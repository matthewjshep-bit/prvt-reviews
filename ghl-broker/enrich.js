// enrich.js — AI contact enrichment. Pulls a contact's GHL conversation
// history, has Claude summarize the relationship, and proposes values for a
// purpose-built set of contact custom fields + tags. Two schemas: listing
// agents (acquisitions relationships) and disposition investors (buy box).
// This module only READS GHL and calls Anthropic — the preview/apply routes
// in routes/offers.js own all writes.

import Anthropic from "@anthropic-ai/sdk";
import { searchConversations, listConversationMessages, getMessageTranscription } from "./ghl.js";

export const ENRICH_MODEL = "claude-opus-4-8";

/* ---------- field schemas ---------- */
// { key, name, dataType, values?, hint?, serverSet? } — values = closed vocab
// (enforced in the AI schema and re-validated on apply; stored as TEXT in
// GHL). serverSet fields are computed by the server, never by the AI.

export const SHARED_ENRICH_FIELDS = [
  { key: "last_convo_summary", name: "Last Conversation Summary", dataType: "TEXT",
    hint: "1-2 sentence summary of the most recent exchange" },
  { key: "last_convo_date", name: "Last Conversation Date", dataType: "TEXT", serverSet: true },
  { key: "suggested_next_action", name: "Suggested Next Action", dataType: "TEXT",
    hint: "one concrete next step for us, e.g. 'text a lowball on the Maple St listing Friday'" },
  { key: "enrich_last_run", name: "AI Enrich Last Run", dataType: "TEXT", serverSet: true },
];

export const AGENT_ENRICH_FIELDS = [
  { key: "relationship_stage", name: "Relationship Stage", dataType: "TEXT",
    values: ["new", "contacted", "responsive", "working_deals", "repeat_partner", "gone_cold"],
    hint: "new = no meaningful reply yet; contacted = outreach sent, minimal response; responsive = replies and engages; working_deals = actively discussing or presenting offers together; repeat_partner = has brought or closed multiple deals with us; gone_cold = previously engaged but stopped responding" },
  { key: "agent_temperature", name: "Agent Temperature", dataType: "TEXT",
    values: ["hot", "warm", "cold"],
    hint: "hot = actively engaging or sending deals right now; warm = responsive and open; cold = unresponsive or dismissive" },
  { key: "preferred_channel", name: "Preferred Channel", dataType: "TEXT",
    values: ["sms", "email", "phone"],
    hint: "the channel the agent actually replies on" },
  { key: "responsiveness", name: "Responsiveness", dataType: "TEXT",
    values: ["highly_responsive", "responsive", "slow", "unresponsive"],
    hint: "highly_responsive = same-day replies; responsive = within a couple of days; slow = a week or more; unresponsive = rarely or never replies" },
  { key: "lowball_receptivity", name: "Lowball Receptivity", dataType: "TEXT",
    values: ["receptive", "neutral", "resistant", "hostile"],
    hint: "receptive = has presented or discussed low offers without pushback; neutral = no clear stance; resistant = pushes back but stays engaged; hostile = offended or refuses to present" },
  { key: "pocket_listing_signals", name: "Pocket Listing Signals", dataType: "TEXT",
    values: ["shares_them", "open_to_it", "no_signal"],
    hint: "shares_them = has mentioned off-market or pocket inventory; open_to_it = hinted willingness; no_signal = nothing in the conversation" },
  { key: "agent_market_area", name: "Agent Market Area", dataType: "TEXT",
    hint: "cities, neighborhoods, or zip codes the agent works in, from texts or call transcripts — output a comma-separated list of place names as stated, e.g. 'Kent, Auburn, Federal Way' or zips; empty if none mentioned" },
  { key: "properties_discussed", name: "Properties Discussed", dataType: "TEXT",
    hint: "property addresses discussed, comma-separated" },
];

