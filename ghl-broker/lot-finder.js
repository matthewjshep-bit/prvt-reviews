// lot-finder.js — the luxury teardown lane's day (Matt, 2026-11-23:
// "automate this entire thing from finding properties to skiptrace to
// sending text").
//
// Once a weekday morning, when settings.lotFinder is on, for each pocket:
//   1. pull the parcels — old single-family houses on big lots inside the
//      circle, owned a while — from the property-data API (the comps key),
//      once a week per pocket;
//   2. look up the owners' cell numbers (Tracerfy, the day's cap), keeping
//      only cells that aren't on a do-not-call list from people who aren't
//      litigators;
//   3. put the day's new reachable owners into GHL tagged `lot-owner`
//      (dry unless OUTREACH_IMPORTS_ENABLED, like every import);
//   4. write each one's next text — the first names the price band, one
//      follow-up a day after it went — as a draft for Matt. It schedules
//      itself only when autoSend is on, sends are live AND OWNER_SMS_ENABLED
//      is set (RCW 19.190.060: Matt's call, not the machine's).
//
// A dry run spends nothing: it counts the parcels, says who it would trace
// and text, and writes nothing. The gating is the gatekeeper line's: cursor
// before the run, a stale run retried, the day's tries capped. Results carry
// counts and keys, never a name, a phone or an address.

import { store as defaultStore } from "./store.js";
import { recordEvent, recordEvents, ensureProfile } from "./contact-record.js";
import { getContact, findDuplicateContact, createContact, addContactTags, removeContactTags, smsUnsubscribed } from "./ghl.js";
import { resolveBuilderContact } from "./builder-contacts.js";
import { matchTagPatterns } from "./conversation-party.js";
import { optOutTagsOf, optedOutReason } from "./shared/opt-out.js";
import { optedOutFor } from "./opt-out.js";
import { conversationConfig } from "./reply-agent.js";
import { spreadAcrossDay, machineHours } from "./conversation-scheduler.js";
import { workHour, isWorkday } from "./outreach-sweep.js";
import { ranThisDay, pacificDay } from "./daily-gate.js";
import { voiceFlags } from "./shared/voice.js";
import { carrierFlags } from "./shared/carrier-words.js";
import { soldSearchUrl, searchRows, normalizeRow, mergeFacts, streetKey } from "./comps-zillow.js";
import { fetchZillowFacts, MAX_FACT_LOOKUPS } from "./rehab-scan.js";
import { citySlug } from "./shared/dispo-regions.js";
import {
  normalizeLotFinder, pocketReady, propertySearchBody, ownerFromProperty, pickToTrace, traceLookupBody, phonesFromTrace, reachable,
  lotOwnerText, nextOwnerStep, lotOwnerTags, LOT_OWNER_EVENTS, LOT_OWNER_PARTY, SEQUENCE_EVENT_TYPES,
  suggestPocket, builderFromNewBuild, builderTags, TEARDOWN_YEAR_MAX, repliesByOwner, hasLotOffer,
} from "./shared/lot-finder.js";

export const CURSOR_NAME = "lotFinder";
export const SWEEP_HOUR = 10;              // Pacific; after the gatekeepers, with the outreach sweep
const RETRY_WINDOW_HOURS = 6;
const STALE_RUN_MS = 45 * 60000;
const RETRY_GAP_MS = 20 * 60000;
const MAX_DAILY_TRIES = 4;
const PULL_EVERY_MS = 7 * 86400000;
const PAGE = 250;
// A pocket's parcels in one pass (Matt, 2026-11-23: "no cap"): 20 pages is 5,000, more than any pocket.
const MAX_PAGES = 20;
const STEP_KIND = { open: "lot_owner_open", follow: "lot_owner_follow" };
// Builder lookups a run (registry + county are free; a skip trace counts against the day's cap).
const BUILDER_LOOKUPS_PER_RUN = 300;
// The tags a listing agent wrongly carried as a "builder" (2026-11-23), taken back.
const AGENT_UNTAG = ["investor", "builder", "dispo-type-new-construction", "dispo-source-builder-exits"];
const PROPERTY_SEARCH_URL = "https://api.realestateapi.com/v2/PropertySearch";
const NEW_BUILD_YEARS = 3;
const SEARCH_LIMIT = 80;
const TRACE_URL = "https://tracerfy.com/v1/api/trace/lookup/";

export const OWNER_SMS_ENABLED = () => process.env.OWNER_SMS_ENABLED === "true";
const OUTREACH_IMPORTS_ENABLED = () => process.env.OUTREACH_IMPORTS_ENABLED === "true";
export const traceKeyOf = (saved = {}) => String(saved?.tracerfyApiKey || process.env.TRACERFY_API_KEY || "").trim();
export const propertyKeyOf = (saved = {}) => String(saved?.compsApiKey || "").trim();

const iso = (t) => new Date(t).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jobs = new Map();
export const getLotFinderJob = (locationId) => jobs.get(locationId) || null;
export function _resetJobs() { jobs.clear(); }

