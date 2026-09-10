// post-mortem.js — gather everything a dead deal left behind, have the
// model read it, and write the result on the deal.
//
// The pure half (shared/post-mortem.js) does the arithmetic and the shaping.
// This half does the reading: the buyer-feedback package (every investor
// thread, via the offers router's own builder so the two pages never
// disagree), the LISTING AGENT's thread — which the feedback package
// deliberately never reads, because that page is for the agent — the
// offer's contact events, and the location's settings. Then one structured
// call to Claude to say, in words with quotes, why it died.
//
// Same shape as feedback-scan.js: an in-memory job registry, a synchronous
// start, a phase the console can poll, and a result that lands on
// `deal.postMortem` plus a contact_events row saying it was written.

import Anthropic from "@anthropic-ai/sdk";
import { buildTranscript } from "./enrich.js";
import { recordEvent } from "./contact-record.js";
import { anthropicErrorToHttp } from "./rehab-scan.js";
import { buildPostMortem, dealScorecard, FELL_THROUGH_CODES, normalizeAnalysis } from "./shared/post-mortem.js";
import { PASS_REASONS, PASS_REASON_GLOSS } from "./shared/conversation-ai.js";
import { effectiveSettings } from "./shared/offer-calc.js";

const POST_MORTEM_MODEL = "claude-sonnet-5";
const AGENT_THREAD_CHARS = 30000;
const jobs = new Map();               // offerId -> job

export const getPostMortemJob = (offerId) => jobs.get(offerId) || null;
export function publicPostMortemJob(job) { if (!job) return null; const { cancelRequested, ...rest } = job; return rest; }
export function _resetPostMortemJobs() { jobs.clear(); }

/* ---------- gathering ---------- */

/**
 * gatherPostMortem({ client, locationId, store, offer, deps, refresh })
 *   → { feedback, agentThread, agentStats, events, settings, warnings }
 *
 * `deps.feedbackFor` is the offers router's cached package builder;
 * `deps.readThread` defaults to enrich.js's buildTranscript. Both are
 * injectable so the route test runs without GHL.
 */
export async function gatherPostMortem({ client, locationId, store, offer, deps = {}, refresh = false, onPhase = () => {} }) {
  const warnings = [];
  const settings = effectiveSettings((await store.getOfferSettings(locationId)) || {});
  onPhase("feedback");
  let feedback = null;
  if (deps.feedbackFor) {
    try { feedback = await deps.feedbackFor({ locationId, client, offer, refresh }); }
    catch (e) { warnings.push(`buyer feedback: ${String(e?.message || e).slice(0, 160)}`); }
  } else if (offer.deal?.feedbackPackage) {
    feedback = offer.deal.feedbackPackage;
  }
  onPhase("agent_thread");
  let agentThread = ""; let agentStats = null;
  if (offer.contactId) {
    const read = deps.readThread || ((cid) => buildTranscript(client, locationId, cid, { maxCallTranscripts: 8 }));
    try { const t = await read(offer.contactId); agentThread = t?.text || ""; agentStats = t?.stats || null; }
    catch (e) { warnings.push(`agent thread: ${String(e?.message || e).slice(0, 160)}`); }
  }
  let events = [];
  try { events = await store.listContactEventsByOffer(locationId, offer.id, { limit: 5000 }); } catch { events = []; }
  return { feedback, agentThread, agentStats, events, settings, warnings };
}

/* ---------- the AI's reading ---------- */

const ANALYSIS_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["rootCauses", "agentSide", "buyerSide", "whatWouldHaveSold", "lessons", "offerProcessChanges"],
  properties: {
    rootCauses: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["code", "weight", "summary", "evidence"],
        properties: {
          code: { type: "string", enum: [...FELL_THROUGH_CODES, ...PASS_REASONS] },
          weight: { type: "number" },
          summary: { type: "string" },
          evidence: {
            type: "array",
            items: { type: "object", additionalProperties: false, required: ["who", "quote", "at"], properties: { who: { type: "string", enum: ["agent", "buyer", "us"] }, quote: { type: "string" }, at: { type: "string" } } },
          },
        },
      },
    },
    agentSide: {
      type: "object", additionalProperties: false, required: ["narrative", "concessions", "backOutResponse"],
      properties: {
        narrative: { type: "string" },
        concessions: { type: "array", items: { type: "object", additionalProperties: false, required: ["at", "from", "to", "why"], properties: { at: { type: "string" }, from: { type: "number" }, to: { type: "number" }, why: { type: "string" } } } },
        backOutResponse: { type: "string" },
      },
    },
    buyerSide: { type: "object", additionalProperties: false, required: ["narrative", "whatTheyNeeded"], properties: { narrative: { type: "string" }, whatTheyNeeded: { type: "string" } } },
    whatWouldHaveSold: { type: "object", additionalProperties: false, required: ["price", "basis"], properties: { price: { type: "number" }, basis: { type: "string" } } },
    lessons: { type: "array", items: { type: "string" } },
    offerProcessChanges: { type: "array", items: { type: "string" } },
  },
};

