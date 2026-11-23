// lot-finder.js — the luxury teardown lane's front end: find the old houses
// on big lots in a builders' pocket, find their owners' cell numbers, and
// say hello with a price (Matt, 2026-11-23: "automate this entire thing from
// finding properties to skiptrace to sending text").
//
// A pocket is a circle around an address: lots at least this big, houses
// built before this year, owned at least this long. The parcels come from
// the property-data API (owner of record, mailing address, year built, lot,
// last sale); the cell numbers from the skip trace; the contact goes into
// GHL tagged `lot-owner` and gets one short text that names the price band
// up front, then one follow-up a day later. A reply ends the machine's part:
// the bot never answers a homeowner (reply-agent.js handsOffReason), the
// Desk says call them now.
//
// Washington: RCW 19.190.060 limits unsolicited commercial texts to WA cell
// phones. The text step ships behind its own switch (OWNER_SMS_ENABLED) and
// `autoSend`; until both are on, every text waits in the outbox for Matt.
//
// Pure: the settings, the owner row off a property record, who to trace, the
// phones worth keeping, the words, and what's due next.

export const LOT_OWNER_TAG = "lot-owner";
export const LOT_OWNER_TAG_PATTERNS = ["lot-owner", "lot-pocket-*"];
export const LOT_OWNER_PARTY = "owner";
export const LOT_OWNER_OUT_KINDS = ["lot_owner_open", "lot_owner_follow"];
export const LOT_OWNER_EVENTS = { queued: "lot_owner_queued", sent: "lot_owner_sent", replied: "lot_owner_replied" };
// Anything that means they're talking to us, Matt is, or they don't want to
// hear from us: the machine stops.
export const STOP_TYPES = [LOT_OWNER_EVENTS.replied, "call_summary", "call_booked", "hand_reply", "unsubscribed", "drive_stopped"];
export const SEQUENCE_EVENT_TYPES = ["import", LOT_OWNER_EVENTS.queued, LOT_OWNER_EVENTS.sent, ...STOP_TYPES];
export const OWNER_STATUSES = ["new", "tracing", "traced", "no_phone", "imported", "skipped", "do_not_contact"];
export const MAX_POCKETS = 12;
export const TEXT_MAX = 300;   // two segments is fine (the method's own texts run long)

