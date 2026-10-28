// price-bricked.js — Bricked.ai's read of a house: ARV, as-is value, repairs,
// and which of its comps it judged renovated from their photos.
//
// Matt, 2026-10-28: on a one-month trial against the county answer key
// (scripts/price-bakeoff.mjs). Our own engine guesses "renovated" from the top
// $/sqft of the Zillow ring, which is why its ARVs run high; Bricked grades each
// comp's MLS photos (is_renovated, renovation_score, C1–C6) and prices the ARV
// off the renovated ones. One call, one shape, so the bake-off and later the
// underwriter can read it without knowing whose it is.
//
// GET https://api.bricked.ai/v1/property/create?address=…  header x-api-key.
// Errors come back as { error }: 400 bad address or no comps, 401 key,
// 402 subscription lapsed, 404 not found. Each call counts against the plan.

export const BRICKED_URL = "https://api.bricked.ai/v1/property/create";
export const BRICKED_TIMEOUT_MS = 90_000;

// What we may tell it about the house. Anything else is dropped rather than
// sent: an unknown parameter is at best ignored and at worst a 400.
const OVERRIDES = ["bedrooms", "bathrooms", "squareFeet", "yearBuilt", "landUse", "propertyStatus", "timeframe", "searchRadiusMiles", "repairs"];

export function brickedRequestUrl(address, overrides = {}) {
  const u = new URL(BRICKED_URL);
  u.searchParams.set("address", String(address || "").trim());
  for (const k of OVERRIDES) {
    if (overrides[k] != null && overrides[k] !== "") u.searchParams.set(k, String(overrides[k]));
  }
  return u.toString();
}

/**
 * brickedProperty(address, { apiKey, fetch, ...overrides }) → normalizeBricked(raw)
 * Throws with `.status` on any non-2xx, carrying Bricked's own message.
 *
 * Repairs: Bricked prices repairs only from a description of the work
 * (`repairs`); without one `repairs` comes back null, not zero (2026-10-28,
 * 7034 S K St: none without, $45,859 in 17 lines with the agent's words).
 *
 * A dropped connection is tried once more (the first live call with a
 * description, 2026-10-28, failed "fetch failed" and the retry went through).
 * An answer from Bricked, or our own timeout, is not.
 */
export async function brickedProperty(address, opts = {}) {
  try {
    return await brickedOnce(address, opts);
  } catch (e) {
    if (e?.status || e?.name === "AbortError") throw e;
    return brickedOnce(address, opts);
  }
}

async function brickedOnce(address, { apiKey, fetch = globalThis.fetch, timeoutMs = BRICKED_TIMEOUT_MS, ...overrides } = {}) {
  if (!apiKey) throw new Error("Bricked: no API key");
  if (!String(address || "").trim()) throw new Error("Bricked: no address");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(brickedRequestUrl(address, overrides), { headers: { "x-api-key": apiKey, accept: "application/json" }, signal: ctl.signal });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(`Bricked ${res.status}: ${body?.error || res.statusText || "request failed"}`);
      err.status = res.status;
      throw err;
    }
    return normalizeBricked(body);
  } finally {
    clearTimeout(timer);
  }
}

const num = (x) => (x == null || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));

// The house as Bricked has it on record. Comps carry the same fields.
function house(p = {}) {
  const d = p.details || {};
  return {
    address: p.address?.fullAddress || null,
    lat: num(p.latitude), lng: num(p.longitude),
    beds: num(d.bedrooms), baths: num(d.bathrooms), sqft: num(d.squareFeet), yearBuilt: num(d.yearBuilt),
    lastSale: num(d.lastSaleAmount) ? { price: num(d.lastSaleAmount), at: num(d.lastSaleDate) } : null,
    condition: num(d.condition_rating), renovationScore: num(d.renovationScore?.score),
    listPrice: num(p.mls?.amount), listStatus: p.mls?.status || null,
  };
}

export function normalizeBricked(raw = {}) {
  return {
    id: raw.id || null,
    arv: num(raw.arv), arvConfidence: num(raw.arvConfidence), arvReasoning: raw.arvReasoning || null,
    asIs: num(raw.cmv), asIsConfidence: num(raw.cmvConfidence), asIsReasoning: raw.cmvReasoning || null,
    repairs: num(raw.totalRepairCost),
    repairLines: (raw.repairs || []).map((r) => ({ repair: r.repair, cost: num(r.cost) })),
    subject: house(raw.property),
    comps: (raw.comps || []).map((c) => ({
      ...house(c),
      use: c.compType || null, selected: !!c.selected,
      adjustedValue: num(c.adjusted_value),
      renovated: c.is_renovated ?? null, renovationScore: num(c.renovation_score), renovationConfidence: num(c.renovation_confidence),
      condition: num(c.condition_rating),
    })),
    links: { share: raw.shareLink || null, dashboard: raw.dashboardLink || null },
  };
}
