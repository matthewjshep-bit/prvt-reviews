// auto-underwrite-bricked.test.mjs — Bricked.ai prices the draft, Matt still sets the number.
//
// Matt, 2026-10-28: "just use a third-party API … not reinvent the wheel."
// With brickedOnDrafts on and a key saved, a draft or skeleton the
// conversation makes gets one Bricked lookup: its ARV and repairs go into the
// draft's inputs, its read rides along for the editor, and the draft stays
// held. Nothing is created, floated or texted.
//
//   node --test auto-underwrite-bricked.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uw-bricked-test-"));
delete process.env.DATABASE_URL;
delete process.env.AUTO_UNDERWRITE_ENABLED;

const { store } = await import("./store.js");
const { startUnderwrite, _resetJobs, brickedBasis, brickedLine, brickedOn } = await import("./auto-underwrite.js");
const { isDraftOnly, isSkeleton } = await import("./shared/offer-status.js");
const { _resetCompsCache } = await import("./comps-zillow.js");
await store.init();

const ADDRESS = "4417 Somerset Ln, Everett, WA 98203";
const BRICKED = {
  id: "b1", arv: 640000, arvConfidence: 0.82, cmv: 455000, cmvConfidence: 0.7, totalRepairCost: 85000,
  repairs: [{ repair: "Kitchen", description: "", cost: 45000 }, { repair: "Roof", description: "", cost: 40000 }],
  property: { address: { fullAddress: ADDRESS }, latitude: 47.95, longitude: -122.2,
    details: { bedrooms: 3, bathrooms: 2, squareFeet: 1500, yearBuilt: 1961 }, mls: { amount: 529000 } },
  comps: [
    { compType: "arv", selected: true, is_renovated: true, address: { fullAddress: "4421 Somerset Ln" }, details: { squareFeet: 1450, lastSaleAmount: 655000, lastSaleDate: 1750000000000 } },
    { compType: "arv", selected: true, is_renovated: true, address: { fullAddress: "4501 Somerset Ln" }, details: { squareFeet: 1520, lastSaleAmount: 630000 } },
    { compType: "arv", selected: true, is_renovated: false, address: { fullAddress: "4300 Elm St" }, details: { squareFeet: 1480, lastSaleAmount: 610000 } },
    { compType: "cmv", selected: true, is_renovated: false, address: { fullAddress: "4310 Elm St" }, details: { squareFeet: 1490, lastSaleAmount: 450000 } },
  ],
  shareLink: "https://bricked.ai/share/b1", dashboardLink: "https://bricked.ai/dash/b1",
};

function stubFetch({ bricked = { status: 200, body: BRICKED } } = {}) {
  _resetCompsCache();
  const calls = { bricked: [], detail: 0, search: 0, anthropic: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const reply = (status, body) => ({ ok: status < 300, status, statusText: "", json: async () => body, text: async () => JSON.stringify(body) });
    if (u.includes("api.bricked.ai")) { calls.bricked.push({ url: u, key: opts.headers?.["x-api-key"] }); return reply(bricked.status, bricked.body); }
    if (u.includes("anthropic")) { calls.anthropic++; return reply(200, {}); }
    if (u.includes("geocoding.geo.census.gov")) {
      return reply(200, { result: { addressMatches: [{ coordinates: { x: -122.2, y: 47.95 }, matchedAddress: "4417 SOMERSET LN, EVERETT, WA, 98203" }] } });
    }
    if (u.includes("apify")) {
      if (String(opts.body || "").includes("searchUrls")) { calls.search++; return reply(200, []); }
      calls.detail++;
      return reply(200, [{ address: { streetAddress: "4417 Somerset Ln", city: "Everett", state: "WA", zipcode: "98203" }, homeType: "SINGLE_FAMILY",
        bedrooms: 3, bathrooms: 1.75, livingArea: 1480, yearBuilt: 1962, price: 525000, homeStatus: "FOR_SALE", listingPhotos: [] }]);
    }
    return reply(200, { features: [] });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 10)); } return true; };