function systemPrompt(extraInstructions) {
  const gloss = PASS_REASONS.map((c) => `- ${c}: ${PASS_REASON_GLOSS[c]}`).join("\n");
  return (
    "You are the post-mortem analyst for a real-estate wholesaling operation ('The Agent Method'): lowball offers " +
    "on listed distressed homes through listing agents; a signed contract is assigned to a cash-buyer investor for " +
    "a fee. This deal was under contract and we had to back out. You are reading everything it left behind — our " +
    "underwriting numbers, the price we contracted at, what the listing agent said while we negotiated, and what " +
    "every buyer said when they were pitched — to say why it died and what to do differently.\n\n" +
    "Root-cause codes (deal level): buyers_passed_price, buyers_passed_rehab, buyers_passed_area, no_buyer_response, " +
    "inspection, seller_backed_out, title_or_financing, other. Buyer-level pass codes, when one buyer's reason is " +
    `the finding:\n${gloss}\n\n` +
    "Rules: every root cause carries evidence — verbatim quotes with who said them (agent / buyer / us) and when. " +
    "Weights sum to about 1. The SCORECARD is arithmetic and is authoritative for the numbers; your job is the " +
    "story the numbers don't tell: where the contract price came from (did the seller or agent name it? did we " +
    "climb toward it?), what we conceded and why, how the agent took the back-out, what buyers actually needed to " +
    "say yes, and the price that would have sold — with its basis (a buyer's own number, the 70% rule, the " +
    "closest comparable deal that did sell). Lessons are short imperative sentences a person can act on at the " +
    "negotiating table; offerProcessChanges are changes to how offers are produced (inputs, checks, sequencing), " +
    "not to any specific dollar setting. Never invent a quote. Speaker labels in call transcripts are positional; " +
    "attribute by content." +
    (extraInstructions ? `\n\nAdditional instructions from the team:\n${extraInstructions}` : "")
  );
}

/**
 * analyzePostMortem({ offer, scorecard, feedback, agentThread, aiApiKey, extraInstructions })
 *   → normalized analysis | null when there is no key
 */
export async function analyzePostMortem({ offer, scorecard, feedback, agentThread = "", aiApiKey, extraInstructions = "" }) {
  if (!aiApiKey) return null;
  const anthropic = new Anthropic({ apiKey: aiApiKey, timeout: 180_000 });
  const deal = offer.deal || {};
  const money = (n) => `$${Math.round(Number(n) || 0).toLocaleString("en-US")}`;

  const buyersBlock = (feedback?.buyers || []).filter((b) => b.replied || b.passed).slice(0, 40).map((b) => {
    const lines = [`### ${b.name} — ${b.status}${b.reason?.code ? ` (${b.reason.code}: ${b.reason.note || ""})` : ""}`];
    for (const q of (b.quotes || []).filter((q) => q.aboutDeal).slice(0, 6)) lines.push(`[${String(q.at).slice(0, 16)}] THEM: ${q.text}`);
    for (const c of (b.calls || []).slice(0, 2)) for (const l of c.lines.slice(0, 6)) lines.push(`[${String(c.at).slice(0, 16)}] call Speaker ${l.speaker}: ${l.text}`);
    return lines.join("\n");
  }).join("\n\n") || "(no buyer threads read — the record's statuses are in the scorecard)";
  const askedFor = (feedback?.askedFor || []).map((a) => `${a.name || a.shortName}: ${money(a.amount)}`).join(", ");

  const thread = String(agentThread || "");
  const agentBlock = thread.length > AGENT_THREAD_CHARS ? `(older history omitted)\n…${thread.slice(-AGENT_THREAD_CHARS)}` : thread || "(no agent thread)";

  const response = await anthropic.messages.create({
    model: POST_MORTEM_MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: systemPrompt(extraInstructions),
    output_config: { format: { type: "json_schema", schema: ANALYSIS_SCHEMA } },
    messages: [{
      role: "user",
      content:
        `THE DEAL\n${offer.address}\nListing agent: ${offer.contactName || "(unknown)"}\n` +
        `Under contract ${String(deal.createdAt || "").slice(0, 10)} → fell through ${String(scorecard.days?.underContract ?? "?")} days later. ` +
        `Operator's reason: "${deal.fellThroughReason || ""}"\n\n` +
        `SCORECARD (authoritative arithmetic)\n${JSON.stringify(scorecard, null, 1)}\n\n` +
        (askedFor ? `NUMBERS BUYERS SAID THEY WOULD DO: ${askedFor}\n\n` : "") +
        `WHAT THE BUYERS SAID (US = our team, THEM = the buyer)\n${buyersBlock}\n\n` +
        `THE LISTING AGENT'S THREAD (US = our team, THEM = the agent; the negotiation and the back-out are in here)\n${agentBlock}\n\n` +
        `Why did this deal die, and what do we do differently?`,
    }],
  }).catch((e) => { throw anthropicErrorToHttp(e); });

  if (response.stop_reason === "max_tokens") throw Object.assign(new Error("post-mortem output truncated — try again"), { http: 502 });
  if (response.stop_reason === "refusal") throw Object.assign(new Error("post-mortem was declined"), { http: 502 });
  const text = response.content.find((b) => b.type === "text")?.text || "{}";
  const parsed = JSON.parse(text);
  return normalizeAnalysis({ ...parsed, by: "ai" });
}

