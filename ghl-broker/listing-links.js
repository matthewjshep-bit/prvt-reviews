// listing-links.js — a listing link texted in is an address.
//
// Agents answer "what have you got?" with a share link as often as with an
// address: redf.in/3ckOYn, a zillow.com/homedetails URL, a realtor.com page.
// The model reading that text sees a URL and no house, so propertyAddress came
// back empty and nothing downstream — the subject property, the underwrite,
// the follow-up — ever started.
//
// The address is almost always IN the URL. Every big portal puts a slug of it
// in the path, and a short link is one redirect away from that path. So this
// reads URLs, not pages: Redfin answers a server fetch of the listing itself
// with a 403, but its redirect to the listing is free and carries everything.
// Only when the path has no address does it read the page, and then only the
// structured-data fields a portal publishes for search engines.

import { stateAbbr } from "./shared/us-address.js";

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

export const MAX_LINKS = 3;
const HOP_TIMEOUT_MS = 8000;
const MAX_HOPS = 5;
const MAX_HTML = 400_000;

// Bare hosts too: "zillow.com/homedetails/…" pasted without the scheme is how
// a link looks after a phone's share sheet has been through a copy/paste.
const URL_RE =
  /\bhttps?:\/\/[^\s<>"'()\]]+|\b(?:www\.)?(?:redf\.in|zillow\.com|redfin\.com|realtor\.com|trulia\.com|homes\.com)\/[^\s<>"'()\]]+/gi;

// Written back into the message beside the link. The next reader — the
// underwriter, handed the draft's inbound text — takes the address from here
// instead of fetching the link again.
const MARKER_RE = /\[listing link → ([^\]\n]{5,200})\]/g;

export function findUrls(text) {
  const out = [];
  for (const m of String(text || "").matchAll(URL_RE)) {
    let u = m[0].replace(/[.,;:!?]+$/, "");
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    try { out.push(new URL(u).href); } catch { /* not a URL after all */ }
  }
  return [...new Set(out)];
}

/* ---------- reading an address out of a path ---------- */

const DIRS = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw", "north", "south", "east", "west", "northeast", "northwest", "southeast", "southwest"]);
const SUFFIXES = new Set([
  "st", "street", "ave", "avenue", "av", "rd", "road", "dr", "drive", "ln", "lane", "way", "ct", "court",
  "pl", "place", "blvd", "boulevard", "ter", "terrace", "cir", "circle", "loop", "hwy", "highway",
  "pkwy", "parkway", "trl", "trail", "sq", "square", "expy", "plz", "plaza", "aly", "alley", "xing",
]);
const UNIT_WORDS = new Set(["apt", "unit", "ste", "suite", "#"]);

const tokens = (slug) => {
  let s = String(slug || "");
  try { s = decodeURIComponent(s); } catch { /* keep it raw */ }
  return s.split(/[-_+\s]+/).filter(Boolean);
};

// Trulia and Homes.com lowercase the whole slug. Put the capitals back so the
// address reads like one on the contact record and in the letter.
const tidyWord = (w) => {
  const k = w.toLowerCase();
  if (DIRS.has(k) && k.length <= 2) return k.toUpperCase();
  if (/^\d+(st|nd|rd|th)$/.test(k)) return k;
  if (/\d/.test(k)) return w.toUpperCase();
  return k.charAt(0).toUpperCase() + k.slice(1);
};
const tidy = (words) => (words.some((w) => /[A-Z]/.test(w)) ? words : words.map(tidyWord));

// "10625 SE 304th Way Auburn" → street and city. A run-on slug has no comma to
// say where the street ends, so cut after the LAST street suffix that still
// leaves a city behind (which is what keeps "Federal Way" a city), plus a
// trailing directional ("Riverview Way E") and a unit.
function splitStreetCity(words) {
  let cut = -1;
  for (let i = 1; i < words.length - 1; i++) if (SUFFIXES.has(words[i].toLowerCase())) cut = i;
  if (cut < 0) return null;
  let end = cut;
  if (end + 2 < words.length && DIRS.has(words[end + 1].toLowerCase())) end++;
  if (end + 3 < words.length && UNIT_WORDS.has(words[end + 1].toLowerCase())) end += 2;
  return { street: words.slice(0, end + 1).join(" "), city: words.slice(end + 1).join(" ") };
}