// A stable pick among the eight first texts, so a retry writes the same one.
export const variantOf = (key) => [...String(key)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/* ---------- 1. the parcels ---------- */

/**
 * pullPocket({ pocket, apiKey, fetchFn, countOnly }) → { count, rows }
 * The property-data API, paged; `countOnly` asks how many match and buys nothing.
 */
export async function pullPocket({ pocket, apiKey, fetchFn = fetch, countOnly = false }) {
  const headers = { "x-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" };
  const call = async (body) => {
    const r = await fetchFn(PROPERTY_SEARCH_URL, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`parcel search failed (${r.status})`);
    return r.json();
  };
  if (countOnly) {
    const j = await call({ ...propertySearchBody(pocket, { size: 1 }), count: true });
    return { count: Number(j?.resultCount ?? j?.recordCount) || 0, rows: [] };
  }
  const rows = [];
  let count = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const j = await call(propertySearchBody(pocket, { size: PAGE, resultIndex: page * PAGE }));
    const data = Array.isArray(j?.data) ? j.data : [];
    count = Number(j?.resultCount) || count;
    for (const p of data) { const row = ownerFromProperty(p, pocket); if (row) rows.push(row); }
    if (data.length < PAGE) break;
  }
  return { count: count || rows.length, rows };
}

/* ---------- 1b. the pocket off Zillow: the builders' exits and the teardowns that sold (§1A–1C, §6) ---------- */

/**
 * scanPocketZillow({ lat, lng, radiusMiles, apifyToken, now, deps }) → { newBuilds, teardowns, suggest }
 *
 * Two sold searches plus one detail batch: the new builds that sold nearby
 * (the builders' exits, with their lots, sale history, description and
 * listing agent) and the older houses that sold in the same box (what
 * builders paid for the lot). Every filter is re-applied in code: Zillow
 * ignores keys it doesn't know. The comps cache makes a second look free
 * for a day.
 */
export async function scanPocketZillow({ lat, lng, radiusMiles = 1, apifyToken, now = Date.now(), deps = {} }) {
  const year = new Date(now).getFullYear();
  const search = deps.searchRows || searchRows;
  const facts = deps.fetchZillowFacts || fetchZillowFacts;
  const rowsOf = async (url, what) => (await search(url, SEARCH_LIMIT, apifyToken, what)).map(normalizeRow).filter((r) => r.price > 0);
  const [nb, old] = await Promise.all([
    rowsOf(soldSearchUrl({ lat, lng, radiusMiles, monthsBack: 36, builtMin: year - NEW_BUILD_YEARS, priceMin: 1000000 }), "Zillow new-build lookup"),
    rowsOf(soldSearchUrl({ lat, lng, radiusMiles, monthsBack: 24, builtMax: TEARDOWN_YEAR_MAX }), "Zillow teardown lookup"),
  ]);
  // Two detail batches, not one: the lookup takes a capped list, and with the
  // new builds first the older houses fell off the end (Clyde Hill, 2026-11-23:
  // 40 new builds, 0 teardowns).
  // The lookup takes MAX_FACT_LOOKUPS addresses a call (25): a 75-row search
  // goes in three calls, not one with two-thirds dropped (Clyde Hill, second
  // scan: 22 new builds seen of 42).
  const chunked = async (rows) => {
    const out = new Map();
    const addrs = rows.map((r) => r.address);
    for (let i = 0; i < addrs.length; i += MAX_FACT_LOOKUPS) {
      const part = await facts(addrs.slice(i, i + MAX_FACT_LOOKUPS), apifyToken).catch(() => new Map());
      for (const [k, v] of part) out.set(k, v);
    }
    return out;
  };
  const [detailNew, detailOld] = await Promise.all([chunked(nb), chunked(old)]);
  const detail = new Map([...detailNew, ...detailOld]);
  const factsFor = (r) => detail.get(streetKey(r.address)) || null;
  const newBuilds = mergeFacts(nb, detail).filter((r) => (r.yearBuilt || 0) >= year - NEW_BUILD_YEARS && r.price >= 1000000)
    .map((r) => ({ address: r.address, price: r.price, saleDate: r.saleDate, lotSqft: r.lotSqft || 0, sqft: r.sqft || 0, yearBuilt: r.yearBuilt || 0, facts: factsFor(r) }));
  const teardowns = mergeFacts(old, detail).filter((r) => r.yearBuilt > 0 && r.yearBuilt <= TEARDOWN_YEAR_MAX)
    .map((r) => ({ address: r.address, price: r.price, saleDate: r.saleDate, lotSqft: r.lotSqft || 0, sqft: r.sqft || 0, yearBuilt: r.yearBuilt }));
  const suggest = suggestPocket({ newBuilds, teardowns });
  const sample = newBuilds.find((b) => b.facts)?.facts || null;
  const debug = { newRows: nb.length, oldRows: old.length, oldWithYear: mergeFacts(old, detail).filter((r) => r.yearBuilt > 0).length, newBuilds: newBuilds.length, teardowns: teardowns.length,
    shape: sample?.shape || null, agentKeys: sample ? Object.keys(sample.agent || {}) : null, agentFields: sample?.agent?.fields || null, salesSeen: sample ? (sample.sales || []).length : null };
  return { newBuilds, teardowns: teardowns.filter((t) => !suggest.lotSqftMin || t.lotSqft >= suggest.lotSqftMin), suggest, debug };
}

