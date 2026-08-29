// auto-underwrite.js — an offer, start to finish, from one inbound text.
//
// A listing agent texts "you still buying? 1234 NE 8th St, asking 525k". A GHL
// workflow webhooks that message here, and this runs the same five steps the
// operator would run by hand on the New Offer page:
//
//   extracting → read the address (and asking price) out of the message
//   comps      → pull closed sales, keep the ones within half a mile
//   grading    → have Claude grade each comp's condition from its sold photos
//   arv        → derive the ARV from the RENOVATED ones only
//   rehab      → scan the subject's listing photos into a priced scope of work
//   creating   → blended underwrite, offer + documents + GHL writeback
//
// Two things this deliberately does NOT do:
//
//   It never sends. The offer lands in History for a human to look at and
//   press Send, behind the CARD_SENDS_ENABLED rail that already exists.
//
//   It never guesses. A run that can't find three renovated comps within half
//   a mile, or can't get enough photos to scan, stops and saves a DRAFT with
//   the reason instead of publishing an offer built on a number nobody chose.
//   See evaluateGates — that function is the whole safety argument.
//
// Job state is in memory, like the enrichment sweep: a restart loses the job
// list but never corrupts anything, because every write is the same idempotent
// create the manual flow uses. The spend guards read from the store instead,
// precisely so a crash loop can't reset them.

import Anthropic from "@anthropic-ai/sdk";
import { pullComps, photonGeocode } from "./comps-pull.js";
import { pullZillowComps } from "./comps-zillow.js";
import { gradeComps } from "./comps-grade.js";
import { fetchZillowPhotos, fetchListingPhotos, scanRehabFromPhotos, anthropicErrorToHttp } from "./rehab-scan.js";
import { deriveArv } from "./shared/arv.js";
import { scoreComp, compareByMatch, milesBetween, markRenovatedByPrice, PRICE_PROXY_MIN_POOL } from "./shared/comp-match.js";
import { seedRoomCounts, applyScanSuggestion, priceScope } from "./shared/rehab-scope.js";
import { rehabBand } from "./shared/rehab-catalog.js";
import { fmtMoney } from "./shared/offer-calc.js";
import { addressKey } from "./shared/us-address.js";
import { buildTranscript } from "./enrich.js";
import { getContact, createContactNote, addContactTags, removeContactTags } from "./ghl.js";

/* ---------- the dials ---------- */

export const UW_RADIUS_MILES = 0.5;        // "under half a mile", as asked
export const UW_MIN_REHABBED_COMPS = 3;    // below this the run holds for review
export const UW_MAX_ARV_COMPS = 4;         // 3–4 comps carry the ARV
export const UW_GRADE_CANDIDATES = 6;      // how many we pay Apify+Claude to grade
// How wide the pool is that the PRICE PROXY ranks. Deliberately looser than the
// comps that end up carrying the ARV, because the two answer different
// questions — see the note above the condition stage in runUnderwrite.
//
// Measured, not guessed: on a live 78-comp pull around a 3/2 1,610 sqft house
// in Lake Forest Park, the tight bands (beds exact, baths ±0.5, sqft ±20%) left
// a pool of FOUR. The proxy needs six to have a top tier, so every run on a
// perfectly ordinary address would have held for review. These bands leave ten.
export const UW_POOL_BEDS_TOLERANCE = 1;
export const UW_POOL_BATHS_TOLERANCE = 1;
export const UW_POOL_SQFT_PCT = 0.30;
export const UW_MIN_SUBJECT_PHOTOS = 8;    // a 3-photo listing is not a scope of work
export const UW_REPAIRS_BAND_SLACK = 1.25; // how far past the heavy band is still plausible
export const UW_DEFAULT_DAILY_CAP = 25;
export const MAX_CONCURRENT_PER_LOCATION = 2;

const ARV_CONDITIONS = new Set(["renovated", "updated"]);

// The offer is only as good as the underwrite is honest, so the mode is fixed:
// blended is the number to lead with when you aren't in the room to argue one
// lens over another. See UNDERWRITE_MODES in shared/offer-calc.js.
export const UW_MODE = "blended";

export const UW_TAGS = {
  running: process.env.UW_RUNNING_TAG || "uw-running",
  done: process.env.UW_DONE_TAG || "uw-done",
  review: process.env.UW_REVIEW_TAG || "uw-needs-review",
  failed: process.env.UW_FAILED_TAG || "uw-failed",
};
const ALL_UW_TAGS = Object.values(UW_TAGS);

export const AUTO_UNDERWRITE_ENABLED = process.env.AUTO_UNDERWRITE_ENABLED === "true";

/* ---------- job registry ---------- */

const jobs = new Map();     // jobId -> job
const lanes = new Map();    // locationId -> { running, waiting: [fn] }

