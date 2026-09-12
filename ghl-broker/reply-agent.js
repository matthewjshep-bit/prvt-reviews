// reply-agent.js — the Conversation AI: a drafted (and, when allowed, sent)
// reply to an inbound text, from whoever sent it.
//
// GHL's Conversation AI is a generic CRM bot working from a knowledge base: it
// has never seen the offer we sent this agent, or the deal we blasted to this
// investor, and every reply is really a reply about one of those. The broker
// is the one thing that knows them all. So this reads the thread AND the
// right record book — the offer book for a listing agent, the deal book and
// buy box for an investor — and drafts what we would say, in the voice the
// operator set on the Conversation AI page.
//
// What it will and won't do on its own:
//
//   It sends only what the page allows. Each party has an auto-send switch
//   and an allowlist of intents, and NEVER_AUTO (shared/conversation-ai.js)
//   keeps everything that commits us — a number, a time, a document, a deal —
//   off that list whatever the page says. An approved reply is SCHEDULED a
//   few human minutes out, inside quiet hours, and the operator can Hold it.
//   Everything else waits as a draft for a person.
//
//   It never negotiates. A counter, a "call me", a walkthrough, a request for
//   proof of funds — anything that commits us — is drafted as a holding reply
//   and flagged. See evaluateReplyGates, the argument for what may go out
//   unread, and decideAutoSend, the argument for when.
//
//   It never invents a number, and it never leaks one. Every figure in a reply
//   must be in the record book or the inbound message; an investor never
//   hears our contract price or fee. That guard is not a judgment call.
//
//   It triggers what the page wired. An intent can add tags, set a field,
//   drop the contact into a GHL workflow, or run one of the broker's own
//   moves — on its own when the rule says auto and the model was sure,
//   otherwise as a suggestion on the draft row.
//
// Job state is in memory like the underwriter's; the DRAFTS are in the store,
// because a draft that vanishes on a redeploy is a text somebody sent that
// nobody answers. The spend cap reads from the store for the same reason.

import Anthropic from "@anthropic-ai/sdk";
import { buildTranscript, enrichFieldDefs, mergeHistory, mergeFacts, SUBJECT_PROPERTY_FIELD } from "./enrich.js";
import { learnFacts, recordEvent, recordEvents } from "./contact-record.js";
import { BOOKING_INTENTS, looksLikeScheduling, pickSlots, evaluateBookingGuard, bookingContextText } from "./shared/booking.js";
import { getFreeSlots } from "./ghl.js";
import { GUARD_FOR_INTENT } from "./shared/conversation-ai.js";
import { eventFromLedgerLine, normalizePropertyDetails, propertyDossier } from "./shared/contact-record.js";
import { stepLabel, normalizeSteps } from "./shared/follow-up.js";
import { evaluateCounterBand, evaluateAcceptance } from "./shared/auto-accept.js";
// Aliased: this module already has its own OPEN_STATUSES for DRAFT rows.
import { OPEN_STATUSES as OPEN_OFFER_STATUSES, effectiveStatus as offerStatus } from "./shared/offer-status.js";
import { addressKey as propertyKey } from "./shared/us-address.js";
import { findOrCreateCustomFieldByKey, updateContact } from "./ghl.js";
import { matchTagPatterns } from "./conversation-party.js";
import { anthropicErrorToHttp } from "./rehab-scan.js";
import { fmtMoney } from "./shared/offer-calc.js";
import { parseUsAddress, addressKey, lastMention } from "./shared/us-address.js";
import {
  normalizeConversationAi, INTENTS, NEVER_AUTO, GUARDED_AUTO, autoEligible, PARTY_LABEL, CONFIDENCES,
  SILENT_INTENTS, OUTBOUND_INTENTS, detectOptOut, optOutActions, normalizePassReason,
} from "./shared/conversation-ai.js";
import {
  getContact, createContactNote, addContactTags, removeContactTags, sendSms, sendEmail,
} from "./ghl.js";
import { listJobs as listUnderwriteJobs } from "./auto-underwrite.js";
import { resolveParty } from "./conversation-party.js";
import {
  loadContactContext, loadAgentContext, loadInvestorContext, summarizeOffers, RA_OFFERS_IN_CONTEXT, liveDealHold, lessonsContextText } from "./conversation-context.js";
import {
  buildSystemPrompt, buildUserContext, schemaFor, CLASSIFY_SYSTEM, CLASSIFY_SCHEMA, buildClassifyContext,
} from "./conversation-prompt.js";
import { planActions, runActions } from "./conversation-actions.js";
import { pickDelayMs, nextSendTime, spreadAcrossDay, isWeekend } from "./conversation-scheduler.js";

// What the machine STARTS is spread across the day and skips weekends
// (unless the page says otherwise); what it ANSWERS goes in human minutes.
const STARTED_KINDS = new Set(["offer_nudge", "blast_nudge", "dataroom_nudge", "outreach_nudge", "outreach_open"]);
function scheduleFor({ config, now, kind = null, intent = "", replyLength = 0, random = Math.random }) {
  const a = config.autoSend || {};
  if (kind && STARTED_KINDS.has(kind)) {
    return spreadAcrossDay({ now, quietHours: a.quietHours, hours: a.nudgeSpreadHours ?? 8, random, weekends: a.weekends || "all" });
  }
  const at = nextSendTime({ now, delayMs: pickDelayMs(config, random, { intent, replyLength }), quietHours: a.quietHours });
  // A reply on a weekend goes unless the page says nothing does.
  if (a.weekends === "none" && isWeekend(Date.parse(at), a.quietHours?.timeZone || "UTC")) {
    return spreadAcrossDay({ now: Date.parse(at), quietHours: a.quietHours, hours: 0, random, weekends: "none" });
  }
  return at;
}

export { summarizeOffers, RA_OFFERS_IN_CONTEXT };

/* ---------- the dials ---------- */

export const RA_DEFAULT_DAILY_CAP = 60;   // drafts per location per day (the page can change it)
export const RA_MAX_SMS_CHARS = 480;      // three segments; longer than that is an email
export const RA_MAX_CONCURRENT = 2;

export const RA_TAGS = {
  draft: process.env.REPLY_DRAFT_TAG || "reply-draft",
};

// The first version's names, kept for callers and tests: the agent vocabulary
// and the agent auto-eligible set. The per-party truth is in
// shared/conversation-ai.js.
export const REPLY_INTENTS = INTENTS.agent;
export const AUTO_SENDABLE_INTENTS = new Set(autoEligible("agent"));

// The effective config for a location. Seeds from the first version's two
// settings when the page has never been saved, so nothing changes for an
// account that never opened it.
export function conversationConfig(saved = {}) {
  return normalizeConversationAi(saved?.conversationAi, {
    instructions: saved?.replyAgentInstructions,
    dailyCap: saved?.replyAgentDailyCap,
    signer: saved?.company?.signer || saved?.company?.name,
  });
}

/* ---------- job registry ---------- */

