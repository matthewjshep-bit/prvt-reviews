// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// rehab-scope.js — the scope-of-work state machine: a rehab checklist, what an
// AI photo scan does to it, and what it costs. Pure functions, no I/O, no deps.
//
// This used to live inside RehabPane.jsx, which was fine while a human clicking
// through the New Offer page was the only thing that could produce a repair
// number. The auto-underwrite pipeline runs the same scan server-side, so the
// pricing had to come out of the component or the two would drift — and a
// repair figure that disagrees with the one on the scope-of-work PDF is the
// kind of bug you discover in front of a seller's agent.
//
// The pane now imports these; nothing in here knows React exists.

import {
  ALL_REHAB_ITEMS, BED_TIERS, BATH_TIERS, lineCost,
} from "./rehab-catalog.js";

const parse = (v) => Number(String(v).replace(/[^\d.]/g, "")) || 0;

// Rooms are a fixed-length list so "bathroom 3" keeps its tier when you add a
// fourth. Growing pads with "no work" rather than repeating the last row.
export const resizeRooms = (rooms, n) => {
  const next = (rooms || []).slice(0, n);
  while (next.length < n) next.push({ tier: "none", unit: 0 });
  return next;
};

// Every catalog item present and unticked, at catalog prices. The rows map is
// dense on purpose: a sparse one makes "did the user untick this, or has it
// never existed?" unanswerable when an older offer is reopened.
export function blankRehabState() {
  return {
    rows: Object.fromEntries(ALL_REHAB_ITEMS.map((i) => [i.id, { on: false, unit: i.unit, qty: 1 }])),
    bedCount: 0,
    bathCount: 0,
    bedRooms: [],
    bathRooms: [],
    custom: [],
    contingency: "10",
    bucket: null,
    bucketAmount: "",
    aiResult: null,
  };
}

// Merge a partial (a restored snapshot, or nothing) onto the blank state so
// every consumer below can index without guarding. Rows merge per-item rather
// than wholesale, so a snapshot that predates a new catalog item still gets it.
export function hydrateRehabState(state) {
  const base = blankRehabState();
  if (!state || typeof state !== "object") return base;
  return {
    ...base,
    ...state,
    rows: { ...base.rows, ...(state.rows || {}) },
  };
}

// The subject's recorded bed/bath counts drive how many room rows exist.
// Bathrooms round UP — a 2.5-bath house has three rooms to walk into, and the
// half bath gets a cheap tier rather than no row at all.
export function seedRoomCounts(state, { beds = 0, baths = 0 } = {}) {
  const s = hydrateRehabState(state);
  const next = { ...s };
  if (Number(beds) > 0) {
    next.bedCount = Math.round(Number(beds));
    next.bedRooms = resizeRooms(s.bedRooms, next.bedCount);
  }
  if (Number(baths) > 0) {
    next.bathCount = Math.ceil(Number(baths));
    next.bathRooms = resizeRooms(s.bathRooms, next.bathCount);
  }
  return next;
}

