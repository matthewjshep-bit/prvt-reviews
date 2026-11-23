// lot-finder.test.mjs — the luxury teardown lane's day: off until switched
// on, a dry run that spends and writes nothing, the parcels pulled and the
// owners traced through stubbed APIs, imports dry until the broker allows
// them, the first text a draft until every switch is on, and a homeowner's
// reply held for Matt. Names, addresses and phones are made up.
//
//   node --test lot-finder.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lot-finder-test-"));
process.env.DATA_DIR = DIR;
delete process.env.DATABASE_URL;
delete process.env.OWNER_SMS_ENABLED;
delete process.env.OUTREACH_IMPORTS_ENABLED;

const { store } = await import("./store.js");
const { recordEvent } = await import("./contact-record.js");
const { runLotFinder, maybeRunLotFinder, getLotFinderJob, _resetJobs, CURSOR_NAME } = await import("./lot-finder.js");
const { handsOffReason } = await import("./reply-agent.js");
await store.init();
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

// Tuesday 2026-11-24, 10:05am Pacific.
const T0 = Date.parse("2026-11-24T18:05:00Z");
const pocket = { id: "clyde-hill", name: "Clyde Hill", address: "1 Lake Washington Blvd, Clyde Hill, WA", lat: 47.63, lng: -122.21, radiusMiles: 1, lotSqftMin: 30000, yearBuiltMax: 1980, yearsOwnedMin: 5, bandLo: 1900000, bandHi: 2300000, enabled: true };
const ON = (over = {}) => ({ compsApiKey: "rapi-key", tracerfyApiKey: "trace-key", conversationAi: { enabled: true },
  lotFinder: { enabled: true, dryRun: false, pockets: [pocket], ...over } });

const parcels = [
  { id: 1001, address: { street: "9 Lakeview Ln", city: "Clyde Hill", state: "WA", zip: "98004" }, owner1FirstName: "Pat", owner1LastName: "Example", yearBuilt: 1962, lotSquareFeet: 34000, squareFeet: 2300, lastSaleDate: "2009-05-01", lastSaleAmount: "900000" },
  { id: 1002, address: { street: "11 Lakeview Ln", city: "Clyde Hill", state: "WA", zip: "98004" }, companyName: "Lakeview Holdings LLC", yearBuilt: 1971, lotSquareFeet: 36000 },
  { id: 1003, address: { street: "4 Ridge Rd", city: "Clyde Hill", state: "WA", zip: "98004" }, owner1FirstName: "Sam", owner1LastName: "Sample", yearBuilt: 1968, lotSquareFeet: 31000 },
];
const calls = [];
const fetchStub = (phones) => async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url, body });
  if (/PropertySearch/.test(url)) {
    if (body.count) return { ok: true, status: 200, json: async () => ({ resultCount: parcels.length }) };
    return { ok: true, status: 200, json: async () => ({ resultCount: parcels.length, data: parcels }) };
  }
  if (/trace\/lookup/.test(url)) {
    const hit = phones[body.address];
    return { ok: true, status: 200, json: async () => (hit ? { hit: true, credits_deducted: 5, persons: [{ first_name: body.first_name || "Owner", litigator: false, phones: hit }] } : { hit: false, credits_deducted: 0, persons: [] }) };
  }
  throw new Error(`unexpected fetch ${url}`);
};
const PHONES = {
  "9 Lakeview Ln": [{ number: "2065550142", type: "Mobile", dnc: false, rank: 1 }],
  "4 Ridge Rd": [{ number: "4255550199", type: "Mobile", dnc: true, rank: 1 }, { number: "4255550100", type: "Landline", dnc: false, rank: 2 }],
};
const ghl = () => {
  const created = [];
  const tagged = [];
  return { created, tagged,
    deps: { getContact: async (id) => ({ id, phone: "+12065550142", tags: ["lot-owner"] }), findDuplicateContact: async () => null,
      createContact: async (body) => { created.push(body); return `c-${created.length}`; }, addContactTags: async (id, tags) => { tagged.push({ id, tags }); } } };
};

