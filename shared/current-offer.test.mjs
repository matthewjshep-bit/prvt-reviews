import test from "node:test";
import assert from "node:assert/strict";
import {
  houseKey, pricedAt, resolveHouse, currentOffers, currentOfferFor, annotateCurrent,
  isSuperseded, ourComeDown, paperCheck,
} from "./current-offer.js";

// 13041 SE 208th St, Kent (2026-09-25): five rows on one house, the thread at
// ~400K since August, and the letter of intent went out at 416,500 off a July
// row. The rows as they stood on 9/22, before anyone touched them by hand.
const C = "kent-agent";
const ADDR = "13041 Southeast 208th Street, Kent, Washington 98031";
const KENT = [
  { id: "0ce76a5e", contactId: C, address: ADDR, cashAmount: 434456, createdAt: "2026-07-27T22:22:00Z" },
  { id: "13e02997", contactId: C, address: ADDR, cashAmount: 416500, createdAt: "2026-07-27T22:35:00Z", status: "sent",
    sends: [{ ts: "2026-07-27T22:44:00Z" }] },
  { id: "811a7afc", contactId: C, address: ADDR, cashAmount: 419556, createdAt: "2026-08-04T22:28:00Z", status: "passed",
    sends: [{ ts: "2026-08-04T22:30:00Z" }], statusHistory: [{ ts: "2026-08-31T22:34:57Z", status: "passed" }] },
  { id: "a261a006", contactId: C, address: ADDR, cashAmount: 421556, createdAt: "2026-08-05T16:31:00Z", status: "passed",
    sends: [{ ts: "2026-08-05T16:31:42Z" }], statusHistory: [{ ts: "2026-08-31T22:34:55Z", status: "passed" }] },
  { id: "218b6402", contactId: C, address: ADDR, cashAmount: 402687, createdAt: "2026-08-21T16:28:00Z", status: "draft", draft: {} },
];
const THREAD = [
  "[2026-08-05 16:31] US sms: here's our revised written cash offer on 13041 Southeast 208th Street — $421,556.26, as-is",
  "[2026-08-07 20:57] THEM sms: she's firm",
  "[2026-08-07 20:57] US sms: our calculation puts us back at $390-400K.",
  "[2026-08-21 16:29] US sms: is the seller open to an offer at $400K",
  "[2026-09-25 02:04] US sms: We're still at 400 as-is, cash, quick close.",
].join("\n");

test("the offer we last sent is current, not the July one the counter landed on", () => {
  const { current, superseded } = resolveHouse(KENT);
  assert.equal(current.id, "a261a006");
  assert.deepEqual(superseded.map((o) => o.id).sort(), ["0ce76a5e", "13e02997", "811a7afc"]);
});

test("a draft is never current, and a house of only drafts has none", () => {
  assert.equal(resolveHouse([KENT[4]]).current, null);
  assert.equal(annotateCurrent(KENT).find((o) => o.id === "218b6402").isCurrent, undefined);
});

test("a re-priced offer is current even though it was created first", () => {
  const revised = { ...KENT[1], revisions: [{ ts: "2026-09-20T00:00:00Z", from: 416500, to: 398000 }], cashAmount: 398000 };
  assert.equal(resolveHouse([revised, KENT[2], KENT[3]]).current.id, "13e02997");
  assert.equal(pricedAt(revised), Date.parse("2026-09-20T00:00:00Z"));
});

test("a status change is not a price move", () => {
  const passedLater = { ...KENT[1], status: "passed", statusAt: "2026-09-24T00:00:00Z", statusHistory: [{ ts: "2026-09-24T00:00:00Z", status: "passed" }] };
  assert.equal(resolveHouse([passedLater, KENT[3]]).current.id, "a261a006");
});

test("a pin holds until a sibling is sent", () => {
  const pinned = { ...KENT[0], pin: { at: "2026-09-01T00:00:00Z", by: "operator" } };
  assert.equal(resolveHouse([pinned, KENT[1], KENT[3]]).current.id, "0ce76a5e");
  assert.equal(resolveHouse([pinned, KENT[1], KENT[3]]).pinned, true);
  const sentAfter = { ...KENT[3], sends: [...KENT[3].sends, { ts: "2026-09-02T00:00:00Z" }] };
  assert.equal(resolveHouse([pinned, KENT[1], sentAfter]).current.id, "a261a006");
  assert.equal(resolveHouse([{ ...pinned, pin: { at: "2026-09-01T00:00:00Z", off: true } }, KENT[3]]).current.id, "a261a006", "an unpinned row is back on the rule");
});

