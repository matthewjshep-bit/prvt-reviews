import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DealModal, BuyerFeedback, outcomeDraft, outcomeLine, datesNote } from "../DealsView.jsx";
import PsaModal from "../PsaModal.jsx";

// 2026-11-09: a deal keeps its deadlines and records who bought it.
const deal = (over = {}) => ({
  stage: "assigned", createdAt: "2026-10-01T18:00:00.000Z", contractPrice: 300000, assignmentFee: 30000,
  stageHistory: [], investors: [
    { contactId: "b-oak", name: "Oak Tran", status: "committed", agreedPrice: { amount: 312000 } },
    { contactId: "b-elm", name: "Elm Ruiz", status: "passed" },
  ], feedback: [], ...over,
});
const offer = (d) => ({ id: "o1", address: "88 Juniper Way, Kent, WA 98030", contactId: "a1", contactName: "Orla Penn", deal: d });
const render = (o) => renderToStaticMarkup(<DealModal offer={o} settings={{}} onClose={() => {}} onUpdated={() => {}} onRemoved={() => {}} />);

test("closing a deal records who bought it and at what price: the form starts from the committed buyer's agreed price", () => {
  const d = outcomeDraft(deal());
  expect(d.buyerContactId).toBe("b-oak");
  expect(d.buyerName).toBe("Oak Tran");
  expect(d.price).toBe("312000");
  expect(d.fee).toBe("");
  // Nobody agreed a price: it stays blank, never contract plus the setting's fee.
  expect(outcomeDraft(deal({ investors: [{ contactId: "b-oak", name: "Oak Tran", status: "committed" }] })).price).toBe("");
});

test("closing a deal from a row says to record who bought it", async () => {
  const { describeResult } = await import("../pipeline-ops.js");
  expect(describeResult("mark_closed", { ok: true, askOutcome: true })).toBe("Done. Open the deal and record who bought it and for how much.");
  expect(describeResult("mark_closed", { ok: true })).toBe("Done.");
});

test("a recorded sale reads as one line on the deal", () => {
  const d = deal({ stage: "closed", outcome: { buyerContactId: "b-oak", buyerName: "Oak Tran", price: 312000, fee: 12000, closedAt: "2026-11-05" } });
  expect(outcomeLine(d)).toBe("Sold to Oak Tran for $312,000 · our fee $12,000 · closed Nov 5");
  expect(render(offer(d))).toContain("Sold to Oak Tran for $312,000");
  expect(outcomeLine(deal())).toBe("");
});

test("the deal says where its dates came from, so a guess is checked against the paper", () => {
  expect(datesNote(deal({ datesFrom: { inspection: "psa", closing: "terms", earnest: "letter" }, earnestMoney: 1000, earnestDue: "feasibility" })))
    .toBe("Inspection end from the PSA we wrote. Closing from our standard terms. Earnest $1,000, due after the inspection. Check them against the signed paper.");
  expect(datesNote(deal({ datesFrom: { inspection: "psa_short_sale", closing: "", earnest: "" } })))
    .toBe("Inspection end not set: a short sale's starts at the lienholder's approval. Check them against the signed paper.");
  expect(datesNote(deal())).toBe("");
});

test("a wrong pass code can be put right from the buyers tab", () => {
  const d = deal({ stage: "under_contract", feedback: [{ contactId: "b-elm", name: "Elm Ruiz", code: "area", note: "too far out" }] });
  const html = renderToStaticMarkup(<BuyerFeedback deal={d} onFix={() => {}} />);
  expect(html).toContain("What buyers said (1)");
  expect(html).toContain("Fix a reason");
  expect(renderToStaticMarkup(<BuyerFeedback deal={d} />)).not.toContain("Fix a reason");
});

test("a PSA built after a write-up-terms letter starts at $1,000 due after feasibility", () => {
  const settings = { psa: { feasibilityDays: 10, closingDays: 21 }, conversationAi: { writeUp: { earnestMoney: 1000, earnestDue: "after inspection", inspectionDays: 14 } } };
  const html = renderToStaticMarkup(<PsaModal offer={{ id: "o1", address: "88 Juniper Way", cashAmount: 300000, terms: { earnestMoney: 1000, inspectionDays: 14 } }} settings={settings} onClose={() => {}} />);
  expect(html).toContain('value="1000"');
  expect(html).toMatch(/<option value="feasibility" selected="">3 business days after feasibility ends<\/option>/);
  expect(html).toContain('value="14"');
});
