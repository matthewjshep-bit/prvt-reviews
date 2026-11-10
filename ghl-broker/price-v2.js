// price-v2.js — the offer engine prices every named house in the shadow (auto-underwrite v2, 2026-11-04).
//
// Matt chose "shadow two weeks first": the engine (shared/price-engine.js) prices each house the
// conversation names, beside the live path, and writes its answer to the house's record
// (house_pricing). It sends nothing, floats nothing and changes nothing on the draft or the
// thread; it only reads what the run already bought (Bricked's read, the Zillow listing, the comps
// and the photo scope when a full run took them) and the agent's own words on file. The daily
// scorecard (shared/price-scorecard.js) measures it against what really happened.
//
// Switch: settings.pricingV2.shadow, off. No names, numbers or message text are logged here.

import { priceHouse, normalizePricingV2 } from "./shared/price-engine.js";
import { KC_FLIP_RATIOS } from "./shared/kc-flip-ratios.js";
import { houseKey } from "./shared/current-offer.js";
import { oneAgentsHouse, parseUsAddress, normalizeUsAddress } from "./shared/us-address.js";
import { streetMentions } from "./shared/mentioned-houses.js";

export const ENGINE_VERSION = "v2.0";
const HISTORY_MAX = 10;
const TEXT_MAX = 1500;
// Their words about this house: the triggering text plus their own lines since the house was
// first named (houseLines), newest kept when it runs long.
const SAID_MAX = 4000;
// shadowPrice keeps the house's heaviest rehab read from this far back (audit 2026-11-09: four
// runs on one house read 60k to 118.5k, and the one at the 60k floor was graded A and floated).
export const PRIOR_REHAB_DAYS = 14;
const DAY = 86400000;

// The engine prices a house whenever it is on at all: in the shadow, or live on grade A.
export const shadowOn = (saved) => { const s = normalizePricingV2(saved?.pricingV2); return s.shadow || s.liveA; };
export const engineLive = (saved) => normalizePricingV2(saved?.pricingV2).liveA;

const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
const zipOf = (address) => (String(address || "").match(/\b(\d{5})(?:-\d{4})?\s*$/) || String(address || "").match(/\b(9[789]\d{3})\b/) || [])[1] || "";
const clip = (s) => String(s || "").slice(0, TEXT_MAX);

// The same house as `address`, for one contact's own events: the full key, or a shorter spelling
// of it ("4417 Somerset" for "4417 Somerset Ln, Everett, WA"), never a namesake in another town.
const onHouse = (a, address, key) => Boolean(a) && (houseKey(a) === key || oneAgentsHouse(a, address));

// A note that only says what they owe ("owes 210k on the mortgage") is a payoff, not their number.
// A note that also says what they want is their number.
const PAYOFF_RX = /\b(?:owes?|owed|owing|payoff|pay\s*off|mortgage|loan|liens?|balance)\b/i;
const ASK_RX = /\b(?:wants?|asking|ask|take|accept|entertain|hoping|net)\b/i;
const payoffOnly = (note) => PAYOFF_RX.test(String(note || "")) && !ASK_RX.test(String(note || ""));

/**
 * sellerNumberFor({ address, events, offer, dossier }) → { amount, at, source } | null
 *
 * What the seller said they'd take on this house, newest first, read the way
 * shared/number-stance.js sellerNumberOn reads it: the dossier's sellerAsk, a property_details or
 * house_mentioned sellerAsk, a counter (offer_countered, or the offer's own `counter`). Never a
 * payoff, never what they owe, never the list price: only seller-sourced asks cap the engine.
 */
export function sellerNumberFor({ address = "", events = [], offer = null, dossier = null } = {}) {
  const key = houseKey(address);
  if (!key) return null;
  const found = [];
  const add = (amount, at, source) => { const n = num(amount); if (n) found.push({ amount: Math.round(n), at: String(at || ""), source }); };
  if (dossier?.have?.sellerAsk) add(dossier.have.sellerAsk.value, dossier.have.sellerAsk.at, "dossier");
  for (const e of events || []) {
    if (!e?.address || !onHouse(e.address, address, key)) continue;
    if (e.type === "property_details") add(e.data?.sellerAsk, e.at, "property_details");
    else if (e.type === "house_mentioned" && !payoffOnly(e.data?.note)) add(e.data?.sellerAsk, e.at, "house_mentioned");
    else if (e.type === "offer_countered") add(e.data?.amount, e.at, "counter");
  }
  if (offer && (!offer.address || onHouse(offer.address, address, key))) add(offer.counter?.amount, offer.counter?.at, "counter");
  return found.sort((x, y) => y.at.localeCompare(x.at))[0] || null;
}

