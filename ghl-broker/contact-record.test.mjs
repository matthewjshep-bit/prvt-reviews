// contact-record.test.mjs — the record's I/O against the real file store.
//
// What this guards:
//   1. A replay that doubles the timeline. recordEvent twice for one action
//      must leave one row — that is the whole point of the dedupe key.
//   2. A projection that changes what GHL says. projectToGhl must write
//      exactly what mergeHistory / mergeFacts would have written for the same
//      inputs, or the "GHL keeps its meaning" promise is broken.
//   3. Reconcile that overwrites or deletes. GHL fills gaps; the record wins
//      where it has a value; nothing is ever removed by a pull.
//
//   node --test contact-record.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "contact-record-test-"));
delete process.env.DATABASE_URL;

const { store } = await import("./store.js");
const { mergeHistory, mergeFacts, historyLine } = await import("./enrich.js");
const { renderLedger, eventFromLedgerLine, currentFacts } = await import("./shared/contact-record.js");
const { recordEvent, recordEvents, learnFacts, forgetFact, projectToGhl, reconcileFromGhl, getContactRecord, ensureProfile, RECORD_FIELD_DEFS } =
  await import("./contact-record.js");

const LOC = "LOC";

// A GHL stub that holds one contact's custom fields and records every write.
function ghlStub(custom = {}, contact = {}) {
  const fields = { ...custom };
  const writes = [];
  const defs = [];
  const client = { call: async (p, o = {}) => {
    if (/\/locations\/.*\/customFields/.test(p) && (!o.method || o.method === "GET")) {
      return { customFields: Object.keys(fields).concat(defs).map((k) => ({ id: `id_${k}`, fieldKey: `contact.${k}`, name: k })) };
    }
    // Creation sends only a display name; GHL derives the key from it. Map the
    // name back through our definitions the way the real id→key map does.
    if (/\/customFields/.test(p) && o.method === "POST") {
      const key = RECORD_FIELD_DEFS.find((d) => d.name === o.body?.name)?.key || o.body?.name;
      defs.push(key);
      return { customField: { id: `id_${key}`, fieldKey: `contact.${key}`, name: key } };
    }
    if (/\/contacts\/[^/]+$/.test(p) && (!o.method || o.method === "GET")) {
      return { contact: { id: "c1", firstName: "Sam", lastName: "Lee", email: "sam@x.com", phone: "+1", tags: ["investor"], ...contact,
        customFields: Object.entries(fields).map(([k, v]) => ({ id: `id_${k}`, value: v })) } };
    }
    if (/\/contacts\/[^/]+$/.test(p) && o.method === "PUT") {
      writes.push(o.body);
      for (const f of o.body?.customFields || []) fields[f.id.replace(/^id_/, "")] = f.value;
      return { contact: {} };
    }
    return {};
  } };
  return { client, writes, fields };
}

test("an event recorded twice is one row, and a note is always a new row", async () => {
  const ev = { store, locationId: LOC, contactId: "c1", party: "investor", type: "investor_passed", at: "2026-09-05T18:00:00.000Z",
    address: "22018 76th Ave W, Edmonds, WA 98026", offerId: "o1", source: "conversation", ref: "d1", data: { note: "Price too high: no meat at 498" } };
  const a = await recordEvent(ev);
  const b = await recordEvent(ev);
  assert.equal(a.inserted, true);
  assert.equal(b.inserted, false, "same action, same key, no second row");
  assert.equal((await store.listContactEvents(LOC, "c1")).length, 1);
  // The same action arriving as its ledger line lands on the same row too.
  const line = historyLine(ev.at, ev.address, "passed", ev.data.note);
  const r = await recordEvents({ store, locationId: LOC, contactId: "c1", events: [eventFromLedgerLine(line, { party: "investor", source: "import" })] });
  assert.equal(r.inserted, 0, `the backfill's line collides with the live event: ${line}`);
  await recordEvent({ store, locationId: LOC, contactId: "c1", type: "note", source: "operator", data: { text: "called, no answer" } });
  await recordEvent({ store, locationId: LOC, contactId: "c1", type: "note", source: "operator", data: { text: "called, no answer" } });
  assert.equal((await store.listContactEvents(LOC, "c1", { types: ["note"] })).length, 2);
  // Recording an event created the profile with the party.
  assert.equal((await store.getContactProfile(LOC, "c1")).party, "investor");
});

