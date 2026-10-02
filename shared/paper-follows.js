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

import { effectiveStatus } from "./offer-status.js";

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

/**
 * paperWorthy(offer) → boolean
 *
 * A number we'd put in writing unasked: a person's own offer, a clean
 * underwrite, or a held one a person published. Not a rough number built on
 * the agent's own figures (`basis: "agent_numbers"`), and not a held draft.
 */
export function paperWorthy(offer) {
  const au = offer?.autoUnderwrite;
  if (!au) return true;
  if (au.basis === "agent_numbers") return false;
  return au.passed === true || Boolean(au.publishedAt);
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