// "<street words>-<city words>-<ST>[-<ZIP>]" — Zillow, Trulia, Homes.com and
// most brokerage sites. Without a comma the geocoder has its own rung for
// putting one before the city, so an uncuttable slug is still usable.
export function addressFromRunOnSlug(slug) {
  const t = tidy(tokens(slug));
  let zip = "";
  if (/^\d{5}$/.test(t[t.length - 1] || "")) zip = t.pop();
  const st = t.length && /^[A-Za-z]{2}$/.test(t[t.length - 1]) ? stateAbbr(t[t.length - 1]) : "";
  if (!st) return "";
  t.pop();
  if (t.length < 3 || !/^\d+[A-Za-z]?$/.test(t[0])) return "";
  const tail = `${st}${zip ? ` ${zip}` : ""}`;
  const s = splitStreetCity(t);
  return s ? `${s.street}, ${s.city}, ${tail}` : `${t.join(" ")}, ${tail}`;
}

// /WA/Auburn/10625-SE-304th-Way-98092/home/406999, optionally /unit-2/ before home.
function fromRedfin(u) {
  const p = u.pathname.split("/").filter(Boolean);
  const home = p.indexOf("home");
  if (home < 3) return "";
  const st = stateAbbr(p[0]);
  if (!st) return "";
  const t = tidy(tokens(p[2]));
  const zip = /^\d{5}$/.test(t[t.length - 1] || "") ? t.pop() : "";
  if (t.length < 2 || !/^\d/.test(t[0])) return "";
  const unit = /^unit-/i.test(p[3] || "") ? ` #${p[3].slice(5)}` : "";
  return `${t.join(" ")}${unit}, ${tidy(tokens(p[1])).join(" ")}, ${st}${zip ? ` ${zip}` : ""}`;
}

// /realestateandhomes-detail/10625-SE-304th-Way_Auburn_WA_98092_M12345-67890
function fromRealtor(u) {
  const m = u.pathname.match(/\/realestateandhomes-detail\/([^/]+)/i);
  if (!m) return "";
  let raw = m[1];
  try { raw = decodeURIComponent(raw); } catch { /* raw */ }
  const [street, city, stRaw, zip] = raw.split("_");
  const st = stateAbbr(stRaw);
  if (!st || !/^\d{5}$/.test(zip || "") || !/^\d/.test(street || "")) return "";
  return `${tidy(tokens(street)).join(" ")}, ${tidy(tokens(city)).join(" ")}, ${st} ${zip}`;
}

const site = (host) => {
  const h = host.replace(/^www\./, "");
  if (h === "redf.in" || h.endsWith("redfin.com")) return "redfin";
  if (h.endsWith("zillow.com")) return "zillow";
  if (h.endsWith("realtor.com")) return "realtor.com";
  if (h.endsWith("trulia.com")) return "trulia";
  if (h.endsWith("homes.com")) return "homes.com";
  return h;
};

export function addressFromListingUrl(href) {
  let u;
  try { u = new URL(href); } catch { return ""; }
  const s = site(u.hostname);
  if (s === "redfin") return fromRedfin(u);
  if (s === "realtor.com") return fromRealtor(u);
  if (s === "zillow") {
    const m = u.pathname.match(/\/homedetails\/([^/]+)/i);
    return m ? addressFromRunOnSlug(m[1]) : "";
  }
  // Everyone else: the path segment that parses. Trulia and Homes.com tack an
  // id onto the slug ("…-wa-98092--2084431234"), which comes off first.
  for (const seg of u.pathname.split("/").filter(Boolean).reverse()) {
    const a = addressFromRunOnSlug(seg.replace(/--\d+$/, "").replace(/-(\d{5})-\d{6,}$/, "-$1"));
    if (a) return a;
  }
  return "";
}

