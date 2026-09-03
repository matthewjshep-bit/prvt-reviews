// reply-agent.js — a drafted reply to a listing agent, from one inbound text.
//
// GHL's Conversation AI is a generic CRM bot working from a knowledge base: it
// has never seen the offer we sent this agent, at what price, on which house,
// or what happened to it. Every reply to a listing agent is really a reply
// about a specific offer, and the broker is the one thing that knows them all.
// So this reads the thread AND the offer book, and drafts what we would say.
//
// Two things it deliberately does NOT do in this version:
//
//   It never sends. The draft lands in the app (and as a note on the contact)
//   and a person presses Send — after editing it, if they like. The send goes
//   out through the same GHL endpoint an offer text does, from the same
//   number, in the same thread; the agent sees a reply from us.
//
//   It never negotiates. A counter, a "call me", a showing, a request for
//   proof of funds — anything that commits us — is drafted as a holding reply
//   and flagged for a human. See evaluateReplyGates, which is the whole
//   argument for letting this run unattended one day; today every draft
//   waits for a person regardless, and the gate result is shown beside it so
//   the operator can watch how often it would have been right.
//
// Job state is in memory like the underwriter's; the DRAFTS are in the store,
// because a draft that vanishes on a redeploy is a text an agent sent that
// nobody answers. The spend cap reads from the store for the same reason the
// underwriter's does.

import Anthropic from "@anthropic-ai/sdk";
import { buildTranscript } from "./enrich.js";
import { anthropicErrorToHttp } from "./rehab-scan.js";
import { fmtMoney } from "./shared/offer-calc.js";
import { effectiveStatus } from "./shared/offer-status.js";
import {
  getContact, createContactNote, addContactTags, removeContactTags, sendSms, sendEmail,
} from "./ghl.js";
import { listJobs as listUnderwriteJobs } from "./auto-underwrite.js";

/* ---------- the dials ---------- */

export const RA_DEFAULT_DAILY_CAP = 60;   // drafts per location per day
export const RA_MAX_SMS_CHARS = 480;      // three segments; longer than that is an email
export const RA_MAX_CONCURRENT = 2;
export const RA_OFFERS_IN_CONTEXT = 8;    // the agent's most recent offers, newest first

export const RA_TAGS = {
  draft: process.env.REPLY_DRAFT_TAG || "reply-draft",
};

// What the agent is doing, as far as the model can tell. The set is closed so
// the gate below can reason about it — an intent it has never heard of holds.
export const REPLY_INTENTS = [
  "question",        // asks something answerable from the thread or the offer book
  "counter",         // names a different number, or asks if we'd go higher
  "acceptance",      // accepts, or says the seller wants to move forward
  "rejection",       // passes, "seller went another way", "too low"
  "wants_call",      // asks to talk, or for a callback
  "scheduling",      // showing, inspection, walkthrough, a time or a date
  "proof_of_funds",  // asks for POF, a bank letter, or who the buyer is
  "new_property",    // brings up a house we haven't offered on
  "status_check",    // "did you get my email", "any update", "still interested?"
  "small_talk",      // thanks, ok, 👍 — nothing to answer
  "other",
];

// The intents a reply agent may one day answer on its own. Everything else
// commits us to something — a number, a time, a document — and stays a
// person's call. Deliberately a short list that has to EARN additions.
export const AUTO_SENDABLE_INTENTS = new Set(["question", "rejection", "status_check", "small_talk"]);

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

/* ---------- what we know about this agent ---------- */

// The offer book, in the terms the model needs and nothing else. Newest first,
// capped, and every number here is a number the reply is ALLOWED to say — see
// the money guard in evaluateReplyGates.
export function summarizeOffers(offers = [], { now = Date.now() } = {}) {
  const rows = [...offers]
    .filter((o) => o && o.address)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, RA_OFFERS_IN_CONTEXT);
  const lines = [];
  const amounts = new Set();
  for (const o of rows) {
    const status = effectiveStatus(o);
    const amount = Number(o.cashAmount) || 0;
    if (amount) amounts.add(amount);
    const asking = Number(o.inputs?.askingPrice ?? o.calc?.inputs?.askingPrice) || 0;
    if (asking) amounts.add(asking);
    const lastSend = (o.sends || []).filter((s) => s && s.ts).sort((a, b) => String(b.ts).localeCompare(String(a.ts)))[0];
    const daysAgo = (iso) => {
      const t = Date.parse(iso || "");
      return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 86400000)) : null;
    };
    const age = daysAgo(lastSend?.ts || o.createdAt);
    const parts = [
      `${o.address}:`,
      amount ? `our cash offer ${fmtMoney(amount)}` : status === "draft" ? "still being underwritten (no number yet)" : "no amount recorded",
      asking ? `(asking ${fmtMoney(asking)})` : "",
      `— status: ${statusWord(status)}`,
      lastSend ? `sent ${age === 0 ? "today" : `${age} day${age === 1 ? "" : "s"} ago`} by ${(lastSend.channels || []).join("+") || "message"}` : status === "draft" ? "" : "not sent yet",
      o.validLabel ? `valid ${o.validLabel}` : "",
      o.statusNote ? `note: ${String(o.statusNote).slice(0, 120)}` : "",
    ].filter(Boolean);
    lines.push(`- ${parts.join(" ")}`);
  }
  return { text: lines.join("\n"), amounts: [...amounts], count: rows.length };
}

