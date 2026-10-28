// offer-autosave.test.mjs — the editor saves as you type, one row per house.
// Run with:  node --test offer-autosave.test.mjs
//
// What went wrong (2026-10-23): the editor had five save buttons — Save
// draft, Update draft, Create offer, Save changes, Save as new offer — and
// every blank "New offer" minted a fresh row, so one address collected a
// draft, an offer and a second draft. Matt: whatever I type saves, Send moves
// the status, and there is one record per house.
//
// So the assertions that matter are the row count and the id: a second New
// offer on a house opens the first, sending a draft turns that same row into
// the offer, and typing on an offer that's out doesn't write a history line
// per pause.
//
// JSON file backend in a throwaway temp dir, cardgen and GHL stubbed, as in
// offer-update.test.mjs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "offer-autosave-test-"));

const { default: express } = await import("express");

const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
  "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64"
);
const cardgen = express();
cardgen.use(express.json({ limit: "30mb" }));
cardgen.post("/render", (_req, res) => { res.type("image/jpeg").send(JPEG); });
const cardServer = cardgen.listen(0);
process.env.CARD_SERVICE_URL = `http://127.0.0.1:${cardServer.address().port}`;

const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");

const LOC = "loc-offer-autosave-test";

let calls = [];
const client = {
  call: async (p, opts = {}) => {
    const method = opts.method || "GET";
    calls.push({ path: p, method, body: opts.body });
    if (p.includes("/customFields") && method === "GET") return { customFields: [] };
    if (p.includes("/customFields") && method === "POST") {
      return { customField: { id: `cf-${String(opts.body?.name || "x").toLowerCase().replace(/[^a-z]+/g, "-")}` } };
    }
    if (/^\/contacts\/[^/]+$/.test(p) && method === "GET") {
      return { contact: { id: "contact-1", firstName: "Dana", lastName: "Reyes", customFields: [] } };
    }
    return {};
  },
};

const app = express();
app.use(express.json({ limit: "30mb" }));
app.use("/api/offers", createOffersRouter({
  resolveLocation: () => ({ locationId: LOC, client }),
  uploadDir: process.env.DATA_DIR,
  publicBaseUrl: "http://127.0.0.1:4996",
}));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();

