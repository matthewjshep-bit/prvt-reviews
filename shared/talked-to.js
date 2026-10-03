// talked-to.js — who we are actually building a relationship with.
//
// "Ever replied" was the nearest thing the Dispositions book had, and it is
// too loose: one "who is this?" or "stop" after a blast makes a stranger look
// engaged. A relationship is a back-and-forth — they wrote to us more than
// once, we spoke on the phone, the bot learned their buy box from them, or
// they did something with a deal we sent.
//
// Pure. The broker tallies messages during the book sync; the page filters.

export const TALK_MIN_REPLIES = 2;
export const CALL_MIN_SECONDS = 30;
// A call that didn't connect, as the Desk's chips (and call-intake) say it.
export const CALL_OUTCOMES = ["no_answer", "voicemail", "call_back"];

// Tags that mean "do not contact" — they never count as a relationship,
// whatever the thread says.
const OPT_OUT_TAGS = new Set(["unsubscribed", "dnc", "dnd", "do-not-contact"]);

const typeOf = (m) => String(m?.messageType || m?.type || "").toUpperCase();
const isCall = (m) => typeOf(m).includes("CALL");
// Voicemail drops, activity rows and the like aren't somebody talking to us.
const isNoise = (m) => /VOICEMAIL|ACTIVITY|OPPORTUNITY|REVIEW|CUSTOM_PROVIDER_CALL_LOG/.test(typeOf(m));

/**
 * connectedCall({ durationSec, status }) → boolean
 *
 * Did somebody actually talk? For a call GHL couldn't (or didn't) transcribe,
 * or whose transcript is a voicemail greeting. A status that says nobody
 * picked up wins; then the length (CALL_MIN_SECONDS); then a completed /
 * answered status. An unknown length and status is not a conversation.
 */
export function connectedCall({ durationSec, status = "" } = {}) {
  const st = String(status || "").toLowerCase();
  if (/no.?answer|busy|fail|cancel|voicemail|missed|unanswered/.test(st)) return false;
  const secs = Number(durationSec);
  if (Number.isFinite(secs) && secs > 0) return secs >= CALL_MIN_SECONDS;
  return st === "completed" || st === "answered";
}

/**
 * callEventConnected(event) → boolean
 *
 * A call_summary on the timeline that was a conversation. Since 2026-10-02 a
 * call that rang out is a call_attempt, but older rows carry the call that
 * rang out as a bare call_summary (no transcript, a few seconds, or a
 * voicemail greeting) — those were never a person talking. A call logged by
 * hand from Matt's own phone has no length and is taken at his word.
 */
export function callEventConnected(e) {
  if (e?.type !== "call_summary") return false;
  const d = e.data || {};
  if (d.tooShort === true) return false;
  if (d.transcribed === false) return connectedCall({ durationSec: d.durationSec, status: d.status });
  return true;
}

function callConnected(m) {
  const meta = m?.meta?.call || m?.meta || {};
  const secs = Number(meta.duration ?? m?.duration ?? NaN);
  const status = String(meta.status || m?.status || "").toLowerCase();
  if (Number.isFinite(secs)) return secs >= CALL_MIN_SECONDS;
  return status === "completed" || status === "answered";
}

/**
 * tallyMessages(messages) → { replies, calls }
 *
 * `replies`: messages they sent us (text, email, chat). `calls`: calls either
 * way that actually connected — a missed call or a ring-out is not a talk.
 */
export function tallyMessages(messages = []) {
  let replies = 0, calls = 0;
  for (const m of messages || []) {
    if (isCall(m)) { if (callConnected(m)) calls++; continue; }
    if (isNoise(m)) continue;
    if (String(m?.direction || "").toLowerCase() === "inbound") replies++;
  }
  return { replies, calls };
}

// Timeline events that only exist because we talked: a call or text you
// logged, and a fact the bot or a call learned from them (not one copied in
// from a GHL field).
export const TALK_EVENT_TYPES = ["call_summary", "text_summary", "fact_learned"];
export function isTalkEvent(ev) {
  if (ev?.type === "call_summary" || ev?.type === "text_summary") return true;
  return ev?.type === "fact_learned" && (ev.source === "conversation" || ev.source === "call");
}

export const RELATIONSHIPS = {
  talking: { label: "Talking to", hint: "A real back-and-forth: they've written more than once, you've spoken on the phone, or they've weighed in on a deal" },
  replied: { label: "Replied once", hint: "Answered us, but there's no conversation yet" },
  no_reply: { label: "No reply", hint: "We've messaged them; they've never answered" },
  never: { label: "Never contacted", hint: "No conversation on record" },
  opted_out: { label: "Opted out", hint: "Tagged unsubscribed or do-not-contact" },
};

/**
 * relationshipOf({ tags, talk, engagement, lastRepliedAt, lastMessageAt }) → key of RELATIONSHIPS
 *
 * `talk` is { replies, calls } from the sync; `engagement` is the timeline
 * tally (buyer-score.js engagementFromEvents), including `talks`.
 */
export function relationshipOf(i = {}) {
  if ((i.tags || []).some((t) => OPT_OUT_TAGS.has(String(t || "").toLowerCase()))) return "opted_out";
  const t = i.talk || {};
  const e = i.engagement || {};
  if ((t.replies || 0) >= TALK_MIN_REPLIES || (t.calls || 0) > 0 || (e.talks || 0) > 0
    || e.evaluating || e.committed || e.passed) return "talking";
  if (i.lastRepliedAt) return "replied";
  if (i.lastMessageAt) return "no_reply";
  return "never";
}

/**
 * matchesText(investor, text) → boolean
 *
 * The page's search box: plain words, every one must appear somewhere in the
 * name, email, phone, company, areas, cities, types or tags. Phone digits
 * match however they're typed.
 */
export function matchesText(i = {}, text = "") {
  const words = String(text || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [
    i.name, i.email, i.companyName, i.buybox?.areasRaw, i.buybox?.exclusions,
    ...(i.markets?.cities || []).map((c) => c.replace(/-/g, " ")),
    ...(i.markets?.regions || []), ...(i.markets?.types || []).map((t) => t.replace(/-/g, " ")),
    ...(i.tags || []),
  ].filter(Boolean).join(" ").toLowerCase();
  const digits = String(i.phone || "").replace(/\D/g, "");
  return words.every((w) => {
    if (hay.includes(w)) return true;
    const d = w.replace(/\D/g, "");
    return d.length >= 3 && d.length === w.replace(/[\s().+-]/g, "").length && digits.includes(d);
  });
}
