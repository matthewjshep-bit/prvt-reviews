// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// rehab-checks.js — is the scope complete? The work a buyer will price that
// our scope left out, as visible "Buyer allowance" lines. Pure, no I/O.
//
// Rehab was the most consistently wrong number in the 2026-10-02 read of
// every buyer thread: about 26 buyers said it was too low, at 1.2 to 4.3
// times ours, and not one ever said too high. The cause was missing scope,
// not markup — contingency is already 10% and the catalog prices installed
// work:
//
//   22018 76th Ave W (1941) went out as "not a gut job" at $30k. Buyers
//     itemized roof, water damage, siding, deck, bath, windows: $60–150k.
//     "Hard to find a true cosmetic built before 1980."
//   1415 2nd St (1904) went out as "full cosmetic" at $90k; $150–160k back.
//   3511 NE 153rd: "a hoarder house… probably needs 200k, probably more."
//
// So each line here needs evidence on this house — its age with the systems
// not shown updated, an area the photos grade poor with no line for it, the
// listing's own words, contents left behind, or a distressed listing priced
// as if it weren't. Nothing is added as a blanket markup, nothing pushes the
// scope past the heavy band (so a check can never create a hold), and a line
// a person removes stays removed.

import { ALL_REHAB_ITEMS, lineCost, sizeFactor, rehabBand, heavyCeiling } from "./rehab-catalog.js";
import { hydrateRehabState, priceScope } from "./rehab-scope.js";

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round100 = (n) => Math.round(n / 100) * 100;
const item = (id) => ALL_REHAB_ITEMS.find((i) => i.id === id);

// The scan's graded areas → the catalog line that fixes each one. Bathrooms
// and bedrooms have their own tiers and the foundation already holds the run,
// so neither is here.
const AREA_ROW = {
  roof: "roof", windows: "windows", exterior: "siding", kitchen: "kit-cab", flooring: "lvp",
  paint_walls: "paint-int", hvac: "hvac", plumbing: "plumb", electrical: "elec", yard: "landscape",
};
const AREA_WORD = {
  roof: "roof", windows: "windows", exterior: "siding / exterior", kitchen: "kitchen", flooring: "flooring",
  paint_walls: "walls / paint", hvac: "heating", plumbing: "plumbing", electrical: "electrical", yard: "yard",
};
// Defects named in the listing → the lines that price them. Fire and a
// carved-up layout have no honest catalog line; they're flagged, not priced.
const DEFECT_ROWS = {
  water_damage: ["drywall", "pest"],
  mold: ["pest"],
  roof: ["roof"],
  foundation: ["found"],
  sewer: ["sewer"],
};

const gradeOf = (areas = [], key) => (Array.isArray(areas) ? areas : []).find((a) => a?.area === key)?.grade || null;
const rowOn = (state, id) => Boolean(state.rows?.[id]?.on);
// The scope already pays for this line: a ticked row, or a custom/AI line
// that names it.
const priced = (state, id, words = []) => rowOn(state, id) ||
  (state.custom || []).some((c) => words.some((w) => String(c.label || "").toLowerCase().includes(w)));

// What one catalog line costs on this house, the way the scope would price it.
function costOf(id, sqft, { mult = 1, qty = null } = {}) {
  const it = item(id);
  if (!it) return 0;
  const row = it.mode === "qty" ? { qty: qty ?? 1 } : {};
  return round100(lineCost(it, row, sqft) * mult);
}
// Windows are priced per window; the count off the house's size.
const windowCount = (sqft) => Math.max(6, Math.round((num(sqft) || 1200) / 120));

