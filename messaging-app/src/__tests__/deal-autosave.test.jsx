import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DealModal } from "../DealsView.jsx";
import DealAccess from "../DealAccess.jsx";
import WalkthroughCard from "../WalkthroughCard.jsx";
import { termsFrom, termsChanges, settleTerms, revertTerms, sameWindows, savedLine } from "../deal-autosave.js";
import { parseMoney } from "@shared/money.js";

// 2026-11-23 audit (D12): the deal modal had Save buttons, against Matt's
// 10-23 rule that everything saves as you type, and closing it with unsaved
// terms dropped them. Names are invented.
const deal = (over = {}) => ({
  stage: "under_contract", createdAt: "2026-11-20T18:00:00.000Z", contractPrice: 400000, assignmentFee: 30000,
  inspectionDate: "2026-12-01", closingDate: "2026-12-20", notes: "", investors: [], feedback: [], stageHistory: [], ...over,
});
const offer = (d) => ({ id: "o1", address: "12 Alder Ln, Kent, WA 98030", deal: d });

test("the deal modal has no Save buttons: terms, what buyers said, access and the walkthrough save as you go", () => {
  const html = renderToStaticMarkup(<DealModal offer={offer(deal())} settings={{}} confirmNew={{ id: "o1", warnings: [] }}
    onClose={() => {}} onUpdated={() => {}} onRemoved={() => {}} />);
  expect(html).not.toContain("Save terms");
  expect(html).not.toContain("Save what buyers said");
  expect(html).toContain("Saves as you go");
  expect(renderToStaticMarkup(<DealAccess offer={offer(deal())} onUpdated={() => {}} />)).not.toContain("Save access");
  const walk = renderToStaticMarkup(<WalkthroughCard offer={offer(deal({ showing: { windows: [{ start: "2026-11-28T18:00:00.000Z", end: "2026-11-28T19:00:00.000Z" }] } }))} onUpdated={() => {}} />);
  expect(walk).not.toContain("Save walkthrough");
});

test("only the terms you changed are sent, and emptying the fee asks before it clears", () => {
  const d = deal();
  expect(termsChanges(termsFrom(d), d, { parse: parseMoney }).body).toBe(null);
  const fee = termsChanges({ ...termsFrom(d), assignmentFee: "25k" }, d, { parse: parseMoney });
  expect(fee.body).toEqual({ assignmentFee: "25k" });
  expect(fee.clearing).toEqual([]);
  const cleared = termsChanges({ ...termsFrom(d), assignmentFee: "" }, d, { parse: parseMoney });
  expect(cleared.clearing).toEqual(["assignmentFee"]);
});

test("a saved '25k' reads back as the stored number, so it isn't saved again; a field typed since is left alone", () => {
  const sent = { assignmentFee: "25k" };
  const after = deal({ assignmentFee: 25000 });
  expect(settleTerms({ ...termsFrom(deal()), assignmentFee: "25k" }, sent, after).assignmentFee).toBe(25000);
  expect(settleTerms({ ...termsFrom(deal()), assignmentFee: "26k" }, sent, after).assignmentFee).toBe("26k");
  expect(termsChanges(settleTerms({ ...termsFrom(deal()), assignmentFee: "25k" }, sent, after), after, { parse: parseMoney }).body).toBe(null);
  expect(revertTerms({ assignmentFee: "" }, ["assignmentFee"], deal()).assignmentFee).toBe(30000);
});

test("a walkthrough window saves only when it changed", () => {
  const a = [{ start: "2026-11-28T18:00:00.000Z", end: "2026-11-28T19:00:00.000Z" }];
  expect(sameWindows(a, [{ start: "2026-11-28T18:00:00Z", end: "2026-11-28T19:00:00Z" }])).toBe(true);
  expect(sameWindows(a, [])).toBe(false);
  expect(savedLine({ phase: "saved" })).toBe("Saved");
  expect(savedLine({ phase: "error", error: "no" })).toBe("Not saved: no");
});
