// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// call-list.js — who to call today, and why.
//
// Matt, 2026-10-02: "my highest leverage is that I am a human connecting and
// calling these agents, human to human." The machine texts, floats, nudges,
// underwrites and blasts; the phone is his. Before this, a hot offer reached
// Today only after the machine's pushes had failed twice (hot_stalled), a
// counter only if its draft was still open, and GHL's Tier 1 stage was the
// call list he walked by hand.
//
// Each reason here is a Desk row in the Call section (shared/desk.js), with
// a brief: why now, what the call is for, the houses with ours against
// theirs, and an opener (a template — no model, no spend). A connected call
// after the row's `since` clears it (call-intake reads the GHL dialer's
// transcript, or Matt logs one); a call that didn't connect is a
// `call_attempt` — it lowers the row for the day, a "call back" date hides it
// until then, and after `triesBeforeMachine` tries it goes back to the
// machine's texting.
//
// Pure. The route reads; this decides.

import { effectiveStatus, pushesToPaper, priceAgreed } from "./offer-status.js";
import { callEventConnected } from "./talked-to.js";
import { agentSegment } from "./agent-pulse.js";
import { IRRITATED_RX } from "./thread-health.js";
import { handsWriteUpBack } from "./conversation-ai.js";
import { holdState } from "./counter-hold.js";
import { flipRead } from "./flip-read.js";
import { offMarketCue } from "./off-market.js";
import { sameStreet } from "./us-address.js";

const DAY_MS = 86400000;
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };
const street = (a) => String(a || "").split(",")[0].trim();
const first = (name) => String(name || "").trim().split(/\s+/)[0] || "there";
// "386K" / "197.5K" / "1.08M" — how Matt says numbers on the phone. Never
// rounded up: 197,500 said as "198K" is a number above the one we sent.
export const kText = (n) => {
  const v = Math.round(Number(n) || 0);
  if (!v) return "";
  if (v >= 1e6) return `${Math.floor(v / 1e4) / 100}M`;
  return `${Math.floor(v / 100) / 10}K`;
};

/* ---------- settings: saved.desk ---------- */

export const DESK_DEFAULTS = Object.freeze({
  callCap: 12,             // Call rows shown before "N more to call"
  relationshipDays: 30,    // a partner agent quiet this long is worth a call
  relationshipPerDay: 2,   // at most this many partner check-ins on the list
  firstReplyDays: 3,       // a new agent's first reply stays a call this long
  triesBeforeMachine: 2,   // calls that didn't connect before texting takes over again
});

/** normalizeDesk(v) → every setting, a whole number in its range. */
export function normalizeDesk(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  const n = (x, d, lo, hi) => { const k = Math.round(Number(x)); return x == null || x === "" || !Number.isFinite(k) ? d : Math.min(hi, Math.max(lo, k)); };
  const d = DESK_DEFAULTS;
  return {
    callCap: n(o.callCap, d.callCap, 1, 50),
    relationshipDays: n(o.relationshipDays, d.relationshipDays, 7, 180),
    relationshipPerDay: n(o.relationshipPerDay, d.relationshipPerDay, 0, 10),
    firstReplyDays: n(o.firstReplyDays, d.firstReplyDays, 1, 14),
    triesBeforeMachine: n(o.triesBeforeMachine, d.triesBeforeMachine, 1, 5),
  };
}

/* ---------- the reasons ---------- */