let seq = 0;
const newJobId = () => `uw-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function getJob(id) {
  return jobs.get(id) || null;
}

export function listJobs(locationId, { limit = 25 } = {}) {
  return [...jobs.values()]
    .filter((j) => j.locationId === locationId)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, limit);
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job || (job.status !== "running" && job.status !== "queued")) return false;
  job.cancelRequested = true;
  return true;
}

// JSON-safe view for the polling route. `stopping` mirrors the sweep's — a
// cancel lands between stages, so the UI needs to say "finishing up" rather
// than pretend the job already stopped.
export function publicJob(job) {
  if (!job) return null;
  const { cancelRequested, ...rest } = job;
  rest.stopping = Boolean(cancelRequested && (job.status === "running" || job.status === "queued"));
  return rest;
}

// For tests: the registry is process-wide, so a suite that starts jobs needs a
// way back to a clean slate.
export function _resetJobs() {
  jobs.clear();
  lanes.clear();
}

/* ---------- spend guards ---------- */

const dayStartIso = (now = Date.now()) => {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
};

// How many auto-underwrites this location has started today.
//
// Counted from the STORE, not just the in-memory registry, so a broker that
// restarts (or crash-loops on a bad payload) can't hand a misconfigured GHL
// workflow a fresh budget every few minutes. Jobs still in flight, and jobs
// that failed before writing anything, are unioned in from memory by id.
export async function countToday({ store, locationId, now = Date.now() }) {
  const since = dayStartIso(now);
  const ids = new Set();
  for (const j of jobs.values()) {
    if (j.locationId === locationId && String(j.startedAt) >= since) ids.add(j.id);
  }
  const rows = await store.listOffers(locationId, { limit: 200, lean: true }).catch(() => []);
  for (const o of rows) {
    const uw = o?.autoUnderwrite;
    if (uw?.jobId && String(uw.startedAt || o.createdAt || "") >= since) ids.add(uw.jobId);
  }
  return ids.size;
}

// Has this contact already had this address underwritten recently? A chatty
// agent following up on the same listing three times in an afternoon should
// cost one Apify run, not three.
export async function findRecent({ store, locationId, contactId, address, now = Date.now(), windowMs = 24 * 3600 * 1000 }) {
  const key = addressKey(address);
  if (!key) return null;
  const rows = await store.listOffers(locationId, { contactId, limit: 25, lean: true }).catch(() => []);
  for (const o of rows) {
    if (!o?.autoUnderwrite) continue;
    if (addressKey(o.address || "") !== key) continue;
    const ts = Date.parse(o.createdAt || o.autoUnderwrite.startedAt || "");
    if (Number.isFinite(ts) && now - ts <= windowMs) return o;
  }
  return null;
}

/* ---------- stage 1: what did the agent actually say? ---------- */

const EXTRACT_SYSTEM =
  "You read inbound text messages sent to a real-estate wholesaler by listing agents, and pull out the one " +
  "property the agent wants an offer on. Rules: " +
  "Return the full street address including city and state when they are recoverable — from the message itself, " +
  "or from earlier messages in the thread when the newest message is a follow-up (\"what about that one?\"). " +
  "Return an empty address rather than a guess: a wrong address underwrites a different house and nobody catches it. " +
  "confidence is 'high' only when the street number, street name and city are all explicit somewhere in the thread, " +
  "and the newest message is unambiguously about that property. Use 'medium' when you had to infer which property " +
  "from context, 'low' when you are stitching together fragments. " +
  "askingPrice is the list price in whole dollars if the agent states one ('asking 525k' -> 525000); 0 otherwise — " +
  "do NOT treat an offer amount, a price cut, or a range as the asking price. " +
  "note is one sentence saying what you keyed on.";

const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["address", "askingPrice", "confidence", "note"],
  properties: {
    address: { type: "string", description: "Full street address, or empty string if not recoverable" },
    askingPrice: { type: "integer", description: "List price in whole dollars, 0 when not stated" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    note: { type: "string", description: "One sentence on what you keyed on" },
  },
};

export async function extractRequest({ message, transcript, aiApiKey }) {
  const client = new Anthropic({ apiKey: aiApiKey, timeout: 120_000 });
  const text =
    `NEWEST INBOUND MESSAGE (this is the one to act on):\n"${String(message || "").slice(0, 2000)}"\n\n` +
    (transcript
      ? `EARLIER THREAD (US = our team, THEM = the agent) — context only:\n${String(transcript).slice(0, 12000)}\n\n`
      : "") +
    "Which property does the agent want an offer on?";

  let response;
  try {
    response = await client.beta.messages.create({
      model: "claude-opus-5",
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      // A safety refusal on "read an address out of a text" is close to
      // impossible, but an unattended pipeline has nobody to retry it, so the
      // server-side fallback costs nothing and removes the failure mode.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: EXTRACT_SYSTEM,
      output_config: { format: { type: "json_schema", schema: EXTRACT_SCHEMA } },
      messages: [{ role: "user", content: [{ type: "text", text }] }],
    });
  } catch (e) {
    throw anthropicErrorToHttp(e);
  }
  if (response.stop_reason === "max_tokens") {
    throw Object.assign(new Error("address extraction was truncated"), { http: 502 });
  }
  if (response.stop_reason === "refusal") {
    throw Object.assign(new Error("address extraction was declined"), { http: 502 });
  }
  const raw = response.content.find((b) => b.type === "text")?.text || "{}";
  const parsed = JSON.parse(raw);
  return {
    address: String(parsed.address || "").trim(),
    askingPrice: Math.max(0, Number(parsed.askingPrice) || 0),
    confidence: parsed.confidence || "low",
    note: String(parsed.note || "").slice(0, 300),
  };
}

/* ---------- stage 2: the comps that are actually nearby ---------- */

// Score every comp against the subject, backfill any missing distance from the
// coordinates, and keep only what is genuinely inside the radius.
//
// A comp whose distance can't be established is DROPPED, not kept. Everywhere
// else in this codebase an unknown datum is forgiving — the match scorecard
// abstains, the sqft filter keeps the comp — because a human is looking at the
// list. Here nobody is, and "within half a mile" has to mean it.
export function nearbyComps({ compsData, subjectFacts, subjectAddress = "", radiusMiles = UW_RADIUS_MILES }) {
  const origin = compsData?.subject?.lat != null ? compsData.subject : null;
  // The subject's own prior sale is not a comp for the subject.
  //
  // If the house changed hands inside the comp window it comes back in its own
  // sold search, at distance zero, and — because it is by definition a perfect
  // match on every criterion — sorts straight to the top and anchors the ARV on
  // the very transaction we are trying to value independently of. Caught on a
  // live run, where it was the highest $/sqft "renovated" comp in the set.
  const selfKey = addressKey(subjectAddress);
  const isSelf = (c) =>
    (selfKey && addressKey(c.address || "") === selfKey) ||
    (c.distance != null && c.distance < 0.01);   // ~50 ft: same parcel, different string
  return (compsData?.comps || [])
    .map((c) => {
      const miles = c.distance == null && origin ? milesBetween(origin, c) : c.distance;
      const withDist = miles == null ? c : { ...c, distance: Math.round(miles * 100) / 100 };
      return { ...withDist, match: scoreComp(subjectFacts, withDist) };
    })
    .filter((c) => c.distance != null && c.distance <= radiusMiles)
    .filter((c) => !isSelf(c))
    .sort(compareByMatch);
}

/* ---------- the gates ---------- */

/**
 * Everything that has to be true before an unattended run is allowed to
 * publish an offer. Pure — this is the function to read (and to test) if you
 * want to know what the automation will and won't do on its own.
 *
 * Returns { ok, held: [reason] }. `held` is written verbatim into the GHL note,
 * so each reason has to read like something a person would say.
 */
export function evaluateGates({
  extraction, subject, rehabbedComps = [], arv, photosAnalyzed = 0, scan, repairs = 0, proxy = null,
}) {
  const held = [];

  if (!extraction?.address) {
    held.push("no property address in the message");
  } else if (extraction.confidence !== "high") {
    held.push(`the address was read with ${extraction.confidence} confidence — "${extraction.address}"`);
  }

  if (!subject || subject.lat == null) {
    held.push("that address didn't resolve to a property record");
  }
  // Without the subject's floor area, two things quietly go wrong at once: the
  // comp search runs with no size filter, and deriveArv falls back to a plain
  // median with no size adjustment. Seen live — a run pulled comps spanning
  // 730 to 2,690 sqft and produced a confident ARV from them. Neither failure
  // announces itself, so this gate does.
  else if (!(Number(subject.sqft) > 0)) {
    held.push("the subject's square footage is unknown — comps can't be size-matched and the ARV can't be size-adjusted");
  }

  // When the price proxy declined, say THAT rather than "0 renovated comps".
  // The two look identical from the outside and have completely different
  // fixes: one wants a wider net, the other wants someone to look at photos.
  if (proxy && !proxy.applied) {
    held.push(`${proxy.reason} — not enough nearby sales to tell renovated from tired by price`);
  } else {
    const n = rehabbedComps.length;
    if (n < UW_MIN_REHABBED_COMPS) {
      held.push(
        `only ${n} renovated/updated comp${n === 1 ? "" : "s"} within ${UW_RADIUS_MILES} mi — ${UW_MIN_REHABBED_COMPS} required`
      );
    }
  }

  if (!arv) {
    held.push("no ARV could be derived from the comps");
  } else {
    // deriveArv falls back to every comp when it can't find two graded ones.
    // That fallback is right for a human who can see what it did; unattended
    // it is exactly the silent downgrade this whole feature must not make.
    if (!arv.graded) held.push("the ARV fell back to ungraded comps");
    if ((arv.oversized || []).length > 1) {
      held.push(`${arv.oversized.length} of the comps are more than ±25% off the subject's size`);
    }
  }

  if (!(photosAnalyzed >= UW_MIN_SUBJECT_PHOTOS)) {
    held.push(`only ${photosAnalyzed || 0} listing photo${photosAnalyzed === 1 ? "" : "s"} to scan — ${UW_MIN_SUBJECT_PHOTOS} required for a scope of work`);
  }

  const band = rehabBand(subject?.sqft || 0);
  if (band && repairs > band.heavy[1] * UW_REPAIRS_BAND_SLACK) {
    held.push(`the scope totals ${fmtMoney(repairs)}, past the heavy band for ${band.label} (${fmtMoney(band.heavy[1])})`);
  }

  const foundation = (scan?.areas || []).find((a) => a.area === "foundation_structure");
  if (foundation?.grade === "poor") {
    held.push("the photo scan flagged a possible foundation or structural problem");
  }

  return { ok: held.length === 0, held };
}

