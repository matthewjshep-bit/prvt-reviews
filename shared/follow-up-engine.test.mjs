// follow-up-engine.test.mjs — Reports → Follow-up, the arithmetic.
//
//   node --test shared/follow-up-engine.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  periodWindow, pacificDayKey, runsBetween, rollOntoRuns, dedupePlanned, attributeReplies, buildFollowUpEngine,
  mechanismOf, describeMechanism, FOLLOW_UP_MECHANISMS, FOLLOW_UP_GROUPS, EXCLUDED_KINDS,
} from "./follow-up-engine.js";
import { MACHINE_STARTED_KINDS } from "./follow-up.js";
import { addWorkingHours, workingHoursBetween } from "./paper-follows.js";

const HOUR = 3600000, DAY = 24 * HOUR;
// Saturday 2026-10-17, noon Pacific.
const NOW = Date.parse("2026-10-17T19:00:00Z");

test("the week starts on Monday, Pacific time", () => {
  const w = periodWindow("week", NOW);
  assert.equal(new Date(w.start).toISOString(), "2026-10-12T07:00:00.000Z");
  assert.equal(w.buckets.length, 7);
  assert.equal(w.buckets[0].label, "Mon 12");
  assert.equal(w.buckets.at(-1).label, "Sun 18");
});

test("the week the clocks go back still has seven days, one of them 25 hours", () => {
  const w = periodWindow("week", Date.parse("2026-10-30T19:00:00Z"));
  assert.equal(w.buckets.length, 7);
  assert.deepEqual(w.buckets.map((b) => (b.end - b.start) / HOUR), [24, 24, 24, 24, 24, 24, 25]);
  assert.equal(pacificDayKey(w.buckets.at(-1).start + HOUR), "2026-11-01");
});

test("today is hours, the month is its days, the year is weeks plus thirty days ahead", () => {
  assert.equal(periodWindow("today", NOW).buckets.length, 24);
  assert.equal(periodWindow("month", NOW).buckets.length, 31);
  const y = periodWindow("ytd", NOW);
  assert.equal(new Date(y.start).toISOString(), "2026-01-01T08:00:00.000Z");
  assert.equal(new Date(y.end).toISOString(), "2026-11-17T08:00:00.000Z");
  assert.equal(y.unit, "week");
});

test("a once-a-day job skips the weekend and lands at noon Pacific across the time change", () => {
  const runs = runsBetween({ hour: 12, from: Date.parse("2026-10-30T00:00:00Z"), until: Date.parse("2026-11-04T00:00:00Z") });
  assert.deepEqual(runs.map((t) => new Date(t).toISOString()), ["2026-10-30T19:00:00.000Z", "2026-11-02T20:00:00.000Z", "2026-11-03T20:00:00.000Z"]);
});

test("agents due beyond the day's cap wait for the next workday's run", () => {
  const fri3pm = Date.parse("2026-10-16T22:00:00Z");
  const due = [0, 1, 2].map((i) => ({ id: i, due: new Date(fri3pm - 1000).toISOString() }));
  const out = rollOntoRuns(due, { hour: 12, cap: 2, now: fri3pm, until: fri3pm + 7 * DAY });
  // Friday's run is still in its window: two go now, one on Monday.
  assert.deepEqual(out.map((x) => x.at), ["2026-10-16T22:00:00.000Z", "2026-10-16T22:00:00.000Z", "2026-10-19T19:00:00.000Z"]);
  const ran = rollOntoRuns(due, { hour: 12, cap: 2, now: fri3pm, until: fri3pm + 7 * DAY, ranToday: true });
  assert.equal(ran[0].at, "2026-10-19T19:00:00.000Z");
});

test("a queued draft and a plan for the same agent count once", () => {
  const at = new Date(NOW + DAY).toISOString();
  const queued = [{ mech: "offer_nudge", contactId: "c1", offerId: "o1", at }];
  const planned = [{ mech: "offer_nudge", contactId: "c1", offerId: "o1", at }, { mech: "agent_pulse", contactId: "c2", at }];
  assert.deepEqual(dedupePlanned(planned, queued).map((p) => p.contactId), ["c2"]);
  const page = buildFollowUpEngine({ period: "week", now: NOW, queued, planned, status: { offer_nudge: { state: "on" }, agent_pulse: { state: "on" } } });
  const nudge = page.groups.find((g) => g.key === "offer_live").mechanisms.find((m) => m.key === "offer_nudge");
  assert.equal(nudge.queued, 1);
  assert.equal(nudge.planned, 0);
});

test("two offers to one agent on the same morning plan one text, the push to paper first", () => {
  const at = "2026-10-19T16:00:00.000Z";
  const out = dedupePlanned([
    { mech: "offer_nudge", contactId: "c1", offerId: "o1", at },
    { mech: "hot_push", contactId: "c1", offerId: "o2", at },
    { mech: "offer_nudge", contactId: "c1", offerId: "o3", at: "2026-10-20T16:00:00.000Z" },
  ]);
  assert.deepEqual(out.map((p) => p.offerId).sort(), ["o2", "o3"]);
});

test("a reply after the second nudge credits only the second, and one four days later credits nothing", () => {
  const t0 = Date.parse("2026-10-10T16:00:00Z");
  const sends = [
    { id: "a", contactId: "c1", at: new Date(t0).toISOString() },
    { id: "b", contactId: "c1", at: new Date(t0 + 3 * DAY).toISOString() },
    { id: "c", contactId: "c2", at: new Date(t0).toISOString() },
  ];
  const inbound = [
    { contactId: "c1", at: new Date(t0 + 3 * DAY + HOUR).toISOString() },
    { contactId: "c2", at: new Date(t0 + 4 * DAY).toISOString() },
  ];
  assert.deepEqual([...attributeReplies(sends, inbound)], ["b"]);
});

