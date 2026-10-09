// paper-follows.js — the written offer follows the floated number (2026-10-02).
//
// Matt: "send them our offer in the official email text form so that they have
// it in front of them … floating and actually sending the offer should be more
// in line." Over the last 30 days 114 numbers were floated by text and 35 got
// the written offer. The float stays (it asks the agent's read before any
// paper); what changes is that silence no longer leaves the offer unwritten.
// After a working day with no answer, the letter of intent goes out "for your
// records". The pushback half — paper after a no — lives in the reply agent.
//
// Pure: the runner (ghl-broker/routes/offers.js sendPaperAfterSilence) reads
// the offers, drafts and timeline and asks these.

import { effectiveStatus, priceAgreed } from "./offer-status.js";
import { sameStreet } from "./us-address.js";
import { GONE_TEXT } from "./held-underwrites.js";

export const WORK_TZ = "America/Los_Angeles";
const HOUR = 3600000;

// A float older than this isn't followed by paper out of the blue.
export const PAPER_FLOAT_MAX_DAYS = 14;

const ms = (v) => {
  const t = Date.parse(v || "");
  return Number.isFinite(t) ? t : null;
};

function isWeekday(t, tz = WORK_TZ) {
  const wd = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(new Date(t));
  return wd !== "Sat" && wd !== "Sun";
}

/**
 * workingHoursBetween(fromMs, toMs, tz) → hours
 *
 * Clock hours on weekdays (Pacific) between two moments — a number floated
 * Friday at 2pm has had ten working hours by Monday morning, not sixty.
 */
export function workingHoursBetween(fromMs, toMs, tz = WORK_TZ) {
  if (!(toMs > fromMs)) return 0;
  let total = 0;
  // An hour at a time is plenty: the question is "a day or more?", and the
  // window is capped at the float's two-week shelf life.
  const end = Math.min(toMs, fromMs + (PAPER_FLOAT_MAX_DAYS + 3) * 24 * HOUR);
  for (let t = fromMs; t < end;) {
    const next = Math.min(end, t + HOUR);
    if (isWeekday(t, tz)) total += next - t;
    t = next;
  }
  return total / HOUR;
}

/**
 * paperWent(offer) → boolean
 *
 * The written offer reached them on at least one channel. A send attempt that
 * failed everywhere is in `offer.sends` too ("part of the story"), but it is
 * not paper: a nudge that says "we sent you our offer" after one would be
 * false. Old ledger rows without per-channel results count as sent.
 */
export function paperWent(offer) {
  return (offer?.sends || []).some((s) => s?.ts && (!s.results || Object.values(s.results).some((r) => r?.ok)));
}

// A rough number: priced on the agent's own figures because our comps were
// thin (`agent_numbers`), or a first pass marked rough. Paper only after
// they said yes to it (2026-10-08).
export const ROUGH_BASES = new Set(["agent_numbers", "rough"]);

// A reply about this house: it named it, or named none.
function aboutHouse(d, offer) {
  const a = String(d?.propertyAddress || "").trim();
  return !a || !offer?.address || sameStreet(a, offer.address);
}

/**
 * saidYesOn(offer, { drafts, events }) → boolean
 *
 * The agent told us the number on THIS offer works: a realm yes or an agreed
 * price on the offer itself, a realm_yes / acceptance on the timeline tied to
 * it, or a reply the bot read as realm_yes / acceptance about this house
 * since the offer was made.
 */
export function saidYesOn(offer, { drafts = [], events = [] } = {}) {
  if (!offer) return false;
  if (priceAgreed(offer)) return true;
  if ((events || []).some((e) => e?.offerId === offer.id && ["realm_yes", "offer_accepted"].includes(e.type))) return true;
  const since = ms(offer.createdAt) ?? 0;
  return (drafts || []).some((d) => ["realm_yes", "acceptance"].includes(d?.intent) && String(d.inbound || "").trim()
    && (ms(d.createdAt) ?? 0) >= since && aboutHouse(d, offer));
}

/**
 * paperWorthy(offer, { saidYes }) → boolean
 *
 * A number we'd put in writing unasked: a person's own offer, a clean
 * underwrite, or a held one a person published. A rough number — built on
 * the agent's own figures (`basis: "agent_numbers"`) or marked `rough` — only
 * once they said yes to it (`saidYes`, see saidYesOn): silence, a no or a
 * neutral answer never puts it on paper. Never a held draft.
 */
