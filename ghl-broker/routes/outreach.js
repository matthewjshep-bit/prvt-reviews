// routes/outreach.js — Agent Outreach: pull active MLS listings from RentCast,
// group them by listing agent, score each listing for "fixer-ness" (the best
// one becomes the agent's outreach hook), flag agents already in GHL, and bulk
// import selected agents as GHL contacts (custom fields + tag — the tag fires
// the outreach workflow inside GHL). Mounted at /api/outreach.
//
//   GET  /api/outreach/agents                        saved agents + request-meter usage
//   GET  /api/outreach/agents/:agentKey/listings     one agent's listings, ranked
//   POST /api/outreach/pull                          fetch + score + persist (manual now, cron later)
//   POST /api/outreach/import                        bulk import to GHL (dry-run by default)
//   POST /api/outreach/agents/:agentKey/status       skip / unskip
//
// RentCast is billed per REQUEST (up to 500 listings each, free tier 50/mo),
// so pulls carry a hard request budget and a 24h cache, and every pull is
// recorded to power the month-to-date meter in the UI.

import express from "express";
import { store } from "../store.js";
import { mapPool } from "../map-pool.js";
import { scoreListing, medianPricePerSqft, priceCuts } from "../outreach-score.js";
import { zillowUrl } from "../shared/us-address.js";
import {
  findDuplicateContact, createContact, getContact, updateContact,
  addContactTags, findOrCreateCustomFieldByKey,
} from "../ghl.js";

const OUTREACH_TAG = process.env.OUTREACH_TAG || "agent-outreach";
const OUTREACH_IMPORTS_ENABLED = process.env.OUTREACH_IMPORTS_ENABLED === "true";

