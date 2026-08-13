// dispo.js — dispositions search. Turns a plain-English question ("cash buyers
// for a gut-job duplex in Tacoma under 400k") or an under-contract deal into a
// ranked shortlist of investors, using the buy-box fields the enrichment sweep
// writes into GHL.
//
// Three stages, and the middle one is deliberately NOT the model:
//
//   1. PARSE   Claude turns the question into a structured query.
//   2. FILTER  Plain JS (shared/buybox.js) drops the investors whose buy box
//              actively contradicts it. Deterministic, testable, free, and it
//              keeps the ranking prompt small enough to stay cheap.
//   3. RANK    Claude orders the survivors from their compact profiles and
//              says why, citing the buy-box fact it relied on.
//
// Why no embeddings: a buy box is structured data (areas, a price band, a set
// of property types) wearing a text costume. Cosine similarity over that text
// would blur exactly the distinctions that matter — $400k vs $4M reads as
// nearly the same sentence — while the filter stage answers them exactly. The
// model is used for the two things it is actually better at than a vector:
// reading an English question, and judging fit from conversation history.
// A second embeddings vendor would also mean a second API key and a
// re-embed-on-every-edit pipeline, for a book that is hundreds of rows.
//
// This module only READS. Every write to GHL lives in routes/dispo.js.

import Anthropic from "@anthropic-ai/sdk";
import { ENRICH_MODEL, INVESTOR_ENRICH_FIELDS, enrichFieldDefs } from "./enrich.js";
import { normalizeUsAddress } from "./shared/us-address.js";
import {
  PROPERTY_TYPES, REHAB_APPETITES, PROPERTY_TYPE_LABELS, REHAB_APPETITE_LABELS,
  buildBuyboxProfile, normalizeQuery, priceBandText,
} from "./shared/buybox.js";

// Same model as the enrichment sweep, for the same reason: this is structured
// extraction plus a ranking judgment over pre-filtered, compact profiles —
// well inside Sonnet's range — and the operator runs several searches per
// session, so per-query cost is felt.
export const DISPO_MODEL = ENRICH_MODEL;

// The buy-box field defs live in enrich.js (they're what the AI sweep writes);
// re-exported here so routes/dispo.js validates edits against one vocabulary.
export const BUYBOX_FIELDS = INVESTOR_ENRICH_FIELDS;

// Every field an enriched investor can carry (buy box + the shared summary /
// history / last-run fields). Used to translate GHL's name-derived fieldKeys
// back to the keys this code actually reads — see customFieldIdKeyMapForDefs.
export const INVESTOR_FIELD_DEFS = enrichFieldDefs("investor");

export { buildBuyboxProfile };

// Max investors sent to the ranker in one call. Beyond this the filter stage
// hasn't narrowed enough to be worth ranking — the UI says so rather than
// silently ranking an arbitrary subset.
export const RANK_LIMIT = 60;

const anthropicFor = (aiApiKey) => new Anthropic({ apiKey: aiApiKey, timeout: 120_000 });

// enrich.js's guards, in one place: a truncated or declined completion is a
// 502 with a message the operator can act on, not a JSON.parse crash.
function readJson(response, what) {
  if (response.stop_reason === "max_tokens") {
    throw Object.assign(new Error(`AI ${what} output truncated — narrow the search and try again`), { http: 502 });
  }
  if (response.stop_reason === "refusal") {
    throw Object.assign(new Error(`AI ${what} was declined`), { http: 502 });
  }
  const text = response.content.find((b) => b.type === "text")?.text || "{}";
  return JSON.parse(text);
}

/* ---------- 1. parse ---------- */

const QUERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["areas", "priceMin", "priceMax", "propertyTypes", "lotMin", "rehabAppetite", "keywords"],
  properties: {
    areas: { type: "array", items: { type: "string" } },
    // anyOf rather than a `type: ["number","null"]` union — structured
    // outputs accept anyOf, and union type arrays are not on the supported list.
    priceMin: { anyOf: [{ type: "number" }, { type: "null" }] },
    priceMax: { anyOf: [{ type: "number" }, { type: "null" }] },
    propertyTypes: { type: "array", items: { type: "string", enum: PROPERTY_TYPES } },
    lotMin: { anyOf: [{ type: "number" }, { type: "null" }] },
    rehabAppetite: { anyOf: [{ type: "string", enum: REHAB_APPETITES }, { type: "null" }] },
    keywords: { type: "array", items: { type: "string" } },
  },
};

