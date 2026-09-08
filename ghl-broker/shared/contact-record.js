// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// contact-record.js — the vocabulary and arithmetic of a person's record.
//
// The app is the system of record for every agent and investor: what they
// like and don't, their buy box, every deal and offer worked, why they said
// no. GoHighLevel's contact custom fields are a DIGEST rendered from this —
// they keep exactly the semantics they have today (so workflows, tags and
// filters keep working) but they are no longer where the truth lives. A
// 2,000-character ledger that drops its oldest lines cannot be a complete
// record; this can.
//
// Two shapes:
//
//   an EVENT   one thing that happened, typed, dated, with a dedupe key so a
//              replay (a backfill, a webhook that fired twice, a ledger line
//              and a direct record of the same action) is a no-op.
//   a FACT     one thing we know, with where we learned it and when. Facts
//              live as { key: [entries] } on the profile; the newest entry
//              is the current value for a scalar key, and the whole list is
//              the value for a list key.
//
// Everything here is pure. The I/O — writing to the store, projecting the
// digest into GHL — is ghl-broker/contact-record.js. Both the console and
// the broker import this file, so the drawer labels an event with the same
// words the broker recorded it under.

import { STATUS_HISTORY_PHRASE } from "./offer-status.js";
import { PROPERTY_TYPES } from "./buybox.js";
import { PASS_REASON_LABEL } from "./conversation-ai.js";

/* ---------- vocabulary ---------- */

export const EVENT_TYPES = [
  "offer_sent", "offer_revised", "offer_countered", "offer_passed", "offer_no_response", "offer_accepted",
  "realm_yes", "realm_no",
  "deal_promoted", "deal_stage",
  "investor_evaluating", "investor_committed", "investor_passed", "feedback",
  "blast_sent", "dataroom_sent", "dataroom_viewed",
  "call_summary", "text_summary", "note",
  "enrich_run", "tag_added", "tag_removed",
  "subject_property_set", "fact_learned", "fact_removed", "import",
];

export const EVENT_LABEL = {
  offer_sent: "we offered", offer_revised: "we revised our offer", offer_countered: "they countered",
  offer_passed: "they passed on our offer", offer_no_response: "no response to our offer", offer_accepted: "they accepted our offer",
  realm_yes: "number was in the realm", realm_no: "number was not in the realm",
  deal_promoted: "under contract", deal_stage: "deal stage changed",
  investor_evaluating: "evaluating the deal", investor_committed: "committed buyer", investor_passed: "passed on the deal",
  feedback: "feedback on the deal",
  blast_sent: "deal blasted to them", dataroom_sent: "dataroom link sent", dataroom_viewed: "opened the dataroom",
  call_summary: "call", text_summary: "text conversation", note: "note",
  enrich_run: "AI enrichment ran", tag_added: "tag added", tag_removed: "tag removed",
  subject_property_set: "subject property set", fact_learned: "learned about them", fact_removed: "fact removed",
  import: "imported",
};

// Lucide icon names — the drawer resolves them; the broker never needs to.
export const EVENT_ICON = {
  offer_sent: "Send", offer_revised: "RefreshCw", offer_countered: "ArrowLeftRight", offer_passed: "XCircle",
  offer_no_response: "Clock", offer_accepted: "CheckCircle2",
  realm_yes: "ThumbsUp", realm_no: "ThumbsDown",
  deal_promoted: "FileSignature", deal_stage: "Milestone",
  investor_evaluating: "Eye", investor_committed: "Handshake", investor_passed: "XCircle", feedback: "MessageSquareQuote",
  blast_sent: "Megaphone", dataroom_sent: "FolderOpen", dataroom_viewed: "Eye",
  call_summary: "Phone", text_summary: "MessageSquare", note: "StickyNote",
  enrich_run: "Sparkles", tag_added: "Tag", tag_removed: "Tag",
  subject_property_set: "Crosshair", fact_learned: "Lightbulb", fact_removed: "Eraser", import: "Download",
};

