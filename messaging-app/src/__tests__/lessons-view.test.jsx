import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildPostMortem, dealScorecard, lessons } from "@shared/post-mortem.js";
import { LessonsBody, EngineScorecard } from "../LessonsView.jsx";
import { scorecard } from "@shared/price-scorecard.js";
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

test("the offer engine's scorecard says it's off, or how close it is to your numbers and whether grade A is ready", () => {
  const off = renderToStaticMarkup(<EngineScorecard data={{ switches: { shadow: false }, records: 0, card: scorecard([]) }} />);
  expect(off).toContain("Off. Turn it on in Settings");
  const now = Date.parse("2026-11-20T03:00:00Z");
  const recs = Array.from({ length: 22 }, (_, i) => ({ v2: { arv: 600000, rehab: 95000, walkAway: 310000, grade: "A", at: new Date(now - i * 86400000).toISOString() }, outcome: { mattArv: 610000, mattRehab: 90000 } }));
  const on = renderToStaticMarkup(<EngineScorecard data={{ switches: { shadow: true }, records: 22, card: scorecard(recs, { now }) }} />);
  expect(on).toContain("22 houses priced");
  expect(on).toContain("Grade A has cleared the bars");
});

test("the engine's scorecard counts walk-aways over the seller's number, reads the evening's card, and works it out now on a press", () => {
  const now = Date.parse("2026-11-20T03:00:00Z");
  const recs = Array.from({ length: 22 }, (_, i) => ({ v2: { arv: 600000, rehab: 95000, walkAway: 310000, grade: "A", at: new Date(now - i * 86400000).toISOString() },
    outcome: { mattArv: 610000, mattRehab: 90000 }, ...(i === 0 ? { reads: { sellerNumber: 300000 } } : {}) }));
  const html = renderToStaticMarkup(<EngineScorecard data={{ switches: { shadow: true }, records: 22, stored: true, at: "2026-11-20T03:30:00Z", card: scorecard(recs, { now }) }} onFresh={() => {}} />);
  expect(html).toContain("Over their number");
  expect(html).toContain("1 of 1");
  expect(html).toContain("1 walk-away above their stated number");
  expect(html).toContain("From the evening run");
  expect(html).toContain("Work it out now");
});

// Grade B's week in the shadow (2026-11-10): what it would have sent, beside Matt's own numbers.
test("the engine's scorecard says how many grade-B numbers would have gone out and where they opened against yours", () => {
  const now = Date.parse("2026-11-20T03:00:00Z");
  const b = (i, gradeB, outcome = {}) => ({ v2: { arv: 500000, rehab: 80000, walkAway: 255000, open: 240000, grade: "B", at: new Date(now - i * 86400000).toISOString(), gradeB }, outcome });
  const recs = [b(1, { mode: "shadow", open: 216000, wouldSend: true }, { mattNumber: 240000 }), b(2, { mode: "shadow", open: 216000, wouldSend: false })];
  const html = renderToStaticMarkup(<EngineScorecard data={{ switches: { shadow: true, liveB: "shadow" }, records: 2, card: scorecard(recs, { now }) }} />);
  expect(html).toContain("Grade B at the lower open: 2 priced, 1 would have gone out, 0 went, opening at 90% of your number (1 with yours).");
  const none = renderToStaticMarkup(<EngineScorecard data={{ switches: { shadow: true }, records: 1, card: scorecard([b(1, undefined)], { now }) }} />);
  expect(none).not.toContain("Grade B at the lower open");
});
