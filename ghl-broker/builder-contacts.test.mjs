// builder-contacts.test.mjs — the builder's own number: by name in the
// registry, by the county's entity, or the person behind a one-off LLC.
// Companies and people are made up.

import test from "node:test";
import assert from "node:assert/strict";
import { registryName, countyStreetPrefix, lniLookup, countyEntities, resolveBuilderContact, ENTITY_RX } from "./builder-contacts.js";

const stub = (routes) => async (url, init) => {
  for (const [rx, fn] of routes) if (rx.test(url)) { const body = fn(url, init); return { ok: true, status: 200, json: async () => body }; }
  return { ok: false, status: 404, json: async () => ({}) };
};
const lni = (rows) => [/data\.wa\.gov/, (url) => rows.filter((r) => decodeURIComponent(url).toUpperCase().includes(r.businessname.replace(/ LLC$/, "").toUpperCase()))];
const kc = (features) => [/kingcounty/, () => ({ features })];

test("a company name is looked up as the registry spells it, a street as the county does", () => {
  assert.equal(registryName("JayMarc Homes, LLC"), "JAYMARC HOMES");
  assert.equal(registryName("Adam Leland Homes Inc."), "ADAM LELAND HOMES");
  assert.equal(countyStreetPrefix("8458 NE 9th Street, Medina, WA 98039"), "8458 NE 9TH");
  assert.equal(countyStreetPrefix("2309 103rd Avenue NE, Bellevue, WA"), "2309 103RD");
  assert.ok(ENTITY_RX.test("8458 DEV LLC") && ENTITY_RX.test("Mystery Homes") && !ENTITY_RX.test("Pat Example"));
});

test("a builder the listing names comes back with the registry's phone and principal", async () => {
  const f = stub([lni([{ businessname: "MYSTERY HOMES LLC", phonenumber: "4255550100", primaryprincipalname: "SAM SAMPLE", city: "BELLEVUE", contractorlicensestatus: "Active" }])]);
  const r = await lniLookup("Mystery Homes", f);
  assert.deepEqual(r, { entity: "Mystery Homes LLC", phone: "+14255550100", principal: "Sam Sample", city: "Bellevue", source: "lni" });
  assert.equal(await lniLookup("Nobody Builds Here", f), null);
});

test("the county's sale chain names the entity that sold the new build, biggest sale first", async () => {
  const f = stub([kc([
    { attributes: { address: "8458 NE 9TH ST", SaleDate: 1770940800000, SalePrice: 6400000, Sellername: "PAT EXAMPLE", buyername: "LEE EXAMPLE" } },
    { attributes: { address: "8458 NE 9TH ST", SaleDate: 1718236800000, SalePrice: 6450000, Sellername: "8458 DEV LLC", selleradd1: "PO BOX 9", selleradd2: "BELLEVUE WA 98009", buyername: "PAT EXAMPLE" } },
    { attributes: { address: "8458 NE 9TH ST", SaleDate: 1650000000000, SalePrice: 2500000, Sellername: "OLD OWNER", buyername: "8458 DEV LLC", buyeradd1: "PO BOX 9", buyeradd2: "BELLEVUE WA 98009" } },
  ])]);
  const e = await countyEntities("8458 NE 9th Street, Medina, WA 98039", f);
  assert.equal(e.length, 2);
  assert.deepEqual([e[0].name, e[0].role, e[0].price, e[0].date], ["8458 DEV LLC", "seller", 6450000, "2024-06-13"]);
  assert.equal(e[1].role, "buyer");
});

test("no name and a one-off LLC: the registry doesn't know it, the skip trace on its mailing address finds the person, only when allowed", async () => {
  const f = stub([
    lni([]),
    kc([{ attributes: { address: "8458 NE 9TH ST", SaleDate: 1718236800000, SalePrice: 6450000, Sellername: "8458 DEV LLC", selleradd1: "9 PO BOX RD", selleradd2: "BELLEVUE WA 98009", buyername: "PAT EXAMPLE" } }]),
    [/tracerfy/, () => ({ hit: true, credits_deducted: 5, persons: [{ first_name: "Sam", last_name: "Sample", litigator: false, phones: [{ number: "4255550177", type: "Mobile", dnc: false, rank: 1 }] }] })],
  ]);
  const free = await resolveBuilderContact({ address: "8458 NE 9th Street, Medina, WA 98039", traceKey: "k", allowTrace: false, fetchFn: f });
  assert.deepEqual([free.entity, free.phone, free.source], ["8458 Dev LLC", "", "county"]);
  assert.deepEqual(free.exit, { price: 6450000, date: "2024-06-13" }, "the county's record of the builder's sale, not a later resale");
  const traced = await resolveBuilderContact({ address: "8458 NE 9th Street, Medina, WA 98039", traceKey: "k", allowTrace: true, fetchFn: f });
  assert.deepEqual([traced.entity, traced.phone, traced.principal, traced.source, traced.credits], ["8458 Dev LLC", "+14255550177", "Sam Sample", "trace", 5]);
});

test("a named builder wins over the county entity", async () => {
  const f = stub([
    lni([{ businessname: "MYSTERY HOMES LLC", phonenumber: "4255550100", primaryprincipalname: "SAM SAMPLE", city: "BELLEVUE", contractorlicensestatus: "Active" }]),
    kc([{ attributes: { address: "12 SUMMIT DR", SaleDate: 1718236800000, SalePrice: 4600000, Sellername: "SUMMIT 12 LLC", buyername: "PAT EXAMPLE" } }]),
  ]);
  const r = await resolveBuilderContact({ address: "12 Summit Dr, Clyde Hill, WA", builderName: "Mystery Homes", fetchFn: f });
  assert.equal(r.source, "lni");
  assert.equal(r.phone, "+14255550100");
  assert.equal(r.exit.price, 4600000);
});
