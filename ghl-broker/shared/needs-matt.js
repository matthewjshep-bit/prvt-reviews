// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// needs-matt.js — the few things only Matt can do, as a GHL stage.
//
// Matt, 2026-10-22, after the follow-up audit: "Can we just have another
// stage in GHL opp pipeline as a catch all for everything else. But I want
// it minimize what those things are and have the app handle most things …
// Instead of ping to me they land there." Today is gone (2026-10-20) and the
// ping workflow was never built, so an acceptance sat 15 hours, three
// counters up to 46, and an agreed number a week, with nothing telling him.
//
// The agent's Acquisitions card moves to a stage named "Needs Matt" while one
// of these is open, and back to where the offers put it once it's done:
//
//   yes        they said yes (an acceptance held for him, a yes after we
//              passed) or agreed a number he hasn't approved; since
//              2026-11-09 also a held reply that quotes our terms back or
//              says they're writing it up, and that same yes on a house our
//              row says is closed, until a person acts on it
//   paper      paper to sign, a pre-contract warning, a hand-off only he
//              can do, an answer only he has; since 2026-11-09 also proof
//              of funds asked, the terms asked on a house where our number
//              is out, and a call we owe after they sent terms
//   price      a house an agent surfaced that has waited PRICE_WAIT_HOURS
//              for his number, or their number on a house we never priced.
//              PASS_AFTER_HOURS working hours after it landed (weekdays,
//              not his days off), still unpriced, the runner passes it and
//              the pass note tells the agent. A house the offer engine priced
//              at grade A or B is never passed by that clock (Matt,
//              2026-11-10): it waits for him with the engine's number on the
//              card. A grade-C number passes like an unpriced house
//
// Everything else stays the machine's: counters (the bot holds our number,
// Matt 2026-10-22), booked calls (booking), calls (the GHL dialer,
// desk.ghlCalls), passes (the pass note), promises (the promise sweep), held
// check-ins (the gates), closing tasks (the card sits in Contract), buyers
// (Deals). Keep this list short: a stage that fills up is one nobody reads.
//
// Pure. The runner is ghl-broker/needs-matt.js; the stage move is
// shared/ghl-stages.js planCard's `needsMatt`.

import { ownerOf, closeSignalFor, termsCallOwed } from "./hand-off.js";
import { isCounterDraft } from "./desk.js";
import { saysTurnkey, saysCosmeticOnly, workBudgetIn } from "./flip-read.js";
import { hasHouseNumber } from "./mentioned-houses.js";
import { isOffMarket } from "./off-market.js";
import { workingHoursBetween, addWorkingHours, WORK_TZ } from "./paper-follows.js";

export const NEEDS_MATT_STAGE_RX = /^needs\s+matt\b/i;
export const NEEDS_MATT_STAGE_NAME = "Needs Matt";
export const PRICE_WAIT_HOURS = 24;
// Matt, 2026-10-22: "Land, then bot passes." Three days on the stage: working days since
// 2026-11-10 (18 of the 43 houses it passed in 16 days had waited over a weekend).
export const PASS_AFTER_HOURS = 72;
export const NEEDS_MATT_CURSOR = "needsMatt";
export const NEEDS_MATT_EVENT = "needs_matt_noted";

// Most pressing first: one per agent, the top one names the card's note.
export const NEEDS_MATT_KINDS = Object.freeze(["yes", "paper", "price"]);
const RANK = Object.fromEntries(NEEDS_MATT_KINDS.map((k, i) => [k, i]));

// Pipeline row kinds that are his on sight (hand-off.js says "ping" for
// them; buyers' and closing rows stay on Deals). `undelivered`: our answer
// to their text never arrived (shared/delivery.js undeliveredAnswers, read by
// ghl-broker/needs-matt.js while the delivery check is on, 2026-11-09). The
// machine never resends an answer, so a call or an email is his.
const PAPER_KINDS = new Set(["paper_to_sign", "pre_contract", "handoff", "undelivered"]);
// A house waiting on his number: the draft he prices, a number we owe.
const PRICE_KINDS = new Set(["price_it", "number_owed"]);

