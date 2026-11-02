// investor-read.test.mjs — what an investor told us about how they buy, kept
// in their own words.
//
// What went wrong (2026-11-02): of 2,786 buyers in the book, 619 had written
// back or talked to Matt on the phone, and 155 had a buy box on file. The
// rest of what they'd said ("only Tacoma and Lakewood", "no septic", "I pay
// cash up to 450") was locked up in texts and call transcripts nobody could
// search or sort. A read keeps their sentences word for word next to the
// columns read from them — and a sentence that isn't really theirs never
// makes it in.
//
//   node --test investor-read.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  verifyQuotes, maskContact, normalizeRead, normalizeFields, cleanRead, threadForModel, hasTheirWords, readFacts,
  readColumns, readsCsv, readIsStale, readSearchText, priceBand, toNumber, READ_SCHEMA, READ_FIELD_KEYS, lastSaidAt,
} from "./investor-read.js";

const thread = {
  contactId: "c1",
  messages: [
    { id: "a", at: "2026-08-01T17:00:00.000Z", dir: "us", channel: "sms", body: "Hi Sam, got a flip in Tacoma under contract. What do you usually buy?" },
    { id: "b", at: "2026-08-01T17:05:00.000Z", dir: "them", channel: "sms", body: "Mostly Tacoma and Lakewood. I’m cash up to 450k, nothing with septic." },
    { id: "c", at: "2026-08-03T20:00:00.000Z", dir: "us", channel: "call", secs: 4, body: "" },
    { id: "d", at: "2026-08-09T18:00:00.000Z", dir: "us", channel: "call", secs: 312, body: "", turns: [
      { speaker: "1", text: "So what are you looking for these days?" },
      { speaker: "2", text: "Honestly I want heavy rehab, the uglier the better. Three bed minimum, and I can close in ten days." },
    ] },
    { id: "e", at: "2026-08-20T16:00:00.000Z", dir: "them", channel: "email", body: "Please send deals to my email going forward." },
  ],
};

test("a quote they really wrote is kept, dated and channelled from their message", () => {
  const { quotes, dropped } = verifyQuotes([{ ref: "m2", text: "Mostly Tacoma and Lakewood.", about: ["areas"] }], thread);
  assert.equal(dropped, 0);
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].at, "2026-08-01T17:05:00.000Z");
  assert.equal(quotes[0].channel, "sms");
  assert.equal(quotes[0].messageId, "b");
  assert.deepEqual(quotes[0].about, ["areas"]);
});

test("a quote is found even when the model cited the wrong message or straightened the apostrophe", () => {
  const { quotes } = verifyQuotes([{ ref: "m1", text: "I'm cash up to 450k", about: ["funding", "price_max"] }], thread);
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].messageId, "b");
});

test("a paraphrase of what they said is dropped", () => {
  const { quotes, dropped } = verifyQuotes([{ ref: "m2", text: "Buys in Tacoma and Lakewood with cash", about: ["areas"] }], thread);
  assert.equal(quotes.length, 0);
  assert.equal(dropped, 1);
});

test("our own words are never filed as theirs", () => {
  const { quotes, dropped } = verifyQuotes([{ ref: "m1", text: "got a flip in Tacoma under contract", about: ["areas"] }], thread);
  assert.equal(quotes.length, 0);
  assert.equal(dropped, 1);
});

test("a quote cut down with an ellipsis is kept when the pieces are in order", () => {
  const ok = verifyQuotes([{ ref: "m3", text: "I want heavy rehab… I can close in ten days", about: ["rehab"] }], thread);
  assert.equal(ok.quotes.length, 1);
  assert.equal(ok.quotes[0].channel, "call");
  const backwards = verifyQuotes([{ ref: "m3", text: "I can close in ten days… I want heavy rehab", about: ["rehab"] }], thread);
  assert.equal(backwards.quotes.length, 0);
});

test("the same sentence quoted twice is kept once", () => {
  const { quotes } = verifyQuotes([
    { ref: "m4", text: "Please send deals to my email going forward.", about: ["deals_by"] },
    { ref: "m4", text: "please send deals to my email going forward", about: ["deals_by"] },
  ], thread);
  assert.equal(quotes.length, 1);
});

