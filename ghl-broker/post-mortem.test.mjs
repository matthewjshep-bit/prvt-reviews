// post-mortem.test.mjs — the post-mortem routes and the fell-through code.
// Run with:  npm run test:post-mortem
//
// Same harness as deal-documents.test.mjs: JSON store in a temp dir, GHL
// stubbed. The thread reader and the feedback builder are injected so no
// network is touched; there is no AI key, so the deterministic half is what
// gets written and the job says so.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "post-mortem-test-"));

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");
const { default: createPostMortemRouter } = await import("./routes/post-mortem.js");
const { default: createDashboardRouter } = await import("./routes/dashboard.js");

const LOC = "loc-post-mortem-test";
const resolveLocation = () => ({ locationId: LOC, client: { call: async () => ({}) } });
const app = express();
app.use(express.json({ limit: "5mb" }));
const offersRouter = createOffersRouter({ resolveLocation, uploadDir: process.env.DATA_DIR, publicBaseUrl: "http://127.0.0.1:4996" });
app.use("/api/offers", offersRouter);
const feedbackCalls = [];
app.use("/api/offers", createPostMortemRouter({
  resolveLocation,
  feedbackFor: async ({ offer }) => { feedbackCalls.push(offer.id); return { generatedAt: "2026-09-10T00:00:00Z", funnel: { contacted: 20, replied: 12, passed: 9, silent: 8, committed: 0 }, objections: [{ code: "price", label: "Price too high", count: 2, buyers: [{ contactId: "b1", name: "Pat M", quote: "ARV is 1.7-1.9M, best I can do is 1.2-1.4", at: "2026-08-12T00:00:00Z" }] }], askedFor: [{ contactId: "b1", name: "Pat M", amount: 1400000 }], buyers: [{ contactId: "b1", name: "Pat M", status: "passed", passed: true, replied: true, repliedAt: "2026-08-12T00:00:00Z", quotes: [{ at: "2026-08-12T00:00:00Z", text: "ARV is 1.7-1.9M", aboutDeal: true }], calls: [] }] }; },
  deps: { readThread: async () => ({ text: "[2026-08-11 00:35] THEM sms: $1.85 is my breakeven with excise tax\n[2026-08-18 17:00] US sms: our buyers couldn't get there, we have to pass\n", stats: { messages: 2 } }) },
}));
app.use("/api/dashboard", createDashboardRouter({ resolveLocation }));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();

const req = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitJob = async (id) => {
  for (let i = 0; i < 100; i++) {
    const r = await req("GET", `/api/offers/${id}/deal/postmortem`);
    if (!r.json.job || r.json.job.status !== "running") return r.json;
    await sleep(30);
  }
  throw new Error("job never finished");
};

const snap = (over = {}) => ({ underwriteMode: "lowball", maoPctOfArv: 70, wholesaleFee: 30000, cashPctOfArv: 90, repairBuffer: 30000, repairHeavyPctOfArv: 10, repairBaseMult: 2, repairHeavyMult: 1.5, precisionJitter: true, ...over });
const mkDeal = (over = {}, dealOver = {}) => store.createOffer({
  id: crypto.randomUUID(), locationId: LOC, contactId: "agent-1", contactName: "David L",
  address: "10836 Northeast 12th Place, Bellevue, Washington 98004", cashAmount: 1934755, status: "accepted", statusHistory: [],
  calc: { inputs: { askingPrice: 0, arv: 2450000, repairs: 120000 }, settings: snap(), offers: { cash: { mode: "lowball", amount: 1934755 } } },
  deal: { stage: "under_contract", investors: [], stageHistory: [{ stage: "under_contract", ts: "2026-08-11T01:40:00Z" }], createdAt: "2026-08-11T01:40:00Z", contractPrice: 1850000, assignmentFee: 45000, fellThroughReason: "", ...dealOver },
  ...over,
});

test("marking a deal fallen through takes a code, validates it, and puts it on the event", async () => {
  const o = await mkDeal();
  const bad = await req("PATCH", `/api/offers/${o.id}/deal`, { stage: "fell_through", fellThroughCode: "meteor" });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /fellThroughCode must be one of/);
  const ok = await req("PATCH", `/api/offers/${o.id}/deal`, { stage: "fell_through", fellThroughReason: "Price too high", fellThroughCode: "buyers_passed_price" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.offer.deal.fellThroughCode, "buyers_passed_price");
  const events = await store.listContactEventsByOffer(LOC, o.id, { limit: 50 });
  const ev = events.find((e) => e.type === "deal_stage");
  assert.ok(ev, "a deal_stage event was written");
  assert.equal(ev.data.stage, "fell_through");
  assert.equal(ev.data.reason, "Price too high");
  assert.equal(ev.data.code, "buyers_passed_price");
  // The rejected body must not have half-applied itself: the stage moved once.
  const after = await store.getOffer(o.id);
  assert.equal(after.deal.stageHistory.filter((h) => h.stage === "fell_through").length, 1);
});

