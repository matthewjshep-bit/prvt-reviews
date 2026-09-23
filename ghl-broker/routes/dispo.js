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
import { recordEvent, recordEvents, learnFacts, forgetFact, reconcileFromGhl } from "../contact-record.js";
import { marketsFromTags, regionFor, citySlug } from "../shared/dispo-regions.js";
import { scoreBuyer, rankForDeal, dealTarget, engagementFromEvents, ENGAGEMENT_TYPES } from "../shared/buyer-score.js";
import { WA_CITY_COORDS } from "../shared/wa-city-coords.js";
import { purchaseEvents } from "../buyer-import.js";
import { DISPO_IMPORTS_ENABLED, previewCsv, startImport, getImportJob, publicImportJob, cancelImport } from "../dispo-import.js";
import { FACT_KEYS, factsAsCustom, factsEmpty } from "../shared/contact-record.js";
import { buyboxCustom, investorProfileText, refreshInvestorRow } from "../investor-row.js";
import { CURSOR_NAME as BOOK_SYNC_CURSOR } from "../investor-sync.js";
import { store } from "../store.js";
import { mapPool } from "../map-pool.js";
import { queueBlastDrafts, normalizeDispoAutopilot } from "../dispo-autopilot.js";
import { planBuyerPulse, startBuyerPulse, getBuyerPulseJob, CURSOR_NAME as PULSE_CURSOR } from "../buyer-pulse.js";
import { dealOutreachPaused, outreachPausedReason } from "../shared/offer-status.js";
import {
  searchAllContactsByTags, getContact, updateContact, listLocationTags,
  findOrCreateCustomFieldByKey, customFieldIdKeyMapForDefs, contactCustomRecord,
  addContactTags, scanConversationsByContact, lastInboundByContact,
} from "../ghl.js";
import { anthropicErrorToHttp } from "../rehab-scan.js";
import {
  BUYBOX_FIELDS, INVESTOR_FIELD_DEFS, RANK_LIMIT, dealToQuery, addressAreas,
  parseBuyboxQuery, rankInvestors,
} from "../dispo.js";
import {
  applyBuyboxFilters, buyboxIsEmpty, normalizeBuybox, normalizeQuery, queryIsEmpty,
} from "../shared/buybox.js";

