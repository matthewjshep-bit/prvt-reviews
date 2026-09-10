// post-mortem.test.mjs — the arithmetic of a dead deal, pinned to the five
// real ones that taught it: three that fell through (Bellevue, Edmonds,
// Seattle NE 54th) and two that sold (Vashon, Snohomish). Run with:
//   node --test shared/post-mortem.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  FELL_THROUGH_CODES, normalizeFellThroughCode, codeFromPassReasons, buyerCeiling, dealScorecard,
  buildPostMortem, lessons, normalizeAnalysis, amountsIn,
} from "./post-mortem.js";

const snap = (over = {}) => ({ underwriteMode: "lowball", maoPctOfArv: 70, wholesaleFee: 30000, cashPctOfArv: 90, repairBuffer: 30000, repairHeavyPctOfArv: 10, repairBaseMult: 2, repairHeavyMult: 1.5, precisionJitter: true, ...over });
const inv = (name, status, reason = null) => ({ contactId: `c-${name.toLowerCase().replace(/\s+/g, "-")}`, name, status, reason, addedAt: "2026-08-11T02:00:00Z", updatedAt: "2026-08-12T02:00:00Z" });

const bellevue = {
  id: "o-bellevue", address: "10836 Northeast 12th Place, Bellevue, Washington 98004", contactId: "agent-leonti", contactName: "David Leonti",
  createdAt: "2026-08-11T01:30:00Z", cashAmount: 1934755.04,
  calc: { inputs: { askingPrice: 0, arv: 2450000, repairs: 120000 }, settings: snap(), offers: { cash: { mode: "lowball", amount: 1934755.04 } } },
  deal: { stage: "fell_through", createdAt: "2026-08-11T01:40:00Z", contractPrice: 1850000, assignmentFee: 45000, fellThroughReason: "Price too high",
    stageHistory: [{ stage: "under_contract", ts: "2026-08-11T01:40:00Z" }, { stage: "fell_through", ts: "2026-08-18T18:00:00Z" }],
    investors: [inv("Vlad T", "passed"), inv("Rith R", "sent"), inv("Kate B", "passed"), inv("Sam S", "passed"), inv("Jon T", "sent")], feedback: [] },
};
const edmonds = {
  id: "o-edmonds", address: "22018 76th Avenue West, Edmonds, Washington 98026", contactId: "agent-shaw", contactName: "Catrina Shaw",
  createdAt: "2026-08-28T20:00:00Z", cashAmount: 485721,
  revisions: [{ ts: "2026-09-04T16:13:30Z", from: 465568, to: 460990 }, { ts: "2026-09-04T17:00:50Z", from: 460990, to: 470990 }, { ts: "2026-09-06T19:30:00Z", from: 470990, to: 481964 }, { ts: "2026-09-06T19:31:14Z", from: 481964, to: 485721 }],
  calc: { inputs: { askingPrice: 0, arv: 700000, repairs: 30000 }, settings: snap({ underwriteMode: "backstack", wholesaleFee: 9000 }), offers: { cash: { mode: "backstack", amount: 485721 } } },
  deal: { stage: "fell_through", createdAt: "2026-09-04T18:00:00Z", contractPrice: 480000, assignmentFee: 9000, fellThroughReason: "price, not accurate rehab estimate",
    stageHistory: [{ stage: "under_contract", ts: "2026-09-04T18:00:00Z" }, { stage: "fell_through", ts: "2026-09-10T18:00:00Z" }],
    investors: [
      inv("Flavia G", "passed", { code: "rehab_scope", note: "30k rehab 🤣", at: "2026-09-09T00:13:00Z" }),
      inv("Alex C", "passed", { code: "rehab_scope", note: "needs way over $30k", at: "2026-09-09T00:21:00Z" }),
      inv("Richard R", "passed", { code: "price", note: "aggressive on the resale price", at: "2026-09-09T00:42:00Z" }),
      inv("Phong M", "passed", { code: "area", note: "Not this one", at: "2026-09-08T15:26:00Z" }),
      inv("Denis V", "passed", { code: "area", note: "busy rd", at: "2026-09-09T20:59:00Z" }),
      inv("Isaiah A", "sent"),
    ],
    feedback: [{ contactId: "c-denis-v", code: "condition", note: "Busy rd", ts: "2026-09-09T20:59:00Z" }] },
};
const seattle = {
  id: "o-seattle", address: "2010 Northeast 54th Street, Seattle, Washington 98105", contactId: "agent-stevens", contactName: "Georgia Stevens",
  createdAt: "2026-08-05T19:00:00Z", cashAmount: 833120.69,
  calc: { inputs: { askingPrice: 0, arv: 1200000, repairs: 110000 }, settings: snap(), offers: { cash: { mode: "lowball", amount: 833120.69 } } },
  deal: { stage: "fell_through", createdAt: "2026-08-09T18:00:00Z", contractPrice: 833120.69, assignmentFee: 10000, fellThroughReason: "Price to High given rehab",
    stageHistory: [{ stage: "under_contract", ts: "2026-08-09T18:00:00Z" }, { stage: "fell_through", ts: "2026-08-17T18:00:00Z" }],
    investors: [inv("Regina W", "passed"), inv("Greg E", "sent"), inv("Deepali P", "passed"), inv("Lisa K", "sent"), inv("Sid B", "sent"), inv("Taj S", "passed"), inv("Dave B", "sent"), inv("Varun J", "sent"), inv("Chan L", "passed"), inv("Shane M", "sent"), inv("Glenn F", "sent"), inv("Emory T", "sent")], feedback: [] },
};
const vashon = {
  id: "o-vashon", address: "21904 Vashon Hwy SW, Vashon, WA 98070", contactId: "agent-ponio", contactName: "Allan Ponio",
  createdAt: "2026-08-03T19:00:00Z", cashAmount: 371030.22,
  calc: { inputs: { askingPrice: 0, arv: 900000, repairs: 250000 }, settings: snap({ wholesaleFee: 16000 }), offers: { cash: { mode: "lowball", amount: 371030.22 } } },
  deal: { stage: "closed", createdAt: "2026-08-09T18:00:00Z", contractPrice: 371030.22, assignmentFee: 15000,
    stageHistory: [{ stage: "under_contract", ts: "2026-08-09T18:00:00Z" }, { stage: "buyer_found", ts: "2026-08-10T18:00:00Z" }, { stage: "closed", ts: "2026-08-31T18:00:00Z" }],
    investors: [inv("Todd G", "sent"), inv("Robert H", "committed"), inv("Manuel M", "sent")], feedback: [] },
};
const snohomish = {
  id: "o-snohomish", address: "1415 2nd St, Snohomish, WA 98290", contactId: "agent-simonson", contactName: "Christian Simonson",
  createdAt: "2026-08-28T20:00:00Z", cashAmount: 420000,
  calc: { inputs: { askingPrice: 0, arv: 750000, repairs: 90000 }, settings: snap({ maoPctOfArv: 72.5 }), offers: { cash: { mode: "lowball", amount: 420000, overridden: true, systemAmount: 470550 } } },
  deal: { stage: "buyer_found", createdAt: "2026-08-31T17:00:00Z", contractPrice: 430000, assignmentFee: 13000,
    stageHistory: [{ stage: "under_contract", ts: "2026-08-31T17:00:00Z" }, { stage: "buyer_found", ts: "2026-09-03T17:00:00Z" }],
    investors: [inv("Carolyn B", "passed"), inv("Glen S", "committed"), inv("Hung P", "sent")], feedback: [] },
};
const SETTINGS = { underwriteMode: "lowball", maoPctOfArv: 72.5, wholesaleFee: 30000 };