export function paperWorthy(offer, { saidYes = false } = {}) {
  const au = offer?.autoUnderwrite;
  if (!au) return true;
  if (ROUGH_BASES.has(au.basis)) return saidYes === true;
  return au.passed === true || Boolean(au.publishedAt);
}

/**
 * isRoughNumber(offer) → boolean
 *
 * A rough first pass (2026-10-08): the underwrite held on something only we
 * were missing — the size, the photos, thin comps — and priced past it
 * rather than leave a promised number unanswered. It floats as a rough range
 * asking for their read, never as paper, and their numbers re-run it. A
 * person publishing it makes it theirs.
 */
export function isRoughNumber(offer) {
  const au = offer?.autoUnderwrite;
  return Boolean(au && au.basis === "rough" && !au.publishedAt);
}

/**
 * sendsItselfOnClear(offer) → boolean
 *
 * May the written offer go out by itself the moment the underwrite lands
 * (sendOffer.onClearUnderwrite)? Not on the agent's own figures and not on a
 * rough first pass: both are numbers to float, not paper.
 */
export function sendsItselfOnClear(offer) {
  const au = offer?.autoUnderwrite;
  return !au || (au.basis !== "agent_numbers" && au.basis !== "rough");
}

/**
 * floatSentAt(drafts, offerId) → ISO | null
 *
 * When our number on this offer actually went out by text: the latest sent
 * realm-check draft for it. (The offer's `proactive.realmCheckAt` is stamped
 * when the float is drafted, which can be long before it leaves.) A take-check
 * asks for their read and names no number, so it isn't a float to follow.
 */
export function floatSentAt(drafts = [], offerId) {
  const times = (drafts || [])
    .filter((d) => d?.status === "sent" && d.outbound?.kind === "realm_check" && d.outbound?.offerId === offerId)
    .map((d) => d.sentAt || d.updatedAt)
    .filter((t) => ms(t) != null)
    .sort();
  return times.at(-1) || null;
}

/**
 * floatSentIndex(drafts) → Map<offerId, iso>
 *
 * floatSentAt for every offer at once — the Offers list reads the whole
 * book, and one pass over the drafts beats one filter per row.
 */
export function floatSentIndex(drafts = []) {
  const out = new Map();
  for (const d of drafts || []) {
    if (d?.status !== "sent" || d.outbound?.kind !== "realm_check" || !d.outbound?.offerId) continue;
    const t = d.sentAt || d.updatedAt;
    if (ms(t) == null) continue;
    const prev = out.get(d.outbound.offerId);
    if (!prev || String(t) > String(prev)) out.set(d.outbound.offerId, t);
  }
  return out;
}

/**
 * answeredSince(at, { drafts, events }) → boolean
 *
 * They said something after `at`: a text the bot drafted a reply to, a text
 * the timeline summarised, or a call. Then the conversation has it, not a timer.
 */
export function answeredSince(at, { drafts = [], events = [] } = {}) {
  const since = ms(at);
  if (since == null) return false;
  if ((drafts || []).some((d) => String(d?.inbound || "").trim() && (ms(d.createdAt) ?? 0) > since)) return true;
  return (events || []).some((e) => (e?.type === "call_summary" || (e?.type === "text_summary" && String(e?.data?.inbound || "").trim()))
    && (ms(e.at) ?? 0) > since);
}

/**
 * paperAfterSilenceDue({ offer, drafts, events, silenceHours, now }) → { due, reason, floatAt, hours }
 *
 * Whether the written offer should follow a float nobody answered. Every
 * refusal says why, for the runner's log and the tests.
 */
export function paperAfterSilenceDue({ offer, drafts = [], events = [], silenceHours = 24, now = Date.now() } = {}) {
  const no = (reason, extra = {}) => ({ due: false, reason, floatAt: null, hours: 0, ...extra });
  if (!offer || offer.deal) return no("a deal, not an offer");
  const status = effectiveStatus(offer);
  if (!["new", "sent"].includes(status)) return no(`the offer is ${status}`);
  if (!(Number(offer.cashAmount) > 0)) return no("no number on the offer");
  if (paperWent(offer)) return no("the written offer already went");
  if (offer.paperAfterFloat) return no("already tried once");
  if (!paperWorthy(offer)) return no("not a number we put in writing unasked");
  const floatAt = floatSentAt(drafts, offer.id);
  if (!floatAt) return no("our number never went out by text");
  if (now - ms(floatAt) > PAPER_FLOAT_MAX_DAYS * 24 * HOUR) return no("the float is more than two weeks old", { floatAt });
  if (answeredSince(floatAt, { drafts, events })) return no("they answered — the conversation has it", { floatAt });
  const hours = workingHoursBetween(ms(floatAt), now);
  if (hours < silenceHours) return no("not a working day since the float yet", { floatAt, hours });
  return { due: true, reason: "", floatAt, hours };
}

