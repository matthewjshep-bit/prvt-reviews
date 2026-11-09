// thread-reads.test.mjs — every conversation, read for pricing evidence, every night.
//
//   node --test thread-reads.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "thread-reads-test-"));
delete process.env.DATABASE_URL;

const { store } = await import("./store.js");
const { readContact, planThreadReads, importThreadReads, maybeRunThreadReads } = await import("./thread-reads.js");
const { normalizeThreadRead, questionTopics } = await import("./shared/thread-read.js");
const { houseKey } = await import("./shared/current-offer.js");
await store.init();

const LOC = "LOC-tr";
const ADDRESS = "4417 Somerset Ln, Everett, WA 98203";
const thread = {
  messages: [
    { id: "m1", at: "2026-11-02T18:00:00.000Z", dir: "us", channel: "sms", body: "Hi Sam, could we land around 400k on 4417 Somerset?" },
    { id: "m2", at: "2026-11-02T18:05:00.000Z", dir: "them", channel: "sms", body: "Let me talk to them tonight." },
    { id: "m3", at: "2026-11-03T17:00:00.000Z", dir: "them", channel: "call", secs: 240, turns: [
      { speaker: "1", text: "So I talked to the sellers and honestly they would take 450 if you can close fast." },
      { speaker: "2", text: "Okay, and the roof?" },
      { speaker: "1", text: "Roof is shot and the kitchen is original, I'd guess 80 grand of work." }] },
  ],
};
const raw = {
  kind: "listing_agent", broughtOtherHouses: 0, summary: "Seller would take 450k; roof and kitchen.",
  representation: { offered: false, quote: null, askedCommission: false },
  openQuestions: [{ topic: "Proof of funds", quote: "can you send proof of funds?", answered: "deferred" }],
  houses: [{ address: ADDRESS, listed: true, listPrice: 525000, ourNumbers: [{ amount: 400000, date: "2026-11-02" }],
    sellerNumbers: [{ amount: 450000, date: "2026-11-03", kind: "would_take" }], agentArv: null, agentRehab: 80000,
    condition: "moderate", conditionWords: "Roof is shot and the kitchen is original", killers: [], outcome: "open",
    otherBuyerPrice: null, whyItDied: null, walkBack: false, quote: "they would take 450 if you can close fast" }],
};

test("a seller's number said on a call lands on that house's record", async () => {
  const r = await readContact({ locationId: LOC, contactId: "c1", party: "agent", store, saved: {}, deps: { readThread: async () => thread, read: async () => raw } });
  assert.equal(r.status, "read");
  assert.equal(r.houses, 1);
  const rec = await store.getHousePricing(LOC, houseKey(ADDRESS));
  assert.ok(rec, "a record for the house, even before the engine priced it");
  const e = rec.doc.evidence[0];
  assert.equal(e.sellerLowest, 450000);
  assert.equal(e.agentRehab, 80000);
  assert.equal(e.ourLast, 400000);
  assert.equal(e.quote, "they would take 450 if you can close fast", "found in the call transcript");
  const stored = await store.getThreadRead(LOC, "c1");
  assert.equal(stored.throughAt, "2026-11-03T17:00:00.000Z", "read through the newest message");
  // A second read of the same contact replaces its row, it doesn't pile up.
  await readContact({ locationId: LOC, contactId: "c1", party: "agent", store, saved: {}, deps: { readThread: async () => thread, read: async () => raw } });
  assert.equal((await store.getHousePricing(LOC, houseKey(ADDRESS))).doc.evidence.length, 1);
});

test("a quote that isn't in their own words is dropped", () => {
  const read = normalizeThreadRead({ ...raw, houses: [{ ...raw.houses[0], quote: "could we land around 400k on 4417 Somerset?" }] }, thread, { party: "agent" });
  assert.equal(read.houses[0].quote, null, "that line is ours");
  assert.equal(read.openQuestions[0].quote, null, "they never said it");
  assert.equal(read.openQuestions[0].topic, "proof of funds");
  assert.deepEqual(questionTopics([read]), [["proof of funds", 1]]);
});

