// off-market.js — our best deals: houses an agent brings us before (or
// without) the market seeing them. Matt, 2026-09-30: "our biggest success has
// been in agent-sourced off market properties… ask agents if they get off
// market properties please send our way… not in an aggressive way… a way to
// mark offers as off-market and track those."
//
// Pure. Four questions, one place:
//   offMarketOf(offer)          is this offer off-market, and who said so
//   offMarketSignals(...)       why the machine thinks a new offer is off-market
//   offMarketStats(offers)      off-market vs listed, station by station
//   offMarketAskDaysAgo(events) when we last asked this agent for off-market houses

import { effectiveStatus, priceAgreed } from "./offer-status.js";

const DAY_MS = 86400000;
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

/* ---------- the flag ---------- */

/**
 * offMarketOf(offer) → { value, by, why, at } | null
 *
 * Stored at `offer.offMarket = { value, by: "you" | "machine", why, at }`.
 * Null is "not known": an offer on a house we found listed, or one nobody
 * has said anything about.
 */
export function offMarketOf(offer) {
  const m = offer?.offMarket;
  if (!m || typeof m !== "object" || typeof m.value !== "boolean") return null;
  return { value: m.value, by: m.by === "you" ? "you" : "machine", why: String(m.why || "").slice(0, 160), at: m.at || null };
}
export const isOffMarket = (offer) => offMarketOf(offer)?.value === true;

/* ---------- what says a new offer is off-market ---------- */

// The agent's words: "it's a pocket listing", "not listed yet", "coming
// soon", "hasn't hit the MLS", "before it goes on the market", "off market".
export const OFF_MARKET_CUE_RX = new RegExp([
  "off[\\s-]?market", "pocket(?:\\s+listing)?", "pre[\\s-]?market", "coming soon",
  "not (?:yet )?(?:listed|on (?:the )?(?:market|mls))",
  "(?:hasn'?t|has not|never) (?:been )?(?:listed|hit (?:the )?(?:market|mls)|gone on (?:the )?(?:market|mls))",
  "before (?:it|we|they) (?:list|lists|hit|hits|go|goes) (?:it )?(?:on )?(?:the )?(?:market|mls)?",
  "private (?:listing|sale)", "whisper listing", "quiet listing", "exclusive listing",
  // The way the off-market houses with committed buyers actually came
  // (2026-10-09): a friend's house, a friend who told them about a seller,
  // word of mouth, a house that was never listed.
  "(?:my|a) friend (?:of mine )?(?:has|owns|is (?:looking|thinking|wanting) to sell|told me)",
  "word[\\s-]of[\\s-]mouth",
].map((p) => `\\b${p}`).join("|"), "i");

/** offMarketCue(text) → the phrase that says it, or "". */
export function offMarketCue(text = "") {
  const m = String(text || "").match(OFF_MARKET_CUE_RX);
  return m ? m[0].trim() : "";
}

// Their lines in a transcript (buildTranscript marks them THEM), newest last:
// what we said about a house isn't evidence of how it's being sold.
const theirLines = (transcript = "", max = 12) => String(transcript || "").split("\n").filter((l) => /\bTHEM\b/.test(l)).slice(-max);

// Zillow's word for a house nobody can buy on the open market yet.
const PRE_MARKET_STATUSES = new Set(["COMING_SOON", "OFF_MARKET", "PRE_MARKET"]);

/**
 * offMarketSignals({ message, transcript, listing }) → { value: true, why } | null
 *
 * The machine's read when an underwrite lands an offer: the agent said so
 * (the text that started it, or their recent lines), or Zillow shows the
 * house coming soon or off the market. Nothing said and a listing found (or
 * no lookup at all) is "not known" — never "listed" by guess.
 */
export function offMarketSignals({ message = "", transcript = "", listing = null, agentBrought = false } = {}) {
  const said = offMarketCue(message) || theirLines(transcript).map(offMarketCue).find(Boolean) || "";
  if (said) return { value: true, why: `they said "${said.toLowerCase()}"` };
  const status = String(listing?.status || "").toUpperCase();
  if (PRE_MARKET_STATUSES.has(status)) return { value: true, why: status === "COMING_SOON" ? "coming soon on Zillow" : "not listed on Zillow" };
  // A house the agent brought us (not the listing we texted about) that
  // Zillow knows and doesn't show for sale: the friend's house, the estate
  // that never got listed. Without a lookup it stays "not known".
  if (agentBrought && listing && status && !LISTED_STATUSES.has(status)) return { value: true, why: "an agent brought it and Zillow doesn't show it for sale" };
  return null;
}

// Zillow's words for a house anyone can buy (or has just bought) on the market.
const LISTED_STATUSES = new Set(["FOR_SALE", "PENDING", "CONTINGENT", "ACTIVE", "UNDER_CONTRACT", "FOR_AUCTION"]);