export const INVESTOR_ENRICH_FIELDS = [
  { key: "buybox_areas", name: "Buy Box: Areas", dataType: "TEXT",
    hint: "areas the investor buys in (cities, neighborhoods, or zips), from texts or call transcripts — output a comma-separated list of place names as stated, e.g. 'Tacoma, Spanaway, 98444'; empty if none mentioned" },
  { key: "buybox_price_min", name: "Buy Box: Price Min", dataType: "NUMERICAL",
    hint: "lowest purchase price mentioned, dollars" },
  { key: "buybox_price_max", name: "Buy Box: Price Max", dataType: "NUMERICAL",
    hint: "highest purchase price mentioned, dollars" },
  { key: "buybox_property_types", name: "Buy Box: Property Types", dataType: "TEXT",
    values: ["sfr", "townhouse", "condo", "multi_family", "land"], multi: true,
    hint: "property types they buy (may be several, comma-joined)" },
  { key: "rehab_appetite", name: "Rehab Appetite", dataType: "TEXT",
    values: ["cosmetic_only", "moderate", "heavy", "full_gut"],
    hint: "how much rehab they'll take on" },
  { key: "investor_strategy", name: "Investor Strategy", dataType: "TEXT",
    values: ["flip", "buy_and_hold", "brrrr", "wholetail", "development"],
    hint: "their stated exit strategy" },
  { key: "decision_speed", name: "Decision Speed", dataType: "TEXT",
    values: ["same_day", "days", "weeks", "slow"],
    hint: "how fast they commit on a deal they like" },
  { key: "proof_of_funds", name: "Proof of Funds", dataType: "TEXT",
    values: ["verified", "mentioned", "not_mentioned"],
    hint: "verified = sent POF/closed with us; mentioned = claims funds; not_mentioned = never came up" },
  { key: "financing_type", name: "Financing Type", dataType: "TEXT",
    values: ["cash", "hard_money", "conventional", "mixed"],
    hint: "how they fund purchases" },
  { key: "investor_activity", name: "Investor Activity", dataType: "TEXT",
    values: ["active", "selective", "paused"],
    hint: "active = wants deal flow now; selective = only specific deals; paused = not buying currently" },
];

// Mutually exclusive tag groups per contact type. The AI may only suggest
// these; adding one implies removing its siblings.
export const ENRICH_TAG_GROUPS = {
  agent: [["agent-hot", "agent-warm", "agent-cold"]],
  investor: [["investor-active", "investor-stale"]],
};

export const enrichFieldDefs = (type) => [
  ...(type === "investor" ? INVESTOR_ENRICH_FIELDS : AGENT_ENRICH_FIELDS),
  ...SHARED_ENRICH_FIELDS,
];
const aiFieldDefs = (type) => enrichFieldDefs(type).filter((f) => !f.serverSet);
export const enrichTagVocab = (type) => (ENRICH_TAG_GROUPS[type] || []).flat();

// "agent" | "investor" | null from the contact's tags. Ambiguous (both kinds
// of tags, or neither) → null and the UI asks.
export function inferContactType(tags) {
  const t = (tags || []).map((x) => String(x).toLowerCase());
  const isInvestor = t.some((x) => x.includes("investor") || x.includes("buyer") || x.includes("dispo"));
  const isAgent = t.some((x) => x.includes("agent"));
  if (isInvestor && !isAgent) return "investor";
  if (isAgent && !isInvestor) return "agent";
  return null;
}

/* ---------- transcript ---------- */

const MAX_CONVERSATIONS = 5;
const MAX_PAGES_PER_CONVO = 3;
const MAX_MESSAGES = 400;
const MAX_AGE_DAYS = 180;
const MAX_CHARS = 60000;
const MAX_BODY_CHARS = 1500;
const MAX_CALL_TRANSCRIPTS = 10; // one extra GHL request per transcribed call
const MAX_CALL_CHARS = 4000;

// Email bodies arrive as HTML; the model doesn't need the markup.
const stripHtml = (s) =>
  String(s).replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/\s+/g, " ").trim();

const channelOf = (m) => {
  const t = String(m.messageType || m.type || "").toUpperCase();
  if (t.includes("CALL")) return "call";
  if (t.includes("SMS")) return "sms";
  if (t.includes("EMAIL")) return "email";
  if (t.includes("VOICEMAIL")) return "voicemail";
  if (t.includes("ACTIVITY") || t.includes("OPPORTUNITY") || t.includes("REVIEW")) return null; // system noise
  return t ? t.toLowerCase().replace(/^type_/, "") : "msg";
};

