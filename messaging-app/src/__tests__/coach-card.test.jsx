import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CoachBody } from "../CoachCard.jsx";

const base = { enabled: true, hour: 20, canFile: false, run: null, last: null, open: [], applied: [], settled: [] };
const example = { id: "p1", status: "open", kind: "example", party: "agent", intent: "price_pushback", theySaid: "That's way too low.", weSay: "Fair. It's what the numbers gave me.", why: "you cut the sympathetic opener twice", evidence: ["d1", "d2"] };

test("switched off and never run, the card takes no room on Today", () => {
  expect(renderToStaticMarkup(<CoachBody coach={{ ...base, enabled: false }} />)).toBe("");
});

test("an open example shows both sides in your words, why, and Apply / Reject — nothing reads as already done", () => {
  const html = renderToStaticMarkup(<CoachBody coach={{ ...base, open: [example], last: { trigger: "daily", status: "done", finishedAt: "2026-09-18T03:21:00Z", counts: { edits: 3, dismissals: 1, yours: 0, errors: 0 }, summary: "You keep cutting the opener.", dropped: [{ kind: "rule", reason: "names an amount — money stays hand-edited" }] } }} />);
  expect(html).toContain("Learned last night");
  expect(html).toContain("Fair. It&#x27;s what the numbers gave me.");
  expect(html).toContain("you cut the sympathetic opener twice");
  expect(html).toContain("from 2 drafts");
  expect(html).toContain(">Apply<");
  expect(html).toContain(">Reject<");
  expect(html).not.toContain("Revert");
  expect(html).toContain("1 idea thrown out");
  expect(html).toContain("money stays hand-edited");
});

test("a code gap is filed, not applied, and the button says why it can't be until GitHub is wired", () => {
  const gap = { id: "g1", status: "open", kind: "code_gap", title: "Agent called by our own first name", suspectedArea: "callsThemOurName", suggestedTest: "a reply that uses our name as theirs is blocked", why: "seen on one thread", evidence: [] };
  const html = renderToStaticMarkup(<CoachBody coach={{ ...base, open: [gap] }} />);
  expect(html).toContain("File for a fix");
  expect(html).toContain("Add the GitHub repo");
  expect(html).not.toContain(">Apply<");
});

test("a failed run says so, and a quiet night says there was nothing to learn", () => {
  expect(renderToStaticMarkup(<CoachBody coach={{ ...base, last: { status: "error", error: "overloaded" } }} />)).toContain("The last run failed: overloaded");
  expect(renderToStaticMarkup(<CoachBody coach={{ ...base, last: { status: "done", skipped: "nothing to learn from" } }} />)).toContain("Nothing to learn from");
});

test("the card counts what you taught it", () => {
  const html = renderToStaticMarkup(<CoachBody coach={{ ...base, last: { trigger: "daily", status: "done", finishedAt: "2026-09-23T03:21:00Z", counts: { edits: 0, dismissals: 0, yours: 0, rowFeedback: 3, errors: 0 }, summary: "", dropped: [] } }} />);
  expect(html).toContain("<b>3</b> you taught it");
});
