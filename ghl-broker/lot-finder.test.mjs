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
    assert.ok(d.reply.includes("9 Lakeview Ln") && d.reply.includes("Clyde Hill") && !/\d\.\dM/.test(d.reply), d.reply);
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
  // The bot answers an owner with the owner playbook (reply-agent.js); it only
  // hands the thread off when Autopilot → Lots has the bot off for owners.
  assert.equal(handsOffReason({ lotOwner: true, laneBotOff: false }), "");
  assert.match(handsOffReason({ lotOwner: true, laneBotOff: true }), /the bot is off for owners/);
  assert.equal(handsOffReason({ lotOwner: false, gatekeeper: false }), "");
  const { decideAutoSend } = await import("./reply-agent.js");
  const ok = { ok: true, flags: [] };
  const cfg = { enabled: true, parties: { agent: { autoSend: { enabled: true, intents: ["question"] } } }, autoSend: { channels: ["sms"] } };
  assert.equal(decideAutoSend({ gate: ok, party: "agent", intent: "question", config: cfg, sendsEnabled: true, lane: "owner", laneBot: "draft" }).code, "owner_lane");
  assert.equal(decideAutoSend({ gate: ok, party: "agent", intent: "question", config: cfg, sendsEnabled: true, lane: "owner", laneBot: "send" }).send, true);
  assert.equal(decideAutoSend({ gate: ok, party: "agent", intent: "question", config: cfg, sendsEnabled: true }).send, true);
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

test("the weekly pass reads the new builds that sold in the pocket and puts their builders into the buyer book through the listing agent, tagged for the pocket's city", async () => {
  process.env.OUTREACH_IMPORTS_ENABLED = "true";
  try {
    const g = ghl();
    const scan = async () => ({ suggest: {}, teardowns: [], newBuilds: [
      { address: "12 Summit Dr, Clyde Hill, WA 98004", price: 4600000, saleDate: "2026-06-10", lotSqft: 32670, sqft: 6500, yearBuilt: 2026,
        facts: { description: "Built by Mystery Homes, an estate…", sales: [{ date: "2026-06-10", price: 4600000 }, { date: "2023-09-01", price: 1100000 }], agent: { name: "Ann Agent", phone: "4255550177", email: "" }, brokerage: "Example Realty" } },
      { address: "14 Summit Dr, Clyde Hill, WA 98004", price: 4100000, saleDate: "2026-02-01", lotSqft: 43560, sqft: 6000, yearBuilt: 2025, facts: { description: "", sales: [], agent: { name: "", phone: "" } } },
    ] });
    const saved = { ...ON({ traceDailyCap: 0, dailyNew: 0 }), apifyToken: "apify" };
    // The builder's own contact: the registry knows Mystery Homes; nobody knows the other build.
    const resolveBuilderContact = async ({ builderName }) => (builderName ? { entity: "Mystery Homes LLC", phone: "+14255550100", principal: "Sam Sample", source: "lni" } : null);
    const out = await runLotFinder({ client: {}, locationId: "L8", saved, store, deps: { fetch: fetchStub(PHONES), scanPocketZillow: scan, resolveBuilderContact, ...g.deps }, now: T0 });
    assert.equal(out.pockets[0].builders, 2);
    assert.equal(out.builderLookups.looked, 2);
    assert.equal(out.builders.created, 1, "the builder the registry knows");
    assert.equal(out.builderLookups.looked - out.builderLookups.found, 1, "the other build has no builder number, and the listing agent's is never used");
    assert.equal((await store.listLotBuilders("L8")).filter((x) => x.status === "no_phone").length, 1);
    const b = g.created.find((c) => c.companyName);
    assert.equal(b.companyName, "Mystery Homes LLC");
    assert.equal(b.firstName, "Sam");
    assert.equal(b.phone, "+14255550100", "the registry's number, not the agent's");
    assert.ok(!g.created.some((c) => c.phone === "+14255550177"), "the listing agent's number is never used");
    assert.deepEqual(g.tagged.find((t) => t.tags.includes("builder")).tags, ["investor", "builder", "dispo-type-new-construction", "dispo-source-builder-exits", "lot-pocket-clyde-hill", "dispo-source-lni", "dispo-city-clyde-hill"]);
    const rows = await store.listLotBuilders("L8");
    assert.equal(rows.find((r) => r.builderKey === "nb:12-summit-dr-clyde-hill-wa-98004").doc.priorLotPrice, 1100000);
    // A week later the same pocket isn't scanned again.
    const again = await runLotFinder({ client: {}, locationId: "L8", saved, store, deps: { fetch: fetchStub(PHONES), scanPocketZillow: async () => { throw new Error("scanned twice"); }, resolveBuilderContact, ...g.deps }, now: T0 + 86400000 });
    assert.equal(again.pockets[0].builders, undefined);
  } finally { delete process.env.OUTREACH_IMPORTS_ENABLED; }
});

