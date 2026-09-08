// contact-record.test.mjs — the record's arithmetic.
//
// What this guards, in order of cost:
//   1. A ledger line that doesn't round-trip. The backfill reads years of
//      `YYYY-MM-DD | address | event — note` lines out of GHL; a parse that
//      loses the note or mis-splits on a dash in it quietly corrupts history.
//   2. Two keys for one action. A live appendDealHistory and a backfill of
//      the same line must collide, or every backfill doubles the timeline.
//   3. A fact that resurrects. An operator removing "no condos" and the next
//      sweep putting it back is the kind of bug that makes people stop
//      trusting the record.
//
//   node --test contact-record.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_TYPES, EVENT_LABEL, EVENT_ICON, FACT_KEYS, factKeysFor,
  parseHistoryLine, eventFromLedgerLine, eventToHistoryLine, eventDedupeKey, ledgerEventType, eventPhrase,
  renderLedger, ledgerEvents, addFact, removeFact, currentFacts, renderFactField, factsFromCustom, factsAsCustom,
  offerEvents, draftEvents, draftFacts, inviteEvents, groupByDay, addressKey, eventKey,
} from "./contact-record.js";
import { STATUS_HISTORY_PHRASE } from "./offer-status.js";

test("every event type has a label and an icon, and every fact key names a party", () => {
  for (const t of EVENT_TYPES) {
    assert.ok(EVENT_LABEL[t], `${t} needs a label`);
    assert.ok(EVENT_ICON[t], `${t} needs an icon`);
  }
  for (const [k, def] of Object.entries(FACT_KEYS)) {
    assert.ok(["agent", "investor", "both"].includes(def.party), k);
    assert.ok(["list", "scalar"].includes(def.kind), k);
    assert.ok(def.cap > 0, k);
  }
  assert.ok(factKeysFor("agent").includes("agent_market_area") && !factKeysFor("agent").includes("buybox_areas"));
  assert.ok(factKeysFor("investor").includes("buybox_areas") && factKeysFor("investor").includes("personal_details"));
});

test("a ledger line round-trips, dashes in the note and all", () => {
  const line = "2026-09-05 | 22018 76th Ave W, Edmonds, WA 98026 | passed — Price too high: no meat - at 498";
  const p = parseHistoryLine(line);
  assert.deepEqual(p, { date: "2026-09-05", address: "22018 76th Ave W, Edmonds, WA 98026", event: "passed", note: "Price too high: no meat - at 498" });
  const ev = eventFromLedgerLine(line, { party: "investor" });
  assert.equal(ev.type, "investor_passed");
  assert.equal(eventToHistoryLine(ev), line, "byte-identical back out");
  // No note, undated, and the placeholder address all survive too.
  assert.equal(eventToHistoryLine(eventFromLedgerLine("????-??-?? | unknown property | we offered $410,000", { party: "agent" })),
    "????-??-?? | unknown property | we offered $410,000");
  assert.equal(parseHistoryLine("nonsense"), null);
  assert.equal(parseHistoryLine("2026-01-01 | 1 Elm | "), null, "no event word is not a line");
});

test("the phrases the broker writes are typed, and unknown ones are kept as notes", () => {
  assert.equal(ledgerEventType("we offered $410,000").type, "offer_sent");
  assert.equal(ledgerEventType("we offered $410,000").data.amountText, "$410,000");
  assert.equal(ledgerEventType("we revised our offer to $400,000").type, "offer_revised");
  for (const [status, phrase] of Object.entries(STATUS_HISTORY_PHRASE)) {
    assert.equal(ledgerEventType(phrase).type, `offer_${status}`, phrase);
  }
  assert.equal(ledgerEventType("under contract").type, "deal_promoted");
  assert.deepEqual(ledgerEventType("fell through"), { type: "deal_stage", data: { stage: "fell_through" } });
  assert.equal(ledgerEventType("number in the realm").type, "realm_yes");
  assert.equal(ledgerEventType("number not in the realm").type, "realm_no");
  assert.equal(ledgerEventType("evaluating", "investor").type, "investor_evaluating");
  assert.equal(ledgerEventType("sent", "investor").type, "investor_evaluating", "the retired status reads as evaluating");
  assert.equal(ledgerEventType("committed", "investor").type, "investor_committed");
  assert.equal(ledgerEventType("feedback", "investor").type, "feedback");
  assert.equal(ledgerEventType("talked about the market").type, "note");
  // Rendering a typed event without its original phrase uses the same words.
  assert.equal(eventPhrase({ type: "offer_countered" }), STATUS_HISTORY_PHRASE.countered);
  assert.equal(eventPhrase({ type: "deal_stage", data: { stage: "buyer_found" } }), "buyer found");
});

