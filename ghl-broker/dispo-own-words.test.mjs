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

/* ---------- an agent who buys, into the buyer book (2026-11-09) ---------- */

// What went wrong: 70 agents told us they buy, flip or build, and none of
// them was ever in the buyer book; one was told we had nothing with three
// deals live. Matt's call (10/09) is that it takes his press, so the press
// is one button. Their own thread stays an agent's: the check-ins, the tiers
// and the bot keep treating them as the listing agent they are.

// A GHL stand-in: one contact, and every tag write it was asked for.
function ghlWith(contact) {
  const calls = [];
  return {
    calls,
    client: {
      async call(p, { method = "GET", body } = {}) {
        calls.push({ path: p, method, body });
        if (method === "GET" && p === `/contacts/${contact.id}`) return { contact };
        if (method === "POST" && p === `/contacts/${contact.id}/tags`) { contact.tags = [...contact.tags, ...body.tags]; return { tags: contact.tags }; }
        throw Object.assign(new Error(`unexpected GHL call ${method} ${p}`), { status: 404 });
      },
    },
  };
}
const post = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

test("pressing Add to buyers puts an agent in the buyer book and their own thread stays an agent's", async () => {
  const loc = "LOC-agent-buyer";
  const rory = { id: "agent-rory", firstName: "Rory", phone: "+12065550177", tags: ["agent"] };
  const ghl = ghlWith(rory);
  const { base, close } = appFor(loc, ghl.client);
  try {
    // Matt's saved Investor tags replace the defaults, so the new tag must join them.
    await store.saveOfferSettings(loc, { dispoTags: "investor, disposition-*", dispoAutopilot: { autoBlastOnPromote: true } });
    await store.upsertContactProfile(loc, "agent-rory", { party: "agent", name: "Rory", tags: ["agent"] });

    const r = await post(`${base}/investors/agent-rory/add-to-buyers`, { areas: "Tacoma, Puyallup" });
    assert.equal(r.ok, true, r.error);
    const tagWrites = ghl.calls.filter((c) => c.method === "POST");
    assert.deepEqual(tagWrites.map((c) => c.body.tags), [["dispo-agent-buyer"]]);
    assert.match((await store.getOfferSettings(loc)).dispoTags, /dispo-agent-buyer/);

    // In the book now, with the areas they named, and a Tacoma deal goes to them.
    const row = await store.getInvestor(loc, "agent-rory");
    assert.ok(row, "in the buyer book without waiting for a sync");
    const offer = await dealOffer(loc, "88 Quarry Bend Rd, Tacoma, WA 98404");
    const preview = await (await fetch(`${base}/waves/preview?offerId=${offer.id}`)).json();
    assert.deepEqual(preview.wouldGet.map((i) => [i.contactId, i.areaFit]), [["agent-rory", "said_city"]]);

    // Still an agent: the record, and their thread's party off their tags.
    assert.equal((await store.getContactProfile(loc, "agent-rory")).party, "agent");
    const { resolveParty } = await import("./conversation-party.js");
    const { normalizeConversationAi } = await import("./shared/conversation-ai.js");
    assert.deepEqual(rory.tags, ["agent", "dispo-agent-buyer"]);
    assert.equal(resolveParty({ tags: rory.tags, routing: normalizeConversationAi({}).routing }).party, "agent");

    // A deal text to them, a sync of the book and a buy-box edit all say
    // "investor"; none of them moves the record off "agent".
    const { recordEvent, reconcileFromGhl, learnFacts } = await import("./contact-record.js");
    await recordEvent({ store, locationId: loc, contactId: "agent-rory", party: "investor", type: "blast_sent", at: new Date().toISOString(), offerId: offer.id, address: offer.address, source: "blast", data: {} });
    await reconcileFromGhl({ store, locationId: loc, contactId: "agent-rory", party: "investor", contact: { id: "agent-rory", firstName: "Rory", tags: ["agent", "dispo-agent-buyer"] }, custom: {} });
    await learnFacts({ store, locationId: loc, contactId: "agent-rory", party: "investor", facts: [{ key: "buybox_areas", value: "Fife", source: "operator" }] });
    assert.equal((await store.getContactProfile(loc, "agent-rory")).party, "agent");
    assert.match((await store.getInvestor(loc, "agent-rory")).doc.record.buybox_areas, /Fife/, "the edit still reaches their row in the book");

    // Pressed twice: nothing new.
    const again = await post(`${base}/investors/agent-rory/add-to-buyers`, {});
    assert.equal(again.ok, true);
    assert.equal(ghl.calls.filter((c) => c.method === "POST").length, 1, "no second tag write");
  } finally { close(); }
});

test("when Matt's routing reads every dispo tag as a buyer, the agent is tagged agent too", async () => {
  const loc = "LOC-agent-buyer-routing";
  const ghl = ghlWith({ id: "agent-lux", firstName: "Lux", phone: "+12065550178", tags: [] });
  const { base, close } = appFor(loc, ghl.client);
  try {
    await store.saveOfferSettings(loc, { conversationAi: { routing: { agentTags: ["agent"], investorTags: ["investor", "dispo-*"] } } });
    await store.upsertContactProfile(loc, "agent-lux", { party: "agent", name: "Lux" });
    const r = await post(`${base}/investors/agent-lux/add-to-buyers`, {});
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(ghl.calls.filter((c) => c.method === "POST").map((c) => c.body.tags), [["dispo-agent-buyer", "agent"]]);
    assert.equal((await store.getOfferSettings(loc)).dispoTags, undefined, "no saved Investor tags: the default list has the tag");
  } finally { close(); }
});