// The words of a street name, without its directional or suffix: "193rd" for "193rd St SW".
const DIR_WORDS = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw", "north", "south", "east", "west", "northeast", "northwest", "southeast", "southwest"]);
const SUFFIX_WORDS = new Set(["st", "ave", "av", "ln", "rd", "dr", "ct", "pl", "way", "blvd", "cir", "ter", "trl", "pkwy", "hwy", "loop", "lp", "sq", "expy",
  "street", "avenue", "lane", "road", "drive", "court", "place", "boulevard", "circle", "terrace", "trail", "parkway", "highway", "square"]);
const nameWords = (street) => normalizeUsAddress(String(street || "")).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ")
  .filter((w) => w && !DIR_WORDS.has(w) && !SUFFIX_WORDS.has(w));
const LINE_HEAD_RX = /^\s*(?:\[[^\]]*\]\s*)?(THEM|US)\b[^:]*:\s*/;

/**
 * houseLines(thread, address) → [their lines about this house]
 *
 * The engine's killers used to read only the text that started the run, so "it's an assignment"
 * said a text before the address never reached them (audit 2026-11-09, UWM-11). This reads the
 * thread (buildTranscript's "[stamp] THEM sms: …" lines, oldest first) from the first line that
 * names the house by its street, and keeps THEIR lines while the talk is on it: a line naming
 * another street stops it until this one is named again. A thread that never names the house
 * gives nothing, and the engine reads the triggering text alone, as before.
 */
export function houseLines(thread = "", address = "") {
  const words = nameWords(parseUsAddress(address).street);
  if (!words.length || !String(thread || "").trim()) return [];
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = new RegExp(`\\b${words.map(esc).join("\\s+")}\\b`, "i");
  const out = [];
  let on = false;
  for (const line of String(thread).split("\n")) {
    const head = line.match(LINE_HEAD_RX);
    const body = head ? line.slice(head[0].length) : line;
    if (names.test(body)) on = true;
    else if (streetMentions(body).some((m) => !names.test(m.address))) on = false;
    if (on && head?.[1] === "THEM" && body.trim()) out.push(body.trim());
  }
  return out;
}

const saidOf = (message, lines) => {
  const first = String(message || "").slice(0, TEXT_MAX);
  const rest = lines.filter((l) => l !== first.trim());
  let tail = rest.join("\n");
  const room = SAID_MAX - first.length - 1;
  if (tail.length > room) tail = room > 0 ? tail.slice(tail.length - room) : "";
  return [first, tail].filter(Boolean).join("\n");
};

/**
 * readsFrom({ address, message, listPrice, askingPrice, b, listing, facts, subject, comps, scope, events, offer, dossier, thread, now })
 *   → the engine's reads for one house, from what a run already holds.
 *
 *   b        Bricked's read (price-bricked.js normalizeBricked), or null
 *   facts    the Zillow listing's facts { sqft, yearBuilt, lotSqft, homeType }
 *   subject  Bricked's subject, when there are no Zillow facts
 *   comps    { arv, n, listing, radius, acrossInArv, eraGivesWay, gutCheck } — a full run's own comps
 *            and how far they reached (engineFinish)
 *   scope    { total, photos } — a full run's photo scope
 *   events   the contact's property_details / agent_estimate / house_mentioned / offer_countered
 *            events (their numbers)
 *   offer, dossier  optional: a counter on the offer, the dossier's sellerAsk (sellerNumberFor)
 *   thread   the run's transcript, when it read one: their lines about this house feed `said`
 *   now      the clock, for `currentYear` (a house built in the last two years is a new build)
 */