/* ---------- the job ---------- */

/**
 * startPostMortem({ client, locationId, store, offer, deps, refresh, analysis }) → job
 *
 * `analysis` given → no model call; the supplied reading is stored (a person's
 * or a session's). Otherwise the location's AI key decides: with one, the
 * model reads; without, the deterministic half is written with a warning.
 */
export function startPostMortem({ client, locationId, store, offer, deps = {}, refresh = false, analysis = undefined, now = Date.now() }) {
  const existing = jobs.get(offer.id);
  if (existing?.status === "running") throw Object.assign(new Error("a post-mortem is already being written for this deal"), { http: 409 });
  const job = { id: `pm-${Date.now().toString(36)}`, offerId: offer.id, locationId, status: "running", phase: "starting",
    startedAt: new Date(now).toISOString(), finishedAt: null, warnings: [], error: null, cancelRequested: false, analyzed: false };
  jobs.set(offer.id, job);
  runPostMortem(job, { client, locationId, store, offer, deps, refresh, analysis, now }).catch((e) => {
    job.status = "error"; job.error = String(e?.message || e).slice(0, 300); job.finishedAt = new Date().toISOString(); job.phase = "";
  });
  return job;
}

async function runPostMortem(job, { client, locationId, store, offer, deps, refresh, analysis, now }) {
  const g = await gatherPostMortem({ client, locationId, store, offer, deps, refresh, onPhase: (p) => { job.phase = p; } });
  job.warnings.push(...g.warnings);
  let reading = analysis === undefined ? null : normalizeAnalysis(analysis);
  if (analysis === undefined) {
    job.phase = "analysis";
    const scorecard = dealScorecard({ offer, settings: g.settings, feedback: g.feedback, events: g.events, now });
    if (g.settings.aiApiKey) {
      try {
        reading = await analyzePostMortem({ offer, scorecard, feedback: g.feedback, agentThread: g.agentThread, aiApiKey: g.settings.aiApiKey, extraInstructions: g.settings.replyAgentInstructions || "" });
        job.analyzed = Boolean(reading);
      } catch (e) { job.warnings.push(`analysis: ${String(e?.message || e).slice(0, 200)}`); }
    } else {
      job.warnings.push("no AI key in Settings — the numbers and the quotes are here, the reading is not");
    }
  }
  job.phase = "saving";
  const pm = buildPostMortem({ offer, settings: g.settings, feedback: g.feedback, agentThread: g.agentThread, events: g.events, analysis: reading, now: Date.now() });
  pm.agentThreadStats = g.agentStats;
  pm.warnings = job.warnings.slice();
  const full = await store.getOffer(offer.id);
  if (full?.deal) {
    full.deal.postMortem = pm;
    await store.updateOffer(full.id, full);
  }
  try {
    await recordEvent({ store, locationId, contactId: offer.contactId, party: "agent", type: "post_mortem_built", at: pm.generatedAt,
      address: String(offer.address || "").split(",")[0], offerId: offer.id, dealId: offer.id, source: reading?.by === "ai" || !reading ? "deal" : "operator",
      ref: `post-mortem:${offer.id}`, dedupeKey: `post-mortem:${offer.id}:${pm.generatedAt.slice(0, 13)}`,
      data: { code: pm.scorecard.fellThroughCode, gap: pm.scorecard.gap, buyerPctOfArv: pm.scorecard.buyerPctOfArv, by: reading?.by || "numbers" } });
  } catch { /* the record is best-effort; the post-mortem is on the deal */ }
  job.status = "done";
  job.phase = "";
  job.finishedAt = new Date().toISOString();
  job.result = { generatedAt: pm.generatedAt, code: pm.scorecard.fellThroughCode, gap: pm.scorecard.gap, analyzed: Boolean(reading) };
}
