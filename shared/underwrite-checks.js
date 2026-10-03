// underwrite-checks.js — the buyer's view of a house: what each check is
// allowed to do, and the summary every surface prints. Pure, no I/O.
//
// Why these exist (2026-10-02). Every buyer thread with a reply was read —
// 539 of them, calls included — after a run of deals fell through. Buyers
// passed for reasons the underwriting could have seen first:
//
//   rehab too low (~26 buyers, never once "too high") — pre-1950 houses
//     pitched as cosmetic while the photos showed the roof, the water damage,
//     the siding; the remarks said "low ceilings"
//   ARV too high (~16) — the record's square footage, no garage, a short
//     basement, comps listed for less today
//   the street (~12) — "busy rd", "double yellow is busy street"
//   already seen it (~14) — on the MLS, pending, shopped cheaper elsewhere
//
// and one counterweight that shaped every default here: on the Mamer listing
// the agent agreed with our ARV and rehab and our $326k still lost to a $425k
// cash offer. Too low is also a miss. So a check fires only on evidence about
// THIS house, measures against the comps, is capped, shows its working, can be
// removed by hand — and the whole set ships switched off until a quiet
// backtest against what buyers actually paid says it's right.

import { deriveArv, arvPool } from "./arv.js";
import { siteAdjustments, mergeSiteAdjustments } from "./site-check.js";
import { sizeCheck, compParity, sameBathComps, activeCeiling, limitAuto } from "./arv-checks.js";
import { rehabChecks } from "./rehab-checks.js";
import { remarkSignals, normalizeHouse, garageOf } from "./house-facts.js";
import { monthsSince } from "./comp-match.js";
import { parseUsAddress } from "./us-address.js";

const num = (v) => {
  const n = Number(typeof v === "string" ? v.replace(/[$,\s%]/g, "") : v);
  return Number.isFinite(n) ? n : NaN;
};
const n0 = (v) => { const n = num(v); return Number.isFinite(n) ? n : 0; };

export const UNDERWRITE_CHECKS_DEFAULTS = Object.freeze({
  // The master switch. Off until Matt turns it on after the backtest; a run
  // can force it for a backtest without touching the saved setting.
  enabled: false,
  // The street and what's next to it, from OpenStreetMap. Cuts are the
  // CompsPane presets, scaled by how many ARV comps share the trait.
  site: {
    enabled: true,
    frontageMeters: 75,      // the address's own street, within this of the point
    adjacentMeters: 35,      // any secondary-or-bigger road this close (corner, backs onto it)
    nearPrimaryMeters: 175,  // a primary/trunk this close (7034 S K St drew it at 163 m)
    nearMotorwayMeters: 250,
    commercialMeters: 50,
    railMeters: 150,
    busyRoadPct: -5,
    commercialPct: -5,
    railroadPct: -6,
  },
  // The same finished house: what the comps have that the subject lacks.
  layout: {
    enabled: true,
    verifySizePct: 10,       // sqft used more than this over the record → use the record
    garagePct: -3,           // no garage among garage comps, × the share that have one
    smallLotRatio: 0.6,      // subject lot under this × the comps' median lot
    smallLotPct: -2,
    bathCure: true,          // fewer baths than the ARV comps → add one to the scope
    addBathCost: 25000,
  },
  // Today's listings: ARV can't sit above what similar renovated-looking
  // houses are listed for now. One more Zillow pull (~$0.15).
  actives: {
    enabled: true,
    radiusMiles: 1,
    minActives: 3,
    candidates: 10,
    maxCutPct: 20,
    includePending: true,
  },
  // Is the scope complete? Visible "Buyer allowance" lines.
  rehab: {
    enabled: true,
    systemsBeforeYear: 1980,
    oldHouseYear: 1950,
    oldHouseMultiplier: 2,
    distressedMinPctOfArv: 8,
    cleanout: true,
  },
  // The balance: auto adjustments never move ARV past these, and a cut under
  // minAdjPct isn't worth a line.
  limits: {
    maxArvCutPct: 15,
    maxArvCreditPct: 3,
    minAdjPct: 1,
  },
  // Shown, never priced.
  flags: {
    enabled: true,
    highArv: 1500000,
    smallSqft: 1000,
    staleCompMonths: 6,
  },
});