test("a thread that hasn't moved isn't read again; an investor is read as an investor", async () => {
  await store.upsertThreadRead(LOC, "same", { through: "2026-11-03T17:00:00.000Z", readAt: "2026-11-04T00:00:00.000Z" });
  const convos = [
    { contactId: "moved", lastMessageDate: Date.parse("2026-11-04T15:00:00Z"), tags: ["agent-outreach"] },
    { contactId: "same", lastMessageDate: Date.parse("2026-11-03T17:00:00Z"), tags: ["agent"] },
    { contactId: "buyer", lastMessageDate: Date.parse("2026-11-04T14:00:00Z"), tags: ["investor"] },
    { contactId: "old", lastMessageDate: Date.parse("2026-10-01T00:00:00Z"), tags: ["agent"] },
  ];
  const plan = await planThreadReads({ locationId: LOC, store, since: "2026-11-02T00:00:00Z",
    deps: { searchConversations: async (_c, _l, { startAfterDate }) => ({ conversations: startAfterDate ? [] : convos }) } });
  assert.deepEqual(plan.map((p) => [p.contactId, p.party, p.why]), [["moved", "agent", "never_read"], ["buyer", "investor", "never_read"]]);
});

test("the backfill imports without a model call, dry by default, and isn't re-read the first night", async () => {
  const rows = [{ contactId: "b1", ...raw, houses: [{ ...raw.houses[0], address: "22 Pine St, Tacoma, WA 98402" }] },
    { contactId: "i1", party: "investor", deals: [{ address: "22 Pine St, Tacoma, WA 98402", pitchedPrice: 340000, theirPrice: 290000, theirArv: 520000, theirRehab: 120000, verdict: "passed", reason: "rehab", quote: "rehab is more like 120" }],
      rules: { pctOfArv: 70, minProfit: 50000, maxPrice: null, rehabView: null, quote: null }, openQuestions: [], summary: "" }];
  const dry = await importThreadReads({ store, locationId: LOC, rows, by: "backfill:2026-11-04" });
  assert.deepEqual({ imported: dry.imported, houses: dry.houses }, { imported: 2, houses: 2 });
  assert.equal(await store.getThreadRead(LOC, "b1"), null, "dry wrote nothing");
  await importThreadReads({ store, locationId: LOC, rows, by: "backfill:2026-11-04", dryRun: false, through: "2026-11-04T23:00:00Z" });
  const rec = await store.getHousePricing(LOC, houseKey("22 Pine St, Tacoma, WA 98402"));
  assert.equal(rec.doc.evidence.length, 2, "the agent's row and the investor's row");
  assert.equal(rec.doc.evidence.find((e) => e.party === "investor").theirRehab, 120000);
  assert.equal((await store.getThreadRead(LOC, "i1")).doc.rules.pctOfArv, 0.7);
  const plan = await planThreadReads({ locationId: LOC, store, since: "2026-11-01T00:00:00Z",
    deps: { searchConversations: async (_c, _l, { startAfterDate }) => ({ conversations: startAfterDate ? [] : [{ contactId: "b1", lastMessageDate: Date.parse("2026-11-04T20:00:00Z"), tags: ["agent"] }] }) } });
  assert.equal(plan.length, 0, "covered through the backfill");
});

test("the nightly read waits for its switch and a key", async () => {
  const sixAm = Date.parse("2026-11-05T14:10:00Z");
  assert.equal(await maybeRunThreadReads({ locationId: LOC, saved: {}, store, now: sixAm }), null);
  assert.equal(await maybeRunThreadReads({ locationId: LOC, saved: { pricingV2: { reads: true } }, store, now: sixAm }), null, "no AI key");
});