const HOUR_MS = 3600000;
// The counter band found no offer to answer: nothing of ours went out on it.
const noNumberOfOurs = (d) => d?.exception?.kind === "counter_band"
  && (d.exception.checks || []).some((c) => c?.name === "offer_live" && c.ok === false);
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };
// A redraft of the same text (the audit, the daytime pass) carries the first
// draft's time as `waitingSince` (reply-agent.js): the wait is theirs, not
// the draft's. Mary S., 2026-11-09: each redraft restarted the clock, so the
// card left Needs Matt and came back a day later, three times on one text.
const waitedFrom = (d) => d?.waitingSince || d?.createdAt || null;
const street = (a) => String(a || "").split(",")[0].trim();
const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const k$ = (n) => { const v = Math.round(Number(n) || 0); return v ? `${Math.round(v / 1000)}K` : ""; };

/**
 * needsMattKind(row, { draftsById, offersById, now }) → "yes" | "paper" | "price" | null
 *
 * `row` is one action from the pipeline read (shared/pipeline.js) or a call
 * list row; `draftsById` the open drafts the read came with; `offersById`
 * the offers it read (a held reply that quotes our terms, or asks for the
 * paper on a house where our number is out, needs them).
 */
export function needsMattKind(row, ctx = {}) {
  return needsMattReason(row, ctx)?.kind || null;
}

/**
 * needsMattReason(row, ctx) → { kind, reason } | null — needsMattKind, with
 * what made it his (the why line reads it). The 2026-11-09 audit's three:
 *
 *   yes    quotes_terms, writing_up   a held agent reply (hand-off.js
 *          closeSignal), or their yes on a house our row says is closed
 *          (the pipeline's their_yes row, which outlives the draft)
 *   paper  proof_of_funds, paper_ask  a held agent reply, at once
 *          terms_call                 a call we owe after they sent terms,
 *                                     on a house where our number is out
 */
export function needsMattReason(row, { draftsById = new Map(), offersById = new Map(), now = Date.now() } = {}) {
  const kind = String(row?.kind || "");
  if (kind === "approve_number") return { kind: "yes", reason: "approve" };
  if (kind === "their_yes") return { kind: "yes", reason: row.signal || "writing_up" };
  if (kind === "draft_waiting") {
    const d = draftsById.get(row.draftId) || null;
    if (!d || d.party === "investor") return null;
    const close = closeSignalFor(row, d, { offersById });
    if (row.yesAfterPass || d.yesAfterPass?.offerId || d.intent === "acceptance") return { kind: "yes", reason: close?.kind === "yes" ? close.reason : "accepted" };
    if (close) return close;
    // A counter is the bot's: it holds our number (reply-agent.js). Only
    // their number on a house with no offer of ours to hold is his to price,
    // or one far over ours that never went out (`unsentCounter`, the
    // 2026-11-09 audit): float ours or pass.
    if (isCounterDraft(d) && (noNumberOfOurs(d) || d.unsentCounter?.offerId)) {
      const at = ms(waitedFrom(d));
      return at != null && now - at >= PRICE_WAIT_HOURS * HOUR_MS ? { kind: "price", reason: "their_number" } : null;
    }
    return null;
  }
  // The bot answered their terms with "calling you shortly" (2026-11-09: a
  // seller at our number, three of those, no call): the terms are his.
  if (kind === "call_owed") return termsCallOwed(row, { offersById }) ? { kind: "paper", reason: "terms_call" } : null;
  const plain = needsMattPlainKind(kind, row, now);
  return plain ? { kind: plain, reason: "" } : null;
}

function needsMattPlainKind(kind, row, now) {
  if (PAPER_KINDS.has(kind)) return "paper";
  if (kind === "promise_owed") {
    const owner = ownerOf(row);
    if (owner === "ping") return "paper";
    if (owner !== "price") return null;
    const at = ms(row.owedAt);
    return at != null && now - at >= PRICE_WAIT_HOURS * HOUR_MS ? "price" : null;
  }
  if (PRICE_KINDS.has(kind)) {
    const at = ms(row.readyAt || row.promisedAt);
    return at != null && now - at >= PRICE_WAIT_HOURS * HOUR_MS ? "price" : null;
  }
  return null;
}

