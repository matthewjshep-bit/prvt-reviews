// investor-read.js — what an investor has told us about how they buy, in
// their own words, and the buy box read from those words. Pure.
//
// Matt, 2026-11-02: "all that information is kind of locked up in all the
// investor conversations, both the text and the call transcripts." Of 2,786
// buyers in the book, 619 had written back or talked on the phone and 155 had
// a buy box on file. A read keeps two things side by side:
//
//   - **their words**: the sentences where they said what, where and how they
//     buy, word for word, dated, with the channel (text, email, call). Every
//     quote is checked against the thread before it is kept (`verifyQuotes`):
//     a quote that isn't in their own messages, or only in ours, is dropped.
//   - **the columns** read from those words (`READ_FIELDS`): areas, kinds of
//     house, strategy, price, rehab, how they pay, size, dealbreakers, how
//     they run numbers, volume, whether they're buying now, who they are.
//
// A read is evidence, not the buy box the matcher uses. The contact record's
// facts (shared/contact-record.js) stay the one buy box deals go out on;
// `readFacts` is what "Add to buy box" files from a read, on a person's press.

import { PROPERTY_TYPES, REHAB_APPETITES, PROPERTY_TYPE_LABELS, REHAB_APPETITE_LABELS } from "./buybox.js";

export const STRATEGIES = ["flip", "rental", "brrrr", "new_construction", "adu_dadu", "land_development", "short_term_rental", "wholesale", "owner_occupant"];
export const STRATEGY_LABELS = {
  flip: "Flip", rental: "Rental / hold", brrrr: "BRRRR", new_construction: "New construction",
  adu_dadu: "ADU / DADU", land_development: "Land / subdivide", short_term_rental: "Short-term rental",
  wholesale: "Wholesale", owner_occupant: "Owner-occupant",
};
export const FUNDING = ["cash", "hard_money", "private_money", "conventional", "dscr", "partners"];
export const FUNDING_LABELS = {
  cash: "Cash", hard_money: "Hard money", private_money: "Private money", conventional: "Conventional",
  dscr: "DSCR", partners: "Partners / JV",
};
export const BUYING_STATUS = ["active", "slow", "paused", "not_buying"];
export const BUYING_STATUS_LABELS = { active: "Buying", slow: "Picky / slow", paused: "Paused", not_buying: "Not buying" };
export const ROLES = ["investor", "builder", "wholesaler", "agent_investor", "lender", "property_manager", "other"];
export const ROLE_LABELS = {
  investor: "Investor", builder: "Builder", wholesaler: "Wholesaler", agent_investor: "Agent who invests",
  lender: "Lender", property_manager: "Property manager", other: "Other",
};
export const DEALS_BY = ["text", "email", "call"];
export const CHANNELS = ["sms", "email", "call", "voicemail", "chat"];