test("a house from a lot owner, or inside a pocket, belongs to the luxury lane; any other house doesn't", async () => {
  const { luxuryLaneFor } = await import("./auto-underwrite.js");
  const saved = ON();
  assert.match(luxuryLaneFor({ saved, contact: { tags: ["lot-owner", "lot-pocket-clyde-hill"] } }).why, /homeowner the lot finder texted, inside the Clyde Hill pocket/);
  assert.match(luxuryLaneFor({ saved, contact: { tags: ["lot-owner"] } }).why, /homeowner the lot finder texted/);
  assert.equal(luxuryLaneFor({ saved, contact: { tags: ["agent-outreach"] }, lat: 47.635, lng: -122.212, lotSqft: 34000, yearBuilt: 1962 }).pocket.id, "clyde-hill");
  assert.equal(luxuryLaneFor({ saved, contact: { tags: ["agent-outreach"] }, lat: 47.635, lng: -122.212, lotSqft: 7000, yearBuilt: 1962 }), null, "too small a lot");
  assert.equal(luxuryLaneFor({ saved: {}, contact: { tags: ["agent-outreach"] }, lat: 47.635, lng: -122.212, lotSqft: 34000, yearBuilt: 1962 }), null, "no pockets");
});

test("a listing agent imported as a builder on the first pass is retired: builder tags off, a lot-listing-agent tag on, and the row waits for the builder's own number", async () => {
  process.env.OUTREACH_IMPORTS_ENABLED = "true";
  try {
    const g = ghl();
    const untagged = [];
    await store.upsertLotBuilders("L9", [{ builderKey: "nb:old", pocketId: "clyde-hill", doc: { address: "14 Summit Dr, Clyde Hill, WA 98004", exitPrice: 4100000, agent: { name: "Ann Agent", phone: "+14255550177" }, reach: "agent" } }]);
    await store.setLotBuilder("L9", "nb:old", { status: "imported", contactId: "c-agent", importedAt: new Date(T0).toISOString() });
    const saved = { ...ON({ traceDailyCap: 0, dailyNew: 0 }), apifyToken: "apify" };
    const out = await runLotFinder({ client: {}, locationId: "L9", saved, store, deps: { fetch: fetchStub(PHONES), scanPocketZillow: async () => ({ suggest: {}, teardowns: [], newBuilds: [] }), resolveBuilderContact: async () => ({ entity: "Summit 14 LLC", phone: "", principal: "", source: "county" }), removeContactTags: async (id, tags) => { untagged.push({ id, tags }); }, ...g.deps }, now: T0 });
    assert.equal(out.agentsRetired, 1);
    assert.equal(untagged[0].id, "c-agent");
    assert.ok(untagged[0].tags.includes("builder") && untagged[0].tags.includes("investor") && untagged[0].tags.includes("lot-pocket-clyde-hill"));
    assert.deepEqual(g.tagged.find((t) => t.id === "c-agent").tags, ["lot-listing-agent"]);
    const row = (await store.listLotBuilders("L9"))[0];
    assert.equal(row.status, "new", "waits for the builder's own number");
    assert.equal(row.doc.reach, "agent_retired");
    assert.ok(!g.created.some((c) => c.phone === "+14255550177"), "nobody imported off the agent's number");
    // The next run looks the builder up; nothing found, so the row is no_phone, still not in the book.
    await runLotFinder({ client: {}, locationId: "L9", saved, store, deps: { fetch: fetchStub(PHONES), scanPocketZillow: async () => ({ suggest: {}, teardowns: [], newBuilds: [] }), resolveBuilderContact: async () => ({ entity: "Summit 14 LLC", phone: "", principal: "", source: "county" }), removeContactTags: async () => {}, ...g.deps }, now: T0 + 86400000 });
    const later = (await store.listLotBuilders("L9"))[0];
    assert.equal(later.status, "no_phone");
    assert.equal(later.doc.reach, "none");
    assert.ok(!g.created.some((c) => c.phone === "+14255550177"));
  } finally { delete process.env.OUTREACH_IMPORTS_ENABLED; }
});