/* ---------- 2. the cell numbers ---------- */

/** traceOwner({ row, apiKey, fetchFn }) → { phones, hit, credits } — one instant lookup. */
export async function traceOwner({ row, apiKey, fetchFn = fetch }) {
  const r = await fetchFn(TRACE_URL, {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json", "User-Agent": "shep-flips-lot-finder" },
    body: JSON.stringify(traceLookupBody(row)), signal: AbortSignal.timeout(30000),
  });
  if (r.status === 402) throw Object.assign(new Error("skip trace: out of credits"), { credits: true });
  if (!r.ok) throw new Error(`skip trace failed (${r.status})`);
  const j = await r.json();
  const result = Array.isArray(j) ? j[0] || {} : j || {};
  return { phones: phonesFromTrace(result), hit: result.hit === true, credits: Number(result.credits_deducted) || 0 };
}

/* ---------- the day ---------- */

/**
 * runLotFinder({ client, locationId, saved, store, sendsEnabled, deps, now, dryRun }) → summary
 *
 * deps: { fetch, getContact, findDuplicateContact, createContact, addContactTags } — the
 * two APIs and GHL, injectable for tests.
 */
/**
 * ownersWhoAnswered({ store, locationId, now, days, limit }) → [{ contactId, name, street, at, replies }]
 *
 * The Luxury page's "Owners who answered": every homeowner the lot finder
 * texted who answered in the last `days`, with no luxury-lot offer from Matt
 * yet (shared/lot-finder.js hasLotOffer), newest answer first. One event read
 * for the window, then one offer read and one profile read per person shown.
 */
export async function ownersWhoAnswered({ store = defaultStore, locationId, now = Date.now(), days = 60, limit = 50 } = {}) {
  const since = iso(now - days * 86400000);
  const events = (await store.listContactEventsSince(locationId, since, { types: [LOT_OWNER_EVENTS.replied], limit: 5000 }).catch(() => [])) || [];
  const out = [];
  for (const r of repliesByOwner(events)) {
    if (out.length >= limit) break;
    const [offers, profile] = await Promise.all([
      store.listOffers(locationId, { contactId: r.contactId, limit: 10, lean: true }).catch(() => []),
      store.getContactProfile?.(locationId, r.contactId).catch(() => null),
    ]);
    if (hasLotOffer(offers)) continue;
    out.push({ ...r, name: String(profile?.name || "").trim() });
  }
  return out;
}

