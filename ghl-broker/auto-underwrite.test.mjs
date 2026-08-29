import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  evaluateGates, nearbyComps, countToday, findRecent, startUnderwrite, _resetJobs,
  listJobs, publicJob, cancelJob,
  UW_RADIUS_MILES, UW_MIN_REHABBED_COMPS, UW_MIN_SUBJECT_PHOTOS, UW_DEFAULT_DAILY_CAP,
} from "./auto-underwrite.js";

/* ---------- fixtures ---------- */

const SUBJECT = { lat: 47.49, lng: -122.19, beds: 3, baths: 2, sqft: 1400, yearBuilt: 1968 };
const EXTRACTION = { address: "1234 NE 8th St, Renton, WA 98056", askingPrice: 525000, confidence: "high", note: "" };
const ARV = { arv: 620000, base: 620000, graded: true, oversized: [], basis: "3 comps (renovated/updated), size-adjusted to 1,400 sqft" };
const SCAN = { areas: [{ area: "foundation_structure", grade: "good", note: "" }] };
const comps = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, address: `${i} Elm`, price: 600000 }));

const gate = (over = {}) => evaluateGates({
  extraction: EXTRACTION,
  subject: SUBJECT,
  rehabbedComps: comps(3),
  arv: ARV,
  photosAnalyzed: 24,
  scan: SCAN,
  repairs: 55000,
  ...over,
});

/* ---------- the gates: the whole safety argument ---------- */

test("a clean run clears every gate", () => {
  const g = gate();
  assert.equal(g.ok, true);
  assert.deepEqual(g.held, []);
});

test("two rehabbed comps is not three — the run holds", () => {
  const g = gate({ rehabbedComps: comps(2) });
  assert.equal(g.ok, false);
  assert.match(g.held[0], /only 2 renovated\/updated comps within 0.5 mi — 3 required/);
});

test("one rehabbed comp reads as singular", () => {
  assert.match(gate({ rehabbedComps: comps(1) }).held[0], /only 1 renovated\/updated comp within/);
});

test("three rehabbed comps is exactly enough", () => {
  assert.equal(gate({ rehabbedComps: comps(UW_MIN_REHABBED_COMPS) }).ok, true);
});

test("an ARV that fell back to ungraded comps is refused", () => {
  // deriveArv degrades to every comp when it can't find two graded ones. That
  // is right for a human who can see it happen, and wrong unattended.
  const g = gate({ arv: { ...ARV, graded: false } });
  assert.equal(g.ok, false);
  assert.ok(g.held.some((h) => /fell back to ungraded comps/.test(h)));
});

test("more than one wildly oversized comp is refused", () => {
  const over = [{ address: "a", sqft: 2600, ratio: 1.86 }, { address: "b", sqft: 2700, ratio: 1.93 }];
  assert.equal(gate({ arv: { ...ARV, oversized: over } }).ok, false);
  assert.equal(gate({ arv: { ...ARV, oversized: over.slice(0, 1) } }).ok, true);   // one is tolerable
});

test("no ARV at all is refused", () => {
  assert.ok(gate({ arv: null }).held.some((h) => /no ARV could be derived/.test(h)));
});

test("a thin photo set can't produce a scope of work", () => {
  const g = gate({ photosAnalyzed: 3 });
  assert.equal(g.ok, false);
  assert.match(g.held.find((h) => /photo/.test(h)), /only 3 listing photos to scan — 8 required/);
  assert.equal(gate({ photosAnalyzed: UW_MIN_SUBJECT_PHOTOS }).ok, true);
});

test("zero photos reads correctly rather than as 'undefined photos'", () => {
  assert.match(gate({ photosAnalyzed: 0 }).held.find((h) => /photo/.test(h)), /only 0 listing photos/);
});

test("a scope far past the heavy band for the house size is refused", () => {
  // 1,400 sqft → the 1,000–1,500 band, heavy tops out at $90k. 1.25× slack.
  assert.equal(gate({ repairs: 110000 }).ok, true);        // 110k ≤ 90k × 1.25
  const g = gate({ repairs: 140000 });
  assert.equal(g.ok, false);
  assert.match(g.held.find((h) => /heavy band/.test(h)), /past the heavy band for 1,000–1,500 sqft/);
});