const DAY_MS = 86400000;
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const slug = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const int = (v, d, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const digits = (s) => String(s || "").replace(/\D/g, "").slice(-10);
export const e164 = (p) => (digits(p).length === 10 ? `+1${digits(p)}` : "");

export const POCKET_DEFAULTS = Object.freeze({
  id: "", name: "", address: "", lat: 0, lng: 0, radiusMiles: 1,
  // 10,000 sqft is a starting point for Seattle-side pockets (Medina runs
  // 15–40k, Mercer Island 10–20k, Laurelhurst 7–15k; Scottsdale's ¾-acre
  // lots were 30k+). Suggest from Zillow sets the real band off the lots the
  // builders bought here.
  lotSqftMin: 10000, yearBuiltMax: 1980, yearsOwnedMin: 5,
  bandLo: 0, bandHi: 0,          // the lot value band the first text names, in dollars
  enabled: true,
});

export const LOT_FINDER_DEFAULTS = Object.freeze({
  enabled: false,
  dryRun: true,                  // says what it would do; spends and writes nothing
  autoSend: false,               // off: every text waits in the outbox for Matt
  dailyNew: 10,                  // owners texted per day, per location
  traceDailyCap: 25,             // skip-trace lookups per day (money)
  followUpDays: 1,
  // The bot's part once an owner writes back: "draft" writes the reply for Matt
  // to send; "send" lets the agent-side auto-send rules apply; "off" leaves
  // the thread to Matt with no draft at all.
  bot: "draft",
  ownerPlaybook: "",     // empty = OWNER_PLAYBOOK
  builderPlaybook: "",   // empty = BUILDER_PLAYBOOK
  pockets: [],
});

export function normalizePocket(raw = {}, i = 0) {
  const r = raw && typeof raw === "object" ? raw : {};
  const D = POCKET_DEFAULTS;
  const name = clean(r.name).slice(0, 60) || clean(r.address).split(",")[0].slice(0, 60) || `Pocket ${i + 1}`;
  return {
    id: slug(r.id) || slug(name) || `pocket-${i + 1}`,
    name,
    address: clean(r.address).slice(0, 160),
    lat: num(r.lat), lng: num(r.lng),
    radiusMiles: Math.min(5, Math.max(0.25, num(r.radiusMiles, D.radiusMiles))),
    lotSqftMin: int(r.lotSqftMin, D.lotSqftMin, 3000, 200000),
    yearBuiltMax: int(r.yearBuiltMax, D.yearBuiltMax, 1850, 2100),
    yearsOwnedMin: int(r.yearsOwnedMin, D.yearsOwnedMin, 0, 60),
    bandLo: Math.max(0, Math.round(num(r.bandLo))),
    bandHi: Math.max(0, Math.round(num(r.bandHi))),
    enabled: r.enabled !== false,
  };
}

/** normalizeLotFinder(raw) → every switch and pocket in shape; idempotent. */
export function normalizeLotFinder(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const D = LOT_FINDER_DEFAULTS;
  const seen = new Set();
  const pockets = (Array.isArray(r.pockets) ? r.pockets : []).slice(0, MAX_POCKETS).map((p, i) => normalizePocket(p, i))
    .filter((p) => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });
  return {
    enabled: r.enabled === true,
    dryRun: r.dryRun !== false,
    autoSend: r.autoSend === true,
    dailyNew: int(r.dailyNew, D.dailyNew, 0, 200),
    traceDailyCap: int(r.traceDailyCap, D.traceDailyCap, 0, 500),
    followUpDays: int(r.followUpDays, D.followUpDays, 0, 14),
    bot: ["draft", "send", "off"].includes(r.bot) ? r.bot : D.bot,
    ownerPlaybook: String(r.ownerPlaybook || "").trim().slice(0, 4000),
    builderPlaybook: String(r.builderPlaybook || "").trim().slice(0, 4000),
    pockets,
  };
}

/** A pocket is ready when it has a center and a price band to say. */
export function pocketReady(p) {
  return Boolean(p && p.enabled !== false && p.lat && p.lng && p.bandLo > 0 && p.bandHi >= p.bandLo);
}

/* ---------- the parcels ---------- */

/**
 * propertySearchBody(pocket, { size, resultIndex, today }) → the property-data
 * API's PropertySearch request: single-family, inside the circle, old enough,
 * lot big enough, owned long enough. Corporate owners are left in: a trust
 * or an LLC is still a seller, the trace just has nobody to look up.
 */
export function propertySearchBody(p, { size = 250, resultIndex = 0 } = {}) {
  return {
    latitude: p.lat, longitude: p.lng, radius: p.radiusMiles,
    property_type: "SFR",
    year_built_max: p.yearBuiltMax,
    lot_size_min: p.lotSqftMin,
    ...(p.yearsOwnedMin > 0 ? { years_owned_min: p.yearsOwnedMin } : {}),
    size, resultIndex,
  };
}

const addr = (a = {}) => ({
  street: clean(a?.street || a?.address || "").slice(0, 120), city: clean(a?.city).slice(0, 60),
  state: clean(a?.state).slice(0, 2).toUpperCase(), zip: clean(a?.zip).slice(0, 10),
});

/**
 * ownerFromProperty(record, pocket) → { ownerKey, pocketId, doc } | null
 *
 * The owner row the finder keeps, off one PropertySearch record. Kept small:
 * the house, the owner of record and where their mail goes, the facts the
 * teardown test wants. No phone yet — that's the trace's.
 */