/**
 * rehabChecks({ state, sqft, yearBuilt, arv, areas, contents, remarks, t, declined, cures }) → {
 *   rows: [{ id, key, label, cost, evidence }],   // "Buyer allowance" lines, in order
 *   flags: [{ key, label }],                       // named but not priceable
 *   before, after,                                 // scope totals without / with the rows
 *   floor: { amount, distressed, why } | null,
 *   trimmed,                                       // true when the heavy band cut a row
 * }
 *
 *   state     the rehab state the scope was priced from (rows, custom, rooms)
 *   areas     the photo scan's grades: [{ area, grade, note }]
 *   contents  the scan's read of belongings left behind: "none" | "some" | "heavy"
 *   remarks   remarkSignals(listing remarks) from house-facts.js
 *   t         settings.underwriteChecks.rehab
 *   declined  keys a person removed (kept on the snapshot)
 *   cures     ARV-side cures that belong in the scope (arv-checks compParity)
 */
export function rehabChecks({
  state, sqft = 0, yearBuilt = 0, arv = 0, areas = [], contents = "none", remarks = null,
  t = {}, declined = [], cures = [],
} = {}) {
  // Priced without any allowance a previous run left on the state — the
  // checks recompute those, they don't stack on them.
  const s = { ...hydrateRehabState(state), allowance: [] };
  const off = new Set(declined || []);
  const r = remarks || { updated: {}, defects: [], layout: [], legal: [], distressed: false, turnkey: false, contents: false };
  const rows = [];
  const flags = [];
  const add = (key, id, label, cost, evidence) => {
    if (off.has(key) || !(cost > 0)) return;
    if (rows.some((x) => x.id === id && id)) return;
    rows.push({ id: id ? `allow-${id}` : `allow-${key}`, key, label: `Buyer allowance — ${label}`.slice(0, 70), cost: Math.round(cost), evidence });
  };

  // R1 — systems by age. A house built before 1980 hasn't had its wiring and
  // pipes priced unless the scope, the photos or the listing say so; before
  // 1950 it's a rewire and a repipe, scaled to the house.
  const year = num(yearBuilt);
  if (year > 1800 && year < num(t.systemsBeforeYear || 1980)) {
    const old = year < num(t.oldHouseYear || 1950);
    const mult = old ? num(t.oldHouseMultiplier || 2) : 1;
    for (const [sys, id, newWord, oldWord] of [["electrical", "elec", "electrical update", "rewire"], ["plumbing", "plumb", "plumbing update", "repipe"]]) {
      if (priced(s, id, [sys, oldWord, "rewire", "repipe"])) continue;
      if (gradeOf(areas, sys) === "good" || r.updated?.[sys]) continue;
      const it = item(id);
      const cost = old ? round100(num(it.unit) * mult * sizeFactor(sqft)) : costOf(id, sqft);
      add(`systems_${sys}`, id, `${old ? oldWord : newWord} (built ${year})`, cost,
        `built ${year}; ${gradeOf(areas, sys) ? `photos grade ${sys} ${gradeOf(areas, sys)}` : `photos don't show the ${sys}`}`);
    }
  }

  // R2 — an area the photos grade poor with no line paying for it.
  for (const [area, id] of Object.entries(AREA_ROW)) {
    if (gradeOf(areas, area) !== "poor") continue;
    if (priced(s, id, [AREA_WORD[area].split(" ")[0]])) continue;
    if (rows.some((x) => x.id === `allow-${id}`)) continue;
    add(`photos_${area}`, id, `${AREA_WORD[area]} (photos: poor)`, costOf(id, sqft, { qty: area === "windows" ? windowCount(sqft) : null }),
      (Array.isArray(areas) ? areas : []).find((a) => a?.area === area)?.note || `the photos grade the ${AREA_WORD[area]} poor`);
  }

  // R3 — the listing's own words.
  for (const d of r.defects || []) {
    const ids = DEFECT_ROWS[d.key];
    if (!ids) { flags.push({ key: `remarks_${d.key}`, label: `the listing mentions ${d.label} — price it by hand` }); continue; }
    for (const id of ids) {
      if (priced(s, id, [item(id)?.label.split(" ")[0].toLowerCase()])) continue;
      if (rows.some((x) => x.id === `allow-${id}`)) continue;
      add(`remarks_${d.key}`, id, `${item(id)?.label.toLowerCase()} (listing: ${d.label})`, costOf(id, sqft), `the listing says ${d.label}`);
    }
  }
  for (const l of r.layout || []) {
    if (l.key === "converted_rooms") flags.push({ key: "remarks_converted_rooms", label: "the listing says it's carved into rooms — price putting it back by hand" });
  }

  // R4 — contents left behind.
  const heavy = contents === "heavy";
  if (t.cleanout !== false && (heavy || contents === "some" || r.contents) && !priced(s, "junk", ["junk", "clean"])) {
    add("cleanout", "junk", heavy ? "heavy cleanout" : "cleanout", costOf("junk", sqft, { mult: heavy ? 2 : 1 }),
      heavy ? "the photos show the house full of belongings" : contents === "some" ? "the photos show belongings left behind" : "the listing mentions contents left behind");
  }

  // Cures the ARV assumes (a second bath when the ARV comps have one).
  for (const c of cures || []) add(c.key, null, c.label.replace(/^Add a bath/, "add a bath"), num(c.cost), c.label);

  // R5 — a distressed listing is never priced as if it weren't: at least
  // distressedMinPctOfArv of the ARV and the size band's light floor.
  const before = priceScope(s, sqft).total;
  const allowanceSum = () => rows.reduce((tt, x) => tt + x.cost, 0);
  const contingency = 1 + num(s.contingency) / 100;
  const poorish = (Array.isArray(areas) ? areas : []).filter((a) => a?.grade === "poor" || a?.grade === "dated").length;
  const distressed = !r.turnkey && (r.distressed || poorish >= 3);
  let floor = null;
  if (distressed && num(arv) > 0 && !off.has("distress_floor")) {
    const band = rehabBand(sqft);
    const amount = Math.max(num(arv) * num(t.distressedMinPctOfArv || 8) / 100, band ? band.light[0] : 0);
    const withRows = Math.round((priceScope(s, sqft).subtotal + allowanceSum()) * contingency);
    floor = { amount: Math.round(amount), distressed: true, why: r.distressed ? "the listing sells it as a project" : `${poorish} areas graded dated or poor` };
    if (withRows < amount) {
      add("distress_floor", null, `distressed listing, held to ${num(t.distressedMinPctOfArv || 8)}% of ARV`,
        Math.ceil((amount / contingency - priceScope(s, sqft).subtotal - allowanceSum()) / 100) * 100, floor.why);
    }
  }

  // The heavy band is a ceiling, never a target: allowances fill up to it and
  // stop, so a check can't hold a run. The distress floor goes first, then the
  // cleanout, then photo lines; the systems lines are the last to give.
  const ceiling = Math.max(heavyCeiling(sqft) || Infinity, before);
  let trimmed = false;
  const order = ["distress_floor", "cleanout", "remarks_", "photos_", "add_bath", "systems_"];
  const total = () => Math.round((priceScope(s, sqft).subtotal + allowanceSum()) * contingency / 500) * 500;
  for (const prefix of order) {
    while (total() > ceiling) {
      const i = rows.findIndex((x) => x.key.startsWith(prefix));
      if (i < 0) break;
      const over = total() - ceiling;
      const cut = Math.ceil(over / contingency / 100) * 100;
      if (rows[i].cost > cut) { rows[i] = { ...rows[i], cost: rows[i].cost - cut, trimmed: true }; trimmed = true; break; }
      rows.splice(i, 1);
      trimmed = true;
    }
  }

  const after = rows.length ? total() : before;
  return { rows, flags, before, after, floor, trimmed };
}

/**
 * withAllowance(state, rows) → the state with the allowance lines on it, so
 * priceScope prices them (contingency included) and the scope PDF prints them.
 */
export function withAllowance(state, rows = []) {
  const s = hydrateRehabState(state);
  return { ...s, allowance: rows.map((x) => ({ id: x.id, key: x.key, label: x.label, cost: Math.round(num(x.cost)) })) };
}
