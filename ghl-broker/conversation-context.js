// conversation-context.js — what we know about the person texting us, in the
// terms the model needs and nothing else.
//
// Two record books, one per party. An agent's is the offer book: what we
// offered, on which house, at what price, and what happened. An investor's is
// the deal book: their buy box, the deals they're already on, the live deals
// that fit them, and whether they've opened the dataroom links we sent. Each
// builder returns the text block for the prompt PLUS two lists of numbers —
// the ones the reply may quote, and the ones it must never say. The money
// guard in reply-agent.js is only as good as those lists.
//
// The loaders do I/O; the builders are pure and tested.

import { fmtMoney } from "./shared/offer-calc.js";
import { effectiveStatus, offerHeat, investorStatus, WORKING_INVESTOR_STATUSES, dealSpokenFor, dealOutreachPaused } from "./shared/offer-status.js";
import { normalizeBuybox, buildBuyboxProfile, matchBuybox } from "./shared/buybox.js";
import { dealToQuery } from "./dispo.js";
import { dealNumbers } from "./dataroom.js";
import { enrichFieldDefs } from "./enrich.js";
import { OUTREACH_FIELDS } from "./field-registry.js";
import { PASS_REASON_LABEL } from "./shared/conversation-ai.js";
import { addressKey as propertyKey } from "./shared/us-address.js";
import { ledgerEvents, eventToHistoryLine, factsAsCustom, factsEmpty, addressKey, propertyDossier, PROPERTY_DETAIL_FIELDS, CORE_DETAIL_FIELDS } from "./shared/contact-record.js";
import { customFieldIdKeyMapForDefs, contactCustomRecord } from "./ghl.js";

export const RA_OFFERS_IN_CONTEXT = 8;    // the agent's most recent offers, newest first
export const MATCHING_DEALS_MAX = 5;
export const INVESTOR_DEAL_STAGES = new Set(["under_contract", "buyer_found"]);
// Deals that are over. An investor who asks about one gets told, not ignored.
export const GONE_DEAL_STAGES = new Set(["assigned", "closed", "fell_through"]);
const GONE_WORD = { assigned: "assigned to another buyer", closed: "closed", fell_through: "fell through", spoken_for: "committed to another buyer, don't pitch it or send the package" };
export const HISTORY_LINES_IN_CONTEXT = 6;

const daysAgo = (iso, now) => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 86400000)) : null;
};
const agoWord = (d) => (d == null ? "" : d === 0 ? "today" : `${d} day${d === 1 ? "" : "s"} ago`);
const dateWord = (iso) => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "";
};

/* ---------- the contact's own fields ---------- */

// The enrichment fields both parties share, plus each party's own. Read by
// OUR key names through customFieldIdKeyMapForDefs — GHL derives its own key
// from the display name and they drift.
const AGENT_FIELD_KEYS = ["subject_property", "agent_market_area", "personal_details", "last_convo_summary", "suggested_next_action"];
const INVESTOR_FIELD_KEYS = ["personal_details", "last_convo_summary", "suggested_next_action"];

export async function loadContactContext({ client, locationId, contact }) {
  let custom = {};
  try {
    const defs = [...enrichFieldDefs("agent"), ...enrichFieldDefs("investor"), ...OUTREACH_FIELDS];
    const idKeyMap = await customFieldIdKeyMapForDefs(client, locationId, defs);
    custom = contactCustomRecord(contact, idKeyMap);
  } catch { /* no custom-field scope, or an offline test client — the thread still carries the conversation */ }
  return custom;
}

const FIELD_LABEL = {
  subject_property: "the property they're currently discussing with us",
  agent_market_area: "areas they work",
  personal_details: "personal details they've shared",
  last_convo_summary: "our last conversation, summarised",
  suggested_next_action: "the next step we had planned",
};

export function fieldLines(custom = {}, keys = []) {
  const out = [];
  for (const k of keys) {
    const v = String(custom?.[k] ?? "").trim();
    if (v) out.push(`- ${FIELD_LABEL[k] || k}: ${v.slice(0, 400)}`);
  }
  return out;
}

/* ---------- the agent's book ---------- */

// "around 450ish" on a 447,300 offer: the rough figure is ours too. The exact
// number, the nearest thousand, and round numbers at or BELOW the offer —
// never a rounding that lands above what we underwrote.
export function roughAmounts(amount) {
  const a = Math.round(Number(amount) || 0);
  if (!(a > 0)) return [];
  const out = new Set([a, Math.round(a / 1000) * 1000]);
  for (const step of [5000, 10000, 25000]) out.add(Math.floor(a / step) * step);
  const near5 = Math.round(a / 5000) * 5000;
  if (near5 <= a + 1000) out.add(near5);
  return [...out].filter((n) => n > 0);
}

const statusWord = (s) => ({
  draft: "draft (not sent)", new: "not sent yet", sent: "sent, waiting on the agent",
  countered: "agent countered", no_response: "no response", passed: "agent passed", we_passed: "we passed on it (withdrawn)", accepted: "accepted",
}[s] || s || "unknown");

