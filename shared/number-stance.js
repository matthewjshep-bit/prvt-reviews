// number-stance.js — price once (2026-10-15).
//
// The funnel review (July to October): on 35 of 305 houses our number fell
// after the agent had seen it, 11 of them after a counter or a yes ("since
// we're aligned at 752,500, can you write it up?" and the next day "can't get
// there"). Numbers priced by hand were cut about as often as the machine's
// (12.6% against 11%), so the inputs are the problem (rehab read low off the
// photos, ARV read high), not who priced it. And the gap between their number
// and ours decided the outcome: within 5%, 13 of 25 agreed; past 25%, none of
// 95. "Too low" or "insulting" came up in 66 of 485 threads, often a number
// 25 to 37% under list sent minutes after a one-line reply.
//
// Two answers, both pure:
//
//   numberStance  a high-stakes house (off-market, one the agent brought us,
//                 or over $500K) floats a RANGE, never a number we'd put on
//                 paper, until we have the agent's own read of the value and
//                 the work AND someone's eyes on it, or Matt approved the
//                 number.
//   listedFit     a listed house: ask what the seller is hoping to get
//                 before any number of ours, and when ours is far under
//                 theirs, a polite no-fit (no number, ask for other fixers)
//                 that Matt sees on Today, instead of a lowball. Never a pass:
//                 he can still price it by hand.
//
// Switches: parties.agent.realmCheck.highStakes and parties.agent.listedFirst
// (shared/conversation-ai.js), both off by default.

import { isOffMarket } from "./off-market.js";
import { sameStreet } from "./us-address.js";

// "Eyes on it": a photo scan this deep, a walkthrough video, or a person
// marking that someone has been (offer.seen).
export const EYES_MIN_PHOTOS = 8;
// Over this, a number is high-stakes whoever brought the house.
export const HIGH_STAKES_OVER = 500000;
// A listed house where ours is under this share of the seller's number (or
// of the list price) is a no-fit. The counter walk-away (reply-agent.js
// WALK_AWAY_GAP, 25% over the most we'd pay, so ours under about 80% of
// theirs) is a different rule for a different moment: theirs came after
// ours. This one is before we've said a number at all.
export const LISTED_MIN_PCT = 75;

