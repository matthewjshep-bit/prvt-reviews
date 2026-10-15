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
import { WA_CITY_COORDS } from "./wa-city-coords.js";

const SUFFIX = "St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Way|Pl|Place|Ct|Court|Blvd|Boulevard|Hwy|Highway|Ter|Terrace|Cir|Circle|Pkwy|Parkway|Loop|Trl|Trail";
const SUFFIX_RX = new RegExp(`\\b(?:${SUFFIX})\\.?$`, "i");
const SUFFIX_WORD_RX = new RegExp(`^(?:${SUFFIX})$`, "i");
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
    if (!address || !streetKey(address) || isTownStreet(address)) continue;
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
    if (!key || seen.has(key) || isTownStreet(address)) continue;
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
 *
 * Then the houses they named with no street at all (areaMentions: "some
 * Stanwood houses", "his flips"), each with `address: ""` and a `label`
 * the ask names it by. A town the first-text house is in only counts when
 * they said "another" or "more"; a town a street above already covers is
 * that house, not another.
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
  const streets = [...byStreet.values()].map((h) => ({ ...h, needsAddress: !hasHouseNumber(h.address) }));
  const exceptTowns = new Set((except || []).map(townIn).filter(Boolean));
  const streetTowns = new Set(streets.map((h) => townIn(h.address)).filter(Boolean));
  const areas = new Map();
  for (const h of [...areaMentions(message), ...modelAreas(houses)]) {
    const town = String(h.town || "").toLowerCase();
    if (town && streetTowns.has(town)) continue;
    if (town && exceptTowns.has(town) && !h.another) continue;
    const key = town || h.label.toLowerCase();
    const had = areas.get(key);
    if (had) { areas.set(key, { ...had, sellerAsk: had.sellerAsk || h.sellerAsk, note: had.note || h.note }); continue; }
    areas.set(key, h);
  }
  const named = [...areas.values()].map(({ another, town, ...h }) => ({ ...h, ...(town ? { town } : {}), needsAddress: true }));
  return [...streets, ...named].slice(0, MAX_HOUSES);
}

/* ---------- houses named with no street (2026-10-14) ---------- */

// "I got one in Medina. I got 2 in Stanwood", "a Federal Way duplex coming
// up", "two more parcels next to" a listing, "he wants to sell his flips":
// leads with no street to put a number on. Each is kept by what they called
// it, and the ask names it the same way ("the Stanwood ones").

// Towns we work, from the buyer map, plus a few it has no pin for.
const EXTRA_TOWNS = ["west seattle", "white center", "anacortes", "burlington", "lynden", "blaine", "sequim", "port angeles",
  "port townsend", "chehalis", "aberdeen", "hoquiam", "ellensburg", "wenatchee", "longview", "kelso", "camas", "kingston",
  "hansville", "port ludlow", "hoodsport", "lilliwaup", "mccleary", "montesano", "seahurst", "lake hills", "south hill"];
const TOWNS = [...new Set([...Object.keys(WA_CITY_COORDS).map((s) => s.replace(/-/g, " ")), ...EXTRA_TOWNS])]
  .sort((a, b) => b.length - a.length);
