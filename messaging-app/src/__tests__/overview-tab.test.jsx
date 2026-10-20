import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SideCard, whenLabel } from "../OverviewTab.jsx";
import { autopilotOverview } from "@shared/autopilot-overview.js";

const page = { groups: [
  { key: "outreach", mechanisms: [{ key: "outreach_open", label: "First text", sent: 40, replied: 9, queued: 12 }] },
  { key: "agent", mechanisms: [{ key: "outreach_nudge", label: "Cold-agent follow-up", sent: 22, replied: 3, planned: 18, held: 2,
    next: { at: "2026-10-21T17:00:00Z", state: "planned", count: 18 } }] },
] };

test("a side reads as three numbers, the kinds of text behind them, and the next one coming", () => {
  const agents = autopilotOverview(page).sides[0];
  const html = renderToStaticMarkup(<SideCard side={agents} onOpen={() => {}} />);
  for (const t of ["Agents", "62", "12 replied", "30", "Coming up", "Waiting on you", "First text", "40 sent · 12 coming", "Follow-ups", "See the texts"]) expect(html).toContain(t);
  expect(html).toMatch(/Next:.*Follow-ups to 18/);
});

test("a side with nothing on it says so", () => {
  const html = renderToStaticMarkup(<SideCard side={autopilotOverview({}).sides[1]} />);
  expect(html).toContain("Nothing sent or coming in this period.");
  expect(html).not.toContain("See the texts");
});

test("when the next text goes, in a few words", () => {
  const now = Date.parse("2026-10-20T18:00:00Z"); // Tue 11am Pacific
  expect(whenLabel("2026-10-20T17:00:00Z", now)).toBe("now");
  expect(whenLabel("2026-10-20T22:00:00Z", now)).toBe("today 3pm");
  expect(whenLabel("2026-10-21T17:30:00Z", now)).toBe("Wed 10:30am");
  expect(whenLabel("2026-11-02T17:00:00Z", now)).toBe("Nov 2");
});
