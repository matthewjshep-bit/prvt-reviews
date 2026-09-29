// next-follow-up.test.mjs — the "Next follow-up" column: one answer per offer,
// and the same day the sweep will act on.

import test from "node:test";
import assert from "node:assert/strict";
import { nextFollowUp, sweepTime } from "./next-follow-up.js";
import { nextRungAt, threadTimes, offerNudgeAnchor } from "./follow-up.js";
import { normalizeConversationAi } from "./conversation-ai.js";

const DAY = 86400000;
// A Tuesday, 15:00 UTC — an hour before the day's sweep.
const T0 = Date.parse("2026-09-01T15:00:00.000Z");
const at = (d) => new Date(T0 + d * DAY).toISOString();

const CONFIG = normalizeConversationAi({
  enabled: true,
  parties: { agent: {
    followUp: { enabled: true, ladders: {
      offer_nudge: { enabled: true, steps: [3, 7, 14], repeatEvery: 7 },
      passed_checkin: { enabled: true, steps: [10, 20, 30] },
      hot_push: { enabled: true, steps: [1, 3, 6, 10] },
    } },
    autoSend: { enabled: true, intents: ["offer_nudge", "passed_checkin", "hot_push", "checkin_due"] },
  } },
});

const offer = (over = {}) => ({
  id: "o1", contactId: "c1", address: "12 Elm St, Renton, WA 98055", cashAmount: 265000,
  status: "sent", statusAt: at(0), createdAt: at(0), sends: [{ ts: at(0) }], isCurrent: true, ...over,
});
const next = (o, extra = {}) => nextFollowUp({ offer: o, config: CONFIG, now: T0 + 0.1 * DAY, ...extra });

/* ---------- the ladder arithmetic ---------- */

test("the next rung is named with its day, and a rung whose day passed unsent is due now", () => {
  assert.deepEqual(nextRungAt({ steps: [3, 7], startedAt: at(0), now: T0 + DAY }), { at: at(3), step: 3, due: false });
  assert.deepEqual(nextRungAt({ steps: [3, 7], startedAt: at(0), now: T0 + 4 * DAY }), { at: at(3), step: 3, due: true });
  assert.deepEqual(nextRungAt({ steps: [3, 7], startedAt: at(0), sentSteps: [3], now: T0 + 4 * DAY }), { at: at(7), step: 7, due: false });
  assert.equal(nextRungAt({ steps: [3, 7], startedAt: at(0), sentSteps: [3, 7], now: T0 + 8 * DAY }), null, "finished");
  assert.equal(nextRungAt({ steps: [3, 7], repeatEvery: 7, startedAt: at(0), sentSteps: [3, 7], now: T0 + 8 * DAY }).step, 14, "a repeating ladder always has one more");
});

test("a rung lands on the next morning's sweep, and never on a weekend", () => {
  const tue17 = Date.parse("2026-09-01T17:00:00.000Z");
  assert.equal(new Date(sweepTime(tue17)).toISOString(), "2026-09-02T16:00:00.000Z", "missed today's sweep: tomorrow");
  assert.equal(new Date(sweepTime(T0)).toISOString(), "2026-09-01T16:00:00.000Z", "before the sweep: today");
  const fri17 = Date.parse("2026-09-04T17:00:00.000Z");
  assert.equal(new Date(sweepTime(fri17)).toISOString(), "2026-09-07T16:00:00.000Z", "Saturday's rung goes Monday");
  assert.equal(new Date(sweepTime(fri17, 16, "all")).toISOString(), "2026-09-05T16:00:00.000Z");
});

test("an 'ok thanks' left unanswered is handled, a held reply is owed", () => {
  const t = threadTimes([
    { status: "sent", inbound: "", outbound: { kind: "offer_nudge" }, createdAt: at(3), updatedAt: at(3) },
    { status: "dismissed", inbound: "ok thanks", createdAt: at(4) },
  ]);
  assert.equal(t.lastInboundAt, at(4));
  assert.equal(t.lastHandledAt, at(4));
  assert.equal(t.heldSince, null);
  assert.equal(offerNudgeAnchor({ startedAt: at(0), lastInboundAt: t.lastInboundAt, lastHandledAt: t.lastHandledAt }).reanchored, true);
  assert.equal(threadTimes([{ status: "draft", inbound: "what's your best?", createdAt: at(4) }]).heldSince, at(4));
});

/* ---------- every offer gets an answer ---------- */

test("a sent offer shows its first nudge, on the sweep that sends it", () => {
  const n = next(offer());
  assert.equal(n.kind, "offer_nudge");
  assert.equal(n.at, "2026-09-04T16:00:00.000Z", "day three, the morning after");
  assert.equal(n.who, "machine");
  assert.match(n.label, /Nudge · step 1 of 3/);
});