// The offer book, newest first, capped, and every number here is a number the
// reply is ALLOWED to say. Unchanged from the first version except that the
// asking price now actually arrives (see toListOffer in shared/offer-status.js).
// The last time the offer's own number moved: the newest send, re-quote or
// status row. A number we floated after that is the number.
function lastPriceMoveTs(o) {
  const ts = [
    ...(o.requotes || []).map((r) => r?.ts),
    ...(o.sends || []).map((x) => x?.ts),
    ...(o.statusHistory || []).filter((h) => h?.status === "sent").map((h) => h?.ts),
    o.createdAt,
  ].map((t) => Date.parse(t || "")).filter(Number.isFinite);
  return ts.length ? Math.max(...ts) : 0;
}

// Money the way we text it, off one line. Kept small: the reply agent's
// fuller parser lives beside the gates; the book only needs to notice a
// number of ours.
const LINE_MONEY_RX = /\$\s?\d[\d,]*(?:\.\d+)?\s?[kK]?\b|\b\d+(?:\.\d+)?\s?[kK]\b|\b\d{1,3}(?:,\d{3})+\b/g;
const lineMoney = (text) => [...String(text || "").matchAll(LINE_MONEY_RX)].map((m) => {
  const raw = m[0].replace(/[$,\s]/g, "");
  const k = /k$/i.test(raw);
  const n = Number(k ? raw.slice(0, -1) : raw);
  return Number.isFinite(n) ? Math.round(k ? n * 1000 : n) : 0;
}).filter((n) => n > 0);

/**
 * ourComeDown(offer, transcript) → { amount, ts, text } | null
 *
 * The lower number WE put to the agent after the offer's number last moved
 * — "Can we do $65k actually" (Kimberly Pettie, 1510 Maple Lane: the book
 * said 71,075, Matt texted 65k by hand, and three days later the bot told
 * her the offer was "still good, 71k"). Ours only (US lines), after the
 * last send/re-quote, under the book's number and not absurdly under it.
 * The lowest such number wins: it is the one the seller is deciding on.
 */
export function ourComeDown(o, transcript = "") {
  const amount = Number(o?.cashAmount) || 0;
  if (!amount || !transcript) return null;
  const since = lastPriceMoveTs(o);
  let best = null;
  for (const line of String(transcript).split(/\r?\n/)) {
    const m = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\] US \w+: (.*)$/.exec(line);
    if (!m) continue;
    const ts = Date.parse(`${m[1]}T${m[2]}:00Z`);
    if (!Number.isFinite(ts) || ts < since) continue;
    const text = m[3].trim();
    // A message that carries the offer documents restates the book, not a
    // new number.
    if (/\bhere's our (written cash offer|letter of intent)\b/i.test(text)) continue;
    // Under the book's number, not absurdly under it, and not the book's
    // own number said the way people text it ("71k" for 71,075).
    const restated = (n) => {
      let unit = 1000;
      while (n % (unit * 10) === 0 && unit < 1e9) unit *= 10;
      return n % 1000 === 0 && Math.abs(n - amount) <= unit / 2 && Math.abs(n - amount) <= amount * 0.01;
    };
    const lower = lineMoney(text).filter((n) => n < amount && n >= amount * 0.4 && !restated(n));
    if (!lower.length) continue;
    const n = Math.min(...lower);
    if (!best || n < best.amount) best = { amount: n, ts, text: text.slice(0, 120) };
  }
  return best;
}