/* ---------- GHL writeback ---------- */

const contactName = (c) =>
  [c?.firstName, c?.lastName].filter(Boolean).join(" ") || c?.name || c?.contactName || "";

// Move the contact from whatever uw-* tag it wears to this one. Without the
// removal a contact ends up permanently tagged uw-running and every GHL filter
// built on these tags quietly stops meaning anything.
async function setTag(client, contactId, tag, warnings) {
  try {
    const stale = ALL_UW_TAGS.filter((t) => t !== tag);
    if (stale.length) await removeContactTags(client, contactId, stale).catch(() => {});
    await addContactTags(client, contactId, [tag]);
  } catch (e) {
    warnings.push(`tag ${tag}: ${e.message}`);
  }
}

async function note(client, contactId, body, warnings) {
  try {
    // GHL wants { body }, not a bare string — a string serializes to a JSON
    // string and the API rejects it as malformed. It fails into `warnings`
    // rather than loudly, which is exactly why this survived until a live run:
    // the tags landed, the notes never did.
    await createContactNote(client, contactId, { body });
  } catch (e) {
    warnings.push(`note: ${e.message}`);
  }
}

/* ---------- the pipeline ---------- */

/**
 * startUnderwrite(...) — validates, enqueues, returns the job immediately.
 * The caller (the webhook route) answers GHL right away; everything below
 * happens on the lane.
 *
 * deps.createOffer is offers.js's createOfferFromRequest, injected so an
 * automated offer travels the identical code path as a hand-built one.
 */
