// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// buyer-pulse.js — the check-in between deals.
//
// The buyer pool has only ever heard from us when we had something to sell:
// of 1,645 buyers with a phone on 2026-09-18, 1,326 had been blasted a deal,
// 484 had ever replied, and 85 had a buy box on file. Matt, the same day:
// "send them a text here and again between deals, as a pulse check — are you
// buying right now and what's your buy box, so the deals I send are relevant
// — as personable as possible using context clues on their contact.
// Deprioritize the ones we have had conversations with but still make sure
// they are included."
//
// Pure: who gets one today, in what order, and what the message may lean on.
// The runner (ghl-broker/buyer-pulse.js) does the reading and the sending.

import { paceScale } from "./bot-hold.js";

export const DEFAULT_DAILY_CAP = 10;
export const MAX_DAILY_CAP = 50;
export const DEFAULT_EVERY_DAYS = 90;
export const DEFAULT_QUIET_DAYS = 7;
// Of each day's texts, the share kept for buyers we have already talked to.
// Without it they would wait behind a thousand who never answered — at ten a
// day, most of a year.
export const DEFAULT_CONVERSED_SHARE = 20;
export const DEFAULT_HOUR = 11; // Pacific, an hour after the agent sweep
export const DEFAULT_AFTER_DEAL_DAYS = 10;
// After this long a deal they never answered is old news, not a way in.
export const AFTER_DEAL_MAX_DAYS = 21;
export const DEFAULT_IGNORED_SLOWDOWN = 2;
export const SLOW_EVERY_DAYS = 90;

const DAY_MS = 86400000;
const clamp = (x, d, lo, hi) => { const k = Math.round(Number(x)); return Number.isFinite(k) ? Math.min(hi, Math.max(lo, k)) : d; };

/**
 * normalizeBuyerPulse(v) → { enabled, autoSend, dailyCap, everyDays, quietDays, conversedShare, hour, weekdaysOnly }
 *
 * Two switches, both off: `enabled` writes the day's drafts into the outbox,
 * `autoSend` lets a draft the money guard passed send itself.
 */
export function normalizeBuyerPulse(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  const everyDays = clamp(o.everyDays, DEFAULT_EVERY_DAYS, 30, 365);
  return {
    enabled: o.enabled === true,
    autoSend: o.autoSend === true,
    dailyCap: clamp(o.dailyCap, DEFAULT_DAILY_CAP, 1, MAX_DAILY_CAP),
    everyDays,
    // Buyers who have never written back may be checked in on less often
    // than the ones we talk to. Unset, it is `everyDays` — no change.
    quietEveryDays: o.quietEveryDays == null || o.quietEveryDays === "" ? everyDays : clamp(o.quietEveryDays, everyDays, 30, 365),
    quietDays: clamp(o.quietDays, DEFAULT_QUIET_DAYS, 1, 60),
    conversedShare: clamp(o.conversedShare, DEFAULT_CONVERSED_SHARE, 0, 100),
    hour: clamp(o.hour, DEFAULT_HOUR, 8, 18),
    weekdaysOnly: o.weekdaysOnly !== false,
    // Relationship first (2026-10-05). A buyer who never answered a deal is
    // asked what fits them `afterDealDays` after it — that house is the way
    // in — instead of being nudged about it. Seated right after friends.
    afterDeal: o.afterDeal !== false,
    afterDealDays: clamp(o.afterDealDays, DEFAULT_AFTER_DEAL_DAYS, 3, 30),
    // How Matt wants these to sound, in his words (like the agent check-in's).
    voice: String(o.voice || "").slice(0, 600),
    // A buyer who let this many pulses in a row go unanswered is asked again
    // every SLOW_EVERY_DAYS at most. 0 turns it off.
    ignoredSlowdown: clamp(o.ignoredSlowdown, DEFAULT_IGNORED_SLOWDOWN, 0, 5),
  };
}

// Tags that mean "do not text", however they were spelled.
const BLOCK_TAG_RX = /^(?:dnc|dnd|do[-\s]?not[-\s]?(?:contact|text|call)|opt(?:ed)?[-\s]?out|unsubscribed?|stop|wrong[-\s]?number)$/i;
// Unsubscribed in GHL (synced onto the row as `dnd`) or tagged off. The pulse
// and the blast waves both ask (shared/buyer-score.js pickWave).
export const isBlockedBuyer = (inv = {}) => Boolean(inv?.dnd) || (inv?.tags || []).some((t) => BLOCK_TAG_RX.test(String(t).trim()));

