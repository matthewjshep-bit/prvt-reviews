// lane-breaker.test.mjs — the rules that pause a send lane (shared/lane-breaker.js).
//
// 2026-11-23 audit (AH-4): the first 49 lot-owner texts had 15 carrier blocks
// and nothing stopped the lane; the delivery check only reads sends 2 hours
// old and up. Every id and time below is made up.

import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLaneBreaker, laneVerdict, stoppedSends, carrierBlocked, sendRead, heldKinds, holdFlag, isHoldFlag, slackTripLine,
  laneRunGate, laneSince, pacificDayStart, pacificDay, LANE_BREAKER_DEFAULTS, LANE_MAX_DAILY_TRIES, LANE_STALE_RUN_MS, LANE_KINDS,
} from "./lane-breaker.js";
import { normalizeConversationAi } from "./conversation-ai.js";

const NOW = Date.parse("2026-11-24T19:00:00Z"); // Monday 11am Pacific
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();
const send = (i, over = {}) => ({ id: `s${i}`, contactId: `c${i}`, sentAt: minsAgo(200 - i), kind: "lot_owner_open", ...over });
const blocked = { delivery: { status: "failed", code: "30007" } };
const ok = { delivery: { status: "delivered", code: null } };

test("the lane breaker ships on, a save that switches it off keeps it off, and no threshold can be saved away", () => {
  assert.equal(normalizeConversationAi({}).laneBreaker.enabled, true);
  assert.deepEqual(normalizeConversationAi({}).laneBreaker.kinds, [...LANE_KINDS]);
  const off = normalizeConversationAi({ laneBreaker: { enabled: false } });
  assert.equal(off.laneBreaker.enabled, false);
  assert.equal(normalizeConversationAi(JSON.parse(JSON.stringify(off))).laneBreaker.enabled, false, "a second save keeps it off");
  const silly = normalizeLaneBreaker({ earlyBlocked: 0, earlyStops: -3, rollingStopPct: 0, minCount: 0, kinds: ["lot_owner_open", "not_a_kind"] });
  assert.equal(silly.earlyBlocked, 1);
  assert.equal(silly.earlyStops, 1);
  assert.equal(silly.rollingStopPct, 1);
  assert.equal(silly.minCount, 1);
  assert.deepEqual(silly.kinds, ["lot_owner_open"]);
  assert.equal(normalizeLaneBreaker({ earlyBlocked: "" }).earlyBlocked, LANE_BREAKER_DEFAULTS.earlyBlocked);
});

test("a lane whose first owner texts come back carrier-blocked trips at the fourth block, without waiting for twenty", () => {
  const early = [send(1, blocked), send(2, ok), send(3, blocked), send(4, blocked), send(5, ok), send(6, blocked), send(7), send(8)];
  const v = laneVerdict({ kind: "lot_owner_open", early, recent: [...early].reverse() });
  assert.equal(v.trip, true);
  assert.equal(v.rule, "early_blocked");
  assert.match(v.why, /4 of the first 8 lot owner first texts today were blocked by the carrier \(30007\)/);
  assert.deepEqual(v.counts.early, { sent: 8, read: 6, blocked: 4, stops: 0 });
});

test("three blocks in the first twenty, and dead numbers, do not trip it", () => {
  const dead = { delivery: { status: "failed", code: "30006" } };
  const early = Array.from({ length: 20 }, (_, i) => send(i, i < 3 ? blocked : i < 9 ? dead : ok));
  const v = laneVerdict({ kind: "lot_owner_open", early, recent: early });
  assert.equal(v.trip, false, "dead numbers are the list, not the carrier's view of us");
  assert.equal(carrierBlocked(send(1, dead)), false);
  assert.equal(carrierBlocked(send(1, { laneRead: { status: "failed", code: "30007" } })), true, "the breaker's own early read counts");
  assert.equal(sendRead(send(1)), false);
});

test("a STOP the day after a nudge counts against the nudge, not the first text", () => {
  const open = { id: "o1", contactId: "c1", sentAt: minsAgo(60 * 30), kind: "outreach_open" };
  const nudge = { id: "n1", contactId: "c1", sentAt: minsAgo(60 * 6), kind: "outreach_nudge" };
  const stop = { contactId: "c1", at: minsAgo(60 * 2), type: "unsubscribed", data: { via: "sms_keyword" } };
  assert.deepEqual([...stoppedSends([open, nudge], [stop])], ["n1"]);
  assert.deepEqual([...stoppedSends([open], [{ ...stop, at: new Date(NOW + 80 * 3600000).toISOString() }])], [], "a STOP more than 72 hours on counts against nothing");
  assert.deepEqual([...stoppedSends([open, nudge], [{ ...stop, data: { via: "backfill" } }])], [], "a backfilled STOP carries the backfill's time, not theirs");
  assert.deepEqual([...stoppedSends([nudge], [{ ...stop, at: minsAgo(60 * 8) }])], [], "a STOP before the text isn't the text's");
});