// Contact custom fields written on import (created on demand, like OFFER_FIELDS).
const OUTREACH_FIELDS = [
  { key: "hook_address", name: "Hook Address", dataType: "TEXT" },
  { key: "hook_price", name: "Hook Price", dataType: "NUMERICAL" },
  { key: "hook_dom", name: "Hook Days on Market", dataType: "NUMERICAL" },
  { key: "hook_url", name: "Hook URL", dataType: "TEXT" },
  { key: "brokerage", name: "Brokerage", dataType: "TEXT" },
];

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

  /* ---------- pull ---------- */

  // Resolve pull targets from the request body, falling back to the location's
  // saved defaults so a future Render Cron can POST with just location_id.
  function pullParams(body, settings) {
    const zips = (Array.isArray(body.zipCodes) ? body.zipCodes.join(",") : String(body.zipCodes || settings.outreachZips || ""))
      .split(",").map((z) => z.trim()).filter((z) => /^\d{5}$/.test(z));
    const city = String(body.city ?? settings.outreachCity ?? "").trim();
    const state = String(body.state ?? settings.outreachState ?? "").trim().toUpperCase();
    const daysOld = Math.min(365, Math.max(1, parseInt(body.daysOld, 10) || parseInt(settings.outreachDaysOld, 10) || 180));
    const propertyType = String(body.propertyType || "").trim();
    const maxRequests = Math.min(5, Math.max(1, parseInt(body.maxRequests, 10) || 3));
    // Post-fetch filters (applied to the cohort, not the RentCast query):
    // keep listings within ±N% of the pull's median price, and/or only
    // below-market ones (price-cut history or cheap $/sqft vs cohort median).
    const priceBandPct = Math.min(75, Math.max(0, parseInt(body.priceBandPct, 10) || 0));
    const belowMarketOnly = body.belowMarketOnly === true;
    return { zips, city, state, daysOld, propertyType, maxRequests, priceBandPct, belowMarketOnly };
  }

  async function runPull(locationId, client, body) {
    const settings = await getSettings(locationId);
    const apiKey = String(settings.rentcastApiKey || "").trim();
    if (!apiKey) throw Object.assign(new Error("RentCast API key not configured — add it in Settings"), { http: 400 });

    const { zips, city, state, daysOld, propertyType, maxRequests, priceBandPct, belowMarketOnly } =
      pullParams(body, settings);
    // One RentCast query per zip; else one for city/state.
    const targets = zips.length
      ? zips.map((z) => ({ zipCode: z }))
      : city && state
        ? [{ city, state }]
        : null;
    if (!targets) throw Object.assign(new Error("no market configured — set zip codes or city/state"), { http: 400 });

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
        while (budgetLeft > 0) {
          budgetLeft--;
          requestsUsed++;
          const page = await rentcastPage(apiKey, { ...common, ...target, ...(offset ? { offset: String(offset) } : {}) });
          listings.push(...page);
          if (page.length < 500) break; // last page for this target
          offset += 500;
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

    // Cohort medians come from the FULL pull (pre-filter) so they describe the
    // market, not the filtered slice.
    const medianPpsf = medianPricePerSqft(listings);
    const prices = listings.map((l) => Number(l.price)).filter((p) => p > 0).sort((a, b) => a - b);
    const medianPrice = prices.length
      ? prices.length % 2 ? prices[(prices.length - 1) / 2] : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
      : 0;

    let pool = listings;
    if (priceBandPct && medianPrice) {
      const lo = medianPrice * (1 - priceBandPct / 100);
      const hi = medianPrice * (1 + priceBandPct / 100);
      const before = pool.length;
      pool = pool.filter((l) => Number(l.price) >= lo && Number(l.price) <= hi);
      warnings.push(`price band ±${priceBandPct}% of $${Math.round(medianPrice).toLocaleString()} median kept ${pool.length} of ${before}`);
    }
    if (belowMarketOnly) {
      const before = pool.length;
      pool = pool.filter((l) => {
        const cheap =
          Number(l.price) > 0 && Number(l.squareFootage) > 0 && medianPpsf > 0 &&
          Number(l.price) / Number(l.squareFootage) <= 0.9 * medianPpsf;
        return cheap || priceCuts(l).count > 0;
      });
      warnings.push(`below-market filter kept ${pool.length} of ${before}`);
    }

    const byAgent = new Map();
    const listingRows = [];
    let droppedNoAgent = 0;
    for (const l of pool) {
      const idc = agentIdentity(l);
      if (!idc.agentKey) { droppedNoAgent++; continue; }
      const { score, components } = scoreListing(l, { medianPpsf });
      const key = listingKey(l);
      const address = l.formattedAddress || [l.addressLine1, l.city, l.state, l.zipCode].filter(Boolean).join(", ");
      const docListing = {
        address, city: l.city, state: l.state, zip: l.zipCode,
        price: l.price, daysOnMarket: l.daysOnMarket, listedDate: l.listedDate,
        yearBuilt: l.yearBuilt, sqft: l.squareFootage, propertyType: l.propertyType,
        mlsName: l.mlsName, mlsNumber: l.mlsNumber, score, components,
      };
      listingRows.push({ listingKey: key, agentKey: idc.agentKey, doc: docListing });
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
    // GHL for the agents we haven't matched yet.
    const agentRows = [];
    let agentsNew = 0;
    for (const [agentKey, g] of byAgent) {
      const stored = await store.getOutreachAgent(locationId, agentKey);
      if (!stored) agentsNew++;
      const officePhone = normPhone(
        listings.find((l) => agentIdentity(l).agentKey === agentKey)?.listingOffice?.phone
      );
      const hook = g.listings.slice().sort((a, b) => b.score - a.score)[0];
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
            dom: hook.daysOnMarket, score: hook.score, components: hook.components,
          },
          listingCount: g.listings.length,
        },
      });
    }

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

    await store.upsertOutreachListings(locationId, listingRows);
    await store.upsertOutreachAgents(locationId, agentRows.map(({ agentKey, doc }) => ({ agentKey, doc })));
    await store.recordOutreachPull(locationId, {
      params: { targets, daysOld, propertyType, maxRequests, priceBandPct, belowMarketOnly },
      requestsUsed, cached, listingsFetched: listings.length, listingsKept: pool.length,
      agentsTotal: byAgent.size, agentsNew, medianPpsf: Math.round(medianPpsf),
      medianPrice: Math.round(medianPrice),
    });

    return {
      ok: true, cached, requestsUsed,
      listingsFetched: listings.length, listingsKept: pool.length,
      medianPrice: Math.round(medianPrice),
      agentsTotal: byAgent.size, agentsNew,
      warnings,
    };
  }

  router.post("/pull", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      res.json(await runPull(locationId, client, req.body || {}));
    } catch (err) { fail(res, err); }
  });

  /* ---------- list ---------- */

  router.get("/agents", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const settings = await getSettings(locationId);
      const enabled = Boolean(String(settings.rentcastApiKey || "").trim());

      const rows = await store.listOutreachAgents(locationId, {
        status: String(req.query.status || "") || null,
      });
      const agents = rows.map((r) => ({
        agentKey: r.agentKey, status: r.status, contactId: r.contactId,
        importedAt: r.importedAt, firstSeen: r.firstSeen, lastSeen: r.lastSeen,
        ...r.doc,
      }));

      // Month-to-date RentCast request usage (free tier = 50/month).
      const pulls = await store.listOutreachPulls(locationId, { limit: 50 });
      const monthStart = new Date();
      monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
      const requestsThisMonth = pulls
        .filter((p) => new Date(p.createdAt) >= monthStart)
        .reduce((s, p) => s + (Number(p.doc?.requestsUsed) || 0), 0);

      res.json({
        enabled, agents, tag: OUTREACH_TAG, importsEnabled: OUTREACH_IMPORTS_ENABLED,
        usage: { requestsThisMonth, lastPullAt: pulls[0]?.createdAt || null },
      });
    } catch (err) { fail(res, err); }
  });

  router.get("/agents/:agentKey/listings", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const rows = await store.listOutreachListings(locationId, { agentKey: req.params.agentKey });
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
          const row = await store.getOutreachAgent(locationId, agentKey);
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

          let tagged = false;
          if (applyTag) {
            await withRetry(() => addContactTags(client, contactId, [OUTREACH_TAG]));
            tagged = true;
          }

          await store.setOutreachAgentStatus(locationId, agentKey, {
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
        results,
        imported: results.filter((r) => r.ok && r.action).length,
        warnings,
      });
    } catch (err) { fail(res, err); }
  });

  /* ---------- clear (reset before a re-filtered pull) ---------- */

  // Remove all non-imported agents (and their listings) so the next pull
  // starts fresh — pulls only ever add/update, so tightening filters would
  // otherwise leave stale agents in the list. Imported agents are kept.
  router.post("/clear", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const removed = await store.clearOutreachAgents(locationId);
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
      const row = await store.getOutreachAgent(locationId, req.params.agentKey);
      if (!row) return res.status(404).json({ error: "unknown agent" });
      if (row.status === "imported")
        return res.status(400).json({ error: "imported agents can't change status" });
      await store.setOutreachAgentStatus(locationId, req.params.agentKey, { status });
      res.json({ ok: true, status });
    } catch (err) { fail(res, err); }
  });

  return router;
}