// Market tags are slugs: "federal-way" → "Federal Way".
const titleCase = (s) => String(s || "").toLowerCase().replace(/[-_]+/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());
// "Made contact with": they wrote back, or they passed on, weighed or took a
// deal — which only happens in a conversation, whatever GHL's reply stamp says
// (it is as old as the last sync). Opening a package is not a conversation.
export const hasConversed = (inv = {}) => Boolean(inv.lastRepliedAt
  || (Number(inv.engagement?.passed) || 0) + (Number(inv.engagement?.evaluating) || 0) + (Number(inv.engagement?.committed) || 0) > 0);
// "285 EARLINGTON AVE SW, RENTON, WA" → "Renton". The street never leaves here.
const cityOf = (address) => {
  const parts = String(address || "").split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length >= 2 ? titleCase(parts[parts.length - 2].replace(/\s+\d{5}.*$/, "")) : "";
};

// How we found a buyer, for one hearing from us properly for the first time
// (the blast's own line, dispo-autopilot.js blastIntro).
const SOURCE_LINES = { "dispo-source-fb-warei": "found you through the WA real estate Facebook group" };
const sourceLine = (inv = {}) => {
  if (inv.lastRepliedAt) return "";
  const tags = (inv.tags || []).map((t) => String(t || "").toLowerCase());
  for (const t of tags) if (SOURCE_LINES[t]) return SOURCE_LINES[t];
  return tags.some((t) => t.startsWith("dispo-source-fb")) ? "found you through a real estate Facebook group" : "";
};
const streetOf = (address) => String(address || "").split(",")[0].trim();
const clip = (v, n) => String(v || "").replace(/\s+/g, " ").trim().slice(0, n);

/**
 * pulseSubject(investor, { now, history }) → what the message may lean on
 *
 * Context clues, never a dossier: how many deals we have sent them, whether
 * they have ever written back, the CITY of their last financed purchase (a
 * public record — no street, no amount, no lender), where and what they buy,
 * and the buy box if there is one to confirm rather than ask for again.
 *
 * And, since 2026-10-05, what makes it personal: the last house we sent and
 * how it went (by street — ours to mention), why they passed on what they
 * passed on, what the record says about them and our last conversation, the
 * piece of the buy box we're missing (so we ask for that, not all of it),
 * and how we found someone who has never written back. `history` is the
 * runner's read of their timeline (ghl-broker/buyer-pulse.js).
 */
