// gatekeeper-feed.js — where the gatekeepers come from (Matt, 2026-10-26).
//
//   • Probate notices. Every estate's personal representative publishes a
//     Notice to Creditors that names their attorney. They arrive pasted in
//     (POST /api/gatekeepers/notices) or as the statewide notice site's daily
//     alert email, read from Gmail by that one sender and nothing else.
//     Each becomes the attorney (a gatekeeper) and the estate (their hook).
//   • Our own closings. The title or escrow officer on a deal we closed is a
//     gatekeeper we already know; the closing is the hook.
//
// Then, best effort, the estate's house: the county's parcel owner of
// record, matched on the decedent's name. Only Snohomish publishes owner
// names it can be asked by (King's bulk files carry no names); a name that
// fits more than one house is left unmatched rather than guessed.
//
// I/O lives here; the rules are shared/probate-notice.js and
// shared/gatekeeper.js. Results carry counts, never a name.

import { parseNotices } from "./shared/probate-notice.js";
import { fromNotice, mergeGatekeeperDoc, gatekeeperKey, splitName, normalizeGatekeepers } from "./shared/gatekeeper.js";
import { resolveParties } from "./shared/deal-parties.js";
import { bodyText } from "./shared/gmail.js";
import { gmailEnv, makeGmail } from "./gmail-api.js";

export const SNOHOMISH_PARCELS = "https://services6.arcgis.com/z6WYi9VRHfgwgtyW/arcgis/rest/services/Parcels/FeatureServer/0/query";
export const NOTICE_MAIL_CURSOR = "gatekeeperNoticeMail";
const MAX_SEEN_MAIL = 500;
const PARCEL_TIMEOUT_MS = 20000;