// Full conversation history for one contact, normalized to a chronological
// text transcript with hard caps (message count, age, characters). Throws GHL
// errors through — callers treat 401/403 as the conversations.readonly scope
// missing. opts override the caps for cheaper scans (e.g. the per-candidate
// snippets in deal investor suggestions: fewer pages, no call transcripts).
export async function buildTranscript(client, locationId, contactId, opts = {}) {
  const maxConversations = opts.maxConversations ?? MAX_CONVERSATIONS;
  const maxPagesPerConvo = opts.maxPagesPerConvo ?? MAX_PAGES_PER_CONVO;
  const maxMessages = opts.maxMessages ?? MAX_MESSAGES;
  const maxChars = opts.maxChars ?? MAX_CHARS;
  const maxCallTranscripts = opts.maxCallTranscripts ?? MAX_CALL_TRANSCRIPTS;

  const { conversations } = await searchConversations(client, locationId, {
    contactId,
    limit: 20,
  });

  const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
  const entries = []; // { ts, line }
  let sawConversations = 0;

  for (const convo of conversations.slice(0, maxConversations)) {
    sawConversations++;
    let lastMessageId;
    for (let page = 0; page < maxPagesPerConvo; page++) {
      const r = await listConversationMessages(client, convo.id, { lastMessageId, limit: 100 });
      for (const m of r.messages) {
        const ts = new Date(m.dateAdded || 0).getTime();
        if (!Number.isFinite(ts) || ts <= 0 || ts < cutoff) continue;
        const channel = channelOf(m);
        if (!channel) continue;
        const dir = String(m.direction || "").toLowerCase() === "inbound" ? "THEM" : "US";
        let body = String(m.body || "").trim();
        if (channel === "email" && body) body = stripHtml(body);
        if (body.length > MAX_BODY_CHARS) body = `${body.slice(0, MAX_BODY_CHARS)}…`;
        const stamp = new Date(ts).toISOString().slice(0, 16).replace("T", " ");
        if (channel === "call" || channel === "voicemail") {
          const callId = m.id || m.messageId || null;
          entries.push({
            ts,
            line: `[${stamp}] ${dir} ${channel}${body ? `: ${body}` : ""}`,
            call: callId ? { id: callId, dir, channel, stamp } : null,
          });
        } else {
          if (!body) continue;
          entries.push({ ts, line: `[${stamp}] ${dir} ${channel}: ${body}` });
        }
      }
      if (!r.nextPage || !r.lastMessageId) break;
      lastMessageId = r.lastMessageId;
    }
  }

  entries.sort((a, b) => a.ts - b.ts);
  let truncated = conversations.length > maxConversations;
  if (entries.length > maxMessages) {
    entries.splice(0, entries.length - maxMessages);
    truncated = true;
  }

  // Pull sentence-level transcriptions for the most recent calls so what was
  // said on the phone (areas worked, buy box, temperature) reaches the model.
  // 404 = no transcription for that call (keep the bare marker); 401/403 = the
  // conversations/message.readonly scope is missing — flag it and stop trying.
  const callEntries = entries.filter((e) => e.call);
  let callsTranscribed = 0;
  let callTranscriptsUnavailable = false;
  for (const e of maxCallTranscripts > 0 ? callEntries.slice(-maxCallTranscripts).reverse() : []) {
    try {
      const sentences = (await getMessageTranscription(client, locationId, e.call.id))
        .slice()
        .sort((a, b) => (a.sentenceIndex || 0) - (b.sentenceIndex || 0));
      const parts = [];
      let curChannel = null;
      for (const s of sentences) {
        const t = String(s.transcript || "").trim();
        if (!t) continue;
        if (s.mediaChannel !== curChannel) {
          curChannel = s.mediaChannel;
          parts.push(`\nSpeaker ${curChannel}: ${t}`);
        } else {
          parts.push(t);
        }
      }
      let text = parts.join(" ").trim();
      if (!text) continue;
      if (text.length > MAX_CALL_CHARS) text = `${text.slice(0, MAX_CALL_CHARS)}…`;
      e.line = `[${e.call.stamp}] ${e.call.dir} ${e.call.channel} TRANSCRIPT:\n${text}`;
      callsTranscribed++;
    } catch (err) {
      if (err?.status === 401 || err?.status === 403) {
        callTranscriptsUnavailable = true;
        break;
      }
      // 404 / transient — this call stays a bare [call] marker.
    }
  }

  // Character budget: drop oldest lines until the transcript fits (call
  // transcripts count toward the budget too).
  let total = entries.reduce((s, e) => s + e.line.length + 1, 0);
  while (entries.length && total > maxChars) {
    total -= entries[0].line.length + 1;
    entries.shift();
    truncated = true;
  }

  return {
    text: entries.map((e) => e.line).join("\n"),
    lastMessageAt: entries.length ? new Date(entries[entries.length - 1].ts).toISOString() : null,
    stats: {
      conversations: sawConversations,
      messages: entries.length,
      calls: callEntries.length,
      callsTranscribed,
      callTranscriptsUnavailable,
      firstAt: entries.length ? new Date(entries[0].ts).toISOString() : null,
      lastAt: entries.length ? new Date(entries[entries.length - 1].ts).toISOString() : null,
      truncated,
    },
  };
}

/* ---------- structured-output schema ---------- */