test("facts learned carry their source, leave a trail, and stay forgotten once removed", async () => {
  const r = await learnFacts({ store, locationId: LOC, contactId: "c2", party: "investor", facts: [
    { key: "buybox_areas", value: "Gig Harbor", source: "conversation", at: "2026-09-06T00:00:00Z", ref: "d9" },
    { key: "buybox_price_max", value: "$400,000", source: "conversation", ref: "d9" },
    { key: "agent_market_area", value: "Kent", source: "conversation", ref: "d9" },   // not an investor key
    { key: "buybox_areas", value: "gig harbor", source: "sweep" },                     // dupe
  ] });
  assert.deepEqual(r.added.map((a) => [a.key, a.value]), [["buybox_areas", "Gig Harbor"], ["buybox_price_max", "400000"]]);
  const p = await store.getContactProfile(LOC, "c2");
  assert.equal(p.facts.buybox_areas[0].ref, "d9");
  assert.equal(p.facts.buybox_areas[0].source, "conversation");
  const trail = await store.listContactEvents(LOC, "c2", { types: ["fact_learned"] });
  assert.equal(trail.length, 2);
  assert.equal(trail.find((e) => e.data.key === "buybox_areas").ref, "d9");
  // Forget, then the sweep tries again.
  const f = await forgetFact({ store, locationId: LOC, contactId: "c2", key: "buybox_areas", value: "Gig Harbor" });
  assert.equal(f.removed, true);
  const again = await learnFacts({ store, locationId: LOC, contactId: "c2", party: "investor", facts: [{ key: "buybox_areas", value: "Gig Harbor", source: "sweep" }] });
  assert.equal(again.added.length, 0, "a removed fact does not come back");
  assert.equal((await store.listContactEvents(LOC, "c2", { types: ["fact_removed"] })).length, 1);
});

test("projectToGhl writes exactly what mergeHistory and mergeFacts would have", async () => {
  const cid = "c3";
  const existing = [
    "2026-07-01 | 1 Old St, Kent, WA | we offered $300,000",
    "2026-07-05 | 1 Old St, Kent, WA | agent countered — wants 320",
  ].join("\n");
  const { client, writes, fields } = ghlStub({ agent_deal_history: existing, personal_details: "two kids", agent_market_area: "Kent" }, { tags: ["agent"] });
  await recordEvents({ store, locationId: LOC, contactId: cid, party: "agent", events: [
    eventFromLedgerLine("2026-07-01 | 1 Old St, Kent, WA | we offered $300,000", { party: "agent", source: "offer" }),
    eventFromLedgerLine("2026-08-10 | 9 New Ave, Renton, WA | we offered $410,000", { party: "agent", source: "offer" }),
    { type: "tag_added", at: "2026-08-11T00:00:00Z", source: "conversation", data: { tag: "tier-1" } },   // never a ledger line
  ] });
  await learnFacts({ store, locationId: LOC, contactId: cid, party: "agent", facts: [
    { key: "personal_details", value: "had knee surgery", source: "conversation" },
    { key: "agent_market_area", value: "Auburn", source: "sweep" },
    { key: "subject_property", value: "9 New Ave, Renton, WA", source: "offer" },
  ] });
  const r = await projectToGhl({ client, store, locationId: LOC, contactId: cid, party: "agent" });
  assert.deepEqual(r.written.sort(), ["agent_deal_history", "agent_market_area", "personal_details", "subject_property"]);
  // Ledger: the current GHL value on the left, the record's lines on the right — the countered line GHL had and the record doesn't is kept.
  const appLines = renderLedger((await store.listContactEvents(LOC, cid)).reverse().filter((e) => e.type.startsWith("offer_"))).split("\n");
  assert.equal(fields.agent_deal_history, mergeHistory(existing, appLines));
  assert.ok(fields.agent_deal_history.includes("agent countered — wants 320"), "GHL's own line survives");
  assert.ok(fields.agent_deal_history.includes("9 New Ave"));
  assert.ok(!fields.agent_deal_history.includes("tier-1"), "a tag is not a ledger line");
  // Facts: same merge, same caps.
  assert.equal(fields.personal_details, mergeFacts("two kids", "had knee surgery", 1500));
  assert.equal(fields.agent_market_area, mergeFacts("Kent", "Auburn", 600));
  assert.equal(fields.subject_property, "9 New Ave, Renton, WA");
  // Nothing changed → nothing written.
  const again = await projectToGhl({ client, store, locationId: LOC, contactId: cid, party: "agent" });
  assert.deepEqual(again.written, []);
  assert.equal(writes.length, 1);
  assert.ok((await store.getContactProfile(LOC, cid)).projectedAt);
});

test("renderLedger is mergeHistory('') for the same lines, cap included", async () => {
  const lines = [];
  for (let i = 0; i < 120; i++) {
    const d = `2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")}`;
    lines.push(`${d} | ${i % 7} Some Fairly Long Street Name, Some City, WA 98${String(i).padStart(3, "0")} | ${["we offered $1", "agent countered", "passed on our offer", "under contract"][i % 4]}${i % 3 ? " — a note with a - dash" : ""}`);
  }
  const events = lines.map((l) => eventFromLedgerLine(l, { party: "agent" }));
  assert.equal(renderLedger(events), mergeHistory("", lines));
  assert.equal(renderLedger(events, { maxChars: 700 }), mergeHistory("", lines, 700));
});