test("the vocabulary normalises and the buyers' reasons point at a code", () => {
  assert.equal(normalizeFellThroughCode("Buyers Passed Price"), "buyers_passed_price");
  assert.equal(normalizeFellThroughCode("nonsense"), "");
  assert.ok(FELL_THROUGH_CODES.includes("seller_backed_out"));
  assert.equal(codeFromPassReasons([]), "no_buyer_response");
  assert.equal(codeFromPassReasons([{ code: "timing", count: 2 }]), "other");
  // rehab + condition pool together and beat a tie with area
  assert.equal(codeFromPassReasons([{ code: "area", count: 2 }, { code: "rehab_scope", count: 2 }, { code: "condition", count: 1 }]), "buyers_passed_rehab");
  assert.equal(codeFromPassReasons([{ code: "price", count: 3 }, { code: "area", count: 1 }]), "buyers_passed_price");
});

test("the buyer ceiling is the 70% rule off the offer's own snapshot, never the asking price", () => {
  const c = buyerCeiling({ offer: bellevue, settings: SETTINGS });
  assert.equal(c.computable, true);
  assert.equal(c.source, "offer_snapshot");
  assert.equal(c.pct, 70);                      // the snapshot's 70, not the location's 72.5
  assert.equal(c.noFee, 1595000);               // 0.7 × 2.45M − 120k
  assert.equal(c.withFee, 1550000);             // minus the 45k fee on the deal
  const noArv = buyerCeiling({ offer: { calc: { inputs: { askingPrice: 500000, arv: 0, repairs: 10000 } } } });
  assert.equal(noArv.computable, false);
  const live = buyerCeiling({ offer: { arv: 700000, repairs: 0 }, settings: SETTINGS, fee: 30000 });
  assert.equal(live.source, "location_settings");
  assert.equal(live.noFee, 507500);
  assert.match(live.note, /no repair estimate/);
  const override = buyerCeiling({ offer: bellevue, pct: 65 });
  assert.equal(override.noFee, 1472500);
});