export async function startUnderwrite({
  client, locationId, saved, store, contactId, message, address, askingPrice, dryRun, deps,
}) {
  const aiApiKey = String(saved?.aiApiKey || "").trim();
  if (!aiApiKey) throw Object.assign(new Error("Anthropic API key required (Settings)"), { http: 400 });
  const compsApiKey = String(saved?.compsApiKey || saved?.rentcastApiKey || "").trim();
  // Zillow is the default comps source and needs no RealEstateAPI key at all —
  // Apify covers both the sold-comp search and the subject's listing.
  if (saved?.compsSource === "realestateapi" && !compsApiKey) {
    throw Object.assign(new Error("RealEstateAPI key required (Settings) — or switch the comps source to Zillow"), { http: 400 });
  }
  const apifyToken = String(saved?.apifyToken || "").trim();
  if (!apifyToken) throw Object.assign(new Error("Apify token required (Settings) for comps and listing photos"), { http: 400 });

  const cap = Number(saved?.autoUnderwriteDailyCap) > 0
    ? Number(saved.autoUnderwriteDailyCap)
    : UW_DEFAULT_DAILY_CAP;
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
    message: String(message || "").slice(0, 500),
    // An address handed over by the GHL workflow. When the conversation bot has
    // already confirmed the property with the agent, that capture is better
    // evidence than anything a one-shot extraction can produce from the same
    // thread — and skipping the extraction saves a Claude call and removes a
    // failure mode. Blank falls back to reading the conversation.
    suppliedAddress: String(address || "").trim().slice(0, 200),
    suppliedAskingPrice: Math.max(0, Number(askingPrice) || 0),
    address: "",
    askingPrice: null,
    addressSource: null,
    compsSource: null,
    conditionSource: null,
    dryRun: Boolean(dryRun),
    arv: null,
    arvBasis: "",
    repairs: null,
    cashAmount: null,
    compsUsed: [],
    photosAnalyzed: 0,
    offerId: null,
    offerUrl: null,
    held: [],
    warnings: [],
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    // Set once the contact has been tagged uw-running, so every exit path
    // knows whether it owes the contact a terminal tag.
    announced: false,
    cancelRequested: false,
  };
  jobs.set(job.id, job);

  runOnLane(locationId, () =>
    runUnderwrite(job, { client, locationId, saved, store, aiApiKey, compsApiKey, apifyToken, deps })
      .then(async () => {
        // A stop is a deliberate act by someone who is looking at the screen,
        // so it clears the uw-* tags outright rather than leaving a
        // needs-review nag behind. It still leaves a note: the agent's text is
        // sitting unanswered either way, and that is worth a trace.
        if (job.status === "canceled" && job.announced) {
          await removeContactTags(client, contactId, ALL_UW_TAGS).catch(() => {});
          await note(client, contactId,
            `Auto-underwrite stopped for ${job.address || "an unidentified property"} before it finished. Nothing was created.`,
            job.warnings);
        }
      })
      .catch(async (e) => {
        job.status = "error";
        job.error = String(e?.message || e).slice(0, 300);
        job.finishedAt = new Date().toISOString();
        // A run that dies mid-flight must not leave the contact wearing
        // uw-running forever — that tag is what GHL filters are built on, and
        // a stuck one quietly poisons every one of them. Say what broke, too:
        // otherwise an agent's text just vanishes and nobody finds out until
        // they follow up.
        if (job.announced) {
          await setTag(client, contactId, UW_TAGS.failed, job.warnings);
          await note(client, contactId,
            `Auto-underwrite failed for ${job.address || "an unidentified property"} — ${job.error}\n\n` +
            `Nothing was created. The agent's message is still in the thread above; underwrite it by hand, ` +
            `or fix the cause and re-trigger the workflow.`,
            job.warnings);
        }
      })
  );

  return { skipped: null, job };
}