// The columns. `fact` is the contact-record key "Add to buy box" files the
// value under; a column without one is read-only evidence.
export const READ_FIELDS = {
  areas:          { kind: "list",   label: "Areas they buy", fact: "buybox_areas", hint: "Cities, ZIPs, neighborhoods or regions they said they buy in" },
  areas_avoid:    { kind: "list",   label: "Areas they won't buy", hint: "Places they said no to" },
  property_types: { kind: "list",   label: "Kinds of house", values: PROPERTY_TYPES, labels: PROPERTY_TYPE_LABELS, fact: "buybox_property_types" },
  strategies:     { kind: "list",   label: "Strategy", values: STRATEGIES, labels: STRATEGY_LABELS },
  price_min:      { kind: "number", label: "Price min", fact: "buybox_price_min", money: true },
  price_max:      { kind: "number", label: "Price max", fact: "buybox_price_max", money: true },
  rehab:          { kind: "enum",   label: "Rehab", values: REHAB_APPETITES, labels: REHAB_APPETITE_LABELS, fact: "rehab_appetite" },
  // One fact, the first way they named (buyer_funding is a scalar).
  funding:        { kind: "list",   label: "How they pay", values: FUNDING, labels: FUNDING_LABELS, fact: "buyer_funding", factFirst: true },
  beds_min:       { kind: "number", label: "Beds min" },
  baths_min:      { kind: "number", label: "Baths min" },
  sqft_min:       { kind: "number", label: "Sq ft min" },
  lot_min:        { kind: "number", label: "Lot min (sq ft)", fact: "buybox_lot_min" },
  must_haves:     { kind: "list",   label: "Must-haves", fact: "buybox_exclusions" },
  dealbreakers:   { kind: "list",   label: "Dealbreakers", fact: "buybox_exclusions" },
  numbers:        { kind: "list",   label: "How they run numbers", hint: "e.g. 70% of ARV less repairs, a minimum profit, a cap rate" },
  volume:         { kind: "text",   label: "Volume", hint: "How many they do, or can take on" },
  status:         { kind: "enum",   label: "Buying now?", values: BUYING_STATUS, labels: BUYING_STATUS_LABELS },
  timing:         { kind: "text",   label: "Timing", hint: "When they're back, what they're waiting on" },
  role:           { kind: "enum",   label: "Who they are", values: ROLES, labels: ROLE_LABELS },
  company:        { kind: "text",   label: "Company" },
  deals_by:       { kind: "enum",   label: "Send deals by", values: DEALS_BY },
  close_speed:    { kind: "text",   label: "How fast they close" },
  notes:          { kind: "list",   label: "Worth knowing" },
};
export const READ_FIELD_KEYS = Object.keys(READ_FIELDS);

export const MAX_QUOTES = 30;
export const MAX_QUOTE_CHARS = 500;
const MAX_LIST = 20;
const MAX_TEXT = 200;
const OUR_TEXT_CHARS = 320;

const norm = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
const low = (v) => norm(v).toLowerCase();
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const asList = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
const enumKey = (v) => low(v).replace(/[\s/-]+/g, "_");
const ALIASES = {
  single_family: "sfr", sfh: "sfr", house: "sfr", mobile: "manufactured", mobile_home: "manufactured", townhome: "townhouse",
  multifamily: "multi_family", duplex: "multi_family", fix_and_flip: "flip", buy_and_hold: "rental", hold: "rental",
  adu: "adu_dadu", dadu: "adu_dadu", str: "short_term_rental", airbnb: "short_term_rental", hard: "hard_money",
  private: "private_money", loan: "conventional", jv: "partners", cosmetic: "cosmetic_only", light: "cosmetic_only",
  medium: "moderate", gut: "full_gut", full: "full_gut", realtor: "agent_investor", agent: "agent_investor",
  developer: "builder", paused_for_now: "paused", inactive: "not_buying", sms: "text", phone: "call",
};
const vocab = (v, values) => {
  const k = enumKey(v);
  if (values.includes(k)) return k;
  const a = ALIASES[k];
  return a && values.includes(a) ? a : "";
};

// "350k", "$1.2M", 350000 → 350000. Prices under 5,000 were said in
// thousands ("up to 400").
export function toNumber(v, { money = false, lot = false } = {}) {
  if (v == null || v === "") return null;
  let s = String(v).toLowerCase().replace(/[$,\s]/g, "");
  let mult = 1;
  if (/m$/.test(s)) { mult = 1e6; s = s.slice(0, -1); }
  else if (/k$/.test(s)) { mult = 1e3; s = s.slice(0, -1); }
  else if (/acres?$/.test(s)) { mult = 43560; s = s.replace(/acres?$/, ""); }
  let n = Number(s) * mult;
  if (!Number.isFinite(n) || n <= 0) return null;
  if (money && n < 5000) n *= 1000;
  if (lot && n < 50) n *= 43560; // acres given as a bare number
  return Math.round(n);
}