const sqlText = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9 \-]/g, "").replace(/'/g, "''").trim();

/**
 * estateHouseSnohomish(hook, { fetchImpl }) → { address, parcelId, matches } | { matches, reason }
 *
 * The county stores owners "Last First M" ("Example Harold T & Spouse"),
 * and an estate sometimes as "Estate Of …". Residential use codes only
 * (11x). One match is the house; none or several is no house.
 */
export async function estateHouseSnohomish(hook, { fetchImpl = globalThis.fetch } = {}) {
  const { firstName, lastName } = splitName(hook?.decedent || "");
  const last = sqlText(lastName);
  const first = sqlText(firstName);
  if (!last || !first) return { matches: 0, reason: "no decedent name" };
  const where = `(UPPER(OWNERNAME) LIKE '${last} ${first}%' OR UPPER(OWNERNAME) LIKE '%ESTATE%${last}%${first}%') AND USECODE LIKE '11%'`;
  const body = new URLSearchParams({
    where, outFields: "PARCEL_ID,SITUSLINE1,SITUSCITY,SITUSZIP,USECODE", returnGeometry: "false", resultRecordCount: "10", f: "json",
  });
  const res = await fetchImpl(SNOHOMISH_PARCELS, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(),
    signal: AbortSignal.timeout(PARCEL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`snohomish parcels: HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`snohomish parcels: ${j.error.message || "error"}`);
  const rows = (j.features || []).map((f) => f.attributes || {}).filter((a) => a.SITUSLINE1);
  const houses = [...new Map(rows.map((a) => [String(a.SITUSLINE1).trim().toUpperCase(), a])).values()];
  if (houses.length !== 1) return { matches: houses.length, reason: houses.length ? "more than one house fits the name" : "no house in the owner's name" };
  const a = houses[0];
  const street = String(a.SITUSLINE1).replace(/\s+/g, " ").trim();
  const city = String(a.SITUSCITY || "").trim();
  return { matches: 1, parcelId: String(a.PARCEL_ID || ""), address: [street, city, `WA ${String(a.SITUSZIP || "").trim()}`.trim()].filter(Boolean).join(", "), source: "snohomish-parcels" };
}

const HOUSE_LOOKUPS = { Snohomish: estateHouseSnohomish };

/** The estate's house, where the county lets us ask; `null` with why where it doesn't. */
export async function findEstateHouse(hook, deps = {}) {
  const look = (deps.houseLookups || HOUSE_LOOKUPS)[hook?.county];
  if (!look) return { house: null, reason: `no owner lookup for ${hook?.county || "that county"}` };
  try {
    const r = await look(hook, deps);
    return r.address ? { house: { address: r.address, parcelId: r.parcelId || "", source: r.source || "", foundAt: new Date().toISOString() } } : { house: null, reason: r.reason, matches: r.matches };
  } catch (e) {
    return { house: null, reason: "lookup failed", error: e.message };
  }
}

/**
 * ingestNotices({ store, locationId, text, source, settings, deps }) → counts
 *
 * Parse every notice in `text`, keep the counties we work, and save the
 * attorney and the estate. An attorney already held keeps their status and
 * anything we knew; an estate already held keeps the house we found.
 */
export async function ingestNotices({ store, locationId, text, source = "paste", settings = {}, deps = {} }) {
  const g = normalizeGatekeepers(settings?.outreachAutopilot?.gatekeepers);
  const counties = new Set(g.counties.map((c) => c.toLowerCase()));
  const notices = parseNotices(text);
  const out = { notices: notices.length, proSe: 0, outOfArea: 0, unreadable: 0, attorneys: { created: 0, updated: 0 }, estates: { created: 0, updated: 0 }, housesFound: 0, houseMisses: {} };

  const gkRows = new Map();
  const hookRows = [];
  for (const n of notices) {
    if (n.proSe) { out.proSe++; continue; }
    if (counties.size && !counties.has(String(n.county || "").toLowerCase())) { out.outOfArea++; continue; }
    const r = fromNotice(n);
    if (!r) { out.unreadable++; continue; }
    const prev = gkRows.get(r.gatekeeper.gkKey) || (await store.getGatekeeper(locationId, r.gatekeeper.gkKey))?.doc || {};
    const { gkKey, kind, ...doc } = r.gatekeeper;
    gkRows.set(gkKey, mergeGatekeeperDoc(prev, { ...doc, sources: undefined }));
    gkRows.get(gkKey).sources = [...new Set([...(prev.sources || []), `probate-notice:${source}`])];
    hookRows.push(r.hook);
  }

  const existingHooks = new Map(((await store.listGatekeeperHooks(locationId).catch(() => [])) || []).map((h) => [h.hookKey, h]));
  const toSave = [];
  for (const h of hookRows) {
    const prev = existingHooks.get(h.hookKey)?.doc;
    let house = prev?.house || null;
    if (!house && !prev?.houseChecked) {
      const found = await findEstateHouse(h, deps);
      house = found.house;
      if (house) out.housesFound++;
      else out.houseMisses[found.reason || "no match"] = (out.houseMisses[found.reason || "no match"] || 0) + 1;
      // A failed lookup is asked again next time; a clean miss isn't.
      h.houseChecked = !found.error;
    } else if (prev?.houseChecked) h.houseChecked = true;
    toSave.push({ hookKey: h.hookKey, gkKey: h.gkKey, kind: "estate", doc: { ...(prev || {}), ...h, house } });
  }

  out.attorneys = await store.upsertGatekeepers(locationId, [...gkRows].map(([gkKey, doc]) => ({ gkKey, kind: "probate_attorney", doc })));
  out.estates = await store.upsertGatekeeperHooks(locationId, toSave);
  return out;
}

/**
 * readNoticeEmails({ store, locationId, settings, deps }) → counts | { skipped }
 *
 * The statewide notice site's daily alert, read from Gmail by its sender
 * only (settings noticeEmailFrom). Each message is read once: its id goes
 * on a job cursor. Nothing else in the inbox is searched or kept.
 */
export async function readNoticeEmails({ store, locationId, settings = {}, deps = {} }) {
  const g = normalizeGatekeepers(settings?.outreachAutopilot?.gatekeepers);
  if (!g.noticeEmailFrom) return { skipped: "no notice email sender set" };
  const gmail = deps.gmail || (gmailEnv() ? makeGmail(gmailEnv()) : null);
  if (!gmail) return { skipped: "Gmail isn't connected" };
  const cursor = (await store.getJobCursor(locationId, NOTICE_MAIL_CURSOR).catch(() => null))?.doc || {};
  const seen = new Set(cursor.seen || []);
  const ids = (await gmail.list(`from:${g.noticeEmailFrom} newer_than:7d`, { max: 50 })).filter((id) => !seen.has(id));
  const totals = { messages: ids.length, notices: 0, attorneys: 0, estates: 0, housesFound: 0 };
  for (const id of ids) {
    const msg = await gmail.message(id);
    const text = bodyText(msg?.payload);
    const r = await ingestNotices({ store, locationId, text, source: "email", settings, deps });
    totals.notices += r.notices;
    totals.attorneys += r.attorneys.created;
    totals.estates += r.estates.created;
    totals.housesFound += r.housesFound;
    seen.add(id);
  }
  await store.setJobCursor(locationId, NOTICE_MAIL_CURSOR, { doc: { seen: [...seen].slice(-MAX_SEEN_MAIL), lastReadAt: new Date().toISOString(), last: totals } });
  return totals;
}

const ESCROW_RX = /\bescrow\b/i;

/**
 * seedFromClosings({ store, locationId, settings }) → counts
 *
 * The title or escrow officer named on our own deals (set on the deal or
 * on its PSA — not the Settings default, which is every deal's). The deal
 * is the hook: "we closed 123 Elm together".
 */
export async function seedFromClosings({ store, locationId, settings = {} }) {
  const deals = (await store.listDeals(locationId, { limit: 1000 }).catch(() => [])) || [];
  const gkRows = new Map();
  const hooks = [];
  for (const o of deals) {
    const t = resolveParties(o, settings).title;
    if (!t || !(t.source === "deal" || t.source === "the offer's PSA")) continue;
    const kind = ESCROW_RX.test(t.company) && !/\btitle\b/i.test(t.company) ? "escrow" : "title";
    const gkKey = gatekeeperKey({ kind, email: t.email, phone: t.phone, name: t.name || t.company, firm: t.company });
    if (!gkKey) continue;
    const prev = gkRows.get(gkKey) || (await store.getGatekeeper(locationId, gkKey))?.doc || {};
    gkRows.set(gkKey, mergeGatekeeperDoc(prev, {
      name: t.name || "", ...splitName(t.name), firm: t.company || "", phone: String(t.phone || "").replace(/\D/g, "").slice(-10),
      email: String(t.email || "").toLowerCase(), ghlContactId: t.contactId || "",
    }));
    gkRows.get(gkKey).sources = [...new Set([...(prev.sources || []), "our-closing"])];
    hooks.push({ hookKey: `closing:${o.id}`, gkKey, kind: "closing", doc: { address: o.address || o.propertyAddress || "", offerId: o.id, stage: o.deal?.stage || o.status || "", closedAt: o.deal?.closedAt || o.deal?.closingDate || "" } });
  }
  const gks = await store.upsertGatekeepers(locationId, [...gkRows].map(([gkKey, doc]) => ({ gkKey, kind: ESCROW_RX.test(doc.firm) && !/\btitle\b/i.test(doc.firm) ? "escrow" : "title", doc })));
  const hk = await store.upsertGatekeeperHooks(locationId, hooks);
  return { deals: deals.length, gatekeepers: gks, closings: hk };
}
