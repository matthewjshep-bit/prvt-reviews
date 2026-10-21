// deal-reply-link.test.mjs — a reply about a deal, filed on the deal.
//
// Kenneth Patton (2026-10-01) asked about 1510 Maple Lane's land lease, its
// size and its photos, and was on no deal. linkInvestorInterest now files any
// reply about a deal: evaluating, or passed with what they said — and it
// never moves a committed buyer, or anyone at all when it is only guessing.
//
//   node --test deal-reply-link.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "deal-reply-link-test-"));
delete process.env.DATABASE_URL;
delete process.env.CARD_SENDS_ENABLED;

const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");
await store.init();

const LOC = "loc-deal-reply-link";
const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
// A thread per contact: the pitch and when it went.
const threads = new Map();
const client = {
  call: async (p, opts = {}) => {
    const c = /^\/contacts\/([^/?]+)$/.exec(p);
    if (c && !opts.method) return { contact: { id: c[1], firstName: "Buyer", lastName: c[1], tags: ["investor"] } };
    if (p.startsWith("/conversations/search")) {
      const id = /contactId=([^&]+)/.exec(p)?.[1];
      return { conversations: threads.has(id) ? [{ id: `cv-${id}`, contactId: id }] : [] };
    }
    const m = /^\/conversations\/cv-([^/]+)\/messages/.exec(p);
    if (m) return { messages: threads.get(m[1]) || [] };
    if (p.includes("/customFields") && !opts.method) return { customFields: [] };
    if (p.includes("/customFields")) return { customField: { id: "cf-x" } };
    return {};
  },
};
const router = createOffersRouter({ resolveLocation: () => ({ locationId: LOC, client }), uploadDir: process.env.DATA_DIR });
const link = (args) => router.linkInvestorInterest({ locationId: LOC, client, ...args });

const maple = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "agent", address: "1510 Maple Lane, Kent, Washington 98030",
  cashAmount: 71075, status: "accepted", statusHistory: [],
  deal: { stage: "under_contract", contractPrice: 71075, assignmentFee: 5000, stageHistory: [], investors: [
    { contactId: "committed", name: "C", status: "committed" },
    { contactId: "looking", name: "L", status: "evaluating" },
  ] } });
await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "agent2", address: "3511 Northeast 153rd Street, Lake Forest Park, Washington 98155",
  cashAmount: 400000, status: "accepted", statusHistory: [], deal: { stage: "under_contract", contractPrice: 400000, assignmentFee: 21000, stageHistory: [], investors: [] } });
const pitched = (id, at) => threads.set(id, [{ id: `m-${id}`, dateAdded: at, direction: "outbound", messageType: "TYPE_SMS", body: "Hey, 1510 Maple Lane in Kent just went under contract. Interested?" }]);
const on = async (id) => (await store.getOffer(maple.id)).deal.investors.find((i) => i.contactId === id) || null;

test("a question about the deal last pitched puts them on it as evaluating", async () => {
  pitched("kenneth", day(0));
  const r = await link({ contactId: "kenneth", withinDays: 14, revive: false });
  assert.equal(r.linked, true, r.reason);
  assert.equal(r.offerId, maple.id);
  assert.equal((await on("kenneth")).status, "evaluating");
});

test("a pass goes on as passed with what they said, and moves someone who was looking", async () => {
  pitched("megan", day(1));
  await link({ contactId: "megan", status: "passed", reason: { code: "area", note: "too far south" }, withinDays: 14 });
  const megan = await on("megan");
  assert.equal(megan.status, "passed");
  assert.deepEqual({ code: megan.reason.code, note: megan.reason.note }, { code: "area", note: "too far south" });
  assert.ok((await store.getOffer(maple.id)).deal.feedback.some((f) => f.contactId === "megan" && f.code === "area"));

  pitched("looking", day(1));
  await link({ contactId: "looking", status: "passed", reason: { code: "price", note: "too high" }, withinDays: 14 });
  assert.equal((await on("looking")).status, "passed");
});