// [min, max] per number. Out-of-range values are clamped, unparseable ones
// fall back to the default.
const RANGES = {
  site: {
    frontageMeters: [10, 200], adjacentMeters: [5, 100], nearPrimaryMeters: [0, 500], nearMotorwayMeters: [0, 800],
    commercialMeters: [0, 300], railMeters: [0, 500], busyRoadPct: [-15, 0], commercialPct: [-15, 0], railroadPct: [-15, 0],
  },
  layout: { verifySizePct: [2, 50], garagePct: [-10, 0], smallLotRatio: [0.2, 1], smallLotPct: [-10, 0], addBathCost: [0, 100000] },
  actives: { radiusMiles: [0.25, 2], minActives: [2, 10], candidates: [3, 20], maxCutPct: [0, 40] },
  rehab: { systemsBeforeYear: [1900, 2010], oldHouseYear: [1880, 2000], oldHouseMultiplier: [1, 4], distressedMinPctOfArv: [0, 30] },
  limits: { maxArvCutPct: [0, 40], maxArvCreditPct: [0, 10], minAdjPct: [0, 5] },
  flags: { highArv: [100000, 20000000], smallSqft: [300, 3000], staleCompMonths: [1, 36] },
};

export const CHECK_SECTIONS = Object.keys(RANGES);

/**
 * normalizeUnderwriteChecks(v) → the full settings block, every key present.
 *
 * The master switch is on only when it says exactly true. A section is on
 * unless it says exactly false, so turning the master on brings every check
 * Matt chose with it.
 */
export function normalizeUnderwriteChecks(v) {
  const src = v && typeof v === "object" ? v : {};
  const out = { enabled: src.enabled === true };
  for (const sec of CHECK_SECTIONS) {
    const d = UNDERWRITE_CHECKS_DEFAULTS[sec];
    const s = src[sec] && typeof src[sec] === "object" ? src[sec] : {};
    const o = {};
    for (const [k, dv] of Object.entries(d)) {
      if (typeof dv === "boolean") { o[k] = s[k] === undefined || s[k] === null ? dv : s[k] !== false; continue; }
      const n = num(s[k]);
      const [lo, hi] = RANGES[sec][k] || [-Infinity, Infinity];
      o[k] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dv;
    }
    out[sec] = o;
  }
  return out;
}

/**
 * checksFor(saved, { force }) → normalized settings, or null when the checks
 * don't run. `force` is the backtest: on for this run, saved setting untouched.
 */
export function checksFor(saved, { force = false } = {}) {
  const c = normalizeUnderwriteChecks(saved?.underwriteChecks);
  if (force) c.enabled = true;
  return c.enabled ? c : null;
}

// Ferry-only places (Vashon/Maury, the San Juans, Anderson Island): ~16
// buyers passed on Vashon for the ferry alone — "a ferry ride my contractors
// won't do". It still sold at our numbers, so this is a smaller buyer pool to
// disclose and target, never a price cut.
export const FERRY_ONLY_ZIPS = new Set(["98070", "98250", "98261", "98245", "98243", "98279", "98280", "98297", "98303"]);

// The declined lists a person builds by removing auto lines, in one place.
export function normalizeDeclined(d) {
  const s = d && typeof d === "object" ? d : {};
  const list = (v) => (Array.isArray(v) ? [...new Set(v.map(String).filter(Boolean))] : []);
  return { arv: list(s.arv), rehab: list(s.rehab), cap: s.cap === true };
}

/**
 * buyerView({...}) → the checks applied to one house.
 *
 *   checks      normalized settings (checksFor) — null means don't run
 *   address     the subject's address (ZIP for the ferry flag; the listings
 *               cap never uses the subject's own listing)
 *   subject     { sqft, beds, baths, yearBuilt, lotSqft } — the record
 *   house       house facts (normalizeHouse shape): garage, above/below grade, status…
 *   remarks     the listing description (text)
 *   comps       the ARV comps as deriveArv would get them (condition resolved,
 *               similarity, id, lat/lng, garage/lotSqft/baths when known)
 *   sqft        the size the offer would use (editor input, else the record)
 *   trend       timeTrend() of the ring
 *   operatorAdjustments  a person's own ARV adjustments (kept as theirs)
 *   site        siteReport() or null (null = the street wasn't checked)
 *   actives     for-sale/pending rows in the ring, or null (not pulled)
 *   areas, contents   the photo scan's grades and its read of belongings
 *   rehabState  the scope state the repairs were priced from
 *   declined    { arv: [keys], rehab: [keys], cap } a person removed
 *
 * Returns { arv, sqftForArv, adjustments, cap, rehab, flags, status, summary }
 * where `arv` is a deriveArv result (or null), `rehab` a rehabChecks result
 * (or null), and `summary` the compact record kept on the offer.
 */
