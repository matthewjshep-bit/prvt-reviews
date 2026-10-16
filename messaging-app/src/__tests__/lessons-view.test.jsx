import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildPostMortem, dealScorecard, lessons } from "@shared/post-mortem.js";
import { LessonsBody } from "../LessonsView.jsx";
import { PostMortemBody } from "../PostMortemView.jsx";

const snap = { underwriteMode: "lowball", maoPctOfArv: 70, wholesaleFee: 30000, cashPctOfArv: 90, repairBuffer: 30000, repairHeavyPctOfArv: 10, repairBaseMult: 2, repairHeavyMult: 1.5, precisionJitter: true };
const bellevue = {
  id: "o1", address: "10836 Northeast 12th Place, Bellevue, Washington 98004", contactId: "a1", contactName: "David L", createdAt: "2026-08-11T01:30:00Z", cashAmount: 1934755,
  calc: { inputs: { askingPrice: 0, arv: 2450000, repairs: 120000 }, settings: snap, offers: { cash: { mode: "lowball", amount: 1934755 } } },
  deal: { stage: "fell_through", createdAt: "2026-08-11T01:40:00Z", contractPrice: 1850000, assignmentFee: 45000, fellThroughReason: "Price too high", fellThroughCode: "buyers_passed_price",
    stageHistory: [{ stage: "under_contract", ts: "2026-08-11T01:40:00Z" }, { stage: "fell_through", ts: "2026-08-18T18:00:00Z" }],
    investors: [{ contactId: "b1", name: "Pat M", status: "passed", reason: { code: "price", note: "ARV is 1.7-1.9M", at: "2026-08-12T00:00:00Z" } }, { contactId: "b2", name: "Rith R", status: "sent" }], feedback: [] },
};
const vashon = {
  id: "o2", address: "21904 Vashon Hwy SW, Vashon, WA 98070", contactId: "a2", createdAt: "2026-08-03T19:00:00Z", cashAmount: 371030,
  calc: { inputs: { askingPrice: 0, arv: 900000, repairs: 250000 }, settings: { ...snap, wholesaleFee: 16000 }, offers: { cash: { mode: "lowball", amount: 371030 } } },
  deal: { stage: "closed", createdAt: "2026-08-09T18:00:00Z", contractPrice: 371030, assignmentFee: 15000, stageHistory: [{ stage: "under_contract", ts: "2026-08-09T18:00:00Z" }, { stage: "closed", ts: "2026-08-31T18:00:00Z" }], investors: [] },
};
const settings = { underwriteMode: "lowball", maoPctOfArv: 72.5, wholesaleFee: 30000 };

test("the post-mortem page shows the gap, the seller's number, the buyer's words and the reading", () => {
  const pm = buildPostMortem({ offer: bellevue, settings, agentThread: "[2026-08-11 00:35] THEM sms: $1.85 is my breakeven\n", analysis: {
    rootCauses: [{ code: "buyers_passed_price", weight: 0.9, summary: "We wrote the seller's break-even.", evidence: [{ who: "agent", quote: "$1.85 is my breakeven", at: "2026-08-11" }] }],
    agentSide: { narrative: "He named 1.85M and we agreed.", concessions: [], backOutResponse: "Gracious." },
    buyerSide: { narrative: "Nobody could make 1.9M work.", whatTheyNeeded: "Closer to 1.4M." },
    whatWouldHaveSold: { price: 1595000, basis: "70% rule" }, lessons: ["Run the line before answering a named price."], offerProcessChanges: ["Check the ceiling at promote."], by: "session",
  } });
  const html = renderToStaticMarkup(<PostMortemBody pm={pm} />);
  expect(html).toContain("$1,895,000");
  expect(html).toContain("$1,595,000");
  expect(html).toContain("$300,000");
  expect(html).toContain("seller&#x27;s own number");
  expect(html).toContain("ARV is 1.7-1.9M");
  expect(html).toContain("Buyers passed on price");
  expect(html).toContain("Run the line before answering a named price.");
  expect(html).toContain("reading by session");
});

test("the lessons block renders the recommendations with their evidence and an Apply button per settings delta", () => {
  const data = { ...lessons({ postMortems: [buildPostMortem({ offer: bellevue, settings })], controls: [dealScorecard({ offer: vashon, settings })], settings }), digestSaved: "" };
  const html = renderToStaticMarkup(<LessonsBody data={data} />);
  expect(html).toContain("Contract price + fee must sit at or under 72.5% of ARV minus repairs");
  expect(html).toContain("Apply");
  expect(html).toContain("Underwrite mode → mao");
  expect(html).toContain("10836 Northeast 12th Place: buyers were asked $1,895,000");
  expect(html).toContain("Save digest");
  expect(data.digest).not.toMatch(/\$/);
});

// 2026-10-15: Matt's own revisions calibrate the underwriter (shared/calibration.js).
test("the lessons block shows a calibration from his revisions with its Apply, and a note when there isn't enough yet", async () => {
  const { calibrationReport } = await import("@shared/calibration.js");
  const offers = [4, 5, 6, 7, 8].map((pct, i) => ({ id: `o${i}`, address: `${100 + i} Fern Way, Kent, WA 98030`, cashAmount: 300000, autoUnderwrite: { passed: true },
    revisions: [{ ts: "2026-10-15T18:00:00Z", from: 320000, to: 300000, by: "you", arv: [500000, 500000 * (1 - pct / 100)], repairs: [50000, 50000], sqft: 1400, yearBuilt: 1962 }] }));
  const calib = calibrationReport({ offers });
  const base = lessons({ postMortems: [], controls: [], settings });
  const data = { ...base, recommendations: calib.recommendations, current: { ...base.current, underwriteCalibration: null }, calibration: { note: calib.note }, digestSaved: "" };
  const html = renderToStaticMarkup(<LessonsBody data={data} />);
  expect(html).toContain("Our ARV runs high against your revisions — take 6% off it");
  expect(html).toContain("Calibration from your revisions → ARV −6%");
  expect(html).toContain("Now: Calibration from your revisions off");
  const thin = calibrationReport({ offers: offers.slice(0, 2) });
  const note = renderToStaticMarkup(<LessonsBody data={{ ...base, recommendations: [], calibration: { note: thin.note }, digestSaved: "" }} />);
  expect(note).toContain("Not enough of your revisions yet to calibrate: 2 of 5");
});
