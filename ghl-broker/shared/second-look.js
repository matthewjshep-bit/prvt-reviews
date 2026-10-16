// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// second-look.js — a strong past offer, asked about once more.
//
// The 2026-10-16 audit: 36 offers that died close, with nothing planned.
// They passed, went quiet or countered and stopped; the seller's number (their
// counter, what the agent said the seller needs, or the list price now) sat
// within 15% of ours; and the agent had really talked to us. Matt: "checking
// really good past offers to see if they would reconsider if the margin's good
// enough and the conversation warranted a follow-up".
//
// The second look is one short text naming the street: if the seller is still
// open to it, we can still do our same number — never more — and is it worth
// a quick call. It never asks whether the house sold (Matt, 2026-10-08): a
// house that went pending or sold is skipped, not asked about.
//
// Switch: parties.agent.followUp.secondLook (shared/conversation-ai.js), off.
// The follow-up sweep (ghl-broker/follow-up-sweep.js) reads the rows and
// starts the text; startProactive (reply-agent.js) reads the thread and works
// out the one number it may say (secondLookNumber).
//
// Pure. `now` is passed in.

import { effectiveStatus } from "./offer-status.js";
import { paperWent } from "./paper-follows.js";
import { sameStreet } from "./us-address.js";
import { sentNumber, holdNumber } from "./current-offer.js";
import { realCall } from "./talked-to.js";
import { isAutoReply } from "./brush-offs.js";
import { GONE_TEXT } from "./held-underwrites.js";
import { agentStops } from "./agent-pulse.js";
import { machineMayStart } from "./thread-health.js";
import { focusOf, streetOf } from "./agent-focus.js";
import { normalizeSecondLook } from "./conversation-ai.js";

export { SECOND_LOOK_DEFAULTS, normalizeSecondLook } from "./conversation-ai.js";