export function readsFrom({ address = "", message = "", listPrice = 0, askingPrice = 0, b = null, listing = null, facts = null, subject = null, comps = null, scope = null,
  events = [], offer = null, dossier = null, thread = "", now = Date.now() } = {}) {
  const key = houseKey(address);
  const mine = (events || []).filter((e) => !e?.address || houseKey(e.address) === key);
  const newest = (type, field) => mine.filter((e) => e?.type === type && num(e?.data?.[field]))
    .sort((x, y) => String(y.at || "").localeCompare(String(x.at || "")))[0]?.data?.[field];
  const s = subject || b?.subject || {};
  const year = new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now()).getUTCFullYear();
  return {
    list: num(listPrice) || num(listing?.listPrice) || num(askingPrice),
    sellerNumber: sellerNumberFor({ address, events, offer, dossier })?.amount || 0,
    theirRepairs: num(newest("agent_estimate", "rehab")),
    zip: zipOf(address),
    sqft: num(facts?.sqft) || num(s.sqft),
    yearBuilt: num(facts?.yearBuilt) || num(s.yearBuilt),
    currentYear: year,
    lotSqft: num(facts?.lotSqft),
    homeType: facts?.homeType || "",
    bricked: b && num(b.arv)
      ? { arv: num(b.arv), arvConfidence: Number(b.arvConfidence) || 0, asIs: num(b.asIs), repairs: num(b.repairs), described: num(b.repairs) > 0,
        condition: Number(b.subject?.condition) || null, comps: (b.comps || []).map((c) => ({ use: c.use, renovated: c.renovated ?? null, renovationScore: c.renovationScore ?? null })) }
      : null,
    comps: comps && num(comps.arv)
      ? { arv: num(comps.arv), n: Number(comps.n) || 0,
        ...(comps.listing != null ? { listing: Number(comps.listing) || 0 } : {}),
        ...(comps.radius != null ? { radius: Number(comps.radius) || 0 } : {}),
        ...(comps.acrossInArv != null ? { acrossInArv: Number(comps.acrossInArv) || 0 } : {}),
        ...(comps.eraGivesWay != null ? { eraGivesWay: comps.eraGivesWay === true } : {}),
        ...(comps.gutCheck != null ? { gutCheck: comps.gutCheck === true } : {}) }
      : null,
    scope: scope && num(scope.total) ? { total: num(scope.total), photos: Number(scope.photos) || 0 } : null,
    said: saidOf(message, houseLines(thread, address)),
    // The triggering text alone: their earlier lines add killers and cost, never rehab evidence.
    saidNow: clip(message),
    remarks: clip(listing?.remarks),
  };
}

/**
 * nextRecord(prev, { address, contactId, offerId, leadSource, reads, v2, at }) → the house's record
 * The answer replaces the last one; the last HISTORY_MAX answers are kept so the scorecard can see
 * a number move. Outcome and evidence (filled by price-outcomes.js and thread-reads.js) are kept.
 */
export function nextRecord(prev = null, { address = "", contactId = null, offerId = null, leadSource = null, reads = {}, v2 = {}, at = new Date().toISOString() } = {}) {
  const p = prev || {};
  // rehabRead: what that read alone said, so an earlier heavy read ages out after PRIOR_REHAB_DAYS
  // instead of being carried forward by every read that kept it.
  const point = { at, grade: v2.grade, walkAway: v2.walkAway, open: v2.open, arv: v2.arv, rehab: v2.rehab, rehabRead: v2.rehabOwn ?? v2.rehab };
  return {
    houseKey: houseKey(address), address: address || p.address || "",
    contactId: contactId || p.contactId || null, offerId: offerId || p.offerId || null, leadSource: leadSource || p.leadSource || null,
    firstAt: p.firstAt || at,
    reads, v2: { ...v2, version: ENGINE_VERSION, at },
    history: [...(p.history || []), point].slice(-HISTORY_MAX),
    outcome: p.outcome || null,
    evidence: p.evidence || [],
  };
}

/**
 * priorRehabOf(record, now) → the heaviest rehab any read of this house said in the last
 * PRIOR_REHAB_DAYS (each read's own figure, `rehabRead`), or 0.
 */
export function priorRehabOf(record = null, now = Date.now()) {
  const since = Number(now) - PRIOR_REHAB_DAYS * DAY;
  return Math.max(0, ...((record?.history || [])
    .filter((p) => (Date.parse(p?.at || "") || 0) >= since)
    .map((p) => num(p?.rehabRead ?? p?.rehab))));
}

