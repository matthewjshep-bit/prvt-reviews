// stale-unsent.test.mjs — a number we priced and never sent, closed out.
//
// 2026-10-16: six priced offers sat "never went out" for weeks, some since
// August, held for Matt forever. These pin which ones close, and the many
// that never do.

import test from "node:test";
import assert from "node:assert/strict";
import { staleUnsent, staleUnsentPatch, numberWentOut, STALE_UNSENT_BY, RETIRE_UNSENT_DEFAULT_DAYS } from "./stale-unsent.js";
import { offerOwner } from "./agent-pulse.js";
import { nextFollowUp } from "./next-follow-up.js";
import { normalizeConversationAi } from "./conversation-ai.js";

const DAY = 86400000;
const NOW = Date.parse("2026-10-16T02:00:00Z");
const ago = (d) => new Date(NOW - d * DAY).toISOString();

// An auto-underwrite priced 12 days ago; nothing went out.
const unsent = (over = {}) => ({
  id: "o1", contactId: "c1", contactName: "Pat Agent", address: "804 Willow Rd, Puyallup, WA 98371", cashAmount: 255000,
  status: "new", createdAt: ago(12), autoUnderwrite: { jobId: "j1", finishedAt: ago(12) }, sends: [], ...over,
});
const check = (offer, over = {}) => staleUnsent({ offer, drafts: [], events: [], now: NOW, ...over });

test("the setting is on at ten days, and 0 turns it off", () => {
  assert.equal(RETIRE_UNSENT_DEFAULT_DAYS, 10);
  assert.equal(normalizeConversationAi({}).parties.agent.followUp.retireUnsentDays, 10);
  assert.equal(normalizeConversationAi({ parties: { agent: { followUp: { retireUnsentDays: 0 } } } }).parties.agent.followUp.retireUnsentDays, 0);
  assert.equal(normalizeConversationAi({}).parties.investor.followUp.retireUnsentDays, undefined, "agent only");
  assert.equal(check(unsent(), { days: 0 }).retire, false);
});

test("a number we priced and never sent is closed ten days after it was due, and says how long it sat", () => {
  const v = check(unsent());
  assert.equal(v.retire, true, v.why);
  assert.equal(v.why, "never sent: closed after 12 days");
  assert.equal(v.overdueDays, 11, "due four hours after it was priced");
  assert.match(check(unsent({ createdAt: ago(9) })).why, /days overdue, not 10/);
  // A re-quote moved the number: the clock starts from there.
  assert.equal(check(unsent({ requotes: [{ ts: ago(3), from: 250000, to: 255000 }] })).retire, false);
});

test("a number that went out in any way is never closed — a number texted in a plain reply included", () => {
  for (const over of [
    { floatSentAt: ago(10) },
    { proactive: { realmCheckAt: ago(10) } },
    { proactive: { takeCheckAt: ago(10) } },
    { sends: [{ ts: ago(10), results: { sms: { ok: true } } }] },
    { followUps: [{ kind: "offer_nudge", step: 3, at: ago(5) }] },
  ]) {
    assert.equal(numberWentOut(unsent(over)), true, JSON.stringify(over));
    assert.equal(check(unsent(over)).retire, false, JSON.stringify(over));
  }
  assert.equal(numberWentOut(unsent({ sends: [{ ts: ago(10), results: { sms: { ok: false } } }] })), false, "a send that failed everywhere isn't paper");
});

test("a person's own work stands two weeks: made by hand, revised, pinned or approved", () => {
  const hand = unsent({ autoUnderwrite: undefined });
  assert.match(check(hand).why, /a person worked on it 12 days ago/);
  assert.equal(check(unsent({ autoUnderwrite: undefined, createdAt: ago(15) })).retire, true);
  assert.equal(check(unsent({ createdAt: ago(30), revisions: [{ ts: ago(5), from: 240000, to: 255000, by: "you" }] })).retire, false);
  assert.equal(check(unsent({ createdAt: ago(30), revisions: [{ ts: ago(20), from: 240000, to: 255000, by: "requote" }] })).retire, true, "a machine re-quote isn't a person");
  assert.equal(check(unsent({ createdAt: ago(30), pin: { at: ago(4) } })).retire, false);
  assert.equal(check(unsent({ createdAt: ago(30), approved: { amount: 255000, at: ago(4), by: "today" } })).retire, false);
});

test("not while you have the thread, a float you pressed is waiting, or they said yes", () => {
  const typed = [{ type: "hand_reply", at: ago(1), contactId: "c1" }];
  assert.match(check(unsent(), { events: typed }).why, /you have the thread/);
  const call = [{ type: "call_summary", at: new Date(NOW - 3600000).toISOString(), data: { durationSec: 300, transcribed: true } }];
  assert.match(check(unsent(), { events: call }).why, /you have the thread/);
  const waiting = [{ id: "f1", contactId: "c1", status: "draft", outbound: { kind: "realm_check", offerId: "o1" }, createdAt: ago(2) }];
  assert.match(check(unsent(), { drafts: waiting }).why, /waiting in the outbox/);
  const old = [{ ...waiting[0], createdAt: ago(11) }];
  assert.equal(check(unsent(), { drafts: old }).retire, true, "one held eleven days is as stale as the row");
  assert.equal(check(unsent({ agreed: { amount: 255000, at: ago(2), via: "realm_yes" } })).retire, false);
});

test("only an unsent offer: a deal, a held underwrite, or one they answered is somebody else's", () => {
  assert.equal(check(unsent({ deal: { stage: "under_contract" } })).retire, false);
  assert.equal(check(unsent({ status: "draft" })).retire, false);
  assert.equal(check(unsent({ status: "passed", statusAt: ago(5) })).retire, false);
  assert.equal(check(unsent({ cashAmount: null })).retire, false);
});

test("closed as we_passed with the reason on the row, the held sweep's shape — and the agent goes to the check-in", () => {
  const o = unsent();
  const v = check(o);
  const after = staleUnsentPatch(o, { why: v.why, now: NOW });
  assert.equal(after.status, "we_passed");
  assert.equal(after.statusNote, "never sent: closed after 12 days");
  assert.deepEqual(after.retired, { at: new Date(NOW).toISOString(), by: STALE_UNSENT_BY, reason: v.why });
  assert.deepEqual(after.statusHistory.at(-1), { status: "we_passed", ts: new Date(NOW).toISOString(), note: v.why });
  // Nothing follows up a pass of ours, so nothing owns the agent: the agent
  // check-in asks them for their next one.
  const config = normalizeConversationAi({ enabled: true, parties: { agent: { followUp: { enabled: true, ladders: { offer_nudge: { enabled: true } } } } } });
  assert.equal(nextFollowUp({ offer: after, config, now: NOW }).kind, "we_passed");
  assert.equal(offerOwner({ offers: [after], config, now: NOW }), null);
  // A fresh one still holds them, as before.
  assert.equal(offerOwner({ offers: [unsent({ createdAt: ago(1) })], config, now: NOW }), "an open offer");
});
