import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DealModal } from "../DealsView.jsx";
import { dealHref } from "../links.js";

// 2026-11-23 audit (D5): promote opens the new deal to confirm its fee, dates
// and kind, and shows what promote warned about. Names are invented.
const offer = (over = {}) => ({
  id: "o-new", address: "12 Alder Ln, Kent, WA 98030", contactId: "a1", contactName: "Test Agent",
  asset: { type: "sfr" },
  warnings: ["comps are thin", "buyer ceiling: contract + fee is $430,000, $20,000 over the 70% line ($410,000)"],
  deal: {
    stage: "under_contract", createdAt: "2026-11-23T18:00:00.000Z", contractPrice: 400000, assignmentFee: 30000,
    assignmentFeeSource: "setting", inspectionDate: "2026-12-03", closingDate: "2026-12-20",
    datesFrom: { inspection: "terms", closing: "terms" }, investors: [], feedback: [], stageHistory: [],
  },
  ...over,
});
const render = (o, confirmNew) => renderToStaticMarkup(
  <DealModal offer={o} settings={{}} confirmNew={confirmNew} onClose={() => {}} onUpdated={() => {}} onRemoved={() => {}} />);

test("a deal promote just made opens to confirm its fee, dates and kind, with the promote warnings", () => {
  const html = render(offer(), { id: "o-new", warnings: ["buyer ceiling: contract + fee is $430,000 over the line", "before signing, not checked: the roof"] });
  expect(html).toContain("Confirm the deal");
  expect(html).toContain("$30,000 (Settings default)");
  expect(html).toContain("Dec 3");
  expect(html).toContain("Inspection end from our standard terms.");
  expect(html).toContain("before signing, not checked: the roof");
  // It opens on Terms & paperwork, where the fee and dates are typed.
  expect(html).toMatch(/aria-selected="true"[^>]*>Terms &amp; paperwork/);
});

test("without the promote's own list, the card shows the deal's promote warnings and not the offer's calc ones", () => {
  const html = render(offer(), { id: "o-new", warnings: [] });
  expect(html).toContain("buyer ceiling: contract + fee is $430,000");
  expect(html).not.toContain("comps are thin");
});

test("opening a deal from the list doesn't ask to confirm it", () => {
  const html = render(offer(), null);
  expect(html).not.toContain("Confirm the deal");
  // A deal still being shopped opens on its buyers.
  expect(html).toMatch(/aria-selected="true"[^>]*>Buyers/);
});

test("outside the Offers app a promote still lands on the deal itself", () => {
  expect(dealHref({ id: "o-new" }, { fresh: true }, "?location_id=L1&deal_id=old")).toBe("/deals?location_id=L1&deal_id=o-new&confirm=1");
  expect(dealHref("o-2", {}, "?location_id=L1")).toBe("/deals?location_id=L1&deal_id=o-2");
  expect(dealHref(null, {}, "")).toBe("/deals");
});
