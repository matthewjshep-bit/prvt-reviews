// site-check.js — the street a house sits on and what's next to it, read off
// OpenStreetMap the way a buyer reads it from the curb. Pure, no I/O: the
// broker fetches (ghl-broker/site-context.js), this classifies.
//
// Why (2026-10-02): "Busy rd". "Double yellow is busy street." "The busy
// streets / proximity to the commercial district are a no-go for me." "Too
// close to hwy 99." About a dozen buyers passed on the street — Edmonds,
// Yakima, Ravenna, 3511 NE 153rd, 7034 S K St — and OpenStreetMap had every
// one of them: each fronts a secondary or tertiary street, or sits within
// 175 m of a primary; the quiet-street deals that sold show only residential
// roads. The Comps pane has had a "Busy road −5%" chip since the start; the
// auto-underwriter never applied it and the hand-built offers rarely did.
//
// Balanced, because the counterweight is real: a busy-road house comped
// against busy-road sales is already priced for it, so the cut is scaled by
// the share of ARV comps that DON'T share the trait — and a quiet house comped
// against busy-road sales earns a small credit back.

import { normalizeUsAddress, parseUsAddress } from "./us-address.js";

// The site presets the Comps pane offers as chips. Moved here from
// CompsPane.jsx so the auto checks and the pane agree on keys and percents.
// Percent of base ARV; defaults from published study ranges.
export const SITE_PRESETS = [
  { key: "busy_road", label: "Busy road", pct: -5 },
  { key: "power_lines", label: "Power lines / easement", pct: -6 },
  { key: "backs_commercial", label: "Backs commercial / industrial", pct: -5 },
  { key: "railroad", label: "Railroad / highway noise", pct: -6 },
  { key: "steep_lot", label: "Steep / difficult lot", pct: -4 },
  { key: "flood_zone", label: "Flood zone", pct: -7 },
  { key: "airport", label: "Airport flight path", pct: -5 },
  { key: "cell_tower", label: "Cell tower / substation", pct: -3 },
];
// The ones OpenStreetMap can see. The rest stay a person's call.
export const AUTO_SITE_KEYS = ["busy_road", "backs_commercial", "railroad"];

// OSM highway classes. "Busy" is secondary and up — tertiary is a collector
// with a yellow line in most of the cities we buy in (76th Ave W, Edmonds).
const RANK = { motorway: 6, trunk: 5, primary: 4, secondary: 3, tertiary: 2 };
const LINK = { motorway_link: "motorway", trunk_link: "trunk", primary_link: "primary", secondary_link: "secondary", tertiary_link: "tertiary" };
const clsOf = (h) => LINK[h] || h;
const rankOf = (h) => RANK[clsOf(h)] || 0;
const BUSY_RANK = RANK.tertiary;

/* ---------- reading Overpass ---------- */

/**
 * normalizeOverpass(json) → { roads, landuse, rail, water } | null
 *
 * Overpass `out tags geom` → just what the classifier needs. Null when the
 * answer isn't an Overpass answer (a rate-limit page, a runtime-error remark)
 * — "unavailable" must never read as "a quiet street".
 */
export function normalizeOverpass(json) {
  if (!json || typeof json !== "object" || !Array.isArray(json.elements)) return null;
  if (typeof json.remark === "string" && /runtime error|timed out|rate limit|too many requests|out of memory/i.test(json.remark)) return null;
  const roads = [];
  const landuse = [];
  const rail = [];
  // Rivers, for the same-side check (shared/same-side.js); only the
  // barrier query asks for them.
  const water = [];
  for (const e of json.elements) {
    const t = e?.tags || {};
    const geometry = Array.isArray(e?.geometry) ? e.geometry.filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon)) : [];
    if (geometry.length < 2) continue;
    if (t.highway && rankOf(t.highway) > 0) {
      roads.push({
        cls: clsOf(t.highway),
        link: Boolean(LINK[t.highway]),
        name: t.name || "",
        names: [t.name, t.alt_name, t.old_name, t.official_name, t.ref].filter(Boolean),
        lanes: Number(t.lanes) || null,
        maxspeed: Number(String(t.maxspeed || "").replace(/[^\d.]/g, "")) || null,
        geometry,
      });
    } else if (t.landuse && /^(commercial|retail|industrial)$/.test(t.landuse)) {
      landuse.push({ kind: t.landuse, geometry, closed: sameSpot(geometry[0], geometry[geometry.length - 1]) });
    } else if (t.railway === "rail" && !/^(spur|yard|siding|crossover)$/.test(t.service || "")) {
      rail.push({ name: t.name || "", geometry });
    } else if (t.waterway === "river") {
      water.push({ name: t.name || "", geometry });
    }
  }
  return { roads, landuse, rail, water };
}

