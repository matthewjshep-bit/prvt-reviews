// auto-underwrite-draft-only.test.mjs — the app makes the draft, Matt prices it.
//
// Matt, 2026-10-16, after the review of 363 runs and their threads: "the
// biggest help is when an address is identified a draft offer is created …
// I can then go in and quickly do an underwrite myself … I usually have to do
// the comps." With autoUnderwriteMode "draft", a house an agent names stops
// after the listing's facts: a held draft with the agent and the address, no
// comp search bought, no photo scan, no offer, nothing texted. A run a person
// starts is still the full machine.
//
//   node --test auto-underwrite-draft-only.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uw-draft-only-test-"));
delete process.env.DATABASE_URL;
delete process.env.AUTO_UNDERWRITE_ENABLED;

const { store } = await import("./store.js");
const { startUnderwrite, cancelJob, _resetJobs } = await import("./auto-underwrite.js");
const { KIND_HOLD } = await import("./shared/asset-type.js");
const { isDraftOnly, isSkeleton, DRAFT_ONLY_RX } = await import("./shared/offer-status.js");
const { underwriteMode } = await import("./shared/offer-calc.js");
// The comp search is cached a day by URL; every test here buys its own.
const { _resetCompsCache } = await import("./comps-zillow.js");
await store.init();

const ADDRESS = "4417 Somerset Ln, Everett, WA 98203";
function stubFetch(homeType = "SINGLE_FAMILY", more = {}) {
  _resetCompsCache();
  const calls = { detail: 0, search: 0, anthropic: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.includes("anthropic")) { calls.anthropic++; return ok({}); }
    if (u.includes("geocoding.geo.census.gov")) {
      return ok({ result: { addressMatches: [{ coordinates: { x: -122.2, y: 47.95 }, matchedAddress: "4417 SOMERSET LN, EVERETT, WA, 98203" }] } });
    }
    if (u.includes("apify")) {
      const body = String(opts.body || "");
      if (body.includes("searchUrls")) { calls.search++; return ok([]); }
      calls.detail++;
      return ok([{ address: { streetAddress: "4417 Somerset Ln", city: "Everett", state: "WA", zipcode: "98203" }, homeType,
        bedrooms: 3, bathrooms: 1.75, livingArea: 1480, yearBuilt: 1962, price: 525000, homeStatus: "FOR_SALE",
        listingPhotos: [], ...more }]);
    }
    return ok({ features: [] });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 10)); } return true; };
const client = { call: async () => ({}) };
const draftOnly = { aiApiKey: "sk-ant-x", apifyToken: "apify-x", autoUnderwriteMode: "draft" };
const noOffer = { createOffer: async () => { throw new Error("draft only makes no offer"); },
  onOfferCreated: async () => { throw new Error("draft only floats nothing"); } };

test("the mode reads draft only when it says so, and full otherwise", () => {
  assert.equal(underwriteMode({ autoUnderwriteMode: "draft" }), "draft");
  assert.equal(underwriteMode({ autoUnderwriteMode: " Draft " }), "draft");
  for (const v of [undefined, "", "full", "anything"]) assert.equal(underwriteMode({ autoUnderwriteMode: v }), "full");
  assert.equal(underwriteMode(), "full");
});

test("with draft only on, a house an agent names becomes a draft for Matt to price — no comp search, no photo scan, no offer", async () => {
  _resetJobs();
  const { calls, restore } = stubFetch();
  try {
    const { job } = await startUnderwrite({ client, locationId: "LOC-draft", saved: draftOnly, store, contactId: "agent-d1",
      message: "Needs a new roof and the kitchen is gutted", address: ADDRESS, deps: noOffer });
    assert.ok(await until(() => ["held", "done", "error"].includes(job.status)), `still ${job.status}/${job.phase}`);
    assert.equal(job.status, "held", job.error || "");
    assert.match(job.held[0], DRAFT_ONLY_RX);
    assert.equal(calls.search, 0, "no comp search was bought");
    assert.equal(calls.anthropic, 0, "no photo scan (and no address read: the address came with the request)");
    assert.equal(calls.detail, 1, "only the listing's facts were looked up");

    const draft = await store.getOffer(job.offerId);
    assert.equal(draft.status, "draft");
    assert.ok(isDraftOnly(draft));
    assert.equal(draft.autoUnderwrite.draftOnly, true);
    assert.equal(draft.cashAmount, null, "no number on it");
    assert.equal(draft.contactId, "agent-d1", "the agent it's for");
    assert.match(draft.address, /^4417 Somerset Ln/);
    assert.equal(draft.draft.subjectInfo.beds, 3, "the editor opens on the listing's facts");
    assert.equal(draft.draft.subjectInfo.sqft, 1480);
    assert.equal(draft.draft.inputs.askingPrice, 525000, "the list price is filled in");
    assert.equal(draft.draft.comps.result, null, "no comps on it — those are Matt's");
    assert.match(draft.autoUnderwrite.subjectLine, /3 bd · 1\.75 ba · 1,480 sqft · built 1962 · listed \$525,000/);
    assert.match(draft.autoUnderwrite.message, /new roof/, "what the agent said rides on the row");
  } finally { restore(); }
});