export const SOURCES = ["conversation", "call", "sweep", "operator", "import", "offer", "deal", "dataroom", "blast"];
export const SOURCE_LABEL = {
  conversation: "from a text", call: "from a call", sweep: "AI sweep", operator: "entered by hand",
  import: "imported", offer: "from an offer", deal: "from a deal", dataroom: "dataroom", blast: "blast",
};
// The sources the drawer colours violet: something the AI inferred rather
// than something a person stated or a record produced.
export const AI_SOURCES = new Set(["conversation", "call", "sweep"]);

// Keys map 1:1 to the GHL custom fields they project into, so the digest is
// a rendering, not a translation. `cap` is a COUNT of entries — the record
// never drops a fact for length; `ghlMax` is the character cap the digest
// keeps, unchanged from what mergeFacts always applied.
export const FACT_KEYS = {
  personal_details:      { kind: "list",   party: "both",     cap: 60, ghlMax: 1500, label: "About them" },
  agent_market_area:     { kind: "list",   party: "agent",    cap: 40, ghlMax: 600,  label: "Areas they work" },
  buybox_areas:          { kind: "list",   party: "investor", cap: 40, ghlMax: 600,  label: "Areas they buy" },
  buybox_exclusions:     { kind: "list",   party: "investor", cap: 40, ghlMax: 500,  label: "Must-haves / dealbreakers" },
  buybox_property_types: { kind: "list",   party: "investor", cap: 10, ghlMax: 200,  label: "Property types", values: PROPERTY_TYPES },
  buybox_price_min:      { kind: "scalar", party: "investor", cap: 20, number: true, label: "Price min" },
  buybox_price_max:      { kind: "scalar", party: "investor", cap: 20, number: true, label: "Price max" },
  buybox_lot_min:        { kind: "scalar", party: "investor", cap: 20, number: true, label: "Lot size min" },
  rehab_appetite:        { kind: "scalar", party: "investor", cap: 20, label: "Rehab appetite", values: ["cosmetic_only", "moderate", "heavy", "full_gut"] },
  subject_property:      { kind: "scalar", party: "agent",    cap: 20, label: "Subject property" },
  brokerage:             { kind: "scalar", party: "agent",    cap: 5,  label: "Brokerage" },
  suggested_next_action: { kind: "scalar", party: "both",     cap: 20, label: "Next action" },
  last_convo_summary:    { kind: "scalar", party: "both",     cap: 20, ghlMax: 500, label: "Last conversation" },
};
export const factKeysFor = (party) =>
  Object.keys(FACT_KEYS).filter((k) => FACT_KEYS[k].party === "both" || FACT_KEYS[k].party === party);

/* ---------- ledger lines: the same normalisation mergeHistory uses ---------- */

// These two are byte-for-byte the halves of mergeHistory's dedupe key in
// ghl-broker/enrich.js. They have to be: an event recorded live from a ledger
// line and the same line read back by a backfill must land on one key.
export const addressKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const eventKey = (s) => String(s || "").toLowerCase().split(/[—–-]/)[0].trim();

const dateOf = (iso) => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(iso || ""));
  return m ? m[1] : "";
};

/**
 * parseHistoryLine(line) → { date, address, event, note } | null
 *
 * The inverse of enrich.js historyLine: `YYYY-MM-DD | address | event — note`.
 * A note may itself contain dashes ("Price too high: no meat - at 498"), so
 * the split is on the FIRST em dash with spaces, which is what historyLine
 * writes; a stray hyphen in the event word is left alone. An undated line
 * (`????-??-??`) parses with an empty date.
 */
export function parseHistoryLine(line) {
  const parts = String(line || "").split("|").map((p) => p.trim());
  if (parts.length < 3) return null;
  const date = dateOf(parts[0]);
  const address = parts[1] || "";
  const rest = parts.slice(2).join(" | ");
  const dash = rest.indexOf(" — ");
  const event = (dash >= 0 ? rest.slice(0, dash) : rest).trim();
  const note = dash >= 0 ? rest.slice(dash + 3).trim() : "";
  if (!event) return null;
  return { date, address, event, note };
}

const STAGE_WORDS = { "under contract": "under_contract", "buyer found": "buyer_found", assigned: "assigned", closed: "closed", "fell through": "fell_through" };
const PHRASE_TO_STATUS = Object.fromEntries(Object.entries(STATUS_HISTORY_PHRASE).map(([k, v]) => [v, k]));