const DAY_MS = 86400000;
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };
const kText = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1000)}K`);
const daysAgo = (t, now) => Math.max(0, Math.floor((now - t) / DAY_MS));
const pacificDay = (t) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(t));

// Lost no longer ago than this (the audit's window).
export const SECOND_LOOK_WINDOW_DAYS = 120;
// What the text may run to (the prompt says it; the gate holds it).
export const SECOND_LOOK_MAX_CHARS = 240;
// The outbound kind, and the timeline event a sent one leaves.
export const SECOND_LOOK_KIND = "second_look";
export const SECOND_LOOK_SENT = "second_look_sent";
// The statuses an offer dies in that a second look can revive. A pass of
// ours only when it was over the numbers (numbersPass).
export const SECOND_LOOK_STATUSES = new Set(["passed", "no_response", "countered", "we_passed"]);

// Our pass for what the house IS (or where it is) is never a second look.
const NOT_OUR_KIND_RX = /outside the area|out of (?:the )?area|rural|acre|manufactured|mobile home|park home|condo|townho|multi-?family|duplex|turnkey|move[- ]in ready|renovated|not a (?:fix|flip)|not our kind|wholesaler|never sent/i;

/**
 * numberPresented(offer) → iso | null
 *
 * When our number was in front of them: the letter (a send that went), our
 * number texted (floatSentAt — a number in a plain reply carries only this),
 * or a realm check. Our ARV/rehab read alone is not our number.
 */
export function numberPresented(o) {
  if (!o) return null;
  const sent = (o.sends || []).filter((s) => s?.ts && (!s.results || Object.values(s.results).some((r) => r?.ok))).map((s) => s.ts).sort().at(-1);
  if (paperWent(o) && sent) return sent;
  return o.floatSentAt || o.proactive?.realmCheckAt || null;
}

/**
 * numbersPass(offer) → boolean
 *
 * A pass of OURS that was about the numbers: they countered and we held, or
 * we told them we wouldn't meet their number. Never a pass for the kind of
 * house, the area, or one a sweep closed out.
 */
export function numbersPass(o) {
  if (!o || effectiveStatus(o) !== "we_passed") return false;
  if (o.retired?.by) return false;                         // a sweep closed it, not a conversation
  if (NOT_OUR_KIND_RX.test(String(o.statusNote || ""))) return false;
  if (o.asset?.type && o.asset.type !== "sfr") return false;
  return Number(o.counter?.amount) > 0 || Boolean(o.counterHold?.at);
}

/**
 * theirNumberOn({ offer, events }) → { amount, source, at } | null
 *
 * The closest the seller has come: their counter, what the agent said the
 * seller needs (property_details / house_mentioned sellerAsk on this house),
 * or the list price — the price watch's last look when there is one, else
 * the list price we priced against. The lowest of them.
 */
export function theirNumberOn({ offer = null, events = [] } = {}) {
  if (!offer?.address) return null;
  const out = [];
  const counter = Math.round(Number(offer.counter?.amount) || 0);
  if (counter > 0) out.push({ amount: counter, source: "counter", at: offer.counter.at || null });
  for (const e of events || []) {
    if ((e?.type !== "property_details" && e?.type !== "house_mentioned") || !e.address || !sameStreet(e.address, offer.address)) continue;
    const n = Math.round(Number(e.data?.sellerAsk) || 0);
    if (n > 0) out.push({ amount: n, source: "seller", at: e.at || null });
  }
  const watched = Math.round(Number(offer.priceWatch?.listPrice) || 0);
  const listed = watched || Math.round(Number(offer.askingPrice ?? offer.calc?.inputs?.askingPrice) || 0);
  if (listed > 0) out.push({ amount: listed, source: watched ? "list" : "list_at_pricing", at: watched ? offer.priceWatch.checkedAt || null : null });
  if (!out.length) return null;
  return out.sort((a, b) => a.amount - b.amount || String(b.at || "").localeCompare(String(a.at || "")))[0];
}

/**
 * offMarketOn({ offer, events }) → iso | null
 *
 * The price watch saw the listing go pending or sold, and not come back.
 * Nothing seen is not "gone": an unwatched house is allowed.
 */
export function offMarketOn({ offer = null, events = [] } = {}) {
  if (!offer) return null;
  const pw = offer.priceWatch || {};
  if (pw.offMarketAt && !(pw.backOnMarketAt && String(pw.backOnMarketAt) > String(pw.offMarketAt))) return pw.offMarketAt;
  const mine = (events || []).filter((e) => (e?.type === "listing_off_market" || e?.type === "listing_back_on_market")
    && (e.offerId === offer.id || (e.address && offer.address && sameStreet(e.address, offer.address))));
  const off = mine.filter((e) => e.type === "listing_off_market").map((e) => e.at).sort().at(-1) || null;
  const back = mine.filter((e) => e.type === "listing_back_on_market").map((e) => e.at).sort().at(-1) || null;
  return off && !(back && String(back) > String(off)) ? off : null;
}

// Their texts on the thread, auto-replies left out. The drafts hold the
// recent ones, the timeline's text summaries the older: two records of the
// same messages, so the larger count stands.
function theirInbound({ drafts = [], events = [] } = {}) {
  const fromDrafts = (drafts || []).filter((d) => d && String(d.inbound || "").trim() && !isAutoReply(d.inbound))
    .map((d) => ({ at: d.createdAt, text: String(d.inbound), intent: d.intent, address: d.propertyAddress || "" }));
  const fromEvents = (events || []).filter((e) => e?.type === "text_summary" && String(e.data?.inbound || "").trim() && !isAutoReply(e.data.inbound))
    .map((e) => ({ at: e.at, text: String(e.data.inbound), intent: e.data?.intent, address: e.address || "" }));
  return { count: Math.max(fromDrafts.length, fromEvents.length), all: [...fromDrafts, ...fromEvents] };
}

/**
 * secondLookNumber({ offer, transcript }) → number | null
 *
 * The one number the second look may say: the lowest we have put to them on
 * this house — what went out on the offer, a lower number we texted since, or
 * the last quote that named the house (shared/current-offer.js holdNumber).
 * Never above what we sent.
 */
export function secondLookNumber({ offer = null, transcript = "" } = {}) {
  const sent = sentNumber(offer);
  if (!(sent > 0)) return null;
  const held = holdNumber({ offer, transcript });
  const n = Math.round(Number(held?.amount) || 0);
  return n > 0 ? Math.min(n, sent) : null;
}

/**
 * secondLookDue({ offer, offers, events, drafts, tags, botOffTags, cfg, now })
 *   → { due, why, theirs?, source?, ours?, gapPct?, step? }
 *
 *   offer    the agent's CURRENT row on the house (the caller drops superseded rows)
 *   offers   this agent's offers (lean rows are enough), for one house at a time
 *   events   this agent's timeline
 *   drafts   this agent's reply drafts, any status
 *   cfg      parties.agent.followUp.secondLook
 */
export function secondLookDue({ offer = null, offers = [], events = [], drafts = [], tags = [], botOffTags = [], cfg = {}, now = Date.now() } = {}) {
  const s = normalizeSecondLook(cfg);
  const no = (why) => ({ due: false, why });
  if (!offer?.address || !offer.contactId) return no("no house");
  if (offer.deal) return no("it became a deal");
  const status = effectiveStatus(offer);
  if (!SECOND_LOOK_STATUSES.has(status)) return no(`the offer is ${status.replace(/_/g, " ")}`);
  if (status === "we_passed" && !numbersPass(offer)) return no("we passed on it for what it is, not the numbers");
  if (offer.asset?.type && offer.asset.type !== "sfr") return no("not a house we buy");
  const ours = sentNumber(offer);
  if (!(ours > 0)) return no("no number of ours");
  if (!numberPresented(offer)) return no("our number never went out");

  const settledAt = ms(offer.statusAt) ?? ms(offer.createdAt);
  if (settledAt == null || now - settledAt > SECOND_LOOK_WINDOW_DAYS * DAY_MS) return no(`lost more than ${SECOND_LOOK_WINDOW_DAYS} days ago`);
  if (now - settledAt < s.afterDays * DAY_MS) return no(`it went ${status.replace(/_/g, " ")} ${daysAgo(settledAt, now)} days ago — not ${s.afterDays} yet`);

  // Gone: the price watch saw it go, or they told us.
  if (offMarketOn({ offer, events })) return no("the listing went off the market");
  const inbound = theirInbound({ drafts, events });
  const aboutHouse = inbound.all.filter((m) => !m.address || sameStreet(m.address, offer.address))
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  if (aboutHouse.slice(0, 3).some((m) => GONE_TEXT.test(m.text))) return no("they said it's gone");

  // Close enough to be worth asking.
  const theirs = theirNumberOn({ offer, events });
  if (!theirs) return no("we don't know the seller's number or the list price");
  const gapPct = Math.round(((theirs.amount - ours) / ours) * 1000) / 10;
  if (gapPct > s.withinPct) return no(`their ${kText(theirs.amount)} is ${gapPct}% over our ${kText(ours)}`);

  // An agent who really talked to us.
  const called = (events || []).some((e) => realCall(e));
  if (inbound.count < s.minTheirTexts && !called) return no(`they wrote us ${inbound.count} time${inbound.count === 1 ? "" : "s"} and never on a real call`);

  // Gone quiet: nothing from them, and nothing of ours on this house — a
  // nudge or the counter hold still working it has its own clock.
  const lastIn = Math.max(...inbound.all.map((m) => ms(m.at) ?? 0), ...(events || []).filter((e) => e?.type === "call_summary").map((e) => ms(e.at) ?? 0), 0);
  if (lastIn && now - lastIn < s.afterDays * DAY_MS) return no(`they wrote ${daysAgo(lastIn, now)} days ago — the conversation isn't quiet`);
  const onThisHouse = (x, address) => x.offerId === offer.id || x.outbound?.offerId === offer.id || Boolean(address && sameStreet(address, offer.address));
  const ourOnHouse = Math.max(0,
    ...(drafts || []).filter((d) => d?.status === "sent" && onThisHouse(d, d.propertyAddress || d.outbound?.address)).map((d) => ms(d.sentAt || d.updatedAt || d.createdAt) ?? 0),
    ...(events || []).filter((e) => e?.type === "hand_reply" && onThisHouse(e, e.address)).map((e) => ms(e.at) ?? 0));
  if (ourOnHouse && now - ourOnHouse < s.afterDays * DAY_MS) return no(`we texted them about it ${daysAgo(ourOnHouse, now)} days ago`);

  // Our earlier second looks: on this house, and to this agent at all.
  const looks = (events || []).filter((e) => e?.type === SECOND_LOOK_SENT || (e?.type === "follow_up_sent" && e.data?.kind === SECOND_LOOK_KIND));
  const onHouse = (e) => e.offerId === offer.id || (e.address && sameStreet(e.address, offer.address));
  const sends = looks.filter((e) => e.type === SECOND_LOOK_SENT && onHouse(e));
  if (sends.length >= s.maxPerHouse) return no(`asked ${sends.length} time${sends.length === 1 ? "" : "s"} already`);
  const lastSend = sends.map((e) => e.at).sort().at(-1) || null;
  if (lastSend && aboutHouse.some((m) => m.intent === "rejection" && String(m.at) > String(lastSend))) return no("they said no to the last second look");
  const lastLook = Math.max(0, ...looks.map((e) => ms(e.at) ?? 0));
  if (lastLook && now - lastLook < s.everyDays * DAY_MS) {
    const other = looks.filter((e) => (ms(e.at) ?? 0) === lastLook).find((e) => !onHouse(e));
    return no(other ? `one house at a time — we asked about ${streetOf(other.address)} ${daysAgo(lastLook, now)} days ago` : `the last second look was ${daysAgo(lastLook, now)} days ago`);
  }

  // The agent, not the house: stopped, opted out, annoyed; a live thread;
  // a call queued for them today; another house of theirs in play.
  const stop = agentStops({ drafts, events, tags, botOffTags, now });
  if (stop) return no(stop);
  const may = machineMayStart({ kind: SECOND_LOOK_KIND, drafts, events, offers, address: offer.address, now });
  if (!may.ok) return no(may.reason);
  const today = pacificDay(now);
  if ((events || []).some((e) => e?.type === "ghl_call_queued" && ms(e.at) != null && pacificDay(ms(e.at)) === today)) return no("a call to them is queued in GHL today");
  const focus = focusOf(offers || [], { contactId: offer.contactId });
  if (focus && focus.id !== offer.id && !(focus.address && sameStreet(focus.address, offer.address))) {
    return no(`one house at a time — the live offer on ${streetOf(focus.address)} is what we text them about`);
  }

  const word = { counter: "their counter", seller: "the seller's number", list: "the list price", list_at_pricing: "the list price when we priced it" }[theirs.source];
  return {
    due: true, theirs: theirs.amount, source: theirs.source, ours, gapPct, step: sends.length + 1,
    why: `${word} ${kText(theirs.amount)} is ${gapPct <= 0 ? "at or under" : `${gapPct}% over`} our ${kText(ours)}; ${status.replace(/_/g, " ")} ${daysAgo(settledAt, now)} days ago`,
  };
}