test("each mechanism counts sends from its own source only", () => {
  const at = new Date(NOW - DAY).toISOString();
  const page = buildFollowUpEngine({
    period: "week", now: NOW,
    sent: [
      // The check-in went: the event counts, the outbox row for it doesn't.
      { mech: "agent_pulse", src: "event", contactId: "c1", at },
      { mech: "agent_pulse", src: "draft", contactId: "c1", at },
      { mech: "offer_nudge", src: "draft", contactId: "c2", at },
    ],
  });
  const agent = page.groups.find((g) => g.key === "agent").mechanisms.find((m) => m.key === "agent_pulse");
  assert.equal(agent.sent, 1);
  assert.equal(page.kpis.sent, 2);
});

test("a first text and a float are shown but are not follow-ups", () => {
  const at = new Date(NOW - DAY).toISOString();
  const page = buildFollowUpEngine({ period: "week", now: NOW, sent: [
    { mech: "outreach_open", src: "event", contactId: "c1", at },
    { mech: "float", src: "draft", contactId: "c2", at },
  ] });
  assert.equal(page.kpis.sent, 0);
  assert.equal(page.groups.find((g) => g.key === "outreach").mechanisms[0].sent, 1);
});

test("a plan already past due shows as due now, and nothing past the period is counted", () => {
  const page = buildFollowUpEngine({ period: "week", now: NOW, planned: [
    { mech: "offer_nudge", contactId: "c1", offerId: "o1", at: new Date(NOW - 2 * DAY).toISOString() },
    { mech: "offer_nudge", contactId: "c2", offerId: "o2", at: new Date(NOW + 30 * DAY).toISOString() },
  ] });
  const item = page.items.find((x) => x.contactId === "c1");
  assert.equal(item.overdue, true);
  assert.equal(item.at, new Date(NOW).toISOString());
  assert.equal(page.kpis.planned, 1);
});

test("the year to date says where the outbox's 180 days begin", () => {
  const page = buildFollowUpEngine({ period: "ytd", now: NOW, retentionDays: 180 });
  assert.equal(page.floors.draftsFrom, new Date(NOW - 180 * DAY).toISOString());
  const nudge = page.groups.find((g) => g.key === "offer_live").mechanisms.find((m) => m.key === "offer_nudge");
  assert.equal(nudge.countedFrom, page.floors.draftsFrom);
  // Event-sourced rows are whole.
  assert.equal(page.groups.find((g) => g.key === "agent").mechanisms.find((m) => m.key === "agent_pulse").countedFrom, null);
  assert.equal(buildFollowUpEngine({ period: "week", now: NOW }).floors.draftsFrom, undefined);
});

test("status reads Drafts only when the mechanism writes but doesn't send itself", () => {
  const page = buildFollowUpEngine({ period: "week", now: NOW, status: { offer_nudge: { state: "drafts", why: "not on the agent auto-send list" } } });
  const m = page.groups.find((g) => g.key === "offer_live").mechanisms.find((x) => x.key === "offer_nudge");
  assert.equal(m.statusLabel, "Drafts only");
  assert.match(m.statusWhy, /auto-send/);
});

test("the sketch's blocks, in order, with buyers last", () => {
  assert.deepEqual(FOLLOW_UP_GROUPS.map((g) => g.key), ["outreach", "agent", "offer_live", "offer_passed", "buyer"]);
  for (const m of FOLLOW_UP_MECHANISMS) assert.ok(FOLLOW_UP_GROUPS.some((g) => g.key === m.group), m.key);
});

test("every kind the machine starts has a row here or is left out on purpose", () => {
  const known = new Set(FOLLOW_UP_MECHANISMS.flatMap((m) => m.kinds));
  for (const k of [...MACHINE_STARTED_KINDS, "blast_open"]) {
    assert.ok(known.has(k) || EXCLUDED_KINDS.has(k) || k === "blast_open" || k === "agent_pulse", `${k} has no row`);
  }
});

test("a deal text is the first wave or a later one, and Matt's 15 is his own row", () => {
  assert.equal(mechanismOf({ outbound: { kind: "blast_open" } }, { wave: 1 }), "blast_first");
  assert.equal(mechanismOf({ outbound: { kind: "blast_open" } }, { wave: 2 }), "blast_wave");
  assert.equal(mechanismOf({ outbound: { kind: "agent_pulse", forMatt: true } }), "matts_fifteen");
  assert.equal(mechanismOf({ outbound: { kind: "realm_check" } }), "float");
  assert.equal(mechanismOf({ outbound: { kind: "check_in" } }), null);
  assert.equal(mechanismOf({ intent: "question" }), null);
});

test("the plain words come from the live settings", () => {
  const s = { fu: { minHoursBetween: 72, ladders: { offer_nudge: { steps: [3, 7, 14], repeatEvery: 7 } } }, agentPulse: { everyDays: 14, dailyCap: 0, hour: 12 } };
  assert.match(describeMechanism("offer_nudge", s), /days 3, 7 and 14, then every 7 days/);
  assert.match(describeMechanism("agent_pulse", s), /every 14 days/);
  assert.match(describeMechanism("agent_pulse", s), /no daily cap/);
});

test("the written offer's working hours run the other way round", () => {
  const fri4pm = Date.parse("2026-10-16T23:00:00Z");
  const at = addWorkingHours(fri4pm, 24);
  assert.equal(new Date(at).toISOString(), "2026-10-19T23:00:00.000Z");
  assert.equal(workingHoursBetween(fri4pm, at), 24);
});
