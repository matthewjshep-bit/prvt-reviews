// outreach-score.js — deterministic "likely a fixer" score for a RentCast
// sale listing. Pure function of the listing plus the pull cohort's median
// $/sqft; the UI renders the returned components verbatim, so every point
// awarded must carry a human-readable `detail` string.

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// RentCast `history` is an object keyed by ISO date ({ event, price, ... });
// tolerate arrays too. Returns price points sorted oldest → newest.
function pricePoints(history) {
  if (!history) return [];
  const entries = Array.isArray(history)
    ? history.map((h) => [h.date || h.listedDate || "", h])
    : Object.entries(history);
  return entries
    .filter(([, h]) => Number(h?.price) > 0)
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
    .map(([date, h]) => ({ date, price: Number(h.price) }));
}

export function priceCuts(listing) {
  const pts = pricePoints(listing.history);
  const current = Number(listing.price) > 0 ? { date: "9999", price: Number(listing.price) } : null;
  const seq = current ? [...pts, current] : pts;
  let count = 0;
  for (let i = 1; i < seq.length; i++) if (seq[i].price < seq[i - 1].price) count++;
  const original = seq[0]?.price || 0;
  const latest = seq[seq.length - 1]?.price || 0;
  const totalDropPct = original > latest && original > 0 ? ((original - latest) / original) * 100 : 0;
  return { count, totalDropPct };
}

export function scoreListing(listing, { medianPpsf = 0 } = {}) {
  const components = [];
  const add = (key, label, points, max, detail, na = false) =>
    components.push({ key, label, points: Math.round(points * 10) / 10, max, detail, ...(na ? { na: true } : {}) });

  const dom = Number(listing.daysOnMarket) || 0;
  if (dom > 0) add("dom", "Days on market", (Math.min(dom, 180) / 180) * 35, 35, `${dom} days on market`);
  else add("dom", "Days on market", 0, 35, "unknown", true);

  const cuts = priceCuts(listing);
  if (cuts.count > 0)
    add("cuts", "Price cuts", Math.min(25, cuts.count * 10 + cuts.totalDropPct), 25,
      `${cuts.count} cut${cuts.count > 1 ? "s" : ""}, −${cuts.totalDropPct.toFixed(1)}% from list`);
  else add("cuts", "Price cuts", 0, 25, "no price cuts");

  const yearBuilt = Number(listing.yearBuilt) || 0;
  if (yearBuilt > 1800) add("age", "Age", clamp((2000 - yearBuilt) * 0.4, 0, 20), 20, `built ${yearBuilt}`);
  else add("age", "Age", 0, 20, "year built unknown", true);

  const price = Number(listing.price) || 0;
  const sqft = Number(listing.squareFootage) || 0;
  if (price > 0 && sqft > 0 && medianPpsf > 0) {
    const ppsf = price / sqft;
    add("ppsf", "Cheap $/sqft", clamp((1 - ppsf / medianPpsf) * 50, 0, 20), 20,
      `$${Math.round(ppsf)}/sqft vs $${Math.round(medianPpsf)} median`);
  } else add("ppsf", "Cheap $/sqft", 0, 20, "sqft or median unavailable", true);

  const score = Math.round(components.reduce((s, c) => s + c.points, 0));
  return { score: clamp(score, 0, 100), components };
}

export function medianPricePerSqft(listings) {
  const vals = listings
    .map((l) => (Number(l.price) > 0 && Number(l.squareFootage) > 0 ? Number(l.price) / Number(l.squareFootage) : 0))
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  if (!vals.length) return 0;
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}
