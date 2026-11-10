// deal-deadlines-and-outcome.test.mjs — a deal keeps its deadlines and
// records who bought it (2026-11-09).
//
// What went wrong: an inspection period lapsed with no notice, an earnest
// date was found by phone, promote counted the inspection from the server's
// UTC day, a buyer who backed out left the deal "buyer found" with every
// other buyer told it was spoken for, and no deal held what its buyer paid.
//
// Same harness as deal-closing.test.mjs: JSON file backend in a temp
// directory, GHL stubbed to a no-op client, the router on listen(0).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

// Render runs in UTC: a promote at 6pm Pacific is already tomorrow there.
process.env.TZ = "UTC";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "deal-deadlines-test-"));
delete process.env.CARD_SENDS_ENABLED;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");
const { dealSpokenFor, dealOutreachPaused } = await import("./shared/offer-status.js");
const { dealScorecard } = await import("./shared/post-mortem.js");
const { resolveChecklist } = await import("./shared/deal-checklist.js");

const LOC = "loc-deal-deadlines-test";
const client = { call: async () => ({}) };
const router = createOffersRouter({ resolveLocation: () => ({ locationId: LOC, client }), uploadDir: process.env.DATA_DIR });
const app = express();
app.use(express.json({ limit: "5mb" }));
app.use("/api/offers", router);
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();

const req = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const TS = "2026-10-01T18:00:00.000Z";
let n = 0;
const mkOffer = (over = {}) => store.createOffer({
  id: crypto.randomUUID(), locationId: LOC, contactId: "agent-1", contactName: "Orla Penn",
  address: `${400 + ++n} Quillen Row, Auburn, WA 98002`, cashAmount: 300000, status: "sent",
  statusHistory: [{ ts: TS, status: "sent" }], ...over,
});
const mkDeal = (deal = {}, over = {}) => mkOffer({ status: "accepted", ...over, deal: {
  stage: "under_contract", createdAt: TS, stageHistory: [{ stage: "under_contract", ts: TS }],
  contractPrice: 300000, assignmentFee: 30000, investors: [], feedback: [], ...deal,
} });
const eventsOf = async (contactId) => (await store.listContactEvents(LOC, contactId, { limit: 50 })) || [];

/* ---------- dates from the paper, in Pacific days ---------- */

test("a deal promoted at 6pm Pacific ends inspection N Pacific days later, not N+1", async () => {
  const o = await mkOffer({ psa: { fields: { mode: "standard", feasibilityDays: 10, closingDate: "2026-11-20", earnestMoney: 1000, earnestDue: "feasibility" }, generatedAt: TS } });
  const sixPm = Date.parse("2026-10-21T01:00:00Z"); // Oct 20, 6pm in Seattle
  await router.promoteToDeal({ locationId: LOC, client, offer: await store.getOffer(o.id), now: sixPm });
  const deal = (await store.getOffer(o.id)).deal;
  assert.equal(deal.inspectionDate, "2026-10-30");
  assert.equal(deal.closingDate, "2026-11-20");
  assert.equal(deal.earnestMoney, 1000);
  assert.deepEqual(deal.datesFrom, { inspection: "psa", closing: "psa", earnest: "psa" });
  // The deposit after feasibility is chased three days after the inspection, not three after the contract.
  const earnest = resolveChecklist(deal, { now: sixPm }).items.find((i) => i.id === "earnest_money");
  assert.equal(earnest.dueYmd, "2026-11-02");
});

