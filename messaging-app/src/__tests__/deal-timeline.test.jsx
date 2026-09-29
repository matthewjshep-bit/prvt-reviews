import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DealTimeline from "../DealTimeline.jsx";
import DealParties from "../DealParties.jsx";
import { resolveParties } from "@shared/deal-parties.js";

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const OFFER = {
  id: "o1", contactId: "agent-1", contactName: "Mick Walls", address: "3511 NE 153rd St, Lake Forest Park, WA",
  deal: { stage: "under_contract", createdAt: daysAgo(5), stageHistory: [{ stage: "under_contract", ts: daysAgo(5) }], investors: [],
    checklist: { items: [
      { id: "psa_signed", gate: "under_contract", label: "Purchase & sale signed by both sides", owner: "us", rule: { from: "contract", days: 0 }, done: true },
      { id: "earnest_money", gate: "under_contract", label: "Earnest money to title", owner: "us", rule: { from: "contract", days: 3 } },
      { id: "recorded", gate: "assigned", label: "Recorded, assignment fee received", owner: "title", rule: { from: "closing", days: 0 } },
    ] } },
};

test("the timeline shows every stage with its count and the current gate's work, late items flagged", () => {
  const html = renderToStaticMarkup(<DealTimeline offer={OFFER} parties={resolveParties(OFFER, {})} onUpdated={() => {}} />);
  for (const s of ["Under contract", "Buyer found", "Assigned", "Closed"]) expect(html).toContain(s);
  expect(html).toContain("1/2");
  expect(html).toContain("To do before Under contract is done");
  expect(html).toContain("Earnest money to title");
  expect(html).toContain("2d overdue");
  expect(html).toContain("bg-rose-100");
  expect(html).not.toContain("Recorded, assignment fee received");
  expect(html).toContain("Add an item to Under contract");
});

test("the parties say who's filled in from the offer and what's still missing", () => {
  const html = renderToStaticMarkup(<DealParties offer={OFFER} settings={{ psa: { titleCompany: "Ticor Title" } }} onUpdated={() => {}} />);
  expect(html).toContain("Seller&#x27;s agent");
  expect(html).toContain("Mick Walls");
  expect(html).toContain("from the offer");
  expect(html).toContain("Ticor Title");
  expect(html).toContain("from your PSA settings");
  expect(html).toContain("not set");
});
