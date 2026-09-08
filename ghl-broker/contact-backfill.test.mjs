// contact-backfill.test.mjs — filling the record from what already exists.
//
// The one property that matters: running it twice changes nothing. Every
// event the app pass derives from an offer must land on the same row as the
// ledger line GHL already carries for it, or the timeline doubles on the
// first real run against a book that has both.
//
//   node --test contact-backfill.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "contact-backfill-test-"));
delete process.env.DATABASE_URL;

const { store } = await import("./store.js");
const { runContactBackfill } = await import("./contact-backfill.js");
const { historyLine } = await import("./enrich.js");
const { currentFacts } = await import("./shared/contact-record.js");

const LOC = "LOC";

// A GHL whose contacts already carry the ledger lines the app's own records
// would derive — the state a real book is in on day one.
function ghlStub(contacts) {
  const keys = ["agent_deal_history", "investor_deal_history", "personal_details", "buybox_areas", "buybox_price_max", "agent_market_area", "last_convo_date"];
  const calls = { getContact: 0 };
  const client = { call: async (p, o = {}) => {
    if (/\/customFields/.test(p)) return { customFields: keys.map((k) => ({ id: `id_${k}`, fieldKey: `contact.${k}`, name: k })) };
    const m = /\/contacts\/([^/?]+)$/.exec(p);
    if (m && (!o.method || o.method === "GET")) {
      calls.getContact++;
      const c = contacts[m[1]];
      if (!c) { const e = new Error("not found"); e.status = 404; throw e; }
      return { contact: { id: m[1], ...c, customFields: Object.entries(c.custom || {}).map(([k, v]) => ({ id: `id_${k}`, value: v })) } };
    }
    return {};
  } };
  return { client, calls };
}