const sameSpot = (a, b) => a && b && Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7;

/* ---------- geometry ---------- */

// Metres from a point to a polyline, on a local flat projection — plenty
// accurate inside a mile.
export function metersToLine(point, geometry = []) {
  const lat0 = point.lat * Math.PI / 180;
  const ky = 111320;
  const kx = 111320 * Math.cos(lat0);
  const px = point.lng * kx;
  const py = point.lat * ky;
  let best = Infinity;
  for (let i = 1; i < geometry.length; i++) {
    const ax = geometry[i - 1].lon * kx, ay = geometry[i - 1].lat * ky;
    const bx = geometry[i].lon * kx, by = geometry[i].lat * ky;
    const dx = bx - ax, dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}

// Inside a closed ring (ray casting). A house inside a commercial polygon is
// zero metres from it.
function inside(point, ring) {
  let yes = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.lat > point.lat) !== (b.lat > point.lat) &&
        point.lng < ((b.lon - a.lon) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lon) yes = !yes;
  }
  return yes;
}

/* ---------- street names ---------- */

// "76th Avenue West" and "76th Ave W" are the same street; so are "Hwy 99"
// and an OSM ref "SR 99". A key per name, USPS-normalized.
const streetKey = (s) => normalizeUsAddress(String(s || "")).toLowerCase().replace(/[^a-z0-9]/g, "");
const routeNo = (s) => (String(s || "").match(/\b(?:hwy|highway|sr|us|i|state route|route)[\s-]*(\d{1,3})\b/i) || [])[1] || "";

export function streetOfAddress(address = "") {
  return parseUsAddress(address).street || "";
}

function namesStreet(road, street) {
  const k = streetKey(street);
  if (!k) return false;
  if (road.names.some((n) => streetKey(n) === k)) return true;
  const rn = routeNo(street);
  return Boolean(rn) && road.names.some((n) => routeNo(n) === rn || String(n).trim() === rn);
}

/* ---------- classifying a point ---------- */

const PCT_KEY = { busy_road: "busyRoadPct", backs_commercial: "commercialPct", railroad: "railroadPct" };
const CLS_WORD = { motorway: "freeway", trunk: "highway", primary: "arterial", secondary: "arterial", tertiary: "collector" };

/**
 * classifyPoint({ point, street, precision, context, t }) → {
 *   flags: { busy_road?: {...}, backs_commercial?: {...}, railroad?: {...} },
 *   nearest: { road, cls, meters } | null,
 * }
 *
 * `t` is settings.underwriteChecks.site. `precision` is the geocode's
 * ("address" | "street" | …): distance rules need the house, so a point placed
 * only on its street is checked for frontage alone, and anything vaguer isn't
 * checked at all.
 */
