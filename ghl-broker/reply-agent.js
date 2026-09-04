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
import { buildTranscript } from "./enrich.js";
import { anthropicErrorToHttp } from "./rehab-scan.js";
import { fmtMoney } from "./shared/offer-calc.js";
import {
  normalizeConversationAi, INTENTS, NEVER_AUTO, autoEligible, PARTY_LABEL, CONFIDENCES,
} from "./shared/conversation-ai.js";
import {
  getContact, createContactNote, addContactTags, removeContactTags, sendSms, sendEmail,
} from "./ghl.js";
import { listJobs as listUnderwriteJobs } from "./auto-underwrite.js";
import { resolveParty } from "./conversation-party.js";
import {
  loadContactContext, loadAgentContext, loadInvestorContext, summarizeOffers, RA_OFFERS_IN_CONTEXT,
} from "./conversation-context.js";
import { buildSystemPrompt, buildUserContext, schemaFor } from "./conversation-prompt.js";
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
  party = "agent", config = null, context = null, channel = "sms",
}) {
  const client = new Anthropic({ apiKey: aiApiKey, timeout: 120_000 });
  const cfg = config || normalizeConversationAi(null);
  const ctx = context || {
    text: offers.count
      ? `OUR OFFERS TO THIS AGENT (newest first — the only numbers you may quote):\n${offers.text}`
      : "",
  };
  const system = buildSystemPrompt({ config: cfg, party, channel });
  const user = buildUserContext({ party, contact, signer, instructions, context: ctx, underwriting, transcript, message });
  const intents = INTENTS[party] || INTENTS.agent;

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
      output_config: { format: { type: "json_schema", schema: schemaFor(party) } },
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
    reply: String(p.reply || "").trim(),
    needsHuman: Boolean(p.needsHuman),
    humanReason: String(p.humanReason || "").trim().slice(0, 300),
    summary: String(p.summary || "").trim().slice(0, 300),
    propertyAddress: String(p.propertyAddress || "").trim().slice(0, 200),
    counterAmount: Math.max(0, Number(p.counterAmount) || 0),
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
  draft, party = "agent", allowedAmounts = [], forbiddenAmounts = [], inboundMessage = "", channel = "sms",
}) {
  const flags = [];
  if (!draft) return { ok: false, flags: ["no draft was produced"] };
  const never = NEVER_AUTO[party] || NEVER_AUTO.agent;

  if (never.includes(draft.intent) || !(INTENTS[party] || INTENTS.agent).includes(draft.intent)) {
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
  if (channel === "sms" && draft.reply.length > RA_MAX_SMS_CHARS) {
    flags.push(`${draft.reply.length} characters is too long for a text`);
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
export function decideAutoSend({ gate, party = "agent", intent = "other", channel = "sms", config, sendsEnabled = false }) {
  if (!gate?.ok) return { send: false, reason: gate?.flags?.[0] ? `needs a person: ${gate.flags[0]}` : "the gates did not pass" };
  if (!config?.enabled) return { send: false, reason: "Conversation AI is switched off" };
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
  const party = resolved.party;

  // The real thread when there is a contact, and after it whatever the test
  // window typed — so a test on a real contact is "their conversation so far,
  // then this", which is exactly what a live run would see next.
  let real = "";
  if (contactId) {
    try {
      const t = await buildTranscript(client, locationId, contactId, {
        maxConversations: 2, maxPagesPerConvo: 1, maxMessages: 60, maxChars: 14000, maxCallTranscripts: 0,
      });
      real = t.text || "";
    } catch (e) {
      warnings.push(`thread: ${e.message?.slice(0, 120) || "could not be read"}`);
    }
  }
  const typed = fakeThread ? renderFakeThread(fakeThread, channel) : "";
  const transcript = [real, typed].filter(Boolean).join("\n");

  const custom = contact ? await loadContactContext({ client, locationId, contact }) : {};

  let context = { text: "", amounts: [], forbiddenAmounts: [], summary: {} };
  let underwriting = [];
  if (party === "agent") {
    context = await loadAgentContext({ store, locationId, contactId, custom, now });
    underwriting = listUnderwriteJobs(locationId)
      .filter((j) => j.contactId === contactId && (j.status === "running" || j.status === "queued"))
      .map((j) => j.address || "a property")
      .slice(0, 3);
  } else if (party === "investor") {
    context = await loadInvestorContext({ store, locationId, contactId, contactName: name, custom, settings: saved || {}, now });
  }

  const playbook = config.parties?.[party] || null;
  const instructions = playbook ? playbook.instructions : config.routing.genericInstructions;
  const signer = config.persona.name || saved?.company?.signer || saved?.company?.name || "";

  return {
    config, party, partySource: resolved.source, matchedTags: resolved.matched,
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
}) {
  const aiApiKey = String(saved?.aiApiKey || "").trim();
  if (!aiApiKey) throw Object.assign(new Error("Anthropic API key required (Settings)"), { http: 400 });
  if (!String(message || "").trim()) throw Object.assign(new Error("message required"), { http: 400 });

  const config = conversationConfig(saved);
  if (!config.enabled) return { skipped: "Conversation AI is switched off on the Conversation AI page", job: null };

  const cap = config.dailyCap || RA_DEFAULT_DAILY_CAP;
  const usedToday = await countToday({ store, locationId });
  if (usedToday >= cap) {
    return { skipped: `daily cap reached (${usedToday}/${cap})`, job: null };
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

  runOnLane(locationId, () =>
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
  return { skipped: null, job };
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

  /* --- 1. who and what --- */
  job.phase = "reading";
  const a = await assembleConversation({
    client, locationId, saved, store, contactId: job.contactId, message: job.message, channel: job.channel,
    explicitParty: job.party, now, warnings,
  });
  const { config, party, playbook, context } = a;
  job.party = party;
  job.partySource = a.partySource;
  job.contactName = a.contactName;

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
  const draft = await deps.draft({
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
  job.intent = draft.intent;
  job.summary = draft.summary;

  const gate = evaluateReplyGates({
    draft, party, allowedAmounts: context.amounts, forbiddenAmounts: context.forbiddenAmounts,
    inboundMessage: job.message, channel: job.channel,
  });
  const auto = decideAutoSend({ gate, party, intent: draft.intent, channel: job.channel, config, sendsEnabled });
  const plan = playbook ? planActions({ party, intent: draft.intent, confidence: draft.confidence, playbook }) : { auto: [], suggested: [] };

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
    contextSummary: context.summary || {},
    offersInContext: context.offers?.count ?? 0,
    autoSend: { decided: auto.send, reason: auto.reason },
    actions: [...plan.auto, ...plan.suggested],
    supersededIds: open.map((o) => o.id),
    warnings: warnings.slice(0, 6),
    promptVersion: 2,
    updatedAt: ts,
  });
  job.draftId = record.id;

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
  await note(client, job.contactId, draftNote(record), warnings);

  job.status = "done";
  job.phase = "";
  job.finishedAt = new Date().toISOString();
}

const whoWord = (d) => (d.party === "investor" ? "The investor" : d.party === "agent" ? "The agent" : "They");

function draftNote(d) {
  const acted = (d.actions || []).filter((a) => a.status === "done").map((a) => `  • ${a.detail || a.type}`);
  const failed = (d.actions || []).filter((a) => a.status === "failed").map((a) => `  • ${a.type}: ${a.error}`);
  const asks = (d.actions || []).filter((a) => a.status === "pending").map((a) => `  • ${a.type.replace(/_/g, " ")}`);
  return [
    d.status === "scheduled"
      ? `AI drafted a reply${d.propertyAddress ? ` about ${d.propertyAddress}` : ""} and will send it itself at ${new Date(d.sendAt).toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })} unless you hold it in the app.`
      : `AI drafted a reply${d.propertyAddress ? ` about ${d.propertyAddress}` : ""} — open the app to send it.`,
    ``,
    `${whoWord(d)}: ${d.summary || d.intent}`,
    d.flags.length ? `Needs you because: ${d.flags.join("; ")}` : `Would have been safe to send on its own.`,
    ...(acted.length ? [``, `Done automatically:`, ...acted] : []),
    ...(failed.length ? [``, `Could not do:`, ...failed] : []),
    ...(asks.length ? [``, `Suggested (apply in the app):`, ...asks] : []),
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
  client, locationId, saved, store, contactId = "", message, channel = "sms",
  explicitParty = "", fakeThread = null, fakeParty = "", sendsEnabled = false, deps = {}, now = Date.now(),
}) {
  const aiApiKey = String(saved?.aiApiKey || "").trim();
  if (!aiApiKey) throw Object.assign(new Error("Anthropic API key required (Settings)"), { http: 400 });
  if (!String(message || "").trim()) throw Object.assign(new Error("message required"), { http: 400 });
  const warnings = [];
  const a = await assembleConversation({
    client, locationId, saved, store, contactId, message, channel, explicitParty, fakeThread, fakeParty, now, warnings,
  });
  const { config, party, playbook, context } = a;
  const base = {
    party, partySource: a.partySource, matchedTags: a.matchedTags, contactName: a.contactName,
    context: { text: context.text, amounts: context.amounts, forbiddenAmounts: context.forbiddenAmounts, summary: context.summary || {} },
    transcript: String(a.transcript || "").slice(-4000),
    instructions: a.instructions, signer: a.signer, warnings,
  };
  if (party === "unknown" && config.routing.unknown === "hold") {
    return { ...base, held: true, reason: "no agent or investor tag on the contact — the run would hold with no draft" };
  }
  const drafter = deps.draft || draftReply;
  const draft = await drafter({
    message, transcript: a.transcript, offers: context.offers || { text: "", amounts: [], count: 0 },
    contact: { name: a.contactName, tags: a.tags }, underwriting: a.underwriting,
    instructions: a.instructions, signer: a.signer, aiApiKey, party, config, context, channel,
  });
  const gate = evaluateReplyGates({
    draft, party, allowedAmounts: context.amounts, forbiddenAmounts: context.forbiddenAmounts, inboundMessage: message, channel,
  });
  const auto = decideAutoSend({ gate, party, intent: draft.intent, channel, config, sendsEnabled });
  const plan = playbook ? planActions({ party, intent: draft.intent, confidence: draft.confidence, playbook }) : { auto: [], suggested: [] };
  const sendAt = auto.send
    ? nextSendTime({ now, delayMs: pickDelayMs(config, deps.random || Math.random), quietHours: config.autoSend.quietHours })
    : null;
  return {
    ...base, held: false, draft, gate,
    autoSend: { would: auto.send, reason: auto.reason, sendAt },
    actions: { auto: plan.auto, suggested: plan.suggested },
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
  if (auto) {
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
