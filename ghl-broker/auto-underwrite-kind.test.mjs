// auto-underwrite-kind.test.mjs — single-family houses only, for now.
//
// Matt, 2026-10-01: focus on single-family residences. An agent who texts a
// mobile home, a townhouse, a condo or a multi-family gets it held for a
// person — before the comps and the photo scan are bought — instead of an
// offer. "Underwrite anyway" on Today runs it again past that hold, and a run
// started from the offer form prices it anyway too.
//
//   node --test auto-underwrite-kind.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uw-kind-test-"));
delete process.env.DATABASE_URL;
delete process.env.AUTO_UNDERWRITE_ENABLED;

const { store } = await import("./store.js");
const { startUnderwrite, cancelJob, _resetJobs } = await import("./auto-underwrite.js");
const { KIND_HOLD } = await import("./shared/asset-type.js");
await store.init();

const ADDRESS = "1510 Maple Lane, Kent, WA 98030";
function stubFetch(homeType) {
  const calls = { detail: 0, search: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.includes("geocoding.geo.census.gov")) {
      return ok({ result: { addressMatches: [{ coordinates: { x: -122.227, y: 47.366 }, matchedAddress: "1510 MAPLE LN, KENT, WA, 98030" }] } });
    }
    if (u.includes("apify")) {
      const body = String(opts.body || "");
      if (body.includes("searchUrls")) { calls.search++; return ok([]); }
      calls.detail++;
      return ok([{ address: { streetAddress: "1510 Maple Ln", city: "Kent", state: "WA", zipcode: "98030" }, homeType,
        bedrooms: 3, bathrooms: 2, livingArea: 1440, yearBuilt: 1978, listingPhotos: [] }]);
    }
    return ok({ features: [] });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 10)); } return true; };
const client = { call: async () => ({}) };
const saved = { aiApiKey: "sk-ant-x", apifyToken: "apify-x" };

test("a mobile home an agent texts is held as not our kind, before any comp search is bought", async () => {
  _resetJobs();
  const { calls, restore } = stubFetch("MANUFACTURED");
  try {
    const { job } = await startUnderwrite({ client, locationId: "LOC-kind", saved, store, contactId: "agent-1", address: ADDRESS,
      deps: { createOffer: async () => { throw new Error("no offer for a mobile home"); } } });
    assert.ok(await until(() => ["held", "done", "error"].includes(job.status)), `still ${job.status}/${job.phase}`);
    assert.equal(job.status, "held", job.error || "");
    assert.ok(KIND_HOLD.test(job.held[0]), job.held[0]);
    assert.match(job.held[0], /a mobile home \(single-family only right now\)/);
    assert.equal(calls.search, 0, "no comp search was bought");
    const draft = await store.getOffer(job.offerId);
    assert.equal(draft.status, "draft");
    assert.equal(draft.draft.subjectInfo.homeType, "MANUFACTURED", "the editor opens knowing what it is");
  } finally { restore(); }
});

test("a single-family house goes on to the comps, and so does anything run from the offer form", async () => {
  for (const [homeType, fill] of [["SINGLE_FAMILY", false], ["TOWNHOUSE", true]]) {
    _resetJobs();
    const { calls, restore } = stubFetch(homeType);
    try {
      const { job } = await startUnderwrite({ client, locationId: `LOC-kind-${homeType}`, saved, store, contactId: "agent-2", address: ADDRESS, fill,
        deps: { createOffer: async () => { throw new Error("not reached in this test"); } } });
      assert.ok(await until(() => ["held", "done", "error"].includes(job.status) || calls.search > 0), `still ${job.status}/${job.phase}`);
      assert.ok(calls.search > 0, `${homeType}${fill ? " from the form" : ""} reached the comp search`);
      assert.ok(!(job.held || []).some((h) => KIND_HOLD.test(h)));
      // Stop it at the next phase boundary, before anything past the stubs.
      cancelJob(job.id);
      await until(() => job.status !== "running");
    } finally { restore(); }
  }
});

test("Underwrite anyway on a held mobile home runs the comps and replaces the held draft", async () => {
  _resetJobs();
  const { calls, restore } = stubFetch("MANUFACTURED");
  try {
    const held = (await startUnderwrite({ client, locationId: "LOC-kind-anyway", saved, store, contactId: "agent-3", address: ADDRESS,
      deps: { createOffer: async () => { throw new Error("no offer for a mobile home"); } } })).job;
    assert.ok(await until(() => held.status === "held"), `still ${held.status}/${held.phase}`);
    assert.equal(calls.search, 0);

    const { job } = await startUnderwrite({ client, locationId: "LOC-kind-anyway", saved, store, contactId: "agent-3", address: ADDRESS,
      anyKind: true, replaceOfferId: held.offerId,
      deps: { createOffer: async () => { throw new Error("not reached in this test"); } } });
    assert.ok(job, "the run started");
    assert.notEqual(job.id, held.id);
    assert.equal(job.fill, false, "not a form fill: it makes the offer itself");
    assert.ok(await until(() => ["held", "done", "error"].includes(job.status) || calls.search > 0), `still ${job.status}/${job.phase}`);
    assert.ok(calls.search > 0, "it reached the comp search");
    assert.ok(!(job.held || []).some((h) => KIND_HOLD.test(h)), "not held as not-our-kind again");
    assert.equal(job.replaceOfferId, held.offerId, "the held draft is the one it replaces");
    cancelJob(job.id);
    await until(() => job.status !== "running");
  } finally { restore(); }
});

test("a Retry of an Underwrite anyway run still prices it anyway", async () => {
  const { retryArgs } = await import("./auto-underwrite.js");
  assert.equal(retryArgs({ id: "uw-1", contactId: "c1", address: ADDRESS, anyKind: true, offerId: "draft1" }).anyKind, true);
  assert.equal(retryArgs({ id: "uw-2", contactId: "c1", address: ADDRESS, offerId: "draft1" }).anyKind, false);
});