export function classifyPoint({ point, street = "", precision = "address", context, t }) {
  const out = { flags: {}, nearest: null };
  if (!context || !point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return out;
  const exact = precision === "address" || precision === "rooftop" || precision == null;
  if (!exact && precision !== "street") return out;

  const roads = context.roads.map((r) => ({ ...r, meters: metersToLine(point, r.geometry) }));
  const busy = roads.filter((r) => rankOf(r.cls) >= BUSY_RANK).sort((a, b) => a.meters - b.meters);
  if (busy[0]) out.nearest = { road: busy[0].name || busy[0].names[0] || "", cls: busy[0].cls, meters: Math.round(busy[0].meters) };

  const fronts = busy.find((r) => r.meters <= t.frontageMeters && namesStreet(r, street));
  const adjacent = exact && busy.find((r) => r.meters <= t.adjacentMeters);
  const near = exact && busy.find((r) => (r.cls === "primary" || r.cls === "trunk") ? r.meters <= t.nearPrimaryMeters : r.cls === "motorway" ? r.meters <= t.nearMotorwayMeters : false);
  const hit = fronts ? ["fronts", fronts] : adjacent ? ["adjacent", adjacent] : near ? ["near", near] : null;
  if (hit) {
    const [how, r] = hit;
    const name = r.name || r.names[0] || "an unnamed road";
    out.flags.busy_road = {
      how, road: name, cls: r.cls, lanes: r.lanes, maxspeed: r.maxspeed, meters: Math.round(r.meters),
      label: how === "fronts" ? `fronts ${shortStreet(name)} (${CLS_WORD[r.cls]})`
        : how === "adjacent" ? `next to ${shortStreet(name)} (${CLS_WORD[r.cls]})`
        : `${Math.round(r.meters)} m from ${shortStreet(name)} (${CLS_WORD[r.cls]})`,
    };
  }

  if (exact) {
    let land = null;
    for (const l of context.landuse) {
      const m = l.closed && inside(point, l.geometry) ? 0 : metersToLine(point, l.geometry);
      if (m <= t.commercialMeters && (!land || m < land.meters)) land = { meters: Math.round(m), kind: l.kind };
    }
    if (land) out.flags.backs_commercial = { ...land, label: land.meters === 0 ? `on ${land.kind} land` : `${land.meters} m from ${land.kind} land` };
    let rail = null;
    for (const r of context.rail) {
      const m = metersToLine(point, r.geometry);
      if (m <= t.railMeters && (!rail || m < rail.meters)) rail = { meters: Math.round(m) };
    }
    if (rail) out.flags.railroad = { ...rail, label: `${rail.meters} m from a rail line` };
  }
  return out;
}

const shortStreet = (s) => normalizeUsAddress(String(s || "")).slice(0, 28);

/**
 * siteReport({ subject, comps, context, t }) → {
 *   status: "ok" | "unavailable" | "skipped",
 *   subject: { flags, nearest },
 *   comps: { [id]: string[] },   // flag keys per comp; a missing id = not checked
 * }
 *
 * `subject` is { lat, lng, address, precision }; comps carry id, lat, lng,
 * address (Zillow rows: rooftop coordinates).
 */
export function siteReport({ subject, comps = [], context, t }) {
  if (!context) return { status: "unavailable", subject: { flags: {}, nearest: null }, comps: {} };
  const s = subject || {};
  if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) return { status: "skipped", subject: { flags: {}, nearest: null }, comps: {} };
  const subj = classifyPoint({ point: { lat: s.lat, lng: s.lng }, street: streetOfAddress(s.address), precision: s.precision ?? "address", context, t });
  const byComp = {};
  for (const c of comps) {
    if (!c?.id || !Number.isFinite(c.lat) || !Number.isFinite(c.lng)) continue;
    byComp[c.id] = Object.keys(classifyPoint({ point: { lat: c.lat, lng: c.lng }, street: streetOfAddress(c.address), precision: "address", context, t }).flags);
  }
  return { status: "ok", subject: subj, comps: byComp };
}

/**
 * siteAdjustments({ report, arvCompIds, t, maxCreditPct, minPct }) → [{
 *   key, label, pct, source: "auto", basePct, share: { with, of }, note,
 * }]
 *
 * Per trait: the subject has it and k of n classified ARV comps do too →
 * preset × (1 − k/n). The subject doesn't and k of n comps do → a credit of
 * |preset| × k/n (all credits together capped at maxCreditPct). Nothing
 * classified → the full preset. A move under minPct isn't worth a line.
 */