// Structured data first (schema.org PostalAddress, which every portal ships
// for search), then an og:title that reads like an address.
export function addressFromHtml(html) {
  const s = String(html || "").slice(0, MAX_HTML);
  const field = (k) => (s.match(new RegExp(`"${k}"\\s*:\\s*"([^"]{1,120})"`)) || [])[1] || "";
  const street = field("streetAddress");
  const city = field("addressLocality");
  const st = stateAbbr(field("addressRegion"));
  if (street && /^\d/.test(street) && city && st) {
    const zip = field("postalCode").match(/^\d{5}/)?.[0] || "";
    return `${street}, ${city}, ${st}${zip ? ` ${zip}` : ""}`;
  }
  const og = (s.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) || [])[1] || "";
  const m = og.match(/(\d+[A-Za-z]?\s[^,|]{3,60}),\s*([A-Za-z .'-]{2,40}),\s*([A-Za-z]{2})\b\s*(\d{5})?/);
  if (m && stateAbbr(m[3])) return `${m[1].trim()}, ${m[2].trim()}, ${stateAbbr(m[3])}${m[4] ? ` ${m[4]}` : ""}`;
  return "";
}

/* ---------- following a link ---------- */

// Links arrive from strangers' phones and the broker fetches them, so nothing
// that names a machine on a private network gets a request.
function isPublicHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return false;
  if (/^(127|10|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  if (h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return false;
  return h.includes(".");
}

/**
 * resolveListingLink(href) → { url, resolvedUrl, address, source } | null
 *
 * Follows redirects by hand, reading each hop's URL for an address before
 * spending another request. Never throws: a dead link is "no address here".
 */
export async function resolveListingLink(href, { fetchImpl = fetch, timeoutMs = HOP_TIMEOUT_MS, maxHops = MAX_HOPS } = {}) {
  let url = href;
  for (let hop = 0; hop <= maxHops; hop++) {
    let u;
    try { u = new URL(url); } catch { return null; }
    if (!/^https?:$/.test(u.protocol) || !isPublicHost(u.hostname)) return null;
    const address = addressFromListingUrl(url);
    if (address) return { url: href, resolvedUrl: url, address, source: site(u.hostname) };
    if (hop === maxHops) return null;

    let r;
    try {
      r = await fetchImpl(url, {
        redirect: "manual",
        headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return null;
    }
    const location = r.headers?.get?.("location");
    if (r.status >= 300 && r.status < 400 && location) {
      try { url = new URL(location, url).href; } catch { return null; }
      continue;
    }
    if (r.ok && /html/i.test(r.headers?.get?.("content-type") || "")) {
      const fromPage = addressFromHtml(await r.text().catch(() => ""));
      if (fromPage) return { url: href, resolvedUrl: url, address: fromPage, source: site(u.hostname) };
    }
    return null;
  }
  return null;
}

/**
 * expandListingLinks(text) → { text, links }
 *
 * Resolves up to MAX_LINKS links in the text and appends one
 * "[listing link → address]" line per address found, so every later reader
 * of the message sees a house instead of a URL. Text with no links comes back
 * untouched and costs nothing. A text that already carries markers is read
 * from them, without fetching.
 */
export async function expandListingLinks(text, { resolve = resolveListingLink, ...opts } = {}) {
  const raw = String(text || "");
  const marked = [...raw.matchAll(MARKER_RE)].map((m) => ({ url: "", resolvedUrl: "", address: m[1].trim(), source: "link" }));
  if (marked.length) return { text: raw, links: marked };
  const urls = findUrls(raw).slice(0, MAX_LINKS);
  if (!urls.length) return { text: raw, links: [] };
  const links = (await Promise.all(urls.map((u) => resolve(u, opts).catch(() => null)))).filter(Boolean);
  if (!links.length) return { text: raw, links: [] };
  const lines = [...new Set(links.map((l) => l.address))].map((a) => `[listing link → ${a}]`);
  return { text: `${raw.trim()}\n${lines.join("\n")}`, links };
}