const jobs = new Map();
const lanes = new Map();
let seq = 0;
const newJobId = () => `ra-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function getJob(id) {
  return jobs.get(id) || null;
}

export function listJobs(locationId, { limit = 25 } = {}) {
  return [...jobs.values()]
    .filter((j) => j.locationId === locationId)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, limit);
}

export function publicJob(job) {
  if (!job) return null;
  return { ...job };
}

export function _resetJobs() {
  jobs.clear();
  lanes.clear();
  for (const w of waiting.values()) clearTimeout(w.timer);
  waiting.clear();
}

/* ---------- spend guard ---------- */

const dayStartIso = (now = Date.now()) => {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
};

// Drafts started today, from the STORE plus whatever is in flight — the same
// shape as the underwriter's guard, for the same reason: a crash loop must not
// hand a misconfigured workflow a fresh budget every restart.
export async function countToday({ store, locationId, now = Date.now() }) {
  const since = dayStartIso(now);
  const ids = new Set();
  for (const j of jobs.values()) {
    if (j.locationId === locationId && String(j.startedAt) >= since) ids.add(j.id);
  }
  const rows = await store.listReplyDrafts(locationId, { since, limit: 500 }).catch(() => []);
  for (const d of rows) if (d?.jobId) ids.add(d.jobId);
  return ids.size;
}

/* ---------- the draft ---------- */

/**
 * draftReply({ party, config, context, message, transcript, contact, underwriting, instructions, signer, aiApiKey, channel })
 *
 * One Claude call. Pure with respect to everything but the model. `offers`
 * is still accepted for the first version's callers and becomes the context
 * when none is given.
 */
export async function draftReply({
  message, transcript = "", offers = { text: "", amounts: [], count: 0 }, contact = {},
  underwriting = [], instructions = "", signer = "", aiApiKey, companyContact = {},
  party = "agent", config = null, context = null, channel = "sms", outbound = null, booking = false, inboundKind = "text", call = null,
}) {
  const client = new Anthropic({ apiKey: aiApiKey, timeout: 120_000 });
  const cfg = config || normalizeConversationAi(null);
  const ctx = context || {
    text: offers.count
      ? `OUR OFFERS TO THIS AGENT (newest first — the only numbers you may quote):\n${offers.text}`
      : "",
  };
  const system = buildSystemPrompt({ config: cfg, party, channel });
  const user = buildUserContext({ party, contact, signer, instructions, context: ctx, underwriting, transcript, message, outbound, inboundKind, call, companyContact });
  const intents = outbound ? [outbound.kind] : (INTENTS[party] || INTENTS.agent);

  let response;
  try {
    response = await client.beta.messages.create({
      model: "claude-opus-5",
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      // Unattended: a refusal on "answer a text about a house" is near
      // impossible, and the server-side fallback removes the failure mode.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      // The system prompt is the same bytes for every draft this location
      // sends to this party on this channel, so it caches. Replies to a blast
      // arrive in a wave; each one after the first reads the persona, the
      // playbook, the house rules and the examples at a tenth of the price.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      // Answering a text is not a reasoning problem. The default (high) buys
      // thinking this job has no use for and bills it as output.
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: schemaFor(party, { outbound, booking: Boolean(booking) }) },
      },
      messages: [{ role: "user", content: [{ type: "text", text: user }] }],
    });
  } catch (e) {
    throw anthropicErrorToHttp(e);
  }
  if (response.stop_reason === "max_tokens") {
    throw Object.assign(new Error("reply drafting was truncated"), { http: 502 });
  }
  if (response.stop_reason === "refusal") {
    throw Object.assign(new Error("reply drafting was declined"), { http: 502 });
  }
  const raw = response.content.find((b) => b.type === "text")?.text || "{}";
  const p = JSON.parse(raw);
  return {
    intent: intents.includes(p.intent) ? p.intent : "other",
    confidence: CONFIDENCES.includes(p.confidence) ? p.confidence : "low",
    reply: scrubReply(String(p.reply || "").trim(), cfg.style),
    needsHuman: Boolean(p.needsHuman),
    humanReason: String(p.humanReason || "").trim().slice(0, 300),
    summary: String(p.summary || "").trim().slice(0, 300),
    propertyAddress: String(p.propertyAddress || "").trim().slice(0, 200),
    counterAmount: Math.max(0, Number(p.counterAmount) || 0),
    // Investors only, and only when they turned something down.
    passReason: normalizePassReason(p.passReason),
    // Agents only: what THEY think it's worth and costs. Theirs, never ours.
    agentTake: normalizeAgentTake(p),
    // Agents only: what this message added to the property's dossier.
    propertyDetails: normalizePropertyDetails(p.propertyDetails),
    profile: normalizeProfile(p.profile),
    // The calendar: which of the handed-in times the reply used, and which
    // previously offered one this message picked. Checked, not trusted.
    offeredSlots: Array.isArray(p.offeredSlots) ? p.offeredSlots.map(String).slice(0, 5) : [],
    chosenSlot: String(p.chosenSlot || "").trim().slice(0, 40),
  };
}

// The agent's own read on a property — ARV and rehab as they see it. Kept
// apart from every number of ours so it can be laid beside them, never
// mistaken for them.
export function normalizeAgentTake(p) {
  const arv = Math.max(0, Math.round(Number(p?.agentArv) || 0));
  const rehab = Math.max(0, Math.round(Number(p?.agentRehab) || 0));
  const note = String(p?.agentTakeNote || "").trim().slice(0, 200);
  return arv || rehab ? { arv, rehab, note } : null;
}

// What the model learned, trimmed to what the fields can hold.
export function normalizeProfile(p) {
  if (!p || typeof p !== "object") return null;
  const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
  const out = {
    personalDetails: str(p.personalDetails, 400),
    marketAreas: str(p.marketAreas, 300),
    dealHistoryLine: str(p.dealHistoryLine, 300),
    nextAction: str(p.nextAction, 300),
    priceMin: Math.max(0, Math.round(Number(p.priceMin) || 0)),
    priceMax: Math.max(0, Math.round(Number(p.priceMax) || 0)),
    propertyTypes: str(p.propertyTypes, 120).toLowerCase(),
    rehabAppetite: ["cosmetic_only", "moderate", "heavy", "full_gut"].includes(p.rehabAppetite) ? p.rehabAppetite : "",
    exclusions: str(p.exclusions, 300),
  };
  const any = Object.values(out).some((v) => (typeof v === "number" ? v > 0 : Boolean(v)));
  return any ? out : null;
}

// The em dash is the tell of a bot. The model is told not to; this is the
// net under it. A comma reads right in a text almost everywhere a dash did.
export function scrubReply(reply, style = {}) {
  if (!style?.noEmDashes) return reply;
  return String(reply || "")
    .replace(/\s*[\u2014\u2013]\s*/g, ", ")
    .replace(/^,\s*/, "").replace(/,\s*$/, "").replace(/,\s*,/g, ",")
    .trim();
}

/**
 * classifyParty({ contact, transcript, message, aiApiKey }) → { party, confidence, reason }
 *
 * The GHL "master bot", reduced to one cheap structured call. Only runs for
 * a contact whose tags say nothing and only when the page asks for it.
 */
export async function classifyParty({ contact = {}, transcript = "", message = "", aiApiKey }) {
  const client = new Anthropic({ apiKey: aiApiKey, timeout: 60_000 });
  let response;
  try {
    response = await client.beta.messages.create({
      model: "claude-sonnet-5",
      // Adaptive thinking is on whenever `thinking` is omitted, and 400 was a
      // ceiling from before that — enough reasoning to run past it and hand
      // back truncated JSON. Low effort for a three-way call, and room to land.
      max_tokens: 1200,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: CLASSIFY_SYSTEM,
      output_config: { format: { type: "json_schema", schema: CLASSIFY_SCHEMA } },
      messages: [{ role: "user", content: [{ type: "text", text: buildClassifyContext({ contact, transcript, message }) }] }],
    });
  } catch (e) {
    throw anthropicErrorToHttp(e);
  }
  // A truncated classification is unparseable JSON; unknown is the honest
  // answer and routing already knows what to do with it.
  if (response.stop_reason === "max_tokens" || response.stop_reason === "refusal") {
    return { party: "unknown", confidence: "low", reason: "classification did not complete" };
  }
  const raw = response.content.find((b) => b.type === "text")?.text || "{}";
  const p = JSON.parse(raw);
  return {
    party: p.party === "agent" || p.party === "investor" ? p.party : "unknown",
    confidence: CONFIDENCES.includes(p.confidence) ? p.confidence : "low",
    reason: String(p.reason || "").slice(0, 200),
  };
}

/* ---------- the gates ---------- */

// Money the way people text it: "$525,000", "$525k", "525k", "1.2M", "525,000".
// A bare "14" (days) or "2026" is not money and must not trip the guard.
const MONEY_RE = /\$\s?\d[\d,]*(?:\.\d+)?\s?[kKmM]?\b|\b\d+(?:\.\d+)?\s?[kK]\b|\b\d+(?:\.\d+)?\s?[mM]\b|\b\d{1,3}(?:,\d{3})+\b/g;

export function moneyIn(text) {
  const out = [];
  for (const m of String(text || "").matchAll(MONEY_RE)) {
    const s = m[0].replace(/[$,\s]/g, "");
    const suffix = s.slice(-1).toLowerCase();
    const base = Number(suffix === "k" || suffix === "m" ? s.slice(0, -1) : s);
    if (!Number.isFinite(base)) continue;
    out.push(Math.round(suffix === "k" ? base * 1e3 : suffix === "m" ? base * 1e6 : base));
  }
  return out;
}

/**
 * Everything that has to be true before a drafted reply could go out with
 * nobody reading it. Pure — this is the function to read if you want to know
 * what the agent would and wouldn't say on its own.
 *
 * Returns { ok, flags: [reason] }. `ok` alone never sends: decideAutoSend
 * adds the page's own switches. But `ok` is recorded beside every draft, so
 * "could this have gone out by itself?" is a count, not a guess.
 */
// An agent's text opens "Hi Matt," and the model, mirroring, answers "Thanks,
// Matt." (Nate Wright, 1322 N Mamer Rd, 2026-09-03). Our own first name used
// as a greeting or address, never as "I'm Matt" or the sign-off, is flagged,
// unless they share it.
const firstNameOf = (s) => String(s || "").trim().split(/\s+/)[0] || "";
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function callsThemOurName(reply, { selfName = "", contactName = "", signOff = "" } = {}) {
  const ours = firstNameOf(selfName);
  if (ours.length < 2 || !reply) return false;
  if (ours.toLowerCase() === firstNameOf(contactName).toLowerCase()) return false;
  const n = escapeRe(ours);
  let text = String(reply).trim();
  const so = String(signOff || "").trim();
  if (so && text.toLowerCase().endsWith(so.toLowerCase())) text = text.slice(0, -so.length).trim();
  // Our name as the LAST thing in the message is us signing off, not us
  // addressing them — the check-in drafts end "Thanks, Matt" and are fine.
  text = text.replace(new RegExp(`(?:[\\n.!?,]|\\s[-–—])\\s*(?:thanks|thank you|talk soon|best|cheers)?[,]?\\s*${n}[.!]?$`, "i"), "");
  // What went wrong with Nate: the greeting mirrored straight back at them.
  const greeting = new RegExp(`^\\s*(hi|hey|hello|thanks|thank you|thx|ty|appreciate it|sounds good|ok|okay|got it|morning|afternoon)[,!]?\\s+${n}\\b`, "i");
  const vocative = new RegExp(`(^|[,.!?]\\s+)${n}\\s*[,.!?]`, "i");
  return greeting.test(text) || vocative.test(text);
}

// How sure is sure enough. "medium" lets a draft the model was fairly sure
// of go on its own; "high" waits for a person unless it was certain.
const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };

export function evaluateReplyGates({
  draft, party = "agent", allowedAmounts = [], forbiddenAmounts = [], inboundMessage = "", channel = "sms", style = null,
  minConfidence = "high", holdOnNeedsHuman = true, selfName = "", contactName = "", signOff = "",
}) {
  const flags = [];
  if (!draft) return { ok: false, flags: ["no draft was produced"] };
  if (callsThemOurName(draft.reply, { selfName, contactName, signOff })) {
    flags.push(`the draft calls them "${firstNameOf(selfName)}", which is our name, not theirs`);
  }
  const never = NEVER_AUTO[party] || NEVER_AUTO.agent;
  const maxSms = Number(style?.maxSmsChars) > 0 ? Number(style.maxSmsChars) : RA_MAX_SMS_CHARS;

  const known = [...(INTENTS[party] || INTENTS.agent), ...(OUTBOUND_INTENTS[party] || [])];
  if (never.includes(draft.intent) || !known.includes(draft.intent)) {
    flags.push(`a ${String(draft.intent).replace(/_/g, " ")} is a person's call`);
  }
  // The model's own "needs a human" is usually about an ACTION beside the
  // reply — "a person has to send the package" — not the reply itself. The
  // page decides whether it holds the send; the reason is kept on the draft
  // either way.
  if (draft.needsHuman && holdOnNeedsHuman) {
    flags.push(draft.humanReason || "the model asked for a person");
  }
  if ((CONFIDENCE_RANK[draft.confidence] ?? 0) < (CONFIDENCE_RANK[minConfidence] ?? 2)) {
    flags.push(`the model was only ${draft.confidence} confidence`);
  }
  if (draft.intent !== "small_talk" && !draft.reply) {
    flags.push("the draft came back empty");
  }
  if (channel === "sms" && draft.reply.length > maxSms) {
    flags.push(`${draft.reply.length} characters is too long for a text`);
  }
  // Carrier filters key on these two; the page decides whether they hold.
  if (channel === "sms" && style?.noDollarSigns && /\$/.test(draft.reply)) {
    flags.push("a dollar sign in a text trips carrier spam filters");
  }
  if (channel === "sms" && style?.noLinks && /https?:\/\/|www\./i.test(draft.reply)) {
    flags.push("a link in a text trips carrier spam filters");
  }
  // The two rules that are not judgment calls. A number the other side must
  // never hear — our contract price, our fee — is flagged even if they said
  // it first. And a number that is in neither the record book nor their own
  // message was made up, which is the worst thing this could do.
  const said = moneyIn(draft.reply);
  const forbidden = new Set(forbiddenAmounts.map((n) => Math.round(n)));
  const leaked = said.filter((n) => forbidden.has(n));
  if (leaked.length) {
    flags.push(`the draft names ${[...new Set(leaked)].map((n) => fmtMoney(n)).join(", ")}, which is our contract price or assignment fee`);
  }
  const allowed = new Set([...allowedAmounts, ...moneyIn(inboundMessage)].map((n) => Math.round(n)));
  const invented = said.filter((n) => !allowed.has(n) && !forbidden.has(n));
  if (invented.length) {
    flags.push(`the draft names ${[...new Set(invented)].map((n) => fmtMoney(n)).join(", ")}, which is not in the ${party === "investor" ? "deal book" : "offer book"}`);
  }
  // `ok` is the row's word — a counter is not auto-sendable, full stop. But
  // the lock is the ONE flag a guard may overturn, so it is named apart from
  // the rest: `clean` says every OTHER gate passed. decideAutoSend lets a
  // locked-but-clean draft fall through to the never_auto code, which is the
  // only code releaseUnderGuard will open. Without this the band and the
  // calendar could never release anything — the lock tripped "gates" first.
  const locked = flags.find((f) => / is a person's call$/.test(f)) || null;
  return { ok: flags.length === 0, flags, locked, clean: flags.filter((f) => f !== locked).length === 0 };
}

/**
 * decideAutoSend({ gate, party, intent, channel, config, sendsEnabled })
 *
 * The page's switches, on top of the gates. Returns { send, reason } with the
 * FIRST reason it won't, in the operator's words — that line is stored on the
 * draft and shown on the row, so "why didn't it send itself?" is answered
 * before it is asked.
 */
export function decideAutoSend({ gate, party = "agent", intent = "other", channel = "sms", config, sendsEnabled = false, humanActive = null }) {
  if (!gate?.ok && !(gate?.locked && gate?.clean)) return { send: false, code: "gates", reason: gate?.flags?.[0] ? `needs a person: ${gate.flags[0]}` : "the gates did not pass" };
  if (!config?.enabled) return { send: false, code: "bot_off", reason: "Conversation AI is switched off" };
  if (humanActive) return { send: false, code: "human_active", reason: `you replied to them ${humanActive.minutesAgo} minute${humanActive.minutesAgo === 1 ? "" : "s"} ago — you have the thread` };
  if (!sendsEnabled) return { send: false, code: "sends_off", reason: "sends are off on the broker (CARD_SENDS_ENABLED)" };
  const playbook = config.parties?.[party];
  if (!playbook) return { send: false, code: "unknown_party", reason: "an unknown contact never auto-sends" };
  if (!playbook.autoSend?.enabled) return { send: false, code: "party_off", reason: `auto-send is off for ${PARTY_LABEL[party].toLowerCase()}s` };
  // The one refusal the counter band may overturn — and the ONLY one. The
  // code is what releaseUnderGuard keys on, so a draft held for any other
  // reason can never be released by a guard passing.
  if ((NEVER_AUTO[party] || []).includes(intent)) return { send: false, code: "never_auto", reason: `a ${intent.replace(/_/g, " ")} is a person's call` };
  if (!(playbook.autoSend.intents || []).includes(intent)) return { send: false, code: "not_allowlisted", reason: `${intent.replace(/_/g, " ")} is not on the ${party} auto-send list` };
  if (!(config.autoSend?.channels || []).includes(channel)) return { send: false, code: "channel", reason: `${channel} replies don't auto-send` };
  return { send: true, code: "", reason: "" };
}

/**
 * releaseUnderGuard({ base, party, intent, config, guard }) → { send, reason, exception }
 *
 * The one door through NEVER_AUTO, and it opens only when every one of these
 * holds: the base decision was blocked BY NEVER_AUTO AND BY NOTHING ELSE, the
 * intent is in GUARDED_AUTO, the band is switched on, and a structural guard —
 * a check on numbers, not a judgment on words — passed on this very message.
 *
 * `base.code === "never_auto"` is the load-bearing line. It means the band can
 * overturn one specific objection and no other: a draft that invented a
 * number, or arrived while the bot was off, or while a person had the thread,
 * is never released however well the arithmetic checks out.
 */
export function releaseUnderGuard({ base, party = "agent", intent = "other", config, guard = null }) {
  if (base?.send) return { ...base, exception: null };
  if (base?.code !== "never_auto") return { ...base, exception: null };
  if (!(GUARDED_AUTO[party] || []).includes(intent)) return { ...base, exception: null };
  if (!guard) return { ...base, exception: null };
  // The guard has to be the RIGHT guard for the intent: a passing counter
  // band never releases a "wants a call", and a booking never releases a
  // counter. Each family has its own switch on the page.
  const family = guard.kind === "booking" ? "booking" : "band";
  if (GUARD_FOR_INTENT[intent] !== family) return { ...base, exception: null };
  const on = family === "booking" ? config?.booking?.enabled : config?.parties?.[party]?.counterBand?.enabled;
  if (!on) return { ...base, exception: null };
  if (!guard.passed) {
    return { send: false, code: "guard_failed", reason: `needs a person: ${guard.reason || (family === "booking" ? "the calendar did not open" : "the band did not open")}`, exception: guard };
  }
  return {
    send: true, code: "released",
    reason: family === "booking"
      ? `released under the calendar — ${guard.reason}`
      : `released under the counter band — ${fmtMoney(guard.theirAmount)} is at or under the ${fmtMoney(guard.ceiling)} ceiling`,
    exception: guard,
  };
}

/* ---------- the calendar ---------- */

const BOOKING_LOOKBACK_MS = 7 * 86400000;

/**
 * prepareBooking({ client, store, locationId, contactId, party, message, config, now, deps })
 *   → { offered, previouslyOffered, freeSlots } | null
 *
 * Reads the calendar only when a time could be on the table: the page has
 * booking on with a calendar picked, and either this message sounds like
 * scheduling or we recently offered them times (so a bare "the second one"
 * still resolves). One GHL read; `deps.freeSlots` replaces it in tests.
 */
export async function prepareBooking({ client, store, locationId, contactId, party, message = "", config, now = Date.now(), deps = {} }) {
  const bk = config?.booking;
  if (!bk?.enabled || !bk.calendarId || !BOOKING_INTENTS[party]) return null;
  let previouslyOffered = [];
  try {
    const rows = await store.listReplyDrafts(locationId, { contactId, since: new Date(now - BOOKING_LOOKBACK_MS).toISOString(), limit: 20 });
    const last = rows
      .filter((d) => (d.status === "sent" || d.status === "scheduled") && Array.isArray(d.booking?.offered) && d.booking.offered.length)
      .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))[0];
    previouslyOffered = last ? last.booking.offered : [];
  } catch { previouslyOffered = []; }
  if (!previouslyOffered.length && !looksLikeScheduling(message)) return null;

  const timeZone = config.autoSend?.quietHours?.timeZone || "America/Los_Angeles";
  const read = typeof deps.freeSlots === "function"
    ? deps.freeSlots
    : ({ startMs, endMs }) => getFreeSlots(client, bk.calendarId, { startMs, endMs, timeZone });
  let freeSlots = [];
  try {
    freeSlots = await read({ startMs: now, endMs: now + bk.daysAhead * 86400000, calendarId: bk.calendarId, timeZone });
  } catch (e) {
    return { offered: [], previouslyOffered, freeSlots: [], error: String(e?.message || e).slice(0, 160) };
  }
  const offered = pickSlots(freeSlots, { now, count: bk.slotsToOffer, minLeadHours: bk.minLeadHours, timeZone });
  return { offered, previouslyOffered, freeSlots, error: null };
}


/* ---------- the counter band ---------- */

