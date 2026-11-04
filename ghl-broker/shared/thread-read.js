// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// thread-read.js — every conversation, read for pricing evidence (auto-underwrite v2, 2026-11-04).
//
// Matt: "Make sure every single agent conversation and investor conversation, including all of the
// call transcripts, is read and taken into account … I want to have a continuous improvement
// feedback loop." On 2026-11-04 every thread since 7/27 was read once by hand-run readers (the
// backfill); the nightly reader (ghl-broker/thread-reads.js) keeps reading the ones that move.
//
// A read is one contact's whole thread, texts, emails and every call transcript:
//   - an agent's (or seller's): per house, our numbers, the seller's numbers, the agent's own value
//     and rehab, the condition in their words, killer facts, the outcome, a walk-back, and what
//     another buyer paid; whether they offered to represent us; the questions we left unanswered.
//   - an investor's: per deal of ours, what they'd pay and their ARV and rehab, the verdict and why;
//     their stated rules.
// The field names are the 2026-11-04 reader brief's, so the backfill imports as it is.
//
// The evidence lands on each house's record (house_pricing.evidence), beside the engine's answer,
// where the scorecard and the calibration read it. A quote is kept only when it appears in their
// own words (shared/investor-read.js verifyQuotes); a phone number or email in one is masked.
//
// Pure.

import { threadForModel, verifyQuotes, maskContact } from "./investor-read.js";
import { houseKey } from "./current-offer.js";

export const THREAD_READ_VERSION = 1;
export const CONDITIONS = ["turnkey", "cosmetic", "moderate", "heavy", "gut", "teardown", "unknown"];
export const OUTCOMES = ["agreed", "under_contract_with_us", "they_passed", "we_passed", "sold_or_pending_elsewhere", "withdrawn", "open", "unknown"];
export const SELLER_KINDS = ["ask", "counter", "would_take", "accepted_ours", "floor"];
export const VERDICTS = ["interested", "offered", "passed", "bought", "asked_info", "no_reply"];
export const REASONS = ["price", "rehab", "arv", "area", "condition", "timing", "capital", "property_type", "layout", "other"];
const MAX_HOUSES = 20, MAX_QUESTIONS = 20, MAX_DEALS = 30, MAX_KILLERS = 12;

const str = (v, n = 200) => maskContact(String(v == null ? "" : v).replace(/\s+/g, " ").trim()).slice(0, n);
const money = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 1000 && n <= 50_000_000 ? n : null; };
const day = (v) => (/^\d{4}-\d{2}-\d{2}/.test(String(v || "")) ? String(v).slice(0, 10) : null);
const oneOf = (v, list, dflt) => (list.includes(v) ? v : dflt);
const list = (v) => (Array.isArray(v) ? v : []);

// Nullable the way the live investor read writes it (shared/investor-read.js READ_SCHEMA).
const nullable = (t) => ({ anyOf: [t, { type: "null" }] });
const NUM = nullable({ type: "integer" });
const STR = nullable({ type: "string" });
const AMOUNT_AT = (extra = {}) => ({ type: "object", additionalProperties: false, required: ["amount", "date", ...Object.keys(extra)], properties: { amount: { type: "integer" }, date: STR, ...extra } });

export const AGENT_READ_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["kind", "houses", "representation", "openQuestions", "broughtOtherHouses", "summary"],
  properties: {
    kind: { type: "string", enum: ["listing_agent", "buyers_agent", "wholesaler", "investor", "seller", "other"] },
    houses: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["address", "listed", "listPrice", "ourNumbers", "sellerNumbers", "agentArv", "agentRehab", "condition", "conditionWords", "killers", "outcome", "otherBuyerPrice", "whyItDied", "walkBack", "quote"],
      properties: {
        address: { type: "string" }, listed: nullable({ type: "boolean" }), listPrice: NUM,
        ourNumbers: { type: "array", items: AMOUNT_AT() },
        sellerNumbers: { type: "array", items: AMOUNT_AT({ kind: { type: "string", enum: SELLER_KINDS } }) },
        agentArv: NUM, agentRehab: NUM,
        condition: { type: "string", enum: CONDITIONS }, conditionWords: STR,
        killers: { type: "array", items: { type: "string" } },
        outcome: { type: "string", enum: OUTCOMES }, otherBuyerPrice: NUM, whyItDied: STR, walkBack: { type: "boolean" }, quote: STR,
      } } },
    representation: { type: "object", additionalProperties: false, required: ["offered", "quote", "askedCommission"],
      properties: { offered: { type: "boolean" }, quote: STR, askedCommission: { type: "boolean" } } },
    openQuestions: { type: "array", items: { type: "object", additionalProperties: false, required: ["topic", "quote", "answered"],
      properties: { topic: { type: "string" }, quote: STR, answered: { type: "string", enum: ["yes", "deferred", "no"] } } } },
    broughtOtherHouses: { type: "integer" },
    summary: { type: "string" },
  },
};

