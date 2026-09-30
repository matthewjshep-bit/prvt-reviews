// line.test.mjs — the line, measured.

import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLineTargets, lineStations, methodMath, cycleTimes, offerLeaks, agentLeaks, buyerLeaks, dealLeaks,
  leakTotal, backlogTotal, lineJobs, errorsByArea, realizedPricing, buildLine, LINE_JOBS,
} from "./line.js";

const NOW = Date.parse("2026-09-29T18:00:00Z");
const D = (n) => new Date(NOW - n * 86400000).toISOString();
const H = (n) => new Date(NOW - n * 3600000).toISOString();
const offer = (id, over = {}) => ({ id, contactId: `a-${id}`, address: `${id} Elm St, Renton, WA`, status: "sent", createdAt: D(10), statusHistory: [], ...over });

test("an open offer with nothing scheduled is a leak; a stopped one, a finished check-in and a superseded row are not", () => {
  const r = offerLeaks([
    offer("1", { nextFollowUp: { kind: "none", label: "None scheduled", reason: "the nudges ran out" } }),
    offer("2", { nextFollowUp: { kind: "stopped", label: "Stopped by you" } }),
    offer("3", { status: "passed", nextFollowUp: { kind: "none", reason: "check-ins finished (day 120)" } }),
    offer("4", { supersededBy: { id: "5" }, nextFollowUp: { kind: "none" } }),
    offer("5", { nextFollowUp: { kind: "offer_nudge", at: H(-20), who: "machine" } }),
  ], { now: NOW });
  assert.equal(r.nothing, 1);
  assert.deepEqual(r.rows.map((x) => [x.offerId, x.leak]), [["1", "nothing"]]);
  assert.equal(r.rows[0].reason, "the nudges ran out");
});

test("a machine clock a day and a sweep late is a missed run; one due this morning isn't; a held reply waits on you", () => {
  const r = offerLeaks([
    offer("1", { nextFollowUp: { kind: "offer_nudge", at: H(30), who: "machine" } }),
    offer("2", { nextFollowUp: { kind: "offer_nudge", at: H(3), who: "machine" } }),
    offer("3", { nextFollowUp: { kind: "reply_owed", at: H(50), who: "you" } }),
    offer("4", { status: "accepted", nextFollowUp: { kind: "deal", who: "you", label: "Accepted — promote to a deal" } }),
  ], { now: NOW });
  assert.equal(r.missed, 1);
  assert.equal(r.waitingOnYou, 2);
  assert.equal(r.nothing, 0);
});

test("cycle times count only hops that finished in the window, median and 90th", () => {
  const offers = [
    offer("a", { createdAt: D(20), sends: [{ ts: D(18) }], statusHistory: [{ status: "countered", ts: D(15) }] }),
    offer("b", { createdAt: D(12), proactive: { realmCheckAt: D(11) }, statusHistory: [{ status: "accepted", ts: D(5) }],
      deal: { createdAt: D(4), stageHistory: [{ stage: "under_contract", ts: D(4) }, { stage: "buyer_found", ts: D(1) }], blasts: [{ at: D(3.5) }] } }),
    offer("old", { createdAt: D(90), sends: [{ ts: D(80) }] }),
  ];
  const c = Object.fromEntries(cycleTimes(offers, { now: NOW, days: 30 }).map((h) => [h.key, h]));
  assert.equal(c.out.n, 2, "the 80-day-old send is outside the window");
  assert.equal(c.out.medianDays, 1.5, "two hops of 1 and 2 days: the median is the middle of the two");
  assert.equal(c.answer.n, 2);
  assert.equal(c.contract.medianDays, 1);
  assert.equal(c.blast.medianDays, 0.5);
  assert.equal(c.buyer.medianDays, 3);
  assert.equal(c.close.n, 0);
});

test("realized all-in splits sold from died, beside the setting, and never touches settings", () => {
  const settings = Object.freeze({ maoPctOfArv: 75 });
  const r = realizedPricing({ settings, scorecards: [
    { offerId: "s1", street: "1 A St", outcome: "closed", arv: 500000, allInPctOfArv: 70.7 },
    { offerId: "s2", street: "2 B St", outcome: "buyer_found", arv: 400000, allInPctOfArv: 71.1 },
    { offerId: "d1", street: "3 C St", outcome: "fell_through", arv: 450000, allInPctOfArv: 74.2 },
    { offerId: "d2", street: "4 D St", outcome: "fell_through", arv: 450000, allInPctOfArv: 82 },
    { offerId: "live", street: "5 E St", outcome: "live", arv: 450000, allInPctOfArv: 90 },
  ] });
  assert.deepEqual(r.sold, { n: 2, medianPct: 70.9 });
  assert.deepEqual(r.died, { n: 2, medianPct: 78.1 });
  assert.equal(r.setting, 75);
  assert.equal(r.gapToSold, 4.1);
  assert.equal(r.rows.some((x) => x.outcome === "live"), false);
  assert.deepEqual(settings, { maoPctOfArv: 75 });
});

test("stations carry their targets and the month's pace; the method says what the offers should have made", () => {
  const month = [{ key: "offered", side: "agent", label: "Offered", count: 150, machine: 100 }, { key: "contract", side: "agent", label: "Under contract", count: 1, machine: 0 }, { key: "replied", side: "agent", label: "Replied", count: 40, machine: 0 }];
  const week = [{ key: "offered", count: 40 }];
  const s = Object.fromEntries(lineStations({ week, month, targets: {} }).map((x) => [x.key, x]));
  assert.equal(s.offered.perDay, 5);
  assert.equal(s.offered.pace, 0.5);
  assert.equal(s.offered.week, 40);
  assert.equal(s.replied.target, null);
  assert.equal(s.contract.pace, 0.5);
  assert.deepEqual(methodMath({ month, targets: {} }), { offers30: 150, contracts30: 1, expectedContracts: 1.3, offersForTarget: 240, feeAtTarget: 30000 });
});