/* ---------- off-market vs listed ---------- */

const blank = () => ({ offers: 0, sent: 0, countered: 0, agreed: 0, contract: 0, buyer: 0, closed: 0 });
// A deal with a committed buyer: the ones that close (Matt, 2026-10-09).
const BUYER_STAGES = new Set(["buyer_found", "assigned", "closed"]);
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

/**
 * funnelBy(offers, sideOf, { now, days, sides }) → { [side]: { offers, sent, countered, agreed, contract, buyer, closed, contractRate } }
 *
 * The house-by-house funnel, split by whatever `sideOf(offer)` says — off-
 * market or listed, single family or another kind (shared/line.js). Each
 * house once (its current row; a draft never), created inside the window.
 */
export function funnelBy(offers = [], sideOf = () => "all", { now = Date.now(), days = null, sides = [] } = {}) {
  const from = days ? now - days * DAY_MS : -Infinity;
  const out = Object.fromEntries(sides.map((k) => [k, blank()]));
  for (const o of offers || []) {
    if (!o || o.status === "draft" || o.supersededBy || o.isCurrent === false) continue;
    if ((ms(o.createdAt) ?? 0) < from) continue;
    const key = sideOf(o);
    const side = out[key] || (out[key] = blank());
    const seen = new Set((o.statusHistory || []).map((h) => h?.status));
    const status = effectiveStatus(o);
    side.offers++;
    if ((o.sends || []).some((s) => s?.ts) || o.proactive?.realmCheckAt || seen.has("sent") || status !== "new") side.sent++;
    if (seen.has("countered") || o.counter || status === "countered") side.countered++;
    if (o.deal || priceAgreed(o) || seen.has("accepted") || status === "accepted") side.agreed++;
    if (o.deal) side.contract++;
    if (o.deal && BUYER_STAGES.has(o.deal.stage)) side.buyer++;
    if (o.deal && ["closed", "assigned"].includes(o.deal.stage)) side.closed++;
  }
  for (const side of Object.values(out)) side.contractRate = pct(side.contract, side.offers);
  return out;
}

/**
 * offMarketStats(offers, { now, days }) → { offMarket, listed, agents }
 *
 * Each house once (its current row; a draft never), created inside the
 * window (`days`, or all time), counted at every station it reached:
 * offers → sent → countered → agreed → contract → closed, with the share of
 * offers that reached a contract. `agents`: who brings us off-market houses,
 * most first, with how many became contracts.
 */
export function offMarketStats(offers = [], { now = Date.now(), days = null, names = {} } = {}) {
  const out = funnelBy(offers, (o) => (isOffMarket(o) ? "offMarket" : "listed"), { now, days, sides: ["offMarket", "listed"] });
  const from = days ? now - days * DAY_MS : -Infinity;
  const agents = new Map();
  for (const o of offers || []) {
    if (!o || o.status === "draft" || o.supersededBy || o.isCurrent === false) continue;
    if ((ms(o.createdAt) ?? 0) < from) continue;
    const off = isOffMarket(o);
    if (off && o.contactId) {
      const a = agents.get(o.contactId) || { contactId: o.contactId, name: o.contactName || names[o.contactId] || "", offers: 0, contracts: 0 };
      a.offers++;
      if (o.deal) a.contracts++;
      agents.set(o.contactId, a);
    }
  }
  return {
    ...out,
    agents: [...agents.values()].sort((a, b) => b.contracts - a.contracts || b.offers - a.offers || a.name.localeCompare(b.name)).slice(0, 10),
  };
}

/* ---------- asking for them ---------- */

// Never ask the same agent more often than this (Matt: "not in an aggressive way").
export const OFF_MARKET_ASK_EVERY_DAYS = 30;

// A text of ours that asks about off-market houses — recorded when it sends
// (`offmarket_asked`), so the next ask waits its turn.
export const OFF_MARKET_ASK_RX = /\b(?:off[\s-]?market|pocket listings?|before (?:it|they)(?:'s| is)? (?:hits?|list(?:ed)?|goes? on)|hasn'?t hit the (?:market|mls)|(?:a )?first look)\b/i;

/** offMarketAskDaysAgo(events, now) → whole days since we last asked, or null if never. */
export function offMarketAskDaysAgo(events = [], now = Date.now()) {
  const t = (events || []).filter((e) => e?.type === "offmarket_asked").map((e) => ms(e.at)).filter((x) => x != null);
  return t.length ? Math.max(0, Math.floor((now - Math.max(...t)) / DAY_MS)) : null;
}

/** offMarketAskDue(events, now) → true when we may ask them again. */
export const offMarketAskDue = (events = [], now = Date.now()) => {
  const d = offMarketAskDaysAgo(events, now);
  return d == null || d >= OFF_MARKET_ASK_EVERY_DAYS;
};