/**
 * repriceStaleRow({ store, locationId, saved, offer, now }) → the record written, or null
 *
 * Engine mode's touch on a row the old machine priced and nobody stood behind (shared/current-
 * offer.js awaitingReprice, 2026-11-09): when a float on it is skipped, the engine prices the house
 * on what the row already holds — its comps ARV, the list price, the house's facts — and the house
 * record gets the engine's answer. Only when the house has no engine answer yet, or one older than
 * the row: a full run's richer answer is never replaced by this thinner one. It writes the house
 * record only; the offer row and the thread are untouched.
 */
export async function repriceStaleRow({ store, locationId, saved = {}, offer = null, now = Date.now() } = {}) {
  if (!offer?.address || !store?.upsertHousePricing) return null;
  const key = houseKey(offer.address);
  if (!key) return null;
  const prev = await Promise.resolve(store.getHousePricing?.(locationId, key)).catch(() => null);
  const prevAt = Date.parse(prev?.pricedAt || prev?.doc?.v2?.at || "");
  if (Number.isFinite(prevAt) && prevAt >= (Date.parse(offer.createdAt || "") || 0)) return null;
  const info = offer.snapshot?.subjectInfo || {};
  const facts = { sqft: info.sqft, yearBuilt: info.yearBuilt, lotSqft: info.lotSqft ?? offer.subjectLotSqft, homeType: info.homeType || offer.subjectHomeType || "" };
  const arv = num(offer.arv ?? offer.calc?.inputs?.arv);
  const list = num(offer.askingPrice ?? offer.calc?.inputs?.askingPrice);
  return shadowPrice({
    store, locationId, saved, force: true, now, address: offer.address, facts, listPrice: list,
    job: { contactId: offer.contactId || null, offerId: offer.id || null, message: "", askingPrice: list, leadSource: offer.autoUnderwrite?.leadSource || null, warnings: [] },
    comps: arv ? { arv, n: Number(offer.autoUnderwrite?.compsUsedCount) || 0 } : null,
  });
}

/**
 * shadowPrice({ store, locationId, saved, job, address, b, listing, facts, subject, comps, scope, listPrice, thread, offer, dossier })
 *   → the record written, or null (switch off, nothing to price, or a failure — never thrown).
 */
export async function shadowPrice({ store, locationId, saved = {}, job = {}, address = "", b = null, listing = null, facts = null, subject = null, comps = null, scope = null, listPrice = 0, thread = "", offer = null, dossier = null, force = false, now = Date.now() } = {}) {
  // `force`: engine mode prices every house it reads, switch or not (the record is what it's for).
  if ((!shadowOn(saved) && !force) || !address || !store?.upsertHousePricing) return null;
  try {
    const key = houseKey(address);
    if (!key) return null;
    // Their numbers on the house: what they told us (property_details, agent_estimate), a house
    // they named with an asking figure (house_mentioned) and their counters (offer_countered).
    const events = job.contactId
      ? (await store.listContactEvents?.(locationId, job.contactId, { types: ["property_details", "agent_estimate", "house_mentioned", "offer_countered"], limit: 200 }).catch(() => [])) || []
      : [];
    const prev = await store.getHousePricing(locationId, key).catch(() => null);
    const reads = readsFrom({ address, message: job.message, listPrice, askingPrice: job.askingPrice, b, listing, facts, subject, comps, scope, events, offer, dossier, thread, now });
    const priorRehab = priorRehabOf(prev?.doc, now);
    const v2 = priceHouse(priorRehab ? { ...reads, priorRehab } : reads, saved.pricingV2 || {}, { ratios: KC_FLIP_RATIOS });
    const doc = nextRecord(prev?.doc, { address, contactId: job.contactId, offerId: job.offerId, leadSource: job.leadSource, reads, v2, at: new Date(now).toISOString() });
    await store.upsertHousePricing(locationId, key, doc);
    return doc;
  } catch (e) {
    job.warnings?.push?.(`shadow price: ${String(e?.message || e).slice(0, 120)}`);
    return null;
  }
}