const statusWord = (s) => ({
  draft: "draft (not sent)", new: "not sent yet", sent: "sent, waiting on the agent",
  countered: "agent countered", no_response: "no response", passed: "agent passed", accepted: "accepted",
}[s] || s || "unknown");

/* ---------- the draft ---------- */

const SYSTEM_PROMPT =
  "You write text-message replies on behalf of a real-estate investor (a cash buyer who makes offers on " +
  "listed homes) to the LISTING AGENTS who text them. You are answering as the investor, in the first " +
  "person — the agent is talking to a person, not a bot, and must never be told otherwise. " +
  "Voice: short, plain, warm, professional. One to three sentences. No emojis, no exclamation marks, no " +
  "salesy language, no bullet points. Use the agent's first name once at most. Sound like a busy " +
  "investor who is easy to work with and respects the agent's time. " +
  "FACTS: every number, date, address and term you use must come from the CONTEXT you are given — the " +
  "offer book, the thread, or the operator's standing instructions. Never invent a price, a closing " +
  "timeline, an earnest money amount, a contingency, a proof-of-funds claim, or a company detail. If " +
  "the agent asks something the context does not answer, say you will check and get back to them " +
  "today; do not guess. " +
  "COMMITMENTS: you may NOT accept a counter, raise or lower an offer, propose or confirm a showing " +
  "or inspection time, promise proof of funds, or agree to terms. When the agent asks for any of " +
  "those, write a holding reply that acknowledges it specifically and promises a same-day answer " +
  "(\"Let me run that number by my partner and get back to you this afternoon\"), and set needsHuman " +
  "to true with the reason. A rejection needs no counter-argument: thank them, ask them to keep us in " +
  "mind for the next one, and stop. " +
  "If the newest message needs no reply at all (a thanks, an ok, a thumbs up), set intent to " +
  "small_talk, needsHuman to false, and return an empty reply. " +
  "summary is one line for the operator, in the third person, saying what the agent wants and what " +
  "the draft does about it.";

const REPLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "confidence", "reply", "needsHuman", "humanReason", "summary", "propertyAddress", "counterAmount"],
  properties: {
    intent: { type: "string", enum: REPLY_INTENTS },
    confidence: { type: "string", enum: ["high", "medium", "low"], description: "How sure you are of the intent AND that the reply is right" },
    reply: { type: "string", description: "The reply text, or empty when nothing should be sent" },
    needsHuman: { type: "boolean", description: "True when the message asks for anything that commits the investor" },
    humanReason: { type: "string", description: "Why a person must look, or empty" },
    summary: { type: "string", description: "One line for the operator" },
    propertyAddress: { type: "string", description: "The property this message is about, if one is identifiable; else empty" },
    counterAmount: { type: "integer", description: "A number the agent named, in whole dollars; 0 if none" },
  },
};

/**
 * draftReply({ message, transcript, offers, contact, instructions, signer, aiApiKey })
 *
 * One Claude call. Pure with respect to everything but the model.
 */
