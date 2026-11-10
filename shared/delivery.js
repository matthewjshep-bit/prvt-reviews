// delivery.js — did our text actually arrive? (2026-11-09)
//
// GHL takes a text, hands back a message id, and later marks the message
// delivered, failed or undelivered with the carrier's error code. Until now
// nothing read that back: since 10-01, 22 of our answers to someone who had
// just written never arrived (most of them carrier blocks, two on 11-09 alone,
// both to someone asking who we were), and 160 machine texts went to 104 numbers that
// had already come back dead. A 30003 is sometimes temporary (22 of those 160
// got through), so an unreachable phone gets two strikes; a dead number or a
// landline gets one.
//
// Pure. The runner is ghl-broker/delivery-watch.js (off until
// conversationAi.deliveryWatch.enabled). No phone, no message words here or in
// anything this writes: codes, kinds, ids.

import { callEventConnected } from "./talked-to.js";

const HOUR_MS = 3600000;

export const DELIVERY_CURSOR = "deliveryWatch";
// A send that came back failed: data { code, class, kind, channel, draftId,
// answer, messageId, auto }. Deduped on the GHL message id.
export const SEND_FAILED = "send_failed";
// The one retry of a blocked deal text, claimed per buyer per deal before the
// retry is drafted (dedupe retryKey), so a blocked retry is never retried.
export const SEND_RETRIED = "send_retried";
// A text to a number we had as dead was delivered after all (a reply to them,
// a person's send, a new number on the contact): the strikes before it no
// longer count. Written only for a contact numberDead says is dead.
export const PHONE_OK = "phone_ok";
// What numberDead reads: the strikes and the all-clears.
export const PHONE_EVENT_TYPES = Object.freeze([SEND_FAILED, PHONE_OK]);
// The GHL tag a buyer whose phone is dead wears (shared/buyer-pulse.js
// BLOCK_TAG_RX reads it, so no pulse and no deal text picks them again).
export const PHONE_DEAD_TAG = "phone-dead";
// What the stand-down says, on the dismissed draft and the held job.
export const DEAD_NUMBER_LINE = "their number came back dead";

// The window a run reads: sends old enough for the carrier to have answered,
// young enough that a verdict still changes something.
export const DELIVERY_MIN_AGE_MS = 2 * HOUR_MS;
export const DELIVERY_MAX_AGE_MS = 26 * HOUR_MS;
export const DELIVERY_MAX_PER_RUN = 100;
// Every two hours, so every send is looked at about a dozen times inside its
// window, and at most 12 tries a day (a stale or failed run counts as one).
export const DELIVERY_EVERY_MS = 2 * HOUR_MS;
export const DELIVERY_MAX_DAILY_TRIES = 12;
export const DELIVERY_STALE_RUN_MS = 30 * 60 * 1000;
export const DELIVERY_RETRY_GAP_MS = 20 * 60 * 1000;
// A failed answer stays on Needs Matt this long unless something reaches them.
export const UNDELIVERED_ANSWER_DAYS = 7;

// The deal texts a carrier block may retry once (dispoAutopilot.retryBlocked).
export const RETRY_KINDS = Object.freeze(new Set(["blast_open", "blast_nudge"]));
export const retryKey = (offerId, contactId) => `retry:${offerId || "deal"}:${contactId}`;

const FAILED = new Set(["failed", "undelivered", "error", "bounced", "rejected"]);
const PENDING = new Set(["", "pending", "queued", "sending", "scheduled", "accepted", "processing"]);

// Keys never read for a code: what we said, and who to.
const SKIP_KEYS = new Set(["body", "text", "html", "subject", "attachments", "message", "to", "from", "phone", "email"]);
const ERROR_KEY_RX = /err|reason|fail|code|status/i;
const CODE_RX = /\b(30\d{3})\b/;

// Every value under a key that names an error (error, errorMessage, meta's
// error code, a statusReason), and everything inside an object so named.
function errorTexts(o, inError = false, depth = 0, out = []) {
  if (!o || typeof o !== "object" || depth > 4) return out;
  for (const [k, v] of Object.entries(o)) {
    if (SKIP_KEYS.has(k) && !inError) continue;
    const err = inError || ERROR_KEY_RX.test(k);
    if (v && typeof v === "object") errorTexts(v, err, depth + 1, out);
    else if (err && v != null && v !== "") out.push(String(v));
  }
  return out;
}

/**
 * carrierCode(message) → "30007" | null
 *
 * The first carrier code (30000-30999) in a GHL message's error fields. GHL
 * has carried it as "Error 30007" in `error`; other shapes (an error object,
 * meta's fields, a bare number) are read the same way. Never the body: a
 * house number is not an error.
 */