export function ownerFromProperty(r = {}, pocket = {}) {
  const id = String(r?.id ?? r?.propertyId ?? "").trim();
  const house = addr(r?.address);
  if (!id || !house.street) return null;
  const mail = addr(r?.mailAddress);
  const first = clean(r?.owner1FirstName), last = clean(r?.owner1LastName);
  const company = clean(r?.companyName || r?.owner2Company);
  return {
    ownerKey: `rapi:${id}`, pocketId: pocket.id || "",
    doc: {
      house, mail: mail.street ? mail : null,
      first, last, company,
      // A person we can look up by name; a trust or an LLC is traced by the
      // address alone, which costs the same and hits less.
      person: Boolean(first && last && !company),
      yearBuilt: int(r?.yearBuilt, 0, 0, 2100) || null,
      lotSqft: int(r?.lotSquareFeet, 0, 0, 10000000) || null,
      sqft: int(r?.squareFeet, 0, 0, 100000) || null,
      lastSaleDate: clean(r?.lastSaleDate).slice(0, 10) || null,
      lastSaleAmount: Math.round(num(r?.lastSaleAmount)) || null,
      estimatedValue: Math.round(num(r?.estimatedValue)) || null,
      ownerOccupied: typeof r?.ownerOccupied === "boolean" ? r.ownerOccupied : null,
      lat: num(r?.latitude) || null, lng: num(r?.longitude) || null,
    },
  };
}

/** pickToTrace(rows, { cap }) → the new rows worth a lookup, oldest first, people before entities. */
export function pickToTrace(rows = [], { cap = 25 } = {}) {
  return rows.filter((r) => r.status === "new" && r.doc?.house?.street)
    .sort((a, b) => Number(Boolean(b.doc?.person)) - Number(Boolean(a.doc?.person)) || String(a.firstSeen || "").localeCompare(String(b.firstSeen || "")))
    .slice(0, Math.max(0, cap));
}

/** traceLookupBody(row) → one entry for the skip trace's instant lookup (owner name when we have one). */
export function traceLookupBody(row) {
  const d = row.doc || {};
  const h = d.house || {};
  const base = { address: h.street, city: h.city, state: h.state, ...(h.zip ? { zip: h.zip } : {}) };
  return d.person ? { ...base, find_owner: false, first_name: d.first, last_name: d.last } : { ...base, find_owner: true };
}

/**
 * phonesFromTrace(result) → [{ number, type, dnc, litigator, rank }] — every
 * phone the trace found, cells first, the person's DNC and litigator flags on
 * each. `reachable` below is the subset we may text.
 */
export function phonesFromTrace(result = {}) {
  const out = [];
  for (const p of Array.isArray(result?.persons) ? result.persons : []) {
    if (p?.deceased === true) continue;
    for (const ph of Array.isArray(p?.phones) ? p.phones : []) {
      const number = e164(ph?.number);
      if (!number) continue;
      out.push({ number, type: String(ph?.type || "").toLowerCase(), dnc: ph?.dnc === true || ph?.tcpa === true, litigator: p?.litigator === true, rank: num(ph?.rank, 99) });
    }
  }
  const seen = new Set();
  const ok = (p) => Number(p.type === "mobile" && !p.dnc && !p.litigator);
  return out.sort((a, b) => ok(b) - ok(a) || Number(b.type === "mobile") - Number(a.type === "mobile") || a.rank - b.rank)
    .filter((p) => { if (seen.has(p.number)) return false; seen.add(p.number); return true; });
}

/** reachable(phones) → the cells we may text: mobile, not on a do-not-call list, not a litigator. */
export const reachable = (phones = []) => phones.filter((p) => p.type === "mobile" && !p.dnc && !p.litigator);

/* ---------- the words ---------- */