test("one action, one key: a live ledger line and an offer-derived event collide", () => {
  const offer = {
    id: "o1", contactId: "agent1", address: "12 Elm St, Renton, WA 98056", cashAmount: 410000,
    createdAt: "2026-08-20T17:00:00.000Z",
    statusHistory: [{ status: "countered", ts: "2026-08-22T18:00:00.000Z", note: "wants 425" }],
    realm: { answer: "yes", ts: "2026-08-21T10:00:00.000Z" },
    deal: {
      stage: "under_contract", createdAt: "2026-08-25T00:00:00.000Z",
      stageHistory: [{ stage: "under_contract", ts: "2026-08-25T00:00:00.000Z" }],
      investors: [{ contactId: "inv1", status: "passed", addedAt: "2026-08-26T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z", reason: { code: "price", note: "no meat at 498" } }],
      feedback: [{ contactId: "inv2", code: "area", note: "wrong side of I-5", ts: "2026-08-28T00:00:00.000Z" }],
    },
  };
  const derived = offerEvents(offer);
  const byType = Object.fromEntries(derived.map((e) => [`${e.contactId}:${e.type}`, e]));
  // The lines the twelve appendDealHistory sites would have written.
  const live = {
    "agent1:offer_sent": eventFromLedgerLine("2026-08-20 | 12 Elm St, Renton, WA 98056 | we offered $410,000", { party: "agent" }),
    "agent1:offer_countered": eventFromLedgerLine("2026-08-22 | 12 Elm St, Renton, WA 98056 | agent countered — wants 425", { party: "agent" }),
    "agent1:realm_yes": eventFromLedgerLine("2026-08-21 | 12 Elm St, Renton, WA 98056 | number in the realm", { party: "agent" }),
    "agent1:deal_promoted": eventFromLedgerLine("2026-08-25 | 12 Elm St, Renton, WA 98056 | under contract", { party: "agent" }),
    "inv1:investor_passed": eventFromLedgerLine("2026-08-27 | 12 Elm St, Renton, WA 98056 | passed — Price too high: no meat at 498", { party: "investor" }),
    "inv2:feedback": eventFromLedgerLine("2026-08-28 | 12 Elm St, Renton, WA 98056 | feedback — Wrong area: wrong side of I-5", { party: "investor" }),
  };
  for (const [k, ev] of Object.entries(live)) {
    assert.ok(byType[k], `offerEvents produced ${k}`);
    assert.equal(byType[k].dedupeKey, ev.dedupeKey, `${k} keys agree`);
    assert.equal(eventToHistoryLine(byType[k]), eventToHistoryLine(ev), `${k} renders the same line`);
  }
  // The buyer who passed was evaluating first.
  assert.ok(byType["inv1:investor_evaluating"]);
  // Two offers on one address on different days are two events.
  const a = eventDedupeKey({ type: "offer_sent", at: "2026-08-20T00:00:00Z", address: "12 Elm St", data: { amountText: "$1" } });
  const b = eventDedupeKey({ type: "offer_sent", at: "2026-08-21T00:00:00Z", address: "12 Elm St", data: { amountText: "$1" } });
  assert.notEqual(a, b);
  // A note has no key; every one is real.
  assert.equal(eventDedupeKey({ type: "note", at: "2026-08-20T00:00:00Z" }), null);
});

test("the address and event halves of the key normalise the way mergeHistory does", () => {
  assert.equal(addressKey("12 Elm St., Renton, WA 98056"), "12 elm st renton wa 98056");
  assert.equal(eventKey("Passed — Price too high"), "passed");
  assert.equal(eventKey("we offered $410,000"), "we offered $410,000");
});