test("the finder is off until switched on, and off on a weekend", async () => {
  assert.equal(await maybeRunLotFinder({ client: {}, locationId: "L1", saved: {}, store, now: T0 }), false);
  assert.equal(await maybeRunLotFinder({ client: {}, locationId: "L1", saved: ON(), store, now: Date.parse("2026-11-28T18:05:00Z") }), false, "a Saturday");
  assert.equal(await maybeRunLotFinder({ client: {}, locationId: "L1", saved: ON({ pockets: [] }), store, now: T0 }), false, "no pockets, nothing to do");
});

test("a dry run counts the parcels, says who it would trace and text, and spends and writes nothing", async () => {
  calls.length = 0;
  const out = await runLotFinder({ client: {}, locationId: "L2", saved: ON({ dryRun: true }), store, deps: { fetch: fetchStub(PHONES) }, now: T0, dryRun: null });
  assert.equal(out.dryRun, true);
  assert.equal(out.pockets[0].parcels, 3);
  assert.ok(calls.every((c) => /PropertySearch/.test(c.url) && c.body.count === true), "only a count was asked for");
  assert.equal(out.traced.looked, 0);
  assert.deepEqual(await store.listLotOwners("L2"), []);
});

test("a live run pulls the parcels, traces the owners up to the cap, keeps only a cell that may be texted, and imports dry until the broker allows it", async () => {
  calls.length = 0;
  const g = ghl();
  const out = await runLotFinder({ client: {}, locationId: "L3", saved: ON({ traceDailyCap: 2 }), store, deps: { fetch: fetchStub(PHONES), ...g.deps }, now: T0 });
  assert.equal(out.pockets[0].pulled, true);
  assert.equal(out.pockets[0].created, 3);
  assert.equal(out.traced.looked, 2, "the day's cap");
  assert.equal(out.traced.credits, 10, "two hits at five credits each");
  const rows = await store.listLotOwners("L3");
  const pat = rows.find((r) => r.ownerKey === "rapi:1001");
  const sam = rows.find((r) => r.ownerKey === "rapi:1003");
  const llc = rows.find((r) => r.ownerKey === "rapi:1002");
  assert.equal(pat.status, "traced");
  assert.equal(pat.doc.phones[0].number, "+12065550142");
  assert.equal(sam.status, "no_phone", "a cell on the do-not-call list and a landline aren't reachable");
  assert.match(sam.doc.whyNoPhone, /do-not-call/);
  assert.equal(llc.status, "new", "the entity waits for tomorrow's cap: people first");
  assert.ok(calls.filter((c) => /trace/.test(c.url)).every((c) => c.body.find_owner === false && c.body.last_name), "people are looked up by name");
  assert.equal(out.imported.dry, true, "OUTREACH_IMPORTS_ENABLED is off");
  assert.equal(out.imported.would, 1);
  assert.equal(g.created.length, 0);
  const ownerDoc = JSON.stringify(out);
  assert.ok(!/Example|Lakeview|2065550142/.test(ownerDoc), "the summary carries keys and counts, never a name, an address or a phone");
});

