// offer-snapshot.js — fitting the New Offer workspace into the size an offer
// row will accept.
//
// The snapshot is the entire form state (comps board, rehab state, inputs) and
// exists so History → Edit restores an offer intact. It rides inside the
// offer's jsonb `doc`, so it needs a ceiling.
//
// The ceiling used to be all-or-nothing: one byte over and the WHOLE snapshot
// became null, taking the comps, the rehab scope and the comps PDF with it —
// silently, on an otherwise successful create. That is the worst available
// failure mode for the one field whose entire job is "don't lose my work".
//
// So shed instead, cheapest loss first, re-measuring after each cut, and say
// what went. The ordering encodes what is actually recoverable:
//
//   an AI condition report   → one more call away
//   a provider comp list     → one button away
//   a Zillow capture         → GONE. /comps/claim is read-and-delete, so once
//                              it reaches the form it exists nowhere else.
//
// which is why comps outrank everything and captured comps are the last thing
// standing before we give up.

export const SNAPSHOT_LIMIT = 400_000;

const size = (o) => {
  try { return JSON.stringify(o).length; } catch { return Infinity; }
};

// Each step returns a NEW snapshot (never mutates the caller's) or null when it
// doesn't apply to this payload.
const STEPS = [
  {
    note: "dropped the AI condition report",
    apply: (s) => {
      if (!s.rehab?.aiResult) return null;
      return { ...s, rehab: { ...s.rehab, aiResult: null } };
    },
  },
  {
    note: "dropped comps you hadn't ticked",
    apply: (s) => {
      const list = s.comps?.result?.comps;
      if (!Array.isArray(list) || !list.length) return null;
      const keep = new Set(s.comps?.selected || []);
      const kept = list.filter((c) => keep.has(c?.id));
      if (kept.length === list.length) return null;
      return { ...s, comps: { ...s.comps, result: { ...s.comps.result, comps: kept } } };
    },
  },
  {
    note: "dropped the comps map data",
    apply: (s) => {
      if (!s.comps?.result) return null;
      return { ...s, comps: { ...s.comps, result: null } };
    },
  },
  {
    note: "kept only the comps — the rest of the form was too large to store",
    apply: (s) => {
      if (!s.comps || Object.keys(s).length === 1) return null;
      return { comps: s.comps };
    },
  },
];

// Returns { snapshot, warnings }. `snapshot` is null only when even the comps
// alone don't fit, which means something is very wrong upstream.
export function fitSnapshot(input, limit = SNAPSHOT_LIMIT) {
  if (!input || typeof input !== "object") return { snapshot: null, warnings: [] };

  let snap = input;
  let len = size(snap);
  if (len === Infinity) {
    return { snapshot: null, warnings: ["snapshot: couldn't be stored (unserializable) — comps and rehab state weren't saved"] };
  }
  if (len <= limit) return { snapshot: snap, warnings: [] };

  const dropped = [];
  for (const step of STEPS) {
    const next = step.apply(snap);
    if (!next) continue;
    snap = next;
    dropped.push(step.note);
    len = size(snap);
    if (len <= limit) break;
  }

  if (len > limit) {
    return {
      snapshot: null,
      warnings: ["snapshot: too large to store even after trimming — reopening this offer won't restore the comps board"],
    };
  }
  return { snapshot: snap, warnings: [`snapshot: too large to store in full — ${dropped.join("; ")}`] };
}
