// gatekeeper-feed.test.mjs — where gatekeepers come from: the estate's house
// from the county's owner of record, the notice alert email read once, and
// the title officer on our own closings. Names are made up.
//
//   node --test gatekeeper-feed.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gatekeeper-feed-test-"));
process.env.DATA_DIR = DIR;
delete process.env.DATABASE_URL;

const { store } = await import("./store.js");
const { estateHouseSnohomish, findEstateHouse, readNoticeEmails, seedFromClosings, NOTICE_MAIL_CURSOR } = await import("./gatekeeper-feed.js");
await store.init();
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const parcelFetch = (features, seen = []) => async (url, opts) => {
  seen.push(new URLSearchParams(opts.body).get("where"));
  return { ok: true, json: async () => ({ features: features.map((attributes) => ({ attributes })) }) };
};

test("the estate's house is the one residential parcel in the decedent's name", async () => {
  const seen = [];
  const r = await estateHouseSnohomish({ decedent: "Margaret Anne Sample" }, { fetchImpl: parcelFetch([{ PARCEL_ID: "0042", SITUSLINE1: "2930 EXAMPLE AVE", SITUSCITY: "EVERETT", SITUSZIP: "98201", USECODE: "111" }], seen) });
  assert.equal(r.matches, 1);
  assert.equal(r.address, "2930 EXAMPLE AVE, EVERETT, WA 98201");
  assert.match(seen[0], /UPPER\(OWNERNAME\) LIKE 'SAMPLE MARGARET%'/, "the county files owners last name first");
  assert.match(seen[0], /USECODE LIKE '11%'/, "houses only");
});

test("a name that fits two houses is no house, not a guess", async () => {
  const r = await estateHouseSnohomish({ decedent: "John Smith" }, { fetchImpl: parcelFetch([
    { PARCEL_ID: "1", SITUSLINE1: "1 A ST", SITUSCITY: "EVERETT", SITUSZIP: "98201" },
    { PARCEL_ID: "2", SITUSLINE1: "2 B ST", SITUSCITY: "LYNNWOOD", SITUSZIP: "98036" },
  ]) });
  assert.equal(r.address, undefined);
  assert.equal(r.matches, 2);
  assert.match(r.reason, /more than one house/);
});

test("a quote in a name can't break the county query", async () => {
  const seen = [];
  await estateHouseSnohomish({ decedent: "Mary O'Brien" }, { fetchImpl: parcelFetch([], seen) });
  assert.match(seen[0], /LIKE 'OBRIEN MARY%'/);
});

test("a county with no owner lookup says so; a failed lookup is a miss to try again, not a crash", async () => {
  assert.deepEqual(await findEstateHouse({ county: "King", decedent: "A B" }), { house: null, reason: "no owner lookup for King" });
  const r = await findEstateHouse({ county: "Snohomish", decedent: "A B" }, { houseLookups: { Snohomish: async () => { throw new Error("HTTP 503"); } } });
  assert.equal(r.house, null);
  assert.equal(r.error, "HTTP 503");
});

const NOTICE = "PROBATE NOTICE TO CREDITORS NO. 25-4-07311-2 SEA SUPERIOR COURT OF WASHINGTON FOR KING COUNTY In the Matter of the Estate of HAROLD EXAMPLE, Deceased. The personal representative named below has been appointed. Date of First Publication: October 8, 2025 Personal Representative: Wendy Example Attorney for the Personal Representative: Paul Counsel, WSBA #40123 Address for Mailing or Service: Counsel Law PLLC, 1201 Third Ave, Seattle, WA 98101 (206) 555-0142";
const b64 = (s) => Buffer.from(s).toString("base64url");

test("the notice alert email is read by its sender only, and each message once", async () => {
  const LOC = "loc-mail";
  const queries = [];
  const gmail = {
    list: async (q) => { queries.push(q); return ["m1"]; },
    message: async () => ({ payload: { mimeType: "text/plain", body: { data: b64(NOTICE) } } }),
  };
  const settings = { outreachAutopilot: { gatekeepers: { noticeEmailFrom: "alerts@notices.test" } } };
  assert.deepEqual(await readNoticeEmails({ store, locationId: LOC, settings: {}, deps: { gmail } }), { skipped: "no notice email sender set" });
  const r = await readNoticeEmails({ store, locationId: LOC, settings, deps: { gmail } });
  assert.match(queries[0], /^from:alerts@notices\.test /);
  assert.equal(r.messages, 1);
  assert.equal(r.notices, 1);
  assert.equal(r.attorneys, 1);
  assert.ok(await store.getGatekeeper(LOC, "wsba:40123"));
  const again = await readNoticeEmails({ store, locationId: LOC, settings, deps: { gmail } });
  assert.equal(again.messages, 0, "already read");
  const cur = await store.getJobCursor(LOC, NOTICE_MAIL_CURSOR);
  assert.deepEqual(cur.doc.seen, ["m1"]);
});

test("the title officer we set on a deal is a gatekeeper, with the closing as the hook; the Settings default isn't", async () => {
  const LOC = "loc-closings";
  await store.createOffer({ id: "o-1", locationId: LOC, address: "12 Elm St, Kent, WA", status: "accepted",
    deal: { createdAt: "2026-10-01T00:00:00Z", stage: "closed", closingDate: "2026-10-20",
      parties: { title: { name: "Kim Rep", company: "Example Title", phone: "425-555-0101", email: "kim@exampletitle.test" } } } });
  await store.createOffer({ id: "o-2", locationId: LOC, address: "9 Oak St, Renton, WA", status: "accepted",
    deal: { createdAt: "2026-10-02T00:00:00Z", parties: { title: { company: "Rainier Escrow", phone: "2065550111" } } } });
  await store.createOffer({ id: "o-3", locationId: LOC, address: "3 Fir St, Auburn, WA", status: "accepted", deal: { createdAt: "2026-10-03T00:00:00Z" } });
  const r = await seedFromClosings({ store, locationId: LOC, settings: { psa: { titleCompany: "Default Title Co", titleOfficer: "Default Officer" } } });
  assert.equal(r.gatekeepers.created, 2, "the deal with only the Settings default adds nobody");
  const kim = await store.getGatekeeper(LOC, "e:kim@exampletitle.test");
  assert.equal(kim.kind, "title");
  assert.equal(kim.doc.firm, "Example Title");
  const escrow = await store.getGatekeeper(LOC, "p:2065550111");
  assert.equal(escrow.kind, "escrow");
  const hooks = await store.listGatekeeperHooks(LOC, { gkKey: "e:kim@exampletitle.test" });
  assert.equal(hooks[0].kind, "closing");
  assert.equal(hooks[0].doc.address, "12 Elm St, Kent, WA");
  assert.equal(hooks[0].doc.closedAt, "2026-10-20");
});
