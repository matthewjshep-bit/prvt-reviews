// offer-update.test.mjs — saving an existing offer in place.
// Run with:  npm run test:offer-update
//
// The bug this exists to prevent: reopening an offer and pressing the save
// button used to mint a SECOND offer row, so revising your number three times
// left four offers on one property. So the assertions that matter most here are
// the boring ones — the row count doesn't move, the id doesn't move, and the
// lifecycle (status, sends, the signed paperwork, the deal) survives a save
// that rewrites the money.
//
// Runs against the JSON file backend in a throwaway temp directory, with
// cardgen and GHL stubbed. Both stubs record what they were asked for, because
// "which documents got re-rendered" and "what reached the CRM" are behaviour.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "offer-update-test-"));

const { default: express } = await import("express");

// --- stub cardgen: a real 1x1 JPEG, because jpegToPdf parses the header ---
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
  "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64"
);
let renders = 0;
const cardgen = express();
cardgen.use(express.json({ limit: "30mb" }));
cardgen.post("/render", (_req, res) => { renders++; res.type("image/jpeg").send(JPEG); });
const cardServer = cardgen.listen(0);
// Read once at module load in routes/offers.js — must be set before the import.
process.env.CARD_SERVICE_URL = `http://127.0.0.1:${cardServer.address().port}`;

const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");

const LOC = "loc-offer-update-test";
const OTHER = "loc-someone-else";