const PARSE_SYSTEM =
  "You convert a wholesaler's plain-English question about their cash-buyer list into a structured query.\n\n" +
  "Extract ONLY what the question states. Every field is nullable or may be empty — leaving a field empty is " +
  "always correct when the question didn't mention it, and is far better than guessing. Never infer a price " +
  "band from an area, a property type from a rehab level, or a rehab level from words like 'distressed'.\n\n" +
  "Field notes:\n" +
  "- areas: cities, neighborhoods, or zip codes, exactly as written. 'the south end' is an area; 'nearby' is not.\n" +
  "- priceMin / priceMax: dollars. 'under 400k' is priceMax 400000 with priceMin null. 'around 300k' is a band " +
  "  (270000-330000). A single price with no qualifier is the deal's price — set BOTH bounds to it.\n" +
  `- propertyTypes: ${PROPERTY_TYPES.join(", ")}. 'duplex', 'triplex', 'fourplex', and 'apartment' are all multi_family.\n` +
  `- rehabAppetite: how much work the DEAL needs, not what the buyer prefers. ${REHAB_APPETITES.join(", ")}. ` +
  "  'gut job' / 'teardown' / 'full rehab' = full_gut; 'heavy' / 'major work' = heavy; 'needs updating' = moderate; " +
  "  'turnkey' / 'paint and carpet' = cosmetic_only.\n" +
  "- lotMin: the subject's lot size in square feet (convert acres, 1 acre = 43560).\n" +
  "- keywords: anything else that matters and has no field — 'no HOA', 'seller finance', 'closes fast'. " +
  "  Short phrases, at most 5.";

// Plain English -> the structured query shape from shared/buybox.js.
export async function parseBuyboxQuery({ query, aiApiKey, extraInstructions }) {
  const response = await anthropicFor(aiApiKey).messages.create({
    model: DISPO_MODEL,
    max_tokens: 2000,
    thinking: { type: "adaptive" },
    // Cheap, well-specified extraction — no reason to pay for deep thinking.
    output_config: { effort: "low", format: { type: "json_schema", schema: QUERY_SCHEMA } },
    system: PARSE_SYSTEM + (extraInstructions ? `\n\nAdditional instructions from the team:\n${extraInstructions}` : ""),
    messages: [{ role: "user", content: `Question: ${query}` }],
  });
  // normalizeQuery re-validates the enums and swaps a backwards price band —
  // the schema constrains the model, this constrains everything downstream.
  return normalizeQuery(readJson(response, "query"));
}

/* ---------- 2. rank ---------- */

const rankingSchema = (contactIds) => ({
  type: "object",
  additionalProperties: false,
  required: ["rankings"],
  properties: {
    rankings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["contactId", "score", "fit", "reason"],
        properties: {
          // Pinned to the candidates, so the model cannot invent a buyer.
          contactId: { type: "string", enum: contactIds },
          score: { type: "integer" },
          fit: { type: "string", enum: ["strong", "possible", "weak"] },
          reason: { type: "string" },
        },
      },
    },
  },
});

const RANK_SYSTEM =
  "You are a dispositions analyst for a real-estate wholesaling operation ('The Agent Method'): properties " +
  "under contract get assigned to cash-buyer investors for a fee. You are ranking investors by how well ONE " +
  "property or search fits their buy box.\n\n" +
  "The candidates have already passed a structural filter, so none of them actively contradict the request — " +
  "your job is to order them, not to re-run the filter.\n\n" +
  "Rules:\n" +
  "- Rank on evidence in the profile. A buy box that matches on more stated criteria beats one that matches on " +
  "fewer; a documented match beats a blank field.\n" +
  "- An investor with almost nothing filled in is 'weak' with a low score — not a hidden gem. Say the buy box is " +
  "thin so the operator knows to go ask them.\n" +
  "- Recent property history and the last conversation are strong signals. Someone who passed on three similar " +
  "houses ranks below someone who asked for exactly this kind of deal, even with identical buy boxes.\n" +
  "- Every reason must cite the specific fact it rests on — an area, a price band, a type, a line of history. " +
  "One sentence. No hedging, no restating the request back.\n" +
  "- fit: strong = would send this today; possible = worth a text; weak = long shot.\n" +
  "- score is 0-100 and must agree with fit (strong ≥ 70, possible 40-69, weak < 40).\n" +
  "- Include EVERY candidate exactly once, best first.";

// Rank pre-filtered candidates against a target. `candidates` are investor
// records; profiles are built here so the ranking prompt and the stored
// buybox_text can never drift apart.
export async function rankInvestors({ target, candidates, aiApiKey, extraInstructions }) {
  const ids = candidates.map((c) => c.contactId);
  if (!ids.length) return [];

  const body = candidates
    .map((c) => `### ${c.name || "Unnamed"} (id: ${c.contactId})\n${c.buyboxText || buildBuyboxProfile(c)}`)
    .join("\n\n");

  const response = await anthropicFor(aiApiKey).messages.create({
    model: DISPO_MODEL,
    // ~100 tokens of verdict per candidate, plus headroom for thinking.
    max_tokens: 16_000,
    thinking: { type: "adaptive" },
    output_config: { format: { type: "json_schema", schema: rankingSchema(ids) } },
    system: RANK_SYSTEM + (extraInstructions ? `\n\nAdditional instructions from the team:\n${extraInstructions}` : ""),
    messages: [{
      role: "user",
      content:
        `WHAT WE ARE PLACING\n${describeTarget(target)}\n\n` +
        `INVESTOR CANDIDATES (buy box + recent history)\n\n${body}\n\n` +
        `Rank these investors for this deal.`,
    }],
  });

  const raw = readJson(response, "ranking");
  const byId = new Map();
  for (const r of raw.rankings || []) {
    // Enum-pinned, but a duplicate id would still double-count a buyer.
    if (!byId.has(r.contactId)) byId.set(r.contactId, r);
  }
  return [...byId.values()].sort((a, b) => (b.score || 0) - (a.score || 0));
}

