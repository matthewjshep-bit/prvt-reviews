// buyer-import.test.mjs — a borrower list read into buyers, matched against
// GHL without creating anyone, and the timeline rows it records.

import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv, groupBuyers, contactIndex, matchBuyer, purchaseEvents } from "./buyer-import.js";
import { applyBuyboxFilters } from "./shared/buybox.js";

const HEADER = "First Name,Last Name,Primary Phone,Email,Most Recent Recording,Largest Origination ($),Next Maturity Date,Last Lender,Last Property Address,Last Property City,Last Property State,Last Loan Amount ($),Last Recording Date";
const row = (...v) => v.map((x) => `"${x}"`).join(",");
const CSV = [
  HEADER,
  row("Jimmy", "Tang", "(206) 228-4181", "jimmy@tangrei.com", "2026-07-20", "1950000.00", "2027-01-01", "Bellevue Financial", "10713 15TH AVE NE", "SEATTLE", "WA", "1732000.00", "2026-07-20"),
  row("Jimmy", "Tang", "(206) 228-4181", "jimmy@tangrei.com", "2026-04-02", "2411391.00", "2026-10-01", "Conventus", "1728 NE 148TH ST", "SHORELINE", "WA", "382500.00", "2026-04-02"),
  row("Amanda", "Suitt", "(276) 237-9468", "amandasmith@cutlerhomes.com", "2026-06-16", "792000.00", "2056-07-01", "Kiavi", "3424 26TH AVE NE", "OLYMPIA", "WA", "270300.00", "2026-06-16"),
  row("Brian", "Jessen", "(484) 901-9457", "ddawson@eastsidefunding.com", "2026-03-02", "990314.00", "", "Eastside Funding LLC", "2470 62ND AVE E", "FIFE", "WA", "590081.00", "2026-03-02"),
  row("", "", "", "", "2026-07-14", "206375.00", "", "Eastside Funding LLC", "10218 SW 140TH ST", "VASHON", "WA", "206375.00", "2026-07-14"),
].join("\n");

test("one buyer per person, every city tagged, lender emails dropped, unnamed rows skipped", () => {
  const { buyers, skipped } = groupBuyers(parseCsv(CSV));
  assert.equal(buyers.length, 3);
  assert.equal(skipped.length, 1);
  const jimmy = buyers.find((b) => b.lastName === "Tang");
  assert.equal(jimmy.purchases.length, 2);
  assert.deepEqual(jimmy.cities.sort(), ["seattle", "shoreline"]);
  assert.deepEqual(jimmy.regions.sort(), ["north-king", "seattle"]);
  assert.equal(jimmy.lastAt, "2026-07-20");
  assert.equal(buyers.find((b) => b.lastName === "Suitt").types[0], "rental");
  assert.deepEqual(buyers.find((b) => b.lastName === "Jessen").emails, []);
});

test("matching is phone, then email, then a unique name — never a guess", () => {
  const { buyers } = groupBuyers(parseCsv(CSV));
  const idx = contactIndex([
    { id: "c1", phone: "+12062284181", firstName: "Jimmy", lastName: "Tang" },
    { id: "c2", email: "amandasmith@cutlerhomes.com", firstName: "A", lastName: "S" },
    { id: "c3", firstName: "Brian", lastName: "Jessen" },
    { id: "c4", firstName: "Brian", lastName: "Jessen" },
  ]);
  assert.deepEqual(matchBuyer(buyers.find((b) => b.lastName === "Tang"), idx), { id: "c1", matchedBy: "phone" });
  assert.deepEqual(matchBuyer(buyers.find((b) => b.lastName === "Suitt"), idx), { id: "c2", matchedBy: "email" });
  assert.equal(matchBuyer(buyers.find((b) => b.lastName === "Jessen"), idx).reason, "more than one contact matches");
});

test("purchase events carry a stable dedupe key per property and date", () => {
  const { buyers } = groupBuyers(parseCsv(CSV));
  const ev = purchaseEvents(buyers.find((b) => b.lastName === "Tang").purchases);
  assert.equal(ev.length, 2);
  assert.equal(ev[0].type, "property_financed");
  assert.equal(ev[0].dedupeKey, "financed:10713 15th ave ne:2026-07-20");
  assert.equal(ev[0].data.lender, "Bellevue Financial");
});

test("an investor with no buy-box areas matches on the cities they financed in", () => {
  const investors = [
    { contactId: "a", name: "Kirkland flipper", buybox: {}, fallbackAreas: ["kirkland"] },
    { contactId: "b", name: "Tacoma flipper", buybox: {}, fallbackAreas: ["tacoma"] },
  ];
  const out = applyBuyboxFilters(investors, { areas: ["Kirkland"] });
  assert.deepEqual(out.map((i) => i.contactId), ["a"]);
});
