import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildFlow } from "@shared/flow.js";
import { groupByDay } from "@shared/contact-record.js";
import { ActivityStamp, compareBy } from "../ui.jsx";
import { EventDayGroups } from "../EventFeed.jsx";

const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();
const html = (el) => renderToStaticMarkup(el);

/* ---------- the Last activity column ---------- */

test("their message, your message and the bot's are three different labels", () => {
  expect(html(<ActivityStamp activity={{ at: ago(5), dir: "in", type: "text_summary", machine: false }} />)).toContain("· them");
  expect(html(<ActivityStamp activity={{ at: ago(5), dir: "out", type: "offer_sent", machine: false }} />)).toContain("· you");
  // The one the two-label version would have lied about.
  expect(html(<ActivityStamp activity={{ at: ago(5), dir: "out", type: "follow_up_sent", machine: true }} />)).toContain("· auto");
});

test("'never' and '—' say different things", () => {
  const never = html(<ActivityStamp activity={null} enriched />);
  expect(never).toContain("never");
  const notAsked = html(<ActivityStamp activity={null} enriched={false} />);
  expect(notAsked).toContain("—");
  expect(notAsked).not.toContain("never");
});

test("the stamp reads as a relative time with the exact time on hover", () => {
  const out = html(<ActivityStamp activity={{ at: ago(5), dir: "in", type: "call_summary", machine: false }} />);
  expect(out).toContain("5h ago");
  expect(out).toContain("call");           // the event label, in the title
});

test("agents nobody has ever spoken to sort last whichever way you click", () => {
  const rows = [
    { id: "a", lastActivity: { at: ago(50) } },
    { id: "b", lastActivity: null },
    { id: "c", lastActivity: { at: ago(2) } },
  ];
  const of = (o) => o.lastActivity?.at || null;
  const order = (dir) => [...rows].sort(compareBy("activity", dir, of)).map((r) => r.id);
  expect(order("desc")).toEqual(["c", "a", "b"]);
  expect(order("asc")).toEqual(["a", "c", "b"]);
});

/* ---------- the Flow drill-down ---------- */

test("a stage's rows render the records behind the number", () => {
  const now = Date.parse("2026-09-12T20:00:00Z");
  const events = [
    { id: "e1", contactId: "a1", type: "outreach_sent", at: "2026-09-12T15:00:00Z", source: "conversation", data: { auto: true, contactName: "Priya" }, address: "1 Fixer Ave" },
    { id: "e2", contactId: "a2", type: "outreach_sent", at: "2026-09-12T16:00:00Z", source: "outreach", data: { auto: false, contactName: "Dana" }, address: "9 Held St" },
  ];
  const flow = buildFlow({ events, now, windowStartMs: now - 86400000, windowEndMs: now + 1, itemsFor: "first_text" });
  expect(flow.items).toHaveLength(2);
  const out = html(<EventDayGroups groups={groupByDay(flow.items)} withLinks />);
  expect(out).toContain("Priya");
  expect(out).toContain("Dana");
  expect(out).toContain("1 Fixer Ave");
  expect(out).toContain("text-violet-500");   // the machine's row is tinted
});