function coerceField(key, value) {
  const def = READ_FIELDS[key];
  if (!def) return undefined;
  if (def.kind === "number") return toNumber(value, { money: def.money, lot: key === "lot_min" });
  if (def.kind === "enum") return value == null ? null : vocab(value, def.values) || null;
  if (def.kind === "text") { const t = norm(value).slice(0, MAX_TEXT); return t || null; }
  const seen = new Set();
  const out = [];
  for (const raw of asList(value)) {
    const v = def.values ? vocab(raw, def.values) : norm(raw).slice(0, 120);
    if (!v || seen.has(low(v))) continue;
    seen.add(low(v));
    out.push(v);
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

export function normalizeFields(raw = {}) {
  const src = isObj(raw) ? raw : {};
  const out = {};
  for (const key of READ_FIELD_KEYS) out[key] = coerceField(key, src[key]);
  // A band said backwards is still the band.
  if (out.price_min && out.price_max && out.price_min > out.price_max) [out.price_min, out.price_max] = [out.price_max, out.price_min];
  return out;
}

export function fieldsEmpty(fields = {}) {
  return READ_FIELD_KEYS.every((k) => {
    const v = fields?.[k];
    return v == null || v === "" || (Array.isArray(v) && !v.length);
  });
}

/* ---------- the thread, as the model reads it ---------- */

const day = (iso) => String(iso || "").slice(0, 10);
const secsLabel = (s) => (Number.isFinite(s) && s > 0 ? ` ${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s` : "");

/**
 * threadForModel(thread) → { text, refs }
 *
 * Every message gets a ref (m1, m2, …) the model cites a quote by. Their
 * words go in whole; ours are cut to a line of context, because the read is
 * about them. A call is its transcript, speaker by speaker — GHL's speaker
 * numbers don't say which side is which, so the model reads it from context.
 */
export function threadForModel(thread = {}) {
  const lines = [];
  const refs = {};
  let n = 0;
  for (const m of thread.messages || []) {
    const isCall = m.channel === "call" || m.channel === "voicemail";
    if (isCall && !(m.turns && m.turns.length)) continue;
    const ref = `m${++n}`;
    refs[ref] = m;
    if (isCall) {
      lines.push(`${ref} ${day(m.at)} ${m.channel}${secsLabel(m.secs)} (${m.dir === "them" ? "they called" : "we called"}) TRANSCRIPT:`);
      for (const t of m.turns) lines.push(`  Speaker ${t.speaker}: ${norm(t.text)}`);
      continue;
    }
    const who = m.dir === "them" ? "THEM" : "US";
    let body = norm(m.body);
    if (m.dir !== "them" && body.length > OUR_TEXT_CHARS) body = `${body.slice(0, OUR_TEXT_CHARS)}…`;
    lines.push(`${ref} ${day(m.at)} ${who} ${m.channel}: ${body}`);
  }
  return { text: lines.join("\n"), refs };
}

// Something they said in words, or a call with a transcript. A thread of only
// our texts, reactions and missed calls has nothing to read.
export function hasTheirWords(thread = {}) {
  return (thread.messages || []).some((m) =>
    (m.dir === "them" && m.channel !== "call" && m.channel !== "voicemail" && norm(m.body).length >= 2 && !isReaction(m.body))
    || ((m.channel === "call" || m.channel === "voicemail") && (m.turns || []).length));
}
const isReaction = (b) => /^\s*(liked|loved|laughed at|emphasized|disliked|questioned)\s*[“"']/i.test(String(b || ""));

/* ---------- the model's instructions and answer shape ---------- */

export const READ_SYSTEM = `You read the whole message history between a real-estate wholesaler (US — Matt, Shep Flips, Seattle area) and one investor (THEM), and record what THEY said about how they buy property.

Two outputs, both only from what THEY said or plainly confirmed:

1. quotes — the investor's own sentences about what they buy, where, how, how much, how fast, what they won't touch, how they pay, how they run numbers, when they're buying, who they are. Copy each quote WORD FOR WORD from one message (cite its ref, e.g. "m12"). You may cut a long message down to the sentence or two that matter; never paraphrase, fix spelling or join two messages. For a call, quote the investor's side only (the speaker numbers are not fixed — read who is who from context; US is the one pitching a deal or asking what they buy). Skip greetings, scheduling, "thanks", "not interested" with no reason, and reactions. Tag each quote with the columns it supports (about). Up to 30 quotes, the most informative first; none at all is a valid answer.

2. fields — the columns, filled ONLY where a quote or their plain yes to our question supports it. Leave a column empty (null, or [] for a list) when they never said it. Never infer an area from a house we pitched them; their interest in one deal is not a buy box. A pass on our deal with a reason ("too far", "too much rehab", "no septic") does count: record the reason as a dealbreaker or an area they won't buy, only if it reads as a rule for them, not a one-off.
- areas: places they said they buy (city, ZIP, neighborhood, county or region as they said it: "Tacoma", "South King", "98118"). areas_avoid: places they said no to.
- property_types: sfr, townhouse, condo, multi_family, land, manufactured.
- strategies: flip, rental, brrrr, new_construction, adu_dadu, land_development, short_term_rental, wholesale, owner_occupant.
- price_min / price_max: purchase price in dollars (350000, not "350k"). Only a price they said they'd PAY or buy UP TO, not an ARV.
- rehab: the heaviest work they'll take on: cosmetic_only, moderate, heavy, full_gut.
- funding: cash, hard_money, private_money, conventional, dscr, partners.
- beds_min, baths_min, sqft_min, lot_min (square feet; 1 acre = 43560).
- must_haves and dealbreakers: short phrases in plain words ("garage", "no busy roads", "no septic", "no islands").
- numbers: how they price a deal, in their terms ("70% of ARV minus repairs", "need 50k profit", "8 cap").
- volume: how many they do or can take ("3-4 flips a year", "maxed out on 2 projects"). status: active, slow, paused, not_buying — only from what they said. timing: when they're back or what they're waiting on, with the date they said it if it matters.
- role: investor, builder, wholesaler, agent_investor, lender, property_manager, other. company: a business name they gave.
- deals_by: text, email or call, only when they asked for it. close_speed: as they said it ("close in 10 days").
- notes: anything else a dispositions person must know about buying from or selling to them (short phrases).
- summary: one or two plain sentences, in our words, of what they buy and where. Empty string when they never said.

Write nothing about a person's private life. No phone numbers or emails in any field.`;

const nullable = (t) => ({ anyOf: [t, { type: "null" }] });
const strList = { type: "array", items: { type: "string" } };
const enumList = (values) => ({ type: "array", items: { type: "string", enum: values } });
export const READ_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "fields", "quotes"],
  properties: {
    summary: { type: "string" },
    fields: {
      type: "object",
      additionalProperties: false,
      required: READ_FIELD_KEYS,
      properties: Object.fromEntries(READ_FIELD_KEYS.map((k) => {
        const d = READ_FIELDS[k];
        if (d.kind === "number") return [k, nullable({ type: "integer" })];
        if (d.kind === "enum") return [k, nullable({ type: "string", enum: d.values })];
        if (d.kind === "text") return [k, nullable({ type: "string" })];
        return [k, d.values ? enumList(d.values) : strList];
      })),
    },
    quotes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref", "text", "about"],
        properties: {
          ref: { type: "string" },
          text: { type: "string" },
          about: enumList(READ_FIELD_KEYS),
        },
      },
    },
  },
};