/**
 * ledgerEventType(eventPhrase, party) → { type, data }
 *
 * What kind of event a ledger phrase was. The phrases are the ones the
 * broker writes today (routes/offers.js, the twelve appendDealHistory
 * sites); anything it doesn't recognise is kept as a `note` so nothing is
 * lost, only untyped.
 */
export function ledgerEventType(eventPhrase, party = "agent") {
  const p = String(eventPhrase || "").trim();
  const low = p.toLowerCase();
  const money = /\$[\d,]+(?:\.\d+)?/.exec(p)?.[0] || "";
  if (/^we offered\b/.test(low)) return { type: "offer_sent", data: money ? { amountText: money } : {} };
  if (/^we revised our offer\b/.test(low)) return { type: "offer_revised", data: money ? { amountText: money } : {} };
  if (PHRASE_TO_STATUS[low]) return { type: `offer_${PHRASE_TO_STATUS[low]}`, data: {} };
  if (low === "number in the realm") return { type: "realm_yes", data: {} };
  if (low === "number not in the realm") return { type: "realm_no", data: {} };
  if (party === "investor") {
    if (low === "evaluating" || low === "sent") return { type: "investor_evaluating", data: {} };
    if (low === "committed") return { type: "investor_committed", data: {} };
    if (low === "passed") return { type: "investor_passed", data: {} };
    if (low === "feedback") return { type: "feedback", data: {} };
  }
  if (low === "under contract") return { type: "deal_promoted", data: { stage: "under_contract" } };
  if (STAGE_WORDS[low]) return { type: "deal_stage", data: { stage: STAGE_WORDS[low] } };
  return { type: "note", data: {} };
}

// The phrase an event renders to in a ledger. Where the event came from a
// ledger line (or from appendDealHistory, which has the line) the original
// phrase is kept in data.phrase so the round trip is exact; otherwise the
// type's canonical phrase is used — the same words the broker writes.
export function eventPhrase(ev) {
  const d = ev?.data || {};
  if (d.phrase) return d.phrase;
  switch (ev?.type) {
    case "offer_sent": return d.amountText ? `we offered ${d.amountText}` : STATUS_HISTORY_PHRASE.sent;
    case "offer_revised": return d.amountText ? `we revised our offer to ${d.amountText}` : "we revised our offer";
    case "offer_countered": return STATUS_HISTORY_PHRASE.countered;
    case "offer_passed": return STATUS_HISTORY_PHRASE.passed;
    case "offer_no_response": return STATUS_HISTORY_PHRASE.no_response;
    case "offer_accepted": return STATUS_HISTORY_PHRASE.accepted;
    case "realm_yes": return "number in the realm";
    case "realm_no": return "number not in the realm";
    case "deal_promoted": return "under contract";
    case "deal_stage": return String(d.stage || "").replace(/_/g, " ");
    case "investor_evaluating": return "evaluating";
    case "investor_committed": return "committed";
    case "investor_passed": return "passed";
    case "feedback": return "feedback";
    default: return EVENT_LABEL[ev?.type] || String(ev?.type || "");
  }
}

// Which events belong in the *_deal_history digest. Everything else is real
// but was never a ledger line — a tag, a dataroom view, a fact — and putting
// it there would change what GHL shows.
const LEDGER_TYPES = new Set([
  "offer_sent", "offer_revised", "offer_countered", "offer_passed", "offer_no_response", "offer_accepted",
  "realm_yes", "realm_no", "deal_promoted", "deal_stage",
  "investor_evaluating", "investor_committed", "investor_passed", "feedback",
]);
export function ledgerEvents(events = [], party = null) {
  return events.filter((e) => LEDGER_TYPES.has(e?.type) && (!party || !e.party || e.party === party) && (e.data?.phrase || e.address));
}

export function eventToHistoryLine(ev) {
  const date = ev?.data?.undated ? "????-??-??" : (dateOf(ev?.at) || "????-??-??");
  const note = String(ev?.data?.note || "").trim();
  return `${date} | ${String(ev?.address || "unknown property").trim()} | ${eventPhrase(ev)}${note ? ` — ${note}` : ""}`;
}