export async function draftReply({
  message, transcript = "", offers = { text: "", amounts: [], count: 0 }, contact = {},
  underwriting = [], instructions = "", signer = "", aiApiKey,
}) {
  const client = new Anthropic({ apiKey: aiApiKey, timeout: 120_000 });
  const context = [
    `AGENT: ${contact.name || "unknown name"}${contact.tags?.length ? ` (tags: ${contact.tags.slice(0, 8).join(", ")})` : ""}`,
    signer ? `YOU ARE: ${signer}` : "",
    instructions ? `OPERATOR'S STANDING INSTRUCTIONS (follow these):\n${String(instructions).slice(0, 2000)}` : "",
    offers.count
      ? `OUR OFFERS TO THIS AGENT (newest first — the only numbers you may quote):\n${offers.text}`
      : "OUR OFFERS TO THIS AGENT: none on record.",
    underwriting.length
      ? `IN PROGRESS RIGHT NOW: we are working up numbers on ${underwriting.join("; ")} — you may say an offer is coming shortly, without a number.`
      : "",
    transcript
      ? `THE THREAD SO FAR (US = our team, THEM = the agent):\n${String(transcript).slice(0, 14000)}`
      : "THE THREAD SO FAR: (no earlier messages available)",
    `NEWEST INBOUND MESSAGE FROM THE AGENT (this is what you are replying to):\n"${String(message || "").slice(0, 2000)}"`,
    "Write the reply.",
  ].filter(Boolean).join("\n\n");

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
      system: SYSTEM_PROMPT,
      output_config: { format: { type: "json_schema", schema: REPLY_SCHEMA } },
      messages: [{ role: "user", content: [{ type: "text", text: context }] }],
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
    intent: REPLY_INTENTS.includes(p.intent) ? p.intent : "other",
    confidence: ["high", "medium", "low"].includes(p.confidence) ? p.confidence : "low",
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
 * Returns { ok, flags: [reason] }. In this version NOTHING auto-sends: `ok`
 * is recorded beside the draft and shown to the operator, so the day the
 * question "could this have gone out by itself?" gets asked, the answer is
 * already a count rather than a guess.
 */
export function evaluateReplyGates({ draft, allowedAmounts = [], inboundMessage = "", channel = "sms" }) {
  const flags = [];
  if (!draft) return { ok: false, flags: ["no draft was produced"] };

  if (!AUTO_SENDABLE_INTENTS.has(draft.intent)) {
    flags.push(`a ${draft.intent.replace(/_/g, " ")} is a person's call`);
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
  // The one rule that is not a judgment call. A number in the reply that isn't
  // in the offer book, and wasn't in the agent's own message, was made up —
  // and a made-up number to a listing agent is the worst thing this could do.
  const allowed = new Set([...allowedAmounts, ...moneyIn(inboundMessage)].map((n) => Math.round(n)));
  const invented = moneyIn(draft.reply).filter((n) => !allowed.has(n));
  if (invented.length) {
    flags.push(`the draft names ${invented.map((n) => fmtMoney(n)).join(", ")}, which is not in the offer book`);
  }
  return { ok: flags.length === 0, flags };
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

/* ---------- the pipeline ---------- */

/**
 * startReply(...) — validates, enqueues, returns the job immediately. The
 * webhook route answers GHL right away; the draft is written on the lane.
 */
export async function startReply({ client, locationId, saved, store, contactId, message, channel = "sms", deps = {} }) {
  const aiApiKey = String(saved?.aiApiKey || "").trim();
  if (!aiApiKey) throw Object.assign(new Error("Anthropic API key required (Settings)"), { http: 400 });
  if (!String(message || "").trim()) throw Object.assign(new Error("message required"), { http: 400 });

  const cap = Number(saved?.replyAgentDailyCap) > 0 ? Number(saved.replyAgentDailyCap) : RA_DEFAULT_DAILY_CAP;
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
    draftId: null,
    intent: null,
    summary: "",
    warnings: [],
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(job.id, job);

  runOnLane(locationId, () =>
    runReply(job, { client, locationId, saved, store, aiApiKey, draft: deps.draft || draftReply })
      .catch(async (e) => {
        job.status = "error";
        job.error = String(e?.message || e).slice(0, 300);
        job.finishedAt = new Date().toISOString();
        // The agent's text is sitting unanswered either way; say so where the
        // operator will see it, or it just vanishes.
        await note(client, contactId,
          `AI reply could not be drafted — ${job.error}\n\nThe agent's message is still in the thread above; answer it by hand.`,
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
  // `draft` is draftReply unless a test injects one — the only stage here
  // that costs money, and the only one that can't be exercised offline.
  const { client, locationId, saved, store, aiApiKey, draft: drafter } = ctx;
  const warnings = job.warnings;
  job.status = "running";

  /* --- 1. who and what --- */
  job.phase = "reading";
  let contact = null;
  try {
    contact = await getContact(client, job.contactId);
    job.contactName = contactName(contact);
  } catch { /* the name is decoration; the id is what matters */ }

  let transcript = "";
  try {
    const t = await buildTranscript(client, locationId, job.contactId, {
      maxConversations: 2, maxPagesPerConvo: 1, maxMessages: 60, maxChars: 14000, maxCallTranscripts: 0,
    });
    transcript = t.text || "";
  } catch (e) {
    warnings.push(`thread: ${e.message?.slice(0, 120) || "could not be read"}`);
  }

  const offerRows = await store.listOffers(locationId, { contactId: job.contactId, limit: 25, lean: true }).catch(() => []);
  const offers = summarizeOffers(offerRows);
  const underwriting = listUnderwriteJobs(locationId)
    .filter((j) => j.contactId === job.contactId && (j.status === "running" || j.status === "queued"))
    .map((j) => j.address || "a property")
    .slice(0, 3);

  /* --- 2. the draft --- */
  job.phase = "drafting";
  const draft = await drafter({
    message: job.message,
    transcript,
    offers,
    contact: { name: job.contactName, tags: Array.isArray(contact?.tags) ? contact.tags : [] },
    underwriting,
    instructions: saved?.replyAgentInstructions || "",
    signer: saved?.company?.signer || saved?.company?.name || "",
    aiApiKey,
  });
  job.intent = draft.intent;
  job.summary = draft.summary;

  const gate = evaluateReplyGates({
    draft, allowedAmounts: offers.amounts, inboundMessage: job.message, channel: job.channel,
  });

  /* --- 3. nothing to say --- */
  if (draft.intent === "small_talk" && !draft.reply) {
    job.status = "done";
    job.phase = "";
    job.finishedAt = new Date().toISOString();
    return;
  }

  /* --- 4. save the draft --- */
  job.phase = "saving";
  // One open draft per agent: a second text before the first was answered
  // supersedes it. The reply is to the conversation, not to a message.
  const open = await store.listReplyDrafts(locationId, { contactId: job.contactId, status: "draft", limit: 5 }).catch(() => []);
  for (const old of open) {
    await store.updateReplyDraft(old.id, { ...old, status: "superseded", updatedAt: new Date().toISOString() }).catch(() => {});
  }
  const record = await store.createReplyDraft({
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
    offersInContext: offers.count,
    supersededIds: open.map((o) => o.id),
    warnings: warnings.slice(0, 6),
    updatedAt: new Date().toISOString(),
  });
  job.draftId = record.id;

  /* --- 5. tell GHL --- */
  try { await addContactTags(client, job.contactId, [RA_TAGS.draft]); }
  catch (e) { warnings.push(`tag: ${e.message}`); }
  await note(client, job.contactId, draftNote(record), warnings);

  job.status = "done";
  job.phase = "";
  job.finishedAt = new Date().toISOString();
}

function draftNote(d) {
  return [
    `AI drafted a reply${d.propertyAddress ? ` about ${d.propertyAddress}` : ""} — open the app to send it.`,
    ``,
    `The agent: ${d.summary || d.intent}`,
    d.flags.length ? `Needs you because: ${d.flags.join("; ")}` : `Would have been safe to send on its own.`,
    ``,
    `Draft:`,
    d.reply || "(nothing — the model thought no reply was needed)",
  ].join("\n");
}

/* ---------- acting on a draft ---------- */

/**
 * sendReplyDraft({ client, store, locationId, draftId, text, live })
 *
 * The human's Send. `text` is whatever they left in the box — edited or not —
 * and is what actually goes out; the model's version stays on the record for
 * comparison. `live` false returns a preview and changes nothing, the same
 * double gate every other send in this codebase has.
 */
export async function sendReplyDraft({ client, store, locationId, draftId, text, live, contact = null }) {
  const d = await store.getReplyDraft(draftId);
  if (!d || d.locationId !== locationId) throw Object.assign(new Error("no such draft"), { http: 404 });
  if (d.status !== "draft") throw Object.assign(new Error(`that draft was already ${d.status}`), { http: 409 });
  const body = String(text ?? d.reply ?? "").trim();
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
    ...d, status: "sent", sentAt: ts, sentText: body, edited: body !== String(d.reply || "").trim(),
    ghlMessageId: result?.messageId || result?.id || null, updatedAt: ts,
  };
  await store.updateReplyDraft(d.id, updated);
  await removeContactTags(client, d.contactId, [RA_TAGS.draft]).catch(() => {});
  return { ok: true, dryRun: false, draft: updated };
}

export async function dismissReplyDraft({ client, store, locationId, draftId }) {
  const d = await store.getReplyDraft(draftId);
  if (!d || d.locationId !== locationId) throw Object.assign(new Error("no such draft"), { http: 404 });
  if (d.status !== "draft") return { ok: true, draft: d };
  const updated = { ...d, status: "dismissed", updatedAt: new Date().toISOString() };
  await store.updateReplyDraft(d.id, updated);
  await removeContactTags(client, d.contactId, [RA_TAGS.draft]).catch(() => {});
  return { ok: true, draft: updated };
}

const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