/**
 * bandReleasesToday({ store, locationId, now }) → number
 *
 * How many drafts the band has already released today, read from the STORE
 * rather than a counter in memory — the same discipline the underwriter's
 * spend rails keep, and for the same reason: a crash loop must not hand a
 * misconfigured setup a fresh budget every restart.
 */
export async function bandReleasesToday({ store, locationId, now = Date.now() }) {
  const d = new Date(now);
  const dayStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
  const rows = await store.listReplyDrafts(locationId, { since: dayStart, limit: 500 }).catch(() => []);
  return rows.filter((r) => r?.exception?.passed).length;
}

/**
 * evaluateBandFor({ store, locationId, party, draft, config, saved, job, now })
 *   → verdict | null
 *
 * Runs the guard whenever the intent is one a guard COULD release and the band
 * is switched on — pass OR fail, because the verdict is written onto every
 * such draft and a failed one is the most useful row in the outbox.
 *
 * Returns null when the band is off or the intent isn't guardable, so nothing
 * is computed (and no store reads happen) on the ordinary path.
 */
export async function evaluateBandFor({ store, locationId, party, draft, config, saved, job, now = Date.now() }) {
  const band = config?.parties?.[party]?.counterBand;
  if (!band?.enabled) return null;
  if (!(GUARDED_AUTO[party] || []).includes(draft?.intent)) return null;

  const rows = await store.listOffers(locationId, { contactId: job.contactId, limit: 50, lean: true }).catch(() => []);
  const open = rows.filter((o) => o && !o.deal && OPEN_OFFER_STATUSES.has(offerStatus(o)));
  if (!open.length) {
    return { kind: draft.intent === "acceptance" ? "acceptance_band" : "counter_band", passed: false,
             checks: [{ name: "offer_live", ok: false, detail: "no open offer" }],
             reason: "no open offer to answer", at: new Date(now).toISOString() };
  }
  const picked = pickOfferByAddress(open, draft.propertyAddress) || (open.length === 1 ? open[0] : null);
  // The full doc, for the calc settings the offer was priced with — the lean
  // row deliberately drops them, and the ceiling wants the snapshot.
  const full = picked ? (await store.getOffer(picked.id).catch(() => null)) || picked : null;
  const releasedToday = await bandReleasesToday({ store, locationId, now });
  const args = { offer: full, draft, inboundMessage: job.message || "", settings: saved || {},
                 band, openOffers: open, releasedToday, now, moneyIn };
  return draft.intent === "acceptance" ? evaluateAcceptance(args) : evaluateCounterBand(args);
}

// The offer the message is about. Exact address key first, then a loose
// containment match on the street line — the same two-step the routes use.
function pickOfferByAddress(offers, hint) {
  const want = String(hint || "").trim();
  if (!want) return null;
  const key = propertyKey(want);
  const exact = offers.find((o) => propertyKey(o.address) === key);
  if (exact) return exact;
  const lower = want.toLowerCase();
  return offers.find((o) => {
    const a = String(o.address || "").toLowerCase();
    return a && (a.includes(lower) || lower.includes(a.split(",")[0].trim()));
  }) || null;
}

/* ---------- GHL writeback ---------- */

const contactName = (c) =>
  [c?.firstName, c?.lastName].filter(Boolean).join(" ") || c?.name || c?.contactName || "";

async function note(client, contactId, body, warnings) {
  try {
    await createContactNote(client, contactId, { body });
  } catch (e) {
    warnings.push(`note: ${e.message}`);
  }
}

/* ---------- profile memory ---------- */

// mergeFacts lives in enrich.js beside mergeHistory now; re-exported so
// nothing that imported it from here has to move.
export { mergeFacts };

/**
 * underwritableAddress(raw) → string | ""
 *
 * Subject Property aims the auto-underwriter, so only something it could
 * actually look up may be written there. "the Tacoma one" and "her listing"
 * are real answers to "what is this message about" and useless as an aim: a
 * house number and a street word are the minimum.
 */
export function underwritableAddress(raw) {
  const v = String(raw || "").trim();
  if (v.length < 6 || v.length > 200) return "";
  const p = parseUsAddress(v);
  // House number plus a street is the bar. Deliberately NOT "must have a city
  // and state": "12 Elm St" is what an agent actually texts, and the
  // underwriter has its own extraction to fall back on. The bar exists to
  // keep prose out — "the Tacoma one", "her listing", "that one we discussed"
  // are honest answers to what the message is about and useless as an aim.
  return p.houseNo && p.street ? v : "";
}

/**
 * applyProfileUpdates({ client, locationId, contactId, party, profile, custom, summary, config, now })
 *
 * Files what the reply's model call learned into the contact's CRM fields —
 * the same fields the nightly enrichment sweep keeps, through the same
 * merge rules (history ledgers dedupe and keep the newest; facts union), so
 * the two never fight. Returns { learned: [line], written: [key] }. Never
 * throws; a field write that fails is a warning on the draft.
 */
export async function applyProfileUpdates({ client, locationId, contactId, party, profile, custom = {}, summary = "", subjectProperty = "", config, now = Date.now(), warnings = [], store = null, draftId = null, intent = "", inbound = "" }) {
  if ((!profile && !subjectProperty) || !contactId || party === "unknown") return { learned: [], written: [] };
  const type = party === "investor" ? "investor" : "agent";
  // The record first, GHL second. Everything the model read out of this
  // message is filed as a fact with the draft as its source; the ledger
  // line becomes a typed event; the conversation itself is on the timeline.
  // The GHL writes below are unchanged — the digest keeps saying what it
  // always said.
  if (store && draftId) {
    const at = new Date(now).toISOString();
    const ref = draftId;
    const facts = [];
    const list = (key, v) => String(v || "").split(/[,;\n]/).map((x) => x.trim()).filter(Boolean).forEach((value) => facts.push({ key, value, source: "conversation", at, ref }));
    if (profile?.personalDetails) list("personal_details", profile.personalDetails);
    if (profile?.marketAreas) list(type === "investor" ? "buybox_areas" : "agent_market_area", profile.marketAreas);
    if (profile?.nextAction) facts.push({ key: "suggested_next_action", value: profile.nextAction, source: "conversation", at, ref });
    if (type === "investor") {
      if (profile?.priceMin) facts.push({ key: "buybox_price_min", value: String(profile.priceMin), source: "conversation", at, ref });
      if (profile?.priceMax) facts.push({ key: "buybox_price_max", value: String(profile.priceMax), source: "conversation", at, ref });
      if (profile?.propertyTypes) list("buybox_property_types", profile.propertyTypes);
      if (profile?.rehabAppetite) facts.push({ key: "rehab_appetite", value: profile.rehabAppetite, source: "conversation", at, ref });
      if (profile?.exclusions) list("buybox_exclusions", profile.exclusions);
    }
    if (type === "agent" && underwritableAddress(subjectProperty)) facts.push({ key: "subject_property", value: subjectProperty, source: "conversation", at, ref });
    if (config?.profile?.writeSummary && summary) facts.push({ key: "last_convo_summary", value: summary.slice(0, 500), source: "conversation", at, ref });
    await learnFacts({ store, locationId, contactId, party: type, facts });
    const events = [];
    if (summary) events.push({ type: "text_summary", at, source: "conversation", ref, address: subjectProperty || "", data: { summary: summary.slice(0, 500), intent, inbound: String(inbound || "").slice(0, 300) } });
    if (profile?.dealHistoryLine && profile.dealHistoryLine.includes("|")) {
      const line = /^\d{4}-\d{2}-\d{2}/.test(profile.dealHistoryLine) ? profile.dealHistoryLine : `${at.slice(0, 10)} | ${profile.dealHistoryLine}`;
      const ev = eventFromLedgerLine(line, { party: type, source: "conversation", ref });
      if (ev) events.push(ev);
    }
    if (events.length) await recordEvents({ store, locationId, contactId, party: type, events });
  }
  const defs = new Map(enrichFieldDefs(type).map((f) => [f.key, f]));
  if (!defs.has("subject_property")) defs.set("subject_property", SUBJECT_PROPERTY_FIELD);
  const today = new Date(now).toISOString().slice(0, 10);
  const writes = {};
  const learned = [];
  const cur = (k) => String(custom?.[k] ?? "").trim();

  // The property the agent is on about, on EVERY message that names one —
  // not just the two intents that used to carry a set_field rule. This is
  // what the auto-underwriter aims at, so a stale value points it at a house
  // we already priced. Only written when it moved: re-writing the same
  // address churns the contact's audit trail for nothing.
  if (type === "agent") {
    const aim = underwritableAddress(subjectProperty);
    if (aim && addressKey(aim) !== addressKey(cur("subject_property"))) {
      writes.subject_property = aim;
      learned.push(`subject property: ${aim}`);
      if (store && draftId) await recordEvent({ store, locationId, contactId, party: "agent", type: "subject_property_set", at: new Date(now).toISOString(), address: aim, source: "conversation", ref: draftId, data: { from: cur("subject_property") } });
    }
  }
  if (profile?.personalDetails) {
    const merged = mergeFacts(cur("personal_details"), profile.personalDetails);
    if (merged !== cur("personal_details")) { writes.personal_details = merged; learned.push(`personal: ${profile.personalDetails}`); }
  }
  const areasKey = type === "investor" ? "buybox_areas" : "agent_market_area";
  if (profile?.marketAreas) {
    const merged = mergeFacts(cur(areasKey), profile.marketAreas, 600);
    if (merged !== cur(areasKey)) { writes[areasKey] = merged; learned.push(`areas: ${profile.marketAreas}`); }
  }
  if (profile?.dealHistoryLine && profile.dealHistoryLine?.includes("|")) {
    const key = type === "investor" ? "investor_deal_history" : "agent_deal_history";
    const line = /^\d{4}-\d{2}-\d{2}/.test(profile.dealHistoryLine) ? profile.dealHistoryLine : `${today} | ${profile.dealHistoryLine}`;
    const merged = mergeHistory(cur(key), [line]);
    if (merged !== cur(key)) { writes[key] = merged; learned.push(`history: ${profile.dealHistoryLine}`); }
  }
  if (profile?.nextAction && profile?.nextAction !== cur("suggested_next_action")) {
    writes.suggested_next_action = profile.nextAction;
  }
  if (type === "investor") {
    const num = (k) => Number(String(cur(k)).replace(/[$,\s]/g, "")) || 0;
    if (profile?.priceMin && profile.priceMin !== num("buybox_price_min")) { writes.buybox_price_min = profile.priceMin; learned.push(`buys from ${fmtMoney(profile.priceMin)}`); }
    if (profile?.priceMax && profile.priceMax !== num("buybox_price_max")) { writes.buybox_price_max = profile.priceMax; learned.push(`buys up to ${fmtMoney(profile.priceMax)}`); }
    if (profile?.propertyTypes) {
      const allowed = defs.get("buybox_property_types")?.values || [];
      const types = profile.propertyTypes.split(",").map((t) => t.trim().replace(/[\s-]+/g, "_")).filter((t) => allowed.includes(t));
      const merged = mergeFacts(cur("buybox_property_types"), types.join(", "), 200);
      if (types.length && merged !== cur("buybox_property_types")) { writes.buybox_property_types = merged; learned.push(`types: ${types.join(", ")}`); }
    }
    if (profile?.rehabAppetite && profile.rehabAppetite !== cur("rehab_appetite")) { writes.rehab_appetite = profile.rehabAppetite; learned.push(`rehab: ${profile.rehabAppetite.replace(/_/g, " ")}`); }
    if (profile?.exclusions) {
      const merged = mergeFacts(cur("buybox_exclusions"), profile.exclusions, 500);
      if (merged !== cur("buybox_exclusions")) { writes.buybox_exclusions = merged; learned.push(`must-haves: ${profile.exclusions}`); }
    }
  }
  if (config?.profile?.writeSummary && summary && Object.keys(writes).length) {
    writes.last_convo_summary = summary.slice(0, 500);
    writes.last_convo_date = today;
  }
  if (!Object.keys(writes).length) return { learned: [], written: [] };

  try {
    const fieldWrites = [];
    for (const [k, v] of Object.entries(writes)) {
      const def = defs.get(k);
      const id = await findOrCreateCustomFieldByKey(client, locationId, k, def?.name || k, def?.dataType || "TEXT");
      if (id) fieldWrites.push({ id, value: v });
    }
    if (fieldWrites.length) await updateContact(client, contactId, { customFields: fieldWrites });
  } catch (e) {
    warnings.push(`profile: ${String(e?.message || e).slice(0, 120)}`);
    return { learned, written: [], failed: true };
  }
  return { learned, written: Object.keys(writes) };
}

/* ---------- who has the thread ---------- */

// The newest thing WE sent, off the transcript: "[YYYY-MM-DD HH:MM] US sms: text".
export function lastOutbound(transcript = "") {
  let found = null;
  for (const line of String(transcript || "").split("\n")) {
    const m = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\] US \w+: (.*)$/.exec(line);
    if (m) found = { ts: Date.parse(`${m[1]}T${m[2]}:00Z`), text: m[3].trim() };
  }
  return found;
}

// A person replied to them recently and it wasn't one of ours going out:
// they have the thread, so the bot drafts but never sends on its own.
// Why the bot stood down, in the words the outbox and the job show.
export function handsOffReason(a) {
  if (a?.botOff?.length) return `bot is off for this contact (tag: ${a.botOff[0]})`;
  if (a?.dealHold) {
    return a.dealHold.role === "buyer"
      ? `they are a buyer on your live deal at ${a.dealHold.address} — you are working them yourself`
      : `you have ${a.dealHold.address} under contract with them — the bot stays out of a live deal`;
  }
  return "";
}

export async function humanHasThread({ store, locationId, contactId, transcript, minutes = 30, now = Date.now() }) {
  if (!minutes || !contactId) return null;
  const last = lastOutbound(transcript);
  if (!last || !Number.isFinite(last.ts) || now - last.ts > minutes * 60000) return null;
  const ours = await store.listReplyDrafts(locationId, { contactId, status: "sent", limit: 10 }).catch(() => []);
  const norm = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (ours.some((d) => norm(d.sentText || d.reply) === norm(last.text))) return null;
  return { at: new Date(last.ts).toISOString(), minutesAgo: Math.max(0, Math.round((now - last.ts) / 60000)) };
}