test("the scorecard says how far over the line each deal was", () => {
  const b = dealScorecard({ offer: bellevue, settings: SETTINGS });
  assert.equal(b.outcome, "fell_through");
  assert.equal(b.buyerPrice, 1895000);
  assert.equal(b.gap, 300000);
  assert.equal(b.gapPctOfArv, 12.2);
  assert.equal(b.overCeiling, true);
  assert.equal(b.days.underContract, 8);
  assert.equal(b.buyers.contacted, 5);
  assert.equal(b.buyers.passed, 3);
  assert.equal(b.buyers.silent, 2);
  assert.equal(b.buyers.source, "record");
  assert.equal(b.fellThroughCode, "no_buyer_response");   // nobody coded a reason on the record

  const e = dealScorecard({ offer: edmonds, settings: SETTINGS });
  assert.equal(e.gap, 29000);                              // 489k asked vs 460k (70% × 700k − 30k)
  assert.equal(e.underwrite.firstOffer, 465568);
  assert.equal(e.underwrite.climb, 480000 - 465568);
  assert.equal(e.underwrite.revisions, 4);
  assert.equal(e.fellThroughCode, "buyers_passed_rehab");
  assert.deepEqual(e.buyers.codedReasons.map((r) => `${r.code}:${r.count}`), ["area:2", "rehab_scope:2", "condition:1", "price:1"]);
  assert.equal(e.days.toFirstPass, 3.9);

  const v = dealScorecard({ offer: vashon, settings: SETTINGS });
  assert.equal(v.outcome, "closed");
  assert.ok(v.gap <= 8000, `vashon gap ${v.gap}`);
  const s = dealScorecard({ offer: snohomish, settings: SETTINGS });
  assert.equal(s.overCeiling, false);
  assert.equal(s.underwrite.overridden, true);
  assert.equal(s.underwrite.systemAmount, 470550);
});

