import { test, expect, vi, afterEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DispoCell, MoneyCell, InspectionCallStrip, DealModal, dealsBook } from "../DealsView.jsx";

// 2026-11-23 audit: the Deals list says how each dispo is going, the deal
// shows the inspection call, and the tiles count only the lane on screen.
// Names and numbers are invented.
const NOW = Date.parse("2026-11-23T20:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
const deal = (over = {}) => ({
  stage: "under_contract", createdAt: daysAgo(6), contractPrice: 400000, assignmentFee: 30000,
  investors: [], feedback: [], stageHistory: [], ...over,
});

afterEach(() => { vi.unstubAllGlobals(); });

test("the Deals list shows who a deal went to, who is on it and the best number, not three money columns", () => {
  const d = deal({
    sends: { sent: 24, lastAt: daysAgo(2) },
    blasts: [{ count: 151 }],
    investors: [
      { contactId: "a", name: "Oak", status: "evaluating", addedAt: daysAgo(1), agreedPrice: { amount: 425000 } },
      { contactId: "b", name: "Elm", status: "passed", addedAt: daysAgo(2) },
    ],
  });
  const html = renderToStaticMarkup(<DispoCell deal={d} now={NOW} />);
  expect(html).toContain("sent 24");
  expect(html).not.toContain("151");
  expect(html).toContain("on it 2");
  expect(html).toContain("1 interested");
  expect(html).toContain("1 passed");
  expect(html).toContain("best $425K");
  expect(html).toContain("last buyer move 1d ago");
});

test("a deal nobody has moved on for days says so on the list", () => {
  const html = renderToStaticMarkup(<DispoCell deal={deal({ createdAt: daysAgo(5) })} now={NOW} />);
  expect(html).toContain("no buyer on it yet");
  expect(html).toContain("text-amber-800");
});

test("contract, buyer price and fee read as one cell against the buyer ceiling", () => {
  const over = renderToStaticMarkup(<MoneyCell deal={deal({ ceilingAtPromote: { computable: true, noFee: 410000 } })} />);
  expect(over).toContain("$400K → $430K · fee $30K");
  expect(over).toContain("$20,000 over the buyer ceiling");
  expect(renderToStaticMarkup(<MoneyCell deal={deal({ contractPrice: null, assignmentFee: null })} />)).toContain("—");
});

test("days before the inspection ends the deal shows the go, re-trade or cancel call, on the row and in the modal", () => {
  const today = new Date();
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const soon = new Date(today.getTime() + 2 * 86400000);
  const d = deal({ inspectionDate: ymd(soon), createdAt: new Date().toISOString() });
  expect(renderToStaticMarkup(<InspectionCallStrip deal={d} compact />)).toContain("go / re-trade / cancel");
  const html = renderToStaticMarkup(<DealModal offer={{ id: "o1", address: "12 Alder Ln, Kent, WA 98030", deal: d }} settings={{}}
    onClose={() => {}} onUpdated={() => {}} onRemoved={() => {}} />);
  expect(html).toContain("go, re-trade or cancel");
  expect(html).toContain("No committed buyer.");
  expect(html).toContain("Go: inspection done");
  expect(html).toContain("Cancel: fell through");
  // Far from the date it stays away.
  const later = deal({ inspectionDate: ymd(new Date(today.getTime() + 20 * 86400000)) });
  expect(renderToStaticMarkup(<InspectionCallStrip deal={later} />)).toBe("");
});

test("the luxury Deals tiles count only luxury deals, and the Offers ones leave luxury out", () => {
  const lux = { id: "l1", lane: "luxury", deal: deal({ assignmentFee: 100000 }) };
  const flip = { id: "f1", lane: "flip", deal: deal({ assignmentFee: 20000 }) };
  const flipClosed = { id: "f2", lane: "flip", deal: deal({ stage: "closed" }) };
  const all = [lux, flip, flipClosed];
  const luxury = dealsBook(all, { only: (o) => o.lane === "luxury" });
  expect(luxury.active.map((o) => o.id)).toEqual(["l1"]);
  expect(luxury.potentialFees).toBe(100000);
  expect(luxury.closed).toHaveLength(0);
  const offers = dealsBook(all, { only: (o) => o.lane !== "luxury" });
  expect(offers.potentialFees).toBe(20000);
  expect(offers.closed).toHaveLength(1);
  expect(dealsBook(all).active).toHaveLength(2);
});

test("uploading the signed assignment hands the deal back, so its checklist line ticks on screen", async () => {
  const offer = { id: "o1", deal: deal({ checklist: { items: [] } }) };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, document: { id: "d1" }, documents: [{ id: "d1" }], offer }), { status: 200, headers: { "content-type": "application/json" } })));
  const { uploadDealDoc } = await import("../api.js");
  const r = await uploadDealDoc("o1", { name: "a.pdf", kind: "Assignment", data: "data:application/pdf;base64,AA==" });
  expect(r.documents).toEqual([{ id: "d1" }]);
  expect(r.offer).toEqual(offer);
});