// What the 2026-11-09 kinds ask of him (needsMattReason's reasons).
const YES_WHY = {
  writing_up: (at) => `They're writing it up${at}: send the terms`,
  quotes_terms: (at) => `They quoted our terms back${at}: confirm and send the email`,
};
const PAPER_WHY = {
  proof_of_funds: (at) => `They asked for proof of funds${at}`,
  paper_ask: (at) => `They asked about the paper${at}: send the terms`,
  terms_call: (at) => `They sent terms${at} and we said we'd call: call them or send the terms`,
};

/** needsMattWhy(item) → the card's one line: what it is and what to do. */
export function needsMattWhy(x = {}) {
  const on = street(x.address);
  const at = on ? ` on ${on}` : "";
  if (x.kind === "yes") {
    if (x.rowKind === "approve_number") return clip(`They agreed${at}${x.amount ? ` at ${k$(x.amount)}` : ""}: approve the number in Offers → Hot, then the machine asks for the write-up`, 300);
    if (YES_WHY[x.reason]) return clip(YES_WHY[x.reason](at), 300);
    return clip(`They said yes${at}: the bot's reply is held for you`, 300);
  }
  if (x.kind === "paper" && PAPER_WHY[x.reason]) return clip(PAPER_WHY[x.reason](at), 300);
  if (x.kind === "paper") return clip(`${x.title || "Something only you can do"}${x.title && on && !String(x.title).includes(on) ? ` (${on})` : ""}`, 300);
  if (x.kind === "price" && x.theirs && x.ours) return clip(`They named ${k$(x.theirs)}${at}, over our ${k$(x.ours)} that never went out: float ours or pass`, 300);
  if (x.kind === "price" && x.theirs) return clip(`They named ${k$(x.theirs)}${at}: price it or pass`, 300);
  if (x.kind === "price") {
    const hours = Math.max(1, Math.round(((x.now ?? Date.now()) - (ms(x.since) ?? Date.now())) / HOUR_MS));
    const waited = hours >= 48 ? `${Math.round(hours / 24)} days` : `${hours} hours`;
    // The engine priced it (2026-11-10): its number is on the draft, one look to send or change.
    const n = engineNumber(x.engine);
    if (n) return clip(`Price it${at}: the engine has ${k$(n)} (grade ${x.engine.grade || "?"}) on the draft; the agent has waited ${waited}`, 300);
    return clip(`Price it${at}: the agent has waited ${waited} for our number`, 300);
  }
  return "";
}

/**
 * engineNumber(engine) → the offer engine's number on a house, or 0.
 * `engine` is { grade, open, walkAway } from the draft's engine read or the house's record. The
 * open when there is one, else the walk-away.
 */
export function engineNumber(engine = null) {
  const open = Math.round(Number(engine?.open) || 0);
  const walk = Math.round(Number(engine?.walkAway) || 0);
  return open > 0 ? open : walk > 0 ? walk : 0;
}

/**
 * engineKeeps(engine) → true when the engine's number keeps a house off the pass clock: grade A or
 * B with a number (Matt, 2026-11-10). Grade C is a house the machine shouldn't buy as it stands (a
 * killer fact like a manufactured home or a short sale, a turnkey, or two things it isn't sure of):
 * it passes on the clock like an unpriced one, never waits on Needs Matt for good.
 */
export function engineKeeps(engine = null) {
  return (engine?.grade === "A" || engine?.grade === "B") && engineNumber(engine) > 0;
}

/**
 * engineOn({ offer, record }) → { grade, open, walkAway } | null — the engine's number on a house:
 * the Price-it draft's engine read (draft.engine), else the house's record (house_pricing v2).
 */
export function engineOn({ offer = null, record = null } = {}) {
  for (const e of [offer?.draft?.engine, record?.v2]) {
    if (e && engineNumber(e)) return { grade: e.grade || null, open: Math.round(Number(e.open) || 0), walkAway: Math.round(Number(e.walkAway) || 0) };
  }
  return null;
}