export function summarizeOffers(offers = [], { now = Date.now(), showMath = false, transcript = "" } = {}) {
  const stale = new Set();
  const rows = [...offers]
    .filter((o) => o && o.address)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, RA_OFFERS_IN_CONTEXT);
  const lines = [];
  const amounts = new Set();
  for (const o of rows) {
    const status = effectiveStatus(o);
    const amount = Number(o.cashAmount) || 0;
    const down = amount && !["passed", "expired", "withdrawn", "accepted", "agreed"].includes(status) ? ourComeDown(o, transcript) : null;
    if (down) {
      for (const n of roughAmounts(down.amount)) amounts.add(n);
      stale.add(Math.round(amount));
    } else if (amount) for (const n of roughAmounts(amount)) amounts.add(n);
    const asking = Number(o.askingPrice ?? o.inputs?.askingPrice ?? o.calc?.inputs?.askingPrice) || 0;
    if (asking) amounts.add(asking);
    const lastSend = (o.sends || []).filter((s) => s && s.ts).sort((a, b) => String(b.ts).localeCompare(String(a.ts)))[0];
    const age = daysAgo(lastSend?.ts || o.createdAt, now);
    // The letter's terms are things the bot may confirm; the math behind the
    // number is leverage, shown only when the playbook says so.
    const t = o.terms || {};
    const terms = [
      t.closingDays ? `${t.closingDays}-day close` : "",
      t.earnestMoney ? `${fmtMoney(t.earnestMoney)} earnest money` : "",
      t.condition ? "as-is" : "",
    ].filter(Boolean).join(", ");
    if (t.earnestMoney) amounts.add(Math.round(t.earnestMoney));
    const arv = Number(o.arv ?? o.calc?.inputs?.arv) || 0;
    const repairs = Number(o.repairs ?? o.calc?.inputs?.repairs) || 0;
    // Showing our work: the percent of ARV the offer starts from, and the two
    // stepping stones the bot may say out loud on the way to the number.
    const pct = Number(o.calc?.settings?.maoPctOfArv) || 0;
    const atPct = arv && pct ? Math.round(arv * pct / 100) : 0;
    // What's left between (pct × ARV − rehab) and the offer is our costs and
    // margin. It's never named; it only has to be plausible as that. A gap
    // that is negative or huge means the offer was capped or overridden and
    // the arithmetic shouldn't be walked through.
    const gap = atPct && amount ? atPct - repairs - amount : 0;
    const ties = Boolean(atPct && amount) && gap >= 0 && gap <= Math.max(60000, amount * 0.08);
    if (showMath) { for (const n of [arv, repairs, atPct, atPct && repairs ? atPct - repairs : 0]) if (n > 0) amounts.add(n); }
    const counters = (o.statusHistory || []).filter((h) => h?.status === "countered").slice(-2)
      .map((h) => `countered${h.note ? ` (${String(h.note).slice(0, 60)})` : ""} ${dateWord(h.ts)}`);
    const heat = offerHeat(o);
    const realm = o.realm?.answer === "yes" ? "agent said the number is in the realm" : "";
    const parts = [
      `${o.address}:`,
      down
        ? `our cash offer was ${fmtMoney(amount)}, then WE CAME DOWN TO ${fmtMoney(down.amount)} ${dateWord(down.ts)} ("${down.text}") and the seller is deciding on that — ` +
          `${fmtMoney(down.amount)} is our number on this house. Never say ${fmtMoney(amount)} again, and never say the offer is "still good" at it`
        : amount ? `our cash offer ${fmtMoney(amount)}`
        // A held run is finished, not in progress: someone on the team is
        // checking the numbers, and "coming shortly" would be a promise.
        : status === "draft" ? (o.autoUnderwrite?.held?.length ? "numbers held for our team's review (no number yet)" : "still being underwritten (no number yet)")
        : "no amount recorded",
      asking ? `(asking ${fmtMoney(asking)})` : "",
      terms ? `terms: ${terms}` : "",
      showMath && (arv || repairs)
        ? `[our math: ARV ${arv ? fmtMoney(arv) : "n/a"}${atPct ? `; ${pct}% of ARV = ${fmtMoney(atPct)}` : ""}; rehab ${repairs ? fmtMoney(repairs) : "n/a"}` +
          `${atPct && repairs ? `; less rehab = ${fmtMoney(atPct - repairs)}` : ""}; after our costs and margin = the offer` +
          `${ties ? "" : " — the figures don't tie exactly (the number was capped or set by hand): describe the method, don't do the arithmetic out loud"}]`
        : "",
      `— status: ${statusWord(status)}`,
      lastSend ? `sent ${agoWord(age)} by ${(lastSend.channels || []).join("+") || "message"}` : status === "draft" ? "" : "not sent yet",
      // No expiry date: the offer stands until they answer, and a date here
      // is what had the bot telling agents an offer had lapsed.
      counters.length ? `history: ${counters.join("; ")}` : "",
      realm,
      // Step 4 of the goal is reached: what's left is getting it written up.
      heat ? `HOT (${heat.reason}) — the price conversation is done; the next step is asking them to write it up on NWMLS forms for us to sign` : "",
      o.statusNote ? `note: ${String(o.statusNote).slice(0, 120)}` : "",
    ].filter(Boolean);
    lines.push(`- ${parts.join(" ")}`);
  }
  for (const n of stale) amounts.delete(n);
  return { text: lines.join("\n"), amounts: [...amounts], stale: [...stale], count: rows.length };
}

// The tail of a history ledger — the properties they've sent or discussed
// with us before. This is what "thanks again for the Tacoma addresses" is
// built on.
const historyTail = (v, n = HISTORY_LINES_IN_CONTEXT) =>
  String(v || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-n);

// The record first, GHL second. Where the app has a fact it wins; where it
// has none the GHL field fills the gap — so a contact with an empty record
// reads exactly as it did before the record existed, and one with a full
// record reads from the source of truth. Same 400-char slices either way.
const EVENTS_IN_CONTEXT = 12;
export const recordOverCustom = (custom = {}, facts = null) =>
  facts && !factsEmpty(facts) ? { ...custom, ...factsAsCustom(facts) } : custom;
// The ledger the prompt shows: the newest EVENTS_IN_CONTEXT ledger events,
// oldest first, in the same line format the GHL field carries — or the tail
// of the GHL field when the record has nothing.
export function historyFromRecord(events = [], party, fallbackField) {
  const ledger = ledgerEvents(events, party).slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
  if (ledger.length) return ledger.slice(-EVENTS_IN_CONTEXT).map(eventToHistoryLine);
  return historyTail(fallbackField);
}

