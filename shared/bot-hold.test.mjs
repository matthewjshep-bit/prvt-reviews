// bot-hold.test.mjs — what "stop the bot on them" means, read one way.

import test from "node:test";
import assert from "node:assert/strict";
import { botHold, holdLine, pauseUntil, pauseDay, mergeEvents, BOT_EVENT_TYPES, MAX_PAUSE_DAYS } from "./bot-hold.js";

const NOW = Date.parse("2026-10-01T18:00:00Z");
const DAY = 86400000;
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const ahead = (d) => new Date(NOW + d * DAY).toISOString();
const stop = (d, over = {}) => ({ type: "drive_stopped", contactId: "c1", at: ago(d), data: { reason: "" }, ...over });
const resume = (d, over = {}) => ({ type: "drive_resumed", contactId: "c1", at: ago(d), data: {}, ...over });

test("a stop holds until Resume, and the newest press wins", () => {
  assert.equal(botHold({ events: [], now: NOW }).held, false);
  const held = botHold({ events: [stop(3)], now: NOW });
  assert.equal(held.held, true);
  assert.equal(held.kind, "stopped");
  assert.equal(held.until, null);
  assert.equal(held.since, ago(3));
  assert.equal(botHold({ events: [stop(3), resume(1)], now: NOW }).held, false, "resumed");
  assert.equal(botHold({ events: [resume(5), stop(3)], now: NOW }).held, true, "stopped again after a resume");
  // Order in the list doesn't matter; the time does.
  assert.equal(botHold({ events: [resume(1), stop(3)], now: NOW }).held, false);
});

test("a pause ends by itself on its date with no Resume pressed", () => {
  const paused = stop(2, { data: { until: ahead(5) } });
  const h = botHold({ events: [paused], now: NOW });
  assert.equal(h.held, true);
  assert.equal(h.kind, "paused");
  assert.equal(h.until, ahead(5));
  const after = botHold({ events: [paused], now: NOW + 6 * DAY });
  assert.equal(after.held, false);
  assert.equal(after.endedAt, ahead(5), "the column can say the pause ran out");
});

test("a stop on one house leaves the agent's other houses alone; a stop with no house is the whole person", () => {
  const onElm = stop(2, { offerId: "elm" });
  assert.equal(botHold({ events: [onElm], offerId: "elm", now: NOW }).held, true);
  assert.equal(botHold({ events: [onElm], offerId: "oak", now: NOW }).held, false, "another house");
  assert.equal(botHold({ events: [onElm], now: NOW }).held, true, "no house named: any stop counts");
  assert.equal(botHold({ events: [onElm], wholeThreadOnly: true, now: NOW }).held, false, "the agent pulse talks to the person, not about a house");
  const whole = stop(2);
  assert.equal(botHold({ events: [whole], offerId: "oak", now: NOW }).held, true);
  assert.equal(botHold({ events: [whole], wholeThreadOnly: true, now: NOW }).held, true);
});

test("a pause past five weeks, or in the past, is refused", () => {
  assert.deepEqual(pauseUntil({ now: NOW }), { until: null }, "no date: a stop until Resume");
  assert.equal(pauseUntil({ preset: "1w", now: NOW }).until, ahead(7));
  assert.equal(pauseUntil({ preset: "2w", now: NOW }).until, ahead(14));
  assert.equal(pauseUntil({ preset: "1m", now: NOW }).until, ahead(30));
  assert.match(pauseUntil({ preset: "6w", now: NOW }).error, /1 week, 2 weeks or 1 month/);
  assert.match(pauseUntil({ until: ahead(MAX_PAUSE_DAYS + 1), now: NOW }).error, /next five weeks/);
  assert.match(pauseUntil({ until: ago(1), now: NOW }).error, /in the future/);
  assert.match(pauseUntil({ until: "next tuesday", now: NOW }).error, /isn't a date/);
  assert.equal(pauseUntil({ until: ahead(10), now: NOW }).until, ahead(10));
});

test("the reason you typed never appears in the line the machine logs", () => {
  const typed = stop(1, { data: { reason: "Dana Reyes is calling the seller 206-555-0101" } });
  const h = botHold({ events: [typed], now: NOW });
  assert.equal(h.reason, "Dana Reyes is calling the seller 206-555-0101", "kept for the screen");
  assert.equal(holdLine(h), "you stopped the bot on them");
  const p = botHold({ events: [stop(1, { data: { reason: "Dana Reyes", until: "2026-10-15T18:00:00Z" } })], now: NOW });
  assert.equal(holdLine(p), "paused until Oct 15");
  assert.doesNotMatch(holdLine(p), /Dana/);
  assert.equal(holdLine(botHold({ events: [], now: NOW })), "");
});

test("a pause day reads in Pacific time", () => {
  // 03:00 UTC on Oct 16 is still Oct 15 in Seattle.
  assert.equal(pauseDay("2026-10-16T03:00:00Z"), "Oct 15");
  assert.equal(pauseDay(""), "");
});

test("one timeline from two reads keeps each event once", () => {
  const a = [{ id: 1, type: "drive_stopped", at: ago(2) }, { type: "note", at: ago(1), dedupeKey: "n1" }];
  const b = [{ id: 1, type: "drive_stopped", at: ago(2) }, { type: "note", at: ago(1), dedupeKey: "n1" }, { id: 2, type: "drive_resumed", at: ago(0.5) }];
  assert.equal(mergeEvents(a, b).length, 3);
  assert.equal(mergeEvents(null, undefined, a).length, 2);
});

test("the stop is read from the stop, resume, pace and unsubscribe events", () => {
  assert.deepEqual(BOT_EVENT_TYPES, ["drive_stopped", "drive_resumed", "cadence_set", "unsubscribed"]);
});
