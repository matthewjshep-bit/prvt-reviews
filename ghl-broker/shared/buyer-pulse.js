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

export const DEFAULT_DAILY_CAP = 10;
export const MAX_DAILY_CAP = 50;
export const DEFAULT_EVERY_DAYS = 90;
export const DEFAULT_QUIET_DAYS = 7;
// Of each day's texts, the share kept for buyers we have already talked to.
// Without it they would wait behind a thousand who never answered — at ten a
// day, most of a year.
export const DEFAULT_CONVERSED_SHARE = 20;
export const DEFAULT_HOUR = 11; // Pacific, an hour after the agent sweep

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
  return {
    enabled: o.enabled === true,
    autoSend: o.autoSend === true,
    dailyCap: clamp(o.dailyCap, DEFAULT_DAILY_CAP, 1, MAX_DAILY_CAP),
    everyDays: clamp(o.everyDays, DEFAULT_EVERY_DAYS, 30, 365),
    quietDays: clamp(o.quietDays, DEFAULT_QUIET_DAYS, 1, 60),
    conversedShare: clamp(o.conversedShare, DEFAULT_CONVERSED_SHARE, 0, 100),
    hour: clamp(o.hour, DEFAULT_HOUR, 8, 18),
    weekdaysOnly: o.weekdaysOnly !== false,
  };
}

// Tags that mean "do not text", however they were spelled.
const BLOCK_TAG_RX = /^(?:dnc|dnd|do[-\s]?not[-\s]?(?:contact|text|call)|opt(?:ed)?[-\s]?out|unsubscribed?|stop|wrong[-\s]?number)$/i;

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

/**
 * pulseSubject(investor, { now }) → what the message may lean on
 *
 * Context clues, never a dossier: how many deals we have sent them, whether
 * they have ever written back, the CITY of their last financed purchase (a
 * public record — no street, no amount, no lender), where and what they buy,
 * and the buy box if there is one to confirm rather than ask for again.
 */
export function pulseSubject(inv = {}, { now = Date.now() } = {}) {
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
  return {
    dealsSent: Number(inv.engagement?.blasts) || 0,
    conversed: hasConversed(inv),
    passed: Number(inv.engagement?.passed) || 0,
    lookedAtDeals: (Number(inv.engagement?.viewed) || 0) + (Number(inv.engagement?.evaluating) || 0) > 0,
    boughtFromUs: (Number(inv.engagement?.committed) || 0) > 0,
    lastBuyCity: recentBuy ? cityOf(inv.flips?.lastAddress) : "",
    lastBuyYear: recentBuy ? new Date(lastAt).getUTCFullYear() : null,
    purchases: Number(inv.flips?.count) || 0,
    cities: (m.cities || []).slice(0, 3).map(titleCase),
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
export function pickPulseBuyers({ investors = [], pulsedAt = new Map(), openDraftIds = new Set(), settings = {}, now = Date.now() } = {}) {
  const s = normalizeBuyerPulse(settings);
  const counts = { pool: investors.length, eligible: 0, quiet: 0, conversed: 0, noPhone: 0, blocked: 0, onDeal: 0, recentlyTexted: 0, openDraft: 0, pulsedRecently: 0 };
  const quiet = [], conversed = [];
  for (const inv of investors) {
    if (!inv?.contactId || (inv.status && inv.status !== "active")) continue;
    if (!String(inv.phone || "").trim()) { counts.noPhone++; continue; }
    if (inv.dnd || (inv.tags || []).some((t) => BLOCK_TAG_RX.test(String(t).trim()))) { counts.blocked++; continue; }
    if (inv.onLiveDeal) { counts.onDeal++; continue; }
    const last = Math.max(Date.parse(inv.lastMessageAt || "") || 0, Date.parse(inv.lastBlastAt || "") || 0, Date.parse(inv.lastRepliedAt || "") || 0);
    if (last && now - last < s.quietDays * DAY_MS) { counts.recentlyTexted++; continue; }
    if (openDraftIds.has(inv.contactId)) { counts.openDraft++; continue; }
    const pulsed = Date.parse(pulsedAt.get(inv.contactId) || "");
    if (Number.isFinite(pulsed) && now - pulsed < s.everyDays * DAY_MS) { counts.pulsedRecently++; continue; }
    counts.eligible++;
    (hasConversed(inv) ? conversed : quiet).push(inv);
  }
  counts.quiet = quiet.length;
  counts.conversed = conversed.length;
  const byName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""));
  quiet.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || byName(a, b));
  const lastTalked = (i) => String(i.lastRepliedAt || i.engagement?.lastEngagedAt || "");
  conversed.sort((a, b) => lastTalked(a).localeCompare(lastTalked(b)) || byName(a, b));

  let seatsConversed = conversed.length ? Math.max(1, Math.round(s.dailyCap * s.conversedShare / 100)) : 0;
  if (s.conversedShare === 0) seatsConversed = 0;
  seatsConversed = Math.min(seatsConversed, conversed.length, s.dailyCap);
  let seatsQuiet = Math.min(quiet.length, s.dailyCap - seatsConversed);
  // Nobody quiet left to fill their seats: the conversed line takes them.
  seatsConversed = Math.min(conversed.length, s.dailyCap - seatsQuiet);

  const row = (group) => (inv) => ({ contactId: inv.contactId, name: inv.name || "", group, subject: pulseSubject(inv, { now }) });
  return {
    picks: [...quiet.slice(0, seatsQuiet).map(row("quiet")), ...conversed.slice(0, seatsConversed).map(row("conversed"))],
    counts,
  };
}
