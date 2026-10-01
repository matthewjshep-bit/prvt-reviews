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