// The method's first text, in eight shapes: a greeting, who we are, the
// address, respect for their time, THE PRICE BAND IN THE FIRST TEXT, cash and
// no agent fees, a soft ask. Blanks: {first} {street} {lo} {hi}. A blank
// nobody filled never sends (shared/voice.js LEFTOVER_RX), and the house rules
// hold: no dollar sign, one question, no "following up" (voiceFlags).
export const OPEN_TEXTS = [
  "Hi {first}, Matt Shepherd here. I work with builders in Washington and I'm looking at lots in your neighborhood. Lots like yours at {street} have been going in the {lo} to {hi} range, no agent fees, no showings. Would you ever consider selling?",
  "{first}, this is Matt, a local investor who works with builders. Not here to waste your time. Comparable lots near {street} have sold {lo} to {hi}, no agent fees, no showings. Would you consider selling, now or down the road?",
  "Hi {first}, Matt Shepherd. I buy lots for builders in your area and {street} is the kind they look for. Similar ones have gone for {lo} to {hi}, no agent fees, and you pick the closing date. Any interest in selling?",
  "Hey {first}, Matt here. I work with home builders in Washington. Lots like yours at {street} have been bringing {lo} to {hi} lately, no agent fees, and you'd stay as long as you need after closing. Worth a chat?",
  "{first}, Matt Shepherd, local investor. I'm looking for a lot in your neighborhood for a builder I work with and {street} caught my eye. Similar lots have sold {lo} to {hi}, no agent fees, no showings. Would you consider it?",
  "Hi {first}, Matt here, I work with developers in the Seattle area. Not trying to waste your time. Lots like yours at {street} are going {lo} to {hi}, no agent fees, no showings. Is selling something you'd ever consider?",
  "Hi {first}, this is Matt Shepherd. I help builders find lots and yours at {street} is the kind they're after. Recent sales nearby ran {lo} to {hi}, no agent fees, close when it suits you. Open to talking?",
  "{first}, Matt Shepherd here, local investor working with builders. Comparable lots to {street} have brought {lo} to {hi} lately, no agent fees, and a couple of months after closing to move if you need it. Worth a conversation?",
];

export const FOLLOW_TEXTS = [
  "Hi {first}, Matt again about {street}. Any interest in talking, or should I leave it there?",
  "{first}, Matt here on {street}. Even a not now helps me, no pressure either way.",
  "Hi {first}, Matt Shepherd. One more note on {street}, then I will leave you be. If it is a no, just say so.",
];

const kWords = (n) => {
  const v = Math.round(num(n));
  if (v >= 1000000) return `${(v / 1000000).toFixed(v % 1000000 === 0 ? 0 : v % 100000 === 0 ? 1 : 2).replace(/\.0$/, "")}M`;
  return `${Math.round(v / 1000)}k`;
};

/**
 * lotOwnerText({ step, variant, first, street, bandLo, bandHi }) → the text, or
 * "" when a blank has nothing to fill it (no street, no band). A missing first
 * name drops the greeting rather than leaving a hole.
 */
export function lotOwnerText({ step = "open", variant = 0, first = "", street = "", bandLo = 0, bandHi = 0 } = {}) {
  const pool = step === "follow" ? FOLLOW_TEXTS : OPEN_TEXTS;
  const t = pool[Math.abs(Math.round(variant)) % pool.length];
  const st = clean(street).split(",")[0];
  if (!st) return "";
  if (step !== "follow" && !(bandLo > 0 && bandHi >= bandLo)) return "";
  const f = clean(first).split(" ")[0];
  let out = t.replace(/\{street\}/g, st).replace(/\{lo\}/g, kWords(bandLo)).replace(/\{hi\}/g, kWords(bandHi));
  out = f ? out.replace(/\{first\}/g, f) : out.replace(/^\{first\},\s*/, "").replace(/^(Hi|Hey) \{first\},\s*/, "$1, ").replace(/\{first\}/g, "");
  out = out.replace(/^Hi, (this|Matt)/, "Hi, $1").replace(/^([a-z])/, (m) => m.toUpperCase());
  return out.slice(0, TEXT_MAX);
}

/* ---------- what's due ---------- */

const at = (e) => Date.parse(e?.at || "") || 0;

/**
 * nextOwnerStep({ events, followUpDays, now }) →
 *   { step: "open" | "follow", why } | { step: null, why } | { stop: why }
 *
 * The first text once imported; one follow-up `followUpDays` after the first
 * actually went (the sent event, never the draft); then nothing. Any reply,
 * call, opt-out or hand text stops it for good.
 */
