import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import NextFollowUp, { whenText, needsFollowUp, groupNext, nextSortKey } from "../NextFollowUp.jsx";
import { compareBy } from "../ui.jsx";

const html = (el) => renderToStaticMarkup(el);
// Tuesday 2026-09-29, 10am Pacific.
const NOW = Date.parse("2026-09-29T17:00:00Z");
const inDays = (d) => new Date(NOW + d * 86400000).toISOString();

test("the date reads in days, Pacific, and a late one says it's late", () => {
  expect(whenText(inDays(0.1), NOW)).toBe("Today");
  expect(whenText(inDays(1), NOW)).toBe("Tomorrow");
  expect(whenText(inDays(2), NOW)).toBe("Thu");
  expect(whenText(inDays(10), NOW)).toBe("Oct 9");
  expect(whenText(inDays(-3), NOW)).toBe("Overdue 3d");
});

test("the cell names the follow-up, who sends it, and a gap in red", () => {
  const nudge = html(<NextFollowUp now={NOW} next={{ at: inDays(2), kind: "offer_nudge", label: "Nudge · step 2 of 3", who: "machine" }} />);
  expect(nudge).toContain("Thu");
  expect(nudge).toContain("Nudge · step 2 of 3");
  expect(nudge).toContain("text-sky-700");
  const yours = html(<NextFollowUp now={NOW} next={{ at: inDays(0.2), kind: "promise", label: "We owe them a number", who: "you" }} />);
  expect(yours).toContain("· you");
  const gap = html(<NextFollowUp now={NOW} next={{ at: null, kind: "none", label: "None scheduled", reason: "the nudges ran out" }} />);
  expect(gap).toContain("None scheduled");
  expect(gap).toContain("text-rose-600");
  expect(gap).toContain("the nudges ran out");
  const ours = html(<NextFollowUp now={NOW} next={{ at: null, kind: "we_passed", label: "We passed — no follow-up" }} />);
  expect(ours).toContain("text-slate-400");
  expect(html(<NextFollowUp next={undefined} />)).toContain("—");
});

test("'No follow-up' is live offers with nothing coming or running late — never a deal or our pass", () => {
  const row = (next, over = {}) => ({ id: "x", status: "sent", nextFollowUp: next, ...over });
  expect(needsFollowUp(row({ kind: "none", at: null }), NOW)).toBe(true);
  expect(needsFollowUp(row({ kind: "reply_owed", at: inDays(-1), who: "you" }), NOW)).toBe(true);
  expect(needsFollowUp(row({ kind: "offer_nudge", at: inDays(2) }), NOW)).toBe(false);
  expect(needsFollowUp(row({ kind: "we_passed", at: null }, { status: "we_passed" }), NOW)).toBe(false);
  expect(needsFollowUp(row({ kind: "none", at: null }, { supersededBy: { id: "y" } }), NOW)).toBe(false);
  expect(needsFollowUp(row({ kind: "deal", at: null }, { deal: { stage: "under_contract" } }), NOW)).toBe(false);
});

test("sorting puts the soonest first and nothing-coming last; the agent's header shows a gap before a date", () => {
  const rows = [
    { id: "late", nextFollowUp: { at: inDays(9) } },
    { id: "none", nextFollowUp: { at: null, kind: "none" } },
    { id: "soon", nextFollowUp: { at: inDays(1) } },
  ];
  expect([...rows].sort(compareBy("next", "asc", nextSortKey)).map((r) => r.id)).toEqual(["soon", "late", "none"]);
  expect(groupNext(rows).kind).toBe("none");
  expect(groupNext(rows.filter((r) => r.id !== "none")).at).toBe(inDays(1));
});