const ghl = () => { const sent = []; return { sent, client: { call: async (...a) => { sent.push(JSON.stringify(a)); return {}; } } }; };
const noOffer = { createOffer: async () => { throw new Error("a draft makes no offer"); },
  onOfferCreated: async () => { throw new Error("a draft floats nothing"); } };
const base = { aiApiKey: "sk-ant-x", apifyToken: "apify-x", brickedApiKey: "bk-123", brickedOnDrafts: true };
const settle = (job) => until(() => ["held", "done", "error"].includes(job.status));

test("Bricked is on only with the switch and a key both saved", () => {
  assert.equal(brickedOn(base), true);
  assert.equal(brickedOn({ ...base, brickedOnDrafts: false }), false);
  assert.equal(brickedOn({ ...base, brickedApiKey: "  " }), false);
  assert.equal(brickedOn({}), false);
});

test("with Bricked on, a skeleton opens priced by Bricked's ARV and repairs, and stays a held draft with nothing sent", async () => {
  _resetJobs();
  const { calls, restore } = stubFetch();
  const { sent, client } = ghl();
  try {
    const { job } = await startUnderwrite({ client, locationId: "LOC-bk-skel", saved: { ...base, autoUnderwriteMode: "skeleton" }, store,
      contactId: "agent-b1", address: ADDRESS, deps: noOffer });
    assert.ok(await settle(job), `still ${job.status}/${job.phase}`);
    assert.equal(job.status, "held", job.error || "");
    assert.equal(calls.bricked.length, 1, "one Bricked lookup");
    assert.equal(calls.bricked[0].key, "bk-123");
    assert.equal(new URL(calls.bricked[0].url).searchParams.get("address"), ADDRESS);
    assert.equal(calls.detail + calls.search, 0, "a skeleton still asks Zillow nothing");

    const draft = await store.getOffer(job.offerId);
    assert.equal(draft.status, "draft");
    assert.ok(isSkeleton(draft) && isDraftOnly(draft));
    assert.equal(draft.cashAmount, null, "no number on it until Matt saves one");
    assert.equal(draft.draft.inputs.arv, 640000, "Bricked's ARV is in the inputs");
    assert.equal(draft.draft.inputs.repairs, 85000, "and its repairs");
    assert.equal(draft.draft.subjectInfo.sqft, 1500, "the house's facts come from the same call");
    assert.equal(draft.draft.bricked.asIs, 455000);
    assert.equal(draft.draft.bricked.link, "https://bricked.ai/share/b1");
    assert.equal(draft.draft.bricked.comps.filter((c) => c.use === "arv" && c.renovated).length, 2);
    assert.equal(draft.autoUnderwrite.brickedArv, 640000, "the lean row carries the numbers for Today");
    assert.equal(draft.autoUnderwrite.brickedLink, "https://bricked.ai/share/b1");
    assert.match(draft.autoUnderwrite.subjectLine, /Bricked ARV \$640,000 · as-is \$455,000 · repairs \$85,000/);
    assert.match(draft.autoUnderwrite.arvBasis, /Bricked\.ai — 2 of 3 ARV comps renovated, 82% confidence/);
    assert.ok(sent.some((s) => s.includes("Bricked report: https://bricked.ai/share/b1")), "the GHL note links the report");
  } finally { restore(); }
});

