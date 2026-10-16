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

/* ---------- agents already in the pool (includePool, 2026-10-16) ---------- */

// Pool agents with no reply on the app's record. 59+ of them had written
// back in GHL, so the check-in held them as cold.
const POOL_THREADS = {
  "c-pool-replied": [opener, sms("inbound", "Not right now, will keep you posted", 69)],
  "c-pool-pinged": [opener, sms("inbound", "Thanks, nothing on my end", 69)],
  "c-pool-stop": [opener, sms("inbound", "Wrong number", 69)],
  "c-pool-quiet": [opener],
  "c-pool-drafted": [opener, sms("inbound", "Maybe later", 69)],
  "c-pool-known": [opener, sms("inbound", "Call me", 69)],
};
const poolDeps = (calls) => ({
  ...deps(calls),
  searchConversations: async (id) => { calls.read.push(id); return { conversations: POOL_THREADS[id] ? [{ id: `conv-${id}` }] : [] }; },
  listConversationMessages: async (convId) => ({ messages: [...POOL_THREADS[convId.replace(/^conv-/, "")]].reverse(), nextPage: false }),
});

async function seedPool(loc) {
  for (const id of Object.keys(POOL_THREADS)) await store.upsertContactProfile(loc, id, { party: "agent" });
  // A cold listing ping six weeks ago: the only text the check-in sent them.
  await store.appendContactEvents(loc, "c-pool-pinged", [
    { type: "agent_pulse_sent", party: "agent", at: ago(40), source: "sweep", dedupeKey: "pulse:c-pool-pinged", data: { segment: "cold", reason: "fresh_listing" } },
    { type: "agent_pulse_texted", party: "agent", at: ago(40), source: "conversation", dedupeKey: "texted:c-pool-pinged", data: { segment: "cold", reason: "fresh_listing" } },
  ]);
  // A reply only a draft holds, and one the timeline already has.
  const d = await store.createReplyDraft({ locationId: loc, contactId: "c-pool-drafted", status: "sent", inbound: "Maybe later", reply: "Sounds good" });
  await store.updateReplyDraft(d.id, { ...d, createdAt: ago(60), updatedAt: ago(60) });
  await store.appendContactEvents(loc, "c-pool-known", [{ type: "text_summary", party: "agent", at: ago(69), source: "conversation", dedupeKey: "ts:c-pool-known", data: { inbound: "Call me" } }]);
}
const poolSaved = { aiApiKey: "k", conversationAi: normalizeConversationAi({ enabled: true }), outreachAutopilot: { pulse: { enabled: true, everyDays: 14, dailyCap: 0 } } };

test("a pool agent the app thought never replied, who did in GHL, joins the regular check-in, spread from the run", async () => {
  const loc = "loc-rb-pool";
  await seedPool(loc);
  const by = (plan) => Object.fromEntries(plan.verdicts.map((v) => [v.contactId, v]));
  const before = by(await planAgentPulse({ locationId: loc, saved: poolSaved, store, now: NOW, tierCards: new Map() }));
  assert.equal(before["c-pool-replied"].segment, "cold", "the app had no reply from them");

  const calls = { loc, contacts: [], unsubscribed: [], read: [] };
  const r = await runReplierBackfill({ client: {}, locationId: loc, store, write: true, includePool: true, deps: poolDeps(calls), now: NOW });
  assert.equal(r.pool.candidates, 5, "everyone in the pool without a reply on the timeline");
  assert.equal(r.pool.hadReply, 1, "a reply in their drafts: not read");
  assert.deepEqual(r.pool.kinds, { engaged: 2, opted_out: 1, none: 1 });
  assert.ok(!calls.read.includes("c-pool-known") && !calls.read.includes("c-pool-drafted"), "GHL is asked only about the ones the app never heard from");
  assert.equal(r.written.markers, 2);
  assert.deepEqual(calls.unsubscribed, ["c-pool-stop"]);
  const ev = (await store.listContactEvents(loc, "c-pool-replied", { limit: 10 })).find((e) => e.source === "backfill");
  assert.equal(ev.at, ago(69));
  assert.equal(ev.data.joinedAt, new Date(NOW).toISOString());

  const now = by(await planAgentPulse({ locationId: loc, saved: poolSaved, store, now: NOW, tierCards: new Map() }));
  assert.equal(now["c-pool-replied"].segment, "engaged");
  assert.equal(now["c-pool-pinged"].segment, "engaged");
  // An old listing ping doesn't make them due all at once on the morning they join.
  assert.equal(now["c-pool-pinged"].status, "not_due", now["c-pool-pinged"].reason);
  assert.match(now["c-pool-pinged"].reason, /joined the check-in/);
  assert.equal(now["c-pool-stop"].status, "stopped");
  assert.equal(now["c-pool-quiet"].segment, "cold", "never wrote back: still cold");
  const later = by(await planAgentPulse({ locationId: loc, saved: poolSaved, store, now: NOW + 15 * DAY, tierCards: new Map() }));
  assert.equal(later["c-pool-replied"].status, "due");
  assert.equal(later["c-pool-pinged"].status, "due");

  // Again: the written are not read twice.
  const again = await runReplierBackfill({ client: {}, locationId: loc, store, write: true, includePool: true, deps: poolDeps({ ...calls, read: [] }), now: NOW + DAY });
  assert.equal(again.pool.candidates, 2, "the quiet one and the drafted one");
  assert.equal(again.written.markers, 0);
});