test("renderLedger dedupes on address+event, sorts by date, and drops the oldest over budget", () => {
  const ev = (date, address, phrase, note = "") => ({ type: "note", at: `${date}T12:00:00Z`, address, data: { phrase, ...(note ? { note } : {}) } });
  const events = [
    ev("2026-03-01", "1 Elm", "we offered $1"),
    ev("2026-01-01", "1 Elm", "we offered $1", "restated later — first wins"),
    ev("2026-02-01", "2 Oak", "passed"),
  ];
  const out = renderLedger(events);
  assert.deepEqual(out.split("\n"), [
    "2026-01-01 | 1 Elm | we offered $1 — restated later — first wins",
    "2026-02-01 | 2 Oak | passed",
  ]);
  const many = Array.from({ length: 80 }, (_, i) => ev(`2026-01-${String((i % 28) + 1).padStart(2, "0")}`, `${i} Long Street Name, Some City, WA 98000`, `we offered $${i}`));
  const capped = renderLedger(many, { maxChars: 600 });
  assert.ok(capped.length <= 600);
  assert.ok(!capped.includes("| 0 Long"), "the oldest went first");
  // Only ledger-shaped events belong in the digest.
  assert.equal(ledgerEvents([{ type: "tag_added", address: "x" }, { type: "offer_sent", address: "1 Elm" }]).length, 1);
});

test("facts: lists union and cap by count, scalars append on change, removals stick", () => {
  let f = {};
  ({ facts: f } = addFact(f, "personal_details", { value: "two kids", source: "conversation", at: "2026-01-01T00:00:00Z", ref: "d1" }));
  ({ facts: f } = addFact(f, "personal_details", { value: "Two Kids", source: "sweep" }));
  assert.equal(f.personal_details.length, 1, "case-insensitive dedupe");
  assert.equal(f.personal_details[0].ref, "d1", "the first sighting keeps its provenance");
  let r = addFact(f, "buybox_price_max", { value: "$600,000", source: "conversation" });
  assert.equal(r.added, true);
  assert.equal(r.facts.buybox_price_max[0].value, "600000", "money coerces to a number");
  r = addFact(r.facts, "buybox_price_max", { value: "600000", source: "operator" });
  assert.equal(r.added, false, "the same scalar again is not a change");
  r = addFact(r.facts, "buybox_price_max", { value: "650000", source: "operator" });
  assert.equal(r.facts.buybox_price_max.length, 2, "a scalar keeps its history");
  assert.equal(currentFacts(r.facts).buybox_price_max, "650000");
  f = r.facts;
  // Enum keys validate.
  assert.equal(addFact(f, "rehab_appetite", { value: "Full Gut" }).facts.rehab_appetite[0].value, "full_gut");
  assert.equal(addFact(f, "rehab_appetite", { value: "whatever" }).added, false);
  assert.equal(addFact(f, "buybox_property_types", { value: "SFR" }).facts.buybox_property_types[0].value, "sfr");
  // Count cap, oldest out.
  let big = {};
  for (let i = 0; i < 70; i++) ({ facts: big } = addFact(big, "personal_details", { value: `fact ${i}` }));
  assert.equal(big.personal_details.length, FACT_KEYS.personal_details.cap);
  assert.equal(big.personal_details[0].value, "fact 10");
  // Removal is a tombstone: the sweep can't put it back.
  ({ facts: f } = addFact(f, "buybox_exclusions", { value: "no condos", source: "sweep" }));
  const rm = removeFact(f, "buybox_exclusions", "No Condos");
  assert.equal(rm.removed, true);
  assert.deepEqual(currentFacts(rm.facts).buybox_exclusions, undefined);
  assert.equal(addFact(rm.facts, "buybox_exclusions", { value: "no condos", source: "sweep" }).added, false, "stays removed");
  // Rendering matches what the GHL field would hold.
  assert.equal(renderFactField(f, "personal_details"), "two kids");
  assert.equal(factsAsCustom(f).buybox_price_max, "650000");
  assert.equal(addFact(f, "not_a_key", { value: "x" }).added, false);
});

