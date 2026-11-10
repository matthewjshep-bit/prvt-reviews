// pending-offer-sends.test.mjs — the tick's send retries read only what's
// waiting, and a few names come without the whole investor book.
//
// 2026-11-09: retryPendingOfferSends and sendPaperAfterSilence each read the
// newest 300 whole offer documents (about 9KB each) every fifteen minutes to
// find the handful waiting on a send, and Flow read the 3.5MB investor book on
// every thirty-second poll for a few names. On the JSON store, through the
// real router; the SQL twins are checked as text here and run for real in
// store-pg.test.mjs when CI gives it a Postgres.
//
//   node --test pending-offer-sends.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pending-offer-sends-test-"));
process.env.CARD_SENDS_ENABLED = "true";
delete process.env.DATABASE_URL;

const { store, pendingSendsQuery, contactNamesQuery } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");

const LOC = "loc-pending-sends";
const client = { call: async () => ({}) };
const router = createOffersRouter({ resolveLocation: () => ({ locationId: LOC, client }), uploadDir: process.env.DATA_DIR, publicBaseUrl: "http://127.0.0.1:1" });
await store.init();
await store.saveOfferSettings(LOC, { conversationAi: { enabled: true } });

// Tuesday 2026-10-06, 11am Pacific: inside the auto-send hours.
const NOW = Date.parse("2026-10-06T18:00:00Z");
const DAY = 86400000;
const iso = (t) => new Date(t).toISOString();
let k = 0;
const mk = (over = {}) => store.createOffer({
  id: crypto.randomUUID(), locationId: LOC, contactId: `agent-${++k}`, contactName: "Robin Invented",
  address: `${100 + k} Larkspur Ln, Kent, WA 98031`, cashAmount: 250000, status: "new", statusHistory: [], ...over,
});

test("the pending-send retry reads only offers waiting to send", async () => {
  for (let i = 0; i < 12; i++) await mk();
  const stale = await mk({ autoSendPending: { reason: "after hours", at: iso(NOW - 10 * DAY), by: "audit" } });
  await mk({ autoSendPending: { reason: "after hours", at: iso(NOW - DAY), by: "audit" }, deal: { stage: "under_contract" } });

  const calls = [];
  const real = store.listOffers;
  store.listOffers = async (...a) => { calls.push(a[1] || {}); return real.apply(store, a); };
  try {
    const r = await router.retryPendingOfferSends({ client, locationId: LOC, now: NOW });
    assert.equal(r.checked, 1, "one offer is waiting; the deal and the other twelve are never read");
    assert.equal(calls.length, 0, "no read of the book");
  } finally { store.listOffers = real; }
  assert.equal((await store.getOffer(stale.id)).autoSendPending, undefined, "a week-old pending send is still dropped");
});

test("a float with no paper yet waits to send; one with paper tried, an old float or a deal doesn't", async () => {
  const since = iso(NOW - 15 * DAY);
  const fresh = await mk({ proactive: { realmCheckAt: iso(NOW - 3 * DAY) } });
  await mk({ proactive: { realmCheckAt: iso(NOW - 3 * DAY) }, paperAfterFloat: { status: "sent" } });
  await mk({ proactive: { realmCheckAt: iso(NOW - 40 * DAY) } });
  await new Promise((r) => setTimeout(r, 5)); // the newest row, by a clear margin
  await mk({ proactive: { realmCheckAt: iso(NOW - 3 * DAY) }, deal: { stage: "under_contract" } });
  const rows = await store.listPendingOfferSends(LOC, { floatedSince: since });
  assert.ok(rows.some((o) => o.id === fresh.id));
  assert.equal(rows.filter((o) => o.proactive?.realmCheckAt).length, 1);
  assert.ok((await store.listPendingOfferSends(LOC)).every((o) => o.autoSendPending), "without floatedSince, only held sends");
  assert.equal((await store.listPendingOfferSends(LOC, { floatedSince: since, limit: 1 })).length, 0, "only among the newest");
});

test("a few names come from the investor book, then the contact record, without reading the book", async () => {
  await store.upsertInvestors(LOC, [{ contactId: "buyer-1", name: "Quinn Buyer", doc: { name: "Quinn Buyer" } }]);
  await store.upsertContactProfile(LOC, "buyer-1", { name: "Q. Buyer" });
  await store.upsertContactProfile(LOC, "agent-x", { name: "Sky Agent" });
  const real = store.listInvestors;
  store.listInvestors = async () => { throw new Error("the whole book was read"); };
  try {
    assert.deepEqual(await store.contactNamesByIds(LOC, ["buyer-1", "agent-x", "nobody", "", null, "buyer-1"]), { "buyer-1": "Quinn Buyer", "agent-x": "Sky Agent" });
    assert.deepEqual(await store.contactNamesByIds(LOC, []), {});
    assert.deepEqual(await store.contactNamesByIds("another-loc", ["buyer-1"]), {}, "one location's names only");
  } finally { store.listInvestors = real; }
});

test("the Postgres twins narrow in SQL, among the newest rows, and never a deal", () => {
  const q = pendingSendsQuery({ locationId: "L", limit: 300, floatedSince: "2026-10-01T00:00:00.000Z" });
  assert.match(q.text, /where id in \(select id from offers where location_id = \$1 order by created_at desc limit \$2\)/);
  assert.match(q.text, /jsonb_typeof\(doc->'autoSendPending'\) = 'object'/);
  assert.match(q.text, /doc #>> '\{proactive,realmCheckAt\}' >= \$3/);
  assert.match(q.text, /coalesce\(doc->'deal', 'null'::jsonb\) in/);
  assert.deepEqual(q.params, ["L", 300, "2026-10-01T00:00:00.000Z"]);
  assert.doesNotMatch(pendingSendsQuery({ locationId: "L" }).text, /realmCheckAt/);
  const n = contactNamesQuery({ locationId: "L", ids: ["a", "b"] });
  assert.match(n.text, /from investors[\s\S]*union all[\s\S]*from contact_profiles[\s\S]*order by pri/);
  assert.deepEqual(n.params, ["L", ["a", "b"]]);
});