export function nextOwnerStep({ events = [], followUpDays = 1, now = Date.now() } = {}) {
  const evs = [...events].sort((a, b) => at(a) - at(b));
  const imported = evs.find((e) => e.type === "import");
  if (!imported) return { step: null, why: "not imported yet" };
  const stop = evs.find((e) => STOP_TYPES.includes(e.type) && at(e) >= at(imported));
  if (stop) return { stop: stop.type === "unsubscribed" ? "they opted out" : stop.type === "drive_stopped" ? "you stopped the bot on them" : "they answered — yours to call" };
  const queued = (step) => evs.filter((e) => e.type === LOT_OWNER_EVENTS.queued && e.data?.step === step);
  const sent = (step) => evs.filter((e) => e.type === LOT_OWNER_EVENTS.sent && e.data?.step === step);
  if (!queued("open").length) return { step: "open", why: "first text" };
  const opened = sent("open")[0];
  if (!opened) return { step: null, why: "the first text hasn't gone yet" };
  if (queued("follow").length) return { step: null, why: "done: two texts, no answer" };
  if (now - at(opened) < followUpDays * DAY_MS) return { step: null, why: `follow-up in ${followUpDays} day${followUpDays === 1 ? "" : "s"}` };
  return { step: "follow", why: "no answer to the first text" };
}

/** lotOwnerTags(pocket) → the GHL tags on an owner contact. */
export const lotOwnerTags = (pocket = {}) => [LOT_OWNER_TAG, ...(pocket?.id ? [`lot-pocket-${slug(pocket.id)}`] : [])];

/* ---------- the pocket's numbers, off Zillow (the method's §1A–1C) ---------- */

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * suggestPocket({ newBuilds, teardowns, lotSqftMin }) → { yearBuiltMax,
 *   lotSqftMin, lotSqftMax, bandLo, bandHi, lotValue, exits }
 *
 * `newBuilds`: sold houses built in the last few years (price, lotSqft, sqft,
 * yearBuilt). `teardowns`: sold older houses in the same box (price, lotSqft,
 * yearBuilt, sqft). The lot band is the new builds' lots; the cutoff is the
 * newest teardown that sold inside that band, rounded up to the decade; the
 * price band is the middle half of what those teardowns sold for.
 */
export function suggestPocket({ newBuilds = [], teardowns = [], lotSqftMin = 0 } = {}) {
  const nbLots = newBuilds.map((b) => num(b.lotSqft)).filter((l) => l > 0);
  const lo = nbLots.length ? Math.round(Math.min(...nbLots) * 0.9) : lotSqftMin || 0;
  const hi = nbLots.length ? Math.round(Math.max(...nbLots) * 1.1) : 0;
  const inBand = teardowns.filter((t) => num(t.price) > 0 && (!lo || !num(t.lotSqft) || (num(t.lotSqft) >= lo && (!hi || num(t.lotSqft) <= hi))));
  const years = inBand.map((t) => num(t.yearBuilt)).filter((y) => y > 1800);
  const cutoff = years.length ? Math.ceil(Math.max(...years) / 10) * 10 : 0;
  const prices = inBand.map((t) => num(t.price)).filter((p) => p > 0).sort((a, b) => a - b);
  const q = (f) => (prices.length ? prices[Math.min(prices.length - 1, Math.floor(f * (prices.length - 1)))] : 0);
  const round25 = (n) => Math.round(n / 25000) * 25000;
  return {
    yearBuiltMax: cutoff || null,
    lotSqftMin: lo || null, lotSqftMax: hi || null,
    lotValue: Math.round(median(prices)) || null,
    bandLo: round25(q(0.25)) || null, bandHi: round25(q(0.75)) || null,
    teardowns: inBand.length, exits: newBuilds.length,
    exitLo: Math.round(Math.min(...newBuilds.map((b) => num(b.price)).filter((p) => p > 0))) || null,
    exitHi: Math.round(Math.max(...newBuilds.map((b) => num(b.price)).filter((p) => p > 0))) || null,
  };
}