export const CALL_KINDS = [
  { key: "call_hot",         label: "Hot: get it written up" },
  // Rows the call list hands the machine or a decision (2026-10-04).
  { key: "paper_to_sign",    label: "Paperwork to sign" },
  { key: "hot_machine",      label: "Hot: the machine is pushing to paper" },
  { key: "counter_held",     label: "Counter: held at our number" },
  { key: "call_missed",      label: "They called you" },
  { key: "call_counter",     label: "Counter above our number" },
  { key: "call_first_reply", label: "New agent, first reply" },
  { key: "call_quiet",       label: "Gone quiet: a call beats another text" },
  { key: "call_phone_only",  label: "Phone only" },
  { key: "call_partner",     label: "Relationship check-in" },
];
// They called you: ring back first — they reached out.
const BASE = { call_missed: 105, call_hot: 100, call_counter: 90, call_first_reply: 70, call_quiet: 60, call_phone_only: 55, call_partner: 30 };
// Points off for each call that didn't connect since the row's reason, and
// for each day their last word has aged (hot, counters, quiet threads).
const PER_TRY = 15;
const PER_DAY = 1, MAX_AGE_PENALTY = 30;

const FIRST_REPLY_INTENTS = new Set(["deal_available", "new_property", "investor_open"]);
// A price in their words: "$425,000", "425k", "1.2M", "425,000". A street
// number never reads as one (no $, no k/m, no thousands comma).
const PRICE_RX = /\$\s?\d|\b\d{1,4}(?:\.\d+)?\s?(?:k|m|mm)\b|\b\d{1,3},\d{3}\b/i;

/**
 * firstReplyLead({ ins, iceAddress }) → why it's a lead, or "" (Matt,
 * 2026-10-08: a first-reply call only for real leads; "it's turnkey" is the
 * bot's to answer, not a call). Their words read as a flip or off-market
 * (shared/flip-read.js, shared/off-market.js), the qualify step found it a
 * flip, they put a number on a house, they asked to talk, or they brought
 * us a house other than the one our first text named.
 */
export function firstReplyLead({ ins = [], iceAddress = "" } = {}) {
  const list = (ins || []).filter(Boolean);
  if (list.some((d) => d.intent === "wants_call")) return "they asked to talk";
  if (list.some((d) => d.qualify?.stage === "qualified")) return "reads as a flip";
  const words = list.map((d) => String(d.inbound || "")).join("\n");
  const rehab = Math.max(0, ...list.map((d) => Number(d.agentTake?.rehab) || 0));
  if (flipRead(words, { agentRehab: rehab }).qualifies) return "reads as a flip";
  if (offMarketCue(words)) return "off-market";
  if (list.some((d) => Number(d.counterAmount) > 0 || Number(d.agentTake?.arv) > 0) || PRICE_RX.test(words)) return "put a number on it";
  const ice = String(iceAddress || "").trim();
  if (ice && list.some((d) => String(d.propertyAddress || "").trim() && !sameStreet(d.propertyAddress, ice))) return "brought us a house";
  return "";
}
// A phone number in their text: "(360) 555-0161 here!"
const PHONE_RX = /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
// The paperwork is on its way to us to sign.
const SENT_TO_SIGN_RX = /\b(?:docusign|authentisign|dotloop|e-?sign(?:ature)?)\b|\bsent (?:it|you|the (?:offer|paperwork|forms?|contract|psa))(?: over)? (?:for|to) (?:your )?sign(?:ature|ing)?\b|\bready (?:for you )?to sign\b|\bfor your signature\b/i;
const LIVE_LANES = new Set(["floated", "sent", "countered", "hot"]);

/**
 * callList({ offers, cards, actions, drafts, events, lastIn, lastAny, unsubscribed, settings, now })
 *   → rows (action-shaped, section "call" — or "machine" once the tries run out)
 *
 *   offers        lean rows (the counter, the heat, the agreed price)
 *   cards         buildPipeline's cards: one per house, its current offer
 *   actions       the pipeline's rows (ladder_exhausted / gone_quiet feed call_quiet)
 *   drafts        open and recent reply drafts (their words, intents, the band's ceiling)
 *   events        the timeline: call_summary, call_attempt, text_summary, outreach_sent…
 *   lastIn        Map contactId → ISO of their last word to us (any time)
 *   lastAny       Map contactId → ISO of the last touch either way
 *   unsubscribed  Set of contactIds who opted out of texts
 *   machine       what the machine is driving (Matt, 2026-10-04: "today should
 *                 only be for urgent things only a human should do"):
 *                   hotPush      the push-to-paper ladder is on — an agreed
 *                                hot offer is the machine's, unless they
 *                                handed the write-up to someone else (a
 *                                call) or sent paper to sign (a decision)
 *                   offerNudge   the offer ladder is on — a warm hot offer
 *                                (nothing agreed) is the machine's
 *                   counterHold  {enabled, checkIns, gapHours} — a counter we
 *                                held our number on is the machine's
 *                   nudges       the offer ladder repeats — a quiet thread is
 *                                the machine's, not a call
 *                 Off (the default), each reads as it did before.
 */