test("a GHL record reads back as the facts it was written from", () => {
  const custom = {
    personal_details: "two kids, had knee surgery; likes fishing",
    buybox_areas: "Tacoma, Spanaway, 98444",
    buybox_price_min: "$250,000", buybox_price_max: "600000",
    buybox_property_types: "sfr, multi_family, castle",
    rehab_appetite: "heavy", buybox_exclusions: "no HOA",
    last_convo_summary: "Asked for the Edmonds package.",
    agent_market_area: "Kent",             // not an investor key — ignored for investors
  };
  const facts = factsFromCustom(custom, "investor", { source: "import", at: "2026-09-01T00:00:00Z", ref: "bf1" });
  const keys = facts.map((f) => `${f.key}=${f.value}`);
  assert.ok(keys.includes("personal_details=two kids") && keys.includes("personal_details=had knee surgery") && keys.includes("personal_details=likes fishing"));
  assert.ok(keys.includes("buybox_areas=98444"));
  assert.ok(keys.includes("buybox_property_types=sfr") && keys.includes("buybox_property_types=multi_family"));
  assert.ok(!keys.some((k) => k.includes("castle")), "an unknown property type is not a fact");
  assert.ok(!keys.some((k) => k.startsWith("agent_market_area")));
  assert.ok(facts.every((f) => f.source === "import" && f.ref === "bf1"));
  // Fold them in and the field renders back the same way.
  let doc = {};
  for (const f of facts) ({ facts: doc } = addFact(doc, f.key, f));
  assert.equal(renderFactField(doc, "personal_details"), "two kids, had knee surgery, likes fishing");
  assert.equal(renderFactField(doc, "buybox_price_min"), "250000");
});

test("a draft's learned lines become facts and events with the draft as their source", () => {
  const draft = {
    id: "d9", contactId: "c1", party: "investor", createdAt: "2026-09-06T20:00:00.000Z",
    summary: "Passed on Edmonds; wants Gig Harbor only.", intent: "passing", inbound: "no thanks, Gig Harbor only",
    propertyAddress: "22018 76th Ave W, Edmonds, WA",
    profileUpdates: { learned: [
      "areas: Gig Harbor", "must-haves: Only buys Gig Harbor", "buys up to $400,000", "rehab: full gut",
      "history: 22018 76th Ave W, Edmonds, WA | passed — outside her area",
    ] },
  };
  const facts = draftFacts(draft);
  assert.deepEqual(facts.map((f) => [f.key, f.value]), [
    ["buybox_areas", "Gig Harbor"], ["buybox_exclusions", "Only buys Gig Harbor"], ["buybox_price_max", "$400,000"], ["rehab_appetite", "full_gut"],
  ]);
  assert.ok(facts.every((f) => f.source === "conversation" && f.ref === "d9"));
  const events = draftEvents(draft);
  assert.deepEqual(events.map((e) => e.type), ["text_summary", "investor_passed"]);
  assert.equal(events[0].dedupeKey, "text_summary:d9");
  assert.equal(events[1].data.note, "outside her area");
  assert.equal(events[1].at.slice(0, 10), "2026-09-06", "an undated learned line takes the draft's day");
  assert.equal(events[1].contactId, "c1");
});

test("dataroom invites yield sent and viewed events keyed on the invite", () => {
  const inv = { id: "i1", contactId: "c1", offerId: "o1", sentAt: "2026-08-20T00:00:00Z", firstViewedAt: "2026-08-21T00:00:00Z", lastViewedAt: "2026-08-23T00:00:00Z", viewCount: 3 };
  const ev = inviteEvents(inv, { address: "2010 NE 54th St" });
  assert.deepEqual(ev.map((e) => [e.type, e.dedupeKey]), [
    ["dataroom_sent", "dataroom_sent:i1"], ["dataroom_viewed", "dataroom_viewed:i1:1"], ["dataroom_viewed", "dataroom_viewed:i1:3"],
  ]);
  assert.equal(ev[0].address, "2010 NE 54th St");
  assert.deepEqual(inviteEvents({ id: "i2" }), [], "no contact, no event");
});

test("the drawer groups by local day, newest first", () => {
  const g = groupByDay([
    { at: "2026-09-06T03:00:00Z", type: "note" },   // Sep 5 evening in Seattle
    { at: "2026-09-06T20:00:00Z", type: "note" },
  ], "America/Los_Angeles");
  assert.deepEqual(g.map((x) => [x.day, x.events.length]), [["2026-09-06", 1], ["2026-09-05", 1]]);
});