export function carrierCode(m) {
  if (!m || typeof m !== "object") return null;
  const hit = CODE_RX.exec(errorTexts(m).join(" "));
  return hit ? hit[1] : null;
}

/**
 * deliveryVerdict(message) → { status, code, failed, pending }
 *
 * `pending`: GHL hasn't heard from the carrier yet (no verdict is written,
 * the next run looks again). A code with no status is a failure.
 */
export function deliveryVerdict(m) {
  const status = String(m?.status ?? m?.messageStatus ?? "").trim().toLowerCase();
  const code = m?.code != null && CODE_RX.test(String(m.code)) ? CODE_RX.exec(String(m.code))[1] : carrierCode(m);
  const failed = FAILED.has(status) || (!status && Boolean(code));
  return { status: status || (failed ? "failed" : ""), code: code || null, failed, pending: !failed && PENDING.has(status) };
}

/**
 * classifyFailure(code, channel) → "carrier_block" | "dead_number" | "unreachable" | "limit" | "email_policy" | "other"
 */
export function classifyFailure(code, channel = "sms") {
  if (String(channel || "").toLowerCase() === "email") return "email_policy";
  switch (String(code ?? "").trim()) {
    case "30007": return "carrier_block";
    case "30005": case "30006": return "dead_number";
    case "30003": return "unreachable";
    case "30022": case "30023": return "limit";
    default: return "other";
  }
}

// In the words Matt reads them (Needs Matt, Slack, the timeline).
export const FAILURE_WORDS = Object.freeze({
  carrier_block: "the carrier blocked it",
  dead_number: "the number is dead or a landline",
  unreachable: "their phone was unreachable",
  limit: "a sending limit stopped it",
  email_policy: "the email bounced",
  other: "it failed",
});
export const failureWords = (cls) => FAILURE_WORDS[cls] || FAILURE_WORDS.other;

/**
 * numberDead(events) → boolean
 *
 * Their phone is dead to the machine: one text came back as a dead number or
 * a landline (30005, 30006), or two came back unreachable (30003). Emails
 * don't count, and nothing before their newest `phone_ok` (a text that
 * arrived after all) does. `events` are their send_failed and phone_ok
 * events, any order.
 */
export function numberDead(events = []) {
  const okAt = (events || []).filter((e) => e?.type === PHONE_OK).reduce((m, e) => (String(e.at || "") > m ? String(e.at || "") : m), "");
  let unreachable = 0;
  for (const e of events || []) {
    if (e?.type !== SEND_FAILED) continue;
    if (okAt && String(e.at || "") <= okAt) continue;
    const d = e.data || {};
    if (String(d.channel || "sms") !== "sms") continue;
    const cls = d.class || classifyFailure(d.code, "sms");
    if (cls === "dead_number") return true;
    if (cls === "unreachable") unreachable++;
  }
  return unreachable >= 2;
}

// A link, however it was written: a scheme, a www., or a bare domain with a
// path ("deals.example.com/r/ab12").
const URL = String.raw`(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|us|link|ly|me|app|page|site|info|biz)\/\S*`;
const LEAD_AND_URL_RX = new RegExp(String.raw`\s*(?:Photos and numbers|Full package|Everything's here|Details)\s*:\s*(?:${URL})`, "gi");
const URL_RX = new RegExp(URL, "gi");

/**
 * stripLinks(text) → the same text with no link in it
 *
 * What a blocked deal text is retried as: the link is what the carriers
 * block most (memory carrier-30007: 32% of cold deal texts with one, none
 * without). Where the link was the ending, the text ends on the plain
 * question the linkless deal text uses.
 */
export function stripLinks(text = "") {
  const src = String(text || "").trim();
  let t = src.replace(LEAD_AND_URL_RX, "").replace(URL_RX, "");
  if (t === src) return src;
  t = t.replace(/\s*:\s*$/, "").replace(/\s+([.,?!])/g, "$1").replace(/\s{2,}/g, " ").trim();
  if (!/\?$/.test(t)) t = `${t.replace(/[\s.,;:]+$/, "")}. Want the details?`;
  return t;
}

const street = (a) => String(a || "").split(",")[0].trim();

/** undeliveredWhy({ address, cls }) → the Needs Matt line for an answer that never arrived. */
export function undeliveredWhy({ address = "", cls = "other" } = {}) {
  const on = street(address);
  return `Your answer${on ? ` on ${on}` : ""} didn't reach them (${failureWords(cls)}): call or email`;
}

/**
 * deliveryFailed(draft) → boolean
 *
 * The delivery check read this send back and GHL had it failed, undelivered
 * or bounced (`draft.delivery`, written by ghl-broker/delivery-watch.js). A
 * send with no verdict yet is not failed: until the check is on, nothing is.
 */