/**
 * needsMattByContact(rows, { drafts, now, screened, walkedAway }) → Map contactId → { kind, why, at, key, rowKind, offerId, address }
 *
 * From the pipeline read's folded rows (each row and its `also`), the most
 * pressing open thing per agent. `at` is when it started (the stage move
 * reads it as "newest wins" against a person's drag); `key` is stable per
 * thing, so the card's note is written once.
 *
 * `walkedAway`: offer ids we passed on. Their number on one of those is not
 * a house to price — our pass is the answer (Matt, 2026-11-09: Mary S. and
 * Ed K. landed here after we'd passed, then bounced back to Offer Out). Only
 * a number: their yes on such a house still lands (needsMattReason).
 *
 * `offersById`: the offers the read came with (a Map, or pass `offers`), so a
 * held reply can be read against our number on its house.
 *
 * `engineByOffer`: offer id → the engine's number on that house (engineOn).
 * A price card carries it as `engine`: its why line names it, and at grade A
 * or B the pass clock never passes it (needsMattPassDue, engineKeeps).
 */
export function needsMattByContact(rows = [], { drafts = [], offers = null, offersById = null, now = Date.now(), screened = null, walkedAway = null, engineByOffer = null } = {}) {
  const draftsById = new Map((drafts || []).filter((d) => d?.id).map((d) => [d.id, d]));
  const byId = offersById instanceof Map ? offersById : new Map((offers || []).filter((o) => o?.id).map((o) => [o.id, o]));
  const out = new Map();
  for (const row of rows || []) {
    for (const r of [row, ...(row?.also || [])]) {
      const contactId = r?.contactId || row?.contactId;
      if (!contactId) continue;
      const found = needsMattReason(r, { draftsById, offersById: byId, now });
      const kind = found?.kind || null;
      if (!kind) continue;
      // A house the bot settles itself (botTakesHouse) never lands.
      if (kind === "price" && r.offerId && screened?.get?.(r.offerId)) continue;
      // Their number on a house we walked away from: nothing to price.
      if (kind === "price" && r.kind === "draft_waiting" && r.offerId && walkedAway?.has?.(r.offerId)) continue;
      const d = r.draftId ? draftsById.get(r.draftId) : null;
      const since = r.owedAt || r.readyAt || r.promisedAt || waitedFrom(d) || r.at || null;
      const theirs = kind === "price" && d && isCounterDraft(d) ? Math.round(Number(d.counterAmount) || 0) || null : null;
      const engine = kind === "price" && r.offerId ? engineByOffer?.get?.(r.offerId) || null : null;
      const item = { kind, reason: found.reason || "", rowKind: r.kind, offerId: r.offerId || null, address: r.address || d?.propertyAddress || "",
        amount: r.amount || null, title: r.title || "", since, now, theirs, engine,
        ours: kind === "price" && d?.unsentCounter?.ours ? Math.round(Number(d.unsentCounter.ours) || 0) || null : null };
      const prev = out.get(contactId);
      if (prev && RANK[prev.kind] <= RANK[kind]) continue;
      out.set(contactId, { kind, rowKind: r.kind, offerId: item.offerId, address: item.address, at: since,
        why: needsMattWhy(item), key: `${NEEDS_MATT_EVENT}:${r.id || `${r.kind}:${contactId}`}`, ...(engine ? { engine } : {}) });
    }
  }
  return out;
}

/**
 * botTakesHouse(offer) → null | { pass: "turnkey", why } | { chase: true, why }
 *
 * A house waiting on his price that the bot settles without him (Matt,
 * 2026-10-22: "only for the things that the bot was not able to handle"):
 *
 *   pass   the agent called it cosmetic or turnkey (shared/flip-read.js, the
 *          brought-house screen's own reading): we pass, the pass note says why
 *   chase  no house number ("125th Ave SE", a rental the lookup matched):
 *          nothing to price yet; the address chase asks for it
 *
 * Off-market is always his: an off-market cosmetic fixer became a contract
 * (7034 S K St). Anything else — real trouble, big-ticket items, nothing
 * said — is his to price.
 */
