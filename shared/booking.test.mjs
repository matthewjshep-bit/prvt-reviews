import test from "node:test";
import assert from "node:assert/strict";
import { slotLabel, pickSlots, evaluateBookingGuard, looksLikeScheduling, bookingContextText } from "./booking.js";

const TZ = "America/Los_Angeles";
const NOW = Date.parse("2026-09-10T16:00:00Z"); // Thu 9am PT

test("a slot label is short, exact, and in the operator's zone", () => {
  assert.equal(slotLabel("2026-09-11T14:00:00-07:00", TZ), "Fri Sep 11 at 2:00pm");
  assert.equal(slotLabel("2026-09-11T21:30:00Z", TZ), "Fri Sep 11 at 2:30pm");
  assert.equal(slotLabel("garbage", TZ), "");
});

test("picking spreads the offers across days and respects the lead time", () => {
  const free = [
    "2026-09-10T16:30:00Z", // 9:30am today — inside the 2h lead, dropped
    "2026-09-10T19:00:00Z", "2026-09-10T20:00:00Z",
    "2026-09-11T17:00:00Z", "2026-09-11T18:00:00Z",
    "2026-09-14T17:00:00Z",
  ];
  const picked = pickSlots(free, { now: NOW, count: 3, minLeadHours: 2, timeZone: TZ });
  assert.deepEqual(picked.map((s) => s.iso), ["2026-09-10T19:00:00Z", "2026-09-11T17:00:00Z", "2026-09-14T17:00:00Z"]);
  assert.equal(picked[0].label, "Thu Sep 10 at 12:00pm");
  assert.equal(pickSlots([], { now: NOW }).length, 0);
});

// 2026-10-28: the bot offered an agent "Thu Oct 29 at 8:00am or Fri Oct 30
// at 8:00am" because 8am was the calendar's first free slot. Matt's calls
// start at 9.
test("a call is never offered before 9am, even when the calendar is free at 8", () => {
  const free = [
    "2026-10-29T15:00:00Z", "2026-10-29T15:30:00Z", // Thu 8:00, 8:30am PT
    "2026-10-29T16:00:00Z",                         // Thu 9:00am PT
    "2026-10-30T15:00:00Z", "2026-10-30T16:30:00Z", // Fri 8:00, 9:30am PT
  ];
  const now = Date.parse("2026-10-28T22:00:00Z");
  const picked = pickSlots(free, { now, count: 2, minLeadHours: 2, timeZone: TZ });
  assert.deepEqual(picked.map((s) => s.label), ["Thu Oct 29 at 9:00am", "Fri Oct 30 at 9:30am"]);
  const early = pickSlots(free, { now, count: 2, minLeadHours: 2, earliestHour: 8, timeZone: TZ });
  assert.equal(early[0].label, "Thu Oct 29 at 8:00am");
});

const offered = [
  { iso: "2026-09-11T17:00:00Z", label: "Fri Sep 11 at 10:00am" },
  { iso: "2026-09-11T21:00:00Z", label: "Fri Sep 11 at 2:00pm" },
];

test("proposing times passes only when every named time is from the calendar and in the text verbatim", () => {
  const good = evaluateBookingGuard({ draft: { reply: "Sure — does Fri Sep 11 at 10:00am or Fri Sep 11 at 2:00pm work?", offeredSlots: offered.map((s) => s.iso) }, offered, now: NOW });
  assert.equal(good.passed, true);
  assert.equal(good.offered.length, 2);
  const invented = evaluateBookingGuard({ draft: { reply: "How about Fri Sep 11 at 4:00pm?", offeredSlots: ["2026-09-11T23:00:00Z"] }, offered, now: NOW });
  assert.equal(invented.passed, false);
  assert.match(invented.reason, /not on the calendar/);
  const paraphrased = evaluateBookingGuard({ draft: { reply: "Friday morning at ten?", offeredSlots: [offered[0].iso] }, offered, now: NOW });
  assert.equal(paraphrased.passed, false);
  assert.match(paraphrased.reason, /as written/);
  const none = evaluateBookingGuard({ draft: { reply: "Let me check my calendar and get back to you.", offeredSlots: [] }, offered, now: NOW });
  assert.equal(none.passed, false);
  assert.match(none.reason, /no time was offered/);
  const tooMany = evaluateBookingGuard({ draft: { reply: "a Fri Sep 11 at 10:00am b Fri Sep 11 at 2:00pm", offeredSlots: offered.map((s) => s.iso) }, offered, config: { slotsToOffer: 1 }, now: NOW });
  assert.equal(tooMany.passed, false);
});

test("a pick books only a time we offered that is still free, confirmed in our words", () => {
  const free = ["2026-09-11T17:00:00Z"];
  const ok = evaluateBookingGuard({ draft: { reply: "Great, Fri Sep 11 at 10:00am it is — I'll call you then.", chosenSlot: "2026-09-11T17:00:00Z" }, previouslyOffered: offered, freeSlots: free, now: NOW });
  assert.equal(ok.passed, true);
  assert.equal(ok.chosen.label, "Fri Sep 11 at 10:00am");
  const gone = evaluateBookingGuard({ draft: { reply: "Fri Sep 11 at 2:00pm works", chosenSlot: "2026-09-11T21:00:00Z" }, previouslyOffered: offered, freeSlots: free, now: NOW });
  assert.equal(gone.passed, false);
  assert.match(gone.reason, /no longer free/);
  const never = evaluateBookingGuard({ draft: { reply: "Sat at noon", chosenSlot: "2026-09-12T19:00:00Z" }, previouslyOffered: offered, freeSlots: free, now: NOW });
  assert.match(never.reason, /never offered/);
  // an offset-formatted ISO for the same instant still matches
  const offsetOk = evaluateBookingGuard({ draft: { reply: "Fri Sep 11 at 10:00am", chosenSlot: "2026-09-11T10:00:00-07:00" }, previouslyOffered: offered, freeSlots: ["2026-09-11T10:00:00-07:00"], now: NOW });
  assert.equal(offsetOk.passed, true);
});

test("the cheap pre-check reads a time on the table, and the context block carries the labels", () => {
  assert.equal(looksLikeScheduling("can you give me a call tomorrow"), true);
  assert.equal(looksLikeScheduling("Thurs 2pm?"), true);
  assert.equal(looksLikeScheduling("still interested in the house?"), false);
  const t = bookingContextText({ offered, previouslyOffered: [offered[0]] });
  assert.match(t, /ALREADY OFFERED/);
  assert.match(t, /Fri Sep 11 at 2:00pm  →  2026-09-11T21:00:00Z/);
});