test("a phone number or email inside a kept quote is masked, in the read and in a loaded one", () => {
  const t = { messages: [{ id: "p", at: "2026-09-01T00:00:00Z", dir: "them", channel: "sms", body: "Send deals to my partner at 206-555-0142 or deals@example.com, he buys Kent." }] };
  const { quotes } = verifyQuotes([{ ref: "m1", text: "Send deals to my partner at 206-555-0142 or deals@example.com, he buys Kent.", about: ["notes"] }], t);
  assert.equal(quotes[0].text, "Send deals to my partner at [phone] or [email], he buys Kent.");
  assert.equal(cleanRead({ quotes: [{ text: "call me (425) 555 0199 about Renton", at: "2026-09-01T00:00:00Z", channel: "sms" }] }).quotes[0].text, "call me [phone] about Renton");
  assert.equal(maskContact("I buy 3 to 4 houses a year under 450000"), "I buy 3 to 4 houses a year under 450000");
});

test("the model reads their words whole and ours cut short; a call nobody transcribed isn't there", () => {
  const long = { messages: [{ id: "x", at: "2026-08-01T00:00:00Z", dir: "us", channel: "sms", body: "word ".repeat(200) }, ...thread.messages] };
  const { text, refs } = threadForModel(long);
  assert.match(text, /^m1 2026-08-01 US sms: (word ){60,}.*…$/m);
  assert.ok(text.includes("nothing with septic"));
  assert.ok(text.includes("Speaker 2: Honestly I want heavy rehab"));
  assert.equal(Object.values(refs).some((m) => m.id === "c"), false); // the 4-second call
});

test("a thread of only our texts, reactions and missed calls has nothing to read", () => {
  assert.equal(hasTheirWords({ messages: [thread.messages[0], thread.messages[2]] }), false);
  assert.equal(hasTheirWords({ messages: [{ dir: "them", channel: "sms", body: "Liked “Hi Sam”" }] }), false);
  assert.equal(hasTheirWords(thread), true);
});

test("columns take what people write for a value, and drop what isn't one", () => {
  const f = normalizeFields({
    areas: ["Tacoma", "tacoma", "Lakewood"], property_types: ["single family", "duplex", "castle"],
    strategies: ["fix and flip", "BRRRR"], price_min: "450k", price_max: 200000, rehab: "gut",
    funding: ["hard"], lot_min: 0.25, status: "nope", deals_by: "SMS",
  });
  assert.deepEqual(f.areas, ["Tacoma", "Lakewood"]);
  assert.deepEqual(f.property_types, ["sfr", "multi_family"]);
  assert.deepEqual(f.strategies, ["flip", "brrrr"]);
  assert.equal(f.price_min, 200000); // a band said backwards is still the band
  assert.equal(f.price_max, 450000);
  assert.equal(f.rehab, "full_gut");
  assert.deepEqual(f.funding, ["hard_money"]);
  assert.equal(f.lot_min, 10890);
  assert.equal(f.status, null);
  assert.equal(f.deals_by, "text");
  assert.equal(f.notes.length, 0);
  assert.equal(toNumber("up to 400", { money: true }), null);
  assert.equal(toNumber("400", { money: true }), 400000);
  assert.equal(toNumber("$1.2M", { money: true }), 1200000);
});