export function siteAdjustments({ report, arvCompIds = [], t, maxCreditPct = 3, minPct = 1 }) {
  if (!report || report.status !== "ok") return [];
  const known = arvCompIds.filter((id) => Array.isArray(report.comps[id]));
  const rows = [];
  let credit = 0;
  for (const key of AUTO_SITE_KEYS) {
    const base = Number(t?.[PCT_KEY[key]]);
    if (!(base < 0)) continue;
    const withIt = known.filter((id) => report.comps[id].includes(key)).length;
    const of = known.length;
    const subj = report.subject.flags[key];
    const preset = SITE_PRESETS.find((p) => p.key === key);
    if (subj) {
      const pct = round1(base * (of ? 1 - withIt / of : 1));
      if (Math.abs(pct) < minPct) continue;
      rows.push({
        key, label: `${preset.label} — ${subj.label}`.slice(0, 60), pct, source: "auto", basePct: base,
        share: { with: withIt, of },
        note: of ? `${withIt} of ${of} ARV comps ${withIt === 1 ? "has" : "have"} it too` : "no ARV comp could be checked",
      });
    } else if (of && withIt) {
      const pct = round1(Math.min(-base * (withIt / of), Math.max(0, maxCreditPct - credit)));
      if (pct < minPct) continue;
      credit += pct;
      rows.push({
        key: `${key}_credit`, label: CREDIT_LABEL[key](withIt, of), pct, source: "auto", basePct: -base,
        share: { with: withIt, of }, note: `the subject has none of it; ${withIt} of ${of} ARV comps do`,
      });
    }
  }
  return rows;
}

const round1 = (n) => Math.round(n * 10) / 10;
const CREDIT_LABEL = {
  busy_road: (k, n) => `Quieter street than ${k} of ${n} comps`,
  backs_commercial: (k, n) => `No commercial next door, unlike ${k} of ${n} comps`,
  railroad: (k, n) => `No rail line nearby, unlike ${k} of ${n} comps`,
};

/**
 * mergeSiteAdjustments(operator, auto, declined) → the list deriveArv gets.
 *
 * A person's own entry always wins for its key (editing an auto cut makes it
 * theirs). An auto cut they removed stays removed — `declined` is the list of
 * keys they took off, kept on the snapshot so a re-run doesn't put it back.
 */
export function mergeSiteAdjustments(operator = [], auto = [], declined = []) {
  const mine = (operator || []).filter((a) => a && a.source !== "auto");
  const taken = new Set(mine.map((a) => baseKey(a.key)));
  const off = new Set(declined || []);
  return [...mine, ...(auto || []).filter((a) => !taken.has(baseKey(a.key)) && !off.has(a.key))];
}
const baseKey = (k) => String(k || "").replace(/_credit$/, "");

/**
 * siteFlagsOf(offer) → the street flags a deal carries, from the auto check
 * or a preset someone ticked by hand. What buyers see disclosed and what
 * their dealbreakers are matched against.
 */
export function siteFlagsOf(offer = {}) {
  const comps = offer?.snapshot?.comps || {};
  const flags = new Set(Object.keys(comps.site?.subject?.flags || {}));
  for (const a of comps.adjustments || []) if (AUTO_SITE_KEYS.includes(a?.key) && Number(a.pct) < 0) flags.add(a.key);
  return [...flags];
}

// The words a buyer reads in the pitch and the package.
export function siteLine(flags = []) {
  const f = new Set(flags);
  const bits = [f.has("busy_road") && "on a busy street", f.has("backs_commercial") && "next to commercial", f.has("railroad") && "near a rail line"].filter(Boolean);
  return bits.join(", ");
}

/**
 * siteDealbreakers(text) → string[] — the site keys a buyer's own words rule
 * out ("no busy streets", "quiet residential streets only", "no yellow
 * lines", "nothing near Aurora", "not near commercial", "no railroad").
 */
export function siteDealbreakers(text = "") {
  const t = String(text || "").toLowerCase();
  const out = new Set();
  if (/(no|not on|nothing on|avoid|won'?t do|no-go)\b[^.;]{0,25}(busy (st|street|rd|road)s?|arterials?|main roads?|yellow lines?|double yellow)|quiet (residential )?streets? only|busy (streets?|roads?)\b[^.;]{0,15}(no-go|not for me)|(near|close to) aurora/.test(t)) out.add("busy_road");
  if (/(no|not|avoid|nothing)\b[^.;]{0,25}(proximity to |near |next to |backs? (up )?(to|onto) )?(the )?commercial|commercial district[^.;]{0,15}no-go/.test(t)) out.add("backs_commercial");
  if (/(no|not|avoid|nothing)\b[^.;]{0,25}(rail(road)?|train tracks?|tracks)/.test(t)) out.add("railroad");
  return [...out];
}