export const deliveryFailed = (d) => FAILED.has(String(d?.delivery?.status || "").trim().toLowerCase());

// What reaches them after a failed answer, or shows they're still talking:
// a text or call of Matt's, an email either way, or a new text from them.
export const UNDELIVERED_REACHED_TYPES = Object.freeze(["hand_reply", "call_summary", "call_booked", "email_sent", "email_received", "text_summary"]);
const REACHED_TYPES = new Set(UNDELIVERED_REACHED_TYPES);
export const UNDELIVERED_READ_TYPES = Object.freeze([SEND_FAILED, ...REACHED_TYPES]);
// A text summary is them writing again only when it carries their words: the
// reply agent writes one for a check-in of ours too (no inbound), the nightly
// sweep writes its own, and the failed draft wrote one for the text it
// answered. A call counts when somebody talked (a missed call reached nobody).
const reachedThem = (e, failedDraftId) => {
  if (e.type === "call_summary") return callEventConnected(e);
  if (e.type === "text_summary") return e.source !== "sweep" && Boolean(String(e.data?.inbound || "").trim()) && !(e.ref && e.ref === failedDraftId);
  return true;
};

/**
 * undeliveredAnswers(events, { now, days }) → [{ id, kind: "undelivered", contactId, address, offerId, at, title, cls }]
 *
 * One row per agent whose newest failed answer (an answer to their own text,
 * `data.answer`) is in the last `days` and nothing has reached them since.
 * A buyer's is left to Slack and Deals: Needs Matt is an agent's card.
 * A summary the nightly sweep wrote, one with no words of theirs in it (a
 * check-in of ours), or the one the failed draft itself wrote, is not them
 * writing again.
 */
export function undeliveredAnswers(events = [], { now = Date.now(), days = UNDELIVERED_ANSWER_DAYS } = {}) {
  const from = new Date(now - days * 86400000).toISOString();
  const byContact = new Map();
  for (const e of events || []) {
    if (!e?.contactId) continue;
    if (!byContact.has(e.contactId)) byContact.set(e.contactId, []);
    byContact.get(e.contactId).push(e);
  }
  const rows = [];
  for (const [contactId, list] of byContact) {
    const fails = list.filter((e) => e.type === SEND_FAILED && e.data?.answer === true && e.party !== "investor" && String(e.at || "") >= from);
    if (!fails.length) continue;
    const newest = fails.reduce((a, b) => (String(b.at) > String(a.at) ? b : a));
    const reached = list.some((e) => REACHED_TYPES.has(e.type) && String(e.at || "") > String(newest.at) && reachedThem(e, newest.data?.draftId));
    if (reached) continue;
    const cls = newest.data?.class || classifyFailure(newest.data?.code, newest.data?.channel);
    rows.push({
      id: `undelivered:${newest.data?.messageId || newest.id || newest.at}`, kind: "undelivered", contactId,
      address: newest.address || "", offerId: newest.offerId || null, at: newest.at, cls,
      title: undeliveredWhy({ address: newest.address, cls }),
    });
  }
  return rows;
}

const pacificDay = (t) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(t));
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

/**
 * deliveryRunGate(doc, now) → { go, why, day, tries, stale }
 *
 * The tick's decision, gated like the nightly audit: due every
 * DELIVERY_EVERY_MS; a run still on the cursor waits until it is stale, then
 * it is retried; a failed run is retried after DELIVERY_RETRY_GAP_MS; never
 * more than DELIVERY_MAX_DAILY_TRIES tries in a Pacific day.
 */
export function deliveryRunGate(doc = {}, now = Date.now()) {
  const d = doc && typeof doc === "object" ? doc : {};
  const day = pacificDay(now);
  const triesToday = d.day === day ? Number(d.tries) || 0 : 0;
  const no = (why) => ({ go: false, why, day, tries: triesToday, stale: false });
  if (triesToday >= DELIVERY_MAX_DAILY_TRIES) return no(`${DELIVERY_MAX_DAILY_TRIES} tries today`);
  const started = ms(d.run?.startedAt);
  const stale = started != null && now - started >= DELIVERY_STALE_RUN_MS;
  if (started != null && !stale) return no("a run is going");
  const last = ms(d.lastRun);
  const due = last == null || now - last >= DELIVERY_EVERY_MS;
  if (!due && !(stale || d.failed)) return no("not due");
  if (!due && now - last < DELIVERY_RETRY_GAP_MS) return no("retried too recently");
  return { go: true, why: "", day, tries: triesToday + 1, stale };
}