test("draft only still holds a mobile home as not our kind", async () => {
  _resetJobs();
  const { calls, restore } = stubFetch("MANUFACTURED");
  try {
    const { job } = await startUnderwrite({ client, locationId: "LOC-draft-kind", saved: draftOnly, store, contactId: "agent-d2", address: ADDRESS, deps: noOffer });
    assert.ok(await until(() => ["held", "done", "error"].includes(job.status)), `still ${job.status}/${job.phase}`);
    assert.ok(KIND_HOLD.test(job.held[0]), job.held[0]);
    assert.equal(calls.search, 0);
    const draft = await store.getOffer(job.offerId);
    assert.equal(isDraftOnly(draft), false, "a not-our-kind hold is that, not a draft to price");
  } finally { restore(); }
});

test("a run a person starts is still the full machine with draft only on", async () => {
  for (const [label, extra] of [["Re-run / Retry", { full: true }], ["Underwrite anyway", { anyKind: true }], ["the editor", { fill: true }]]) {
    _resetJobs();
    const { calls, restore } = stubFetch();
    try {
      const { job } = await startUnderwrite({ client, locationId: `LOC-draft-person-${label}`, saved: draftOnly, store, contactId: "agent-d3", address: ADDRESS,
        ...extra, deps: { createOffer: async () => { throw new Error("not reached in this test"); } } });
      assert.ok(await until(() => ["held", "done", "error"].includes(job.status) || calls.search > 0), `${label}: still ${job.status}/${job.phase}`);
      assert.ok(calls.search > 0, `${label} reached the comp search (${job.status}/${job.phase} ${JSON.stringify(job.held)} ${job.error || ""} dup:${job.duplicateOf || ""})`);
      assert.ok(!(job.held || []).some((h) => DRAFT_ONLY_RX.test(h)), `${label} wasn't stopped at the draft`);
      cancelJob(job.id);
      await until(() => job.status !== "running");
    } finally { restore(); }
  }
});

test("with the mode on full, an agent's house goes on to the comps as before", async () => {
  _resetJobs();
  const { calls, restore } = stubFetch();
  try {
    const { job } = await startUnderwrite({ client, locationId: "LOC-draft-full", saved: { ...draftOnly, autoUnderwriteMode: "full" }, store,
      contactId: "agent-d4", address: ADDRESS, deps: { createOffer: async () => { throw new Error("not reached in this test"); } } });
    assert.ok(await until(() => ["held", "done", "error"].includes(job.status) || calls.search > 0), `still ${job.status}/${job.phase}`);
    assert.ok(calls.search > 0, `${job.status}/${job.phase} ${JSON.stringify(job.held)} ${job.error || ""} dup:${job.duplicateOf || ""}`);
    cancelJob(job.id);
    await until(() => job.status !== "running");
  } finally { restore(); }
});

test("the number Matt prices on a draft goes to the agent as his number, not a what-do-you-think-it's-worth", async () => {
  const { leadsWithNumber, floatStance, chooseProactiveKind } = await import("./reply-agent.js");
  const { normalizeConversationAi } = await import("./shared/conversation-ai.js");
  const config = normalizeConversationAi({ enabled: true, parties: { agent: { realmCheck: { enabled: true, leadWhenConfident: true, highStakes: { enabled: true, overAmount: 500000 } } } } });
  // As POST /api/offers with a draftId leaves it: published, approved at his number.
  const at = "2026-10-16T20:00:00.000Z";
  const offer = { id: "o1", status: "new", cashAmount: 311000, address: "4417 Somerset Ln, Everett, WA 98203",
    autoUnderwrite: { draftOnly: true, leadSource: "agent_brought", held: ["ready for your comps — the app made the draft, you price it"], publishedAt: at },
    approved: { amount: 311000, at, by: "publish" } };
  const stance = floatStance({ offer, config });
  assert.equal(stance.mode, "firm", "a house the agent brought, but the number is his: no range");
  const lead = leadsWithNumber({ offer, config, stance });
  assert.equal(lead, true);
  assert.equal(chooseProactiveKind({ leadWithNumber: lead, address: offer.address }), "realm_check");
});

