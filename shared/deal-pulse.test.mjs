// deal-pulse.test.mjs — how a deal's dispo is going, and the inspection call.
// Run with: node --test shared/deal-pulse.test.mjs
// Names and numbers are invented.

import test from "node:test";
import assert from "node:assert/strict";
import { dispoPulse, bestBuyerNumber, bestWords, moneyLine, inspectionCall, shortMoney } from "./deal-pulse.js";

const NOW = Date.parse("2026-11-23T20:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
const deal = (over = {}) => ({
  stage: "under_contract", createdAt: daysAgo(6), contractPrice: 400000, assignmentFee: 30000,
  investors: [], feedback: [], stageHistory: [], ...over,
});

test("short money reads like Matt says it", () => {
  assert.equal(shortMoney(455000), "$455K");
  assert.equal(shortMoney(1250000), "$1.25M");
  assert.equal(shortMoney(2000000), "$2M");
  assert.equal(shortMoney(0), "");
});

test("a stopped blast never counts as sent: sent comes from the broker's count of buyers it went to, not what a blast queued", () => {
  const d = deal({ blasts: [{ count: 151, at: daysAgo(5) }] });
  assert.equal(dispoPulse(d, { now: NOW }).sent, null);
  assert.ok(!dispoPulse(d, { now: NOW }).line.includes("151"));
  const sentDeal = deal({ blasts: [{ count: 151 }], sends: { sent: 12, lastAt: daysAgo(1) } });
  assert.equal(dispoPulse(sentDeal, { now: NOW }).sent, 12);
  assert.match(dispoPulse(sentDeal, { now: NOW }).line, /^sent 12 · on it 0$/);
});

test("the pulse counts who is on it, interested, passed and walking it", () => {
  const d = deal({
    sends: { sent: 40 },
    investors: [
      { contactId: "a", name: "Oak", status: "evaluating", addedAt: daysAgo(4) },
      { contactId: "b", name: "Elm", status: "passed", addedAt: daysAgo(4), updatedAt: daysAgo(2) },
      { contactId: "c", name: "Ash", status: "soft_commit", addedAt: daysAgo(3) },
    ],
    showing: { rsvps: [{ contactId: "a", status: "coming", at: daysAgo(1) }, { contactId: "c", status: "attended", at: daysAgo(2) }] },
  });
  const p = dispoPulse(d, { now: NOW });
  assert.equal(p.onDeal, 3);
  assert.equal(p.interested, 2);
  assert.equal(p.passed, 1);
  assert.equal(p.walking, 1);
  assert.equal(p.walked, 1);
  assert.equal(p.lastBuyerDays, 1);
  assert.equal(p.stalled, false);
  assert.equal(p.line, "sent 40 · on it 3 · 2 interested · 1 passed · 1 walking · 1 walked it");
});

test("a live deal where no buyer has moved in three days reads as stalled", () => {
  const d = deal({ investors: [{ contactId: "a", name: "Oak", status: "evaluating", addedAt: daysAgo(5) }] });
  assert.equal(dispoPulse(d, { now: NOW }).stalled, true);
  assert.equal(dispoPulse(deal({ createdAt: daysAgo(1) }), { now: NOW }).stalled, false);
  assert.equal(dispoPulse(deal({ stage: "closed", createdAt: daysAgo(30) }), { now: NOW }).stalled, false);
});

test("the best number trusts an agreed price first, then what Matt typed, then the feedback page with its age", () => {
  const agreed = deal({ investors: [
    { contactId: "a", name: "Oak", status: "evaluating", agreedPrice: { amount: 420000 } },
    { contactId: "b", name: "Elm", status: "committed", agreedPrice: { amount: 415000 } },
  ] });
  assert.deepEqual(bestBuyerNumber(agreed, { now: NOW }), { amount: 415000, from: "agreed", name: "Elm", ageDays: null });
  const read = deal({ buyerRead: { price: 405000, at: daysAgo(2) }, feedbackPackage: { generatedAt: daysAgo(1), askedFor: [{ amount: 390000 }] } });
  assert.equal(bestBuyerNumber(read, { now: NOW }).from, "buyerRead");
  const fb = deal({ feedbackPackage: { generatedAt: daysAgo(2), askedFor: [{ amount: 380000, name: "Oak" }, { amount: 395000, name: "Elm" }] } });
  const b = bestBuyerNumber(fb, { now: NOW });
  assert.equal(b.amount, 395000);
  assert.equal(bestWords(b), "best $395K, named on the feedback page 2d old");
  assert.equal(bestBuyerNumber(deal(), { now: NOW }), null);
});

test("a passed buyer's old agreed price is never the best number", () => {
  const d = deal({ investors: [{ contactId: "a", name: "Oak", status: "passed", agreedPrice: { amount: 430000 } }] });
  assert.equal(bestBuyerNumber(d, { now: NOW }), null);
});

test("contract, buyer price and fee read as one cell, measured against the ceiling at promote", () => {
  const m = moneyLine(deal({ ceilingAtPromote: { computable: true, noFee: 410000 } }));
  assert.equal(m.line, "$400K → $430K · fee $30K");
  assert.equal(m.over, 20000);
  assert.equal(moneyLine(deal({ ceilingAtPromote: { computable: true, noFee: 450000 } })).over, 0);
  assert.equal(moneyLine(deal()).over, null);
  assert.equal(moneyLine(deal({ contractPrice: null, assignmentFee: null })), null);
});

test("days before the inspection ends the deal shows the go, re-trade or cancel call with what buyers said", () => {
  const d = deal({
    inspectionDate: "2026-11-25",
    sends: { sent: 30 },
    investors: [
      { contactId: "a", name: "Oak", status: "evaluating", addedAt: daysAgo(3) },
      { contactId: "b", name: "Elm", status: "passed", addedAt: daysAgo(3), reason: { code: "price", note: "" } },
      { contactId: "c", name: "Ash", status: "passed", addedAt: daysAgo(3), reason: { code: "rehab_scope", note: "" } },
    ],
    feedback: [{ contactId: "b", code: "price" }],
    feedbackPackage: { generatedAt: daysAgo(1), askedFor: [{ amount: 380000 }, { amount: 395000 }] },
  });
  const c = inspectionCall(d, { now: NOW });
  assert.ok(c);
  assert.equal(c.dueDays, 2);
  assert.equal(c.tone, "urgent");
  assert.equal(c.headline, "Inspection ends Nov 25, in 2 days: go, re-trade or cancel");
  assert.deepEqual(c.lines, [
    "No committed buyer.",
    "Sent to 30, 3 on it, 1 still interested.",
    "2 passed: Price too high, Too much rehab.",
    "Buyers named $380K to $395K (feedback page, 1d old).",
  ]);
});

test("the inspection call stays away until the window, and once the inspection item is ticked", () => {
  assert.equal(inspectionCall(deal({ inspectionDate: "2026-12-10" }), { now: NOW }), null);
  const ticked = deal({ inspectionDate: "2026-11-24", checklist: { items: [{ id: "inspection", gate: "under_contract", label: "Inspection", owner: "us", rule: { from: "inspection", days: 0 }, done: true }] } });
  assert.equal(inspectionCall(ticked, { now: NOW }), null);
  const lapsed = inspectionCall(deal({ inspectionDate: "2026-11-22" }), { now: NOW });
  assert.equal(lapsed.tone, "lapsed");
  assert.match(lapsed.headline, /^Inspection ended Nov 22, 1 day ago/);
});