export function pulseSubject(inv = {}, { now = Date.now(), history = null } = {}) {
  const b = inv.buybox || {};
  const m = inv.markets || {};
  const lastAt = Date.parse(inv.flips?.lastAt || "");
  const recentBuy = Number.isFinite(lastAt) && now - lastAt < 730 * DAY_MS;
  const box = [
    b.areas?.length ? `areas ${b.areas.slice(0, 4).join(", ")}` : String(b.areasRaw || "").trim() ? `areas ${String(b.areasRaw).slice(0, 80)}` : "",
    b.priceMax ? `up to ${Math.round(b.priceMax / 1000)}K` : "",
    b.propertyTypes?.length ? b.propertyTypes.slice(0, 3).join("/") : "",
    b.rehabAppetite ? `${b.rehabAppetite} rehab` : "",
  ].filter(Boolean).join("; ");
  const rec = { ...(inv.custom || {}), ...(inv.record || {}) };
  const h = history || {};
  const deal = h.lastDeal || null;
  const how = !deal ? "" : deal.outcome === "passed" ? `passed${deal.reason ? ` — ${clip(deal.reason, 80)}` : ""}`
    : deal.answered ? "they answered it" : "no answer";
  const missing = [
    !(b.areas?.length || String(b.areasRaw || "").trim()) ? "where they buy" : "",
    !b.propertyTypes?.length ? "what kind of house" : "",
    !(b.priceMax || b.priceMin) ? "price range" : "",
    !b.rehabAppetite ? "how much work they take on" : "",
  ].filter(Boolean);
  // Where they've bought most recently first: the last purchase's city, then
  // the tags.
  const lastCity = recentBuy ? cityOf(inv.flips?.lastAddress) : "";
  const cities = [...new Set([lastCity, ...(m.cities || []).map(titleCase)].filter(Boolean))].slice(0, 3);
  return {
    lastHouse: deal?.address ? { street: streetOf(deal.address), city: cityOf(deal.address), how, at: deal.at || null } : null,
    passReasons: (h.passes || []).filter((x) => x?.reason).slice(0, 3).map((x) => `${streetOf(x.address)}: ${clip(x.reason, 80)}`),
    aboutThem: clip(rec.personal_details, 200),
    lastSummary: clip(rec.last_convo_summary, 240),
    nextAction: clip(rec.suggested_next_action, 160),
    missing,
    source: sourceLine(inv),
    dealsSent: Number(inv.engagement?.blasts) || 0,
    conversed: hasConversed(inv),
    passed: Number(inv.engagement?.passed) || 0,
    lookedAtDeals: (Number(inv.engagement?.viewed) || 0) + (Number(inv.engagement?.evaluating) || 0) > 0,
    boughtFromUs: (Number(inv.engagement?.committed) || 0) > 0,
    lastBuyCity: recentBuy ? cityOf(inv.flips?.lastAddress) : "",
    lastBuyYear: recentBuy ? new Date(lastAt).getUTCFullYear() : null,
    purchases: Number(inv.flips?.count) || 0,
    cities,
    types: (m.types || []).slice(0, 3),
    buyBox: box,
  };
}

/**
 * pickPulseBuyers({ investors, pulsedAt, openDraftIds, settings, now }) → { picks, counts }
 *
 * Who gets a pulse check today. Out: no phone, not active, a do-not-text tag,
 * on a live deal (that conversation is about the deal), any message either
 * way in the last `quietDays` (mid-conversation, or a blast just landed), a
 * draft already waiting in the outbox, or pulsed within `everyDays`.
 *
 * Two lines. "quiet" — never wrote back — goes first, best buyer score first
 * (the score already weighs recent purchases and where they buy). "conversed"
 * is deprioritised, not dropped: `conversedShare` percent of the cap is
 * theirs, never less than one a day while any are waiting, longest-silent
 * first. Either line's unused seats go to the other.
 */