// Apply an AI photo-scan suggestion onto the checklist.
//
// Ticking is one-way: the scan turns items ON and never off. A scan is evidence
// that work is needed, not evidence that unticked work isn't — and on a re-scan
// silently clearing what the operator ticked by hand would lose real judgement.
//
// Room counts only ever grow (capped at 10). The listing photos are the only
// thing that can reveal a bathroom the county record missed, so when the scan
// grades more rooms than the record claims, the scan wins.
export function applyScanSuggestion(state, suggestion, { photosAnalyzed = null } = {}) {
  const s = hydrateRehabState(state);
  const sug = suggestion || {};
  const next = { ...s, rows: { ...s.rows } };

  for (const it of sug.items || []) {
    if (next.rows[it.id]) next.rows[it.id] = { ...next.rows[it.id], on: true };
  }

  const applyRooms = (list, tiers, count, rooms) => {
    if (!(list || []).length) return { count, rooms };
    const n = Math.min(10, Math.max(count, list.length));
    return {
      count: n,
      rooms: resizeRooms(rooms, n).map((room, i) => {
        const t = list[i] && tiers.find((x) => x.id === list[i].tier);
        return t ? { tier: t.id, unit: t.unit } : room;
      }),
    };
  };

  const baths = applyRooms(sug.bathrooms, BATH_TIERS, s.bathCount, s.bathRooms);
  next.bathCount = baths.count;
  next.bathRooms = baths.rooms;
  const beds = applyRooms(sug.bedrooms, BED_TIERS, s.bedCount, s.bedRooms);
  next.bedCount = beds.count;
  next.bedRooms = beds.rooms;

  // Issues the catalog has no line for. Ids are index-based rather than
  // timestamped so the same scan applied twice produces the same state — the
  // automation re-runs are otherwise impossible to compare.
  const extra = (sug.custom || [])
    .filter((x) => Number(x.cost) > 0)
    .map((x, i) => ({ id: `ai-${i}-${String(x.label || "").slice(0, 24)}`, label: x.label, cost: Math.round(Number(x.cost)) }))
    .filter((x) => !s.custom.some((c) => c.label === x.label && c.cost === x.cost));
  if (extra.length) next.custom = [...s.custom, ...extra];

  const labelOf = (id) => ALL_REHAB_ITEMS.find((i) => i.id === id)?.label || id;
  next.aiResult = {
    summary: sug.summary || "",
    photosAnalyzed,
    areas: Array.isArray(sug.areas) ? sug.areas : [],
    notes: [
      ...(sug.items || []).map((it) => ({ label: labelOf(it.id), note: it.note })),
      ...(sug.bathrooms || []).map((b, i) => ({ label: `Bathroom ${i + 1} — ${b.tier}`, note: b.note })),
      ...(sug.bedrooms || []).map((b, i) => ({ label: `Bedroom ${i + 1} — ${b.tier}`, note: b.note })),
      ...(sug.custom || []).map((c) => ({ label: c.label, note: c.note })),
    ].filter((n) => n.note),
  };

  return next;
}

// The priced scope: one line per room with work, per ticked catalog item, and
// per custom entry. `total` adds the contingency and rounds to $500 — a repair
// estimate quoted to the dollar reads as false precision.
export function priceScope(state, sqft) {
  const s = hydrateRehabState(state);
  const sqftNum = Number(sqft) || 0;
  const lines = [];

  s.bathRooms.forEach((room, i) => {
    if (room.tier === "none" || room.unit <= 0) return;
    const t = BATH_TIERS.find((x) => x.id === room.tier);
    lines.push({ label: `Bathroom ${i + 1} — ${t?.label.toLowerCase() || room.tier}`, cost: Math.round(room.unit) });
  });
  s.bedRooms.forEach((room, i) => {
    if (room.tier === "none" || room.unit <= 0) return;
    const t = BED_TIERS.find((x) => x.id === room.tier);
    lines.push({ label: `Bedroom ${i + 1} — ${t?.label.toLowerCase() || room.tier}`, cost: Math.round(room.unit) });
  });
  for (const item of ALL_REHAB_ITEMS) {
    const row = s.rows[item.id];
    if (!row || !row.on) continue;
    const cost = Math.round(lineCost(item, row, sqftNum));
    if (cost <= 0) continue;
    const qty = item.mode === "qty" && parse(row.qty) > 1 ? ` ×${parse(row.qty)}` : "";
    lines.push({ label: `${item.label}${qty}`, cost });
  }
  for (const c of s.custom) lines.push({ label: c.label, cost: c.cost });

  const subtotal = lines.reduce((t, l) => t + l.cost, 0);
  const total = Math.round((subtotal * (1 + (parse(s.contingency) || 0) / 100)) / 500) * 500;
  return { lines, subtotal, total };
}

// Which number actually becomes the offer's repair figure. A quick-bucket
// override (Light/Medium/Heavy off the cheat sheet) beats the itemized total —
// the itemization still prints on the scope of work either way.
export function scopeAmount(state, sqft) {
  const s = hydrateRehabState(state);
  if (s.bucket) return parse(s.bucketAmount) || 0;
  return priceScope(s, sqft).total;
}