export const INVESTOR_READ_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["deals", "rules", "openQuestions", "summary"],
  properties: {
    deals: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["address", "pitchedPrice", "theirPrice", "theirArv", "theirRehab", "verdict", "reason", "quote"],
      properties: { address: { type: "string" }, pitchedPrice: NUM, theirPrice: NUM, theirArv: NUM, theirRehab: NUM,
        verdict: { type: "string", enum: VERDICTS }, reason: nullable({ type: "string", enum: REASONS }), quote: STR } } },
    rules: { type: "object", additionalProperties: false, required: ["pctOfArv", "minProfit", "maxPrice", "rehabView", "quote"],
      properties: { pctOfArv: nullable({ type: "number" }), minProfit: NUM, maxPrice: NUM, rehabView: STR, quote: STR } },
    openQuestions: AGENT_READ_SCHEMA.properties.openQuestions,
    summary: { type: "string" },
  },
};

const COMMON = `Matt Shepherd (Shep Flips) buys fixer houses around Puget Sound (and Bend/Redmond, OR) by making offers to listing agents — usually a letter of intent, with the agent writing it up on NWMLS forms — and assigns the contracts to investor buyers. US is Matt or his assistant (always speaking as Matt); THEM is the contact. Call transcripts show Speaker numbers; work out which one is Matt from context.

Read the WHOLE history, every call transcript included. Facts only from the history; never invent; null when unknown. Money as whole dollars ("450k" → 450000, "1.2M" → 1200000). Dates YYYY-MM-DD. Quotes are THEIR words, verbatim, at most 200 characters — never ours.`;

export const AGENT_READ_SYSTEM = `${COMMON}

THEM is an agent (or a seller, a wholesaler, someone else). Record:
- houses: each house where something real was said (a price, the condition, an outcome). ourNumbers: numbers WE gave. sellerNumbers: what the seller wants or would take (ask / counter / would_take / accepted_ours / floor). agentArv / agentRehab: the agent's or seller's OWN estimate of value fixed up, or repair cost — never ours read back. condition and conditionWords: the state of the house in their words. killers: facts that keep a flipper away (teardown, manufactured, competing_offers, multiple_offers, wholesaler_paper, short_sale, reo, moved, land, multi_family, rural, tenant, title, septic, foundation, fire, other:…). outcome. otherBuyerPrice: what it sold or went pending for, or a competing offer's amount. walkBack: true if we gave or agreed a number and later lowered or retracted it, or passed after their yes.
- representation: they offered to represent us as our buyer's agent or broker (offered), and whether they asked if we pay their commission (askedCommission).
- openQuestions: questions THEY asked us about our terms, process, money, representation, proof of funds, closing, inspection, earnest money, who we are; answered "deferred" when we said we'd check or call, "no" when we never answered.`;

export const INVESTOR_READ_SYSTEM = `${COMMON}

THEM is an investor buyer. Record:
- deals: each deal of ours they reacted to: pitchedPrice (ours to them), theirPrice (any price they said they'd pay, offered or called fair), theirArv and theirRehab (their own estimates for that house), verdict, and reason when they passed.
- rules: how they say they price any deal ("70% of ARV minus rehab" → pctOfArv 0.70; a minimum profit; a top price; how they think about rehab).
- openQuestions: questions they asked us, as above.`;

/** threadReadPrompt(thread, { party, name }) → the user message for the model. */
export function threadReadPrompt(thread, { party = "agent", name = "" } = {}) {
  const { text } = threadForModel(thread);
  const first = String(name || "").trim().split(/\s+/)[0] || (party === "investor" ? "the investor" : "the agent");
  return `${party === "investor" ? "INVESTOR" : "CONTACT"}: ${first}\nHISTORY (oldest first; US = Matt / Shep Flips, THEM = ${first}):\n\n${text}\n\nRecord what this history says, as the instructions describe.`;
}

// A single quote kept only when it is in their own words (when there is a thread to check it in).
function theirQuote(q, thread) {
  const t = str(q, 200);
  if (!t) return null;
  if (!thread) return t; // an imported read: the backfill readers worked from the whole thread
  const { quotes } = verifyQuotes([{ text: t }], thread);
  return quotes[0]?.text || null;
}

/**
 * normalizeThreadRead(raw, thread, { party, by, at }) → a read safe to store
 * `thread` is null for an imported read (its quotes can't be re-checked here).
 */