test("a read keeps the verified quotes, the columns, and how far into the thread it got", () => {
  const read = normalizeRead({
    summary: "Cash flipper, Tacoma and Lakewood, up to 450k, heavy rehab.",
    fields: { areas: ["Tacoma", "Lakewood"], price_max: 450000, rehab: "heavy", dealbreakers: ["no septic"], beds_min: 3, deals_by: "email" },
    quotes: [
      { ref: "m2", text: "Mostly Tacoma and Lakewood. I’m cash up to 450k, nothing with septic.", about: ["areas", "price_max", "dealbreakers"] },
      { ref: "m3", text: "a made-up line they never said", about: ["notes"] },
    ],
  }, thread, { by: "model:test", at: "2026-11-02T12:00:00.000Z" });
  assert.equal(read.quotes.length, 1);
  assert.equal(read.stats.quotesDropped, 1);
  assert.equal(read.through, "2026-08-20T16:00:00.000Z");
  assert.equal(read.stats.callsTranscribed, 1);
  assert.equal(read.by, "model:test");
  assert.equal(lastSaidAt(read), "2026-08-01T17:05:00.000Z");
  // Back out of the store, the same read.
  assert.deepEqual(cleanRead(JSON.parse(JSON.stringify(read))), read);
});

test("a read is due again only when their thread has moved past it", () => {
  const read = { through: "2026-08-20T16:00:00.000Z" };
  assert.equal(readIsStale(read, "2026-08-20T16:00:00.000Z"), false);
  assert.equal(readIsStale(read, "2026-09-01T00:00:00.000Z"), true);
  assert.equal(readIsStale(null, "2026-09-01T00:00:00.000Z"), true);
  assert.equal(readIsStale(read, null), false);
});

test("Add to buy box files list values the record lacks and never overwrites a scalar a person set", () => {
  const read = { fields: normalizeFields({ areas: ["Tacoma", "Lakewood"], price_max: 450000, price_min: 150000, must_haves: ["garage"], dealbreakers: ["no septic"], volume: "3 a year" }) };
  const facts = readFacts(read, { have: { buybox_areas: ["tacoma"], buybox_price_max: "500000" } });
  assert.deepEqual(facts, [
    { key: "buybox_areas", value: "Lakewood" },
    { key: "buybox_price_min", value: "150000" },
    { key: "buybox_exclusions", value: "must have: garage" },
    { key: "buybox_exclusions", value: "no septic" },
  ]);
});

test("the table's columns and the search read the same words", () => {
  const read = normalizeRead({ summary: "Builder, ADUs in Ballard", fields: { strategies: ["adu_dadu"], price_max: 900000, areas: ["Ballard"] }, quotes: [{ ref: "m2", text: "Mostly Tacoma and Lakewood.", about: ["areas"] }] }, thread);
  const cols = readColumns(read);
  assert.equal(cols.strategies, "ADU / DADU");
  assert.equal(cols.price, "up to 900k");
  assert.equal(cols.quotes, 1);
  assert.match(readSearchText(read), /adu \/ dadu/);
  assert.match(readSearchText(read), /mostly tacoma and lakewood/);
  assert.equal(priceBand({ price_min: 200000, price_max: 1250000 }), "200k–1.25M");
});

test("the CSV holds every quote in one cell, quoted safely, newest first", () => {
  const read = normalizeRead({ summary: 'Says "cash", no septic', fields: { areas: ["Tacoma, WA"] }, quotes: [
    { ref: "m2", text: "Mostly Tacoma and Lakewood.", about: ["areas"] },
    { ref: "m4", text: "Please send deals to my email going forward.", about: ["deals_by"] },
  ] }, thread);
  const csv = readsCsv([{ contactId: "c1", name: "Sam Example", relationship: "talking", tier: "active", read }]);
  const [head, row] = csv.split("\r\n");
  assert.match(head, /^Name,Relationship,Tier,What they buy,Areas they buy/);
  assert.ok(row.startsWith('Sam Example,talking,active,"Says ""cash"", no septic","Tacoma, WA"'));
  const words = row.slice(row.indexOf('"2026-08-20'));
  assert.ok(words.indexOf("2026-08-20 (email)") < words.indexOf("2026-08-01 (text)"));
});

test("the answer schema asks for every column, so a strict model can't leave one out", () => {
  assert.deepEqual(READ_SCHEMA.properties.fields.required, READ_FIELD_KEYS);
  assert.equal(READ_SCHEMA.properties.fields.additionalProperties, false);
  assert.deepEqual(READ_SCHEMA.properties.quotes.items.properties.about.items.enum, READ_FIELD_KEYS);
});