// This contact's drafts today, from the store plus what is in flight.
export async function countTodayForContact({ store, locationId, contactId, now = Date.now() }) {
  const since = dayStartIso(now);
  const ids = new Set();
  for (const j of jobs.values()) {
    if (j.locationId === locationId && j.contactId === contactId && String(j.startedAt) >= since && j.status !== "superseded") ids.add(j.id);
  }
  const rows = await store.listReplyDrafts(locationId, { contactId, since, limit: 200 }).catch(() => []);
  for (const d of rows) if (d?.jobId) ids.add(d.jobId);
  return ids.size;
}

/* ---------- assembling what the model sees ---------- */

// A hand-typed thread from the try-it panel, in the transcript's own format.
const renderFakeThread = (thread = [], channel = "sms") =>
  (Array.isArray(thread) ? thread : [])
    .map((m) => {
      const dir = String(m?.dir || "").toUpperCase() === "US" ? "US" : "THEM";
      const text = String(m?.text || "").trim().slice(0, 1000);
      return text ? `${dir} ${channel}: ${text}` : "";
    })
    .filter(Boolean).slice(0, 40).join("\n");

/**
 * assembleConversation(...) — who they are, and everything we know.
 *
 * Shared by the live run and the try-it preview. Does the GHL reads (contact,
 * fields, thread) and the store reads (offers or deals), never a write.
 */
export async function assembleConversation({
  client, locationId, saved, store, contactId = "", message = "", channel = "sms",
  explicitParty = "", fakeThread = null, fakeParty = "", now = Date.now(), warnings = [],
  aiApiKey = "", classify = classifyParty, light = false,
}) {
  const config = conversationConfig(saved);

  let contact = null;
  if (contactId) {
    try { contact = await getContact(client, contactId); }
    catch { /* the name is decoration; the id is what matters */ }
  }
  const name = contactName(contact);
  const tags = Array.isArray(contact?.tags) ? contact.tags : [];

  const resolved = fakeParty
    ? { party: fakeParty, source: "try-it", matched: { agent: [], investor: [] } }
    : resolveParty({ explicit: explicitParty, tags, routing: config.routing });
  let party = resolved.party;
  let partySource = resolved.source;
  let classified = null;

  // The real thread when there is a contact, and after it whatever the test
  // window typed — so a test on a real contact is "their conversation so far,
  // then this", which is exactly what a live run would see next.
  let real = "";
  if (contactId) {
    try {
      // Call transcripts ride along when the tab asks: what was said on the
      // phone — a surgery, a market, an address — is the memory the reply
      // leans on.
      const t = await buildTranscript(client, locationId, contactId, {
        maxConversations: 2, maxPagesPerConvo: 1, maxMessages: 60, maxChars: 16000,
        maxCallTranscripts: light ? 0 : (config.profile?.enabled ? config.profile.callTranscripts : 0),
      });
      real = t.text || "";
    } catch (e) {
      warnings.push(`thread: ${e.message?.slice(0, 120) || "could not be read"}`);
    }
  }
  const botOff = matchTagPatterns(tags, config.routing.botOffTags || []);
  // The other hands-off rule, and the one you don't have to remember to set:
  // a property under contract means you're working this person yourself.
  const dealHold = light ? null : await liveDealHold({
    store, locationId, contactId, mode: config.routing.holdOnLiveDeal,
  }).catch(() => null);
  const typed = fakeThread ? renderFakeThread(fakeThread, channel) : "";
  const transcript = [real, typed].filter(Boolean).join("\n");

  // The old "master bot": a contact whose tags say nothing is placed by the
  // words. On a confident read the party's first plain tag is stamped on
  // the contact (as an auto action, recorded on the draft) so the next text
  // is routed by tags like everyone else's.
  if (party === "unknown" && config.routing.unknown === "classify" && aiApiKey && !light && String(message || "").trim()) {
    try {
      const c = await classify({ contact: { name, tags }, transcript, message, aiApiKey });
      classified = c;
      if (c.party !== "unknown" && c.confidence !== "low") {
        party = c.party;
        partySource = "classified";
      }
    } catch (e) {
      warnings.push(`classify: ${e.message?.slice(0, 120) || "failed"}`);
    }
  }

  const custom = contact && !light ? await loadContactContext({ client, locationId, contact }) : {};

  let context = { text: "", amounts: [], forbiddenAmounts: [], summary: {} };
  let underwriting = [];
  if (light) {
    /* an opt-out needs the party and nothing else */
  } else if (party === "agent") {
    context = await loadAgentContext({ store, locationId, contactId, custom, now, showMath: Boolean(config.parties.agent?.showMath) });
    // The post-mortem digest rides along only when the switch is on AND a
    // person saved a digest; the machine never writes one for itself.
    const digestText = config.parties.agent?.lessons?.enabled ? lessonsContextText(saved?.postMortem?.digest) : "";
    if (digestText) context = { ...context, text: [context.text, digestText].filter(Boolean).join("\n\n") };
    underwriting = listUnderwriteJobs(locationId)
      .filter((j) => j.contactId === contactId && (j.status === "running" || j.status === "queued"))
      .map((j) => j.address || "a property")
      .slice(0, 3);
  } else if (party === "investor") {
    context = await loadInvestorContext({ store, locationId, contactId, contactName: name, custom, settings: saved || {}, tags, now });
  }
  const humanActive = light ? null : await humanHasThread({
    store, locationId, contactId, transcript: real, minutes: config.autoSend?.humanActiveMin, now,
  });

  const playbook = config.parties?.[party] || null;
  const instructions = playbook ? playbook.instructions : config.routing.genericInstructions;
  const signer = config.persona.name || saved?.company?.signer || saved?.company?.name || "";
  // Ours to hand out when asked — an agent who asks "what's your email?" got
  // "I'll text it over shortly" until 2026-09-12, because we never sent it.
  const companyContact = { email: saved?.company?.email || "", phone: saved?.company?.phone || "" };

  // The tag that would route them next time, when the words placed them.
  const stampTag = partySource === "classified" && config.routing.tagOnClassify
    ? (config.routing[party === "investor" ? "investorTags" : "agentTags"] || []).find((t) => !t.includes("*")) || null
    : null;

  return {
    config, party, partySource, matchedTags: resolved.matched, classified, stampTag, botOff, dealHold, humanActive,
    playbook, contact, contactName: name, tags, custom, transcript, context, underwriting, instructions, signer, companyContact,
  };
}

/* ---------- the pipeline ---------- */

/**
 * startReply(...) — validates, enqueues, returns the job immediately. The
 * webhook route answers GHL right away; the draft is written on the lane.
 *
 * deps: { draft, now, random, startUnderwrite, linkDealInterest, issueDataroomInvite }
 * — the model call and the broker's own actions, injected so the whole run
 * can be exercised offline.
 */