export async function runLotFinder({ client, locationId, saved = {}, store = defaultStore, sendsEnabled = false, deps = {}, now = Date.now(), dryRun = null, rescan = false }) {
  const f = normalizeLotFinder(saved?.lotFinder);
  dryRun = dryRun ?? f.dryRun;
  const fetchFn = deps.fetch || fetch;
  const out = { dryRun, pockets: [], traced: { looked: 0, hits: 0, reachable: 0, would: 0, credits: 0, stopped: "" },
    imported: { created: 0, updated: 0, would: 0, skipped: 0, dry: dryRun || !OUTREACH_IMPORTS_ENABLED() }, texts: { drafted: 0, scheduled: 0, would: 0, skipped: 0 }, rows: [] };
  const propertyKey = propertyKeyOf(saved);
  const traceKey = traceKeyOf(saved);
  const day = pacificDay(now);
  const cur = (await store.getJobCursor?.(locationId, `${CURSOR_NAME}Pulls`).catch(() => null))?.doc || {};
  const pulls = { ...(cur.pulls || {}) };
  const tracesToday = cur.traces?.day === day ? Number(cur.traces.n) || 0 : 0;

  // 1. The parcels, once a week per pocket. A dry run only counts.
  for (const p of f.pockets) {
    const line = { id: p.id, ready: pocketReady(p), parcels: null, pulled: false, skipped: "" };
    out.pockets.push(line);
    if (!p.enabled) { line.skipped = "off"; continue; }
    if (!p.lat || !p.lng) { line.skipped = "no center yet"; continue; }
    if (!propertyKey) { line.skipped = "no property-data key (Settings → comps API key)"; continue; }
    const due = !pulls[p.id] || now - Date.parse(pulls[p.id]) > PULL_EVERY_MS;
    try {
      if (dryRun) { line.parcels = (await pullPocket({ pocket: p, apiKey: propertyKey, fetchFn, countOnly: true })).count; continue; }
      if (!due) { line.skipped = `pulled ${Math.floor((now - Date.parse(pulls[p.id])) / 86400000)} days ago`; continue; }
      const { count, rows } = await pullPocket({ pocket: p, apiKey: propertyKey, fetchFn });
      const up = await store.upsertLotOwners(locationId, rows);
      line.parcels = count; line.pulled = true; line.created = up.created; line.updated = up.updated;
      pulls[p.id] = iso(now);
    } catch (e) { line.error = String(e?.message || e).slice(0, 160); }
  }

  const byPocket = new Map(f.pockets.map((p) => [p.id, p]));

  // 1b. The builders who buy here, off the new builds that sold (weekly, with
  // the parcels). Dry: nothing bought.
  const apifyToken = String(saved?.apifyToken || "").trim();
  const scans = { ...(cur.scans || {}) };
  // The sold teardowns each scan reads, kept for the lot analyzer's suggested
  // comps (routes/lot-finder.js GET /teardowns). `scans` stays the scan time.
  const teardowns = { ...(cur.teardowns || {}) };
  for (const p of f.pockets) {
    const line = out.pockets.find((x) => x.id === p.id);
    if (!p.enabled || !p.lat || !p.lng || dryRun) continue;
    if (!apifyToken) { line.builders = "no Apify token"; continue; }
    if (!rescan && scans[p.id] && now - Date.parse(scans[p.id]) <= PULL_EVERY_MS) continue;
    try {
      const scan = await (deps.scanPocketZillow || scanPocketZillow)({ lat: p.lat, lng: p.lng, radiusMiles: p.radiusMiles, apifyToken, now, deps });
      const rows = scan.newBuilds.map((b) => builderFromNewBuild({ row: b, facts: b.facts, pocket: p, now })).filter(Boolean);
      const up = await store.upsertLotBuilders(locationId, rows);
      line.builders = rows.length; line.buildersCreated = up.created;
      scans[p.id] = iso(now);
      teardowns[p.id] = { at: iso(now), rows: (scan.teardowns || []).slice(0, 60)
        .map((t) => ({ address: t.address, price: t.price, saleDate: t.saleDate, lotSqft: t.lotSqft || 0, sqft: t.sqft || 0, yearBuilt: t.yearBuilt || 0 })) };
    } catch (e) { line.builders = `scan failed: ${String(e?.message || e).slice(0, 120)}`; }
  }

  // 1c. The builder's own contact (builder-contacts.js; Matt, 2026-11-23: "we
  // want the builder who bought it, not the agent who helped them"): by name
  // in the contractor registry, by the entity on the county's sale record, or
  // the person behind a one-off LLC through the skip trace. Never the agent.
  out.builderLookups = { looked: 0, found: 0, traced: 0, credits: 0 };
  let traceRoom = f.traceDailyCap > 0 ? Math.max(0, f.traceDailyCap - tracesToday) : Infinity;
  if (!dryRun) {
    const resolve = deps.resolveBuilderContact || resolveBuilderContact;
    const pending = (await store.listLotBuilders(locationId, { limit: 5000 })).filter((r) => byPocket.get(r.pocketId)?.enabled && !r.doc?.builderContact && r.doc?.reach !== "agent").slice(0, BUILDER_LOOKUPS_PER_RUN);
    for (const row of pending) {
      try {
        const c = await resolve({ address: row.doc.address, builderName: row.doc.builder || "", traceKey, allowTrace: Boolean(traceKey) && traceRoom > 0, fetchFn });
        out.builderLookups.looked++;
        if (c?.credits) { out.builderLookups.credits += c.credits; out.builderLookups.traced++; traceRoom--; }
        const contact = c || { entity: "", phone: "", principal: "", source: "none" };
        if (contact.phone) out.builderLookups.found++;
        // The county's record of the builder's own sale is the exit worth naming.
        const exitFix = c?.exit?.price > 0 && c.exit.price !== row.doc.exitPrice ? { builderExit: c.exit } : {};
        await store.setLotBuilder(locationId, row.builderKey, { status: contact.phone ? "new" : row.status === "imported" ? row.status : "no_phone", doc: { ...row.doc, builderContact: contact, ...exitFix, reach: contact.phone ? "builder" : "none" } });
        await sleep(200);
      } catch (e) { out.rows.push({ builderKey: row.builderKey, error: `builder lookup: ${String(e?.message || e).slice(0, 120)}` }); }
    }
  }

  // 2. The cell numbers, up to the day's cap. Never on a dry run (it's money).
  const all = await store.listLotOwners(locationId, { limit: 20000 });
  const fresh = all.filter((r) => byPocket.get(r.pocketId)?.enabled);
  // 0 = no cap (Matt, 2026-11-23: "no cap pls"; the outreach cap works the same way).
  const room = f.traceDailyCap > 0 ? Math.max(0, f.traceDailyCap - tracesToday) : Infinity;
  const toTrace = pickToTrace(fresh, { cap: room });
  if (dryRun) out.traced.would = toTrace.length;
  else if (!traceKey) out.traced.stopped = toTrace.length ? "no skip-trace key (TRACERFY_API_KEY)" : "";
  else {
    let n = tracesToday;
    for (const row of toTrace) {
      try {
        const t = await traceOwner({ row, apiKey: traceKey, fetchFn });
        out.traced.looked++; n++;
        out.traced.credits += t.credits;
        const ok = reachable(t.phones);
        if (t.hit) out.traced.hits++;
        if (ok.length) out.traced.reachable++;
        await store.setLotOwner(locationId, row.ownerKey, { status: ok.length ? "traced" : "no_phone",
          doc: { ...row.doc, phones: t.phones, tracedAt: iso(now), traceCredits: t.credits, whyNoPhone: ok.length ? "" : t.hit ? (t.phones.length ? "cells on a do-not-call list, or a litigator" : "no cell found") : "no match" } });
        await sleep(250);
      } catch (e) {
        out.rows.push({ ownerKey: row.ownerKey, error: `trace: ${String(e?.message || e).slice(0, 120)}` });
        if (e?.credits) { out.traced.stopped = "out of credits"; break; }
      }
    }
    await store.setJobCursor?.(locationId, `${CURSOR_NAME}Pulls`, { at: iso(now), doc: { ...cur, pulls, scans, teardowns, traces: { day, n } } }).catch(() => {});
  }
  if (!dryRun && out.traced.looked === 0) await store.setJobCursor?.(locationId, `${CURSOR_NAME}Pulls`, { at: iso(now), doc: { ...cur, pulls, scans, teardowns } }).catch(() => {});

  // 3. Into GHL, the day's reachable owners. Dry unless both gates are open.
  const config = conversationConfig(saved);
  const routing = config.routing || {};
  const theirsAlready = (c) => matchTagPatterns(c?.tags || [], [...(routing.agentTags || []), ...(routing.investorTags || [])])[0] || "";
  const findDup = deps.findDuplicateContact || ((args) => findDuplicateContact(client, locationId, args));
  const create = deps.createContact || ((body) => createContact(client, locationId, body));
  const tag = deps.addContactTags || ((id, tags) => addContactTags(client, id, tags));
  const read = deps.getContact || ((id) => getContact(client, id));
  const traced = (await store.listLotOwners(locationId, { status: "traced", limit: 5000 })).filter((r) => byPocket.get(r.pocketId)?.enabled && pocketReady(byPocket.get(r.pocketId)));
  const importedToday = all.filter((r) => r.status === "imported" && r.importedAt && pacificDay(Date.parse(r.importedAt)) === day).length;
  for (const row of traced.slice(0, f.dailyNew > 0 ? Math.max(0, f.dailyNew - importedToday) : traced.length)) {
    const pocket = byPocket.get(row.pocketId);
    const phone = reachable(row.doc?.phones || [])[0]?.number;
    if (!phone) { await store.setLotOwner(locationId, row.ownerKey, { status: "no_phone" }); continue; }
    if (out.imported.dry) { out.imported.would++; out.rows.push({ ownerKey: row.ownerKey, would: "import" }); continue; }
    try {
      await sleep(150);
      const match = await findDup({ phone });
      const existing = match ? await read(match.id).catch(() => null) : null;
      const taken = theirsAlready(existing);
      if (taken) { out.imported.skipped++; await store.setLotOwner(locationId, row.ownerKey, { status: "skipped", doc: { ...row.doc, why: `already in GHL as an agent or buyer (${taken})` } }); continue; }
      const d = row.doc || {};
      let contactId = match?.id;
      let action = "updated";
      if (!contactId) {
        action = "created";
        contactId = await create({ firstName: d.first || "Owner", lastName: d.last || "", phone, address1: d.house?.street || "", city: d.house?.city || "", state: d.house?.state || "", postalCode: d.house?.zip || "", source: "lot-finder" });
      }
      if (!contactId) throw new Error("no contact id returned");
      const tags = lotOwnerTags(pocket);
      await tag(contactId, tags);
      const at = iso(now);
      await ensureProfile({ store, locationId, contactId, party: LOT_OWNER_PARTY, name: [d.first, d.last].filter(Boolean).join(" ") || null, phone });
      await recordEvents({ store, locationId, contactId, party: LOT_OWNER_PARTY, events: [
        { type: "import", at, address: d.house?.street || "", source: "lot-finder", ref: `lot:${row.ownerKey}`, data: { action, ownerKey: row.ownerKey, pocketId: row.pocketId } },
        ...tags.map((t) => ({ type: "tag_added", at, source: "lot-finder", ref: `lot:${row.ownerKey}`, data: { tag: t } })),
      ] });
      await store.setLotOwner(locationId, row.ownerKey, { status: "imported", contactId, importedAt: at });
      out.imported[action]++;
      out.rows.push({ ownerKey: row.ownerKey, imported: action });
    } catch (e) { out.imported.skipped++; out.rows.push({ ownerKey: row.ownerKey, error: `import: ${String(e?.message || e).slice(0, 120)}` }); }
  }

  // 3a. The listing agents imported as "builders" on the first pass (2026-11-23)
  // are taken back out of the pool: their builder tags come off, a
  // lot-listing-agent tag goes on so the thread is still placed, and the row
  // waits for the builder's own contact. Runs once per row.
  out.agentsRetired = 0;
  if (!dryRun) {
    for (const row of (await store.listLotBuilders(locationId, { status: "imported", limit: 2000 })).filter((r) => r.doc?.reach === "agent" && r.contactId)) {
      const untag = deps.removeContactTags || ((id, tags) => removeContactTags(client, id, tags));
      try {
        await untag(row.contactId, [...AGENT_UNTAG, `lot-pocket-${row.pocketId}`]);
        await tag(row.contactId, ["lot-listing-agent"]);
      } catch (e) { out.rows.push({ builderKey: row.builderKey, error: `agent untag: ${String(e?.message || e).slice(0, 120)}` }); }
      await store.setLotBuilder(locationId, row.builderKey, { status: "new", doc: { ...row.doc, reach: "agent_retired", agentContactId: row.contactId } });
      out.agentsRetired++;
    }
  }

  // 3b. The builders into the buyer book: a buyer who builds, found here, by
  // THEIR OWN number (doc.builderContact), never the listing agent's (Matt,
  // 2026-11-23: "make sure this doesn't happen again for the luxury lane").
  // Tagged for the pocket's city, so a lot deal there picks them
  // (shared/buyer-score.js). Same gate as the owners.
  out.builders = { created: 0, updated: 0, would: 0, skipped: 0, noPhone: 0 };
  for (const row of (await store.listLotBuilders(locationId, { status: "new", limit: 2000 })).filter((r) => byPocket.get(r.pocketId)?.enabled)) {
    const pocket = byPocket.get(row.pocketId);
    const d = row.doc || {};
    const bc = d.builderContact || {};
    const phone = bc.phone || "";
    if (!phone) { out.builders.noPhone++; if (d.builderContact) await store.setLotBuilder(locationId, row.builderKey, { status: "no_phone" }); continue; }
    if (out.imported.dry) { out.builders.would++; continue; }
    try {
      await sleep(150);
      const match = await findDup({ phone });
      const city = String(d.address || "").split(",")[1]?.trim() || "";
      const tags = [...builderTags(pocket), `dispo-source-${bc.source || "county"}`, ...(city ? [`dispo-city-${citySlug(city)}`] : [])];
      let contactId = match?.id;
      let action = "updated";
      if (!contactId) {
        action = "created";
        const [first = "", ...rest] = String(bc.principal || "").split(" ");
        contactId = await create({ firstName: first || (bc.entity || d.builder || "Builder"), lastName: rest.join(" "), phone, companyName: bc.entity || d.builder || "", source: "lot-finder" });
      }
      if (!contactId) throw new Error("no contact id returned");
      await tag(contactId, tags);
      const at = iso(now);
      await ensureProfile({ store, locationId, contactId, party: "investor", name: bc.principal || bc.entity || null, phone });
      await recordEvents({ store, locationId, contactId, party: "investor", events: [
        { type: "import", at, address: d.address || "", source: "lot-finder", ref: `builder:${row.builderKey}`, data: { action, builderKey: row.builderKey, pocketId: row.pocketId, exitPrice: d.builderExit?.price || d.exitPrice, priorLotPrice: d.priorLotPrice, lotSqft: d.lotSqft, builder: bc.entity || d.builder || "", via: bc.source } },
        ...tags.map((t) => ({ type: "tag_added", at, source: "lot-finder", ref: `builder:${row.builderKey}`, data: { tag: t } })),
      ] });
      await store.setLotBuilder(locationId, row.builderKey, { status: "imported", contactId, importedAt: at });
      out.builders[action]++;
    } catch (e) { out.builders.skipped++; out.rows.push({ builderKey: row.builderKey, error: `builder import: ${String(e?.message || e).slice(0, 120)}` }); }
  }

  // 4. The texts, for everyone in GHL.
  const optOutTags = optOutTagsOf(config);
  const schedule = !dryRun && f.autoSend && sendsEnabled && OWNER_SMS_ENABLED() && config.enabled;
  out.texts.refreshed = 0;
  const imported = await store.listLotOwners(locationId, { status: "imported", limit: 5000 });
  for (const row of imported) {
    const pocket = byPocket.get(row.pocketId);
    if (!row.contactId || !pocket || !pocketReady(pocket)) continue;
    const events = await store.listContactEvents(locationId, row.contactId, { types: SEQUENCE_EVENT_TYPES, limit: 100 }).catch(() => null);
    if (!events) { out.texts.skipped++; continue; }
    const contact = await read(row.contactId).catch(() => null);
    if (!contact) { out.texts.skipped++; continue; }
    const off = await optedOutFor({ store, locationId, contactId: row.contactId, contact, events, optOutTags }).catch(() => null);
    if (off || smsUnsubscribed(contact)) { out.rows.push({ ownerKey: row.ownerKey, waiting: off ? optedOutReason(off) : "SMS is off for them in GHL" }); continue; }
    const next = nextOwnerStep({ events, followUpDays: f.followUpDays, now });
    const d = row.doc || {};
    // A first text still sitting unsent carries the CURRENT words: the wording
    // changed after the first ten were drafted (Matt, 2026-11-23), and a draft
    // nobody has sent yet is still ours to rewrite.
    if (!next.step && /hasn't gone yet/.test(next.why || "") && !dryRun) {
      const fresh = lotOwnerText({ step: "open", variant: variantOf(row.ownerKey), first: d.first, street: d.house?.street, pocket: pocket.name, bandLo: pocket.bandLo, bandHi: pocket.bandHi });
      const open = (await store.listReplyDrafts(locationId, { contactId: row.contactId, status: "draft", limit: 10 }).catch(() => [])).find((x) => x.outbound?.kind === "lot_owner_open");
      if (fresh && open && open.reply !== fresh) {
        await store.updateReplyDraft(open.id, { ...open, reply: fresh, updatedAt: iso(now) });
        out.texts.refreshed++;
      }
      // Once every switch is on, a first text drafted while they were off
      // schedules itself too (Matt turned OWNER_SMS_ENABLED on after the
      // first ten were drafted, 2026-11-23).
      const hardNow = open ? voiceFlags({ text: open.reply, channel: "sms", kind: "lot_owner_open" }).filter((x) => x.level === "hard") : ["none"];
      if (open && schedule && !hardNow.length && !(open.flags || []).length) {
        const sendAt = spreadAcrossDay({ now, quietHours: machineHours(config.autoSend || {}), hours: 6, weekends: "none", offDays: config.autoSend?.offDays || [] });
        await store.updateReplyDraft(open.id, { ...open, reply: fresh || open.reply, status: "scheduled", sendAt, scheduledAt: iso(now), autoSendable: true, autoSend: { decided: true, reason: "" }, updatedAt: iso(now) });
        out.texts.scheduled++;
        out.rows.push({ ownerKey: row.ownerKey, step: "open", draftId: open.id, status: "scheduled", sendAt });
      }
    }
    if (!next.step) { out.rows.push({ ownerKey: row.ownerKey, waiting: next.stop || next.why }); continue; }
    const text = lotOwnerText({ step: next.step, variant: variantOf(row.ownerKey), first: d.first, street: d.house?.street, pocket: pocket.name, bandLo: pocket.bandLo, bandHi: pocket.bandHi });
    if (!text) { out.texts.skipped++; out.rows.push({ ownerKey: row.ownerKey, skipped: "nothing to say: no street or no band" }); continue; }
    if (dryRun) { out.texts.would++; out.rows.push({ ownerKey: row.ownerKey, would: next.step }); continue; }

    const ts = iso(now);
    const claimed = await recordEvent({ store, locationId, contactId: row.contactId, party: LOT_OWNER_PARTY, type: LOT_OWNER_EVENTS.queued, at: ts,
      address: d.house?.street || "", source: "lot-finder", ref: `lot:${row.ownerKey}`, dedupeKey: `lot_owner:${row.contactId}:${next.step}`, data: { step: next.step, why: next.why, pocketId: row.pocketId } });
    if (!claimed?.inserted) { out.texts.skipped++; continue; }
    // The voice rules, and the carrier's (shared/carrier-words.js): a text with
    // a we-buy-houses word never goes on its own — 2026-11-23, "local investor"
    // was blocked 15 times out of 16.
    const hard = [...voiceFlags({ text, channel: "sms", kind: STEP_KIND[next.step] }).filter((x) => x.level === "hard").map((x) => x.key), ...carrierFlags(text).map((w) => `carrier word: ${w}`)];
    const goes = schedule && !hard.length;
    const sendAt = goes ? spreadAcrossDay({ now, quietHours: machineHours(config.autoSend || {}), hours: 6, weekends: "none", offDays: config.autoSend?.offDays || [] }) : null;
    const record = await store.createReplyDraft({
      locationId, contactId: row.contactId, contactName: [d.first, d.last].filter(Boolean).join(" "), status: goes ? "scheduled" : "draft", channel: "sms", jobId: null,
      inbound: "", outbound: { kind: STEP_KIND[next.step], step: next.step, ownerKey: row.ownerKey, pocketId: row.pocketId, address: d.house?.street || "" },
      reply: text, intent: STEP_KIND[next.step], confidence: "high", needsHuman: hard.length > 0, humanReason: hard.length ? `reads like a machine: ${hard.join(", ")}` : "",
      summary: `Lot owner · ${next.step === "open" ? "first text" : "follow-up"} · ${pocket.name}`,
      propertyAddress: d.house?.street || "", counterAmount: null, autoSendable: !hard.length, flags: hard.map((k) => `reads like a machine: ${k}`),
      party: LOT_OWNER_PARTY, partySource: "lot-finder", matchedTags: { agent: [], investor: [] }, contextSummary: {}, offersInContext: 0,
      autoSend: { decided: goes, reason: goes ? "" : hard.length ? "it waits for you: it reads like a machine" : !f.autoSend ? "owner texts wait for you (Autopilot → Lots)" : !OWNER_SMS_ENABLED() ? "owner texts are off on the broker (OWNER_SMS_ENABLED)" : !sendsEnabled ? "sends are off on the broker (CARD_SENDS_ENABLED)" : "Conversation AI is switched off" },
      humanActive: null, actions: [], supersededIds: [], warnings: [], noteOnAutoSend: false, promptVersion: 1,
      ...(goes ? { sendAt, scheduledAt: ts } : {}), updatedAt: ts,
    });
    if (goes) out.texts.scheduled++; else out.texts.drafted++;
    out.rows.push({ ownerKey: row.ownerKey, step: next.step, draftId: record?.id || null, status: goes ? "scheduled" : "draft" });
  }
  return out;
}