test("an offer they answered and we answered is asked about again from our answer", () => {
  const drafts = [{ status: "sent", inbound: "running it by the seller", reply: "sounds good", createdAt: at(5), sentAt: at(5.01) }];
  const n = next(offer({ followUps: [{ kind: "offer_nudge", step: 3, at: at(3) }] }), { drafts, now: T0 + 6 * DAY });
  assert.equal(n.kind, "offer_nudge");
  assert.equal(n.at.slice(0, 10), "2026-09-09", "day three after our answer, not the old ladder's day seven");
});

test("their text waiting on a person shows as owed, before any ladder", () => {
  const n = next(offer(), { drafts: [{ status: "draft", inbound: "can you do 300?", createdAt: at(1) }], now: T0 + 2 * DAY });
  assert.equal(n.kind, "reply_owed");
  assert.equal(n.who, "you");
  assert.equal(n.overdue, true);
});

test("a queued text is the next follow-up, whatever the ladder says", () => {
  const drafts = [{ status: "scheduled", sendAt: at(0.3), outbound: { kind: "price_drop", offerId: "o1" }, createdAt: at(0.1) }];
  const n = next(offer(), { drafts });
  assert.equal(n.kind, "queued");
  assert.equal(n.at, at(0.3));
  assert.match(n.label, /price drop/);
});

test("a passed offer shows its check-in from the day they passed; a gone-quiet one says so", () => {
  const passed = offer({ status: "passed", statusAt: at(0), statusHistory: [{ status: "passed", ts: at(0) }] });
  const n = next(passed);
  assert.equal(n.kind, "passed_checkin");
  assert.equal(n.at.slice(0, 10), "2026-09-11");
  const quiet = next(offer({ status: "no_response", statusHistory: [{ status: "no_response", ts: at(0) }] }));
  assert.match(quiet.label, /never heard back/);
});

test("a passed house that went off the market has nothing coming, and says why", () => {
  const passed = offer({ status: "passed", statusHistory: [{ status: "passed", ts: at(0) }] });
  const n = next(passed, { events: [{ type: "listing_off_market", offerId: "o1", at: at(0.05) }] });
  assert.equal(n.kind, "stopped");
  assert.equal(n.at, null);
  assert.match(n.label, /off market/);
});

test("a hot offer is pushed to paper, not nudged", () => {
  const hot = offer({ status: "countered", hot: { at: at(0), by: "conversation", signal: "writing_up" } });
  const n = next(hot);
  assert.equal(n.kind, "hot_push");
  assert.equal(n.at, "2026-09-02T16:00:00.000Z");
});

test("the soonest of a promise, a check-in they asked for, and the ladder wins", () => {
  const events = [{ type: "checkin_requested", at: at(0.05), data: { dueAt: at(2), phrase: "Thursday" } }];
  const n = next(offer(), { events });
  assert.equal(n.kind, "checkin_due");
  assert.match(n.label, /Thursday/);
  const promised = next(offer(), { events: [{ type: "promise_made", at: at(0.05), data: { what: "number" } }] });
  assert.equal(promised.kind, "promise");
  assert.match(promised.label, /a number/);
});

test("offers with nothing coming by design say why, and never show a date", () => {
  for (const [o, kind] of [
    [offer({ status: "we_passed" }), "we_passed"],
    [offer({ deal: { stage: "under_contract" }, status: "accepted" }), "deal"],
    [offer({ supersededBy: "o2", isCurrent: false }), "superseded"],
    [offer({ status: "draft", autoUnderwrite: { held: ["comps thin"] } }), "draft"],
  ]) {
    const n = next(o);
    assert.equal(n.kind, kind);
    assert.equal(n.at, null);
  }
  const stopped = next(offer(), { events: [{ type: "drive_stopped", at: at(0.05), offerId: "o1", data: { reason: "calling him" } }] });
  assert.equal(stopped.kind, "stopped");
});

test("with the ladders off, a live offer reads 'None scheduled' and says why", () => {
  const off = normalizeConversationAi({ enabled: true });
  const n = nextFollowUp({ offer: offer(), config: off, now: T0 });
  assert.equal(n.kind, "none");
  assert.match(n.reason, /switched off/);
});

test("a priced offer nobody floated is the timer's for a day, then it's yours", () => {
  const timers = normalizeConversationAi({ ...CONFIG, driver: { timers: { enabled: true, floatAfterHours: 4 } } });
  const fresh = nextFollowUp({ offer: offer({ status: "new", sends: [] }), config: timers, now: T0 + 0.1 * DAY });
  assert.equal(fresh.kind, "float");
  assert.equal(fresh.who, "machine");
  const stuck = nextFollowUp({ offer: offer({ status: "new", sends: [] }), config: timers, now: T0 + 3 * DAY });
  assert.equal(stuck.kind, "float");
  assert.equal(stuck.who, "you");
  assert.equal(stuck.overdue, true);
});