test("a feedback package sharpens the buyer counts and the reasons", () => {
  const feedback = {
    generatedAt: "2026-09-10T00:00:00Z",
    funnel: { contacted: 40, replied: 14, passed: 10, silent: 26, committed: 0 },
    objections: [{ code: "price", label: "Price too high", count: 2, buyers: [{ contactId: "x1", name: "Rich R", quote: "aggressive on the resale", at: "2026-09-09T00:42:00Z" }, { contactId: "x2", name: "Al C", quote: "closer to 440", at: "2026-09-09T01:00:00Z" }] }],
    askedFor: [{ contactId: "x2", amount: 440000 }, { contactId: "x3", amount: 450000 }],
    buyers: [{ contactId: "x1", repliedAt: "2026-09-05T00:00:00Z", passed: true }, { contactId: "x2", repliedAt: "2026-09-04T20:00:00Z", passed: false }],
  };
  const e = dealScorecard({ offer: edmonds, settings: SETTINGS, feedback });
  assert.equal(e.buyers.contacted, 40);
  assert.equal(e.buyers.source, "threads");
  assert.equal(e.buyers.replyRate, 35);
  assert.deepEqual(e.buyers.askedFor, { n: 2, min: 440000, median: 445000, max: 450000 });
  assert.equal(e.days.toFirstReply, 0.1);
  assert.ok(e.buyers.codedReasons.find((r) => r.code === "price").count >= 2);
});

test("the post-mortem reads the agent thread for the numbers and the no", () => {
  const thread = [
    "[2026-08-10 21:32] US sms: Can you send the all-in number for 10836 NE 12th Pl?",
    "[2026-08-11 00:35] THEM sms: $1.85.... which would include drywall and paint. That's my breakeven with excise tax",
    "[2026-08-11 01:18] THEM sms: That's about it man 1,835,000",
    "[2026-08-11 01:22] US sms: $1.835M +$120K to finish",
    "[2026-08-12 10:00] THEM sms: How are we looking?",
    "[2026-08-18 17:00] US sms: Our buyers couldn't make the numbers work at this price, we have to pass.",
    "[2026-08-18 17:30] THEM call TRANSCRIPT:",
    "Speaker 1: I understand, the buyers wanted it closer to 1.6.",
    "Speaker 2: Ok thanks anyway.",
  ].join("\n");
  const pm = buildPostMortem({ offer: bellevue, settings: SETTINGS, agentThread: thread, events: [
    { type: "blast_sent", at: "2026-08-11T03:00:00Z", contactId: "b1" }, { type: "blast_sent", at: "2026-08-11T03:00:00Z", contactId: "b2" },
    { type: "investor_passed", at: "2026-08-12T03:00:00Z", contactId: "b1", party: "investor" },
  ] });
  assert.equal(pm.version, 1);
  assert.equal(pm.scorecard.gap, 300000);
  assert.equal(pm.negotiation.sellerNamedPrice, true);
  assert.equal(pm.negotiation.sellerNamedAt, "2026-08-11T00:35:00.000Z");
  const agentLines = pm.negotiation.exchange.filter((x) => x.who === "agent");
  assert.ok(agentLines.some((x) => x.amounts.includes(1850000)), "reads $1.85 as 1.85M on a $2M house");
  assert.ok(agentLines.some((x) => x.amounts.includes(1835000)));
  assert.ok(pm.negotiation.exchange.some((x) => x.channel === "call" && /closer to 1.6/.test(x.text)));
  assert.ok(!pm.negotiation.exchange.some((x) => /How are we looking/.test(x.text)), "chatter without money or a no is not the negotiation");
  assert.equal(pm.eventCounts.blast_sent, 2);
  assert.ok(!pm.timeline.some((t) => t.type === "blast_sent"), "blasts are counted, not listed");
  assert.ok(pm.timeline.some((t) => t.type === "deal_stage" && t.data.stage === "fell_through"));
  assert.equal(pm.analysis, null);
  assert.equal(pm.sources.agentThreadChars, thread.length);
});