const req = async (method, p, body) => {
  const r = await fetch(B + p, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

const SETTINGS = { wholesaleFee: 15000, validityDays: 7, company: { name: "Shep Flips" } };
const inputsAt = (address, over = {}) => ({ address, arv: 520000, repairs: 62000, askingPrice: 499000, ...over });
const rowCount = async () => (await store.listOffers(LOC, { limit: 500 })).length;
const draftBody = (address, over = {}) => ({
  draft: { inputs: inputsAt(address), contact: { id: "contact-1", name: "Dana Reyes" }, settings: SETTINGS, ...over },
});
const notesWritten = () => calls.filter((c) => c.method === "POST" && /\/contacts\/contact-1\/notes/.test(c.path)).length;
const historyWrites = () => calls.filter((c) => c.method === "PUT" && /^\/contacts\/contact-1$/.test(c.path)
  && (c.body?.customFields || []).some((f) => /history/.test(f.id))).length;

test("a second New offer on the same house opens the first one instead of adding a row", async () => {
  const first = await req("POST", "/api/offers/draft", draftBody("4410 N Mullen St, Tacoma, WA 98407"));
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.ok(!first.json.reused, "the first save makes the row");
  const before = await rowCount();

  // Same house, written the short way, from a blank form (no id).
  const again = await req("POST", "/api/offers/draft", draftBody("4410 North Mullen Street"));
  assert.equal(again.status, 200);
  assert.equal(again.json.reused, true, "the editor is told to open the row that's there");
  assert.equal(again.json.offer.id, first.json.offer.id);
  assert.equal(await rowCount(), before, "no second row on one house");
  // The row that was there is not overwritten by the blank form.
  assert.equal((await store.getOffer(first.json.offer.id)).address, "4410 N Mullen St, Tacoma, WA 98407");
  // The GHL shorthand field leaves the suffix off; it's still the house.
  const short = await req("POST", "/api/offers/draft", draftBody("4410 N Mullen"));
  assert.equal(short.json.offer.id, first.json.offer.id);
  // A different number on the same street is a different house.
  const next = await req("POST", "/api/offers/draft", draftBody("4412 N Mullen St, Tacoma, WA 98407"));
  assert.ok(!next.json.reused);
});

test("a New offer on a house that already has a sent offer opens that offer", async () => {
  const made = await req("POST", "/api/offers", { contactId: "contact-1", inputs: inputsAt("918 S Ainsworth Ave, Tacoma, WA 98405"), settings: SETTINGS });
  assert.equal(made.status, 200, JSON.stringify(made.json).slice(0, 300));
  const before = await rowCount();
  const r = await req("POST", "/api/offers/draft", draftBody("918 S Ainsworth Ave"));
  assert.equal(r.json.reused, true);
  assert.equal(r.json.offer.id, made.json.offer.id);
  assert.equal(await rowCount(), before);
});

test("retyping a draft's address onto a house that has a row moves you there and drops the stray draft", async () => {
  const kept = await req("POST", "/api/offers/draft", draftBody("2201 E Fir St, Tacoma, WA 98404"));
  const stray = await req("POST", "/api/offers/draft", draftBody("2201 E Fur St, Tacoma, WA 98404"));
  assert.ok(!stray.json.reused);
  const before = await rowCount();
  const r = await req("POST", "/api/offers/draft", { id: stray.json.offer.id, ...draftBody("2201 E Fir St, Tacoma, WA 98404") });
  assert.equal(r.json.reused, true);
  assert.equal(r.json.offer.id, kept.json.offer.id);
  assert.equal(await store.getOffer(stray.json.offer.id), null, "the half-typed draft goes away");
  assert.equal(await rowCount(), before - 1);
});

// What went wrong (2026-10-28, a Tacoma house): two held auto-underwrites on
// one house for one agent. Every pause in typing saved, the broker answered
// "open the other one" without saving, and the editor reopened on that row's
// copy — so whatever was typed cleared, then the next save bounced back.
// Comps grabbed off Zillow went the same way.
test("typing in a draft on a house that has a second row saves what you typed instead of swapping rows", async () => {
  const house = "6614 S Birch St, Tacoma, WA 98409";
  const held = (n) => store.createOffer({
    locationId: LOC, status: "draft", autoUnderwrite: true, contactId: "contact-1", contactName: "Dana Reyes",
    address: house, draft: { inputs: inputsAt(house, { arv: 400000 + n }), contact: { id: "contact-1", name: "Dana Reyes" } },
    updatedAt: new Date(Date.now() - n * 1000).toISOString(),
  });
  const a = await held(1);
  const b = await held(2);
  const before = await rowCount();

  const typed = draftBody(house, { inputs: inputsAt(house, { arv: 455000 }) });
  const r = await req("POST", "/api/offers/draft", { id: b.id, ...typed });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(!r.json.reused, "the form stays on the row you're typing in");
  assert.equal(r.json.offer.id, b.id);
  assert.equal((await store.getOffer(b.id)).draft.inputs.arv, 455000, "what you typed is saved");
  assert.equal(r.json.houseRow?.id, a.id, "the other row is named, so the editor can offer to open it");
  assert.equal(await rowCount(), before, "nothing is deleted");

  // A plain draft beside a sent offer on the same house saves too.
  const sent = await req("POST", "/api/offers", { contactId: "contact-1", inputs: inputsAt("31 Elm Ct, Fife, WA 98424"), settings: SETTINGS });
  const mine = await store.createOffer({
    locationId: LOC, status: "draft", contactId: "contact-1", address: "31 Elm Ct, Fife, WA 98424",
    draft: { inputs: inputsAt("31 Elm Ct, Fife, WA 98424"), contact: { id: "contact-1", name: "Dana Reyes" } },
  });
  const r2 = await req("POST", "/api/offers/draft", { id: mine.id, ...draftBody("31 Elm Ct, Fife, WA 98424", { inputs: inputsAt("31 Elm Ct, Fife, WA 98424", { repairs: 81000 }) }) });
  assert.equal(r2.json.offer.id, mine.id);
  assert.equal((await store.getOffer(mine.id)).draft.inputs.repairs, 81000);
  assert.equal(r2.json.houseRow?.id, sent.json.offer.id);
});

// The same day, the other half: a New offer on a house the agent already had
// a row on. The first save with numbers in it was answered with that row,
// and the editor reopened there — the numbers you'd typed, gone.
test("numbers typed into a new offer on a house that already has a row are saved, not cleared", async () => {
  const house = "6620 S Birch St, Tacoma, WA 98409";
  const there = await store.createOffer({
    locationId: LOC, status: "draft", autoUnderwrite: true, contactId: "contact-1", address: house,
    draft: { inputs: inputsAt(house), contact: { id: "contact-1", name: "Dana Reyes" } },
  });
  const before = await rowCount();
  const r = await req("POST", "/api/offers/draft", { keep: true, ...draftBody(house, { inputs: inputsAt(house, { arv: 610000 }) }) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(!r.json.reused, "the form keeps what's on it");
  assert.notEqual(r.json.offer.id, there.id, "the row that was there isn't written over");
  assert.equal((await store.getOffer(r.json.offer.id)).draft.inputs.arv, 610000);
  assert.equal(r.json.houseRow?.id, there.id, "the other row is named, so the editor can offer to open it");
  assert.equal(await rowCount(), before + 1);
  assert.equal((await store.getOffer(there.id)).draft.inputs.arv, 520000);
});

test("another agent's offer on the same house is theirs, not this one", async () => {
  await req("POST", "/api/offers/draft", draftBody("77 Pine Ln, Puyallup, WA 98371"));
  const r = await req("POST", "/api/offers/draft", { draft: { inputs: inputsAt("77 Pine Ln, Puyallup, WA 98371"), contact: { id: "contact-2", name: "Lee" } } });
  assert.ok(!r.json.reused, "a different agent gets their own row");
});

test("sending a draft keeps its id and makes it an offer once", async () => {
  const d = await req("POST", "/api/offers/draft", draftBody("5605 S Puget Sound Ave, Tacoma, WA 98409"));
  const id = d.json.offer.id;
  const before = await rowCount();
  calls = [];

  const form = { contactId: "contact-1", inputs: inputsAt("5605 S Puget Sound Ave, Tacoma, WA 98409"), settings: SETTINGS };
  const r = await req("POST", `/api/offers/${id}/publish`, { form });
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
  assert.equal(r.json.offer.id, id, "the draft becomes the offer — same id");
  assert.equal(await rowCount(), before, "no second row");

  const after = await store.getOffer(id);
  assert.equal(after.status, "new");
  assert.ok(after.pdfUrl, "it has paper now");
  assert.equal(after.createdAt, (await store.getOffer(id)).createdAt);
  assert.equal(after.statusHistory.at(-1).status, "new");
  assert.equal(notesWritten(), 1, "one contact note, as a create writes");
  assert.equal(after.draft, undefined, "the form lives in the snapshot from here, not a draft copy");

  // Pressing Send again on the same row must not note the contact twice.
  const twice = await req("POST", `/api/offers/${id}/publish`, { form });
  assert.equal(twice.status, 409);
  assert.equal(notesWritten(), 1);
});

test("a held draft goes to the bot only when you say so", async () => {
  const held = async (address) => {
    const d = await req("POST", "/api/offers/draft", draftBody(address));
    const row = await store.getOffer(d.json.offer.id);
    row.autoUnderwrite = { startedAt: "2026-10-22T16:00:00.000Z", held: ["comps thin"] };
    await store.updateOffer(row.id, row);
    return row.id;
  };
  const form = (address) => ({ contactId: "contact-1", inputs: inputsAt(address), settings: SETTINGS });

  const mine = await held("3110 N 27th St, Tacoma, WA 98407");
  await req("POST", `/api/offers/${mine}/publish`, { form: form("3110 N 27th St, Tacoma, WA 98407") });
  const sentByMe = await store.getOffer(mine);
  assert.equal(sentByMe.handedToBotAt, undefined, "Send is you sending it; the bot doesn't also float it");
  assert.ok(sentByMe.autoUnderwrite.publishedAt, "the 24h dedupe still knows the house");
  assert.equal(sentByMe.autoUnderwrite.startedAt, "2026-10-22T16:00:00.000Z", "the run's provenance stays");

  const theirs = await held("1702 S 56th St, Tacoma, WA 98408");
  await req("POST", `/api/offers/${theirs}/publish`, { form: form("1702 S 56th St, Tacoma, WA 98408"), handToBot: true });
  const handed = await store.getOffer(theirs);
  assert.ok(handed.handedToBotAt, "Let the bot take it hands it over");
  assert.equal(handed.approved?.by, "publish");
});

test("typing on a sent offer writes one history line, not one per pause", async () => {
  const made = await req("POST", "/api/offers", { contactId: "contact-1", inputs: inputsAt("6012 N 46th St, Tacoma, WA 98407"), settings: SETTINGS });
  const id = made.json.offer.id;
  const row = await store.getOffer(id);
  row.status = "sent";
  row.sends = [{ ts: new Date().toISOString(), channel: "sms" }];
  await store.updateOffer(id, row);

  const live = (arv, over = {}) => req("PUT", `/api/offers/${id}`, {
    contactId: "contact-1", inputs: inputsAt("6012 N 46th St, Tacoma, WA 98407", { arv }), settings: SETTINGS, live: true, ...over,
  });
  calls = [];
  const first = await live(560000);
  assert.equal(first.status, 200);
  assert.equal(first.json.historyBehind, false);
  assert.equal((await live(565000)).status, 200);
  const third = await live(570000);
  assert.equal(third.json.historyBehind, true, "the editor learns the ledger is a number behind");
  assert.equal(historyWrites(), 1, "the first move is written; the next pauses are the same edit");

  const after = await store.getOffer(id);
  assert.equal(after.revisions.length, 1, "one revision for one sitting");
  assert.equal(after.revisions[0].from, made.json.offer.cashAmount, "it starts from the number before you began");
  assert.equal(after.revisions[0].to, after.cashAmount, "and ends at where you stopped");
  assert.ok(after.pdfUrl.includes("?v="), "the agent's link carries the new letter right away");

  // Leaving the editor writes where you stopped, if the ledger is behind.
  await live(575000, { final: true });
  assert.equal(historyWrites(), 2);
  await live(575000, { final: true });
  assert.equal(historyWrites(), 2, "nothing moved, nothing written");
});

test.after(() => { server.close(); cardServer.close(); });