test("the record fills from offers, drafts, invites and GHL — and a second run inserts nothing", async () => {
  // createOffer stamps createdAt with now; a real offer keeps its real date,
  // so the fixture re-dates itself through updateOffer.
  const created = await store.createOffer({
    id: "o1", locationId: LOC, contactId: "agent1", contactName: "Kim Agent", address: "12 Elm St, Renton, WA 98056",
    cashAmount: 410000, status: "accepted",
    statusHistory: [{ status: "countered", ts: "2026-08-22T18:00:00.000Z", note: "wants 425" }, { status: "accepted", ts: "2026-08-24T18:00:00.000Z" }],
    deal: {
      stage: "buyer_found", createdAt: "2026-08-25T00:00:00.000Z",
      stageHistory: [{ stage: "under_contract", ts: "2026-08-25T00:00:00.000Z" }, { stage: "buyer_found", ts: "2026-08-30T00:00:00.000Z" }],
      investors: [
        { contactId: "inv1", name: "Pat Buyer", status: "committed", addedAt: "2026-08-26T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z" },
        { contactId: "inv2", name: "Lee Pass", status: "passed", addedAt: "2026-08-26T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z", reason: { code: "price", note: "no meat at 498" } },
      ],
      feedback: [{ contactId: "inv2", name: "Lee Pass", code: "price", note: "no meat at 498", status: "passed", ts: "2026-08-27T00:00:00.000Z" }],
    },
  });
  await store.updateOffer(created.id, { ...created, createdAt: "2026-08-20T17:00:00.000Z" });
  await store.createReplyDraft({
    id: "d1", locationId: LOC, contactId: "inv2", contactName: "Lee Pass", party: "investor", status: "sent",
    summary: "Passed on Elm; buys Tacoma under 400.", intent: "passing", inbound: "too rich, Tacoma only",
    profileUpdates: { learned: ["areas: Tacoma", "buys up to $400,000"] },
  });
  const room = await store.createDataroom({ id: "r1", locationId: LOC, offerId: "o1", address: "12 Elm St, Renton, WA 98056", status: "active", kind: "deal" });
  const invite = await store.createDataroomInvite({ id: "i1", dataroomId: room.id, locationId: LOC, contactId: "inv1", name: "Pat Buyer", tokenHash: "x", status: "active" });
  // Views land through updateDataroomInvite, the way the view route writes them.
  await store.updateDataroomInvite(invite.id, { sentAt: "2026-08-26T01:00:00.000Z", firstViewedAt: "2026-08-26T02:00:00.000Z", lastViewedAt: "2026-08-28T00:00:00.000Z", viewCount: 3 });

  const ghl = ghlStub({
    agent1: { firstName: "Kim", lastName: "Agent", tags: ["agent"], custom: {
      agent_deal_history: [
        historyLine("2026-08-20T17:00:00.000Z", "12 Elm St, Renton, WA 98056", "we offered $410,000"),
        historyLine("2026-08-22T18:00:00.000Z", "12 Elm St, Renton, WA 98056", "agent countered", "wants 425"),
        "2025-11-02 | 7 Older Way, Kent, WA | passed on our offer — went with a retail buyer",   // only GHL knows this one
      ].join("\n"),
      agent_market_area: "Renton, Kent", personal_details: "two kids",
    } },
    inv1: { firstName: "Pat", lastName: "Buyer", tags: ["investor"], custom: { buybox_areas: "Renton", buybox_price_max: "700000" } },
    inv2: { firstName: "Lee", lastName: "Pass", tags: ["investor"], custom: {
      investor_deal_history: historyLine("2026-08-27T00:00:00.000Z", "12 Elm St, Renton, WA 98056", "passed", "Price too high: no meat at 498"),
      buybox_areas: "Tacoma, Spanaway",
    } },
  });

  const job = { sources: ["app", "ghl"], maxContacts: 100, counts: { contacts: 0, events: 0, skipped: 0, facts: 0, errors: 0 }, errors: [] };
  await runContactBackfill(job, { client: ghl.client, locationId: LOC, store });
  assert.equal(job.status, "done");
  assert.equal(job.total, 3, "agent + two buyers");
  assert.equal(job.counts.errors, 0, job.errors.join(" | "));
  assert.equal(ghl.calls.getContact, 3, "one read per contact");

  // The agent: the offer's own events, plus the line only GHL had.
  const agent = await store.listContactEvents(LOC, "agent1");
  const at = (t) => agent.filter((e) => e.type === t);
  assert.equal(at("offer_sent").length, 1, "offer_sent from the app and from the ledger is ONE row");
  assert.equal(at("offer_countered").length, 1);
  assert.equal(at("offer_countered")[0].data.note, "wants 425");
  assert.equal(at("offer_accepted").length, 1);
  assert.equal(at("deal_promoted").length, 1);
  assert.equal(at("deal_stage")[0]?.data.stage, "buyer_found");
  assert.equal(at("offer_passed").length, 1, "the 2025 line only GHL knew is on the timeline");
  assert.equal(at("offer_passed")[0].address, "7 Older Way, Kent, WA");
  assert.equal(at("offer_passed")[0].source, "operator");
  const agentFacts = currentFacts((await store.getContactProfile(LOC, "agent1")).facts);
  assert.deepEqual(agentFacts.agent_market_area, ["Renton", "Kent"]);
  assert.deepEqual(agentFacts.personal_details, ["two kids"]);
  assert.equal((await store.getContactProfile(LOC, "agent1")).name, "Kim Agent");

  // The buyer who signed: evaluating → committed, and the dataroom trail.
  const pat = (await store.listContactEvents(LOC, "inv1")).filter((e) => e.type !== "fact_learned");
  assert.deepEqual(pat.map((e) => e.type).sort(), ["dataroom_sent", "dataroom_viewed", "dataroom_viewed", "investor_committed", "investor_evaluating"]);
  assert.equal(currentFacts((await store.getContactProfile(LOC, "inv1")).facts).buybox_price_max, "700000");

  // The buyer who passed: one pass (app + ledger collide), the feedback, the draft's conversation and what it learned.
  const lee = await store.listContactEvents(LOC, "inv2");
  const leeTypes = lee.map((e) => e.type);
  assert.equal(leeTypes.filter((t) => t === "investor_passed").length, 1, "app-derived pass and GHL ledger pass are ONE row");
  assert.ok(leeTypes.includes("feedback") && leeTypes.includes("text_summary") && leeTypes.includes("investor_evaluating"));
  assert.equal(lee.find((e) => e.type === "text_summary").ref, "d1");
  const leeFacts = currentFacts((await store.getContactProfile(LOC, "inv2")).facts);
  assert.deepEqual(leeFacts.buybox_areas, ["Tacoma", "Spanaway"], "the draft's 'Tacoma' and GHL's field are one list");
  assert.equal(leeFacts.buybox_price_max, "400000", "the draft's price band was learned");
  const stats = await store.contactRecordStats(LOC);
  assert.equal(stats.profiles, 3);

  // Idempotent.
  const again = { sources: ["app", "ghl"], maxContacts: 100, counts: { contacts: 0, events: 0, skipped: 0, facts: 0, errors: 0 }, errors: [] };
  await runContactBackfill(again, { client: ghl.client, locationId: LOC, store });
  assert.equal(again.counts.events, 0, `second run inserted nothing (skipped ${again.counts.skipped})`);
  assert.equal(again.counts.facts, 0);
  assert.equal((await store.contactRecordStats(LOC)).events, stats.events);
});

test("a contact deleted in GHL is not an error, and the app pass runs without GHL at all", async () => {
  await store.createOffer({ id: "o2", locationId: LOC, contactId: "gone", contactName: "Gone Agent", address: "1 Gone St, Kent, WA", cashAmount: 1000 });
  const { client } = ghlStub({});
  const job = { sources: ["app", "ghl"], maxContacts: 100, counts: { contacts: 0, events: 0, skipped: 0, facts: 0, errors: 0 }, errors: [] };
  await runContactBackfill(job, { client, locationId: LOC, store });
  assert.equal(job.counts.errors, 0, job.errors.join(" | "));
  assert.equal((await store.listContactEvents(LOC, "gone")).length, 1, "the app-side record stands on its own");
  const appOnly = { sources: ["app"], maxContacts: 100, counts: { contacts: 0, events: 0, skipped: 0, facts: 0, errors: 0 }, errors: [] };
  await runContactBackfill(appOnly, { client: null, locationId: LOC, store });
  assert.equal(appOnly.status, "done");
});