export function buyerView({
  checks, address = "", subject = {}, house = null, remarks = "", comps = [], sqft = 0, trend = null,
  operatorAdjustments = [], site = null, actives, areas = [], contents = "none", rehabState = null,
  declined = null, now = Date.now(),
} = {}) {
  if (!checks) return null;
  const d = normalizeDeclined(declined);
  const h = normalizeHouse(house || {});
  const signals = remarkSignals(remarks || "");
  const lim = checks.limits;
  const flags = [];
  const status = { site: site ? site.status : "off", actives: "off", facts: house ? "ok" : "none" };

  // The size an ARV is measured at.
  let sqftForArv = n0(sqft) || n0(subject.sqft);
  if (checks.layout.enabled) {
    const sc = sizeCheck({
      sqft: sqftForArv, record: { sqft: subject.sqft }, house: h,
      lowCeilingBasement: signals.layout.some((l) => l.key === "low_ceiling"), t: checks.layout,
    });
    sqftForArv = sc.sqft || sqftForArv;
    if (sc.flag) flags.push(sc.flag);
  }

  // The comps that carry the ARV, re-picked to same-bath sales when a person
  // took the add-a-bath cure off.
  let pool = arvPool(comps);
  const subjectFacts = { garage: garageOf(h), lotSqft: subject.lotSqft, baths: subject.baths, beds: subject.beds };
  let parity = { adjustments: [], cures: [] };
  if (checks.layout.enabled) {
    parity = compParity({ subject: subjectFacts, arvComps: pool, t: checks.layout, minPct: lim.minAdjPct });
    if (d.rehab.includes("add_bath") && parity.cures.some((c) => c.key === "add_bath")) {
      pool = sameBathComps(pool, subject.baths);
      parity = { ...compParity({ subject: subjectFacts, arvComps: pool, t: { ...checks.layout, bathCure: false }, minPct: lim.minAdjPct }), cures: [] };
    }
  }

  const pre = pool.length ? deriveArv({ comps: pool, subjectSqft: sqftForArv, subjectYearBuilt: subject.yearBuilt, trend, now }) : null;

  // Today's listings.
  // `actives`: an array when pulled, null when the pull failed, undefined when
  // nobody asked — three different lines on the note.
  let cap = null;
  let ceiling = null;
  if (!checks.actives.enabled) status.actives = "off";
  else if (!Array.isArray(actives)) status.actives = actives === null ? "unavailable" : "off";
  else if (!pre) status.actives = "skipped";
  else {
    ceiling = activeCeiling({ actives, subject: { ...subject, sqft: sqftForArv, garage: subjectFacts.garage }, subjectAddress: address, t: checks.actives, now });
    status.actives = ceiling.status;
    if (ceiling.status === "ok" && !d.cap) cap = { amount: ceiling.amount, label: ceiling.label, maxCutPct: checks.actives.maxCutPct };
  }
  const capBinds = cap && pre && pre.base > cap.amount;

  // The street, measured against whatever set the number: the listings when
  // the cap binds, the ARV comps otherwise.
  let siteRows = [];
  if (checks.site.enabled && site?.status === "ok") {
    const ids = capBinds && ceiling?.items?.every((i) => Array.isArray(site.comps[i.id])) ? ceiling.items.map((i) => i.id) : pool.map((c) => c.id);
    siteRows = siteAdjustments({ report: site, arvCompIds: ids, t: checks.site, maxCreditPct: lim.maxArvCreditPct, minPct: lim.minAdjPct });
  }
  const auto = limitAuto([...siteRows, ...parity.adjustments], { maxCutPct: lim.maxArvCutPct, maxCreditPct: lim.maxArvCreditPct });
  const adjustments = mergeSiteAdjustments(operatorAdjustments, auto, d.arv);
  const arv = pool.length ? deriveArv({ comps: pool, subjectSqft: sqftForArv, subjectYearBuilt: subject.yearBuilt, adjustments, trend, cap, now }) : null;

  // The scope a buyer would price.
  let rehab = null;
  if (checks.rehab.enabled && rehabState) {
    rehab = rehabChecks({
      state: rehabState, sqft: n0(subject.sqft) || sqftForArv, yearBuilt: subject.yearBuilt, arv: arv?.arv || pre?.arv || 0,
      areas, contents, remarks: signals, t: checks.rehab, declined: d.rehab,
      cures: parity.cures.filter((c) => !d.rehab.includes(c.key)),
    });
    for (const f of rehab.flags) flags.push(f);
  }

  // Shown, never priced.
  if (checks.flags.enabled) {
    const listed = /for_sale|for sale|active|pending|coming_soon|under contract/i.test(h.status || "");
    if (listed || h.daysOnMarket != null) {
      const bits = [listed ? (/pending/i.test(h.status) ? "pending" : "on the market") : "", h.daysOnMarket != null ? `${h.daysOnMarket} days` : "", h.priceCuts ? `${h.priceCuts} price cut${h.priceCuts === 1 ? "" : "s"}` : ""].filter(Boolean);
      if (bits.length) flags.push({ key: "exposure", label: `${bits.join(", ")} — buyers have likely seen it` });
    }
    const legal = new Map(signals.legal.map((l) => [l.key, l.label]));
    if (h.sewer === "septic") legal.set("septic", "septic");
    if (h.hoa) legal.set("hoa", "an HOA");
    for (const [key, label] of legal) flags.push({ key: `legal_${key}`, label: `the listing shows ${label}` });
    for (const l of signals.layout) if (l.key === "tuck_under" || (l.key === "low_ceiling" && !flags.some((f) => f.key === "low_basement"))) flags.push({ key: `layout_${l.key}`, label: l.label });
    const zip = parseUsAddress(address).zip;
    if (FERRY_ONLY_ZIPS.has(zip)) flags.push({ key: "thin_island", label: "ferry-only — a small buyer pool; send to buyers who've bought there" });
    if ((arv?.arv || 0) >= checks.flags.highArv) flags.push({ key: "thin_high_arv", label: `ARV over $${(checks.flags.highArv / 1e6).toFixed(1)}M — fewer buyers at that price` });
    if (n0(subject.sqft) > 0 && n0(subject.sqft) < checks.flags.smallSqft) flags.push({ key: "thin_small", label: `under ${checks.flags.smallSqft.toLocaleString()} sqft — fewer buyers want it` });
    const ages = pool.map((c) => monthsSince(c.saleDate, now)).filter((m) => m != null);
    const medAge = ages.length ? [...ages].sort((a, b) => a - b)[Math.floor(ages.length / 2)] : 0;
    if (medAge > checks.flags.staleCompMonths && n0(trend?.pctPerMonth) < 0) flags.push({ key: "stale_comps", label: `the ARV comps sold ${Math.round(medAge)} months ago in a falling market` });
  }

  const summary = {
    v: 1, at: new Date(now).toISOString(),
    arv: arv ? {
      base: pre?.base ?? arv.base, final: arv.arv, sqft: sqftForArv,
      capped: arv.capped || null,
      adjustments: (arv.adjustments || []).filter((a) => a.source === "auto").map((a) => ({ key: a.key, label: a.label, pct: a.pct })),
    } : null,
    cap: ceiling ? { status: ceiling.status, amount: ceiling.amount || null, n: ceiling.n || 0, label: ceiling.label || ceiling.reason || "", items: ceiling.items || [] } : null,
    rehab: rehab ? { before: rehab.before, after: rehab.after, rows: rehab.rows.map((x) => ({ key: x.key, label: x.label, cost: x.cost })) } : null,
    flags: flags.map((f) => ({ key: f.key, label: f.label })),
    status,
    declined: d,
  };
  return { arv, pre, sqftForArv, adjustments, cap: ceiling, rehab, flags, status, summary };
}