const round = (n) => Math.round(Number(n) || 0);
const kWord = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1000)}K`);

/**
 * hasEyes({ offer, videos }) → boolean
 *
 * Someone has seen more than a listing photo or two: the underwrite scanned
 * EYES_MIN_PHOTOS or more, there is a walkthrough video on the offer, or a
 * person marked it seen (offer.seen = { at, by }).
 */
export function hasEyes({ offer = null, videos = null } = {}) {
  if (offer?.seen?.at) return true;
  const n = Array.isArray(videos) ? videos.filter((v) => !v?.status || v.status === "ready").length : round(videos);
  if (n > 0) return true;
  return round(offer?.autoUnderwrite?.photosAnalyzed) >= EYES_MIN_PHOTOS;
}

// A number a person stands behind: built by hand, or a held run a person
// published. Matt's approval (offer-status.js numberApproved) is passed in.
const personsNumber = (offer) => !offer?.autoUnderwrite || Boolean(offer.autoUnderwrite.publishedAt);

/**
 * numberStance({ offer, dossier, leadSource, highStakes, videos, approved })
 *   → { mode: "range" | "firm", highStakes, why, missing: ["their_read" | "eyes"] }
 *
 *   highStakes  the switch: { enabled, overAmount } (realmCheck.highStakes)
 *   dossier     propertyDossier(events, address): have.arv / have.rehab is
 *               their read
 *   leadSource  "agent_brought" | "hook" | ... (shared/lead-source.js);
 *               falls back to offer.autoUnderwrite.leadSource
 *   videos      the offer's videos (array) or a count
 *   approved    Matt approved this number
 *
 * "range": float the number as a range topped by ours, ask for what's
 * missing, and put nothing on paper by machine. "firm": as before.
 */
export function numberStance({ offer = null, dossier = null, leadSource = "", highStakes = null, videos = null, approved = false } = {}) {
  const firm = (extra = {}) => ({ mode: "firm", highStakes: false, why: "", missing: [], ...extra });
  if (!highStakes?.enabled) return firm();
  const amount = round(offer?.cashAmount);
  if (!amount) return firm();
  const over = round(highStakes.overAmount) || HIGH_STAKES_OVER;
  const source = String(leadSource || offer?.autoUnderwrite?.leadSource || "");
  const reasons = [
    isOffMarket(offer) ? "off-market" : "",
    source === "agent_brought" ? "a house the agent brought us" : "",
    amount > over ? `over ${kWord(over)}` : "",
  ].filter(Boolean);
  if (!reasons.length) return firm();
  const why = reasons.join(", ");
  if (approved || personsNumber(offer)) return firm({ highStakes: true, why });
  const missing = [];
  if (!(dossier?.have?.arv || dossier?.have?.rehab)) missing.push("their_read");
  if (!hasEyes({ offer, videos })) missing.push("eyes");
  return { mode: missing.length ? "range" : "firm", highStakes: true, why, missing };
}

// What a range float is waiting for, in Matt's words (the offer book, logs).
export function stanceWaitingFor(stance) {
  const m = stance?.missing || [];
  return [
    m.includes("their_read") ? "their read on the value and the work" : "",
    m.includes("eyes") ? "eyes on it (8+ photos, a walkthrough video, or someone's been)" : "",
  ].filter(Boolean).join(" and ");
}

/**
 * sellerNumberOn({ offer, dossier, events }) → { amount, source: "seller" | "list" } | null
 *
 * What the seller is hoping to get: their number in the agent's words (the
 * dossier's sellerAsk, a house_mentioned with one, or a counter on the
 * offer), else the list price.
 */
export function sellerNumberOn({ offer = null, dossier = null, events = [] } = {}) {
  const said = round(dossier?.have?.sellerAsk?.value);
  if (said > 0) return { amount: said, source: "seller" };
  const mentioned = (events || [])
    .filter((e) => e?.type === "house_mentioned" && round(e.data?.sellerAsk) > 0 && e.address && offer?.address && sameStreet(e.address, offer.address))
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))[0];
  if (mentioned) return { amount: round(mentioned.data.sellerAsk), source: "seller" };
  const counter = round(offer?.counter?.amount);
  if (counter > 0) return { amount: counter, source: "seller" };
  const list = round(offer?.askingPrice ?? offer?.calc?.inputs?.askingPrice ?? offer?.inputs?.askingPrice);
  return list > 0 ? { amount: list, source: "list" } : null;
}

/**
 * listedFit({ offer, dossier, events, leadSource, pct, quoted })
 *   → { listed, theirs, source, ratio, move: "ask_number" | "no_fit" | "float" }
 *
 *   ask_number  a listed house, nothing of ours on it yet, and we don't know
 *               the seller's number: ask "what's the seller hoping to get?"
 *               before anything else
 *   no_fit      ours is under `pct`% of theirs (their number, or the list
 *               price once we've asked): a polite no-fit, no number, and a
 *               row for Matt
 *   float       anything else: as before
 *
 * Only before the first quote: once a number of ours went out on the house
 * (`quoted`: a price in the thread, paper, a floated number), it is "float"
 * and the counter rules own it. Off-market houses are never "listed".
 */
export function listedFit({ offer = null, dossier = null, events = [], leadSource = "", pct = LISTED_MIN_PCT, quoted = false } = {}) {
  const asking = round(offer?.askingPrice ?? offer?.calc?.inputs?.askingPrice ?? offer?.inputs?.askingPrice);
  const source = String(leadSource || offer?.autoUnderwrite?.leadSource || "");
  const listed = !isOffMarket(offer) && (asking > 0 || source === "hook");
  const theirs = sellerNumberOn({ offer, dossier, events });
  const ours = round(offer?.cashAmount);
  const ratio = theirs?.amount && ours ? ours / theirs.amount : null;
  const out = (move) => ({ listed, theirs: theirs?.amount || 0, source: theirs?.source || "", ratio, move });
  if (!listed || !ours) return out("float");
  if (quoted || offer?.proactive?.realmCheckAt) return out("float");
  const asked = Boolean(offer?.proactive?.takeCheckAt || offer?.listedFit?.askedAt);
  if (theirs?.source !== "seller" && !asked) return out("ask_number");
  const floor = Math.min(100, Math.max(1, Number(pct) || LISTED_MIN_PCT)) / 100;
  if (ratio != null && ratio < floor) return out("no_fit");
  return out("float");
}

// The no-fit, in a line for the log and the Today row.
export function noFitLine(fit) {
  if (!fit?.theirs) return "";
  const pct = fit.ratio != null ? Math.round(fit.ratio * 100) : null;
  return `ours is ${pct != null ? `${pct}% of ` : "under "}${fit.source === "seller" ? "the seller's" : "the list price of"} ${kWord(fit.theirs)}`;
}
