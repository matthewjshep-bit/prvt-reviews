// replier-backfill.test.mjs — the one-time pass that puts agents who wrote
// back to us, but never reached the app's record, into the agent check-in.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replier-backfill-test-"));
process.env.DATA_DIR = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { store } = await import("./store.js");
const { runReplierBackfill } = await import("./replier-backfill.js");
const { planAgentPulse } = await import("./agent-pulse.js");
const { normalizeConversationAi } = await import("./shared/conversation-ai.js");
await store.init();

const DAY = 86400000;
const NOW = Date.parse("2026-12-01T19:00:00Z");
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const sms = (direction, body, daysAgo) => ({ direction, body, messageType: "TYPE_SMS", dateAdded: ago(daysAgo) });
const opener = sms("outbound", "Hi Pat, is 1 Elm St a project or pretty turnkey?", 70);

// Six agents we imported from the outreach pull, each with a GHL thread.
const THREADS = {
  "c-replied": [opener, sms("inbound", "Pretty turnkey, sorry. Will keep you in mind", 69)],
  "c-stop": [opener, sms("inbound", "STOP", 69)],
  "c-dnd": [opener, sms("inbound", "ok", 69)],
  "c-auto": [opener, sms("inbound", "I'm driving with Do Not Disturb While Driving turned on. I'll see your message when I get where I'm going.", 69)],
  "c-silent": [opener],
  "c-in-pool": [opener, sms("inbound", "Nothing right now", 69)],
};
const CONTACTS = { "c-dnd": { dndSettings: { SMS: { status: "active" } } } };

async function seed(loc) {
  const batch = await store.createOutreachBatch(loc, { name: "Autopilot · King, WA" });
  const keys = Object.keys(THREADS);
  await store.upsertOutreachAgents(loc, batch.id, keys.map((id, i) => ({ agentKey: `k${i}`, doc: { name: "Pat Agent", hook: { address: `${i + 1} Elm St, Kent, WA 98031` } } })));
  for (const [i, id] of keys.entries()) {
    // One matched to GHL on the row only (doc.ghl.contactId), the rest imported.
    if (id === "c-auto") await store.upsertOutreachAgents(loc, batch.id, [{ agentKey: `k${i}`, doc: { name: "Pat Agent", ghl: { contactId: id } } }]);
    else await store.setOutreachAgentStatus(loc, batch.id, `k${i}`, { status: "imported", contactId: id, importedAt: ago(70) });
  }
  // Already in the pool: an agent profile.
  await store.upsertContactProfile(loc, "c-in-pool", { party: "agent" });
}

const deps = (calls) => ({
  getContact: async (id) => { calls.contacts.push(id); return { id, tags: [], ...(CONTACTS[id] || {}) }; },
  searchConversations: async (id) => ({ conversations: THREADS[id] ? [{ id: `conv-${id}` }] : [] }),
  listConversationMessages: async (convId) => ({ messages: [...THREADS[convId.replace(/^conv-/, "")]].reverse(), nextPage: false }),
  markUnsubscribed: async ({ contactId }) => { calls.unsubscribed.push(contactId); await store.appendContactEvents(calls.loc, contactId, [{ type: "unsubscribed", party: "agent", at: new Date(NOW).toISOString(), source: "ghl", dedupeKey: `unsubscribed:${contactId}` }]); await store.upsertContactProfile(calls.loc, contactId, { party: "agent" }); },
  tierCards: async () => new Map(),
  paceMs: 0,
});

test("a dry run of the replier backfill reads every thread and writes nothing, and its counts carry no names", async () => {
  const loc = "loc-rb-dry";
  await seed(loc);
  const calls = { loc, contacts: [], unsubscribed: [] };
  const r = await runReplierBackfill({ client: {}, locationId: loc, store, write: false, deps: deps(calls), now: NOW });
  assert.equal(r.candidates, 5, "everyone imported or matched, minus the one already in the pool");
  assert.equal(r.alreadyInPool, 1);
  assert.deepEqual(r.kinds, { engaged: 1, opted_out: 2, auto_reply: 1, none: 1 });
  assert.equal(r.written.profiles, 0);
  assert.deepEqual(calls.unsubscribed, []);
  assert.equal((await store.listContactProfiles(loc, { party: "agent" })).length, 1, "only the profile the seed wrote");
  assert.doesNotMatch(JSON.stringify(r), /Pat|Elm|turnkey|STOP|c-replied/, "counts only");
});

test("an agent who texted us back before the app saw replies joins the check-in; one who said stop or is on DND is marked opted out", async () => {
  const loc = "loc-rb-write";
  await seed(loc);
  const calls = { loc, contacts: [], unsubscribed: [] };
  const r = await runReplierBackfill({ client: {}, locationId: loc, store, write: true, deps: deps(calls), now: NOW });
  assert.equal(r.written.profiles, 1);
  assert.equal(r.written.markers, 1);
  assert.deepEqual(calls.unsubscribed.sort(), ["c-dnd", "c-stop"]);
  const ev = (await store.listContactEvents(loc, "c-replied", { limit: 10 })).find((e) => e.source === "backfill");
  assert.equal(ev.type, "text_summary");
  assert.equal(ev.at, ago(69), "their last word, so the check-in counts from it");
  assert.equal(ev.data.joinedAt, new Date(NOW).toISOString());

  const saved = { aiApiKey: "k", conversationAi: normalizeConversationAi({ enabled: true }), outreachAutopilot: { pulse: { enabled: true, everyDays: 14, dailyCap: 0 } } };
  const by = (plan) => Object.fromEntries(plan.verdicts.map((v) => [v.contactId, v]));
  const later = by(await planAgentPulse({ locationId: loc, saved, store, now: NOW + 15 * DAY, tierCards: new Map() }));
  assert.equal(later["c-replied"].status, "due");
  assert.equal(later["c-replied"].segment, "engaged");
  assert.equal(later["c-stop"].status, "stopped");
  assert.equal(later["c-dnd"].status, "stopped");
  assert.equal(later["c-auto"], undefined, "an auto-reply is not a person");
  assert.equal(later["c-silent"], undefined);

  // Run it again: nobody is written twice.
  const again = await runReplierBackfill({ client: {}, locationId: loc, store, write: true, deps: deps(calls), now: NOW + DAY });
  assert.equal(again.candidates, 2, "only the auto-reply and the silent one are read again");
  assert.equal(again.written.markers, 0);
});

test("a thread GHL won't give us is counted as failed and the run goes on", async () => {
  const loc = "loc-rb-fail";
  await seed(loc);
  const calls = { loc, contacts: [], unsubscribed: [] };
  const d = deps(calls);
  const r = await runReplierBackfill({ client: {}, locationId: loc, store, write: false, now: NOW,
    deps: { ...d, searchConversations: async (id) => { if (id === "c-stop") throw Object.assign(new Error("boom"), { status: 500 }); return d.searchConversations(id); } } });
  assert.equal(r.failed, 1);
  assert.equal(r.kinds.engaged, 1);
});