/* ---------- the house their text is about (2026-10-16) ---------- */

test("a run never prices the house the thread was on when their text is about another street", async () => {
  // 311 R St NE was drafted and floated off "Address - 129 39 SE 188th ST Renton".
  _resetJobs();
  const { calls, restore } = stubFetch();
  try {
    const { job } = await startUnderwrite({ client, locationId: "LOC-other-street", saved: draftOnly, store, contactId: "agent-o1",
      message: "Address - 129 39 SE 188th ST Renton - He is asking 650k because he is paying commissions.",
      address: "311 R St NE, Auburn, WA 98002", deps: noOffer });
    assert.ok(await until(() => ["held", "done", "error"].includes(job.status)), `still ${job.status}/${job.phase}`);
    assert.equal(job.status, "held", job.error || "");
    assert.match(job.held[0], /^couldn't locate "SE 188th ST" on the map — their text is about it, not 311 R St NE/);
    assert.equal(calls.detail + calls.search, 0, "nothing looked up for the wrong house");
    const draft = await store.getOffer(job.offerId);
    assert.equal(draft.address, "SE 188th ST", "the draft is for the street they named");
  } finally { restore(); }
});

test("a text that names the same street, or none, prices the house as before", async () => {
  for (const [i, message, address] of [
    [1, "311 R St NE needs paint and a roof", "311 R St NE, Auburn, WA 98002"],
    [2, "Needs a new roof and the kitchen is gutted", ADDRESS],
  ]) {
    _resetJobs();
    const { calls, restore } = stubFetch();
    try {
      const { job } = await startUnderwrite({ client, locationId: `LOC-same-street-${i}`, saved: draftOnly, store, contactId: "agent-o2",
        message, address, deps: noOffer });
      assert.ok(await until(() => ["held", "done", "error"].includes(job.status)), `still ${job.status}/${job.phase}`);
      assert.ok(!/couldn't locate/.test(job.held?.[0] || ""), job.held?.[0]);
      assert.equal(calls.detail, 1, message);
    } finally { restore(); }
  }
});

/* ---------- skeleton (2026-10-19) ---------- */
// Matt: "when someone mentions a property can we make a draft for that (just
// agent/address is fine, NO AUTOUNDERWRITE)". Not even the listing's facts.

const skeleton = { ...draftOnly, autoUnderwriteMode: "skeleton", autoUnderwriteDailyCap: 1 };

test("with skeleton on, a house an agent names becomes a draft with just the agent and the address — nothing looked up, nothing bought", async () => {
  assert.equal(underwriteMode({ autoUnderwriteMode: "skeleton" }), "skeleton");
  _resetJobs();
  const { calls, restore } = stubFetch();
  try {
    const { job } = await startUnderwrite({ client, locationId: "LOC-skel", saved: skeleton, store, contactId: "agent-s1",
      message: "Got another one, 4417 Somerset Ln, needs everything", address: ADDRESS, deps: noOffer });
    assert.ok(await until(() => ["held", "done", "error"].includes(job.status)), `still ${job.status}/${job.phase}`);
    assert.equal(job.status, "held", job.error || "");
    assert.equal(calls.detail + calls.search + calls.anthropic, 0, "no Zillow facts, no comps, no photo scan");
    const draft = await store.getOffer(job.offerId);
    assert.equal(draft.status, "draft");
    assert.equal(draft.contactId, "agent-s1");
    assert.match(draft.address, /^4417 Somerset Ln/);
    assert.equal(draft.cashAmount, null);
    assert.ok(isSkeleton(draft));
    assert.ok(isDraftOnly(draft), "the same Price it row as a draft");
  } finally { restore(); }
});

test("a skeleton doesn't spend the day's cap on runs, and a mobile home isn't held as not our kind — nothing was looked up to say so", async () => {
  _resetJobs();
  const { calls, restore } = stubFetch("MANUFACTURED");
  try {
    for (const [i, address] of [[1, ADDRESS], [2, "88 Alder St, Everett, WA 98203"], [3, "1412 Pine St, Everett, WA 98203"]]) {
      const { job, skipped } = await startUnderwrite({ client, locationId: "LOC-skel-cap", saved: skeleton, store, contactId: `agent-s${i + 1}`, address, deps: noOffer });
      assert.equal(skipped || null, null, `#${i}: ${skipped}`);
      assert.ok(await until(() => ["held", "done", "error"].includes(job.status)), `#${i} still ${job.status}/${job.phase}`);
      assert.ok(isSkeleton(await store.getOffer(job.offerId)), `#${i} ${job.held?.[0]}`);
    }
    assert.equal(calls.detail, 0);
  } finally { restore(); }
});

test("a run a person starts is still the full machine with skeleton on", async () => {
  _resetJobs();
  const { calls, restore } = stubFetch();
  try {
    const { job } = await startUnderwrite({ client, locationId: "LOC-skel-person", saved: { ...skeleton, autoUnderwriteDailyCap: 50 }, store, contactId: "agent-s9", address: ADDRESS,
      full: true, deps: { createOffer: async () => { throw new Error("not reached in this test"); } } });
    assert.ok(await until(() => ["held", "done", "error"].includes(job.status) || calls.search > 0), `still ${job.status}/${job.phase}`);
    assert.ok(calls.search > 0, `${job.status}/${job.phase} ${JSON.stringify(job.held)}`);
    cancelJob(job.id);
    await until(() => job.status !== "running");
  } finally { restore(); }
});

test("skeletons made today don't fill the cap a run you start yourself is held to", async () => {
  const { countToday } = await import("./auto-underwrite.js");
  _resetJobs();
  const { restore } = stubFetch();
  try {
    const { job } = await startUnderwrite({ client, locationId: "LOC-skel-count", saved: skeleton, store, contactId: "agent-c1", address: ADDRESS, deps: noOffer });
    assert.ok(await until(() => ["held", "done", "error"].includes(job.status)));
    assert.equal(await countToday({ store, locationId: "LOC-skel-count" }), 0);
  } finally { restore(); }
});

/* ---------- a flyer's house, and one house per link (2026-10-22) ---------- */
// The referee reads the thread for the house mentioned last. A house read off
// a flyer is never in the thread's words, so any older house the agent typed
// "wins" — and the draft for the flyer's house came out with the old one.

const OLD = "22 Birch Ave, Everett, WA 98201";
function threadAbout(text) {
  return { call: async (p) => {
    if (p.includes("/conversations/search")) return { conversations: [{ id: "cv1" }] };
    if (p.includes("/messages")) return { messages: { messages: [
      { id: "m1", direction: "inbound", messageType: "TYPE_SMS", body: text, dateAdded: new Date(Date.now() - 3600000).toISOString() },
    ] } };
    return {};
  } };
}

test("a house read off a flyer they sent becomes the draft, not the older house the thread talks about", async () => {
  _resetJobs();
  const { restore } = stubFetch();
  try {
    await store.appendContactEvents("LOC-photo", "agent-p1", [{ type: "subject_property_set", party: "agent", at: new Date(Date.now() - 7200000).toISOString(), address: OLD, source: "conversation" }]);
    const { job } = await startUnderwrite({ client: threadAbout("22 Birch Ave is still on, needs a roof"), locationId: "LOC-photo", saved: skeleton, store, contactId: "agent-p1",
      message: `[photo → ${ADDRESS}]`, address: ADDRESS, deps: noOffer });
    assert.ok(await until(() => ["held", "done", "error"].includes(job.status)), `still ${job.status}/${job.phase}`);
    assert.match((await store.getOffer(job.offerId)).address, /^4417 Somerset Ln/, job.warnings?.join("; "));
  } finally { restore(); }
});

test("two links in one text make two drafts, each its own house, not two of the last link", async () => {
  _resetJobs();
  const { restore } = stubFetch();
  try {
    const both = `[listing link → ${ADDRESS}]\n[listing link → 88 Alder St, Everett, WA 98203]`;
    const { job } = await startUnderwrite({ client, locationId: "LOC-links", saved: skeleton, store, contactId: "agent-l1",
      message: `https://redf.in/a https://redf.in/b\n${both}`, address: ADDRESS, deps: noOffer });
    assert.ok(await until(() => ["held", "done", "error"].includes(job.status)), `still ${job.status}/${job.phase}`);
    assert.match((await store.getOffer(job.offerId)).address, /^4417 Somerset Ln/, job.warnings?.join("; "));
  } finally { restore(); }
});