export function callList({
  offers = [], cards = [], actions = [], drafts = [], events = [],
  lastIn = new Map(), lastAny = new Map(), unsubscribed = new Set(), settings = {}, now = Date.now(),
  machine = {},
} = {}) {
  const cfg = normalizeDesk(settings);
  const offersById = new Map((offers || []).filter((o) => o?.id).map((o) => [o.id, o]));
  const offersBy = groupBy(offers, (o) => o.contactId);
  const draftsBy = groupBy(drafts, (d) => d.contactId);
  const eventsBy = groupBy(events, (e) => e.contactId);
  const liveCards = (cards || []).filter((c) => c?.side === "agent" && c.contactId && LIVE_LANES.has(c.lane));
  const cardsBy = groupBy(liveCards, (c) => c.contactId);

  const theirWords = (c) => (draftsBy.get(c) || []).filter((d) => String(d.inbound || "").trim())
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const irritated = (c) => theirWords(c).slice(0, 3).some((d) => IRRITATED_RX.test(d.inbound) || d.intent === "opt_out");
  const lastWord = (c) => {
    const ts = [ms(lastIn.get?.(c)), ...theirWords(c).slice(0, 1).map((d) => ms(d.createdAt)),
      ...(eventsBy.get(c) || []).filter((e) => e.type === "text_summary" || callEventConnected(e)).map((e) => ms(e.at))].filter((t) => t != null);
    return ts.length ? Math.max(...ts) : null;
  };
  const housesOf = (c) => (cardsBy.get(c) || []).map((card) => {
    const o = offersById.get(card.offerId) || {};
    const theirs = Number(o.counter?.amount) || 0;
    return { offerId: card.offerId, address: card.address, ours: Number(card.cashAmount) || 0, theirs: theirs > (Number(card.cashAmount) || 0) ? theirs : 0, status: effectiveStatus(o) || card.status, lane: card.lane };
  });

  const out = [];
  const taken = new Set();   // one call reason per person — the strongest
  const add = (kind, { contactId, contactName = "", offerId = null, address = "", since, why, goal, opener, houses = null, draftId = null, extra = {}, agePenaltyFrom = null }) => {
    if (!contactId || taken.has(contactId)) return;
    const evs = eventsBy.get(contactId) || [];
    const sinceMs = ms(since) ?? 0;
    // Talked since the reason arose, or you texted them yourself: done.
    if (evs.some((e) => (callEventConnected(e) || e.type === "hand_reply") && (ms(e.at) ?? 0) >= sinceMs)) return;
    // A call-back date still ahead: not today.
    const back = evs.filter((e) => e.type === "call_attempt" && e.data?.outcome === "call_back" && (ms(e.at) ?? 0) >= sinceMs)
      .map((e) => ms(e.data?.callBackAt)).filter((t) => t != null).sort((a, b) => b - a)[0];
    if (back != null && back > now) return;
    const tries = evs.filter((e) => (e.type === "call_attempt" && e.data?.outcome !== "call_back" && e.data?.direction !== "inbound") && (ms(e.at) ?? 0) >= sinceMs);
    const lastTry = tries.map((e) => e.at).sort().at(-1) || null;
    const aged = agePenaltyFrom != null ? Math.min(MAX_AGE_PENALTY, Math.max(0, Math.floor((now - agePenaltyFrom) / DAY_MS)) * PER_DAY) : 0;
    const spent = tries.length >= cfg.triesBeforeMachine;
    taken.add(contactId);
    out.push({
      id: `${kind}:${offerId || contactId}`, kind, section: spent ? "machine" : "call", group: spent ? "machine" : "yours",
      severity: spent ? "fyi" : "now", contactId, contactName, offerId, address, draftId,
      score: BASE[kind] - aged - PER_TRY * tries.length,
      title: `${contactName || "Someone"}: ${why}`, detail: goal,
      ...(spent ? { next: { what: `called ${tries.length}× with no answer — back to texting`, at: null } } : {}),
      call: { reason: kind, why, goal, opener, houses: houses || housesOf(contactId), since: since || null, tries: tries.length, lastTryAt: lastTry, lastWordAt: (() => { const t = lastWord(contactId); return t ? new Date(t).toISOString() : null; })() },
      ops: [], ...extra,
    });
  };

  // A row the machine is already driving: in "The machine is on it", with
  // what happens next. Never a call, whatever its kind would have said.
  const machineRow = (kind, { contactId, contactName = "", offerId = null, address = "", title, detail = "", next = null, extra = {} }) => {
    if (!contactId || taken.has(contactId)) return;
    taken.add(contactId);
    out.push({ id: `${kind}:${offerId || contactId}`, kind, section: "machine", group: "machine", severity: "fyi",
      contactId, contactName, offerId, address, draftId: null, score: 0, title, detail, next, ops: [], ...extra });
  };
  // Their texts since a moment, newest first.
  const wordsSince = (c, at) => theirWords(c).filter((d) => (ms(d.createdAt) ?? 0) >= (ms(at) ?? 0));

  /* 1. They called and we missed it. */
  for (const e of events || []) {
    if (e?.type !== "call_attempt" || e.data?.direction !== "inbound" || !e.contactId) continue;
    if (now - (ms(e.at) ?? 0) > 3 * DAY_MS || unsubscribed.has(e.contactId) || irritated(e.contactId)) continue;
    const c = e.contactId;
    const card = (cardsBy.get(c) || [])[0];
    const name = card?.contactName || nameOf(c, offersBy, draftsBy);
    add("call_missed", { contactId: c, contactName: name, offerId: card?.offerId || null, address: card?.address || "", since: e.at,
      why: "they called you and it wasn't picked up", goal: "Call them back.",
      opener: `Hi ${first(name)}, it's Matt, sorry I missed your call${card ? ` — is this about ${street(card.address)}?` : "."}` });
  }

  /* 2. Hot, not yet a deal: get it written up. */
  for (const card of liveCards.filter((c) => c.lane === "hot").sort((a, b) => (ms(b.hot?.at) ?? 0) - (ms(a.hot?.at) ?? 0))) {
    const c = card.contactId;
    if (unsubscribed.has(c) || irritated(c)) continue;
    const o = offersById.get(card.offerId) || {};
    const agreed = priceAgreed(o);
    const book = Number(card.cashAmount) || 0;
    // An agreement on record above the number the book says we're at now (a
    // realm yes before a re-price down; the band's 402.5K over Woodcrest's
    // signed 390K) is not a number to say: never above what we sent. The
    // call is to settle which number is real.
    const doubt = Boolean(agreed?.amount && book && Number(agreed.amount) > book);
    const agreedAt = agreed?.amount && !doubt ? Number(agreed.amount) : 0;
    const paper = pushesToPaper(o) && !doubt;
    const ours = agreedAt || book;
    const where = street(card.address);
    // When it went hot — not their last word: a "have a good weekend" after
    // the call re-armed a call that had already happened (336 SW 15th St,
    // 2026-10-04).
    const since = latest([o.hot?.at, agreed?.at, o.statusAt]);
    // You re-priced it below their yes yourself (3418 Wetmore, 2026-10-02:
    // a yes at 289,750, then 226,000 by hand). The yes still guards the
    // price — no paper at the lower number — but there is nothing for you to
    // "settle": the Desk reads it the way the machine drives it.
    const repricedBelow = doubt && [...(o.revisions || []), ...(o.requotes || [])].some((r) => {
      const to = Number(r?.to ?? r?.amount) || 0;
      return (ms(r?.ts) ?? 0) > (ms(agreed.at) ?? 0) && to > 0 && to < Number(agreed.amount);
    });
    // Only what the machine actually drives sits with it: the push to paper
    // when the price is agreed, the offer nudge while it's only warm.
    const driven = paper ? machine.hotPush : machine.offerNudge;
    if (driven && (!doubt || repricedBelow)) {
      const words = wordsSince(c, since);
      // "Write up whatever you like — call the listing broker" (3418
      // Wetmore): the paper is with someone the bot doesn't text. A call.
      const handed = words.find((d) => handsWriteUpBack(d.inbound));
      if (handed) {
        const phone = words.map((d) => (String(d.inbound || "").match(PHONE_RX) || [])[0]).find(Boolean) || "";
        add("call_hot", { contactId: c, contactName: card.contactName, offerId: card.offerId, address: card.address, since: handed.createdAt,
          why: `they handed the write-up on ${where} to someone else — call them`,
          goal: `They said to go to someone else to get ${where} written up${phone ? ` (${phone})` : ""}. Call, introduce yourself, and ask them to write it up on the NWMLS forms at ${kText(ours)} for your signature.`,
          opener: `Hi, it's Matt — ${first(card.contactName)} said you're the one to talk to about writing up ${where}.`,
          extra: phone ? { handedTo: { phone } } : {}, agePenaltyFrom: ms(handed.createdAt) });
        continue;
      }
      // The paper is here: signing it is yours.
      const toSign = words.find((d) => SENT_TO_SIGN_RX.test(String(d.inbound || "")));
      if (toSign) {
        if (taken.has(c)) continue;
        taken.add(c);
        out.push({ id: `paper_to_sign:${card.offerId}`, kind: "paper_to_sign", section: "decide", group: "yours", severity: "now",
          contactId: c, contactName: card.contactName, offerId: card.offerId, address: card.address, draftId: null, score: 0,
          title: `${card.contactName || "They"}: the paperwork on ${where} is ready to sign`,
          detail: `They sent it over at ${kText(ours)}. Check the number and the terms, then sign.`,
          ops: [{ key: "open_offer", label: "Open the offer", intent: "primary" }] });
        continue;
      }
      const writing = o.hot?.signal === "writing_up";
      machineRow("hot_machine", { contactId: c, contactName: card.contactName, offerId: card.offerId, address: card.address,
        title: `${card.contactName || "Someone"}: ${where} is hot${ours ? ` at ${kText(ours)}` : ""} — ${paper ? "the machine is pushing it to paper" : "the machine keeps asking where the seller is"}`,
        detail: writing ? "They said they're writing it up." : paper ? `Asking them to write it up on the NWMLS forms at ${kText(ours)}.` : "Warm, nothing agreed yet: the offer nudge checks in.",
        next: { what: writing ? "waiting on their write-up" : paper ? "the next push to paper" : "the next nudge on the offer", at: null } });
      continue;
    }
    add("call_hot", { contactId: c, contactName: card.contactName, offerId: card.offerId, address: card.address, since,
      why: doubt ? `${where} is hot, but the agreed ${kText(agreed.amount)} on record is above our ${kText(book)} — settle the number first`
        : agreedAt ? `${kText(ours)} on ${where} is agreed — get it on paper`
        : paper ? `${where} is hot at ${kText(ours)} — get it on paper`
        : `${where} is hot`,
      goal: doubt
        ? `Settle the number before anything goes on paper: our current offer on ${where} is ${kText(book)}. Re-quote or take the agreement back in the offer if that's wrong.`
        : paper
        ? `Get it written up today: ask them to represent you and draft it on the NWMLS forms at ${kText(ours)} for your signature.`
        : `Hear where the seller is on ${where} and get to yes at ${kText(ours)}.`,
      opener: paper && agreedAt
        ? `Hi ${first(card.contactName)}, it's Matt — on ${where}, sounds like ${kText(ours)} works. Could you write it up on the NWMLS forms and represent us? I can sign today.`
        : paper
        ? `Hi ${first(card.contactName)}, it's Matt — on ${where}, are we close at ${kText(ours)}? If so, could you write it up on the NWMLS forms and represent us?`
        : `Hi ${first(card.contactName)}, Matt here — wanted to hear what the seller said on ${where}.`,
      agePenaltyFrom: lastWord(c) });
  }

  /* 3. A counter above our number: a call lands a number a text doesn't. */
  for (const card of liveCards.filter((c) => c.lane === "countered")) {
    const c = card.contactId;
    if (unsubscribed.has(c) || irritated(c)) continue;
    const o = offersById.get(card.offerId) || {};
    const ours = Number(card.cashAmount) || 0;
    const theirs = Number(o.counter?.amount) || 0;
    // Held at our number (counter-hold.js): the machine checks in and passes
    // — "come closer to where they are" too, which carries no number.
    if (machine.counterHold?.enabled && o.counterHold?.at) {
      const ourLast = (draftsBy.get(c) || []).filter((d) => d.status === "sent").map((d) => d.sentAt || d.updatedAt || d.createdAt).filter(Boolean).sort().at(-1) || null;
      const st = holdState(o, { lastInboundAt: lastWordIso(lastWord(c)), lastOutboundAt: ourLast, checkIns: machine.counterHold.checkIns, gapHours: machine.counterHold.gapHours, now });
      machineRow("counter_held", { contactId: c, contactName: card.contactName, offerId: card.offerId, address: card.address,
        title: `${card.contactName || "Someone"}: held at ${kText(o.counterHold.ours || ours)} on ${street(card.address)}${theirs ? ` — they're at ${kText(theirs)}` : ""}`,
        detail: st.why,
        next: { what: st.next === "pass" ? "marked we passed" : st.next === "nudge" ? "a check-in" : st.why, at: st.at || null } });
      continue;
    }
    if (!(theirs > ours)) continue;
    const band = newestBand(draftsBy.get(c) || [], card.offerId);
    const ceiling = Number(band?.exception?.ceiling) || 0;
    const counter = { ours, theirs, gap: theirs - ours, ceiling: ceiling || null, overCeiling: ceiling ? Math.max(0, theirs - ceiling) : null, basis: band?.exception?.basis || "", draftId: band?.status === "draft" ? band.id : null };
    add("call_counter", { contactId: c, contactName: card.contactName, offerId: card.offerId, address: card.address, since: o.counter?.at || o.statusAt,
      draftId: counter.draftId,
      why: `countered ${kText(theirs)} on ${street(card.address)} against our ${kText(ours)}`,
      goal: `Land a number. Ours ${kText(ours)}, theirs ${kText(theirs)} (${kText(theirs - ours)} apart)${ceiling ? `; the buyer ceiling is ${kText(ceiling)}` : ""}. Never above what we sent without deciding it yourself.`,
      opener: `Hi ${first(card.contactName)}, it's Matt — got your ${kText(theirs)} on ${street(card.address)}. Easier to talk it through than text.`,
      extra: { counter }, agePenaltyFrom: lastWord(c) });
  }

  /* 4. A new agent's first reply: put a voice to the name. */
  const outreached = new Set((events || []).filter((e) => e?.type === "outreach_sent" && e.contactId).map((e) => e.contactId));
  for (const [c, list] of draftsBy) {
    if (!outreached.has(c) || unsubscribed.has(c) || irritated(c)) continue;
    const ins = list.filter((d) => String(d.inbound || "").trim() && d.party !== "investor").sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
    const firstIn = ins[0];
    if (!firstIn || now - (ms(firstIn.createdAt) ?? 0) > cfg.firstReplyDays * DAY_MS) continue;
    // Their first word ever: nothing earlier on the timeline either.
    const earlier = (eventsBy.get(c) || []).some((e) => (e.type === "text_summary" || callEventConnected(e)) && (ms(e.at) ?? 0) < (ms(firstIn.createdAt) ?? 0) - 60000);
    if (earlier) continue;
    const named = ins.find((d) => FIRST_REPLY_INTENTS.has(d.intent) || d.intent === "wants_call" || String(d.propertyAddress || "").trim());
    if (!named) continue;
    // Only a lead is a call; a turnkey "it's nice" is the bot's to answer.
    const iceAddress = (eventsBy.get(c) || [])
      .filter((e) => (e.type === "outreach_sent" || (e.type === "outreach_enrolled" && e.data?.kind !== "followup")) && e.address)
      .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))[0]?.address || "";
    const lead = firstReplyLead({ ins, iceAddress });
    if (!lead) continue;
    const priorOffer = (offersBy.get(c) || []).some((o) => (ms(o.createdAt) ?? 0) < (ms(firstIn.createdAt) ?? 0));
    if (priorOffer) continue;
    const name = named.contactName || nameOf(c, offersBy, draftsBy);
    const house = String(named.propertyAddress || "").trim();
    add("call_first_reply", { contactId: c, contactName: name, address: house, since: firstIn.createdAt,
      why: house ? `first reply, about ${street(house)} — ${lead}` : `first reply — ${lead}`,
      goal: "Relationship intro: who they are, what they list, and how they like to work with investors.",
      opener: `Hi ${first(name)}, it's Matt — thanks for getting back to me${house ? ` about ${street(house)}` : ""}. Wanted to put a voice to the name.` });
  }

  /* 5. An agent who talks to us, gone quiet on an offer: a call beats another text. */
  // Unless the offer ladder keeps asking (it repeats weekly): then the
  // machine is checking in, and that is Matt's ask (2026-10-04).
  for (const a of machine.nudges ? [] : actions || []) {
    if (!["ladder_exhausted", "gone_quiet"].includes(a?.kind) || !a.contactId) continue;
    const c = a.contactId;
    if (unsubscribed.has(c) || irritated(c)) continue;
    const seg = agentSegment({ offers: offersBy.get(c) || [], lastInboundAt: lastWordIso(lastWord(c)) });
    if (seg === "cold") continue;
    const card = (cardsBy.get(c) || []).find((x) => x.offerId === a.offerId) || null;
    add("call_quiet", { contactId: c, contactName: a.contactName || card?.contactName || "", offerId: a.offerId || null, address: a.address || card?.address || "",
      since: lastWordIso(lastWord(c)) || a.since || null,
      why: `quiet on ${street(a.address || card?.address) || "our offer"}${seg === "partner" ? " — and you've done business" : ""}`,
      goal: `Is ${street(a.address || card?.address) || "it"} still alive, and at what number? A call beats a fourth text.`,
      opener: `Hi ${first(a.contactName || card?.contactName)}, Matt here — circling back on ${street(a.address || card?.address) || "the house"}. Anything we can make work?`,
      agePenaltyFrom: lastWord(c) });
  }

  /* 6. Texting is off for them, and something is open. */
  for (const c of unsubscribed || []) {
    const cs = cardsBy.get(c) || [];
    if (!cs.length || irritated(c)) continue;
    const card = cs.find((x) => x.lane === "hot") || cs.find((x) => x.lane === "countered") || cs[0];
    add("call_phone_only", { contactId: c, contactName: card.contactName, offerId: card.offerId, address: card.address, since: lastWordIso(lastWord(c)) || card.stageSince || null,
      why: `texts are off for them; ${street(card.address)} is still open`,
      goal: `Texting is off for them — settle ${street(card.address)} by phone, or let it go.`,
      opener: `Hi ${first(card.contactName)}, Matt here — calling rather than texting about ${street(card.address)}.` });
  }

  /* 7. Partners — agents we've done business with — gone quiet a while. */
  const partners = [];
  for (const [c, list] of offersBy) {
    if (taken.has(c) || unsubscribed.has(c) || irritated(c)) continue;
    if (!(list || []).some((o) => o && (o.deal || priceAgreed(o) || o.realm?.answer === "yes"))) continue;
    const touched = ms(lastAny.get?.(c)) ?? lastWord(c);
    if (touched != null && now - touched < cfg.relationshipDays * DAY_MS) continue;
    partners.push({ c, touched: touched ?? 0, name: nameOf(c, offersBy, draftsBy) });
  }
  partners.sort((a, b) => a.touched - b.touched);
  for (const p of partners.slice(0, cfg.relationshipPerDay)) {
    const days = p.touched ? Math.floor((now - p.touched) / DAY_MS) : null;
    add("call_partner", { contactId: p.c, contactName: p.name, since: p.touched ? new Date(p.touched).toISOString() : null,
      why: `you've done business; ${days != null ? `${days} days` : "a while"} since you last spoke`,
      goal: "Keep the relationship warm: what are they listing, and anything ugly coming up?",
      opener: `Hi ${first(p.name)}, it's Matt — been a few weeks, wanted to check in and see what you're working on.` });
  }

  return out.sort((a, b) => b.score - a.score);
}