// Two at a time per location. Apify runs take ~90s each and cost credits;
// letting a busy morning fan out twenty of them at once is how you find out
// what your Apify plan's ceiling is.
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
  if (lane.running < MAX_CONCURRENT_PER_LOCATION) {
    lane.running++;
    fn().then(next, next);
  } else {
    lane.waiting.push(fn);
  }
}

const canceled = (job) => {
  if (!job.cancelRequested) return false;
  job.status = "canceled";
  job.finishedAt = new Date().toISOString();
  return true;
};

async function runUnderwrite(job, ctx) {
  const { client, locationId, saved, store, aiApiKey, compsApiKey, apifyToken, deps } = ctx;
  const compsSource = saved?.compsSource === "realestateapi" ? "realestateapi" : "zillow";
  const compsCondition = saved?.compsCondition === "ai" ? "ai" : "price";
  const warnings = job.warnings;
  job.status = "running";

  let contact = null;
  try {
    contact = await getContact(client, job.contactId);
    job.contactName = contactName(contact);
  } catch { /* the name is decoration; the id is what matters */ }

  /* --- 1. the address --- */
  job.phase = "extracting";
  if (canceled(job)) return;

  // Two ways in, and the cheap one is also the better one.
  //
  // When the GHL workflow supplies an address, the conversation bot has already
  // confirmed the property with the agent across several turns — a much
  // stronger signal than one model call re-reading the same thread, and it
  // costs nothing. When it doesn't (an Inbound Message trigger, or a bot field
  // that hadn't been written yet when the workflow fired), fall back to reading
  // the conversation. The fallback is why an empty `address` is not an error.
  let extraction;
  if (job.suppliedAddress) {
    extraction = {
      address: job.suppliedAddress,
      askingPrice: job.suppliedAskingPrice,
      confidence: "high",
      note: "Address supplied by the GHL workflow — already confirmed with the agent in conversation.",
      source: "workflow",
    };
  } else {
    let transcript = "";
    try {
      const t = await buildTranscript(client, locationId, job.contactId, {
        maxConversations: 2, maxPagesPerConvo: 1, maxMessages: 40, maxChars: 12000, maxCallTranscripts: 0,
      });
      transcript = t.text || "";
    } catch { /* missing conversations.readonly — the message alone usually carries the address */ }

    extraction = { ...(await extractRequest({ message: job.message, transcript, aiApiKey })), source: "conversation" };
    // An asking price named in the workflow still wins: it comes off a field
    // the bot wrote, not off a sentence the model had to parse.
    if (job.suppliedAskingPrice) extraction.askingPrice = job.suppliedAskingPrice;
  }
  job.address = extraction.address;
  job.askingPrice = extraction.askingPrice || null;
  job.extractionNote = extraction.note;
  job.addressSource = extraction.source;

  if (!extraction.address) {
    return finishHeld(job, ctx, { extraction, held: ["no property address in the message"], partial: {} });
  }

  // Announce only once we know what we're working on — a note that says
  // "started" with no address is noise on the contact record.
  await setTag(client, job.contactId, UW_TAGS.running, warnings);
  await note(client, job.contactId,
    `Auto-underwrite started for ${extraction.address}` +
    (extraction.source === "conversation" ? " (read from the conversation)" : "") + "." +
    (extraction.askingPrice ? ` Asking ${fmtMoney(extraction.askingPrice)}.` : ""),
    warnings);
  // From here on the contact wears a uw-* tag, so any exit — including a crash
  // — owes it a terminal one. See the catch in startUnderwrite.
  job.announced = true;

  const dupe = await findRecent({ store, locationId, contactId: job.contactId, address: extraction.address });
  if (dupe) {
    job.status = "done";
    job.phase = "";
    job.offerId = dupe.id;
    job.offerUrl = dupe.pdfUrl || null;
    job.cashAmount = dupe.cashAmount ?? null;
    job.duplicateOf = dupe.id;
    job.finishedAt = new Date().toISOString();
    await setTag(client, job.contactId, UW_TAGS.done, warnings);
    await note(client, job.contactId,
      `Already underwrote ${extraction.address} for this agent in the last 24 hours — reusing that offer instead of running again.`,
      warnings);
    return;
  }

  /* --- 2. the subject --- */
  job.phase = "subject";
  if (canceled(job)) return;

  // The subject's Zillow listing is fetched ONCE, here, and used twice: its
  // facts (beds/baths/sqft/year) shape the comp search, and its photos are the
  // scope of work. It used to be pulled down in the rehab stage, after the
  // comps had already been searched with whatever the comps provider thought
  // the subject was — which is backwards when Zillow is the comps source too.
  let photos = [];
  let photosCount = 0;
  let listing = null;
  let facts = null;
  try {
    ({ photos, photosCount, listing, facts } = await fetchZillowPhotos(extraction.address, apifyToken));
  } catch (e) {
    warnings.push(`Zillow listing: ${e.message}`);
    if (compsApiKey) {
      // MLS Detail is the other way in, for accounts carrying that add-on.
      try {
        ({ photos, photosCount, listing } = await fetchListingPhotos(extraction.address, compsApiKey));
      } catch (e2) {
        warnings.push(`MLS photos: ${e2.message}`);
      }
    }
  }
  job.photosAnalyzed = photos.length;
  if (!photos.length) {
    warnings.push(`no listing photos for ${extraction.address} — the scope of work can't be scanned`);
  }

  /* --- 3. comps --- */
  job.phase = "comps";
  job.compsSource = compsSource;
  if (canceled(job)) return;

  let compsData;
  let subject;
  if (compsSource === "zillow") {
    // Zillow search has no notion of a subject property, so we own that record:
    // coordinates from a free geocode, facts from the listing above.
    const geo = await photonGeocode(extraction.address);
    if (!geo) {
      throw Object.assign(new Error(`couldn't locate ${extraction.address} on the map`), { http: 404 });
    }
    subject = {
      lat: geo.lat, lng: geo.lng,
      beds: facts?.beds ?? null, baths: facts?.baths ?? null,
      sqft: facts?.sqft ?? null, yearBuilt: facts?.yearBuilt ?? null,
      stories: null, subdivision: null, material: null,
    };
    compsData = await pullZillowComps({
      apifyToken,
      lat: geo.lat, lng: geo.lng,
      beds: subject.beds || 0, baths: subject.baths || 0, sqft: subject.sqft || 0,
      radiusMiles: UW_RADIUS_MILES,
      monthsBack: 12,
      // Pool bands, not ARV bands. Everything that survives is still ranked by
      // the match scorecard, so the closest matches float to the top on their
      // own — this only decides what gets to be ranked at all.
      bedTolerance: UW_POOL_BEDS_TOLERANCE,
      bathTolerance: UW_POOL_BATHS_TOLERANCE,
      sqftPct: UW_POOL_SQFT_PCT,
      subject,
    });
  } else {
    // widen:false is the point. The ladder in comps-pull.js is right for a
    // human who is told it fired; unattended, silently reaching five miles out
    // for comps would produce an ARV nobody agreed to.
    compsData = await pullComps({
      apiKey: compsApiKey,
      address: extraction.address,
      months: 12,
      widen: false,
    });
    // County records beat a scraped listing for the subject's own facts.
    subject = { ...(compsData.subject || {}) };
    for (const k of ["beds", "baths", "sqft", "yearBuilt"]) {
      if (subject[k] == null && facts?.[k] != null) subject[k] = facts[k];
    }
  }
  const subjectFacts = { ...subject, distance: undefined, saleDate: undefined };
  const nearby = nearbyComps({ compsData, subjectFacts, subjectAddress: extraction.address });

  /* --- 4. condition --- */
  job.phase = "grading";
  job.conditionSource = compsCondition;
  if (canceled(job)) return;

  let grades = {};
  let rehabbed = [];
  let proxy = null;
  if (compsCondition === "price") {
    // Two questions, two pools — this is the part worth understanding.
    //
    //   "Where is the top of the local $/sqft distribution?" needs BREADTH.
    //   Ranking is scale-free once you divide by floor area, so a 4-bed two
    //   doors down tells you plenty about what a renovated house fetches here.
    //
    //   "Which comps carry the ARV?" needs TIGHTNESS — the closest matches to
    //   this specific house.
    //
    // Running both off one tight set was the bug: tight enough to defend an
    // ARV is too tight to have a distribution, and the proxy just refused. So
    // the wide pool establishes the renovated tier, and the ARV then takes the
    // best-MATCHING comps from inside that tier — compareByMatch already
    // scores beds, baths, size, era and distance, so the tightening is done by
    // the scorecard rather than by another set of hand-tuned bands.
    const tier = Math.max(UW_MAX_ARV_COMPS, Math.round(nearby.length * 0.35));
    proxy = markRenovatedByPrice(nearby, { take: tier });
    rehabbed = proxy.comps
      .filter((c) => ARV_CONDITIONS.has(c.condition))
      .sort(compareByMatch)
      .slice(0, UW_MAX_ARV_COMPS);
    grades = Object.fromEntries(
      rehabbed.map((c) => [c.id, { condition: c.condition, confidence: "medium", source: "price", note: proxy.reason }])
    );
  } else {
    const candidates = nearby.slice(0, UW_GRADE_CANDIDATES);
    if (candidates.length) {
      try {
        const out = await gradeComps({
          subjectAddress: extraction.address,
          comps: candidates.map((c) => ({
            id: c.id, address: c.address, price: c.price, sqft: c.sqft,
            beds: c.beds, baths: c.baths, saleDate: c.saleDate,
          })),
          aiApiKey,
          apifyToken,
        });
        grades = Object.fromEntries(
          Object.entries(out.grades || {}).map(([id, g]) => [id, { ...g, source: "ai" }])
        );
        for (const f of out.failed || []) warnings.push(`comp ${f.id}: ${f.reason}`);
      } catch (e) {
        throw anthropicErrorToHttp(e);
      }
    }
    rehabbed = candidates
      .filter((c) => ARV_CONDITIONS.has(grades[c.id]?.condition))
      .slice(0, UW_MAX_ARV_COMPS);
  }

  job.compsUsed = rehabbed.map((c) => ({
    address: c.address, price: c.price, sqft: c.sqft, distance: c.distance,
    saleDate: c.saleDate, condition: grades[c.id]?.condition || null,
  }));

  /* --- 5. ARV --- */
  job.phase = "arv";
  if (canceled(job)) return;

  const subjectSqft = Number(subject.sqft) || 0;
  const arv = rehabbed.length
    ? deriveArv({
        comps: rehabbed.map((c) => ({ ...c, condition: grades[c.id]?.condition })),
        subjectSqft,
        adjustments: [],
      })
    : null;
  job.arv = arv?.arv ?? null;
  job.arvBasis = arv?.basis || "";

  /* --- 6. rehab --- */
  job.phase = "rehab";
  if (canceled(job)) return;

  const beds = Number(subject.beds) || 0;
  const baths = Number(subject.baths) || 0;
  const sqft = subjectSqft;
  const yearBuilt = Number(subject.yearBuilt) || 0;

  let scan = null;
  let rehabState = seedRoomCounts(undefined, { beds, baths });
  let repairs = 0;
  let scope = [];
  if (photos.length) {
    try {
      scan = await scanRehabFromPhotos({
        photos, listing,
        subject: { beds: beds || null, baths: baths || null, sqft: sqft || null, yearBuilt: yearBuilt || null },
        aiApiKey,
      });
      rehabState = applyScanSuggestion(rehabState, scan, { photosAnalyzed: photos.length });
      const priced = priceScope(rehabState, sqft);
      scope = priced.lines;
      repairs = priced.total;
    } catch (e) {
      throw anthropicErrorToHttp(e);
    }
  }

  /* --- the gates --- */
  const gate = evaluateGates({
    extraction, subject, rehabbedComps: rehabbed, arv,
    photosAnalyzed: photos.length, scan, repairs, proxy,
  });

  const partial = {
    compsData, subject, subjectSqft: sqft, nearby, grades, rehabbed,
    arv, rehabState, scope, repairs, listing, photosCount,
  };

  if (!gate.ok || job.dryRun || !AUTO_UNDERWRITE_ENABLED) {
    const held = gate.ok
      ? [AUTO_UNDERWRITE_ENABLED ? "dry run — nothing was published" : "AUTO_UNDERWRITE_ENABLED is not set on the broker"]
      : gate.held;
    return finishHeld(job, ctx, { extraction, held, partial, cleared: gate.ok });
  }

  /* --- 6. create --- */
  job.phase = "creating";
  if (canceled(job)) return;
  if (typeof deps?.createOffer !== "function") {
    throw new Error("auto-underwrite was wired without a createOffer dependency");
  }

  const result = await deps.createOffer({
    locationId,
    client,
    body: {
      contactId: job.contactId,
      inputs: {
        address: extraction.address,
        arv: arv.arv,
        repairs,
        askingPrice: extraction.askingPrice || 0,
      },
      settings: { ...(saved || {}), underwriteMode: UW_MODE },
      scope,
      snapshot: buildSnapshot({ extraction, partial }),
    },
  });

  const offer = result.offer;
  offer.autoUnderwrite = auditTrail(job, extraction, gate);
  await store.updateOffer(offer.id, offer).catch(() => {});

  job.status = "done";
  job.phase = "";
  job.offerId = offer.id;
  job.offerUrl = offer.pdfUrl || null;
  job.cashAmount = offer.cashAmount ?? null;
  job.repairs = repairs;
  job.finishedAt = new Date().toISOString();
  warnings.push(...(result.warnings || []));

  await setTag(client, job.contactId, UW_TAGS.done, warnings);
  await note(client, job.contactId, doneNote(job, arv, repairs), warnings);
}

