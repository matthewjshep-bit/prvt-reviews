// dispo-own-words.test.mjs — a buyer's own words decide which deals they get.
//
// What went wrong (2026-11-09 audit): 26 deals since 10/21 went to buyers
// whose own buy box ruled them out. A Seattle city tag sent a Green Lake deal
// to a buyer who said "West Seattle"; a builder who said "no rehabs" got
// fixers; buyers who said "not buying right now" got them all. Find buyers on
// a deal dropped buyers who said "Eastside" from a Bellevue deal. And nobody
// could see who the rules left off.
//
//   node --test dispo-own-words.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dispo-own-words-test-"));
delete process.env.DATABASE_URL;

const { store } = await import("./store.js");
const { default: createDispoRouter } = await import("./routes/dispo.js");

// One app per location, so each test's book is its own.
function appFor(locationId, client = null) {
  const app = express();
  app.use(express.json());
  app.use("/api/dispo", createDispoRouter({ resolveLocation: () => ({ locationId, client }) }));
  const server = app.listen(0);
  return { base: `http://127.0.0.1:${server.address().port}/api/dispo`, close: () => server.close() };
}

const HOUR = 3600000;
const row = (contactId, doc = {}) => ({
  contactId, name: doc.name || contactId,
  doc: { name: doc.name || contactId, phone: "+12065550142", tags: ["investor"], custom: {}, ...doc },
  buyboxText: "",
});
const dealOffer = (locationId, address, deal = {}, over = {}) => store.createOffer({
  id: crypto.randomUUID(), locationId, contactId: "agent-x", address, cashAmount: 600000, status: "accepted", statusHistory: [],
  calc: { inputs: { arv: 900000, repairs: 60000 } },
  deal: { stage: "under_contract", investors: [], stageHistory: [], createdAt: new Date(Date.now() - 2 * HOUR).toISOString(), blasts: [], ...deal },
  ...over,
});

test("the wave preview says who was left off and why", async () => {
  const loc = "LOC-own-words-preview";
  const { base, close } = appFor(loc);
  try {
    await store.saveOfferSettings(loc, { dispoAutopilot: { autoBlastOnPromote: true } });
    const seattle = ["investor", "dispo-city-seattle", "dispo-region-seattle", "dispo-type-flip"];
    await store.upsertInvestors(loc, [
      row("west-seattle-only", { name: "Wren", tags: seattle, custom: { buybox_areas: "West Seattle only" } }),
      row("builder-no-rehabs", { name: "Bram", tags: seattle, custom: { buybox_exclusions: "land and teardowns, no rehabs" } }),
      row("not-buying", { name: "Odile", tags: seattle, custom: { buybox_exclusions: "not buying right now" } }),
      row("not-a-seattle-fan", { name: "Fenn", tags: seattle, custom: { buybox_areas: "Not a Seattle fan" } }),
      row("north-seattle", { name: "Nell", custom: { buybox_areas: "North Seattle" } }),
      row("seattle-flipper", { name: "Sid", tags: seattle }),
      row("tacoma-only", { name: "Tova", custom: { buybox_areas: "Tacoma" } }),
    ]);
    const offer = await dealOffer(loc, "4417 Linden Crest Ave N, Seattle, WA 98103");
    const r = await (await fetch(`${base}/waves/preview?offerId=${offer.id}`)).json();
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.wouldGet.map((i) => i.contactId).sort(), ["north-seattle", "seattle-flipper"], JSON.stringify(r.wouldGet));
    assert.deepEqual(Object.fromEntries(r.leftOff.map((i) => [i.contactId, i.why])), {
      "west-seattle-only": "their areas are elsewhere (West Seattle only)",
      "builder-no-rehabs": "they said no rehabs",
      "not-buying": "they're not buying right now",
      "not-a-seattle-fan": "they said not a Seattle fan",
    });
    assert.equal(r.leftOff.find((i) => i.contactId === "builder-no-rehabs").name, "Bram");
  } finally { close(); }
});

test("Find buyers keeps an Eastside buyer on a Bellevue deal", async () => {
  const loc = "LOC-own-words-match";
  const { base, close } = appFor(loc);
  try {
    await store.saveOfferSettings(loc, {});
    await store.upsertInvestors(loc, [
      row("eastside", { name: "Esme", custom: { buybox_areas: "Eastside" } }),
      row("king-county", { name: "Kip", custom: { buybox_areas: "King County" } }),
      row("tacoma", { name: "Tad", custom: { buybox_areas: "Tacoma" } }),
      row("eastside-paused", { name: "Pia", custom: { buybox_areas: "Eastside", buybox_exclusions: "on hold" } }),
    ]);
    const offer = await dealOffer(loc, "2210 Alder Run Pl NE, Bellevue, WA 98004");
    const r = await (await fetch(`${base}/match`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ offerId: offer.id }) })).json();
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.results.map((i) => i.contactId).sort(), ["eastside", "king-county"], JSON.stringify(r.results.map((i) => [i.contactId, i.match])));
  } finally { close(); }
});
