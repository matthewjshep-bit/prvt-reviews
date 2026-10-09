// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// lead-source.js — how a house came to us.
//
// Matt, 2026-10-09: the deals with committed buyers are the ones closing, and
// all of them came through listing agents. Three of the four were not the
// listing we texted about: the agent brought us another house — a friend's, a
// tenant's tip, a POA they knew — after "if you've got other fixers on your
// radar, I'm all ears" or a "circling back, any fixers?" check-in. Until this,
// nothing in the app could tell that from the listing we opened with, so the
// Line showed every one of them as "listed".
//
//   hook           the listing our outreach opened with (or a listing of
//                  theirs we texted them about since)
//   agent_brought  an agent we reached out to brought us a house we never
//                  raised
//   direct         a house we went after ourselves, with no outreach to that
//                  agent on record (a call on a listing, a house you typed in)
//   unknown        no agent on the offer
//
// Derived on read from what is already stored: the outreach rows (each
// imported agent's hook listing, store.listOutreachHooks) and the contact
// events. Nothing is written.
//
// Pure.

import { sameStreetLoose } from "./us-address.js";

const DAY_MS = 86400000;
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

export const LEAD_SOURCES = ["agent_brought", "hook", "direct", "unknown"];

// Our texts that named a house of theirs: the opener and its follow-ups, and
// a check-in about a fresh listing of theirs.
export const RAISED_EVENT_TYPES = ["outreach_sent", "outreach_enrolled", "agent_pulse_texted", "listing_pinged"];
// Our texts that ask "anything else?": the check-in clock, a check-in they
// asked for, the off-market ask, and the outreach follow-up workflow.
export const CHECKIN_EVENT_TYPES = ["agent_pulse_texted", "checkin_sent", "offmarket_asked", "outreach_enrolled"];
// Every type the reader needs, for one events read.
export const LEAD_EVENT_TYPES = [...new Set([...RAISED_EVENT_TYPES, ...CHECKIN_EVENT_TYPES])];

// A house that turns up this soon after a check-in came from the check-in.
export const CHECKIN_WINDOW_DAYS = 10;

const isCheckin = (e) => CHECKIN_EVENT_TYPES.includes(e?.type)
  // The outreach workflow's first text is the opener, not a check-in; its
  // follow-up ("circling back…") is.
  && (e.type !== "outreach_enrolled" || e.data?.kind === "followup");

/**
 * leadSourceOf({ offer, hooks, events }) → { source, hook, checkin, firstTouchAt, daysToHouse }
 *
 *   offer   { contactId, address, createdAt }
 *   hooks   this agent's outreach rows: [{ address, importedAt }]
 *   events  this agent's contact events (any order; only LEAD_EVENT_TYPES read)
 *
 * `checkin` is true when an agent-brought house came within
 * CHECKIN_WINDOW_DAYS of one of our check-ins. `daysToHouse` is from our first
 * outreach to this offer.
 */
export function leadSourceOf({ offer = {}, hooks = [], events = [] } = {}) {
  const none = { source: "unknown", hook: "", checkin: false, firstTouchAt: null, daysToHouse: null };
  if (!offer?.contactId) return none;
  const at = ms(offer.createdAt) ?? Infinity;
  const before = (e) => (ms(e?.at) ?? Infinity) <= at;
  const ours = (events || []).filter((e) => e && LEAD_EVENT_TYPES.includes(e.type) && before(e));
  const raised = [
    ...(hooks || []).map((h) => h?.address),
    ...ours.filter((e) => RAISED_EVENT_TYPES.includes(e.type)).map((e) => e.address),
  ].filter(Boolean);
  const touches = [
    ...(hooks || []).map((h) => ms(h?.importedAt)),
    ...ours.filter((e) => e.type === "outreach_sent" || e.type === "outreach_enrolled").map((e) => ms(e.at)),
  ].filter((t) => t != null && t <= at);
  const firstTouch = touches.length ? Math.min(...touches) : null;
  const base = {
    hook: (hooks || [])[0]?.address || "",
    firstTouchAt: firstTouch != null ? new Date(firstTouch).toISOString() : null,
    daysToHouse: firstTouch != null && Number.isFinite(at) ? Math.max(0, Math.floor((at - firstTouch) / DAY_MS)) : null,
  };
  if (!raised.length && firstTouch == null) return { ...none, ...base, source: "direct" };
  if (offer.address && raised.some((a) => sameStreetLoose(a, offer.address))) return { ...base, source: "hook", checkin: false };
  const lastCheckin = Math.max(-Infinity, ...ours.filter(isCheckin).map((e) => ms(e.at)).filter((t) => t != null));
  const checkin = Number.isFinite(lastCheckin) && at - lastCheckin <= CHECKIN_WINDOW_DAYS * DAY_MS;
  return { ...base, source: "agent_brought", checkin };
}

/**
 * leadSourcesFor({ offers, hooks, events }) → Map(offerId → leadSourceOf())
 *
 * The whole book at once: hooks and events grouped by contact once.
 */
