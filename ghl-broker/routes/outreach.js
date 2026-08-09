// routes/outreach.js — Agent Outreach: pull active MLS listings from RentCast,
// group them by listing agent, score each listing for "fixer-ness" (the best
// one becomes the agent's outreach hook), flag agents already in GHL, and bulk
// import selected agents as GHL contacts (custom fields + tag — the tag fires
// the outreach workflow inside GHL). Mounted at /api/outreach.
//
//   GET  /api/outreach/batches                       saved batches (named pull cohorts)
//   POST /api/outreach/batches                       create a batch
//   POST /api/outreach/batches/:batchId/rename       rename (changes the import tag)
//   DELETE /api/outreach/batches/:batchId            delete batch + its agents/listings
//   GET  /api/outreach/agents                        one batch's agents + request-meter usage
//   GET  /api/outreach/agents/:agentKey/listings     one agent's listings, ranked
//   POST /api/outreach/pull                          fetch + score + persist into a batch
//   POST /api/outreach/import                        bulk import to GHL (dry-run by default)
//   POST /api/outreach/agents/:agentKey/status       skip / unskip
//
// Agents and listings are scoped to a BATCH (a saved, named pull cohort);
// batchId/batch_id defaults to the most recent batch so the cron pull keeps
// working without one. The GHL import tag derives from the batch name.
//
// RentCast is billed per REQUEST (up to 500 listings each, free tier 50/mo),
// so pulls carry a hard request budget and a 24h cache, and every pull is
// recorded to power the month-to-date meter in the UI.

import express from "express";
import { store } from "../store.js";
import { mapPool } from "../map-pool.js";
import { scoreListing, medianPricePerSqft, distressSignals } from "../outreach-score.js";
import { zillowUrl } from "../shared/us-address.js";
import { findCounty, listingInCounty } from "../shared/us-counties.js";
import { OUTREACH_FIELDS } from "../field-registry.js";
import {
  findDuplicateContact, createContact, getContact, updateContact,
  addContactTags, findOrCreateCustomFieldByKey, getLastMessageDate,
} from "../ghl.js";

const OUTREACH_TAG = process.env.OUTREACH_TAG || "agent-outreach";
const OUTREACH_IMPORTS_ENABLED = process.env.OUTREACH_IMPORTS_ENABLED === "true";

// Contact custom fields written on import live in the shared registry so the
// Fields Manager can visualize them alongside the offer + enrichment fields.

/* ---------- normalization ---------- */

const normEmail = (s) => {
  const e = String(s || "").trim().toLowerCase();
  return e.includes("@") ? e : "";
};
// Last 10 digits — strips country code and formatting.
const normPhone = (s) => {
  const d = String(s || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
};
const slug = (s) =>
  String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function agentIdentity(listing) {
  const a = listing.listingAgent || {};
  const email = normEmail(a.email);
  const phone = normPhone(a.phone);
  const name = String(a.name || "").trim();
  const office = String(listing.listingOffice?.name || "").trim();
  const agentKey = email ? `e:${email}` : phone ? `p:${phone}` : name ? `n:${slug(name)}|${slug(office)}` : null;
  return { agentKey, email, phone, name, office };
}

const listingKey = (l) => {
  if (l.mlsName && l.mlsNumber) return `${l.mlsName}:${l.mlsNumber}`;
  return `a:${slug(l.formattedAddress || `${l.addressLine1} ${l.city} ${l.state} ${l.zipCode}`)}`;
};

const splitName = (name) => {
  const parts = String(name || "").trim().split(/\s+/);
  return { firstName: parts[0] || "", lastName: parts.slice(1).join(" ") };
};

// GHL stores phones as E.164 — send +1XXXXXXXXXX, not bare digits.
const e164 = (phone) => (phone ? `+1${normPhone(phone)}` : "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry a GHL call on 429 (2s, then 4s). Other errors propagate.
async function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e.status !== 429 || attempt >= 2) throw e;
      await sleep(2000 * (attempt + 1));
    }
  }
}

/* ---------- RentCast ---------- */

// Overridable so tests can point at a local mock instead of spending real
// free-tier requests.
const RENTCAST_BASE = process.env.RENTCAST_BASE_URL || "https://api.rentcast.io/v1";