/* ---------- the disposition side: the builders who buy here (the method's §6) ---------- */

export const BUILDER_STATUSES = ["new", "imported", "skipped", "no_phone"];
export const BUILDER_SOURCE_TAG = "dispo-source-builder-exits";

// "Built by Acme Homes", "another Acme Homes masterpiece", "presented by Acme
// Construction LLC": the builder's name as a listing description says it.
const BUILDER_RX = /\b(?:built|constructed|crafted|presented|brought to you|developed|designed and built)\s+by\s+([A-Z][\w&'.-]*(?:\s+[A-Z][\w&'.-]*){0,4})/;
const BUILDER_WORD_RX = /\b([A-Z][\w&'.-]*(?:\s+[A-Z][\w&'.-]*){0,3}\s+(?:Homes|Home Builders|Builders|Construction|Development|Developments|Custom Homes|Design Build|Residential))\b/;
const NOT_A_BUILDER = /\b(?:New|This|The|Stunning|Luxury|Modern|Custom|Beautiful|Gorgeous|Welcome)\b$/;

/** builderName(description) → "Acme Homes" | "" — the builder a listing names, if it does. */
export function builderName(description = "") {
  const text = clean(description);
  const m = text.match(BUILDER_RX) || text.match(BUILDER_WORD_RX);
  if (!m) return "";
  const name = clean(m[1]).replace(/[.,;:]+$/, "");
  if (!name || NOT_A_BUILDER.test(name) || name.split(" ").length > 6) return "";
  return name.slice(0, 80);
}

/**
 * builderFromNewBuild({ row, facts, pocket, now }) → { builderKey, pocketId, doc } | null
 *
 * One new build that sold (a Zillow sold row with its detail facts) read as a
 * builder lead: the exit (price and date), the lot it sits on, and the lot
 * buy before it in the page's sale history — the method's "you got the lot
 * for $1.2M" line. The builder's name off the description when it's there;
 * the listing agent otherwise, who has a reason to help (the builder gives
 * them the finished house to list). Nothing is skip-traced here.
 */
export function builderFromNewBuild({ row = {}, facts = null, pocket = {}, now = Date.now() } = {}) {
  const address = clean(row.address);
  const price = Math.round(num(row.price));
  if (!address || price <= 0) return null;
  const sales = Array.isArray(facts?.sales) ? facts.sales : [];
  const exitDate = clean(row.saleDate || sales[0]?.date).slice(0, 10);
  // The lot buy: the sale before the exit, a year or more earlier and well under it.
  const prior = sales.find((s) => s.date && exitDate && s.date < exitDate && s.price < price * 0.7
    && (Date.parse(exitDate) - Date.parse(s.date)) >= 300 * DAY_MS) || null;
  const agent = facts?.agent || {};
  const builder = builderName(facts?.description || "");
  const name = builder || (agent.name ? `${agent.name} (listing agent)` : "");
  return {
    builderKey: `nb:${address.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80)}`,
    pocketId: pocket.id || "",
    doc: {
      address, exitPrice: price, exitDate: exitDate || null,
      lotSqft: int(row.lotSqft ?? facts?.lotSqft, 0, 0, 10000000) || null,
      sqft: int(row.sqft ?? facts?.sqft, 0, 0, 100000) || null,
      yearBuilt: int(row.yearBuilt ?? facts?.yearBuilt, 0, 0, 2100) || null,
      priorLotPrice: prior?.price || null, priorLotDate: prior?.date || null,
      builder, name,
      agent: { name: clean(agent.name).slice(0, 80), phone: e164(agent.phone), email: clean(agent.email).slice(0, 120), brokerage: clean(facts?.brokerage).slice(0, 80) },
      // Who we'd reach: the builder (P1) when we have a number for them — we
      // don't off Zillow — else the listing agent (P2). P3, the LLC behind the
      // sale, is the county's and a skip trace's, by hand for now.
      reach: agent.phone ? "agent" : "none",
      seenAt: iso(now),
    },
  };
}