/** startLotFinder(...) → job: runs in the background, the cursor says how it went. */
export function startLotFinder({ client, locationId, saved, store = defaultStore, sendsEnabled = false, deps = {}, now = Date.now(), dryRun = null, trigger = "daily", rescan = false }) {
  const job = { id: `lot-${now.toString(36)}`, trigger, status: "running", startedAt: iso(now), finishedAt: null, result: null, error: null };
  jobs.set(locationId, job);
  const stamp = async (patch) => {
    const cur = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
    await store.setJobCursor?.(locationId, CURSOR_NAME, { at: cur?.at || iso(now), doc: { ...(cur?.doc || {}), ...patch } }).catch(() => {});
  };
  const summary = () => ({ id: job.id, trigger, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error,
    ...(job.result ? { dryRun: job.result.dryRun, pockets: job.result.pockets, traced: job.result.traced, imported: job.result.imported, builders: job.result.builders, builderLookups: job.result.builderLookups, agentsRetired: job.result.agentsRetired, texts: job.result.texts } : {}) });
  job.done = stamp({ run: { id: job.id, trigger, startedAt: job.startedAt } })
    .then(() => runLotFinder({ client, locationId, saved, store, sendsEnabled, deps, now, dryRun, rescan }))
    .then(async (result) => {
      job.result = result; job.status = "done"; job.finishedAt = iso(Date.now());
      console.log(`lot finder: ${result.traced.looked} traced (${result.traced.reachable} reachable), imported ${JSON.stringify(result.imported)}, texts ${JSON.stringify(result.texts)}`);
      await stamp({ run: null, last: summary() });
    })
    .catch(async (e) => {
      job.status = "error"; job.error = String(e?.message || e).slice(0, 300); job.finishedAt = iso(Date.now());
      await stamp({ run: null, last: summary(), ...(trigger === "daily" ? { failed: true, error: job.error } : {}) });
    });
  return job;
}