test("four STOPs in the first twenty of a kind today trip it, and three do not", () => {
  const early = Array.from({ length: 12 }, (_, i) => send(i, { kind: "outreach_nudge" }));
  const v = laneVerdict({ kind: "outreach_nudge", early, recent: early, stopped: new Set(["s2", "s5", "s9", "s11"]) });
  assert.equal(v.rule, "early_stops");
  assert.match(v.why, /4 of the first 12 agent nudges today got a STOP/);
  assert.equal(laneVerdict({ kind: "outreach_nudge", early, recent: early, stopped: new Set(["s2", "s5", "s9"]) }).trip, false);
});

test("the rolling rules: 10% blocked of the last fifty read, or 8% STOPs, never on fewer than four", () => {
  const fifty = (fn) => Array.from({ length: 50 }, (_, i) => send(i, fn(i)));
  // 5 of 50 read blocked: 10%.
  assert.equal(laneVerdict({ kind: "agent_pulse", early: [], recent: fifty((i) => (i % 10 === 0 ? blocked : ok)) }).rule, "rolling_blocked");
  // 4 of 50: not yet.
  assert.equal(laneVerdict({ kind: "agent_pulse", early: [], recent: fifty((i) => (i % 10 === 0 && i < 40 ? blocked : ok)) }).trip, false);
  // 4 STOPs of 50 is 8%.
  const stops4 = new Set(["s1", "s11", "s21", "s31"]);
  assert.equal(laneVerdict({ kind: "agent_pulse", early: [], recent: fifty(() => ok), stopped: stops4 }).rule, "rolling_stops");
  assert.equal(laneVerdict({ kind: "agent_pulse", early: [], recent: fifty(() => ok), stopped: new Set(["s1", "s11", "s21"]) }).trip, false);
  // Twenty sends: 8% would be two STOPs, but the floor is four.
  const twenty = Array.from({ length: 20 }, (_, i) => send(i, ok));
  assert.equal(laneVerdict({ kind: "agent_pulse", early: [], recent: twenty, stopped: new Set(["s1", "s2", "s3"]) }).trip, false);
  // Thirty read with three blocked is 10%, but under the floor.
  assert.equal(laneVerdict({ kind: "agent_pulse", early: [], recent: Array.from({ length: 30 }, (_, i) => send(i, i < 3 ? blocked : ok)) }).trip, false);
  // Under twenty read, the rolling block rule waits.
  const few = Array.from({ length: 10 }, (_, i) => send(i, i < 3 ? blocked : ok));
  assert.equal(laneVerdict({ kind: "agent_pulse", early: [], recent: few }).trip, false);
});

test("a held kind is only held while the breaker is on, and the flag says why without anyone's name", () => {
  const doc = { trips: { lot_owner_open: { at: minsAgo(5), why: "x" } } };
  assert.deepEqual([...heldKinds(doc).keys()], ["lot_owner_open"]);
  assert.equal(heldKinds(doc, { enabled: false }).size, 0, "switched off, it holds nothing");
  const f = holdFlag("lot_owner_open", "4 of the first 8 lot owner first texts today were blocked by the carrier (30007)");
  assert.ok(isHoldFlag(f));
  assert.match(f, /^held: /);
  const line = slackTripLine({ kind: "lot_owner_open", why: "4 of the first 8 were blocked", held: 212, mattUserId: "U0MATT123" });
  assert.match(line, /^<@U0MATT123> Lane breaker: lot owner first texts are stopped\. 4 of the first 8 were blocked\. 212 queued texts went back to drafts/);
  assert.match(line, /Nothing was sent/);
});

test("the breaker runs every tick, retries a stale run, and caps its day", () => {
  assert.equal(laneRunGate({}, NOW).go, true);
  assert.equal(laneRunGate({ lastRun: minsAgo(5), day: pacificDay(NOW), tries: 3 }, NOW).go, false);
  assert.equal(laneRunGate({ lastRun: minsAgo(15), day: pacificDay(NOW), tries: 3 }, NOW).tries, 4);
  assert.equal(laneRunGate({ run: { startedAt: minsAgo(2) }, lastRun: minsAgo(20) }, NOW).why, "a run is going");
  const stale = laneRunGate({ run: { startedAt: new Date(NOW - LANE_STALE_RUN_MS - 1).toISOString() }, lastRun: minsAgo(12) }, NOW);
  assert.equal(stale.go, true);
  assert.equal(stale.stale, true);
  assert.equal(laneRunGate({ lastRun: minsAgo(20), day: pacificDay(NOW), tries: LANE_MAX_DAILY_TRIES }, NOW).go, false);
});

test("today starts at midnight Pacific, and a lane Matt cleared is judged only on what went after", () => {
  assert.equal(new Date(pacificDayStart(NOW)).toISOString(), "2026-11-24T08:00:00.000Z");
  assert.equal(new Date(pacificDayStart(Date.parse("2026-07-01T18:00:00Z"))).toISOString(), "2026-07-01T07:00:00.000Z");
  const s = laneSince({ cleared: { lot_owner_open: { at: minsAgo(30) } } }, "lot_owner_open", { now: NOW });
  assert.equal(s.earlyFrom, minsAgo(30));
  assert.equal(s.rollingFrom, minsAgo(30));
  const t = laneSince({}, "lot_owner_open", { now: NOW });
  assert.equal(t.earlyFrom, "2026-11-24T08:00:00.000Z");
});
