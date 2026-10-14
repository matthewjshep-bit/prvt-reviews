// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// mentioned-houses.js — every house an agent names in a text, kept.
//
// 2026-10-13: a listing agent we'd passed on (the house from our first text)
// wrote back with two more of theirs, one on a street in town and a triplex on
// another, each with a price and no number. No
// house numbers. The reply agent took the empty address to mean the
// first-text house, its qualify step had already passed on that one, and
// the canned "keep me in mind" line went out. Neither house was kept, and
// nobody asked where they are.
//
// So: every house in their text is a row of its own, address or not; a house
// with no number makes the reply ask for it and starts the address chase;
// and talk of a house that isn't the first-text one is never read as more
// talk about it.
//
// Pure. The reply agent (ghl-broker/reply-agent.js) writes `house_mentioned`
// events from it.

import { parseUsAddress, normalizeUsAddress } from "./us-address.js";

const SUFFIX = "St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Way|Pl|Place|Ct|Court|Blvd|Boulevard|Hwy|Highway|Ter|Terrace|Cir|Circle|Pkwy|Parkway|Loop|Trl|Trail";
const SUFFIX_RX = new RegExp(`\\b(?:${SUFFIX})\\.?$`, "i");
// "one on Pine St in Shelton", "a triplex in Alder Street", "1412 Pine St".
// The street name must start with a capital or be a numbered street, so
// "on my way" and "down the road" stay prose.
const MENTION_RX = new RegExp(
  `(?:\\b(\\d{1,6}[A-Za-z]?)\\s+)?` +
  `\\b((?:[NSEW]\\.?\\s+)?(?:[A-Z][A-Za-z'-]*|\\d+(?:st|nd|rd|th))(?:\\s+[A-Z][A-Za-z'-]*){0,2})` +
  `\\s+(${SUFFIX})\\b\\.?` +
  `(?:\\s*,?\\s+(?:in\\s+)?([A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?))?`,
  "g",
);
// Words that open a sentence but are never part of a street name.
const NOT_A_NAME = /^(?:The|This|That|A|An|It|Its|One|Another|And|But|On|In|At|Off|Hey|Hi|Matt|I|We|My|Our|Your)$/;
// Capitalised words that follow a street but aren't a city.
const NOT_A_CITY = /^(?:Asking|Listed|Two|Three|Four|Older|Single|Seller|Built|It|And|But|The|With)\b/;

const MAX_HOUSES = 5;

// What a text about their houses reads as. A "the one on Pine St sold" is
// a rejection or a status, not a lead, so nothing is kept or asked for then.
export const HOUSE_LEAD_INTENTS = new Set(["deal_available", "new_property", "investor_open", "media", "wants_call", "scheduling"]);
// "1200 Main St, Suite 300": an office in a signature, not a house.
const OFFICE_AFTER = /^\s*,?\s*(?:Suite|Ste\.?|Unit|Floor|Fl\.?|#)\s*\w/i;

/** streetKey(address) → "pine st" — the street with no number, unit or city; "" when it isn't a street. */
export function streetKey(address = "") {
  const p = parseUsAddress(String(address || ""));
  const street = String(p.street || "").trim();
  if (!street || !SUFFIX_RX.test(street)) return "";
  return normalizeUsAddress(`1 ${street}`).toLowerCase().replace(/^1\s+/, "").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

/** hasHouseNumber(address) → true when there's a number to underwrite on. */
export function hasHouseNumber(address = "") {
  const p = parseUsAddress(String(address || ""));
  return Boolean(p.houseNo && p.street);
}

/**
 * normalizeMentionedHouses(raw) → [{ address, sellerAsk, note }]
 *
 * The model's `houses` list, cleaned: an entry needs a street, at most five.
 */
export function normalizeMentionedHouses(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const h of raw) {
    const address = String(h?.address || "").replace(/\s+/g, " ").trim().slice(0, 160);
    if (!address || !streetKey(address)) continue;
    out.push({
      address,
      sellerAsk: Math.max(0, Math.round(Number(h?.sellerAsk) || 0)),
      note: String(h?.note || "").replace(/\s+/g, " ").trim().slice(0, 120),
      from: "model",
    });
    if (out.length >= MAX_HOUSES) break;
  }
  return out;
}

/**
 * streetMentions(text) → [{ address, sellerAsk: 0, note: "" }]
 *
 * The streets in their own words, for when the model's list comes back
 * short: "one on Pine St in Shelton" → "Pine St, Shelton".
 */
export function streetMentions(text = "") {
  const out = [];
  const seen = new Set();
  const t = String(text || "");
  for (const m of t.matchAll(MENTION_RX)) {
    // What follows the street's suffix, city capture included.
    const suffixEnd = m[0].indexOf(m[3], (m[1] || "").length + m[2].length) + m[3].length;
    if (OFFICE_AFTER.test(`${m[0].slice(suffixEnd).replace(/^\./, "")}${t.slice(m.index + m[0].length)}`)) continue;
    const words = m[2].split(/\s+/);
    while (words.length && NOT_A_NAME.test(words[0])) words.shift();
    if (!words.length) continue;
    const street = `${words.join(" ")} ${m[3]}`;
    const city = m[4] && !NOT_A_CITY.test(m[4]) ? m[4] : "";
    const address = [m[1] ? `${m[1]} ${street}` : street, city].filter(Boolean).join(", ");
    const key = streetKey(address);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ address, sellerAsk: 0, note: "", from: "text" });
    if (out.length >= MAX_HOUSES) break;
  }
  return out;
}