/* ---------- targets ---------- */

// Human-readable form of what we're placing — the free-text question when the
// operator typed one, else the deal's own facts.
function describeTarget(target = {}) {
  if (target.question) return target.question;
  const q = target.query || {};
  return [
    target.address ? `Property: ${target.address}` : null,
    q.areas?.length ? `Area: ${q.areas.join(", ")}` : null,
    priceBandText(q) ? `Price: ${priceBandText(q)}` : null,
    q.propertyTypes?.length ? `Type: ${q.propertyTypes.map((t) => PROPERTY_TYPE_LABELS[t] || t).join(", ")}` : null,
    q.rehabAppetite ? `Rehab needed: ${REHAB_APPETITE_LABELS[q.rehabAppetite] || q.rehabAppetite}` : null,
    q.lotMin != null ? `Lot: ${Math.round(q.lotMin).toLocaleString("en-US")} sqft` : null,
    target.assignmentFee ? `Assignment fee: $${Number(target.assignmentFee).toLocaleString("en-US")}` : null,
    q.keywords?.length ? `Also: ${q.keywords.join(", ")}` : null,
  ].filter(Boolean).join("\n") || "(no details given)";
}

// An offer/deal -> the same query shape a typed question produces, so deal
// matching and free-text search share one filter and one ranker.
//
// Only three of the five criteria are derivable from a saved offer: area
// (parsed off the address), price, and rehab level. The offer record carries
// no property type or lot size — the comps subject has beds/baths/sqft but
// not those — so both stay empty, which abstains rather than guessing a type
// and silently filtering out half the book.
//
// The price we match on is what the INVESTOR would pay — contract price plus
// our assignment fee — not our cost basis. Matching a buyer's band against
// the wholesaler's contract price shortlists buyers who can't afford the deal.
export function dealToQuery(offer = {}) {
  const deal = offer.deal || {};
  const contract = Number(deal.contractPrice) || 0;
  const fee = Number(deal.assignmentFee) || 0;
  // Before a contract price is entered, fall back to the offer we made — a
  // deal with no numbers yet should still match on area and rehab.
  const buyerPrice = (contract && contract + fee) || Number(offer.cashAmount) || null;

  return {
    query: normalizeQuery({
      areas: addressAreas(offer.address),
      // A band around the buyer's price, not a point: a buyer whose stated
      // ceiling is $380k is still worth a call on a $400k deal.
      priceMin: buyerPrice ? Math.round(buyerPrice * 0.85) : null,
      priceMax: buyerPrice ? Math.round(buyerPrice * 1.15) : null,
      propertyTypes: [],
      lotMin: null,
      rehabAppetite: rehabAppetiteFor(offer),
      keywords: [],
    }),
    address: offer.address || "",
    assignmentFee: fee || null,
  };
}

// City and ZIP out of a full address string ("1911 9th Ave W, Seattle, WA
// 98119" -> ["Seattle", "98119"]). Segment 0 is the street and never an area;
// the state segment is dropped because "WA" would match every Washington buy
// box. Both forms are emitted because investors state their areas either way.
//
// Normalized first so a spelled-out state ("…, Spanaway, Washington", the form
// the GHL address autocomplete produces) collapses to "WA" and gets dropped
// by the same two-letter test as the abbreviated form.
export function addressAreas(address) {
  const parts = normalizeUsAddress(address).split(",").map((s) => s.trim()).filter(Boolean);
  const areas = [];
  for (const part of parts.slice(1)) {
    const zip = /\b(\d{5})(?:-\d{4})?\b/.exec(part);
    if (zip) areas.push(zip[1]);
    const withoutZip = part.replace(/\b\d{5}(-\d{4})?\b/, "").trim();
    // A bare state (or state + zip) segment contributes only its zip.
    if (withoutZip && !/^[A-Za-z]{2}$/.test(withoutZip)) areas.push(withoutZip);
  }
  return areas;
}

// How much work the deal needs, from the repair estimate against ARV.
// Returns null when either is missing — which abstains, as it should.
function rehabAppetiteFor(offer = {}) {
  const inputs = offer.calc?.inputs || {};
  const rehab = Number(inputs.repairs) || 0;
  const arv = Number(inputs.arv) || 0;
  if (!rehab || !arv) return null;
  const pct = rehab / arv;
  if (pct >= 0.25) return "full_gut";
  if (pct >= 0.15) return "heavy";
  if (pct >= 0.06) return "moderate";
  return "cosmetic_only";
}