test("a first text still unsent is rewritten with the current words on the next run", async () => {
  process.env.OUTREACH_IMPORTS_ENABLED = "true";
  try {
    const g = ghl();
    const saved = ON({ traceDailyCap: 5, autoSend: false });
    await runLotFinder({ client: {}, locationId: "L10", saved, store, deps: { fetch: fetchStub(PHONES), ...g.deps }, now: T0 });
    const d = (await store.listReplyDrafts("L10", { limit: 10 })).find((x) => x.outbound?.kind === "lot_owner_open");
    assert.ok(d && d.status === "draft");
    await store.updateReplyDraft(d.id, { ...d, reply: "old words with a 1.9M to 2.3M band" });
    const again = await runLotFinder({ client: {}, locationId: "L10", saved, store, deps: { fetch: fetchStub(PHONES), ...g.deps }, now: T0 + 3600000 });
    assert.equal(again.texts.refreshed, 1);
    const fresh = (await store.listReplyDrafts("L10", { limit: 10 })).find((x) => x.id === d.id);
    assert.ok(fresh.reply.includes("Clyde Hill") && !/1\.9M/.test(fresh.reply), fresh.reply);
    assert.equal(fresh.status, "draft");
  } finally { delete process.env.OUTREACH_IMPORTS_ENABLED; }
});

test("a first text drafted while the switches were off schedules itself once they're all on", async () => {
  process.env.OUTREACH_IMPORTS_ENABLED = "true";
  try {
    const g = ghl();
    await runLotFinder({ client: {}, locationId: "L11", saved: ON({ traceDailyCap: 5, autoSend: false }), store, sendsEnabled: true, deps: { fetch: fetchStub(PHONES), ...g.deps }, now: T0 });
    const d = (await store.listReplyDrafts("L11", { limit: 10 })).find((x) => x.outbound?.kind === "lot_owner_open");
    assert.equal(d.status, "draft");
    process.env.OWNER_SMS_ENABLED = "true";
    const again = await runLotFinder({ client: {}, locationId: "L11", saved: ON({ traceDailyCap: 5, autoSend: true }), store, sendsEnabled: true, deps: { fetch: fetchStub(PHONES), ...g.deps }, now: T0 + 3600000 });
    assert.equal(again.texts.scheduled, 1);
    const s = (await store.listReplyDrafts("L11", { limit: 10 })).find((x) => x.id === d.id);
    assert.equal(s.status, "scheduled");
    assert.ok(s.sendAt);
  } finally { delete process.env.OUTREACH_IMPORTS_ENABLED; delete process.env.OWNER_SMS_ENABLED; }
});

test("a lot owner's first text the carrier blocked goes once more in another clean variant, and never a third time", async () => {
  const { queueLotOwnerRetry } = await import("./delivery-watch.js");
  await store.upsertLotOwners("L12", [{ ownerKey: "rapi:9", pocketId: "clyde-hill", doc: { first: "Pat", last: "Example", house: { street: "9 Lakeview Ln", city: "Clyde Hill", state: "WA" }, person: true } }]);
  await store.setLotOwner("L12", "rapi:9", { status: "imported", contactId: "c-9" });
  const first = await store.createReplyDraft({ locationId: "L12", contactId: "c-9", contactName: "Pat Example", status: "sent", channel: "sms", jobId: null, inbound: "",
    outbound: { kind: "lot_owner_open", step: "open", ownerKey: "rapi:9", pocketId: "clyde-hill", address: "9 Lakeview Ln" }, reply: "the text that bounced", sentText: "the text that bounced", intent: "lot_owner_open",
    confidence: "high", needsHuman: false, humanReason: "", summary: "", propertyAddress: "9 Lakeview Ln", counterAmount: null, autoSendable: true, flags: [], party: "owner", partySource: "lot-finder",
    matchedTags: { agent: [], investor: [] }, contextSummary: {}, offersInContext: 0, autoSend: { decided: false, reason: "" }, humanActive: null, actions: [], supersededIds: [], warnings: [], noteOnAutoSend: false, promptVersion: 1, autoSent: false, updatedAt: new Date(T0).toISOString() });
  const saved = ON({ traceDailyCap: 0, dailyNew: 0, autoSend: true });
  const r = await queueLotOwnerRetry({ store, locationId: "L12", saved, draft: first, now: T0 + 7200000, sendsEnabled: true });
  assert.equal(r.queued, true);
  assert.equal(r.scheduled, false, "the first waited for Matt's Send, so this one does");
  const d = await store.getReplyDraft(r.draftId);
  assert.equal(d.outbound.kind, "lot_owner_open");
  assert.equal(d.outbound.retryOf, first.id);
  assert.ok(d.reply.includes("9 Lakeview Ln") && d.reply.includes("Clyde Hill") && d.reply !== "the text that bounced", d.reply);
  assert.doesNotMatch(d.reply, /investor/i);
  const again = await queueLotOwnerRetry({ store, locationId: "L12", saved, draft: first, now: T0 + 9000000, sendsEnabled: true });
  assert.match(again.skipped, /already retried once/);
});
