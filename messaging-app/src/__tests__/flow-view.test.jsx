import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildFlow } from "@shared/flow.js";
import { groupByDay } from "@shared/contact-record.js";
import { EventDayGroups } from "../EventFeed.jsx";

test("the feed renders a machine move and a person's move with their details and links", () => {
  const now = Date.parse("2026-09-10T20:00:00Z");
  const events = [
    { id: "e1", contactId: "a1", type: "outreach_sent", at: "2026-09-10T15:00:00Z", source: "conversation", data: { auto: true, contactName: "Priya" }, address: "1 Fixer Ave" },
    { id: "e2", contactId: "a1", type: "call_summary", at: "2026-09-10T16:00:00Z", source: "call", data: { summary: "seller would take 425" } },
    { id: "e3", contactId: "a1", type: "offer_sent", at: "2026-09-10T17:00:00Z", source: "conversation", offerId: "o1", address: "4410 S Holly St", data: { by: "underwrite", channels: ["sms"] } },
  ];
  const flow = buildFlow({ events, now, windowStartMs: now - 86400000, windowEndMs: now + 1 });
  const html = renderToStaticMarkup(<EventDayGroups groups={groupByDay(flow.feed)} withLinks />);
  expect(html).toContain("we reached out about their listing");
  expect(html).toContain("seller would take 425");
  expect(html).toContain("after a clean underwrite");
  expect(html).toContain("Priya");
  expect(html).toContain("text-violet-500");
  expect(html).toContain("4410 S Holly St");
  const s = Object.fromEntries(flow.stages.map((x) => [x.key, x]));
  expect(s.first_text.machine).toBe(1);
  expect(s.replied.count).toBe(1);
  expect(s.offered.machine).toBe(1);
});
