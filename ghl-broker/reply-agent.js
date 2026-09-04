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
import { buildTranscript, enrichFieldDefs, mergeHistory } from "./enrich.js";
import { findOrCreateCustomFieldByKey, updateContact } from "./ghl.js";
import { matchTagPatterns } from "./conversation-party.js";
import { anthropicErrorToHttp } from "./rehab-scan.js";
import { fmtMoney } from "./shared/offer-calc.js";
import {
  normalizeConversationAi, INTENTS, NEVER_AUTO, autoEligible, PARTY_LABEL, CONFIDENCES,
  SILENT_INTENTS, OUTBOUND_INTENTS, detectOptOut, optOutActions,
} from "./shared/conversation-ai.js";
import {
  getContact, createContactNote, addContactTags, removeContactTags, sendSms, sendEmail,
} from "./ghl.js";
import { listJobs as listUnderwriteJobs } from "./auto-underwrite.js";
import { resolveParty } from "./conversation-party.js";
import {
  loadContactContext, loadAgentContext, loadInvestorContext, summarizeOffers, RA_OFFERS_IN_CONTEXT,
} from "./conversation-context.js";
import {
  buildSystemPrompt, buildUserContext, schemaFor, CLASSIFY_SYSTEM, CLASSIFY_SCHEMA, buildClassifyContext,
} from "./conversation-prompt.js";
import { planActions, runActions } from "./conversation-actions.js";
import { pickDelayMs, nextSendTime } from "./conversation-scheduler.js";

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
  underwriting = [], instructions = "", signer = "", aiApiKey,
  party = "agent", config = null, context = null, channel = "sms", outbound = null,
}) {
  const client = new Anthropic({ apiKey: aiApiKey, timeout: 120_000 });
  const cfg = config || normalizeConversationAi(null);
  const ctx = context || {
    text: offers.count
      ? `OUR OFFERS TO THIS AGENT (newest first — the only numbers you may quote):\n${offers.text}`
      : "",
  };
  const system = buildSystemPrompt({ config: cfg, party, channel });
  const user = buildUserContext({ party, contact, signer, instructions, context: ctx, underwriting, transcript, message, outbound });
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
      system,
      output_config: { format: { type: "json_schema", schema: schemaFor(party, { outbound }) } },
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
    profile: normalizeProfile(p.profile),
  };
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
      max_tokens: 400,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: CLASSIFY_SYSTEM,
      output_config: { format: { type: "json_schema", schema: CLASSIFY_SCHEMA } },
      messages: [{ role: "user", content: [{ type: "text", text: buildClassifyContext({ contact, transcript, message }) }] }],
    });
  } catch (e) {
    throw anthropicErrorToHttp(e);
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
export function evaluateReplyGates({
  draft, party = "agent", allowedAmounts = [], forbiddenAmounts = [], inboundMessage = "", channel = "sms", style = null,
}) {
  const flags = [];
  if (!draft) return { ok: false, flags: ["no draft was produced"] };
  const never = NEVER_AUTO[party] || NEVER_AUTO.agent;
  const maxSms = Number(style?.maxSmsChars) > 0 ? Number(style.maxSmsChars) : RA_MAX_SMS_CHARS;

  const known = [...(INTENTS[party] || INTENTS.agent), ...(OUTBOUND_INTENTS[party] || [])];
  if (never.includes(draft.intent) || !known.includes(draft.intent)) {
    flags.push(`a ${String(draft.intent).replace(/_/g, " ")} is a person's call`);
  }
  if (draft.needsHuman) {
    flags.push(draft.humanReason || "the model asked for a person");
  }
  if (draft.confidence !== "high") {
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
  return { ok: flags.length === 0, flags };
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
  if (!gate?.ok) return { send: false, reason: gate?.flags?.[0] ? `needs a person: ${gate.flags[0]}` : "the gates did not pass" };
  if (!config?.enabled) return { send: false, reason: "Conversation AI is switched off" };
  if (humanActive) return { send: false, reason: `you replied to them ${humanActive.minutesAgo} minute${humanActive.minutesAgo === 1 ? "" : "s"} ago — you have the thread` };
  if (!sendsEnabled) return { send: false, reason: "sends are off on the broker (CARD_SENDS_ENABLED)" };
  const playbook = config.parties?.[party];
  if (!playbook) return { send: false, reason: "an unknown contact never auto-sends" };
  if (!playbook.autoSend?.enabled) return { send: false, reason: `auto-send is off for ${PARTY_LABEL[party].toLowerCase()}s` };
  if ((NEVER_AUTO[party] || []).includes(intent)) return { send: false, reason: `a ${intent.replace(/_/g, " ")} is a person's call` };
  if (!(playbook.autoSend.intents || []).includes(intent)) return { send: false, reason: `${intent.replace(/_/g, " ")} is not on the ${party} auto-send list` };
  if (!(config.autoSend?.channels || []).includes(channel)) return { send: false, reason: `${channel} replies don't auto-send` };
  return { send: true, reason: "" };
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

// Comma-separated facts, merged: what they told us before plus what is new,
// deduped case-insensitively, oldest first, capped.
export function mergeFacts(existing, additions, max = 1500) {
  const split = (v) => String(v || "").split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const f of [...split(existing), ...split(additions)]) {
    const k = f.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  let text = out.join(", ");
  while (out.length > 1 && text.length > max) { out.shift(); text = out.join(", "); }
  return text.slice(0, max);
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
export async function applyProfileUpdates({ client, locationId, contactId, party, profile, custom = {}, summary = "", config, now = Date.now(), warnings = [] }) {
  if (!profile || !contactId || party === "unknown") return { learned: [], written: [] };
  const type = party === "investor" ? "investor" : "agent";
  const defs = new Map(enrichFieldDefs(type).map((f) => [f.key, f]));
  const today = new Date(now).toISOString().slice(0, 10);
  const writes = {};
  const learned = [];
  const cur = (k) => String(custom?.[k] ?? "").trim();

  if (profile.personalDetails) {
    const merged = mergeFacts(cur("personal_details"), profile.personalDetails);
    if (merged !== cur("personal_details")) { writes.personal_details = merged; learned.push(`personal: ${profile.personalDetails}`); }
  }
  const areasKey = type === "investor" ? "buybox_areas" : "agent_market_area";
  if (profile.marketAreas) {
    const merged = mergeFacts(cur(areasKey), profile.marketAreas, 600);
    if (merged !== cur(areasKey)) { writes[areasKey] = merged; learned.push(`areas: ${profile.marketAreas}`); }
  }
  if (profile.dealHistoryLine && profile.dealHistoryLine.includes("|")) {
    const key = type === "investor" ? "investor_deal_history" : "agent_deal_history";
    const line = /^\d{4}-\d{2}-\d{2}/.test(profile.dealHistoryLine) ? profile.dealHistoryLine : `${today} | ${profile.dealHistoryLine}`;
    const merged = mergeHistory(cur(key), [line]);
    if (merged !== cur(key)) { writes[key] = merged; learned.push(`history: ${profile.dealHistoryLine}`); }
  }
  if (profile.nextAction && profile.nextAction !== cur("suggested_next_action")) {
    writes.suggested_next_action = profile.nextAction;
  }
  if (type === "investor") {
    const num = (k) => Number(String(cur(k)).replace(/[$,\s]/g, "")) || 0;
    if (profile.priceMin && profile.priceMin !== num("buybox_price_min")) { writes.buybox_price_min = profile.priceMin; learned.push(`buys from ${fmtMoney(profile.priceMin)}`); }
    if (profile.priceMax && profile.priceMax !== num("buybox_price_max")) { writes.buybox_price_max = profile.priceMax; learned.push(`buys up to ${fmtMoney(profile.priceMax)}`); }
    if (profile.propertyTypes) {
      const allowed = defs.get("buybox_property_types")?.values || [];
      const types = profile.propertyTypes.split(",").map((t) => t.trim().replace(/[\s-]+/g, "_")).filter((t) => allowed.includes(t));
      const merged = mergeFacts(cur("buybox_property_types"), types.join(", "), 200);
      if (types.length && merged !== cur("buybox_property_types")) { writes.buybox_property_types = merged; learned.push(`types: ${types.join(", ")}`); }
    }
    if (profile.rehabAppetite && profile.rehabAppetite !== cur("rehab_appetite")) { writes.rehab_appetite = profile.rehabAppetite; learned.push(`rehab: ${profile.rehabAppetite.replace(/_/g, " ")}`); }
    if (profile.exclusions) {
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

  // The tag that would route them next time, when the words placed them.
  const stampTag = partySource === "classified" && config.routing.tagOnClassify
    ? (config.routing[party === "investor" ? "investorTags" : "agentTags"] || []).find((t) => !t.includes("*")) || null
    : null;

  return {
    config, party, partySource, matchedTags: resolved.matched, classified, stampTag, botOff, humanActive,
    playbook, contact, contactName: name, tags, custom, transcript, context, underwriting, instructions, signer,
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
  attachments = 0,
}) {
  const aiApiKey = String(saved?.aiApiKey || "").trim();
  if (!aiApiKey) throw Object.assign(new Error("Anthropic API key required (Settings)"), { http: 400 });
  const nAttachments = Math.max(0, Number(attachments) || 0);
  if (!String(message || "").trim() && !nAttachments) throw Object.assign(new Error("message required"), { http: 400 });

  const config = conversationConfig(saved);
  if (!config.enabled) return { skipped: "Conversation AI is switched off on the Conversation AI page", job: null };

  const cap = config.dailyCap || RA_DEFAULT_DAILY_CAP;
  const usedToday = await countToday({ store, locationId });
  if (usedToday >= cap) {
    return { skipped: `daily cap reached (${usedToday}/${cap})`, job: null };
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

/**
 * startProactive({ client, locationId, saved, store, contactId, kind, offer, sendsEnabled, deps })
 *
 * A message the bot STARTS. Today one kind: the realm check — an
 * auto-underwrite just landed an offer for this agent, and before the formal
 * offer goes over the bot floats the number as a soft one and asks whether
 * it's in the realm. Same lane, same gates, same outbox as a reply; the
 * number is in the offer book, so the money guard allows it. Sends itself
 * only when realm_check is on the agent's auto-send list. Returns the job,
 * or { skipped } when the playbook has it off.
 */
export async function startProactive({ client, locationId, saved, store, contactId, kind = "realm_check", offer, sendsEnabled = false, deps = {} }) {
  const aiApiKey = String(saved?.aiApiKey || "").trim();
  if (!aiApiKey) throw Object.assign(new Error("Anthropic API key required (Settings)"), { http: 400 });
  const config = conversationConfig(saved);
  if (!config.enabled) return { skipped: "Conversation AI is switched off", job: null };
  if (kind !== "realm_check") return { skipped: `unknown outbound kind ${kind}`, job: null };
  if (!config.parties.agent.realmCheck?.enabled) return { skipped: "realm check is off for agents", job: null };
  if (!offer?.cashAmount) return { skipped: "the offer has no number to float", job: null };
  if (!contactId) return { skipped: "the offer has no contact", job: null };

  const job = {
    id: newJobId(), locationId, contactId, contactName: "", status: "queued", phase: "queued",
    channel: "sms", message: "", attachments: 0, party: "agent", partySource: "offer", outbound: kind,
    offerId: offer.id || null, draftId: null, intent: kind, summary: "", heldReason: null, scheduledFor: null,
    warnings: [], error: null, startedAt: new Date().toISOString(), finishedAt: null,
  };
  jobs.set(job.id, job);
  runOnLane(locationId, () =>
    runProactive(job, { client, locationId, saved, store, aiApiKey, sendsEnabled, offer, config, deps: { ...deps, draft: deps.draft || draftReply } })
      .catch(async (e) => {
        job.status = "error";
        job.error = String(e?.message || e).slice(0, 300);
        job.finishedAt = new Date().toISOString();
        await note(client, contactId, `AI realm check could not be drafted — ${job.error}. The offer is in History; float the number by hand if you like.`, job.warnings);
      })
  );
  return { skipped: null, job };
}

async function runProactive(job, ctx) {
  const { client, locationId, saved, store, aiApiKey, sendsEnabled, offer, config, deps } = ctx;
  const now = typeof deps.now === "function" ? deps.now() : Date.now();
  const warnings = job.warnings;
  job.status = "running";
  job.phase = "reading";
  const a = await assembleConversation({
    client, locationId, saved, store, contactId: job.contactId, message: "", channel: "sms",
    explicitParty: "agent", now, warnings, aiApiKey,
  });
  job.contactName = a.contactName;
  if (a.botOff?.length) {
    job.status = "held"; job.phase = ""; job.heldReason = `bot is off for this contact (tag: ${a.botOff[0]})`; job.finishedAt = new Date().toISOString();
    return;
  }
  const { context } = a;
  const closeDays = offer.terms?.closingDays || saved?.psa?.closingDays || 0;
  const terms = [closeDays ? `${closeDays}-day close` : "", "as-is"].filter(Boolean).join(", ");
  const asking = Number(offer.askingPrice || offer.calc?.inputs?.askingPrice) || 0;
  const outbound = {
    kind: "realm_check", address: offer.address || "the property", amount: offer.cashAmount,
    amountText: fmtMoney(offer.cashAmount), askingText: asking ? fmtMoney(asking) : "", terms,
  };

  job.phase = "drafting";
  const draft = await deps.draft({
    message: "", transcript: a.transcript, offers: context.offers || { text: "", amounts: [], count: 0 },
    contact: { name: a.contactName, tags: a.tags }, underwriting: [], instructions: a.instructions, signer: a.signer,
    aiApiKey, party: "agent", config, context, channel: "sms", outbound,
  });
  draft.intent = "realm_check";
  job.summary = draft.summary;
  // The number it floats is the offer's; the guard sees it either way.
  const allowed = [...new Set([...(context.amounts || []), Math.round(offer.cashAmount)])];
  const gate = evaluateReplyGates({ draft, party: "agent", allowedAmounts: allowed, forbiddenAmounts: context.forbiddenAmounts, inboundMessage: "", channel: "sms", style: config.style });
  const auto = decideAutoSend({ gate, party: "agent", intent: "realm_check", channel: "sms", config, sendsEnabled, humanActive: a.humanActive });

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
    inbound: "", outbound: { kind: "realm_check", offerId: offer.id || null, address: offer.address || "", amount: offer.cashAmount },
    reply: draft.reply, intent: "realm_check", confidence: draft.confidence, needsHuman: draft.needsHuman, humanReason: draft.humanReason,
    summary: draft.summary || `Floats our ${fmtMoney(offer.cashAmount)} on ${offer.address} and asks if it's in the realm.`,
    propertyAddress: offer.address || draft.propertyAddress || "", counterAmount: null,
    autoSendable: gate.ok, flags: gate.flags, party: "agent", partySource: "offer", matchedTags: a.matchedTags,
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
    const sendAt = nextSendTime({ now, delayMs: pickDelayMs(config, random), quietHours: config.autoSend.quietHours });
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
  if (detectOptOut(job.message, cfg.optOut)) {
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

  if (a.botOff?.length) {
    // The operator turned the bot off for this contact. No draft, no note —
    // they know.
    job.status = "held";
    job.phase = "";
    job.heldReason = `bot is off for this contact (tag: ${a.botOff[0]})`;
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

  /* --- 2. the draft --- */
  job.phase = "drafting";
  let draft;
  if (job.attachments > 0 && !String(job.message || "").trim()) {
    // A bare photo gets the canned line and no model call — the rule is
    // "never analyse the image", and the surest way not to is not to look.
    draft = mediaDraft(config);
  } else {
    draft = await deps.draft({
      message: job.message,
      transcript: a.transcript,
      offers: context.offers || { text: "", amounts: [], count: 0 },
      contact: { name: a.contactName, tags: a.tags },
      underwriting: a.underwriting,
      instructions: a.instructions,
      signer: a.signer,
      aiApiKey,
      party, config, context, channel: job.channel,
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

  const gate = evaluateReplyGates({
    draft, party, allowedAmounts: context.amounts, forbiddenAmounts: context.forbiddenAmounts,
    inboundMessage: job.message, channel: job.channel, style: config.style,
  });
  const auto = decideAutoSend({ gate, party, intent: draft.intent, channel: job.channel, config, sendsEnabled, humanActive: a.humanActive });
  const plan = playbook ? planActions({ party, intent: draft.intent, confidence: draft.confidence, playbook }) : { auto: [], suggested: [] };
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
  let record = await store.createReplyDraft({
    locationId,
    contactId: job.contactId,
    contactName: job.contactName,
    status: "draft",
    channel: job.channel,
    jobId: job.id,
    inbound: job.message,
    reply: draft.reply,
    intent: draft.intent,
    confidence: draft.confidence,
    needsHuman: draft.needsHuman,
    humanReason: draft.humanReason,
    summary: draft.summary,
    propertyAddress: draft.propertyAddress,
    counterAmount: draft.counterAmount || null,
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
    humanActive: a.humanActive || null,
    actions: [...plan.auto, ...plan.suggested],
    supersededIds: open.map((o) => o.id),
    warnings: warnings.slice(0, 6),
    noteOnAutoSend: config.notes?.onAutoSend !== false,
    promptVersion: 3,
    updatedAt: ts,
  });
  job.draftId = record.id;

  /* --- 4b. what we learned about them --- */
  if (config.profile?.enabled && draft.profile) {
    job.phase = "filing";
    const filed = await applyProfileUpdates({
      client, locationId, contactId: job.contactId, party, profile: draft.profile, custom: a.custom,
      summary: draft.summary, config, now, warnings,
    });
    if (filed.learned.length || filed.written.length) {
      record = { ...record, profileUpdates: { learned: filed.learned, written: filed.written }, warnings: warnings.slice(0, 6), updatedAt: new Date().toISOString() };
      await store.updateReplyDraft(record.id, record).catch(() => {});
    }
  }

  /* --- 5. the automatic actions --- */
  if (plan.auto.length) {
    job.phase = "acting";
    const done = await runActions({
      client, locationId, contactId: job.contactId, actions: plan.auto,
      draft: { ...record, now }, deps,
    });
    const byId = new Map(done.map((x) => [x.id, x]));
    record = { ...record, actions: record.actions.map((x) => byId.get(x.id) || x), updatedAt: new Date().toISOString() };
    await store.updateReplyDraft(record.id, record).catch(() => {});
  }

  /* --- 6. tell GHL --- */
  try { await addContactTags(client, job.contactId, [RA_TAGS.draft]); }
  catch (e) { warnings.push(`tag: ${e.message}`); }

  /* --- 7. schedule, or wait for a person --- */
  if (auto.send && draft.reply) {
    job.phase = "scheduling";
    const random = typeof deps.random === "function" ? deps.random : Math.random;
    const sendAt = nextSendTime({ now, delayMs: pickDelayMs(config, random), quietHours: config.autoSend.quietHours });
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
    const done = await runActions({ client, locationId, contactId: job.contactId, actions: toRun, draft: { ...record, now: Date.now() }, deps });
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
  if (a.botOff?.length) {
    return { ...base, held: true, reason: `the bot is off for this contact (tag: ${a.botOff[0]}) — nothing would be drafted` };
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
      instructions: a.instructions, signer: a.signer, aiApiKey, party, config, context, channel,
    });
  if (SILENT_INTENTS.has(draft.intent)) return optOutView(draft.confidence, draft.summary || "the model read an opt-out");
  const gate = evaluateReplyGates({
    draft, party, allowedAmounts: context.amounts, forbiddenAmounts: context.forbiddenAmounts, inboundMessage: message, channel, style: config.style,
  });
  const auto = decideAutoSend({ gate, party, intent: draft.intent, channel, config, sendsEnabled, humanActive: a.humanActive });
  const plan = playbook ? planActions({ party, intent: draft.intent, confidence: draft.confidence, playbook }) : { auto: [], suggested: [] };
  if (a.stampTag) plan.auto.unshift({ type: "add_tags", tags: [a.stampTag], mode: "auto", status: "pending", why: "routed by the message" });
  if (!plan.auto.length && !plan.suggested.length && playbook?.fallback?.actions?.length &&
      !(draft.intent === "small_talk" && !draft.reply) && !matchTagPatterns(a.tags, playbook.fallback.unlessTags || []).length) {
    const fb = playbook.fallback.actions.map((x) => ({ ...x, mode: playbook.fallback.mode, status: "pending", why: "no rule matched" }));
    if (playbook.fallback.mode === "auto") plan.auto.push(...fb); else plan.suggested.push(...fb);
  }
  const sendAt = auto.send
    ? nextSendTime({ now, delayMs: pickDelayMs(config, deps.random || Math.random), quietHours: config.autoSend.quietHours })
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
export async function sendReplyDraft({ client, store, locationId, draftId, text, live, auto = false }) {
  const d = await store.getReplyDraft(draftId);
  if (!d || d.locationId !== locationId) throw Object.assign(new Error("no such draft"), { http: 404 });
  const sendable = OPEN_STATUSES.has(d.status) || (auto && d.status === "sending");
  if (!sendable) throw Object.assign(new Error(`that draft was already ${d.status}`), { http: 409 });
  const body = String(auto ? d.reply : (text ?? d.reply ?? "")).trim();
  if (!body) throw Object.assign(new Error("nothing to send"), { http: 400 });

  if (!live) {
    return { ok: true, dryRun: true, preview: { channel: d.channel, to: d.contactId, message: body } };
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
  const [done] = await runActions({ client, locationId, contactId: d.contactId, actions: [action], draft: d, deps });
  const applied = { ...done, status: done.status === "done" ? "applied" : done.status };
  const updated = { ...d, actions: d.actions.map((a) => (a.id === actionId ? applied : a)), updatedAt: new Date().toISOString() };
  await store.updateReplyDraft(d.id, updated);
  return { ok: true, action: applied, draft: updated };
}

const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
