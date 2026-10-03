import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildInPlay } from "@shared/in-play.js";
import { InPlayTable, inPlayFilter } from "../InPlayView.jsx";

const NOW = Date.now();
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const offer = (over = {}) => ({ id: "o1", contactId: "c1", contactName: "Dana R", address: "9311 12th Pl SE, Lake Stevens, WA", cashAmount: 197500,
  status: "sent", statusAt: ago(5), createdAt: ago(6), sends: [{ ts: ago(5) }], nextFollowUp: { kind: "offer_nudge", label: "Nudge", who: "machine", at: ago(-2) },
  lastActivity: { at: ago(1), dir: "in", type: "text_summary", machine: false }, ...over });

test("In play is one row per agent: the stage, ours against theirs, the last touch, what's next", () => {
  const rows = buildInPlay([
    offer({ id: "o2", address: "1 Elm St, Kent, WA", status: "countered", cashAmount: 300000, counter: { amount: 320500 } }),
    offer(),
    offer({ id: "o3", contactId: "c2", contactName: "Lee K", address: "5 Ash St", nextFollowUp: { kind: "none", label: "None scheduled" } }),
  ], { now: NOW });
  const html = renderToStaticMarkup(<InPlayTable rows={rows} />);
  expect(html).toContain("Dana R");
  expect(html).toContain("Countered");
  expect(html).toContain("1 Elm St");
  expect(html).toContain("300K / 320.5K");
  expect(html).toContain("nothing scheduled");   // Lee's open offer fell off
  expect(html.indexOf("Lee K")).toBeLessThan(html.indexOf("Dana R"));   // leaks first
});

test("the chips: live by default, then what fell off and what's waiting on you", () => {
  const rows = [{ stage: "sent", leak: "nothing" }, { stage: "recent", leak: null }, { stage: "hot", leak: "waiting_on_you" }];
  expect(rows.filter(inPlayFilter("live")).length).toBe(2);
  expect(rows.filter(inPlayFilter("leaks")).length).toBe(1);
  expect(rows.filter(inPlayFilter("yours")).length).toBe(1);
  expect(rows.filter(inPlayFilter("recent")).length).toBe(1);
});