/**
 * maybeRunLotFinder({ client, locationId, saved, store, sendsEnabled, deps, now }) → boolean
 * Weekdays at SWEEP_HOUR Pacific, once; a failed run retried through the
 * morning, MAX_DAILY_TRIES at most. Off unless settings.lotFinder.enabled.
 */
export async function maybeRunLotFinder({ client, locationId, saved = {}, store = defaultStore, sendsEnabled = false, deps = {}, now = Date.now() }) {
  const f = normalizeLotFinder(saved?.lotFinder);
  if (!f.enabled || !f.pockets.some((p) => p.enabled)) return false;
  if (!isWorkday(now)) return false;
  const h = workHour(now);
  if (h < SWEEP_HOUR || h >= SWEEP_HOUR + RETRY_WINDOW_HOURS) return false;
  if (jobs.get(locationId)?.status === "running") return false;
  const doc = (await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null))?.doc || {};
  const dailyAt = doc.lastDaily ? Date.parse(doc.lastDaily) : null;
  const ranToday = ranThisDay({ dailyAt, now, hourNow: h, startHour: SWEEP_HOUR });
  const stale = doc.run?.startedAt && now - Date.parse(doc.run.startedAt) > STALE_RUN_MS;
  let tries = 1;
  if (ranToday) {
    const triedSoFar = Number(doc.tries) || 1;
    if (!(doc.failed || stale) || triedSoFar >= MAX_DAILY_TRIES || now - dailyAt < RETRY_GAP_MS) return false;
    tries = triedSoFar + 1;
  } else if (h !== SWEEP_HOUR) {
    return false;
  }
  await store.setJobCursor?.(locationId, CURSOR_NAME, { at: iso(now), doc: { tries, lastDaily: iso(now), last: doc.last || null, ...(stale ? { staleRun: doc.run } : {}) } }).catch(() => {});
  startLotFinder({ client, locationId, saved, store, sendsEnabled, deps, now, trigger: "daily" });
  return true;
}