test("a deal on the house is current whatever else was sent", () => {
  const deal = { ...KENT[0], deal: { stage: "under_contract" } };
  assert.equal(resolveHouse([deal, ...KENT.slice(1)]).current.id, "0ce76a5e");
  const fell = { ...KENT[1], deal: { stage: "fell_through" } };
  assert.ok(!resolveHouse([deal, fell, KENT[3]]).superseded.includes(fell), "a deal is never superseded");
});

test("one agent, two houses: each has its own current, and no house named picks neither", () => {
  const other = { id: "x1", contactId: C, address: "13045 SE 208th St, Kent, WA 98031", cashAmount: 250000, createdAt: "2026-09-01T00:00:00Z" };
  const book = [...KENT, other];
  assert.equal(currentOffers(book).length, 2);
  assert.equal(currentOfferFor(book, { contactId: C, address: "13041 SE 208th St" }).id, "a261a006");
  assert.equal(currentOfferFor(book, { contactId: C, address: "13045 Southeast 208th Street, Kent" }).id, "x1");
  assert.equal(currentOfferFor(book, { contactId: C }), null);
  assert.equal(currentOfferFor(KENT, { contactId: C }).id, "a261a006", "one house needs no address");
  assert.equal(currentOfferFor(book, { contactId: C, address: "99 Elsewhere Rd" }), null);
  assert.equal(currentOfferFor(book, { contactId: "someone-else", address: ADDR }), null);
  assert.equal(houseKey("13041 SE 208th St"), houseKey(ADDR));
});

test("annotateCurrent marks the live row and says what superseded the rest", () => {
  const rows = annotateCurrent(KENT);
  const byId = Object.fromEntries(rows.map((o) => [o.id, o]));
  assert.equal(byId.a261a006.isCurrent, true);
  assert.equal(byId["13e02997"].isCurrent, false);
  assert.equal(byId["13e02997"].supersededBy.id, "a261a006");
  assert.equal(byId["13e02997"].supersededBy.cashAmount, 421556);
  assert.equal(KENT[1].isCurrent, undefined, "inputs untouched");
  assert.equal(isSuperseded(KENT[1], KENT), true);
  assert.equal(isSuperseded(KENT[3], KENT), false);
});

test("the LOI is held when we texted 400K after the offer said 416,500", () => {
  // The row the bot actually sent: superseded on the house, and stale on its own.
  const july = paperCheck({ offer: KENT[1], offers: KENT, transcript: THREAD });
  assert.equal(july.ok, false);
  assert.match(july.reason, /isn't the current offer/);
  // The current row: we came down to 390K–400K after it went out.
  const current = paperCheck({ offer: KENT[3], offers: KENT, transcript: THREAD });
  assert.equal(current.ok, false);
  assert.equal(current.comeDown.amount, 400000);
  assert.match(current.reason, /we texted 400K on 2026-08-07 after this offer's \$421,556/);
  // Re-quoted at our number after the last text: paper may go.
  const requoted = { ...KENT[3], cashAmount: 400000, revisions: [{ ts: "2026-09-25T03:00:00Z", from: 421556, to: 400000 }] };
  assert.equal(paperCheck({ offer: requoted, offers: [requoted], transcript: THREAD }).ok, true);
});

test("the offer's own letter and a rounded restatement are not a come-down", () => {
  const o = { cashAmount: 71075, createdAt: "2026-09-15T00:00:00Z" };
  assert.equal(ourComeDown(o, "[2026-09-16 10:00] US sms: still good at 71k as-is"), null);
  assert.equal(ourComeDown(o, "[2026-09-16 10:00] US sms: here's our letter of intent — $65,000"), null);
  assert.equal(ourComeDown(o, "[2026-09-16 10:00] US sms: Can we do $65k actually").amount, 65000);
  assert.equal(ourComeDown(o, "[2026-09-14 10:00] US sms: Can we do $65k actually"), null, "before the offer moved");
});

test("a held paper stays held until the offer is re-priced or sent", async () => {
  const { paperHeldNow } = await import("./current-offer.js");
  const held = { ...KENT[3], paperHeld: { at: "2026-09-25T02:07:34Z", reason: "we texted 400K", amount: 400000 } };
  assert.equal(paperHeldNow(held).amount, 400000);
  assert.equal(paperHeldNow({ ...held, revisions: [{ ts: "2026-09-25T03:00:00Z", from: 421556, to: 400000 }] }), null);
  assert.equal(paperHeldNow(KENT[3]), null);
});