export function leadSourcesFor({ offers = [], hooks = [], events = [] } = {}) {
  const hooksBy = new Map();
  for (const h of hooks || []) {
    if (!h?.contactId) continue;
    if (!hooksBy.has(h.contactId)) hooksBy.set(h.contactId, []);
    hooksBy.get(h.contactId).push(h);
  }
  const eventsBy = new Map();
  for (const e of events || []) {
    if (!e?.contactId || !LEAD_EVENT_TYPES.includes(e.type)) continue;
    if (!eventsBy.has(e.contactId)) eventsBy.set(e.contactId, []);
    eventsBy.get(e.contactId).push(e);
  }
  const out = new Map();
  for (const o of offers || []) {
    if (!o?.id) continue;
    out.set(o.id, leadSourceOf({ offer: o, hooks: hooksBy.get(o.contactId) || [], events: eventsBy.get(o.contactId) || [] }));
  }
  return out;
}

/**
 * sourceAgents(offers, { names }) → [{ contactId, name, houses, contracts, buyers, firstHouseDays }]
 *
 * The agents who bring us houses (offers annotated with `leadSource`), the
 * ones with a committed buyer first. `firstHouseDays` is how long after our
 * first text their first house came.
 */
export function sourceAgents(offers = [], { names = {}, limit = 12 } = {}) {
  const by = new Map();
  for (const o of offers || []) {
    if (!o || o.status === "draft" || o.supersededBy || o.isCurrent === false) continue;
    if (o.leadSource?.source !== "agent_brought" || !o.contactId) continue;
    const a = by.get(o.contactId) || { contactId: o.contactId, name: o.contactName || names[o.contactId] || "", houses: 0, contracts: 0, buyers: 0, firstHouseDays: null };
    a.houses++;
    if (o.deal) a.contracts++;
    if (o.deal && BUYER_STAGES.has(o.deal.stage)) a.buyers++;
    const d = o.leadSource.daysToHouse;
    if (d != null && (a.firstHouseDays == null || d < a.firstHouseDays)) a.firstHouseDays = d;
    by.set(o.contactId, a);
  }
  return [...by.values()]
    .sort((a, b) => b.buyers - a.buyers || b.contracts - a.contracts || b.houses - a.houses || a.name.localeCompare(b.name))
    .slice(0, limit);
}

// A deal with a committed buyer: found, assigned or closed.
export const BUYER_STAGES = new Set(["buyer_found", "assigned", "closed"]);

/* ---------- their number, against what a buyer pays ---------- */

// The least we keep on a house (Snohomish 23706 and 7034 S K closed at 10–11K).
export const MIN_FEE = 10000;

/**
 * theirNumberCheck({ seller, ceiling, minFee }) → { seller, ceiling, room, fits } | null
 *
 * On the off-market houses that went to a committed buyer we paid at or near
 * the seller's number (98% of ask, the seller's own counter, a matched
 * rival), and it still sat inside what a flipper pays. `ceiling` is
 * buyerCeiling().noFee (pct of ARV − repairs, shared/post-mortem.js); their
 * number fits when it leaves at least `minFee` under it. A flag for the Desk
 * only: nothing here sends a number.
 */
export function theirNumberCheck({ seller = 0, ceiling = 0, minFee = MIN_FEE } = {}) {
  const s = Math.round(Number(seller) || 0);
  const c = Math.round(Number(ceiling) || 0);
  if (!(s > 0) || !(c > 0)) return null;
  const room = c - s;
  return { seller: s, ceiling: c, room, fits: room >= minFee };
}

/* ---------- agents who think like investors ---------- */

// The agents behind the deals with committed buyers (2026-10-09) asked about
// a finder's fee or assigning on day one, owned rentals, or offered to write
// it up and represent us. Their own words, never ours.
export const INVESTOR_MINDED_RX = new RegExp([
  "finder'?s?\\s+fees?", "(?:pay|paying)\\s+(?:a\\s+)?referral",
  "do\\s+you\\s+(?:assign|wholesale|do\\s+assignments)", "are\\s+you\\s+(?:a\\s+)?wholesaler", "work\\s+with\\s+wholesalers",
  "(?:my|our)\\s+(?:own\\s+)?(?:rentals?|rental\\s+propert(?:y|ies)|flips?)", "i\\s+(?:have|own)\\s+(?:a\\s+(?:couple|few)\\s+(?:of\\s+)?|some\\s+|several\\s+)?rentals?", "i\\s+(?:also\\s+)?(?:flip|invest\\s+in|buy)\\s+(?:houses|homes|properties)",
  "(?:happy|glad|can)\\s+(?:to\\s+)?(?:represent\\s+you|write\\s+(?:it|it\\s+up|the\\s+offer)\\s+for\\s+you)", "represent\\s+you\\s+as\\s+(?:your\\s+)?buyer",
  "partner\\s+(?:with\\s+you\\s+)?on\\s+(?:a|the)\\s+flip",
].map((p) => `\\b${p}`).join("|"), "i");

/** investorMindedCue(text) → the phrase that shows it, or "". */
export function investorMindedCue(text = "") {
  const m = String(text || "").match(INVESTOR_MINDED_RX);
  return m ? m[0].trim().toLowerCase() : "";
}

// A house that is someone else's contract being sold on: 9 came to us through
// agents, none reached a committed buyer (daisy chains at retail, a 10k hard
// deposit on Yakima).
export const ASSIGNMENT_RX = /\b(?:assignment|assigning\s+(?:the|their|my)\s+contract|wholesaler|wholesale\s+deal|under\s+contract\s+with\s+an?\s+investor|double\s+clos(?:e|ing)|investorlift)\b/i;