/**
 * housesInText({ houses, message, except }) → [{ address, sellerAsk, note, from, needsAddress }]
 *
 * The model's list, plus any street in their text it missed, one per
 * street, leaving out the houses in `except` (the first-text house). A
 * numbered address for a street wins over the bare street name. `from` is
 * "model" when the model listed it, "text" when only our regex saw it.
 */
export function housesInText({ houses = [], message = "", except = [] } = {}) {
  const skip = new Set((except || []).map(streetKey).filter(Boolean));
  const byStreet = new Map();
  for (const h of [...normalizeMentionedHouses(houses), ...streetMentions(message)]) {
    const key = streetKey(h.address);
    if (!key || skip.has(key)) continue;
    const had = byStreet.get(key);
    if (!had) { byStreet.set(key, h); continue; }
    if (!hasHouseNumber(had.address) && hasHouseNumber(h.address)) {
      byStreet.set(key, { ...h, sellerAsk: h.sellerAsk || had.sellerAsk, note: h.note || had.note, from: had.from === "model" ? "model" : h.from });
    }
  }
  return [...byStreet.values()].slice(0, MAX_HOUSES).map((h) => ({ ...h, needsAddress: !hasHouseNumber(h.address) }));
}

// "Pine St, Shelton" → "Pine St". How the house reads in a text.
const streetLabel = (address) => {
  const p = parseUsAddress(String(address || ""));
  return normalizeUsAddress(`1 ${p.street}`).replace(/^1\s+/, "") || String(address || "").split(",")[0].trim();
};
const joinAnd = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** addressAsk(houses) → the one sentence that asks where they are. */
export function addressAsk(houses = []) {
  const labels = houses.map((h) => `the ${streetLabel(h.address)} one`);
  if (!labels.length) return "";
  return labels.length === 1
    ? `What's the exact address on ${labels[0]}? I'll take a look.`
    : `What are the exact addresses on ${joinAnd(labels)}? I'll take a look at each.`;
}

/** asksForAddress(reply) → true when the reply already asks where it is. */
export function asksForAddress(reply = "") {
  return /\baddress(?:es)?\b|\bwhere\s+(?:is|are)\s+(?:it|they|those|these|the)\b/i.test(String(reply || ""));
}

/** addressHint(houses) → "Pine St, Shelton (asking 410K, rambler); Alder Street (…)" for the chase. */
export function addressHint(houses = []) {
  return houses.map((h) => {
    const bits = [h.sellerAsk ? `asking ${Math.round(h.sellerAsk / 1000)}K` : "", h.note].filter(Boolean);
    return bits.length ? `${h.address} (${bits.join(", ")})` : h.address;
  }).join("; ").slice(0, 300);
}

const OPEN_DAYS = 60;

/**
 * housesAwaitingAddress({ events, offers, now }) → [{ address, sellerAsk, note, at }]
 *
 * Houses they named in the last 60 days that we still have no number for:
 * no later mention of the same street with one, and no offer on it. What
 * the reply's context lists, so a later "it's 1412" lands on the right house.
 */
export function housesAwaitingAddress({ events = [], offers = [], now = Date.now() } = {}) {
  const since = now - OPEN_DAYS * 86400000;
  const numbered = new Set();
  for (const o of offers || []) if (o?.address && hasHouseNumber(o.address)) numbered.add(streetKey(o.address));
  for (const e of events || []) {
    if (e?.type === "house_mentioned" && e.address && hasHouseNumber(e.address)) numbered.add(streetKey(e.address));
  }
  const open = new Map();
  for (const e of [...(events || [])].sort((a, b) => String(a?.at || "").localeCompare(String(b?.at || "")))) {
    if (e?.type !== "house_mentioned" || !e.address || hasHouseNumber(e.address)) continue;
    if ((Date.parse(e.at || "") || 0) < since) continue;
    const key = streetKey(e.address);
    if (!key || numbered.has(key)) continue;
    open.set(key, { address: e.address, sellerAsk: Number(e.data?.sellerAsk) || 0, note: String(e.data?.note || ""), at: e.at });
  }
  return [...open.values()];
}
