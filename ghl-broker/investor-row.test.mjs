// investor-row.test.mjs — the Dispositions list keeps up with what investors
// tell us, without anyone pressing Sync.
//
// What went wrong (2026-09-23): the bot read every investor's buy box out of
// their texts and filed it on the contact record and in GHL, but the
// searchable list is a cache that only a manual Sync rebuilt. It was ten days
// stale, 112 investors had talked to us since, and a search for "Tacoma"
// couldn't find the ones who had said Tacoma. And even right after a sync,
// search read GHL's fields while the AI ranking read the record, so the two
// could disagree about the same buyer.
//
//   node --test investor-row.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "investor-row-test-"));
delete process.env.DATABASE_URL;

const { store } = await import("./store.js");
const { learnFacts, forgetFact } = await import("./contact-record.js");
const { default: createDispoRouter } = await import("./routes/dispo.js");

const LOC = "LOC";
const app = express();
app.use(express.json());
app.use("/api/dispo", createDispoRouter({ resolveLocation: () => ({ locationId: LOC, client: null }) }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/dispo`;
test.after(() => server.close());

const get = async (p) => (await fetch(`${base}${p}`)).json();
const post = async (p, body) => (await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

// An investor as the last sync left them: tagged, nothing on file.
async function syncedInvestor(contactId, custom = {}) {
  await store.upsertInvestors(LOC, [{
    contactId, name: `Buyer ${contactId}`,
    doc: { name: `Buyer ${contactId}`, email: "", phone: "", tags: ["investor"], custom },
    buyboxText: "",
  }]);
  return (await store.getInvestor(LOC, contactId)).syncedAt;
}

const fromText = (key, value) => ({ key, value, source: "conversation", at: new Date().toISOString(), ref: "draft-1" });

test("a buy box an investor texts is in the Dispositions list without a sync", async () => {
  const syncedAt = await syncedInvestor("inv-text");
  // What applyProfileUpdates files when they text "Tacoma and Lakewood, flips up to 400k".
  await learnFacts({ store, locationId: LOC, contactId: "inv-text", party: "investor", facts: [
    fromText("buybox_areas", "Tacoma"), fromText("buybox_areas", "Lakewood"),
    fromText("buybox_price_max", "400000"), fromText("buybox_property_types", "sfr"),
  ] });

  const { investors, counts } = await get("/investors");
  const row = investors.find((i) => i.contactId === "inv-text");
  assert.deepEqual(row.buybox.areas, ["Tacoma", "Lakewood"]);
  assert.equal(row.buybox.priceMax, 400000);
  assert.deepEqual(row.buybox.propertyTypes, ["sfr"]);
  assert.ok(counts.documented >= 1);
  // The AI ranker reads the profile text; it has to say it too.
  assert.match((await store.getInvestor(LOC, "inv-text")).buyboxText, /Tacoma/);
  // "Last synced" still means the last time GHL was read, not the last text.
  assert.equal((await store.getInvestor(LOC, "inv-text")).syncedAt, syncedAt);
});

test("searching for an area finds the investor who texted it", async () => {
  await syncedInvestor("inv-search");
  await learnFacts({ store, locationId: LOC, contactId: "inv-search", party: "investor", facts: [fromText("buybox_areas", "Puyallup")] });
  const r = await post("/search", { parsed: { areas: ["Puyallup"] }, buyboxStatus: "documented" });
  assert.ok(r.results.some((x) => x.contactId === "inv-search"), "the Puyallup buyer is in the results");
});

test("what they told us wins over an older GHL field", async () => {
  await syncedInvestor("inv-newer", { buybox_price_max: "250000" });
  await learnFacts({ store, locationId: LOC, contactId: "inv-newer", party: "investor", facts: [fromText("buybox_price_max", "500000")] });
  const { investors } = await get("/investors");
  assert.equal(investors.find((i) => i.contactId === "inv-newer").buybox.priceMax, 500000);
});

test("an area removed in the drawer leaves the list too", async () => {
  await syncedInvestor("inv-forget");
  await learnFacts({ store, locationId: LOC, contactId: "inv-forget", party: "investor", facts: [fromText("buybox_areas", "Kent"), fromText("buybox_areas", "Auburn")] });
  await forgetFact({ store, locationId: LOC, contactId: "inv-forget", party: "investor", key: "buybox_areas", value: "Kent" });
  const { investors } = await get("/investors");
  assert.deepEqual(investors.find((i) => i.contactId === "inv-forget").buybox.areas, ["Auburn"]);
});

test("someone not in the book isn't added to it by a text", async () => {
  await learnFacts({ store, locationId: LOC, contactId: "not-tagged", party: "investor", facts: [fromText("buybox_areas", "Renton")] });
  assert.equal(await store.getInvestor(LOC, "not-tagged"), null);
});