export function readPrompt(thread, { name = "" } = {}) {
  const { text } = threadForModel(thread);
  const first = String(name || "").trim().split(/\s+/)[0] || "the investor";
  return `INVESTOR: ${first}\nHISTORY (oldest first; US = Matt / Shep Flips, THEM = ${first}):\n\n${text}\n\nRecord what ${first} said about how they buy.`;
}

/* ---------- quotes, checked against the thread ---------- */

// Quote matching forgives what copying does to text and nothing else:
// curly quotes, dashes, spacing, case, a trailing full stop, an ellipsis
// where the model cut words out of the middle.
const canon = (s) => String(s || "")
  .replace(/[‘’‛′]/g, "'").replace(/[“”″]/g, '"')
  .replace(/[–—]/g, "-").replace(/…/g, "...")
  .toLowerCase().replace(/\s+/g, " ").trim();
const pieces = (q) => canon(q).replace(/^["'\s]+|["'\s.,!?]+$/g, "").split(/\s*\.\.\.\s*|\s*\[[^\]]*\]\s*/).map((p) => p.trim()).filter((p) => p.length >= 3);
function foundIn(haystack, parts) {
  const h = canon(haystack);
  let from = 0;
  for (const p of parts) {
    const i = h.indexOf(p, from);
    if (i < 0) return false;
    from = i + p.length;
  }
  return parts.length > 0;
}
// A quote can carry a phone number or an email ("send deals to my husband at
// …"). Kept quotes show and export, so those are masked after the match.
const PHONE_RX = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const EMAIL_RX = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/gi;
export const maskContact = (t) => String(t || "").replace(EMAIL_RX, "[email]").replace(PHONE_RX, "[phone]");
// One sentence, however it was punctuated or spaced.
const quoteKey = (t) => pieces(t).join(" ");

const theirText = (m) => (m.channel === "call" || m.channel === "voicemail" ? (m.turns || []).map((t) => t.text).join(" ") : m.dir === "them" ? m.body : "");

/**
 * verifyQuotes(rawQuotes, thread) → { quotes, dropped }
 *
 * Each quote is looked for in the message it cites, then in every message of
 * theirs. Kept only when found in their words (a text, an email of theirs, or
 * a call transcript); a quote found only in our own texts is ours, not
 * theirs. The date, channel and message id come from the message it was found
 * in, never from the model. Duplicates fold into one, and a phone number or
 * email inside a kept quote is masked.
 */
export function verifyQuotes(rawQuotes = [], thread = {}) {
  const { refs } = threadForModel(thread);
  const theirs = Object.values(refs).filter((m) => theirText(m));
  const quotes = [];
  const seen = new Set();
  let dropped = 0;
  for (const q of Array.isArray(rawQuotes) ? rawQuotes : []) {
    const text = norm(q?.text).replace(/^["“]+|["”]+$/g, "").slice(0, MAX_QUOTE_CHARS);
    const parts = pieces(text);
    if (!parts.length || parts.join(" ").length < 8) { dropped++; continue; }
    const cited = refs[String(q?.ref || "").trim()];
    const hit = cited && theirText(cited) && foundIn(theirText(cited), parts) ? cited : theirs.find((m) => foundIn(theirText(m), parts));
    if (!hit) { dropped++; continue; }
    const key = quoteKey(text);
    if (seen.has(key)) continue;
    seen.add(key);
    const about = [...new Set(asList(q?.about).map(String).filter((k) => READ_FIELDS[k]))];
    quotes.push({ text: maskContact(text), at: hit.at, channel: hit.channel, messageId: hit.id || null, about });
    if (quotes.length >= MAX_QUOTES) break;
  }
  return { quotes, dropped };
}

/* ---------- a read ---------- */

/**
 * normalizeRead(raw, thread, { by, at }) → read
 *
 * raw is the model's answer ({ summary, fields, quotes }). The read keeps the
 * verified quotes, the coerced columns, what it covered (`through`: the newest
 * message in the thread) and how it was made (`by`: "model:<id>" or
 * "import:<batch>").
 */
export function normalizeRead(raw = {}, thread = {}, { by = "", at = new Date().toISOString() } = {}) {
  const { quotes, dropped } = verifyQuotes(raw?.quotes, thread);
  const msgs = thread.messages || [];
  return {
    summary: norm(raw?.summary).slice(0, 400),
    fields: normalizeFields(raw?.fields),
    quotes,
    through: msgs.length ? msgs[msgs.length - 1].at : null,
    readAt: at,
    by: String(by || "").slice(0, 80),
    stats: {
      messages: msgs.length,
      theirs: msgs.filter((m) => m.dir === "them" && m.channel !== "call" && m.channel !== "voicemail").length,
      calls: msgs.filter((m) => m.channel === "call" || m.channel === "voicemail").length,
      callsTranscribed: msgs.filter((m) => (m.turns || []).length).length,
      quotesDropped: dropped,
    },
  };
}

// A read stored by hand (the backfill file) or coming back out of the store:
// the same shape, coerced, without a thread to check quotes against — the
// quotes were checked when the read was made.
export function cleanRead(r = {}) {
  const src = isObj(r) ? r : {};
  const quotes = [];
  const seen = new Set();
  for (const q of Array.isArray(src.quotes) ? src.quotes : []) {
    const text = maskContact(norm(q?.text).slice(0, MAX_QUOTE_CHARS));
    const at = q?.at && !Number.isNaN(Date.parse(q.at)) ? new Date(q.at).toISOString() : null;
    if (text.length < 8 || seen.has(quoteKey(text))) continue;
    seen.add(quoteKey(text));
    quotes.push({
      text, at,
      channel: CHANNELS.includes(q?.channel) ? q.channel : "sms",
      messageId: q?.messageId ? String(q.messageId).slice(0, 80) : null,
      about: [...new Set(asList(q?.about).map(String).filter((k) => READ_FIELDS[k]))],
    });
    if (quotes.length >= MAX_QUOTES) break;
  }
  const iso = (v) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
  const st = isObj(src.stats) ? src.stats : {};
  const count = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : 0);
  return {
    summary: norm(src.summary).slice(0, 400),
    fields: normalizeFields(src.fields),
    quotes,
    through: iso(src.through),
    readAt: iso(src.readAt) || new Date().toISOString(),
    by: String(src.by || "").slice(0, 80),
    stats: { messages: count(st.messages), theirs: count(st.theirs), calls: count(st.calls), callsTranscribed: count(st.callsTranscribed), quotesDropped: count(st.quotesDropped) },
  };
}

// The newest thing they said that made it into the read.
export const lastSaidAt = (read) => (read?.quotes || []).reduce((max, q) => (q.at && q.at > (max || "") ? q.at : max), null);

// A read is out of date when their thread has moved past what it covered.
// A time from the store or GHL: an ISO string, or a Date as Postgres hands
// back timestamptz (Date.parse on a Date drops its milliseconds).
const timeOf = (v) => (v instanceof Date ? v.getTime() : Date.parse(v || ""));
// GHL stamps a conversation's last message a few seconds after the message
// (seen up to 36s, 2026-11-02); a message past this is a new one.
export const READ_STALE_SLACK_MS = 60_000;
export function readIsStale(read, lastMessageAt) {
  if (!read) return true;
  const last = timeOf(lastMessageAt);
  if (!Number.isFinite(last)) return false;
  const through = timeOf(read.through);
  return !Number.isFinite(through) || last > through + READ_STALE_SLACK_MS;
}

/* ---------- what the table and the export show ---------- */

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 2 : 0).replace(/\.?0+$/, "")}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
export function priceBand(fields = {}) {
  const lo = fields.price_min, hi = fields.price_max;
  if (lo && hi) return `${k(lo)}–${k(hi)}`;
  if (hi) return `up to ${k(hi)}`;
  if (lo) return `${k(lo)}+`;
  return "";
}
export function fieldText(key, value) {
  const def = READ_FIELDS[key];
  if (!def || value == null || value === "" || (Array.isArray(value) && !value.length)) return "";
  if (def.kind === "number") return def.money ? k(value) : Number(value).toLocaleString("en-US");
  const label = (v) => def.labels?.[v] || String(v).replace(/_/g, " ");
  return Array.isArray(value) ? value.map(label).join("; ") : label(value);
}