test("a dry run over the pool reads and counts and writes nothing; without includePool the pool isn't read", async () => {
  const loc = "loc-rb-pool-dry";
  await seedPool(loc);
  const calls = { loc, contacts: [], unsubscribed: [], read: [] };
  const r = await runReplierBackfill({ client: {}, locationId: loc, store, write: false, includePool: true, deps: poolDeps(calls), now: NOW });
  assert.deepEqual(r.pool.kinds, { engaged: 2, opted_out: 1, none: 1 });
  assert.equal(r.written.markers + r.written.profiles + r.written.optedOut, 0);
  assert.deepEqual(calls.unsubscribed, []);
  for (const id of Object.keys(POOL_THREADS)) {
    assert.equal((await store.listContactEvents(loc, id, { limit: 20 })).filter((e) => e.source === "backfill").length, 0, id);
  }
  assert.doesNotMatch(JSON.stringify(r), /Wrong number|keep you posted|c-pool/, "counts only");

  const off = await runReplierBackfill({ client: {}, locationId: loc, store, write: false, deps: poolDeps({ ...calls, read: [] }), now: NOW });
  assert.equal(off.pool, undefined);
  assert.equal(off.read, 0);
});

test("POST /api/outreach/repliers/backfill runs it as a job, dry by default, and GET says how it went in counts only", async () => {
  const { default: createOutreachRouter } = await import("./routes/outreach.js");
  const { default: express } = await import("express");
  const loc = "loc-rb-route";
  await seedPool(loc);
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = { loc, contacts: [], unsubscribed: [], read: [] };
  const d = poolDeps(calls);
  const router = createOutreachRouter({ resolveLocation: () => ({ locationId: loc, client: {} }) });
  router.replierBackfillDeps = { ...d, searchConversations: async (id) => { await gate; return d.searchConversations(id); } };
  const app = express();
  app.use(express.json());
  app.use("/api/outreach", router);
  const server = app.listen(0);
  try {
    const B = `http://127.0.0.1:${server.address().port}/api/outreach/repliers/backfill`;
    const post = (body) => fetch(B, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const started = await post({});
    assert.equal(started.status, 202);
    const { job } = await started.json();
    assert.equal(job.dryRun, true, "a dry run unless dryRun: false");
    assert.equal(job.includePool, true);
    assert.equal(job.status, "running");
    assert.equal((await post({ dryRun: false })).status, 409, "one at a time");
    release();
    let state;
    for (let i = 0; i < 100; i++) {
      state = (await (await fetch(B)).json()).job;
      if (state.status !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(state.status, "done", state.error);
    assert.deepEqual(state.result.pool.kinds, { engaged: 2, opted_out: 1, none: 1 });
    assert.equal(state.result.written.markers, 0);
    assert.doesNotMatch(JSON.stringify(state), /Wrong number|keep you posted|c-pool/, "no names, numbers or words");
  } finally {
    server.close();
  }
});