/**
 * eventDedupeKey(ev) → string | null
 *
 * One scheme for live writes and backfill, so they converge on the same row.
 * Address-bearing events key on the day, the address and the phrase — the
 * same two halves mergeHistory dedupes on, plus the date, because "we
 * offered" on two different days is two events even though the digest would
 * show one. Ref-bearing events key on the ref. A manual note has no key:
 * each one is real.
 */
export function eventDedupeKey(ev) {
  const t = ev?.type;
  const d = ev?.data || {};
  const day = dateOf(ev?.at);
  if (t === "note") return null;
  if (LEDGER_TYPES.has(t) && ev.address) return `ev:${day}:${addressKey(ev.address)}:${eventKey(eventPhrase(ev))}`;
  if (t === "text_summary" || t === "call_summary") return ev.ref ? `${t}:${ev.ref}` : null;
  if (t === "dataroom_sent") return ev.ref ? `dataroom_sent:${ev.ref}` : null;
  if (t === "dataroom_viewed") return ev.ref ? `dataroom_viewed:${ev.ref}:${Number(d.viewCount) || 1}` : null;
  if (t === "blast_sent") return `blast_sent:${addressKey(ev.address || d.tag || "")}:${day}`;
  if (t === "enrich_run") return ev.ref ? `enrich_run:${ev.ref}` : null;
  if (t === "tag_added" || t === "tag_removed") return d.tag ? `${t}:${String(d.tag).toLowerCase()}:${day}` : null;
  if (t === "subject_property_set") return ev.address ? `subject_property_set:${addressKey(ev.address)}:${day}` : null;
  if (t === "fact_learned" || t === "fact_removed") return d.key ? `${t}:${d.key}:${String(d.value || "").toLowerCase().trim()}` : null;
  if (t === "import") return ev.ref ? `import:${ev.ref}` : null;
  return ev.ref ? `${t}:${ev.ref}` : null;
}

export function eventFromLedgerLine(line, { party = "agent", source = "import", ref = null, at = null } = {}) {
  const p = parseHistoryLine(line);
  if (!p) return null;
  const { type, data } = ledgerEventType(p.event, party);
  const ev = {
    party, type, source, ref,
    at: p.date ? `${p.date}T12:00:00.000Z` : (at || new Date().toISOString()),
    address: p.address === "unknown property" ? "" : p.address,
    // An undated line gets a timestamp so it can be ordered, but stays
    // undated on the way back out — inventing a date would be lying.
    data: { ...data, phrase: p.event, ...(p.note ? { note: p.note } : {}), ...(p.date ? {} : { undated: true }) },
  };
  ev.dedupeKey = eventDedupeKey({ ...ev, address: p.address });
  if (!ev.address) ev.address = p.address; // keep "unknown property" so the round trip is exact
  return ev;
}

/**
 * renderLedger(events, { maxChars }) → string
 *
 * The digest, rendered the way mergeHistory would merge these same lines
 * into an empty field: chronological by date, one line per address+event
 * (first wins), oldest dropped when over budget. Byte-identical to
 * mergeHistory("", lines) — the broker's test asserts it.
 */
