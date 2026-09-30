import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildLine } from "@shared/line.js";
import { LineBody } from "../LineView.jsx";

const NOW = Date.parse("2026-09-29T18:00:00Z");

test("the Line shows what fell off, the stations against target, the jobs, and pricing as evidence only", () => {
  const data = buildLine({
    now: NOW,
    month: [{ key: "offered", side: "agent", label: "Offered", count: 150, machine: 100 }, { key: "blasted", side: "dispo", label: "Blasted", count: 3, machine: 3 }],
    week: [{ key: "offered", count: 40 }],
    offers: [{ id: "o1", address: "12 Elm St, Renton, WA", status: "sent", nextFollowUp: { kind: "none", label: "None scheduled", reason: "the nudges ran out" } }],
    actions: [{ kind: "deal_no_buyers", offerId: "o9", address: "9 Oak St, Kent, WA", title: "9 Oak St has nobody on it", severity: "soon" }],
    agentPlan: { settings: { enabled: false }, counts: { due: { general: 4 }, coverage: { touched: 3, pool: 6 } } },
    cursors: [{ name: "dispo", at: "2026-09-28T17:00:00Z", doc: { failed: true, last: { error: "GHL 502" } } }],
    scorecards: [{ offerId: "s1", street: "1 A St", outcome: "closed", arv: 500000, allInPctOfArv: 70.7 }],
    settings: { maoPctOfArv: 75 },
  });
  const html = renderToStaticMarkup(<LineBody data={data} />);
  expect(html).toContain("fell off with nothing scheduled");
  expect(html).toContain("12 Elm St");
  expect(html).toContain("the nudges ran out");
  expect(html).toContain("9 Oak St has nobody on it");
  expect(html).toContain("the agent check-in is off");
  expect(html).toContain("50%");
  expect(html).toContain("10 a day");
  expect(html).toContain("failed");
  expect(html).toContain("GHL 502");
  expect(html).toContain("never ran");
  expect(html).toContain("Evidence only");
  expect(html).toContain("70.7%");
});

test("buyers queued behind today's check-in seats show as backlog, apart from the leaks", () => {
  const data = buildLine({
    now: NOW,
    buyerPlan: { settings: { enabled: true }, picks: [1, 2], counts: { pool: 100, eligible: 50, passWorkdays: 25 } },
  });
  const html = renderToStaticMarkup(<LineBody data={data} />);
  expect(html).toContain("Leaks — 0 fell off with nothing scheduled");
  expect(html).toContain("Backlog: <b>48</b>");
  expect(html).toContain("queued behind today&#x27;s seats (backlog)");
});

test("the Line shows off-market beside listed, and who brings them", () => {
  const data = buildLine({
    now: NOW,
    offers: [
      { id: "o1", contactId: "lori", contactName: "Lori Wright", status: "sent", createdAt: "2026-09-20T00:00:00Z", sends: [{ ts: "2026-09-21T00:00:00Z" }], offMarket: { value: true, by: "you" }, deal: { stage: "under_contract" } },
      { id: "l1", contactId: "sam", status: "sent", createdAt: "2026-09-20T00:00:00Z", sends: [{ ts: "2026-09-21T00:00:00Z" }] },
    ],
  });
  const html = renderToStaticMarkup(<LineBody data={data} />);
  expect(html).toContain("Off-market vs listed");
  expect(html).toContain("Lori Wright");
  expect(html).toContain("1 under contract");
  expect(html).toContain("100%");
});