test("an unknown house size is itself a hold, and no band is invented for it", () => {
  // Two separate things. rehabBand refuses to guess a band for an unknown size
  // (a made-up band would anchor the repair check on nothing) — so the scope
  // check must NOT fire. But an unknown size is disqualifying on its own: the
  // comp search runs unfiltered and deriveArv can't size-adjust. Seen live:
  // comps spanning 730–2,690 sqft producing a confident ARV.
  const g = gate({ subject: { ...SUBJECT, sqft: 0 }, repairs: 500000 });
  assert.equal(g.ok, false);
  assert.equal(g.held.filter((h) => /heavy band/.test(h)).length, 0, "no invented band check");
  assert.ok(g.held.some((h) => /square footage is unknown/.test(h)));
});

test("a subject that never resolved reports that, not a missing-size complaint", () => {
  // One root cause, one sentence. An unresolved address has no size either, and
  // saying both would send the operator looking for two problems.
  const g = gate({ subject: null });
  assert.ok(g.held.some((h) => /didn't resolve to a property record/.test(h)));
  assert.equal(g.held.filter((h) => /square footage is unknown/.test(h)).length, 0);
});

test("a foundation call is never made unattended", () => {
  const g = gate({ scan: { areas: [{ area: "foundation_structure", grade: "poor", note: "Stair-step crack." }] } });
  assert.equal(g.ok, false);
  assert.ok(g.held.some((h) => /foundation or structural/.test(h)));
});

test("a merely dated foundation grade is not a hold", () => {
  assert.equal(gate({ scan: { areas: [{ area: "foundation_structure", grade: "fair" }] } }).ok, true);
});

test("anything short of a high-confidence address holds, and says which", () => {
  assert.match(gate({ extraction: { ...EXTRACTION, confidence: "medium" } }).held[0], /read with medium confidence/);
  assert.match(gate({ extraction: { ...EXTRACTION, confidence: "low" } }).held[0], /read with low confidence/);
  assert.match(gate({ extraction: { ...EXTRACTION, address: "" } }).held[0], /no property address in the message/);
});

test("an address that resolved to no property record holds", () => {
  assert.ok(gate({ subject: { ...SUBJECT, lat: null } }).held.some((h) => /didn't resolve to a property record/.test(h)));
  assert.ok(gate({ subject: null }).held.some((h) => /didn't resolve to a property record/.test(h)));
});

test("every failing reason is collected, not just the first", () => {
  const g = gate({ rehabbedComps: comps(0), arv: null, photosAnalyzed: 0 });
  assert.equal(g.ok, false);
  assert.ok(g.held.length >= 3);
  for (const h of g.held) assert.equal(typeof h, "string");
});

test("a price proxy that declined says so, instead of reporting zero renovated comps", () => {
  // These look identical from outside — "no renovated comps" — and have
  // opposite fixes. One needs a wider net; the other needs someone to open the
  // photos. The note has to distinguish them or the operator chases the wrong
  // problem.
  const g = gate({
    rehabbedComps: [],
    proxy: { applied: false, pool: 3, reason: "only 3 priced comps — the price proxy needs 6 to have a top tier" },
  });
  assert.equal(g.ok, false);
  const reason = g.held.find((h) => /price proxy/.test(h));
  assert.ok(reason, "the proxy's own reason is surfaced");
  assert.match(reason, /not enough nearby sales to tell renovated from tired by price/);
  // And it must not ALSO claim zero renovated comps — that's the same fact twice.
  assert.equal(g.held.filter((h) => /renovated\/updated comp/.test(h)).length, 0);
});

test("a price proxy that applied is judged on its output like any other", () => {
  const applied = { applied: true, pool: 8, reason: "top 4 of 8 comps by $/sqft, taken as renovated" };
  assert.equal(gate({ proxy: applied }).ok, true);
  assert.match(
    gate({ proxy: applied, rehabbedComps: comps(2) }).held[0],
    /only 2 renovated\/updated comps within 0.5 mi/
  );
});

/* ---------- the half-mile rule ---------- */

const at = (id, distance, extra = {}) => ({ id, address: `${id} St`, price: 600000, sqft: 1400, beds: 3, baths: 2, ...extra, distance });

test("comps beyond the radius are dropped", () => {
  const out = nearbyComps({
    compsData: { subject: SUBJECT, comps: [at("a", 0.2), at("b", 0.49), at("c", 0.51), at("d", 1.0)] },
    subjectFacts: SUBJECT,
  });
  assert.deepEqual(out.map((c) => c.id), ["a", "b"]);
});

test("a comp with no distance is dropped, not kept — nobody is looking at this list", () => {
  const out = nearbyComps({
    compsData: { subject: SUBJECT, comps: [at("a", 0.2), at("nodist", null)] },
    subjectFacts: SUBJECT,
  });
  assert.deepEqual(out.map((c) => c.id), ["a"]);
});

test("a missing distance is computed from coordinates before the radius is applied", () => {
  // ~0.25 mi north of the subject.
  const near = { id: "geo", address: "geo", price: 600000, distance: null, lat: SUBJECT.lat + 0.0036, lng: SUBJECT.lng };
  const far = { id: "far", address: "far", price: 600000, distance: null, lat: SUBJECT.lat + 0.05, lng: SUBJECT.lng };
  const out = nearbyComps({ compsData: { subject: SUBJECT, comps: [near, far] }, subjectFacts: SUBJECT });
  assert.deepEqual(out.map((c) => c.id), ["geo"]);
  assert.ok(out[0].distance > 0 && out[0].distance <= UW_RADIUS_MILES);
});

test("the subject's own prior sale is not a comp for the subject", () => {
  // Caught live: underwriting 15857 35th Ave NE returned 15857 35th Ave NE at
  // distance 0 as the top "renovated" comp. It is a perfect match on every
  // criterion by construction, so it sorts first and anchors the ARV on the
  // exact transaction we are trying to value independently of.
  const out = nearbyComps({
    compsData: { subject: SUBJECT, comps: [at("self", 0), at("other", 0.3)] },
    subjectFacts: SUBJECT,
  });
  assert.deepEqual(out.map((c) => c.id), ["other"]);
});

test("the same parcel under a different address string is still excluded", () => {
  const out = nearbyComps({
    compsData: {
      subject: SUBJECT,
      comps: [
        { ...at("byName", 0.2), address: "15857 35th Ave NE, Lake Forest Park, WA 98155" },
        at("other", 0.3),
      ],
    },
    subjectFacts: SUBJECT,
    subjectAddress: "15857 35th Avenue Northeast, Lake Forest Park, WA 98155",
  });
  assert.deepEqual(out.map((c) => c.id), ["other"]);
});

test("a genuinely close neighbour is kept — only the parcel itself is dropped", () => {
  const out = nearbyComps({
    compsData: { subject: SUBJECT, comps: [at("neighbour", 0.02)] },
    subjectFacts: SUBJECT,
    subjectAddress: "15857 35th Avenue NE, Lake Forest Park, WA 98155",
  });
  assert.deepEqual(out.map((c) => c.id), ["neighbour"]);
});

test("survivors come back best-match first", () => {
  const exact = at("exact", 0.4, { beds: 3, baths: 2, sqft: 1400, yearBuilt: 1968 });
  const loose = at("loose", 0.1, { beds: 5, baths: 4, sqft: 1400, yearBuilt: 1968 });
  const out = nearbyComps({ compsData: { subject: SUBJECT, comps: [loose, exact] }, subjectFacts: SUBJECT });
  assert.equal(out[0].id, "exact");          // match beats proximity
  assert.ok(out[0].match.pct > out[1].match.pct);
});

/* ---------- spend guards ---------- */

const fakeStore = (offers) => ({
  listOffers: async (_loc, { contactId = null } = {}) =>
    offers.filter((o) => !contactId || o.contactId === contactId),
});

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

test("countToday counts what the store recorded today and ignores yesterday", async () => {
  _resetJobs();
  const store = fakeStore([
    { id: "1", createdAt: iso(60_000), autoUnderwrite: { jobId: "uw-a", startedAt: iso(60_000) } },
    { id: "2", createdAt: iso(60_000), autoUnderwrite: { jobId: "uw-b", startedAt: iso(60_000) } },
    { id: "3", createdAt: iso(50 * 3600_000), autoUnderwrite: { jobId: "uw-old", startedAt: iso(50 * 3600_000) } },
    { id: "4", createdAt: iso(60_000) },                       // a hand-built offer doesn't count
  ]);
  assert.equal(await countToday({ store, locationId: "LOC" }), 2);
});

test("countToday tolerates a store that can't answer rather than opening the tap", async () => {
  _resetJobs();
  const store = { listOffers: async () => { throw new Error("db down"); } };
  assert.equal(await countToday({ store, locationId: "LOC" }), 0);
});

test("findRecent matches the same address for the same agent inside 24h", async () => {
  const store = fakeStore([{
    id: "off1", contactId: "c1", address: "1234 NE 8th St, Renton, WA 98056",
    createdAt: iso(3600_000), autoUnderwrite: { jobId: "uw-x" },
  }]);
  const hit = await findRecent({ store, locationId: "LOC", contactId: "c1", address: "1234 NE 8th Street, Renton WA 98056" });
  assert.equal(hit?.id, "off1");
});

test("findRecent ignores a different address, a different agent, and anything older than a day", async () => {
  const row = (over) => ({
    id: "x", contactId: "c1", address: "1234 NE 8th St, Renton, WA 98056",
    createdAt: iso(3600_000), autoUnderwrite: { jobId: "uw-x" }, ...over,
  });
  const miss = async (offers, address = "1234 NE 8th St, Renton, WA 98056", contactId = "c1") =>
    findRecent({ store: fakeStore(offers), locationId: "LOC", contactId, address });

  assert.equal(await miss([row({})], "99 Other Rd, Renton, WA"), null);
  assert.equal(await miss([row({ contactId: "c2" })]), null);
  assert.equal(await miss([row({ createdAt: iso(30 * 3600_000) })]), null);
  assert.equal(await miss([row({ autoUnderwrite: undefined })]), null);   // a hand-built offer isn't a dupe
});

/* ---------- startUnderwrite's front door ---------- */

const KEYS = { aiApiKey: "sk-ant-x", compsApiKey: "reapi-x", apifyToken: "apify-x" };
const start = (saved, store) => startUnderwrite({
  client: {}, locationId: "LOC", saved, store,
  contactId: "c1", message: "1234 NE 8th St", dryRun: true,
  deps: { createOffer: async () => { throw new Error("should not be reached"); } },
});

test("a missing API key is refused before anything is spent", async () => {
  _resetJobs();
  const store = fakeStore([]);
  await assert.rejects(() => start({ ...KEYS, aiApiKey: "" }, store), /Anthropic API key required/);
  await assert.rejects(() => start({ ...KEYS, apifyToken: "" }, store), /Apify token required/);
  assert.equal(listJobs("LOC").length, 0);
});

test("the default Zillow source needs no RealEstateAPI key at all", async () => {
  // Apify covers both halves — the sold-comp search and the subject listing —
  // so a location can run the whole pipeline without a RealEstateAPI account.
  _resetJobs();
  const { job } = await startWith(
    { saved: { aiApiKey: "sk-ant-x", apifyToken: "apify-x" }, address: "1 Elm St" }
  );
  assert.ok(job, "started without compsApiKey");
});

test("choosing the RealEstateAPI source brings its key requirement back", async () => {
  _resetJobs();
  await assert.rejects(
    () => start({ ...KEYS, compsApiKey: "", rentcastApiKey: "", compsSource: "realestateapi" }, fakeStore([])),
    /RealEstateAPI key required/
  );
});

test("the daily cap stops the run before a job is ever created", async () => {
  _resetJobs();
  const spent = Array.from({ length: UW_DEFAULT_DAILY_CAP }, (_, i) => ({
    id: `o${i}`, createdAt: iso(60_000), autoUnderwrite: { jobId: `uw-${i}`, startedAt: iso(60_000) },
  }));
  const { skipped, job } = await start(KEYS, fakeStore(spent));
  assert.match(skipped, /daily cap reached \(25\/25\)/);
  assert.equal(job, null);
  assert.equal(listJobs("LOC").length, 0);
});

test("a per-location cap overrides the default", async () => {
  _resetJobs();
  const spent = [{ id: "o0", createdAt: iso(60_000), autoUnderwrite: { jobId: "uw-0", startedAt: iso(60_000) } }];
  const { skipped } = await start({ ...KEYS, autoUnderwriteDailyCap: 1 }, fakeStore(spent));
  assert.match(skipped, /daily cap reached \(1\/1\)/);
});

/* ---------- the two front doors ---------- */

// A run started from an Opportunity-Created trigger has no inbound message,
// only the address the conversation bot already confirmed. A run started from
// an Inbound Message trigger has the opposite. Both have to work, and the
// supplied address must skip extraction entirely — that is the whole saving.

// These assert on the record startUnderwrite BUILDS, not on the run. The lane
// starts the moment it returns, so cancel synchronously — the first phase
// boundary sees the flag and returns before any provider is called. Without
// this, a unit test would go out to RealEstateAPI with a fake key.
async function startWith(over, store = fakeStore([])) {
  const out = await startUnderwrite({
    client: {}, locationId: "LOC", saved: KEYS, store,
    contactId: "c1", dryRun: true,
    deps: { createOffer: async () => { throw new Error("should not be reached"); } },
    ...over,
  });
  if (out.job) cancelJob(out.job.id);
  return out;
}

test("a supplied address is enough on its own — no inbound message needed", async () => {
  _resetJobs();
  const { job } = await startWith({ address: "1234 NE 8th St, Renton, WA 98056", askingPrice: 525000 });
  assert.ok(job);
  assert.equal(job.suppliedAddress, "1234 NE 8th St, Renton, WA 98056");
  assert.equal(job.suppliedAskingPrice, 525000);
});

test("a supplied address is trimmed and capped rather than trusted raw", async () => {
  _resetJobs();
  const { job } = await startWith({ address: `   ${"x".repeat(400)}   ` });
  assert.equal(job.suppliedAddress.length, 200);
  assert.equal(job.suppliedAddress.startsWith(" "), false);
});

test("a blank supplied address falls back to the conversation rather than erroring", async () => {
  // The GHL race this protects against: the workflow fires on opportunity
  // creation before the bot's custom-field write has landed, so the merge
  // field resolves to "". That must degrade to reading the thread, not fail.
  _resetJobs();
  const { job } = await startWith({ address: "   ", message: "you still buying 1234 NE 8th St?" });
  assert.equal(job.suppliedAddress, "");
  assert.equal(job.message, "you still buying 1234 NE 8th St?");
});

test("a contact alone is a valid trigger — the address can come off the record", async () => {
  // GHL's default webhook payload is just the contact. Before Subject Property
  // that was unusable and the route 400'd; now it's the normal Tier-1 shape,
  // and the run resolves the address from the field itself.
  _resetJobs();
  const { job } = await startWith({ address: "", message: "" });
  assert.ok(job, "started with neither an address nor a message");
  assert.equal(job.suppliedAddress, "");
  assert.equal(job.message, "");
});

test("a non-numeric asking price is dropped, not passed through as NaN", async () => {
  _resetJobs();
  const { job } = await startWith({ address: "1 Elm St", askingPrice: "not a number" });
  assert.equal(job.suppliedAskingPrice, 0);
});

test("a live run has to be asked for two ways, and GHL only speaks strings", () => {
  // The route's rule. GHL's Custom Data has no types, so "dryRun: false" set in
  // the workflow arrives as the STRING "false" — which is not `false`, and
  // silently left every run dry with the setting apparently applied.
  const isDry = (dryRun, enabled) =>
    !(dryRun === false || String(dryRun).toLowerCase() === "false") || !enabled;

  assert.equal(isDry(false, true), false, "a real false with the flag on goes live");
  assert.equal(isDry("false", true), false, "and so does GHL's string");
  assert.equal(isDry("FALSE", true), false);

  assert.equal(isDry(false, false), true, "the env flag still has a veto");
  assert.equal(isDry(undefined, true), true, "silence means dry");
  assert.equal(isDry(true, true), true);
  assert.equal(isDry("true", true), true);
  assert.equal(isDry("", true), true);
});

/* ---------- the job record ---------- */

test("publicJob hides the cancel flag and reports stopping instead", () => {
  const job = { id: "uw-1", status: "running", cancelRequested: true };
  const view = publicJob(job);
  assert.equal(view.cancelRequested, undefined);
  assert.equal(view.stopping, true);
  assert.equal(publicJob({ id: "uw-2", status: "done", cancelRequested: false }).stopping, false);
  assert.equal(publicJob(null), null);
});

test("cancelling an already-finished job is a no-op, not an error", () => {
  _resetJobs();
  assert.equal(cancelJob("nope"), false);
});


/* ---------- the webhook credential ---------- */
// Guarded here rather than in the route's own file because the reasoning is
// the load-bearing part: GHL_LOCATION_KEYS is enforced by resolveLocation on
// EVERY request for a location, so using it to protect this one webhook 403s
// every GHL custom menu link in the account until each URL is re-issued with
// ?key= appended. AUTO_UNDERWRITE_SECRET guards this route alone.

test("a timing-safe compare rejects a prefix, a suffix and a length change", () => {
  // The shape the route's secretOk uses. Length is checked first because
  // timingSafeEqual throws on mismatched buffers.
  const eq = (got, want) => {
    const a = Buffer.from(String(got ?? ""));
    const b = Buffer.from(String(want));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const secret = "EXAMPLE-not-a-real-secret-000000";
  assert.equal(eq(secret, secret), true);
  assert.equal(eq(secret.slice(0, -1), secret), false);
  assert.equal(eq(secret + "x", secret), false);
  assert.equal(eq("", secret), false);
  assert.equal(eq(null, secret), false);
  assert.equal(eq(undefined, secret), false);
});