const DISPO_BLASTS_ENABLED = process.env.DISPO_BLASTS_ENABLED === "true";
const CARD_SENDS_ENABLED = process.env.CARD_SENDS_ENABLED === "true";
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
    // The record first, GHL's fields under it: what they told us last week
    // beats a field written last month (investor-row.js).
    buybox: normalizeBuybox(buyboxCustom(row.doc)),
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
    // Where they buy and how — read off the dispo-city/region/type tags.
    markets: i.markets || marketsFromTags(i.tags),
    flips: i.flips || null,
    score: i.score ?? null,
    tier: i.tier || null,
    scoreParts: i.scoreParts || null,
    scoreReasons: i.scoreReasons || [],
    engagement: i.engagement || null,
  });

  // The whole book with what the page ranks on: markets, flips, engagement off
  // the timeline, and the buyer score + tier. One read per event family.
  async function scoredBook(locationId, { status = null } = {}) {
    const [rows, onDeal, flips, engEvents] = await Promise.all([
      store.listInvestors(locationId, { status }),
      liveDealContactIds(locationId),
      flipsByContact(locationId),
      store.listContactEventsSince(locationId, new Date(Date.now() - 2 * 365 * 86400000).toISOString(), { types: ENGAGEMENT_TYPES, limit: 20000 }).catch(() => []),
    ]);
    const eng = engagementFromEvents(engEvents);
    return rows.map((r) => {
      const i = hydrate(r);
      const base = {
        ...i, onLiveDeal: onDeal.has(i.contactId), markets: marketsFromTags(i.tags),
        flips: flips.get(i.contactId) || null, engagement: eng.get(i.contactId) || null,
      };
      const s = scoreBuyer(base);
      return { ...base, score: s.score, tier: s.tier, scoreParts: s.parts, scoreReasons: s.reasons };
    });
  }

  // Every property_financed event in the location, folded per contact into
  // what the table shows. Built at read time: the investors doc is replaced
  // wholesale on every sync, the timeline is not.
  async function flipsByContact(locationId) {
    const events = await store.listContactEventsSince(locationId, "1970-01-01T00:00:00.000Z", { types: ["property_financed"], limit: 50000 }).catch(() => []);
    const out = new Map();
    for (const e of events) {
      if (!e?.contactId) continue;
      const f = out.get(e.contactId) || { count: 0, lastAt: "", largest: 0, lastAddress: "", lenders: [] };
      f.count++;
      const amount = Number(e.data?.amount) || 0;
      if (amount > f.largest) f.largest = amount;
      if (String(e.at) > f.lastAt) { f.lastAt = e.at; f.lastAddress = e.address || ""; }
      const lender = e.data?.lender;
      if (lender && !f.lenders.includes(lender) && f.lenders.length < 5) f.lenders.push(lender);
      out.set(e.contactId, f);
    }
    return out;
  }

  // Market filters, shared by browse (client) and search (here).
  const matchesMarket = (i, { region, city, type }) => {
    const m = i.markets || marketsFromTags(i.tags);
    if (region && !m.regions.includes(region)) return false;
    if (city && !m.cities.includes(city)) return false;
    if (type && !m.types.includes(type)) return false;
    return true;
  };

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
    region: sanitizeTag(body.region || ""),
    city: sanitizeTag(body.city || ""),
    type: sanitizeTag(body.type || ""),
  });

  /* ---------- read ---------- */

  router.get("/investors", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      // Stamped per investor rather than left to the client: only the server
      // can see the deals and the timeline, and the browse table filters and
      // sorts on them without a second round trip.
      const investors = await scoredBook(locationId, { status: req.query.status || null });
      const tally = (pick) => investors.filter((i) => i.status !== "archived")
        .reduce((a, i) => { for (const k of pick(i)) a[k] = (a[k] || 0) + 1; return a; }, {});
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
          regions: tally((i) => i.markets.regions),
          cities: tally((i) => i.markets.cities),
          types: tally((i) => i.markets.types),
          withFlips: investors.filter((i) => i.flips).length,
          tiers: tally((i) => [i.tier]),
        },
        syncedAt: investors.reduce(
          (max, i) => (String(i.syncedAt || "") > String(max || "") ? i.syncedAt : max),
          null
        ),
        tags: dispoTagPatterns(await getSettings(locationId)),
        // The nightly re-read (investor-sync.js): when it last ran and what it found.
        nightlySync: (await store.getJobCursor?.(locationId, BOOK_SYNC_CURSOR).catch(() => null))?.doc?.last || null,
      });
    } catch (err) { fail(res, err); }
  });

  router.get("/investors/:contactId", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const row = await store.getInvestor(locationId, req.params.contactId);
      if (!row) return res.status(404).json({ error: "investor not found — run a sync first" });
      const purchases = await store.listContactEvents(locationId, req.params.contactId, { types: ["property_financed"], limit: 100 }).catch(() => []);
      res.json({
        ok: true,
        investor: hydrate(row),
        deals: await dealsFor(locationId, req.params.contactId),
        purchases: purchases.map((e) => ({ at: e.at, address: e.address, ...(e.data || {}) })),
      });
    } catch (err) { fail(res, err); }
  });

  /* ---------- sync ---------- */

  // Pull every contact carrying one of the configured tags and rebuild the
  // local index. Read-only against GHL, so no dry-run gate. The Sync button
  // and the nightly run (investor-sync.js) both come through here.
  async function syncBook({ locationId, client }) {
    const saved = await getSettings(locationId);
    const { tags, patterns, expanded, warning } = await resolveTags(client, locationId, saved);
    const warnings = warning ? [warning] : [];
    if (!tags.length) {
      throw Object.assign(
        new Error(`No investor tags matched. Configured: ${patterns.join(", ")}. Check Settings → Dispositions.`),
        { http: 400 }
      );
    }

    const { contacts, truncated } = await searchAllContactsByTags(client, locationId, tags);

    // Resolved before the conversation scans on purpose: those issue
    // thousands of requests, and when GHL throttles, whatever runs after
    // them pays for it. The field map is load-bearing for every row.
    const idKeyMap = await customFieldIdKeyMapForDefs(client, locationId, INVESTOR_FIELD_DEFS);

    // Reply state we already know. Scanning a contact's messages is the most
    // expensive thing this endpoint does, so it is only done for contacts
    // whose conversation actually moved since the last sync.
    const known = new Map(
      (await store.listInvestors(locationId)).map((r) => [
        r.contactId,
        {
          lastMessageAt: r.doc?.lastMessageAt || "",
          lastRepliedAt: r.doc?.lastRepliedAt || "",
          // When we last established the answer. Without this an empty
          // lastRepliedAt is ambiguous — "we looked and they never replied"
          // and "we have never looked" are the same blank — and reusing it
          // means the cache can never warm up.
          scannedAt: r.doc?.inboundScannedAt || "",
        },
      ])
    );

    // Who has actually answered us. Best-effort: without the
    // conversations.readonly scope the book still syncs, it just can't tell
    // "replied" from "we spoke last".
    let replies = new Map();
    let inbound = new Map();
    let scannedConversations = 0;
    // Contacts whose reply state is authoritative after this run.
    const settled = new Set();
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
        if (!hit) continue;
        const prev = known.get(c.id);
        // Their last message is inbound — they replied, and we know exactly
        // when, without opening the conversation at all.
        if (String(hit.direction || "").toLowerCase() === "inbound") {
          inbound.set(c.id, hit.at);
          settled.add(c.id);
          continue;
        }
        // Established before, and nothing has happened since — the stored
        // answer still stands, including a stored "no, never replied".
        if (prev?.scannedAt && prev.lastMessageAt === hit.at) {
          if (prev.lastRepliedAt) inbound.set(c.id, prev.lastRepliedAt);
          settled.add(c.id);
          continue;
        }
        mine.set(c.id, hit);
      }
      const inb = await lastInboundByContact(client, mine);
      for (const [cid, at] of inb.lastInbound) inbound.set(cid, at);
      for (const cid of mine.keys()) settled.add(cid);
      scannedConversations = inb.scanned;
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
        inboundScannedAt: settled.has(c.id) ? new Date().toISOString() : "",
        lastConvoSummary: custom.last_convo_summary || "",
        lastConvoDate: custom.last_convo_date || "",
        dealHistory: custom.investor_deal_history || "",
        enrichLastRun: custom.enrich_last_run || "",
      };
      return {
        contactId: c.id,
        name: doc.name,
        doc,
        buyboxText: investorProfileText(doc),
      };
    });

    // The record: every synced contact's fields fill whatever the record
    // lacks (zero extra GHL calls — the contact is in hand), and the row
    // then carries the record beside GHL's fields, so search and ranking
    // both read it record-first: a fact filed from a conversation an hour
    // ago outranks a GHL field written last month.
    const byId = new Map(contacts.map((c) => [c.id, c]));
    for (const r of rows) {
      try {
        await reconcileFromGhl({ store, locationId, contactId: r.contactId, party: "investor", contact: byId.get(r.contactId), custom: r.doc.custom });
        const facts = (await store.getContactProfile(locationId, r.contactId))?.facts || null;
        if (facts && !factsEmpty(facts)) {
          r.doc.record = factsAsCustom(facts);
          r.buyboxText = investorProfileText(r.doc);
        }
      } catch (e) { console.error(`dispo: record reconcile failed contact=${r.contactId}:`, e?.message); }
    }

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

    return {
      synced: rows.length, created, updated, removed, truncated,
      tags, patterns, expanded, scannedConversations, warnings,
    };
  }
  router.syncBook = syncBook;

  router.post("/sync", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      res.json({ ok: true, ...(await syncBook({ locationId, client })) });
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
      // What the editor showed: the record first, GHL under it.
      const existing = buyboxCustom(row.doc);

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
      // waiting for a full re-sync. The record half is re-rendered below,
      // once the edit has been filed on it.
      const custom = { ...(row.doc?.custom || {}), ...changed };
      const doc = {
        ...row.doc,
        custom,
        dealHistory: custom.investor_deal_history || row.doc?.dealHistory || "",
      };
      await store.updateInvestorDoc(locationId, contactId, doc, investorProfileText(doc));

      // The record: an operator's edit. A list value that was there and is
      // gone from what they submitted is forgotten with a tombstone, so the
      // next sweep can't put it back; anything new is a fact they stated.
      try {
        const split = (v) => String(v || "").split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
        const facts = [];
        for (const [key, next] of Object.entries(changed)) {
          if (!FACT_KEYS[key]) continue;
          if (FACT_KEYS[key].kind === "list") {
            const was = new Set(split(existing[key]).map((x) => x.toLowerCase()));
            const now = split(next);
            for (const v of split(existing[key])) if (!now.some((n) => n.toLowerCase() === v.toLowerCase())) {
              await forgetFact({ store, locationId, contactId, party: "investor", key, value: v, ref: "dispo-buybox" });
            }
            for (const v of now) if (!was.has(v.toLowerCase())) facts.push({ key, value: v, source: "operator", ref: "dispo-buybox" });
          } else if (next !== "") {
            facts.push({ key, value: next, source: "operator", ref: "dispo-buybox" });
          }
        }
        if (facts.length) await learnFacts({ store, locationId, contactId, party: "investor", facts });
      } catch (e) { console.error(`dispo: buy-box record failed contact=${contactId}:`, e?.message); }
      // learnFacts and forgetFact re-render the row as they go; this covers an
      // edit that only confirmed what the record already held.
      await refreshInvestorRow({ store, locationId, contactId });

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

  /* ---------- ranked buyers for a deal ---------- */

  // POST /rank { offerId, limit } — every active buyer scored against one deal
  // (where it is, its buyer price, the work), weighted by tier. No AI: this is
  // arithmetic on the book, instant and free, with the parts shown.
  router.post("/rank", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const offer = await store.getOffer(String(req.body?.offerId || ""));
      if (!offer || offer.locationId !== locationId) return res.status(404).json({ error: "deal not found" });
      const limit = Math.min(1000, Math.max(10, Number(req.body?.limit) || 300));
      const { target, linked, ranked, considered } = await rankedForDeal(locationId, offer);
      const results = ranked.slice(0, limit).map((i) => ({
        contactId: i.contactId, rank: i.rank, rankParts: i.rankParts, rankReasons: i.rankReasons, alreadyBlasted: i.alreadyBlasted,
      }));
      const coords = WA_CITY_COORDS[target.city] || null;
      res.json({
        ok: true,
        deal: { offerId: offer.id, address: offer.address, stage: offer.deal?.stage || null, ...target, lat: coords?.[0] ?? null, lng: coords?.[1] ?? null },
        linked: [...linked], results, considered,
      });
    } catch (err) { fail(res, err); }
  });

  /* ---------- map + charts ---------- */

  // GET /insights?region=&city=&type=&tier= — where the (filtered) book has
  // bought, and when, at what price. Read off property_financed events.
  router.get("/insights", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const f = { region: sanitizeTag(req.query.region || ""), city: sanitizeTag(req.query.city || ""), type: sanitizeTag(req.query.type || ""), tier: sanitizeTag(req.query.tier || "") };
      const book = (await scoredBook(locationId, { status: "active" }))
        .filter((i) => matchesMarket(i, f) && (!f.tier || i.tier === f.tier));
      const ids = new Set(book.map((i) => i.contactId));
      const events = (await store.listContactEventsSince(locationId, "1970-01-01T00:00:00.000Z", { types: ["property_financed"], limit: 50000 }).catch(() => []))
        .filter((e) => ids.has(e.contactId));

      const months = [];
      const now = new Date();
      for (let k = 23; k >= 0; k--) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1)); months.push(d.toISOString().slice(0, 7)); }
      const byMonth = Object.fromEntries(months.map((m) => [m, 0]));
      const BANDS = [[0, 300e3, "Under $300k"], [300e3, 500e3, "$300–500k"], [500e3, 750e3, "$500–750k"], [750e3, 1e6, "$750k–1M"], [1e6, 2e6, "$1–2M"], [2e6, Infinity, "$2M+"]];
      const byPrice = BANDS.map(([, , label]) => ({ label, count: 0 }));
      const byRegion = {}, byType = {};
      const cities = new Map();
      for (const e of events) {
        const m = String(e.at || "").slice(0, 7);
        if (m in byMonth) byMonth[m]++;
        const amt = Number(e.data?.amount) || 0;
        if (amt > 0) { const idx = BANDS.findIndex(([lo, hi]) => amt >= lo && amt < hi); if (idx >= 0) byPrice[idx].count++; }
        const st = String(e.data?.strategy || ""); if (st) byType[st] = (byType[st] || 0) + 1;
        const cityName = e.data?.city || "";
        if (cityName && String(e.data?.state || "WA").toUpperCase() === "WA") {
          const slug = citySlug(cityName);
          const reg = regionFor(cityName);
          if (reg) byRegion[reg] = (byRegion[reg] || 0) + 1;
          const c = cities.get(slug) || { city: slug, region: reg, purchases: 0, investors: new Set() };
          c.purchases++; c.investors.add(e.contactId);
          cities.set(slug, c);
        }
      }
      const cityPoints = [...cities.values()]
        .filter((c) => WA_CITY_COORDS[c.city])
        .map((c) => ({ city: c.city, region: c.region, lat: WA_CITY_COORDS[c.city][0], lng: WA_CITY_COORDS[c.city][1], purchases: c.purchases, investors: c.investors.size }))
        .sort((a, b) => b.investors - a.investors);
      res.json({
        ok: true, filters: f, investors: book.length, purchases: events.length,
        byMonth: months.map((m) => ({ month: m, count: byMonth[m] })), byPrice, byRegion, byType, cityPoints,
        tiers: book.reduce((a, i) => ((a[i.tier] = (a[i.tier] || 0) + 1), a), {}),
      });
    } catch (err) { fail(res, err); }
  });

  /* ---------- buyer import (borrower list CSV) ---------- */

  router.post("/import/preview", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      res.json({ ok: true, importsEnabled: DISPO_IMPORTS_ENABLED, ...previewCsv({ locationId, csv: req.body?.csv, fileName: String(req.body?.fileName || "").slice(0, 120) }) });
    } catch (err) { fail(res, err); }
  });

  router.post("/import", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const job = startImport({
        client, store, locationId,
        previewId: String(req.body?.previewId || ""),
        keys: Array.isArray(req.body?.keys) ? req.body.keys.map(String) : [],
        batch: String(req.body?.batch || "").slice(0, 60),
        dryRun: req.body?.dryRun !== false,
      });
      res.json({ ok: true, job: publicImportJob(job) });
    } catch (err) { fail(res, err); }
  });

  router.get("/import/status", (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      res.json({ ok: true, importsEnabled: DISPO_IMPORTS_ENABLED, job: publicImportJob(getImportJob(locationId)) });
    } catch (err) { fail(res, err); }
  });

  router.post("/import/cancel", (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      res.json({ ok: true, stopping: cancelImport(locationId) });
    } catch (err) { fail(res, err); }
  });

  /* ---------- purchase history ---------- */

  // POST /purchases { buyers: [{ contactId, purchases: [...] }] }
  // Records each financed property on the contact's timeline. Dedupe-keyed
  // per property + recording date, so re-posting a list adds nothing. The
  // retag script posts here because only the broker can reach the database.
  router.post("/purchases", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const buyers = (Array.isArray(req.body?.buyers) ? req.body.buyers : []).slice(0, 500);
      let inserted = 0, skipped = 0;
      for (const b of buyers) {
        const contactId = String(b?.contactId || "").slice(0, 64);
        const events = purchaseEvents(Array.isArray(b?.purchases) ? b.purchases.slice(0, 100) : []);
        if (!contactId || !events.length) continue;
        const r = await recordEvents({ store, locationId, contactId, party: "investor", events });
        inserted += r.inserted || 0; skipped += r.skipped || 0;
      }
      res.json({ ok: true, buyers: buyers.length, inserted, skipped });
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
    if (filters.region || filters.city || filters.type) pool = pool.filter((i) => matchesMarket(i, filters));
    // The cities they've financed in stand in for a missing buy-box area list,
    // so a Kirkland deal finds Kirkland flippers who never filled one in.
    pool = pool.map((i) => ({ ...i, fallbackAreas: marketsFromTags(i.tags).cities.map((c) => c.replace(/-/g, " ")) }));

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

      // The app-side blast: the deal in one text per buyer, staggered, sent
      // by the scheduler. Needs the deal (offerId). Tags the deal's own blast
      // tag for GHL filtering but never the trigger tag — the workflow must
      // not text them as well.
      if (req.body?.sendWith === "app") {
        const offerId = String(req.body?.offerId || "").slice(0, 64);
        if (!offerId) return res.status(400).json({ error: "sendWith app needs offerId — blast from the deal" });
        const offer = await store.getOffer(offerId);
        if (!offer || offer.locationId !== locationId || !offer.deal) return res.status(404).json({ error: "deal not found" });
        const investors = [];
        for (const contactId of contactIds) {
          const row = await store.getInvestor(locationId, contactId);
          if (row) investors.push({ contactId, name: row.name || row.doc?.name || "" });
        }
        const r = await blastFromApp({ locationId, client, offer, investors, saved, dryRun: req.body?.dryRun !== false, label: label || slugStreet(offer.address), wave: 1 });
        return res.json({ ok: true, sendWith: "app", blastTag: r.blastTag, ...r });
      }

      // The tag-and-workflow blast doesn't go through blastFromApp, so it asks
      // here. Only when it names a deal — a bare prefix blast isn't one deal's.
      const taggedOfferId = String(req.body?.offerId || "").slice(0, 64);
      if (taggedOfferId) {
        const dealOffer = await store.getOffer(taggedOfferId).catch(() => null);
        const paused = dealOffer?.locationId === locationId ? dealOutreachPaused(dealOffer.deal) : null;
        if (paused) return res.status(409).json({ error: outreachPausedReason(paused, dealOffer.address), paused });
      }

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
          // The record: this deal went out to them. The blast knows its
          // label, not its deal; the label is the street line by convention
          // and blastTagged() matches it back to the deal on read.
          await recordEvent({ store, locationId, contactId, party: "investor", type: "blast_sent", at, address: label || "",
            source: "blast", ref: blastTag, data: { tag: blastTag, label: label || "" } });
          return { contactId, ok: true, name: row.name, tagged: true, blastedAt: at };
        } catch (e) {
          warnings.push(`${contactId}: ${e.message}`);
          return { contactId, ok: false, error: e.message };
        }
      });

      // The deal remembers what it was blasted under, so the feedback package
      // can find every recipient later without guessing from the label.
      const offerId = String(req.body?.offerId || "").slice(0, 64);
      if (offerId && !dryRun) {
        try {
          const full = await store.getOffer(offerId);
          if (full?.deal && full.locationId === locationId) {
            full.deal.blastTags = [...new Set([...(full.deal.blastTags || []), blastTag])];
            await store.updateOffer(full.id, full);
          }
        } catch (e) { warnings.push(`deal tag record: ${e.message}`); }
      }
      res.json({
        ok: true, dryRun, blastsEnabled: DISPO_BLASTS_ENABLED,
        blastTag, triggerTag: applyTag ? DISPO_TAG : null,
        results,
        blasted: results.filter((r) => r.ok && r.tagged).length,
        warnings,
      });
    } catch (err) { fail(res, err); }
  });

  const slugStreet = (address) => sanitizeTag(String(address || "").split(",")[0]);

  /**
   * blastFromApp({ locationId, client, offer, investors, saved, dryRun, label, wave })
   *
   * The deal as staggered outbound drafts (dispo-autopilot.js), plus the
   * deal's own blast tag on each contact and a `blasts` entry on the deal so
   * the second wave and the feedback package know. Never the trigger tag.
   */
  async function blastFromApp({ locationId, client, offer, investors = [], saved = null, dryRun = false, label = "", wave = 1, now = Date.now() }) {
    // Somebody is probably taking this one. Every app blast comes through
    // here — the button, the blast on promote, the second wave — so this is
    // the one place that has to ask.
    const paused = dealOutreachPaused(offer?.deal);
    if (paused) {
      return { queued: 0, drafted: 0, dryRun: Boolean(dryRun), scheduled: false, paused,
               reason: outreachPausedReason(paused, offer?.address), rows: [], price: 0, blastTag: "" };
    }
    const settings = saved || await getSettings(locationId);
    const prefix = sanitizeTag(settings?.dispoBlastTagPrefix || "dispo") || "dispo";
    const blastTag = sanitizeTag(`${prefix}-${label || slugStreet(offer.address) || "deal"}`);
    const r = await queueBlastDrafts({ store, locationId, offer, investors, saved: settings, now, dryRun, sendsEnabled: CARD_SENDS_ENABLED, blastsEnabled: DISPO_BLASTS_ENABLED, label: blastTag });
    if (!dryRun && (r.queued || r.drafted)) {
      const warnings = [];
      await mapPool(investors, 2, async (inv) => {
        try { await sleep(120); await withRetry(() => addContactTags(client, inv.contactId, [blastTag])); }
        catch (e) { warnings.push(`${inv.contactId}: tag: ${e.message}`); }
      });
      const full = await store.getOffer(offer.id);
      if (full?.deal) {
        full.deal.blastTags = [...new Set([...(full.deal.blastTags || []), blastTag])];
        full.deal.blasts = [...(full.deal.blasts || []), { at: new Date(now).toISOString(), count: investors.length, queued: r.queued, drafted: r.drafted, via: "app", wave, tag: blastTag }];
        await store.updateOffer(full.id, full);
      }
      r.warnings = warnings;
    }
    return { ...r, blastTag };
  }

  /**
   * rankedForDeal(locationId, offer) → { target, linked, ranked, considered }
   *
   * Every active buyer scored against this deal (buyer-score.js), highest
   * first, with their tier and whether they've already been sent it. The one
   * ranking the page, the autopilot waves and the dataroom guard all read.
   */
  async function rankedForDeal(locationId, offer) {
    const q = dealToQuery(offer).query;
    const city = addressAreas(offer.address).find((a) => !/^\d{5}$/.test(a)) || "";
    const target = dealTarget({ city, priceMin: q.priceMin, priceMax: q.priceMax, rehabAppetite: q.rehabAppetite });
    const linked = new Set((offer.deal?.investors || []).map((i) => i.contactId));
    const blasted = new Set((await store.listContactEventsSince(locationId, new Date(Date.now() - 365 * 86400000).toISOString(), { types: ["blast_sent"], limit: 20000 }).catch(() => []))
      .filter((e) => e.offerId === offer.id).map((e) => e.contactId));
    const book = (await scoredBook(locationId, { status: "active" })).filter((i) => !linked.has(i.contactId));
    const ranked = book
      .map((i) => { const r = rankForDeal(i, target); return { ...i, rank: r.score, rankParts: r.parts, rankReasons: r.reasons, alreadyBlasted: blasted.has(i.contactId) }; })
      .sort((a, b) => b.rank - a.rank);
    return { target, linked, ranked, considered: book.length };
  }

  /**
   * matchForDeal(locationId, offer, { wave, exclude }) → { results, target }
   *
   * Who the autopilot sends a deal to. Wave 1 (on promote): VIP and Active
   * buyers at or above the first-wave match score, VIPs first. Wave 2 (no
   * commitment after the delay): anyone at or above the second-wave score who
   * hasn't been sent it yet. Always: a phone to text, not already on a live
   * deal, not already blasted this deal.
   */
  async function matchForDeal(locationId, offer, { wave = 1, exclude = "blasted" } = {}) {
    const saved = await getSettings(locationId);
    const da = normalizeDispoAutopilot(saved.dispoAutopilot);
    const { target, ranked } = await rankedForDeal(locationId, offer);
    const floor = wave === 1 ? da.minMatchScore : da.secondWaveMinScore;
    const tierOrder = { vip: 0, active: 1, cold: 2 };
    const results = ranked
      .filter((i) => i.phone && !i.onLiveDeal && i.rank >= floor)
      .filter((i) => exclude !== "blasted" || !i.alreadyBlasted)
      .filter((i) => wave !== 1 || i.tier === "vip" || i.tier === "active")
      .sort((a, b) => wave === 1 ? (tierOrder[a.tier] - tierOrder[b.tier]) || (b.rank - a.rank) : b.rank - a.rank)
      .map((i) => ({ contactId: i.contactId, name: i.name, tier: i.tier, rank: i.rank, reasons: i.rankReasons }));
    return { results, target };
  }

  /** rankBuyerForDeal(locationId, offer, contactId) → { rank, tier } | null — for the dataroom guard. */
  async function rankBuyerForDeal(locationId, offer, contactId) {
    const { ranked } = await rankedForDeal(locationId, offer);
    const i = ranked.find((x) => x.contactId === contactId);
    return i ? { rank: i.rank, tier: i.tier, reasons: i.rankReasons } : null;
  }

  /* ---------- the check-in between deals ---------- */

  // Status: the switches, what the broker allows, the last run, and who
  // today's run would pick (counts only — a dry run lists them).
  router.get("/pulse", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const saved = await getSettings(locationId);
      const cursor = await store.getJobCursor?.(locationId, PULSE_CURSOR).catch(() => null);
      const plan = await planBuyerPulse({ locationId, saved, store, deps: { book: (loc) => scoredBook(loc, { status: "active" }) } });
      res.json({
        ok: true, settings: plan.settings, sendsEnabled: CARD_SENDS_ENABLED, blastsEnabled: DISPO_BLASTS_ENABLED,
        counts: plan.counts, wouldPick: plan.picks.length,
        lastRunAt: cursor?.doc?.lastDaily || null, last: cursor?.doc?.last || null, run: cursor?.doc?.run || null,
        tries: cursor?.doc?.tries || 0, failed: Boolean(cursor?.doc?.failed), job: getBuyerPulseJob(locationId),
      });
    } catch (err) { fail(res, err); }
  });

  // Run now. A dry run (the default) picks and reports and touches nothing.
  router.post("/pulse/run", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const saved = await getSettings(locationId);
      const dryRun = req.body?.dryRun !== false;
      const limit = req.body?.limit != null ? Number(req.body.limit) : null;
      const job = startBuyerPulse({
        client, locationId, saved, store, sendsEnabled: CARD_SENDS_ENABLED, blastsEnabled: DISPO_BLASTS_ENABLED,
        deps: { ...(router.conversationDepsFor?.({ locationId, client, saved }) || {}), book: (loc) => scoredBook(loc, { status: "active" }) },
        trigger: "manual", dryRun, limit,
      });
      res.json({ ok: true, job });
    } catch (err) { fail(res, err); }
  });

  router.scoredBook = scoredBook;
  router.matchForDeal = matchForDeal;
  router.rankBuyerForDeal = rankBuyerForDeal;
  router.blastFromApp = blastFromApp;

  return router;
}