/* ---------- holding for review ---------- */

// A held run is not a failed one. Everything expensive has already been paid
// for — the comps, the grades, the photo scan — so it is saved as a DRAFT in
// exactly the shape the New Offer page restores from. Opening it lands the
// operator mid-form with the work done; the review is "tick two more comps",
// not "start over".
async function finishHeld(job, ctx, { extraction, held, partial, cleared = false }) {
  const { client, locationId, store } = ctx;
  const warnings = job.warnings;

  const draft = {
    ...buildSnapshot({ extraction, partial }),
    cashPreview: null,
  };
  const record = {
    locationId,
    status: "draft",
    contactId: job.contactId,
    contactName: job.contactName,
    address: extraction.address || "",
    cashAmount: null,
    draft,
    autoUnderwrite: { ...auditTrail(job, extraction, { ok: cleared, held }), held },
    updatedAt: new Date().toISOString(),
  };
  const saved = await store.createOffer(record);

  job.status = "held";
  job.phase = "";
  job.held = held;
  job.offerId = saved.id;
  job.arv = partial.arv?.arv ?? null;
  job.repairs = partial.repairs ?? null;
  job.finishedAt = new Date().toISOString();

  if (job.contactId) {
    await setTag(client, job.contactId, UW_TAGS.review, warnings);
    await note(client, job.contactId, heldNote(job, held), warnings);
  }
}