// One page of sale listings. Bare array in practice; tolerate a wrapper.
async function rentcastPage(apiKey, params) {
  const qs = new URLSearchParams({ status: "Active", limit: "500", ...params });
  const r = await fetch(`${RENTCAST_BASE}/listings/sale?${qs}`, {
    headers: { "X-Api-Key": apiKey, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 300);
    throw Object.assign(new Error(`RentCast ${r.status}`), { http: 502, detail });
  }
  const data = await r.json();
  return Array.isArray(data) ? data : data.listings || [];
}

export default function createOutreachRouter({ resolveLocation }) {
  const router = express.Router();
  const fail = (res, err) => {
    const code = err.http || err.status || 500;
    if (code >= 500) console.error("outreach error:", code, err.message, err.detail || "");
    res.status(code).json({ error: err.message, detail: err.detail });
  };

  // 24h pull cache: params → raw listings. A cache hit costs 0 RentCast requests.
  const pullCache = new Map();
  const PULL_TTL = 24 * 3600 * 1000;

  async function getSettings(locationId) {
    return (await store.getOfferSettings(locationId)) || {};
  }

  /* ---------- batches ---------- */

  const sanitizeTag = (s) =>
    String(s || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  // Stable GHL tag for a batch, derived from its name: batch "Queen Anne
  // fixers" → "agent-outreach-queen-anne-fixers". Same tag across every import
  // session from the batch.
  const batchTagFor = (batch) => sanitizeTag(`${OUTREACH_TAG}-${batch.name}`) || OUTREACH_TAG;

  const shortDate = () => new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
  // "98119, 98109 · Aug 4"  /  "King County, WA · Aug 4"  /  "Seattle, WA · Aug 4"
  function autoBatchName({ zips, county, city, state }) {
    const market = zips?.length
      ? zips.slice(0, 3).join(", ") + (zips.length > 3 ? ` +${zips.length - 3}` : "")
      : [county || city, state].filter(Boolean).join(", ") || "Pull";
    return `${market} · ${shortDate()}`;
  }

  // Resolve the batch a request operates on: explicit id must exist (404);
  // otherwise the most recent batch; otherwise create one when createName is
  // given (the pull path — keeps the batchless cron POST working), else null.
  async function resolveBatch(locationId, batchId, { createName = null } = {}) {
    if (batchId) {
      const b = await store.getOutreachBatch(locationId, String(batchId));
      if (!b) throw Object.assign(new Error("unknown batch"), { http: 404 });
      return b;
    }
    const [latest] = await store.listOutreachBatches(locationId);
    if (latest) return latest;
    if (createName) return store.createOutreachBatch(locationId, { name: createName, autoNamed: true });
    return null;
  }

  /* ---------- pull ---------- */

  // Resolve pull targets from the request body, falling back to the location's
  // saved defaults so a future Render Cron can POST with just location_id.
  function pullParams(body, settings) {
    const zips = (Array.isArray(body.zipCodes) ? body.zipCodes.join(",") : String(body.zipCodes || settings.outreachZips || ""))
      .split(",").map((z) => z.trim()).filter((z) => /^\d{5}$/.test(z));
    const county = String(body.county ?? settings.outreachCounty ?? "").trim();
    const city = String(body.city ?? settings.outreachCity ?? "").trim();
    const state = String(body.state ?? settings.outreachState ?? "").trim().toUpperCase();
    const daysOld = Math.min(365, Math.max(1, parseInt(body.daysOld, 10) || parseInt(settings.outreachDaysOld, 10) || 180));
    const propertyType = String(body.propertyType || "").trim();
    // County pulls cover a whole market in 500-listing pages, so they get a
    // higher request ceiling and a bigger default than zip/city pulls.
    const maxRequests = Math.min(10, Math.max(1, parseInt(body.maxRequests, 10) || (county && !zips.length ? 5 : 3)));
    // Post-fetch filters (applied to the cohort, not the RentCast query —
    // RentCast can't filter on price or days-on-market server-side).
    // distressOnly keeps listings with ANY distress signal (stale ≥ staleDom
    // days, price-cut history, or ≤90% of median $/sqft) — OR semantics, the
    // signals are alternatives. Defaults ON so the batchless cron POST pulls
    // distressed cohorts. priceBandPct additionally trims to ±N% of the
    // pull's median price.
    const priceBandPct = Math.min(75, Math.max(0, parseInt(body.priceBandPct, 10) || 0));
    const distressOnly = body.distressOnly !== false;
    const staleDom = Math.min(365, Math.max(1, parseInt(body.staleDom, 10) || 45));
    return { zips, county, city, state, daysOld, propertyType, maxRequests, priceBandPct, distressOnly, staleDom };
  }

  async function runPull(locationId, client, body) {
    const settings = await getSettings(locationId);
    const apiKey = String(settings.rentcastApiKey || "").trim();
    if (!apiKey) throw Object.assign(new Error("RentCast API key not configured — add it in Settings"), { http: 400 });

    const { zips, county, city, state, daysOld, propertyType, maxRequests, priceBandPct, distressOnly, staleDom } =
      pullParams(body, settings);
    // Precedence: zips (one query each) → county (one circular query around
    // the county centroid, post-filtered to the county line) → city/state.
    // RentCast has no county search, but every listing it returns carries its
    // county, so a bounding circle + exact filter is equivalent.
    let countyMeta = null;
    if (!zips.length && county) {
      if (!state) throw Object.assign(new Error("county pulls need a state — set the state field"), { http: 400 });
      countyMeta = findCounty(county, state);
      if (!countyMeta)
        throw Object.assign(new Error(`unknown county "${county}" in ${state} — check the spelling`), { http: 400 });
    }
    const targets = zips.length
      ? zips.map((z) => ({ zipCode: z }))
      : countyMeta
        ? [{ latitude: String(countyMeta.lat), longitude: String(countyMeta.lng), radius: String(countyMeta.radiusMi) }]
        : city && state
          ? [{ city, state }]
          : null;
    if (!targets) throw Object.assign(new Error("no market configured — set zip codes, a county, or city/state"), { http: 400 });

    // Every pull lands in a batch: explicit batchId, else most recent, else a
    // fresh auto-named one. An untouched auto-named empty batch adopts this
    // pull's market · date name.
    const nameParts = { zips, county: countyMeta?.name, city, state };
    const batch = await resolveBatch(locationId, body.batchId, {
      createName: autoBatchName(nameParts),
    });
    if (batch.autoNamed) {
      const existing = await store.listOutreachAgents(locationId, { batchId: batch.id, limit: 1 });
      if (!existing.length) {
        batch.name = autoBatchName(nameParts);
        await store.renameOutreachBatch(locationId, batch.id, batch.name, { autoNamed: true });
      }
    }

    const warnings = [];
    const common = { daysOld: String(daysOld), ...(propertyType ? { propertyType } : {}) };
    const cacheKey = `${locationId}|${JSON.stringify({ targets, common })}`;

    let listings;
    let requestsUsed = 0;
    let cached = false;
    const hit = pullCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < PULL_TTL) {
      listings = hit.listings;
      cached = true;
    } else {
      listings = [];
      let budgetLeft = maxRequests;
      for (const target of targets) {
        let offset = 0;
        let moreAvailable = false;
        while (budgetLeft > 0) {
          budgetLeft--;
          requestsUsed++;
          const page = await rentcastPage(apiKey, { ...common, ...target, ...(offset ? { offset: String(offset) } : {}) });
          listings.push(...page);
          moreAvailable = page.length >= 500;
          if (!moreAvailable) break; // last page for this target
          offset += 500;
        }
        if (moreAvailable && budgetLeft <= 0) {
          warnings.push(`request budget (${maxRequests}) ran out mid-market — results are truncated; raise max requests to get the rest`);
          break;
        }
        if (budgetLeft <= 0 && targets.indexOf(target) < targets.length - 1) {
          warnings.push(`request budget (${maxRequests}) exhausted before all zips were pulled — narrow the market or raise maxRequests`);
          break;
        }
      }
      if (listings.length) {
        pullCache.set(cacheKey, { ts: Date.now(), listings });
        if (pullCache.size > 20) pullCache.delete(pullCache.keys().next().value);
      }
    }

    // The circle over-covers by design — trim to the actual county line using
    // the county each listing carries. Runs on cached pulls too (the cache
    // stores the raw circle).
    if (countyMeta) {
      const before = listings.length;
      listings = listings.filter((l) => listingInCounty(l, countyMeta));
      warnings.push(`county filter kept ${listings.length} of ${before} circle listings inside ${countyMeta.name}`);
    }

    // Cohort medians come from the FULL pull (pre-filter) so they describe the
    // market, not the filtered slice.
    const medianPpsf = medianPricePerSqft(listings);
    const prices = listings.map((l) => Number(l.price)).filter((p) => p > 0).sort((a, b) => a - b);
    const medianPrice = prices.length
      ? prices.length % 2 ? prices[(prices.length - 1) / 2] : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
      : 0;

    let pool = listings;
    if (distressOnly) {
      const before = pool.length;
      pool = pool.filter((l) => distressSignals(l, { medianPpsf, staleDom }).any);
      warnings.push(
        `distress filter (${staleDom}+ DOM, price cut, or ≤90% of $${Math.round(medianPpsf)}/sqft median) kept ${pool.length} of ${before}`
      );
    }
    if (priceBandPct && medianPrice) {
      const lo = medianPrice * (1 - priceBandPct / 100);
      const hi = medianPrice * (1 + priceBandPct / 100);
      const before = pool.length;
      pool = pool.filter((l) => Number(l.price) >= lo && Number(l.price) <= hi);
      warnings.push(`price band ±${priceBandPct}% of $${Math.round(medianPrice).toLocaleString()} median kept ${pool.length} of ${before}`);
    }

    // Group the FULL pull by agent — filters decide which agents qualify and
    // which listing becomes the hook, but activity counts (listingCount) must
    // reflect the agent's whole book of business in this market.
    const qualifying = new Set(pool);
    const byAgent = new Map();
    let droppedNoAgent = 0;
    for (const l of listings) {
      const idc = agentIdentity(l);
      if (!idc.agentKey) { droppedNoAgent++; continue; }
      const { score, components } = scoreListing(l, { medianPpsf });
      const { stale, cut, cheap } = distressSignals(l, { medianPpsf, staleDom });
      const key = listingKey(l);
      const address = l.formattedAddress || [l.addressLine1, l.city, l.state, l.zipCode].filter(Boolean).join(", ");
      const docListing = {
        address, city: l.city, state: l.state, zip: l.zipCode,
        price: l.price, daysOnMarket: l.daysOnMarket, listedDate: l.listedDate,
        yearBuilt: l.yearBuilt, sqft: l.squareFootage, propertyType: l.propertyType,
        mlsName: l.mlsName, mlsNumber: l.mlsNumber, score, components,
        distress: { stale, cut, cheap }, qualifies: qualifying.has(l),
      };
      const g = byAgent.get(idc.agentKey) || { identity: idc, listings: [] };
      // Prefer the richest identity seen (a later listing may add email/phone).
      g.identity = {
        agentKey: idc.agentKey,
        email: g.identity.email || idc.email,
        phone: g.identity.phone || idc.phone,
        name: g.identity.name || idc.name,
        office: g.identity.office || idc.office,
      };
      g.listings.push({ listingKey: key, ...docListing });
      byAgent.set(idc.agentKey, g);
    }
    if (droppedNoAgent) warnings.push(`${droppedNoAgent} listing(s) had no agent identity and were skipped`);

    // Merge with stored rows (preserve ghl match + import status), then check
    // GHL for the agents we haven't matched yet. An agent joins the batch only
    // when at least one of their listings survived the filters; the hook is
    // their best-scoring qualifying listing, while listingCount/listingRows
    // cover their full book so activity stays visible.
    const agentRows = [];
    const listingRows = [];
    let agentsNew = 0;
    let agentsExcluded = 0;
    for (const [agentKey, g] of byAgent) {
      const qual = g.listings.filter((x) => x.qualifies);
      if (!qual.length) { agentsExcluded++; continue; }
      const stored = await store.getOutreachAgent(locationId, batch.id, agentKey);
      if (!stored) agentsNew++;
      const officePhone = normPhone(
        listings.find((l) => agentIdentity(l).agentKey === agentKey)?.listingOffice?.phone
      );
      const hook = qual.slice().sort((a, b) => b.score - a.score)[0];
      for (const { listingKey: lk, ...docListing } of g.listings)
        listingRows.push({ listingKey: lk, agentKey, doc: docListing });
      agentRows.push({
        agentKey,
        stored,
        doc: {
          name: g.identity.name, ...splitName(g.identity.name),
          phone: g.identity.phone, email: g.identity.email,
          brokerage: g.identity.office, officePhone,
          ghl: stored?.doc?.ghl || { contactId: null, matchedBy: null, checkedAt: null },
          hook: {
            listingKey: hook.listingKey, address: hook.address, price: hook.price,
            dom: hook.daysOnMarket, propertyType: hook.propertyType,
            score: hook.score, components: hook.components,
          },
          listingCount: g.listings.length,
          distressedCount: g.listings.filter((x) => x.distress.stale || x.distress.cut || x.distress.cheap).length,
        },
      });
    }
    if (agentsExcluded)
      warnings.push(`${agentsExcluded} agent(s) had no qualifying listing and were excluded`);

    const unchecked = agentRows.filter((r) => !r.doc.ghl.contactId && r.stored?.status !== "imported");
    await mapPool(unchecked, 3, async (r) => {
      try {
        const match = await withRetry(() =>
          findDuplicateContact(client, locationId, { email: r.doc.email, phone: r.doc.phone })
        );
        r.doc.ghl = {
          contactId: match?.id || null,
          matchedBy: match?.matchedBy || null,
          checkedAt: new Date().toISOString(),
        };
      } catch (e) {
        warnings.push(`GHL check failed for ${r.doc.name || r.agentKey}: ${e.message}`);
      }
    });

    // Last message activity for every agent that has a GHL contact (matched or
    // already imported) — shown in the UI so recently-touched agents stand out.
    // Needs conversations.readonly; a 401/403 means the scope isn't granted.
    let convScopeMissing = false;
    const withContact = agentRows.filter((r) => r.doc.ghl.contactId || r.stored?.contactId);
    await mapPool(withContact, 3, async (r) => {
      if (convScopeMissing) return;
      try {
        const lm = await withRetry(() =>
          getLastMessageDate(client, locationId, r.doc.ghl.contactId || r.stored.contactId)
        );
        r.doc.ghl.lastMessageAt = lm?.at || null;
        r.doc.ghl.lastMessageDirection = lm?.direction || null;
      } catch (e) {
        if (e.status === 401 || e.status === 403) convScopeMissing = true;
      }
    });
    if (convScopeMissing)
      warnings.push("last-message dates unavailable — add the conversations.readonly scope to the GHL private integration");

    await store.upsertOutreachListings(locationId, batch.id, listingRows);
    await store.upsertOutreachAgents(locationId, batch.id, agentRows.map(({ agentKey, doc }) => ({ agentKey, doc })));
    await store.recordOutreachPull(locationId, {
      batchId: batch.id,
      params: { targets, ...(countyMeta ? { county: countyMeta.name } : {}), daysOld, propertyType, maxRequests, priceBandPct, distressOnly, staleDom },
      requestsUsed, cached, listingsFetched: listings.length, listingsKept: pool.length,
      agentsTotal: agentRows.length, agentsNew, medianPpsf: Math.round(medianPpsf),
      medianPrice: Math.round(medianPrice),
    });

    return {
      ok: true, cached, requestsUsed,
      batchId: batch.id, batchName: batch.name,
      listingsFetched: listings.length, listingsKept: pool.length,
      medianPrice: Math.round(medianPrice),
      agentsTotal: agentRows.length, agentsNew,
      warnings,
    };
  }

  router.post("/pull", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      res.json(await runPull(locationId, client, req.body || {}));
    } catch (err) { fail(res, err); }
  });

  /* ---------- batches CRUD ---------- */

  router.get("/batches", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const batches = (await store.listOutreachBatches(locationId)).map((b) => ({ ...b, tag: batchTagFor(b) }));
      res.json({ batches });
    } catch (err) { fail(res, err); }
  });

  router.post("/batches", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const name = String(req.body?.name || "").trim().slice(0, 80);
      // Unnamed batches stay autoNamed so the first pull renames them to
      // "market · date"; an explicit name sticks.
      const batch = await store.createOutreachBatch(locationId, {
        name: name || `New batch · ${shortDate()}`,
        autoNamed: !name,
      });
      res.json({ ok: true, batch: { ...batch, tag: batchTagFor(batch) } });
    } catch (err) { fail(res, err); }
  });

  router.post("/batches/:batchId/rename", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const name = String(req.body?.name || "").trim().slice(0, 80);
      if (!name) return res.status(400).json({ error: "name required" });
      const ok = await store.renameOutreachBatch(locationId, req.params.batchId, name);
      if (!ok) return res.status(404).json({ error: "unknown batch" });
      const batch = await store.getOutreachBatch(locationId, req.params.batchId);
      res.json({ ok: true, batch: { ...batch, tag: batchTagFor(batch) } });
    } catch (err) { fail(res, err); }
  });

  router.delete("/batches/:batchId", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const batch = await store.getOutreachBatch(locationId, req.params.batchId);
      if (!batch) return res.status(404).json({ error: "unknown batch" });
      const { removedAgents } = await store.deleteOutreachBatch(locationId, batch.id);
      res.json({ ok: true, removedAgents });
    } catch (err) { fail(res, err); }
  });

  /* ---------- list ---------- */

  router.get("/agents", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const settings = await getSettings(locationId);
      const enabled = Boolean(String(settings.rentcastApiKey || "").trim());

      // Scope to one batch (explicit or most recent). No batches yet → empty list.
      const batch = await resolveBatch(locationId, String(req.query.batch_id || "") || null);
      const rows = batch
        ? await store.listOutreachAgents(locationId, {
            batchId: batch.id,
            status: String(req.query.status || "") || null,
          })
        : [];

      // Join saved offers onto agents: an offer counts as "theirs" when its
      // property matches one of the agent's listings (street-level compare) or
      // it's attached to the agent's GHL contact.
      const normStreet = (s) => String(s || "").split(",")[0].toLowerCase().replace(/[^a-z0-9]/g, "");
      const offers = await store.listOffers(locationId, { limit: 500 });
      const offersByStreet = new Map();
      for (const o of offers) {
        const k = normStreet(o.address);
        if (!k) continue;
        if (!offersByStreet.has(k)) offersByStreet.set(k, []);
        offersByStreet.get(k).push(o);
      }
      const offersByContact = new Map();
      for (const o of offers) {
        if (!o.contactId) continue;
        if (!offersByContact.has(o.contactId)) offersByContact.set(o.contactId, []);
        offersByContact.get(o.contactId).push(o);
      }
      const listingStreetsByAgent = new Map();
      const batchListings = batch ? await store.listAllOutreachListings(locationId, { batchId: batch.id }) : [];
      for (const l of batchListings) {
        const k = normStreet(l.doc?.address);
        if (!k) continue;
        if (!listingStreetsByAgent.has(l.agentKey)) listingStreetsByAgent.set(l.agentKey, new Set());
        listingStreetsByAgent.get(l.agentKey).add(k);
      }

      const agents = rows.map((r) => {
        const matched = new Map();
        for (const street of listingStreetsByAgent.get(r.agentKey) || [])
          for (const o of offersByStreet.get(street) || []) matched.set(o.id, o);
        const cid = r.contactId || r.doc?.ghl?.contactId;
        for (const o of offersByContact.get(cid) || []) matched.set(o.id, o);
        const agentOffers = [...matched.values()]
          .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
          .slice(0, 5)
          .map((o) => ({ id: o.id, address: o.address, cashAmount: o.cashAmount, createdAt: o.createdAt }));
        return {
          agentKey: r.agentKey, status: r.status, contactId: r.contactId,
          importedAt: r.importedAt, firstSeen: r.firstSeen, lastSeen: r.lastSeen,
          ...r.doc,
          offers: agentOffers,
        };
      });

      // Month-to-date RentCast request usage (free tier = 50/month).
      const pulls = await store.listOutreachPulls(locationId, { limit: 50 });
      const monthStart = new Date();
      monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
      const requestsThisMonth = pulls
        .filter((p) => new Date(p.createdAt) >= monthStart)
        .reduce((s, p) => s + (Number(p.doc?.requestsUsed) || 0), 0);

      res.json({
        enabled, agents, tag: OUTREACH_TAG, importsEnabled: OUTREACH_IMPORTS_ENABLED,
        batch: batch ? { id: batch.id, name: batch.name, tag: batchTagFor(batch) } : null,
        usage: { requestsThisMonth, lastPullAt: pulls[0]?.createdAt || null },
      });
    } catch (err) { fail(res, err); }
  });

  router.get("/agents/:agentKey/listings", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const batch = await resolveBatch(locationId, String(req.query.batch_id || "") || null);
      if (!batch) return res.json({ listings: [] });
      const rows = await store.listOutreachListings(locationId, { batchId: batch.id, agentKey: req.params.agentKey });
      const listings = rows
        .map((r) => ({ listingKey: r.listingKey, ...r.doc }))
        .sort((a, b) => (b.score || 0) - (a.score || 0));
      res.json({ listings });
    } catch (err) { fail(res, err); }
  });

  /* ---------- import ---------- */

  router.post("/import", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const agentKeys = Array.isArray(req.body?.agentKeys) ? req.body.agentKeys.slice(0, 200) : [];
      if (!agentKeys.length) return res.status(400).json({ error: "agentKeys required" });
      const applyTag = req.body?.applyTag !== false;
      const batch = await resolveBatch(locationId, req.body?.batchId);
      if (!batch) return res.status(400).json({ error: "no batch — pull listings first" });
      // Batch tag (e.g. "agent-outreach-queen-anne-fixers") — applied to every
      // contact regardless of applyTag, so the batch can be targeted in GHL
      // later (manual automation triggers). Derived from the batch name, so
      // it's stable across import sessions from the same batch.
      const batchTag = batchTagFor(batch);
      // Session tag — batch tag + a caller-supplied suffix (the UI defaults it
      // to date+time), unique per import click so same-day imports from one
      // batch stay individually targetable in GHL. Empty suffix = no session tag.
      const sessionSuffix = sanitizeTag(req.body?.sessionTag);
      const sessionTag = sessionSuffix ? sanitizeTag(`${batchTag}-${sessionSuffix}`) : null;
      // Live only when explicitly requested AND enabled server-side — same
      // double gate as offer sends (CARD_SENDS_ENABLED).
      const dryRun = req.body?.dryRun !== false || !OUTREACH_IMPORTS_ENABLED;

      const warnings = [];
      // Resolve custom-field ids once per batch (created on first use).
      let fieldIds = null;
      if (!dryRun) {
        fieldIds = {};
        for (const f of OUTREACH_FIELDS) {
          fieldIds[f.key] = await withRetry(() =>
            findOrCreateCustomFieldByKey(client, locationId, f.key, f.name, f.dataType)
          );
        }
      }

      const results = await mapPool(agentKeys, 2, async (agentKey) => {
        try {
          const row = await store.getOutreachAgent(locationId, batch.id, agentKey);
          if (!row) return { agentKey, ok: false, error: "unknown agent" };
          if (row.status === "imported")
            return { agentKey, ok: true, alreadyImported: true, contactId: row.contactId };
          const a = row.doc;

          // Authoritative dedupe re-check at import time.
          await sleep(150);
          const match = await withRetry(() =>
            findDuplicateContact(client, locationId, { email: a.email, phone: a.phone })
          );

          if (dryRun) {
            return {
              agentKey, ok: true, dryRun: true,
              name: a.name,
              ...(match ? { wouldUpdate: true, contactId: match.id, matchedBy: match.matchedBy } : { wouldCreate: true }),
              tagWouldApply: applyTag,
            };
          }

          let contactId;
          let action;
          if (match) {
            contactId = match.id;
            action = "updated";
            // Fill blanks only — never clobber an existing name/phone/email.
            const existing = await withRetry(() => getContact(client, contactId));
            const patch = {};
            if (!existing.phone && a.phone) patch.phone = e164(a.phone);
            if (!existing.email && a.email) patch.email = a.email;
            if (!existing.firstName && !existing.lastName && a.name) {
              patch.firstName = a.firstName;
              patch.lastName = a.lastName;
            }
            if (Object.keys(patch).length) await withRetry(() => updateContact(client, contactId, patch));
          } else {
            action = "created";
            contactId = await withRetry(() =>
              createContact(client, locationId, {
                firstName: a.firstName || a.name || "Agent",
                lastName: a.lastName || "",
                ...(a.phone ? { phone: e164(a.phone) } : {}),
                ...(a.email ? { email: a.email } : {}),
                source: "agent-outreach",
              })
            );
          }
          if (!contactId) throw new Error("no contact id returned");

          const hook = a.hook || {};
          const values = {
            // Street portion only — "1911 9th Ave W, Seattle, WA 98119" → "1911 9th Ave W"
            short_hand_property_address: String(hook.address || "").split(",")[0].trim(),
            hook_address: hook.address || "",
            hook_price: hook.price || "",
            hook_dom: hook.dom || "",
            hook_url: hook.address ? zillowUrl(hook.address) || "" : "",
            brokerage: a.brokerage || "",
          };
          const customFields = OUTREACH_FIELDS
            .filter((f) => values[f.key] !== "" && values[f.key] != null)
            .map((f) => ({ id: fieldIds[f.key], value: values[f.key] }));
          if (customFields.length) await withRetry(() => updateContact(client, contactId, { customFields }));

          // Batch + session tags always; the trigger tag only when requested
          // (it fires the GHL texting workflow).
          await withRetry(() =>
            addContactTags(client, contactId, [
              batchTag,
              ...(sessionTag ? [sessionTag] : []),
              ...(applyTag ? [OUTREACH_TAG] : []),
            ])
          );
          const tagged = applyTag;

          await store.setOutreachAgentStatus(locationId, batch.id, agentKey, {
            status: "imported", contactId, importedAt: new Date().toISOString(),
          });
          return { agentKey, ok: true, name: a.name, action, contactId, tagged };
        } catch (e) {
          warnings.push(`${agentKey}: ${e.message}`);
          return { agentKey, ok: false, error: e.message };
        }
      });

      res.json({
        ok: true, dryRun, importsEnabled: OUTREACH_IMPORTS_ENABLED, tag: OUTREACH_TAG,
        batchTag, sessionTag, batchId: batch.id,
        results,
        imported: results.filter((r) => r.ok && r.action).length,
        warnings,
      });
    } catch (err) { fail(res, err); }
  });

  /* ---------- clear (reset a batch before a re-filtered pull) ---------- */

  // Remove a batch's non-imported agents (and their listings) so the next
  // pull into it starts fresh — pulls only ever add/update, so tightening
  // filters would otherwise leave stale agents. Imported agents are kept.
  router.post("/clear", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const batch = await resolveBatch(locationId, req.body?.batchId);
      if (!batch) return res.json({ ok: true, removed: 0 });
      const removed = await store.clearOutreachAgents(locationId, batch.id);
      res.json({ ok: true, removed });
    } catch (err) { fail(res, err); }
  });

  /* ---------- skip / unskip ---------- */

  router.post("/agents/:agentKey/status", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const status = String(req.body?.status || "");
      if (!["skipped", "new"].includes(status))
        return res.status(400).json({ error: 'status must be "skipped" or "new"' });
      const batch = await resolveBatch(locationId, req.body?.batchId);
      if (!batch) return res.status(404).json({ error: "unknown agent" });
      const row = await store.getOutreachAgent(locationId, batch.id, req.params.agentKey);
      if (!row) return res.status(404).json({ error: "unknown agent" });
      if (row.status === "imported")
        return res.status(400).json({ error: "imported agents can't change status" });
      await store.setOutreachAgentStatus(locationId, batch.id, req.params.agentKey, { status });
      res.json({ ok: true, status });
    } catch (err) { fail(res, err); }
  });

  return router;
}