export function pickPulseBuyers({ investors = [], pulsedAt = new Map(), openDraftIds = new Set(), stopped = new Set(), paceBy = new Map(), history = new Map(), settings = {}, now = Date.now() } = {}) {
  const s = normalizeBuyerPulse(settings);
  const counts = { pool: investors.length, eligible: 0, friends: 0, afterDeal: 0, quiet: 0, conversed: 0, noPhone: 0, blocked: 0, stopped: 0, onDeal: 0, recentlyTexted: 0, openDraft: 0, pulsedRecently: 0 };
  const quiet = [], conversed = [], friends = [], afterDeal = [];
  // Sent a deal `afterDealDays`–21 days ago and never answered it, nor
  // written since: the house is the way in to "what fits you?".
  const unansweredDeal = (id) => {
    const d = history.get(id)?.lastDeal;
    if (!s.afterDeal || !d || d.answered) return false;
    const age = now - (Date.parse(d.at || "") || 0);
    return age >= s.afterDealDays * DAY_MS && age <= AFTER_DEAL_MAX_DAYS * DAY_MS;
  };
  for (const inv of investors) {
    if (!inv?.contactId || (inv.status && inv.status !== "active")) continue;
    if (!String(inv.phone || "").trim()) { counts.noPhone++; continue; }
    if (isBlockedBuyer(inv)) { counts.blocked++; continue; }
    // You stopped the bot on them (shared/bot-hold.js): no check-in.
    if (stopped.has(inv.contactId)) { counts.stopped++; continue; }
    if (inv.onLiveDeal) { counts.onDeal++; continue; }
    // Check in less / more with this buyer (shared/bot-hold.js): the cadence
    // stretches or shrinks; the quiet days after any text only grow.
    const { rung, floor } = paceScale(paceBy.get(inv.contactId) || 1);
    const last = Math.max(Date.parse(inv.lastMessageAt || "") || 0, Date.parse(inv.lastBlastAt || "") || 0, Date.parse(inv.lastRepliedAt || "") || 0);
    if (last && now - last < s.quietDays * floor * DAY_MS) { counts.recentlyTexted++; continue; }
    if (openDraftIds.has(inv.contactId)) { counts.openDraft++; continue; }
    const pulsed = Date.parse(pulsedAt.get(inv.contactId) || "");
    let cadence = (hasConversed(inv) ? s.everyDays : s.quietEveryDays) * rung;
    // Two in a row with nothing back: they're not looking, or not at us.
    // Asked again in a quarter, not a month — they still get deals that fit.
    if (s.ignoredSlowdown > 0 && (Number(history.get(inv.contactId)?.unansweredPulses) || 0) >= s.ignoredSlowdown) {
      cadence = Math.max(cadence, SLOW_EVERY_DAYS * rung);
    }
    if (Number.isFinite(pulsed) && now - pulsed < cadence * DAY_MS) { counts.pulsedRecently++; continue; }
    counts.eligible++;
    // Bought from us before: a friend, first in line (2026-09-29).
    if ((Number(inv.engagement?.committed) || 0) > 0) friends.push(inv);
    else if (unansweredDeal(inv.contactId)) afterDeal.push(inv);
    else (hasConversed(inv) ? conversed : quiet).push(inv);
  }
  counts.friends = friends.length;
  counts.afterDeal = afterDeal.length;
  counts.quiet = quiet.length;
  counts.conversed = conversed.length;
  // How long one pass through everyone reachable takes at this cap, in
  // workdays — the honest answer to "is everyDays achievable?".
  const reachable = counts.pool - counts.noPhone - counts.blocked - counts.stopped - counts.onDeal;
  counts.passWorkdays = s.dailyCap > 0 ? Math.ceil(Math.max(0, reachable) / s.dailyCap) : null;
  const byName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""));
  quiet.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || byName(a, b));
  const lastTalked = (i) => String(i.lastRepliedAt || i.engagement?.lastEngagedAt || "");
  conversed.sort((a, b) => lastTalked(a).localeCompare(lastTalked(b)) || byName(a, b));

  friends.sort((a, b) => lastTalked(a).localeCompare(lastTalked(b)) || byName(a, b));
  // The deal went out longest ago first: it's the one about to stop being a
  // natural way in.
  const dealAt = (i) => String(history.get(i.contactId)?.lastDeal?.at || "");
  afterDeal.sort((a, b) => dealAt(a).localeCompare(dealAt(b)) || byName(a, b));
  const seatsFriends = Math.min(friends.length, s.dailyCap);
  const seatsAfter = Math.min(afterDeal.length, s.dailyCap - seatsFriends);
  const cap = s.dailyCap - seatsFriends - seatsAfter;
  let seatsConversed = conversed.length ? Math.max(1, Math.round(cap * s.conversedShare / 100)) : 0;
  if (s.conversedShare === 0) seatsConversed = 0;
  seatsConversed = Math.min(seatsConversed, conversed.length, cap);
  let seatsQuiet = Math.min(quiet.length, cap - seatsConversed);
  // Nobody quiet left to fill their seats: the conversed line takes them.
  seatsConversed = Math.min(conversed.length, cap - seatsQuiet);

  const row = (group) => (inv) => ({ contactId: inv.contactId, name: inv.name || "", group, subject: pulseSubject(inv, { now, history: history.get(inv.contactId) || null }) });
  // `spares`: the next in line after the day's picks, so a buyer skipped
  // before being claimed (unsubscribed in GHL) gives the seat to someone.
  const rest = [...afterDeal.slice(seatsAfter).map(row("after_deal")), ...quiet.slice(seatsQuiet).map(row("quiet")), ...conversed.slice(seatsConversed).map(row("conversed"))];
  return {
    picks: [...friends.slice(0, seatsFriends).map(row("friend")), ...afterDeal.slice(0, seatsAfter).map(row("after_deal")), ...quiet.slice(0, seatsQuiet).map(row("quiet")), ...conversed.slice(0, seatsConversed).map(row("conversed"))],
    spares: rest.slice(0, Math.max(5, Math.ceil(s.dailyCap / 2))),
    counts,
  };
}
