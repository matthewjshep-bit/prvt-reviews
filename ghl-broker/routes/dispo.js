// routes/dispo.js — Dispositions: the cash-buyer side of the business. Mirror
// the investor contacts out of GHL into a local index, search that index in
// plain English, edit a buy box back into GHL, match an under-contract deal to
// a ranked shortlist, and tag the shortlist so a GHL workflow blasts it.
//
//   GET    /api/dispo/investors                     the local book + sync status
//   POST   /api/dispo/sync                          re-pull tagged contacts from GHL
//   GET    /api/dispo/investors/:contactId          one investor + their deal history
//   PUT    /api/dispo/investors/:contactId/buybox   write changed buy-box fields to GHL
//   POST   /api/dispo/investors/:contactId/status   archive / unarchive (local only)
//   POST   /api/dispo/search                        plain-English buy-box search
//   POST   /api/dispo/match                         rank investors against one deal
//   POST   /api/dispo/blast                         bulk-tag a shortlist (dry-run by default)
//
// GHL stays the source of truth for contacts; the `investors` table is a
// rebuildable search cache. Sync is read-only against GHL and therefore has no
// dry-run gate — the two endpoints that WRITE (buybox, blast) are the guarded
// ones, and blast carries the same double gate as the agent-outreach import.

import express from "express";
import { store } from "../store.js";
import { mapPool } from "../map-pool.js";
import {
  searchAllContactsByTags, getContact, updateContact,
  findOrCreateCustomFieldByKey, customFieldIdKeyMap, contactCustomRecord,
  addContactTags,
} from "../ghl.js";
import { anthropicErrorToHttp } from "../rehab-scan.js";
import {
  BUYBOX_FIELDS, RANK_LIMIT, buildBuyboxProfile, dealToQuery,
  parseBuyboxQuery, rankInvestors,
} from "../dispo.js";
import {
  applyBuyboxFilters, buyboxIsEmpty, normalizeBuybox, normalizeQuery, queryIsEmpty,
} from "../shared/buybox.js";

const DISPO_BLASTS_ENABLED = process.env.DISPO_BLASTS_ENABLED === "true";
const DISPO_TAG = process.env.DISPO_TAG || "dispo-blast";

