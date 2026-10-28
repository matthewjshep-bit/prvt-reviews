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
import { leaveOutreachWorkflows } from "./outreach-followup.js";
import { learnFacts, recordEvent, recordEvents } from "./contact-record.js";
import { saveTextedEmail, setDealsBy } from "./contact-email.js";
import { wantsDealsByEmail } from "./shared/contact-email.js";
import { recordError } from "./app-errors.js";
import { BOOKING_INTENTS, looksLikeScheduling, pickSlots, evaluateBookingGuard, bookingContextText } from "./shared/booking.js";
import { paperWent, paperWorthy, floatSentAt, isRoughNumber } from "./shared/paper-follows.js";
import { RSVP_SIGNALS } from "./shared/showing.js";
import { getFreeSlots, searchConversations, listConversationMessages } from "./ghl.js";
import { GUARD_FOR_INTENT, AGENT_PAPER_RULE, AGENT_GOAL_RULE, AGENT_HONESTY_RULE, CLARIFY_RULE, PROMISE_RULE, handsWriteUpBack, clearsWriteUp, DEAL_SIGNALS, DEAL_SIGNAL_LABEL, dealSignalFromText, asksWriteUpTerms, defersWriteUpTerms, claimsAllCash, houseWordsIn, asksUsToComeUp, asksForTheirNumber, asksOurNumber, soundsLikeSecondThoughts, soundsCrossedUp, doesntKnowUs } from "./shared/conversation-ai.js";
import { eventFromLedgerLine, normalizePropertyDetails, propertyDossier } from "./shared/contact-record.js";
import { stepLabel, normalizeSteps, MACHINE_STARTED_KINDS, blockingDraft, blockingReason, answersInbound, supersededBy } from "./shared/follow-up.js";
import { normalizeAgentPulse, listingAlreadyRaised, LISTING_REASONS } from "./shared/agent-pulse.js";
import { secondLookNumber, SECOND_LOOK_MAX_CHARS, SECOND_LOOK_SENT, SECOND_LOOK_STATUSES } from "./shared/second-look.js";
import { passNoteStale } from "./shared/pass-note.js";
import { cadenceRequest, cadenceDueAt, refusesAddress, notAHouse, isAutoReply, autoReplyNumber } from "./shared/brush-offs.js";
import { normalizeOpener, openerVoice, countyName, homeFor, withHomeBlank, stripSignOff, houseDetails, overusedPhrases, openerVariant, OPENER_MAX_CHARS } from "./shared/outreach-opener.js";
import { standardText } from "./shared/standard-texts.js";
import { OFF_MARKET_ASK_RX, offMarketCue, onMarketCue } from "./shared/off-market.js";
import { PASS_RE, inferReason } from "./shared/deal-feedback.js";
import { agentFocusRule } from "./shared/asset-type.js";
import { draftWaitingOnYou } from "./outbox-guard.js";
import { holdFor } from "./bot-hold.js";
import { machineMayStart, liveHouse, LIVE_THREAD_KINDS, PASS_SHAPED_KINDS, IRRITATED_RX } from "./shared/thread-health.js";
import { closeCounter } from "./shared/counter-hold.js";
import { agentTurnReason } from "./agent-focus.js";
import { streetOf } from "./shared/agent-focus.js";
import { holdLine } from "./shared/bot-hold.js";
import { evaluateCounterBand, evaluateAcceptance, evaluateInvestorBand, autoAcceptCeiling, COUNTER_MARGIN, acceptanceAtOurNumber } from "./shared/auto-accept.js";
import { houseGone, saysTurnkey, reopensOnTheirNumbers } from "./shared/held-underwrites.js";
import { passedOnHouse, isTierOneAction, isLowerTierAction, isTierOneCardAction, TIER_ONE_OUT_EVENTS } from "./shared/tier-one.js";
import { normalizeGhlStages, validAddress, sameRaisedHouse } from "./shared/ghl-stages.js";
import { qualifyStep, broughtStep, isPastWork, QUALIFY_ASK_RX, ourReplyPasses, pointsToThePhotos, photosPassReply, withCallAsk, withFixersAsk, CALL_ASK_RX, FIXERS_ASK_RX, asksTheirRehab } from "./shared/flip-read.js";
import { housesInText, normalizeMentionedHouses, addressAsk, asksForAddress, addressHint, HOUSE_LEAD_INTENTS, callWords, saidIn, referralMention, referralKey, hasHouseNumber } from "./shared/mentioned-houses.js";
import { currentOffers, currentOfferFor, walkedAwayFrom, paperCheck, ourComeDown, ourMoveUp, machineRaise, machineCut, shorthandPrices, pricesWeName, valuesWeName, lastQuoteOnHouse, holdNumber, floatRange, rangeWords, rangeLows, liveRange, namedInRange } from "./shared/current-offer.js";
import { offerMath, compactMath, mathAllowedAmounts, mathFigures } from "./shared/offer-breakdown.js";
import { usageOf } from "./shared/ai-cost.js";
import { batcherFor } from "./draft-batch.js";
// Aliased: this module already has its own OPEN_STATUSES for DRAFT rows.
import { OPEN_STATUSES as OPEN_OFFER_STATUSES, effectiveStatus as offerStatus, dealIsOver, dealOutreachStopped, dealOutreachPaused, fellThroughOn, underContractOn, isNegotiable, pushesToPaper, asksForWriteUp, numberApproved, saysYes, saidYes, YES_WINDOW_DAYS, aiHoldReasons, DRAFT_ONLY_RX } from "./shared/offer-status.js";
import { signedContractIn, themLines, paperworkSignal } from "./shared/contract-signed.js";
import { sameStreet, sameHouse } from "./shared/us-address.js";
import { releasableHeld } from "./shared/conversation-audit.js";
import { addressKey as propertyKey } from "./shared/us-address.js";
import { findOrCreateCustomFieldByKey, updateContact } from "./ghl.js";
import { matchTagPatterns } from "./conversation-party.js";
import { GATEKEEPER_TAG_PATTERNS } from "./shared/gatekeeper.js";
import { GATEKEEPER_OUT_KINDS } from "./shared/gatekeeper-sequence.js";
import { anthropicErrorToHttp } from "./rehab-scan.js";
import { expandListingLinks } from "./listing-links.js";
import { inboundPhotoUrls, readPhotoAddresses, expandPhotoAddresses, bodyImageUrls } from "./photo-addresses.js";
import { fmtMoney, underwriteMode } from "./shared/offer-calc.js";
import { parseUsAddress, addressKey, lastMention, offerForms, normalizeUsAddress } from "./shared/us-address.js";
import {
  normalizeConversationAi, shadowModelFor, INTENTS, NEVER_AUTO, GUARDED_AUTO, autoEligible, PARTY_LABEL, CONFIDENCES,
  SILENT_INTENTS, OUTBOUND_INTENTS, detectOptOut, optOutInTranscript, optOutActions, normalizePassReason, normalizeDraftFeedback,
  setupQuestionFor, EYES_QUESTION, SELLER_NUMBER_QUESTION,
} from "./shared/conversation-ai.js";
import { numberStance, listedFit, noFitLine } from "./shared/number-stance.js";
import {
  getContact, createContactNote, addContactTags, removeContactTags, sendSms, sendEmail, smsUnsubscribed, emailUnsubscribed, DND_TAG,
} from "./ghl.js";
import { listJobs as listUnderwriteJobs } from "./auto-underwrite.js";
import { endsWithQuestionToThem } from "./shared/promise-resolver.js";
import { keepsOurWord } from "./shared/promise-owed.js";
import { detectPromise, isConditionalPromise, PROMISE_DUE_HOURS, checkInRequested, offersToSendDeals, addressPending, takingItToSeller, unansweredCheckIn, detectLeadTiming, leadIsTheNet } from "./shared/follow-up.js";
import { resolveParty } from "./conversation-party.js";
import {
  loadContactContext, loadAgentContext, loadInvestorContext, summarizeOffers, RA_OFFERS_IN_CONTEXT, liveDealHold, lessonsContextText, roughAmounts,
  investorFacingPrice, INVESTOR_DEAL_STAGES } from "./conversation-context.js";
import {
  buildSystemPrompt, buildUserContext, schemaFor, CLASSIFY_SYSTEM, CLASSIFY_SCHEMA, buildClassifyContext, CARRIER_CHECKED_KINDS,
  openerPlan,
} from "./conversation-prompt.js";
import { carrierFlags } from "./shared/carrier-words.js";
import { planActions, runActions } from "./conversation-actions.js";
import { pickDelayMs, nextSendTime, spreadAcrossDay, isWeekend, machineHours } from "./conversation-scheduler.js";
import { refreshBlastText, refreshBundleText, defaultDataroomBaseUrl } from "./blast-refresh.js";
import { buyerTouchLimit, slotWord } from "./buyer-touch.js";
import { normalizeTouchBudget } from "./shared/buyer-touch.js";
import { gmailBeforeDraft, contactEmails } from "./gmail-sync.js";
import { meterAi } from "./ai-spend.js";
import { investorMindedCue } from "./shared/lead-source.js";
import { partnerTerms, partnerTermsLine, PARTNER_TERMS_LABEL } from "./shared/partner-terms.js";
import { agentRuledOut } from "./shared/held-underwrites.js";
import { followWithCard, defaultCardBaseUrl, mintCardToken } from "./contact-card.js";

// What the machine STARTS is spread across the day and skips weekends
// (unless the page says otherwise); what it ANSWERS goes in human minutes.
const STARTED_KINDS = new Set(["offer_nudge", "passed_checkin", "blast_nudge", "dataroom_nudge", "deal_followup", "outreach_nudge", "outreach_open", "buyer_pulse", "agent_pulse"]);
export function scheduleFor({ config, now, kind = null, intent = "", replyLength = 0, random = Math.random }) {
  const a = config.autoSend || {};
  // What the machine starts keeps its own, shorter hours (machineUntil, 5pm).
  const hours = kind && MACHINE_STARTED_KINDS.has(kind) ? machineHours(a) : a.quietHours;
  if (kind && STARTED_KINDS.has(kind)) {
    return spreadAcrossDay({ now, quietHours: hours, hours: a.nudgeSpreadHours ?? 8, random, weekends: a.weekends || "all" });
  }
  const at = nextSendTime({ now, delayMs: pickDelayMs(config, random, { intent, replyLength }), quietHours: hours });
  // A reply on a weekend goes unless the page says nothing does.
  if (a.weekends === "none" && isWeekend(Date.parse(at), a.quietHours?.timeZone || "UTC")) {
    return spreadAcrossDay({ now: Date.parse(at), quietHours: hours, hours: 0, random, weekends: "none" });
  }
  return at;
}

export { summarizeOffers, RA_OFFERS_IN_CONTEXT };

/* ---------- the dials ---------- */

export const RA_DEFAULT_DAILY_CAP = 60;   // drafts per location per day (the page can change it)
export const RA_MAX_SMS_CHARS = 480;      // three segments; longer than that is an email
export const RA_MAX_CONCURRENT = 2;
// Sweep-started texts that may wait on a batch (BATCHABLE_KINDS) run on their
// own lane this wide: enough for a sweep to fill one batch, few enough that
// the GHL reads around each draft stay under its rate limit. 8 until
// 2026-10-16: with the outreach cap gone a day held ~530 machine drafts, each
// two or three batch round trips (draft, then the carrier/length rewrites),
// and 8 at a time wrote ~0.6 a minute — most of the day's first texts would
// have waited for Monday. 24 is three times that and ~70 GHL reads in a burst,
// still under GHL's 100 per 10 seconds.
export const RA_MACHINE_CONCURRENT = 24;

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

// The one way the Conversation AI blob is saved: read the settings fresh (the
// rest of that row belongs to other pages), normalise, write. The config page
// and the coach's Apply both come through here.
export async function saveConversationConfig(store, locationId, config) {
  const saved = (await store.getOfferSettings(locationId)) || {};
  // A page from before the contact card existed sends no contactCard: the
  // saved one stands rather than being wiped by the defaults.
  const incoming = config && typeof config === "object" && !("contactCard" in config) && saved.conversationAi?.contactCard
    ? { ...config, contactCard: saved.conversationAi.contactCard } : config;
  const next = normalizeConversationAi(incoming);
  // The card's public link (/card/<token>) is minted once, the first time a
  // card is saved, and kept after that.
  if (next.contactCard.vcard && !next.contactCard.token) {
    const had = normalizeConversationAi(saved.conversationAi).contactCard.token;
    next.contactCard = { ...next.contactCard, token: had || mintCardToken() };
  }
  await store.saveOfferSettings(locationId, { ...saved, conversationAi: next });
  return next;
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

// The share of the day's cap that only replies to people may use. Constants,
// not settings: a save can't hand the machine the whole day.
export const REPLY_RESERVE_SHARE = 0.25;
export const REPLY_RESERVE_MIN = 10;

// Drafts started today, from the STORE plus whatever is in flight — the same
// shape as the underwriter's guard, for the same reason: a crash loop must not
// hand a misconfigured workflow a fresh budget every restart.
export async function countToday({ store, locationId, now = Date.now(), cap = 0 }) {
  const since = dayStartIso(now);
  const ids = new Set();
  for (const j of jobs.values()) {
    if (j.locationId === locationId && String(j.startedAt) >= since) ids.add(j.id);
  }
  // Newest first, so the read only has to reach past the cap to be exact.
  const rows = await store.listReplyDrafts(locationId, { since, limit: Math.max(500, Math.round(Number(cap) || 0) + 1) }).catch(() => []);
  for (const d of rows) if (d?.jobId) ids.add(d.jobId);
  return ids.size;
}

/**
 * machineRoomToday({ store, locationId, saved, now }) → number
 *
 * How many more texts the machine may start today before it reaches the
 * reserve kept for people who text us (startProactive's own check).
 * Infinity with no cap. The outreach sweep asks first, so it never creates
 * an agent in GHL it then can't text.
 */
export async function machineRoomToday({ store, locationId, saved = {}, now = Date.now() }) {
  const cap = Math.round(Number(conversationConfig(saved).dailyCap) || 0);
  if (!(cap > 0)) return Infinity;
  const reserve = Math.max(REPLY_RESERVE_MIN, Math.ceil(cap * REPLY_RESERVE_SHARE));
  const used = await countToday({ store, locationId, now, cap });
  return Math.max(0, cap - reserve - used);
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
  batch = null, shadowModel = null, now = Date.now(), fix = null,
}) {
  const client = new Anthropic({ apiKey: aiApiKey, timeout: 120_000 });
  const cfg = config || normalizeConversationAi(null);
  const ctx = context || {
    text: offers.count
      ? `OUR OFFERS TO THIS AGENT (newest first — the only numbers you may quote):\n${offers.text}`
      : "",
  };
  const system = buildSystemPrompt({ config: cfg, party, channel });
  const user = buildUserContext({ party, contact, signer, instructions, context: ctx, underwriting, transcript, message, outbound, inboundKind, call, companyContact, fix });
  const intents = outbound ? [outbound.kind] : (INTENTS[party] || INTENTS.agent);
  const params = draftParams({ model: REPLY_MODEL, system, user, schema: schemaFor(party, { outbound, booking: Boolean(booking) }), effort: draftEffort(outbound) });

  // The shadow: the same request on another model, stored beside the real
  // draft and never sent (config.ai.shadowModel until config.ai.shadowUntil).
  // It never delays or fails the real draft.
  const shadowOn = shadowModel ?? shadowModelFor(cfg.ai, now);
  const shadowRun = shadowOn && shadowOn !== REPLY_MODEL
    ? callDraftModel(client, { ...params, model: shadowOn })
      .then(({ response, batched }) => ({ model: shadowOn, ...parseDraft(response, intents, cfg, outbound), usage: meterAi("draft_shadow", response, { model: shadowOn, batched }) }))
      .catch((e) => ({ model: shadowOn, error: String(e?.message || e).slice(0, 160) }))
    : null;

  let response;
  let batched = false;
  try {
    ({ response, batched } = await callDraftModel(client, params, { batch }));
  } catch (e) {
    throw anthropicErrorToHttp(e);
  }
  // The real draft waits for the shadow a little while at most; a slow shadow
  // is recorded as late, never a slow reply.
  let graceTimer = null;
  const shadow = shadowRun
    ? await Promise.race([shadowRun, new Promise((r) => { graceTimer = setTimeout(() => r({ model: shadowOn, error: "shadow still running when the real draft was done" }), SHADOW_GRACE_MS); })])
    : null;
  clearTimeout(graceTimer);
  // A reply written again because a gate caught it is its own line on the
  // spend ledger, so what the redraft costs can be read apart.
  const usage = meterAi(outbound ? "draft_machine" : fix?.length ? "draft_regate" : "draft_reply", response, { model: REPLY_MODEL, batched });
  return { ...parseDraft(response, intents, cfg, outbound), usage, ...(shadow ? { shadow } : {}) };
}

// The shadow's draft as the row keeps it, judged by the same gates as the
// real one so the two can be compared on what would actually have happened.
// Never sent, never acted on.
export function shadowRow(shadow, gateFor) {
  if (!shadow) return null;
  if (shadow.error) return { model: shadow.model, error: shadow.error };
  const g = gateFor(shadow);
  return {
    model: shadow.model, intent: shadow.intent, confidence: shadow.confidence, needsHuman: shadow.needsHuman,
    humanReason: shadow.humanReason, reply: shadow.reply, counterAmount: shadow.counterAmount || 0,
    gateOk: Boolean(g.ok), flags: (g.flags || []).slice(0, 6), usage: shadow.usage || null,
  };
}

// The model every real draft runs on. The shadow (config.ai) is how a cheaper
// one earns this spot: on live traffic, beside it, before it replaces it.
// Sonnet 5 earned it on 2026-09-30: 420 drafts beside Opus 5 — same intent
// 80%, same needs-a-person 87%, 42% of the cost, and every number above ours
// caught by the gates. Matt: "do everything".
export const REPLY_MODEL = "claude-sonnet-5";
// Where a draft Sonnet declines goes: Opus, with its server-side fallback.
export const REFUSAL_RETRY_MODEL = "claude-opus-5";
export const SHADOW_GRACE_MS = 20_000;

// Plain check-ins with no number, no negotiation and no terms in them — the
// texts where thinking harder buys nothing (2026-09-25). Everything else,
// replies included, stays at medium.
// A lead this far out is its own check-in, not the address chase's first ask
// (promise-sweep.js reads a chase for 60 days and its ladder runs 28 past its first).
const LEAD_CHASE_MAX_DAYS = 21;

export const LOW_EFFORT_KINDS = new Set(["offer_nudge", "outreach_nudge", "checkin_due", "passed_checkin", "buyer_pulse", "agent_pulse", "blast_nudge", "dataroom_nudge", "deal_followup", "showing_reminder", "showing_followup"]);
export const draftEffort = (outbound) => (outbound && LOW_EFFORT_KINDS.has(outbound.kind) ? "low" : "medium");

// Machine texts a gate catches that wait for a person rather than being
// redrafted or dropped (runProactive): our number floated, a promised
// number, a price drop, the first text to a new agent.
export const KEEP_FOR_A_PERSON = new Set(["realm_check", "take_check", "promise_due", "price_drop", "outreach_open"]);

// Texts a sweep starts that nobody is waiting on: these may go through the
// Batch API at half price (draft-batch.js). A float after an underwrite, a
// partner's answer, an address chase and every reply to a person may not.
export const BATCHABLE_KINDS = new Set([
  "outreach_open", "outreach_nudge", "counter_nudge", "take_ask", "offer_nudge", "hot_push", "passed_checkin",
  "buyer_pulse", "agent_pulse", "blast_nudge", "dataroom_nudge", "deal_followup", "promise_due", "price_drop", "checkin_due",
  "showing_reminder", "showing_followup", "second_look",
]);

export function draftParams({ model, system, user, schema, effort = "medium" }) {
  return {
    model,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    // The system prompt is the same bytes for every draft this location sends
    // to this party on this channel, so it caches. Drafts arrive every few
    // minutes through the day, which the 5-minute cache missed about half the
    // time (each miss re-writes ~5K tokens at 1.25x); the hour holds it from
    // one draft to the next.
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }],
    // Answering a text is not a reasoning problem. The default (high) buys
    // thinking this job has no use for and bills it as output.
    output_config: { effort, format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: [{ type: "text", text: user }] }],
  };
}

// The Opus and Fable tiers carry the server-side refusal fallback; a batch
// request is sent without it and falls back to this direct call on anything
// but a clean result, a refusal included.
const withFallbacks = (model) => /^claude-(opus-5|fable)/.test(model);
export async function callDraftModel(client, params, { batch = null } = {}) {
  if (batch) {
    try {
      const response = await batch.enqueue(params);
      if (response?.stop_reason !== "refusal") return { response, batched: true };
    } catch (e) {
      console.log(`draft batch fell back to a direct call: ${String(e?.message || e).slice(0, 120)}`);
    }
  }
  const direct = (p) => (withFallbacks(p.model)
    ? client.beta.messages.create({ ...p, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
    : client.messages.create(p));
  let response = await direct(params);
  // Sonnet carries no server-side fallback, so a draft it declines would just
  // fail. It is written once more on Opus, which has its own.
  if (response?.stop_reason === "refusal" && !withFallbacks(params.model)) {
    response = await direct({ ...params, model: REFUSAL_RETRY_MODEL });
  }
  return { response, batched: false };
}

// A buyer saying they want to see it or buy it (reply-agent runReply).
const WARM_INTENTS = new Set(["wants_walkthrough", "wants_to_buy"]);

// A reply about a deal puts them on it (2026-10-01). Kenneth Patton asked
// about 1510 Maple Lane's land lease, its size and its photos and was on no
// deal: only WARM_INTENTS linked a buyer, and a question never did. A
// question, interest or a push on price is someone looking at it; a pass is
// filed as a pass, with what they said.
const DEAL_REPLY_INTENTS = new Set([...WARM_INTENTS, "interested", "question", "price_pushback", "wants_call"]);
// A reply that doesn't name the house is about the deal last mentioned in the
// thread — only if it came up this recently.
export const DEAL_REPLY_DAYS = 14;
// "Liked “…”", "ok", "thanks", an emoji: a reply, but nothing about the deal.
const TAPBACK_RX = /^(liked|loved|laughed at|emphasized|questioned|disliked)\s+[“"']/i;
const ACK_RX = /^(ok(ay)?|k|kk|thanks?|thank you|thx|ty|sounds good|got it|cool|great|nice|will do|👍|🙏|😁|😀|🙂|😊)[\s.!]*$/i;

/**
 * dealReplyFiling({ intent, propertyAddress, passReason, linkedDeals })
 *   → { status, reason, revive, withinDays } | null
 *
 * How a reply the bot read is filed on a deal. Walking it or buying it, as
 * before, from anyone (and a buyer who had passed is back). A question,
 * interest, a price push or wanting a call: evaluating. A pass: passed, with
 * the model's reason. Either of the last two only when the reply is about a
 * deal — it names one, or a live deal was sent to them (`linkedDeals`, the
 * investor context's deals they're on or were blasted).
 */
export function dealReplyFiling({ intent = "", propertyAddress = "", passReason = null, linkedDeals = [] } = {}) {
  const status = intent === "passing" ? "passed" : DEAL_REPLY_INTENTS.has(intent) ? "evaluating" : null;
  if (!status) return null;
  const warm = WARM_INTENTS.has(intent);
  if (!warm && !String(propertyAddress || "").trim() && !(linkedDeals || []).length) return null;
  return { status, reason: status === "passed" ? passReason || null : null, revive: warm, withinDays: warm ? 0 : DEAL_REPLY_DAYS };
}

/**
 * heldDealReplyFiling(message, linkedDeals) → the same, for a reply the bot
 * stood aside from because Matt has the thread — nothing read it but this.
 * Only someone not on the deal yet is added (never a status changed on a
 * guess): passed when the words plainly say no (deal-feedback.js PASS_RE),
 * otherwise evaluating. A tapback or a bare "ok" files nothing.
 */
export function heldDealReplyFiling(message = "", linkedDeals = []) {
  const t = String(message || "").trim();
  if (!t || !(linkedDeals || []).length || TAPBACK_RX.test(t) || ACK_RX.test(t)) return null;
  // "No. I've seen this one… better as a teardown" (Kenneth Patton on 3511
  // NE 153rd) opens on the no; PASS_RE looks for the reason words.
  const passed = PASS_RE.test(t) || /^(no|nope|nah)\b/i.test(t);
  return { status: passed ? "passed" : "evaluating", reason: passed ? inferReason(t) : null, revive: false, addOnly: true, withinDays: DEAL_REPLY_DAYS };
}

/**
 * walkthroughDealFor(deals, address) → the deal row a buyer's walkthrough
 * talk is about, or null.
 *
 * Only a deal under contract that the buyer is already on (sent it, or
 * linked). The one the message names, else the only one there is — two open
 * houses and no address is a person's read, not ours.
 */
export function walkthroughDealFor(deals = null, address = "") {
  const rows = (deals?.linked || []).filter((d) => d?.stage === "under_contract" && d.offerId);
  if (!rows.length) return null;
  if (address) {
    const named = rows.find((d) => sameStreet(d.address, address));
    if (named) return named;
  }
  return rows.length === 1 ? rows[0] : null;
}

/**
 * dealToEmailFor(deals, address) → the deal row a buyer who asked for email
 * should get by email, or null.
 *
 * A live deal they're already on (sent it, or linked): the one the message
 * names, else the only one there is. Two and no address: nothing is guessed.
 */
export function dealToEmailFor(deals = null, address = "") {
  const rows = (deals?.linked || []).filter((d) => d?.offerId);
  if (!rows.length) return null;
  if (address) {
    const named = rows.find((d) => sameStreet(d.address, address));
    if (named) return named;
  }
  return rows.length === 1 ? rows[0] : null;
}

/**
 * vacantPerRecord(deals, address) → true only when the deal this text is
 * about is recorded vacant (shared/deal-access.js). No address, no match, or
 * nothing recorded → false: "vacant" is then the model's guess.
 */
export function vacantPerRecord(deals = null, address = "") {
  if (!address) return false;
  const rows = [...(deals?.linked || []), ...(deals?.matching || [])];
  const hit = rows.find((d) => sameStreet(d?.address, address));
  return hit?.occupancy === "vacant";
}

/**
 * houseWordsFor(deals, transcript, inbound) → the words a buyer text may use
 * about a house: each deal's own words (the headline, the rehab level Matt
 * picked — conversation-context.js) and whatever the buyer said themselves.
 * Our own earlier texts are left out on purpose: an old blast that said
 * "heavy rehab" is the mistake, not a licence to repeat it.
 */
export function houseWordsFor(deals = null, transcript = "", inbound = "") {
  const rows = [...(deals?.linked || []), ...(deals?.matching || [])];
  const ours = rows.flatMap((d) => [d?.ownWords, d?.rehabLevel ? `${d.rehabLevel} rehab` : ""]);
  const theirs = String(transcript || "").split("\n").filter((l) => /^\[[^\]]+\] THEM\b/.test(l));
  return [...ours, ...theirs, inbound].filter(Boolean).join("\n");
}

/**
 * claimsAccess(reply, { vacantOk }) → the words that claim something about
 * getting into the house, or "".
 *
 * "Open" about the house is never ours to say (a deal is "available"); an
 * access code never goes in a text; "vacant"/"empty"/"go by any time" only
 * when the deal is recorded vacant. "Open to a call" and "are you open to
 * heavy rehab" are about the person, not the house.
 */
export function claimsAccess(reply = "", { vacantOk = false } = {}) {
  const t = String(reply || "");
  const open = t.match(/\b(?:it'?s|it is|house is|place is|property is|home is|still)\s+(?:still\s+|wide\s+)?open\b(?!\s+to\b)|\bopen\s+(?:right now|now|today|house)\b/i);
  if (open) return open[0];
  const code = t.match(/\b(?:lock\s?box|door|gate|access|entry)\s+code\b/i);
  if (code) return code[0];
  if (!vacantOk) {
    const empty = t.match(/\b(?:vacant|empty|unlocked|unoccupied|nobody(?:'s| is) (?:living|home)|no one(?:'s| is)? living)\b|\b(?:go|swing|drive|stop|pop) by (?:any ?time|whenever)\b|\b(?:walk|see) (?:it|in) (?:any ?time|whenever)\b/i);
    if (empty) return empty[0];
  }
  return "";
}

// `outbound`: a machine-started text is always its own kind, whatever the
// model wrote in the field (its schema no longer lists the one value — see
// schemaFor).
export function parseDraft(response, intents, cfg, outbound = null) {
  if (response.stop_reason === "max_tokens") {
    throw Object.assign(new Error("reply drafting was truncated"), { http: 502 });
  }
  if (response.stop_reason === "refusal") {
    throw Object.assign(new Error("reply drafting was declined"), { http: 502 });
  }
  const raw = response.content.find((b) => b.type === "text")?.text || "{}";
  const p = JSON.parse(raw);
  return {
    intent: outbound?.kind || (intents.includes(p.intent) ? p.intent : "other"),
    confidence: CONFIDENCES.includes(p.confidence) ? p.confidence : "low",
    reply: scrubReply(String(p.reply || "").trim(), cfg.style),
    needsHuman: Boolean(p.needsHuman),
    humanReason: String(p.humanReason || "").trim().slice(0, 300),
    summary: String(p.summary || "").trim().slice(0, 300),
    propertyAddress: String(p.propertyAddress || "").trim().slice(0, 200),
    // Agents only: every house they named in this message, address or not.
    houses: normalizeMentionedHouses(p.houses),
    counterAmount: Math.max(0, Number(p.counterAmount) || 0),
    // Investors only, and only when they turned something down.
    passReason: normalizePassReason(p.passReason),
    // Investors only: what this message said about walking the house.
    walkthrough: RSVP_SIGNALS.includes(p.walkthrough) ? p.walkthrough : "",
    // Agents only: what THEY think it's worth and costs. Theirs, never ours.
    agentTake: normalizeAgentTake(p),
    // Agents only: how warm they are toward our number ("might work", "let's present it").
    dealSignal: DEAL_SIGNALS.includes(p.dealSignal) ? p.dealSignal : "",
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
/**
 * isTurnkeyReply(message) → boolean
 *
 * The agent told us the house needs nothing: turnkey, renovated, remodeled,
 * move-in ready, "not a project". The words are read in one place
 * (shared/held-underwrites.js saysTurnkey) so the nightly sweep and the
 * underwriter read them the way the bot does.
 */
export const isTurnkeyReply = (message = "") => saysTurnkey(message);

/**
 * isShowingOffer(message) → boolean
 *
 * The agent is offering to show us the house — a tour, a showing, a
 * walkthrough, "would you like to see it?". Matt (2026-09-14, Velia Sierra's
 * triplex on 4207 S Bateman St): before anybody books a time, get them a
 * number and see whether it makes sense at all.
 */
export function isShowingOffer(message = "") {
  const t = String(message || "");
  return /\b(?:private\s+)?(?:tours?|showings?|walk[\s-]?throughs?|viewings?|open\s+house)\b/i.test(t)
    || /\b(?:like|want|love|happy|able|welcome)\s+to\s+(?:see|tour|view|walk)\b/i.test(t)
    || /\b(?:come\s+(?:by|see|take\s+a\s+look)|show\s+(?:it|you|the\s+(?:house|home|property|place|units?))|see\s+it\s+in\s+person)\b/i.test(t)
    // Haleh Clapp, 2026-09-14: "Feel free to make an appointment to see it."
    // An appointment or a time TO SEE it — "a time to talk" is a call.
    || /\b(?:appointment|appt|time|visit)\s+to\s+(?:see|view|tour|walk|look\s+at|get\s+in(?:to|side)?)\b/i.test(t)
    || /\b(?:go|feel\s+free\s+to)\s+(?:see|view|tour|walk|take\s+a\s+look\s+at|look\s+at)\s+(?:it|the\s+(?:house|home|property|place|units?))\b/i.test(t)
    || /\b(?:want|like|need)\s+to\s+get\s+in(?:\s+there|side|to\s+(?:it|the\s+(?:house|home|property|place|units?)))\b/i.test(t);
}

/**
 * floorFirmness(message) → "firm" | "soft" | "plain"
 *
 * How hard a named number is. "If you were more around $460k we would consider
 * it most likely" (Jahine Wallace) and "if your number starts with an eight, I
 * can probably make something work" (Kevin Flynn) are openings, not goodbyes;
 * "he won't entertain anything under 450k" is a wall. Matt, 2026-09-14: for
 * the soft ones, ask for their numbers and re-quote instead of closing.
 */
export function floorFirmness(message = "") {
  const t = String(message || "");
  if (/\b(?:won['’]?t|will\s+not|not\s+going\s+to)\s+(?:entertain|consider|accept|take|go\s+(?:below|under|lower))|\bno\s+need\s+to\s+(?:submit|send|write)|\bfirm\b|non[\s-]?negotiable|bottom\s+line|not\s+a\s+(?:penny|dollar)\s+(?:less|under|below)/i.test(t)) return "firm";
  // "Can't go any less than that" (184th St SE, 2026-10-07): the seller
  // can't come down, said plainly. Texts from a phone carry a curly
  // apostrophe.
  if (/\b(?:can['’]?t|cannot|can\s+not|won['’]?t|will\s+not|not\s+going\s+to)\s+(?:go|do|take|accept)\s+(?:any(?:thing)?\s+)?(?:less|lower|below|under)\b/i.test(t)) return "firm";
  if (/\bwould\s+(?:\w+\s+){0,2}consider|\bmost\s+likely|\bprobably\s+(?:work|consider|take|do|make)|\bstarts?\s+with\s+an?\b|\bmake\s+(?:something|it)\s+work|\bopen\s+to\b|\bif\s+you\s+(?:were|can|could|came|come|got|get)\b|\bin\s+the\s+(?:ballpark|neighborhood|range)\b|\bmight\s+(?:work|take|consider|do)\b/i.test(t)
    // "I could get them to 950 but no way on that number" (Lori Mcdonald,
    // 2026-09-14): a number they can deliver is an opening, whatever follows.
    || /\b(?:could|can|might|should|would)\s+(?:probably\s+|likely\s+|maybe\s+)?(?:get|bring|push)\s+(?:them|him|her|the\s+sellers?)\s+(?:down\s+)?to\b/i.test(t)) return "soft";
  return "plain";
}

/**
 * passHeldWhy({ offer, message }) → "" | why the far-counter goodbye waits
 *
 * The canned "too far apart" goodbye is for a text about one house that asks
 * nothing of us. Already passed: we closed it out, and their number said
 * again isn't news. Asked our number, or another house in the text: the
 * goodbye answers neither, so a person does.
 */
export function passHeldWhy({ offer, message = "" } = {}) {
  const street = String(offer?.address || "").split(",")[0].trim() || "the house";
  if (offerStatus(offer) === "passed") return `we already passed on ${street} — their number again is for a person, not a second goodbye`;
  if (asksOurNumber(message)) return `they asked what we'd offer on ${street} — a goodbye doesn't answer it`;
  const other = housesInText({ message, except: [offer?.address || ""] })[0];
  if (other) return `their text is also about ${other.address || other.label} — a goodbye on ${street} would answer the wrong house`;
  return "";
}

export function normalizeAgentTake(p) {
  const arv = Math.max(0, Math.round(Number(p?.agentArv) || 0));
  const rehab = Math.max(0, Math.round(Number(p?.agentRehab) || 0));
  const note = String(p?.agentTakeNote || "").trim().slice(0, 200);
  return arv || rehab ? { arv, rehab, note } : null;
}

// Shorthand money → whole dollars. "60" beside repairs is $60,000; "1.6" beside
// value is $1,600,000. An explicit k/m wins; a number already in dollars stands.
const shorthandDollars = (raw, unit = "", { millionsUnder = 10 } = {}) => {
  const n = Number(String(raw).replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return 0;
  const u = String(unit || "").toLowerCase();
  if (u === "m" || u === "mm" || u === "mil") return Math.round(n * 1_000_000);
  if (u === "k") return Math.round(n * 1000);
  if (n >= 10000) return Math.round(n);
  if (n < millionsUnder && /\./.test(String(raw))) return Math.round(n * 1_000_000);
  return Math.round(n * 1000);
};

/**
 * agentTakeFromText(message) → { arv, rehab, note } | null
 *
 * The backstop for THEIR TAKE when the model returns 0 on shorthand. On
 * 2026-09-14 Thomas Rinow wrote "Even at 60 in repairs we're well over your
 * price" and the take came back empty, so the re-quote found "nothing new"
 * and the bot asked for a counter instead of re-running our math on $60k.
 * Deliberately narrow: a number has to sit right beside a repairs/rehab/work
 * word (rehab) or a worth/value/ARV word (arv). A price they want ("lowest is
 * $700k", "need to be at 610") is a counter, not a take, and is never read here.
 */
export function agentTakeFromText(message = "") {
  const text = String(message || "");
  const range = (a, b) => (b ? (Number(a) + Number(b)) / 2 : Number(a));
  const num = "\\$?(\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?)\\s*(?:-|to)?\\s*\\$?(\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?)?\\s*(k|m|mm|mil)?";
  let rehab = 0;
  let arv = 0;
  // "60 in repairs", "60k of work", "$45,000 rehab"
  const r1 = text.match(new RegExp(`${num}\\s*(?:in|of|for|worth of)?\\s*(?:repairs?|rehab|work|fix(?:es)?)\\b`, "i"));
  // "repairs around 60", "rehab is 45k"
  const r2 = text.match(new RegExp(`\\b(?:repairs?|rehab)\\s*(?:is|are|at|around|about|of|~)?\\s*${num}`, "i"));
  const rm = r1 || r2;
  // Work already done ("56k in work done before it was listed") isn't a take.
  if (rm && !isPastWork(text, rm.index, rm[0].length)) rehab = shorthandDollars(range(rm[1].replace(/,/g, ""), rm[2]?.replace(/,/g, "")), rm[3], { millionsUnder: 0 });
  // "worth 850", "value closer to 1.6-1.8", "ARV 715k", and "value fixed up
  // could be" two figures (2026-10-16 — the take came back empty and the
  // reply argued our 842k at him)
  const a1 = text.match(new RegExp(`\\b(?:worth|value[ds]?|arv|after repair value)(?:\\s+(?:fixed up|done|finished|updated|after repairs?))?\\s*(?:(?:could|would|should|might|will)\\s+be|is|at|of|around|about|closer to|more like|~)?\\s*(?:around|about|~)?\\s*${num}`, "i"));
  // "715 done", "1.6-1.8 fixed up"
  const a2 = text.match(new RegExp(`${num}\\s*(?:done|fixed up|finished|after repairs?)\\b`, "i"));
  // "1.6-1.8 value", "850 ARV"
  const a3 = text.match(new RegExp(`${num}\\s*(?:value|arv|after repair value)\\b`, "i"));
  const am = a1 || a2 || a3;
  if (am) {
    const raw = am[2] ? String(range(am[1].replace(/,/g, ""), am[2].replace(/,/g, ""))) : am[1].replace(/,/g, "");
    const decimal = /\./.test(am[1]) || /\./.test(am[2] || "");
    arv = shorthandDollars(decimal && !/\./.test(raw) ? `${raw}.0` : raw, am[3]);
  }
  // Sanity: a rehab figure over $5M or an ARV under $50k is a misread, not a take.
  if (rehab > 5_000_000) rehab = 0;
  if (arv && arv < 50_000) arv = 0;
  if (!arv && !rehab) return null;
  return { arv, rehab, note: text.replace(/\s+/g, " ").trim().slice(0, 200) };
}

// Price language with a bare number right after it: "go to 670", "take 650",
// "wants 700", "needs to be at 610". The number itself is captured alone — no
// comma group, no k/m suffix, no unit word behind it — because anything
// written in full is already money and moneyIn has it.
const COUNTER_CUE_RX = new RegExp(
  "\\b(?:(?:go(?:ing)?|get(?:ting)?|come|bring|push|move)\\s+(?:(?:them|him|her|the\\s+sellers?)\\s+)?(?:up\\s+|down\\s+)?to|take|takes|accept|want(?:s|ed)?|" +
  "need(?:s|ed)?(?:\\s+to\\s+be)?(?:\\s+at)?|ask(?:ing)?(?:\\s+for)?|counter(?:ed|ing)?\\s+at|looking\\s+at|lowest(?:\\s+is)?|" +
  "at|for|net(?:s|ting)?)\\s*\\$?\\s*(\\d{2,4}(?:\\.\\d+)?)(?![\\d,.])(?!\\s*[kKmM%])" +
  "(?!\\s*(?:days?|hours?|minutes?|mins?|weeks?|months?|years?|am|pm|sq|st\\b|nd\\b|rd\\b|th\\b))",
  "gi"
);

/**
 * counterDollars(said, { message, reference }) → whole dollars
 *
 * The seller's number as the agent actually typed it.
 *
 * moneyIn refuses a bare integer on purpose — "14" is a day count and "2026" is
 * a year, and the leak guard must never read a day as a dollar. On a counter
 * that rule cost us a live negotiation: Thomas Rinow, 2026-09-15, answered our
 * $456,250 on 10412 SE 219th with "That are willing to go to 670" — the number
 * we had just asked him for. The band saw no number in his message, failed on
 * "at or under our own number", and nobody replied at all.
 *
 * Narrow on purpose. The bare number has to sit beside price language in THEIR
 * message, it is read as thousands the way agents write it (a decimal under 10
 * is millions, "1.6"), and the result must land in a house-price band around
 * our own offer — half to five times it. So a day count, a door code, a year
 * or a phone extension can never become a counter, and two different candidate
 * numbers are left for a person rather than guessed between.
 *
 * A figure they wrote in full ("$670,000", "670k") is already money and stands.
 * Pure.
 */
export function counterDollars(said, { message = "", reference = 0 } = {}) {
  const asked = Math.max(0, Math.round(Number(said) || 0));
  const ref = Math.max(0, Math.round(Number(reference) || 0));
  if (!ref) return asked;
  const plausible = (n) => n >= ref * 0.5 && n <= ref * 5;
  if (plausible(asked)) return asked;

  const found = new Set();
  for (const m of String(message || "").matchAll(COUNTER_CUE_RX)) {
    const n = shorthandDollars(m[1]);
    if (plausible(n)) found.add(n);
  }
  // The model's own read, scaled — but only when they actually typed it.
  if (asked > 0) {
    const scaled = shorthandDollars(String(asked));
    if (plausible(scaled) && found.has(scaled)) return scaled;
  }
  return found.size === 1 ? [...found][0] : asked;
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
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: CLASSIFY_SYSTEM,
      // One output_config: this call used to set it twice, and the second
      // (format only) silently dropped effort "low" (2026-09-30).
      output_config: { effort: "low", format: { type: "json_schema", schema: CLASSIFY_SCHEMA } },
      messages: [{ role: "user", content: [{ type: "text", text: buildClassifyContext({ contact, transcript, message }) }] }],
    });
  } catch (e) {
    throw anthropicErrorToHttp(e);
  }
  meterAi("classify_party", response, { model: "claude-sonnet-5" });
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
 * namesHidden(text, hidden) → the hidden figures the text says, any way at all
 *
 * Profit and risk (shared/offer-breakdown.js) is the one line of our math a
 * text never gives a figure — it holds our margin. Said as "$91,217", "91k",
 * or the bare "91" we text thousands as. The bare reading is deliberately
 * eager (a false hold beats a leak), short of a count of days or months.
 * Pure.
 */
export function namesHidden(text, hidden = []) {
  const targets = (hidden || []).map((n) => Math.round(Number(n) || 0)).filter((n) => n >= 10000);
  if (!targets.length) return [];
  const t = String(text || "");
  const said = new Set(moneyIn(t));
  const BARE = /(?<![\d,.$])\b(\d{2,3})\b(?![\d,.]|\s*(?:%|[kKmM]\b|days?\b|weeks?\b|months?\b|years?\b|yrs?\b|hours?\b|mins?\b|minutes?\b|am\b|pm\b))/g;
  for (const m of t.matchAll(BARE)) said.add(Number(m[1]) * 1000);
  return targets.filter((h) => [...said].some((n) => Math.abs(n - h) < 1000));
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

// The bot is Matt; it never hands off to him. "I'll flag it to Matt in case
// he's got questions before he signs tonight" (Gig Harbor, 2026-10-21) went
// to an agent who'd talked to Matt by phone twice that day, and she asked who
// she'd been texting and wanted his driver's license before going on. Our
// first name is ours to say only as who we are ("it's Matt", "Matt here"), as
// a sign-off, or inside the saved answer to "are you a bot?".
export function talksAboutUsAsSomeoneElse(reply, { selfName = "", contactName = "", signOff = "", botAnswer = "" } = {}) {
  const ours = firstNameOf(selfName);
  if (ours.length < 2 || !reply) return false;
  if (ours.toLowerCase() === firstNameOf(contactName).toLowerCase()) return false;
  const n = escapeRe(ours);
  let text = String(reply).trim();
  const so = String(signOff || "").trim();
  if (so && text.toLowerCase().endsWith(so.toLowerCase())) text = text.slice(0, -so.length).trim();
  const bot = String(botAnswer || "").trim();
  if (bot) text = text.split(bot).join(" ");
  text = text
    .replace(/\S+@\S+|https?:\/\/\S+|\b[\w-]+\.(?:com|net|org)\b\S*/gi, " ")
    // An email's signature block: our name alone on its line, surname and all.
    .replace(new RegExp(`^[ \\t]*[-–—]?[ \\t]*${n}(?:[ \\t]+[A-Z][\\w.'-]*)*[ \\t]*$`, "gm"), " ")
    .replace(new RegExp(`(?:[\\n.!?,]|\\s[-–—])\\s*(?:thanks|thank you|talk soon|best|cheers)?[,]?\\s*${n}[.!]?$`, "i"), "")
    .replace(new RegExp(`\\b(?:it'?s|it is|this is|i'?m|i am|my name is|name'?s)\\s+${n}\\b`, "gi"), " ")
    .replace(new RegExp(`\\b${n}\\s+here\\b`, "gi"), " ");
  return new RegExp(`\\b${n}\\b`, "i").test(text) && !callsThemOurName(reply, { selfName, contactName, signOff });
}

// How sure is sure enough. "medium" lets a draft the model was fairly sure
// of go on its own; "high" waits for a person unless it was certain.
const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };

export function evaluateReplyGates({
  draft, party = "agent", allowedAmounts = [], forbiddenAmounts = [], staleAmounts = [], hiddenAmounts = [], ranges = [], inboundMessage = "", channel = "sms", style = null,
  minConfidence = "high", holdOnNeedsHuman = true, selfName = "", contactName = "", signOff = "", botAnswer = "", ourAmount = 0,
  vacantOk = false, carrierCheck = false, houseWords = "", writeUpOk = true, theirValue = 0, ourValue = 0,
}) {
  const flags = [];
  if (!draft) return { ok: false, flags: ["no draft was produced"] };
  // A machine text that introduces us and reads like a we-buy-houses ad is
  // what the carriers block (Error 30007; shared/carrier-words.js).
  const blocked = carrierCheck && channel === "sms" ? carrierFlags(draft.reply) : [];
  if (blocked.length) flags.push(`carriers block texts like this — it says ${blocked.map((w) => `"${w}"`).join(", ")}`);
  if (callsThemOurName(draft.reply, { selfName, contactName, signOff })) {
    flags.push(`the draft calls them "${firstNameOf(selfName)}", which is our name, not theirs`);
  }
  if (talksAboutUsAsSomeoneElse(draft.reply, { selfName, contactName, signOff, botAnswer })) {
    const me = firstNameOf(selfName);
    flags.push(`the draft talks about ${me} as someone else — you are ${me}; say it in the first person ("let me call you on that"), never "I'll flag it to ${me}"`);
  }
  const never = NEVER_AUTO[party] || NEVER_AUTO.agent;
  const maxSms = Number(style?.maxSmsChars) > 0 ? Number(style.maxSmsChars) : RA_MAX_SMS_CHARS;

  const known = [...(INTENTS[party] || INTENTS.agent), ...(OUTBOUND_INTENTS[party] || [])];
  if (never.includes(draft.intent) || !known.includes(draft.intent)) {
    flags.push(personsCall(draft.intent));
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
  // Showing our work never means showing how we exit or what we make. The
  // prompt says so; this is the backstop that holds the text if it slips.
  if (party === "agent") {
    // They offered to work together on terms (shared/partner-terms.js): a
    // list-back, being our buyer's agent, a fee, their deal list, buying
    // themselves. Matt answers terms; no intent, guard or audit sends it.
    const terms = draft.partnerTerms?.kind ? PARTNER_TERMS_LABEL[draft.partnerTerms.kind] : "";
    if (terms) flags.push(`they ${terms} — partner terms are yours to answer`);
    // They offered a showing on a live house (2026-10-15): book it, call, or pass is Matt's.
    if (draft.showingOffered) flags.push(`they offered a showing on ${String(draft.showingOffered.address || "the house").split(",")[0]} — yours to book, call or pass`);
    // "and/or assigns" is how the buyer is written on the contract, not a
    // word about how we exit.
    const slip = draft.reply.replace(/\band\/or assigns\b/gi, "").match(/\b(assign(?:ment|ing|ed|s)?|wholesal(?:e|er|ing)|end buyer|our fee|my fee|spread)\b/i);
    if (slip) flags.push(`the draft says "${slip[0]}" — how we exit and what we make never goes to an agent`);
    // We run our own numbers (Matt, 2026-10-21): the one gut check says
    // whether it's flip material, and nothing after it asks them for theirs.
    if (asksTheirRehab(draft.reply)) {
      flags.push("the draft asks them what the work would run or what it's worth fixed up — we run our own numbers; ask what the seller's hoping to get or their timeline instead");
    }
    // The hot push has one ask: the listing agent writes it up on NWMLS
    // forms for us to sign. Offering our own paper is a different move, and
    // a person's.
    const paper = draft.intent === "hot_push" ? draft.reply.match(/\bPSA\b|purchase\s+(?:and|&)\s+sale|\bcontracts?\b/i) : null;
    if (paper) flags.push(`the draft says "${paper[0]}" — the hot push asks for the NWMLS offer, never our paper`);
    // "Earnest? Inspection?" has a standing answer (the write-up terms in
    // the prompt). Putting it off to a partner is the one thing it must not do.
    if (asksWriteUpTerms(inboundMessage) && defersWriteUpTerms(draft.reply)) {
      flags.push("the draft puts off earnest, inspection or the buyer name — the write-up terms answer those in the same message");
    }
    // "Write up whatever you like! Call the listing broker" (3418
    // Wetmore Ave, 2026-10-03): they think we write our own offer. A reply
    // that doesn't clear that up is going on past a misunderstanding.
    if (handsWriteUpBack(inboundMessage) && !clearsWriteUp(draft.reply)) {
      flags.push("they handed the write-up back to us — the reply has to say we're not agents and ask who on their side writes it on NWMLS forms");
    }
    // A write-up ask at a number Matt hasn't approved (2026-10-15): "since
    // we're aligned at 752,500, can you write it up?" and the next day "can't
    // get there". Not the clarification the rule above asks for when they
    // handed the write-up back to us.
    if (!writeUpOk && asksWriteUp(draft.reply) && !(handsWriteUpBack(inboundMessage) && NOT_AGENTS_RX.test(draft.reply))) {
      flags.push("the draft asks them to write it up (NWMLS, represent us) at a number you haven't approved — approve it on the offer first (Offers → Hot)");
    }
    // 10917 48th St E, 2026-09-27: "cash means no lender". We use hard money.
    const cash = claimsAllCash(draft.reply);
    if (cash) flags.push(`the draft says "${cash}" — we buy with a hard money loan, not all cash`);
    // Showing our work names the costs; what's left is never given a figure.
    const margin = namesHidden(draft.reply, hiddenAmounts);
    if (margin.length) flags.push(`the draft puts a figure on our profit and risk (about ${Math.round(margin[0] / 1000)}K) — show the costs, never what's left`);
    // A range we floated is topped by our number; its bottom is never an
    // offer on its own (2026-10-07). Said inside a range it's fine.
    const lowsHere = rangeLows(draft.reply);
    for (const r of (ranges || []).filter((x) => Number(x?.low) > 0)) {
      const named = [...moneyIn(draft.reply), ...shorthandPrices(draft.reply, Number(r.high) || 0)].some((n) => Math.abs(n - r.low) < 1000);
      if (named && !lowsHere.some((x) => Math.abs(x.low - r.low) < 1000)) {
        flags.push(`the draft names ${Math.round(r.low / 1000)}K on its own — the bottom of the range we floated is never an offer`);
      }
    }
  }
  // What the house is like to get into. Rajesh Kasturi, 2026-09-29: "it's
  // open right now" went to a buyer about a house nobody had said was open.
  // Only the deal's access record knows (shared/deal-access.js), and the
  // prompt is told what it says; this holds the text when the model says
  // more than that.
  if (party === "investor") {
    const claim = claimsAccess(draft.reply, { vacantOk });
    if (claim) flags.push(`the draft says "${claim}" — only the deal's access record says whether a house is open, vacant or how to get in`);
    // "heavy rehab" on 3511 NE 153rd St (2026-09-29) was nobody's word.
    const word = houseWordsIn(draft.reply, { allowed: houseWords });
    if (word) flags.push(`the draft calls the house "${word}" — the deal doesn't say that; describe it only in the deal's own words and numbers`);
  }
  // The two rules that are not judgment calls. A number the other side must
  // never hear — our contract price, our fee — is flagged even if they said
  // it first. And a number that is in neither the record book nor their own
  // message was made up, which is the worst thing this could do.
  // "at 650" is a price too (shorthandPrices) — Jesse, 2026-09-25.
  const ours = Math.max(0, Math.round(Number(ourAmount) || 0));
  const said = [...new Set([...moneyIn(draft.reply), ...shorthandPrices(draft.reply, ours)])];
  const forbidden = new Set(forbiddenAmounts.map((n) => Math.round(n)));
  const leaked = said.filter((n) => forbidden.has(n));
  if (leaked.length) {
    flags.push(`the draft names ${[...new Set(leaked)].map((n) => fmtMoney(n)).join(", ")}, which is our contract price or assignment fee`);
  }
  // The book's old number after we came down from it (Kimberly Pettie,
  // 2026-09-18: "still good, 71k" three days after Matt texted 65k). Rounded
  // the way people text it counts too — "71k" for 71,075.
  const stale = new Set(staleAmounts.map((n) => Math.round(n)));
  const backTo = said.filter((n) => stale.has(n) || roundsFromBook(n, stale));
  if (backTo.length) {
    flags.push(`the draft names ${[...new Set(backTo)].map((n) => fmtMoney(n)).join(", ")}, which we already came down from in the thread`);
  }
  // Their shorthand counts as theirs the way ours counts as ours: "$650 is
  // their bottom" is 650K, and echoing it is not inventing it.
  const theirShort = [
    ...shorthandPrices(inboundMessage, ours),
    ...moneyIn(inboundMessage).filter((n) => n >= 10 && n < 10000).map((n) => n * 1000),
  ];
  const allowed = new Set([...allowedAmounts, ...moneyIn(inboundMessage), ...theirShort].map((n) => Math.round(n)));
  const invented = said.filter((n) => !allowed.has(n) && !forbidden.has(n) && !stale.has(n) && !roundsFromBook(n, allowed) && !roundsFromBook(n, stale));
  if (invented.length) {
    flags.push(`the draft names ${[...new Set(invented)].map((n) => fmtMoney(n)).join(", ")}, which is not in the ${party === "investor" ? "deal book" : "offer book"}`);
  }
  // More than our number, on the house, in our words. That the agent typed
  // it first makes it allowed to echo, not ours to agree to: "that scope is
  // workable for us at 650" on a 550K offer went out as a deal_available
  // (Jesse, 2026-09-25). Paying more is the counter band's arithmetic
  // or a person's call, never the model's. A counter is left clean so the
  // band can still weigh it — and a band that says yes rewrites the reply in
  // its own words — but `overOffer` rides on the gate so nothing else (the
  // nightly audit) can release it.
  let overOffer = [];
  if (party === "agent" && ours > 0) {
    const slack = Math.max(1000, ours * 0.005);
    overOffer = pricesWeName(draft.reply, ours).filter((n) => n > ours + slack && !forbidden.has(n));
    if (overOffer.length && draft.intent !== "counter") {
      flags.push(`the draft says ${overOffer.map((n) => fmtMoney(n)).join(", ")}, above our ${fmtMoney(ours)} offer — only the counter band or a person agrees to more`);
    }
  }
  // Their value under ours is never argued up (2026-10-16, Shoreline: "650–
  // 680 fixed up" answered with "we're actually seeing comps closer to 842k
  // fixed up", and he agreed with our number). Once they've said what it's
  // worth, a value we name above that holds — and so does our own ARV said
  // back without a value word. Before they've said, floating ours to get
  // theirs is the take check, and stands. Their own figures may be echoed.
  const theirs = party === "agent" ? Math.max(0, Math.round(Number(theirValue) || 0)) : 0;
  if (theirs > 0) {
    const echo = new Set([...moneyIn(inboundMessage), ...shorthandPrices(inboundMessage, theirs)].map((n) => Math.round(n)));
    const ourArv = Math.max(0, Math.round(Number(ourValue) || 0));
    const above = (n) => n > theirs * 1.05 && !echo.has(n);
    const named = [...new Set([
      ...valuesWeName(draft.reply, theirs),
      ...(ourArv > theirs * 1.05 ? said.filter((n) => Math.abs(n - ourArv) <= ourArv * 0.02) : []),
    ])].filter(above);
    if (named.length) {
      flags.push(`the draft says ${named.map((n) => fmtMoney(n)).join(", ")} for what it's worth fixed up — they said ${fmtMoney(theirs)}; ` +
        "when their value is under ours we price on theirs, never argue it up");
    }
  }
  // `ok` is the row's word — a counter is not auto-sendable, full stop. But
  // the lock is the ONE flag a guard may overturn, so it is named apart from
  // the rest: `clean` says every OTHER gate passed. decideAutoSend lets a
  // locked-but-clean draft fall through to the never_auto code, which is the
  // only code releaseUnderGuard will open. Without this the band and the
  // calendar could never release anything — the lock tripped "gates" first.
  const locked = flags.find((f) => / is a person's call$/.test(f)) || null;
  return { ok: flags.length === 0, flags, locked, clean: flags.filter((f) => f !== locked).length === 0, overOffer };
}

// Why a held draft waits, in words: "a counter is a person's call". The
// catch-all intent reads "a reply the bot couldn't place", not "a other"
// (Jeffrey Valcik's row, 2026-09-29).
export function personsCall(intent = "") {
  const what = String(intent || "").replace(/_/g, " ");
  if (!what || what === "other") return "a reply the bot couldn't place is a person's call";
  return `${/^[aeiou]/i.test(what) ? "an" : "a"} ${what} is a person's call`;
}

/**
 * redraftOnGate({ draft, gate, gateFor, config, redraft }) → { draft, gate }
 *
 * A reply a content gate caught is written once more, with what caught it
 * fed back as corrections. Only the fixable kind: words and numbers in the
 * reply. A draft the model itself sent to a person (needsHuman), wasn't sure
 * of, or left empty is a person's whatever it says, and costs no second call.
 * Neither does one held only by its intent's lock ("a counter is a person's
 * call"). The rewrite is judged by the same gates, unchanged; only its words
 * are taken — the intent, address and numbers read off their text stay the
 * first read's. Still caught: the first draft and its reasons stand.
 */
export async function redraftOnGate({ draft, gate, gateFor, config = null, redraft }) {
  if (!draft || !gate || typeof redraft !== "function" || typeof gateFor !== "function") return { draft, gate };
  if (gate.ok || (gate.locked && gate.clean)) return { draft, gate };
  const minConfidence = config?.autoSend?.minConfidence || "high";
  // The model's own "a person should see this" is never argued with by a
  // second draft, whether or not the page holds on it.
  if (draft.needsHuman) return { draft, gate };
  if ((CONFIDENCE_RANK[draft.confidence] ?? 0) < (CONFIDENCE_RANK[minConfidence] ?? 2)) return { draft, gate };
  if (!String(draft.reply || "").trim() || RELEASE_QUIET.has(draft.intent)) return { draft, gate };
  const tripped = (gate.flags || []).filter((f) => f !== gate.locked);
  if (!tripped.length) return { draft, gate };
  const again = await Promise.resolve().then(() => redraft(tripped)).catch(() => null);
  if (!String(again?.reply || "").trim()) return { draft: { ...draft, redraftHeld: { for: tripped, flags: ["the redraft came back empty"] } }, gate };
  const next = { ...draft, reply: again.reply, redraftedFor: tripped, replyBeforeRedraft: draft.reply };
  const g2 = gateFor(next);
  if (g2.ok || (g2.locked && g2.clean)) return { draft: next, gate: g2 };
  return { draft: { ...draft, redraftHeld: { for: tripped, flags: (g2.flags || []).filter((f) => f !== g2.locked).slice(0, 6) } }, gate };
}

// Why a person has the thread, in the words the outbox and the job show.
export function humanActiveLine(h) {
  const n = h?.minutesAgo ?? 0;
  const ago = `${n} minute${n === 1 ? "" : "s"} ago`;
  return h?.by === "call" ? `you called them ${ago} — you have the thread` : `you replied to them ${ago} — you have the thread`;
}

/**
 * decideAutoSend({ gate, party, intent, channel, config, sendsEnabled, humanActive, hold })
 *
 * The page's switches, on top of the gates. Returns { send, reason } with the
 * FIRST reason it won't, in the operator's words — that line is stored on the
 * draft and shown on the row, so "why didn't it send itself?" is answered
 * before it is asked.
 */
export function decideAutoSend({ gate, party = "agent", intent = "other", channel = "sms", config, sendsEnabled = false, humanActive = null, hold = null }) {
  // You stopped the bot on them (shared/bot-hold.js): their text gets a
  // draft, and the draft waits for you. First, so nothing below — the gates
  // passing, a guard, the audit — reads as "it could have gone".
  if (hold?.held) return { send: false, code: "bot_stopped", reason: `${holdLine(hold)} — it waits for you` };
  if (!gate?.ok && !(gate?.locked && gate?.clean)) return { send: false, code: "gates", reason: gate?.flags?.[0] ? `needs a person: ${gate.flags[0]}` : "the gates did not pass" };
  if (!config?.enabled) return { send: false, code: "bot_off", reason: "Conversation AI is switched off" };
  if (humanActive) return { send: false, code: "human_active", reason: humanActiveLine(humanActive) };
  if (!sendsEnabled) return { send: false, code: "sends_off", reason: "sends are off on the broker (CARD_SENDS_ENABLED)" };
  const playbook = config.parties?.[party];
  if (!playbook) return { send: false, code: "unknown_party", reason: "an unknown contact never auto-sends" };
  if (!playbook.autoSend?.enabled) return { send: false, code: "party_off", reason: `auto-send is off for ${PARTY_LABEL[party].toLowerCase()}s` };
  // The one refusal the counter band may overturn — and the ONLY one. The
  // code is what releaseUnderGuard keys on, so a draft held for any other
  // reason can never be released by a guard passing.
  if ((NEVER_AUTO[party] || []).includes(intent)) return { send: false, code: "never_auto", reason: personsCall(intent) };
  // The pass note's own switch is its place on the list (pass-note.js).
  const listed = (playbook.autoSend.intents || []).includes(intent) || (intent === "pass_note" && playbook.passNote?.enabled);
  if (!listed) return { send: false, code: "not_allowlisted", reason: `${intent.replace(/_/g, " ")} is not on the ${party} auto-send list` };
  if (!(config.autoSend?.channels || []).includes(channel)) return { send: false, code: "channel", reason: `${channel} replies don't auto-send` };
  return { send: true, code: "", reason: "" };
}

// Why a reply didn't send itself, split two ways. These four mean THIS thread
// is waiting on a person — the gates caught something, the intent is a
// person's call, the band didn't open, the intent isn't on the list — and a
// person who never gets to it leaves the agent with silence, so the check-in
// clock starts (see 4c‴ in runReply).
//
// The rest are states of the SETUP, not of the thread: the bot is off, sends
// are off on the broker, auto-send is off for this party, the channel doesn't
// send, we don't know who they are. Nothing is automated in any of those, an
// operator is working the outbox by hand, and a clock we set would be a text
// they never asked us to send. `human_active` is the clearest of all: a person
// has the thread right now. So is `bot_stopped`: you stopped the bot on them,
// and a check-in clock, a kept-scheduled reply or an audit release would each
// be the machine texting them anyway.
export const HELD_FOR_A_PERSON = new Set(["gates", "never_auto", "guard_failed", "not_allowlisted", "stale_number", "in_range"]);

// The nightly audit's loosening (Matt, 2026-09-16: "fire where it can"). A
// draft the money guard passed, that the model didn't flag for a person,
// held only because its intent is a person's call or off the list or the
// band's arithmetic didn't open — the reply itself is a holding reply that
// commits to nothing, and silence is worse. Released, and said so on the
// row. The gates are never released: `code === "gates"` stays held.
// `partner_answer` is the owner's own words (partner-answer.js): it leaves on
// his Send and no other way.
export const RELEASE_QUIET = new Set(["opt_out", "small_talk", "media", "partner_answer"]);
export function releaseForAudit({ auto, gate, draft, deps }) {
  if (!deps?.releaseHeld || auto?.send) return auto;
  // A paper hold (stale_number) and their number inside our range (in_range)
  // are number questions, like the gates: never released as "a holding reply".
  if (!HELD_FOR_A_PERSON.has(auto?.code) || ["gates", "stale_number", "in_range"].includes(auto.code)) return auto;
  // A counter that names more than our number is never "a holding reply".
  if (gate?.overOffer?.length) return auto;
  // "Locked but clean" is how the gates report a never-auto intent whose
  // reply passed every money check — the shape decideAutoSend itself accepts.
  const clean = Boolean(gate?.ok || (gate?.locked && gate?.clean));
  if (!clean || draft?.needsHuman || RELEASE_QUIET.has(draft?.intent) || !String(draft?.reply || "").trim()) return auto;
  // By day (the daytime pass's redraft) a person's call waits for a person —
  // the same rule releasableHeld keeps for its own releases. The one
  // exception is an agent's reply the bot couldn't place, when
  // driver.daytime.releaseOther is on (Matt, 2026-10-08).
  if (deps.releaseByDay) {
    const party = draft?.party || "agent";
    const otherOk = deps.releaseOther === true && party === "agent" && draft?.intent === "other";
    if ((NEVER_AUTO[party] || NEVER_AUTO.agent).includes(draft?.intent) && !otherOk) return auto;
  }
  return { ...auto, send: true, code: "", reason: deps.releaseReason || "released by the nightly audit — a holding reply, nothing committed", released: true };
}

// An agent's reply the bot couldn't place, sent at once (Matt, 2026-10-18,
// autoSend.otherNow) rather than after the daytime pass's two-hour wait. The
// same release the daytime pass makes — releaseForAudit by day with
// releaseOther — so the gates, the over-our-number check, needsHuman and
// investors hold exactly as they do there. Only a refusal that was
// never_auto and nothing else: the bot stopped, a person on the thread,
// sends off and auto-send off all come first in decideAutoSend.
export function releaseOtherNow({ auto, base, gate, draft, party = "agent", config, channel = "sms", isCall = false }) {
  if (auto?.send || !config?.autoSend?.otherNow || isCall) return auto;
  if (party !== "agent" || draft?.intent !== "other" || base?.code !== "never_auto") return auto;
  if (!(config.autoSend?.channels || []).includes(channel)) return auto;
  return releaseForAudit({ auto, gate, draft, deps: { releaseHeld: true, releaseByDay: true, releaseOther: true,
    releaseReason: "sent at once — a reply the bot couldn't place, every gate clean" } });
}

// What reaches the person (or puts our name on paper) and so waits while you
// have stopped the bot on them: the letter, a dataroom invite, a GHL drip, a
// booking, a re-quote, a counter, an agreed investor price. Bookkeeping —
// tags, an offer's status, an underwrite — still runs.
export const HELD_WHILE_STOPPED = new Set([
  "send_offer", "send_dataroom_invite", "add_to_workflow", "requote_from_agent_numbers", "book_call", "revise_offer_to_counter", "agree_investor_price",
]);

/**
 * holdActionsWhileStopped(plan, why) → { plan, held }
 * The plan's automatic actions that reach them become suggestions ("ask"),
 * each saying why, for a person to press on the draft.
 */
export function holdActionsWhileStopped(plan, why) {
  const auto = plan?.auto || [];
  const held = auto.filter((x) => HELD_WHILE_STOPPED.has(x.type))
    .map((x) => ({ ...x, mode: "ask", why: `${x.why ? `${x.why} — ` : ""}held: ${why}` }));
  if (!held.length) return { plan, held: [] };
  return { plan: { ...plan, auto: auto.filter((x) => !HELD_WHILE_STOPPED.has(x.type)), suggested: [...(plan.suggested || []), ...held] }, held };
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
  // Two bands, and neither borrows from the other: an investor's pushback is
  // released only by the investor band's own verdict under its own switch,
  // and an agent's counter never by the investor's.
  const investorBand = party === "investor" && intent === "price_pushback";
  if (family === "band" && investorBand !== (guard.kind === "investor_band")) return { ...base, exception: null };
  const on = family === "booking" ? config?.booking?.enabled
    : investorBand ? config?.parties?.investor?.priceBand?.enabled
      : config?.parties?.[party]?.counterBand?.enabled;
  if (!on) return { ...base, exception: null };
  if (!guard.passed) {
    return { send: false, code: "guard_failed", reason: `needs a person: ${guard.reason || (family === "booking" ? "the calendar did not open" : "the band did not open")}`, exception: guard };
  }
  if (investorBand) {
    return { send: true, code: "released", exception: guard,
      reason: `released under the investor band — ${fmtMoney(guard.theirAmount)} is their own number, at or above the ${fmtMoney(Math.max(guard.floor || 0, guard.dropLimit || 0))} limit` };
  }
  return {
    send: true, code: "released",
    reason: family === "booking"
      ? `released under the calendar — ${guard.reason}`
      : guard.kind === "acceptance_band"
        ? "released under the acceptance band — they took our number and named no new one"
      : guard.counterBack
        ? `released under the counter band — ${fmtMoney(guard.theirAmount)} is just over the ${fmtMoney(guard.ceiling)} ceiling, countering back at it`
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
export async function bandReleasesToday({ store, locationId, now = Date.now(), kind = null }) {
  const d = new Date(now);
  const dayStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
  // Every draft of the day: a blast day writes hundreds, and a release from
  // the morning must still count against the band's cap in the evening.
  const rows = await store.listReplyDrafts(locationId, { since: dayStart, limit: 5000 }).catch(() => []);
  // The investor band keeps its own daily count; the agent's count is
  // everything else, as it always was.
  return rows.filter((r) => r?.exception?.passed && (kind ? r.exception.kind === kind : r.exception.kind !== "investor_band")).length;
}

/**
 * evaluateInvestorBandFor({ store, locationId, draft, config, saved, job, now }) → verdict | null
 *
 * The investor's side (shared/auto-accept.js evaluateInvestorBand). The deal
 * is one this buyer is already on, or the one their message names; the asking
 * price is the one they have been quoted (the dataroom's headline when there
 * is one). Null when the band is off, so the ordinary path reads nothing.
 */
export async function evaluateInvestorBandFor({ store, locationId, draft, config, saved, job, now = Date.now() }) {
  const band = config?.parties?.investor?.priceBand;
  if (!band?.enabled || draft?.intent !== "price_pushback") return null;
  const deals = (await (store.listDeals ? store.listDeals(locationId, { limit: 100 }) : Promise.resolve([])).catch(() => []))
    .filter((o) => INVESTOR_DEAL_STAGES.has(o?.deal?.stage));
  const mine = deals.filter((o) => (o.deal.investors || []).some((i) => i.contactId === job.contactId));
  const named = draft.propertyAddress ? deals.find((o) => sameStreet(o.address, draft.propertyAddress)) || null : null;
  const offer = named || (mine.length === 1 ? mine[0] : null);
  let asking = 0;
  if (offer) {
    const link = (offer.deal.investors || []).find((i) => i.contactId === job.contactId) || null;
    let room = null;
    try {
      const rooms = await store.listDatarooms(locationId, { offerId: offer.id, limit: 5 });
      room = rooms.find((r) => r.status === "active" && r.kind !== "portfolio" && r.kind !== "offer") || null;
    } catch { room = null; }
    asking = Number(link?.agreedPrice?.amount) || investorFacingPrice({ offer, room, settings: saved || {} }).price;
  }
  const releasedToday = await bandReleasesToday({ store, locationId, now, kind: "investor_band" });
  return evaluateInvestorBand({
    offer, asking, contactId: job.contactId, liveDeals: named ? [named] : mine, draft, inboundMessage: job.message || "",
    band, releasedToday, now, moneyIn,
  });
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
export async function evaluateBandFor({ store, locationId, party, draft, config, saved, job, now = Date.now(), transcript = "" }) {
  if (party === "investor" && draft?.intent === "price_pushback") return evaluateInvestorBandFor({ store, locationId, draft, config, saved, job, now });
  const band = config?.parties?.[party]?.counterBand;
  if (!band?.enabled) return null;
  if (!(GUARDED_AUTO[party] || []).includes(draft?.intent)) return null;

  const rows = await store.listOffers(locationId, { contactId: job.contactId, limit: 50, lean: true }).catch(() => []);
  // Open, or dead on their side and revived by this counter (isNegotiable):
  // the passed-offer check-in asked for exactly this answer. An offer we
  // walked from stays closed.
  // The current offer on each house only (shared/current-offer.js): a band
  // measured from a row the house has moved past answers the wrong number.
  const open = currentOffers(rows).filter(isNegotiable);
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
  // "Their own words" has to read the message the way the counter above it
  // did. moneyIn refuses a bare integer, so a counter typed short ("go to
  // 670") failed the check as "not in their message" and the band never got
  // as far as the arithmetic — see counterDollars. Same number, same rule,
  // both places; an acceptance that names one is still a counter, which is
  // what that check is for.
  const saidMoney = moneySaidAgainst(job.message || "", full?.cashAmount);
  const args = { offer: full, draft, inboundMessage: job.message || "", settings: saved || {},
                 band, openOffers: open, releasedToday, now, moneyIn: saidMoney,
                 // A higher number we texted that the offer never moved to
                 // disagrees with the book just as much: "yes" to it is not
                 // a yes to the book (Jesse, 2026-09-25).
                 comeDown: full ? (ourComeDown(full, transcript) || ourMoveUp(full, transcript)) : null };
  return draft.intent === "acceptance" ? evaluateAcceptance(args) : evaluateCounterBand(args);
}

// Every figure they typed, read the way the counter band reads it: amounts
// that look like money, plus a counter typed short ("go to 670") scaled
// against our number. One reader for the band and for a recorded yes.
function moneySaidAgainst(message = "", reference = 0) {
  const shorthand = counterDollars(0, { message, reference: Math.round(Number(reference) || 0) });
  return (t) => {
    const out = moneyIn(t);
    return shorthand > 0 && !out.includes(shorthand) ? [...out, shorthand] : out;
  };
}

// Our number on the house a draft is about, from the offer book — the most
// the reply may say we'd pay. A named house the book doesn't have has no
// number of ours (a made-up one is still caught as not in the book); no house
// named, the highest of ours.
export function ourNumberFor(numbers = [], address = "") {
  const list = (numbers || []).filter((n) => n && Number(n.amount) > 0);
  if (!list.length) return 0;
  if (address) {
    const named = list.find((n) => sameStreet(n.address, address));
    return named ? Math.round(named.amount) : 0;
  }
  return Math.round(Math.max(...list.map((n) => n.amount)));
}

// Our value fixed up on the house a draft is about, from the same book.
export function ourValueFor(numbers = [], address = "") {
  const list = (numbers || []).filter((n) => n && Number(n.arv) > 0);
  if (!list.length) return 0;
  if (address) {
    const named = list.find((n) => sameStreet(n.address, address));
    return named ? Math.round(named.arv) : 0;
  }
  return list.length === 1 ? Math.round(list[0].arv) : 0;
}

/**
 * theirValueFor({ draft, message, events, address }) → dollars
 *
 * What the agent told us the house is worth fixed up: this message's take
 * first (the model's read, else the shorthand backstop), then the latest on
 * their timeline for the house. 0 when they haven't said.
 */
export function theirValueFor({ draft = null, message = "", events = [], address = "" } = {}) {
  const take = draft?.agentTake ?? normalizeAgentTake(draft) ?? (message ? agentTakeFromText(message) : null);
  if (Number(take?.arv) > 0) return Math.round(take.arv);
  const dossier = address && events?.length ? propertyDossier(events, address) : null;
  return Math.round(Number(dossier?.have?.arv?.value) || 0);
}

/**
 * writeUpOkFor(numbers, address) → boolean
 *
 * May a draft ask them to write it up (NWMLS, represent us) on this house?
 * Only at a number Matt approved (shared/offer-status.js numberApproved,
 * 2026-10-15). `numbers` is the offer book's [{ address, amount, approved }].
 * A house we have no number on is not this gate's business; with no house
 * named, it's fine while any house in the book is approved.
 */
export function writeUpOkFor(numbers = [], address = "") {
  const list = (numbers || []).filter((n) => n && Number(n.amount) > 0);
  if (!list.length) return true;
  if (address) {
    const named = list.find((n) => sameStreet(n.address, address));
    return !named || named.approved !== false;
  }
  return list.some((n) => n.approved !== false);
}
// A write-up ask: NWMLS, "write it up", or "represent us" beside an offer
// or a price. "We'd love to have you represent us on the buy" is not one.
const WRITE_UP_ASK_RX = /\bnwmls\b|\bwrite (?:it|this|that|one) up\b|\bwrite up (?:an? |the |our )?offer\b/i;
const REPRESENT_ASK_RX = /\brepresent us\b/i;
const OFFER_OR_PRICE_RX = /\boffer\b|\$?\d{2,3}(?:,\d{3}|\s?k)\b/i;
const NOT_AGENTS_RX = /\bnot (?:an? |licensed )?(?:agents?|realtors?)\b|\b(?:don'?t|do not) have (?:an? |our own )?(?:agent|realtor)\b|\bno agent\b/i;
export const asksWriteUp = (reply = "") => {
  const t = String(reply || "");
  return WRITE_UP_ASK_RX.test(t) || (REPRESENT_ASK_RX.test(t) && OFFER_OR_PRICE_RX.test(t));
};

// Do we already have this house in the agent's book? A live or recent offer
// (60 days) or a held draft someone is still reviewing (7 days) counts; an old
// one doesn't — a house that comes back months later deserves fresh numbers.
// A counter more than this far above the higher of our offer and the ceiling
// is their pass, not a negotiation (see the counter reclassify in runReply).
// The same margin the band counters back inside — one number, one place.
export const COUNTER_PASS_MARGIN = COUNTER_MARGIN;
// Over this much past the most we'd pay, a softly-put floor is still a pass:
// a gap a re-quote on their numbers could never close. Under it, one round.
export const WALK_AWAY_GAP = 0.25;
// Their floor is the list price, said in words rather than digits.
export function listPriceFloor(message = "") {
  return /\b(?:(?:current|the|full|at|our|their|his|her)\s+)?(?:list|listing|asking)\s+price\b|\bfull\s+price\b|\bat\s+asking\b|\bnothing\s+(?:below|under|less\s+than)\s+(?:list|asking)\b/i.test(String(message || ""));
}
const KNOWN_OFFER_DAYS = 60;
const KNOWN_DRAFT_DAYS = 7;
// A draft waiting on Matt's number (draft only, a skeleton) is in hand as
// long as an offer is: the same house named again a week on was a second
// skeleton for him to price (2026-10-22 audit). Any spelling of it counts
// (sameRaisedHouse: "12 SE Oak-Hill Lp" is "12 Se Oak Hill Loop").
export function knownOfferFor(rows = [], address = "", now = Date.now()) {
  const key = addressKey(address);
  if (!key) return null;
  return rows.find((o) => {
    if (!o?.address || (addressKey(o.address) !== key && !sameRaisedHouse(o.address, address))) return false;
    const ts = Date.parse(o.updatedAt || o.createdAt || "");
    if (!Number.isFinite(ts)) return true;
    const days = (now - ts) / 86400000;
    const waitsOnMatt = o.status === "draft" && aiHoldReasons(o).some((h) => DRAFT_ONLY_RX.test(String(h || "")));
    return o.status === "draft" && !waitsOnMatt ? days <= KNOWN_DRAFT_DAYS : days <= KNOWN_OFFER_DAYS;
  }) || null;
}

/**
 * rerunsRoughOffer({ known, book, events }) → boolean
 *
 * A rough first pass (isRoughNumber) is a number we said was rough: once the
 * agent tells us more about the house — their value, their repairs, the
 * work — the underwrite runs again on it, the way a held draft does. Only
 * while it is still the house's current offer (a re-run already landed
 * otherwise) and nothing went out on paper (then it is a person's to re-price).
 */
export function rerunsRoughOffer({ known = null, book = [], events = [] } = {}) {
  if (!known || !isRoughNumber(known) || paperWent(known) || known.deal) return false;
  const current = currentOfferFor(book, known);
  if (current && current.id !== known.id) return false;
  const since = Date.parse(known.updatedAt || known.createdAt || "") || 0;
  return (events || []).some((e) => ["agent_estimate", "property_details"].includes(e?.type)
    && e.address && (propertyKey(e.address) === propertyKey(known.address || "") || sameHouse(e.address, known.address || ""))
    && (Date.parse(e.at || "") || 0) > since);
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

/**
 * yesAfterOurPass({ offers, drafts, events, draft, message, now }) → { offerId, address, amount, passedAt, at } | null
 *
 * Their yes to our number landed on a house we had marked we passed (the
 * funnel review, 2026-10-15: the seller took our 261k four hours after we
 * passed, and the bot answered "We've actually moved on"). The house they named,
 * or with no house named and nothing open, the newest one we walked from in
 * the last month. Only a house we put a number to: one we passed on before
 * pricing it reopens on their numbers (held-underwrites.js) and the book
 * already says so.
 *
 * This text's yes, or an earlier one since the pass that nobody has answered
 * yet: their "did you get my text?" after it is still waiting on that yes,
 * and the bot, told we walked away, would answer it with a goodbye.
 */
export function yesAfterOurPass({ offers = [], drafts = [], events = [], draft = {}, message = "", now = Date.now() } = {}) {
  const walked = currentOffers(offers || []).filter((o) => offerStatus(o) === "we_passed" && Number(o.cashAmount) > 0 && !o.deal);
  if (!walked.length) return null;
  let picked = draft.propertyAddress ? pickOfferByAddress(walked, draft.propertyAddress) : null;
  if (!picked) {
    const open = currentOffers(offers || []).filter(isNegotiable);
    if (draft.propertyAddress && pickOfferByAddress(open, draft.propertyAddress)) return null;
    if (open.length) return null;
    const passedAt = (o) => Date.parse(o.statusAt || "") || 0;
    picked = [...walked].sort((x, y) => passedAt(y) - passedAt(x))[0];
    if (now - passedAt(picked) > YES_WINDOW_DAYS * 86400000) return null;
  }
  const ours = Math.round(Number(picked.cashAmount) || 0);
  const found = { offerId: picked.id, address: picked.address || "", amount: ours, passedAt: picked.statusAt || null };
  const yesNow = (["acceptance", "realm_yes"].includes(draft.intent) && !draft.inRange && !(Number(draft.counterAmount) > 0)) || saysYes(message, ours);
  if (yesNow) return { ...found, at: new Date(now).toISOString() };
  const before = saidYes({ offers: [picked], drafts, events, address: picked.address, since: picked.statusAt, now });
  if (!before) return null;
  // Answered since: a person sent something after it (the bot's own replies
  // to it are held, so a sent one is somebody's Send) or typed one on Today.
  const after = (t) => (Date.parse(t || "") || 0) > Date.parse(before.at);
  const answered = (drafts || []).some((d) => d?.status === "sent" && after(d.sentAt || d.updatedAt || d.createdAt))
    || (events || []).some((e) => e?.type === "hand_reply" && after(e.at));
  return answered ? null : { ...found, at: before.at };
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
export async function applyProfileUpdates({ client, locationId, contactId, party, profile, custom = {}, summary = "", subjectProperty = "", config, now = Date.now(), warnings = [], store = null, draftId = null, intent = "", inbound = "", notOurKind = false, qualifying = "" }) {
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
    // An agent who thinks like an investor (a finder's fee, assigning, their
    // own rentals, offering to represent us): once per agent, read by the
    // check-in and the Desk (shared/lead-source.js investorMindedCue).
    const minded = type === "agent" ? investorMindedCue(inbound) : "";
    if (minded) events.push({ type: "investor_minded", at, source: "conversation", ref, dedupeKey: `investor_minded:${contactId}`, data: { cue: minded } });
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
      if (store && draftId) await recordEvent({ store, locationId, contactId, party: "agent", type: "subject_property_set", at: new Date(now).toISOString(), address: aim, source: "conversation", ref: draftId, data: { from: cur("subject_property"), ...(notOurKind ? { notOurKind: true } : {}), ...(qualifying ? { qualifying } : {}) } });
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
/**
 * theirLatestWords(transcript, message) → string
 *
 * Everything they've said since our last text, this message included, one
 * line each. A burst is one answer: "move in ready… certainly not a fix n
 * flip", then "You should come take a look!" a minute later (Ryan Bowen,
 * 2026-10-05) is one agent saying one thing, though each text gets its own
 * reply job. The transcript is oldest first.
 */
export function theirLatestWords(transcript = "", message = "") {
  let since = [];
  for (const line of String(transcript || "").split("\n")) {
    const m = /^\[[^\]]*\]\s+(US|THEM)\b[^:]*:\s?(.*)$/.exec(line);
    if (!m) continue;
    if (m[1] === "US") since = [];
    else if (m[2].trim()) since.push(m[2].trim());
  }
  const msg = String(message || "").trim();
  if (msg && !since.includes(msg)) since.push(msg);
  return since.join("\n");
}

/**
 * theirWordsSince(transcript, sinceMs, message) → their lines from `sinceMs`
 * on, this message included: everything they've told us about the house
 * since our first text, read as one answer.
 */
export function theirWordsSince(transcript = "", sinceMs = 0, message = "") {
  const out = [];
  for (const line of String(transcript || "").split("\n")) {
    const m = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\]\s+THEM\b[^:]*:\s?(.*)$/.exec(line);
    if (!m || !m[3].trim()) continue;
    const ts = Date.parse(`${m[1]}T${m[2]}:00Z`);
    if (Number.isFinite(ts) && ts + 60000 < sinceMs) continue;
    out.push(m[3].trim());
  }
  const msg = String(message || "").trim();
  if (msg && !out.includes(msg)) out.push(msg);
  return out.join("\n");
}

/**
 * icebreakerHouse(events) → { address, at } | null
 *
 * The newest listing of theirs we opened with: the app's outreach_sent, the
 * GHL workflow's outreach_enrolled for the cohort it texted, or a check-in
 * about a fresh listing of theirs (agent_pulse_texted with its listingKey).
 * A check-in listing is the same icebreaker as the first text's (Matt,
 * 2026-10-14: Dana F.'s "needs a refresh" on Welfare Ave ran Tier 1
 * and an underwrite while the reply passed on it).
 */
export function icebreakerHouse(events = []) {
  const e = (events || [])
    .filter((x) => x?.address && (x.type === "outreach_sent"
      || (x.type === "outreach_enrolled" && x.data?.kind !== "followup")
      || (x.type === "agent_pulse_texted" && (x.data?.listingKey || x.data?.reason === "fresh_listing"))))
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))[0];
  return e ? { address: e.address, at: Date.parse(e.at || "") || 0 } : null;
}

// The first-text house for a contact, off their timeline.
export async function firstTextHouse(store, locationId, contactId) {
  const evs = (await store.listContactEvents?.(locationId, contactId, { types: ["outreach_sent", "outreach_enrolled", "agent_pulse_texted"], limit: 50 }).catch(() => [])) || [];
  return icebreakerHouse(evs);
}

// What the model is told on their first answer (shared/flip-read.js FIXERS_CALL_ASKS).
const CALL_ASK_LINE =
  "FIRST ANSWER: this is their first answer to our first text. Close with ONE question that asks for both other fixers and a " +
  "quick call, in your words or these: \"If you've got other fixers on your radar, I'd love a quick 5-minute call this week, what " +
  "time works?\" Never name a day or a time (there's no calendar: they pick), and ask nothing else in the same text. Leave it out " +
  "if they brought up a house of their own (that house is the lead) or don't want to hear from us.";
// The same, without the call (parties.agent.callAsk off): the first text
// carries no other-fixers line, so their first answer always asks for one.
const FIXERS_ASK_LINE =
  "FIRST ANSWER: this is their first answer to our first text. Close with ONE question asking whether they have other " +
  "fixers on their radar, on or off-market, in your words or these: \"If you've got other fixers on your radar, on or " +
  "off-market, I'm all ears.\" Ask nothing else in the same text. Leave it out if they brought up a house of their own " +
  "(that house is the lead) or don't want to hear from us.";
// Replies the call ask never rides on: the conversation turned, or a person has it.
const CALL_ASK_SKIP_INTENTS = new Set(["counter", "acceptance", "realm_yes", "rejection", "proof_of_funds", "opt_out", "wants_call", "scheduling", "wants_walkthrough", "media"]);

/**
 * callAskFor({ events, transcript, message, ice }) → { first } | null
 *
 * Whether this reply may carry the call ask (shared/flip-read.js
 * FIXERS_CALL_ASKS, 2026-10-15): we texted them first (the app's first text
 * or the GHL workflow's), we've never asked them for a call (call_asked),
 * and they don't sound annoyed. `first`: this is their first answer — no
 * text or call of ours since the first text. Pure; the caller reads the
 * timeline.
 */
export function callAskFor({ events = [], transcript = "", message = "", ice = null } = {}) {
  if ((events || []).some((e) => e?.type === "call_asked")) return null;
  const opener = (events || []).filter((e) => e?.type === "outreach_sent" || (e?.type === "outreach_enrolled" && e.data?.kind !== "followup"))
    .map((e) => Date.parse(e.at || "") || 0).sort((a, b) => b - a)[0];
  if (!opener) return null;
  const words = theirLatestWords(transcript, message);
  if (IRRITATED_RX.test(words) || soundsCrossedUp(words)) return null;
  // Our first text, or a check-in about a fresh listing of theirs since, is the icebreaker either way.
  const since = Math.max(opener, ice?.at || 0);
  const ours = String(transcript || "").split("\n").some((line) => {
    const m = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\]\s+US\b/.exec(line);
    return m && Date.parse(`${m[1]}T${m[2]}:00Z`) > since + 60000;
  });
  return { first: !ours };
}

/**
 * qualifyIcebreaker({ ... }) → null | { stage, address, why, reply }
 *
 * shared/flip-read.js applied to a reply about the house our first text
 * opened with. null when it isn't that house, it's already priced, or the
 * switch is off. Stage "qualified" lets everything run as before; "ask",
 * "pass" and "closed" carry the reply and hold the underwrite.
 */
export async function qualifyIcebreaker({ store, locationId, contactId, draft, message, transcript, now = Date.now(), agentRehab = 0, ice: given, callAsk = false }) {
  const ice = given !== undefined ? given : await firstTextHouse(store, locationId, contactId);
  if (!ice) return null;
  // They named another house of theirs (2026-10-13: a street name and a
  // triplex, no numbers). An empty propertyAddress isn't
  // the first-text house then; those houses are the lead.
  if (housesInText({ houses: draft.houses, message, except: [ice.address] }).length) return null;
  // Same number, same street: a check-in event from before 2026-10-14 holds
  // the street alone, and the model's address may carry the city.
  if (!addressKey(ice.address) || !sameStreet(draft.propertyAddress || ice.address, ice.address)) return null;
  const book = await store.listOffers(locationId, { contactId, limit: 50, lean: true }).catch(() => []);
  if (knownOfferFor(book, ice.address, now)) return null;
  const sent = await store.listReplyDrafts(locationId, { contactId, status: "sent", limit: 30 }).catch(() => []);
  const ours = (stage) => sent.some((d) => d.qualify?.stage === stage && sameStreet(d.qualify.address || "", ice.address));
  const asked = ours("ask") || String(transcript || "").split("\n").some((l) => /^\[[^\]]*\]\s+US\b/.test(l) && QUALIFY_ASK_RX.test(l));
  const passed = ours("pass");
  const step = qualifyStep({ words: theirWordsSince(transcript, ice.at, message), asked, passed, agentRehab, variant: openerVariant(contactId, 3), callAsk });
  return { stage: step.move === "underwrite" ? "qualified" : step.move, address: ice.address, why: step.read.why, reply: step.reply };
}

/**
 * qualifyRehab(take, message) → their rehab number for the screen, or 0
 *
 * The model's read of it, unless the only work figure in their words is
 * work already done: "It had 56k in work done before it was listed"
 * (217 N French Ave, 2026-10-16) is not a 56k rehab budget.
 */
export function qualifyRehab(take, message = "") {
  const r = Math.round(Number(take?.rehab) || 0);
  if (!r) return 0;
  if (agentTakeFromText(message)?.rehab) return r;
  return /\b(?:done|completed|put|spent|invested|sunk|poured)\b/i.test(String(message || "")) ? 0 : r;
}

/**
 * qualifyBrought({ ... }) → null | { stage, address, why, reply }
 *
 * shared/flip-read.js broughtStep applied to a house the agent raised
 * themselves (parties.agent.qualifyFirst.brought, Matt 2026-10-16). null when
 * it isn't one (it's the first-text house, or there's no street address to
 * it), or we already have it: an offer, or a draft that's waiting on Matt.
 */
export async function qualifyBrought({ store, locationId, contactId, draft, message, transcript, now = Date.now(), agentRehab = 0, ice = null, callAsk = false }) {
  const address = String(draft?.propertyAddress || "").trim();
  if (!underwritableAddress(address)) return null;
  if (ice?.address && sameStreet(address, ice.address)) return null;
  const book = await store.listOffers(locationId, { contactId, limit: 50, lean: true }).catch(() => []);
  if (knownOfferFor(book, address, now)) return null;
  const sent = await store.listReplyDrafts(locationId, { contactId, status: "sent", limit: 30 }).catch(() => []);
  const ours = (stage) => sent.filter((d) => d.qualify?.stage === stage && sameStreet(d.qualify.address || "", address));
  const asks = ours("ask");
  const asked = asks.length > 0;
  const passed = ours("pass").length > 0;
  // What they've said about it: the two days before our question (or before
  // now), so their first word on it still counts once they've answered.
  const from = asked ? Math.min(...asks.map((d) => Date.parse(d.sentAt || d.createdAt || "") || now)) : now;
  const words = theirWordsSince(transcript, from - 2 * 86400000, message);
  const step = broughtStep({
    words, asked, passed, agentRehab, callAsk, variant: openerVariant(contactId, 3),
    offMarket: Boolean(offMarketCue(words)), sellerAsk: Number(draft?.propertyDetails?.sellerAsk) || 0,
  });
  return { stage: step.move === "underwrite" ? "qualified" : step.move, address, why: step.read.why, reply: step.reply };
}

// A call is a line too: "[…] US call" bare, or "[…] US call TRANSCRIPT:"
// with the words below it (enrich.js buildTranscript). Kyle R.,
// 2026-10-05: the colon-only match never saw Matt's call, and the bot texted
// three minutes into it.
export function lastOutbound(transcript = "") {
  let found = null;
  for (const line of String(transcript || "").split("\n")) {
    const call = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\] US call(?:$|:| TRANSCRIPT:)/.exec(line);
    if (call) { found = { ts: Date.parse(`${call[1]}T${call[2]}:00Z`), text: "", channel: "call" }; continue; }
    const m = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\] US (\w+): (.*)$/.exec(line);
    if (m) found = { ts: Date.parse(`${m[1]}T${m[2]}:00Z`), text: m[4].trim(), channel: m[3] };
  }
  return found;
}

// A person replied to them recently and it wasn't one of ours going out:
// they have the thread, so the bot drafts but never sends on its own.
// Why the bot stood down, in the words the outbox and the job show.
export const DND_REASON = "they unsubscribed (DND in GHL) — nothing is drafted";
export function handsOffReason(a) {
  if (a?.dnd) return DND_REASON;
  if (a?.botOff?.length) return `bot is off for this contact (tag: ${a.botOff[0]})`;
  // An estate attorney, a title or escrow officer (2026-10-26): a
  // relationship Matt runs himself. The bot never answers one and never
  // starts an agent's or a buyer's text to one; their own sequence is
  // gatekeeper-sweep.js.
  if (a?.gatekeeper) return "a gatekeeper (estate attorney, title or escrow) — yours to answer";
  if (a?.dealHold) {
    return a.dealHold.role === "buyer"
      ? `they are a buyer on your live deal at ${a.dealHold.address} — you are working them yourself`
      : `you have ${a.dealHold.address} under contract with them — the bot stays out of a live deal`;
  }
  return "";
}

// The flag Matt asked for (2026-09-16): an unsubscribed contact wears the
// tag, carries one timeline row, and is never drafted for again. Best-effort
// and idempotent — the dedupe key is the contact.
export async function markUnsubscribed({ client, store, locationId, contactId, party = "agent", now = Date.now() }) {
  if (!contactId) return;
  await addContactTags(client, contactId, [DND_TAG]).catch(() => {});
  await recordEvent({
    store, locationId, contactId, party, type: "unsubscribed", at: new Date(now).toISOString(),
    address: "", source: "ghl", dedupeKey: `unsubscribed:${contactId}`, data: { via: "dnd" },
  }).catch(() => {});
}

// A reply that says an email has gone: "emailed it", "sent it to x@y.com",
// "it went to …@…", "check your inbox". Future tense ("I'll email it") is fine.
export const CLAIMS_EMAIL_RX = /\b(just |already )?e-?mailed\b|\b(sent|went|resent|forwarded)\b[^.?!]{0,60}\b(to\s+\S+@\S+|by e-?mail|via e-?mail|to your e-?mail|to your inbox)|\bcheck your (inbox|e-?mail|spam)\b/i;

const EMAIL_RX = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
/**
 * emailRequest(message, transcript) → { to, cc[] } | null
 *
 * An address to send the documents to. From the message itself ("my email is
 * a@b.com, please cc c@d.com" — everything after "cc" is copied); or, when the
 * message only asks after the email ("did you email it?", "nothing yet"), the
 * last addresses THEY gave earlier in the thread.
 */
export function emailRequest(message = "", transcript = "") {
  const split = (text) => {
    const [head, ...tail] = String(text || "").split(/\bcc\b|\bcopy\b/i);
    const to = head.match(EMAIL_RX) || [];
    const cc = tail.join(" ").match(EMAIL_RX) || [];
    if (!to.length && !cc.length) return null;
    const first = (to[0] || cc[0]).replace(/[.,;]+$/, "");
    const rest = [...to.slice(1), ...(to.length ? cc : cc.slice(1))].map((x) => x.replace(/[.,;]+$/, ""));
    return { to: first, cc: [...new Set(rest.filter((x) => x.toLowerCase() !== first.toLowerCase()))].slice(0, 5) };
  };
  const direct = split(message);
  if (direct) return direct;
  const asksAfterIt = /\be-?mail/i.test(message) && /\b(did you|didn'?t|haven'?t|have not|nothing|not (seeing|showing|received|get)|resend|re-send|send it again|where)\b/i.test(message);
  if (!asksAfterIt) return null;
  const theirs = String(transcript || "").split(/\r?\n/).filter((l) => /\bTHEM\b/.test(l) && EMAIL_RX.test(l));
  EMAIL_RX.lastIndex = 0;
  return theirs.length ? split(theirs.at(-1).replace(/^.*?\bTHEM\b[^:]*:/, "")) : null;
}

// What a buyer says back to "want the details?" that gets the link.
const LINK_ON_REPLY_INTENTS = new Set(["interested", "question", "wants_to_buy", "wants_walkthrough", "status_check", "price_pushback"]);
const LINK_OWED_DAYS = 30;

// The newest deal text we sent this buyer without its link, in the last
// month, that no package link has followed since. null when there's none.
// A text that carried two or three deals (outbound.bundle) owes the link for
// the one they're answering about — `prefer`, the house the reply is about —
// else the first one in it.
async function linkOwed({ store, locationId, contactId, now = Date.now(), prefer = "" }) {
  const drafts = await store.listReplyDrafts(locationId, { contactId, limit: 50 }).catch(() => []);
  const blast = drafts
    .filter((d) => d?.status === "sent" && d.blastWithoutLink && d.outbound?.kind === "blast_open"
      && now - Date.parse(d.sentAt || d.updatedAt || "") < LINK_OWED_DAYS * 86400000)
    .sort((x, y) => String(y.sentAt || "").localeCompare(String(x.sentAt || "")))[0];
  if (!blast) return null;
  const sentAt = String(blast.sentAt || "");
  const linkedSince = drafts.some((d) => String(d.updatedAt || d.createdAt || "") > sentAt
    && (d.actions || []).some((x) => x.type === "send_dataroom_invite" && x.status === "done"));
  if (linkedSince) return null;
  const parts = Array.isArray(blast.outbound.bundle) ? blast.outbound.bundle.filter((p) => p?.address) : [];
  const named = parts.length && prefer ? parts.find((p) => sameStreet(p.address, prefer)) : null;
  if (named) return { address: named.address, offerId: named.offerId || null };
  return { address: blast.outbound.address || blast.propertyAddress || "", offerId: blast.outbound.offerId || null };
}

// They'll go find out: "I could ask, and see what…", "let me check with the
// seller", "I'll see what they'd take". A counter-read with no number that
// says this is a status reply (counterHold, 2026-10-04).
export const WILL_ASK_RX = /\b(?:i'?ll|i will|i could|i can|let me|i'?m going to|going to)\s+(?:go\s+)?(?:ask|check|find out|see|talk to|run it by|get back)\b/i;
export const OUR_OFFER_TEXT_RX = /\b(?:here's our (?:written cash offer|letter of intent)|sending our written offer|please find our (?:letter of intent|written (?:cash )?offer)) on\b/i;

/**
 * isOurEcho({ store, locationId, contactId, message }) → boolean
 *
 * Our own words arriving as theirs: an offer letter's email bounced back
 * into the thread, or a text of ours quoted whole. 9520 187th St Ct E
 * (2026-10-04): our letter-of-intent email came in as "their" message; the
 * bot read "could you represent us and write it up" in it, flagged the offer
 * hot ("writing it up") and drafted "having trouble getting that email out".
 */
export async function isOurEcho({ store, locationId, contactId, message }) {
  const text = String(message || "");
  // Our letter's words OPENING the message (after a "Hi Dana,"): a reply
  // that quotes our letter under their own words is theirs.
  const m = OUR_OFFER_TEXT_RX.exec(text);
  if (m && m.index <= 40) return true;
  const norm = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
  const said = norm(text);
  if (said.length < 30) return false;
  const ours = await store.listReplyDrafts(locationId, { contactId, status: "sent", limit: 20 }).catch(() => []);
  return ours.some((d) => { const t = norm(d.sentText || d.reply); return t.length >= 30 && said.startsWith(t.slice(0, 120)); });
}

// A book number said the way a person texts it: "1.144M" for $1,144,500
// (Angela Jaeger, 2026-09-15, held as "not in the offer book"). It counts when
// it is that number rounded at the precision it was said, and never more than
// 1% off, so "1.1M" for 1,144,500 still reads as made up.
export function roundsFromBook(n, allowed) {
  const said = Math.round(Number(n) || 0);
  if (!(said > 0) || said % 1000 !== 0) return false;
  let unit = 1000;
  while (said % (unit * 10) === 0 && unit < 1e9) unit *= 10;
  for (const a of allowed) {
    const book = Math.round(Number(a) || 0);
    if (book > 0 && Math.abs(said - book) <= unit / 2 && Math.abs(said - book) <= book * 0.01) return true;
  }
  return false;
}

// Our first text to an agent about their listing: a reply to it is them
// answering us, not something for a person to decide. The phrase is the GHL
// workflow template's; the app's own first texts are told apart by their
// sent draft (lastLineIsOurFirstText), since no two say the same thing.
export const OUTREACH_OPEN_RX = /\bcame across your listing\b/i;

/**
 * lastLineIsOurFirstText({ store, locationId, contactId, transcript }) → bool
 *
 * The last US line in the thread is our first text: the workflow template's
 * words, or a sent outreach_open draft (GHL may put its stop line on the end
 * of what we sent, so ours is a match when it starts theirs). 2026-10-15: the
 * short first texts mostly don't say "came across your listing".
 */
export async function lastLineIsOurFirstText({ store, locationId, contactId, transcript }) {
  const last = lastOutbound(transcript);
  if (!last) return false;
  if (OUTREACH_OPEN_RX.test(String(last.text || ""))) return true;
  if (!contactId || typeof store?.listReplyDrafts !== "function") return false;
  const ours = await store.listReplyDrafts(locationId, { contactId, status: "sent", limit: 10 }).catch(() => []);
  const norm = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
  const said = norm(last.text);
  return (ours || []).some((d) => {
    if ((d.outbound?.kind || d.intent) !== "outreach_open") return false;
    const t = norm(d.sentText || d.reply);
    return Boolean(t) && (said === t || said.startsWith(t));
  });
}
// The opt-out line every one of Matt's GHL workflow templates ends on.
export const WORKFLOW_FOOTER_RX = /\bno worries if not,? can stop\b/i;
export async function humanHasThread({ store, client = null, locationId, contactId, transcript, minutes = 30, now = Date.now() }) {
  if (!minutes || !contactId) return null;
  const last = lastOutbound(transcript);
  if (!last || !Number.isFinite(last.ts) || now - last.ts > minutes * 60000) return null;
  // A call we placed is a person on the line; no template dials.
  if (last.channel === "call") return { at: new Date(last.ts).toISOString(), minutesAgo: Math.max(0, Math.round((now - last.ts) / 60000)), by: "call" };
  const ours = await store.listReplyDrafts(locationId, { contactId, status: "sent", limit: 10 }).catch(() => []);
  const norm = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
  // GHL may put the stop line on the end of what we sent ("…I'm all ears.
  // No worries if not can stop lmk"), so ours is a match when it starts theirs.
  if (ours.some((d) => { const t = norm(d.sentText || d.reply); return t && (t === norm(last.text) || norm(last.text).startsWith(t)); })) return null;
  // The offer documents' own text (routes/offers.js sendOfferDocs) is the
  // app, not a person: Julie Nutley's thanks was dismissed as "you answered it
  // yourself" because the offer had just gone out ahead of it (2026-09-15).
  if (OUR_OFFER_TEXT_RX.test(String(last.text || ""))) return null;
  // A GHL workflow's template is a machine too. The outreach workflow texts a
  // new agent and the fast ones answer inside the half hour: Paul Redal ("it's
  // all cosmetic"), Brenton Holland and Andre Bohall (2026-09-21) each got
  // silence, held as "you replied to them 6 minutes ago — you have the
  // thread". The first text's own words, or the templates' footer, which no
  // person types.
  if (OUTREACH_OPEN_RX.test(String(last.text || "")) || WORKFLOW_FOOTER_RX.test(String(last.text || ""))) return null;
  // And whatever the template says, GHL knows who sent it. Gina Hasson
  // (2026-09-29) answered the 14-day follow-up ("reached out a couple weeks
  // back…") within two minutes and got silence: no phrase above matched.
  if (client && (await sentByMachine({ client, locationId, contactId, last }))) return null;
  return { at: new Date(last.ts).toISOString(), minutesAgo: Math.max(0, Math.round((now - last.ts) / 60000)) };
}

/**
 * sentByMachine({ client, locationId, contactId, last }) → true when GHL
 * records the transcript's last outbound as sent by a workflow, a bulk send
 * or a campaign rather than a person.
 *
 * A person is a message with a userId, or one sent from the GHL app or the
 * mobile app. The message is matched by its text (the transcript is a
 * string). Unreadable or not found → false: holding is the careful default.
 */
export async function sentByMachine({ client, locationId, contactId, last }) {
  try {
    const norm = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
    const want = norm(last?.text).slice(0, 120);
    if (!want) return false;
    const { conversations } = await searchConversations(client, locationId, { contactId, limit: 3 });
    for (const c of conversations.slice(0, 2)) {
      const { messages } = await listConversationMessages(client, c.id, { limit: 15 });
      const m = messages.find((x) => String(x.direction || "").toLowerCase() === "outbound" && norm(x.body).startsWith(want));
      if (!m) continue;
      const source = String(m.source || "").toLowerCase();
      return !m.userId && !["app", "mobile", "mobile_app"].includes(source) && Boolean(source);
    }
  } catch { /* GHL unreachable: a person may have the thread */ }
  return false;
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
  aiApiKey = "", classify = classifyParty, light = false, gmailSync = gmailBeforeDraft,
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
  // Never placed by their words or our offer book: an attorney who sends a
  // house is still an attorney (handsOffReason holds them for Matt).
  const gatekeeper = !fakeParty && matchTagPatterns(tags, GATEKEEPER_TAG_PATTERNS).length > 0;

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
  // They texted STOP (or were put on DND in GHL): GHL refuses the send, so
  // there is nothing to draft. Read off the contact, never assumed.
  const dnd = smsUnsubscribed(contact);
  // The other hands-off rule, and the one you don't have to remember to set:
  // a property under contract means you're working this person yourself.
  const dealHold = light ? null : await liveDealHold({
    store, locationId, contactId, mode: config.routing.holdOnLiveDeal,
  }).catch(() => null);
  // Stop / Pause on the work pane (shared/bot-hold.js): the bot still drafts
  // for them, and nothing it writes goes by itself. A read that fails holds.
  const hold = light || !contactId ? null : await holdFor({ store, locationId, contactId, now });
  const typed = fakeThread ? renderFakeThread(fakeThread, channel) : "";
  const transcript = [real, typed].filter(Boolean).join("\n");

  // The old "master bot": a contact whose tags say nothing is placed by the
  // words. On a confident read the party's first plain tag is stamped on
  // the contact (as an auto action, recorded on the draft) so the next text
  // is routed by tags like everyone else's.
  if (party === "unknown" && !gatekeeper && config.routing.unknown === "classify" && aiApiKey && !light && String(message || "").trim()) {
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

  // A contact we've written an offer to is an agent, whatever their tags say.
  // Mike Renard (9314 Canyon Rd #54) had a live counter in our book and every
  // text he sent sat as "an unknown contact never auto-sends".
  if (party === "unknown" && !gatekeeper && contactId && !fakeParty && typeof store?.listOffers === "function") {
    const theirs = await store.listOffers(locationId, { contactId, limit: 1, lean: true }).catch(() => []);
    if ((theirs || []).some((o) => o && o.contactId === contactId)) {
      party = "agent";
      partySource = "offer_book";
    }
  }

  const custom = contact && !light ? await loadContactContext({ client, locationId, contact }) : {};

  // What already went by email with them, onto the record before it is read
  // (off unless conversationAi.gmail is on; bounded, never throws).
  if (!light && contactId && config.gmail?.enabled) {
    await gmailSync({ locationId, contactId, emails: contactEmails(contact), saved, store, now, warnings });
  }

  let context = { text: "", amounts: [], forbiddenAmounts: [], summary: {} };
  let underwriting = [];
  if (light) {
    /* an opt-out needs the party and nothing else */
  } else if (party === "agent") {
    context = await loadAgentContext({ store, locationId, contactId, custom, now, showMath: Boolean(config.parties.agent?.showMath), transcript: real, focusKinds: saved?.focusKinds,
      highStakes: config.parties.agent?.realmCheck?.highStakes, mattPrices: underwriteMode(saved) !== "full" });
    // The write-up terms' earnest money is a number the bot may say.
    if (config.writeUp?.earnestMoney) context = { ...context, amounts: [...new Set([...context.amounts, Math.round(config.writeUp.earnestMoney)])] };
    // The post-mortem digest rides along only when the switch is on AND a
    // person saved a digest; the machine never writes one for itself.
    const digestText = config.parties.agent?.lessons?.enabled ? lessonsContextText(saved?.postMortem?.digest) : "";
    if (digestText) context = { ...context, text: [context.text, digestText].filter(Boolean).join("\n\n") };
    underwriting = listUnderwriteJobs(locationId, { contactId })
      .filter((j) => j.status === "running" || j.status === "queued")
      .map((j) => j.address || "a property")
      .slice(0, 3);
  } else if (party === "investor") {
    context = await loadInvestorContext({ store, locationId, contactId, contactName: name, custom, settings: saved || {}, tags, now });
  }
  const humanActive = light ? null : await humanHasThread({
    store, client, locationId, contactId, transcript: real, minutes: config.autoSend?.humanActiveMin, now,
  });

  const playbook = config.parties?.[party] || null;
  const base = playbook ? playbook.instructions : config.routing.genericInstructions;
  // What we buy right now (shared/asset-type.js): single-family only since
  // 2026-10-01, so a condo or a mobile home gets a plain no, not a promise —
  // except a house we chose to price anyway, which is named.
  const instructions = party === "agent" ? [base, AGENT_GOAL_RULE, AGENT_PAPER_RULE, CLARIFY_RULE, AGENT_HONESTY_RULE, PROMISE_RULE, agentFocusRule(saved?.focusKinds, { pricedAnyway: context.pricedOutsideFocus || [] })].filter(Boolean).join("\n")
    : party === "investor" ? [base, CLARIFY_RULE].filter(Boolean).join("\n") : base;
  const signer = config.persona.name || saved?.company?.signer || saved?.company?.name || "";
  // Ours to hand out when asked — an agent who asks "what's your email?" got
  // "I'll text it over shortly" until 2026-09-12, because we never sent it.
  const companyContact = { email: saved?.company?.email || "", phone: saved?.company?.phone || "" };

  // The tag that would route them next time, when the words placed them.
  const stampTag = partySource === "classified" && config.routing.tagOnClassify
    ? (config.routing[party === "investor" ? "investorTags" : "agentTags"] || []).find((t) => !t.includes("*")) || null
    : null;

  return {
    config, party, partySource, matchedTags: resolved.matched, classified, stampTag, botOff, dnd, dealHold, humanActive, hold, gatekeeper,
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
  attachments = 0, inboundKind = "text", call = null, fromCheckIn = false, attachmentUrls = [],
}) {
  const aiApiKey = String(saved?.aiApiKey || "").trim();
  if (!aiApiKey) throw Object.assign(new Error("Anthropic API key required (Settings)"), { http: 400 });
  const nAttachments = Math.max(0, Number(attachments) || 0);
  if (!String(message || "").trim() && !nAttachments) throw Object.assign(new Error("message required"), { http: 400 });
  // Our own words echoed back: nothing to answer, and settled on the record
  // so last night's audit doesn't hand it to you (reply_not_needed).
  if (inboundKind !== "call" && await isOurEcho({ store, locationId, contactId, message })) {
    await recordEvent({ store, locationId, contactId, party: party === "investor" ? "investor" : "agent", type: "reply_not_needed", at: new Date().toISOString(),
      source: "conversation", dedupeKey: `reply_not_needed:echo:${contactId}:${new Date().toISOString().slice(0, 13)}`, data: { intent: "echo" } }).catch(() => {});
    return { skipped: "their message is our own text echoed back — nothing to answer", job: null, echo: true };
  }
  // A machine answered, not them (2026-10-14: Redfin's "we use a different
  // number for texting", the eXp desk's menu): nothing to answer, nothing
  // waiting on you, no check-in clock, and they haven't written back — so no
  // text summary, and the outreach drip keeps them. Settled on the record for
  // the audit. When it names the number their texts go to, that is yours
  // (texts_elsewhere → "Their texts go to another number" on Today).
  if (inboundKind !== "call" && isAutoReply(message)) {
    const at = new Date(typeof deps.now === "function" ? deps.now() : Date.now()).toISOString();
    const who = party === "investor" ? "investor" : "agent";
    await recordEvent({ store, locationId, contactId, party: who, type: "reply_not_needed", at,
      source: "conversation", dedupeKey: `reply_not_needed:auto:${contactId}:${at.slice(0, 13)}`, data: { intent: "auto_reply" } }).catch(() => {});
    const other = autoReplyNumber(message);
    if (other) {
      await recordEvent({ store, locationId, contactId, party: who, type: "texts_elsewhere", at,
        source: "conversation", dedupeKey: `texts_elsewhere:${contactId}:${other.replace(/\D/g, "")}`, data: { otherNumber: other } }).catch(() => {});
    }
    return { skipped: "an auto-reply, not a person — nothing to answer", job: null, autoReply: true };
  }

  // They wrote back: out of the outreach drip, whatever happens to the reply
  // (bot off, capped, held). Best effort, in the background.
  leaveOutreachWorkflows({ client, store, locationId, contactId })
    .then((r) => { if (r.left.length) console.log(`${contactId} replied — left outreach workflow(s) ${r.left.join(", ")}`); })
    .catch(() => {});

  const config = conversationConfig(saved);
  if (!config.enabled) return { skipped: "Conversation AI is switched off on the Conversation AI page", job: null };

  // 0 means no cap. The caps exist to bound a runaway loop, not to ration a
  // busy day — an operator who has decided to run without one gets to.
  const cap = config.dailyCap;
  if (cap > 0) {
    const usedToday = await countToday({ store, locationId, cap });
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
  // Two picture texts with no words are two messages when their pictures differ.
  const urls = (Array.isArray(attachmentUrls) ? attachmentUrls : []).map(String).slice(0, 8);
  for (const j of jobs.values()) {
    if (j.locationId === locationId && j.contactId === contactId && (j.originalMessage ?? j.message) === text.slice(0, 1000) &&
        (j.attachmentUrls || []).join(" ") === urls.join(" ") &&
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
    attachmentUrls: urls,
    party: party === "agent" || party === "investor" ? party : "",
    // Re-answering a text the "unanswered" clock found still owed
    // (promise-sweep.js): if this holds too, it is a person's — no new clock.
    fromCheckIn: Boolean(fromCheckIn),
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
        await recordError(store, { locationId, area: "reply", err: e, context: { contactId, jobId: job.id, party: job.party } });
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
    ready: ({ offer, config, dossier, stance = null }) => {
      if (!offer?.cashAmount) return "the offer has no number to float";
      if (offer?.deal && offer.deal.stage !== "fell_through") return "the house is under contract";
      // Their read before our price. A number that arrives with nothing
      // anchoring it reads as a lowball and ends the thread — so unless the
      // operator has deliberately switched the first step off, the take check
      // goes first and this waits for their answer.
      const takeOn = config?.parties?.agent?.takeCheck?.enabled;
      // A listed house where we asked the seller's number (listedFirst): their
      // answer is the read the number waits for.
      const haveTheirs = Boolean(dossier?.have?.arv || dossier?.have?.rehab
        || (config?.parties?.agent?.listedFirst?.enabled && dossier?.have?.sellerAsk));
      // …unless the underwrite is confident: then our number leads. A rough
      // first pass goes too: it was promised, and it asks for their read
      // itself (floatExtras' their_read question).
      if (takeOn && !haveTheirs && !leadsWithNumber({ offer, config, stance }) && !isRoughNumber(offer)) return "no read from the agent yet — the take check goes first";
      return true;
    },
    // The exact number and its rough forms ("around 445ish"), never rounded
    // up — and a range's bottom when we float one ("the 280s to 295").
    floats: realmFloats,
    // The figures behind the number when we say how we got there. Allowed,
    // never "ours": an ARV above our offer is not a price we'd pay.
    allows: ({ outbound }) => outbound?.math?.allowed || [],
    forbids: () => [],
  },
  offer_nudge: {
    party: "agent",
    enabled: (pb) => pb?.followUp?.enabled && pb?.followUp?.ladders?.offer_nudge?.enabled,
    ready: ({ offer }) => (offer?.address ? true : "nothing to follow up on"),
    floats: () => [],
    forbids: () => [],
  },
  // They countered and nobody came back — Gabe Spruell's 850k against our
  // 732k sat six days (2026-09-16). Keeps the negotiation alive by asking for
  // room, names no number of ours; the nightly audit starts it.
  counter_nudge: {
    party: "agent",
    enabled: (pb) => Boolean(pb?.followUp?.enabled),
    // A hold on "come closer to where they are" has no number of theirs.
    ready: ({ offer }) => (offer?.address && (Number(offer?.counter?.amount) > 0 || offer?.counterHold?.at) ? true : "no counter on record"),
    floats: () => [],
    forbids: () => [],
  },
  // The underwrite held on something the agent can answer (thin comps, too
  // few photos) and nobody asked them. One text for the missing piece; their
  // read re-runs it (agentNumbersRescue). Started by the nightly held sweep
  // (held-underwrites.js), which releases it; not on the playbook grid.
  take_ask: {
    party: "agent",
    enabled: (pb) => Boolean(pb?.followUp?.enabled),
    ready: ({ offer, subject }) => (offer?.address || subject?.address ? true : "no address to ask about"),
    floats: () => [],
    forbids: () => [],
  },
  // A held underwrite the nightly sweep passed (held-underwrites.js): not
  // single-family, or outside the towns we buy in. One line so they aren't
  // left waiting on a number. Started by the sweep, released by the audit;
  // not on the playbook grid. Names no number.
  // Houses you marked "We passed: <reason>" that nothing went out on
  // (shared/pass-note.js, Matt 2026-10-19): one text for all of them —
  // thanks for sending, we're passing, and why. It needs no place on the
  // auto-send list: its own switch (passNote) says it sends.
  pass_note: {
    party: "agent",
    enabled: (pb) => Boolean(pb?.passNote?.enabled),
    ready: ({ subject }) => ((subject?.houses || []).length ? true : "no house you marked is waiting on a note"),
    floats: () => [],
    forbids: () => [],
  },
  kind_pass: {
    party: "agent",
    enabled: (pb) => Boolean(pb?.followUp?.enabled),
    ready: ({ offer, subject }) => (offer?.address || subject?.address ? true : "no house to pass on"),
    floats: () => [],
    forbids: () => [],
  },
  // A price is agreed and nothing is on paper (follow-up-sweep.js
  // hotCandidates). The ask is always the same one: the listing agent writes
  // it up on NWMLS forms for us to sign. The agreed number is the offer's own
  // and may be said; nothing new may.
  hot_push: {
    party: "agent",
    enabled: (pb) => pb?.followUp?.enabled && pb?.followUp?.ladders?.hot_push?.enabled,
    ready: ({ offer }) => {
      if (!offer?.address) return "no offer to push";
      if (offer.deal) return "it became a deal";
      if (!pushesToPaper(offer)) return "no price is agreed on it";
      // Agreed, but Matt hasn't approved the number (2026-10-15): Today asks him first.
      if (!asksForWriteUp(offer)) return "the agreed number isn't approved yet — Today asks you first";
      return true;
    },
    floats: ({ offer }) => [Math.round(Number(offer?.cashAmount) || 0)].filter(Boolean),
    forbids: () => [],
    // The agreed number on THIS house and no other. The book holds every
    // house the agent has with us, and 336 SW 15th St (2026-09-25) was asked
    // to be written up "at 173k" — the number we had quoted on her other
    // listing.
    onlyFloats: true,
  },
  // The owner's answer to a question the bot deflected (partner-answer.js,
  // Today's answer box). A person typed it and pressed the button, so no
  // playbook switch gates it; it is not on the auto-send grid, so it waits in
  // the outbox for his Send. The figures he typed may be said, and only those.
  partner_answer: {
    party: "agent",
    enabled: () => true,
    ready: ({ subject }) => (String(subject?.answer || "").trim() ? true : "there is no answer to send"),
    floats: ({ subject }) => moneyIn(String(subject?.answer || "")),
    forbids: () => [],
  },
  passed_checkin: {
    party: "agent",
    enabled: (pb) => pb?.followUp?.enabled && pb?.followUp?.ladders?.passed_checkin?.enabled,
    ready: ({ offer }) => {
      if (!offer?.address) return "nothing to check in on";
      if (offer.deal) return "it became a deal";
      // no_response too (2026-09-29): an offer that went quiet is checked
      // back in on the same way — the prompt words it as "never heard back".
      if (offerStatus(offer) !== "passed" && offerStatus(offer) !== "no_response") return `the offer is ${offerStatus(offer)} now, not passed`;
      return true;
    },
    floats: () => [],
    forbids: () => [],
  },
  // We said we'd come back with a number (or an answer) and the clock ran out
  // with nothing sent. Keep the promise honestly: no number of ours, and when
  // the underwrite held, ask for theirs so there's something to run.
  promise_due: {
    party: "agent",
    enabled: (pb) => pb?.followUp?.enabled,
    ready: ({ subject }) => (subject?.address || subject?.what ? true : "nothing was promised"),
    floats: () => [],
    forbids: () => [],
  },
  // The list price came down on a house we priced (price-watch.js). Their new
  // price and the old one may be said, and our number from the book; ours is
  // never raised here.
  price_drop: {
    party: "agent",
    enabled: (pb) => pb?.followUp?.enabled,
    ready: ({ offer, subject }) => {
      if (!offer?.address) return "no offer on the house";
      if (offer.deal) return "it became a deal";
      return subject?.to ? true : "no new price to mention";
    },
    floats: ({ subject }) => [subject?.to, subject?.from].map((n) => Math.round(Number(n) || 0)).filter(Boolean),
    forbids: () => [],
  },
  // A strong past offer, asked about once more (shared/second-look.js,
  // 2026-10-16): our same number, never more. `subject.ours` is that number,
  // worked out from the thread in startProactive (secondLookNumber) — the
  // lowest we put to them on the house — and it is the ONLY number the text
  // may say (`onlyFloats`): not the book, not theirs. Its switch is
  // followUp.secondLook; not on the playbook grid, so the sweep releases a
  // clean draft itself (follow-up-sweep.js), the way the check-in's runner does.
  second_look: {
    party: "agent",
    enabled: (pb) => pb?.followUp?.enabled && pb?.followUp?.secondLook?.enabled,
    ready: ({ offer, subject }) => {
      if (!offer?.address) return "no offer on the house";
      if (offer.deal) return "it became a deal";
      if (!SECOND_LOOK_STATUSES.has(offerStatus(offer))) return `the offer is ${offerStatus(offer).replace(/_/g, " ")} now`;
      return Number(subject?.ours) > 0 ? true : "no number of ours to restate";
    },
    floats: ({ subject }) => {
      const n = Math.round(Number(subject?.ours) || 0);
      // Exactly ours, or ours said in thousands rounded DOWN ("377K" on
      // 377,552): never a figure above what we sent.
      return n > 0 ? [n, Math.floor(n / 1000) * 1000] : [];
    },
    forbids: () => [],
    onlyFloats: true,
  },
  // They told us when to check back ("this Wednesday"), or offered to send us
  // deals — the check-in they asked for (promise-sweep.js runCheckInSweep).
  checkin_due: {
    party: "agent",
    enabled: (pb) => pb?.followUp?.enabled,
    ready: () => true,
    floats: () => [],
    forbids: () => [],
  },
  // A property they said was coming, and still no address
  // (promise-sweep.js runAddressChase).
  address_chase: {
    party: "agent",
    enabled: (pb) => pb?.followUp?.enabled,
    ready: ({ subject }) => (subject?.hint ? true : "nothing to chase"),
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
  // A buyer who spoke up on a deal and went quiet (shared/follow-up.js):
  // one text, picking up where they left off. Floats nothing.
  deal_followup: {
    party: "investor",
    enabled: (pb) => pb?.followUp?.enabled && pb?.followUp?.ladders?.deal_followup?.enabled,
    ready: ({ subject }) => (subject?.address ? true : "nothing to follow up on"),
    floats: () => [],
    forbids: () => [],
  },
  // The check-in between deals (buyer-pulse.js): are you buying, and what.
  // No deal, no number. Its switches are dispoAutopilot.pulse, checked by the
  // runner before it gets here; it is not on the playbook grid.
  buyer_pulse: {
    party: "investor",
    enabled: () => true,
    ready: () => true,
    floats: () => [],
    forbids: () => [],
  },
  // The agent's own clock (shared/agent-pulse.js): every ~3 weeks for an
  // agent who has written back, about a fresh listing of theirs, the house
  // they had with us, or what's coming up. Its switches are
  // outreachAutopilot.pulse, checked by the runner; not on the playbook grid.
  // `onlyFloats` with nothing floated: ANY number in it holds the draft —
  // not even a price from the book may ride along on a check-in.
  agent_pulse: {
    party: "agent",
    enabled: () => true,
    ready: ({ subject }) => (subject?.reason ? true : "no reason to check in"),
    floats: () => [],
    forbids: () => [],
    onlyFloats: true,
  },
  // The walkthrough texts (showing-sweep.js): "see you tomorrow" to a buyer
  // coming, and "how did it look" after. The window and the street, never a
  // price: any number holds the draft. Their switches are
  // dispoAutopilot.showings, checked by the runner; not on the playbook grid.
  showing_reminder: {
    party: "investor",
    enabled: () => true,
    ready: ({ subject }) => (subject?.windowLabel ? true : "no walkthrough window"),
    floats: () => [],
    forbids: () => [],
    onlyFloats: true,
  },
  showing_followup: {
    party: "investor",
    enabled: () => true,
    ready: ({ subject }) => (subject?.windowLabel ? true : "no walkthrough window"),
    floats: () => [],
    forbids: () => [],
    onlyFloats: true,
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
// The fell-through deal on any of these addresses, or null (shared/offer-status.js
// fellThroughOn). A store that can't list deals, or fails to, holds nothing back.
async function fellThroughFor({ store, locationId, addresses = [] }) {
  const wanted = addresses.map((a) => String(a || "").trim()).filter(Boolean);
  if (!wanted.length || typeof store?.listDeals !== "function") return null;
  const deals = await store.listDeals(locationId, { limit: 200 }).catch(() => []);
  for (const a of wanted) { const hit = fellThroughOn(deals, a); if (hit) return hit; }
  return null;
}
const fellThroughLine = (o) => `the deal on ${String(o?.address || "the house").split(",")[0].trim()} fell through`;

// The live deal on any of these addresses, or null (shared/offer-status.js
// underContractOn): the offer row itself when it is the deal, else the book.
async function underContractFor({ store, locationId, offer = null, addresses = [] }) {
  if (offer?.deal && offer.deal.stage !== "fell_through") return offer;
  const wanted = addresses.map((a) => String(a || "").trim()).filter(Boolean);
  if (!wanted.length || typeof store?.listDeals !== "function") return null;
  const deals = await store.listDeals(locationId, { limit: 200 }).catch(() => []);
  for (const a of wanted) { const hit = underContractOn(deals, a); if (hit) return hit; }
  return null;
}
const underContractLine = (o) => `${String(o?.address || "the house").split(",")[0].trim()} is under contract — no number goes to the listing side`;
// What quotes, nudges or re-asks our number on the listing side. None of it
// goes about a house we signed.
const LISTING_NUMBER_KINDS = new Set(["take_check", "realm_check", "offer_nudge", "counter_nudge", "take_ask", "hot_push", "price_drop"]);

// The house we walked away from (passed, or it's gone), found by the
// contact's own offers on that address: a check-in carries the address and
// often no offer id (3037 Massey Rd, 2026-10-19). A store that can't list
// offers, or fails to, holds nothing back.
async function walkedAwayFor({ store, locationId, contactId, addresses = [] }) {
  const wanted = addresses.map((a) => String(a || "").trim()).filter(Boolean);
  if (!wanted.length || !contactId || typeof store?.listOffers !== "function") return null;
  const offers = await store.listOffers(locationId, { contactId, limit: 100, lean: true }).catch(() => []);
  for (const a of wanted) { const hit = walkedAwayFrom(offers || [], { contactId, address: a }); if (hit) return hit; }
  return null;
}
const walkedAwayLine = (o) => (o?.status === "unavailable" ? `${o.address || "that house"} is no longer available` : `we passed on ${o?.address || "that house"}`);

// machineMayStart (shared/thread-health.js) on this contact's book, drafts
// and timeline. A read that fails holds nothing back: the other doors still
// ask their own questions.
export async function machineMayStartFor({ store, locationId, contactId, kind, why = "", address = "", passes = false, now = Date.now() }) {
  if (!LIVE_THREAD_KINDS.has(kind) && !PASS_SHAPED_KINDS.has(kind) && !passes) return { ok: true };
  const [drafts, events, offers] = await Promise.all([
    typeof store?.listReplyDrafts === "function" ? store.listReplyDrafts(locationId, { contactId, limit: 50 }).catch(() => []) : [],
    typeof store?.listContactEvents === "function" ? store.listContactEvents(locationId, contactId, { limit: 200 }).catch(() => []) : [],
    typeof store?.listOffers === "function" ? store.listOffers(locationId, { contactId, limit: 50, lean: true }).catch(() => []) : [],
  ]);
  return machineMayStart({ kind, why, drafts: drafts || [], events: events || [], offers: offers || [], address, passes, now });
}

export async function startProactive({
  client, locationId, saved, store, contactId, kind = "realm_check",
  offer = null, subject = null, sendsEnabled = false, deps = {}, personAsked = false, continues = null,
}) {
  const aiApiKey = String(saved?.aiApiKey || "").trim();
  if (!aiApiKey) throw Object.assign(new Error("Anthropic API key required (Settings)"), { http: 400 });
  const config = conversationConfig(saved);
  if (!config.enabled) return { skipped: "Conversation AI is switched off", job: null };
  const spec = OUTBOUND_KINDS[kind];
  if (!spec) return { skipped: `unknown outbound kind ${kind}`, job: null };
  const playbook = config.parties?.[spec.party];
  // The seller's-number ask on a listed house is its own switch (listedFirst).
  const asksSeller = kind === "take_check" && subject?.askSeller && playbook?.listedFirst?.enabled;
  if (!spec.enabled(playbook) && !asksSeller) return { skipped: `${outboundLabel(kind)} is off for ${PARTY_LABEL[spec.party].toLowerCase()}s`, job: null };
  if (!contactId) return { skipped: "there is nobody to send it to", job: null };

  // A listed house (shared/number-stance.js listedFit, 2026-10-15): what the
  // seller is hoping to get comes before any number of ours, and a number far
  // under theirs isn't texted at all. The machine's first word on the house
  // only; a person pressing Float has decided, and a re-quote is past it.
  if (!personAsked && playbook?.listedFirst?.enabled && FLOAT_KINDS.has(kind) && !subject?.requote && !subject?.askSeller && offer?.address && offer?.cashAmount) {
    const events = await store.listContactEvents(locationId, contactId, { limit: 200 }).catch(() => []);
    let fit = listedFit({ offer, dossier: propertyDossier(events, offer.address), events, pct: playbook.listedFirst.minPctOfTheirs });
    if (fit.move !== "float") {
      // Only before our first quote on the house, whichever row it came off.
      let thread = null;
      try { thread = (await buildTranscript(client, locationId, contactId, { maxConversations: 2, maxPagesPerConvo: 1, maxMessages: 60, maxChars: 16000, maxCallTranscripts: 0 })).text || ""; }
      catch { thread = null; }
      if (thread == null || paperWent(offer) || lastQuoteOnHouse(offer, thread)) fit = { ...fit, move: "float" };
    }
    if (fit.move === "no_fit") {
      return { skipped: `${offer.address}: ${noFitLine(fit)} — too far apart to text a number; a polite no-fit instead, yours to price by hand`, noFit: fit, job: null };
    }
    if (fit.move === "ask_number") {
      return startProactive({ client, locationId, saved, store, contactId, kind: "take_check", offer,
        subject: { ...(subject || {}), address: offer.address, askSeller: true }, sendsEnabled, deps, personAsked, continues });
    }
  }

  // One voice at a time (outbox-guard.js). A text the machine starts never
  // replaces a reply to their text, or a person's own draft, that is waiting
  // in the outbox — only an older machine text, or the reply it carries on
  // from (`continues`). `blocked` tells the caller it can try again once the
  // waiting row is dealt with, rather than filing this as a dead end.
  const machine = !personAsked && MACHINE_STARTED_KINDS.has(kind);
  if (machine) {
    // You stopped the bot on them (shared/bot-hold.js): nothing the machine
    // starts is drafted, and no model call is spent finding that out. A
    // person pressing Float has decided — that drafts, and waits for Send.
    const hold = await holdFor({ store, locationId, contactId, offerId: offer?.id || null, now: typeof deps.now === "function" ? deps.now() : Date.now() });
    if (hold.held) return { skipped: holdLine(hold), held: { kind: hold.kind, until: hold.until }, job: null };
    // A deal that fell through is not checked in on with anybody — the
    // listing agent, their TC, a buyer (5232 S Yakima, 2026-10-03).
    const gone = await fellThroughFor({ store, locationId, addresses: [offer?.address, subject?.address] });
    if (gone) return { skipped: fellThroughLine(gone), job: null };
    if (LISTING_NUMBER_KINDS.has(kind)) {
      const signed = await underContractFor({ store, locationId, offer, addresses: [offer?.address, subject?.address] });
      if (signed) return { skipped: underContractLine(signed), job: null };
    }
    // A house we passed on, or that's gone, is not reached out about (3037
    // Massey Rd, 2026-10-19). The second look is the one text about our pass,
    // and its picker read it.
    // The pass note is the text about our pass, by definition (pass-note.js).
    if (kind !== "second_look" && kind !== "pass_note") {
      const left = await walkedAwayFor({ store, locationId, contactId, addresses: [offer?.address, subject?.address] });
      if (left) return { skipped: walkedAwayLine(left), job: null };
    }
    // A live thread, or a yes we'd be walking away from (shared/thread-health.js).
    const live = await machineMayStartFor({ store, locationId, contactId, kind, why: subject?.why || "", address: offer?.address || subject?.address || "",
      now: typeof deps.now === "function" ? deps.now() : Date.now() });
    if (!live.ok) return { skipped: live.reason, liveThread: live.rule, job: null };
    const waiting = await draftWaitingOnYou({ store, locationId, contactId, continues, kind });
    // The holding reply this number answers: the float carries on from it
    // (floatAnswersHeldReply). Anything else waiting holds the float.
    if (waiting && floatAnswersHeldReply({ held: waiting, kind, offer, now: typeof deps.now === "function" ? deps.now() : Date.now() })) continues = waiting.id;
    else if (waiting) return { skipped: blockingReason(waiting), blocked: { draftId: waiting.id }, job: null };
    // One house at a time, three days apart, two a week (shared/agent-focus.js).
    // The sweep asks before it claims; this is every other door asking too.
    // The pass note answers houses they sent us; it isn't a turn of ours.
    if (spec.party === "agent" && kind !== "pass_note") {
      const turn = await agentTurnReason({ store, locationId, contactId, kind, address: offer?.address || subject?.address || "", config,
        now: typeof deps.now === "function" ? deps.now() : Date.now() });
      if (turn) return { skipped: turn, spaced: true, job: null };
    }
    // Replies to people always have room. The day's cap counts every draft,
    // but was only ever enforced on replies — so a busy day of nudges and
    // pulses could leave a person's text unanswered by evening. The machine
    // stops a reserve short of the cap; a reply may use the whole of it.
    const cap = Math.round(Number(config.dailyCap) || 0);
    if (cap > 0) {
      const reserve = Math.max(REPLY_RESERVE_MIN, Math.ceil(cap * REPLY_RESERVE_SHARE));
      const used = await countToday({ store, locationId, cap });
      if (used >= cap - reserve) return { skipped: `the rest of today's drafts are kept for people who text us (${used} of ${cap}; the last ${reserve} are theirs)`, job: null };
    }
  }

  // The realm check needs to know whether the agent has given us their read,
  // which lives on the contact's timeline rather than on the offer.
  let dossier = null;
  if (kind === "realm_check" && offer?.address) {
    try {
      const events = await store.listContactEvents(locationId, contactId, { limit: 200 });
      dossier = propertyDossier(events, offer.address);
    } catch { dossier = null; }
  }
  // A high-stakes house floats a range until we have their read and eyes on
  // it (shared/number-stance.js).
  const stance = kind === "realm_check" ? await floatStanceFor({ store, offer, config, dossier }) : null;
  // The second look restates our number on the house, and only ours: the
  // lowest we put to them there (shared/second-look.js secondLookNumber),
  // read off the thread, never above what we sent. No thread, no text.
  if (kind === "second_look" && offer?.address) {
    let thread = "";
    try { thread = (await buildTranscript(client, locationId, contactId, { maxConversations: 2, maxPagesPerConvo: 1, maxMessages: 60, maxChars: 16000, maxCallTranscripts: 0 })).text || ""; }
    catch (e) { return { skipped: `couldn't read the thread to check our number (${String(e?.message || e).slice(0, 80)})`, job: null }; }
    subject = { ...(subject || {}), ours: secondLookNumber({ offer, transcript: thread }) || 0 };
  }
  const ready = spec.ready({ offer, subject, config, dossier, stance });
  if (ready !== true) return { skipped: ready, job: null };

  // A number the machine puts to the agent is never above the last one we
  // texted on that house (shared/current-offer.js machineRaise). A person
  // pressing Float has decided; nothing else has. The thread is read here,
  // before a job exists, so the caller can say why nothing went.
  if (NUMBER_FLOATS.has(kind) && offer?.cashAmount && !personAsked) {
    let thread = "";
    try { thread = (await buildTranscript(client, locationId, contactId, { maxConversations: 2, maxPagesPerConvo: 1, maxMessages: 60, maxChars: 16000, maxCallTranscripts: 0 })).text || ""; }
    catch (e) { return { skipped: `couldn't read the thread to check the number (${String(e?.message || e).slice(0, 80)})`, job: null }; }
    const raise = machineRaise(offer, thread);
    if (raise) {
      return { skipped: `we last texted ${kText(raise.amount)} on ${offer.address} and this number is ${kText(Number(offer.cashAmount))} — the machine never raises our own number; a person decides to go up`, raise, job: null };
    }
    // A house the agent said is not a project (shared/held-underwrites.js):
    // no number floats on it by itself.
    const ruledOut = agentRuledOut(await store.listContactEvents(locationId, contactId, { limit: 200 }).catch(() => []), offer.address);
    if (ruledOut) return { skipped: `${offer.address}: ${ruledOut.why} — no number goes out on it by itself`, ruledOut, job: null };
    const cut = machineCut(offer, thread);
    if (cut) {
      return { skipped: `we last texted ${kText(cut.amount)} on ${offer.address} and this number is ${kText(Number(offer.cashAmount))} — the machine never takes our number back; a person decides to go down`, cut, job: null };
    }
  }

  const job = {
    id: newJobId(), locationId, contactId, contactName: "", status: "queued", phase: "queued",
    channel: "sms", message: "", attachments: 0, party: spec.party, partySource: "offer", outbound: kind,
    offerId: offer?.id || null, draftId: null, intent: kind, summary: "", heldReason: null, scheduledFor: null,
    step: subject?.step ?? null,
    warnings: [], error: null, startedAt: new Date().toISOString(), finishedAt: null,
  };
  jobs.set(job.id, job);
  // A text that may wait on a batch runs on its own lane, wide enough for a
  // sweep's worth to land in one batch, so it never holds up a reply to a
  // person on the location's lane.
  const batched = Boolean(config.ai?.batchMachineDrafts && BATCHABLE_KINDS.has(kind));
  runOnLane(batched ? `${locationId}:machine` : locationId, () =>
    runProactive(job, { client, locationId, saved, store, aiApiKey, sendsEnabled, offer, subject, spec, config, dossier, stance, machine, continues, deps: { ...deps, draft: deps.draft || draftReply } })
      .catch(async (e) => {
        job.status = "error";
        job.error = String(e?.message || e).slice(0, 300);
        job.finishedAt = new Date().toISOString();
        await recordError(store, { locationId, area: "proactive", err: e, context: { contactId, jobId: job.id, kind } });
        await note(client, contactId, `AI ${outboundLabel(kind)} could not be drafted — ${job.error}. Pick it up by hand if you like.`, job.warnings);
      })
      // The caller's own bookkeeping once the text is drafted, held or failed
      // (the agent pulse gives a seat back when nothing was drafted).
      .finally(() => { try { deps.onSettled?.(job); } catch { /* the caller's problem */ } }),
    batched ? RA_MACHINE_CONCURRENT : RA_MAX_CONCURRENT,
  );
  return { skipped: null, job };
}
/**
 * floatAnswersHeldReply({ held, kind, offer, now }) → boolean
 *
 * An agent texts about a house, our holding reply ("let me run the numbers")
 * is held for a person, and the underwrite it started lands an offer. Until
 * 2026-10-08 the float stood down for that very reply, and nothing tried it
 * again unless the timers were on — and they too wait for the reply to be
 * dealt with — so the offer sat with no float (proactive: null). The number
 * is the answer that reply promised, so the float carries on from it (takes
 * its place) when all of these hold: it is a float of our read or number;
 * the held row answers their text, is still a draft, and is about this house;
 * it came in before the offer existed (a newer text is a new question); and
 * it is a reply the 7pm audit would send as it stands (releasableHeld:
 * every gate clean, nothing for a person) and no person's call (a counter,
 * an acceptance, a call). Anything else still holds the float.
 */
const FLOAT_KINDS = new Set(["take_check", "realm_check"]);
export function floatAnswersHeldReply({ held, kind, offer, now = Date.now() }) {
  if (!held || !FLOAT_KINDS.has(kind) || !offer?.address) return false;
  if (held.status !== "draft" || !answersInbound(held) || held.outbound?.kind) return false;
  const heldAt = Date.parse(held.createdAt || ""), offerAt = Date.parse(offer.createdAt || "");
  if (!Number.isFinite(heldAt) || !Number.isFinite(offerAt) || heldAt >= offerAt) return false;
  if (!held.propertyAddress || !sameHouse(held.propertyAddress, offer.address)) return false;
  const party = held.party || "agent";
  if (party !== "agent" || (NEVER_AUTO.agent.includes(held.intent) && held.intent !== "other")) return false;
  return releasableHeld(held, { loose: true, mode: "night", now });
}

// The kinds that put a price on a house in front of the agent.
const NUMBER_FLOATS = new Set(["realm_check", "hot_push"]);
// "850K", not "$850K": a dollar sign in a text trips carrier spam filters, and
// the style gate would hold the draft for it.
const kText = (n) => `${Math.round(n / 1000)}K`;

/**
 * chooseProactiveKind() → "realm_check"
 *
 * Our number goes. Until 2026-10-21 it was "their read before our price": a
 * take check floated our ARV and rehab and asked what they thought, and the
 * number waited for their answer. Matt: agents push back, "you're the
 * flipper, do the analysis yourself" — and he prices every house himself.
 * A listed house still asks the seller's number first (startProactive's
 * listedFirst turns this into a take check that asks just that).
 */
export function chooseProactiveKind() {
  return "realm_check";
}

/**
 * numberConfidence({ offer, job }) → "high" | "medium" | "low" | null
 *
 * How much the auto-underwrite's own record says we can stand behind its
 * number. A run that cleared every gate (street-level address read with high
 * confidence, known square footage, ≥3 renovated comps within half a mile,
 * graded ARV, enough photos, repairs inside the band, no structural flag) is
 * at least medium; with 4+ comps it's high. A held run is low — until a
 * person reviews and publishes it, which makes it theirs. null: not an
 * auto-underwrite at all (a hand-built offer keeps "their read first").
 */
export const CONFIDENT_COMPS = 4;
export function numberConfidence({ offer = null, job = null } = {}) {
  if (job) {
    if (job.held?.length) return "low";
    const n = job.compsUsed?.length || 0;
    return n >= CONFIDENT_COMPS ? "high" : "medium";
  }
  const uw = offer?.autoUnderwrite;
  if (!uw) return null;
  if (uw.publishedAt) return "high";
  if (!uw.passed) return "low";
  return (Number(uw.compsUsedCount) || 0) >= CONFIDENT_COMPS ? "high" : "medium";
}

// Lead with our number (skip "what do you think it's worth?") when the
// underwrite is confident and the operator hasn't turned it off. Never on a
// high-stakes house still in range mode (shared/number-stance.js).
export function leadsWithNumber({ offer = null, job = null, config = null, stance = null } = {}) {
  const rc = config?.parties?.agent?.realmCheck;
  if (!rc?.enabled || rc.leadWhenConfident === false) return false;
  if (stance?.mode === "range") return false;
  if (!(Number(offer?.cashAmount) > 0)) return false;
  return ["high", "medium"].includes(numberConfidence({ offer, job }));
}

/**
 * floatStance({ offer, config, dossier, videos }) → numberStance()
 *
 * The house's number stance from the agent playbook's switch
 * (realmCheck.highStakes). floatStanceFor reads the offer's videos first.
 */
export function floatStance({ offer = null, config = null, dossier = null, videos = null } = {}) {
  return numberStance({ offer, dossier, highStakes: config?.parties?.agent?.realmCheck?.highStakes, videos });
}
export async function floatStanceFor({ store, offer, config, dossier = null }) {
  if (!config?.parties?.agent?.realmCheck?.highStakes?.enabled || !offer?.id) return floatStance({ offer, config, dossier });
  const videos = typeof store?.listOfferVideos === "function" ? await store.listOfferVideos(offer.id).catch(() => []) : [];
  return floatStance({ offer, config, dossier, videos });
}

// The descriptor the prompt reads for one outbound kind: everything the model
// needs to write this particular message, and nothing about how it was chosen.
// What of ours the agent actually has on a house: the letter ("paper"), a
// number floated by text ("number"), or only our read of it ("read"). A nudge
// on an offer that never went out used to say "we sent you an offer".
export function whatWentOut(offer) {
  // A send that failed on every channel is in the ledger but isn't paper.
  if (paperWent(offer)) return "paper";
  // Only a float that left (floatSentAt). The realm check's own stamp is put
  // on when it's queued: one that a reply superseded never went, and a week
  // on the nudge asked about "that number I mentioned" (2026-10-21).
  if (offer?.floatSentAt) return "number";
  if (offer?.proactive?.takeCheckAt) return "read";
  // Marked sent by hand (it went outside the app): the letter.
  return offer && offerStatus(offer) !== "new" ? "paper" : "";
}

// What the float carries besides the number (2026-10-07), each behind its own
// realmCheck switch and none on a re-quote (that one is already their
// numbers): how we got there, a range topped by our number, and one setup
// question. The math is ours, so it rides only when the agent hasn't given
// their own read (then the float is tied to theirs) and only when it ties to
// the number in play.
// "500" → "500k"; "1.1M" stays.
const withK = (k) => (/M$/.test(k) ? k : `${k}k`);

// A float carrying the math runs longer than a reply (Matt's wording,
// 2026-10-07): up to FLOAT_MATH_MAX_CHARS, three segments. Every other text
// keeps the configured limit.
export const FLOAT_MATH_MAX_CHARS = 340;
export function styleFor(kind, outbound, style) {
  if (kind !== "realm_check" || !outbound?.math) return style;
  return { ...(style || {}), maxSmsChars: Math.max(Number(style?.maxSmsChars) || 0, FLOAT_MATH_MAX_CHARS) };
}

// The realm check's gate on its own (tests, previews): its floats and allows
// on top of the book, the float's length.
export function floatGate({ offer, outbound, style = null, amounts = [], party = "agent" }) {
  const spec = OUTBOUND_KINDS.realm_check;
  const allowed = [...new Set([...amounts, ...spec.floats({ offer, outbound }), ...spec.allows({ offer, outbound })].filter(Boolean))];
  return (d) => evaluateReplyGates({ draft: d, party, allowedAmounts: allowed, hiddenAmounts: outbound?.math?.hidden ? [outbound.math.hidden] : [],
    ranges: outbound?.range ? [outbound.range] : [], channel: "sms", style: styleFor("realm_check", outbound, style),
    ourAmount: Math.max(Number(offer?.cashAmount) || 0, ...realmFloats({ offer, outbound })) });
}

// What a realm check may say about our number: the exact figure, its rough
// forms ("around 445ish", never rounded up), and a range's two ends — its top
// is the book rounded down ("the 650s to 686" on 686,610).
export function realmFloats({ offer, outbound }) {
  return [...roughAmounts(offer?.cashAmount), Number(outbound?.range?.low) || 0, Number(outbound?.range?.high) || 0];
}

// Under this share of the ARV (less the work) the offer was capped or priced
// by hand well below our formula — "we base it on about 44%" (825 Livingston
// Bay Shore Dr, preview 2026-10-07) invites "why so low?" rather than
// answering it. The float goes without the math.
export const FLOAT_MATH_MIN_PCT = 60;

// What the seller is hoping to get, as a float's one question — unless they
// already said.
function sellerNumberQuestion(dossier) {
  return dossier?.have?.sellerAsk ? null : { key: "seller_number", text: SELLER_NUMBER_QUESTION };
}

export function floatExtras({ offer, saved, dossier = null, requote = false, theirs = false, stance = null }) {
  if (requote || !offer?.cashAmount) return {};
  const rc = conversationConfig(saved || {}).parties?.agent?.realmCheck || {};
  const out = {};
  // A rough first pass (2026-10-08): always a range, never the math (the
  // math reads as a number we stand behind). The question was their read
  // until 2026-10-21; now it's what the seller is hoping to get — we run
  // our own numbers (Matt), and a read they volunteer still re-runs it.
  if (isRoughNumber(offer)) {
    const r = floatRange(offer.cashAmount, rc.range?.pct);
    if (r) out.range = { ...r, words: rangeWords(r) };
    const q = sellerNumberQuestion(dossier)
      || (rc.setupQuestion?.enabled ? setupQuestionFor({ offerId: offer.id || offer.address || "", dossier, ask: rc.setupQuestion.ask }) : null);
    if (q) out.question = q;
    return out;
  }
  // A high-stakes house still in range mode (2026-10-15): the same shape —
  // a range, no math, and one question: eyes on it, else the seller's number.
  if (stance?.mode === "range") {
    const r = floatRange(offer.cashAmount, rc.range?.pct);
    if (r) out.range = { ...r, words: rangeWords(r) };
    out.question = stance.missing.includes("eyes") ? { ...EYES_QUESTION } : sellerNumberQuestion(dossier);
    if (!out.question) delete out.question;
    return out;
  }
  if (rc.withMath && !theirs) {
    const m = offer.math || compactMath(offerMath(offer));
    if (m && !(m.premium > 0) && Math.abs(m.total - Number(offer.cashAmount)) < 1000 && m.pctOfArv >= FLOAT_MATH_MIN_PCT) {
      const f = mathFigures(m);
      out.math = {
        ...f,
        // The short form for a two-segment text; the gate allows exactly these.
        // Short on purpose: with a range and a question it has to fit two
        // texts (two previews came back at 305 and 308 characters).
        // Matt's wording (2026-10-07): k on the figures, "rehab work",
        // "lender holding costs", "profit and risk margin".
        line: `we base it on ${f.pct}% of the ${withK(f.arvK)} it's worth fixed up` +
          `${f.repairsK ? `, less ${withK(f.repairsK)} of rehab work` : ""}; the rest is ` +
          [f.closingK ? `${withK(f.closingK)} to buy and resell` : "", f.holdingK ? `${withK(f.holdingK)} of lender holding costs` : ""].filter(Boolean).join(", ") +
          `${f.closingK || f.holdingK ? ", and" : ""} our profit and risk margin`,
        allowed: mathAllowedAmounts(m),
        hidden: Math.round(m.residual) || 0,
      };
    }
  }
  if (rc.range?.enabled) {
    const r = floatRange(offer.cashAmount, rc.range.pct);
    if (r) out.range = { ...r, words: rangeWords(r) };
  }
  if (rc.setupQuestion?.enabled) {
    const q = setupQuestionFor({ offerId: offer.id || offer.address || "", dossier, ask: rc.setupQuestion.ask });
    if (q) out.question = q;
  }
  return out;
}

// Which repeat a rung past the last configured step is (day 30 on [2] every
// 14 is the 2nd), so each one picks the next check-in text. {} for a
// configured step.
function repeatOf(subject) {
  const every = Math.round(Number(subject?.repeatEvery) || 0);
  const steps = normalizeSteps(subject?.steps || []);
  const step = Math.round(Number(subject?.step));
  if (!(every > 0) || !steps.length || !Number.isFinite(step) || steps.includes(step)) return {};
  return { repeatN: Math.max(1, Math.round((step - steps[steps.length - 1]) / every)) };
}

export function outboundDescriptor({ kind, offer, subject, saved, dossier, stance = null }) {
  const address = offer?.address || subject?.address || "the property";
  const step = subject?.step ?? null;
  const steps = subject?.steps || [];
  const base = { kind, address, ...(step != null ? { step, stepLabel: stepLabel(step, steps), stepIndex: normalizeSteps(steps).indexOf(step) + 1, stepCount: normalizeSteps(steps).length } : {}),
    ...(Number(subject?.repeatEvery) > 0 ? { repeats: true } : {}), ...(subject?.wavering ? { wavering: true } : {}) };
  if (kind === "take_check") {
    const n = offerNumbers(offer);
    // The one question is the seller's number (listedFirst), and since
    // 2026-10-21 that's every take check: it never asks for their read.
    // When they've already said it, their timeline instead.
    return { ...base,
      arv: n.arv, rehab: n.rehab,
      arvText: n.arv ? fmtMoney(n.arv) : "", rehabText: n.rehab ? fmtMoney(n.rehab) : "",
      arvK: n.arv ? kText(n.arv) : "", rehabK: n.rehab ? kText(n.rehab) : "",
      askSeller: true, sellerQuestion: dossier?.have?.sellerAsk ? "what's the seller's timeline looking like?" : SELLER_NUMBER_QUESTION };
  }
  if (kind === "pass_note") {
    const houses = (subject?.houses || []).slice(0, 6).map((h) => ({ offerId: h.offerId, address: String(h.address || ""), code: h.code, label: h.label || "", words: h.words || "", statusAt: h.statusAt || null }));
    return { ...base, address: houses.map((h) => h.address).join("; ") || address, houses, notBefore: subject?.notBefore || null };
  }
  if (kind === "kind_pass") {
    const why = ["area", "numbers", "rural", "promised", "manufactured", "too_far"].includes(subject?.why) ? subject.why : "kind";
    return { ...base, address: offer?.address || subject?.address || "", why, heldReason: String(subject?.heldReason || "").slice(0, 160),
      // A house we owed them a number on (held-underwrites.js, 2026-10-14).
      ...(why === "promised" ? { owed: ["number", "paper", "answer"].includes(subject?.owed) ? subject.owed : "number", passReason: String(subject?.reason || "").slice(0, 160) } : {}) };
  }
  if (kind === "take_ask") {
    // What the seller would take, and the address when the map missed it.
    // Their value and the work were asks too until 2026-10-21 (Matt: we run
    // our own numbers); a sweep queued before then still asks only these.
    const asked = (Array.isArray(subject?.needs) ? subject.needs : []).filter((n) => n === "address" || n === "take");
    const needs = asked.length ? asked : ["take"];
    return { ...base, heldReason: String(subject?.heldReason || ""), needs,
      needValue: needs.includes("value"), needWork: needs.includes("work"), needAddress: needs.includes("address"), needTake: needs.includes("take") };
  }
  if (kind === "partner_answer") {
    return { ...base, address: offer?.address || subject?.address || "", question: String(subject?.question || "").slice(0, 300), answer: String(subject?.answer || "").slice(0, 600) };
  }
  if (kind === "passed_checkin") {
    return { ...base, quiet: offerStatus(offer) === "no_response", went: whatWentOut(offer), relisted: Boolean(subject?.relisted) };
  }
  if (kind === "counter_nudge") {
    const theirs = Math.round(Number(offer?.counter?.amount) || 0);
    const at = Date.parse(offer?.counter?.at || "");
    // After our hold (counter-hold.js): we already told them our number.
    const held = subject?.held && Number(subject.held.ours) > 0
      ? { heldK: kText(subject.held.ours), heldStep: Number(subject.held.step) || 1, heldOf: Number(subject.held.of) || 2 } : {};
    return { ...base, theirs, theirsK: theirs ? kText(theirs) : "", ours: offer?.cashAmount || 0,
      days: Number.isFinite(at) ? Math.max(1, Math.round((Date.now() - at) / 86400000)) : 0, ...held };
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
    const st = subject?.requote ? null : stance || floatStance({ offer, config: conversationConfig(saved || {}), dossier });
    const ranged = st?.mode === "range";
    return { ...base,
      amount: offer.cashAmount, amountText: fmtMoney(offer.cashAmount),
      amountK: kText(Number(offer.cashAmount) || 0),
      askingText: asking ? fmtMoney(asking) : "", terms,
      theirArv, theirRehab,
      theirArvK: theirArv ? kText(theirArv) : "", theirRehabK: theirRehab ? kText(theirRehab) : "",
      // A confident auto-underwrite leads with the number, plainly — never a
      // high-stakes house still in range mode.
      confident: !ranged && ["high", "medium"].includes(numberConfidence({ offer })),
      ...(ranged ? { stance: { mode: "range", missing: st.missing } } : {}),
      // The write-up ask only at a number Matt approved (2026-10-15).
      approved: numberApproved(offer),
      street: String(offer.address || "").split(",")[0].trim(),
      requote: Boolean(subject?.requote),
      ...floatExtras({ offer, saved, dossier, requote: Boolean(subject?.requote), theirs: Boolean(theirArv || theirRehab), stance: st }) };
  }
  if (kind === "agent_pulse") {
    // shared/agent-pulse.js agentPulseSubject: a listing by street (never its
    // price), a house by street and how it ended, what we last talked about,
    // what they've told us and where they work — each dated — and Matt's own
    // notes on how these should sound (Settings → Agent Outreach).
    const p = subject || {};
    const list = (xs, n) => (Array.isArray(xs) ? xs.slice(0, n) : []);
    return { kind, address: String(p.address || ""), reason: p.reason || "general", segment: p.segment || "engaged",
      listing: p.listing || null, house: p.house || null, dealsWithUs: Number(p.dealsWithUs) || 0, offersWithUs: Number(p.offersWithUs) || 0,
      lastSummary: String(p.lastSummary || "").slice(0, 200), nextAction: String(p.nextAction || "").slice(0, 160),
      lastHouse: p.lastHouse && p.lastHouse.street ? { street: String(p.lastHouse.street), how: String(p.lastHouse.how || ""), daysAgo: p.lastHouse.daysAgo ?? null } : null,
      aboutThem: list(p.aboutThem, 3).map((x) => ({ what: String(x?.what || "").slice(0, 120), daysAgo: x?.daysAgo ?? null })).filter((x) => x.what),
      areas: list(p.areas, 3).map((x) => String(x).slice(0, 60)),
      voice: normalizeAgentPulse(saved?.outreachAutopilot?.pulse).voice,
      // Matt's fixed check-in, or the model's (shared/standard-texts.js).
      mode: normalizeAgentPulse(saved?.outreachAutopilot?.pulse).mode,
      forMatt: subject?.forMatt === true,
      offMarketAskDue: p.offMarketAskDue !== false,
      // The one real thing it names (shared/agent-pulse.js checkInHook).
      hook: pulseHook(p.hook),
      // A cold agent's fresh listing goes in the short first-text voice,
      // held under OPENER_MAX_CHARS like the first text (2026-10-15).
      coldOpen: (p.segment === "cold" || /gone quiet/.test(String(p.segment || ""))) && (p.reason === "fresh_listing" || p.reason === "off_market_listing") && Boolean(p.listing),
      // A focus county's listing (pulse.focusListings): texted in Matt's
      // first-text words, so it carries what those name.
      ...(p.listing?.focus ? focusOpener({ listing: p.listing, address: p.address, saved }) : {}),
      variant: Number(p.variant) || 0 };
  }
  if (kind === "second_look") {
    // Our same number, said in thousands rounded down, and nothing else.
    const ours = Math.round(Number(subject?.ours) || 0);
    return { ...base, street: streetOf(address), ours, oursK: ours ? `${Math.floor(ours / 1000)}K` : "",
      offerStatus: offerStatus(offer), went: whatWentOut(offer), step: Number(subject?.step) || 1, maxChars: SECOND_LOOK_MAX_CHARS,
      ...(subject?.offMarket ? { offMarket: true } : {}) };
  }
  if (kind === "showing_reminder" || kind === "showing_followup") {
    // The walkthrough: the street and the window as a buyer reads it
    // (shared/showing.js windowLabel). How they get in is the deal's access
    // record, which the investor context carries; nothing here adds to it.
    const p = subject || {};
    return { ...base, street: String(p.street || String(address).split(",")[0]).trim(), windowLabel: String(p.windowLabel || "") };
  }
  if (kind === "buyer_pulse") {
    // Context clues for a check-in with no deal in it (shared/buyer-pulse.js
    // pulseSubject). There is no property, so no address.
    const p = subject || {};
    return { kind, address: "", dealsSent: Number(p.dealsSent) || 0, conversed: Boolean(p.conversed), passed: Number(p.passed) || 0,
      lookedAtDeals: Boolean(p.lookedAtDeals), boughtFromUs: Boolean(p.boughtFromUs),
      lastBuyCity: String(p.lastBuyCity || ""), lastBuyYear: p.lastBuyYear || null, purchases: Number(p.purchases) || 0,
      cities: (p.cities || []).slice(0, 3), types: (p.types || []).slice(0, 3), buyBox: String(p.buyBox || "").slice(0, 200),
      variant: Number(p.variant) || 0,
      // What makes it personal (2026-10-05, shared/buyer-pulse.js pulseSubject).
      lastHouse: p.lastHouse?.street ? { street: String(p.lastHouse.street).slice(0, 80), city: String(p.lastHouse.city || "").slice(0, 40), how: String(p.lastHouse.how || "").slice(0, 100) } : null,
      passReasons: (p.passReasons || []).slice(0, 3).map((x) => String(x).slice(0, 120)),
      aboutThem: String(p.aboutThem || "").slice(0, 200), lastSummary: String(p.lastSummary || "").slice(0, 240), nextAction: String(p.nextAction || "").slice(0, 160),
      missing: (p.missing || []).slice(0, 4).map(String), source: String(p.source || "").slice(0, 80),
      voice: String(saved?.dispoAutopilot?.pulse?.voice || "").slice(0, 600) };
  }
  if (kind === "outreach_open") {
    // What we know about the listing, for the introduction. Price and days
    // on market are colour ("been sitting a while"), never a number to quote.
    const price = Math.round(Number(subject?.hookPrice) || 0);
    const opener = normalizeOpener(saved?.outreachAutopilot?.opener);
    // The city we say we're in, by the listing's market (2026-10-21).
    const home = homeFor({ county: subject?.county, state: subject?.house?.state, address }, opener);
    return { ...base, home,
      hookPrice: price, hookPriceK: price ? kText(price) : "", hookDom: Number(subject?.hookDom) || 0,
      brokerage: String(subject?.brokerage || ""),
      // The county the listing is in, the only place the text names, and
      // Matt's own openers as the voice (shared/outreach-opener.js).
      county: countyName(subject?.county), city: String(subject?.city || ""),
      // Matt's fixed first texts (mode "template", 2026-10-17), and the voice
      // the model writes one in when it does (mode "ai", the turnkey and
      // off-market seats).
      templates: opener.examples,
      examples: openerVoice(opener).map((x) => withHomeBlank(x).replace(/\{home\}/g, home)), variant: Number(subject?.variant) || 0,
      mode: opener.mode,
      // One real thing about the house for the text to notice.
      details: houseDetails({ ...(subject?.house || {}), city: subject?.city || subject?.house?.city || "", dom: Number(subject?.hookDom) || subject?.house?.dom || 0 }),
      // A finished listing, texted for the agent rather than the house (the turnkey seats).
      turnkey: subject?.house?.turnkey === true,
      // A listing that came off the market lately without selling (the off-market seats).
      offMarket: subject?.house?.offMarket === true,
      // Their listing came down lately, sold or not (the recent listers): the fixed past-tense text.
      ...(subject?.house?.pastListing === true ? { pastListing: true } : {}) };
  }
  // The nudges. They carry what the message is ABOUT and no numbers at all.
  return { ...base,
    ...(kind === "offer_nudge" || kind === "price_drop" ? { went: whatWentOut(offer) } : {}),
    ...(kind === "outreach_nudge" && countyName(subject?.county) ? { county: countyName(subject.county) } : {}),
    // Follow-up N's own text (Autopilot → Agents, 2026-10-20).
    ...(kind === "outreach_nudge" ? { home: homeFor({ county: subject?.county, address }, normalizeOpener(saved?.outreachAutopilot?.opener)),
      mode: normalizeOpener(saved?.outreachAutopilot?.opener).mode, followUps: normalizeOpener(saved?.outreachAutopilot?.opener).followUps,
      checkIns: normalizeOpener(saved?.outreachAutopilot?.opener).checkIns, ...repeatOf(subject),
      // A recent lister's first text named a house that's gone: no follow-up asks about it.
      ...(subject?.pastListing ? { pastListing: true } : {}) } : {}),
    // A passed house riding on this nudge as one line (follow-up-sweep.js).
    ...(kind === "offer_nudge" && subject?.aside?.address ? { aside: { street: streetOf(subject.aside.address), quiet: Boolean(subject.aside.quiet) } } : {}),
    blastedAt: subject?.blastedAt || null, viewedAt: subject?.viewedAt || null,
    lastTouchAt: subject?.lastTouchAt || null,
    ...(kind === "deal_followup" ? { spokeAt: subject?.spokeAt || null } : {}),
    ...(kind === "promise_due" ? { what: subject?.what || "answer", heldReason: subject?.heldReason || "", promisedText: subject?.promisedText || "", running: Boolean(subject?.running) } : {}),
    ...(kind === "price_drop" ? { from: Math.round(Number(subject?.from) || 0), to: Math.round(Number(subject?.to) || 0),
      fromK: Number(subject?.from) > 0 ? kText(Number(subject.from)) : "", toK: Number(subject?.to) > 0 ? kText(Number(subject.to)) : "",
      offerStatus: subject?.status || "", ourK: Number(offer?.cashAmount) > 0 ? kText(Number(offer.cashAmount)) : "" } : {}),
    ...(kind === "checkin_due" ? { phrase: subject?.phrase || "", sourceKind: subject?.sourceKind || "date",
      // The lead they told us about, in their words (promise-sweep.js).
      ...(subject?.lead ? { lead: { what: String(subject.lead.what || "").slice(0, 80), said: String(subject.lead.said || "").slice(0, 200),
        toldAt: subject.lead.toldAt || null, via: subject.lead.via || "text" } } : {}) } : {}),
    ...(kind === "address_chase" ? { hint: String(subject?.hint || "").slice(0, 300), phrase: subject?.phrase || "",
      rung: Number(subject?.rung) || 1, rungs: Number(subject?.rungs) || 1,
      houses: (Array.isArray(subject?.houses) ? subject.houses : []).map(String).slice(0, 5) } : {}) };
}

// The one-liner the outbox row shows when the model didn't write its own.
function outboundSummary({ kind, offer, outbound }) {
  const where = outbound.address;
  const rung = outbound.stepLabel ? ` (${outbound.stepLabel})` : "";
  switch (kind) {
    case "take_check": {
      const parts = [outbound.arv ? `${outbound.arvK} ARV` : "", outbound.rehab ? `${outbound.rehabK} rehab` : ""].filter(Boolean);
      return `Floats our ${parts.join(" / ")} read on ${where} and asks ${outbound.sellerQuestion && !/hoping/.test(outbound.sellerQuestion) ? "the seller's timeline" : "what the seller is hoping to get"}.`;
    }
    case "realm_check":
      return outbound.requote
        ? `Comes back on ${where} with ${fmtMoney(offer.cashAmount)} after re-running their numbers.`
        : `Floats ${fmtMoney(offer.cashAmount)} on ${where} as a rough first pass and asks if it's in the realm.`;
    case "offer_nudge":   return `Follows up on our offer on ${where}${rung}.${outbound.aside?.street ? ` One line: still around if ${outbound.aside.street} shakes loose.` : ""}`;
    case "counter_nudge": return `Their ${outbound.theirsK || "counter"} on ${where} sat ${outbound.days}d — asks if the seller has any room, names no number of ours.`;
    case "partner_answer": return "Your answer to a question the bot couldn't answer, in its voice.";
    case "hot_push": return `Pushes the agreed price on ${where} toward paper: asks them to write it up on NWMLS forms for us to sign${rung}.`;
    case "kind_pass": return outbound.why === "promised"
      ? `We owed them ${outbound.owed === "paper" ? "the written offer" : outbound.owed === "answer" ? "an answer" : "a number"} on ${where}: says we're out${outbound.passReason ? ` (${outbound.passReason})` : ""} and asks for the next one.`
      : outbound.why === "too_far"
        ? `Tells them ${where} doesn't fit: ours would be too far under the seller's number to send. Names no number; asks for other fixers, on or off market.`
        : `Lets them know we're passing on ${where} — ${outbound.why === "area" ? "outside the area we buy in" : outbound.why === "numbers" ? "we couldn't get to a number on it" : outbound.why === "rural" ? "it's rural, and we buy houses on under 2 acres" : outbound.why === "manufactured" ? "it's a mobile home, and we don't buy those" : "we only buy single-family right now"}.`;
    case "pass_note": return `Thanks them for sending ${(outbound.houses || []).length > 1 ? "these" : "it"} and says we're passing — ${(outbound.houses || []).map((h) => `${h.address} (${String(h.label || "").toLowerCase()})`).join(", ")}.`;
    case "take_ask": return outbound.needAddress
      ? `Asks them to confirm the street address of ${where} — the map couldn't place it.`
      : `Asks what the seller would take on ${where}${outbound.heldReason ? ` (${outbound.heldReason})` : ""}.`;
    case "passed_checkin": return outbound.relisted
      ? `Saw ${where} is back on the market; asks if the seller would look at our offer now${rung}.`
      : `Checks in after ${where} — asks if any other houses that need work, on the market or off, have come across their desk${rung}.`;
    case "outreach_open": return outbound.pastListing
      ? `First text: names their recent listing at ${where} as theirs, asks for their next fixer.`
      : outbound.offMarket
      ? `First text: their listing at ${where} (off the market lately, not said), does it need much work?`
      : outbound.turnkey
        ? `First text: their listing at ${where} looks finished, asks whether they ever get ones that need work.`
        : `First text: saw their listing at ${where}, asks whether it needs much work.`;
    case "outreach_nudge": return `Follows up on our first text about ${where}${rung}.`;
    case "buyer_pulse":   return `Checks in between deals: are they buying right now, and ${outbound.buyBox ? "is their buy box still right" : "what is their buy box"}.`;
    case "agent_pulse":
      if (outbound.reason === "fresh_listing") return `Checks in, naming their listing at ${outbound.listing?.street || where} in passing: anything else distressed on their plate?`;
      if (outbound.reason === "off_market_listing") return `Checks in about their listing at ${outbound.listing?.street || where}, off the market lately: is the seller still hoping to sell?`;
      if (outbound.reason === "deal_thanks") return "Thanks them for the deal that just closed and asks whether anything distressed or off-market has come across their desk.";
      return "Checks in: anything distressed or off-market come across their desk lately?";
    case "showing_reminder": return `Reminds them about the walkthrough at ${outbound.street || where} tomorrow, ${outbound.windowLabel}.`;
    case "showing_followup": return `Asks how ${outbound.street || where} looked after the walkthrough (${outbound.windowLabel}) and whether they want it.`;
    case "blast_nudge":   return `Follows up on ${where} — we sent it and heard nothing${rung}.`;
    case "dataroom_nudge": return `Follows up on ${where} — they opened the package and went quiet${rung}.`;
    case "deal_followup": return `Picks up on ${where} — they said something about it and went quiet.`;
    case "checkin_due":
      if (outbound.sourceKind === "source") return "Weekly check-in with an agent who offered to send us deals: anything new that needs work?";
      if (outbound.sourceKind === "unanswered") return `Comes back to them${where ? ` on ${where}` : ""} — their last text never got an answer from us.`;
      if (outbound.sourceKind === "lead") return outbound.lead?.what
        ? `Asks about ${outbound.lead.what}, on the day they named${outbound.phrase ? ` ("${outbound.phrase}")` : ""}.`
        : `The check-in they asked for${outbound.phrase ? ` ("${outbound.phrase}")` : ""}, on the day they named.`;
      return `The check-in they asked for${outbound.phrase ? ` ("${outbound.phrase}")` : ""}: anything land that needs work?`;
    case "address_chase": return outbound.houses?.length
      ? `Asks again for the addresses of the houses they named: ${outbound.houses.join(", ")} (check-in ${outbound.rung} of ${outbound.rungs}).`
      : `Asks again for the address of the property they said was coming (check-in ${outbound.rung} of ${outbound.rungs}).`;
    case "second_look": return `Second look at ${where}: if the seller is still open to it, we can still do ${outbound.oursK} (our same number); asks if it's worth a quick call.`;
    case "price_drop": return `The list price on ${where} came down${outbound.fromK ? ` from ${outbound.fromK}` : ""} to ${outbound.toK}; asks if the seller would look at cash closer to ours now.`;
    case "promise_due": return `Keeps our word on ${where}: we said we'd come back with ${outbound.what === "number" ? "a number" : "an answer"} and nothing went out${outbound.heldReason ? " (the underwrite held)" : ""}.`;
    default: return `Starts a message about ${where}${rung}.`;
  }
}

// The gates a machine-started text answers to. What its kind floats is what
// it may say, on top of the record book — and what it forbids is subtracted
// even though the book has it. A nudge floats nothing, so its allowance is
// exactly the book; `onlyFloats` (a check-in) allows nothing at all.
/**
 * namesHouse(text, address) → the words it used ("163rd", "11435"), or ""
 *
 * Whether a text names a house: its number, or its street name (the first
 * word that isn't a direction — "163rd" of "163rd Avenue Southeast",
 * "Flintstone" of "704 Flintstone Dr"). A check-in on a passed house must not
 * (Matt, 2026-10-08): we don't know what happened to it, and it usually sold.
 */
const DIRECTION_WORD = /^(n|s|e|w|ne|nw|se|sw|north|south|east|west|northeast|northwest|southeast|southwest)\.?$/i;
export function namesHouse(text = "", address = "") {
  const { houseNo, street } = parseUsAddress(String(address || ""));
  const core = String(street || "").split(/\s+/).find((w) => w && !DIRECTION_WORD.test(w)) || "";
  const t = String(text || "");
  const said = (w) => w && w.length >= 3 && new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t);
  return [houseNo, core].filter(said).join(", ");
}

function outboundGateFor({ spec, offer, subject, context, config, party, a, kind = "", outbound = null, dossier = null }) {
  const floats = spec.floats({ offer, subject, outbound }).filter(Boolean);
  const allows = (spec.allows?.({ offer, subject, outbound }) || []).filter(Boolean);
  const allowed = spec.onlyFloats ? floats : [...new Set([...(context.amounts || []), ...floats, ...allows])];
  const hidden = [...(context.hiddenAmounts || []), ...(outbound?.math?.hidden ? [outbound.math.hidden] : [])];
  const ranges = [...(context.ranges || []), ...(outbound?.range ? [outbound.range] : [])];
  const extraForbidden = spec.forbids({ offer, subject }).filter(Boolean);
  const forbiddenAmounts = extraForbidden.length
    ? [...new Set([...(context.forbiddenAmounts || []), ...extraForbidden])]
    : context.forbiddenAmounts;
  // A check-in on a passed house asks about the next one, never that house
  // (unless it's back on the market — then the house is the news).
  const oldHouse = kind === "passed_checkin" && !outbound?.relisted ? (offer?.address || subject?.address || "") : "";
  // The agent check-in is generic (Matt, 2026-10-09): it names none of the
  // houses we've had with them. A fresh listing of theirs is left out of
  // the list (shared/agent-pulse.js pastHouses).
  const pastHouses = kind === "agent_pulse" ? (Array.isArray(subject?.pastHouses) ? subject.pastHouses : []).filter(Boolean) : [];
  const gate = (d) => evaluateReplyGates({ minConfidence: config.autoSend?.minConfidence, holdOnNeedsHuman: config.autoSend?.holdOnNeedsHuman, draft: d, party, allowedAmounts: allowed, forbiddenAmounts, hiddenAmounts: hidden, ranges, inboundMessage: "", channel: "sms", style: styleFor(kind, outbound, config.style), selfName: a.signer, contactName: a.contactName, signOff: config.persona?.signOff, botAnswer: config.persona?.ifAskedIfBot,
    ourAmount: Math.max(ourNumberFor(context.offers?.numbers, d.propertyAddress || subject?.address || offer?.address), ...floats.map((n) => Number(n) || 0)),
    writeUpOk: writeUpOkFor(context.offers?.numbers, d.propertyAddress || subject?.address || offer?.address),
    vacantOk: vacantPerRecord(context?.deals, d.propertyAddress || offer?.address), carrierCheck: CARRIER_CHECKED_KINDS.has(kind),
    houseWords: houseWordsFor(context?.deals, a.transcript),
    theirValue: party === "agent" ? Math.round(Number(dossier?.have?.arv?.value) || 0) : 0,
    ourValue: ourValueFor(context.offers?.numbers, d.propertyAddress || subject?.address || offer?.address) });
  // The second look is one or two short lines (shared/second-look.js), and
  // says our same number and nothing above it — not even the book's own
  // rounding up ("378K" on 377,552).
  if (kind === "second_look") {
    const ours = Math.round(Number(subject?.ours) || 0);
    return (d) => {
      const g = gate(d);
      const extra = [];
      const n = String(d?.reply || "").length;
      if (n > SECOND_LOOK_MAX_CHARS) extra.push(`${n} characters — the second look is one or two short lines, under ${SECOND_LOOK_MAX_CHARS}`);
      const above = ours > 0 ? pricesWeName(d?.reply || "", ours).filter((x) => x > ours) : [];
      if (above.length) extra.push(`the draft says ${above.map((x) => fmtMoney(x)).join(", ")} — the second look is our same number, ${fmtMoney(ours)}, never more`);
      return extra.length ? { ...g, ok: false, clean: false, flags: [...(g.flags || []), ...extra] } : g;
    };
  }
  if (pastHouses.length) {
    return (d) => {
      const g = gate(d);
      const named = pastHouses.map((h) => namesHouse(d?.reply, h)).find(Boolean);
      return named ? { ...g, ok: false, clean: false, flags: [...(g.flags || []), `named a house from before (${named}): the check-in is generic — ask about distressed or off-market houses, never one we've had with them`] } : g;
    };
  }
  if (!oldHouse) return gate;
  return (d) => {
    const g = gate(d);
    const named = namesHouse(d?.reply, oldHouse);
    return named ? { ...g, ok: false, clean: false, flags: [...(g.flags || []), `named the house we passed on (${named}): a check-in asks about other houses that need work, never that one`] } : g;
  };
}

/**
 * writeAgainWithoutCarrierWords({ draft, kind, redraft }) → draft
 *
 * A machine text that introduces us and still says what the carriers block
 * ("cash offer", "as-is", "investor", a link…) is written once more with
 * those words named. The rewrite is kept only if it says fewer of them; the
 * gate holds whatever is left. Other kinds, and clean drafts, never pay for a
 * second call.
 */
export { CARRIER_CHECKED_KINDS };

// The texts a buyer gets about a deal, checked once more as they leave by
// themselves (sendReplyDraft): the deal text is written again at that moment,
// after any gate saw it.
export const BUYER_CARRIER_KINDS = new Set(["blast_open", "blast_nudge", "dataroom_nudge", "deal_followup", "buyer_pulse", "showing_reminder", "showing_followup"]);

export async function writeAgainWithoutCarrierWords({ draft, kind, redraft }) {
  if (!CARRIER_CHECKED_KINDS.has(kind) || typeof redraft !== "function") return draft;
  const before = carrierFlags(draft?.reply);
  if (!before.length) return draft;
  const again = await redraft(before).catch(() => null);
  return again?.reply && carrierFlags(again.reply).length < before.length ? again : draft;
}

// A check-in's hook, trimmed: the street of a house they named, or the town
// one of our deals closed in — never the closed house's street.
function pulseHook(h) {
  if (!h || typeof h !== "object" || !["listing", "mentioned", "closed_nearby", "situation"].includes(h.kind)) return null;
  if (h.kind === "mentioned") return { kind: h.kind, street: String(h.street || "").slice(0, 80), label: String(h.label || "").slice(0, 60), town: String(h.town || "").slice(0, 40), daysAgo: Number(h.daysAgo) || 0 };
  if (h.kind === "closed_nearby") return h.town ? { kind: h.kind, town: String(h.town).slice(0, 40) } : { kind: "situation" };
  return { kind: h.kind };
}

// The opener's choices, kept on the draft's outbound (openerPlan): small
// numbers and the style, never the examples themselves.
function openerChoices(outbound = {}) {
  const p = openerPlan(outbound);
  return { variant: p.variant, move: p.moveIndex, who: p.whoIndex, notice: p.notice || "", turnkey: p.turnkey, examplesHash: p.examplesHash,
    style: p.style, ...(outbound.offMarket === true ? { offMarket: true } : {}), ...(outbound.pastListing === true ? { pastListing: true } : {}) };
}

// The cold open and its nudge never sign off: GHL puts "Thanks, Matt" and
// "No worries if not can stop" on the first text a contact gets, so a sign-off
// the model wrote anyway would reach the agent twice (Matt, 2026-10-05).
const NO_SIGN_OFF_KINDS = new Set(["outreach_open", "outreach_nudge"]);

// A first text that leans on what every other agent today is getting
// ("hunting", "Seattle flipper") is written again once without it; the new one
// goes if it uses fewer of them and picked up no carrier words. No opening
// move starts with the street catching your eye any more (2026-10-16), so
// none of them is allowed.
export async function writeWithoutOverused({ draft, kind, redraft }) {
  if (kind !== "outreach_open" || typeof redraft !== "function" || !draft?.reply) return draft;
  const allow = [];
  const before = overusedPhrases(draft.reply, { allow });
  if (!before.length) return draft;
  const again = await redraft(before).catch(() => null);
  return again?.reply && overusedPhrases(again.reply, { allow }).length < before.length
    && carrierFlags(again.reply).length <= carrierFlags(draft.reply).length ? again : draft;
}

// A first text over OPENER_MAX_CHARS (200 since 2026-10-15: the short ones
// get answered) is written again once, shorter; the shorter one goes, unless
// it picked up carrier words.
export async function writeShorterFirstText({ draft, kind, redraft, outbound = null }) {
  const n = String(draft?.reply || "").length;
  // A cold agent's fresh-listing check-in is held to the same length (outbound.coldOpen).
  const short = kind === "outreach_open" || (kind === "agent_pulse" && outbound?.coldOpen === true);
  if (!short || n <= OPENER_MAX_CHARS || typeof redraft !== "function") return draft;
  const again = await redraft(n).catch(() => null);
  const m = String(again?.reply || "").length;
  return m && m < n && carrierFlags(again.reply).length <= carrierFlags(draft.reply).length ? again : draft;
}
// Matt's fixed texts (shared/standard-texts.js, 2026-10-17): the first text,
// its follow-up and the plain check-in, filled in as he writes them. No model
// call and nothing to rewrite; the gates still read it like any draft.
// What a focus listing's check-in needs to be filled from Matt's first texts
// (shared/standard-texts.js): the texts, the city we say we're in, the town
// and county.
function focusOpener({ listing = {}, address = "", saved = {} }) {
  const opener = normalizeOpener(saved?.outreachAutopilot?.opener);
  return { templates: opener.examples, home: homeFor({ county: listing.county, state: listing.state, address }, opener),
    city: String(listing.city || ""), county: countyName(listing.county) };
}

function standardDraft({ kind, offer, outbound, name, contactId }) {
  const s = standardText({ kind, outbound, name, contactId });
  if (!s) return null;
  return { reply: s.text, summary: outboundSummary({ kind, offer, outbound }), confidence: "high", needsHuman: false, usage: null,
    standard: { set: s.set, index: s.index } };
}

// A check-in about their fresh listing when the thread already has that
// house in it (shared/agent-pulse.js listingAlreadyRaised): a cold agent,
// texted only because of a new listing, hears nothing; anyone else gets the
// plain check-in instead. 2026-10-19: agents asked about a house in August
// were asked "is it a bit of a project?" about it again, and texted STOP.
export function listingCheckInFor({ kind, outbound, transcript = "" }) {
  if (kind !== "agent_pulse" || !LISTING_REASONS.has(outbound?.reason)) return { outbound };
  const seen = listingAlreadyRaised(transcript, outbound.address);
  if (!seen) return { outbound };
  const cold = outbound.segment === "cold" || /gone quiet/.test(String(outbound.segment || ""));
  const street = String(outbound.listing?.street || outbound.address).split(",")[0];
  if (cold) return { skip: `their listing at ${street} came up with them on ${seen.at} — a cold agent hears from us only about a new one` };
  return { outbound: { ...outbound, reason: "general", listing: null, address: "", coldOpen: false, hook: { kind: "situation" } } };
}

function withoutSignOff(draft, kind, signer = "") {
  if (!NO_SIGN_OFF_KINDS.has(kind) || !draft?.reply) return draft;
  const reply = stripSignOff(draft.reply, { names: [signer, String(signer || "").split(/\s+/)[0]] });
  return reply && reply !== draft.reply ? { ...draft, reply } : draft;
}

/**
 * previewProactive({ client, locationId, saved, store, contactId, kind, offer, subject, deps })
 *   → { contactName, reply, summary, held, flags } | { skipped }
 *
 * What a machine-started text WOULD say, drafted the way runProactive drafts
 * it — their thread, their record, the prompt, the money guard — and then
 * dropped: no draft row, no claim, no job, nothing sent. For reading the
 * agent check-in's voice before it's switched on (Settings → Agent Outreach).
 * `held` is the money guard or another gate objecting; the check-in's own
 * "a person's call" lock is not counted, since its switch releases that.
 */
export async function previewProactive({ client, locationId, saved, store, contactId, kind, offer = null, subject = null, deps = {}, name = "" }) {
  const aiApiKey = String(saved?.aiApiKey || "").trim();
  if (!aiApiKey) throw Object.assign(new Error("Anthropic API key required (Settings)"), { http: 400 });
  const config = conversationConfig(saved);
  const spec = OUTBOUND_KINDS[kind];
  if (!spec) return { skipped: `unknown outbound kind ${kind}` };
  const party = spec.party;
  // The same read of their take the queued float makes (startProactive), so
  // a preview asks the question the real one would.
  let dossier = null;
  if (kind === "realm_check" && offer?.address) {
    try { dossier = propertyDossier(await store.listContactEvents(locationId, contactId, { limit: 200 }), offer.address); } catch { dossier = null; }
  }
  const stance = kind === "realm_check" ? await floatStanceFor({ store, offer, config, dossier }) : null;
  const ready = spec.ready({ offer, subject, config, dossier, stance });
  if (ready !== true) return { skipped: ready };
  const a = await assembleConversation({
    client, locationId, saved, store, contactId, message: "", channel: "sms", explicitParty: party, now: Date.now(), warnings: [], aiApiKey,
  });
  const handsOff = handsOffReason(a);
  if (handsOff) return { skipped: handsOff, contactName: a.contactName };
  const askedOff = optOutInTranscript(a.transcript, config.optOut);
  if (askedOff) return { skipped: `they asked to be left alone on ${askedOff.at}`, contactName: a.contactName };
  const { context } = a;
  const listingCheck = listingCheckInFor({ kind, outbound: outboundDescriptor({ kind, offer, subject, saved, dossier, stance }), transcript: a.transcript });
  if (listingCheck.skip) return { skipped: listingCheck.skip, contactName: a.contactName };
  const { outbound } = listingCheck;
  const previewArgs = {
    message: "", transcript: a.transcript, offers: context.offers || { text: "", amounts: [], count: 0 },
    contact: { name: a.contactName || name, tags: a.tags }, underwriting: [], instructions: a.instructions, signer: a.signer, companyContact: a.companyContact,
    aiApiKey, party, config, context, channel: "sms", outbound, batch: null,
  };
  const draftWith = deps.draft || draftReply;
  const draft = standardDraft({ kind, offer, outbound, name: a.contactName || name, contactId }) || await writeShorterFirstText({
    draft: withoutSignOff(await writeAgainWithoutCarrierWords({
      draft: await draftWith(previewArgs), kind,
      redraft: (avoid) => draftWith({ ...previewArgs, outbound: { ...outbound, avoid } }),
    }), kind, a.signer),
    kind, outbound, redraft: async (n) => withoutSignOff(await draftWith({ ...previewArgs, outbound: { ...outbound, tooLong: n } }), kind, a.signer),
  }).then((d) => writeWithoutOverused({ draft: d, kind, variant: outbound.variant,
    redraft: async (words) => withoutSignOff(await draftWith({ ...previewArgs, outbound: { ...outbound, overused: words } }), kind, a.signer) }))
    .then((d) => writeShorterFirstText({ draft: d, kind, outbound, redraft: async (n) => withoutSignOff(await draftWith({ ...previewArgs, outbound: { ...outbound, tooLong: n } }), kind, a.signer) }));
  draft.intent = kind;
  const gate = outboundGateFor({ spec, offer, subject, context, config, party, a, kind, outbound, dossier })(draft);
  const clean = Boolean(gate.ok || (gate.locked && gate.clean));
  return { contactName: a.contactName || name, reply: String(draft.reply || ""), summary: String(draft.summary || ""),
    held: !clean, flags: (gate.flags || []).filter((f) => f !== gate.locked) };
}

async function runProactive(job, ctx) {
  const { client, locationId, saved, store, aiApiKey, sendsEnabled, offer, subject, spec, config, dossier, stance = null, deps } = ctx;
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
  // They asked to be left alone earlier in the thread and carry no tag (it
  // was before the bot, or a person answered it). Nothing the machine starts
  // goes to them; an answer to something THEY send is not this path.
  const askedOff = optOutInTranscript(a.transcript, config.optOut);
  if (askedOff) {
    job.status = "held"; job.phase = ""; job.finishedAt = new Date().toISOString();
    job.heldReason = `they asked to be left alone on ${askedOff.at} — nothing is drafted`;
    return;
  }
  // Stopped after this was queued on the lane (shared/bot-hold.js). A float
  // a person pressed still drafts; decideAutoSend keeps it waiting.
  if (ctx.machine && a.hold?.held) {
    job.status = "held"; job.phase = ""; job.heldReason = holdLine(a.hold); job.finishedAt = new Date().toISOString();
    return;
  }
  const { context } = a;
  const listingCheck = listingCheckInFor({ kind, outbound: outboundDescriptor({ kind, offer, subject, saved, dossier, stance }), transcript: a.transcript });
  if (listingCheck.skip) {
    job.status = "held"; job.phase = ""; job.heldReason = `dropped, not sent: ${listingCheck.skip}`; job.finishedAt = new Date().toISOString();
    return;
  }
  const { outbound } = listingCheck;

  job.phase = "drafting";
  const draftArgs = {
    message: "", transcript: a.transcript, offers: context.offers || { text: "", amounts: [], count: 0 },
    contact: { name: a.contactName, tags: a.tags }, underwriting: [], instructions: a.instructions, signer: a.signer, companyContact: a.companyContact,
    aiApiKey, party, config, context, channel: "sms", outbound,
    // Nobody is waiting on a sweep's text: half price through the Batch API,
    // falling back to a direct call (draft-batch.js). `subject.direct`: a
    // person is waiting on this one (first texts held and written again,
    // 2026-10-16), so it's a direct call, on the same machine lane.
    batch: config.ai?.batchMachineDrafts && BATCHABLE_KINDS.has(kind) && subject?.direct !== true ? batcherFor(aiApiKey) : null,
  };
  // Still reads like an ad the carriers block: written once more without it.
  const draft = standardDraft({ kind, offer, outbound, name: a.contactName, contactId: job.contactId }) || await writeShorterFirstText({
    draft: withoutSignOff(await writeAgainWithoutCarrierWords({
      draft: await deps.draft(draftArgs), kind,
      redraft: (avoid) => deps.draft({ ...draftArgs, outbound: { ...outbound, avoid } }),
    }), kind, a.signer),
    kind, outbound, redraft: async (n) => withoutSignOff(await deps.draft({ ...draftArgs, outbound: { ...outbound, tooLong: n } }), kind, a.signer),
  }).then((d) => writeWithoutOverused({ draft: d, kind, variant: outbound.variant,
    redraft: async (words) => withoutSignOff(await deps.draft({ ...draftArgs, outbound: { ...outbound, overused: words } }), kind, a.signer) }))
    .then((d) => writeShorterFirstText({ draft: d, kind, outbound, redraft: async (n) => withoutSignOff(await deps.draft({ ...draftArgs, outbound: { ...outbound, tooLong: n } }), kind, a.signer) }));
  draft.intent = kind;
  if (draft.shadow && !draft.shadow.error) draft.shadow.intent = kind;
  job.summary = draft.summary;
  const gateFor = outboundGateFor({ spec, offer, subject, context, config, party, a, kind, outbound, dossier });
  let gate = gateFor(draft);
  // A text the machine started that a gate caught (not the kind's own
  // lock): written once more, told what tripped it. If it still trips,
  // nothing goes and nothing waits on you — nobody asked for this text, and
  // two check-ins sat on the Desk for days over the word "assigning"
  // (2026-10-04). The timeline says what was dropped and why.
  const passes = (g) => Boolean(g.ok || (g.locked && g.clean));
  // Not a float or a first text, though: those are marked as gone the
  // moment they're queued (realmCheckAt, takeCheckAt, the outreach record),
  // so a dropped one would read as sent and never be tried again. They still
  // wait for you, as before (review, 2026-10-04).
  // Matt's 15 is his to fix and send, like these (subject.forMatt).
  if (ctx.machine && !passes(gate) && !KEEP_FOR_A_PERSON.has(kind) && !subject?.forMatt) {
    const tripped = (gate.flags || []).filter((f) => f !== gate.locked);
    const again = tripped.length ? await deps.draft({ ...draftArgs, outbound: { ...outbound, fix: tripped } }).catch(() => null) : null;
    if (again?.reply) {
      again.intent = kind;
      const g2 = gateFor(again);
      if (passes(g2)) { Object.assign(draft, again, { intent: kind }); gate = g2; job.summary = draft.summary; }
    }
    if (!passes(gate)) {
      const why = String(tripped[0] || gate.flags?.[0] || "a gate held it").replace(/^needs a person:\s*/, "").slice(0, 160);
      await recordEvent({ store, locationId, contactId: job.contactId, party, type: "note", at: new Date(now).toISOString(), source: "conversation",
        dedupeKey: `machine_text_dropped:${job.id}`, data: { note: `${kind.replace(/_/g, " ")} not sent — ${why}`, phrase: "the machine dropped its own text" } }).catch(() => {});
      job.status = "held"; job.phase = ""; job.heldReason = `dropped, not sent: ${why}`; job.finishedAt = new Date().toISOString();
      return;
    }
  }
  let auto = decideAutoSend({ gate, party, intent: kind, channel: "sms", config, sendsEnabled, humanActive: a.humanActive, hold: a.hold });
  auto = releaseForAudit({ auto, gate, draft, deps });
  // A caller whose own switch is off (held-underwrites.js: the pass on a
  // house we owed them a number on, heldTriage.passOnRetire) wants the draft
  // to wait for a person — and "needs a person" is what keeps the 7pm audit
  // from releasing it later (releasableHeld).
  if (deps.holdForAPerson) auto = { send: false, code: "switch_off", reason: `needs a person: ${String(deps.holdForAPerson).slice(0, 160)}` };

  job.phase = "saving";
  const open = [];
  for (const status of ["draft", "scheduled"]) {
    const rows = await store.listReplyDrafts(locationId, { contactId: job.contactId, status, limit: 5 }).catch(() => []);
    open.push(...rows);
  }
  // They may have texted while this was being written. Their reply, or a
  // person's own draft, is never replaced by the machine's: stand down.
  const blocker = ctx.machine ? blockingDraft(open, { continues: ctx.continues, kind }) : null;
  if (blocker) {
    job.status = "held"; job.phase = ""; job.heldReason = blockingReason(blocker); job.finishedAt = new Date().toISOString();
    return;
  }
  // A deal text queued for this buyer is its own thing — it may be waiting
  // days for their week (shared/buyer-touch.js) — and another machine text
  // never replaces it. Nor does the agent check-in replace a reply held a
  // week (shared/follow-up.js supersededBy): that one stays on the Desk.
  const replaced = supersededBy(open, { kind });
  for (const old of replaced) {
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
      ...(kind === "realm_check" ? { amount: offer.cashAmount, requote: outbound.requote, ...(outbound.range ? { range: { low: outbound.range.low, high: outbound.range.high, step: outbound.range.step } } : {}) } : {}),
      ...(outbound.step != null ? { step: outbound.step, steps: subject?.steps || [], stepLabel: outbound.stepLabel } : {}),
      ...(kind === "agent_pulse" ? { segment: outbound.segment, reason: outbound.reason, listingKey: LISTING_REASONS.has(outbound.reason) ? subject?.listingKey || null : null, hook: outbound.hook?.kind || null,
        // Matt's 15 (agent-pulse.js startMattsFifteen): his to make his own and send, on Today.
        ...(subject?.forMatt ? { forMatt: true } : {}) } : {}),
      ...((kind === "outreach_open" || kind === "outreach_nudge") && outbound.county ? { county: outbound.county } : {}),
      // Why we passed: the send-time live-thread check lets a no-fit ("too_far") through.
      ...(kind === "kind_pass" && outbound.why ? { why: outbound.why } : {}),
      // The houses it passes on, and each one's status stamp: a house you
      // priced or marked again since stops it at send (pass-note.js passNoteStale).
      ...(kind === "pass_note" ? { houses: outbound.houses, notBefore: outbound.notBefore } : {}),
      // The number it restates, and where the offer stood when it was
      // drafted: a status marked after this stops it at send.
      ...(kind === "second_look" ? { amount: outbound.ours, offerStatus: outbound.offerStatus, statusAt: offer?.statusAt || null, step: outbound.step } : {}),
      // Which first text this was (conversation-prompt.js openerPlan), so
      // replies can be read back by opening, voice and detail.
      ...(kind === "outreach_open" ? openerChoices(outbound) : {}),
      // Which of Matt's fixed texts went, when one did.
      ...(draft.standard ? { standard: draft.standard, ...(kind === "outreach_open" ? { style: "standard" } : {}) } : {}),
    },
    reply: draft.reply, intent: kind, confidence: draft.confidence, needsHuman: draft.needsHuman, humanReason: draft.humanReason,
    usage: draft.usage || null, shadow: shadowRow(draft.shadow, gateFor),
    summary: draft.summary || outboundSummary({ kind, offer, outbound }),
    propertyAddress: outbound.address || draft.propertyAddress || "", counterAmount: null,
    autoSendable: gate.ok, gateClean: Boolean(gate.ok || (gate.locked && gate.clean)), flags: gate.flags, party, partySource: "offer", matchedTags: a.matchedTags,
    contextSummary: context.summary || {}, offersInContext: context.offers?.count ?? 0,
    autoSend: { decided: auto.send, reason: auto.reason }, humanActive: a.humanActive || null, actions: [],
    supersededIds: replaced.map((o) => o.id), warnings: warnings.slice(0, 6), noteOnAutoSend: config.notes?.onAutoSend !== false,
    promptVersion: 3, updatedAt: ts,
  });
  job.draftId = record.id;
  try { await addContactTags(client, job.contactId, [RA_TAGS.draft]); } catch (e) { warnings.push(`tag: ${e.message}`); }
  if (auto.send && draft.reply) {
    job.phase = "scheduling";
    const random = typeof deps.random === "function" ? deps.random : Math.random;
    let sendAt = scheduleFor({ config, now, kind, intent: kind, replyLength: String(draft.reply || "").length, random });
    // The pass note waits out your minutes to text them yourself, inside its hours.
    if (kind === "pass_note" && Date.parse(outbound.notBefore || "") > Date.parse(sendAt)) {
      sendAt = nextSendTime({ now: Date.parse(outbound.notBefore), delayMs: 0, quietHours: machineHours(config.autoSend || {}) });
    }
    record = { ...record, status: "scheduled", sendAt, scheduledAt: new Date(now).toISOString(), updatedAt: new Date().toISOString() };
    await store.updateReplyDraft(record.id, record);
    job.scheduledFor = sendAt;
  }
  if (config.notes?.onDraft !== false) await note(client, job.contactId, draftNote(record), warnings);
  job.status = "done";
  job.phase = "";
  job.finishedAt = new Date().toISOString();
}

function runOnLane(locationId, fn, max = RA_MAX_CONCURRENT) {
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
  if (lane.running < max) {
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

  // A listing link is an address the model can't see. Resolve it into the
  // message first ("[listing link → 10625 SE 304th Way, Auburn, WA 98092]"),
  // so propertyAddress, the subject property, the underwrite and the
  // follow-up all key off a house exactly as if the agent had typed it. The
  // original text is kept for the duplicate check.
  if (job.inboundKind !== "call" && !job.originalMessage) {
    const expanded = await (deps.expandLinks || expandListingLinks)(job.message).catch(() => ({ links: [] }));
    if (expanded?.links?.length) {
      job.originalMessage = job.message;
      job.message = String(expanded.text).slice(0, 1400);
      job.listingLinks = expanded.links.map(({ url, address, source }) => ({ url, address, source }));
    }
  }
  // A flyer is an address the model can't see either (Matt, 2026-10-22:
  // "scrub images that people sent over and create the drafts from the
  // address(es) that are in the image", texts and emails both). The pictures
  // and PDFs they sent since our last text are read for the printed street
  // address and nothing else, and it goes into the message the way a link's
  // does: "[photo → 7413 Soundview Dr, Edmonds, WA 98026]". The reply model
  // reads that line, never the picture. Off unless media.readAddresses is on.
  if (job.inboundKind !== "call" && !job.photoAddresses && conversationConfig(saved).media?.readAddresses
      && (job.attachments > 0 || job.attachmentUrls?.length || (job.channel === "email" && /<img\b/i.test(job.message)))) {
    job.photoAddresses = [];
    try {
      const fromGhl = await (deps.photoUrls || ((id) => inboundPhotoUrls(client, locationId, id, { now })))(job.contactId).catch(() => []);
      const urls = [...new Set([...(fromGhl || []), ...(job.attachmentUrls || []), ...(job.channel === "email" ? bodyImageUrls(job.message) : [])])];
      job.photoAddresses = urls.length
        ? await (deps.readPhotos || ((us) => readPhotoAddresses(us, { aiApiKey, now })))(urls)
        : [];
    } catch (e) {
      warnings.push(`photo addresses: ${String(e?.message || e).slice(0, 120)}`);
    }
    if (job.photoAddresses.length) {
      if (job.originalMessage == null) job.originalMessage = job.message;
      job.message = expandPhotoAddresses(job.message, job.photoAddresses).slice(0, 1400);
    }
  }

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

  // An email address they texted goes on their GHL contact (2026-10-15).
  // Until then it was used once, for the send it came with, and forgotten.
  // A buyer asking for deals by email is filed the same way. Neither sends
  // anything, so both run whoever has the thread; a call's transcript is
  // never read for an address (shared/contact-email.js).
  if (party !== "unknown" && !isCall) {
    const words = job.originalMessage || job.message;
    const mail = await saveTextedEmail({ client, store, locationId, contactId: job.contactId, party, message: words,
      current: a.contact ? a.contact.email || "" : undefined, ref: job.id, now }).catch(() => null);
    if (mail && mail.action !== "none") job.emailSave = { action: mail.action, ok: mail.ok ?? null, reason: mail.reason || "" };
    if (party === "investor" && wantsDealsByEmail(words)) {
      const r = await setDealsBy({ client, store, locationId, contactId: job.contactId, value: "email", source: "conversation", ref: job.id }).catch(() => null);
      if (r?.ok) job.dealsByEmail = { hasEmail: Boolean(mail?.ok || a.contact?.email) };
    }
  }

  // A hold before any draft leaves no row in the outbox, and until 2026-09-22
  // no trace anywhere: the nightly audit's redraft of Michael Lindekugel
  // (bot-off tag) came back as "drafting was tried … nothing came of it".
  // One timeline row per job says why, so the audit can say it too.
  const noteHeld = async (reason) => recordEvent({
    store, locationId, contactId: job.contactId, party: a.party === "investor" ? "investor" : "agent", type: "reply_held",
    at: new Date(now).toISOString(), source: "conversation", ref: job.id, dedupeKey: `reply_held:${job.id}`, data: { reason: String(reason).slice(0, 200) },
  }).catch(() => {});

  const handsOff = handsOffReason(a);
  if (handsOff) {
    // Either the operator tagged them off, or we are mid-deal with them. No
    // draft, no note — they know, and a note on a live deal is noise.
    job.status = "held";
    job.phase = "";
    job.heldReason = handsOff;
    job.finishedAt = new Date().toISOString();
    if (a.dnd) await markUnsubscribed({ client, store, locationId, contactId: job.contactId, party: a.party, now });
    await noteHeld(handsOff);
    // A gatekeeper answered: their sequence stops, and Matt calls.
    if (a.gatekeeper) {
      await recordEvent({ store, locationId, contactId: job.contactId, party: "gatekeeper", type: "gatekeeper_replied",
        at: new Date(now).toISOString(), source: "conversation", ref: job.id, dedupeKey: `gatekeeper_replied:${job.id}`,
        data: { channel: job.channel || "sms", call: Boolean(isCall) } }).catch(() => {});
    }
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
    job.heldReason = humanActiveLine(a.humanActive);
    // The thread is Matt's, but what they said about the deal still goes on
    // it: Kenneth Patton's four questions about 1510 Maple Lane (2026-10-01)
    // came while Matt was answering him, and none of them reached the deal.
    if (party === "investor" && deps.linkDealInterest) {
      const filing = heldDealReplyFiling(job.originalMessage || job.message, context?.deals?.linked);
      if (filing) {
        const r = await deps.linkDealInterest({ contactId: job.contactId, addressHint: "", said: job.originalMessage || job.message || "", ...filing })
          .catch((e) => { warnings.push(`not put on the deal: ${e.message}`); return null; });
        if (r?.linked && !r.unchanged) job.filedOnDeal = { status: r.status, address: r.address };
      }
    }
    job.finishedAt = new Date().toISOString();
    await noteHeld(job.heldReason);
    return;
  }

  if (party === "unknown" && config.routing.unknown === "hold") {
    job.status = "held";
    job.phase = "";
    job.heldReason = "no agent or investor tag on the contact — no draft written";
    job.finishedAt = new Date().toISOString();
    await noteHeld(job.heldReason);
    await note(client, job.contactId,
      `Conversation AI did not answer: this contact carries none of the tags that mark a listing agent or an investor ` +
      `(see the Conversation AI page → routing). Their message is in the thread above; answer it by hand, or tag them and it will next time.`,
      warnings);
    return;
  }

  /* --- 1a. an agent offering to work together, on terms --- */
  // 2026-10-14: ~17 agents offered a list-back, to be our buyer's agent, a
  // referral fee, their wholesale list, or said they buy — and got "keep me
  // in mind". Their burst, texts only (on a call Matt heard it himself). The
  // reply is held for Matt below, and the Desk raises a partner row from the
  // event (shared/call-list.js call_partner_terms). One who says they buy is
  // investor-minded too, by the same key the reply's own read uses.
  const terms = party === "agent" && !isCall ? partnerTerms(theirLatestWords(a.transcript, job.originalMessage || job.message)) : null;
  if (terms) {
    const at = new Date(now).toISOString();
    const events = [{ type: "partner_terms", at, source: "conversation", ref: job.id, dedupeKey: `partner_terms:${job.contactId}:${terms.kind}:${at.slice(0, 10)}`,
      data: { kind: terms.kind, phrase: terms.phrase, kinds: terms.kinds, addToBuyers: terms.addToBuyers } }];
    if (terms.addToBuyers) events.push({ type: "investor_minded", at, source: "conversation", ref: job.id, dedupeKey: `investor_minded:${job.contactId}`, data: { cue: terms.phrase.slice(0, 80) } });
    await recordEvents({ store, locationId, contactId: job.contactId, party: "agent", events }).catch(() => {});
  }

  /* --- 1b. the calendar, when a time is on the table --- */
  const booking = await prepareBooking({ client, store, locationId, contactId: job.contactId, party, message: job.message, config, now, deps }).catch(() => null);
  if (booking?.error) warnings.push(`calendar: ${booking.error}`);
  const bookingText = booking ? bookingContextText(booking) : "";
  // The house our first text opened with (read before the draft since
  // 2026-10-15: the call ask below needs it too).
  const iceHouse = party === "agent" ? await firstTextHouse(store, locationId, job.contactId) : null;
  // The call ask (2026-10-15): their first answer to our first text closes
  // with one question — other fixers, and a quick call this week. Texts
  // only, once, never to someone annoyed; parties.agent.callAsk, off.
  // Off, their first answer still closes on the other-fixers ask alone.
  const callOn = Boolean(config.parties?.agent?.callAsk?.enabled);
  const firstAnswer = party === "agent" && !isCall
    ? callAskFor({ events: (await store.listContactEvents?.(locationId, job.contactId, { types: ["outreach_sent", "outreach_enrolled", "call_asked"], limit: 50 }).catch(() => [])) || [],
      transcript: a.transcript, message: job.originalMessage || job.message, ice: iceHouse })
    : null;
  const callAsk = callOn ? firstAnswer : null;
  const extraText = [bookingText, partnerTermsLine(terms), firstAnswer?.first ? (callOn ? CALL_ASK_LINE : FIXERS_ASK_LINE) : ""].filter(Boolean).join("\n\n");
  const draftContext = extraText ? { ...context, text: [context.text, extraText].filter(Boolean).join("\n\n") } : context;

  /* --- 2. the draft --- */
  job.phase = "drafting";
  let draft;
  // What the model was asked, kept for the one redraft a content gate earns
  // (redraftOnGate, below). Null for the canned photo line.
  let replyArgs = null;
  if (job.attachments > 0 && !String(job.message || "").trim()) {
    // A bare photo gets the canned line and no model call — the rule is
    // "never analyse the image", and the surest way not to is not to look.
    draft = mediaDraft(config);
  } else {
    replyArgs = {
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
    };
    draft = await deps.draft(replyArgs);
  }
  job.intent = draft.intent;
  job.summary = draft.summary;

  // A price named on a house we have never priced is the seller's ask, not a
  // counter. "My seller won't take less than 450k" in answer to a cold
  // outreach text read as `counter`, which never sends itself and has no
  // offer for the band to check — so the reply sat in the outbox and no
  // underwrite started. With no live or recent offer (or held draft) on that
  // address, it is a new property: the underwrite starts with their number as
  // the asking price, the holding reply can go, and our number follows as a
  // realm check once the numbers land. A counter on a house we DID offer on
  // is untouched and still goes to the band.
  // Conservative on purpose: any open offer for this agent at all, or anything
  // on file that even loosely names this house, leaves it a counter — the
  // band matches loosely and falls back to a lone open offer, so this must
  // not call something new that the band would have recognised.
  if (party === "agent" && draft.intent === "counter" && draft.propertyAddress) {
    const book = await store.listOffers(locationId, { contactId: job.contactId, limit: 50, lean: true }).catch(() => null);
    const anyOpen = (book || []).some(isNegotiable);
    if (book && !anyOpen && !knownOfferFor(book, draft.propertyAddress, now) && !pickOfferByAddress(book, draft.propertyAddress)) {
      draft = { ...draft, intent: "new_property", reclassifiedFrom: "counter" };
      job.intent = draft.intent;
    }
  }

  // A number inside the range we floated (2026-10-07): "285 works" after
  // "the 280s to 295". Under our number, so not a counter; a number of
  // theirs, so not a yes to ours. A person decides — the letter at our
  // number or a revise to theirs — and nothing files it as countered. A
  // plain yes is still a yes at the top; above the top is still a counter.
  let inRange = null;
  if (party === "agent" && !isCall && ["counter", "realm_yes", "acceptance", "question", "other"].includes(draft.intent)) {
    const book = await store.listOffers(locationId, { contactId: job.contactId, limit: 50, lean: true }).catch(() => []);
    const open = currentOffers(book).filter(isNegotiable);
    const picked = pickOfferByAddress(open, draft.propertyAddress) || (open.length === 1 ? open[0] : null);
    const range = picked ? liveRange(picked) : null;
    const hit = range ? namedInRange({ range, message: job.message }) : null;
    if (hit) {
      inRange = { offerId: picked.id, amount: hit.amount, low: range.low, high: range.high };
      draft = { ...draft, intent: "realm_yes", reclassifiedFrom: draft.intent, counterAmount: 0, inRange };
      job.intent = draft.intent;
    }
  }

  // A counter far past what we'd pay is a pass, not a negotiation. Jesse
  // (2026-09-14): "They can't take that offer. Their lowest at this time is
  // $700k" against our $550k — the band had no room (our number was already
  // over the buyer line), so the draft sat for a person, the offer stayed
  // "countered" and he stayed Tier 1. Over COUNTER_PASS_MARGIN above the higher
  // of our offer and the ceiling, it's filed as their pass: offer passed, Tier
  // 3, and a short reply that names no number of ours.
  let softFloor = false;
  // "Current list price" / "full asking" IS their number, and it is the list
  // price. Bryce Buri (2026-09-16): our 900k, "far too low", asked where the
  // seller needs to be, "Current list price" (1,195,000) — read as a counter
  // with no figure in the words, so the band held it and nobody walked.
  if (party === "agent" && ["rejection", "counter", "question", "other"].includes(draft.intent) && listPriceFloor(job.message)) {
    draft = { ...draft, intent: "counter", counterFloor: "list_price", reclassifiedFrom: draft.intent === "counter" ? draft.reclassifiedFrom : draft.intent };
    job.intent = draft.intent;
  }
  if (party === "agent" && draft.intent === "counter") {
    const book = await store.listOffers(locationId, { contactId: job.contactId, limit: 50, lean: true }).catch(() => []);
    const open = currentOffers(book).filter(isNegotiable);   // the number we're working from, per house
    const picked = pickOfferByAddress(open, draft.propertyAddress) || (open.length === 1 ? open[0] : null);
    const full = picked && typeof store.getOffer === "function" ? (await store.getOffer(picked.id).catch(() => null)) || picked : picked;
    if (full) {
      const ceiling = autoAcceptCeiling({ offer: full, settings: saved || {} });
      const reference = Math.max(Math.round(Number(full.cashAmount) || 0), ceiling.computable ? ceiling.ceiling : 0);
      // Shorthand first, so everything below — the pass line, the band, the
      // record — reads the number they meant rather than the digits they typed.
      const read = counterDollars(draft.counterAmount, { message: isCall ? "" : job.message, reference });
      if (read !== Math.round(Number(draft.counterAmount) || 0)) {
        draft = { ...draft, counterAmount: read, counterShorthand: true };
      }
      if (draft.counterFloor === "list_price") {
        // The list price as we know it: on the offer, else the seller's ask
        // on the timeline ("another price reduction, currently at 1,195,000"
        // — Bryce Buri, filed as sellerAsk), else the figure the model read
        // off the thread. A held draft that was published carries no list.
        let list = Math.round(Number(full.askingPrice ?? full.calc?.inputs?.askingPrice) || 0);
        if (!(list > 0)) {
          const evs = await store.listContactEvents?.(locationId, job.contactId, { limit: 200 }).catch(() => []) || [];
          list = Math.round(Number(propertyDossier(evs, full.address || draft.propertyAddress || "")?.have?.sellerAsk?.value) || 0);
        }
        if (!(list > 0)) list = Math.round(Number(draft.counterAmount) || 0);
        if (list > 0) draft = { ...draft, counterAmount: list };
      }
      const theirs = Math.round(Number(draft.counterAmount));
      if (theirs > 0) {
        // Once we've already come back with a number (the band countered or
        // accepted, or a re-quote went out), any counter above what we'd pay is
        // their answer to it — no margin, no second round.
        const weMovedOnPrice = Boolean(full.counterBand?.acceptedAt || (full.requotes || []).length);
        const passLine = weMovedOnPrice ? reference : reference * (1 + COUNTER_PASS_MARGIN);
        const firmness = floorFirmness(job.message);
        // Matt, 2026-09-16: "be quicker to pass on ones that aren't in our
        // buy box and move on." A floor this far past the most we'd pay is
        // not a gap to work however softly it's put; the list price as their
        // floor is the same thing said plainly.
        const beyondReach = reference > 0 && (theirs > reference * (1 + WALK_AWAY_GAP) || draft.counterFloor === "list_price");
        // Close to our number (2026-10-15): a call, never a pass or a soft
        // round by text — the hold below hands it to a person.
        const close = closeCounter({ ours: full.cashAmount, theirs, pct: config.parties?.agent?.counterHold?.callWithinPct ?? 10 });
        const heldWhy = passHeldWhy({ offer: full, message: job.originalMessage || job.message });
        if (close) { /* a person's call: see the hold below */ }
        else if (reference > 0 && theirs > passLine && firmness === "soft" && !beyondReach && !(full.requotes || []).length) {
          // A soft floor is an opening. Keep it a live negotiation: file their
          // number on the offer and say we'll take another look. No number of
          // ours, no goodbye — and since 2026-10-21 no "what would you budget
          // for the work?": we run our own numbers (Matt).
          softFloor = true;
          const street = String(draft.propertyAddress || full.address || "").split(",")[0].trim();
          draft = {
            ...draft, intent: "question", reclassifiedFrom: "counter",
            summary: `Their number (${fmtMoney(theirs)}) is well over ours (${fmtMoney(reference)}), but they sound open — told them we'd take another look.`,
            reply: `Appreciate you giving me a number to work with${street ? ` on ${street}` : ""}. Let me take another look at it with that in mind and I'll come back to you.`,
            needsHuman: false,
          };
          job.intent = draft.intent;
        } else if (reference > 0 && theirs > passLine && heldWhy) {
          // The goodbye goes once, to a text that asks nothing else. Melissa
          // W. (2026-10-20): 311 R St NE was passed on 10/17, and each
          // text repeating the 600k drew the same goodbye — three in 25
          // minutes, the last to "What would you offer on the Auburn home?",
          // and one to a text about a second house. The model's reply waits
          // for a person instead.
          draft = { ...draft, needsHuman: true, passHeld: { offerId: full.id, theirs, why: heldWhy, passed: offerStatus(full) === "passed" }, humanReason: heldWhy };
        } else if (reference > 0 && theirs > passLine) {
          draft = {
            ...draft, intent: "rejection", reclassifiedFrom: "counter",
            summary: weMovedOnPrice
              ? `Their number (${fmtMoney(theirs)}) is over the most we'd pay (${fmtMoney(reference)}) after we already came back — filed as a pass.`
              : `Their number (${fmtMoney(theirs)}) is more than ${Math.round(COUNTER_PASS_MARGIN * 100)}% over the most we'd pay (${fmtMoney(reference)}) — filed as a pass.`,
            reply: "Sorry, this one didn't work out for us, we're too far apart on the number. Appreciate you working it with me. Keep me in mind for the next one that needs work, and if anything changes with the seller I'm here.",
            needsHuman: false,
          };
          job.intent = draft.intent;
        }
      }
    }
  }

  // Hold, then pass (Matt, 2026-10-04: counterHold, Full on the dial). A
  // counter still above our number after the pass line, or "come closer to
  // where they are" with no number, gets OUR number back, once, held — the
  // lowest we've put to them (holdNumber), never more. The check-ins and the
  // pass are counter-hold.js's. A counter with no number that asks nothing
  // of us ("I could ask what they'd take") is a status reply, not a counter.
  let counterHold = null;
  // Texts only, never a call: a call's transcript carries Matt's own words
  // ("we can't go higher") and he has just had the conversation. And only
  // with the follow-up clock on, which the check-ins after the hold ride.
  const holdOn = config.parties?.agent?.counterHold?.enabled && config.parties?.agent?.followUp?.enabled;
  if (party === "agent" && !isCall && draft.intent === "counter" && holdOn && !draft.passHeld) {
    const book = await store.listOffers(locationId, { contactId: job.contactId, limit: 50, lean: true }).catch(() => []);
    const open = currentOffers(book).filter(isNegotiable);
    const picked = pickOfferByAddress(open, draft.propertyAddress) || (open.length === 1 ? open[0] : null);
    const full = picked && typeof store.getOffer === "function" ? (await store.getOffer(picked.id).catch(() => null)) || picked : picked;
    const hold = full ? holdNumber({ offer: full, transcript: a.transcript || "" }) : null;
    const theirs = Math.round(Number(draft.counterAmount) || 0);
    const comeUp = asksUsToComeUp(job.originalMessage || job.message);
    // Close to our number: a phone call lands these and the hold text loses
    // them (2026-10-15: within 5%, 13 of 25 agreed; past 25%, none). No hold,
    // no pass: it stays a person's counter, and the Desk's call list leads
    // with it (call_counter).
    const close = hold ? closeCounter({ ours: hold.amount, theirs, pct: config.parties?.agent?.counterHold?.callWithinPct ?? 10 }) : null;
    if (close) {
      const where = String(full.address || "").split(",")[0].trim() || "the house";
      draft = { ...draft, needsHuman: true, callCounter: { offerId: full.id, ours: hold.amount, theirs, pct: close.pct },
        humanReason: `their ${fmtMoney(theirs)} on ${where} is ${close.pct}% over our ${fmtMoney(hold.amount)} — call them; a held number by text loses these` };
    } else if (hold && (theirs > hold.amount || (!theirs && comeUp))) {
      const where = String(full.address || "").split(",")[0].trim() || "the house";
      // Said once; a second ask that didn't move gets the short version.
      const again = Boolean(full.counterHold?.at) && !(theirs > 0 && theirs < (Number(full.counterHold.theirs) || Infinity));
      // "Can't go any less than that": there's nothing for a check-in to move.
      // Our number goes once all the same, and the offer is theirs to pass on.
      const firm = theirs > 0 && floorFirmness(job.originalMessage || job.message) === "firm";
      counterHold = { offerId: full.id, ours: hold.amount, theirs, again, ...(firm ? { firm: true } : {}) };
      // holdNumber's words, written like a text: a dollar sign trips the
      // carrier filters (the gates hold it), so the number goes bare.
      const n = hold.amount.toLocaleString("en-US");
      draft = { ...draft, needsHuman: false, counterHold,
        reply: again ? `Understood. We're still at ${n} on ${where}; if anything changes on the seller's side, I'm here.`
          : `Appreciate you working it. On ${where} we're going to hold at ${n}: that's where the numbers work for us. If the seller can get there, we're ready to go.` };
    } else if (!theirs && !comeUp && !moneyIn(job.originalMessage || job.message).length && !moneyIn(draft.reply).length
        && WILL_ASK_RX.test(job.originalMessage || job.message)) {
      // Only what Matt authorised: no number from them, none in ours, no ask
      // for more — and they said they'd go ask ("I could ask what they'd take").
      draft = { ...draft, intent: "status_check", reclassifiedFrom: "counter" };
      job.intent = draft.intent;
    }
  }
  // A house that's done — we passed, or they did and say their number again —
  // and their number still above the one we sent (Matt, 2026-10-22: "Bot
  // holds our number"; two counters waited 46 hours on "the machine never
  // goes above what we sent — your call"). Ours once more, short, and nothing
  // reopens: no hold clock, no check-ins. Said once: when our last word on it
  // already was "still at N", the draft waits quietly — never a second
  // goodbye (Melissa W., 2026-10-20). A text that asks our number or names
  // another house is still a person's.
  if (party === "agent" && !isCall && draft.intent === "counter" && holdOn && !counterHold && !draft.callCounter) {
    const msg = job.originalMessage || job.message;
    const book = await store.listOffers(locationId, { contactId: job.contactId, limit: 50, lean: true }).catch(() => []);
    const shut = (book || []).filter((o) => o && !o.deal && (["we_passed", "no_response"].includes(offerStatus(o))
      || (offerStatus(o) === "passed" && draft.passHeld?.passed)));
    const pick = pickOfferByAddress(shut, draft.propertyAddress) || (shut.length === 1 && !draft.propertyAddress ? shut[0] : null);
    const closed = pick && typeof store.getOffer === "function" ? (await store.getOffer(pick.id).catch(() => null)) || pick : pick;
    const hold = closed ? holdNumber({ offer: closed, transcript: a.transcript || "" }) : null;
    const theirs = Math.round(Number(draft.counterAmount) || 0);
    const aboutThisOnly = !asksOurNumber(msg) && !housesInText({ message: msg, except: [closed?.address || ""] }).length;
    if (hold && aboutThisOnly && (theirs > hold.amount || (!theirs && asksUsToComeUp(msg)))) {
      const n = hold.amount.toLocaleString("en-US");
      const where = String(closed.address || "").split(",")[0].trim() || "the house";
      const saidIt = new RegExp(`still at \\$?${n}\\b`, "i").test(a.transcript || "");
      const closedHold = { offerId: closed.id, ours: hold.amount, theirs, ...(saidIt ? { quiet: true } : {}) };
      draft = saidIt
        ? { ...draft, needsHuman: false, closedHold, humanReason: `we already told them we're still at ${n} on ${where}; nothing more to say` }
        : { ...draft, needsHuman: false, closedHold, humanReason: "",
          reply: `Understood. We're still at ${n} on ${where}; if anything changes on the seller's side, I'm here.` };
    }
  }

  // Turnkey is not a deal. "This one is pretty turnkey with tenants in place"
  // answers our "project or turnkey?" and read as deal_available — the listing
  // IS available — so Karamveer Tiwana and Angie Bomar (2026-09-14) were moved
  // to Tier 1 and a renovated house was sent to underwriting. A deal is a
  // house that needs work; a turnkey one is "nothing right now, stay in
  // touch", which is Tier 2.
  // Read across their burst, not just this text: the "not a flip" and the
  // "come take a look" arrive as two texts and two jobs.
  const notOurKind = party === "agent" && isTurnkeyReply(theirLatestWords(a.transcript, job.message));
  if (party === "agent" && ["deal_available", "new_property"].includes(draft.intent) && notOurKind) {
    draft = { ...draft, intent: "investor_open", reclassifiedFrom: draft.intent };
    job.intent = draft.intent;
  }

  // Qualify first (shared/flip-read.js, Matt 2026-10-08). The house our
  // first text opened with is an icebreaker: "it's a project" or "come take
  // a look" about it buys one short question, not an underwrite, and a vague
  // answer to that is a pass and an ask for what else they've got. Specific
  // trouble underwrites at once. A house they bring up themselves isn't
  // read here, and neither is one we've already priced.
  // Every house they named that isn't the first-text one (2026-10-13): each
  // is kept (4c″), one with no number is asked for, and the qualify step
  // below leaves the message alone.
  // Only on a text that reads as a lead: "the one on Pine St sold" is not
  // a house to ask about.
  // On a call (2026-10-14: "I'll have one up in Mount Vernon in a few
  // weeks" was said on the phone and never kept) only their side counts
  // when the transcript says whose words are whose; a call covers many
  // things, so its intent doesn't gate it, and a house already in our book
  // is the one we were talking about. With no speaker labels our own words
  // are in there too: the houses are kept and asked about, never underwritten.
  const heard = isCall ? callWords(inboundText) : { words: job.message, labelled: true };
  const callBook = isCall && party === "agent"
    ? ((await store.listOffers(locationId, { contactId: job.contactId, limit: 50, lean: true }).catch(() => [])) || []).map((o) => o?.address).filter(Boolean)
    : [];
  const namedHouses = party === "agent" && (isCall ? !SILENT_INTENTS.has(draft.intent) : HOUSE_LEAD_INTENTS.has(draft.intent))
    // The model reads both sides of a call: on a labelled one, only the houses they said.
    ? housesInText({ houses: isCall && heard.labelled ? (draft.houses || []).filter((h) => saidIn(heard.words, h?.address)) : draft.houses,
      message: heard.words, except: [...(iceHouse ? [iceHouse.address] : []), ...callBook] })
    : [];
  const housesWithoutNumber = namedHouses.filter((h) => h.needsAddress);
  // The houses they named with a full address, in their own words, that
  // aren't in the book yet: each a skeleton in skeleton mode (2026-10-19).
  const skeletonHouses = async () => {
    if (party !== "agent" || (isCall && !heard.labelled) || draft.intent === "opt_out") return [];
    // A flyer's address is theirs whatever the model made of the text, and
    // it is the whole address: the text's shorter reading of the same line
    // ("13645 3rd Ave" off "[photo → 13645 3rd Ave S, Burien, WA 98168]") gives way to it.
    const photos = job.photoAddresses || [];
    const line = (x) => normalizeUsAddress(String(x || "").split(",")[0]).toLowerCase();
    const covered = (h) => photos.some((p) => sameHouse(h.address || "", p) || `${line(p)} `.startsWith(`${line(h.address)} `));
    const fresh = [...namedHouses.filter((h) => !covered(h)), ...photos.map((address) => ({ address }))].filter((h) => h.address && !h.needsAddress && hasHouseNumber(h.address) && lastMention(heard.words, h.address) >= 0);
    if (!fresh.length) return [];
    const rows = await store.listOffers(locationId, { contactId: job.contactId, limit: 50, lean: true }).catch(() => []);
    return fresh.filter((x) => !knownOfferFor(rows, x.address, now)).slice(0, 5);
  };

  let qualify = null;
  if (party === "agent" && !isCall && !notOurKind && config.parties.agent.qualifyFirst?.enabled
      && !SILENT_INTENTS.has(draft.intent)
      && (["deal_available", "new_property", "wants_walkthrough"].includes(draft.intent) || isShowingOffer(job.message))
      && !["counter", "acceptance", "rejection", "realm_yes", "proof_of_funds", "opt_out"].includes(draft.intent)) {
    const take = draft.agentTake ?? normalizeAgentTake(draft) ?? agentTakeFromText(job.message);
    qualify = await qualifyIcebreaker({ store, locationId, contactId: job.contactId, draft, message: job.message, transcript: a.transcript, now, agentRehab: qualifyRehab(take, job.message), ice: iceHouse, callAsk: Boolean(callAsk) })
      .catch((e) => { warnings.push(`qualify: ${e.message}`); return null; });
  }
  // A house they raised themselves (2026-10-16, qualifyFirst.brought): the
  // same screen, a little kinder (shared/flip-read.js broughtStep). Their
  // own house unclear after our question still goes to Matt.
  if (!qualify && party === "agent" && !isCall && !notOurKind && config.parties.agent.qualifyFirst?.brought
      && ["deal_available", "new_property"].includes(draft.intent) && !isShowingOffer(job.message)) {
    const take = draft.agentTake ?? normalizeAgentTake(draft) ?? agentTakeFromText(job.message);
    qualify = await qualifyBrought({ store, locationId, contactId: job.contactId, draft, message: job.message, transcript: a.transcript, now, agentRehab: qualifyRehab(take, job.message), ice: iceHouse, callAsk: Boolean(callAsk) })
      .catch((e) => { warnings.push(`qualify: ${e.message}`); return null; });
  }
  if (qualify) {
    if (qualify.stage !== "qualified") {
      draft = {
        ...draft,
        intent: qualify.stage === "ask" ? "deal_available" : "investor_open",
        reclassifiedFrom: draft.reclassifiedFrom || draft.intent,
        propertyAddress: draft.propertyAddress || qualify.address,
        needsHuman: false,
        reply: qualify.reply,
        qualify: { stage: qualify.stage, address: qualify.address, why: qualify.why },
      };
      job.intent = draft.intent;
    } else if (qualify) {
      draft = { ...draft, qualify: { stage: "qualified", address: qualify.address, why: qualify.why } };
    }
  }
  const qualifyHeld = Boolean(qualify && qualify.stage !== "qualified");

  // A house they named with no number: the reply asks where it is. The model
  // is told to; this is the backstop for a reply that forgot (a list of two
  // ran against "one property per message"). After a call too: the text
  // after hanging up is where the ask goes.
  if (party === "agent" && housesWithoutNumber.length && !qualifyHeld
      && !SILENT_INTENTS.has(draft.intent) && draft.intent !== "opt_out" && !asksForAddress(draft.reply)) {
    const ask = addressAsk(housesWithoutNumber);
    const said = String(draft.reply || "").trim();
    draft = { ...draft, reply: said ? `${said} ${ask}` : ask, addressAsked: housesWithoutNumber.map((h) => h.address) };
  }

  // Number first. An agent offering a showing, a tour or a time on a house we
  // have no number on gets a number before anybody books anything — Matt,
  // 2026-09-14: "even if he asks for a time to schedule, lets push back and
  // get him a number first to see if it makes sense." Velia Sierra offered a
  // private tour of a remodeled triplex; it read as turnkey (Tier 2, no
  // underwrite) and a showing (notify-only), so nothing ran and nobody replied.
  // Turnkey still files as Tier 2 — this only adds the underwrite and the
  // reply that says so. A house we already priced is left alone: the offer is
  // the conversation there.
  let numberFirst = null;
  // An agent opening the door on a live house (2026-10-15, agents work for
  // us): booking it, calling, or passing is Matt's. The reply waits for him
  // (the "more finished than what we buy" line is drafted, never sent by
  // itself). A house they told us was turnkey before this, or one that's
  // closed, gets the line as it always did.
  const holdForShowing = (street) => {
    draft = { ...draft, needsHuman: true, showingOffered: { address: draft.propertyAddress },
      humanReason: `they offered a showing on ${street || "the house"} — yours: book it, call them, or pass` };
  };
  if (party === "agent" && !qualifyHeld && !SILENT_INTENTS.has(draft.intent)
      && !["counter", "acceptance", "rejection", "realm_yes", "proof_of_funds", "opt_out"].includes(draft.intent)
      // A showing, not a call: "give me a call tomorrow" stays with the calendar.
      && (draft.intent === "wants_walkthrough" || isShowingOffer(job.message))
      && underwritableAddress(draft.propertyAddress)) {
    const rows = await store.listOffers(locationId, { contactId: job.contactId, limit: 50, lean: true }).catch(() => []);
    const known = knownOfferFor(rows, draft.propertyAddress, now);
    const street = String(draft.propertyAddress || "").split(",")[0].trim();
    // Ruled turnkey before this message (their property details on record).
    const ruledBefore = notOurKind
      ? agentRuledOut(await store.listContactEvents?.(locationId, job.contactId, { limit: 200 }).catch(() => []) || [], draft.propertyAddress)
      : null;
    if (known && known.status !== "draft" && OPEN_OFFER_STATUSES.has(offerStatus(known))) {
      // A house we priced and they're still working: the showing is the next step, and it's Matt's.
      holdForShowing(street);
    } else if (!known || known.status === "draft") {
      if (notOurKind) {
        // They've told us it needs nothing: not a number to chase (Matt,
        // 2026-10-05: the underwrite spends credits on a house we won't buy,
        // and "let me run the numbers" promises one). Say what we do buy.
        draft = {
          ...draft,
          intent: "investor_open",
          reclassifiedFrom: draft.reclassifiedFrom || draft.intent,
          needsHuman: false,
          notOurKind: true,
          reply: "Appreciate it, but that one sounds more finished than what we buy. We go after houses that need real work, so if something rough crosses your desk, I'd love a first look.",
        };
        if (!ruledBefore) holdForShowing(street);
      } else if (underwriteMode(saved) !== "full") {
        // Draft only (2026-10-16): Matt prices it, so a showing is his to
        // book — not "let me run the numbers first", which put off 42
        // walkthroughs in the review. The draft is still made, so the house
        // is ready to price when he looks.
        // Reclassified like number-first, so the heads-up-only path for a
        // scheduling reply doesn't swallow the draft's action.
        numberFirst = { replaceOfferId: known?.id || null, showing: true };
        draft = {
          ...draft,
          intent: draft.intent === "investor_open" ? "investor_open" : "deal_available",
          reclassifiedFrom: draft.reclassifiedFrom || draft.intent,
        };
        holdForShowing(street);
      } else {
        numberFirst = { replaceOfferId: known?.id || null };
        draft = {
          ...draft,
          intent: draft.intent === "investor_open" ? "investor_open" : "deal_available",
          reclassifiedFrom: draft.reclassifiedFrom || draft.intent,
          needsHuman: false,
          numberFirst: true,
          reply: `Appreciate that. Before we set up a time, let me run the numbers on ${street || "it"} so nobody's time gets wasted. I'll text you where we'd be once they're done.`,
        };
      }
      job.intent = draft.intent;
    }
  }

  // "Other" with real information in it — Diane Tien's developer terms, Angie
  // Bomar's park manager and "best time to call is morning" (2026-09-14) — sat
  // silent as "a person's call". A confident read that asks nothing of us gets
  // its acknowledgement out, and a note puts the substance in front of a person.
  // "I'll run it by them and get back to you" (Julie Nutley, 2026-09-15) read
  // as a medium "other" and sat. They're taking our number to the seller:
  // nothing to decide, so the thanks goes, and 4c′ books the check-in.
  if (party === "agent" && draft.intent === "other" && !draft.needsHuman && String(draft.reply || "").trim() && takingItToSeller(job.message, now)) {
    draft = { ...draft, intent: "status_check", reclassifiedFrom: "other" };
    job.intent = draft.intent;
  }
  // An answer to our first text that fits no intent — an agent's "Its
  // for sale", Michael Lindekugel's "Not my place to judge the condition"
  // (2026-09-15) — sat as "a person's call" and the thread stalled. It is
  // them answering us: the reply that keeps it going sends, provided it names
  // no number of ours.
  if (party === "agent" && draft.intent === "other" && !draft.needsHuman && String(draft.reply || "").trim()
    && !moneyIn(draft.reply).length && (await lastLineIsOurFirstText({ store, locationId, contactId: job.contactId, transcript: a.transcript }))) {
    draft = { ...draft, intent: "question", reclassifiedFrom: "other" };
    job.intent = draft.intent;
  }
  if (party === "agent" && draft.intent === "other" && draft.confidence === "high" && !draft.needsHuman && String(draft.reply || "").trim()) {
    draft = { ...draft, intent: "question", reclassifiedFrom: "other" };
    job.intent = draft.intent;
    await createContactNote(client, job.contactId, {
      body: `Needs you — the bot acknowledged it, the substance is yours: ${String(draft.summary || job.message || "").slice(0, 400)}`,
    }).catch(() => {});
  }

  // The call ask's backstop (2026-10-15): their first answer, and the model
  // didn't close with it. Not when they brought us a house of their own (that
  // house is the lead), not on a canned qualify or number-first text, not on
  // a reply that turned the conversation (a counter, a yes, a no-contact).
  const theirHouse = Boolean(namedHouses.length) || (Boolean(draft.propertyAddress) && Boolean(iceHouse?.address) && !sameStreet(draft.propertyAddress, iceHouse.address));
  if (callAsk?.first && !qualifyHeld && !numberFirst && !theirHouse && !CALL_ASK_SKIP_INTENTS.has(draft.intent)
      && String(draft.reply || "").trim() && !CALL_ASK_RX.test(draft.reply)) {
    draft = { ...draft, reply: withCallAsk(draft.reply, openerVariant(job.contactId, 3)), callAskAdded: true };
  } else if (!callOn && firstAnswer?.first && !qualifyHeld && !numberFirst && !theirHouse && !CALL_ASK_SKIP_INTENTS.has(draft.intent)
      && String(draft.reply || "").trim() && !FIXERS_ASK_RX.test(draft.reply)) {
    draft = { ...draft, reply: withFixersAsk(draft.reply, openerVariant(job.contactId, 3)), fixersAskAdded: true };
  }

  // The model read an opt-out the keywords didn't catch ("lose my number",
  // plain anger). Same outcome as the keyword: silence and the tag.
  if (SILENT_INTENTS.has(draft.intent)) {
    await handleOptOut(job, { ...ctx, config, party, partySource: a.partySource, matchedTags: a.matchedTags, confidence: draft.confidence, reason: draft.summary || "the model read an opt-out" });
    return;
  }

  // The buyer walkthrough (shared/showing.js). A buyer's answer about
  // walking a house we hold is filed on the deal whatever happens to the
  // reply — "I can make Saturday" must not live only in a thread.
  const walkDeal = party === "investor" ? walkthroughDealFor(context?.deals, draft.propertyAddress) : null;
  if (walkDeal && draft.walkthrough && deps.recordShowingRsvp) {
    await deps.recordShowingRsvp({ offerId: walkDeal.offerId, contactId: job.contactId, name: a.contactName || "", status: draft.walkthrough })
      .catch((e) => warnings.push(`walkthrough answer not filed: ${e.message}`));
  }

  // Wanting to walk it or buy it puts them on the deal, whatever becomes of
  // the reply. James Knopf (2026-09-29) asked to "pop by after 5:00 one
  // night" on 3511 NE 153rd St; the notice below returned before the
  // playbook's link ran, so he was the one interested buyer not on the deal.
  // Linking only records them — it sends nothing.
  //
  // Since 2026-10-01 any reply about a deal does the same (dealReplyFiling):
  // a question or interest puts them on it as evaluating, a pass as passed.
  let filedOnDeal = null;
  const filing = party === "investor"
    ? dealReplyFiling({ intent: draft.intent, propertyAddress: draft.propertyAddress, passReason: draft.passReason, linkedDeals: context?.deals?.linked })
    : null;
  if (filing && deps.linkDealInterest) {
    const r = await deps.linkDealInterest({ contactId: job.contactId, addressHint: draft.propertyAddress || walkDeal?.address || "", said: job.originalMessage || job.message || "", ...filing })
      .catch((e) => { warnings.push(`not put on the deal: ${e.message}`); return null; });
    if (r?.ok) filedOnDeal = filing.status;
  }

  // They asked for it by email (2026-10-15): the deal they're on goes to them
  // as an email, drafted like a wave's (routes/dispo.js emailDealToBuyer). It
  // waits in the outbox unless emailed deals send themselves, so the reply
  // must not say it went — CLAIMS_EMAIL_RX below holds one that does.
  if (job.dealsByEmail && draft.intent !== "passing") {
    const deal = dealToEmailFor(context?.deals, draft.propertyAddress || walkDeal?.address || "");
    if (!job.dealsByEmail.hasEmail) warnings.push("they want deals by email and we have no address for them — ask for it");
    else if (deal && deps.emailDealTo) {
      const r = await deps.emailDealTo({ contactId: job.contactId, offerId: deal.offerId })
        .catch((e) => ({ ok: false, reason: String(e?.message || e).slice(0, 120) }));
      warnings.push(r?.ok
        ? `${deal.address} ${r.status === "scheduled" ? "is scheduled to go" : "is in the outbox"} to them by email`
        : `they asked for ${deal.address} by email and it wasn't drafted: ${r?.reason || "unknown"}`);
    }
  }

  // A walkthrough, a call, a time: yours by design, and therefore a draft
  // that was never going to be sent. The heads-up is the useful output. The
  // calendar is the exception — once it is wired it can answer a time for
  // real, so the draft stands and the guard decides. So is a buyer who wants
  // to walk a house we have under contract (Matt, 2026-09-29): getting them
  // out there is the job, so the reply is written for a person to send —
  // wants_walkthrough stays NEVER_AUTO, so it is never sent on its own.
  const bookingCouldAnswer = Boolean(booking) && (BOOKING_INTENTS[party] || []).includes(draft.intent);
  const walkthroughDraft = Boolean(walkDeal) && draft.intent === "wants_walkthrough";
  if ((config.notifyOnly || []).includes(draft.intent) && !bookingCouldAnswer && !walkthroughDraft) {
    // "Call me about 1412 Pine and 88 Alder": the call is yours, and each
    // house is still a skeleton for you to look at before you dial
    // (skeleton mode, 2026-10-19). Nothing else of the plan runs here.
    if (party === "agent" && underwriteMode(saved) === "skeleton" && !notOurKind && typeof deps.startUnderwrite === "function") {
      for (const h of await skeletonHouses()) {
        const r = await deps.startUnderwrite({ contactId: job.contactId, message: job.message, address: h.address, askingPrice: h.sellerAsk || 0 })
          .catch((e) => ({ skipped: String(e?.message || e).slice(0, 120) }));
        if (r?.skipped) warnings.push(`skeleton for ${h.address}: ${r.skipped}`);
      }
    }
    await handleNotifyOnly(job, { ...ctx, config, party, partySource: a.partySource, matchedTags: a.matchedTags, draft });
    return;
  }

  // A voicemail an agent left about a live house (call-intake.js call.missed).
  let missedCallHouse = "";
  if (isCall && job.call?.missed && party === "agent") {
    const book = await store.listOffers(locationId, { contactId: job.contactId, limit: 50, lean: true }).catch(() => []);
    const live = liveHouse({ offers: book || [], now });
    if (live) {
      missedCallHouse = String(live.address || "their house").split(",")[0].trim();
      draft = { ...draft, needsHuman: true, humanReason: `they called about ${missedCallHouse} and left a voicemail — call them back before any text` };
    }
  }

  // A yes after we passed (2026-10-15). The seller took our number on a
  // house we had walked from; the model, told we walked away, answered
  // "We've actually moved on". Whatever the model filed it as, the reply
  // waits for Matt — reopening it is his call — and Today says why.
  let yesAfterPass = null;
  // Their timeline, kept for the gate's "what they said it's worth".
  let agentEvents = [];
  if (party === "agent" && !isCall) {
    const [book, earlier, timeline] = await Promise.all([
      store.listOffers(locationId, { contactId: job.contactId, limit: 50, lean: true }).catch(() => []),
      store.listReplyDrafts(locationId, { contactId: job.contactId, limit: 50 }).catch(() => []),
      typeof store.listContactEvents === "function" ? store.listContactEvents(locationId, job.contactId, { limit: 200 }).catch(() => []) : [],
    ]);
    agentEvents = timeline || [];
    yesAfterPass = yesAfterOurPass({ offers: book || [], drafts: earlier || [], events: timeline || [], draft, message: job.originalMessage || job.message, now });
    if (yesAfterPass) {
      const where = String(yesAfterPass.address || "the house").split(",")[0].trim();
      draft = { ...draft, needsHuman: true, yesAfterPass,
        humanReason: `they said yes to our ${fmtMoney(yesAfterPass.amount)} on ${where} after we passed on it — reopening it is your call; never answer a yes with a goodbye` };
    }
  }

  // "Did you look at the photos?" to our question about the work (Albert C.,
  // 3932 S Angeline St, 2026-10-16: new construction, and the bot answered
  // with 647K fixed up). They're telling us it's done: the reply is our pass
  // with the ask for their other houses (shared/flip-read.js
  // pointsToThePhotos), and it files the way our own pass does
  // (replyPassed). Not once a number on it went out: that's a conversation.
  let photosPass = false;
  if (party === "agent" && !isCall && !qualifyHeld && !numberFirst && !notOurKind && !yesAfterPass
      && !SILENT_INTENTS.has(draft.intent) && !["counter", "acceptance", "rejection", "realm_yes", "proof_of_funds", "opt_out"].includes(draft.intent)
      && pointsToThePhotos(theirLatestWords(a.transcript, job.message), lastOutbound(a.transcript)?.text || "")) {
    const address = draft.propertyAddress || iceHouse?.address || "";
    const rows = await store.listOffers(locationId, { contactId: job.contactId, limit: 50, lean: true }).catch(() => []);
    const known = address ? knownOfferFor(rows, address, now) : null;
    if (!known || ["draft", "new"].includes(offerStatus(known))) {
      photosPass = true;
      draft = {
        ...draft,
        intent: "deal_available",
        reclassifiedFrom: draft.reclassifiedFrom || draft.intent,
        propertyAddress: address,
        needsHuman: false,
        reply: photosPassReply({ variant: openerVariant(job.contactId, 3), callAsk: Boolean(callAsk) }),
      };
      job.intent = draft.intent;
    }
  }

  // Partner terms are Matt's: the reply waits for him whatever else rewrote
  // it above, and a person's flag keeps a redraft from being spent on it.
  if (terms) {
    draft = { ...draft, partnerTerms: terms, needsHuman: true, humanReason: `they ${PARTNER_TERMS_LABEL[terms.kind]} — the terms are yours to answer` };
  }
  const gateFor = (d) => evaluateReplyGates({ minConfidence: config.autoSend?.minConfidence, holdOnNeedsHuman: config.autoSend?.holdOnNeedsHuman,
    draft: d, party, allowedAmounts: context.amounts, forbiddenAmounts: context.forbiddenAmounts, staleAmounts: context.staleAmounts || [],
    hiddenAmounts: context.hiddenAmounts || [], ranges: context.ranges || [], inboundMessage: inboundText, channel: job.channel, style: config.style,
    selfName: a.signer, contactName: a.contactName, signOff: config.persona?.signOff, botAnswer: config.persona?.ifAskedIfBot,
    ourAmount: ourNumberFor(context.offers?.numbers, d.propertyAddress),
    writeUpOk: writeUpOkFor(context.offers?.numbers, d.propertyAddress),
    vacantOk: vacantPerRecord(context?.deals, d.propertyAddress),
    houseWords: houseWordsFor(context?.deals, a.transcript, inboundText),
    theirValue: party === "agent" ? theirValueFor({ draft: d, message: isCall ? "" : job.message, events: agentEvents, address: d.propertyAddress }) : 0,
    ourValue: ourValueFor(context.offers?.numbers, d.propertyAddress),
  });
  let gate = gateFor(draft);
  // A draft a content gate caught — a number not in the book, "cash close",
  // "assignment", too long — is written once more, told exactly what held
  // it. The same gates judge the rewrite: clean, it carries on as any clean
  // draft would; still caught, the first draft and its reasons stay for Matt.
  if (replyArgs && !a.hold?.held && !photosPass) {
    const r = await redraftOnGate({ draft, gate, gateFor, config, redraft: (fix) => deps.draft({ ...replyArgs, fix }) });
    draft = r.draft; gate = r.gate;
  }
  // Our reply passes on the house (Matt, 2026-10-14). "Sounds mostly
  // cosmetic, probably not enough meat for us" went out tagged
  // deal_available, and the intent alone ran Tier 1 — tag, TIER 1 workflow,
  // an underwrite — for a house we'd just turned down (Dana F.'s
  // Welfare Ave, Korey P.'s turnkey Puyallup). What we said wins: it files
  // as "nothing right now" (Tier 2), the house is stamped passed so a racing
  // underwrite stops (threadPassed), and an unsent offer on it is closed.
  // Never on a yes (2026-10-15): a reply that turns down a house they just
  // said yes on is the bot's mistake, not our decision.
  const replyPassed = party === "agent" && !qualifyHeld && !numberFirst && !notOurKind && !yesAfterPass
    && ["deal_available", "new_property"].includes(draft.intent) && (photosPass || ourReplyPasses(draft.reply))
    && !saysYes(job.originalMessage || job.message);
  if (replyPassed) {
    draft = {
      ...draft,
      intent: "investor_open",
      reclassifiedFrom: draft.reclassifiedFrom || draft.intent,
      ...(draft.propertyAddress ? { qualify: { stage: "pass", address: draft.propertyAddress, why: photosPass ? "they pointed us to the photos" : "our reply passed on it" } } : {}),
    };
    job.intent = draft.intent;
    gate = gateFor(draft);
  }
  let base = decideAutoSend({ gate, party, intent: draft.intent, channel: job.channel, config, sendsEnabled, humanActive: a.humanActive, hold: a.hold });
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
    : await evaluateBandFor({ store, locationId, party, draft, config, saved, job, now, transcript: a.transcript });
  // A booking guard on an intent that is not itself locked (a "question"
  // that picks a time) has nothing to release; the pass still books.
  let auto = releaseUnderGuard({ base, party, intent: draft.intent, config, guard });
  auto = releaseForAudit({ auto, gate, draft, deps });
  auto = releaseOtherNow({ auto, base, gate, draft, party, config, channel: job.channel, isCall });
  // The hold is our number said once, and nothing more: the one counter
  // reply the machine sends. Only where every other check passed and the
  // counter's own lock is all that held it — never past a gate, a stop, a
  // person having the thread, or sends off — and never naming more than ours.
  // The same door for ours said again on a house that's done (closedHold),
  // except when it was already said: that one waits quietly.
  const heldOurs = draft.counterHold || (draft.closedHold && !draft.closedHold.quiet ? draft.closedHold : null);
  if (heldOurs && !auto.send && base.code === "never_auto" && !gate?.overOffer?.length && !isCall
      && (config.autoSend?.channels || []).includes(job.channel)
      && moneyIn(draft.reply).every((n) => n <= heldOurs.ours)) {
    auto = draft.counterHold
      ? { ...auto, send: true, code: "", reason: "our number, held — hold, then pass", counterHold: true }
      : { ...auto, send: true, code: "", reason: "our number again on a house that's done — nothing reopens" };
  }
  // Confused by us or repeating themselves (Kyle R., 2026-10-10): the
  // machine already lost the thread once, so it doesn't answer for you.
  if (auto.send && party === "agent" && soundsCrossedUp(theirLatestWords(a.transcript, job.message))) {
    auto = { ...auto, send: false, code: "needs_you", reason: "they sound confused, or say they already told us — you take this one" };
  }
  // Their yes on a house we walked from never gets a reply by itself.
  if (yesAfterPass) {
    auto = { ...auto, send: false, code: "needs_you", reason: "they said yes after we passed — you take this one" };
  }
  // An agent with a live house called and left a voicemail (2026-10-15): a
  // call back from Matt first (the Desk's "they called you" row), so the text
  // after it waits for him.
  if (missedCallHouse) {
    auto = { ...auto, send: false, code: "needs_you", reason: `they called about ${missedCallHouse} and left a voicemail — call them back` };
  }
  const bookingVerdict = guard?.kind === "booking" ? guard : null;
  const autoWithVerdict = bookingVerdict && !auto.exception ? { ...auto, exception: bookingVerdict } : auto;
  const plan = playbook ? planActions({ party, intent: draft.intent, confidence: draft.confidence, playbook, minConfidence: config.autoSend?.minConfidence }) : { auto: [], suggested: [] };
  // Filed above: the playbook's own link or pass would only write it twice.
  const filedAction = filedOnDeal === "evaluating" ? "link_deal_evaluating" : filedOnDeal === "passed" ? "mark_investor_passed" : null;
  if (filedAction) {
    plan.auto = plan.auto.filter((x) => x.type !== filedAction);
    plan.suggested = plan.suggested.filter((x) => x.type !== filedAction);
  }
  // A house we already passed stays passed while its repeat waits for a
  // person: filed "countered", the next repeat would draw the goodbye again.
  if (draft.passHeld?.passed || draft.closedHold) {
    plan.auto = plan.auto.filter((x) => x.type !== "mark_offer_countered");
  }
  // Number first: the reply promises numbers, so the underwrite runs whatever
  // the tier's rule carries (Tier 2 carries none) — replacing a held draft
  // rather than standing down behind it.
  // A soft floor still files their number on the offer.
  if (softFloor && !plan.auto.some((x) => x.type === "mark_offer_countered")) {
    plan.auto.push({ id: `a-soft-${job.id}`, type: "mark_offer_countered", mode: "auto", status: "pending", party,
      why: "they named a number but sound open — asked for their value and repairs" });
  }
  // Their floor is firm and over our number (Matt, 2026-10-09, 184th St SE:
  // "this should be they passed"). The hold is the last word on it; the
  // offer is marked they passed instead of riding the check-in clock. Only
  // when the hold goes out — a hold waiting for a person is theirs to call.
  if (auto.counterHold && draft.counterHold?.firm && !plan.auto.some((x) => x.type === "mark_offer_passed")) {
    plan.auto.push({ id: `a-firm-${job.id}`, type: "mark_offer_passed", mode: "auto", status: "pending", party,
      why: `their floor is firm at ${fmtMoney(draft.counterHold.theirs)}, over our ${fmtMoney(draft.counterHold.ours)} — we held; they passed` });
  }
  // A seller saying yes is the most important text of the week. Whatever the
  // guard decides about replying, the contact is tagged so it can't sit.
  if (party === "agent" && draft.intent === "acceptance" && !plan.auto.some((x) => x.type === "add_tags" && (x.tags || []).includes("seller-accepted"))) {
    plan.auto.push({ id: `a-acc-${job.id}`, type: "add_tags", mode: "auto", status: "pending", party, tags: ["seller-accepted"],
      why: "the seller accepted — send the contract" });
  }
  // Not our kind of house, in their words: no rule spends a credit on it.
  if (notOurKind) {
    plan.auto = plan.auto.filter((x) => x.type !== "start_underwrite");
    plan.suggested = plan.suggested.filter((x) => x.type !== "start_underwrite");
  }
  // A house is coming and they gave no address (Kyle R., 2026-10-05: a flip
  // "if you're interested"). The underwrite would fall back to the Subject
  // Property — the last house, which he'd called turnkey — and quote it. The
  // address chase asks; the underwrite starts when the address lands.
  // "Pine St, Shelton" is what the message is about, but it's a street, not
  // a house: the underwriter can't place it and would fall back to the
  // Subject Property. The reply asks for the number instead.
  if (party === "agent" && (addressPending({ intent: draft.intent, propertyAddress: draft.propertyAddress, message: job.message, now })
      || (housesWithoutNumber.length && !underwritableAddress(draft.propertyAddress)))) {
    plan.auto = plan.auto.filter((x) => x.type !== "start_underwrite");
    plan.suggested = plan.suggested.filter((x) => x.type !== "start_underwrite");
  }
  // Still qualifying the icebreaker house: no credits, and no Tier 1 yet.
  if (qualifyHeld) {
    plan.auto = plan.auto.filter((x) => x.type !== "start_underwrite" && !isTierOneAction(x));
    plan.suggested = plan.suggested.filter((x) => x.type !== "start_underwrite" && !isTierOneAction(x));
  }
  // We passed on it in this reply: no credits, no Tier 1, and a number we
  // priced and never sent on it is closed, so it can't hold their card in
  // Tier 1 (Korey P.'s turnkey Puyallup, 2026-10-06).
  if (replyPassed) {
    plan.auto = plan.auto.filter((x) => x.type !== "start_underwrite" && !isTierOneAction(x));
    plan.suggested = plan.suggested.filter((x) => x.type !== "start_underwrite" && !isTierOneAction(x));
    if (draft.propertyAddress) {
      plan.auto.push({ id: `a-unsent-${job.id}`, type: "retire_unsent_offer", mode: "auto", status: "pending", party,
        why: "our reply passed on the house — a number we never sent on it closes" });
    }
  }
  // Two houses with numbers in one text ("Pine is 1412 Pine St and the
  // triplex is 88 Alder St"): the rule underwrites the one in
  // propertyAddress, and each of the others runs beside it the same way.
  // Only when the rule already starts one, only streets in their own words,
  // and never a house already in the book. On a call, only one they said
  // in their own lines: with no speaker labels it gets the address ask, never an underwrite.
  if (party === "agent" && (!isCall || heard.labelled) && plan.auto.some((x) => x.type === "start_underwrite" && !x.address)) {
    const extra = namedHouses.filter((h) => h.from === "model" && !h.needsAddress && !sameStreet(h.address, draft.propertyAddress) && lastMention(heard.words, h.address) >= 0);
    if (extra.length) {
      const rows = await store.listOffers(locationId, { contactId: job.contactId, limit: 50, lean: true }).catch(() => []);
      for (const h of extra.filter((x) => !knownOfferFor(rows, x.address, now)).slice(0, 3)) {
        plan.auto.push({ id: `a-uw-${job.id}-${addressKey(h.address).slice(0, 24)}`, type: "start_underwrite", mode: "auto", status: "pending", party,
          address: h.address, askingPrice: h.sellerAsk || 0, why: `they named ${h.address} too` });
      }
    }
  }
  // Skeleton mode (Matt, 2026-10-19: "when someone mentions a property can
  // we make a draft for that"): every house they name with a full address is
  // a skeleton for him to eyeball and mark, not only the one the rule would
  // underwrite. Not one this reply already answered — passed on, called
  // turnkey, or still asking its one question about — and never a house
  // already in the book. Their own words only, as above.
  if (party === "agent" && underwriteMode(saved) === "skeleton" && !notOurKind && !replyPassed && !qualifyHeld) {
    const planned = new Set(plan.auto.filter((x) => x.type === "start_underwrite").map((x) => addressKey(x.address || draft.propertyAddress || "")).filter(Boolean));
    for (const h of (await skeletonHouses()).filter((x) => !planned.has(addressKey(x.address)))) {
      plan.auto.push({ id: `a-sk-${job.id}-${addressKey(h.address).slice(0, 24)}`, type: "start_underwrite", mode: "auto", status: "pending", party,
        address: h.address, askingPrice: h.sellerAsk || 0, why: `they named ${h.address} — a skeleton for you to look at` });
    }
  }
  if (numberFirst) {
    const extra = numberFirst.replaceOfferId ? { replaceOfferId: numberFirst.replaceOfferId } : {};
    if (plan.auto.some((x) => x.type === "start_underwrite")) {
      plan.auto = plan.auto.map((x) => (x.type === "start_underwrite" ? { ...x, ...extra } : x));
    } else {
      plan.suggested = plan.suggested.filter((x) => x.type !== "start_underwrite");
      plan.auto.push({ id: `a-nf-${job.id}`, type: "start_underwrite", mode: "auto", status: "pending", party, ...extra,
        why: numberFirst.showing ? "they offered a showing — the draft is made for you to price" : "they offered a showing — get them a number first" });
    }
  }
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
  // A counter the band released is a yes: re-issue the paper at their number
  // and send it, then say so. Only the band injects these — ASK_ONLY_ACTIONS
  // still keeps revise_offer_to_counter off any rule, so nothing but this
  // structural check (their own number, under the $10k-fee ceiling, once per
  // offer, capped per day) ever re-prices an offer unattended. If either step
  // fails, the reply is held below: it must not say "sent" when nothing went.
  if (auto.exception?.passed && draft.intent === "counter") {
    // Inside the ceiling: their number. A little over it: ours — the ceiling.
    const amount = guard.counterBack ? guard.ceiling : guard.theirAmount;
    plan.auto.push(
      { id: `a-band-${job.id}`, type: "revise_offer_to_counter", mode: "auto", status: "pending", party, amount, via: "counter band",
        why: guard.counterBack
          ? `they countered at ${fmtMoney(guard.theirAmount)}, just over the ${fmtMoney(guard.ceiling)} ceiling — countering back at it`
          : `they countered at ${fmtMoney(amount)}, inside the ${fmtMoney(guard.ceiling)} ceiling` },
      { id: `a-band-send-${job.id}`, type: "send_offer", mode: "auto", status: "pending", party, afterCounter: true, via: "counter band",
        why: `the revised offer at ${fmtMoney(amount)}` },
    );
    const street = String(draft.propertyAddress || "").split(",")[0].trim();
    // No dollar sign: carriers filter it, and the gate flags it.
    const k = amount % 1000 === 0 ? `${amount / 1000}k` : amount.toLocaleString("en-US");
    draft.reply = guard.counterBack
      ? `Best we can do${street ? ` on ${street}` : ""} is ${k} as-is, cash. Sending the updated offer over now.`
      : `${k} works for us${street ? ` on ${street}` : ""}. Sending the updated offer over now.`;
  }
  // The investor band released a buyer's own number: write the price down
  // for this buyer on this deal, and say yes in fixed words that name that
  // number and nothing else. Marking them committed stays a person's press.
  // If the write fails the reply is held below: "works for us" must be true.
  if (auto.exception?.passed && auto.exception.kind === "investor_band" && draft.intent === "price_pushback") {
    const amount = guard.releaseAmount;
    plan.auto.push({ id: `a-iband-${job.id}`, type: "agree_investor_price", mode: "auto", status: "pending", party, amount, offerId: guard.offerId, via: "investor band",
      why: `they named ${fmtMoney(amount)}, at or above the ${fmtMoney(Math.max(guard.floor, guard.dropLimit))} limit` });
    const street = String(draft.propertyAddress || "").split(",")[0].trim();
    const k = amount % 1000 === 0 ? `${amount / 1000}k` : amount.toLocaleString("en-US");
    draft.reply = `${k} works${street ? ` on ${street}` : ""}. Want to walk it this week, or should I send the paperwork over?`;
  }
  // They're taking our number to the seller ("I'll run it by them", Julie
  // Nutley 2026-09-15): the written offer goes by text AND email so they have
  // it to show. Idempotent (an offer already sent isn't sent twice), and a
  // miss here never holds the thanks — see the send check in step 5.
  if (party === "agent" && !isCall && takingItToSeller(job.message, now)
    && !["counter", "acceptance", "rejection", "opt_out"].includes(draft.intent)
    && !plan.auto.some((x) => x.type === "send_offer")) {
    plan.auto.push({ id: `a-seller-send-${job.id}`, type: "send_offer", mode: "auto", status: "pending", party,
      channels: ["sms", "email"], via: "to seller", why: "they're taking our number to the seller" });
    // The reply says the paper is on its way; step 5 puts the model's own
    // words back if the offer didn't actually go.
    const first = firstNameOf(job.contactName || a.contactName || "");
    // The write-up ask only at a number Matt approved (2026-10-15).
    const writeUp = writeUpOkFor(context.offers?.numbers, draft.propertyAddress);
    draft = { ...draft, replyBeforeSend: draft.reply,
      reply: `Sounds good${first ? ` ${first}` : ""}, no rush. Sent our letter of intent over by text and email so you have it to share with them.` +
        (writeUp ? ` If they're open to it, could you write it up on ${offerForms(draft.propertyAddress)} forms for us to sign?` : " Let me know what they think.") };
  }
  // They gave us an address to email it to ("my email is …, please cc …"), or
  // ask where the email is. The documents go to THAT address, by email, and
  // the reply says so only because it is about to be true — step 5 takes the
  // words back and holds the text if the email didn't go. (Lee Dedinsky,
  // 2026-09-17: asked twice, told twice it had been emailed, nothing was.)
  const mail = party === "agent" && !isCall && !["rejection", "opt_out"].includes(draft.intent)
    ? emailRequest(job.originalMessage || job.message, a.transcript) : null;
  if (mail) {
    const existing = plan.auto.find((x) => x.type === "send_offer");
    if (existing) Object.assign(existing, { channels: [...new Set([...(existing.channels || ["sms"]), "email"])], emailTo: mail.to, emailCc: mail.cc });
    else plan.auto.push({ id: `a-email-send-${job.id}`, type: "send_offer", mode: "auto", status: "pending", party,
      channels: ["email"], emailTo: mail.to, emailCc: mail.cc, via: "to their email", why: `they asked for it by email (${mail.to})` });
    if (!existing) {
      draft = { ...draft, replyBeforeSend: draft.replyBeforeSend ?? draft.reply,
        reply: `Just emailed it to ${mail.to}${mail.cc.length ? ` with ${mail.cc.join(" and ")} copied` : ""}. Let me know if it doesn't show up in the next few minutes.` };
    }
  }
  if (auto.exception?.passed && draft.intent === "acceptance") {
    plan.suggested.push({ id: `a-acc-${job.id}`, type: "promote_to_deal", mode: "ask", status: "pending", party,
      why: "they say the seller accepted — mint the deal when you've confirmed it" });
  }
  // They say it's signed — mutual, fully executed, under contract
  // (shared/contract-signed.js). Before 2026-10-02 nothing noticed: the offer
  // sat "sent" until someone promoted it by hand. The hand-off goes on Today;
  // promoting stays a person's tap (ASK_ONLY_ACTIONS). Only with an open
  // offer of theirs to promote; a closing date they named rides along.
  // Ours, not someone else's: never on a counter or a "gone" text, and only
  // when they said it about our offer or our offer is already hot (a yes, a
  // presenting, a flag) — "we're under contract" alone is often the other buyer.
  const signedText = isCall ? themLines(inboundText) : (job.originalMessage || job.message);
  if (party === "agent" && !plan.suggested.some((x) => x.type === "promote_to_deal") && !["rejection", "opt_out", "counter"].includes(draft.intent)
      && !houseGone(signedText, draft.intent)) {
    const signed = signedContractIn(signedText, { now });
    // Already a deal: their "fully executed" ticks the checklist's "PSA signed by
    // both sides", so the Desk stops asking (9311 12th Pl SE, 2026-10-04).
    if (signed.signed && typeof deps.tickDealTask === "function") {
      await deps.tickDealTask({ contactId: job.contactId, addressHint: draft.propertyAddress || "", taskId: "psa_signed", why: "they said it's signed" })
        .catch((e) => warnings.push(`checklist: ${String(e?.message || e).slice(0, 120)}`));
    }
    if (signed.signed) {
      const rows = await store.listOffers(locationId, { contactId: job.contactId, limit: 50 }).catch(() => []);
      const open = rows.filter((o) => o && !o.deal && OPEN_OFFER_STATUSES.has(offerStatus(o)));
      if (open.length && (signed.ours || open.some((o) => pushesToPaper(o)))) {
        plan.suggested.push({ id: `a-signed-${job.id}`, type: "promote_to_deal", mode: "ask", status: "pending", party,
          ...(signed.closingDate ? { closingDate: signed.closingDate } : {}),
          why: `they say it's signed${signed.closingDate ? `, closing ${signed.closingDate}` : ""} — promote it when you've seen the paper` });
      }
    }
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
  // A deal text that went without its link said "want the details?"
  // (dispoAutopilot.blastLink "on_reply"): when they answer it with interest
  // or a question, the link goes — for the deal that text was about, named or
  // not — whatever the buy-box guard above would say. A pass gets nothing,
  // and neither does "why are you sending this to us?" (3831 Bagley,
  // 2026-10-17): a question about who we are isn't one about the house.
  if (party === "investor" && !isCall && LINK_ON_REPLY_INTENTS.has(draft.intent)
      && !plan.auto.some((x) => x.type === "send_dataroom_invite")) {
    const strangers = doesntKnowUs(theirLatestWords(a.transcript, job.message));
    const owed = strangers ? null : await linkOwed({ store, locationId, contactId: job.contactId, now, prefer: draft.propertyAddress || "" });
    // A stopped deal still sends it: the link answers what they said, and
    // Stop holds only the outreach the machine starts (stoppedDealAction).
    const where = String(owed?.address || "the deal").split(",")[0];
    if (strangers) {
      warnings.push("no package link: they asked who we are or why we texted them");
    } else if (owed) {
      plan.suggested = plan.suggested.filter((x) => x.type !== "suggest_dataroom_invite");
      const action = { id: `a-link-${job.id}`, type: "send_dataroom_invite", status: "pending", party, addressHint: owed.address };
      // The link goes with the answer. A reply that waits for you keeps the
      // link waiting too — a bare link with nothing said is what Bagley got.
      if (auto.send) plan.auto.push({ ...action, mode: "auto", why: `they answered the deal text on ${where} that offered the details` });
      else plan.suggested.push({ ...action, mode: "ask", why: `they answered the deal text on ${where} — send it with your reply` });
    }
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

  // What a "no" wires: they passed, Tier 3.
  const closes = (x) => x.type === "mark_offer_passed"
    || (x.type === "add_tags" && (x.tags || []).some((t) => /^tier-3$/i.test(String(t))))
    || (x.type === "add_to_workflow" && /tier\s*3/i.test(String(x.workflowName || "")));

  // The house is gone — "that one sold", "it's pending now" (shared/
  // held-underwrites.js houseGone). Nobody passed. Matt, 2026-10-02: "we
  // passed is like we intentionally said no". The offer is marked no longer
  // available and nothing chases it; what a no wires comes off (a house
  // that sold says nothing about the agent); and the first-no ask — "what
  // would the seller take?" — is never made on a house that sold. Not on a
  // call: a transcript carries every house they talked about.
  const gone = party === "agent" && !isCall && houseGone(job.message || "", draft.intent);
  if (gone) {
    plan.auto = plan.auto.filter((x) => !closes(x));
    plan.suggested = plan.suggested.filter((x) => !closes(x));
    plan.auto.push({ id: `a-gone-${job.id}`, type: "mark_offer_unavailable", mode: "auto", status: "pending", party,
      why: "they said the house sold or came off the market — no longer available, nothing chases it" });
  }

  // The first no on a live offer opens a negotiation; it doesn't end one.
  // The reply asks what the seller would take (COMMITMENTS), so the record
  // must not file the offer dead and tag them Tier 3 in the same breath.
  // The closing actions are held back once — the offer is stamped — and a
  // second no (or the offer ladder running out) closes it the usual way.
  if (party === "agent" && draft.intent === "rejection" && !gone) {
    const rows = await store.listOffers(locationId, { contactId: job.contactId, limit: 50, lean: true }).catch(() => []);
    const open = currentOffers(rows).filter((o) => o && !o.deal && OPEN_OFFER_STATUSES.has(offerStatus(o)));
    const picked = pickOfferByAddress(open, draft.propertyAddress) || (open.length === 1 ? open[0] : null);
    const full = picked && typeof store.getOffer === "function" ? (await store.getOffer(picked.id).catch(() => null)) || picked : picked;
    // A no after we've already come back to them is an answer, not an
    // opening. Matt, 2026-09-14: "if we counter and they say no, mark it they
    // passed." We've moved when the offer was re-quoted on their numbers,
    // re-issued under the counter band, revised, or already heard one no.
    const weMoved = Boolean(full && (
      full.declinedOnce?.at || (full.requotes || []).length || full.counterBand?.acceptedAt || (full.revisions || []).length
    ));
    // A counter too far over to negotiate already told us their number — there
    // is nothing left to ask for, so it closes on the first message. And the
    // hold is only for a reply that asks: one that says goodbye (1638 119th St
    // S, 2026-10-13) never draws a second no, and the offer sat "sent" for good.
    if (full && !weMoved && draft.reclassifiedFrom !== "counter" && asksForTheirNumber(draft.reply)) {
      plan.auto = plan.auto.filter((x) => !closes(x));
      plan.suggested = plan.suggested.filter((x) => !closes(x));
      plan.auto.push({ id: `a-no1-${job.id}`, type: "note_first_decline", mode: "auto", status: "pending", party, offerId: full.id,
        why: "first no on a live offer — asking for their number before it's filed dead" });
    }
  }

  // A no still gets the paper (Matt, 2026-10-02: "even if it doesn't make
  // sense for the agent or if the number they say they have some pushback on
  // it … send them our offer … so that they have it in front of them"). A no
  // to a number we floated — the first no, a plain no, their pass, a soft
  // floor — sends the written offer with the reply, by text and email, for
  // their records. It runs FIRST, ahead of anything that files the offer dead
  // (the send only goes on an open offer). Never on a counter: that stays a
  // person's call (NEVER_AUTO). Never on a house that sold, a number we never
  // floated or wouldn't put in writing unasked (agent_numbers, a held draft),
  // a house already on paper, a thread whose number has moved past the offer
  // (paperCheck — skipped, never held), or while a re-quote is on its way.
  // When the reply waits for a person, the paper waits with it as one click.
  const afterFloat = config.parties.agent.sendOffer?.afterFloat;
  if (party === "agent" && !isCall && !gone && afterFloat?.enabled && afterFloat.onPushback
      && (draft.intent === "rejection" || softFloor)
      && ![...plan.auto, ...plan.suggested].some((x) => x.type === "send_offer" || x.type === "requote_from_agent_numbers")) {
    const rows = await store.listOffers(locationId, { contactId: job.contactId, limit: 50 }).catch(() => []);
    const open = currentOffers(rows).filter((o) => o && !o.deal && ["new", "countered"].includes(offerStatus(o)));
    const offer = pickOfferByAddress(open, draft.propertyAddress) || (open.length === 1 ? open[0] : null);
    const mine = offer ? await store.listReplyDrafts(locationId, { contactId: job.contactId, limit: 30 }).catch(() => []) : [];
    const floated = offer && (floatSentAt(mine, offer.id) || lastQuoteOnHouse(offer, a.transcript));
    // Never on a house we told them didn't fit (listedFirst), nor a
    // high-stakes one still in range mode (shared/number-stance.js).
    const stance = floated && config.parties.agent.realmCheck?.highStakes?.enabled
      ? await floatStanceFor({ store, offer, config, dossier: propertyDossier(await store.listContactEvents(locationId, job.contactId, { limit: 200 }).catch(() => []), offer.address) })
      : null;
    if (floated && !offer.noFit && !paperWent(offer) && paperWorthy(offer, { stance }) && paperCheck({ offer, transcript: a.transcript }).ok) {
      const action = { id: `a-record-send-${job.id}`, type: "send_offer", mode: "auto", status: "pending", party, offerId: offer.id,
        channels: ["sms", "email"], via: "for record", forRecord: true,
        why: "they pushed back on the number we floated — the written offer goes anyway, for their records" };
      const line = "I'll send our written offer over anyway so you have it on file.";
      const said = String(draft.reply || "").trim();
      const withLine = /\bkeep me in mind\b/i.test(said) ? said.replace(/\b(keep me in mind)/i, `${line} $1`) : `${said}${said ? " " : ""}${line}`;
      const next = { ...draft, replyBeforeSend: draft.replyBeforeSend ?? draft.reply, reply: withLine };
      if (auto.send && gateFor(next).ok) {
        plan.auto.unshift(action);
        draft = next;
      } else {
        plan.suggested.push({ ...action, mode: "ask", why: `${action.why} — press it to send` });
      }
    }
  }

  // Paper and the number on it (shared/current-offer.js). A draft that would
  // put our offer in front of them — send it, or call it in the realm — waits
  // for a person when the house's current offer isn't the number in the
  // thread. 13041 SE 208th St (2026-09-25): the thread was at 400K, the row
  // said 416,500, and the letter went out with "let's do it". The text and
  // the paper wait together; the paper moves to "ask" so nothing sends it on
  // the side, and the offer is stamped so its pane offers the re-quote.
  let paperHold = null;
  const PAPER_ACTIONS = new Set(["send_offer", "mark_offer_realm_yes"]);
  if (party === "agent" && (plan.auto.some((x) => PAPER_ACTIONS.has(x.type)) || ["realm_yes", "acceptance"].includes(draft.intent))
      && !plan.auto.some((x) => x.type === "revise_offer_to_counter")) {
    const rows = await store.listOffers(locationId, { contactId: job.contactId, limit: 50 }).catch(() => []);
    const cur = currentOfferFor(rows, { address: draft.propertyAddress || "" }) || (draft.propertyAddress ? null : currentOfferFor(rows, {}));
    if (cur) {
      const check = paperCheck({ offer: cur, transcript: a.transcript });
      if (!check.ok) {
        paperHold = { offerId: cur.id, ...check };
        // A stop stays the reason it waits: stale_number is a person's call,
        // which would set a check-in clock the stop exists to prevent.
        if (!a.hold?.held) auto = { send: false, code: "stale_number", reason: `needs a person: ${check.reason}` };
        const moved = plan.auto.filter((x) => PAPER_ACTIONS.has(x.type)).map((x) => ({ ...x, mode: "ask", why: `${x.why ? `${x.why} — ` : ""}held: ${check.reason}` }));
        plan.auto = plan.auto.filter((x) => !PAPER_ACTIONS.has(x.type));
        plan.suggested.push(...moved);
        if (typeof deps.markPaperHeld === "function") await deps.markPaperHeld({ offerId: cur.id, check, draftId: job.id }).catch(() => {});
        warnings.push(`paper held: ${check.reason}`);
      }
    }
  }

  // Their number inside our range waits for a person (see inRange above):
  // the paper at our number and a revise to theirs are both one click, and
  // neither goes by itself.
  if (inRange && party === "agent") {
    const theirs = fmtMoney(inRange.amount);
    const moved = plan.auto.filter((x) => PAPER_ACTIONS.has(x.type))
      .map((x) => ({ ...x, mode: "ask", why: `${x.why ? `${x.why} — ` : ""}at our ${fmtMoney(inRange.high)}; they named ${theirs}` }));
    plan.auto = plan.auto.filter((x) => !PAPER_ACTIONS.has(x.type));
    plan.suggested.push(...moved);
    if (inRange.amount < inRange.high && !plan.suggested.some((x) => x.type === "revise_offer_to_counter")) {
      plan.suggested.push({ id: `a-range-${job.id}`, type: "revise_offer_to_counter", mode: "ask", status: "pending", party, amount: inRange.amount,
        via: "range", why: `they named ${theirs} inside the range we floated (${kText(inRange.low)}–${kText(inRange.high)}) — revise to it, then send the letter there` });
    }
    if (!a.hold?.held) {
      auto = { send: false, code: "in_range", reason: `needs a person: they named ${theirs} inside the range we floated (${kText(inRange.low)}–${kText(inRange.high)}) — write it at theirs, or hold at ours` };
    }
  }

  // "The seller accepted", at our number: the price is agreed (routes/offers.js
  // markOfferAgreed), which locks it and hands the offer to the push to paper.
  // Until 2026-09-29 only the band and a realm yes wrote it, so a yes kept
  // getting weekly "any update?" nudges. Not on a call (the transcript holds
  // our side's numbers too), and not while the paper is held above.
  if (party === "agent" && !isCall && !paperHold && draft.intent === "acceptance" && typeof deps.markOfferAgreed === "function") {
    const rows = await store.listOffers(locationId, { contactId: job.contactId, limit: 50 }).catch(() => []);
    const open = currentOffers(rows).filter(isNegotiable);
    const picked = pickOfferByAddress(open, draft.propertyAddress) || (open.length === 1 ? open[0] : null);
    const yes = acceptanceAtOurNumber({
      offer: picked, draft, inboundMessage: job.message || "", openOffers: open,
      comeDown: picked ? (ourComeDown(picked, a.transcript) || ourMoveUp(picked, a.transcript)) : null,
      moneyIn: moneySaidAgainst(job.message || "", picked?.cashAmount),
    });
    if (yes.ok) {
      plan.auto.push({ id: `a-agreed-${job.id}`, type: "mark_offer_agreed", mode: "auto", status: "pending", party, offerId: picked.id,
        why: "the seller accepted our number — the price is agreed and the push to paper starts" });
    } else {
      warnings.push(`the yes wasn't recorded as agreed: ${yes.reason}`);
    }
  }

  /* --- 3. nothing to say --- */
  if (draft.intent === "small_talk" && !draft.reply && !plan.auto.length && !plan.suggested.length) {
    // No draft, but a trace: without one the nightly audit sees a text with
    // no reply and no row, redrafts it three nights and hands it to Matt
    // ("Ugly 😂😂 ok.", 2026-10-02). The intent only — never their words.
    await recordEvent({
      store, locationId, contactId: job.contactId, party: a.party === "investor" ? "investor" : "agent", type: "reply_not_needed",
      at: new Date(now).toISOString(), source: "conversation", ref: job.id, dedupeKey: `reply_not_needed:${job.id}`, data: { intent: draft.intent },
    }).catch(() => {});
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
  //
  // With one exception — a burst never silences a thread. Colin Foote,
  // 2026-09-15: a listing link and "$950k, quick close" drew "Running 15605
  // NE 1st by underwriting today, what work does it need?", counting down to
  // send; a minute later "buyer to pay my 3%" arrived, read as a person's
  // call, and its held draft superseded the one about to go. Nothing went.
  // When THIS draft is held for a person and the message didn't turn the
  // conversation (a no, a counter, a yes, an opt-out), the scheduled reply
  // to the earlier texts still goes, and this one waits in the outbox on top.
  const turned = ["opt_out", "rejection", "counter", "acceptance", "realm_yes", "we_passed"].includes(draft.intent);
  const keepScheduled = !auto.send && HELD_FOR_A_PERSON.has(auto.code) && !turned;
  const open = [];
  for (const status of ["draft", "scheduled"]) {
    const rows = await store.listReplyDrafts(locationId, { contactId: job.contactId, status, limit: 5 }).catch(() => []);
    open.push(...rows);
  }
  const keptScheduled = [];
  for (const old of open) {
    if (keepScheduled && old.status === "scheduled" && old.autoSend?.decided) { keptScheduled.push(old.id); continue; }
    // A deal text queued for them isn't a reply to anything they said, and
    // may be waiting days for their week (shared/buyer-touch.js): their text
    // about something else doesn't cancel it. Only an opt-out does.
    if (old.outbound?.kind === "blast_open" && draft.intent !== "opt_out") continue;
    await store.updateReplyDraft(old.id, { ...old, status: "superseded", sendAt: null, updatedAt: new Date().toISOString() }).catch(() => {});
  }
  if (keptScheduled.length) warnings.push("the reply already counting down to the earlier texts still goes; this one waits for you");
  const ts = new Date().toISOString();
  // The agent's own numbers and the property details, whichever shape the draft arrived in.
  // The model's read first; the shorthand backstop only when it came back empty.
  const agentTake = draft.agentTake ?? normalizeAgentTake(draft)
    ?? (party === "agent" && !isCall ? agentTakeFromText(job.message) : null);
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
    ...(draft.walkthrough ? { walkthrough: draft.walkthrough } : {}),
    // Where the icebreaker house stands (shared/flip-read.js): the next
    // reply reads whether our question or our pass already went.
    ...(draft.qualify ? { qualify: draft.qualify } : {}),
    // What they offered to work together on (shared/partner-terms.js).
    ...(draft.partnerTerms ? { partnerTerms: draft.partnerTerms } : {}),
    // A showing they offered on a live house, held for Matt (2026-10-15).
    ...(draft.showingOffered ? { showingOffered: draft.showingOffered } : {}),
    // They told us it isn't our kind of house: a pass on it, which the
    // contact card reads (shared/contact-card.js).
    ...(notOurKind ? { notOurKind: true } : {}),
    // The model's own words, kept when the reply was rewritten to say the
    // offer went out, so step 5 can put them back if it didn't.
    ...(draft.replyBeforeSend ? { replyBeforeSend: draft.replyBeforeSend } : {}),
    // Written once more because a gate caught the first one (redraftOnGate):
    // what caught it, and — when the rewrite was caught too — that it was.
    ...(draft.redraftedFor ? { redraftedFor: draft.redraftedFor, replyBeforeRedraft: draft.replyBeforeRedraft || "" } : {}),
    ...(draft.redraftHeld ? { redraftHeld: draft.redraftHeld } : {}),
    agentTake,
    propertyDetails: propertyDetails || null,
    autoSendable: gate.ok,
    // The money guard's verdict apart from the intent lock — what the nightly
    // audit reads to release a held holding-reply (releaseForAudit).
    gateClean: Boolean(gate.ok || (gate.locked && gate.clean)),
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
    // What the draft cost, and the shadow model's draft of the same message
    // beside it (config.ai) — judged by the same gates, never sent.
    usage: draft.usage || null,
    shadow: shadowRow(draft.shadow, gateFor),
    // The paper this draft would have sent, held because the thread's number
    // isn't the offer's (the Today row offers the re-quote).
    paperHold: paperHold ? { offerId: paperHold.offerId, reason: paperHold.reason, amount: Math.round(Number(paperHold.comeDown?.amount) || 0) } : null,
    // The calendar: what this reply offers (so the next message can pick
    // one) and what it booked.
    booking: bookingVerdict ? { offered: bookingVerdict.passed ? bookingVerdict.offered : [], chosen: bookingVerdict.chosen || null } : null,
    humanActive: a.humanActive || null,
    actions: [...plan.auto, ...plan.suggested],
    supersededIds: open.filter((o) => !keptScheduled.includes(o.id)).map((o) => o.id),
    keptScheduledIds: keptScheduled,
    warnings: warnings.slice(0, 6),
    noteOnAutoSend: config.notes?.onAutoSend !== false,
    ...(draft.counterHold ? { counterHold: draft.counterHold } : {}),
    // Their yes landed on a house we passed on: Today's row says so.
    ...(draft.yesAfterPass ? { yesAfterPass: draft.yesAfterPass } : {}),
    // A counter close to ours: a call, not the hold text (call_counter).
    ...(draft.callCounter ? { callCounter: draft.callCounter } : {}),
    promptVersion: 3,
    updatedAt: ts,
  });
  job.draftId = record.id;

  // The hold went (or goes at the next open minute): its clock starts on the
  // offer — counter-hold.js checks in and passes from here.
  if (auto.counterHold && draft.counterHold && typeof deps.markCounterHold === "function") {
    await deps.markCounterHold({ offerId: draft.counterHold.offerId, ours: draft.counterHold.ours, theirs: draft.counterHold.theirs, again: draft.counterHold.again, draftId: record.id })
      .catch((e) => warnings.push(`hold: ${String(e?.message || e).slice(0, 120)}`));
  }

  /* --- 4a. the call itself, on the timeline --- */
  if (isCall && job.call) {
    await recordEvent({
      store, locationId, contactId: job.contactId, party, type: "call_summary", at: job.call.at || new Date(now).toISOString(),
      address: draft.propertyAddress || "", source: "call", ref: job.call.messageId || record.id, dedupeKey: job.call.dedupeKey || `call:${job.call.messageId}`,
      data: { summary: String(draft.summary || "").slice(0, 500), intent: draft.intent, direction: job.call.direction, durationSec: job.call.durationSec, transcribed: true, draftId: record.id,
        // A voicemail they left (call-intake.js): their words, not a conversation (talked-to.js).
        ...(job.call.missed ? { missed: true } : {}) },
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
      store, draftId: record.id, intent: draft.intent, inbound: job.message, notOurKind, qualifying: qualifyHeld ? draft.qualify.stage : replyPassed ? "pass" : "",
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
      try { await deps.afterAgentTake({ contactId: job.contactId, address: draft.propertyAddress, draftId: record.id }); }
      catch (e) { warnings.push(`realm follow-up: ${String(e?.message || e).slice(0, 120)}`); }
    }
  }

  /* --- 4c‴. they're warming to our number: the offer goes hot --- */
  // "Might work", "let me present it", "I'll write it up" — and a yes on the
  // number. The model's read first, the plain words second; never on a no or
  // a counter, which say the opposite. The broker decides whether there is
  // an offer of ours, with its number already out, for this to be about.
  // Not while the paper is held: "hot" means the number is settled, and the
  // number on that row is the one in question.
  // Nor when they're asking us to come up, or the seller is wavering: on
  // 1010 Bellevue (2026-10-04) the model read "make an offer closer to where
  // they are" as "the number might work", and the Desk called it hot. The
  // model's own read is not trusted on those either.
  const theirWords = job.originalMessage || job.message;
  const notWarm = ["rejection", "opt_out", "we_passed", "counter", "price_pushback"].includes(draft.intent)
    || asksUsToComeUp(theirWords) || soundsLikeSecondThoughts(theirWords);
  if (party === "agent" && !isCall && !paperHold && typeof deps.raiseOfferHeat === "function" && !notWarm) {
    const signal = draft.dealSignal
      || dealSignalFromText(theirWords)
      || (["realm_yes", "acceptance"].includes(draft.intent) ? "warm" : "");
    if (signal) {
      try {
        const r = await deps.raiseOfferHeat({ contactId: job.contactId, addressHint: draft.propertyAddress || "", signal, note: DEAL_SIGNAL_LABEL[signal], draftId: record.id });
        if (r?.ok && r.raised) job.warnings.push(`flagged hot: ${r.address} — ${DEAL_SIGNAL_LABEL[signal]}`);
      } catch (e) { warnings.push(`hot flag: ${String(e?.message || e).slice(0, 120)}`); }
    }
  }

  // …and heat the conversation set cools when they say the opposite: a no,
  // a push back on price, an ask for more, cold feet. A flag you set stays.
  const cools = draft.intent === "rejection" || draft.intent === "price_pushback" || asksUsToComeUp(theirWords) || soundsLikeSecondThoughts(theirWords);
  if (party === "agent" && !isCall && cools && typeof deps.coolOfferHeat === "function") {
    try {
      const r = await deps.coolOfferHeat({ contactId: job.contactId, addressHint: draft.propertyAddress || "", why: draft.intent === "rejection" ? "they said no" : asksUsToComeUp(theirWords) ? "they asked us to come up" : soundsLikeSecondThoughts(theirWords) ? "the seller is having second thoughts" : "they pushed back on the price" });
      if (r?.ok && r.cooled) job.warnings.push(`no longer hot: ${r.address}`);
    } catch (e) { warnings.push(`cool: ${String(e?.message || e).slice(0, 120)}`); }
  }

  /* --- 4c‴′. how the house is being sold, and the paper to sign --- */
  // "One other offer", "a back up at 750k": a machine's off-market mark comes
  // off (3831 Bagley Ave N). "Sent you the offer for your signature", "we
  // have mutual", "I'll write it up": the signing moment is stamped on the
  // house's row, a held draft too, so what nobody checked reaches Matt
  // before he signs (1538 NW 61st St). Nothing is sent from here.
  if (party === "agent" && !isCall && typeof deps.noteHouseWords === "function") {
    const onMarket = onMarketCue(theirWords);
    const paper = paperworkSignal(theirWords)
      || ((draft.dealSignal || dealSignalFromText(theirWords)) === "writing_up" && !notWarm ? "writing_up" : "");
    if (onMarket || paper) {
      try {
        const r = await deps.noteHouseWords({ contactId: job.contactId, addressHint: draft.propertyAddress || "", onMarket, paper, draftId: record.id });
        if (r?.ok && r.offMarketCleared) job.warnings.push(`no longer off-market: ${r.address} — they said "${onMarket}"`);
        if (r?.ok && r.paper) job.warnings.push(`paper to sign: ${r.address} — before-you-sign check is up`);
      } catch (e) { warnings.push(`house words: ${String(e?.message || e).slice(0, 120)}`); }
    }
  }

  /* --- 4c″. a property is coming, and they didn't give the address --- */
  // Alexandria Goforth (2026-09-15): "I will likely have one in Spanaway soon."
  // The reply asks for the address; promise-sweep.js runAddressChase keeps
  // asking on a ladder until an address lands, they opt out, or it runs out.
  // A time they named ("in a few weeks") is its first rung, in place of a
  // separate check-in, so they don't get two texts.
  //
  // Not when the same text says no to giving it ("can't share the address
  // until it lists") or what's coming is a piece of land (2026-10-14: an
  // agent with only a vacant lot got five chase texts).
  let chaseHasDate = false;
  let chaseStarted = false;
  // A lead they gave us the timing of ("relisting in the spring", "should
  // know by end of the month"), read from their words: on a call, their side
  // of the transcript. A call is read for this and for nothing else in 4c′
  // (shared/follow-up.js detectLeadTiming).
  const callTheirs = isCall ? themLines(inboundText) : "";
  const lead = party === "agent" && draft.intent !== "opt_out"
    ? detectLeadTiming(isCall ? (callTheirs || inboundText) : job.message, now, { checkBack: !isCall || Boolean(callTheirs) })
    : null;
  if (party === "agent") {
    // Every house they named, address or not, is a row on their timeline:
    // "Pine St, Shelton, asking 410K, a 1920s rambler" is a lead even
    // before the number comes (2026-10-13).
    // A house named with no street at all ("some Stanwood houses") has no
    // address; it is kept by what they called it (data.label), and its town.
    for (const h of namedHouses) {
      await recordEvent({
        store, locationId, contactId: job.contactId, party: "agent", type: "house_mentioned", at: new Date(now).toISOString(),
        address: h.address, source: isCall ? "call" : "conversation", ref: record.id,
        dedupeKey: `house_mentioned:${job.contactId}:${h.address ? addressKey(h.address) : `area:${String(h.label || "").toLowerCase()}`}:${record.id}`,
        data: { sellerAsk: h.sellerAsk || 0, note: h.note || "", needsAddress: h.needsAddress,
          ...(h.address ? {} : { label: h.label || "", area: h.area || "", ...(h.town ? { town: h.town } : {}) }),
          // Whose words: a text, their side of a call, or a call with no speaker labels.
          heard: isCall ? (heard.labelled ? "them" : "unlabelled") : "text" },
      }).catch(() => {});
    }
    // A house this reply closed: the GHL card's Tier 1 reads it beside the
    // houses they raised (shared/ghl-stages.js raisedHouses), so a house
    // raised and passed in the same thread leaves Tier 1 with no row to close
    // (Matt, 2026-10-16). A millisecond after the mentions above, so the
    // close is the later word on a house named and passed in one text.
    const closedHouse = draft.qualify && ["pass", "closed"].includes(draft.qualify.stage) && draft.qualify.address ? draft.qualify.address : draft.propertyAddress;
    // Our words pass on it whatever the reply was filed as (Bend, 2026-10-22:
    // four passes filed investor_open closed nothing, and the houses the
    // agents raised held their cards in Tier 1). Never on their yes to a
    // number of ours; saysYes alone is too loose here ("Seller situation is
    // good" reads as one), and a sent offer's row keeps its own stage anyway.
    const ourWordsPass = !yesAfterPass && ourReplyPasses(draft.reply);
    const closedWhy = !closedHouse ? ""
      : gone ? "it sold or came off the market"
      : replyPassed || ourWordsPass || (draft.qualify && ["pass", "closed"].includes(draft.qualify.stage)) ? "we passed on it"
      : notOurKind ? "they said it's turnkey"
      : draft.intent === "rejection" ? "they passed"
      : "";
    if (closedWhy) {
      await recordEvent({
        store, locationId, contactId: job.contactId, party: "agent", type: "house_closed", at: new Date(now + 1).toISOString(),
        address: closedHouse, source: isCall ? "call" : "conversation", ref: record.id,
        dedupeKey: `house_closed:${job.contactId}:${addressKey(closedHouse)}:${record.id}`,
        data: { why: closedWhy, intent: draft.intent },
      }).catch(() => {});
    }
    // Their yes on a house (2026-10-22, 1128 N Jackson Ave: Matt quoted it by
    // text and no row of ours was on it): Tier 1 by itself, row or not.
    if (!closedWhy && draft.intent === "acceptance" && validAddress(draft.propertyAddress || "")) {
      await recordEvent({
        store, locationId, contactId: job.contactId, party: "agent", type: "house_agreed", at: new Date(now + 1).toISOString(),
        address: draft.propertyAddress, source: isCall ? "call" : "conversation", ref: record.id,
        dedupeKey: `house_agreed:${job.contactId}:${addressKey(draft.propertyAddress)}:${record.id}`,
        data: { intent: draft.intent },
      }).catch(() => {});
    }
    // A house with no number starts the chase too, even when propertyAddress
    // holds the street; its hint names each one the way they did.
    let pend = addressPending({ intent: draft.intent, propertyAddress: draft.propertyAddress, message: job.message, now });
    if (housesWithoutNumber.length && draft.intent !== "opt_out") {
      pend = { ...(pend || { firstDueAt: null, phrase: "" }), hint: addressHint(housesWithoutNumber), houses: housesWithoutNumber.map((h) => h.address || h.label) };
    }
    // Someone else they pointed us to for a house (2026-10-14: "contact
    // <a colleague> at <a brokerage>, she has one coming up" was answered
    // and forgotten). A Decide row for Matt (shared/call-list.js); nothing
    // ever texts the person they named. Their side of a call only.
    const referral = draft.intent !== "opt_out" && heard.labelled
      ? referralMention(isCall ? heard.words : (job.originalMessage || job.message), { self: a.contactName || "" })
      : null;
    if (referral) {
      await recordEvent({
        store, locationId, contactId: job.contactId, party: "agent", type: "referral_mentioned", at: new Date(now).toISOString(),
        address: "", source: isCall ? "call" : "conversation", ref: record.id,
        dedupeKey: `referral_mentioned:${job.contactId}:${referralKey(referral)}`,
        data: { name: referral.name, brokerage: referral.brokerage, relation: referral.relation, phone: referral.phone, phrase: referral.phrase },
      }).catch(() => {});
    }
    if (pend && (refusesAddress(job.message) || notAHouse(job.message))) {
      job.warnings.push(refusesAddress(job.message) ? "no address chase: they won't share it yet" : "no address chase: it's land, not a house");
      pend = null;
    }
    // A house coming with no address, on a day only the lead reader heard
    // ("one coming up closer to Nov 1"): the chase's first ask is that day.
    // Further out than the chase's ladder can wait ("one in the spring"),
    // there's no chase: the lead's own check-in asks on its day.
    if (pend && lead && Date.parse(lead.when) - now > LEAD_CHASE_MAX_DAYS * 86400000) pend = null;
    else if (pend && !pend.firstDueAt && lead) { pend.firstDueAt = lead.when; pend.phrase = lead.phrase; }
    if (pend) {
      chaseHasDate = Boolean(pend.firstDueAt);
      chaseStarted = true;
      await recordEvent({
        store, locationId, contactId: job.contactId, party: "agent", type: "address_pending", at: new Date(now).toISOString(),
        address: "", source: "conversation", ref: record.id,
        dedupeKey: `address_pending:${job.contactId}:${record.id}`,
        data: { hint: pend.hint, firstDueAt: pend.firstDueAt, phrase: pend.phrase, ...(pend.houses ? { houses: pend.houses } : {}) },
      }).catch(() => {});
    } else if (draft.intent === "opt_out") {
      await recordEvent({
        store, locationId, contactId: job.contactId, party: "agent", type: "address_pending_closed", at: new Date(now).toISOString(),
        address: "", source: "conversation", ref: record.id,
        dedupeKey: `address_pending_closed:${job.contactId}:${record.id}`, data: { intent: draft.intent },
      }).catch(() => {});
    }
  }

  /* --- 4c′. when they said to check back, and who sends us deals --- */
  // Remembered as `checkin_requested`; promise-sweep.js runCheckInSweep sends
  // the check-in when it's due and they haven't come back first.
  //
  // How often they want to hear from us, in their words (2026-10-14: "check
  // in no more than every 2–3 months", "you are on my email list so you don't
  // need to check in", "I have enough wholesalers"): the contact's
  // `checkinEvery` fact, newest wins, which the agent check-in waits at least
  // (shared/agent-pulse.js). "Check back in a couple months" is also a dated
  // check-in that far out. A cadence never starts the weekly deal-source
  // chain or the two-morning clock under a held reply.
  let checkInBooked = false;
  const cadence = party === "agent" && !isCall && draft.intent !== "opt_out" ? cadenceRequest(job.message) : null;
  if (cadence) {
    await learnFacts({ store, locationId, contactId: job.contactId, party: "agent",
      facts: [{ key: "checkinEvery", value: String(cadence.days), source: "conversation", at: new Date(now).toISOString(), ref: record.id }] }).catch(() => {});
  }
  // The lead, on its own track (promise-sweep.js runCheckInSweep): its day
  // may be months off, and an offer's own clock keeps them until it lets go.
  // Not when the address chase already asks on that day, nor for a bare
  // "check back in a couple months" with no lead in it: that is their
  // cadence, booked below as a dated check-in.
  const leadBooked = Boolean(lead) && !chaseStarted && !(cadence?.checkBack && !lead.what);
  if (leadBooked) {
    await recordEvent({
      store, locationId, contactId: job.contactId, party: "agent", type: "checkin_requested", at: new Date(now).toISOString(),
      address: "", source: isCall ? "call" : "conversation", ref: record.id,
      dedupeKey: `checkin_requested:lead:${job.contactId}:${lead.when.slice(0, 10)}`,
      data: { kind: "lead", phrase: lead.phrase, dueAt: lead.when,
        lead: { what: lead.what, when: lead.when, said: lead.said, confidence: lead.confidence, via: isCall ? "call" : "text" } },
    }).catch(() => {});
    // Only a lead days away is the net under a held reply; one in March isn't.
    if (leadIsTheNet({ data: { kind: "lead", dueAt: lead.when } }, now)) checkInBooked = true;
  }
  if (party === "agent" && !isCall && !["opt_out", "counter", "acceptance", "realm_yes"].includes(draft.intent)) {
    const ask = chaseHasDate || leadBooked ? null : (checkInRequested(job.message, now) || takingItToSeller(job.message, now)
      || (cadence?.checkBack ? { dueAt: cadenceDueAt(now, cadence.days), phrase: cadence.phrase } : null));
    if (ask) {
      checkInBooked = true;
      await recordEvent({
        store, locationId, contactId: job.contactId, party: "agent", type: "checkin_requested", at: new Date(now).toISOString(),
        address: draft.propertyAddress || "", source: "conversation", ref: record.id,
        dedupeKey: `checkin_requested:${job.contactId}:${ask.dueAt.slice(0, 10)}`,
        data: { kind: "date", phrase: ask.phrase, dueAt: ask.dueAt },
      }).catch(() => {});
    }
    if (offersToSendDeals(job.message)) {
      checkInBooked = true;
      await addContactTags(client, job.contactId, ["deal-source"]).catch((e) => warnings.push(`tag: ${e.message}`));
      // A chain already running is left to run. Until 2026-09-29 the key was
      // one per contact for all time, so an agent who offered deals a second
      // time — months later — never got a check-in again.
      const prior = await store.listContactEvents?.(locationId, job.contactId, { types: ["checkin_requested", "checkin_sent"], limit: 50 }).catch(() => []) || [];
      const lastSource = prior.filter((e) => e.type === "checkin_requested" && e.data?.kind === "source").sort((x, y) => String(y.at).localeCompare(String(x.at)))[0];
      // Running = its newest request is still waiting to go (a sent one writes
      // the next; one they answered, or that aged out, is over).
      const running = lastSource && !prior.some((e) => e.type === "checkin_sent" && e.data?.requestAt === lastSource.at)
        && Date.parse(lastSource.data?.dueAt || "") > now - 8 * 86400000;
      if (!running && !cadence) {
        await recordEvent({
          store, locationId, contactId: job.contactId, party: "agent", type: "checkin_requested", at: new Date(now).toISOString(),
          address: "", source: "conversation", ref: record.id,
          dedupeKey: `checkin_requested:source:${job.contactId}:${new Date(now).toISOString().slice(0, 10)}`,
          data: { kind: "source", phrase: "", dueAt: new Date(now + 7 * 86400000).toISOString(), left: 5 },
        }).catch(() => {});
      }
    }
  }

  /* --- 4c‴. nothing is going out, and nobody is holding the thread --- */
  // A held draft waits in the outbox, which is a list, not a clock. Thomas
  // Rinow (2026-09-15) answered our 456,250 on 10412 SE 219th with the
  // seller's number — "that are willing to go to 670" — the draft was held,
  // no one picked it up, and the next thing that happened was his email the
  // following morning closing the deal out himself.
  //
  // So when an agent's text leaves us silent, the check-in sweep owns the
  // thread two mornings on (unansweredCheckIn), and a note says so where the
  // operator will see it. Never on an opt-out (silence is the whole point),
  // never on small talk, and never when this message already booked a
  // check-in or started an address chase — nobody gets two texts.
  const heldSilent = party === "agent" && !isCall && !auto.send && HELD_FOR_A_PERSON.has(auto.code)
    && !checkInBooked && !chaseStarted && !job.fromCheckIn && !cadence
    && !["opt_out", "small_talk"].includes(draft.intent);
  if (heldSilent) {
    const due = unansweredCheckIn(now);
    const filed = await recordEvent({
      store, locationId, contactId: job.contactId, party: "agent", type: "checkin_requested", at: new Date(now).toISOString(),
      address: draft.propertyAddress || "", source: "conversation", ref: record.id,
      dedupeKey: `checkin_requested:unanswered:${job.contactId}:${due.dueAt.slice(0, 10)}`,
      data: { kind: "unanswered", phrase: "", dueAt: due.dueAt, draftId: record.id },
    }).catch(() => ({ inserted: false }));
    if (filed?.inserted) {
      await createContactNote(client, job.contactId, {
        body: `Nothing went out — their text is waiting on you in the outbox (${auto.reason || "held"}). ` +
          `If neither of us comes back, we check in on ${new Date(due.dueAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}. ` +
          `They said: ${String(job.message || "").replace(/\s+/g, " ").slice(0, 200)}`,
      }).catch((e) => warnings.push(`note: ${e.message}`));
    }
  }

  // A showing they offered on a live house is on their timeline, one a day
  // per house: the hold's reason, for Today and the tour promise to read.
  if (party === "agent" && draft.showingOffered?.address) {
    await recordEvent({
      store, locationId, contactId: job.contactId, party: "agent", type: "showing_offered", at: new Date(now).toISOString(),
      address: draft.showingOffered.address, source: "conversation", ref: record.id,
      dedupeKey: `showing_offered:${job.contactId}:${propertyKey(draft.showingOffered.address)}:${new Date(now).toISOString().slice(0, 10)}`,
      data: { draftId: record.id },
    }).catch((e) => warnings.push(`showing: ${String(e?.message || e).slice(0, 120)}`));
  }

  if (party === "agent" && propertyDetails && draft.propertyAddress) {
    await recordEvent({
      store, locationId, contactId: job.contactId, party: "agent", type: "property_details", at: new Date(now).toISOString(),
      address: draft.propertyAddress, source: "conversation", ref: record.id, data: propertyDetails,
    });
    // A listed house where we asked what the seller is hoping to get
    // (listedFirst): their answer is what the number waited for, the way
    // their read is (4c).
    // Every take check asks it since 2026-10-21, so not only under listedFirst.
    if (propertyDetails.sellerAsk && !agentTake && typeof deps.afterAgentTake === "function") {
      try { await deps.afterAgentTake({ contactId: job.contactId, address: draft.propertyAddress, draftId: record.id }); }
      catch (e) { warnings.push(`realm follow-up: ${String(e?.message || e).slice(0, 120)}`); }
    }
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
  // The RECORD decides "new", not the field. An address they named with no
  // offer (or recent held draft) behind it is new even when Subject Property
  // already held it — a first mention read at medium confidence files the
  // field and only suggests the underwrite, and "moved" never fires again.
  const bookRows = party === "agent" && draft.propertyAddress
    ? await store.listOffers(locationId, { contactId: job.contactId, limit: 50, lean: true }).catch(() => [])
    : [];
  const namedKnown = draft.propertyAddress ? knownOfferFor(bookRows, draft.propertyAddress, now) : null;
  let subjectMoved = party === "agent" && Boolean(draft.propertyAddress)
    && lastMention(job.message, draft.propertyAddress) >= 0 && !namedKnown;
  // A HELD underwrite is not "numbers we have". If the agent has told us more
  // about the house since it held — the work, their value — run it again and
  // replace the held draft. Kelby Schweitzer's 5016 7th Ave NE (2026-09-14)
  // held on thin comps at 11:04, then got the scope and a 1.6–1.8M value, and
  // every later run stood down on "already have a held draft" — so the bot
  // promised a number all afternoon with nothing running.
  let rerunHeld = null;
  if (namedKnown && namedKnown.status === "draft" && plan.auto.some((x) => x.type === "start_underwrite")) {
    const heldAt = Date.parse(namedKnown.updatedAt || namedKnown.createdAt || "") || 0;
    const evs = (await store.listContactEvents?.(locationId, job.contactId, { limit: 200 }).catch(() => [])) || [];
    const told = evs.some((e) => ["agent_estimate", "property_details"].includes(e?.type)
      && e.address && propertyKey(e.address) === propertyKey(namedKnown.address || "")
      && (Date.parse(e.at || "") || 0) > heldAt);
    if (told) {
      rerunHeld = namedKnown;
      plan.auto = plan.auto.map((x) => (x.type === "start_underwrite" ? { ...x, replaceOfferId: namedKnown.id, why: "they told us more since it held — run it again" } : x));
      record = { ...record, actions: (record.actions || []).map((x) => (x.type === "start_underwrite" && x.status === "pending" ? { ...x, replaceOfferId: namedKnown.id } : x)), updatedAt: new Date().toISOString() };
      await store.updateReplyDraft(record.id, record).catch(() => {});
    }
  }
  // A house the nightly sweep passed on before we ever priced it — gone
  // quiet, or read as turnkey — reopens on the agent's own numbers. Matt,
  // 2026-10-11, on 1425 33rd St SE: "even though we passed, if the numbers
  // work out we should proceed." It is an ordinary underwrite
  // from here: its number goes out only the way any number does.
  if (!rerunHeld && namedKnown && party === "agent" && !notOurKind && !qualifyHeld && !replyPassed && reopensOnTheirNumbers(namedKnown)) {
    const since = Date.parse(namedKnown.retired?.at || namedKnown.statusAt || "") || 0;
    const evs = (await store.listContactEvents?.(locationId, job.contactId, { limit: 200 }).catch(() => [])) || [];
    const told = evs.some((e) => e?.type === "agent_estimate" && e.address
      && (propertyKey(e.address) === propertyKey(namedKnown.address || "") || sameHouse(e.address, namedKnown.address || ""))
      && (Number(e.data?.arv) > 0 || Number(e.data?.rehab) > 0)
      && (Date.parse(e.at || "") || 0) > since);
    if (told) {
      rerunHeld = namedKnown;
      const why = "they gave us their numbers on a house we passed on before pricing it — run it again";
      if (plan.auto.some((x) => x.type === "start_underwrite")) {
        plan.auto = plan.auto.map((x) => (x.type === "start_underwrite" ? { ...x, replaceOfferId: namedKnown.id, why } : x));
        record = { ...record, actions: (record.actions || []).map((x) => (x.type === "start_underwrite" && x.status === "pending" ? { ...x, replaceOfferId: namedKnown.id } : x)), updatedAt: new Date().toISOString() };
      } else {
        const action = { id: `a-reopen-${job.id}`, type: "start_underwrite", mode: "auto", status: "pending", party, replaceOfferId: namedKnown.id, why };
        plan.suggested = plan.suggested.filter((x) => x.type !== "start_underwrite");
        plan.auto.push(action);
        record = { ...record, actions: [...(record.actions || []).filter((x) => !(x.type === "start_underwrite" && x.status === "pending")), action], updatedAt: new Date().toISOString() };
      }
      await store.updateReplyDraft(record.id, record).catch(() => {});
    }
  }
  // A rough first pass is the same: we said it was rough and asked for their
  // read, so their read re-runs it (rerunsRoughOffer) — whether or not a rule
  // planned an underwrite on this message. Not when a re-quote on their
  // numbers is already planned, and not on a house we've been told isn't ours
  // or are still qualifying.
  if (!rerunHeld && namedKnown && party === "agent" && !notOurKind && !qualifyHeld && !replyPassed
      && ![...plan.auto, ...plan.suggested].some((x) => x.type === "requote_from_agent_numbers")) {
    const evs = (await store.listContactEvents?.(locationId, job.contactId, { limit: 200 }).catch(() => [])) || [];
    if (rerunsRoughOffer({ known: namedKnown, book: bookRows, events: evs })) {
      rerunHeld = namedKnown;
      const why = "they gave us their read on our rough number — run it again";
      if (plan.auto.some((x) => x.type === "start_underwrite")) {
        plan.auto = plan.auto.map((x) => (x.type === "start_underwrite" ? { ...x, replaceOfferId: namedKnown.id, why } : x));
        record = { ...record, actions: (record.actions || []).map((x) => (x.type === "start_underwrite" && x.status === "pending" ? { ...x, replaceOfferId: namedKnown.id } : x)), updatedAt: new Date().toISOString() };
      } else {
        const action = { id: `a-rough-${job.id}`, type: "start_underwrite", mode: "auto", status: "pending", party, replaceOfferId: namedKnown.id, why };
        plan.suggested = plan.suggested.filter((x) => x.type !== "start_underwrite");
        plan.auto.push(action);
        record = { ...record, actions: [...(record.actions || []).filter((x) => !(x.type === "start_underwrite" && x.status === "pending")), action], updatedAt: new Date().toISOString() };
      }
      await store.updateReplyDraft(record.id, record).catch(() => {});
    }
  }
  // Nothing to re-run: we already have numbers (or a draft a person is
  // reviewing) on this house. The rule's own underwrite stands down.
  if (namedKnown && !rerunHeld && plan.auto.some((x) => x.type === "start_underwrite")) {
    const why = `already have ${namedKnown.status === "draft" ? "a held draft" : "an offer"} on ${namedKnown.address}`;
    // A run already aimed at replacing that held draft (number first) goes ahead.
    plan.auto = plan.auto.filter((x) => x.type !== "start_underwrite" || x.replaceOfferId);
    record = { ...record, actions: record.actions.map((x) => x.type === "start_underwrite" && x.status === "pending" && !x.replaceOfferId ? { ...x, status: "skipped", detail: why } : x), updatedAt: new Date().toISOString() };
    await store.updateReplyDraft(record.id, record).catch(() => {});
  }
  // Not when their own words say it isn't a flip: the reply is "that one's
  // more finished than what we buy", and Tier 1 is houses that need work.
  if (subjectMoved && playbook && !LIFECYCLE.has(draft.intent) && !notOurKind && !qualifyHeld && !replyPassed) {
    const already = new Set([...plan.auto, ...plan.suggested].map((a) => `${a.type}:${a.workflowId || (a.tags || []).join(",") || a.key || ""}`));
    const extra = planActions({ party, intent: "new_property", confidence: "high", playbook, minConfidence: "high" });
    const fresh = [...extra.auto, ...extra.suggested].filter((a) => !already.has(`${a.type}:${a.workflowId || (a.tags || []).join(",") || a.key || ""}`))
      .filter((a) => !(notOurKind && a.type === "start_underwrite"))
      // A street with no number isn't a house to underwrite yet; the reply asks for it.
      .filter((a) => !(a.type === "start_underwrite" && housesWithoutNumber.length && !underwritableAddress(draft.propertyAddress)))
      .map((a) => ({ ...a, via: "subject moved" }));
    if (fresh.length) {
      for (const a of fresh) (a.mode === "auto" ? plan.auto : plan.suggested).push(a);
      record = { ...record, actions: [...record.actions, ...fresh], updatedAt: new Date().toISOString() };
      await store.updateReplyDraft(record.id, record).catch(() => {});
    }
  }

  /* --- 4e°. GHL follows the offers: no tier tag, no TIER workflow --- */
  // Matt's four stages (2026-10-13): Tier 3 is folded into Tier 2 and the
  // offers move the card. A tier-3 tag on a "no" would start GHL's TIER 3
  // workflow, which drags the card back into a stage that's gone. The tier-1
  // tag and TIER 1 workflow go too (2026-10-14): they moved the card into
  // Tier 1 on the model's intent alone — Dana F., Loren K.,
  // Lan N., on replies that passed — and the underwrite the rule carries
  // (start_underwrite) is what makes an offer, and the offer moves the card.
  const followsOffers = (x) => isLowerTierAction(x) || isTierOneCardAction(x);
  if (party === "agent" && normalizeGhlStages(saved?.ghlStages).mode === "on" && [...plan.auto, ...plan.suggested].some(followsOffers)) {
    const why = "the pipeline follows the offers — the stage comes from the offers, not a tag or a TIER workflow";
    plan.auto = plan.auto.filter((x) => !followsOffers(x));
    plan.suggested = plan.suggested.filter((x) => !followsOffers(x));
    record = { ...record, actions: (record.actions || []).map((x) => (followsOffers(x) && x.status === "pending" ? { ...x, status: "skipped", detail: why } : x)), updatedAt: new Date().toISOString() };
    await store.updateReplyDraft(record.id, record).catch(() => {});
  }

  /* --- 4e′. a house we passed on doesn't put them back on Tier 1 --- */
  // Tier 1 is the list Matt works by hand (GHL's stage); a pass takes the
  // house off it. An agent pitching the same house again ("still needs a
  // gut, want another look?") would otherwise be re-tagged and their card
  // reopened to Tier 1 — the tier-1 rule's actions stand down for it. A
  // different house still runs the rule. (Matt, 2026-10-07)
  if (party === "agent" && draft.propertyAddress && [...plan.auto, ...plan.suggested].some(isTierOneAction)) {
    const evs = (await store.listContactEvents?.(locationId, job.contactId, { types: [...TIER_ONE_OUT_EVENTS, "tier1_added"], limit: 100 }).catch(() => [])) || [];
    const passed = passedOnHouse({ offers: bookRows, events: evs, address: draft.propertyAddress });
    if (passed) {
      plan.auto = plan.auto.filter((x) => !isTierOneAction(x));
      plan.suggested = plan.suggested.filter((x) => !isTierOneAction(x));
      record = { ...record, actions: (record.actions || []).map((x) => (isTierOneAction(x) && x.status === "pending" ? { ...x, status: "skipped", detail: passed.why } : x)), updatedAt: new Date().toISOString() };
      await store.updateReplyDraft(record.id, record).catch(() => {});
    }
  }

  // A new house with no address: Tier 1 waits for the address. GHL's TIER 1
  // workflow underwrites the contact's Subject Property field, which still
  // names the house before — an agent (2026-10-08) said Walker Park Rd
  // was "not a project", then mentioned an almost-done flip with no address,
  // and TIER 1 priced Walker Park at 810K; it was floated and papered. The
  // reply asks for the address; the message that gives it runs Tier 1 on it.
  if (party === "agent" && !String(draft.propertyAddress || "").trim()
    && (draft.intent === "new_property" || draft.intent === "deal_available")
    && [...plan.auto, ...plan.suggested].some(isTierOneAction)) {
    const why = "waiting for the address: Tier 1 runs on the house once we have it";
    plan.auto = plan.auto.filter((x) => !isTierOneAction(x));
    plan.suggested = plan.suggested.filter((x) => !isTierOneAction(x));
    record = { ...record, actions: (record.actions || []).map((x) => (isTierOneAction(x) && x.status === "pending" ? { ...x, status: "skipped", detail: why } : x)), updatedAt: new Date().toISOString() };
    await store.updateReplyDraft(record.id, record).catch(() => {});
  }

  /* --- 4f. a new house runs Tier 1 again --- */
  // An agent already on Tier 1 who brings a DIFFERENT house got the tier-1 tag
  // and the TIER 1 workflow "added" again — which GHL treats as nothing: the
  // tag was already there, so no tag trigger, and they were already enrolled.
  // Angie Bomar's 3611 I St NE (2026-09-14) never got its own Tier 1 run. When
  // the subject property moved on this message, they leave Tier 1 first and
  // come back in, so the workflow runs for the new address. (The TIER 1
  // workflow must allow re-entry in GHL for the re-enroll to take.)
  {
    const subjectChanged = (filedLearned || []).some((l) => /^subject property:/i.test(String(l)));
    const wasTier1 = (a.tags || []).some((t) => /^tier-1$/i.test(String(t)));
    const t1Tag = plan.auto.find((x) => x.type === "add_tags" && (x.tags || []).some((t) => /^tier-1$/i.test(String(t))));
    const t1Flow = plan.auto.find((x) => x.type === "add_to_workflow" && /tier\s*1\b/i.test(String(x.workflowName || "")));
    if (party === "agent" && subjectChanged && wasTier1 && (t1Tag || t1Flow)) {
      const why = "a new house runs Tier 1 again";
      const inject = [
        ...(t1Tag ? [{ id: `a-t1tag-${job.id}`, type: "remove_tags", tags: ["tier-1"], mode: "auto", status: "pending", party, why }] : []),
        ...(t1Flow ? [{ id: `a-t1wf-${job.id}`, type: "remove_from_workflow", workflowId: t1Flow.workflowId, workflowName: t1Flow.workflowName, mode: "auto", status: "pending", party, why }] : []),
      ];
      const at = Math.min(...[t1Tag, t1Flow].filter(Boolean).map((x) => plan.auto.indexOf(x)));
      plan.auto.splice(at, 0, ...inject);
      record = { ...record, actions: [...inject, ...(record.actions || [])], updatedAt: new Date().toISOString() };
      await store.updateReplyDraft(record.id, record).catch(() => {});
    }
  }

  /* --- 4g. you stopped the bot on them: nothing that reaches them runs by itself --- */
  // After every step above that adds an action (the to-seller letter, the
  // band, a booking, the dataroom invite, Tier 1 re-entry), before any runs.
  // The draft offers each one; a person presses it. The reply keeps the
  // model's own words — "sent our letter of intent over" would not be true.
  if (a.hold?.held) {
    const why = holdLine(a.hold);
    const { plan: kept, held } = holdActionsWhileStopped(plan, why);
    if (held.length || record.replyBeforeSend) {
      plan.auto = kept.auto;
      plan.suggested = kept.suggested;
      const asked = new Map(held.map((x) => [x.id, x]));
      record = {
        ...record,
        actions: (record.actions || []).map((x) => (asked.has(x.id) && x.status === "pending" ? { ...x, mode: "ask", why: asked.get(x.id).why } : x)),
        ...(record.replyBeforeSend ? { reply: record.replyBeforeSend } : {}),
        updatedAt: new Date().toISOString(),
      };
      await store.updateReplyDraft(record.id, record).catch(() => {});
    }
  }

  /* --- 4e. re-quote before anything that files the offer dead --- */
  // Actions run in plan order, and the re-quote is appended last — so on a no
  // "mark passed" ran first, the offer closed, and the re-quote found "no open
  // offer to re-quote". Thomas Rinow's "Even at 60 in repairs we're well over
  // your price" (2026-09-14) was filed dead and tagged Tier 3 while the reply
  // still asked for a counter, and the higher number never went. So: the
  // re-quote runs first, and when it floats a new number the closers stand
  // down for this message — their answer to the new number decides.
  const isCloser = (x) => x.type === "mark_offer_passed"
    || (x.type === "add_tags" && (x.tags || []).some((t) => /^tier-3$/i.test(String(t))))
    || (x.type === "add_to_workflow" && /tier\s*3/i.test(String(x.workflowName || "")));
  const requoteFirst = plan.auto.find((x) => x.type === "requote_from_agent_numbers");
  if (party === "agent" && requoteFirst && plan.auto.some(isCloser)) {
    const [ran] = await runActions({
      client, locationId, contactId: job.contactId, actions: [requoteFirst],
      draft: { ...record, now }, deps, store,
    });
    const floated = ran?.status === "done" && /^re-ran /.test(String(ran.detail || ""));
    plan.auto = plan.auto.filter((x) => x !== requoteFirst && !(floated && isCloser(x)));
    const touched = new Map(ran ? [[ran.id, ran]] : []);
    if (floated) {
      for (const a of record.actions || []) {
        if (isCloser(a) && a.status === "pending") {
          touched.set(a.id, { ...a, status: "skipped", detail: "we came back with a new number — their answer to it decides" });
        }
      }
    }
    record = { ...record, actions: (record.actions || []).map((x) => touched.get(x.id) || x), updatedAt: new Date().toISOString() };
    await store.updateReplyDraft(record.id, record).catch(() => {});
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
    // "Running it by underwriting" leaves only if the underwrite started
    // (or was already running); "sending it over" only if the offer went.
    const uwFailed = done.find((x) => x.type === "start_underwrite" && x.status === "failed");
    if (uwFailed && !holdForBooking) {
      holdForBooking = `the underwrite didn't start: ${uwFailed.error || "unknown error"}`;
      record = { ...record, flags: [...(record.flags || []), holdForBooking], autoSend: { decided: false, reason: `needs a person: ${holdForBooking}` } };
    }
    // "Sent the written offer over" stands only if it went (or already had).
    const sellerSend = done.find((x) => x.type === "send_offer" && x.via === "to seller");
    if (sellerSend && record.replyBeforeSend
      && (sellerSend.status !== "done" || !/^(sent the offer|offer on .* already went out)/.test(String(sellerSend.detail || "")))) {
      record = { ...record, reply: record.replyBeforeSend, flags: [...(record.flags || []), `the offer didn't go with it: ${sellerSend.error || sellerSend.detail || "unknown"}`] };
    }
    // "Just emailed it" stands only if the email went. Otherwise the honest
    // line, held for a person: they are waiting on a document.
    const SENT_OK = /^(sent the offer|offer on .* already went out)/;
    const emailSend = done.find((x) => x.type === "send_offer" && x.emailTo);
    const emailWent = emailSend && emailSend.status === "done" && SENT_OK.test(String(emailSend.detail || ""));
    if (emailSend && !emailWent && emailSend.via === "to their email") {
      const why = `the email to ${emailSend.emailTo} didn't go: ${emailSend.error || emailSend.detail || "unknown"}`;
      record = { ...record, reply: "Having trouble getting that email out on my end. I'll get it over to you shortly and confirm once it's sent.",
        flags: [...(record.flags || []), why], autoSend: { decided: false, reason: `needs a person: ${why}` } };
      holdForBooking = holdForBooking || why;
    }
    // And the general rule: no text claims an email went unless one did, in
    // this run. The model has no way to send mail; only the action above does.
    if (!emailWent && CLAIMS_EMAIL_RX.test(String(record.reply || "")) && !holdForBooking) {
      const why = "the draft says something was emailed, and nothing was";
      record = { ...record, flags: [...(record.flags || []), why], autoSend: { decided: false, reason: `needs a person: ${why}` } };
      holdForBooking = why;
    }
    // "I'll send our written offer over anyway" stands only if it went; a
    // miss puts the model's words back and never holds the reply to a no.
    const recordSend = done.find((x) => x.type === "send_offer" && x.via === "for record");
    if (recordSend && record.replyBeforeSend
      && (recordSend.status !== "done" || !/^(sent the offer|offer on .* already went out)/.test(String(recordSend.detail || "")))) {
      record = { ...record, reply: record.replyBeforeSend, flags: [...(record.flags || []), `the written offer didn't go with it: ${recordSend.error || recordSend.detail || "unknown"}`] };
    }
    const sendFailed = done.find((x) => x.type === "send_offer" && x.via !== "counter band" && x.via !== "to seller" && x.via !== "for record"
      && (x.status !== "done" || !/^(sent the offer|offer on .* already went out)/.test(String(x.detail || ""))));
    if (sendFailed && !holdForBooking) {
      holdForBooking = `the offer didn't go out: ${sendFailed.error || sendFailed.detail || "unknown"}`;
      record = { ...record, flags: [...(record.flags || []), holdForBooking], autoSend: { decided: false, reason: `needs a person: ${holdForBooking}` } };
    }
    // "Sending the updated offer over now" leaves only if the paper did.
    const bandChain = done.filter((x) => x.via === "counter band");
    const bandFailed = bandChain.find((x) => x.status !== "done" || !/^(re-issued|sent the offer)/.test(String(x.detail || "")));
    if (bandFailed && !holdForBooking) {
      holdForBooking = `the counter-band offer did not go out: ${bandFailed.error || bandFailed.detail || bandFailed.type}`;
      record = { ...record, flags: [...(record.flags || []), holdForBooking], autoSend: { decided: false, reason: `needs a person: ${holdForBooking}` } };
    }
    // "415k works" leaves only if the price was actually written down.
    const investorBandFailed = done.find((x) => x.via === "investor band" && (x.status !== "done" || !/^agreed /.test(String(x.detail || ""))));
    if (investorBandFailed && !holdForBooking) {
      holdForBooking = `the agreed price was not recorded: ${investorBandFailed.error || investorBandFailed.detail || investorBandFailed.type}`;
      record = { ...record, flags: [...(record.flags || []), holdForBooking], autoSend: { decided: false, reason: `needs a person: ${holdForBooking}` } };
    }
    await store.updateReplyDraft(record.id, record).catch(() => {});
  }

  // Nothing to say back ("that was an auto dial") and nothing left for a
  // person to decide: the row was only saved because a tag ran on the way.
  // It closes itself instead of waiting on Today. A suggestion keeps it.
  const nothingToSay = draft.intent === "small_talk" && !String(draft.reply || "").trim() && !draft.needsHuman
    && !(record.actions || []).some((x) => x.status === "pending" || x.status === "suggested" || x.status === "error");
  if (nothingToSay) {
    const ts = new Date(now).toISOString();
    record = { ...record, status: "dismissed", dismissedAt: ts, updatedAt: ts, flags: [...(record.flags || []), "nothing to say back — not sent"] };
    await store.updateReplyDraft(record.id, record).catch(() => {});
    job.status = "done"; job.phase = ""; job.finishedAt = new Date().toISOString();
    return;
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
    draft, party, allowedAmounts: context.amounts, forbiddenAmounts: context.forbiddenAmounts, staleAmounts: context.staleAmounts || [], hiddenAmounts: context.hiddenAmounts || [], ranges: context.ranges || [], inboundMessage: message, channel, style: config.style,
    selfName: a.signer, contactName: a.contactName, signOff: config.persona?.signOff, botAnswer: config.persona?.ifAskedIfBot,
    ourAmount: ourNumberFor(context.offers?.numbers, draft.propertyAddress),
    writeUpOk: writeUpOkFor(context.offers?.numbers, draft.propertyAddress),
    vacantOk: vacantPerRecord(context?.deals, draft.propertyAddress),
    houseWords: houseWordsFor(context?.deals, a.transcript, message),
  });
  const auto = decideAutoSend({ gate, party, intent: draft.intent, channel, config, sendsEnabled, humanActive: a.humanActive, hold: a.hold });
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

export async function sendReplyDraft({ client, store, locationId, draftId, text, live, auto = false, reason = null, readThread = readRecentThread, now = Date.now(), dataroomBaseUrl = defaultDataroomBaseUrl(), cardBaseUrl = defaultCardBaseUrl() }) {
  const d = await store.getReplyDraft(draftId);
  if (!d || d.locationId !== locationId) throw Object.assign(new Error("no such draft"), { http: 404 });
  const sendable = OPEN_STATUSES.has(d.status) || (auto && d.status === "sending");
  if (!sendable) throw Object.assign(new Error(`that draft was already ${d.status}`), { http: 409 });
  let body = String(auto ? d.reply : (text ?? d.reply ?? "")).trim();
  if (!body) throw Object.assign(new Error("nothing to send"), { http: 400 });

  if (!live) {
    return { ok: true, dryRun: true, preview: { channel: d.channel, to: d.contactId, message: body } };
  }

  // You stopped the bot on them while this counted down (shared/bot-hold.js).
  // Nothing goes by itself until Resume or the pause's date: a text the
  // machine started is binned, a reply goes back to wait for your Send. The
  // draft is written before returning — the scheduler has already marked it
  // "sending", and a bare skip would leave it there to be "recovered" as
  // interrupted. Only the auto path: a person pressing Send is deciding.
  if (auto) {
    const hold = await holdFor({ store, locationId, contactId: d.contactId, offerId: d.outbound?.offerId || null, now });
    if (hold.held) {
      const ts = new Date(now).toISOString();
      const line = holdLine(hold);
      // A read that failed never bins anything: it waits instead.
      const machine = hold.kind !== "unread" && MACHINE_STARTED_KINDS.has(d.outbound?.kind) && !String(d.inbound || "").trim();
      if (machine) {
        await store.updateReplyDraft(d.id, {
          ...d, status: "dismissed", sendAt: null, sendingAt: null, dismissedAt: ts, updatedAt: ts,
          flags: [...(d.flags || []), `${line} — not sent`],
        });
        await removeContactTags(client, d.contactId, [RA_TAGS.draft]).catch(() => {});
      } else {
        await store.updateReplyDraft(d.id, {
          ...d, status: "draft", sendAt: null, sendingAt: null, heldAt: ts, updatedAt: ts,
          flags: [...(d.flags || []), `held: ${line}`],
          autoSend: { ...(d.autoSend || {}), decided: false, reason: `${line} — it waits for you` },
        });
      }
      return { ok: true, skipped: line };
    }
  }

  // A text the machine started, to anybody, about a house whose deal fell
  // through since it was queued (5232 S Yakima, 2026-10-03: a check-in to
  // the agent's TC). Matched loosely, so the thread's short spelling counts.
  if (auto && d.outbound?.kind) {
    const gone = await fellThroughFor({ store, locationId, addresses: [d.outbound.address, d.propertyAddress] });
    if (gone) {
      const ts = new Date(now).toISOString();
      const why = fellThroughLine(gone);
      await store.updateReplyDraft(d.id, {
        ...d, status: "dismissed", sendAt: null, sendingAt: null, dismissedAt: ts, updatedAt: ts,
        flags: [...(d.flags || []), `${why} — not sent`],
      });
      await removeContactTags(client, d.contactId, [RA_TAGS.draft]).catch(() => {});
      return { ok: true, skipped: why };
    }
  }

  // A deal can end while a text about it counts down (drafted Monday, marked
  // fell through Tuesday). An investor text about a deal that's over is
  // dismissed rather than sent. Only the auto path — a person pressing Send
  // is a person deciding.
  if (auto && d.party === "investor") {
    const address = d.outbound?.address || d.propertyAddress || "";
    let offer = d.outbound?.offerId && store.getOffer ? await store.getOffer(d.outbound.offerId).catch(() => null) : null;
    if (!offer && address && store.listDeals) {
      offer = (await store.listDeals(locationId, { limit: 200 }).catch(() => [])).find((o) => sameStreet(o?.address, address)) || null;
    }
    if (dealIsOver(offer?.deal)) {
      const ts = new Date(now).toISOString();
      const why = `the deal is ${offer.deal.stage.replace("_", " ")}`;
      await store.updateReplyDraft(d.id, {
        ...d, status: "dismissed", sendAt: null, sendingAt: null, dismissedAt: ts, updatedAt: ts,
        flags: [...(d.flags || []), `${why} — not sent`],
      });
      await removeContactTags(client, d.contactId, [RA_TAGS.draft]).catch(() => {});
      return { ok: true, skipped: why };
    }
    // You stopped outreach on the deal since this was queued (Stop outreach
    // on the deal pane). The machine's own text about it is dismissed; a
    // reply to something the buyer said goes as usual (stoppedDealAction).
    if (dealOutreachStopped(offer?.deal) && stoppedDealAction(d) === "dismiss") {
      const ts = new Date(now).toISOString();
      const street = String(offer.address || "the deal").split(",")[0].trim();
      const why = `you stopped outreach on ${street}`;
      await store.updateReplyDraft(d.id, { ...d, status: "dismissed", sendAt: null, sendingAt: null, dismissedAt: ts, updatedAt: ts, flags: [...(d.flags || []), `${why} — not sent`] });
      await removeContactTags(client, d.contactId, [RA_TAGS.draft]).catch(() => {});
      return { ok: true, skipped: why };
    }
  }

  // We walked away since (marked "we passed" while a check-in counted
  // down). Matt, 2026-09-22, the Medina thread: our own pass ends every text
  // the machine starts about that house. Their pass does not — a "they
  // passed" check-in is the point of that ladder. Only the auto path: a
  // person pressing Send is a person deciding.
  if (auto && d.party !== "investor" && d.outbound?.kind && !String(d.inbound || "").trim()) {
    // No offer id (a promise check-in carries only the address): the house
    // is found by their offers on it (3037 Massey Rd, 2026-10-19).
    const offer = (d.outbound?.offerId && store.getOffer ? await store.getOffer(d.outbound.offerId).catch(() => null) : null)
      || (d.outbound?.offerId ? null : await walkedAwayFor({ store, locationId, contactId: d.contactId, addresses: [d.outbound.address || d.propertyAddress] }));
    // The second look at a pass of ours over the numbers (shared/second-look.js
    // numbersPass) is the one text about a house we passed on: its picker read
    // that pass. A status marked since it was drafted still stops it.
    const lookAtOurPass = d.outbound.kind === "second_look" && offer && offerStatus(offer) === "we_passed"
      && d.outbound.offerStatus === "we_passed" && Boolean(d.outbound.statusAt) && d.outbound.statusAt === offer.statusAt;
    // The pass note is the text about our pass on these very houses; it is
    // checked against what you marked just below.
    if (offer && ["we_passed", "unavailable"].includes(offerStatus(offer)) && !lookAtOurPass && d.outbound.kind !== "pass_note") {
      const ts = new Date(now).toISOString();
      const why = walkedAwayLine({ ...offer, status: offerStatus(offer) });
      await store.updateReplyDraft(d.id, {
        ...d, status: "dismissed", sendAt: null, sendingAt: null, dismissedAt: ts, updatedAt: ts,
        flags: [...(d.flags || []), `${why} — not sent`],
      });
      await removeContactTags(client, d.contactId, [RA_TAGS.draft]).catch(() => {});
      return { ok: true, skipped: why };
    }
  }

  // The pass note (shared/pass-note.js): every house it names must still be
  // the pass you marked. A house you priced, un-passed or marked again since
  // stops it — a new mark has drafted a new note. Only the auto path.
  if (auto && d.outbound?.kind === "pass_note") {
    const houses = d.outbound.houses || [];
    const offers = new Map();
    for (const h of houses) {
      const o = h.offerId && store.getOffer ? await store.getOffer(h.offerId).catch(() => null) : null;
      if (o) offers.set(h.offerId, o);
    }
    const stale = passNoteStale(houses, offers);
    if (stale) {
      const ts = new Date(now).toISOString();
      await store.updateReplyDraft(d.id, {
        ...d, status: "dismissed", sendAt: null, sendingAt: null, dismissedAt: ts, updatedAt: ts,
        flags: [...(d.flags || []), `${stale} — not sent`],
      });
      await removeContactTags(client, d.contactId, [RA_TAGS.draft]).catch(() => {});
      return { ok: true, skipped: stale };
    }
  }

  // A live thread, or a yes (2026-10-15, shared/thread-health.js): a text the
  // machine started that now lands on a conversation they're having, or any
  // text — a reply too — that walks away from a house they said yes on. The
  // machine's own text is binned; a reply waits for you. Only the auto path.
  if (auto && d.party !== "investor") {
    const machineText = Boolean(d.outbound?.kind) && !String(d.inbound || "").trim();
    const live = await machineMayStartFor({ store, locationId, contactId: d.contactId, kind: machineText ? d.outbound.kind : "", why: d.outbound?.why || "",
      address: d.outbound?.address || d.propertyAddress || "", passes: ourReplyPasses(body), now });
    if (!live.ok) {
      const ts = new Date(now).toISOString();
      if (machineText) {
        await store.updateReplyDraft(d.id, {
          ...d, status: "dismissed", sendAt: null, sendingAt: null, dismissedAt: ts, updatedAt: ts,
          flags: [...(d.flags || []), `${live.reason} — not sent`],
        });
        await removeContactTags(client, d.contactId, [RA_TAGS.draft]).catch(() => {});
      } else {
        await store.updateReplyDraft(d.id, {
          ...d, status: "draft", sendAt: null, sendingAt: null, heldAt: ts, updatedAt: ts,
          flags: [...(d.flags || []), `held: ${live.reason}`],
          autoSend: { ...(d.autoSend || {}), decided: false, reason: `needs a person: ${live.reason}` },
        });
      }
      return { ok: true, skipped: live.reason, held: !machineText };
    }
  }

  // They unsubscribed since (or a blast never looked): GHL would answer 400
  // "has unsubscribed" and the row would come back as "Needs you" for a text
  // nobody can send. Dismissed instead, and the contact is flagged.
  if (auto) {
    const contact = await getContact(client, d.contactId).catch(() => null);
    if (d.channel === "email" ? emailUnsubscribed(contact) : smsUnsubscribed(contact)) {
      const ts = new Date(now).toISOString();
      await store.updateReplyDraft(d.id, {
        ...d, status: "dismissed", sendAt: null, sendingAt: null, dismissedAt: ts, updatedAt: ts,
        flags: [...(d.flags || []), "they unsubscribed — not sent"],
      });
      await removeContactTags(client, d.contactId, [RA_TAGS.draft]).catch(() => {});
      await markUnsubscribed({ client, store, locationId, contactId: d.contactId, party: d.party || "agent", now });
      return { ok: true, skipped: "they unsubscribed" };
    }
    // A bot-off tag ("stop bot") put on them since their deal text was
    // queued (2026-10-21): it waits for your Send, as it would have if the
    // tag had been there when it was queued (dispo-autopilot.js).
    if (d.outbound?.kind === "blast_open") {
      const saved = (await store.getOfferSettings?.(locationId).catch(() => null)) || {};
      const tag = matchTagPatterns(contact?.tags || [], conversationConfig(saved).routing?.botOffTags || [])[0];
      if (tag) {
        const ts = new Date(now).toISOString();
        const line = `bot is off for this contact (tag: ${tag})`;
        await store.updateReplyDraft(d.id, {
          ...d, status: "draft", sendAt: null, sendingAt: null, heldAt: ts, updatedAt: ts,
          flags: [...(d.flags || []), `held: ${line}`],
          autoSend: { ...(d.autoSend || {}), decided: false, reason: `${line} — it waits for you` },
        });
        return { ok: true, skipped: line };
      }
    }
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
      // A deal text isn't an answer to them, and may have waited days for
      // their week (shared/buyer-touch.js): you texting them since doesn't
      // bin it. It waits for you to send it or not.
      if (d.outbound?.kind === "blast_open") {
        const why = "you've texted them yourself since this was queued";
        await store.updateReplyDraft(d.id, {
          ...d, status: "draft", sendAt: null, sendingAt: null, heldAt: ts, updatedAt: ts,
          flags: [...(d.flags || []), `held: ${why} — send it or not`],
          autoSend: { ...(d.autoSend || {}), decided: false, reason: `${why} — it waits for you` },
        });
        return { ok: true, skipped: why, held: true };
      }
      await store.updateReplyDraft(d.id, {
        ...d, status: "dismissed", answeredBy: "you", sendAt: null, sendingAt: null, dismissedAt: ts, updatedAt: ts,
        flags: [...(d.flags || []), "you answered it yourself — the bot stood aside"],
      });
      await removeContactTags(client, d.contactId, [RA_TAGS.draft]).catch(() => {});
      return { ok: true, skipped: "answered by you", at: theirs.at };
    }
  }

  // One buyer, one week (shared/buyer-touch.js). Buck, 3511 NE 153rd St,
  // 2026-10-05: two pulse checks, the deal, a walkthrough invite and "Last
  // check" in eleven days. A deal text to a buyer whose week is spent waits
  // for it to open; when it goes, any other deal waiting for them goes in the
  // same text. Only the machine's own text on the auto path: a person
  // pressing Send is a person deciding, and an email isn't a text.
  let bundle = [];
  if (auto && d.outbound?.kind === "blast_open" && d.channel !== "email" && body === String(d.reply || "").trim()) {
    const saved = (await store.getOfferSettings?.(locationId).catch(() => null)) || {};
    const budget = normalizeTouchBudget(saved.dispoAutopilot?.touchBudget);
    if (budget.enabled) {
      // A deal text waits for their week only when Matt asks (holdDealTexts,
      // off since 2026-10-21); a deal queued for them alongside still bundles.
      const limit = budget.holdDealTexts ? await buyerTouchLimit({ store, locationId, contactId: d.contactId, budget, now }) : { open: true };
      if (!limit.open) {
        const config = conversationConfig(saved);
        const sendAt = spreadAcrossDay({ now: limit.at, quietHours: machineHours(config.autoSend), hours: 0, weekends: config.autoSend.weekends || "all" });
        const ts = new Date(now).toISOString();
        const line = `waits for this buyer's weekly limit — goes ${slotWord(Date.parse(sendAt))}, with anything else new for them`;
        await store.updateReplyDraft(d.id, {
          ...d, status: "scheduled", sendAt, sendingAt: null, updatedAt: ts,
          flags: [...(d.flags || []).filter((f) => !/^waits for this buyer's weekly limit/.test(f)), line],
        });
        return { ok: true, skipped: line, sendAt };
      }
      const waiting = (await store.listReplyDrafts(locationId, { contactId: d.contactId, status: "scheduled", limit: 20 }).catch(() => []))
        .filter((o) => o.id !== d.id && o.outbound?.kind === "blast_open" && o.channel !== "email"
          && o.outbound?.offerId && o.outbound.offerId !== d.outbound?.offerId)
        .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
      for (const o of waiting) {
        if (bundle.length >= budget.bundleMax - 1) break;
        if (bundle.some((x) => x.outbound.offerId === o.outbound.offerId)) continue;
        const offer = await store.getOffer?.(o.outbound.offerId).catch(() => null);
        const deal = offer?.deal;
        if (!deal || dealIsOver(deal) || dealOutreachStopped(deal)) continue;
        const paused = dealOutreachPaused(deal);
        if (paused && paused.contactId !== d.contactId) continue;
        // Each house answers the same checks its own text would: a bot stop
        // on that house, or the house falling through.
        const held = await holdFor({ store, locationId, contactId: d.contactId, offerId: o.outbound.offerId, now });
        if (held.held) continue;
        if (await fellThroughFor({ store, locationId, addresses: [o.outbound.address, offer.address] })) continue;
        // Claimed before anything goes, so an overlapping scheduler tick
        // can't send it on its own as well. Read again: it may have gone.
        const fresh = await store.getReplyDraft(o.id).catch(() => null);
        if (!fresh || fresh.status !== "scheduled") continue;
        const claimed = { ...fresh, status: "sending", sendingAt: new Date(now).toISOString(), combinedInto: d.id, updatedAt: new Date(now).toISOString() };
        await store.updateReplyDraft(o.id, claimed);
        bundle.push(claimed);
      }
    }
  }

  // A blast is written again as it leaves: the deal's price now, not when it
  // was queued, and the buyer's own package link (blast-refresh.js). Only the
  // machine's own words — a text a person rewrote goes as they wrote it. A
  // deal whose price can't be read holds the text rather than send a number
  // nobody checked.
  // A deal claimed for the combined text that ends up not in it goes back
  // to waiting, as it was.
  const release = async (rows) => {
    for (const o of rows) {
      const fresh = await store.getReplyDraft(o.id).catch(() => null);
      if (fresh?.status !== "sending" || fresh.combinedInto !== d.id) continue;
      const { combinedInto: _c, sendingAt: _s, ...rest } = fresh;
      await store.updateReplyDraft(o.id, { ...rest, status: "scheduled", updatedAt: new Date().toISOString() }).catch(() => {});
    }
  };
  let blast = null;
  if (d.outbound?.kind === "blast_open" && body === String(d.reply || "").trim()) {
    try {
      if (bundle.length) blast = await refreshBundleText({ store, locationId, draft: d, others: bundle });
      const carried = new Set((blast?.bundle || []).map((p) => p.draftId));
      await release(bundle.filter((o) => !carried.has(o.id)));
      if (!blast) blast = await refreshBlastText({ store, client, locationId, draft: d, baseUrl: dataroomBaseUrl });
    } catch (e) {
      await release(bundle);
      const ts = new Date(now).toISOString();
      await store.updateReplyDraft(d.id, {
        ...d, status: "draft", sendAt: null, sendingAt: null, updatedAt: ts,
        flags: [...(d.flags || []), `couldn't read the deal's price (${e.message}) — not sent`],
      });
      return { ok: true, skipped: "couldn't read the deal's price" };
    }
    if (blast?.text) body = blast.text;
  }

  // The last look before a buyer's deal or walkthrough text leaves by itself
  // (2026-10-15): one that still says what the carriers block waits for you,
  // as the price hold above does. A link only counts to a buyer who has never
  // written back. You pressing Send is you deciding.
  if (auto && d.channel !== "email" && BUYER_CARRIER_KINDS.has(d.outbound?.kind)) {
    let words = carrierFlags(body);
    if (words.includes("a link")) {
      const inv = await store.getInvestor?.(locationId, d.contactId).catch(() => null);
      if (inv?.doc?.lastRepliedAt || inv?.lastRepliedAt) words = words.filter((w) => w !== "a link");
    }
    if (words.length) {
      await release(bundle);
      // The package link minted for it goes back; your Send mints a fresh one.
      if (blast?.invite?.id) await store.updateDataroomInvite?.(blast.invite.id, { status: "revoked" })?.catch?.(() => {});
      const ts = new Date(now).toISOString();
      const why = `carriers block texts like this — it says ${words.map((w) => `"${w}"`).join(", ")}`;
      await store.updateReplyDraft(d.id, {
        ...d, status: "draft", sendAt: null, sendingAt: null, heldAt: ts, updatedAt: ts,
        flags: [...(d.flags || []), `held: ${why} — not sent`],
        autoSend: { ...(d.autoSend || {}), decided: false, reason: `${why} — it waits for you` },
      });
      return { ok: true, skipped: why, held: true };
    }
  }

  let result;
  if (d.channel === "email") {
    // A deal sent by email is a new message, not a reply: it says what the
    // house is and the price (shared/blast-text.js blastSubject).
    const subject = blast?.subject || d.outbound?.subject || (d.propertyAddress ? `Re: ${d.propertyAddress}` : "Re: your message");
    const html = body.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");
    result = await sendEmail(client, { contactId: d.contactId, subject, html });
  } else {
    try { result = await sendSms(client, { contactId: d.contactId, message: body }); }
    catch (e) { await release(bundle); throw e; }
  }

  const ts = new Date().toISOString();
  const updated = {
    ...d, status: "sent", sentAt: ts, sentText: body, autoSent: Boolean(auto),
    edited: auto || blast ? false : body !== String(d.reply || "").trim(),
    ...(blast ? { quotedPrice: blast.price, ...(blast.invite ? { dataroomInviteId: blast.invite.id } : {}), ...(blast.withoutLink ? { blastWithoutLink: true } : {}) } : {}),
    ...(blast?.bundle ? { outbound: { ...d.outbound, bundle: blast.bundle.map(({ offerId, address }) => ({ offerId, address })) } } : {}),
    // Why a person changed it, when they said (the nightly coach reads this).
    ...(!auto && normalizeDraftFeedback(reason) ? { feedback: { ...normalizeDraftFeedback(reason), at: ts } } : {}),
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
      data: { draftId: d.id, auto: Boolean(auto), label: d.outbound.label || "", via: "app", channel: d.channel === "email" ? "email" : "sms" },
    }).catch(() => {});
    await store.setInvestorStatus?.(locationId, d.contactId, { lastBlastAt: ts }).catch(() => {});
    // The other deals that went in this text: each is sent, as far as its
    // waves, its feedback and its Flow attribution are concerned, and its own
    // queued text stands down.
    const street = (a) => String(a || "").split(",")[0].trim();
    for (const part of (blast?.bundle || []).filter((p) => p.draftId !== d.id)) {
      const other = await store.getReplyDraft(part.draftId).catch(() => null);
      if (other && (OPEN_STATUSES.has(other.status) || (other.status === "sending" && other.combinedInto === d.id))) {
        await store.updateReplyDraft(other.id, {
          ...other, status: "superseded", combinedInto: d.id, sendAt: null, sendingAt: null, updatedAt: ts,
          flags: [...(other.flags || []), `went out together with ${street(d.outbound.address || d.propertyAddress)}`],
        }).catch(() => {});
      }
      await recordEvent({
        store, locationId, contactId: d.contactId, party: "investor", type: "blast_sent", at: ts,
        address: part.address, offerId: part.offerId, source: "blast", ref: part.draftId,
        dedupeKey: `blast:${part.offerId}:${d.contactId}`,
        data: { draftId: d.id, bundledWith: d.id, auto: Boolean(auto), label: other?.outbound?.label || "", via: "app", channel: "sms" },
      }).catch(() => {});
    }
    if (blast?.invite) {
      await store.updateDataroomInvite?.(blast.invite.id, { sentAt: ts }).catch(() => {});
      await store.logDataroomEvent?.(blast.room.id, blast.invite.id, "sent", { via: "blast" }).catch(() => {});
    }
  }
  // An ask for off-market houses actually went (shared/off-market.js), in
  // whatever text carried it: the next one waits a month.
  if ((d.party || "agent") === "agent" && OFF_MARKET_ASK_RX.test(body)) {
    await recordEvent({
      store, locationId, contactId: d.contactId, party: "agent", type: "offmarket_asked", at: ts, source: "conversation", ref: d.id,
      dedupeKey: `offmarket_asked:${d.contactId}:${ts.slice(0, 10)}`, data: { draftId: d.id, auto: Boolean(auto) },
    }).catch(() => {});
  }
  // Our ask for a call, and for their other fixers, actually went (the call
  // ask, 2026-10-15): asked once, and the Desk can see who was asked.
  if ((d.party || "agent") === "agent") {
    for (const [type, rx] of [["call_asked", CALL_ASK_RX], ["fixers_asked", FIXERS_ASK_RX]]) {
      if (!rx.test(body)) continue;
      await recordEvent({
        store, locationId, contactId: d.contactId, party: "agent", type, at: ts, source: "conversation", ref: d.id,
        dedupeKey: `${type}:${d.contactId}:${ts.slice(0, 10)}`, data: { draftId: d.id, auto: Boolean(auto) },
      }).catch(() => {});
    }
  }
  // A pass about a house of theirs actually went (the pass note, a kind
  // pass): the check-in counts it as our last word (2026-10-22).
  if (d.outbound?.kind === "pass_note" || d.outbound?.kind === "kind_pass") {
    await recordEvent({
      store, locationId, contactId: d.contactId, party: "agent", type: "pass_texted", at: ts,
      address: d.outbound.address || d.propertyAddress || "", source: "conversation", ref: d.id, dedupeKey: `pass_texted:${d.id}`,
      data: { draftId: d.id, kind: d.outbound.kind, auto: Boolean(auto) },
    }).catch(() => {});
  }
  // The agent's check-in actually went: the cadence and the "unanswered"
  // counts (shared/agent-pulse.js) read this, never the claim.
  if (d.outbound?.kind === "agent_pulse") {
    await recordEvent({
      store, locationId, contactId: d.contactId, party: "agent", type: "agent_pulse_texted", at: ts,
      address: d.outbound.address || "", source: "conversation", ref: d.id, dedupeKey: `agent_pulse_texted:${d.id}`,
      data: { draftId: d.id, auto: Boolean(auto), segment: d.outbound.segment || "", reason: d.outbound.reason || "", listingKey: d.outbound.listingKey || null,
        // What it named (shared/agent-pulse.js checkInHook), to read replies by.
        ...(d.outbound.hook ? { hook: d.outbound.hook } : {}) },
    }).catch(() => {});
  }
  // The pass note went: each house it named is done (shared/pass-note.js).
  if (d.outbound?.kind === "pass_note") {
    for (const h of d.outbound.houses || []) {
      const o = h.offerId && store.getOffer ? await store.getOffer(h.offerId).catch(() => null) : null;
      if (!o || o.passNote?.status === "sent") continue;
      await store.updateOffer(o.id, { ...o, passNote: { ...(o.passNote || {}), status: "sent", sentAt: ts, draftId: d.id } }).catch(() => {});
    }
  }
  // The second look at a past offer actually went (shared/second-look.js):
  // how many a house has had, and when the last one was, read this.
  if (d.outbound?.kind === "second_look") {
    await recordEvent({
      store, locationId, contactId: d.contactId, party: "agent", type: SECOND_LOOK_SENT, at: ts,
      address: d.outbound.address || d.propertyAddress || "", offerId: d.outbound.offerId || null, source: "conversation", ref: d.id,
      dedupeKey: `${SECOND_LOOK_SENT}:${d.id}`, data: { draftId: d.id, auto: Boolean(auto), amount: Number(d.outbound.amount) || null, step: d.outbound.step ?? null },
    }).catch(() => {});
  }
  // Our number actually went by text: the offer is Sent from here
  // (shared/offer-stage.js), and its agent's card follows. `floatSentAt` is
  // the same fact floatSentIndex reads off the drafts, kept on the offer so
  // every lean read has it.
  //
  // A range that went (2026-10-07) is remembered too, so the next reply knows
  // the bottom was never an offer and a number inside it waits for a person.
  // Only when the text that went still says the range.
  if (d.outbound?.kind === "realm_check" && d.outbound.offerId) {
    const withRange = d.outbound.range?.low && rangeLows(body).some((r) => Math.abs(r.low - d.outbound.range.low) < 1000);
    try {
      const o = await store.getOffer(d.outbound.offerId);
      if (o) {
        o.floatSentAt = ts;
        if (withRange) o.proactive = { ...(o.proactive || {}), range: { low: d.outbound.range.low, high: d.outbound.range.high, step: d.outbound.range.step || 10000, at: ts } };
        await store.updateOffer(o.id, o);
      }
    } catch (e) { console.error(`reply-agent: could not note the float on ${d.outbound.offerId}:`, e?.message); }
  }
  // The buyer pulse actually went: "two in a row with no answer" counts
  // these, never the day's claim (shared/buyer-pulse.js, 2026-10-05).
  if (d.outbound?.kind === "buyer_pulse") {
    await recordEvent({
      store, locationId, contactId: d.contactId, party: "investor", type: "pulse_texted", at: ts,
      source: "conversation", ref: d.id, dedupeKey: `pulse_texted:${d.id}`, data: { draftId: d.id, auto: Boolean(auto) },
    }).catch(() => {});
  }
  // A gatekeeper's email, text or check-in actually went: the sequence's
  // clock (shared/gatekeeper-sequence.js) runs from here, not the draft.
  if (GATEKEEPER_OUT_KINDS.includes(d.outbound?.kind)) {
    await recordEvent({
      store, locationId, contactId: d.contactId, party: "gatekeeper", type: "gatekeeper_sent", at: ts, address: d.outbound.address || "",
      source: "conversation", ref: d.id, dedupeKey: `gatekeeper_sent:${d.id}`,
      data: { draftId: d.id, step: d.outbound.step || "", hookKey: d.outbound.hookKey || null, channel: d.channel === "email" ? "email" : "sms", auto: Boolean(auto), edited: Boolean(updated.edited) },
    }).catch(() => {});
  }
  if (d.outbound?.kind === "outreach_open") {
    await recordEvent({
      store, locationId, contactId: d.contactId, party: "agent", type: "outreach_sent", at: ts,
      address: d.outbound.address || d.propertyAddress || "", source: "conversation", ref: d.id,
      dedupeKey: `outreach:${d.contactId}:${d.id}`,
      data: { draftId: d.id, auto: Boolean(auto), contactName: d.contactName || "", ...(d.outbound.county ? { county: d.outbound.county } : {}),
        // What went, for reading replies by opening (2026-10-15): the
        // variant and opening move it was written from, whether it was a
        // turnkey seat, how long it was, and whether a person changed it.
        ...(d.outbound.variant != null ? { variant: d.outbound.variant, openingMove: d.outbound.move } : {}),
        // "plain" since 2026-10-16; none before that.
        ...(d.outbound.style ? { style: d.outbound.style } : {}),
        turnkey: d.outbound.turnkey === true, chars: body.length, edited: Boolean(updated.edited), ...(d.outbound.offMarket ? { offMarket: true } : {}),
        ...(d.outbound.pastListing ? { pastListing: true } : {}) },
    }).catch(() => {});
  }
  // A reply that promised to come back starts a clock (promise-sweep.js). The
  // numbers themselves, and the promise_due text, promise nothing new.
  // A text that delivers what we promised — a price, or our pass — keeps it
  // (shared/promise-owed.js keepsOurWord), so neither Today's owed rows nor
  // the sweep chase a number that already went. A millisecond ahead of a
  // promise the same text makes ("we'd be at 598k … I'll get the offer
  // over"), which stays open.
  const keeps = d.party === "agent" ? (["realm_check", "take_check", "kind_pass", "pass_note"].includes(d.outbound?.kind) ? "sent" : keepsOurWord(body)) : null;
  if (keeps) {
    await recordEvent({
      store, locationId, contactId: d.contactId, party: "agent", type: "promise_kept", at: new Date(Date.parse(ts) - 1).toISOString(),
      address: d.propertyAddress || d.outbound?.address || "", source: "conversation", ref: d.id,
      dedupeKey: `promise_kept:${d.contactId}:sent:${d.id}`, data: { by: keeps === "sent" ? d.outbound.kind : `our_${keeps}`, draftId: d.id },
    }).catch(() => {});
  }
  if (d.party === "agent" && !["realm_check", "take_check", "promise_due"].includes(d.outbound?.kind || d.intent)) {
    const what = detectPromise(body);
    if (what) {
      await recordEvent({
        store, locationId, contactId: d.contactId, party: "agent", type: "promise_made", at: ts,
        address: d.propertyAddress || d.outbound?.address || "", source: "conversation", ref: d.id,
        dedupeKey: `promise_made:${d.id}`,
        data: { what, draftId: d.id, dueAt: new Date(Date.parse(ts) + PROMISE_DUE_HOURS * 3600000).toISOString(), text: body.slice(0, 200), asksThem: endsWithQuestionToThem(body), ...(isConditionalPromise(body) ? { conditional: true } : {}) },
      }).catch(() => {});
    }
  }
  // Matt's contact card, in its own text right behind this one, when they
  // asked who we are or an agent's house didn't work (shared/contact-card.js).
  const card = await followWithCard({ client, store, locationId, draft: updated, body, auto, baseUrl: cardBaseUrl, now });
  if (auto && d.noteOnAutoSend !== false) {
    await createContactNote(client, d.contactId, {
      body: `Conversation AI sent this reply itself (${d.party || "agent"} · ${String(d.intent || "").replace(/_/g, " ")}):\n\n${body}`,
    }).catch(() => {});
  }
  return { ok: true, dryRun: false, draft: updated, ...(card.sent ? { contactCard: card.why } : {}) };
}

/**
 * stopMachineTextsForOffer({ client, store, locationId, offer, why }) → [draftId]
 *
 * Every open text the machine started about this house (a nudge, a check-in,
 * a price-drop note — anything with an outbound kind and no inbound) is
 * dismissed. The status routes call it when an offer is marked "we passed":
 * a house we walked from gets no more chasing, whatever was already queued.
 * Replies to something the agent said are left alone — they are answers,
 * not outreach.
 */
export async function stopMachineTextsForOffer({ client, store, locationId, offer, why = "", now = Date.now() }) {
  if (!offer?.id || !offer.contactId) return [];
  const open = [];
  for (const status of ["draft", "scheduled"]) {
    open.push(...await store.listReplyDrafts(locationId, { contactId: offer.contactId, status, limit: 20 }).catch(() => []));
  }
  const ts = new Date(now).toISOString();
  const flag = `${why || `we passed on ${offer.address || "that house"}`} — not sent`;
  const stopped = [];
  for (const d of open) {
    if (!d?.outbound?.kind || String(d.inbound || "").trim()) continue;
    if (d.outbound.offerId !== offer.id) continue;
    await store.updateReplyDraft(d.id, { ...d, status: "dismissed", sendAt: null, sendingAt: null, dismissedAt: ts, updatedAt: ts, flags: [...(d.flags || []), flag] });
    stopped.push(d.id);
  }
  if (stopped.length && client) await removeContactTags(client, offer.contactId, [RA_TAGS.draft]).catch(() => {});
  return stopped;
}

/**
 * standDownForHold({ client, store, locationId, contactId, why, now }) → { pulled, held }
 *
 * Stop (or Pause) pressed on a person. What was waiting to go to them stops
 * now rather than at its send time: every open text the machine started (a
 * nudge, a check-in, a price drop) is binned, "… — not sent"; a reply that
 * was counting down goes back to wait for a person's Send. A reply already
 * waiting for you keeps waiting, and a row already sending is out of our
 * hands. Resume re-sends nothing — what was held waits for Send.
 */
export async function standDownForHold({ client, store, locationId, contactId, why = "you stopped the bot on them", now = Date.now() }) {
  if (!contactId) return { pulled: [], held: [] };
  const open = [];
  for (const status of ["draft", "scheduled"]) {
    open.push(...await store.listReplyDrafts(locationId, { contactId, status, limit: 50 }).catch(() => []));
  }
  const ts = new Date(now).toISOString();
  const pulled = [];
  const held = [];
  for (const d of open) {
    if (!d || d.contactId !== contactId) continue;
    const machine = MACHINE_STARTED_KINDS.has(d.outbound?.kind) && !String(d.inbound || "").trim();
    if (machine) {
      await store.updateReplyDraft(d.id, { ...d, status: "dismissed", sendAt: null, sendingAt: null, dismissedAt: ts, updatedAt: ts, flags: [...(d.flags || []), `${why} — not sent`] });
      pulled.push(d.id);
    } else if (d.status === "scheduled") {
      await store.updateReplyDraft(d.id, {
        ...d, status: "draft", sendAt: null, heldAt: ts, updatedAt: ts, flags: [...(d.flags || []), `held: ${why}`],
        autoSend: { ...(d.autoSend || {}), decided: false, reason: `${why} — it waits for you` },
      });
      held.push(d.id);
    }
  }
  // Nothing left open for them: the draft tag comes off, as on a dismiss.
  if (pulled.length && open.every((d) => pulled.includes(d.id)) && client) {
    await removeContactTags(client, contactId, [RA_TAGS.draft]).catch(() => {});
  }
  return { pulled, held };
}

/**
 * stoppedDealAction(draft) → "dismiss" | "reply"
 *
 * What stopping outreach on a deal does to an open text about it. Stop is
 * for the outreach the machine starts (Matt, 2026-10-27, 1146 N 77th: "The
 * stop is really just for initial outreach going out to these people"): a
 * blast, a nudge, a walkthrough text — an outbound kind and nothing they
 * said — is dismissed. A reply to something a buyer said goes on as it
 * would on any deal. (Until 2026-10-27 replies were held for you, and a
 * pass or thanks was dropped; on 77th that left every buyer who wrote back
 * without an answer.)
 */
export const stoppedDealAction = (d) => (d?.outbound?.kind && !String(d.inbound || "").trim() ? "dismiss" : "reply");

/**
 * stopDealOutreach({ client, store, locationId, offer }) → { dismissed: [id], held: [id] }
 *
 * The moment you stop outreach on a deal, every buyer text about it already
 * queued is pulled back rather than left to be caught at its send time (the
 * guard in sendReplyDraft): the machine's own are dismissed, from the outbox
 * too. A reply to a buyer is left as it is (stoppedDealAction); `held` stays
 * empty and is kept for the route's answer. The listing agent's thread is not
 * a buyer's and is left alone.
 */
export async function stopDealOutreach({ client, store, locationId, offer, now = Date.now() }) {
  const out = { dismissed: [], held: [] };
  if (!offer?.id) return out;
  const open = await store.listReplyDrafts(locationId, { status: ["draft", "scheduled"], limit: 5000 }).catch(() => []);
  const ts = new Date(now).toISOString();
  const why = `you stopped outreach on ${String(offer.address || "the deal").split(",")[0].trim()}`;
  for (const d of open) {
    if (d?.party !== "investor" || !["draft", "scheduled"].includes(d.status)) continue;
    const about = d.outbound?.offerId ? d.outbound.offerId === offer.id
      : Boolean(offer.address && sameStreet(d.outbound?.address || d.propertyAddress || "", offer.address));
    if (!about) continue;
    if (stoppedDealAction(d) === "dismiss") {
      await store.updateReplyDraft(d.id, { ...d, status: "dismissed", sendAt: null, sendingAt: null, dismissedAt: ts, updatedAt: ts, flags: [...(d.flags || []), `${why} — not sent`] });
      if (client) await removeContactTags(client, d.contactId, [RA_TAGS.draft]).catch(() => {});
      out.dismissed.push(d.id);
    }
  }
  return out;
}

export async function dismissReplyDraft({ client, store, locationId, draftId, reason = null }) {
  const d = await store.getReplyDraft(draftId);
  if (!d || d.locationId !== locationId) throw Object.assign(new Error("no such draft"), { http: 404 });
  if (!OPEN_STATUSES.has(d.status)) return { ok: true, draft: d };
  const ts = new Date().toISOString();
  const why = normalizeDraftFeedback(reason);
  // dismissedBy tells the coach a person binned it, not a gate or a dead deal.
  const updated = { ...d, status: "dismissed", sendAt: null, dismissedAt: ts, dismissedBy: "you", ...(why ? { feedback: { ...why, at: ts } } : {}), updatedAt: ts };
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
  const [done] = await runActions({ client, locationId, contactId: d.contactId, actions: [action], draft: d, deps: { ...deps, byPerson: true }, store });
  const applied = { ...done, status: done.status === "done" ? "applied" : done.status };
  const updated = { ...d, actions: d.actions.map((a) => (a.id === actionId ? applied : a)), updatedAt: new Date().toISOString() };
  await store.updateReplyDraft(d.id, updated);
  return { ok: true, action: applied, draft: updated };
}

const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