function buildEnrichSchema(type) {
  const entry = (def) => ({
    type: "object",
    additionalProperties: false,
    required: ["value", "reason"],
    properties: {
      value:
        def.dataType === "NUMERICAL"
          ? { anyOf: [{ type: "integer" }, { type: "null" }] }
          : def.values && !def.multi
          ? { type: "string", enum: [...def.values, "unknown"] }
          : { type: "string" }, // free text ("" = unknown); multi-enums comma-join
      reason: { type: "string" },
    },
  });
  const defs = aiFieldDefs(type);
  const vocab = enrichTagVocab(type);
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "confidence", "fields", "tags"],
    properties: {
      summary: { type: "string", description: "3-5 sentence summary of the relationship and where it stands" },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      fields: {
        type: "object",
        additionalProperties: false,
        required: defs.map((f) => f.key),
        properties: Object.fromEntries(defs.map((f) => [f.key, entry(f)])),
      },
      tags: {
        type: "object",
        additionalProperties: false,
        required: ["add", "remove"],
        properties: {
          add: { type: "array", items: { type: "string", enum: vocab } },
          remove: { type: "array", items: { type: "string", enum: vocab } },
        },
      },
    },
  };
}

/* ---------- the AI call ---------- */

const TYPE_LABEL = { agent: "listing agent (acquisitions side)", investor: "disposition investor (cash buyer)" };

function systemPrompt(type, extraInstructions) {
  const vocabLines = aiFieldDefs(type)
    .map((f) => `- ${f.key}${f.values ? ` (${f.values.join(" / ")})` : ""}: ${f.hint || f.name}`)
    .join("\n");
  return (
    "You are a CRM analyst for a real-estate wholesaling operation running 'The Agent Method': high-volume " +
    "lowball offers on listed distressed homes made through listing agents (about 10 offers a day, new agents " +
    "contacted daily, follow-ups on a 12-touch cadence). Roughly 10% of agents become repeat relationships — " +
    "the compounding asset of the business. Accepted contracts are assigned to cash-buyer investors " +
    "(dispositions) for a fee.\n\n" +
    `You are analyzing the conversation history with one ${TYPE_LABEL[type]}. Field vocabulary:\n${vocabLines}\n\n` +
    "Rules: Only propose values supported by explicit evidence in the conversation. Use 'unknown' (or an empty " +
    "string / null for free-text and numeric fields) when the conversation does not establish a value — never " +
    "guess. Every reason must point at the specific message or behavior that supports the value (quote or " +
    "paraphrase it). Response patterns (speed, channel, who initiates) are evidence too, not just message " +
    "content. Call transcripts carry the same evidentiary weight as messages; their speaker labels " +
    "(Speaker 1/2) are positional, not identified — attribute statements by content, not label. " +
    "If the transcript is marked truncated, treat older behavior as possibly stale. Tags: only " +
    "suggest adding a tag when the evidence is clear; suggest removing a tag only when it contradicts the " +
    "current evidence." +
    (extraInstructions ? `\n\nAdditional instructions from the team:\n${extraInstructions}` : "")
  );
}

// settings must carry aiApiKey. Returns the parsed structured output:
// { summary, confidence, fields: {key: {value, reason}}, tags: {add, remove} }.
export async function runEnrichment({ contact, currentFields, currentTags, transcript, type, extraInstructions, aiApiKey }) {
  const anthropic = new Anthropic({ apiKey: aiApiKey, timeout: 120_000 });

  const profile = [
    `Name: ${[contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.contactName || "(unknown)"}`,
    contact.phone ? `Phone: ${contact.phone}` : null,
    contact.email ? `Email: ${contact.email}` : null,
    currentTags?.length ? `Current tags: ${currentTags.join(", ")}` : "Current tags: (none)",
  ].filter(Boolean).join("\n");

  const currentValues = Object.entries(currentFields || {})
    .filter(([, v]) => String(v ?? "").trim())
    .map(([k, v]) => `- ${k}: ${String(v).slice(0, 300)}`)
    .join("\n") || "(none set)";

  const s = transcript.stats;
  const statsLine =
    `${s.conversations} conversation(s), ${s.messages} message(s), ` +
    (s.calls ? `${s.callsTranscribed}/${s.calls} call(s) transcribed, ` : "") +
    `${s.firstAt ? s.firstAt.slice(0, 10) : "?"} → ${s.lastAt ? s.lastAt.slice(0, 10) : "?"}` +
    (s.truncated ? " (TRUNCATED — older history omitted)" : "");

  const response = await anthropic.messages.create({
    model: ENRICH_MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: systemPrompt(type, extraInstructions),
    output_config: { format: { type: "json_schema", schema: buildEnrichSchema(type) } },
    messages: [{
      role: "user",
      content:
        `CONTACT PROFILE\n${profile}\n\n` +
        `CURRENT CUSTOM FIELD VALUES\n${currentValues}\n\n` +
        `CONVERSATION TRANSCRIPT (${statsLine})\n` +
        `US = our team, THEM = the contact.\n\n${transcript.text}\n\n` +
        `Propose updated field values and tag changes for this ${TYPE_LABEL[type]}.`,
    }],
  });

  if (response.stop_reason === "max_tokens") {
    throw Object.assign(new Error("AI enrichment output truncated — try again"), { http: 502 });
  }
  if (response.stop_reason === "refusal") {
    throw Object.assign(new Error("AI enrichment was declined"), { http: 502 });
  }
  const text = response.content.find((b) => b.type === "text")?.text || "{}";
  return JSON.parse(text);
}

