import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeShowing, applyShowingEdit, windowLabel, walkthroughAsk, agentAskText, recordRsvp,
  showingContextLines, showingSummary, upcomingWindows,
} from "./showing.js";

// Sat Oct 3 2026, 10am–12pm Pacific (PDT, UTC−7).
const SAT = { start: "2026-10-03T17:00:00.000Z", end: "2026-10-03T19:00:00.000Z" };
const SUN = { start: "2026-10-04T18:30:00.000Z", end: "2026-10-04T20:00:00.000Z" };
const NOW = Date.parse("2026-09-29T16:00:00Z");

test("a window reads the way a person texts it, with no dash the carrier scrub would eat", () => {
  assert.equal(windowLabel(SAT), "Sat Oct 3, 10am-12pm");
  assert.equal(windowLabel(SUN), "Sun Oct 4, 11:30am-1pm");
  assert.equal(windowLabel({ start: "2026-10-03T20:00:00Z", end: "2026-10-03T21:00:00Z" }), "Sat Oct 3, 1-2pm");
  assert.equal(windowLabel({}), "");
});

test("a buyer is invited to the deal's window, or asked when they could come when there is none", () => {
  assert.equal(walkthroughAsk({ showing: null, now: NOW }), "When could you get out to walk it?");
  assert.equal(walkthroughAsk({ showing: { windows: [SAT] }, now: NOW }), "Walkthrough is Sat Oct 3, 10am-12pm. Can you make it?");
  assert.equal(walkthroughAsk({ showing: { windows: [SUN, SAT] }, now: NOW }), "Walkthroughs are Sat Oct 3, 10am-12pm or Sun Oct 4, 11:30am-1pm. Which works for you?");
  // A window that has ended is no invitation.
  assert.equal(walkthroughAsk({ showing: { windows: [SAT] }, now: Date.parse("2026-10-03T20:00:00Z") }), "When could you get out to walk it?");
});

test("the stored shape survives junk: bad times dropped, a backwards end becomes an hour, one answer per buyer", () => {
  const s = normalizeShowing({
    windows: [{ start: "nope" }, { start: SAT.start, end: "2026-10-03T16:00:00Z" }],
    access: { mode: "helicopter", note: "x" },
    rsvps: [{ contactId: "c1", status: "coming" }, { contactId: "c1", status: "interested" }, { contactId: "c2", status: "maybe" }],
  });
  assert.deepEqual(s.windows, [{ start: SAT.start, end: "2026-10-03T18:00:00.000Z" }]);
  assert.equal(s.access.mode, "");
  assert.equal(s.rsvps.length, 1);
  assert.equal(s.agentAsk.status, "none");
});

test("typing in a window settles the ask to the agent", () => {
  const asked = applyShowingEdit(null, { agentAsk: { status: "asked", at: "2026-09-29T16:00:00Z" } });
  assert.equal(asked.agentAsk.status, "asked");
  const set = applyShowingEdit(asked, { windows: [SAT], access: { mode: "lockbox" } });
  assert.equal(set.agentAsk.status, "confirmed");
  assert.equal(set.access.mode, "lockbox");
});

test("the latest walkthrough answer wins, but 'interested' never undoes a yes and the bot never undoes a walked-it", () => {
  let s = recordRsvp(null, { contactId: "c1", name: "Rick", status: "interested" });
  s = recordRsvp(s, { contactId: "c1", status: "coming" });
  assert.equal(s.rsvps[0].status, "coming");
  assert.equal(s.rsvps[0].name, "Rick");
  s = recordRsvp(s, { contactId: "c1", status: "interested" });
  assert.equal(s.rsvps[0].status, "coming");
  s = recordRsvp(s, { contactId: "c1", status: "attended", source: "manual" });
  s = recordRsvp(s, { contactId: "c1", status: "cant_make_it" });
  assert.equal(s.rsvps[0].status, "attended");
});

test("the listing agent is asked for a window and how buyers get in, never for one buyer's time", () => {
  const t = agentAskText({ agentName: "Mick Walls", address: "3511 Northeast 153rd Street, Lake Forest Park, WA" });
  assert.match(t, /^Hi Mick, /);
  assert.match(t, /3511 Northeast 153rd Street this week/);
  assert.match(t, /time window/);
  assert.match(t, /lockbox\?$/);
});

test("the investor prompt hears the window and how access works, never another buyer's name", () => {
  const s = { windows: [SAT], access: { mode: "agent" }, rsvps: [{ contactId: "c1", name: "Rick", status: "coming" }, { contactId: "c2", name: "Taj", status: "coming" }] };
  const lines = showingContextLines(s, { contactId: "c1", now: NOW });
  assert.equal(lines[0], "walkthrough window: Sat Oct 3, 10am-12pm");
  assert.match(lines[1], /listing agent lets buyers in/);
  assert.match(lines[2], /coming/);
  assert.match(lines[3], /2 buyers are coming/);
  assert.doesNotMatch(lines.join(" "), /Rick|Taj/);
  assert.match(showingContextLines(null, { now: NOW })[0], /no window set yet/);
});

test("the summary counts who is coming to the next window", () => {
  const sum = showingSummary({ windows: [SAT], rsvps: [{ contactId: "c1", status: "coming" }, { contactId: "c2", status: "interested" }] }, NOW);
  assert.equal(sum.nextLabel, "Sat Oct 3, 10am-12pm");
  assert.equal(sum.coming, 1);
  assert.equal(sum.interested, 1);
  assert.equal(Math.round(sum.hoursToNext), 97);
  assert.equal(upcomingWindows({ windows: [SAT] }, Date.parse("2026-10-04T00:00:00Z")).length, 0);
});