/**
 * readColumns(read) → { summary, areas, …, price, quotes, lastSaid }
 *
 * One flat row: what the Investors table and the CSV show. Lists are joined
 * with "; " because an area can carry a comma ("Tacoma, WA").
 */
export function readColumns(read) {
  const f = read?.fields || {};
  const out = { summary: read?.summary || "" };
  for (const key of READ_FIELD_KEYS) {
    if (key === "price_min" || key === "price_max") continue;
    out[key] = fieldText(key, f[key]);
  }
  out.price = priceBand(f);
  out.quotes = (read?.quotes || []).length;
  out.lastSaid = lastSaidAt(read);
  return out;
}

const CHANNEL_WORD = { sms: "text", email: "email", call: "call", voicemail: "voicemail", chat: "chat" };
export const quoteLine = (q) => `${day(q.at)} (${CHANNEL_WORD[q.channel] || q.channel}): "${q.text}"`;

// What a plain search box looks through: the summary, every column and every
// quote, lower-cased.
export function readSearchText(read) {
  if (!read) return "";
  const cols = readColumns(read);
  return low([cols.summary, ...READ_FIELD_KEYS.map((k) => cols[k] || ""), cols.price, ...(read.quotes || []).map((q) => q.text)].join(" "));
}

/**
 * readFacts(read, { have }) → [{ key, value }]
 *
 * What "Add to buy box" files into the contact record: each column that has a
 * buy-box fact key, as the record spells it. `have` is the record's current
 * facts ({ key: string | string[] }); a value already there is skipped, and a
 * scalar the record already holds is left alone — the record is the buy box,
 * and a person may have set it on purpose.
 */