test("targets default to the Agent Method and clamp", () => {
  assert.deepEqual(normalizeLineTargets(), { newAgentsPerDay: 10, offersPerDay: 10, offersPerContract: 120, dealsPerMonth: 2, feePerDeal: 15000, agentTouchDays: 21, buyerTouchDays: 30 });
  assert.equal(normalizeLineTargets({ offersPerDay: "25" }).offersPerDay, 25);
  assert.equal(normalizeLineTargets({ offersPerContract: 0 }).offersPerContract, 1);
});

test("agents and buyers due with their check-in off are leaks; on, only the ones without a seat", () => {
  const agentPlan = (enabled) => ({ settings: { enabled }, counts: { due: { fresh_listing: 3, our_house: 2, general: 10 }, dueNoSeat: 5, coldDropped: 7, coverage: { touched: 30, pool: 60 } } });
  assert.deepEqual(agentLeaks(agentPlan(false)), { enabled: false, due: 15, dueNoSeat: 0, dueWhileOff: 15, freshListings: 3, coldDropped: 7, coverage: { touched: 30, pool: 60, pct: 50 } });
  assert.equal(agentLeaks(agentPlan(true)).dueNoSeat, 5);
  assert.equal(agentLeaks(agentPlan(true)).dueWhileOff, 0);
  const buyerPlan = { settings: { enabled: true }, picks: [1, 2, 3], counts: { pool: 1000, noPhone: 100, blocked: 50, eligible: 400, passWorkdays: 40 } };
  const b = buyerLeaks(buyerPlan, { buyerTouchDays: 30 });
  assert.equal(b.dueNoSeat, 397);
  assert.equal(b.passTooLong, true, "40 workdays is eight weeks, past a 30-day touch");
  assert.deepEqual(b.coverage, { inCadence: 450, reachable: 850, pct: 52.9 });
  assert.equal(agentLeaks(null), null);
});

test("the switchboard lists every job, which never ran and which failed; errors group by area", () => {
  const jobs = lineJobs([
    { name: "followUp", at: H(2), doc: { last: { finishedAt: H(1), status: "done" }, tries: 1 } },
    { name: "dispo", at: H(30), doc: { failed: true, last: { error: "GHL 502" } } },
  ], { now: NOW });
  assert.equal(jobs.length, Object.keys(LINE_JOBS).length);
  const by = Object.fromEntries(jobs.map((j) => [j.name, j]));
  assert.equal(by.followUp.hoursAgo, 1);
  assert.equal(by.dispo.failed, true);
  assert.equal(by.dispo.error, "GHL 502");
  assert.equal(by.agentPulse.never, true);
  const e = errorsByArea([{ area: "tick:dispo", count: 3, lastAt: H(1), message: "x" }, { area: "tick:dispo", count: 1, lastAt: H(5) }, { area: "proactive", count: 1, lastAt: H(2) }]);
  assert.deepEqual(e.map((x) => [x.area, x.count]), [["tick:dispo", 4], ["proactive", 1]]);
});

test("the whole line adds its leaks into one number, leaving out what waits on you", () => {
  const line = buildLine({
    now: NOW,
    offers: [offer("1", { nextFollowUp: { kind: "none" } }), offer("2", { nextFollowUp: { kind: "reply_owed", who: "you" } })],
    actions: [{ kind: "deal_no_buyers", offerId: "o9", address: "9 Elm", title: "nobody on it" }, { kind: "offer_ready" }],
    agentPlan: { settings: { enabled: false }, counts: { due: { general: 4 }, coverage: {} } },
    settings: { maoPctOfArv: 75, lineTargets: { offersPerDay: 12 } },
  });
  assert.equal(line.targets.offersPerDay, 12);
  assert.equal(line.leaks.deals.total, 1);
  assert.equal(line.leakTotal, 1 + 4 + 1);
  assert.equal(leakTotal({}), 0);
  assert.deepEqual(dealLeaks([]).byKind, {});
  assert.deepEqual(dealLeaks([{ kind: "closing_task_due", severity: "soon" }, { kind: "closing_task_due", severity: "now" }]).byKind, { closing_task_due: 1 }, "a checklist item is a leak once overdue");
});

test("a buyer or agent waiting for a check-in seat is backlog, not a leak; with the check-in off, everyone due is a leak", () => {
  const buyerPlan = (enabled) => ({ settings: { enabled }, picks: [1, 2], counts: { pool: 100, eligible: 50 } });
  const agentPlan = (enabled) => ({ settings: { enabled }, counts: { due: { general: 7 }, dueNoSeat: 5, coverage: {} } });
  const on = buildLine({ now: NOW, buyerPlan: buyerPlan(true), agentPlan: agentPlan(true) });
  assert.equal(on.leakTotal, 0, "queued for a seat is scheduled");
  assert.equal(on.backlog, 48 + 5);
  const off = buildLine({ now: NOW, buyerPlan: buyerPlan(false), agentPlan: agentPlan(false) });
  assert.equal(off.leakTotal, 50 + 7, "nothing will pick them up while it's off");
  assert.equal(off.backlog, 0);
  assert.equal(backlogTotal({}), 0);
});