test("a promote records the buyer ceiling and warns when the ask is over it, without blocking", async () => {
  const o = await store.createOffer({
    id: crypto.randomUUID(), locationId: LOC, contactId: "agent-2", contactName: "G S", address: "2010 NE 54th St, Seattle, WA 98105",
    cashAmount: 833121, status: "sent", statusHistory: [{ status: "sent", ts: "2026-08-05T19:00:00Z" }],
    calc: { inputs: { askingPrice: 0, arv: 1200000, repairs: 110000 }, settings: snap(), offers: { cash: { mode: "lowball", amount: 833121 } } },
  });
  const r = await req("POST", `/api/offers/${o.id}/deal`, { contractPrice: 833121, assignmentFee: 10000 });
  assert.equal(r.status, 200);
  assert.equal(r.json.offer.deal.ceilingAtPromote.noFee, 730000);
  assert.ok((r.json.warnings || r.json.offer.warnings || []).some((w) => /buyer ceiling/.test(w)), `warned: ${JSON.stringify(r.json.warnings || r.json.offer.warnings)}`);
  assert.equal(r.json.offer.deal.stage, "under_contract");
});

test("POST builds the post-mortem from the injected threads and writes it on the deal", async () => {
  const o = await mkDeal({}, { stage: "fell_through", stageHistory: [{ stage: "under_contract", ts: "2026-08-11T01:40:00Z" }, { stage: "fell_through", ts: "2026-08-18T18:00:00Z" }], fellThroughReason: "Price too high", fellThroughCode: "buyers_passed_price" });
  const start = await req("POST", `/api/offers/${o.id}/deal/postmortem`);
  assert.equal(start.status, 202);
  assert.equal(start.json.job.status, "running");
  const done = await waitJob(o.id);
  assert.equal(done.job.status, "done", JSON.stringify(done.job));
  assert.ok(done.job.warnings.some((w) => /no AI key/.test(w)));
  const pm = done.postMortem;
  assert.equal(pm.version, 1);
  assert.equal(pm.scorecard.gap, 300000);
  assert.equal(pm.scorecard.buyers.contacted, 20);
  assert.equal(pm.scorecard.buyers.source, "threads");
  assert.equal(pm.negotiation.sellerNamedPrice, true);
  assert.equal(pm.analysis, null);
  assert.equal(pm.reasons.code, "buyers_passed_price");
  assert.equal(pm.reasons.quotes[0].name, "Pat M");
  assert.ok(feedbackCalls.includes(o.id));
  const events = await store.listContactEventsByOffer(LOC, o.id, { limit: 50 });
  const ev = events.find((e) => e.type === "post_mortem_built");
  assert.ok(ev);
  assert.equal(ev.data.by, "numbers");
  // A second POST while one runs is refused; after it's done it's allowed.
  const again = await req("POST", `/api/offers/${o.id}/deal/postmortem`);
  assert.equal(again.status, 202);
  await waitJob(o.id);
});

test("PUT stores a reading written by hand and rebuilds the numbers around it", async () => {
  const o = await mkDeal({}, { stage: "fell_through", fellThroughCode: "buyers_passed_price" });
  const put = await req("PUT", `/api/offers/${o.id}/deal/postmortem`, { analysis: {
    rootCauses: [{ code: "buyers_passed_price", weight: 0.8, summary: "we took his break-even", evidence: [{ who: "agent", quote: "$1.85 is my breakeven", at: "2026-08-11" }] }],
    agentSide: { narrative: "The seller named 1.85M and we wrote it.", concessions: [], backOutResponse: "understood" },
    whatWouldHaveSold: { price: 1595000, basis: "70% rule" }, lessons: ["Run the line before answering a named price."], by: "session",
  } });
  assert.equal(put.status, 202);
  const done = await waitJob(o.id);
  assert.equal(done.job.status, "done");
  assert.equal(done.postMortem.analysis.by, "session");
  assert.equal(done.postMortem.analysis.whatWouldHaveSold.price, 1595000);
  assert.equal(done.postMortem.scorecard.gap, 300000);
  const bad = await req("PUT", `/api/offers/${o.id}/deal/postmortem`, {});
  assert.equal(bad.status, 400);
});

test("a deal that isn't one yet, or isn't ours, is refused", async () => {
  const o = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "a", address: "1 Main St", cashAmount: 1, status: "sent", statusHistory: [] });
  assert.equal((await req("POST", `/api/offers/${o.id}/deal/postmortem`)).status, 409);
  assert.equal((await req("GET", `/api/offers/nope/deal/postmortem`)).status, 404);
});

test("the lessons endpoint reads every deal on the location and names the line", async () => {
  await store.createOffer({
    id: crypto.randomUUID(), locationId: LOC, contactId: "agent-3", contactName: "Allan P", address: "21904 Vashon Hwy SW, Vashon, WA 98070", cashAmount: 371030, status: "accepted", statusHistory: [],
    calc: { inputs: { askingPrice: 0, arv: 900000, repairs: 250000 }, settings: snap({ wholesaleFee: 16000 }), offers: { cash: { mode: "lowball", amount: 371030 } } },
    deal: { stage: "closed", investors: [], stageHistory: [{ stage: "under_contract", ts: "2026-08-09T18:00:00Z" }, { stage: "closed", ts: "2026-08-31T18:00:00Z" }], createdAt: "2026-08-09T18:00:00Z", contractPrice: 371030, assignmentFee: 15000 },
  });
  const r = await req("GET", `/api/dashboard/lessons`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.sample.failed >= 2);
  assert.equal(r.json.sample.controls, 1);
  const ids = r.json.recommendations.map((x) => x.id);
  assert.ok(ids.includes("ceiling_rule"));
  assert.ok(ids.includes("underwrite_mode"));
  assert.ok(r.json.deals.every((d) => d.scorecard));
  assert.equal(r.json.current.underwriteMode, "backstack");
  assert.ok(!/\$/.test(r.json.digest));
  assert.equal(r.json.secretsPresent.aiApiKey, false);
});

test.after(() => { server.close(); });