// Contacts carrying any of these tags are investors. Overridable per location
// in Settings (dispoTags) — some locations tag their buyers differently.
const DEFAULT_DISPO_TAGS = ["investor", "investor-active", "investor-stale", "on-deal"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same bands the ranker is told to use, applied to a filter-only score.
const fitFor = (score) => (score >= 70 ? "strong" : score >= 40 ? "possible" : "weak");

// Retry a GHL call on 429 (2s, then 4s) — same policy as outreach import.
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

const contactName = (c) =>
  [c?.firstName, c?.lastName].filter(Boolean).join(" ").trim() ||
  c?.name || c?.contactName || c?.email || "";

// GHL tags are lowercase, hyphenated, and punctuation-free. Anything else
// silently becomes a DIFFERENT tag on their side, which would strand the blast.
const sanitizeTag = (s) =>
  String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

export default function createDispoRouter({ resolveLocation }) {
  const router = express.Router();

  const fail = (res, err) => {
    const code = err.http || err.status || 500;
    if (code >= 500) console.error("dispo error:", code, err.message, err.detail || "");
    res.status(code).json({ error: err.message, detail: err.detail });
  };

  const getSettings = async (locationId) => (await store.getOfferSettings(locationId)) || {};

  const dispoTags = (saved) => {
    const configured = String(saved?.dispoTags || "")
      .split(",").map((t) => t.trim()).filter(Boolean);
    return configured.length ? configured : DEFAULT_DISPO_TAGS;
  };

  // The Anthropic key lives in per-location settings, not env — same message
  // as the deal investor suggestions so the operator learns one fix.
  const requireAiKey = (saved) => {
    const key = String(saved?.aiApiKey || "").trim();
    if (!key) {
      throw Object.assign(
        new Error("Anthropic API key required — add it in Settings → AI features"),
        { http: 400 }
      );
    }
    return key;
  };

  // Rehydrate a stored row into the shape buybox.js and the ranker expect.
  const hydrate = (row) => ({
    contactId: row.contactId,
    name: row.name || row.doc?.name || "",
    status: row.status,
    buyboxText: row.buyboxText,
    syncedAt: row.syncedAt,
    lastBlastAt: row.lastBlastAt,
    ...row.doc,
    buybox: normalizeBuybox(row.doc?.custom || {}),
  });

  // Every deal this contact is linked to, newest first — the join the UI
  // shows under an expanded investor row.
  async function dealsFor(locationId, contactId) {
    const out = [];
    for (const offer of await store.listDeals(locationId)) {
      const link = (offer.deal?.investors || []).find((i) => i.contactId === contactId);
      if (!link) continue;
      out.push({
        offerId: offer.id,
        address: offer.address,
        stage: offer.deal.stage,
        status: link.status,
        assignmentFee: offer.deal.assignmentFee ?? null,
        createdAt: offer.deal.createdAt || offer.createdAt,
      });
    }
    return out.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  }

  /* ---------- read ---------- */

  router.get("/investors", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const rows = await store.listInvestors(locationId, {
        status: req.query.status || null,
      });
      const investors = rows.map(hydrate);
      res.json({
        ok: true,
        investors,
        counts: {
          total: investors.length,
          active: investors.filter((i) => i.status !== "archived").length,
          needsBuybox: investors.filter((i) => buyboxIsEmpty(i.buybox)).length,
        },
        syncedAt: investors.reduce(
          (max, i) => (String(i.syncedAt || "") > String(max || "") ? i.syncedAt : max),
          null
        ),
        tags: dispoTags(await getSettings(locationId)),
      });
    } catch (err) { fail(res, err); }
  });

  router.get("/investors/:contactId", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const row = await store.getInvestor(locationId, req.params.contactId);
      if (!row) return res.status(404).json({ error: "investor not found — run a sync first" });
      res.json({
        ok: true,
        investor: hydrate(row),
        deals: await dealsFor(locationId, req.params.contactId),
      });
    } catch (err) { fail(res, err); }
  });

  /* ---------- sync ---------- */

  // Pull every contact carrying one of the configured tags and rebuild the
  // local index. Read-only against GHL, so no dry-run gate.
  router.post("/sync", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const saved = await getSettings(locationId);
      const tags = dispoTags(saved);
      const warnings = [];

      const { contacts, truncated } = await searchAllContactsByTags(client, locationId, tags);
      // One field-definition fetch for the whole book, not one per contact.
      const idKeyMap = await customFieldIdKeyMap(client, locationId);

      const rows = contacts.map((c) => {
        const custom = contactCustomRecord(c, idKeyMap);
        const doc = {
          name: contactName(c),
          email: c.email || "",
          phone: c.phone || "",
          tags: Array.isArray(c.tags) ? c.tags : [],
          custom,
          lastConvoSummary: custom.last_convo_summary || "",
          lastConvoDate: custom.last_convo_date || "",
          dealHistory: custom.investor_deal_history || "",
          enrichLastRun: custom.enrich_last_run || "",
        };
        const buybox = normalizeBuybox(custom);
        return {
          contactId: c.id,
          name: doc.name,
          doc,
          buyboxText: buildBuyboxProfile({ ...doc, buybox }),
        };
      });

      const { created, updated } = await store.upsertInvestors(locationId, rows);

      // Prune only after a COMPLETE walk. On a truncated sync the contacts we
      // never saw are indistinguishable from the ones who lost their tag, and
      // pruning would delete the tail of the book.
      let removed = 0;
      if (truncated) {
        warnings.push(
          `Only the first ${rows.length} investors were read — untagged contacts were not pruned. ` +
          `Narrow the tag list in Settings if this repeats.`
        );
      } else {
        removed = await store.deleteMissingInvestors(locationId, rows.map((r) => r.contactId));
      }

      res.json({ ok: true, synced: rows.length, created, updated, removed, truncated, tags, warnings });
    } catch (err) { fail(res, err); }
  });

  /* ---------- buy box write-back ---------- */

  const FIELD_BY_KEY = new Map(BUYBOX_FIELDS.map((f) => [f.key, f]));

  // Validate one submitted buy-box value against the registry's own vocabulary.
  // Returns the string to store, or throws with the offending key.
  function validateField(key, value) {
    const def = FIELD_BY_KEY.get(key);
    if (!def) throw Object.assign(new Error(`unknown buy box field: ${key}`), { http: 400 });
    const raw = value == null ? "" : String(value).trim();
    if (!raw) return "";
    if (def.dataType === "NUMERICAL") {
      const n = Number(raw.replace(/[$,\s]/g, ""));
      if (!Number.isFinite(n) || n < 0) {
        throw Object.assign(new Error(`${def.name} must be a positive number`), { http: 400 });
      }
      return String(Math.round(n));
    }
    if (def.values) {
      // multi-value fields (property types) are comma-joined in GHL.
      const parts = def.multi ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [raw];
      for (const p of parts) {
        if (!def.values.includes(p)) {
          throw Object.assign(
            new Error(`${def.name}: "${p}" is not one of ${def.values.join(", ")}`),
            { http: 400 }
          );
        }
      }
      return parts.join(", ");
    }
    return raw;
  }

  router.put("/investors/:contactId/buybox", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const contactId = req.params.contactId;
      const row = await store.getInvestor(locationId, contactId);
      if (!row) return res.status(404).json({ error: "investor not found — run a sync first" });

      const submitted = req.body?.buybox || {};
      const existing = row.doc?.custom || {};

      // Only fields the operator actually CHANGED are written. A blind write
      // of the whole buy box would stamp the AI's last extraction back over
      // anything the enrichment sweep refined since this row was synced.
      const changed = {};
      for (const [key, value] of Object.entries(submitted)) {
        if (!FIELD_BY_KEY.has(key)) continue;
        const next = validateField(key, value);
        if (next !== String(existing[key] ?? "").trim()) changed[key] = next;
      }
      if (!Object.keys(changed).length) {
        return res.json({ ok: true, changed: [], investor: hydrate(row) });
      }

      const customFields = [];
      for (const [key, value] of Object.entries(changed)) {
        const def = FIELD_BY_KEY.get(key);
        const id = await withRetry(() =>
          findOrCreateCustomFieldByKey(client, locationId, def.key, def.name, def.dataType)
        );
        customFields.push({ id, value });
      }
      await withRetry(() => updateContact(client, contactId, { customFields }));

      // Mirror the write locally so the UI and the next search see it without
      // waiting for a full re-sync.
      const custom = { ...existing, ...changed };
      const doc = {
        ...row.doc,
        custom,
        dealHistory: custom.investor_deal_history || row.doc?.dealHistory || "",
      };
      const buybox = normalizeBuybox(custom);
      await store.updateInvestorDoc(
        locationId, contactId, doc, buildBuyboxProfile({ ...doc, buybox })
      );

      const fresh = await store.getInvestor(locationId, contactId);
      res.json({ ok: true, changed: Object.keys(changed), investor: hydrate(fresh) });
    } catch (err) { fail(res, err); }
  });

  router.post("/investors/:contactId/status", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const status = String(req.body?.status || "").trim();
      if (!["active", "archived"].includes(status)) {
        return res.status(400).json({ error: "status must be active or archived" });
      }
      const ok = await store.setInvestorStatus(locationId, req.params.contactId, { status });
      if (!ok) return res.status(404).json({ error: "investor not found" });
      res.json({ ok: true, status });
    } catch (err) { fail(res, err); }
  });

  /* ---------- search + match ---------- */

  // Shared tail of both search paths: filter locally, rank what survives.
  // `parsed` is an already-normalized query; `target` is what the ranker is
  // told we're placing.
  async function shortlist({ locationId, parsed, target, aiApiKey, extraInstructions, strict, excludeIds }) {
    const rows = await store.listInvestors(locationId, { status: "active" });
    const pool = rows.map(hydrate).filter((i) => !excludeIds?.has(i.contactId));
    const survivors = applyBuyboxFilters(pool, parsed, { strict });

    // Deterministic order already; the model only re-ranks what fits in one call.
    const candidates = survivors.slice(0, RANK_LIMIT);
    let rankings = [];
    let rankWarning = null;
    // No key means filter-only: the structured filters still work, they just
    // come back in the deterministic order with no reasons attached.
    if (candidates.length && aiApiKey) {
      try {
        rankings = await rankInvestors({ target, candidates, aiApiKey, extraInstructions });
      } catch (e) {
        // A ranking failure must not lose the search: the filter already did
        // the honest structural work, so fall back to its scores and say so.
        if (e.http === 502) rankWarning = e.message;
        else throw anthropicErrorToHttp(e);
      }
    }

    const byId = new Map(rankings.map((r) => [r.contactId, r]));
    const results = candidates
      .map((c) => {
        const r = byId.get(c.contactId);
        const score = r?.score ?? c.match.score;
        return {
          contactId: c.contactId,
          name: c.name,
          buybox: c.buybox,
          buyboxText: c.buyboxText,
          lastBlastAt: c.lastBlastAt,
          match: c.match,
          // No ranking (no key, or the call failed) → fall back to the
          // filter's own score, banded the same way the ranker bands its
          // own, so an undocumented buy box reads as the long shot it is
          // rather than being flattered to "possible".
          score,
          fit: r?.fit || fitFor(score),
          reason: r?.reason || "",
          ranked: Boolean(r),
        };
      })
      .sort((a, b) => b.score - a.score);

    return {
      results,
      scanned: pool.length,
      filtered: survivors.length,
      shortlisted: candidates.length,
      rankedByAi: rankings.length,
      truncated: survivors.length > candidates.length,
      warnings: rankWarning ? [rankWarning] : [],
    };
  }

  router.post("/search", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const saved = await getSettings(locationId);
      const question = String(req.body?.query || "").trim();
      const strict = req.body?.strict === true;
      const extraInstructions = String(saved?.enrichExtraInstructions || "").trim();

      // A chip edit (or the plain structured filters) re-runs against a query
      // the UI already holds — no parse call, so it's instant, free, and works
      // without an Anthropic key at all. Only free text needs the model.
      const aiApiKey = String(saved?.aiApiKey || "").trim();
      let parsed;
      if (req.body?.parsed) {
        parsed = normalizeQuery(req.body.parsed);
      } else {
        if (!question) return res.status(400).json({ error: "query required" });
        requireAiKey(saved);
        try {
          parsed = await parseBuyboxQuery({ query: question, aiApiKey, extraInstructions });
        } catch (e) { throw anthropicErrorToHttp(e); }
      }

      if (queryIsEmpty(parsed)) {
        return res.json({
          ok: true, parsed, results: [], scanned: 0, filtered: 0, ranked: 0, truncated: false,
          empty: true,
          reason: "Nothing to filter on — name an area, a price, a property type, or a rehab level.",
        });
      }

      const out = await shortlist({
        locationId, parsed,
        target: { question: question || null, query: parsed },
        aiApiKey, extraInstructions, strict,
      });
      res.json({ ok: true, parsed, ...out });
    } catch (err) { fail(res, err); }
  });

  router.post("/match", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const offerId = String(req.body?.offerId || "").trim();
      if (!offerId) return res.status(400).json({ error: "offerId required" });
      const offer = await store.getOffer(offerId);
      if (!offer || offer.locationId !== locationId) return res.status(404).json({ error: "offer not found" });
      if (!offer.deal) return res.status(400).json({ error: "this offer is not tracked as a deal" });

      const saved = await getSettings(locationId);
      // The query comes from the deal's own numbers, so no parse call and no
      // key needed — the key only buys AI ranking and the per-investor reason.
      const aiApiKey = String(saved?.aiApiKey || "").trim();
      const target = dealToQuery(offer);
      // Investors already on the deal are ranked out, not greyed out — the
      // question this answers is "who else", and the linked ones come back
      // separately so the UI can show them as already-linked.
      const linked = (offer.deal.investors || []).map((i) => ({ contactId: i.contactId, name: i.name, status: i.status }));

      const out = await shortlist({
        locationId,
        parsed: target.query,
        target,
        aiApiKey,
        extraInstructions: String(saved?.enrichExtraInstructions || "").trim(),
        strict: req.body?.strict === true,
        excludeIds: new Set(linked.map((i) => i.contactId)),
      });

      res.json({
        ok: true,
        offer: { id: offer.id, address: offer.address, stage: offer.deal.stage },
        parsed: target.query,
        linked,
        ...out,
      });
    } catch (err) { fail(res, err); }
  });

  /* ---------- blast ---------- */

  // Bulk-apply a GHL tag to a shortlist so a workflow can text/email them the
  // deal. Same double gate as the agent-outreach import: live only when the
  // caller explicitly asks AND the server allows it.
  router.post("/blast", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const contactIds = Array.isArray(req.body?.contactIds) ? req.body.contactIds.slice(0, 200) : [];
      if (!contactIds.length) return res.status(400).json({ error: "contactIds required" });

      const saved = await getSettings(locationId);
      const prefix = sanitizeTag(saved?.dispoBlastTagPrefix || "dispo") || "dispo";
      // Deal-scoped tag (e.g. "dispo-2010-ne-54th-st") so the GHL workflow can
      // target this blast alone; falls back to the bare prefix when no label
      // was supplied. The trigger tag fires the workflow.
      const label = sanitizeTag(req.body?.label);
      const blastTag = label ? sanitizeTag(`${prefix}-${label}`) : prefix;
      const applyTag = req.body?.applyTag !== false;
      const dryRun = req.body?.dryRun !== false || !DISPO_BLASTS_ENABLED;

      const warnings = [];
      const results = await mapPool(contactIds, 2, async (contactId) => {
        try {
          const row = await store.getInvestor(locationId, contactId);
          if (!row) return { contactId, ok: false, error: "unknown investor" };
          if (dryRun) {
            return { contactId, ok: true, dryRun: true, name: row.name, lastBlastAt: row.lastBlastAt };
          }
          await sleep(150);
          // Confirm the contact still exists before tagging — an investor
          // deleted in GHL since the last sync would otherwise 404 mid-batch.
          await withRetry(() => getContact(client, contactId));
          await withRetry(() =>
            addContactTags(client, contactId, [blastTag, ...(applyTag ? [DISPO_TAG] : [])])
          );
          const at = new Date().toISOString();
          await store.setInvestorStatus(locationId, contactId, { lastBlastAt: at });
          return { contactId, ok: true, name: row.name, tagged: true, blastedAt: at };
        } catch (e) {
          warnings.push(`${contactId}: ${e.message}`);
          return { contactId, ok: false, error: e.message };
        }
      });

      res.json({
        ok: true, dryRun, blastsEnabled: DISPO_BLASTS_ENABLED,
        blastTag, triggerTag: applyTag ? DISPO_TAG : null,
        results,
        blasted: results.filter((r) => r.ok && r.tagged).length,
        warnings,
      });
    } catch (err) { fail(res, err); }
  });

  return router;
}