export function readFacts(read, { have = {} } = {}) {
  const f = read?.fields || {};
  const out = [];
  const already = (key, v) => {
    const cur = have?.[key];
    if (cur == null || cur === "") return false;
    return Array.isArray(cur) ? cur.some((x) => low(x) === low(v)) : true;
  };
  for (const [key, def] of Object.entries(READ_FIELDS)) {
    if (!def.fact) continue;
    const v = f[key];
    for (const one of asList(v).slice(0, def.factFirst ? 1 : undefined)) {
      if (one == null || one === "") continue;
      const value = key === "must_haves" ? `must have: ${one}` : String(one);
      if (already(def.fact, value)) continue;
      out.push({ key: def.fact, value });
    }
  }
  return out;
}

/* ---------- the CSV export ---------- */

const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const EXPORT_COLUMNS = [
  ["name", "Name"], ["relationship", "Relationship"], ["tier", "Tier"],
  ["summary", "What they buy"], ["areas", "Areas they buy"], ["areas_avoid", "Areas they won't buy"],
  ["property_types", "Kinds of house"], ["strategies", "Strategy"], ["price", "Price"], ["rehab", "Rehab"],
  ["funding", "How they pay"], ["beds_min", "Beds min"], ["baths_min", "Baths min"], ["sqft_min", "Sq ft min"],
  ["lot_min", "Lot min (sq ft)"], ["must_haves", "Must-haves"], ["dealbreakers", "Dealbreakers"],
  ["numbers", "How they run numbers"], ["volume", "Volume"], ["status", "Buying now?"], ["timing", "Timing"],
  ["role", "Who they are"], ["company", "Company"], ["deals_by", "Send deals by"], ["close_speed", "How fast they close"],
  ["notes", "Worth knowing"], ["quotes", "Quotes"], ["lastSaid", "Last said"], ["words", "In their words"],
  ["readAt", "Read"], ["contactId", "GHL contact"],
];

/**
 * readsCsv(rows) → string
 *
 * rows: [{ contactId, name, relationship, tier, read }]. One line per
 * investor; "In their words" holds every quote, newest first, one per line
 * inside the cell. For Matt's own download — the route serves it, nothing
 * logs it.
 */
export function readsCsv(rows = []) {
  const head = EXPORT_COLUMNS.map(([, label]) => csvCell(label)).join(",");
  const lines = rows.map((r) => {
    const cols = readColumns(r.read);
    const words = [...(r.read?.quotes || [])].sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))).map(quoteLine).join("\n");
    const row = { ...cols, name: r.name || "", relationship: r.relationship || "", tier: r.tier || "", contactId: r.contactId, words, lastSaid: day(cols.lastSaid), readAt: day(r.read?.readAt) };
    return EXPORT_COLUMNS.map(([key]) => csvCell(row[key])).join(",");
  });
  return `${[head, ...lines].join("\r\n")}\r\n`;
}