test("a PSA built after a write-up-terms letter names $1,000 due after feasibility", async () => {
  // The Conversation AI saved: its write-up terms are $1,000 earnest after the inspection, a 14 day inspection.
  await store.saveOfferSettings(LOC, { conversationAi: { enabled: false } });
  try {
    const o = await mkOffer({ terms: { earnestMoney: 1000, inspectionDays: 14 } });
    const r = await req("POST", `/api/offers/${o.id}/psa`, { fields: { mode: "standard", sellerName: "Ada Vale" } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const f = (await store.getOffer(o.id)).psa.fields;
    assert.deepEqual([f.earnestMoney, f.earnestDue, f.feasibilityDays], [1000, "feasibility", 14]);
    // What you type in the modal still wins.
    const typed = await req("POST", `/api/offers/${o.id}/psa`, { fields: { mode: "standard", earnestMoney: "2,500", earnestDue: "acceptance", feasibilityDays: 7 } });
    assert.equal(typed.status, 200, JSON.stringify(typed.json));
    const g = (await store.getOffer(o.id)).psa.fields;
    assert.deepEqual([g.earnestMoney, g.earnestDue, g.feasibilityDays], [2500, "acceptance", 7]);
  } finally {
    await store.saveOfferSettings(LOC, {});
  }
});

/* ---------- a buyer who backs out ---------- */

const committedDeal = (ids) => mkDeal({
  stage: "buyer_found",
  stageHistory: [{ stage: "under_contract", ts: TS }, { stage: "buyer_found", ts: "2026-10-05T18:00:00.000Z" }],
  investors: ids.map(([contactId, status]) => ({ contactId, name: contactId.replace(/^b-/, ""), status, addedAt: TS, updatedAt: TS })),
});

test("a buyer who backs out of a committed deal puts it back under contract and other buyers stop hearing it's spoken for", async () => {
  const o = await committedDeal([["b-lark", "committed"], ["b-fern", "evaluating"]]);
  assert.equal(dealSpokenFor((await store.getOffer(o.id)).deal), true);
  const r = await req("PATCH", `/api/offers/${o.id}/deal/investors/b-lark`, { status: "passed" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.reopened, true);
  const deal = (await store.getOffer(o.id)).deal;
  assert.equal(deal.stage, "under_contract");
  const last = deal.stageHistory.at(-1);
  assert.deepEqual([last.stage, last.reason, last.contactId], ["under_contract", "buyer_backed_out", "b-lark"]);
  assert.equal(dealSpokenFor(deal), false, "other buyers hear the numbers again");
  assert.equal(dealOutreachPaused(deal), null, "and the deal texts and catch-up start again");
  assert.ok((await eventsOf("b-lark")).some((e) => e.type === "investor_backed_out" && e.offerId === o.id && e.data?.reason === "buyer_backed_out"));
});

test("removing the committed buyer, or the bot hearing they're only looking again, reopens it too", async () => {
  const removed = await committedDeal([["b-wren", "committed"]]);
  const r = await req("DELETE", `/api/offers/${removed.id}/deal/investors/b-wren`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await store.getOffer(removed.id)).deal.stage, "under_contract");
  assert.ok((await eventsOf("b-wren")).some((e) => e.type === "investor_backed_out"));

  const byBot = await committedDeal([["b-sage", "committed"]]);
  const deps = router.conversationDepsFor({ locationId: LOC, client, saved: {} });
  const out = await deps.setInvestorStatus({ contactId: "b-sage", addressHint: byBot.address, status: "evaluating" });
  assert.equal(out.ok, true, JSON.stringify(out));
  const deal = (await store.getOffer(byBot.id)).deal;
  assert.equal(deal.stage, "under_contract");
  assert.equal(deal.stageHistory.at(-1).reason, "buyer_backed_out");
});

test("a deal with another committed buyer stays spoken for when one of them passes", async () => {
  const o = await committedDeal([["b-ash", "committed"], ["b-yew", "committed"]]);
  const r = await req("PATCH", `/api/offers/${o.id}/deal/investors/b-ash`, { status: "passed" });
  assert.equal(r.status, 200);
  assert.equal(r.json.reopened, false);
  const deal = (await store.getOffer(o.id)).deal;
  assert.equal(deal.stage, "buyer_found");
  assert.equal(dealSpokenFor(deal), true);
  // A buyer found by hand with nobody committed isn't "backed out" when an evaluating buyer passes.
  const byHand = await committedDeal([["b-elder", "evaluating"]]);
  await req("PATCH", `/api/offers/${byHand.id}/deal/investors/b-elder`, { status: "passed" });
  assert.equal((await store.getOffer(byHand.id)).deal.stage, "buyer_found");
});

/* ---------- what the deal records ---------- */

test("closing a deal records who bought it and at what price", async () => {
  const o = await mkDeal({ stage: "assigned", investors: [{ contactId: "b-oak", name: "Oak", status: "committed", addedAt: TS, updatedAt: TS }] });
  let r = await req("PATCH", `/api/offers/${o.id}/deal`, { stage: "closed", outcome: { buyerContactId: "b-oak", buyerName: "Oak", price: "312,000", closedAt: "2026-11-05" } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let full = await store.getOffer(o.id);
  assert.equal(full.deal.stage, "closed");
  const { buyerContactId, buyerName, price, fee, closedAt, by } = full.deal.outcome;
  assert.deepEqual({ buyerContactId, buyerName, price, fee, closedAt, by }, { buyerContactId: "b-oak", buyerName: "Oak", price: 312000, fee: 12000, closedAt: "2026-11-05", by: "you" });
  assert.equal(dealScorecard({ offer: full }).realizedFee, 12000, "the fee lesson reads what the buyer paid");
  const ev = (await eventsOf("agent-1")).find((e) => e.type === "deal_stage" && e.offerId === o.id);
  assert.deepEqual([ev?.data?.stage, ev?.data?.price, ev?.data?.fee], ["closed", 312000, 12000]);

  // A price that is a typo for thousands is refused, and nothing half-applies.
  r = await req("PATCH", `/api/offers/${o.id}/deal`, { stage: "assigned", outcome: { buyerContactId: "b-oak", price: "312" } });
  assert.equal(r.status, 400);
  full = await store.getOffer(o.id);
  assert.equal(full.deal.stage, "closed");
  assert.equal(full.deal.outcome.price, 312000);

  // Moving a deal to assigned with nothing recorded asks for it.
  const bare = await mkDeal({ stage: "buyer_found" });
  r = await req("PATCH", `/api/offers/${bare.id}/deal`, { stage: "assigned" });
  assert.equal(r.status, 200);
  assert.equal(r.json.askOutcome, true);
  assert.equal((await store.getOffer(bare.id)).deal.outcome, undefined, "nothing is guessed for you");
});

test("a wrong pass code on a deal can be corrected", async () => {
  const o = await mkDeal({
    investors: [{ contactId: "b-elm", name: "Elm", status: "passed", reason: { code: "area", note: "too far out", at: TS }, addedAt: TS, updatedAt: TS }],
    feedback: [
      { contactId: "b-elm", name: "Elm", code: "area", note: "too far out", status: "passed", ts: TS },
      { contactId: "b-elm", name: "Elm", code: "price", note: "", status: "passed", ts: TS },
    ],
  });
  let r = await req("PATCH", `/api/offers/${o.id}/deal/feedback`, { contactId: "b-elm", code: "area", to: "rehab_scope" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let deal = (await store.getOffer(o.id)).deal;
  assert.deepEqual(deal.feedback.map((f) => f.code), ["rehab_scope", "price"]);
  assert.equal(deal.feedback[0].correctedFrom, "area");
  assert.equal(deal.feedback[0].note, "too far out", "their words stay");
  assert.equal(deal.investors[0].reason.code, "rehab_scope");
  // Moved onto a code they already have: one entry, not two.
  r = await req("PATCH", `/api/offers/${o.id}/deal/feedback`, { contactId: "b-elm", code: "price", to: "rehab_scope" });
  assert.equal(r.status, 200);
  deal = (await store.getOffer(o.id)).deal;
  assert.deepEqual(deal.feedback.map((f) => f.code), ["rehab_scope"]);
  // Taken off outright.
  r = await req("PATCH", `/api/offers/${o.id}/deal/feedback`, { contactId: "b-elm", code: "rehab_scope", remove: true });
  assert.equal(r.status, 200);
  deal = (await store.getOffer(o.id)).deal;
  assert.deepEqual(deal.feedback, []);
  assert.equal(deal.investors[0].reason, null);
  // An unknown code is refused, and a row that isn't there is a 404.
  assert.equal((await req("PATCH", `/api/offers/${o.id}/deal/feedback`, { contactId: "b-elm", code: "rehab_scope", to: "vibes" })).status, 400);
  assert.equal((await req("PATCH", `/api/offers/${o.id}/deal/feedback`, { contactId: "b-elm", code: "layout", to: "price" })).status, 404);
});

test("what a buyer said the house is worth saves on the deal, typed as people type money", async () => {
  const o = await mkDeal({ stage: "fell_through" });
  const r = await req("PATCH", `/api/offers/${o.id}/deal`, { buyerRead: { arv: "480,000", rehab: "95k", price: "$280,000", note: "roof and sewer line" } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const { arv, rehab, price, note } = (await store.getOffer(o.id)).deal.buyerRead;
  assert.deepEqual({ arv, rehab, price, note }, { arv: 480000, rehab: 95000, price: 280000, note: "roof and sewer line" });
  await req("PATCH", `/api/offers/${o.id}/deal`, { buyerRead: null });
  assert.equal((await store.getOffer(o.id)).deal.buyerRead, undefined);
});

test.after(() => server.close());