export function renderLedger(events = [], { maxChars = 2000 } = {}) {
  const lines = [...events].sort((a, b) => String(a.at || "").localeCompare(String(b.at || ""))).map(eventToHistoryLine);
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const parts = line.split("|").map((p) => p.trim());
    const k = `${addressKey(parts[1] || parts[0])}|${eventKey(parts[2] || "")}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(line);
  }
  out.sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
  while (out.length > 1 && out.join("\n").length > maxChars) out.shift();
  return out.join("\n").slice(0, maxChars);
}

/* ---------- facts ---------- */

const norm = (v) => String(v == null ? "" : v).trim();
const lower = (v) => norm(v).toLowerCase();
const REMOVED_CAP = 100;

function coerceValue(key, value) {
  const def = FACT_KEYS[key];
  if (!def) return "";
  let v = norm(value);
  if (!v) return "";
  if (def.number) {
    const n = Number(v.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) && n > 0 ? String(Math.round(n)) : "";
  }
  if (def.values) {
    v = v.toLowerCase().replace(/[\s-]+/g, "_");
    return def.values.includes(v) ? v : "";
  }
  return v.slice(0, key === "last_convo_summary" ? 500 : 300);
}

/**
 * addFact(facts, key, { value, source, at, ref }) → { facts, added }
 *
 * Pure: returns a new facts doc. A list key unions (case-insensitive) and
 * drops its oldest past the count cap; a scalar key appends only when the
 * value differs from the newest, so its history is the sequence of changes.
 * A value the operator removed stays removed: reconcile and backfill can't
 * bring it back, because the tombstone in `_removed` is consulted first.
 */
export function addFact(facts, key, { value, source = "operator", at = new Date().toISOString(), ref = null } = {}) {
  const def = FACT_KEYS[key];
  const v = coerceValue(key, value);
  const base = facts && typeof facts === "object" ? facts : {};
  if (!def || !v) return { facts: base, added: false };
  const removed = new Set((base._removed?.[key] || []).map(lower));
  if (removed.has(lower(v))) return { facts: base, added: false };
  const list = Array.isArray(base[key]) ? base[key] : [];
  if (def.kind === "list") {
    if (list.some((e) => lower(e.value) === lower(v))) return { facts: base, added: false };
  } else if (list.length && lower(list[list.length - 1].value) === lower(v)) {
    return { facts: base, added: false };
  }
  const next = [...list, { value: v, source, at, ref }];
  while (next.length > def.cap) next.shift();
  return { facts: { ...base, [key]: next }, added: true };
}

export function removeFact(facts, key, value) {
  const base = facts && typeof facts === "object" ? facts : {};
  const v = lower(value);
  if (!FACT_KEYS[key] || !v) return { facts: base, removed: false };
  const list = Array.isArray(base[key]) ? base[key] : [];
  const kept = list.filter((e) => lower(e.value) !== v);
  const tomb = [...new Set([...(base._removed?.[key] || []).map(lower), v])].slice(-REMOVED_CAP);
  return {
    facts: { ...base, [key]: kept, _removed: { ...(base._removed || {}), [key]: tomb } },
    removed: kept.length !== list.length,
  };
}

// { key: string[] } for list keys, { key: string } for scalar keys — what the
// contact is understood to be right now.
export function currentFacts(facts) {
  const out = {};
  for (const [key, def] of Object.entries(FACT_KEYS)) {
    const list = Array.isArray(facts?.[key]) ? facts[key] : [];
    if (!list.length) continue;
    out[key] = def.kind === "list" ? list.map((e) => e.value) : list[list.length - 1].value;
  }
  return out;
}
export const factsEmpty = (facts) => Object.keys(currentFacts(facts)).length === 0;

// The value the GHL field would carry: a list joined the way mergeFacts
// joins, a scalar as is.
export function renderFactField(facts, key) {
  const cur = currentFacts(facts)[key];
  if (cur == null) return "";
  return Array.isArray(cur) ? cur.join(", ") : String(cur);
}
// A custom-field record shaped view of the facts — what normalizeBuybox and
// the prompt's field renderers already read.
export function factsAsCustom(facts) {
  const out = {};
  for (const key of Object.keys(FACT_KEYS)) {
    const v = renderFactField(facts, key);
    if (v) out[key] = v;
  }
  return out;
}

/**
 * factsFromCustom(custom, party, { source, at, ref }) → [{ key, value, source, at, ref }]
 *
 * A GHL contact's fields, read back as facts. List fields split on the same
 * separators mergeFacts joins on, so a field this code wrote yields the same
 * entries it was written from.
 */
export function factsFromCustom(custom = {}, party = "agent", { source = "import", at = new Date().toISOString(), ref = null } = {}) {
  const out = [];
  for (const key of factKeysFor(party)) {
    const raw = custom?.[key];
    if (raw == null || norm(raw) === "") continue;
    const def = FACT_KEYS[key];
    const values = def.kind === "list" ? String(raw).split(/[,;\n]/).map((x) => x.trim()).filter(Boolean) : [norm(raw)];
    for (const value of values) {
      if (coerceValue(key, value)) out.push({ key, value, source, at, ref });
    }
  }
  return out;
}

/* ---------- events derived from app records (the backfill's app pass) ---------- */

const money = (n) => {
  const v = Math.round(Number(n) || 0);
  return v > 0 ? `$${v.toLocaleString("en-US")}` : "";
};
const feedbackPhrase = (said) =>
  (said?.note ? `${PASS_REASON_LABEL[said.code] || said.code}: ${said.note}` : PASS_REASON_LABEL[said?.code] || "").slice(0, 200);
const withKey = (ev) => ({ ...ev, dedupeKey: eventDedupeKey(ev) });

/**
 * offerEvents(offer) → events for the agent AND every investor on its deal
 *
 * Reproduces exactly the lines the broker's twelve appendDealHistory sites
 * write for the same records, so an event derived here from an offer and
 * one recorded live as that offer moved land on the same dedupe key.
 */
export function offerEvents(offer) {
  if (!offer?.id) return [];
  const out = [];
  const address = offer.address || "";
  const agent = offer.contactId || "";
  const base = { offerId: offer.id, address, source: "offer", ref: offer.id };
  const push = (contactId, party, ev) => { if (contactId) out.push(withKey({ contactId, party, ...base, ...ev })); };

  // The number we sent, and every revision of it.
  const firstAmount = offer.revisions?.length ? offer.revisions[0].from : offer.cashAmount;
  if (offer.createdAt && money(firstAmount)) {
    push(agent, "agent", { type: "offer_sent", at: offer.createdAt, data: { amountText: money(firstAmount), amount: Math.round(Number(firstAmount)) } });
  }
  for (const r of offer.revisions || []) {
    if (r?.ts && money(r.to)) push(agent, "agent", { type: "offer_revised", at: r.ts, data: { amountText: money(r.to), amount: Math.round(Number(r.to)), from: Math.round(Number(r.from) || 0) } });
  }
  // What the agent said about it.
  for (const h of offer.statusHistory || []) {
    if (!h?.status || !h.ts || !STATUS_HISTORY_PHRASE[h.status]) continue;
    push(agent, "agent", { type: `offer_${h.status}`, at: h.ts, data: h.note ? { note: String(h.note).slice(0, 200) } : {} });
  }
  if (offer.realm?.ts) {
    push(agent, "agent", { type: offer.realm.answer === "yes" ? "realm_yes" : "realm_no", at: offer.realm.ts, data: offer.realm.note ? { note: String(offer.realm.note).slice(0, 120) } : {} });
  }
  const deal = offer.deal;
  if (!deal) return out;
  const dealBase = { dealId: offer.id, source: "deal" };
  // Its life as a deal.
  const stages = deal.stageHistory?.length ? deal.stageHistory : [{ stage: deal.stage, ts: deal.createdAt }];
  stages.forEach((s, i) => {
    if (!s?.stage || !s.ts) return;
    if (i === 0 || s.stage === "under_contract") push(agent, "agent", { ...dealBase, type: "deal_promoted", at: s.ts, data: { stage: "under_contract" } });
    else push(agent, "agent", { ...dealBase, type: "deal_stage", at: s.ts, data: { stage: s.stage, ...(s.stage === "fell_through" && deal.fellThroughReason ? { note: deal.fellThroughReason } : {}) } });
  });
  // Every buyer's standing on it.
  for (const inv of deal.investors || []) {
    if (!inv?.contactId) continue;
    const status = inv.status === "sent" ? "evaluating" : inv.status;
    const when = inv.updatedAt || inv.addedAt || deal.updatedAt;
    if (inv.addedAt && status !== "evaluating") {
      push(inv.contactId, "investor", { ...dealBase, type: "investor_evaluating", at: inv.addedAt, data: {} });
    }
    if (["evaluating", "committed", "passed"].includes(status) && when) {
      const note = status === "passed" && inv.reason ? feedbackPhrase(inv.reason) : "";
      push(inv.contactId, "investor", { ...dealBase, type: `investor_${status}`, at: when, data: { ...(note ? { note } : {}), ...(inv.reason?.code ? { code: inv.reason.code, reasonNote: inv.reason.note || "" } : {}) } });
    }
  }
  for (const f of deal.feedback || []) {
    if (!f?.contactId || !f.ts) continue;
    push(f.contactId, "investor", { ...dealBase, type: "feedback", at: f.ts, data: { note: feedbackPhrase(f), code: f.code, reasonNote: f.note || "" } });
  }
  return out;
}

// What a reply draft tells us happened: the conversation itself, and the
// lines the model filed while drafting.
export function draftEvents(draft) {
  if (!draft?.id || !draft.contactId) return [];
  const out = [];
  const party = draft.party === "investor" ? "investor" : draft.party === "agent" ? "agent" : null;
  const base = { contactId: draft.contactId, party, source: "conversation", ref: draft.id };
  if (draft.summary) {
    out.push(withKey({ ...base, type: "text_summary", at: draft.createdAt || draft.updatedAt, address: draft.propertyAddress || "",
      data: { summary: String(draft.summary).slice(0, 500), intent: draft.intent || "", inbound: String(draft.inbound || "").slice(0, 300) } }));
  }
  for (const line of draft.profileUpdates?.learned || []) {
    const m = /^history:\s*(.+)$/.exec(String(line));
    if (m && party) {
      const ev = eventFromLedgerLine(/^\d{4}-\d{2}-\d{2}/.test(m[1]) ? m[1] : `${dateOf(draft.createdAt)} | ${m[1]}`, { party, source: "conversation", ref: draft.id });
      if (ev) out.push({ ...ev, contactId: draft.contactId });
    }
    const s = /^subject property:\s*(.+)$/.exec(String(line));
    if (s) out.push(withKey({ ...base, type: "subject_property_set", at: draft.createdAt, address: s[1].trim(), data: {} }));
  }
  return out;
}
// The facts a draft learned, in the words the row showed.
export function draftFacts(draft) {
  if (!draft?.id) return [];
  const at = draft.createdAt || new Date().toISOString();
  const out = [];
  const areasKey = draft.party === "investor" ? "buybox_areas" : "agent_market_area";
  for (const line of draft.profileUpdates?.learned || []) {
    // These two carry their value in the head: "buys up to $400,000".
    const band = /^buys (from|up to)\s+(.+)$/.exec(String(line).trim());
    if (band) { out.push({ key: band[1] === "from" ? "buybox_price_min" : "buybox_price_max", value: band[2], source: "conversation", at, ref: draft.id }); continue; }
    const [head, ...rest] = String(line).split(":");
    const body = rest.join(":").trim();
    if (!body) continue;
    const list = (key) => body.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean).forEach((value) => out.push({ key, value, source: "conversation", at, ref: draft.id }));
    switch (head.trim()) {
      case "personal": list("personal_details"); break;
      case "areas": list(areasKey); break;
      case "types": list("buybox_property_types"); break;
      case "must-haves": list("buybox_exclusions"); break;
      case "rehab": out.push({ key: "rehab_appetite", value: body.replace(/\s+/g, "_"), source: "conversation", at, ref: draft.id }); break;
      case "subject property": out.push({ key: "subject_property", value: body, source: "conversation", at, ref: draft.id }); break;
      default: break;
    }
  }
  return out;
}

export function inviteEvents(invite, { address = "" } = {}) {
  if (!invite?.id || !invite.contactId) return [];
  const out = [];
  const base = { contactId: invite.contactId, party: "investor", source: "dataroom", ref: invite.id, address, offerId: invite.offerId || null };
  const sent = invite.sentAt || invite.createdAt;
  if (sent) out.push(withKey({ ...base, type: "dataroom_sent", at: sent, data: {} }));
  if (invite.firstViewedAt) out.push(withKey({ ...base, type: "dataroom_viewed", at: invite.firstViewedAt, data: { viewCount: 1 } }));
  if (invite.lastViewedAt && Number(invite.viewCount) > 1 && invite.lastViewedAt !== invite.firstViewedAt) {
    out.push(withKey({ ...base, type: "dataroom_viewed", at: invite.lastViewedAt, data: { viewCount: Number(invite.viewCount) } }));
  }
  return out;
}

/* ---------- drawer helpers ---------- */

export function groupByDay(events = [], timeZone = "America/Los_Angeles") {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const groups = new Map();
  for (const ev of events) {
    let day = "";
    try { day = fmt.format(new Date(ev.at)); } catch { day = dateOf(ev.at) || "unknown"; }
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(ev);
  }
  return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([day, list]) => ({ day, events: list }));
}