/* ---------- shapes ---------- */

// The New Offer workspace, exactly as CompsPane and RehabPane report it
// upward. Getting this shape wrong doesn't error — it silently opens to an
// empty comps board and drops the comps out of the comps PDF, which is the
// one failure you'd only notice with an agent on the phone.
function buildSnapshot({ extraction, partial }) {
  const { compsData, subject, subjectSqft, grades, rehabbed, arv, rehabState, scope, repairs } = partial;
  const center = subject?.lat != null ? { lat: subject.lat, lng: subject.lng } : null;
  return {
    mode: "existing",
    inputs: {
      address: extraction.address,
      arv: arv?.arv ?? 0,
      repairs: repairs ?? 0,
      askingPrice: extraction.askingPrice || 0,
    },
    subjectSqft: subjectSqft || "",
    subjectInfo: subject || null,
    scope: scope || [],
    underwriteMode: UW_MODE,
    rehab: rehabState || null,
    comps: {
      // CompsPane keeps the resolved map centre on `subject` and the provider's
      // property record on `info` — not the other way round.
      result: compsData ? { ...compsData, subject: center, info: subject || null, loadedFor: extraction.address } : null,
      selected: (rehabbed || []).map((c) => c.id),
      manual: [],
      captured: [],
      // Nothing is dismissed: the comps that didn't carry the ARV were ranked
      // below the ones that did, not rejected. They stay on the board so a
      // review can tick one without pulling again.
      dismissed: [],
      months: 12,
      beds: subject?.beds ?? "",
      baths: subject?.baths ?? "",
      grades: grades || {},
      adjustments: [],
      arvBase: arv?.base ?? null,
      arvBasis: arv?.basis || "",
    },
  };
}

