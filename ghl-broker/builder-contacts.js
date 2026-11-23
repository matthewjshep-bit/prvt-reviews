// builder-contacts.js — the builder's own number, not the agent's (Matt,
// 2026-11-23: "we want the builder who bought it, not the agent who helped
// them"). The method's P1 and P3, automated:
//
//   1. the listing names the builder → the WA contractor registry (L&I, free)
//      has the company's phone and its principal;
//   2. no name → the county's sale record names the entity that sold the new
//      build (or bought the lot): a real builder company is in the registry;
//      a one-off LLC ("8458 DEV LLC") isn't, so its mailing address goes to the
//      skip trace, which finds the person behind it (5 credits).
//
// Pure over `fetch`: every call is injectable, and nothing here writes.

import { phonesFromTrace, reachable, e164 } from "./shared/lot-finder.js";

const LNI_URL = "https://data.wa.gov/resource/m8qx-ubtq.json";
const KC_SALES_URL = "https://gismaps.kingcounty.gov/arcgis/rest/services/Property/KingCo_PropertyInfo/MapServer/3/query";
const TRACE_URL = "https://tracerfy.com/v1/api/trace/lookup/";
export const ENTITY_RX = /\b(?:LLC|L\.L\.C|INC|CORP|CO|LP|LLP|HOMES|HOME|BUILDERS?|CONSTRUCTION|CONSTR|DEVELOPMENT|DEVELOPMENTS|DEV|PROPERTIES|GROUP|PARTNERS|VENTURES|ENTERPRISES|TRUST)\b/i;

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const titleCase = (s) => clean(s).toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bLlc\b/g, "LLC").replace(/\bInc\b/g, "Inc");
// The name the registry would know: no suffix, no punctuation.
export const registryName = (s) => clean(s).toUpperCase().replace(/[.,'"]/g, "").replace(/\b(?:LLC|L L C|INC|CORP|CO|LP|LLP)\b/g, "").replace(/\s+/g, " ").trim();
// The street as the county writes it: "8458 NE 9th Street" → "8458 NE 9TH".
export const countyStreetPrefix = (address = "") => {
  const st = clean(String(address).split(",")[0]).toUpperCase().replace(/[.#]/g, "");
  const m = st.match(/^(\d+[A-Z]?)\s+([A-Z]{1,2}\s+)?(\d+(?:ST|ND|RD|TH)?|[A-Z]+)/);
  return m ? m[0] : st;
};
const isEntity = (s) => ENTITY_RX.test(clean(s));

/** lniLookup(name, fetchFn) → { entity, phone, principal, city } | null — the registry's best row for a company name. */
export async function lniLookup(name, fetchFn = fetch) {
  const want = registryName(name);
  if (want.length < 4) return null;
  const where = `upper(businessname) like '%${want.replace(/'/g, "''")}%'`;
  const r = await fetchFn(`${LNI_URL}?$where=${encodeURIComponent(where)}&$limit=10`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => []);
  const scored = (Array.isArray(rows) ? rows : [])
    .filter((x) => e164(x.phonenumber))
    .map((x) => ({ x, score: (/active/i.test(String(x.contractorlicensestatus || x.statuscode || "")) ? 2 : 0) + (registryName(x.businessname) === want ? 1 : 0) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0]?.x;
  if (!best) return null;
  return { entity: titleCase(best.businessname), phone: e164(best.phonenumber), principal: titleCase(best.primaryprincipalname), city: titleCase(best.city), source: "lni" };
}

/**
 * countyEntities(address, fetchFn) → [{ name, mail, role: "seller" | "buyer", price, date }]
 * The entities on the house's sales in the county's last-3-years layer:
 * the one that sold the new build, the one that bought the lot.
 */
export async function countyEntities(address, fetchFn = fetch) {
  const prefix = countyStreetPrefix(address);
  if (!/^\d/.test(prefix)) return [];
  const where = `upper(address) LIKE '${prefix.replace(/'/g, "''")}%'`;
  const url = `${KC_SALES_URL}?where=${encodeURIComponent(where)}&outFields=address,SaleDate,SalePrice,Sellername,selleradd1,selleradd2,buyername,buyeradd1,buyeradd2&returnGeometry=false&f=json`;
  const r = await fetchFn(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) return [];
  const j = await r.json().catch(() => ({}));
  const out = [];
  for (const f of j.features || []) {
    const a = f.attributes || {};
    const date = a.SaleDate ? new Date(Number(a.SaleDate)).toISOString().slice(0, 10) : "";
    if (isEntity(a.Sellername)) out.push({ name: clean(a.Sellername), mail: clean(`${a.selleradd1 || ""} ${a.selleradd2 || ""}`), role: "seller", price: Number(a.SalePrice) || 0, date });
    if (isEntity(a.buyername)) out.push({ name: clean(a.buyername), mail: clean(`${a.buyeradd1 || ""} ${a.buyeradd2 || ""}`), role: "buyer", price: Number(a.SalePrice) || 0, date });
  }
  // The seller of the biggest sale first: that's the builder's exit.
  return out.sort((a, b) => (b.role === "seller") - (a.role === "seller") || b.price - a.price);
}

/** traceEntity({ name, mail }, apiKey, fetchFn) → { entity, phone, principal } | null — the person behind a one-off LLC, by its mailing address. */
export async function traceEntity({ name, mail }, apiKey, fetchFn = fetch) {
  const m = clean(mail).match(/^(.+?)\s+([A-Z][A-Za-z .]+?)\s+([A-Z]{2})\s+(\d{5})/);
  if (!m || !apiKey) return null;
  const body = { address: m[1], city: m[2], state: m[3], zip: m[4], find_owner: true };
  const r = await fetchFn(TRACE_URL, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json", "User-Agent": "shep-flips-lot-finder" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (!r.ok) return null;
  const j = await r.json().catch(() => ({}));
  const result = Array.isArray(j) ? j[0] || {} : j || {};
  const phone = reachable(phonesFromTrace(result))[0]?.number || "";
  if (!phone) return { entity: titleCase(name), phone: "", principal: "", source: "trace", credits: Number(result.credits_deducted) || 0 };
  const p = (result.persons || []).find((x) => (x.phones || []).some((ph) => e164(ph?.number) === phone)) || result.persons?.[0] || {};
  return { entity: titleCase(name), phone, principal: titleCase(`${p.first_name || ""} ${p.last_name || ""}`), source: "trace", credits: Number(result.credits_deducted) || 0 };
}

/**
 * resolveBuilderContact({ address, builderName, traceKey, allowTrace, fetchFn }) →
 *   { entity, phone, principal, source, exit? } | null
 *
 * By name first (free), then by the county's entity (free when the registry
 * knows it), then the skip trace on the entity's mailing address when
 * `allowTrace` (money). `exit` is the county's own record of the builder's
 * sale when it has one: the real exit, not a homeowner's later resale.
 */
export async function resolveBuilderContact({ address, builderName = "", traceKey = "", allowTrace = false, fetchFn = fetch } = {}) {
  let out = null;
  if (builderName) out = await lniLookup(builderName, fetchFn).catch(() => null);
  const entities = await countyEntities(address, fetchFn).catch(() => []);
  const exit = entities.find((e) => e.role === "seller" && e.price > 0) || null;
  if (!out) {
    for (const e of entities) {
      out = await lniLookup(e.name, fetchFn).catch(() => null);
      if (out) break;
    }
  }
  if (!out && allowTrace && entities.length) {
    const e = entities.find((x) => x.mail) || null;
    if (e) out = await traceEntity(e, traceKey, fetchFn).catch(() => null);
  }
  if (!out && entities.length) out = { entity: titleCase(entities[0].name), phone: "", principal: "", source: "county", mail: entities[0].mail };
  if (!out) return null;
  return { ...out, ...(exit ? { exit: { price: exit.price, date: exit.date } } : {}) };
}
