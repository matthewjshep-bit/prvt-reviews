import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DealModal } from "../DealsView.jsx";

// 2026-11-23 audit (D6): one Buyers tab. The package, the feedback page and
// what buyers said it's worth sat on Terms & paperwork, and the deal always
// opened on the checklist, even while it was being shopped. Names invented.
const deal = (over = {}) => ({
  stage: "under_contract", createdAt: "2026-11-20T18:00:00.000Z", contractPrice: 400000, assignmentFee: 30000,
  investors: [{ contactId: "b1", name: "Oak Tran", status: "evaluating", addedAt: "2026-11-21T18:00:00.000Z", agreedPrice: { amount: 415000 } }],
  showing: { rsvps: [{ contactId: "b1", status: "coming", at: "2026-11-22T18:00:00.000Z" }] },
  feedback: [], stageHistory: [], ...over,
});
const render = (d) => renderToStaticMarkup(<DealModal offer={{ id: "o1", address: "12 Alder Ln, Kent, WA 98030", deal: d }} settings={{}}
  onClose={() => {}} onUpdated={() => {}} onRemoved={() => {}} />);

test("a deal being shopped opens on one Buyers tab with the package, the feedback page and what buyers said it's worth", () => {
  const html = render(deal());
  expect(html).toMatch(/aria-selected="true"[^>]*>Buyers/);
  expect(html).toContain("Investor dataroom");
  expect(html).toContain("Buyer feedback page");
  expect(html).toContain("What buyers said it&#x27;s worth");
  expect(html).toContain("coming to the walkthrough");
  expect(html).toContain("agreed $415K");
});

test("once a buyer is found the deal opens on the checklist", () => {
  expect(render(deal({ stage: "buyer_found" }))).toMatch(/aria-selected="true"[^>]*>Overview/);
});
