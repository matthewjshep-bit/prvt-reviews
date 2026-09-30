// line-route.test.mjs — GET /api/dashboard/line on the JSON store.
//
//   node --test line-route.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "line-route-test-"));
delete process.env.DATABASE_URL;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createDashboardRouter } = await import("./routes/dashboard.js");
const { lineFor, leakSummary } = await import("./line.js");

const LOC = "loc-line-route";
const app = express();
app.use(express.json());
const router = createDashboardRouter({ resolveLocation: () => ({ locationId: LOC, client: { call: async () => ({}) } }) });
app.use("/api/dashboard", router);
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(() => server.close());

const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const mk = (over) => store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: `a-${crypto.randomUUID().slice(0, 6)}`, statusHistory: [], createdAt: ago(10), ...over });

test("the line reports stations, an open offer with nothing scheduled, a stuck deal, the jobs, and what buyers paid, and changes no setting", async () => {
  await store.saveOfferSettings(LOC, { maoPctOfArv: 75, lineTargets: { offersPerDay: 12 } });
  const before = JSON.stringify(await store.getOfferSettings(LOC));
  // Follow-ups are off in these settings, so a sent offer has nothing coming.
  const open = await mk({ address: "1 Open St, Kent, WA 98031", status: "sent", cashAmount: 300000, sends: [{ ts: ago(8), channels: ["sms"] }] });
  await mk({ address: "2 Stuck St, Kent, WA 98031", status: "accepted", cashAmount: 250000,
    deal: { stage: "under_contract", createdAt: ago(5), stageHistory: [{ stage: "under_contract", ts: ago(5) }], investors: [], contractPrice: 250000, assignmentFee: 20000 } });
  await mk({ address: "3 Sold St, Kent, WA 98031", status: "accepted", cashAmount: 300000, arv: 500000, repairs: 50000,
    deal: { stage: "closed", createdAt: ago(40), stageHistory: [{ stage: "under_contract", ts: ago(40) }, { stage: "closed", ts: ago(3) }], investors: [], contractPrice: 300000, assignmentFee: 5000 } });
  await store.setJobCursor(LOC, "followUp", { at: ago(0.5), doc: { last: { finishedAt: ago(0.5), status: "done" } } });

  const r = await (await fetch(`${B}/api/dashboard/line`)).json();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.targets.offersPerDay, 12);
  assert.ok(r.stations.some((s) => s.key === "offered"), "Flow's stations");
  assert.deepEqual(r.leaks.offers.rows.map((x) => x.offerId), [open.id]);
  assert.equal(r.leaks.deals.byKind.deal_no_buyers, 1);
  assert.equal(r.leaks.deals.byKind.deal_no_dataroom, 1, "no package a day after contract");
  assert.equal(r.jobs.find((j) => j.name === "followUp").failed, false);
  assert.equal(r.jobs.find((j) => j.name === "dispo").never, true);
  assert.equal(r.pricing.setting, 75);
  assert.deepEqual(r.pricing.sold, { n: 1, medianPct: 71 }, "300k + 5k fee + 50k repairs on a 500k ARV");
  assert.equal(r.cycle.find((c) => c.key === "close").n, 1);
  assert.equal(JSON.stringify(await store.getOfferSettings(LOC)), before, "reading the line never writes settings");

  const again = await (await fetch(`${B}/api/dashboard/line`)).json();
  assert.equal(again.generatedAt, r.generatedAt, "cached a minute");
});

test("the audit's summary counts what fell off, not what waits on you", async () => {
  const line = await lineFor({ store, locationId: LOC, saved: (await store.getOfferSettings(LOC)) || {} });
  const s = leakSummary(line);
  assert.equal(s.offersNothing, 1);
  assert.equal(line.leaks.deals.byKind.deal_no_buyers, 1);
  assert.equal(line.leaks.deals.byKind.deal_no_dataroom, 1, "the nightly count reads the packages too");
  assert.equal(s.deals, line.leaks.deals.total);
  assert.equal(s.total, line.leakTotal);
});

// What went wrong (2026-09-30, first read on prod): Postgres trims the offer
// list to OFFER_LIST_FIELDS in SQL, which drops the ARV and the repairs, so
// every deal without a written post-mortem scored as "no ARV" and fell out:
// the Line showed 0 deals sold where Lessons showed 4. The JSON store keeps
// them, which is why the test above passed.
test("what buyers paid is read from the whole deal, not the offer list's trimmed row", async () => {
  const { OFFER_LIST_FIELDS } = await import("./shared/offer-status.js");
  const trim = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => OFFER_LIST_FIELDS.includes(k)));
  const pgLike = new Proxy(store, {
    get(t, k) {
      if (k === "listOffers") return async (loc, opts = {}) => (await t.listOffers(loc, opts)).map((o) => (opts.lean ? trim(o) : o));
      const v = t[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const line = await lineFor({ store: pgLike, locationId: LOC, saved: (await store.getOfferSettings(LOC)) || {} });
  assert.deepEqual(line.pricing.sold, { n: 1, medianPct: 71 });
  assert.deepEqual(line.pricing.rows.map((r) => r.street), ["3 Sold St"]);
});
