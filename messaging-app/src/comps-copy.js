// comps-copy.js — the words on the comps board. Pure, so the tooltip that
// explains a similarity score can be tested without rendering the map.

/**
 * similarityTitle(similarity, match) → string
 *
 * The chip is a single number (0–100); this is why. Each factor's share of
 * the score first — "Distance 0.4 mi — 21/25" — then the old ✓/✗ criteria
 * beneath, so the reader can see both how close and whether it passes.
 */
export function similarityTitle(s, m) {
  const lines = [];
  if (s && s.score != null) {
    lines.push(`Similarity ${s.score}/100`, "");
    for (const f of s.factors) {
      if (f.value == null) continue;
      lines.push(`${f.label}${f.detail ? ` ${f.detail}` : ""} — ${Math.round(f.weight * f.value)}/${f.weight}`);
    }
    const unknown = s.factors.filter((f) => f.value == null);
    if (unknown.length) lines.push(`Not knowable: ${unknown.map((f) => f.label.toLowerCase()).join(", ")}`);
  } else {
    lines.push("Not enough data on this comp to score it");
  }
  if (m && m.max) {
    const line = (c) => `${c.ok ? "✓" : "✗"} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`;
    lines.push("", `Criteria: ${m.score} of ${m.max} knowable`, ...m.checks.filter((c) => c.ok !== null).map(line));
  }
  return lines.join("\n");
}

// What the board actually does, said once, under the subject record and in
// the empty state. The old line described the retired county-record provider
// ("same beds/baths/county, arms-length…") long after Zillow took over.
export const COMPS_RULES = "ranked by similarity — distance first, then size, beds/baths, year built and sale date; Zillow comps are enriched with year built and lot from the listing";
