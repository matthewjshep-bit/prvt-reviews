import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTouchBudget, touchTimes, isTalking, touchLimit, TOUCH_KINDS } from "./buyer-touch.js";

const DAY = 86400000;
const NOW = Date.parse("2026-10-05T17:00:00.000Z");
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const sent = (kind, d, over = {}) => ({ id: `${kind}-${d}`, status: "sent", party: "investor", outbound: { kind }, sentAt: ago(d), ...over });

// Buck, 3511 NE 153rd St: a pulse on 9/24, another on 9/28, the deal on 9/29,
// a walkthrough invite on 10/1 and "Last check" on 10/5 — five texts in eleven
// days to a buyer who had written once, to ask who this was. Matt, 2026-10-05:
// relationship first.
test("a buyer who never wrote back hears from us once a week", () => {
  const drafts = [sent("blast_open", 2)];
  const l = touchLimit({ drafts, events: [], now: NOW });
  assert.equal(l.open, false);
  assert.equal(l.talking, false);
  assert.equal(l.allowed, 1);
  assert.equal(l.at, NOW - 2 * DAY + 7 * DAY, "open again a week after the last one");
  assert.equal(touchLimit({ drafts: [sent("buyer_pulse", 8)], events: [], now: NOW }).open, true);
  assert.equal(touchLimit({ drafts: [], events: [], now: NOW }).open, true);
});

test("a buyer we're talking to may hear twice", () => {
  const events = [{ type: "text_summary", at: ago(12) }];
  const one = touchLimit({ drafts: [sent("blast_open", 2)], events, now: NOW });
  assert.equal(one.talking, true);
  assert.equal(one.open, true);
  const two = touchLimit({ drafts: [sent("blast_open", 2), sent("deal_followup", 5)], events, now: NOW });
  assert.equal(two.open, false);
  assert.equal(two.at, NOW - 5 * DAY + 7 * DAY, "the older of the two has to age out");
  // On a deal with us counts too; a reply from last spring doesn't.
  assert.equal(isTalking({ events: [{ type: "investor_evaluating", at: ago(3) }], now: NOW }), true);
  assert.equal(isTalking({ events: [{ type: "text_summary", at: ago(45) }], now: NOW }), false);
});

test("our answers and Matt's hand texts don't count", () => {
  const drafts = [
    { id: "r1", status: "sent", party: "investor", intent: "question", inbound: "is it septic?", sentAt: ago(1) },   // a reply to them
    { id: "h1", status: "sent", party: "investor", intent: "other", inbound: "", sentAt: ago(1) },                     // no outbound kind
    sent("blast_open", 1, { status: "dismissed" }),                                                                     // never went
    sent("buyer_pulse", 1, { party: "agent" }),                                                                         // not a buyer text
  ];
  assert.deepEqual(touchTimes(drafts, { now: NOW }), []);
  assert.equal(touchLimit({ drafts, events: [], now: NOW }).open, true);
});

test("deals that went out together in one text are one touch", () => {
  const t = NOW - DAY;
  const drafts = [
    sent("blast_open", 1, { sentAt: new Date(t).toISOString() }),
    sent("blast_open", 1, { id: "b2", sentAt: new Date(t + 60000).toISOString() }),
  ];
  assert.equal(touchTimes(drafts, { now: NOW }).length, 1);
});

test("every machine-started buyer text counts, walkthrough texts included", () => {
  for (const kind of ["blast_open", "deal_followup", "buyer_pulse", "showing_reminder", "showing_followup", "blast_nudge", "dataroom_nudge"]) {
    assert.ok(TOUCH_KINDS.has(kind), kind);
  }
});

test("the limits are settings with sane floors", () => {
  assert.deepEqual(normalizeTouchBudget(), { enabled: true, quietPerWeek: 1, talkingPerWeek: 2, talkingDays: 30, bundleMax: 3 });
  const n = normalizeTouchBudget({ quietPerWeek: 0, talkingPerWeek: 99, bundleMax: 9, enabled: false });
  assert.equal(n.quietPerWeek, 1);
  assert.equal(n.talkingPerWeek, 7);
  assert.equal(n.bundleMax, 3);
  assert.equal(n.enabled, false);
  // Off means no limit.
  assert.equal(touchLimit({ drafts: [sent("blast_open", 1)], events: [], now: NOW, budget: { enabled: false } }).open, true);
});
