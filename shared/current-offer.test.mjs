import test from "node:test";
import assert from "node:assert/strict";
import {
  houseKey, pricedAt, resolveHouse, currentOffers, currentOfferFor, annotateCurrent,
  isSuperseded, ourComeDown, ourMoveUp, paperCheck, lastQuoteOnHouse, machineRaise, machineCut, holdNumber,
  floatRange, rangeWords, namedInRange,
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

// The first dry run against the live book (2026-09-25) held two houses it
// shouldn't have: "227K" for an offer of 227,552 is that offer said the way
// people text it, and "$507K ARV, $110K in rehab" is the math, not a price.
test("an offer's number said short, or the ARV and rehab behind it, is not a come-down", () => {
  const o = { cashAmount: 227552, createdAt: "2026-08-24T00:00:00Z" };
  assert.equal(ourComeDown(o, "[2026-08-25 10:00] US sms: We can do 227K cash, close in 14"), null);
  const p = { cashAmount: 259600, createdAt: "2026-08-24T00:00:00Z" };
  assert.equal(ourComeDown(p, "[2026-08-31 10:00] US sms: $507K ARV, $110K in rehab. Theres no margin"), null);
  assert.equal(ourComeDown(p, "[2026-08-31 10:00] US sms: ARV is 507K and repairs 110K"), null);
  assert.equal(ourComeDown(p, "[2026-08-31 10:00] US sms: with $110K of work we can do $235K").amount, 235000, "the price in the same line still counts");
  // The real ones still hold.
  assert.equal(ourComeDown({ cashAmount: 250562, createdAt: "2026-09-14T00:00:00Z" }, "[2026-09-16 10:00] US sms: im down to make an offer at $230K").amount, 230000);
});

// 336 SW 15th St, Chehalis (2026-09-25): we quoted 185k (and restated 186k),
// the agent said the floors were new, a re-underwrite landed at 192,250 and
// the bot texted "we can go around 192k" on its own. Her other listing's 173k
// sits in the same thread.
const CH = "336 SW 15th St, Chehalis, WA 98532";
const CH_THREAD = [
  "[2026-09-22 23:12] US sms: Good to know. On 336 SW 15th we'd likely land around 185k as-is with a quick close. Is that in the realm for the seller?",
  "[2026-09-22 23:51] US sms: On 1213 Rhobina we can likely do around 173k as-is with a quick close. Is that in the realm for the seller?",
  "[2026-09-25 17:20] US sms: Ran 336 SW 15th again and we can likely do around 186k as-is with a quick close. Does that work for the seller?",
  "[2026-09-26 00:38] THEM sms: He said they painted inside and put new floors in.",
  "[2026-09-26 00:40] US sms: Vacant and ready to close works for us. Can you float the 186 by him when you talk?",
].join("\n");
const REUNDERWRITE = { id: "70f8d3a9", address: CH, cashAmount: 192250, createdAt: "2026-09-26T00:42:31Z", status: "new",
  autoUnderwrite: { passed: true, compsUsedCount: 4 } };

test("a re-underwrite that came in above the number we already texted on the house is a raise nobody decided on", () => {
  const q = lastQuoteOnHouse(REUNDERWRITE, CH_THREAD);
  assert.equal(q.amount, 186000, "the last number texted on THIS house — not the other listing's 173k");
  assert.equal(machineRaise(REUNDERWRITE, CH_THREAD).amount, 186000);
  const check = paperCheck({ offer: REUNDERWRITE, transcript: CH_THREAD });
  assert.equal(check.ok, false);
  assert.equal(check.comeDown.amount, 186000, "the pane offers the re-quote at the number they have");
  assert.match(check.reason, /last texted 186K .* above it at \$192,250/);
});

test("a raise a person stood behind is theirs to make: a pin, a revision, a send, or a row they made", () => {
  assert.equal(machineRaise({ ...REUNDERWRITE, pin: { at: "2026-09-26T01:00:00Z" } }, CH_THREAD), null);
  assert.equal(machineRaise({ ...REUNDERWRITE, revisions: [{ ts: "2026-09-26T01:00:00Z", from: 190000, to: 192250 }] }, CH_THREAD), null);
  assert.equal(machineRaise({ ...REUNDERWRITE, sends: [{ ts: "2026-09-26T01:00:00Z" }] }, CH_THREAD), null);
  assert.equal(machineRaise({ ...REUNDERWRITE, autoUnderwrite: undefined }, CH_THREAD), null, "made by hand after the text");
  assert.equal(machineRaise({ ...REUNDERWRITE, autoUnderwrite: { ...REUNDERWRITE.autoUnderwrite, publishedAt: "2026-09-26T01:00:00Z" } }, CH_THREAD), null);
  // The machine's own row the text came off, said the way people text it, is not a raise.
  assert.equal(machineRaise({ ...REUNDERWRITE, cashAmount: 185500 }, CH_THREAD), null);
  assert.equal(machineRaise({ ...REUNDERWRITE, cashAmount: 180000 }, CH_THREAD), null, "going down is not a raise");
  // Nothing texted on this house yet: nothing to raise over.
  assert.equal(machineRaise({ ...REUNDERWRITE, address: "1213 Rhobina St, Centralia, WA 98531", cashAmount: 180000 }, CH_THREAD.split("\n").slice(0, 1).join("\n")), null);
});

// The Desk's counter row (2026-10-02): "Hold our number" re-states where we
// are. Woodcrest taught us the machine never names more than we sent; the
// hold is built from the lowest number we put to them, and only that.
test("Hold never names a number above what we sent", () => {
  const o = { id: "w", address: "17044 Woodcrest Dr NE, Bothell, WA 98011", cashAmount: 390000, createdAt: "2026-09-29T00:00:00Z", sends: [{ ts: "2026-09-30T00:00:00Z" }] };
  const h = holdNumber({ offer: o });
  assert.equal(h.amount, 390000);
  assert.equal(h.from, "book");
  assert.match(h.text, /hold at \$390,000/);
  assert.match(h.text, /^Appreciate you working it\. On 17044 Woodcrest Dr NE/);
  assert.equal(holdNumber({ offer: { ...o, cashAmount: 0 } }), null);
});

test("Hold uses the lower number we texted by hand after the offer", () => {
  const o = { id: "m", address: "1510 Maple Lane, Kent, WA 98030", cashAmount: 71075, createdAt: "2026-09-10T00:00:00Z", sends: [{ ts: "2026-09-10T01:00:00Z" }] };
  const h = holdNumber({ offer: o, transcript: "[2026-09-13 18:00] US sms: Can we do $65k actually on 1510 Maple Lane" });
  assert.equal(h.amount, 65000);
  assert.equal(h.from, "come_down");
  assert.doesNotMatch(h.text, /71/);
});

// Review, 2026-10-02: "Meet at…" re-quotes before the letter goes out. If the
// Send window is closed unsent, Hold must still hold at what they last saw.
test("Hold holds at the number that last went out, not a re-quote nobody sent", () => {
  const o = { id: "k", address: "23908 SE 168th St, Issaquah, WA 98027", cashAmount: 705000, createdAt: "2026-09-20T00:00:00Z",
    sends: [{ ts: "2026-09-27T00:00:00Z" }], revisions: [{ ts: "2026-10-02T21:00:00Z", from: 690000, to: 705000 }] };
  assert.equal(holdNumber({ offer: o }).amount, 690000);
  // Sent again at the new number: that's the number now.
  assert.equal(holdNumber({ offer: { ...o, sends: [...o.sends, { ts: "2026-10-02T22:00:00Z" }] } }).amount, 705000);
});

/* ---------- the math behind the number is not a number we quoted ---------- */

// Showing our work (2026-10-07) puts the ARV, the work and the costs in the
// same texts as our number. None of them is a price on the house.
const ELM = { id: "elm", contactId: "a", address: "12 Elm St, Renton, WA 98056", cashAmount: 295000, createdAt: "2026-10-01T00:00:00Z",
  status: "sent", sends: [{ ts: "2026-10-01T00:00:00Z" }] };
const MATH_REPLIES = [
  "On 12 Elm St we base it on around 500 it's worth fixed up, less about 50 of work, then about 38 to buy and resell and 26 to hold it 5 months plus our profit and risk, which lands us at 295.",
  "Sure, on 12 Elm St: around 500 all fixed up, about 38 in closing costs, 26 of holding, 50 for the work, and what's left is our profit and risk. That's how we get to 295.",
  "On 12 Elm St it's worth about 500 when it's done; we take off 38 to buy and resell it and around 26 carrying it, so we land at 295.",
];

test("the math in our text is never read as a price we quoted or a raise", () => {
  for (const text of MATH_REPLIES) {
    const t = `[2026-10-02 10:00] US sms: ${text}`;
    assert.equal(ourMoveUp(ELM, t), null, text);
    assert.equal(ourComeDown(ELM, t), null, text);
    assert.equal(lastQuoteOnHouse(ELM, t)?.amount, 295000, text);
    assert.equal(paperCheck({ offer: ELM, transcript: t }).ok, true, text);
  }
});

// A cheap house: an 80K offer on a 200K ARV with 40K of work. The table in
// our offer email names the renovation at half our number.
const CHEAP = { id: "cheap", contactId: "a", address: "9 Oak St, Tacoma, WA 98404", cashAmount: 80000, createdAt: "2026-10-01T00:00:00Z",
  status: "sent", sends: [{ ts: "2026-10-01T00:00:00Z" }] };

test("the math table in our offer email is never read as us coming down", () => {
  const email = "[2026-10-02 10:00] US email: Hi Sam, Please find our letter of intent on 9 Oak St attached — $80,000, close on your timeline. " +
    "How we got to the number: After-repair value $200,000 Closing costs, buying and reselling $14,780 Holding, 5 months $9,622 " +
    "Renovation budget $40,000 Profit & risk $55,598 Purchase price $80,000";
  assert.equal(ourComeDown(CHEAP, email), null);
  assert.equal(ourMoveUp(CHEAP, email), null);
  assert.equal(lastQuoteOnHouse(CHEAP, email)?.amount, 80000);
  assert.equal(paperCheck({ offer: CHEAP, transcript: email }).ok, true);
  assert.equal(holdNumber({ offer: CHEAP, transcript: email }).amount, 80000);
});

/* ---------- a range topped by our number (2026-10-07) ---------- */

test("a range we floated is never read as us coming down to its bottom", () => {
  for (const said of [
    "On 12 Elm St we'd likely land somewhere in the 280s to 295.",
    "On 12 Elm St we'd land somewhere around 280k to 295k.",
    "around 280 to 295 on 12 Elm St, if that's in the ballpark",
    "On 12 Elm St we'd be between 280 and 295.",
    "12 Elm St: $280,000-$295,000 is where we'd land",
  ]) {
    const t = `[2026-10-02 10:00] US sms: ${said}`;
    assert.equal(ourComeDown(ELM, t), null, said);
    assert.equal(lastQuoteOnHouse(ELM, t)?.amount, 295000, said);
    assert.equal(holdNumber({ offer: ELM, transcript: t }).amount, 295000, said);
    assert.equal(machineRaise(ELM, t), null, said);
    assert.equal(paperCheck({ offer: ELM, transcript: t }).ok, true, said);
  }
  // A lower number on its own is still us coming down.
  assert.equal(ourComeDown(ELM, "[2026-10-02 10:00] US sms: could we do 280k on 12 Elm St?")?.amount, 280000);
});

test("the range is topped by our number, rounded down, and words like a text", () => {
  assert.deepEqual(floatRange(295000, 5), { low: 280000, high: 295000, step: 10000 });
  assert.equal(rangeWords(floatRange(295000, 5)), "the 280s to 295");
  assert.deepEqual(floatRange(295240, 5), { low: 280000, high: 295000, step: 10000 }, "never above the book");
  assert.equal(rangeWords(floatRange(80000, 5)), "75 to 80");
  assert.equal(rangeWords(floatRange(407500, 5)), "the 380s to 407");
  assert.equal(rangeWords(floatRange(1250000, 5)), "1.18M to 1.25M");
  assert.equal(floatRange(0, 5), null);
});

test("a number they name inside our range is read as in range, never above", () => {
  const r = { low: 280000, high: 295000 };
  assert.equal(namedInRange({ range: r, message: "285 works for my seller" })?.amount, 285000);
  assert.equal(namedInRange({ range: r, message: "they'd do 287,500" })?.amount, 287500);
  assert.equal(namedInRange({ range: r, message: "the low 280s works" })?.amount, 280000);
  assert.equal(namedInRange({ range: r, message: "295 works" }), null, "the top is our number: a plain yes");
  assert.equal(namedInRange({ range: r, message: "they need 310" }), null, "above is a counter");
  assert.equal(namedInRange({ range: r, message: "closing in 14 days works" }), null);
});

test("'55k of lender holding costs' is a cost, not a price we quoted", () => {
  const t = "[2026-10-02 10:00] US sms: On 12 Elm St we base it on 69% of the 500k it's worth fixed up, less 50k of rehab work; the rest is 38k to buy and resell, 26k of lender holding costs, and our profit and risk margin. Landing in the 280s to 295.";
  assert.equal(ourComeDown(ELM, t), null);
  assert.equal(lastQuoteOnHouse(ELM, t)?.amount, 295000);
  assert.equal(paperCheck({ offer: ELM, transcript: t }).ok, true);
});

test("a number we floated is never cut without you — a re-run under what the agent last heard holds for a person", () => {
  const lower = { ...REUNDERWRITE, cashAmount: 162000 };
  assert.equal(machineCut(lower, CH_THREAD).amount, 186000);
  const check = paperCheck({ offer: lower, transcript: CH_THREAD });
  assert.equal(check.ok, false);
  assert.equal(check.cut.amount, 186000);
  assert.match(check.reason, /last texted 186K .* below it at \$162,000 — a person decides/);
  assert.equal(machineCut({ ...lower, revisions: [{ ts: "2026-09-26T01:00:00Z", from: 186000, to: 162000 }] }, CH_THREAD), null, "you revised it down yourself");
  assert.equal(machineCut({ ...lower, cashAmount: 185500 }, CH_THREAD), null, "the same number said the way people text it");
  assert.equal(machineCut({ ...lower, cashAmount: 192250 }, CH_THREAD), null, "going up is machineRaise's");
});