test("with Bricked on in draft mode, the listing's facts stay Zillow's and the ARV and repairs are Bricked's", async () => {
  _resetJobs();
  const { calls, restore } = stubFetch();
  try {
    const { job } = await startUnderwrite({ client: ghl().client, locationId: "LOC-bk-draft", saved: { ...base, autoUnderwriteMode: "draft" }, store,
      contactId: "agent-b2", address: ADDRESS, deps: noOffer });
    assert.ok(await settle(job), `still ${job.status}/${job.phase}`);
    assert.equal(calls.bricked.length, 1);
    assert.equal(calls.search, 0, "no comp search bought");
    const draft = await store.getOffer(job.offerId);
    assert.equal(draft.draft.subjectInfo.sqft, 1480, "Zillow's facts");
    assert.equal(draft.draft.inputs.askingPrice, 525000);
    assert.equal(draft.draft.inputs.arv, 640000);
    assert.equal(draft.draft.inputs.repairs, 85000);
    assert.match(draft.autoUnderwrite.subjectLine, /^3 bd · 1\.75 ba · 1,480 sqft · built 1962 · listed \$525,000 · Bricked ARV \$640,000/);
  } finally { restore(); }
});

test("with the switch off, a saved key buys nothing and the skeleton is as it was", async () => {
  _resetJobs();
  const { calls, restore } = stubFetch();
  try {
    const { job } = await startUnderwrite({ client: ghl().client, locationId: "LOC-bk-off", saved: { ...base, brickedOnDrafts: false, autoUnderwriteMode: "skeleton" }, store,
      contactId: "agent-b3", address: ADDRESS, deps: noOffer });
    assert.ok(await settle(job), `still ${job.status}/${job.phase}`);
    assert.equal(calls.bricked.length, 0);
    const draft = await store.getOffer(job.offerId);
    assert.equal(draft.draft.inputs.arv, 0);
    assert.equal(draft.draft.bricked, undefined);
    assert.equal(draft.autoUnderwrite.brickedArv, undefined);
  } finally { restore(); }
});

test("when Bricked fails the draft is still made, and the run says why", async () => {
  _resetJobs();
  const { calls, restore } = stubFetch({ bricked: { status: 402, body: { error: "Subscription inactive" } } });
  const { sent, client } = ghl();
  try {
    const { job } = await startUnderwrite({ client, locationId: "LOC-bk-fail", saved: { ...base, autoUnderwriteMode: "skeleton" }, store,
      contactId: "agent-b4", address: ADDRESS, deps: noOffer });
    assert.ok(await settle(job), `still ${job.status}/${job.phase}`);
    assert.equal(job.status, "held");
    assert.equal(calls.bricked.length, 1);
    assert.ok(job.warnings.some((w) => /Bricked\.ai: Bricked 402: Subscription inactive/.test(w)), job.warnings.join(" | "));
    const draft = await store.getOffer(job.offerId);
    assert.equal(draft.draft.inputs.arv, 0);
    assert.ok(sent.some((s) => s.includes("No comps were pulled")), "the plain draft note");
  } finally { restore(); }
});

test("an address Bricked has no value for leaves a plain draft", async () => {
  _resetJobs();
  const { restore } = stubFetch({ bricked: { status: 200, body: { ...BRICKED, arv: null, cmv: null } } });
  try {
    const { job } = await startUnderwrite({ client: ghl().client, locationId: "LOC-bk-none", saved: { ...base, autoUnderwriteMode: "skeleton" }, store,
      contactId: "agent-b5", address: ADDRESS, deps: noOffer });
    assert.ok(await settle(job), `still ${job.status}/${job.phase}`);
    assert.ok(job.warnings.includes("Bricked.ai had no value for this address"));
    const draft = await store.getOffer(job.offerId);
    assert.equal(draft.draft.inputs.arv, 0);
    assert.equal(draft.autoUnderwrite.brickedArv, undefined);
  } finally { restore(); }
});

test("the basis and the line read plainly when Bricked leaves parts out", () => {
  assert.equal(brickedBasis({ comps: [] }), "Bricked.ai");
  assert.equal(brickedLine({ arv: 500000 }), "Bricked ARV $500,000");
  assert.equal(brickedLine({ asIs: 300000, repairs: 0 }), "as-is $300,000 · repairs $0");
});
