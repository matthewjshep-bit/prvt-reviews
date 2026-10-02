import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import MomentStrip from "../MomentStrip.jsx";

const NOW = Date.parse("2026-10-01T18:00:00Z");
const m = (day, kind, label, who) => ({ at: `2026-09-${String(day).padStart(2, "0")}T18:00:00Z`, kind, label, who });

test("the strip shows the newest few, oldest first, with who did each and the next move", () => {
  const timeline = {
    moments: [m(2, "priced", "priced 385K", "machine"), m(3, "sent", "offer sent", "us"), m(6, "nudge", "nudge went", "machine"),
      m(8, "they_wrote", "they wrote ×2", "them"), m(9, "countered", "countered 425K", "them"), m(11, "requoted", "re-quoted 400K", "us"),
      m(12, "agreed", "agreed 400K", "them"), m(13, "hot", "hot", "us")],
    total: 8,
    next: { at: "2026-10-02T16:00:00Z", kind: "hot_push", label: "Push to paper · day 3", who: "machine" },
  };
  const html = renderToStaticMarkup(<MomentStrip timeline={timeline} onHistory={() => {}} now={NOW} />);
  expect(html).toContain("+2 earlier");
  expect(html).not.toContain("priced 385K");          // older than the newest six
  expect(html.indexOf("nudge went")).toBeLessThan(html.indexOf("hot<"));
  expect(html).toContain("bg-violet-500");           // the machine
  expect(html).toContain("bg-blue-500");             // us
  expect(html).toContain("bg-slate-400");            // them
  expect(html).toContain("9/12");
  expect(html).toContain("→ next: push to paper tomorrow");
  expect(html).toContain(">History<");
});

test("nothing at all until the timeline has loaded, or when there is nothing to say", () => {
  expect(renderToStaticMarkup(<MomentStrip timeline={null} />)).toBe("");
  expect(renderToStaticMarkup(<MomentStrip timeline={{ moments: [], total: 0, next: null }} />)).toBe("");
});

test("a timeline whose older moments weren't loaded says how many, without a button to show them", () => {
  const html = renderToStaticMarkup(<MomentStrip timeline={{ moments: [m(20, "nudge", "nudge went", "machine")], total: 50, next: null }} now={NOW} />);
  expect(html).toContain("+49 earlier");
  expect(html).not.toMatch(/<button[^>]*>\+49 earlier/);
});