/* ---------- deal investor suggestions ---------- */

// Same vocabulary as the deal endpoints (routes/offers.js) and DealsView.
const DEAL_INVESTOR_STATUSES = ["sent", "evaluating", "passed", "committed"];

// Given one deal and a set of investor candidates with recent-conversation
// snippets, ask Claude which of them show evidence of interest in / active
// work on THIS property. Returns { suggestions: [{contactId, include,
// status, reason}] } (contactIds restricted to the candidates via schema).
export async function suggestDealInvestors({ deal, candidates, aiApiKey, extraInstructions }) {
  const anthropic = new Anthropic({ apiKey: aiApiKey, timeout: 120_000 });
  const ids = candidates.map((c) => c.contactId);

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["suggestions"],
    properties: {
      suggestions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["contactId", "include", "status", "reason"],
          properties: {
            contactId: { type: "string", enum: ids },
            include: { type: "boolean" },
            status: { type: "string", enum: DEAL_INVESTOR_STATUSES },
            reason: { type: "string" },
          },
        },
      },
    },
  };

  const dealDesc = [
    `Property: ${deal.address || "(address unknown)"}`,
    deal.contractPrice ? `Contract price: $${Number(deal.contractPrice).toLocaleString()}` : null,
    deal.assignmentFee ? `Assignment fee: $${Number(deal.assignmentFee).toLocaleString()}` : null,
    deal.closingDate ? `Closing date: ${deal.closingDate}` : null,
    `Stage: ${deal.stage}`,
  ].filter(Boolean).join("\n");

  const body = candidates
    .map((c) => `### ${c.name} (id: ${c.contactId})\n${c.snippet || "(no recent messages)"}`)
    .join("\n\n");

  const system =
    "You are a dispositions analyst for a real-estate wholesaling operation ('The Agent Method'): properties " +
    "under contract get assigned to cash-buyer investors for a fee. You are deciding which investor contacts " +
    "show evidence of interest in, or active engagement with, ONE specific property deal, based on recent " +
    "conversation snippets.\n\n" +
    "Rules: include=true ONLY when the conversation shows the investor engaging with this specific property — " +
    "the address (or an unmistakable reference to it), its numbers, photos, a walkthrough, or an explicit ask " +
    "for exactly this kind of deal in this area. General chattiness or unrelated deals do not count. When in " +
    "doubt, include=false.\n" +
    "Status meanings: sent = we sent them this deal but no meaningful reply yet; evaluating = actively " +
    "reviewing or asking questions about it; passed = looked and declined; committed = agreed to take it. " +
    "Every reason must cite the message that supports it." +
    (extraInstructions ? `\n\nAdditional instructions from the team:\n${extraInstructions}` : "");

  const response = await anthropic.messages.create({
    model: ENRICH_MODEL,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    system,
    output_config: { format: { type: "json_schema", schema } },
    messages: [{
      role: "user",
      content:
        `THE DEAL\n${dealDesc}\n\n` +
        `INVESTOR CANDIDATES (recent conversation snippets; US = our team, THEM = the investor)\n\n${body}\n\n` +
        `Which of these investors are interested in or actively working this deal?`,
    }],
  });

  if (response.stop_reason === "max_tokens") {
    throw Object.assign(new Error("AI suggestion output truncated — try again"), { http: 502 });
  }
  if (response.stop_reason === "refusal") {
    throw Object.assign(new Error("AI suggestion was declined"), { http: 502 });
  }
  const text = response.content.find((b) => b.type === "text")?.text || "{}";
  return JSON.parse(text);
}