// --- stub GHL: records every call, answers the shapes ghl.js unwraps ---
let calls = [];
const client = {
  call: async (p, opts = {}) => {
    const method = opts.method || "GET";
    calls.push({ path: p, method, body: opts.body });
    if (p.includes("/customFields") && method === "GET") return { customFields: [] };
    // Name the id after the field, so a test can tell the offer fields apart
    // from the deal-history ledger — both land as updateContact PUTs.
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
  resolveLocation: (req) => {
    const loc = req.query.location_id || req.body?.location_id || LOC;
    return { locationId: loc, client };
  },
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

const INPUTS = { address: "7316 166th Ave E, Sumner, WA 98390", arv: 520000, repairs: 62000, askingPrice: 499000 };
const SETTINGS = { wholesaleFee: 15000, validityDays: 7, company: { name: "Shep Flips" } };

// A created offer, made the way the app makes one, so every field the update
// path has to preserve is genuinely there.
async function seedOffer(over = {}) {
  calls = [];
  const r = await req("POST", "/api/offers", {
    location_id: LOC, contactId: "contact-1",
    inputs: INPUTS, settings: SETTINGS,
    scope: [{ label: "Roof", cost: 14500 }],
    snapshot: { inputs: INPUTS, comps: { selected: ["c1"], result: { comps: [{ id: "c1", address: "7402 168th Ave E", price: 540000, sqft: 1900 }] } } },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
  const offer = await store.getOffer(r.json.offer.id);
  Object.assign(offer, over);
  await store.updateOffer(offer.id, offer);
  return await store.getOffer(offer.id);
}

const WORKSPACE = {
  inputs: INPUTS,
  comps: { selected: ["c1"], result: { comps: [{ id: "c1", address: "7402 168th Ave E", price: 540000, sqft: 1900 }] } },
};
const save = (id, over = {}) => req("PUT", `/api/offers/${id}`, {
  location_id: LOC, inputs: INPUTS, settings: SETTINGS, scope: [{ label: "Roof", cost: 14500 }],
  snapshot: WORKSPACE, ...over,
});

test("a save keeps the same offer — same id, same row, same creation date", async () => {
  const before = await seedOffer();
  const count = (await store.listOffers(LOC, { limit: 500 })).length;

  const r = await save(before.id, { inputs: { ...INPUTS, arv: 560000 } });
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));

  const after = await store.getOffer(before.id);
  assert.equal(after.id, before.id);
  assert.equal(after.createdAt, before.createdAt);
  assert.equal((await store.listOffers(LOC, { limit: 500 })).length, count, "a save must not mint a second offer");
  assert.ok(after.cashAmount > before.cashAmount, `${before.cashAmount} → ${after.cashAmount}`);
  assert.equal(after.calc.inputs.arv, 560000);
});

test("the documents are re-rendered under the same key, and versioned so nobody is served the old one", async () => {
  const before = await seedOffer();
  renders = 0;

  await save(before.id, { inputs: { ...INPUTS, arv: 545000 } });
  const after = await store.getOffer(before.id);

  assert.ok(renders > 0, "the letter should have been re-rendered");
  // Same key, so whoever holds the link gets the new letter rather than a
  // second file appearing beside the old one.
  assert.ok(after.pdfUrl.startsWith(`http://127.0.0.1:4996/api/offers/${before.id}/doc.pdf`),
    `same document path: ${after.pdfUrl}`);
  assert.ok((await store.getOfferDoc(before.id, "pdf"))?.bytes?.length, "and the bytes are still there");
  // The doc routes serve immutable/max-age=1y, so without this the revision is
  // invisible to anyone who already opened the old one.
  assert.match(after.pdfUrl, /\?v=\d+$/, "immutable caching means a revision must version the URL");
  assert.match(after.imageUrl, /\?v=\d+$/);
  assert.match(after.compsPdfUrl, /\?v=\d+$/);
});

test("a companion document the save no longer supports is dropped, not left stale", async () => {
  const before = await seedOffer();
  assert.ok(before.compsPdfUrl && before.scopePdfUrl, "seed sanity");
  // No comps ticked, no rehab scope: the analysis and the SOW have nothing to
  // describe any more. Keeping the old URLs would publish documents that
  // contradict the offer they hang off.
  await save(before.id, { snapshot: { inputs: INPUTS }, scope: [] });
  const after = await store.getOffer(before.id);
  assert.equal(after.compsPdfUrl, null);
  assert.equal(after.scopePdfUrl, null);
  assert.deepEqual(after.scope, []);
});

test("the offer's whole life survives the save", async () => {
  const before = await seedOffer({
    status: "sent",
    statusAt: "2026-08-01T00:00:00.000Z",
    statusHistory: [{ status: "new", ts: "2026-07-30T00:00:00.000Z" }, { status: "sent", ts: "2026-08-01T00:00:00.000Z" }],
    sends: [{ ts: "2026-08-01T00:00:00.000Z", channel: "sms", results: { pdf: { ok: true } } }],
    psa: { fields: { price: 450000 }, generatedAt: "2026-08-01T00:00:00.000Z" },
    psaPdfUrl: "http://example.invalid/psa.pdf",
    contract: { fields: { price: 450000 } },
    contractPdfUrl: "http://example.invalid/contract.pdf",
    assignmentPdfUrl: "http://example.invalid/assignment.pdf",
    autoUnderwrite: { startedAt: "2026-07-30T00:00:00.000Z" },
    deal: { stage: "under_contract", contractPrice: 430000, assignmentFee: 27500, investors: [], stageHistory: [] },
  });

  const r = await save(before.id, { inputs: { ...INPUTS, arv: 600000 } });
  assert.equal(r.status, 200);
  const after = await store.getOffer(before.id);

  assert.equal(after.status, "sent", "a save is not an outcome — it must not touch the status");
  assert.deepEqual(after.statusHistory, before.statusHistory);
  assert.deepEqual(after.sends, before.sends);
  assert.deepEqual(after.psa, before.psa);
  assert.equal(after.psaPdfUrl, before.psaPdfUrl);
  assert.equal(after.contractPdfUrl, before.contractPdfUrl);
  assert.equal(after.assignmentPdfUrl, before.assignmentPdfUrl);
  assert.deepEqual(after.autoUnderwrite, before.autoUnderwrite);
  assert.deepEqual(after.deal, before.deal, "the deal owns its contract price — a revised offer never moves it");
  assert.equal(r.json.revisedAfterSend, true, "the client has to be able to warn before replacing a sent document");
});

test("signable paperwork that no longer matches is reported, never silently regenerated", async () => {
  const before = await seedOffer({
    psa: { fields: { price: 450000 } }, psaPdfUrl: "http://example.invalid/psa.pdf",
  });
  const r = await save(before.id, { inputs: { ...INPUTS, arv: 610000 } });
  assert.ok(r.json.staleDocs.includes("purchase & sale agreement"), JSON.stringify(r.json.staleDocs));
  assert.ok(r.json.warnings.some((w) => /still quotes the old price/.test(w)), JSON.stringify(r.json.warnings));
  const after = await store.getOffer(before.id);
  assert.deepEqual(after.psa.fields, { price: 450000 }, "a signed agreement is never rewritten behind the operator");
});

test("a revision records what moved, and re-dates its own expiry", async () => {
  const before = await seedOffer();
  await save(before.id, { inputs: { ...INPUTS, arv: 570000 } });
  const after = await store.getOffer(before.id);

  assert.equal(after.revisions.length, 1);
  assert.equal(after.revisions[0].from, Math.round(before.cashAmount));
  assert.equal(after.revisions[0].to, after.cashAmount);
  // The letter prints a fresh "valid through", so the stored expiry has to move
  // with it — deriving it from createdAt would expire the offer early.
  assert.ok(after.expiresAt, "a revised offer carries its own expiry");
  assert.ok(Date.parse(after.expiresAt) > Date.parse(before.createdAt));
  assert.ok(Date.parse(after.updatedAt) >= Date.parse(before.createdAt));
});

test("the CRM hears about a new number, and nothing else", async () => {
  const before = await seedOffer();

  calls = [];
  await save(before.id);                                     // same numbers
  const quiet = calls.filter((c) => c.method === "PUT" && JSON.stringify(c.body || {}).includes("we "));
  assert.equal(quiet.length, 0, "re-saving the same offer must not write a ledger line");
  assert.equal(calls.filter((c) => /\/notes$/.test(c.path)).length, 0, "notes are append-only — never re-note");
  assert.equal(calls.filter((c) => /\/tags$/.test(c.path)).length, 0, "the contact is already tagged");

  calls = [];
  await save(before.id, { inputs: { ...INPUTS, arv: 620000 } }); // moved
  const ledger = calls.filter((c) => JSON.stringify(c.body || {}).includes("we revised our offer to"));
  assert.equal(ledger.length, 1, JSON.stringify(calls.map((c) => c.path)));
  assert.ok(calls.some((c) => JSON.stringify(c.body || {}).includes("cf-last-offer-amount")),
    "the contact's offer fields are refreshed");
});

test("revising an older offer doesn't drag the agent's last-offer fields backwards", async () => {
  const older = await seedOffer();
  // A newer offer for the same agent, on another property.
  await seedOffer();

  calls = [];
  const r = await save(older.id, { inputs: { ...INPUTS, arv: 500000 } });
  assert.equal(r.status, 200);
  assert.ok(r.json.warnings.some((w) => /newer offer for this agent/.test(w)), JSON.stringify(r.json.warnings));
  assert.equal(calls.filter((c) => JSON.stringify(c.body || {}).includes("cf-last-offer-amount")).length, 0,
    "the newer offer keeps the fields");
  assert.ok(calls.some((c) => JSON.stringify(c.body || {}).includes("we revised our offer to")),
    "the ledger still records the new number — it is per-property, not per-contact");
});

test("a workspace that didn't fit never eats the one already saved", async () => {
  const before = await seedOffer();
  assert.ok(before.snapshot?.comps, "seed sanity");
  const r = await save(before.id, { snapshot: null });
  assert.equal(r.status, 200);
  const after = await store.getOffer(before.id);
  assert.deepEqual(after.snapshot, before.snapshot);
  assert.ok(r.json.warnings.some((w) => /kept the comps/.test(w)), JSON.stringify(r.json.warnings));
});

test("what a save refuses", async () => {
  const offer = await seedOffer();

  const draft = await store.createOffer({ locationId: LOC, status: "draft", draft: { inputs: INPUTS } });
  assert.equal((await save(draft.id)).status, 400, "a draft keeps its own save path");

  const theirs = await store.createOffer({ locationId: OTHER, status: "new", address: "elsewhere" });
  assert.equal((await save(theirs.id)).status, 404, "another location's offer is invisible, not forbidden");

  const swapped = await save(offer.id, { contactId: "contact-2" });
  assert.equal(swapped.status, 400, "writing this offer for someone else is what Save as new offer is for");

  const empty = await req("PUT", `/api/offers/${offer.id}`, { location_id: LOC });
  assert.equal(empty.status, 400);
});

test("autosave writes the workspace and only the workspace", async () => {
  const before = await seedOffer();
  const count = (await store.listOffers(LOC, { limit: 500 })).length;
  renders = 0;
  calls = [];

  const r = await req("PATCH", `/api/offers/${before.id}/workspace`, {
    location_id: LOC,
    snapshot: { inputs: INPUTS, comps: { captured: [{ id: "z1", address: "Off Zillow", price: 511000 }], selected: ["z1"] } },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));

  const after = await store.getOffer(before.id);
  assert.equal(after.snapshot.comps.captured[0].id, "z1");
  assert.equal(after.cashAmount, before.cashAmount, "autosave must never move the money");
  assert.equal(after.pdfUrl, before.pdfUrl, "…nor re-render a document");
  assert.deepEqual(after.calc, before.calc);
  assert.equal(after.status, before.status);
  assert.equal(renders, 0);
  assert.equal(calls.length, 0, "autosave never touches the CRM");
  assert.equal((await store.listOffers(LOC, { limit: 500 })).length, count,
    "this is the whole point: touching comps on an open offer mints no draft row");
});

test("autosave is allowed on a deal, refused for a draft, and scoped to the location", async () => {
  const onDeal = await seedOffer({ deal: { stage: "under_contract", investors: [], stageHistory: [] } });
  const ok = await req("PATCH", `/api/offers/${onDeal.id}/workspace`, { location_id: LOC, snapshot: { inputs: INPUTS } });
  assert.equal(ok.status, 200, "losing read-and-delete comps is worse than a stale workspace on a deal");

  const draft = await store.createOffer({ locationId: LOC, status: "draft", draft: {} });
  assert.equal((await req("PATCH", `/api/offers/${draft.id}/workspace`, { location_id: LOC, snapshot: { inputs: INPUTS } })).status, 400);

  const theirs = await store.createOffer({ locationId: OTHER, status: "new" });
  assert.equal((await req("PATCH", `/api/offers/${theirs.id}/workspace`, { location_id: LOC, snapshot: { inputs: INPUTS } })).status, 404);

  const offer = await seedOffer();
  assert.equal((await req("PATCH", `/api/offers/${offer.id}/workspace`, { location_id: LOC })).status, 400);
});

test("the agent's own page follows the offer; investor rooms are told they're behind", async () => {
  const offer = await seedOffer();
  const { buildOfferSnapshot } = await import("./offer-page.js");
  const { buildSnapshot } = await import("./dataroom.js");

  const pageRoom = await store.createDataroom({
    locationId: LOC, offerId: offer.id, address: offer.address, status: "active", kind: "offer",
    snapshot: { ...buildOfferSnapshot({ offer, settings: SETTINGS }), headline: "Cash, 10 days" },
  });
  const investorRoom = await store.createDataroom({
    locationId: LOC, offerId: offer.id, address: offer.address, status: "active",
    snapshot: buildSnapshot({ offer, settings: SETTINGS }),
  });

  const r = await save(offer.id, { inputs: { ...INPUTS, arv: 640000 } });
  assert.equal(r.status, 200);
  const revised = await store.getOffer(offer.id);

  const freshPage = await store.getDataroom(pageRoom.id);
  assert.equal(freshPage.snapshot.offer.amount, revised.cashAmount,
    "the page publishes the regenerated PDF — it can't keep printing the old price above it");
  assert.equal(freshPage.snapshot.headline, "Cash, 10 days", "the operator's own words survive the refresh");

  const freshRoom = await store.getDataroom(investorRoom.id);
  assert.equal(freshRoom.snapshot.numbers.contractPrice, revised.cashAmount, "the investor price follows too");
  assert.ok(r.json.warnings.some((w) => /investor dataroom/.test(w)), JSON.stringify(r.json.warnings));
});

test("the bulk status route still answers after the new ones were registered", async () => {
  const offer = await seedOffer();
  const r = await req("PATCH", "/api/offers/status", { location_id: LOC, ids: [offer.id], status: "passed" });
  assert.equal(r.status, 200);
  assert.equal(r.json.results[0].ok, true, JSON.stringify(r.json));
});

// The temp dir is left for the OS to reap: the store's persist() is debounced,
// so deleting it here just races a pending write and logs a scary line.
test.after(() => { server.close(); cardServer.close(); });