test("an analysis is trimmed to the shape the page renders", () => {
  assert.equal(normalizeAnalysis(null), null);
  assert.equal(normalizeAnalysis({ rootCauses: [] }), null);
  const a = normalizeAnalysis({
    rootCauses: [{ code: "buyers_passed_price", weight: 1.7, evidence: [{ who: "buyer", quote: "closer to 1.6" }, { who: "martian", quote: "x" }] }, { code: "bogus" }],
    agentSide: { narrative: "We took his break-even.", concessions: [{ at: "2026-08-11", from: 1934755, to: 1850000, why: "his number" }] },
    whatWouldHaveSold: { price: "1595000", basis: "70% rule" }, lessons: ["Run the line first", ""], by: "session",
  });
  assert.equal(a.rootCauses.length, 1);
  assert.equal(a.rootCauses[0].weight, 1);
  assert.equal(a.rootCauses[0].evidence[1].who, "buyer");
  assert.equal(a.whatWouldHaveSold.price, 1595000);
  assert.deepEqual(a.lessons, ["Run the line first"]);
  assert.equal(a.by, "session");
});

test("lessons across the five deals name the line, the model, the fee and the rehab", () => {
  const pms = [bellevue, edmonds, seattle].map((offer) => buildPostMortem({ offer, settings: SETTINGS }));
  const controls = [vashon, snohomish].map((offer) => dealScorecard({ offer, settings: SETTINGS }));
  const L = lessons({ postMortems: pms, controls, settings: SETTINGS });
  assert.equal(L.sample.failed, 3);
  assert.equal(L.sample.controls, 2);
  const ids = L.recommendations.map((r) => r.id);
  assert.ok(ids.includes("ceiling_rule"));
  assert.ok(ids.includes("underwrite_mode"));
  assert.ok(ids.includes("mao_pct"));
  assert.ok(ids.includes("fee_reality"));
  assert.ok(ids.includes("rehab_floor"));
  assert.ok(ids.includes("no_climbing"));
  assert.ok(ids.includes("silent_majority"));
  assert.equal(L.recommendations.find((r) => r.id === "ceiling_rule").confidence, "high");
  assert.deepEqual(L.recommendations.find((r) => r.id === "underwrite_mode").suggestedSettings, { underwriteMode: "mao" });
  assert.deepEqual(L.recommendations.find((r) => r.id === "mao_pct").suggestedSettings, { maoPctOfArv: 70 });
  const fee = L.recommendations.find((r) => r.id === "fee_reality").suggestedSettings.wholesaleFee;
  assert.ok(fee >= 10000 && fee <= 15000, `fee ${fee}`);
  const gapMetric = L.metrics.find((m) => m.key === "gapPctOfArv");
  assert.equal(gapMetric.separates, true);
  assert.ok(gapMetric.failed.median > 1 && gapMetric.controls.median < 1);
  assert.ok(!/\$/.test(L.digest), "the digest carries no dollar figures");
  assert.match(L.digest, /% of ARV/);
  assert.equal(L.current.maoPctOfArv, 72.5);
});

test("a seller's number becoming ours is its own lesson", () => {
  const thread = "[2026-08-11 00:35] THEM sms: $1.85 is my breakeven\n";
  const pm = buildPostMortem({ offer: bellevue, settings: SETTINGS, agentThread: thread });
  const L = lessons({ postMortems: [pm], controls: [], settings: SETTINGS });
  const r = L.recommendations.find((x) => x.id === "seller_named_price");
  assert.ok(r);
  assert.match(r.evidence[0], /named \$1,850,000/);
  // Our own counter coming back through the agent is not the seller naming a price.
  const relay = "[2026-08-30 20:20] US sms: Can we counter at $430k?\n[2026-08-30 23:19] THEM sms: They verbally accepted our counter at 430k\n";
  assert.equal(buildPostMortem({ offer: snohomish, settings: SETTINGS, agentThread: relay }).negotiation.sellerNamedPrice, false);
  // Nothing to say when nothing died.
  const none = lessons({ postMortems: [], controls: [dealScorecard({ offer: vashon })], settings: SETTINGS });
  assert.ok(!none.recommendations.some((x) => x.id === "ceiling_rule"));
});

test("money in a text is read the way the reply agent reads it, floored at five figures", () => {
  assert.deepEqual(amountsIn("closer to 440k, maybe $1,835,000 or 1.6m"), [440000, 1835000, 1600000]);
  assert.deepEqual(amountsIn("call me at 5pm, 98026"), []);
});