// Stamped onto whatever the run produced. This is what countToday and
// findRecent read, and what tells you six weeks later that a number came from
// a robot at 6am rather than from someone looking at the house.
//
// Scalars only, deliberately: it is carried on the LEAN offer row (see
// OFFER_LIST_FIELDS in shared/offer-status.js) so the spend guards can be
// answered without reading every offer document in full. The comps that
// carried the ARV are already in the snapshot — they don't need a third copy.
function auditTrail(job, extraction, gate) {
  return {
    jobId: job.id,
    startedAt: job.startedAt,
    finishedAt: new Date().toISOString(),
    dryRun: job.dryRun,
    message: String(job.message || "").slice(0, 200),
    address: extraction.address,
    confidence: extraction.confidence,
    addressSource: extraction.source || "conversation",
    extractionNote: extraction.note,
    mode: UW_MODE,
    compsSource: job.compsSource,
    conditionSource: job.conditionSource,
    compsUsedCount: job.compsUsed.length,
    photosAnalyzed: job.photosAnalyzed,
    arvBasis: job.arvBasis,
    passed: Boolean(gate?.ok),
  };
}

/* ---------- the notes a human reads ---------- */

function doneNote(job, arv, repairs) {
  const comps = job.compsUsed
    .map((c) => `  • ${c.address} — ${fmtMoney(c.price)}${c.sqft ? `, ${c.sqft.toLocaleString()} sqft` : ""}, ${c.distance} mi, ${c.condition}`)
    .join("\n");
  return [
    `Auto-underwrite complete for ${job.address}.`,
    ``,
    `Blended cash offer: ${fmtMoney(job.cashAmount || 0)}`,
    `ARV ${fmtMoney(arv?.arv || 0)} — ${job.arvBasis}`,
    `Repairs ${fmtMoney(repairs)} from ${job.photosAnalyzed} listing photos`,
    ``,
    `Comps used:`,
    comps || "  (none)",
    ``,
    job.offerUrl ? `Offer document: ${job.offerUrl}` : "",
    ``,
    `Nothing has been sent — review it in History and send when you're happy.`,
  ].filter((l) => l !== null).join("\n");
}

function heldNote(job, held) {
  return [
    `Auto-underwrite held for review — ${job.address || "no address found"}.`,
    ``,
    `Why:`,
    ...held.map((h) => `  • ${h}`),
    ``,
    job.arv ? `ARV so far: ${fmtMoney(job.arv)} (${job.arvBasis})` : "",
    job.repairs ? `Scope so far: ${fmtMoney(job.repairs)} from ${job.photosAnalyzed} photos` : "",
    ``,
    `The work done so far is saved as a draft — open it in the app and it picks up where this stopped.`,
  ].filter(Boolean).join("\n");
}