// What ends the neutral rule: they passed, it's gone, they want out, or they
// named their own number (a counter is a person's — NEVER_AUTO).
const NOT_NEUTRAL_INTENTS = new Set(["rejection", "counter", "opt_out"]);
const OUT_TEXT = /\b(?:stop|unsubscribe|remove me|do not (?:text|contact)|don'?t (?:text|contact))\b/i;
const PASS_TEXT = /\b(?:not interested|no thanks|no thank you|(?:we|i|they|seller)(?:'ll| will)? pass(?:ing)?|hard pass|not (?:gonna|going to) work|won'?t work)\b/i;
// The reply to their answer is still with a person (or about to go): the
// paper waits with it, the way the pushback paper does.
const OPEN_DRAFT = new Set(["pending", "draft", "scheduled", "queued", "sending"]);
const YES_INTENTS = new Set(["realm_yes", "acceptance"]);

/**
 * paperAfterAnswerDue({ offer, drafts, events, now }) → { due, reason, floatAt, kind }
 *
 * Whether the written offer should follow a float the agent answered with
 * something other than a pass (`sendOffer.afterFloat.onNeutral`, 2026-10-08).
 * "Can't answer for the seller, call my colleague" was an answer, and got no
 * paper; neither did "I actually agree on those numbers" on an offer priced
 * on her own figures. Every refusal says why.
 *
 * Neutral: every answer since the float, about this house, is not a no, a
 * counter, an opt-out, a pass, or a house that sold or went pending, and our
 * reply to none of them is still waiting. A call since the float is the
 * conversation's. A yes counts too (`kind: "yes"`), and only a yes lets a
 * rough number (paperWorthy) go to paper.
 */
export function paperAfterAnswerDue({ offer, drafts = [], events = [], now = Date.now() } = {}) {
  const no = (reason, extra = {}) => ({ due: false, reason, floatAt: null, kind: null, ...extra });
  if (!offer || offer.deal) return no("a deal, not an offer");
  const status = effectiveStatus(offer);
  if (!["new", "sent"].includes(status)) return no(`the offer is ${status}`);
  if (offer.counterHold?.at) return no("a counter is held for a person");
  if (!(Number(offer.cashAmount) > 0)) return no("no number on the offer");
  if (paperWent(offer)) return no("the written offer already went");
  if (offer.paperAfterFloat) return no("already tried once");
  const floatAt = floatSentAt(drafts, offer.id);
  if (!floatAt) return no("our number never went out by text");
  const floatMs = ms(floatAt);
  if (now - floatMs > PAPER_FLOAT_MAX_DAYS * 24 * HOUR) return no("the float is more than two weeks old", { floatAt });
  if ((events || []).some((e) => e?.type === "unsubscribed")) return no("they unsubscribed", { floatAt });
  if ((events || []).some((e) => e?.type === "call_summary" && (ms(e.at) ?? 0) > floatMs)) return no("a call since the float — the conversation has it", { floatAt });
  const answers = (drafts || []).filter((d) => String(d?.inbound || "").trim() && (ms(d.createdAt) ?? 0) > floatMs
    && (!d.party || d.party === "agent") && aboutHouse(d, offer));
  if (!answers.length) return no("no answer since the float", { floatAt });
  for (const d of answers) {
    const text = String(d.inbound || "");
    if (NOT_NEUTRAL_INTENTS.has(d.intent)) return no(`they answered with a ${String(d.intent).replace(/_/g, " ")}`, { floatAt });
    if (GONE_TEXT.test(text)) return no("they said the house sold or went pending", { floatAt });
    if (OUT_TEXT.test(text)) return no("they asked us to stop", { floatAt });
    if (PASS_TEXT.test(text)) return no("they passed", { floatAt });
    if (Number(d.counterAmount) > 0 || d.inRange) return no("they named a number of their own", { floatAt });
    if (OPEN_DRAFT.has(d.status)) return no("our reply to their answer is still waiting", { floatAt });
  }
  const saidYes = saidYesOn(offer, { drafts, events });
  if (!paperWorthy(offer, { saidYes })) return no("not a number we put in writing unasked", { floatAt });
  return { due: true, reason: "", floatAt, kind: saidYes || answers.some((d) => YES_INTENTS.has(d.intent)) ? "yes" : "neutral" };
}