/**
 * checksLines(summary) → the lines a note, a PDF or a pane prints:
 *   "Street: Busy road — fronts S Yakima Ave (arterial) −3.8%"
 *   "Listings: capped at $380,000 — what 4 similar houses … are listed for now"
 *   "Rehab: +$14,800 — rewire (built 1941), repipe (built 1941)"
 *   "Flags: on the market, 64 days — buyers have likely seen it; septic"
 */
export function checksLines(summary) {
  if (!summary) return [];
  const out = [];
  const pct = (p) => `${p > 0 ? "+" : "−"}${Math.abs(p)}%`;
  const adj = summary.arv?.adjustments || [];
  if (adj.length) out.push(`ARV: ${adj.map((a) => `${a.label} ${pct(a.pct)}`).join("; ")}`);
  if (summary.arv?.capped) out.push(`Listings: capped at $${Number(summary.arv.capped.to).toLocaleString()}${summary.arv.capped.label ? ` — ${summary.arv.capped.label}` : ""}`);
  else if (summary.cap && summary.cap.status !== "ok" && summary.cap.label) out.push(`Listings: not applied — ${summary.cap.label}`);
  const rows = summary.rehab?.rows || [];
  if (rows.length) out.push(`Rehab: +$${rows.reduce((t, r) => t + r.cost, 0).toLocaleString()} — ${rows.map((r) => r.label.replace(/^Buyer allowance — /, "")).join(", ")}`);
  if (summary.status?.site === "unavailable") out.push("Street: not checked (map service unavailable)");
  const f = summary.flags || [];
  if (f.length) out.push(`Flags: ${f.map((x) => x.label).join("; ")}`);
  return out;
}

/**
 * summarizeChecks(snapshot) → the compact record kept on the offer (lean
 * rows carry it), or null when the checks didn't run for this offer.
 */
export function summarizeChecks(snapshot) {
  const s = snapshot?.checks;
  if (!s || typeof s !== "object" || s.v !== 1) return null;
  return {
    v: 1, at: s.at || null,
    arvCutPct: (s.arv?.adjustments || []).reduce((t, a) => t + (Number(a.pct) || 0), 0),
    capped: Boolean(s.arv?.capped),
    rehabAdded: (s.rehab?.rows || []).reduce((t, r) => t + (Number(r.cost) || 0), 0),
    flags: (s.flags || []).map((f) => f.key),
    lines: checksLines(s),
  };
}