// Their text gave the number the draft lost ("796 SE Briarwood Ct" against
// "Briarwood Ct"): a number, then the street's own name within a few words.
const numberInWords = (address = "", words = "") => {
  const name = String(address || "").split(",")[0].split(/\s+/).find((w) => /^[a-z]{3,}$/i.test(w) && !/^(?:ave|avenue|st|street|rd|road|dr|drive|ct|court|ln|lane|pl|place|way|blvd|loop|lp|hwy|nw|ne|sw|se)$/i.test(w));
  if (!name) return false;
  return new RegExp(`\\b\\d{1,6}\\s+(?:\\S+\\s+){0,2}${name}\\b`, "i").test(String(words || ""));
};
export function botTakesHouse(offer) {
  if (!offer) return null;
  const words = String(offer.autoUnderwrite?.message || "");
  if (!hasHouseNumber(offer.address) && !numberInWords(offer.address, words)) {
    return { chase: true, why: "no house number: the bot asks the agent for the address" };
  }
  if (isOffMarket(offer)) return null;
  const agentRehab = workBudgetIn(words);
  if (saysTurnkey(words) || saysCosmeticOnly(words, { agentRehab })) return { pass: "turnkey", why: "the agent called it cosmetic or done" };
  return null;
}

/**
 * needsMattPassDue(need, now, { offDays }) → boolean
 *
 * A house still waiting on his price PASS_AFTER_HOURS working hours after it
 * landed in the stage (`landedAt`, the runner's first sight of it): the
 * runner marks it we passed, and the pass note tells the agent. Not from the
 * row's age: on the stage's first day, houses a week old would have been
 * passed unseen. Only a row the runner can mark; a yes or paper is never
 * passed by the machine.
 *
 * Matt, 2026-11-10: the clock counts weekdays only, and not his days off
 * (conversationAi autoSend.offDays); and a house the offer engine priced at
 * grade A or B (`need.engine`, engineKeeps) is never passed by it. A grade-C
 * number doesn't keep it: those pass like an unpriced house.
 */
export function needsMattPassDue(need, now = Date.now(), { offDays = null } = {}) {
  if (need?.kind !== "price" || !need.offerId || engineKeeps(need.engine)) return false;
  const landed = ms(need.landedAt);
  return landed != null && workingHoursBetween(landed, now, WORK_TZ, { offDays }) >= PASS_AFTER_HOURS;
}

/**
 * needsMattPassAt(need, { offDays }) → ISO | null — when the clock passes this card: PASS_AFTER_HOURS
 * working hours after it landed. Null for a card it never passes (not a price card, no row to
 * mark, or the engine priced it at grade A or B).
 */
export function needsMattPassAt(need, { offDays = null } = {}) {
  if (need?.kind !== "price" || !need.offerId || engineKeeps(need.engine)) return null;
  const landed = ms(need.landedAt);
  return landed == null ? null : new Date(addWorkingHours(landed, PASS_AFTER_HOURS, WORK_TZ, { offDays })).toISOString();
}

/**
 * needsMattOutrun(need, offers, readAt) → boolean
 *
 * The house the need is about changed status after the runner last read the
 * list (`readAt`), so the list's word on it is stale: a card sync goes by the
 * offers until the next read. Matt, 2026-10-29: a pass on the click should
 * move the card, not 15 minutes later.
 */
export function needsMattOutrun(need, offers = [], readAt = null) {
  if (!need?.offerId) return false;
  const read = ms(readAt);
  const at = ms((offers || []).find((o) => o?.id === need.offerId)?.statusAt);
  return read != null && at != null && at > read;
}

/** needsMattFromCursor(doc) → Map contactId → item, from the runner's last read. */
export function needsMattFromCursor(doc = null) {
  const m = new Map();
  for (const [id, v] of Object.entries(doc?.needs || {})) if (id && v?.kind) m.set(id, v);
  return m;
}