/**
 * briefFor(row, { cards, offers }) → a `call` block for a Call row the list
 * didn't build (a wants-a-call draft, a buyer the bot stays out of, a counter
 * last night found): why, goal, the houses and an opener.
 */
export function briefFor(row, { cards = [], offers = [] } = {}) {
  if (!row || row.call) return row?.call || null;
  const name = row.contactName || "";
  const offersById = new Map((offers || []).filter((o) => o?.id).map((o) => [o.id, o]));
  const houses = (cards || []).filter((c) => c?.contactId === row.contactId && c.side === "agent" && LIVE_LANES.has(c.lane))
    .map((c) => ({ offerId: c.offerId, address: c.address, ours: Number(c.cashAmount) || 0, theirs: Math.max(0, Number(offersById.get(c.offerId)?.counter?.amount) || 0), lane: c.lane }));
  const where = street(row.address);
  const goal = row.kind === "deal_interest_stalled" ? "Buyers looked and nobody's committed: call the ones evaluating and get a yes or a no."
    : /walk/.test(String(row.title || "")) ? "They want to see it: set a time."
    : /call/.test(String(row.title || "")) ? "They asked for a call."
    : row.findingKind === "counter_stalled" ? "A counter nobody answered: land a number."
    : "A conversation the bot stays out of.";
  return {
    reason: row.kind, why: row.title || "", goal, houses,
    opener: `Hi ${first(name)}, it's Matt${where ? ` — calling about ${where}` : ""}.`,
    tries: 0, since: row.since || null,
  };
}

/* ---------- helpers ---------- */

function groupBy(rows, key) {
  const m = new Map();
  for (const r of rows || []) { const k = r ? key(r) : null; if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return m;
}
const latest = (list) => { const ts = list.map(ms).filter((t) => t != null); return ts.length ? new Date(Math.max(...ts)).toISOString() : null; };
const lastWordIso = (t) => (t != null ? new Date(t).toISOString() : null);
function nameOf(c, offersBy, draftsBy) {
  return (offersBy.get(c) || []).find((o) => o?.contactName)?.contactName || (draftsBy.get(c) || []).find((d) => d?.contactName)?.contactName || "";
}
// The newest draft on this offer the counter band read, held or sent: its ceiling.
function newestBand(drafts, offerId) {
  return [...drafts].filter((d) => d?.exception && (d.offerId === offerId || d.outbound?.offerId === offerId || !d.offerId))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null;
}