const TOWN = `(?:${TOWNS.map((t) => t.replace(/ /g, "\\s+")).join("|")})`;
// Town names that are ordinary words too: only when they're written as a name.
const COMMON_WORD_TOWNS = new Set(["union", "index", "pacific", "concrete", "roy", "preston", "medina", "milton", "graham", "elbe", "kent", "buckley", "fife", "brier", "anderson island", "ruston"]);
const TOWN_RX = new RegExp(`\\b${TOWN}\\b`, "i");
const TOWN_SET = new Set(TOWNS);
// "a Federal Way duplex": a town whose name ends like a street, with no number, is the town.
function isTownStreet(address = "") {
  if (hasHouseNumber(address)) return false;
  return TOWN_SET.has(String(address || "").split(",")[0].replace(/\s+/g, " ").trim().toLowerCase());
}
const titleCase = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());
const isTown = (raw) => {
  const t = String(raw || "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (COMMON_WORD_TOWNS.has(t.toLowerCase()) && !/^[A-Z]/.test(t)) return false;
  return true;
};

/** townIn(text) → "shelton" — the first town we know in an address or phrase; "" when none. */
export function townIn(text = "") {
  const m = TOWN_RX.exec(String(text || ""));
  return m && isTown(m[0]) ? m[0].replace(/\s+/g, " ").toLowerCase() : "";
}

const NOUN = "(?:houses?|homes?|propert(?:y|ies)|places?|listings?|fixer(?:-upper)?s?|fix-?flips?|flips?|lots?|parcels?|duplex(?:es)?|triplex(?:es)?|fourplex(?:es)?|4-?plex(?:es)?|ramblers?|rentals?|deals?|ones?|projects?|tear-?downs?|cottages?|cabins?|acreage|land)";
const NOUN_RX = new RegExp(`\\b${NOUN}\\b`, "i");
const PLURAL_RX = /(?:s|es|ies)$/i;
// Words that mean they have it: "I've got", "there's another", "just listed".
const LEAD = "(?:have|has|got|know\\s+of|knows\\s+of|there's|there\\s+is|there\\s+are|that's\\s+another|listing|listed|list|bringing|working\\s+on)";
const DET = "(?:a|an|another|one|two|three|four|five|[1-9]|some|several|a\\s+few|a\\s+couple(?:\\s+of)?|couple(?:\\s+of)?|few|more|other)";
// More than one, or not the one we're on: enough on its own.
const STRONG_DET = /^(?:another|two|three|four|five|[2-9]|\d{2}|some|several|a\s+few|a\s+couple(?:\s+of)?|couple(?:\s+of)?|few|more|other)$/i;
const ANOTHER_DET = /^(?:another|more|other)$/i;
const MANY_DET = /^(?:two|three|four|five|[2-9]|\d{2}|some|several|a\s+few|a\s+couple(?:\s+of)?|couple(?:\s+of)?|few|more)$/i;
// "I have another listing in Tacoma", "got 2 in Stanwood", "a new fixer going on in Poulsbo".
const IN_TOWN_RX = new RegExp(`\\b${LEAD}\\s+(?:(?:also|still|just|got)\\s+)?(${DET})\\b([^.!?\\n]{0,60}?)\\s(?:in|up\\s+in|down\\s+in|out\\s+in|over\\s+in|near|around)\\s+(?:the\\s+)?(${TOWN})\\b`, "gi");
// "some Stanwood houses", "a Federal Way duplex", "an Issaquah property".
const TOWN_NOUN_RX = new RegExp(`\\b(${DET})\\s+(?:[a-z]+\\s+)?(${TOWN})\\s+(${NOUN})\\b`, "gi");
// "two more parcels next to 5206 W Werner Rd".
const NEXT_TO_RX = new RegExp(
  `\\b(two|three|four|\\d|more|other|additional|extra|a\\s+couple(?:\\s+of)?|couple(?:\\s+of)?|some|the)\\s+(?:more\\s+)?(?:[a-z]+\\s+)?(parcels|lots|houses|homes|properties|ones)\\s+` +
  `(?:right\\s+)?(?:next\\s+to|next\\s+door\\s+to|beside|adjacent\\s+to|behind|across\\s+from)\\s+` +
  `(\\d{1,6}\\s+(?:[NSEW]\\.?\\s+)?[A-Za-z0-9]+(?:\\s+[A-Za-z]+){0,2}?\\s+(?:${SUFFIX}))\\b`, "gi");
// "he wants to sell his flips", "the owner's nearly finished flips".
const THEIR_FLIPS_RX = /\b(?:his|her|their|the owner's|the seller's|my client's|my seller's|my friend's)\s+((?:[a-z-]+\s+){0,3}?)(fix-?flips|fix and flips|flips|rentals|properties|houses|homes)\b/gi;
// "I may have some partially completed fix-flips".
const SOME_FLIPS_RX = new RegExp(`\\b${LEAD}\\s+(?:(?:also|still|just|got)\\s+)?(some|several|a\\s+few|a\\s+couple(?:\\s+of)?)\\s+((?:[a-z-]+\\s+){0,3}?)(fix-?flips|fix and flips|flips|rentals)\\b`, "gi");
const SELL_RX = /\b(?:sell|selling|offload|unload|dump|liquidate|get rid of|let go of|part with)\b/i;
// "it's a Lacey rambler" is the house we're on, described.
const COPULA_BEFORE = /(?:\bit'?s|\bit is|\bthis is|\bthat'?s|\bthat is|\bis|\bwas|\bbe)\s+$/i;
// A tapback quotes our own text back ("Liked “…”", "👍 to “…”").
export const REACTION_RX = /^\s*(?:(?:Liked|Loved|Laughed at|Emphasized|Questioned|Disliked|Le gustó|Le encantó|Reacted)\b|\S{1,4}\s+to\s+[“"])/;
const sentences = (text) => String(text || "").split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

/**
 * areaMentions(text) → [{ address: "", area, town, label, plural, another, sellerAsk: 0, note: "", from: "text" }]
 *
 * Houses they named by town or by what they are, with no street: `area` is
 * the town ("Stanwood") or where it is ("next to 5206 W Werner Rd"), empty
 * for "his flips"; `label` is how the ask names it ("the Stanwood houses").
 */
export function areaMentions(text = "") {
  const out = [];
  const seen = new Set();
  const push = (h) => {
    const key = (h.town || h.label).toLowerCase();
    if (seen.has(key) || out.length >= MAX_HOUSES) return;
    seen.add(key);
    out.push({ address: "", area: h.area || "", ...(h.town ? { town: h.town } : {}), label: h.label, plural: Boolean(h.plural), another: Boolean(h.another), sellerAsk: 0, note: "", from: "text" });
  };
  for (const s of sentences(text)) {
    if (REACTION_RX.test(s)) continue;
    // A street in the same sentence is that house; streetMentions has it.
    if (streetMentions(s).length && !/\bnext\s+(?:door\s+)?to\b|\bbeside\b|\badjacent\b/i.test(s)) continue;
    for (const m of s.matchAll(IN_TOWN_RX)) {
      const [, det, words, rawTown] = m;
      if (!isTown(rawTown)) continue;
      const noun = (NOUN_RX.exec(words) || [])[0] || "";
      // "I have a showing in Tacoma" is not a house; "one in Medina" is.
      if (!noun && !/^(?:one|another|some|several|few|a\s+few|a\s+couple(?:\s+of)?|couple(?:\s+of)?|two|three|four|five|\d{1,2})$/i.test(det)) continue;
      const town = titleCase(rawTown);
      const plural = MANY_DET.test(det) || (noun && PLURAL_RX.test(noun) && !/^(?:one|a|an|another)$/i.test(det));
      const word = noun && !/^ones?$/i.test(noun) ? noun.toLowerCase() : (plural ? "ones" : "one");
      push({ area: town, town, label: `the ${town} ${word}`, plural, another: ANOTHER_DET.test(det) || plural });
    }
    for (const m of s.matchAll(TOWN_NOUN_RX)) {
      const [, det, rawTown, noun] = m;
      if (!isTown(rawTown)) continue;
      if (COPULA_BEFORE.test(s.slice(0, m.index))) continue;
      // "a Seattle house" alone could be anything; one they have, one coming
      // up, or more than one is a lead.
      if (!STRONG_DET.test(det) && !new RegExp(`\\b${LEAD}\\b`, "i").test(s) && !/\bcoming\s+(?:up|soon)\b|\boff[- ]market\b|\bpocket\b/i.test(s)) continue;
      const town = titleCase(rawTown);
      const plural = MANY_DET.test(det) || PLURAL_RX.test(noun);
      const word = /^ones?$/i.test(noun) ? (plural ? "ones" : "one") : noun.toLowerCase();
      push({ area: town, town, label: `the ${town} ${word}`, plural, another: ANOTHER_DET.test(det) || plural });
    }
    for (const m of s.matchAll(NEXT_TO_RX)) {
      const [, , noun, where] = m;
      const street = where.replace(/\s+/g, " ").replace(/\b([a-z])([a-z]*)/g, (w, a, b) => a.toUpperCase() + b);
      push({ area: `next to ${street}`, label: `the ${noun.toLowerCase()} next to ${street}`, plural: true, another: true });
    }
    if (SELL_RX.test(s)) {
      for (const m of s.matchAll(THEIR_FLIPS_RX)) {
        const words = `${m[1] || ""}${m[2]}`.toLowerCase().replace(/\s+/g, " ").trim();
        push({ area: "", label: `the ${words}`, plural: true, another: true });
      }
    }
    for (const m of s.matchAll(SOME_FLIPS_RX)) {
      if (/\b(?:every|per|a\s+(?:week|month|year))\b/i.test(s.slice(m.index + m[0].length, m.index + m[0].length + 20))) continue;
      const words = `${m[2] || ""}${m[3]}`.toLowerCase().replace(/\s+/g, " ").trim();
      push({ area: "", label: `the ${words}`, plural: true, another: true });
    }
  }
  return out;
}

// The model's houses with a town and no street ("Stanwood"): the same kind of lead.
function modelAreas(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const h of raw) {
    const address = String(h?.address || "").replace(/\s+/g, " ").trim().slice(0, 160);
    if (!address || hasHouseNumber(address) || (streetKey(address) && !isTownStreet(address))) continue;
    const town = townIn(address);
    if (!town) continue;
    const name = titleCase(town);
    out.push({ address: "", area: name, town: name, label: `the ${name} house`, plural: false, another: false,
      sellerAsk: Math.max(0, Math.round(Number(h?.sellerAsk) || 0)), note: String(h?.note || "").replace(/\s+/g, " ").trim().slice(0, 120), from: "model" });
    if (out.length >= MAX_HOUSES) break;
  }
  return out;
}

/* ---------- a call's words: theirs, when the transcript says whose ---------- */

/**
 * callWords(transcript) → { words, labelled }
 *
 * GHL's transcript marks each line THEM: or US: when it knows the side
 * (call-intake.js fetchTranscript). Then only their lines count; otherwise
 * the whole thing, ours included, and `labelled` is false.
 */
export function callWords(transcript = "") {
  const t = String(transcript || "");
  if (!/^\s*THEM:/im.test(t)) return { words: t, labelled: false };
  return { words: t.split(/\r?\n/).filter((l) => /^\s*THEM:/i.test(l)).map((l) => l.replace(/^\s*THEM:\s*/i, "")).join("\n"), labelled: true };
}

/**
 * saidIn(text, address) → true when their words name that house: its street
 * name ("pine" for "1412 Pine St"), or its town when it has no street. The
 * model reads both sides of a call; this keeps only the houses they said.
 */
export function saidIn(text = "", address = "") {
  const t = ` ${String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const street = String(parseUsAddress(String(address || "")).street || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ");
  const name = street.split(/\s+/).filter((w) => w && !SUFFIX_WORD_RX.test(w) && !/^(?:[nsew]|ne|nw|se|sw|north|south|east|west)$/.test(w)).join(" ");
  if (name && !isTownStreet(address)) return t.includes(` ${name} `);
  const town = townIn(address);
  return Boolean(town) && t.includes(` ${town} `);
}

/* ---------- a referral to someone else (2026-10-14) ---------- */

// "Contact <a colleague> at <a brokerage>, she has one coming up", "go
// through <my business partner>", "my husband's client wants to sell". A
// lead behind a person we don't know. Matt decides whether to reach out;
// nothing texts a stranger.

// Names are case-sensitive ("call me" is not a name), so these patterns
// carry no `i` flag: a verb that may open the sentence takes either case
// on its first letter.
const either = (phrase) => phrase.replace(/(^|\|)([a-z])/g, (_, bar, c) => `${bar}[${c.toUpperCase()}${c}]`);
const NAME_WORD = "[A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?";
const NAME = `(${NAME_WORD}(?: ${NAME_WORD})?)`;
const BROKERAGE = "((?:eXp|[A-Z][A-Za-z&'.-]*)(?: (?:[A-Z][A-Za-z&'.-]*|&|of)){0,3})";
const REL = "(?:business |buyers? broker |dispo |wholesale |team )?(?:partner|colleague|associate|teammate|team member|co-?worker|husband|wife|assistant|co-?lister|co-?listing agent)";
const REACH = either("contact|call|text|ping|reach out to|talk to|talk with|speak to|speak with|get in touch with|get ahold of|get a hold of|connect with|go through|goes through|going through");
const REACH_RX = new RegExp(`\\b(${REACH}),? (?:(${either("my")} ${REL}),? )?${NAME}(?:,? (?:at|with|from|of) ${BROKERAGE})?`, "g");
const NAME_AT_RX = new RegExp(`\\b${NAME} (?:at|with|from|of) ${BROKERAGE},? (?:has|have|will have|is listing|just listed|is about to list|has got)\\b`, "g");
const MY_REL_NAME_RX = new RegExp(`\\b(${either("my")} ${REL}),? ${NAME}|\\b${NAME},? (${either("my")} ${REL})\\b`, "g");
// What makes it a referral rather than a name in passing.
const LEAD_CUE = /\b(?:has|have|got)\s+(?:one|a|an|some|another|something|two|\d)\b|\bcoming\s+up\b|\blisting\b|\bseller\b|\boff[- ]market\b|\bpropert(?:y|ies)\b|\bhouse\b|\bhome\b|\bdeal\b|\bdetails\b|\baddress\b|\bcan\s+(?:help|assist|get\s+you)\b|\bhandles?\b|\bwants?\s+to\s+sell\b|\bbuyers?\b/i;
// "my husband's Everett client wants to sell", "one of his clients … wants to sell".
const RELATIVE_LEAD_RX = /\bmy\s+(husband|wife|partner|business partner|colleague|friend|dad|mom|father|mother|brother|sister|son|daughter|neighbor)(?:'s)?\b[^.!?\n]{0,80}?\b(clients?|friends?|neighbors?|buddy|co-?workers?)\b[^.!?\n]{0,80}?\b(?:wants?\s+to\s+sell|looking\s+to\s+sell|needs?\s+to\s+sell|has\s+to\s+sell|is\s+selling|wants\s+out)\b/i;
const FRIEND_HAS_RX = /\bmy\s+(friend|neighbor|brother|sister|dad|mom|father|mother|cousin|uncle|aunt)\s+(?:has|owns)\s+(?:a|an|one|two|some)\b[^.!?\n]{0,40}?\b(?:house|home|property|properties|lot|lots|fixer|rental|duplex|triplex)\b/i;
const PARTNER_LOOKING_RX = /\bmy\s+(wholesale|investor|dispo)\s+partners?\b[^.!?\n]{0,60}?\b(?:looking\s+for|wants\s+to\s+(?:talk|connect|work)|would\s+like\s+to)\b/i;
// Capitalised words that are never the person.
const NOT_A_PERSON = new Set(("Matt Matthew Shep Shepherd Me Us You Him Her Them It Info Information The This That Title Escrow Zillow Redfin " +
  "Realtor Realtors Seller Sellers Owner Owners Tenant Tenants Listing Agent Bank City County Today Tomorrow Tonight Now Back Anytime Anyone " +
  "Someone Somebody Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September " +
  "October November December God Jesus Text Call Email Office Team Hi Hey Thanks Thank Please Feel Free Let Our My Your Their His NWMLS MLS " +
  "Windermere Compass Coldwell Remax Sotheby Berkshire Opendoor Offerpad Google Facebook Him Mr Mrs Ms").split(/\s+/));
const PHONE_RX = /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const relLabel = (r) => clean(r).replace(/^my\s+/i, "").toLowerCase();

/**
 * referralMention(text, { self }) → null | { name, brokerage, relation, phone, phrase }
 *
 * A person they point us to for a house: a name (and their brokerage when
 * given), or for "my husband's client" no name and the relation. `self` is
 * the agent's own name, so a signature is never a referral. A tapback
 * quoting our text never is either.
 */
export function referralMention(text = "", { self = "" } = {}) {
  const selfFirst = clean(self).split(" ")[0].toLowerCase();
  const okName = (n) => {
    const words = clean(n).split(" ");
    if (!words[0] || NOT_A_PERSON.has(words[0])) return "";
    if (selfFirst && words[0].toLowerCase() === selfFirst) return "";
    return words.filter((w, i) => i === 0 || !NOT_A_PERSON.has(w)).join(" ");
  };
  const okBrokerage = (b) => {
    const t = clean(b).replace(/[.,]$/, "");
    return t && !(NOT_A_PERSON.has(t.split(" ")[0]) && !/^(?:Windermere|Compass|Coldwell|Remax|Sotheby|Berkshire|Redfin)/.test(t)) ? t : "";
  };
  for (const s of sentences(text)) {
    if (REACTION_RX.test(s)) continue;
    const phone = (s.match(PHONE_RX) || String(text).match(PHONE_RX) || [])[0] || "";
    const phrase = s.slice(0, 160);
    for (const m of s.matchAll(REACH_RX)) {
      const [, verb, rel, rawName, rawBrokerage] = m;
      const name = okName(rawName);
      if (!name) continue;
      const brokerage = okBrokerage(rawBrokerage);
      if (!brokerage && !/through/i.test(verb) && !LEAD_CUE.test(s)) continue;
      return { name, brokerage, relation: rel ? relLabel(rel) : "", phone, phrase };
    }
    for (const m of s.matchAll(NAME_AT_RX)) {
      const name = okName(m[1]);
      const brokerage = okBrokerage(m[2]);
      if (!name || !brokerage) continue;
      return { name, brokerage, relation: "", phone, phrase };
    }
    for (const m of s.matchAll(MY_REL_NAME_RX)) {
      // "Chasing my partner down": a capital that opens the sentence is not a name.
      if (m[3] && !s.slice(0, m.index).trim()) continue;
      const name = okName(m[2] || m[3]);
      if (!name || /ing$/.test(name.split(" ")[0])) continue;
      // "my partner Paul will be going out" is a showing, not a referral.
      if (!LEAD_CUE.test(s)) continue;
      return { name, brokerage: "", relation: relLabel(m[1] || m[4]), phone, phrase };
    }
    let m;
    if ((m = RELATIVE_LEAD_RX.exec(s))) return { name: "", brokerage: "", relation: `${m[1].toLowerCase()}'s ${m[2].toLowerCase().replace(/s$/, "")}`, phone, phrase };
    if ((m = FRIEND_HAS_RX.exec(s))) return { name: "", brokerage: "", relation: m[1].toLowerCase(), phone, phrase };
    if ((m = PARTNER_LOOKING_RX.exec(s))) return { name: "", brokerage: "", relation: `${m[1].toLowerCase()} partner`, phone, phrase };
  }
  return null;
}

/** referralKey(r) → "dana example" — one referral row per person per agent. */
export function referralKey(r) {
  return clean(r?.name || r?.relation || "").toLowerCase().replace(/[^a-z0-9' ]/g, "").slice(0, 60);
}

// "Pine St, Shelton" → "Pine St". How the house reads in a text.
const streetLabel = (address) => {
  const p = parseUsAddress(String(address || ""));
  return normalizeUsAddress(`1 ${p.street}`).replace(/^1\s+/, "") || String(address || "").split(",")[0].trim();
};
const joinAnd = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** addressAsk(houses) → the one sentence that asks where they are. */
export function addressAsk(houses = []) {
  // A house with no street at all goes by what they called it ("the Stanwood houses").
  const labels = houses.map((h) => (h.address ? `the ${streetLabel(h.address)} one` : h.label)).filter(Boolean);
  if (!labels.length) return "";
  return labels.length === 1 && !houses.some((h) => !h.address && h.plural)
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
    const name = h.address || h.label || "";
    return bits.length ? `${name} (${bits.join(", ")})` : name;
  }).join("; ").slice(0, 300);
}

const OPEN_DAYS = 60;

/**
 * housesAwaitingAddress({ events, offers, now }) → [{ address, label?, area?, sellerAsk, note, at }]
 *
 * Houses they named in the last 60 days that we still have no number for:
 * no later mention of the same street with one, and no offer on it. What
 * the reply's context lists, so a later "it's 1412" lands on the right house.
 *
 * A house named with no street ("some Stanwood houses", address "") stays
 * open until a numbered house in that town comes from them after it — or,
 * when no town was said ("his flips"), any numbered house after it.
 */
export function housesAwaitingAddress({ events = [], offers = [], now = Date.now() } = {}) {
  const since = now - OPEN_DAYS * 86400000;
  const numbered = new Set();
  const numberedAt = [];   // every house we have a number for, and since when
  for (const o of offers || []) {
    if (!o?.address || !hasHouseNumber(o.address)) continue;
    numbered.add(streetKey(o.address));
    numberedAt.push({ at: Date.parse(o.createdAt || "") || 0, address: o.address });
  }
  for (const e of events || []) {
    if (e?.type !== "house_mentioned" || !e.address || !hasHouseNumber(e.address)) continue;
    numbered.add(streetKey(e.address));
    numberedAt.push({ at: Date.parse(e.at || "") || 0, address: e.address });
  }
  const open = new Map();
  for (const e of [...(events || [])].sort((a, b) => String(a?.at || "").localeCompare(String(b?.at || "")))) {
    if (e?.type !== "house_mentioned") continue;
    const at = Date.parse(e.at || "") || 0;
    if (at < since) continue;
    if (!e.address) {
      const label = String(e.data?.label || "").trim();
      if (!label) continue;
      const town = String(e.data?.town || "").toLowerCase();
      if (numberedAt.some((n) => n.at > at && (!town || townIn(n.address) === town))) continue;
      open.set(`area:${town || label.toLowerCase()}`, { address: "", label, area: String(e.data?.area || ""),
        sellerAsk: Number(e.data?.sellerAsk) || 0, note: String(e.data?.note || ""), at: e.at });
      continue;
    }
    if (hasHouseNumber(e.address)) continue;
    const key = streetKey(e.address);
    if (!key || numbered.has(key)) continue;
    open.set(key, { address: e.address, sellerAsk: Number(e.data?.sellerAsk) || 0, note: String(e.data?.note || ""), at: e.at });
  }
  return [...open.values()];
}