export async function startReply({
  client, locationId, saved, store, contactId, message, channel = "sms", party = "", sendsEnabled = false, deps = {},
  attachments = 0, inboundKind = "text", call = null,
}) {
  const aiApiKey = String(saved?.aiApiKey || "").trim();
  if (!aiApiKey) throw Object.assign(new Error("Anthropic API key required (Settings)"), { http: 400 });
  const nAttachments = Math.max(0, Number(attachments) || 0);
  if (!String(message || "").trim() && !nAttachments) throw Object.assign(new Error("message required"), { http: 400 });

  const config = conversationConfig(saved);
  if (!config.enabled) return { skipped: "Conversation AI is switched off on the Conversation AI page", job: null };

  // 0 means no cap. The caps exist to bound a runaway loop, not to ration a
  // busy day — an operator who has decided to run without one gets to.
  const cap = config.dailyCap;
  if (cap > 0) {
    const usedToday = await countToday({ store, locationId });
    if (usedToday >= cap) {
      return { skipped: `daily cap reached (${usedToday}/${cap})`, job: null };
    }
  }
  const perContact = config.dailyCapPerContact || 0;
  if (perContact) {
    const theirs = await countTodayForContact({ store, locationId, contactId });
    if (theirs >= perContact) return { skipped: `this contact's daily cap reached (${theirs}/${perContact})`, job: null };
  }
  // GHL retries a webhook it thinks failed, and a workflow can fire twice on
  // one text. The same words from the same contact inside two minutes are
  // one message.
  const text = String(message || "").trim();
  for (const j of jobs.values()) {
    if (j.locationId === locationId && j.contactId === contactId && j.message === text.slice(0, 1000) &&
        j.status !== "superseded" && Date.now() - Date.parse(j.startedAt) < DEDUPE_MS) {
      return { skipped: `duplicate of ${j.id}`, job: null };
    }
  }

  const job = {
    id: newJobId(),
    locationId,
    contactId,
    contactName: "",
    status: "queued",
    phase: "queued",
    channel: channel === "email" ? "email" : "sms",
    message: String(message || "").slice(0, 1000),
    // A call: the message is the transcript (kept whole on `call`), and the
    // draft is the text after the call.
    inboundKind: inboundKind === "call" ? "call" : "text",
    call: inboundKind === "call" && call ? { ...call, transcript: String(call.transcript || message || "").slice(0, 12000) } : null,
    attachments: nAttachments,
    party: party === "agent" || party === "investor" ? party : "",
    partySource: null,
    draftId: null,
    intent: null,
    summary: "",
    heldReason: null,
    scheduledFor: null,
    warnings: [],
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(job.id, job);

  const launch = () => runOnLane(locationId, () =>
    runReply(job, { client, locationId, saved, store, aiApiKey, sendsEnabled, deps: { ...deps, draft: deps.draft || draftReply } })
      .catch(async (e) => {
        job.status = "error";
        job.error = String(e?.message || e).slice(0, 300);
        job.finishedAt = new Date().toISOString();
        // Their text is sitting unanswered either way; say so where the
        // operator will see it, or it just vanishes.
        await note(client, contactId,
          `AI reply could not be drafted — ${job.error}\n\nThe message is still in the thread above; answer it by hand.`,
          job.warnings);
      })
  );

  // Three texts in a row get one reply to all three: the draft waits a
  // beat, and a newer text from the same contact replaces the waiting job.
  // The earlier texts are in the thread the newer job reads.
  const debounceMs = deps.debounceMs != null ? Number(deps.debounceMs) : (config.autoSend?.debounceSec || 0) * 1000;
  const key = `${locationId}:${contactId}`;
  if (debounceMs > 0) {
    const prev = waiting.get(key);
    if (prev) {
      clearTimeout(prev.timer);
      prev.job.status = "superseded";
      prev.job.phase = "";
      prev.job.finishedAt = new Date().toISOString();
      prev.job.supersededBy = job.id;
    }
    job.phase = "waiting";
    const timer = setTimeout(() => { waiting.delete(key); launch(); }, debounceMs);
    if (typeof timer.unref === "function") timer.unref();
    waiting.set(key, { job, timer });
  } else {
    launch();
  }
  return { skipped: null, job };
}

const DEDUPE_MS = 2 * 60 * 1000;
const waiting = new Map();   // `${locationId}:${contactId}` -> { job, timer }

// ARV and repairs off an offer document or its lean row.
const offerNumbers = (offer) => ({
  arv: Math.round(Number(offer?.arv ?? offer?.calc?.inputs?.arv) || 0),
  rehab: Math.round(Number(offer?.repairs ?? offer?.calc?.inputs?.repairs) || 0),
});
/* ---------- the kinds of message the bot starts ---------- */

/**
 * OUTBOUND_KINDS — one row per message the bot may START, replacing what used
 * to be a chain of `if (kind === ...)` branches.
 *
 *   party    which record book to load — an investor nudge reads the deal
 *            book, the buy box and the dataroom trail, exactly as an inbound
 *            reply from them would.
 *   enabled  the playbook switch that has to be on.
 *   ready    a per-message precondition, returning true or the reason why not.
 *   floats   the numbers THIS message is allowed to introduce, on top of the
 *            record book. See the note below — it is the money guard.
 *   forbids  numbers this message must not say even though the book has them.
 *
 * THE NUDGES FLOAT NOTHING. `floats: () => []` means allowedAmounts is exactly
 * the record book, so a follow-up that invents "still open at 310k" is flagged
 * and parks like any other draft. That is the whole difference between a
 * follow-up and a new offer: a nudge re-raises a conversation, it never
 * introduces a number.
 */
export const OUTBOUND_KINDS = {
  // The first text to an agent the outreach page imported. It floats nothing
  // — the hook listing's price is on the contact for context, not for
  // quoting — and it is the one message where the thread is empty by
  // definition, so the prompt has to carry the whole introduction.
  outreach_open: {
    party: "agent",
    enabled: (pb) => pb?.outreach?.enabled,
    ready: ({ subject }) => (subject?.address ? true : "no listing to open with"),
    floats: () => [],
    forbids: () => [],
  },
  outreach_nudge: {
    party: "agent",
    enabled: (pb) => pb?.followUp?.enabled && pb?.followUp?.ladders?.outreach_nudge?.enabled,
    ready: ({ subject }) => (subject?.address ? true : "nothing to follow up on"),
    floats: () => [],
    forbids: () => [],
  },
  take_check: {
    party: "agent",
    enabled: (pb) => pb?.takeCheck?.enabled,
    ready: ({ offer }) => {
      const n = offerNumbers(offer);
      return n.arv || n.rehab ? true : "the underwrite has no ARV or rehab to float";
    },
    // Our read goes out; our PRICE explicitly does not. Asking what they think
    // the property is worth while showing them what we would pay for it is not
    // asking, and the forbid is what makes the question real.
    floats: ({ offer }) => { const n = offerNumbers(offer); return [n.arv, n.rehab].filter(Boolean); },
    forbids: ({ offer }) => [Math.round(Number(offer?.cashAmount) || 0)].filter(Boolean),
  },
  realm_check: {
    party: "agent",
    enabled: (pb) => pb?.realmCheck?.enabled,
    ready: ({ offer, config, dossier }) => {
      if (!offer?.cashAmount) return "the offer has no number to float";
      // Their read before our price. A number that arrives with nothing
      // anchoring it reads as a lowball and ends the thread — so unless the
      // operator has deliberately switched the first step off, the take check
      // goes first and this waits for their answer.
      const takeOn = config?.parties?.agent?.takeCheck?.enabled;
      const haveTheirs = Boolean(dossier?.have?.arv || dossier?.have?.rehab);
      if (takeOn && !haveTheirs) return "no read from the agent yet — the take check goes first";
      return true;
    },
    floats: ({ offer }) => [Math.round(Number(offer.cashAmount) || 0)],
    forbids: () => [],
  },
  offer_nudge: {
    party: "agent",
    enabled: (pb) => pb?.followUp?.enabled && pb?.followUp?.ladders?.offer_nudge?.enabled,
    ready: ({ offer }) => (offer?.address ? true : "nothing to follow up on"),
    floats: () => [],
    forbids: () => [],
  },
  blast_nudge: {
    party: "investor",
    enabled: (pb) => pb?.followUp?.enabled && pb?.followUp?.ladders?.blast_nudge?.enabled,
    ready: ({ subject }) => (subject?.address ? true : "nothing to follow up on"),
    floats: () => [],
    forbids: () => [],
  },
  dataroom_nudge: {
    party: "investor",
    enabled: (pb) => pb?.followUp?.enabled && pb?.followUp?.ladders?.dataroom_nudge?.enabled,
    ready: ({ subject }) => (subject?.address ? true : "nothing to follow up on"),
    floats: () => [],
    forbids: () => [],
  },
};

const outboundLabel = (kind) => String(kind || "").replace(/_/g, " ");

/**
 * startProactive({ client, locationId, saved, store, contactId, kind,
 *                  offer, subject, sendsEnabled, deps })
 *
 * A message the bot STARTS, rather than one it answers. Two families:
 *
 *   The anchor pair. An auto-underwrite lands an offer; take_check floats our
 *   ARV and rehab read to draw out theirs, and once they have answered
 *   realm_check floats a price — as a rough first pass, not an offer.
 *
 *   The follow-up nudges, from the clock (shared/follow-up.js): an offer
 *   nobody answered, a deal we blasted, a dataroom somebody opened and then
 *   went quiet on.
 *
 * Same lane, same gates, same outbox as a reply. `offer` carries the anchor
 * kinds; `subject` is the generic slot the nudges use ({ address, step,
 * steps, viewedAt, blastedAt }). Returns the job, or { skipped } with the
 * reason when the playbook has it off or the message has nothing to say.
 */
export async function startProactive({
  client, locationId, saved, store, contactId, kind = "realm_check",
  offer = null, subject = null, sendsEnabled = false, deps = {},
}) {
  const aiApiKey = String(saved?.aiApiKey || "").trim();
  if (!aiApiKey) throw Object.assign(new Error("Anthropic API key required (Settings)"), { http: 400 });
  const config = conversationConfig(saved);
  if (!config.enabled) return { skipped: "Conversation AI is switched off", job: null };
  const spec = OUTBOUND_KINDS[kind];
  if (!spec) return { skipped: `unknown outbound kind ${kind}`, job: null };
  const playbook = config.parties?.[spec.party];
  if (!spec.enabled(playbook)) return { skipped: `${outboundLabel(kind)} is off for ${PARTY_LABEL[spec.party].toLowerCase()}s`, job: null };
  if (!contactId) return { skipped: "there is nobody to send it to", job: null };

  // The realm check needs to know whether the agent has given us their read,
  // which lives on the contact's timeline rather than on the offer.
  let dossier = null;
  if (kind === "realm_check" && offer?.address) {
    try {
      const events = await store.listContactEvents(locationId, contactId, { limit: 200 });
      dossier = propertyDossier(events, offer.address);
    } catch { dossier = null; }
  }
  const ready = spec.ready({ offer, subject, config, dossier });
  if (ready !== true) return { skipped: ready, job: null };

  const job = {
    id: newJobId(), locationId, contactId, contactName: "", status: "queued", phase: "queued",
    channel: "sms", message: "", attachments: 0, party: spec.party, partySource: "offer", outbound: kind,
    offerId: offer?.id || null, draftId: null, intent: kind, summary: "", heldReason: null, scheduledFor: null,
    step: subject?.step ?? null,
    warnings: [], error: null, startedAt: new Date().toISOString(), finishedAt: null,
  };
  jobs.set(job.id, job);
  runOnLane(locationId, () =>
    runProactive(job, { client, locationId, saved, store, aiApiKey, sendsEnabled, offer, subject, spec, config, dossier, deps: { ...deps, draft: deps.draft || draftReply } })
      .catch(async (e) => {
        job.status = "error";
        job.error = String(e?.message || e).slice(0, 300);
        job.finishedAt = new Date().toISOString();
        await note(client, contactId, `AI ${outboundLabel(kind)} could not be drafted — ${job.error}. Pick it up by hand if you like.`, job.warnings);
      })
  );
  return { skipped: null, job };
}
// "850K", not "$850K": a dollar sign in a text trips carrier spam filters, and
// the style gate would hold the draft for it.
const kText = (n) => `${Math.round(n / 1000)}K`;

/**
 * chooseProactiveKind({ events, address }) → "take_check" | "realm_check"
 *
 * Their read before our price. If the agent has already told us what they
 * think the property is worth and costs, there is nothing to draw out and
 * the cash number can go; otherwise float the ARV/rehab read first.
 */
export function chooseProactiveKind({ events = [], address = "" } = {}) {
  const d = address ? propertyDossier(events, address) : null;
  return d && (d.have.arv || d.have.rehab) ? "realm_check" : "take_check";
}

// The descriptor the prompt reads for one outbound kind: everything the model
// needs to write this particular message, and nothing about how it was chosen.
function outboundDescriptor({ kind, offer, subject, saved, dossier }) {
  const address = offer?.address || subject?.address || "the property";
  const step = subject?.step ?? null;
  const steps = subject?.steps || [];
  const base = { kind, address, ...(step != null ? { step, stepLabel: stepLabel(step, steps), stepIndex: normalizeSteps(steps).indexOf(step) + 1, stepCount: normalizeSteps(steps).length } : {}) };
  if (kind === "take_check") {
    const n = offerNumbers(offer);
    return { ...base,
      arv: n.arv, rehab: n.rehab,
      arvText: n.arv ? fmtMoney(n.arv) : "", rehabText: n.rehab ? fmtMoney(n.rehab) : "",
      arvK: n.arv ? kText(n.arv) : "", rehabK: n.rehab ? kText(n.rehab) : "" };
  }
  if (kind === "realm_check") {
    const closeDays = offer.terms?.closingDays || saved?.psa?.closingDays || 0;
    const terms = [closeDays ? `${closeDays}-day close` : "", "as-is"].filter(Boolean).join(", ");
    const asking = Number(offer.askingPrice || offer.calc?.inputs?.askingPrice) || 0;
    // THEIR numbers, so the price can be framed as a consequence of what they
    // told us rather than a figure out of nowhere. Without these the caveat is
    // a hedge; with them it is an explanation.
    const theirArv = Math.round(Number(dossier?.have?.arv?.value) || 0);
    const theirRehab = Math.round(Number(dossier?.have?.rehab?.value) || 0);
    return { ...base,
      amount: offer.cashAmount, amountText: fmtMoney(offer.cashAmount),
      amountK: kText(Number(offer.cashAmount) || 0),
      askingText: asking ? fmtMoney(asking) : "", terms,
      theirArv, theirRehab,
      theirArvK: theirArv ? kText(theirArv) : "", theirRehabK: theirRehab ? kText(theirRehab) : "",
      requote: Boolean(subject?.requote) };
  }
  if (kind === "outreach_open") {
    // What we know about the listing, for the introduction. Price and days
    // on market are colour ("been sitting a while"), never a number to quote.
    const price = Math.round(Number(subject?.hookPrice) || 0);
    return { ...base,
      hookPrice: price, hookPriceK: price ? kText(price) : "", hookDom: Number(subject?.hookDom) || 0,
      brokerage: String(subject?.brokerage || "") };
  }
  // The nudges. They carry what the message is ABOUT and no numbers at all.
  return { ...base,
    blastedAt: subject?.blastedAt || null, viewedAt: subject?.viewedAt || null,
    lastTouchAt: subject?.lastTouchAt || null };
}

// The one-liner the outbox row shows when the model didn't write its own.
function outboundSummary({ kind, offer, outbound }) {
  const where = outbound.address;
  const rung = outbound.stepLabel ? ` (${outbound.stepLabel})` : "";
  switch (kind) {
    case "take_check": {
      const parts = [outbound.arv ? `${outbound.arvK} ARV` : "", outbound.rehab ? `${outbound.rehabK} rehab` : ""].filter(Boolean);
      return `Floats our ${parts.join(" / ")} read on ${where} and asks what they think.`;
    }
    case "realm_check":
      return outbound.requote
        ? `Comes back on ${where} with ${fmtMoney(offer.cashAmount)} after re-running their numbers.`
        : `Floats ${fmtMoney(offer.cashAmount)} on ${where} as a rough first pass and asks if it's in the realm.`;
    case "offer_nudge":   return `Follows up on our offer on ${where}${rung}.`;
    case "outreach_open": return `First text: saw their listing at ${where}, asks if they have anything distressed.`;
    case "outreach_nudge": return `Follows up on our first text about ${where}${rung}.`;
    case "blast_nudge":   return `Follows up on ${where} — we sent it and heard nothing${rung}.`;
    case "dataroom_nudge": return `Follows up on ${where} — they opened the package and went quiet${rung}.`;
    default: return `Starts a message about ${where}${rung}.`;
  }
}

async function runProactive(job, ctx) {
  const { client, locationId, saved, store, aiApiKey, sendsEnabled, offer, subject, spec, config, dossier, deps } = ctx;
  const now = typeof deps.now === "function" ? deps.now() : Date.now();
  const warnings = job.warnings;
  const kind = job.outbound;
  const party = spec.party;
  job.status = "running";
  job.phase = "reading";
  const a = await assembleConversation({
    client, locationId, saved, store, contactId: job.contactId, message: "", channel: "sms",
    explicitParty: party, now, warnings, aiApiKey,
  });
  job.contactName = a.contactName;
  const handsOff = handsOffReason(a);
  if (handsOff) {
    job.status = "held"; job.phase = ""; job.heldReason = handsOff; job.finishedAt = new Date().toISOString();
    return;
  }
  const { context } = a;
  const outbound = outboundDescriptor({ kind, offer, subject, saved, dossier });

  job.phase = "drafting";
  const draft = await deps.draft({
    message: "", transcript: a.transcript, offers: context.offers || { text: "", amounts: [], count: 0 },
    contact: { name: a.contactName, tags: a.tags }, underwriting: [], instructions: a.instructions, signer: a.signer, companyContact: a.companyContact,
    aiApiKey, party, config, context, channel: "sms", outbound,
  });
  draft.intent = kind;
  job.summary = draft.summary;
  // What this kind floats is what it may say, on top of the record book — and
  // what it forbids is subtracted even though the book has it. A nudge floats
  // nothing, so its allowance is exactly the book.
  const floats = spec.floats({ offer, subject }).filter(Boolean);
  const allowed = [...new Set([...(context.amounts || []), ...floats])];
  const extraForbidden = spec.forbids({ offer, subject }).filter(Boolean);
  const forbiddenAmounts = extraForbidden.length
    ? [...new Set([...(context.forbiddenAmounts || []), ...extraForbidden])]
    : context.forbiddenAmounts;
  const gate = evaluateReplyGates({ minConfidence: config.autoSend?.minConfidence, holdOnNeedsHuman: config.autoSend?.holdOnNeedsHuman, draft, party, allowedAmounts: allowed, forbiddenAmounts, inboundMessage: "", channel: "sms", style: config.style, selfName: a.signer, contactName: a.contactName, signOff: config.persona?.signOff });
  const auto = decideAutoSend({ gate, party, intent: kind, channel: "sms", config, sendsEnabled, humanActive: a.humanActive });

  job.phase = "saving";
  const open = [];
  for (const status of ["draft", "scheduled"]) {
    const rows = await store.listReplyDrafts(locationId, { contactId: job.contactId, status, limit: 5 }).catch(() => []);
    open.push(...rows);
  }
  for (const old of open) {
    await store.updateReplyDraft(old.id, { ...old, status: "superseded", sendAt: null, updatedAt: new Date().toISOString() }).catch(() => {});
  }
  const ts = new Date().toISOString();
  let record = await store.createReplyDraft({
    locationId, contactId: job.contactId, contactName: job.contactName, status: "draft", channel: "sms", jobId: job.id,
    inbound: "",
    // What the row is about, in the shape the outbox renders. The nudges carry
    // their rung so a person approving one can see how far in we are.
    outbound: {
      kind, offerId: offer?.id || null, address: outbound.address,
      ...(kind === "take_check" ? { arv: outbound.arv, rehab: outbound.rehab } : {}),
      ...(kind === "realm_check" ? { amount: offer.cashAmount, requote: outbound.requote } : {}),
      ...(outbound.step != null ? { step: outbound.step, steps: subject?.steps || [], stepLabel: outbound.stepLabel } : {}),
    },
    reply: draft.reply, intent: kind, confidence: draft.confidence, needsHuman: draft.needsHuman, humanReason: draft.humanReason,
    summary: draft.summary || outboundSummary({ kind, offer, outbound }),
    propertyAddress: outbound.address || draft.propertyAddress || "", counterAmount: null,
    autoSendable: gate.ok, flags: gate.flags, party, partySource: "offer", matchedTags: a.matchedTags,
    contextSummary: context.summary || {}, offersInContext: context.offers?.count ?? 0,
    autoSend: { decided: auto.send, reason: auto.reason }, humanActive: a.humanActive || null, actions: [],
    supersededIds: open.map((o) => o.id), warnings: warnings.slice(0, 6), noteOnAutoSend: config.notes?.onAutoSend !== false,
    promptVersion: 3, updatedAt: ts,
  });
  job.draftId = record.id;
  try { await addContactTags(client, job.contactId, [RA_TAGS.draft]); } catch (e) { warnings.push(`tag: ${e.message}`); }
  if (auto.send && draft.reply) {
    job.phase = "scheduling";
    const random = typeof deps.random === "function" ? deps.random : Math.random;
    const sendAt = scheduleFor({ config, now, kind, intent: kind, replyLength: String(draft.reply || "").length, random });
    record = { ...record, status: "scheduled", sendAt, scheduledAt: new Date(now).toISOString(), updatedAt: new Date().toISOString() };
    await store.updateReplyDraft(record.id, record);
    job.scheduledFor = sendAt;
  }
  if (config.notes?.onDraft !== false) await note(client, job.contactId, draftNote(record), warnings);
  job.status = "done";
  job.phase = "";
  job.finishedAt = new Date().toISOString();
}

function runOnLane(locationId, fn) {
  const lane = lanes.get(locationId) || { running: 0, waiting: [] };
  lanes.set(locationId, lane);
  const next = () => {
    lane.running--;
    const queued = lane.waiting.shift();
    if (queued) {
      lane.running++;
      queued().then(next, next);
    }
  };
  if (lane.running < RA_MAX_CONCURRENT) {
    lane.running++;
    fn().then(next, next);
  } else {
    lane.waiting.push(fn);
  }
}

async function runReply(job, ctx) {
  // `deps.draft` is draftReply unless a test injects one — the only stage here
  // that costs money, and the only one that can't be exercised offline.
  const { client, locationId, saved, store, aiApiKey, sendsEnabled, deps } = ctx;
  const now = typeof deps.now === "function" ? deps.now() : Date.now();
  const warnings = job.warnings;
  job.status = "running";

  /* --- 0. an opt-out gets silence, before anything is spent --- */
  const cfg = conversationConfig(saved);
  const isCall = job.inboundKind === "call";
  const inboundText = isCall ? String(job.call?.transcript || job.message || "") : job.message;
  // "Stop" said in a phone call is a sentence, not an opt-out; the keyword
  // rule is for texts.
  if (!isCall && detectOptOut(job.message, cfg.optOut)) {
    job.phase = "reading";
    const a = await assembleConversation({
      client, locationId, saved, store, contactId: job.contactId, message: job.message, channel: job.channel,
      explicitParty: job.party, now, warnings, light: true,
    });
    job.party = a.party;
    job.partySource = a.partySource;
    job.contactName = a.contactName;
    await handleOptOut(job, { ...ctx, config: cfg, party: a.party, partySource: a.partySource, matchedTags: a.matchedTags, confidence: "high", reason: "an opt-out keyword" });
    return;
  }

  /* --- 1. who and what --- */
  job.phase = "reading";
  const a = await assembleConversation({
    client, locationId, saved, store, contactId: job.contactId, message: job.message, channel: job.channel,
    explicitParty: job.party, now, warnings, aiApiKey, classify: deps.classify || classifyParty,
  });
  const { config, party, playbook, context } = a;
  job.party = party;
  job.partySource = a.partySource;
  job.contactName = a.contactName;

  const handsOff = handsOffReason(a);
  if (handsOff) {
    // Either the operator tagged them off, or we are mid-deal with them. No
    // draft, no note — they know, and a note on a live deal is noise.
    job.status = "held";
    job.phase = "";
    job.heldReason = handsOff;
    job.finishedAt = new Date().toISOString();
    return;
  }

  // A person is already in this thread. Until 2026-09-12 that only blocked
  // the send — the draft was written first, and then went stale: a third of
  // the two-week window's drafts were superseded while Matt answered the
  // conversation himself. Standing down BEFORE the model call is the point
  // of the setting; the thread is his, and he does not need a note to say so.
  if (a.humanActive) {
    job.status = "held";
    job.phase = "";
    job.heldReason = `you replied to them ${a.humanActive.minutesAgo} minute${a.humanActive.minutesAgo === 1 ? "" : "s"} ago — you have the thread`;
    job.finishedAt = new Date().toISOString();
    return;
  }

  if (party === "unknown" && config.routing.unknown === "hold") {
    job.status = "held";
    job.phase = "";
    job.heldReason = "no agent or investor tag on the contact — no draft written";
    job.finishedAt = new Date().toISOString();
    await note(client, job.contactId,
      `Conversation AI did not answer: this contact carries none of the tags that mark a listing agent or an investor ` +
      `(see the Conversation AI page → routing). Their message is in the thread above; answer it by hand, or tag them and it will next time.`,
      warnings);
    return;
  }

  /* --- 1b. the calendar, when a time is on the table --- */
  const booking = await prepareBooking({ client, store, locationId, contactId: job.contactId, party, message: job.message, config, now, deps }).catch(() => null);
  if (booking?.error) warnings.push(`calendar: ${booking.error}`);
  const bookingText = booking ? bookingContextText(booking) : "";
  const draftContext = bookingText ? { ...context, text: [context.text, bookingText].filter(Boolean).join("\n\n") } : context;

  /* --- 2. the draft --- */
  job.phase = "drafting";
  let draft;
  if (job.attachments > 0 && !String(job.message || "").trim()) {
    // A bare photo gets the canned line and no model call — the rule is
    // "never analyse the image", and the surest way not to is not to look.
    draft = mediaDraft(config);
  } else {
    draft = await deps.draft({
      message: inboundText,
      transcript: a.transcript,
      offers: context.offers || { text: "", amounts: [], count: 0 },
      contact: { name: a.contactName, tags: a.tags },
      underwriting: a.underwriting,
      instructions: a.instructions,
      signer: a.signer, companyContact: a.companyContact,
      aiApiKey,
      party, config, context: draftContext, channel: job.channel, booking: Boolean(bookingText),
      inboundKind: job.inboundKind || "text", call: job.call || null,
    });
  }
  job.intent = draft.intent;
  job.summary = draft.summary;

  // The model read an opt-out the keywords didn't catch ("lose my number",
  // plain anger). Same outcome as the keyword: silence and the tag.
  if (SILENT_INTENTS.has(draft.intent)) {
    await handleOptOut(job, { ...ctx, config, party, partySource: a.partySource, matchedTags: a.matchedTags, confidence: draft.confidence, reason: draft.summary || "the model read an opt-out" });
    return;
  }

  // A walkthrough, a call, a time: yours by design, and therefore a draft
  // that was never going to be sent. The heads-up is the useful output. The
  // calendar is the exception — once it is wired it can answer a time for
  // real, so the draft stands and the guard decides.
  const bookingCouldAnswer = Boolean(booking) && (BOOKING_INTENTS[party] || []).includes(draft.intent);
  if ((config.notifyOnly || []).includes(draft.intent) && !bookingCouldAnswer) {
    await handleNotifyOnly(job, { ...ctx, config, party, partySource: a.partySource, matchedTags: a.matchedTags, draft });
    return;
  }

  const gate = evaluateReplyGates({ minConfidence: config.autoSend?.minConfidence, holdOnNeedsHuman: config.autoSend?.holdOnNeedsHuman,
    draft, party, allowedAmounts: context.amounts, forbiddenAmounts: context.forbiddenAmounts,
    inboundMessage: inboundText, channel: job.channel, style: config.style,
    selfName: a.signer, contactName: a.contactName, signOff: config.persona?.signOff,
  });
  let base = decideAutoSend({ gate, party, intent: draft.intent, channel: job.channel, config, sendsEnabled, humanActive: a.humanActive });
  // The text after a call is its own allowlist slot on top of the intent's:
  // a question asked on the phone still needs "text after a call" ticked.
  if (isCall && base.send && !(config.parties?.[party]?.autoSend?.intents || []).includes("call_followup")) {
    base = { send: false, code: "not_allowlisted", reason: "text after a call is not on the auto-send list" };
  }
  // The counter band. Evaluated whenever the intent is one a guard COULD
  // release and the band is on — pass or fail — because a failed band is the
  // most useful row in the outbox: it says how far off the counter was, and
  // therefore whether the ceiling is in the right place.
  // Which guard applies is the intent's business: a counter goes to the
  // band, a request for a time (or a pick of one we offered, whatever the
  // intent read as) goes to the calendar.
  const bookingApplies = Boolean(booking) && ((BOOKING_INTENTS[party] || []).includes(draft.intent) || (draft.chosenSlot && booking.previouslyOffered.length));
  const guard = bookingApplies
    ? evaluateBookingGuard({ draft, offered: booking.offered, previouslyOffered: booking.previouslyOffered, freeSlots: booking.freeSlots, config: config.booking, now })
    : await evaluateBandFor({ store, locationId, party, draft, config, saved, job, now });
  // A booking guard on an intent that is not itself locked (a "question"
  // that picks a time) has nothing to release; the pass still books.
  const auto = releaseUnderGuard({ base, party, intent: draft.intent, config, guard });
  const bookingVerdict = guard?.kind === "booking" ? guard : null;
  const autoWithVerdict = bookingVerdict && !auto.exception ? { ...auto, exception: bookingVerdict } : auto;
  const plan = playbook ? planActions({ party, intent: draft.intent, confidence: draft.confidence, playbook, minConfidence: config.autoSend?.minConfidence }) : { auto: [], suggested: [] };
  // The re-quote toggle has to mean something on its own. Without this it is
  // inert unless the operator also wires the action onto a rule by hand, and a
  // switch that does nothing until you find a second switch is a trap.
  //
  // It goes in on a counter or a rejection — "that's way too low" classifies
  // as either — and only when the model was sure, because re-pricing the wrong
  // house on a misread is the failure that costs something. It concedes no
  // money either way, which is why it may run unattended at all.
  if (party === "agent" && config.parties.agent.requote?.enabled &&
      ["counter", "rejection"].includes(draft.intent) &&
      ![...plan.auto, ...plan.suggested].some((a) => a.type === "requote_from_agent_numbers")) {
    const action = { id: `a-rq-${job.id}`, type: "requote_from_agent_numbers", status: "pending", party,
      why: "they pushed back on the number — re-run it on theirs" };
    if (draft.confidence === "high") plan.auto.push({ ...action, mode: "auto" });
    else plan.suggested.push({ ...action, mode: "ask" });
  }
  // A released counter is answered in words and handed over: re-issuing the
  // paper at their number is one click, by a person. ASK_ONLY_ACTIONS makes
  // that permanent — an operator cannot promote it to auto by editing a rule.
  if (auto.exception?.passed && draft.intent === "counter") {
    plan.suggested.push({ id: `a-band-${job.id}`, type: "revise_offer_to_counter", mode: "ask", status: "pending", party,
      amount: guard.theirAmount, why: `they countered at ${fmtMoney(guard.theirAmount)}, inside the ${fmtMoney(guard.ceiling)} ceiling` });
  }
  if (auto.exception?.passed && draft.intent === "acceptance") {
    plan.suggested.push({ id: `a-acc-${job.id}`, type: "promote_to_deal", mode: "ask", status: "pending", party,
      why: "they say the seller accepted — mint the deal when you've confirmed it" });
  }
  // They picked a time we offered. Booked on its own when the guard passed
  // (offered by us, still free, confirmed in our words); otherwise a person
  // books it from the row, or doesn't.
  if (bookingVerdict?.chosen || (draft.chosenSlot && booking?.previouslyOffered?.length)) {
    const chosen = bookingVerdict?.chosen || { iso: draft.chosenSlot, label: (booking.previouslyOffered.find((s) => Date.parse(s.iso) === Date.parse(draft.chosenSlot)) || {}).label || draft.chosenSlot };
    const action = { id: `a-book-${job.id}`, type: "book_call", status: "pending", party, startTime: chosen.iso, label: chosen.label,
      why: bookingVerdict?.passed ? `they picked ${chosen.label}` : `they picked ${chosen.label} — ${bookingVerdict?.reason || "check the calendar"}` };
    if (bookingVerdict?.passed) plan.auto.push({ ...action, mode: "auto" });
    else plan.suggested.push({ ...action, mode: "ask" });
  }
  // The dataroom invite, unattended — under a guard, never from a rule.
  // suggest_dataroom_invite stays ask-only; this is a separate action the
  // broker's own check injects when the buyer is already evaluating the deal
  // the message names (or is being linked to it right now) AND their stated
  // buy box fits it. A cold "send me details" still asks.
  if (party === "investor" && draft.intent === "interested" && typeof deps.dataroomInviteGuard === "function" && draft.confidence !== "low") {
    try {
      const linking = plan.auto.some((x) => x.type === "link_deal_evaluating");
      const g = await deps.dataroomInviteGuard({ contactId: job.contactId, addressHint: draft.propertyAddress || "", linking });
      if (g?.ok) {
        plan.auto.push({ id: `a-invite-${job.id}`, type: "send_dataroom_invite", mode: "auto", status: "pending", party,
          why: `evaluating ${g.address} and their buy box fits (${g.score}%)` });
      } else if (g?.reason && g?.address) {
        plan.suggested.push({ id: `a-invite-${job.id}`, type: "suggest_dataroom_invite", mode: "ask", status: "pending", party, why: g.reason });
      }
    } catch (e) { warnings.push(`invite guard: ${String(e?.message || e).slice(0, 120)}`); }
  }
  if (a.stampTag) {
    plan.auto.unshift({ id: `a-route-${job.id}`, type: "add_tags", tags: [a.stampTag], mode: "auto", status: "pending", party, why: "routed by the message" });
  }
  // No rule matched: the party's catch-all, unless they already carry one
  // of the tags it exists to hand out. Fires whatever the confidence — "no
  // fit" is a bucket, not a judgment.
  if (!plan.auto.length && !plan.suggested.length && playbook?.fallback?.actions?.length &&
      !(draft.intent === "small_talk" && !draft.reply) &&
      !matchTagPatterns(a.tags, playbook.fallback.unlessTags || []).length) {
    const fb = playbook.fallback.actions.map((x, i) => ({ ...x, id: `a-fb-${job.id}-${i}`, mode: playbook.fallback.mode, status: "pending", party, why: "no rule matched" }));
    if (playbook.fallback.mode === "auto") plan.auto.push(...fb); else plan.suggested.push(...fb);
  }

  /* --- 3. nothing to say --- */
  if (draft.intent === "small_talk" && !draft.reply && !plan.auto.length && !plan.suggested.length) {
    job.status = "done";
    job.phase = "";
    job.finishedAt = new Date().toISOString();
    return;
  }

  /* --- 4. save the draft --- */
  job.phase = "saving";
  // One open draft per contact: a second text before the first was answered
  // supersedes it, scheduled or not. The reply is to the conversation, not
  // to a message. (Two reads rather than an IN: the file store and every
  // test double take a single status.)
  const open = [];
  for (const status of ["draft", "scheduled"]) {
    const rows = await store.listReplyDrafts(locationId, { contactId: job.contactId, status, limit: 5 }).catch(() => []);
    open.push(...rows);
  }
  for (const old of open) {
    await store.updateReplyDraft(old.id, { ...old, status: "superseded", sendAt: null, updatedAt: new Date().toISOString() }).catch(() => {});
  }
  const ts = new Date().toISOString();
  // The agent's own numbers and the property details, whichever shape the draft arrived in.
  const agentTake = draft.agentTake ?? normalizeAgentTake(draft);
  const propertyDetails = draft.propertyDetails ?? null;
  let record = await store.createReplyDraft({
    locationId,
    contactId: job.contactId,
    contactName: job.contactName,
    status: "draft",
    channel: job.channel,
    jobId: job.id,
    inbound: isCall ? `(call${job.call?.durationSec ? `, ${Math.round(job.call.durationSec / 60)} min` : ""}) ${inboundText.replace(/\s+/g, " ").slice(0, 240)}${inboundText.length > 240 ? "…" : ""}` : job.message,
    inboundKind: job.inboundKind || "text",
    call: job.call ? { messageId: job.call.messageId, direction: job.call.direction, at: job.call.at, durationSec: job.call.durationSec } : null,
    reply: draft.reply,
    intent: draft.intent,
    confidence: draft.confidence,
    needsHuman: draft.needsHuman,
    humanReason: draft.humanReason,
    summary: draft.summary,
    propertyAddress: draft.propertyAddress,
    counterAmount: draft.counterAmount || null,
    // Why they turned it down. Rides on the draft so the feedback actions
    // have it, and so the row can show it whether or not they ran.
    passReason: draft.passReason || null,
    agentTake,
    propertyDetails: propertyDetails || null,
    autoSendable: gate.ok,
    flags: gate.flags,
    party,
    partySource: a.partySource,
    matchedTags: a.matchedTags,
    classified: a.classified || null,
    attachments: job.attachments || 0,
    contextSummary: context.summary || {},
    offersInContext: context.offers?.count ?? 0,
    autoSend: { decided: auto.send, reason: auto.reason },
    // The band's verdict, on every draft it could have applied to — pass AND
    // fail. A failed one is the row that says how far off the counter was and
    // therefore whether the ceiling is in the right place.
    exception: autoWithVerdict.exception || null,
    // The calendar: what this reply offers (so the next message can pick
    // one) and what it booked.
    booking: bookingVerdict ? { offered: bookingVerdict.passed ? bookingVerdict.offered : [], chosen: bookingVerdict.chosen || null } : null,
    humanActive: a.humanActive || null,
    actions: [...plan.auto, ...plan.suggested],
    supersededIds: open.map((o) => o.id),
    warnings: warnings.slice(0, 6),
    noteOnAutoSend: config.notes?.onAutoSend !== false,
    promptVersion: 3,
    updatedAt: ts,
  });
  job.draftId = record.id;

  /* --- 4a. the call itself, on the timeline --- */
  if (isCall && job.call) {
    await recordEvent({
      store, locationId, contactId: job.contactId, party, type: "call_summary", at: job.call.at || new Date(now).toISOString(),
      address: draft.propertyAddress || "", source: "call", ref: job.call.messageId || record.id, dedupeKey: job.call.dedupeKey || `call:${job.call.messageId}`,
      data: { summary: String(draft.summary || "").slice(0, 500), intent: draft.intent, direction: job.call.direction, durationSec: job.call.durationSec, transcribed: true, draftId: record.id },
    });
  }

  /* --- 4b. what we learned about them --- */
  // Subject Property is not profile memory, it is the underwriter's aim, so
  // it is filed even when profile learning is switched off.
  let filedLearned = [];
  const learnable = config.profile?.enabled ? draft.profile : null;
  if (learnable || (party === "agent" && draft.propertyAddress)) {
    job.phase = "filing";
    const filed = await applyProfileUpdates({
      client, locationId, contactId: job.contactId, party, profile: learnable, custom: a.custom,
      summary: draft.summary, subjectProperty: draft.propertyAddress, config, now, warnings,
      store, draftId: record.id, intent: draft.intent, inbound: job.message,
    });
    if (filed.learned.length || filed.written.length) {
      record = { ...record, profileUpdates: { learned: filed.learned, written: filed.written }, warnings: warnings.slice(0, 6), updatedAt: new Date().toISOString() };
      await store.updateReplyDraft(record.id, record).catch(() => {});
    }
    filedLearned = filed.learned;
  }

  /* --- 4c. the agent's own take on the property --- */
  if (party === "agent" && agentTake && draft.propertyAddress) {
    await recordEvent({
      store, locationId, contactId: job.contactId, party: "agent", type: "agent_estimate", at: new Date(now).toISOString(),
      address: draft.propertyAddress, source: "conversation", ref: record.id,
      data: { arv: agentTake.arv, rehab: agentTake.rehab, note: agentTake.note },
    });
    // Their read is in. If we floated ours to get it and the price is still
    // unsaid, the realm check follows — the second half of "their read
    // before our price". The broker decides whether such an offer exists.
    if (typeof deps.afterAgentTake === "function") {
      try { await deps.afterAgentTake({ contactId: job.contactId, address: draft.propertyAddress }); }
      catch (e) { warnings.push(`realm follow-up: ${String(e?.message || e).slice(0, 120)}`); }
    }
  }

  if (party === "agent" && propertyDetails && draft.propertyAddress) {
    await recordEvent({
      store, locationId, contactId: job.contactId, party: "agent", type: "property_details", at: new Date(now).toISOString(),
      address: draft.propertyAddress, source: "conversation", ref: record.id, data: propertyDetails,
    });
  }

  /* --- 4d. a new property is a new property, whatever the intent was --- */
  // The tier-1 rule is keyed to the intents "has a deal" / "new property",
  // and a six-text burst that includes an address often reads as a
  // question or a check-in instead. But Subject Property just moved to a
  // house we hadn't seen — that IS the event. Run the new-property rule's
  // actions that the intent's own rule didn't already plan.
  // Two fences. Not on an offer-lifecycle intent — a counter, an
  // acceptance, a realm answer are about a house we already priced, and
  // the field being empty on first sight doesn't make it new. And not when
  // the address is already in our offer book for this agent, for the same
  // reason: "a house we hadn't seen" means the record, not the field.
  const LIFECYCLE = new Set(["counter", "acceptance", "rejection", "realm_yes", "realm_check", "proof_of_funds", "opt_out"]);
  // …and a third: the agent has to have SAID the address in this message.
  // A model can return a property off the context for a reply that named
  // none; only an address in their own words is them bringing a house.
  let subjectMoved = party === "agent" && Array.isArray(filedLearned) && filedLearned.some((l) => l.startsWith("subject property:"))
    && lastMention(job.message, draft.propertyAddress) >= 0;
  if (subjectMoved && draft.propertyAddress) {
    const known = await store.listOffers(locationId, { contactId: job.contactId, limit: 50, lean: true }).catch(() => []);
    if (known.some((o) => o?.address && addressKey(o.address) === addressKey(draft.propertyAddress))) subjectMoved = false;
  }
  if (subjectMoved && playbook && !LIFECYCLE.has(draft.intent)) {
    const already = new Set([...plan.auto, ...plan.suggested].map((a) => `${a.type}:${a.workflowId || (a.tags || []).join(",") || a.key || ""}`));
    const extra = planActions({ party, intent: "new_property", confidence: "high", playbook, minConfidence: "high" });
    const fresh = [...extra.auto, ...extra.suggested].filter((a) => !already.has(`${a.type}:${a.workflowId || (a.tags || []).join(",") || a.key || ""}`))
      .map((a) => ({ ...a, via: "subject moved" }));
    if (fresh.length) {
      for (const a of fresh) (a.mode === "auto" ? plan.auto : plan.suggested).push(a);
      record = { ...record, actions: [...record.actions, ...fresh], updatedAt: new Date().toISOString() };
      await store.updateReplyDraft(record.id, record).catch(() => {});
    }
  }

  /* --- 5. the automatic actions --- */
  let holdForBooking = "";
  if (plan.auto.length) {
    job.phase = "acting";
    const done = await runActions({
      client, locationId, contactId: job.contactId, actions: plan.auto,
      draft: { ...record, now }, deps, store,
    });
    const byId = new Map(done.map((x) => [x.id, x]));
    record = { ...record, actions: record.actions.map((x) => byId.get(x.id) || x), updatedAt: new Date().toISOString() };
    // A reply that says "you're booked" must not leave if the calendar
    // refused the booking. The draft stays, with the reason, for a person.
    const failedBooking = done.find((x) => x.type === "book_call" && x.status === "failed");
    if (failedBooking) {
      holdForBooking = `the booking failed: ${failedBooking.error || "calendar error"}`;
      record = { ...record, flags: [...(record.flags || []), holdForBooking], autoSend: { decided: false, reason: `needs a person: ${holdForBooking}` } };
    }
    await store.updateReplyDraft(record.id, record).catch(() => {});
  }

  /* --- 6. tell GHL --- */
  try { await addContactTags(client, job.contactId, [RA_TAGS.draft]); }
  catch (e) { warnings.push(`tag: ${e.message}`); }

  /* --- 7. schedule, or wait for a person --- */
  if (auto.send && draft.reply && !holdForBooking) {
    job.phase = "scheduling";
    const random = typeof deps.random === "function" ? deps.random : Math.random;
    const sendAt = scheduleFor({ config, now, intent: draft.intent, replyLength: String(draft.reply || "").length, random });
    record = { ...record, status: "scheduled", sendAt, scheduledAt: new Date(now).toISOString(), updatedAt: new Date().toISOString() };
    await store.updateReplyDraft(record.id, record);
    job.scheduledFor = sendAt;
  }
  if (config.notes?.onDraft !== false) await note(client, job.contactId, draftNote(record), warnings);

  job.status = "done";
  job.phase = "";
  job.finishedAt = new Date().toISOString();
}

const mediaDraft = (config) => ({
  intent: "media", confidence: "high", reply: config.media?.reply || "Thanks for the images, taking a look!",
  needsHuman: false, humanReason: "", summary: "Sent a photo with no text; the canned acknowledgement goes back.",
  propertyAddress: "", counterAmount: 0,
});

// Silence, the tag, and a record. Any open or scheduled draft to this
// contact is superseded — a reply that was counting down must not go out to
// someone who just said stop.
async function handleOptOut(job, ctx) {
  const { client, locationId, store, config, party, partySource, matchedTags, confidence, reason, deps = {} } = ctx;
  const warnings = job.warnings;
  job.phase = "acting";
  job.intent = "opt_out";
  job.summary = reason;
  const open = [];
  for (const status of ["draft", "scheduled"]) {
    const rows = await store.listReplyDrafts(locationId, { contactId: job.contactId, status, limit: 5 }).catch(() => []);
    open.push(...rows);
  }
  for (const old of open) {
    await store.updateReplyDraft(old.id, { ...old, status: "superseded", sendAt: null, updatedAt: new Date().toISOString() }).catch(() => {});
  }
  const planned = optOutActions(config.optOut).map((a, i) => ({
    ...a, id: `a-optout-${job.id}-${i}`, mode: confidence === "high" ? "auto" : "ask", status: "pending", party,
  }));
  const ts = new Date().toISOString();
  let record = await store.createReplyDraft({
    locationId, contactId: job.contactId, contactName: job.contactName, status: "handled", channel: job.channel,
    jobId: job.id, inbound: job.message, reply: "", intent: "opt_out", confidence, needsHuman: false, humanReason: "",
    summary: reason, propertyAddress: "", counterAmount: null, autoSendable: false,
    flags: ["an opt-out gets no reply"], party, partySource, matchedTags, autoSend: { decided: false, reason: "an opt-out gets no reply" },
    actions: planned, supersededIds: open.map((o) => o.id), warnings: warnings.slice(0, 6), promptVersion: 2, updatedAt: ts,
  });
  job.draftId = record.id;
  const toRun = planned.filter((x) => x.mode === "auto");
  if (toRun.length) {
    const done = await runActions({ client, locationId, contactId: job.contactId, actions: toRun, draft: { ...record, now: Date.now() }, deps, store });
    const byId = new Map(done.map((x) => [x.id, x]));
    record = { ...record, actions: record.actions.map((x) => byId.get(x.id) || x), updatedAt: new Date().toISOString() };
    await store.updateReplyDraft(record.id, record).catch(() => {});
  }
  if (open.length) await removeContactTags(client, job.contactId, [RA_TAGS.draft]).catch(() => {});
  const did = record.actions.filter((x) => x.status === "done").map((x) => x.detail || x.type);
  const asks = record.actions.filter((x) => x.status === "pending").map((x) => x.type.replace(/_/g, " "));
  await note(client, job.contactId,
    `Conversation AI: opt-out (${reason}). No reply was sent and none will be drafted.` +
    (did.length ? `\nDone: ${did.join("; ")}.` : "") +
    (asks.length ? `\nSuggested in the app: ${asks.join("; ")}.` : "") +
    (open.length ? `\n${open.length} pending draft${open.length === 1 ? "" : "s"} to them cancelled.` : ""),
    warnings);
  job.status = "done";
  job.phase = "";
  job.finishedAt = new Date().toISOString();
}

// The heads-up that replaces a draft nobody would have sent. No reply text
// at all: a half-written text is exactly the thing that gets skimmed and
// sent by accident, and the one fact worth surfacing is what they asked for.
async function handleNotifyOnly(job, ctx) {
  const { client, locationId, store, party, partySource, matchedTags, draft } = ctx;
  const warnings = job.warnings;
  job.phase = "acting";
  job.intent = draft.intent;
  job.summary = draft.summary;
  const what = String(draft.intent || "").replace(/_/g, " ");
  const where = draft.propertyAddress ? ` on ${draft.propertyAddress}` : "";
  const line = draft.summary || `${whoWord({ party })} wants a ${what}${where}.`;
  const record = await store.createReplyDraft({
    locationId, contactId: job.contactId, contactName: job.contactName, status: "handled", channel: job.channel,
    jobId: job.id, inbound: job.message, inboundKind: job.inboundKind || "text", reply: "", intent: draft.intent,
    confidence: draft.confidence, needsHuman: true, humanReason: `a ${what} is yours to answer`, summary: line,
    propertyAddress: draft.propertyAddress || "", counterAmount: null, autoSendable: false,
    flags: [`a ${what} is yours to answer — no reply was drafted`], party, partySource, matchedTags,
    autoSend: { decided: false, reason: `a ${what} is yours to answer` }, actions: [],
    warnings: warnings.slice(0, 6), promptVersion: 3, updatedAt: new Date().toISOString(),
  });
  job.draftId = record.id;
  await note(client, job.contactId,
    `Conversation AI: ${line}\nNo reply was drafted — a ${what} is yours to answer.`, warnings);
  job.status = "done";
  job.phase = "";
  job.finishedAt = new Date().toISOString();
}

const whoWord = (d) => (d.party === "investor" ? "The investor" : d.party === "agent" ? "The agent" : "They");

function draftNote(d) {
  const acted = (d.actions || []).filter((a) => a.status === "done").map((a) => `  • ${a.detail || a.type}`);
  const failed = (d.actions || []).filter((a) => a.status === "failed").map((a) => `  • ${a.type}: ${a.error}`);
  const asks = (d.actions || []).filter((a) => a.status === "pending").map((a) => `  • ${a.type.replace(/_/g, " ")}`);
  const learned = (d.profileUpdates?.learned || []).map((l) => `  • ${l}`);
  const what = d.outbound?.kind === "realm_check" ? `a realm check on ${d.outbound.address || d.propertyAddress} (${fmtMoney(d.outbound.amount)})` : `a reply${d.propertyAddress ? ` about ${d.propertyAddress}` : ""}`;
  return [
    d.status === "scheduled"
      ? `AI drafted ${what} and will send it itself at ${new Date(d.sendAt).toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })} unless you hold it in the app.`
      : `AI drafted ${what} — open the app to send it.`,
    ``,
    d.outbound ? `Why: ${d.summary || "numbers came back"}` : `${whoWord(d)}: ${d.summary || d.intent}`,
    d.flags.length ? `Needs you because: ${d.flags.join("; ")}` : `Would have been safe to send on its own.`,
    // The model's own reason rides along even when the page chose not to
    // hold on it — it is still the most useful line on the note.
    ...(d.needsHuman && d.humanReason && !d.flags.includes(d.humanReason) ? [`The model notes: ${d.humanReason}`] : []),
    ...(acted.length ? [``, `Done automatically:`, ...acted] : []),
    ...(failed.length ? [``, `Could not do:`, ...failed] : []),
    ...(asks.length ? [``, `Suggested (apply in the app):`, ...asks] : []),
    ...(learned.length ? [``, `Filed to their profile:`, ...learned] : []),
    ``,
    `Draft:`,
    d.reply || "(nothing — the model thought no reply was needed)",
  ].join("\n");
}

/* ---------- the try-it panel ---------- */

/**
 * previewConversation(...) — the whole pipeline with nothing persisted, no
 * GHL write, no action run and nothing scheduled. What the operator sees
 * when tuning the page.
 */
export async function previewConversation({
  client, locationId, saved, store, contactId = "", message, channel = "sms", attachments = 0,
  explicitParty = "", fakeThread = null, fakeParty = "", sendsEnabled = false, deps = {}, now = Date.now(),
}) {
  const aiApiKey = String(saved?.aiApiKey || "").trim();
  if (!aiApiKey) throw Object.assign(new Error("Anthropic API key required (Settings)"), { http: 400 });
  const nAttachments = Math.max(0, Number(attachments) || 0);
  if (!String(message || "").trim() && !nAttachments) throw Object.assign(new Error("message required"), { http: 400 });
  const warnings = [];
  const cfg = conversationConfig(saved);
  const isOptOut = detectOptOut(message, cfg.optOut);
  const a = await assembleConversation({
    client, locationId, saved, store, contactId, message, channel, explicitParty, fakeThread, fakeParty, now, warnings,
    aiApiKey, classify: deps.classify || classifyParty, light: isOptOut,
  });
  const { config, party, playbook, context } = a;
  const base = {
    party, partySource: a.partySource, matchedTags: a.matchedTags, classified: a.classified, contactName: a.contactName,
    context: { text: context.text, amounts: context.amounts, forbiddenAmounts: context.forbiddenAmounts, summary: context.summary || {} },
    transcript: String(a.transcript || "").slice(-4000),
    instructions: a.instructions, signer: a.signer, warnings,
  };
  const optOutView = (confidence, reason) => ({
    ...base, held: false, optOut: true,
    draft: { intent: "opt_out", confidence, reply: "", needsHuman: false, humanReason: "", summary: reason, propertyAddress: "", counterAmount: 0 },
    gate: { ok: true, flags: [] },
    autoSend: { would: false, reason: "an opt-out gets no reply", sendAt: null },
    actions: { auto: confidence === "high" ? optOutActions(config.optOut) : [], suggested: confidence === "high" ? [] : optOutActions(config.optOut) },
  });
  if (isOptOut) return optOutView("high", "an opt-out keyword — silence, then the opt-out actions");
  const handsOff = handsOffReason(a);
  if (handsOff) {
    return { ...base, held: true, reason: `${handsOff} — nothing would be drafted` };
  }
  if (party === "unknown" && config.routing.unknown === "hold") {
    return { ...base, held: true, reason: "no agent or investor tag on the contact — the run would hold with no draft" };
  }
  const drafter = deps.draft || draftReply;
  const draft = nAttachments > 0 && !String(message || "").trim()
    ? mediaDraft(config)
    : await drafter({
      message, transcript: a.transcript, offers: context.offers || { text: "", amounts: [], count: 0 },
      contact: { name: a.contactName, tags: a.tags }, underwriting: a.underwriting,
      instructions: a.instructions, signer: a.signer, companyContact: a.companyContact, aiApiKey, party, config, context, channel,
    });
  if (SILENT_INTENTS.has(draft.intent)) return optOutView(draft.confidence, draft.summary || "the model read an opt-out");
  const gate = evaluateReplyGates({ minConfidence: config.autoSend?.minConfidence, holdOnNeedsHuman: config.autoSend?.holdOnNeedsHuman,
    draft, party, allowedAmounts: context.amounts, forbiddenAmounts: context.forbiddenAmounts, inboundMessage: message, channel, style: config.style,
    selfName: a.signer, contactName: a.contactName, signOff: config.persona?.signOff,
  });
  const auto = decideAutoSend({ gate, party, intent: draft.intent, channel, config, sendsEnabled, humanActive: a.humanActive });
  const plan = playbook ? planActions({ party, intent: draft.intent, confidence: draft.confidence, playbook, minConfidence: config.autoSend?.minConfidence }) : { auto: [], suggested: [] };
  if (a.stampTag) plan.auto.unshift({ type: "add_tags", tags: [a.stampTag], mode: "auto", status: "pending", why: "routed by the message" });
  if (!plan.auto.length && !plan.suggested.length && playbook?.fallback?.actions?.length &&
      !(draft.intent === "small_talk" && !draft.reply) && !matchTagPatterns(a.tags, playbook.fallback.unlessTags || []).length) {
    const fb = playbook.fallback.actions.map((x) => ({ ...x, mode: playbook.fallback.mode, status: "pending", why: "no rule matched" }));
    if (playbook.fallback.mode === "auto") plan.auto.push(...fb); else plan.suggested.push(...fb);
  }
  const sendAt = auto.send
    ? scheduleFor({ config, now, intent: draft.intent, replyLength: String(draft.reply || "").length, random: deps.random || Math.random })
    : null;
  return {
    ...base, held: false, draft, gate, humanActive: a.humanActive || null,
    autoSend: { would: auto.send, reason: auto.reason, sendAt },
    actions: { auto: plan.auto, suggested: plan.suggested },
    profile: draft.profile || null,
  };
}

/* ---------- acting on a draft ---------- */

const OPEN_STATUSES = new Set(["draft", "scheduled"]);

/**
 * sendReplyDraft({ client, store, locationId, draftId, text, live, auto })
 *
 * The Send. From a person, `text` is whatever they left in the box — edited
 * or not — and is what goes out; the model's version stays on the record.
 * From the scheduler (`auto`), the draft goes as written and the row says so.
 * `live` false returns a preview and changes nothing, the same double gate
 * every other send in this codebase has.
 */
// The newest slice of a contact's thread, for the one question the auto
// send asks before it goes: did a person already answer this?
const readRecentThread = async (client, locationId, contactId) => {
  try {
    const t = await buildTranscript(client, locationId, contactId, { maxConversations: 1, maxPagesPerConvo: 1, maxMessages: 20, maxChars: 4000, maxCallTranscripts: 0 });
    return t.text || "";
  } catch { return ""; }
};

export async function sendReplyDraft({ client, store, locationId, draftId, text, live, auto = false, readThread = readRecentThread, now = Date.now() }) {
  const d = await store.getReplyDraft(draftId);
  if (!d || d.locationId !== locationId) throw Object.assign(new Error("no such draft"), { http: 404 });
  const sendable = OPEN_STATUSES.has(d.status) || (auto && d.status === "sending");
  if (!sendable) throw Object.assign(new Error(`that draft was already ${d.status}`), { http: 409 });
  const body = String(auto ? d.reply : (text ?? d.reply ?? "")).trim();
  if (!body) throw Object.assign(new Error("nothing to send"), { http: 400 });

  if (!live) {
    return { ok: true, dryRun: true, preview: { channel: d.channel, to: d.contactId, message: body } };
  }

  // Pick back up, don't pile on. If a person answered this thread after the
  // draft was written, the bot stands aside for this one — the draft is
  // dismissed and says so — and picks up again on the next inbound. A
  // person pressing Send is a person deciding, so only the auto path asks.
  if (auto) {
    const transcript = await readThread(client, locationId, d.contactId);
    const theirs = await humanHasThread({ store, locationId, contactId: d.contactId, transcript, minutes: 7 * 24 * 60, now });
    if (theirs && Date.parse(theirs.at) >= Date.parse(d.createdAt) - 60000) {
      const ts = new Date(now).toISOString();
      await store.updateReplyDraft(d.id, {
        ...d, status: "dismissed", answeredBy: "you", sendAt: null, sendingAt: null, dismissedAt: ts, updatedAt: ts,
        flags: [...(d.flags || []), "you answered it yourself — the bot stood aside"],
      });
      await removeContactTags(client, d.contactId, [RA_TAGS.draft]).catch(() => {});
      return { ok: true, skipped: "answered by you", at: theirs.at };
    }
  }

  let result;
  if (d.channel === "email") {
    const subject = d.propertyAddress ? `Re: ${d.propertyAddress}` : "Re: your message";
    const html = body.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");
    result = await sendEmail(client, { contactId: d.contactId, subject, html });
  } else {
    result = await sendSms(client, { contactId: d.contactId, message: body });
  }

  const ts = new Date().toISOString();
  const updated = {
    ...d, status: "sent", sentAt: ts, sentText: body, autoSent: Boolean(auto),
    edited: auto ? false : body !== String(d.reply || "").trim(),
    ghlMessageId: result?.messageId || result?.id || null, sendAt: null, sendingAt: null, updatedAt: ts,
  };
  await store.updateReplyDraft(d.id, updated);
  await removeContactTags(client, d.contactId, [RA_TAGS.draft]).catch(() => {});
  // The first cold text is the outreach ladder's trigger, so it goes on the
  // timeline the moment it actually leaves — not when it was drafted.
  if (d.outbound?.kind === "blast_open") {
    // The record the feedback package needs: who was pitched, when, which
    // deal. And the investor's own lastBlastAt, which the shortlist filters on.
    await recordEvent({
      store, locationId, contactId: d.contactId, party: "investor", type: "blast_sent", at: ts,
      address: d.outbound.address || d.propertyAddress || "", offerId: d.outbound.offerId || null, source: "blast", ref: d.id,
      dedupeKey: `blast:${d.outbound.offerId || "deal"}:${d.contactId}`,
      data: { draftId: d.id, auto: Boolean(auto), label: d.outbound.label || "", via: "app" },
    }).catch(() => {});
    await store.setInvestorStatus?.(locationId, d.contactId, { lastBlastAt: ts }).catch(() => {});
  }
  if (d.outbound?.kind === "outreach_open") {
    await recordEvent({
      store, locationId, contactId: d.contactId, party: "agent", type: "outreach_sent", at: ts,
      address: d.outbound.address || d.propertyAddress || "", source: "conversation", ref: d.id,
      dedupeKey: `outreach:${d.contactId}:${d.id}`,
      data: { draftId: d.id, auto: Boolean(auto), contactName: d.contactName || "" },
    }).catch(() => {});
  }
  if (auto && d.noteOnAutoSend !== false) {
    await createContactNote(client, d.contactId, {
      body: `Conversation AI sent this reply itself (${d.party || "agent"} · ${String(d.intent || "").replace(/_/g, " ")}):\n\n${body}`,
    }).catch(() => {});
  }
  return { ok: true, dryRun: false, draft: updated };
}

export async function dismissReplyDraft({ client, store, locationId, draftId }) {
  const d = await store.getReplyDraft(draftId);
  if (!d || d.locationId !== locationId) throw Object.assign(new Error("no such draft"), { http: 404 });
  if (!OPEN_STATUSES.has(d.status)) return { ok: true, draft: d };
  const updated = { ...d, status: "dismissed", sendAt: null, updatedAt: new Date().toISOString() };
  await store.updateReplyDraft(d.id, updated);
  await removeContactTags(client, d.contactId, [RA_TAGS.draft]).catch(() => {});
  return { ok: true, draft: updated };
}

// The operator's Hold: a scheduled reply goes back to being a draft that
// waits for them. The flag says so, so the history shows it was a person who
// stopped it rather than a gate.
export async function holdReplyDraft({ store, locationId, draftId }) {
  const d = await store.getReplyDraft(draftId);
  if (!d || d.locationId !== locationId) throw Object.assign(new Error("no such draft"), { http: 404 });
  if (d.status !== "scheduled") return { ok: true, draft: d };
  const ts = new Date().toISOString();
  const updated = {
    ...d, status: "draft", sendAt: null, heldAt: ts,
    flags: [...(d.flags || []), "held by you"], autoSend: { ...(d.autoSend || {}), decided: false, reason: "held by you" },
    updatedAt: ts,
  };
  await store.updateReplyDraft(d.id, updated);
  return { ok: true, draft: updated };
}

// Apply one suggested action from the row.
export async function applyDraftAction({ client, store, locationId, draftId, actionId, deps = {} }) {
  const d = await store.getReplyDraft(draftId);
  if (!d || d.locationId !== locationId) throw Object.assign(new Error("no such draft"), { http: 404 });
  const action = (d.actions || []).find((a) => a.id === actionId);
  if (!action) throw Object.assign(new Error("no such action on that draft"), { http: 404 });
  if (action.status !== "pending") throw Object.assign(new Error(`that action was already ${action.status}`), { http: 409 });
  const [done] = await runActions({ client, locationId, contactId: d.contactId, actions: [action], draft: d, deps, store });
  const applied = { ...done, status: done.status === "done" ? "applied" : done.status };
  const updated = { ...d, actions: d.actions.map((a) => (a.id === actionId ? applied : a)), updatedAt: new Date().toISOString() };
  await store.updateReplyDraft(d.id, updated);
  return { ok: true, action: applied, draft: updated };
}

const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
