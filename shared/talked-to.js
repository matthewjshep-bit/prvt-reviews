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

// The words of a voicemail greeting or a carrier's "not available". GHL's
// dialer transcribes the greeting like any call, so an outbound call that
// rang through to voicemail arrives as a transcript of them "talking". Read
// against the whole opening of a call, never a single line of a real one
// (deal-feedback.js keeps its own narrower line filter for that).
const GREETING_RE = /leave (?:me )?(?:your|a)\b|please leave|forwarded to voicemail|is not available|not available (?:right now|to take)|unavailable|record your message|after the (?:tone|beep)|at the tone|you(?:'ve| have)? reached|mailbox/i;
// Matt's own message after the beep: he says who he is.
const OUR_MESSAGE_RE = /\b(?:this is|it'?s|it is) matt\b|\bmatt here\b|\bmatt shepherd\b|\bmatt (?:with|from)\b/i;
const MAX_GREETING_CHARS = 500;
// A message left after the beep is a few sentences; anything longer, or a
// call over two minutes, was a conversation that happened to open oddly.
const MAX_MESSAGE_CHARS = 600;
const MAX_VOICEMAIL_SECONDS = 120;

/**
 * voicemailGreeting(transcript, { durationSec }) → null | { leftMessage }
 *
 * Matt, 2026-10-04: three calls that reached a voicemail greeting ("Hi, this
 * is Hung, sorry I missed your call, please leave me your name and number";
 * "Please leave your message for 2069"; "…8199065 is not available") became
 * texts waiting on him to answer. A greeting is not somebody talking to us.
 *
 * Everything before Matt names himself must read as a greeting and be short:
 * a real conversation is far longer than one, whatever it happens to say.
 * `leftMessage` when he spoke after it. Only an OUTBOUND call's transcript
 * is read this way — on a call to us, the greeting is ours and what follows
 * is them leaving a message.
 */
export function voicemailGreeting(transcript = "", { durationSec = null } = {}) {
  const secs = Number(durationSec);
  if (Number.isFinite(secs) && secs > MAX_VOICEMAIL_SECONDS) return null;
  const lines = String(transcript || "").split(/\n+/).map((l) => l.replace(/^\s*(?:THEM|US|Speaker \d+)\s*:\s*/i, "").trim()).filter(Boolean);
  if (!lines.length) return null;
  const ours = lines.findIndex((l) => OUR_MESSAGE_RE.test(l));
  // Where his message starts: the line that names him, or the greeting-to-him
  // ("Hey, Ren.") right before it.
  const start = ours < 0 ? lines.length : (ours > 0 && lines[ours - 1].length <= 20 && !GREETING_RE.test(lines[ours - 1]) ? ours - 1 : ours);
  const before = lines.slice(0, start).join(" ");
  if (!before || before.length > MAX_GREETING_CHARS || !GREETING_RE.test(before)) return null;
  if (lines.slice(start).join(" ").length > MAX_MESSAGE_CHARS) return null;
  return { leftMessage: ours >= 0 };
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
