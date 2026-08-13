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
  searchAllContactsByTags, getContact, updateContact, listLocationTags,
  findOrCreateCustomFieldByKey, customFieldIdKeyMapForDefs, contactCustomRecord,
  addContactTags, scanConversationsByContact, lastInboundByContact,
} from "../ghl.js";
import { anthropicErrorToHttp } from "../rehab-scan.js";
import {
  BUYBOX_FIELDS, INVESTOR_FIELD_DEFS, RANK_LIMIT, buildBuyboxProfile, dealToQuery,
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

// Where a contact stands:
//   replied  — they have answered us at least once (lastRepliedAt holds when)
//   awaiting — we have messaged them and they have never answered
//   never    — no conversation on record at all
//
// Keyed on EVER having replied, not on who sent the last message. The first
// version used last-message direction and it was wrong in the way that matters:
// one bulk send re-stamps every contact as "we spoke last", so 1,267 investors
// read "No reply" on the same day — including people whose buy box exists only
// because they told us what they buy. Who spoke last is still worth showing
// (lastMessageAt / lastMessageDirection), it just isn't the state.
const replyState = (i) => {
  if (i.lastRepliedAt) return "replied";
  return i.lastMessageAt ? "awaiting" : "never";
};

const contactName = (c) =>
  [c?.firstName, c?.lastName].filter(Boolean).join(" ").trim() ||
  c?.name || c?.contactName || c?.email || "";

// GHL tags are lowercase, hyphenated, and punctuation-free. Anything else
// silently becomes a DIFFERENT tag on their side, which would strand the blast.
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

  // The tag patterns as configured — may contain wildcards.
  const dispoTagPatterns = (saved) => {
    const configured = String(saved?.dispoTags || "")
      .split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    return configured.length ? configured : DEFAULT_DISPO_TAGS;
  };

  // Expand those patterns into concrete tag names GHL will actually match.
  //
  // GHL's contact search compares tags EXACTLY — filtering on "disposition"
  // returns nothing even though "disposition-seatac" exists — so a wildcard
  // has to be resolved against the location's real tag list before the search.
  // That also means a new market ("disposition-vashon") is picked up the next
  // time you sync, without anyone editing Settings.
  async function resolveTags(client, locationId, saved) {
    const patterns = dispoTagPatterns(saved);
    const wildcards = patterns.filter((p) => p.includes("*"));
    if (!wildcards.length) return { tags: patterns, patterns, expanded: {} };

    let all = [];
    try {
      all = await listLocationTags(client, locationId);
    } catch (e) {
      // No tag-list scope: fall back to the literal patterns minus the
      // wildcards, so a sync still runs rather than failing outright.
      return {
        tags: patterns.filter((p) => !p.includes("*")),
        patterns,
        expanded: {},
        warning: `Couldn't read the location's tag list (${e.message}) — wildcard tags were skipped.`,
      };
    }

    const expanded = {};
    const out = new Set();
    for (const p of patterns) {
      if (!p.includes("*")) { out.add(p); continue; }
      // Only `*` is special, and only as a simple glob — these are tag names,
      // not a place anyone should be writing regular expressions.
      const rx = new RegExp(`^${p.split("*").map(escapeRx).join(".*")}$`);
      const hits = all.filter((t) => rx.test(t));
      expanded[p] = hits;
      for (const h of hits) out.add(h);
    }
    return { tags: [...out], patterns, expanded };
  }

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

  // What the table needs, and nothing else. The full doc carries the flattened
  // custom-field record, the ranking profile, the conversation summary and the
  // whole property-history ledger — fine for one investor, several megabytes
  // across a book of a few thousand. The expanded row fetches the full record
  // for the one investor it opens.
  const slim = (i) => ({
    contactId: i.contactId,
    name: i.name,
    status: i.status,
    buybox: i.buybox,
    onLiveDeal: i.onLiveDeal,
    lastBlastAt: i.lastBlastAt,
    syncedAt: i.syncedAt,
    tags: i.tags || [],
    email: i.email || "",
    phone: i.phone || "",
    lastConvoDate: i.lastConvoDate || "",
    enrichLastRun: i.enrichLastRun || "",
    lastMessageAt: i.lastMessageAt || "",
    lastMessageDirection: i.lastMessageDirection || "",
    lastRepliedAt: i.lastRepliedAt || "",
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

  // Contacts linked to a deal that is still live (not closed or dead). The
  // point of excluding them is "who ELSE can buy something" — a buyer already
  // working one of your contracts is not available for the next one.
  async function liveDealContactIds(locationId) {
    const LIVE = new Set(["under_contract", "buyer_found", "assigned"]);
    const ids = new Set();
    for (const offer of await store.listDeals(locationId)) {
      if (!LIVE.has(offer.deal?.stage)) continue;
      for (const i of offer.deal.investors || []) {
        // Someone who already passed on this deal is free for the next one.
        if (i.status !== "passed") ids.add(i.contactId);
      }
    }
    return ids;
  }

  // Book-level filter params, shared by /search and /match.
  const readFilters = (body = {}) => ({
    excludeOnDeal: body.excludeOnDeal === true,
    buyboxStatus: ["documented", "missing"].includes(body.buyboxStatus) ? body.buyboxStatus : "all",
    replyStatus: ["replied", "awaiting", "never"].includes(body.replyStatus) ? body.replyStatus : "all",
    notBlastedDays: Number(body.notBlastedDays) > 0 ? Number(body.notBlastedDays) : 0,
  });

  /* ---------- read ---------- */

  router.get("/investors", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const rows = await store.listInvestors(locationId, {
        status: req.query.status || null,
      });
      // Stamped per investor rather than left to the client: only the server
      // can see the deals, and the browse table filters on it without a
      // second round trip.
      const onDeal = await liveDealContactIds(locationId);
      const investors = rows.map((r) => {
        const i = hydrate(r);
        return { ...i, onLiveDeal: onDeal.has(i.contactId) };
      });
      res.json({
        ok: true,
        investors: investors.map(slim),
        counts: {
          total: investors.length,
          active: investors.filter((i) => i.status !== "archived").length,
          documented: investors.filter((i) => !buyboxIsEmpty(i.buybox)).length,
          needsBuybox: investors.filter((i) => buyboxIsEmpty(i.buybox)).length,
          onLiveDeal: investors.filter((i) => i.onLiveDeal).length,
          replied: investors.filter((i) => replyState(i) === "replied").length,
          awaiting: investors.filter((i) => replyState(i) === "awaiting").length,
          neverContacted: investors.filter((i) => replyState(i) === "never").length,
        },
        syncedAt: investors.reduce(
          (max, i) => (String(i.syncedAt || "") > String(max || "") ? i.syncedAt : max),
          null
        ),
        tags: dispoTagPatterns(await getSettings(locationId)),
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
      const { tags, patterns, expanded, warning } = await resolveTags(client, locationId, saved);
      const warnings = warning ? [warning] : [];
      if (!tags.length) {
        return res.status(400).json({
          error: `No investor tags matched. Configured: ${patterns.join(", ")}. Check Settings → Dispositions.`,
        });
      }

      const { contacts, truncated } = await searchAllContactsByTags(client, locationId, tags);

      // Who has actually answered us. Best-effort: without the
      // conversations.readonly scope the book still syncs, it just can't tell
      // "replied" from "we spoke last".
      let replies = new Map();
      let inbound = new Map();
      try {
        const scan = await scanConversationsByContact(client, locationId);
        replies = scan.byContact;

        // Who has ever ANSWERED, which is the question people actually ask of
        // a buyer list. Scoped to the investors being synced — scanning every
        // conversation in the location would multiply the cost for contacts
        // this page will never show.
        const mine = new Map();
        for (const c of contacts) {
          const hit = replies.get(c.id);
          if (hit) mine.set(c.id, hit);
        }
        const inb = await lastInboundByContact(client, mine);
        inbound = inb.lastInbound;
        if (inb.failures) {
          warnings.push(`${inb.failures} conversation${inb.failures === 1 ? "" : "s"} couldn't be read — a few reply dates may be missing.`);
        }

        if (scan.truncated) {
          warnings.push(
            `Only the ${scan.scanned.toLocaleString()} most recent conversations of ${scan.total.toLocaleString()} ` +
            `were scanned — "never contacted" may include people whose last message is older than that.`
          );
        }
      } catch (e) {
        warnings.push(
          e.status === 401 || e.status === 403
            ? "Reply status needs the conversations.readonly scope on the GHL private integration."
            : `Couldn't read conversation history (${e.message}) — reply status not updated.`
        );
      }
      // One field-definition fetch for the whole book, not one per contact.
      // Keyed by OUR field keys — GHL's own fieldKey is derived from the
      // display name and does not match what the registry calls the field.
      const idKeyMap = await customFieldIdKeyMapForDefs(client, locationId, INVESTOR_FIELD_DEFS);

      const rows = contacts.map((c) => {
        const custom = contactCustomRecord(c, idKeyMap);
        const reply = replies.get(c.id) || null;
        const repliedAt = inbound.get(c.id) || "";
        const doc = {
          name: contactName(c),
          email: c.email || "",
          phone: c.phone || "",
          tags: Array.isArray(c.tags) ? c.tags : [],
          custom,
          lastMessageAt: reply?.at || "",
          lastMessageDirection: reply?.direction || "",
          lastMessageType: reply?.type || "",
          lastRepliedAt: repliedAt,
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

      res.json({
        ok: true, synced: rows.length, created, updated, removed, truncated,
        tags, patterns, expanded, warnings,
      });
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
  async function shortlist({
    locationId, parsed, target, aiApiKey, extraInstructions, strict, excludeIds, filters = {},
  }) {
    const rows = await store.listInvestors(locationId, { status: "active" });
    let pool = rows.map(hydrate).filter((i) => !excludeIds?.has(i.contactId));

    // Book-level filters, applied before the buy-box match. These are about
    // WHO to consider at all (already working this deal, never documented,
    // just blasted) rather than whether their buy box fits.
    // Computed either way: when excluding it does the filtering, and when not
    // it still stamps each result so the UI can flag "already on a live deal"
    // rather than letting you blast someone mid-deal by accident.
    const onDeal = await liveDealContactIds(locationId);
    pool = pool.map((i) => ({ ...i, onLiveDeal: onDeal.has(i.contactId) }));
    if (filters.excludeOnDeal) pool = pool.filter((i) => !i.onLiveDeal);
    if (filters.buyboxStatus === "documented") pool = pool.filter((i) => !buyboxIsEmpty(i.buybox));
    if (filters.buyboxStatus === "missing") pool = pool.filter((i) => buyboxIsEmpty(i.buybox));
    if (filters.replyStatus !== "all") pool = pool.filter((i) => replyState(i) === filters.replyStatus);
    if (filters.notBlastedDays > 0) {
      const cutoff = Date.now() - filters.notBlastedDays * 86400000;
      pool = pool.filter((i) => !i.lastBlastAt || new Date(i.lastBlastAt).getTime() < cutoff);
    }

    const survivors = applyBuyboxFilters(pool, parsed, { strict });

    // Only investors with something on file are worth paying to rank. Sending
    // the blanks too costs real money to be told "no buy box" once per row,
    // and buries the documented fits under a wall of identical weak reasons.
    const rankable = survivors.filter((i) => !buyboxIsEmpty(i.buybox));
    const undocumented = survivors.filter((i) => buyboxIsEmpty(i.buybox));
    const candidates = rankable.slice(0, RANK_LIMIT);
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
    // Ranked (or at least documented) fits first; the undocumented tail keeps
    // its place at the bottom so the book stays complete without pretending
    // a blank buy box is a match.
    const results = [...candidates, ...undocumented]
      .map((c) => {
        const r = byId.get(c.contactId);
        const score = r?.score ?? c.match.score;
        return {
          contactId: c.contactId,
          name: c.name,
          buybox: c.buybox,
          lastBlastAt: c.lastBlastAt,
          onLiveDeal: c.onLiveDeal,
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
      documented: rankable.length,
      undocumented: undocumented.length,
      shortlisted: candidates.length,
      rankedByAi: rankings.length,
      truncated: rankable.length > candidates.length,
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
        filters: readFilters(req.body),
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
        filters: readFilters(req.body),
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