export function buildAgentContext({ offers, custom: rawCustom = {}, now = Date.now(), showMath = false, events = [], facts = null, transcript = "" }) {
  const custom = recordOverCustom(rawCustom, facts);
  const book = summarizeOffers(offers, { now, showMath, transcript });
  const amounts = new Set(book.amounts);
  const fields = fieldLines(custom, AGENT_FIELD_KEYS);

  // The listing that made us reach out in the first place. Its list price
  // is a number the reply may say; its days on market is the opener.
  const hookAddress = String(custom.hook_address || "").trim();
  const hookPrice = Number(String(custom.hook_price ?? "").replace(/[$,\s]/g, "")) || 0;
  const hookDom = Number(String(custom.hook_dom ?? "").replace(/[^\d]/g, "")) || 0;
  if (hookPrice) amounts.add(Math.round(hookPrice));
  const hook = hookAddress
    ? `THE LISTING WE FIRST REACHED OUT ABOUT: ${hookAddress}` +
      (hookPrice ? ` — listed at ${fmtMoney(hookPrice)}` : "") + (hookDom ? `, ${hookDom} days on market` : "")
    : "";
  const history = historyFromRecord(events, "agent", custom.agent_deal_history);
  // What the agent said a property is worth and costs — newest per address.
  // Shown so the reply doesn't ask twice and can hold their number next to
  // ours; their figures are allowed in a reply (they said them) but are
  // never ours to quote as an offer.
  const takes = new Map();
  for (const e of [...events].sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
    if (e?.type === "agent_estimate" && e.address) takes.set(addressKey(e.address), e);
  }
  const takeLines = [...takes.values()].slice(-4).map((e) => {
    const d = e.data || {};
    if (d.arv) amounts.add(Math.round(d.arv));
    if (d.rehab) amounts.add(Math.round(d.rehab));
    return `- ${e.address}: ${[d.arv ? `worth ${fmtMoney(d.arv)} done` : "", d.rehab ? `about ${fmtMoney(d.rehab)} of work` : ""].filter(Boolean).join(", ")}${d.note ? ` — "${d.note}"` : ""}`;
  });

  // The dossier on the property they're on about — what we have, and the
  // next thing to ask. The subject property is the one the underwriter
  // will read, so it is the one the checklist is for.
  const subject = String(custom.subject_property || "").trim();
  const dossier = subject ? propertyDossier(events, subject) : null;
  let dossierText = "";
  if (dossier && (Object.keys(dossier.have).length || dossier.missing.length < PROPERTY_DETAIL_FIELDS.length)) {
    const haveLines = PROPERTY_DETAIL_FIELDS.filter((f) => dossier.have[f.key]).map((f) => {
      const v = dossier.have[f.key].value;
      if (f.number) amounts.add(Math.round(Number(v)));
      return `- ${f.label}: ${f.number ? fmtMoney(v) : f.values ? String(v).replace(/_/g, " ") : v}`;
    });
    const core = dossier.asks.filter((f) => f.priority === "core");
    const nice = dossier.missing.filter((f) => f.priority !== "core");
    dossierText = `WHAT WE HAVE ON ${subject}:\n${haveLines.join("\n")}` +
      (core.length ? `\nSTILL MISSING (ask for ONE of these, the most useful next): ${core.map((f) => f.ask).join("; ")}` : "\nNothing we need is missing — it's ready for underwriting.") +
      (nice.length ? `\nDON'T ASK, BUT FILE IF THEY SAY IT: ${nice.map((f) => f.ask).join("; ")}` : "");
  } else if (subject) {
    const seen = new Set();
    const coreAsks = CORE_DETAIL_FIELDS.filter((f) => { const g = f.askGroup || f.key; if (seen.has(g)) return false; seen.add(g); return true; });
    dossierText = `WHAT WE HAVE ON ${subject}: nothing yet.\nSTILL MISSING (ask for ONE of these, the most useful next): ${coreAsks.map((f) => f.ask).join("; ")}` +
      `\nDON'T ASK, BUT FILE IF THEY SAY IT: ${PROPERTY_DETAIL_FIELDS.filter((f) => f.priority !== "core").map((f) => f.ask).join("; ")}`;
  }
  // Our own underwrite on the subject, when there is one and we don't yet
  // have their take: the bot leads with ours to get theirs, the way Matt
  // does — "I'm thinking $850K ARV and $200K+ of rehab. What do you think?"
  // The two figures are allowed in the reply for exactly this; they are
  // never an offer.
  if (subject && dossier && !dossier.have.arv && !dossier.have.rehab) {
    const mine = (offers || []).find((o) => o?.address && propertyKey(o.address) === propertyKey(subject) && (Number(o.arv) > 0 || Number(o.repairs) > 0));
    if (mine) {
      const arv = Math.round(Number(mine.arv) || 0);
      const rehab = Math.round(Number(mine.repairs) || 0);
      if (arv) amounts.add(arv);
      if (rehab) amounts.add(rehab);
      const k = (n) => `${Math.round(n / 1000)}K`;   // no dollar sign in a text
      dossierText += `\nOUR UNDERWRITE ON IT: ${[arv ? `ARV ${fmtMoney(arv)}` : "", rehab ? `rehab about ${fmtMoney(rehab)}` : ""].filter(Boolean).join(", ")}. ` +
        `To get their take, lead with ours as an opinion, in one question: "I'm thinking ${arv ? `${k(arv)} After Repair Value` : "…"}${arv && rehab ? " and " : ""}${rehab ? `${k(rehab)}+ of rehab` : ""}. What do you think?" — this is not an offer and must not read as one.`;
    }
  }

  const text = [
    book.count
      ? `OUR OFFERS TO THIS AGENT (newest first — the only numbers you may quote):\n${book.text}\n` +
        // The operator's "never quote a number" rules are about numbers we
        // haven't committed to. A sent offer is in their inbox already.
        // The underwrite's number is the number we're going to stand behind.
        // Asked "what can you do?", the bot gives it — roughly, without the
        // math — and the agent's answer (yes / tight / no) drives the rest.
        "An offer WITH a number that hasn't been sent yet is our underwritten number: when they ask what we can do, " +
        "give it as a rough figure — \"based on our analysis we can likely do around 450ish\" — rounded to the " +
        "nearest thousand or down to a round number (never up), with no dollar sign, and ask whether that works " +
        "for the seller. A yes means our letter of intent goes over and we ask them to write the official offer on NWMLS forms for us to sign. " +
        (showMath
          ? "If they ask how we got there or push on the number, follow the MATH rule (show our work; never our margin or how we exit). "
          : "Don't explain how we got there (ARV, repairs, fees). ") +
        "Don't volunteer it before you have their own read unless they ask. " +
        "An offer marked SENT is on paper: if they ask for the number or the terms, restate it " +
        "from this list. It stands until they answer: never say it expired or lapsed, and if they ask whether it's " +
        "still good, it is. Rules against quoting numbers are about numbers we don't have; these we do. Never promise " +
        "an offer on an address that already has one sent; refer to the one they have. An offer with no number " +
        "yet is still being worked: never make up timing or a figure for it."
      : "OUR OFFERS TO THIS AGENT: none on record.",
    dossierText,
    takeLines.length ? `THE AGENT'S OWN TAKE (their numbers, not ours — don't ask again, don't adopt them):\n${takeLines.join("\n")}` : "",
    hook,
    history.length ? `PROPERTIES THEY'VE SENT OR DISCUSSED WITH US BEFORE (oldest first):\n${history.map((l) => `- ${l}`).join("\n")}` : "",
    fields.length ? `WHAT WE KNOW ABOUT THEM:\n${fields.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  return {
    text, amounts: [...amounts].filter((n) => !book.stale.includes(n)), forbiddenAmounts: [], staleAmounts: book.stale, offers: book,
    summary: { offers: book.count, fields: fields.length, hook: Boolean(hookAddress), history: history.length },
  };
}

// The contact's record, when the store has one. A store without the
// tables (a test double, a first boot) answers empty and the GHL fields
// carry the prompt as they always did.
async function loadRecord(store, locationId, contactId) {
  let facts = null;
  let events = [];
  try { facts = (await store.getContactProfile?.(locationId, contactId))?.facts || null; } catch { facts = null; }
  try { events = (await store.listContactEvents?.(locationId, contactId, { limit: 200 })) || []; } catch { events = []; }
  return { facts, events };
}

// The lessons digest, as a context block. It carries no dollar figures by
// construction (post-mortem.js strips them), so the money guard's allowance
// is untouched: these are lines to hold, not numbers to quote.
export function lessonsContextText(digest = "") {
  const d = String(digest || "").trim();
  if (!d) return "";
  return "NEGOTIATION LESSONS FROM OUR OWN FELL-THROUGH DEALS (hold these lines; they are not numbers to quote and not a script to recite):\n" +
    d.split(/(?<=[.!?])\s+/).filter(Boolean).map((l) => `- ${l.trim()}`).join("\n");
}

export async function loadAgentContext({ store, locationId, contactId, custom = {}, now = Date.now(), showMath = false, transcript = "" }) {
  const rows = await store.listOffers(locationId, { contactId, limit: 25, lean: true }).catch(() => []);
  const { facts, events } = await loadRecord(store, locationId, contactId);
  return buildAgentContext({ offers: rows, custom, now, showMath, facts, events, transcript });
}

/* ---------- is this a deal you are working yourself? ---------- */

// A deal that is still ours to close. "assigned" counts: the paperwork is
// signed but the file isn't closed, and a stray bot text into that window is
// the worst kind.
export const WORKING_DEAL_STAGES = new Set(["under_contract", "buyer_found", "assigned"]);

/**
 * liveDealHold({ store, locationId, contactId, mode }) → { address, role, stage, status? } | null
 *
 * Whether the bot should keep its hands off this contact because a person is
 * in the middle of a deal with them.
 *
 * Two sides, and they hold for different reasons:
 *
 * ACQUISITION — the listing agent or seller on a property we have under
 * contract. An accepted offer turns cold outreach into a live negotiation,
 * and none of that should be answered by a bot.
 *
 * BUYERS — only the one who is "committed", the buyer signing the assignment.
 * Past that point the deal is paperwork and a bot has nothing to add.
 * "evaluating" is not a handoff: it is every buyer actively weighing the
 * deal, a dozen of them on a good blast, and working them toward a
 * walkthrough is the whole job. A buyer who passed is free for the next one.
 *
 * `mode`: "working" (both sides, the default) | "acquisition" (that side
 * only, so the bot keeps talking to buyers mid-deal) | "off".
 */
export async function liveDealHold({ store, locationId, contactId, mode = "working" }) {
  if (!contactId || mode === "off") return null;
  const theirs = await store.listOffers(locationId, { contactId, limit: 25, lean: true }).catch(() => []);
  const mine = theirs.find((o) => o?.deal && WORKING_DEAL_STAGES.has(o.deal.stage));
  if (mine) return { address: mine.address || "a property", role: "acquisition", stage: mine.deal.stage };
  if (mode !== "working") return null;
  const deals = await store.listDeals(locationId).catch(() => []);
  let found = null;
  for (const o of deals) {
    if (!WORKING_DEAL_STAGES.has(o?.deal?.stage)) continue;
    const link = (o.deal.investors || []).find((i) => i.contactId === contactId);
    if (!link) continue;
    const status = investorStatus(link.status);
    if (!WORKING_INVESTOR_STATUSES.has(status)) continue;
    found = { address: o.address || "a property", role: "buyer", stage: o.deal.stage, status };
    break;
  }
  return found;
}

/* ---------- the investor's book ---------- */

// The price an investor may be quoted on a deal, and the two figures behind
// it that they must never hear. A dataroom's own headline wins when one
// exists — that is the number the investor has already seen — otherwise the
// deal's arithmetic. Both come from the same place the dataroom prints from.
export function investorFacingPrice({ offer, room = null, settings = {} }) {
  const base = dealNumbers({ offer, settings });
  const snap = room?.snapshot?.numbers || null;
  const price = Number(snap?.investorPrice) > 0 ? Number(snap.investorPrice) : base.investorPrice;
  const arv = Number(snap?.arv) > 0 ? Number(snap.arv) : base.arv;
  const repairs = Number(snap?.repairs) > 0 ? Number(snap.repairs) : base.repairs;
  const forbidden = [base.contractPrice, base.assignmentFee, Number(snap?.contractPrice) || 0, Number(snap?.assignmentFee) || 0, Number(offer?.cashAmount) || 0]
    .map((n) => Math.round(n)).filter((n) => n > 0);
  return { price: Math.round(price) || 0, arv: Math.round(arv) || 0, repairs: Math.round(repairs) || 0, forbidden };
}

// A recorded pass reason, in words the model can use. Their own note first —
// "needs to be under 400 for me" says more than "Price too high".
const reasonWords = (r) =>
  r?.code ? (r.note ? `${PASS_REASON_LABEL[r.code]} — "${String(r.note).slice(0, 140)}"` : PASS_REASON_LABEL[r.code]) : "";

const dealLine = (d) => {
  const money = [
    d.price ? `buyer price ${fmtMoney(d.price)}${d.agreed ? " (agreed with them; hold it, do not reopen it)" : ""}` : "price not set yet",
    d.arv ? `ARV ${fmtMoney(d.arv)}` : "",
    d.repairs ? `est. repairs ${fmtMoney(d.repairs)}` : "",
  ].filter(Boolean).join(", ");
  // "blasted" is not a status on the deal — it means the dispo tag says the
  // deal went out to them and nothing has come back.
  const status = d.linkStatus
    ? ` — ${d.linkStatus === "blasted" ? "we sent them this one, no answer yet" : `they are ${d.linkStatus}`}`
    : "";
  // Why they said no last time. The point of carrying it: don't re-pitch the
  // same objection back at them as if they never raised it.
  const said = d.reason ? ` — their reason: ${d.reason}` : "";
  const stage = d.stage === "buyer_found" ? " — a buyer is already lined up" : "";
  const invite = d.invite
    ? ` — dataroom link sent ${dateWord(d.invite.sentAt || d.invite.createdAt)}${d.invite.viewCount ? `, opened ${d.invite.viewCount}× (last ${dateWord(d.invite.lastViewedAt)})` : ", not opened yet"}`
    : "";
  return `- ${d.address}: ${money}${status}${said}${stage}${invite}`;
};

/**
 * buildInvestorContext({ investor, deals, invites, custom, now })
 *
 * `deals` — [{ offer, room }] for every live deal; `invites` — the investor's
 * dataroom invites. Pure. Returns { text, amounts, forbiddenAmounts, summary }.
 */
// A dispo blast tags the investor "<prefix>-<label>", the label typed by the
// operator (usually the street line). Match either way round — a tag that is
// a prefix of the address slug, or the street slug that is a prefix of the
// tag — so "dispo-2010-ne-54th-st" finds 2010 NE 54th St, Seattle.
const slug = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
export function blastTagged(tags = [], address = "", prefix = "dispo") {
  const p = slug(prefix) || "dispo";
  const full = slug(`${p}-${address}`);
  const street = slug(`${p}-${String(address || "").split(",")[0]}`);
  if (street === p || street.length <= p.length + 1) return false;
  return (tags || []).some((raw) => {
    const t = String(raw || "").trim().toLowerCase();
    if (!t.startsWith(`${p}-`) || t === `${p}-blast`) return false;
    return t === street || t === full || full.startsWith(`${t}-`) || t.startsWith(`${street}-`);
  });
}

export function buildInvestorContext({ investor = {}, deals = [], invites = [], custom: rawCustom = {}, contactId = "", tags = [], blastPrefix = "dispo", now = Date.now(), events = [], facts = null }) {
  const custom = recordOverCustom(rawCustom, facts);
  // A record with facts outranks the dispo cache's buy box: the cache is a
  // copy of GHL, and the record is what GHL is a copy of.
  const buybox = facts && !factsEmpty(facts) ? normalizeBuybox(custom) : (investor.buybox || normalizeBuybox(custom));
  const profile = buildBuyboxProfile({ ...investor, buybox }, { maxChars: 900 });
  const inviteByRoom = new Map();
  for (const i of invites) if (i?.dataroomId) inviteByRoom.set(i.dataroomId, i);

  const amounts = new Set();
  const forbidden = new Set();
  if (buybox.priceMin) amounts.add(Math.round(buybox.priceMin));
  if (buybox.priceMax) amounts.add(Math.round(buybox.priceMax));

  const linked = [];
  const candidates = [];
  const gone = [];
  for (const { offer, room = null, settings = {} } of deals) {
    if (!offer?.deal) continue;
    const link = (offer.deal.investors || []).find((i) => i.contactId === contactId) || null;
    const blasted = blastTagged(tags, offer.address, blastPrefix);
    if (GONE_DEAL_STAGES.has(offer.deal.stage)) {
      if (link || blasted) gone.push({ address: offer.address || "a property", stage: offer.deal.stage, at: offer.deal.updatedAt || "", theirs: link?.status || null, reason: reasonWords(link?.reason) });
      continue;
    }
    if (!INVESTOR_DEAL_STAGES.has(offer.deal.stage)) continue;
    // Committed to someone else: never a candidate, and to a buyer who already
    // knows it, only "spoken for" — no numbers to quote.
    if (dealSpokenFor(offer.deal) && link?.status !== "committed") {
      if (link || blasted) gone.push({ address: offer.address || "a property", stage: "spoken_for", at: offer.deal.updatedAt || "", theirs: link?.status || null, reason: reasonWords(link?.reason) });
      continue;
    }
    // Soft-committed to someone else: outreach on it is paused, and the bot
    // offering it in a reply IS outreach. Gunnar Eklund (2026-09-21) asked for
    // anything near Lake Stevens and was pitched 23706 138th Dr SE, numbers
    // and all, with a soft commit on it. A buyer already on the deal keeps it
    // — a soft commit is a maybe, and nobody looking is told it's gone — but
    // it is never brought up to anyone new, and its numbers stay out of what
    // the bot may say.
    if (!link && !blasted && dealOutreachPaused(offer.deal)) continue;
    const n = investorFacingPrice({ offer, room, settings });
    // A price the investor band agreed with THIS buyer is their price from
    // here on. What they must never hear grows with it: the fee they are
    // actually paying, and how far we came down.
    const agreed = Math.round(Number(link?.agreedPrice?.amount) || 0);
    if (agreed > 0 && agreed < n.price) {
      const contract = Math.round(Number(offer.deal.contractPrice) || Number(offer.cashAmount) || 0);
      n.forbidden.push(...[agreed - contract, n.price - agreed].filter((x) => x > 0));
      n.price = agreed;
      n.agreed = true;
    }
    const row = {
      address: offer.address || "a property", stage: offer.deal.stage,
      linkStatus: link ? investorStatus(link.status) : (blasted ? "blasted" : null), blasted,
      price: n.price, agreed: Boolean(n.agreed), arv: n.arv, repairs: n.repairs, invite: room ? inviteByRoom.get(room.id) || null : null,
      offerId: offer.id, reason: reasonWords(link?.reason),
    };
    if (link || blasted) linked.push(row);
    else {
      const m = matchBuybox(buybox, dealToQuery(offer).query);
      if (m.pass) candidates.push({ ...row, score: m.score, matched: m.matched.length });
    }
    for (const x of [n.price, n.arv, n.repairs]) if (x) amounts.add(x);
    for (const f of n.forbidden) forbidden.add(f);
  }
  gone.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  candidates.sort((a, b) => b.score - a.score || b.matched - a.matched || String(a.address).localeCompare(String(b.address)));
  const matching = candidates.slice(0, MATCHING_DEALS_MAX);

  // A figure that is both allowed and forbidden (a deal with no fee, where the
  // contract price IS the buyer price) is allowed — the guard must not flag
  // the one number we told the model to quote.
  const allowed = [...amounts];
  const forbiddenAmounts = [...forbidden].filter((n) => !amounts.has(n));

  const fields = fieldLines(custom, INVESTOR_FIELD_KEYS);
  const history = historyFromRecord(events, "investor", investor.dealHistory || custom.investor_deal_history);
  const standing = { committed: "they were the buyer", passed: "they passed on it", evaluating: "they were looking at it" };
  const goneLines = gone.slice(0, 3).map((g) => `- ${g.address}: ${GONE_WORD[g.stage] || g.stage}${g.theirs && standing[g.theirs] ? ` — ${standing[g.theirs]}` : ""}${g.reason ? ` (${g.reason})` : ""}`);
  const text = [
    `INVESTOR PROFILE (their buy box, as we understand it):\n${profile}`,
    linked.length ? `DEALS THEY ARE ALREADY ON (sent to them, or they asked):\n${linked.map(dealLine).join("\n")}` : "DEALS THEY ARE ALREADY ON: none.",
    matching.length
      ? `LIVE DEALS THAT FIT THEIR BUY BOX (you may bring these up; quote ONLY the buyer price):\n${matching.map(dealLine).join("\n")}`
      : "LIVE DEALS THAT FIT THEIR BUY BOX: none right now — say we'll reach out when something fits, and ask what they're after.",
    goneLines.length ? `NO LONGER AVAILABLE (if they ask about one of these, say so and offer what fits):\n${goneLines.join("\n")}` : "",
    history.length ? `PROPERTIES THEY'VE LOOKED AT WITH US BEFORE (oldest first):\n${history.map((l) => `- ${l}`).join("\n")}` : "",
    fields.length ? `WHAT WE KNOW ABOUT THEM:\n${fields.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");

  return {
    text, amounts: allowed, forbiddenAmounts,
    summary: {
      linkedDeals: linked.length, matchingDeals: matching.length, goneDeals: gone.length, invites: invites.length,
      fields: fields.length, history: history.length, buyboxEmpty: !profile.includes("\n"),
    },
    deals: { linked, matching, gone },
  };
}

export async function loadInvestorContext({ store, locationId, contactId, contactName = "", custom = {}, settings = {}, tags = [], now = Date.now() }) {
  let investor = { name: contactName, tags: [], buybox: null };
  try {
    const row = await store.getInvestor(locationId, contactId);
    if (row) {
      investor = {
        name: row.name || row.doc?.name || contactName,
        tags: row.doc?.tags || [],
        buybox: normalizeBuybox(row.doc?.custom || {}),
        lastConvoSummary: row.doc?.lastConvoSummary || custom.last_convo_summary || "",
        lastConvoDate: row.doc?.lastConvoDate || "",
        dealHistory: row.doc?.dealHistory || custom.investor_deal_history || "",
      };
    }
  } catch { /* no investors table yet, or a test store — the live fields below still describe them */ }
  if (!investor.buybox) {
    investor.buybox = normalizeBuybox(custom);
    investor.lastConvoSummary = investor.lastConvoSummary || custom.last_convo_summary || "";
    investor.dealHistory = investor.dealHistory || custom.investor_deal_history || "";
  }

  const offers = await (store.listDeals ? store.listDeals(locationId, { limit: 100 }) : Promise.resolve([])).catch(() => []);
  const deals = [];
  for (const offer of offers) {
    if (!INVESTOR_DEAL_STAGES.has(offer?.deal?.stage) && !GONE_DEAL_STAGES.has(offer?.deal?.stage)) continue;
    if (GONE_DEAL_STAGES.has(offer.deal.stage)) { deals.push({ offer, room: null, settings }); continue; }
    let room = null;
    try {
      const rooms = await store.listDatarooms(locationId, { offerId: offer.id, limit: 5 });
      room = rooms.find((r) => r.status === "active" && r.kind !== "portfolio" && r.kind !== "offer") || null;
    } catch { /* rooms are decoration on the price; dealNumbers still answers */ }
    deals.push({ offer, room, settings });
  }
  let invites = [];
  try {
    if (store.listDataroomInvitesByContact) invites = await store.listDataroomInvitesByContact(locationId, contactId);
  } catch { /* the invite line is decoration */ }

  const { facts, events } = await loadRecord(store, locationId, contactId);
  return buildInvestorContext({
    investor, deals, invites, custom, contactId, tags, now, facts, events,
    blastPrefix: String(settings?.dispoBlastTagPrefix || "dispo"),
  });
}