const iso = (t) => new Date(t).toISOString();

/** builderTags(pocket) → the buyer-book tags on a builder contact: a buyer who builds, found here. */
export const builderTags = (pocket = {}) => ["investor", "builder", "dispo-type-new-construction", BUILDER_SOURCE_TAG, ...(pocket?.id ? [`lot-pocket-${slug(pocket.id)}`] : [])];

/**
 * builderOpener({ first, exit, lotStreet, assignAt }) → the method's buyer line:
 * "saw you sold X for Y, looks like the lot ran Z — similar lot nearby at W,
 * want the package?" One question, no dollar signs (the house rules).
 */
export function builderOpener({ first = "", exit = {}, lotStreet = "", assignAt = 0 } = {}) {
  const f = clean(first).split(" ")[0];
  const sold = clean(exit.address).split(",")[0];
  if (!sold || !(num(exit.exitPrice) > 0) || !lotStreet) return "";
  const lot = exit.priorLotPrice > 0 ? `, looks like the lot ran ${kWords(exit.priorLotPrice)}` : "";
  const at = assignAt > 0 ? ` at ${kWords(assignAt)}` : "";
  const size = exit.lotSqft > 0 ? " of similar size" : "";
  return `${f ? `${f}, ` : ""}Matt Shepherd here. Saw you sold ${sold} for ${kWords(exit.exitPrice)}${lot}, congrats. I've got an off-market lot${size} a few blocks away at ${clean(lotStreet).split(",")[0]}${at}, fits the building envelope of the one you just did. Any interest?`.slice(0, TEXT_MAX);
}

/* ---------- a house that belongs to the lane (the Luxury page gets every one) ---------- */

// Every hold reason for a luxury lot starts with this (held-underwrites.js
// keys on it): never passed by the machine, never flip math — a person prices
// it by the lot, on the Luxury page.
export const LOT_HOLD_PREFIX = "luxury lot";
export const LOT_HOLD = /^luxury lot\b/i;

const toRad = (d) => (d * Math.PI) / 180;
/** milesApart(a, b) → great-circle miles between two { lat, lng } points. */
export function milesApart(a, b) {
  const R = 3958.8;
  const dLat = toRad(num(b.lat) - num(a.lat));
  const dLng = toRad(num(b.lng) - num(a.lng));
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(num(a.lat))) * Math.cos(toRad(num(b.lat))) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * pocketFor({ lat, lng, lotSqft, yearBuilt }, pockets) → the enabled pocket the
 * house falls in, or null: inside the circle, lot at least the pocket's
 * minimum, built no later than its cutoff. A house with no lot or no year on
 * record doesn't qualify — the lane is for the houses we're sure about.
 */
export function pocketFor({ lat, lng, lotSqft = 0, yearBuilt = 0 } = {}, pockets = []) {
  if (!(num(lat) && num(lng) && num(lotSqft) > 0 && num(yearBuilt) > 0)) return null;
  for (const p of pockets || []) {
    if (!p?.enabled || !p.lat || !p.lng) continue;
    if (num(lotSqft) < p.lotSqftMin || num(yearBuilt) > p.yearBuiltMax) continue;
    if (milesApart({ lat, lng }, p) <= p.radiusMiles) return p;
  }
  return null;
}

/** lotHold(pocket, { lotSqft, yearBuilt, why }) → the hold reason, in the words the Desk shows. */
export function lotHold(pocket = null, { lotSqft = 0, yearBuilt = 0, why = "" } = {}) {
  const facts = [lotSqft > 0 ? `${Math.round(lotSqft).toLocaleString("en-US")} sqft lot` : "", yearBuilt > 0 ? `built ${yearBuilt}` : ""].filter(Boolean).join(", ");
  const where = why || (pocket?.name ? `inside the ${pocket.name} pocket` : "a homeowner the lot finder texted");
  return `${LOT_HOLD_PREFIX} — ${where}${facts ? ` (${facts})` : ""}: a lot for a builder, priced by the lot on the Luxury page, never flip math`;
}

