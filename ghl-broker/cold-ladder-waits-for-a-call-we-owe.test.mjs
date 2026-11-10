// cold-ladder-waits-for-a-call-we-owe.test.mjs — the cold ladder's next
// check-in went out while we owed the agent a call (2026-11-09 audit: a
// booked 8am call nobody made, then a text from us asking for fixers).
//
// A call we owe goes first: the morning sweep holds the rung, unclaimed, for
// three days after the call was owed, and sends it once the wait is over or a
// call of ours happens. The live offer's nudge never waits for it.
//
// Real file store (events + dedupe), stubbed startProactive.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cold-ladder-call-owed-test-"));
process.env.DATA_DIR = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { store } = await import("./store.js");
const { recordEvent } = await import("./contact-record.js");
const { normalizeConversationAi } = await import("./shared/conversation-ai.js");
const { startFollowUpSweep, getFollowUpJob, _resetJobs } = await import("./follow-up-sweep.js");
await store.init();

const DAY = 86400000;
const FIRST_TEXT = "2026-10-16T19:45:00Z";
const morning = (date) => Date.parse(`${date}T17:00:00Z`);   // the 9am PST sweep
const MON_NOV_2 = morning("2026-11-02");
const AI = normalizeConversationAi({ enabled: true, parties: { agent: { followUp: { enabled: true, ladders: { outreach_nudge: { enabled: true, steps: [2], repeatEvery: 14 } } } } } });
const ID = "c-wren";

async function seed(loc) {
  await recordEvent({ store, locationId: loc, contactId: ID, party: "agent", type: "outreach_sent", at: FIRST_TEXT, address: "40 Larch Way, Everett, WA", source: "conversation", dedupeKey: `outreach_sent:${ID}` });
  await recordEvent({ store, locationId: loc, contactId: ID, party: "agent", type: "follow_up_sent", at: "2026-10-18T19:00:00Z", source: "conversation", dedupeKey: `fus:${ID}:2`, data: { kind: "outreach_nudge", step: 2 } });
  // We said we'd call them back, the day before the day-16 rung.
  await recordEvent({ store, locationId: loc, contactId: ID, party: "agent", type: "promise_made", at: new Date(MON_NOV_2 - DAY).toISOString(), source: "conversation",
    dedupeKey: `pm:${ID}`, data: { what: "call", text: "Sorry I missed you, I'll call you back tomorrow.", by: "machine" } });
}

async function sweep(loc, now) {
  _resetJobs();
  const started = [];
  startFollowUpSweep({ client: {}, locationId: loc, saved: { aiApiKey: "k", conversationAi: AI, outreachAutopilot: { enabled: true } }, store, sendsEnabled: true, now,
    deps: { paceMs: 0, startProactive: async (a) => { started.push(a.contactId); return { job: { id: "j" } }; },
      runIntroEmails: async () => ({ queued: 0, drafted: 0, rows: [] }), runCheckInEmails: async () => ({ queued: 0, drafted: 0, rows: [] }) } });
  const until = Date.now() + 5000;
  while (getFollowUpJob(loc)?.status === "running" && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
  assert.equal(getFollowUpJob(loc).status, "done", getFollowUpJob(loc).error || "");
  return { started, results: getFollowUpJob(loc).results || [] };
}
const claims = async (loc) => (await store.listContactEvents(loc, ID, { types: ["follow_up_sent"], limit: 50 })).map((e) => e.data?.step).sort((a, b) => a - b);

test("the cold ladder's check-in waits, unclaimed, while we owe the agent a call", async () => {
  const loc = "loc-call-owed-wait";
  await seed(loc);
  const r = await sweep(loc, MON_NOV_2);
  assert.deepEqual(r.started, []);
  assert.match(r.results.find((x) => x.contactId === ID)?.reason || "", /we said we'd call them: the call goes first/);
  assert.deepEqual(await claims(loc), [2], "the day-16 rung isn't spent on the wait");
  // Three days after we said it, the rung goes.
  const later = await sweep(loc, MON_NOV_2 + 2 * DAY);
  assert.deepEqual(later.started, [ID]);
  assert.deepEqual(await claims(loc), [2, 16]);
});

test("a call of ours since the promise lets the check-in go the same morning", async () => {
  const loc = "loc-call-owed-called";
  await seed(loc);
  await recordEvent({ store, locationId: loc, contactId: ID, party: "agent", type: "call_attempt", at: new Date(MON_NOV_2 - 3 * 3600000).toISOString(), source: "call",
    dedupeKey: `ca:${ID}`, data: { outcome: "voicemail", direction: "outbound" } });
  const r = await sweep(loc, MON_NOV_2);
  assert.deepEqual(r.started, [ID]);
});
