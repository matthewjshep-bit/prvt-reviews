import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildOutreachScorecard, sendsFrom, outcomesFrom } from "@shared/outreach-scorecard.js";
import { TextScoreboard } from "../TextScoreboard.jsx";
import { SideCard } from "../OverviewTab.jsx";
import { autopilotOverview } from "@shared/autopilot-overview.js";

const NOW = Date.parse("2026-11-09T20:00:00Z");
const ago = (d) => new Date(NOW - d * 86400000).toISOString();

test("the scoreboard shows each first text with its own replies and STOPs, small groups greyed", () => {
  const events = [];
  for (let i = 0; i < 4; i++) {
    events.push({ id: `a${i}`, type: "outreach_sent", contactId: `a${i}`, at: ago(12), data: { auto: true, chars: 100, standard: { set: "opener", index: 0, templateHash: "aaa" } } });
    events.push({ id: `b${i}`, type: "outreach_sent", contactId: `b${i}`, at: ago(12), data: { auto: true, chars: 180, standard: { set: "past_listing", index: 0, templateHash: "bbb" } } });
  }
  events.push({ id: "r1", type: "text_summary", contactId: "a0", at: ago(11.9), party: "agent", data: { inbound: "I might have one", intent: "has_property" } });
  events.push({ id: "s1", type: "text_summary", contactId: "b0", at: ago(11.9), party: "agent", data: { inbound: "STOP", intent: "opt_out" } });
  const card = buildOutreachScorecard({ sends: sendsFrom({ events }), ...outcomesFrom({ events }), now: NOW, labels: { templates: { aaa: "Hi {first}, saw your listing on {street}" } } });
  const html = renderToStaticMarkup(<TextScoreboard data={{ card, at: ago(0.3), status: "done" }} />);
  expect(html).toContain("Hi {first}, saw your listing on {street}");
  expect(html).toContain("A fixed text (bbb)");
  expect(html).toContain("25%");
  expect(html).toContain("few");
  expect(html).toContain("report only, nothing retires itself");
  expect(html).toContain("Groups under 30 sends are greyed");
});

test("before the first night the scoreboard says when it comes, and after a failed night says so", () => {
  expect(renderToStaticMarkup(<TextScoreboard data={null} />)).toContain("worked out each night at 4am Pacific");
  expect(renderToStaticMarkup(<TextScoreboard data={{ card: null, status: "error", error: "read failed" }} />)).toContain("Last night&#x27;s read failed");
});

test("Overview shows how many stopped beside how many replied", () => {
  const page = { groups: [{ key: "agent", mechanisms: [{ key: "outreach_nudge", label: "Cold-agent follow-up", sent: 20, replied: 3, stopped: 2, planned: 0 }] }] };
  const html = renderToStaticMarkup(<SideCard side={autopilotOverview(page).sides[0]} />);
  expect(html).toContain("3 replied · 2 stopped (10%)");
});