export function normalizeThreadRead(raw = {}, thread = null, { party = "agent", by = "", at = new Date().toISOString() } = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  const msgs = thread?.messages || [];
  const base = {
    version: THREAD_READ_VERSION, party: party === "investor" ? "investor" : "agent", by: str(by, 80), readAt: at,
    through: msgs.length ? msgs[msgs.length - 1].at : (r.through || null),
    summary: str(r.summary, 400),
    openQuestions: list(r.openQuestions).slice(0, MAX_QUESTIONS).map((q) => ({
      topic: str(q?.topic, 60).toLowerCase(), quote: theirQuote(q?.quote, thread), answered: oneOf(q?.answered, ["yes", "deferred", "no"], "no"),
    })).filter((q) => q.topic),
  };
  if (base.party === "investor") {
    const rules = r.rules || {};
    const pct = Number(rules.pctOfArv);
    return { ...base,
      deals: list(r.deals).slice(0, MAX_DEALS).map((d) => ({
        address: str(d?.address, 120), houseKey: houseKey(d?.address || "") || null,
        pitchedPrice: money(d?.pitchedPrice), theirPrice: money(d?.theirPrice), theirArv: money(d?.theirArv), theirRehab: money(d?.theirRehab),
        verdict: oneOf(d?.verdict, VERDICTS, "asked_info"), reason: oneOf(d?.reason, REASONS, null), quote: theirQuote(d?.quote, thread),
      })).filter((d) => d.address),
      rules: { pctOfArv: Number.isFinite(pct) && pct > 0 ? (pct > 1 ? pct / 100 : pct) : null, minProfit: money(rules.minProfit), maxPrice: money(rules.maxPrice),
        rehabView: str(rules.rehabView, 120) || null, quote: theirQuote(rules.quote, thread) },
    };
  }
  const rep = r.representation || {};
  return { ...base,
    kind: oneOf(r.kind, ["listing_agent", "buyers_agent", "wholesaler", "investor", "seller", "other"], "other"),
    houses: list(r.houses).slice(0, MAX_HOUSES).map((h) => ({
      address: str(h?.address, 120), houseKey: houseKey(h?.address || "") || null, listed: typeof h?.listed === "boolean" ? h.listed : null,
      listPrice: money(h?.listPrice),
      ourNumbers: list(h?.ourNumbers).map((x) => ({ amount: money(x?.amount), date: day(x?.date) })).filter((x) => x.amount),
      sellerNumbers: list(h?.sellerNumbers).map((x) => ({ amount: money(x?.amount), date: day(x?.date), kind: oneOf(x?.kind, SELLER_KINDS, "ask") })).filter((x) => x.amount),
      agentArv: money(h?.agentArv), agentRehab: money(h?.agentRehab),
      condition: oneOf(h?.condition, CONDITIONS, "unknown"), conditionWords: theirQuote(h?.conditionWords, thread),
      killers: [...new Set(list(h?.killers).map((k) => str(k, 60).toLowerCase()).filter(Boolean))].slice(0, MAX_KILLERS),
      outcome: oneOf(h?.outcome, OUTCOMES, "unknown"), otherBuyerPrice: money(h?.otherBuyerPrice),
      whyItDied: str(h?.whyItDied, 140) || null, walkBack: h?.walkBack === true, quote: theirQuote(h?.quote, thread),
    })).filter((h) => h.address),
    representation: { offered: rep.offered === true, quote: theirQuote(rep.quote, thread), askedCommission: rep.askedCommission === true },
    broughtOtherHouses: Math.max(0, Math.round(Number(r.broughtOtherHouses) || 0)),
  };
}

/**
 * evidenceRows(read, { contactId }) → [{ houseKey, address, row }]
 * What one read says about each house, as the row its house_pricing record keeps (one per contact).
 */
export function evidenceRows(read = {}, { contactId = null } = {}) {
  const at = read.readAt || null;
  if (read.party === "investor") {
    return (read.deals || []).filter((d) => d.houseKey).map((d) => ({ houseKey: d.houseKey, address: d.address, row: {
      contactId, party: "investor", at, pitchedPrice: d.pitchedPrice, theirPrice: d.theirPrice, theirArv: d.theirArv, theirRehab: d.theirRehab,
      verdict: d.verdict, reason: d.reason, quote: d.quote } }));
  }
  return (read.houses || []).filter((h) => h.houseKey).map((h) => {
    const theirs = h.sellerNumbers.filter((x) => x.kind !== "accepted_ours").map((x) => x.amount);
    return { houseKey: h.houseKey, address: h.address, row: {
      contactId, party: "agent", at, listPrice: h.listPrice, ourLast: h.ourNumbers.at(-1)?.amount || null,
      sellerLowest: theirs.length ? Math.min(...theirs) : null, acceptedOurs: h.sellerNumbers.some((x) => x.kind === "accepted_ours"),
      agentArv: h.agentArv, agentRehab: h.agentRehab, condition: h.condition, killers: h.killers, outcome: h.outcome,
      otherBuyerPrice: h.otherBuyerPrice, walkBack: h.walkBack, quote: h.quote || h.conditionWords } };
  });
}

/** mergeEvidence(existing, row) → the house's evidence list with this contact's row replacing its last one. */
export function mergeEvidence(existing = [], row = {}) {
  return [...list(existing).filter((e) => !(e?.contactId && e.contactId === row.contactId && e.party === row.party)), row].slice(-40);
}

/** questionTopics(reads) → [[topic, count]] of questions we deferred or never answered, most first. */
export function questionTopics(reads = []) {
  const n = {};
  for (const r of reads) for (const q of r?.openQuestions || []) if (q.answered !== "yes") n[q.topic] = (n[q.topic] || 0) + 1;
  return Object.entries(n).sort((a, b) => b[1] - a[1]);
}