test("with imports live, the owner goes into GHL tagged apart from agents and gets a first text that waits for Matt until every switch is on", async () => {
  process.env.OUTREACH_IMPORTS_ENABLED = "true";
  try {
    const g = ghl();
    const saved = ON({ traceDailyCap: 5, autoSend: true });
    const out = await runLotFinder({ client: {}, locationId: "L4", saved, store, sendsEnabled: true, deps: { fetch: fetchStub(PHONES), ...g.deps }, now: T0 });
    assert.equal(out.imported.created, 1);
    assert.equal(g.created[0].phone, "+12065550142");
    assert.equal(g.created[0].source, "lot-finder");
    assert.deepEqual(g.tagged[0].tags, ["lot-owner", "lot-pocket-clyde-hill"]);
    assert.equal(out.texts.drafted, 1, "autoSend is on and sends are live, but OWNER_SMS_ENABLED isn't");
    assert.equal(out.texts.scheduled, 0);
    const drafts = await store.listReplyDrafts("L4", { limit: 10 });
    const d = drafts.find((x) => x.outbound?.kind === "lot_owner_open");
    assert.ok(d, "the first text is a draft");
    assert.equal(d.status, "draft");
    assert.match(d.autoSend.reason, /OWNER_SMS_ENABLED/);
    assert.ok(d.reply.includes("9 Lakeview Ln") && d.reply.includes("1.9M") && d.reply.includes("2.3M"), d.reply);
    assert.doesNotMatch(d.reply, /[{}]/);
    assert.equal(d.party, "owner");
    // The next day, nothing more: the first text hasn't gone yet.
    const again = await runLotFinder({ client: {}, locationId: "L4", saved, store, sendsEnabled: true, deps: { fetch: fetchStub(PHONES), ...g.deps }, now: T0 + 86400000 });
    assert.equal(again.texts.drafted, 0);
    assert.ok(again.rows.some((r) => /hasn't gone yet/.test(r.waiting || "")));
  } finally { delete process.env.OUTREACH_IMPORTS_ENABLED; }
});

test("with OWNER_SMS_ENABLED on too, the first text schedules itself, and a reply from the owner is held for Matt", async () => {
  process.env.OUTREACH_IMPORTS_ENABLED = "true";
  process.env.OWNER_SMS_ENABLED = "true";
  try {
    const g = ghl();
    const out = await runLotFinder({ client: {}, locationId: "L5", saved: ON({ traceDailyCap: 5, autoSend: true }), store, sendsEnabled: true, deps: { fetch: fetchStub(PHONES), ...g.deps }, now: T0 });
    assert.equal(out.texts.scheduled, 1);
    const d = (await store.listReplyDrafts("L5", { limit: 10 })).find((x) => x.outbound?.kind === "lot_owner_open");
    assert.equal(d.status, "scheduled");
    assert.ok(d.sendAt);
  } finally { delete process.env.OUTREACH_IMPORTS_ENABLED; delete process.env.OWNER_SMS_ENABLED; }
  assert.match(handsOffReason({ lotOwner: true }), /homeowner on a luxury lot — yours to call/);
  assert.equal(handsOffReason({ lotOwner: false, gatekeeper: false }), "");
});

test("switched on, it runs once a weekday morning and writes the cursor before it runs", async () => {
  _resetJobs();
  const saved = ON({ dryRun: true });
  assert.equal(await maybeRunLotFinder({ client: {}, locationId: "L6", saved, store, deps: { fetch: fetchStub(PHONES) }, now: T0 }), true);
  const cur = await store.getJobCursor("L6", CURSOR_NAME);
  assert.equal(cur.doc.tries, 1);
  assert.ok(cur.doc.lastDaily);
  await getLotFinderJob("L6").done;
  assert.equal(await maybeRunLotFinder({ client: {}, locationId: "L6", saved, store, now: T0 + 3600000 }), false, "once a day");
  assert.equal(await maybeRunLotFinder({ client: {}, locationId: "L6", saved, store, now: Date.parse("2026-11-24T22:05:00Z") }), false, "not at 2pm either");
});

test("a reply event from an owner stops the follow-up", async () => {
  const at = new Date(T0).toISOString();
  await recordEvent({ store, locationId: "L7", contactId: "c-owner", party: "owner", type: "import", at, source: "lot-finder" });
  await recordEvent({ store, locationId: "L7", contactId: "c-owner", party: "owner", type: "lot_owner_queued", at, source: "lot-finder", data: { step: "open" } });
  await recordEvent({ store, locationId: "L7", contactId: "c-owner", party: "owner", type: "lot_owner_sent", at, source: "conversation", data: { step: "open" } });
  await recordEvent({ store, locationId: "L7", contactId: "c-owner", party: "owner", type: "lot_owner_replied", at: new Date(T0 + 3600000).toISOString(), source: "conversation" });
  const events = await store.listContactEvents("L7", "c-owner", { limit: 50 });
  const { nextOwnerStep } = await import("./shared/lot-finder.js");
  assert.match(nextOwnerStep({ events, now: T0 + 3 * 86400000 }).stop, /yours to call/);
});