test("a committed buyer is never moved, and a guess never moves anyone already on it", async () => {
  pitched("committed", day(0));
  const r = await link({ contactId: "committed", status: "passed", reason: { code: "timing" }, withinDays: 14 });
  assert.equal(r.unchanged, true);
  assert.equal((await on("committed")).status, "committed");

  pitched("kenneth", day(0));
  await link({ contactId: "kenneth", status: "passed", addOnly: true, withinDays: 14 });
  assert.equal((await on("kenneth")).status, "evaluating", "Matt has the thread; a regex doesn't overrule what's there");
});

test("a reply that doesn't name the house needs it to have come up lately", async () => {
  pitched("stale", day(30));
  const r = await link({ contactId: "stale", withinDays: 14 });
  assert.equal(r.linked, false);
  assert.equal(await on("stale"), null);
  // Walk it / buy it keeps the old reach: any time in the thread.
  const warm = await link({ contactId: "stale" });
  assert.equal(warm.linked, true);
});

// 3831 Bagley Ave N and 1538 NW 61st St (2026-10-20): the same buyers had
// both. A buyer who walked Bagley texted "that's 400k not 110k" — Bagley's
// rehab — after 61st had gone to them, and it was filed on 61st.
test("a buyer's walkthrough verdict lands on the deal they walked", async () => {
  const bagley = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "agent3", address: "3831 Bagley Ave N, Seattle, WA 98103",
    cashAmount: 697500, status: "accepted", statusHistory: [], calc: { inputs: { arv: 1161000, repairs: 102000 } },
    deal: { stage: "under_contract", contractPrice: 740000, assignmentFee: 8000, stageHistory: [], investors: [{ contactId: "walker", name: "W", status: "evaluating" }],
      blasts: [{ at: day(6), wave: 1, contactIds: ["walker", "builder"] }] } });
  const ballard = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "agent4", address: "1538 Nw 61st St, Seattle, WA 98107",
    cashAmount: 890000, status: "accepted", statusHistory: [], asset: { type: "land", by: "you" }, calc: { inputs: { arv: 925000, repairs: 0 } },
    deal: { stage: "under_contract", contractPrice: 890000, assignmentFee: 21000, stageHistory: [], investors: [],
      blasts: [{ at: day(0), wave: 1, contactIds: ["walker", "builder"] }] } });
  // The newest pitch in the thread is 61st, and the model named it too.
  threads.set("walker", [
    { id: "m1", dateAdded: day(6), direction: "outbound", messageType: "TYPE_SMS", body: "Hey, 3831 Bagley Ave N in Seattle just went under contract." },
    { id: "m2", dateAdded: day(0), direction: "outbound", messageType: "TYPE_SMS", body: "Hey, got 1538 NW 61st St in Seattle under contract." },
  ]);
  const said = "It's all lath and plaster, you gotta go down to the studs, that's 400k not 110k";
  const r = await link({ contactId: "walker", addressHint: "1538 NW 61st St, Seattle, WA 98107", status: "passed", reason: { code: "rehab_scope", note: "down to the studs, 400k not 110k" }, said });
  assert.equal(r.offerId, bagley.id, r.reason);
  assert.equal((await store.getOffer(bagley.id)).deal.investors.find((i) => i.contactId === "walker").status, "passed");
  assert.ok(!(await store.getOffer(ballard.id)).deal.investors.some((i) => i.contactId === "walker"));

  // A builder's "not a land guy… how much land is it?" is about the lot.
  const b = await link({ contactId: "builder", status: "passed", reason: { code: "property_type", note: "not a land guy" }, said: "I'm not a land guy, how much land is it?" });
  assert.equal(b.offerId, ballard.id, b.reason);

  // Nothing that tells them apart: filed on neither.
  const unsure = await link({ contactId: "builder", status: "passed", reason: { code: "timing", note: "not right now" }, said: "Not right now, thanks" });
  assert.equal(unsure.linked, false);
});