test("reconcile pulls what GHL has that the record lacks, and never the other way", async () => {
  const cid = "c4";
  await learnFacts({ store, locationId: LOC, contactId: cid, party: "investor", facts: [
    { key: "buybox_price_max", value: "650000", source: "conversation", ref: "d1" },
    { key: "buybox_areas", value: "Tacoma", source: "conversation", ref: "d1" },
  ] });
  await forgetFact({ store, locationId: LOC, contactId: cid, key: "buybox_areas", value: "Spanaway" });
  const { client } = ghlStub({
    buybox_price_max: "600000",                 // GHL disagrees on a scalar the record already has → record wins
    buybox_areas: "Tacoma, Spanaway, 98444",    // Spanaway was removed by hand → stays out; 98444 is new → in
    personal_details: "likes fishing",
    investor_deal_history: "2026-06-01 | 4 Fish Ln, Tacoma, WA | evaluating\n2026-06-03 | 4 Fish Ln, Tacoma, WA | passed — too far",
    last_convo_date: "2026-06-03",
  });
  const r = await reconcileFromGhl({ store, locationId: LOC, contactId: cid, party: "investor", client });
  const f = currentFacts((await store.getContactProfile(LOC, cid)).facts);
  assert.equal(f.buybox_price_max, "650000", "the record's scalar wins");
  assert.deepEqual(f.buybox_areas, ["Tacoma", "98444"], "GHL fills the gap; the removed value stays removed");
  assert.deepEqual(f.personal_details, ["likes fishing"]);
  assert.equal(r.events, 2);
  const ev = await store.listContactEvents(LOC, cid, { types: ["investor_passed", "investor_evaluating"] });
  assert.equal(ev.length, 2);
  assert.ok(ev.every((e) => e.source === "operator" && e.ref === "ghl"));
  assert.equal(ev.find((e) => e.type === "investor_passed").data.note, "too far");
  const p = await store.getContactProfile(LOC, cid);
  assert.equal(p.name, "Sam Lee");
  assert.deepEqual(p.tags, ["investor"]);
  // Idempotent.
  const r2 = await reconcileFromGhl({ store, locationId: LOC, contactId: cid, party: "investor", client });
  assert.deepEqual([r2.facts, r2.events], [0, 0]);
});

test("getContactRecord assembles every section and survives a contact nobody has recorded", async () => {
  const empty = await getContactRecord({ store, locationId: LOC, contactId: "nobody" });
  assert.equal(empty.profile, null);
  assert.equal(empty.factsEmpty, true);
  assert.deepEqual([empty.events, empty.offers, empty.deals, empty.drafts, empty.invites], [[], [], [], [], []]);

  await store.createOffer({ id: "o9", locationId: LOC, contactId: "agent9", address: "9 Nine St, Kent, WA", cashAmount: 300000, status: "sent",
    deal: { stage: "under_contract", investors: [{ contactId: "c4", status: "sent", addedAt: "2026-06-01T00:00:00Z" }], feedback: [{ contactId: "c4", code: "price", note: "rich", ts: "2026-06-02T00:00:00Z" }] } });
  const rec = await getContactRecord({ store, locationId: LOC, contactId: "c4" });
  assert.equal(rec.party, "investor");
  assert.equal(rec.deals.length, 1);
  assert.equal(rec.deals[0].standing.status, "evaluating", "the retired 'sent' reads as evaluating");
  assert.equal(rec.deals[0].live, true);
  assert.deepEqual(rec.feedback.map((f) => [f.code, f.address]), [["price", "9 Nine St, Kent, WA"]]);
  assert.equal(rec.facts.buybox_price_max, "650000");
  const agent = await getContactRecord({ store, locationId: LOC, contactId: "agent9" });
  assert.equal(agent.party, "agent");
  assert.equal(agent.offers.length, 1);
  assert.equal(agent.offers[0].listOnly, true, "lean rows, not documents");
});

test("ensureProfile never blanks a known field with a null", async () => {
  await ensureProfile({ store, locationId: LOC, contactId: "c5", party: "agent", name: "Kim", email: "kim@x.com" });
  await ensureProfile({ store, locationId: LOC, contactId: "c5", name: null, email: null });
  const p = await store.getContactProfile(LOC, "c5");
  assert.deepEqual([p.party, p.name, p.email], ["agent", "Kim", "kim@x.com"]);
});