/* ---------- how the bot talks in this lane ---------- */

// The owner-side playbook, in the method's words. The agent-side bot wears
// this instead of the listing-agent one when the contact is a homeowner the
// lot finder texted (reply-agent.js: party agent, lane owner). Editable in
// Autopilot → Lots; this is the default.
export const OWNER_PLAYBOOK =
  "WHO YOU ARE TALKING TO: a HOMEOWNER, not an agent. They own an older house on a large lot in a neighborhood where builders tear down and build new. " +
  "We texted them first. They may be curious, wary, or offended; they are never a lead to be worked. Warm, plain, short.\n" +
  "WHAT WE ARE: investors who work with home builders. Be transparent: we buy the lot for the land, a builder we work with builds on it, and we make money on the deal. Never pretend to be the builder, a neighbor, or a buyer who will live there.\n" +
  "WHAT MATTERS: only two things — the lot (size, where it sits, interior street or main road, corner) and what the seller needs (timing, where they are going next, whether they need the money from this house for the next one). " +
  "NEVER ask about the roof, the furnace, the kitchen, the condition, repairs, or photos of the inside. The house is coming down; its condition is worth nothing to us and asking reads as a flipper.\n" +
  "WHAT WE OFFER THEM: privacy (no listing, no sign, no showings, the neighbors never know), speed and certainty (a clean sale with no financing contingency, a date they choose), and staying put after closing for a couple of months if they need it to buy their next house — builders need that time for survey, permits and plans anyway.\n" +
  "PRICE: talk about it openly and early. Use the comps nearby and the price band from our first text. If OUR OFFERS has a number for their house, that is our number — never above it. Say what a sale costs them the other way: listing with an agent runs about eight percent in commissions and closing, so our number nets them about the same as listing, with none of the hassle. " +
  "If they say the Zestimate is higher or lower, say it prices the house, not the lot, and in a neighborhood like theirs the lot is the value. " +
  "If they say it's worth way more, don't argue: ask what number they have in mind and what they'd need to see, and let a person decide. A number from them is a counter, not a no.\n" +
  "THE GOAL: a short phone call with a person on our side about the lot and what they need. Ask for it once, lightly; never promise a call at a time.\n" +
  "NEVER: say cash or all cash (we fund with a hard money loan), say assign, wholesale, spread, fee or end buyer, ask for a listing agreement, offer to walk the house, or send a link. One question per text. No dollar signs; money in k or M.";

// The builder-side playbook. The investor-side bot adds this when the deal in
// front of them is a lot (reply-agent.js: party investor, lane builder).
export const BUILDER_PLAYBOOK =
  "THIS DEAL IS A LOT, NOT A HOUSE. The buyer is a BUILDER who tears down and builds new. Talk like a land seller: lot size, zoning, what it backs onto and fronts, interior street or main road, utilities, whether the house is occupied and when it will be empty, our price. " +
  "NEVER say ARV, rehab, fixer, cosmetic, gut, scope of work, or anything about the condition of the house: the house is coming down.\n" +
  "THE PITCH: it fits the building envelope of what they just built nearby — say so when the record shows a recent build of theirs with a similar lot. Our price is the price; a builder pays about what the lot is worth and there is no fee talk from us. " +
  "If they ask whether it's a vacant lot, say there is an older house on it that comes down. If they ask what it backs to or about the street, answer from the record if it's there; otherwise say you'll find out, with needsHuman set.\n" +
  "VERIFY THEY BUILD: if their last deal nearby reads like a remodel rather than a ground-up build, ask lightly whether they built new on it. A builder who only remodels is not this deal's buyer.\n" +
  "ASSIGNMENT, AGENT FEES, EARNEST, CLOSING DATE: a person's call — say you'll confirm today and set needsHuman. Never promise a timeline the deal record doesn't show.";

const MAX_PLAYBOOK = 4000;
