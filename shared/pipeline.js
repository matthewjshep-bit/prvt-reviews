// pipeline.js — where everything currently stands, and what is waiting on a
// person.
//
// One card per PROPERTY. It moves left to right through the acquisition
// lanes (underwriting → floated → sent → countered) and, once it is a deal,
// through disposition (under contract → buyer found → assigned → closed).
// Investors are chips on the deal card, not cards of their own.
//
// The second output is the action queue: every thing the self-driving system
// stopped short of doing — a draft it parked, a counter the band refused, a
// hand-off it planned as ask-only, an underwrite it held, a ladder that ran
// out, a closing date that is next week. Each item names the ops a person can
// take on it; the console maps those keys onto existing API calls.
//
// Pure. Takes plain rows, returns plain objects; `now` is injected. The route
// does the reading, the console does the doing.

import {
  effectiveStatus, isExpired, offerExpiresAt, investorStatus, needsAiReview, aiHoldReasons, isAiGenerated, isHot,
  DEAD_STATUSES, LIVE_DEAL_STAGES, OPEN_STATUSES,
  offerHeat, priceAgreed, agreedAboveOurNumber, numberApproved, isDraftOnly,
} from "./offer-status.js";
import { stepLabel, exhausted, normalizeSteps, questionIn } from "./follow-up.js";
import { NEVER_AUTO, ASK_ONLY_ACTIONS, ACTION_LABEL } from "./conversation-ai.js";
import { addressKey } from "./contact-record.js";
import { openPromises, resolvePromise } from "./promise-resolver.js";
import { owedPromises, owedPersonPromises, PERSON_PROMISE_WORDS } from "./promise-owed.js";
import { UNANSWERED_LIMIT } from "./thread-health.js";
import { botHold, holdLine } from "./bot-hold.js";
import { groupHouses, resolveHouse, pricedAt } from "./current-offer.js";
import { showingSummary } from "./showing.js";
import { resolveChecklist, dueWords, GATE_LABEL } from "./deal-checklist.js";
import { OWNER_LABEL, resolveParties, partyName } from "./deal-parties.js";
import { accessFor } from "./deal-access.js";
import { KIND_HOLD, RURAL_HOLD } from "./asset-type.js";
import { needsPreContract, preContractChecks, openChecks, PRESELL_MIN_BUYERS } from "./pre-contract.js";
import { isOffMarket } from "./off-market.js";

const DAY_MS = 86400000;
// How long a hand-made offer nobody sent stays a decision on the Desk.
export const OFFER_READY_DAYS = 7;
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };
const round = (v) => Math.round(Number(v) || 0);
const money = (n) => `$${round(n).toLocaleString("en-US")}`;
const streetKey = (address) => addressKey(String(address || "").split(",")[0]);

/* ---------- the vocabulary ---------- */

// `stage` is the offer stage each lane sits under on the board (Draft · Sent ·
// Responded, shared/offer-stage.js); the lanes are the detail inside it.
export const AGENT_LANES = [
  { key: "underwriting", stage: "draft",     label: "Underwriting", hint: "the robot is pricing it right now" },
  { key: "needs_review", stage: "draft",     label: "Needs review", hint: "an underwrite stopped on a quality gate" },
  { key: "ready",        stage: "draft",     label: "Not sent",     hint: "priced, nothing has gone out" },
  { key: "floated",      stage: "sent",      label: "Floated",      hint: "our read or a soft number is out; waiting on theirs" },
  { key: "sent",         stage: "sent",      label: "Sent",         hint: "the offer is with the agent" },
  { key: "countered",    stage: "responded", label: "Countered",    hint: "they came back with a number" },
  { key: "hot",          stage: "responded", label: "Hot",          hint: "close to a contract — the price is agreed, or you flagged it" },
];
export const DISPO_LANES = [
  { key: "under_contract", label: "Under contract", hint: "ours to sell" },
  { key: "buyer_found",    label: "Buyer found",    hint: "a committed buyer" },
  { key: "assigned",       label: "Assigned",       hint: "contract assigned, waiting to close" },
  { key: "closed",         label: "Closed",         hidden: true },
];
export const HIDDEN_LANES = [{ key: "dead", label: "Dead", hidden: true }];
export const ALL_LANES = [...AGENT_LANES, ...DISPO_LANES, ...HIDDEN_LANES];

export const SEVERITY_RANK = { now: 0, soon: 1, fyi: 2 };
// Days after the last wave that buyers looking but not committing becomes a row.
export const INTEREST_STALL_DAYS = 4;

// The order the queue shows its groups in, and what each is called.
export const ACTION_KINDS = [
  { key: "promise_owed",      label: "Owed a number" },
  { key: "number_owed",       label: "Still owed, past the day" },
  { key: "call_owed",         label: "A call we promised" },
  { key: "draft_waiting",     label: "Drafts waiting on you" },
  { key: "handoff",           label: "One click from you" },
  { key: "investor_price_agreed", label: "Prices the machine agreed" },
  { key: "closing_soon",      label: "Closing" },
  { key: "closing_task_due",  label: "Closing checklist" },
  { key: "hot_stalled",       label: "Price agreed, gone quiet" },
  { key: "pre_contract",      label: "Before you sign" },
  { key: "price_it",          label: "Houses to price" },
  { key: "underwrite_held",   label: "Underwrites that need a look" },
  { key: "offer_ready",       label: "Priced, not floated" },
  { key: "no_fit",            label: "Too far under the seller to text" },
  { key: "approve_number",    label: "Agreed — approve the number" },
  { key: "ladder_exhausted",  label: "Followed up, no reply" },
  { key: "showing_soon",      label: "Walkthroughs coming up" },
  { key: "showing_no_window", label: "No walkthrough window yet" },
  { key: "deal_no_buyers",    label: "Deals with nobody on them" },
  { key: "blast_no_opens",    label: "Blasted, nobody opened it" },
  { key: "deal_interest_stalled", label: "Buyers looked, nobody's committing" },
  { key: "deal_no_dataroom",  label: "Deals with no buyer package" },
  { key: "draft_scheduled",   label: "Sending itself" },
  { key: "stage_lag",         label: "Stage is behind" },
  { key: "gone_quiet",        label: "Gone quiet" },
  { key: "underwrite_failed", label: "Underwrites that failed" },
  { key: "underwrite_dropped", label: "Underwrites that never ran" },
  { key: "texts_elsewhere",   label: "Their texts go to another number" },
];

// Investor state on a deal card, and its precedence. A buyer who committed
// is committed whatever else the events say; a buyer who only got a blast is
// the coldest thing on the card.
// A soft commit sits just under committed: it outranks evaluating (it is the
// most it can be without being signed) and loses to the real thing.
const INVESTOR_RANK = { committed: 7, soft_commit: 6, passed: 5, evaluating: 4, opened: 3, sent: 2, blasted: 1 };
const INVESTOR_ORDER = ["committed", "soft_commit", "evaluating", "opened", "sent", "blasted", "passed"];

// Today's three groups. "Your call" is a decision only a person makes. "The
// machine is on it" is something already moving, with what happens next and
// when. "Stuck" is something the machine would normally handle and couldn't,
// with why: usually a phone call or a fix to the data.
export const ACTION_GROUPS = [
  { key: "yours",   label: "Your call" },
  { key: "machine", label: "The machine is on it" },
  { key: "stuck",   label: "Stuck" },
];
const STUCK_KINDS = new Set(["hot_stalled", "underwrite_held", "underwrite_failed", "underwrite_dropped", "ladder_exhausted", "gone_quiet"]);

/**
 * groupFor(action) → "yours" | "machine" | "stuck"
 * A promise row is grouped where it is built (it depends on the resolver's
 * move and the driver switch); every other kind is grouped by what it is.
 */
export function groupFor(a) {
  if (a.group) return a.group;
  if (a.kind === "draft_scheduled") return "machine";
  if (a.kind === "offer_ready") return a.why ? "stuck" : "yours";
  if (STUCK_KINDS.has(a.kind)) return "stuck";
  return "yours";
}

// What the driver does next, in the row's words.
const DRIVER_NEXT = {
  send_number: "sends the number on the next pass",
  send_paper: "sends the written offer on the next pass",
  start_underwrite: "starts the underwrite on the next pass",
  ask_numbers: "asks for their numbers on the next pass",
  rerun: "re-runs on their numbers on the next pass",
};

// What a promise row offers for each of the resolver's moves. `wait`,
// `ask_numbers` and `start_underwrite` have no button yet: the row says so.
const PROMISE_OPS = {
  send_number: [{ key: "float_take", label: "Float our read", intent: "primary" }, { key: "float_realm", label: "Float the number", intent: "secondary" }],
  send_paper: [{ key: "open_editor", label: "Open and send", intent: "primary" }],
  rerun: [{ key: "rerun_held", label: "Re-run on their numbers", intent: "primary" }, { key: "open_editor", label: "Open and fix", intent: "secondary" }],
  ask_numbers: [{ key: "open_editor", label: "Open and fix", intent: "secondary" }],
  wait: [],
  start_underwrite: [],
  yours: [{ key: "open_editor", label: "Open and fix", intent: "primary" }],
};
const NEEDS_OFFER = new Set(["float_take", "float_realm", "rerun_held", "open_editor"]);
// A call we promised leads the day's calls (shared/call-list.js scores the
// rest: a missed call is 105, a hot offer 100).
const CALL_OWED_SCORE = 110;
const PROMISE_MOVE_LABEL = {
  send_number: "the number is ready and hasn't gone out",
  send_paper: "we said we'd send the written offer and it hasn't gone",
  rerun: "they gave us their numbers",
  ask_numbers: "needs their value or repairs",
  wait: "waiting",
  start_underwrite: "no underwrite has run on this house",
};

/* ---------- the builder ---------- */

/**
 * buildPipeline({ offers, drafts, events, jobs, config, contactNames, now })
 *   → { lanes, cards, actions, counts }
 *
 *   offers        lean rows (OFFER_LIST_FIELDS + derived)
 *   drafts        reply drafts, any status — only draft|scheduled are read
 *   events        contact_events, ascending, the types the route asked for
 *   jobs          auto-underwrite jobs (in memory; queued|running make cards)
 *   config        the normalized Conversation AI config (for ladder steps)
 *   contactNames  { contactId: name } for buyers not on the deal record
 *   sentDrafts    recent sent replies, so an owed answer we have since given
 *                 leaves the queue (shared/promise-resolver.js)
 *   heldTriageByOffer  { offerId: triageHeldUnderwrite() verdict } for held
 *                 drafts a promise is waiting on — the route reads what the
 *                 triage needs so this stays pure
 *   eventsLimit   what the route asked for, so we can say if the read filled
 *   dealRooms     offer ids with a live buyer package (dataroom). Only when
 *                 given does a deal without one get a row: a caller that
 *                 didn't look never guesses.
 *   preContractByOffer  { offerId: preContractChecks() } read off the full
 *                 record for the offers about to be signed; without it the
 *                 row reads the lean one (shared/pre-contract.js)
 */
export function buildPipeline({
  offers = [], drafts = [], events = [], jobs = [], config = null, contactNames = {},
  sentDrafts = [], heldTriageByOffer = {}, preContractByOffer = {},
  now = Date.now(), eventsLimit = 0, dealRooms = null,
} = {}) {
  const rooms = dealRooms ? new Set(dealRooms) : null;
  const ladders = {
    agent: config?.parties?.agent?.followUp || null,
    investor: config?.parties?.investor?.followUp || null,
  };
  const ev = indexEvents(events);
  const openDrafts = drafts.filter((d) => d && (d.status === "draft" || d.status === "scheduled"));

  const cards = [];
  const actions = [];
  const counts = {
    lanes: Object.fromEntries(ALL_LANES.map((l) => [l.key, 0])),
    actions: { now: 0, soon: 0, fyi: 0, byGroup: { yours: 0, machine: 0, stuck: 0 } },
    hidden: { dead: 0, closed: 0, drafts: 0, superseded: 0 },
    coldNoReply: 0,
    eventsTruncated: eventsLimit > 0 && events.length >= eventsLimit,
  };
  const push = (a) => {
    a.id = a.id || `${a.kind}:${a.offerId || a.draftId || a.jobId || a.contactId}`;
    a.group = groupFor(a);
    actions.push(a);
    counts.actions[a.severity]++;
    counts.actions.byGroup[a.group]++;
    return a.id;
  };

  // Offers by contact, for attaching drafts that name no offer.
  const byContact = new Map();
  for (const o of offers) {
    if (!o?.contactId) continue;
    if (!byContact.has(o.contactId)) byContact.set(o.contactId, []);
    byContact.get(o.contactId).push(o);
  }
  // One card per house: its current offer (current-offer.js). A row the
  // house moved past gets no card, and a draft attached to one moves to the
  // current row, so nothing it asks about is lost.
  const currentIdOf = new Map();
  for (const rows of groupHouses(offers).values()) {
    const { current, superseded } = resolveHouse(rows);
    if (current) for (const o of superseded) currentIdOf.set(o.id, current.id);
  }

  // Drafts by offer, resolved once.
  const draftsByOffer = new Map();
  const unattached = [];
  for (const d of openDrafts) {
    const named = draftOfferId(d, byContact, offers);
    const oid = currentIdOf.get(named) || named;
    if (oid) { if (!draftsByOffer.has(oid)) draftsByOffer.set(oid, []); draftsByOffer.get(oid).push(d); }
    else unattached.push(d);
  }

  /* --- one card per offer --- */
  for (const o of offers) {
    if (!o?.id) continue;
    if (currentIdOf.has(o.id)) { counts.hidden.superseded++; continue; }
    const status = effectiveStatus(o);
    const held = aiHoldReasons(o);
    // Only a DRAFT is a look nobody took. A held draft a person opened and
    // published keeps its hold reasons (they travel with the record) but is a
    // priced offer now — Erin Twedt's 20531 S Danvers (2026-09-16) sat in
    // "needs a look" for a day after its number had already been floated.
    const aiHeld = status === "draft" && needsAiReview(o) && held.length > 0;
    const expired = isExpired(o, new Date(now));

    // A hand-made draft is the editor's business, not the board's.
    if (status === "draft" && !isAiGenerated(o)) { counts.hidden.drafts++; continue; }

    const placed = placeOffer(o, { status, aiHeld });
    if (!placed) { counts.hidden.drafts++; continue; }
    // Heat moves the card on the board only: laneFor (the GHL mirror's
    // question) still answers with the status lane underneath.
    const heat = placed.side === "agent" && placed.lane !== "needs_review" ? offerHeat(o) : null;
    // `lane` stays the status lane for the chips and nudges below; only the
    // card's place on the board changes.
    const { lane, side, stageSince, deadReason } = placed;

    const myDrafts = draftsByOffer.get(o.id) || [];
    const myEvents = [...(ev.byOffer.get(o.id) || []), ...(ev.byStreet.get(streetKey(o.address)) || [])];
    const lastInboundAt = ev.lastInbound.get(o.contactId) || null;
    const sinceMs = ms(stageSince) ?? ms(o.createdAt) ?? now;
    const ageDays = Math.max(0, Math.floor((now - sinceMs) / DAY_MS));
    const silentSince = Math.max(sinceMs, ms(lastInboundAt) ?? 0);
    const expiresAt = offerExpiresAt(o);
    const expiresInDays = expiresAt ? Math.floor((expiresAt.getTime() - now) / DAY_MS) : null;

    const card = {
      id: o.id, kind: "offer", lane: heat ? "hot" : lane, side, offerId: o.id,
      contactId: o.contactId || null, contactName: o.contactName || contactNames[o.contactId] || "",
      address: o.address || "", cashAmount: round(o.cashAmount), askingPrice: round(o.askingPrice),
      status, stageSince, ageDays,
      ai: { made: isAiGenerated(o), held },
      chips: [], draftIds: myDrafts.map((d) => d.id),
      lastInboundAt, silentDays: Math.max(0, Math.floor((now - silentSince) / DAY_MS)),
      expiresAt: expiresAt ? expiresAt.toISOString() : null, expiresInDays, expired,
      deal: null, deadReason: deadReason || null, actionIds: [],
      hot: heat ? { by: heat.by, reason: heat.reason } : null, under: heat ? placed.lane : null,
    };
    if (heat) card.chips.push({ key: "hot", label: `hot: ${heat.reason}`, tone: "warn" });

    /* chips */
    const ladder = ladders.agent?.ladders?.offer_nudge;
    const steps = normalizeSteps(ladder?.steps || []);
    const sentSteps = (o.followUps || []).filter((f) => f?.kind === "offer_nudge").map((f) => Number(f.step)).filter(Number.isFinite);
    const ladderOn = Boolean(ladders.agent?.enabled && ladder?.enabled && steps.length);
    const replied = ms(lastInboundAt) != null && ms(lastInboundAt) > sinceMs;
    const ladderDone = ladderOn && (lane === "sent" || lane === "countered") &&
      exhausted({ steps, sentSteps, startedAt: stageSince, now, repeatEvery: ladder?.repeatEvery });

    if (aiHeld) card.chips.push({ key: "ai-held", label: "ai-held", tone: "warn" });
    else if (card.ai.made) card.chips.push({ key: "ai", label: "ai", tone: "neutral" });
    if (lane === "floated") {
      const kind = ms(o.proactive?.realmCheckAt) != null ? "realm" : "take";
      card.chips.push({ key: "floated", label: `floated: ${kind}`, tone: "neutral" });
    }
    if (sentSteps.length) {
      card.chips.push(ladderDone
        ? { key: "nudge", label: "ladder done", tone: "warn" }
        : { key: "nudge", label: stepLabel(Math.max(...sentSteps), steps) || `nudged ×${sentSteps.length}`, tone: "neutral" });
    }
    if (round(o.counter?.amount)) card.chips.push({ key: "counter", label: `countered ${money(o.counter.amount)}`, tone: "neutral" });
    const bandDraft = myDrafts.filter((d) => d.exception).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0];
    if (bandDraft?.exception) {
      const x = bandDraft.exception;
      card.chips.push(x.passed
        ? { key: "band", label: "in band", tone: "good" }
        : { key: "band", label: x.ceiling && x.theirAmount ? `over by ${money(x.theirAmount - x.ceiling)}` : "outside band", tone: "bad" });
    }
    if ((o.requotes || []).length) card.chips.push({ key: "requoted", label: `requoted ×${o.requotes.length}`, tone: "neutral" });
    // No expiry chip and no expiry queue item. An offer stands until the agent
    // answers — agents answer lapsed lowballs all the time — so the date on
    // the paper never moves a card, nags, or stops a follow-up. Only a
    // recorded outcome ends it.
    if (replied) card.chips.push({ key: "replied", label: "they replied", tone: "good" });

    /* the deal, with its buyers */
    if (o.deal) {
      const d = o.deal;
      const closingInDays = daysUntilYmd(d.closingDate, now);
      card.deal = {
        stage: d.stage, closingDate: d.closingDate || null, closingInDays,
        contractPrice: round(d.contractPrice), assignmentFee: round(d.assignmentFee),
        investors: investorChips(d, myEvents, contactNames),
        showing: { ...showingSummary(d.showing, now), accessSet: Boolean(accessFor(d).method) },
        checklist: (() => {
          const c = resolveChecklist(d, { now });
          const done = c.items.filter((i) => i.done).length;
          return { done, total: c.items.length, next: c.next ? { id: c.next.id, label: c.next.label, owner: c.next.owner, state: c.next.state, dueYmd: c.next.dueYmd, dueDays: c.next.dueDays } : null };
        })(),
      };
      // The investor band agreed a price with one buyer. It said yes in words
      // and wrote the number down; committing them, and the dataroom that
      // still shows the asking price, are a person's.
      for (const inv of d.investors || []) {
        const agreed = Math.round(Number(inv?.agreedPrice?.amount) || 0);
        if (!agreed || ["committed", "passed"].includes(inv.status) || !LIVE_DEAL_STAGES.has(d.stage)) continue;
        const asking = Math.round(Number(d.investorBand?.asking) || (Number(d.contractPrice) || 0) + (Number(d.assignmentFee) || 0));
        const who = inv.name || contactNames[inv.contactId] || "a buyer";
        card.actionIds.push(push({ offerId: o.id, contactId: inv.contactId, contactName: who, address: card.address,
          id: `investor_price_agreed:${o.id}:${inv.contactId}`, kind: "investor_price_agreed", severity: "now",
          title: `${card.address}: the machine agreed ${money(agreed)} with ${who}`,
          detail: `the dataroom still says ${money(asking)} · they are not marked committed`,
          ops: [{ key: "open_deals", label: "Open the deal", intent: "primary" }] }));
      }
      if (closingInDays != null && closingInDays <= 7 && LIVE_DEAL_STAGES.has(d.stage)) {
        card.chips.push({ key: "closing", label: closingInDays < 0 ? `closing ${-closingInDays}d overdue` : closingInDays === 0 ? "closes today" : `closes in ${closingInDays}d`, tone: closingInDays < 0 ? "bad" : "warn" });
      }
    }

    /* actions on this card */
    const base = { offerId: o.id, contactId: card.contactId, contactName: card.contactName, address: card.address };
    if (aiHeld && isDraftOnly(o)) {
      // Draft only (2026-10-16): an agent named this house, and the app made
      // the draft — the agent, the address, the listing's facts — instead of
      // pricing it. Matt prices it, or passes. Severity now: an agent is
      // usually waiting on a number, and nothing is coming unless he does it.
      const au = o.autoUnderwrite || {};
      const said = String(au.message || "").replace(/\s+/g, " ").trim();
      card.actionIds.push(push({ ...base, kind: "price_it", severity: "now",
        readyAt: au.finishedAt || o.createdAt || null,
        title: `Price it: ${card.address}`,
        why: "an agent named it — the app made the draft, you price it",
        detail: [au.subjectLine || "", said ? `they said "${said.length > 140 ? `${said.slice(0, 140)}…` : said}"` : ""].filter(Boolean).join(" · "),
        ops: [{ key: "open_editor", label: "Price it", intent: "primary" }, { key: "mark_we_passed", label: "Pass", intent: "secondary" }] }));
    } else if (aiHeld) {
      // Not our kind of house (shared/asset-type.js): single-family only for
      // now, so the question is whether to price it at all. "Underwrite
      // anyway" runs the underwriter again past that hold.
      // Rural (two acres or more, 2026-10-08) is the same question.
      const ruralHeld = held.find((h) => RURAL_HOLD.test(String(h || "")));
      const kindHeld = ruralHeld || held.find((h) => KIND_HOLD.test(String(h || "")));
      card.actionIds.push(push({ ...base, kind: "underwrite_held", severity: "soon",
        title: ruralHeld ? `Rural: ${card.address}` : kindHeld ? `Not single-family: ${card.address}` : `Underwrite held on ${card.address}`, detail: held.join(" · "),
        ops: kindHeld
          ? [{ key: "underwrite_anyway", label: "Underwrite anyway", intent: "secondary" }, { key: "drop", label: "Pass on it", intent: "primary" }]
          : [{ key: "open_editor", label: "Open and fix", intent: "primary" }, { key: "drop", label: "Drop it", intent: "danger" }] }));
    }
    // A listed house where ours is far under the seller's number (or the
    // list price), so the machine sent a polite no-fit instead of a number
    // (shared/number-stance.js listedFit, 2026-10-15). Not a pass: Matt
    // prices it by hand, floats ours anyway, or walks. Gone once the number
    // moves, a number goes out, or the offer closes.
    const nf = o.noFit;
    const noFitLive = Boolean(nf?.at && OPEN_STATUSES.has(status) && !o.deal && !(o.sends || []).length
      && (ms(o.proactive?.realmCheckAt) ?? 0) <= ms(nf.at) && pricedAt(o) <= ms(nf.at));
    if (noFitLive) {
      const theirsK = nf.theirs ? `${Math.round(nf.theirs / 1000)}K` : "";
      card.actionIds.push(push({ ...base, kind: "no_fit", severity: "soon",
        title: `${card.address}: ours is ${nf.ratio ? `${Math.round(nf.ratio * 100)}% of ` : "far under "}${nf.source === "seller" ? "the seller's" : "the list price,"} ${theirsK}`,
        detail: [`cash ${money(o.cashAmount)}`, "the machine told them it doesn't fit and sent no number"].join(" · "),
        why: "too far apart to text a number",
        ops: [{ key: "open_editor", label: "Price it by hand", intent: "primary" }, { key: "float_realm", label: "Float ours anyway", intent: "secondary" },
          { key: "mark_we_passed", label: "We passed", intent: "secondary" }] }));
    }
    // They said yes to a number Matt hasn't approved (2026-10-15): the machine
    // won't ask them to write it up, or to represent us at it, until he does.
    const agreed = !o.deal && OPEN_STATUSES.has(status) ? priceAgreed(o) : null;
    if (agreed && !agreedAboveOurNumber(o) && !numberApproved(o)) {
      const k = `${Math.round((Number(o.cashAmount) || 0) / 1000)}K`;
      card.actionIds.push(push({ ...base, kind: "approve_number", severity: "now", amount: Math.round(Number(o.cashAmount) || 0),
        title: `${card.address}: they agreed at ${money(o.cashAmount)} — approve it before we ask for the write-up`,
        detail: [`agreed by ${String(agreed.via || "their yes").replace(/_/g, " ")}`, "no write-up ask, no NWMLS, until you approve"].join(" · "),
        ops: [{ key: "approve_number", label: `Approve ${k}`, intent: "primary" }, { key: "open_editor", label: "Open", intent: "secondary" }] }));
    }
    // Our number texted in a plain reply (floatSentAt) went out: not this row,
    // and no timer floats it a second time (2026-10-16).
    if (lane === "ready" && card.ai.made && !(o.sends || []).length && !noFitLive && !o.floatSentAt) {
      card.actionIds.push(push({ ...base, kind: "offer_ready", severity: "soon",
        readyAt: o.autoUnderwrite?.finishedAt || o.createdAt || null,
        title: `${card.address} is priced and nothing has gone out`, why: o.proactive?.skipped?.reason ? String(o.proactive.skipped.reason).slice(0, 140) : "",
        detail: [`cash ${money(o.cashAmount)}`, o.proactive?.skipped?.reason ? `didn't float: ${String(o.proactive.skipped.reason).slice(0, 140)}` : ""].filter(Boolean).join(" · "),
        ops: [{ key: "float_take", label: "Float our read", intent: "primary" }, { key: "float_realm", label: "Float the number", intent: "secondary" }, { key: "open_editor", label: "Open", intent: "secondary" }] }));
    }
    // A hand-made offer, priced a day ago, and nothing of ours has gone out
    // on it — no send, no float, no nudge (2026-10-02: seven sat in Not sent
    // with no row anywhere). Yours: send it, or say you texted it yourself.
    // The machine never floats a hand-made offer (timerMoves skips it).
    if (lane === "ready" && !card.ai.made && !(o.sends || []).length && !o.proactive?.takeCheckAt && !o.proactive?.realmCheckAt && !o.floatSentAt && !(o.followUps || []).length) {
      const pricedMs = ms(o.statusAt) ?? ms(o.createdAt);
      // A week, then it is history, not a decision (2026-10-04: five rows
      // priced 40–69 days ago sat on the Desk).
      if (pricedMs != null && now - pricedMs >= DAY_MS && now - pricedMs <= OFFER_READY_DAYS * DAY_MS) {
        card.actionIds.push(push({ ...base, kind: "offer_ready", severity: "soon", handMade: true, readyAt: new Date(pricedMs).toISOString(),
          title: `${card.address}: priced ${Math.floor((now - pricedMs) / DAY_MS)}d ago and nothing has gone out`,
          detail: `cash ${money(o.cashAmount)} · made by hand`,
          ops: [{ key: "float_take", label: "Float our read", intent: "primary" }, { key: "mark_sent", label: "I sent it myself", intent: "secondary" },
            { key: "float_realm", label: "Float the number", intent: "secondary" }, { key: "mark_we_passed", label: "We passed", intent: "secondary" }] }));
      }
    }
    // A price is agreed and the hot push has asked twice since they last
    // wrote. A third text is not the move (shared/thread-health.js stops the
    // ladder here too); a call is.
    if (isHot(o) && !o.deal && ladders.agent?.enabled && ladders.agent?.ladders?.hot_push?.enabled) {
      const pushes = (o.followUps || []).filter((f) => f?.kind === "hot_push" && (ms(f.at) ?? 0) > (ms(lastInboundAt) ?? 0));
      if (pushes.length >= UNANSWERED_LIMIT) {
        const lastPush = pushes.map((f) => f.at).sort().at(-1);
        // A ladder that repeats keeps checking in once a week (Matt,
        // 2026-10-04): the machine's, with its next date, not a call for you.
        const every = Number(ladders.agent?.ladders?.hot_push?.repeatEvery) || 0;
        card.actionIds.push(push({ ...base, kind: "hot_stalled", severity: every ? "fyi" : "now",
          title: `${card.address}: price agreed, ${pushes.length} pushes and nothing back`,
          detail: `last push ${Math.max(0, Math.floor((now - (ms(lastPush) ?? now)) / DAY_MS))}d ago`,
          why: every ? `checking in every ${every} days` : "the machine has stopped texting; the next move is a call",
          ...(every ? { group: "machine", next: { what: "a status check", at: new Date((ms(lastPush) ?? now) + every * DAY_MS).toISOString() } } : {}),
          ops: [{ key: "open_contact", label: "Open their record", intent: "primary" }, { key: "mark_no_response", label: "Mark no response", intent: "secondary" }] }));
      }
    }
    // About to be signed (2026-10-15): what nobody has looked at yet — the
    // listing remarks, the title, a look inside, the rehab floor, the ARV
    // against today's listings, our number, the deadline, a pre-sell. Seven
    // of eight listed-house contracts fell through on things on this list.
    if (needsPreContract(o, { now })) {
      const checks = preContractByOffer?.[o.id] || preContractChecks({ offer: o });
      const open = openChecks(checks);
      if (open.length) {
        const presold = new Set(o.presell?.contactIds || []).size;
        const presell = !isOffMarket(o) && presold < PRESELL_MIN_BUYERS;
        // One line on the Desk (Matt, 2026-10-18: he won't tick a checklist):
        // the pre-sell is the item a button can do. `checks` stays on the row
        // for the promote's confirm. The pane's Edit offer opens the offer.
        card.actionIds.push(push({ ...base, kind: "pre_contract", severity: o.hot?.signal === "writing_up" ? "now" : "soon",
          title: `${card.address}: before you sign`,
          detail: presell ? `pre-sold to ${presold} of ${PRESELL_MIN_BUYERS} buyers` : "",
          checks,
          ops: [
            ...(presell ? [{ key: "presell", label: `Pre-sell to ${PRESELL_MIN_BUYERS} buyers`, intent: "primary" }] : []),
            { key: "promote_deal", label: "It's signed — promote", intent: presell ? "secondary" : "primary" },
          ] }));
      }
    }
    if (ladderDone && !replied) {
      card.actionIds.push(push({ ...base, kind: "ladder_exhausted", severity: "soon",
        title: `${card.address}: ${sentSteps.length} follow-up${sentSteps.length === 1 ? "" : "s"}, no reply`,
        detail: `sent ${ageDays}d ago`,
        ops: [{ key: "mark_no_response", label: "Mark no response", intent: "primary" }, { key: "float_realm", label: "Float the number again", intent: "secondary" }, { key: "mark_passed", label: "They passed", intent: "danger" }, { key: "mark_we_passed", label: "We passed", intent: "secondary" }] }));
    } else if (!ladderOn && (lane === "sent" || lane === "countered") && card.silentDays >= 14) {
      card.actionIds.push(push({ ...base, kind: "gone_quiet", severity: "fyi",
        title: `${card.address}: nothing for ${card.silentDays} days`, detail: "the follow-up ladder is off for agents",
        ops: [{ key: "mark_no_response", label: "Mark no response", intent: "secondary" }, { key: "float_realm", label: "Float the number again", intent: "secondary" }] }));
    }
    if (card.deal && LIVE_DEAL_STAGES.has(card.deal.stage)) {
      const dd = card.deal;
      if (dd.closingInDays != null && dd.closingInDays <= 7) {
        card.actionIds.push(push({ ...base, kind: "closing_soon", severity: dd.closingInDays < 0 ? "now" : "soon",
          title: dd.closingInDays < 0 ? `${card.address} was due to close ${-dd.closingInDays}d ago` : `${card.address} closes ${dd.closingInDays === 0 ? "today" : `in ${dd.closingInDays}d`}`,
          detail: dd.stage.replace(/_/g, " "),
          ops: [{ key: "mark_closed", label: "Mark closed", intent: "primary" }, { key: "open_deals", label: "Open the deal", intent: "secondary" }, { key: "fell_through", label: "Fell through", intent: "danger" }] }));
      }
      // The closing checklist (shared/deal-checklist.js): one row per deal, for
      // the thing to chase first, once it's overdue or due within two days.
      const cl = resolveChecklist(o.deal, { now });
      if (cl.next && (cl.next.state === "overdue" || cl.next.state === "due_soon")) {
        const n = cl.next;
        const owner = n.owner === "us" ? "Us" : partyName(resolveParties(o, {})[n.owner]) || OWNER_LABEL[n.owner];
        const openHere = cl.open.filter((i) => i.gate === cl.currentGate).length;
        card.actionIds.push(push({ ...base, kind: "closing_task_due", severity: n.state === "overdue" ? "now" : "soon",
          title: `${card.address}: ${n.label}, ${dueWords(n)}`,
          detail: `${owner}${cl.currentGate ? ` · ${openHere} open before ${GATE_LABEL[cl.currentGate]} is done` : ""}`,
          taskId: n.id,
          ops: [{ key: "tick_task", label: "Done", intent: "primary" }, { key: "open_deals", label: "Open the deal", intent: "secondary" }] }));
      }
      // No buyer package a day after contract: every wave's link and every
      // "send me details" is supposed to lead to it.
      if (rooms && dd.stage === "under_contract" && ageDays >= 1 && !rooms.has(o.id)) {
        card.actionIds.push(push({ ...base, kind: "deal_no_dataroom", severity: "soon",
          title: `${card.address} has no buyer package`, detail: `under contract ${ageDays}d · the waves and "send me details" link to it`,
          ops: [{ key: "build_dataroom", label: "Build it", intent: "primary" }, { key: "open_deals", label: "Open the deal", intent: "secondary" }] }));
      }
      const anyBuyer = dd.investors.length > 0;
      const blasts = myEvents.filter((e) => e.type === "blast_sent");
      const views = myEvents.filter((e) => e.type === "dataroom_viewed");
      const warm = dd.investors.some((i) => ["evaluating", "soft_commit", "committed"].includes(i.state));
      if (dd.stage === "under_contract" && !anyBuyer && ageDays >= 2) {
        card.actionIds.push(push({ ...base, kind: "deal_no_buyers", severity: "soon",
          title: `${card.address} has nobody on it`, detail: `under contract ${ageDays}d`,
          ops: [{ key: "match_investors", label: "Find buyers", intent: "primary" }, { key: "open_deals", label: "Open the deal", intent: "secondary" }] }));
      } else if (dd.stage === "under_contract" && blasts.length && !views.length && !warm) {
        const lastBlast = ms(blasts[blasts.length - 1].at);
        const blastDays = lastBlast != null ? Math.floor((now - lastBlast) / DAY_MS) : 0;
        if (blastDays >= 3) {
          // Nudging buyers who never answered is the one thing not to do
          // (Matt, 2026-10-05): the move is more of the right buyers.
          card.actionIds.push(push({ ...base, kind: "blast_no_opens", severity: "soon",
            title: `${card.address}: blasted ${blastDays}d ago, nobody opened it`, detail: `${blasts.length} blast${blasts.length === 1 ? "" : "s"}`,
            ops: [{ key: "match_investors", label: "Find more buyers", intent: "primary" }, { key: "open_deals", label: "Open the deal", intent: "secondary" }] }));
        }
      } else if (dd.stage === "under_contract" && (views.length || dd.investors.some((i) => i.state === "evaluating"))
          && !dd.investors.some((i) => i.state === "soft_commit" || i.state === "committed")) {
        // Buyers looked, and nobody is committing (2026-09-29): until this a
        // deal in that state had no row at all while its contingency ran down.
        const lastWave = ms((o.deal?.blasts || []).at(-1)?.at) ?? ms(blasts.at(-1)?.at);
        const days = lastWave != null ? Math.floor((now - lastWave) / DAY_MS) : null;
        if (days != null && days >= INTEREST_STALL_DAYS) {
          const weighing = dd.investors.filter((i) => i.state === "evaluating").length;
          card.actionIds.push(push({ ...base, kind: "deal_interest_stalled", severity: "soon",
            title: `${card.address}: buyers looked, nobody's committing`,
            detail: `${weighing ? `${weighing} weighing it · ` : ""}${views.length} opened the package · last wave ${days}d ago`,
            ops: [{ key: "match_investors", label: "Find more buyers", intent: "primary" }, { key: "open_deals", label: "Open the deal", intent: "secondary" }] }));
        }
      }
      // The walkthrough (shared/showing.js). Every buyer text invites them to
      // a window, so a deal without one is the first thing to fix; a window
      // in the next day and a half is worth a look at who's coming.
      const sh = dd.showing;
      if (dd.stage === "under_contract" && sh) {
        if (!sh.next && sh.agentAsk !== "asked") {
          card.actionIds.push(push({ ...base, kind: "showing_no_window", severity: "soon",
            title: `${card.address}: no walkthrough window`, detail: "buyers are asked when they could come; get a window from the listing agent",
            ops: [{ key: "ask_agent_window", label: "Ask the agent for a window", intent: "primary" }, { key: "open_deals", label: "Set it on the deal", intent: "secondary" }] }));
        } else if (!sh.next && sh.agentAsk === "asked") {
          const askedDays = ms(sh.askedAt) != null ? Math.floor((now - ms(sh.askedAt)) / DAY_MS) : 0;
          if (askedDays >= 1) {
            card.actionIds.push(push({ ...base, kind: "showing_no_window", severity: "fyi",
              title: `${card.address}: asked the agent for a walkthrough window ${askedDays}d ago`, detail: "set the window on the deal once they answer",
              ops: [{ key: "open_deals", label: "Set it on the deal", intent: "primary" }, { key: "ask_agent_window", label: "Ask again", intent: "secondary" }] }));
          }
        } else if (sh.next && sh.hoursToNext != null && sh.hoursToNext <= 36) {
          // Someone's coming and nobody has said how they get in: that's
          // yours to set, not the machine's (9311 12th Pl SE, 2026-10-05:
          // owner-occupied, a buyer coming at noon, no access on the deal).
          const noWayIn = Boolean(sh.coming) && !sh.accessSet;
          card.actionIds.push(push({ ...base, kind: "showing_soon", severity: sh.coming ? "soon" : "now", ...(noWayIn ? { section: "decide" } : {}),
            title: `${card.address}: walkthrough ${sh.nextLabel}`,
            detail: sh.coming ? `${sh.coming} coming${sh.interested ? ` · ${sh.interested} interested, no time yet` : ""}${sh.accessSet ? "" : " · access not set"}` : "nobody has said they're coming",
            ops: [{ key: "open_deals", label: "Open the deal", intent: "primary" }] }));
        }
      }
      if (dd.stage === "under_contract" && dd.investors.some((i) => i.state === "committed")) {
        card.actionIds.push(push({ ...base, kind: "stage_lag", severity: "fyi",
          title: `${card.address} has a committed buyer but is still under contract`, detail: "",
          ops: [{ key: "advance", label: "Move to buyer found", intent: "primary" }] }));
      }
      // The assignment came back signed (the closing checklist's
      // assignment_signed, ticked): the deal is assigned. Before 2026-10-02
      // nothing said so and every stage past buyer found was moved by hand.
      if (dd.stage === "buyer_found" && resolveChecklist(o.deal, { now }).items.some((i) => i.id === "assignment_signed" && i.done)) {
        card.actionIds.push(push({ ...base, kind: "stage_lag", severity: "soon", advanceTo: "assigned",
          title: `${card.address}: the assignment is signed — it's assigned`, detail: "the closing checklist says the assignee signed",
          ops: [{ key: "advance", label: "Move to assigned", intent: "primary" }] }));
      }
    }

    counts.lanes[card.lane]++;
    if (lane === "dead") counts.hidden.dead++;
    if (lane === "closed") counts.hidden.closed++;
    cards.push(card);
  }

  /* --- underwrites in flight: cards with no row yet --- */
  const known = new Set(offers.map((o) => o.id));
  for (const j of jobs) {
    if (!j) continue;
    if ((j.status === "queued" || j.status === "running") && !(j.offerId && known.has(j.offerId))) {
      const sinceMs = ms(j.startedAt) ?? now;
      cards.push({
        id: `job:${j.id}`, kind: "job", lane: "underwriting", side: "agent", offerId: j.offerId || null, jobId: j.id,
        contactId: j.contactId || null, contactName: j.contactName || contactNames[j.contactId] || "",
        address: j.address || j.suppliedAddress || "", cashAmount: 0, askingPrice: round(j.askingPrice),
        status: j.status, stageSince: j.startedAt || null, ageDays: Math.max(0, Math.floor((now - sinceMs) / DAY_MS)),
        ai: { made: true, held: [] }, chips: [{ key: "phase", label: j.phase || j.status, tone: "neutral" }, ...(j.dryRun ? [{ key: "dry", label: "dry run", tone: "warn" }] : [])],
        draftIds: [], lastInboundAt: null, silentDays: 0, expiresAt: null, expiresInDays: null, deal: null, deadReason: null, actionIds: [],
      });
      counts.lanes.underwriting++;
    }
    if (j.status === "error" && ms(j.finishedAt) != null && now - ms(j.finishedAt) < 3600000) {
      push({ kind: "underwrite_failed", severity: "fyi", jobId: j.id, error: String(j.error || "").slice(0, 160), askingPrice: Number(j.askingPrice) || 0, contactId: j.contactId || null, contactName: j.contactName || "",
        address: j.address || j.suppliedAddress || "", offerId: j.offerId || null,
        title: `Underwrite failed on ${j.address || j.suppliedAddress || "an address"}`, detail: String(j.error || "").slice(0, 160),
        // The run is still in memory for the hour this row lives, so Retry
        // is the strip's own retry; a saved draft can be opened and finished.
        ops: [
          ...(j.contactId ? [{ key: "retry_underwrite", label: "Retry", intent: "primary" }] : []),
          ...(j.contactId && j.offerId ? [{ key: "open_editor", label: "Open what loaded", intent: "secondary" }] : []),
        ] });
    }
  }

  /* --- underwrites that left the queue without running --- */
  // An address that waited past the daily cap and never ran
  // (auto-underwrite.js drainUnderwriteQueue). Until 2026-09-29 that was a
  // console line: the house was simply never priced. The row stays for a week,
  // or until this agent has an offer on that house made after the drop.
  for (const e of events) {
    if (e?.type !== "underwrite_dropped" || !e.contactId) continue;
    const dropped = ms(e.at);
    if (dropped == null || now - dropped > 7 * DAY_MS) continue;
    const key = e.address ? addressKey(e.address) : "";
    const priced = offers.some((o) => o?.contactId === e.contactId && (!key || addressKey(o.address || "") === key) && (ms(o.createdAt) ?? 0) > dropped);
    if (priced) continue;
    push({ id: `underwrite_dropped:${e.contactId}:${key}:${e.at}`, kind: "underwrite_dropped", severity: "soon",
      contactId: e.contactId, contactName: contactNames[e.contactId] || "", address: e.address || "", offerId: null, askingPrice: 0,
      title: `Never underwrote ${String(e.address || "an address").split(",")[0]}`,
      detail: String(e.data?.reason || "it left the underwrite queue without running").slice(0, 160),
      ops: e.address ? [{ key: "rerun_held", label: "Run it now", intent: "primary" }] : [] });
  }

  /* --- their texts go to another number --- */
  // Their phone answered with an auto-reply naming another number to text
  // (2026-10-14: Redfin's "we use a different number for texting"). Nothing
  // we send reaches them until the contact's number changes, which is yours.
  // The row stays a month, or until they write back for real.
  const elsewhere = new Map();
  for (const e of events) {
    if (e?.type !== "texts_elsewhere" || !e.contactId) continue;
    if (String(e.at) > String(elsewhere.get(e.contactId)?.at || "")) elsewhere.set(e.contactId, e);
  }
  for (const [contactId, e] of elsewhere) {
    const at = ms(e.at);
    if (at == null || now - at > 30 * DAY_MS) continue;
    if (events.some((x) => x?.contactId === contactId && x.type === "text_summary" && String(x.at) > String(e.at))) continue;
    const other = String(e.data?.otherNumber || "").slice(0, 20);
    push({ id: `texts_elsewhere:${contactId}:${e.at}`, kind: "texts_elsewhere", severity: "soon", group: "yours",
      contactId, contactName: contactNames[contactId] || "", address: "", offerId: null, askingPrice: 0,
      title: `${contactNames[contactId] || "An agent"}: their texts go to another number`,
      detail: other ? `an auto-reply says to text ${other} — update their number in GHL, or call` : "an auto-reply answered — update their number in GHL, or call",
      ops: [] });
  }

  /* --- drafts: waiting, scheduled, and the hand-offs riding on them --- */
  const cardById = new Map(cards.map((c) => [c.id, c]));
  for (const d of openDrafts) {
    const oid = draftOfferId(d, byContact, offers);
    const card = oid ? cardById.get(oid) : null;
    const base = { offerId: oid || null, draftId: d.id, contactId: d.contactId || null, contactName: d.contactName || "",
      address: d.propertyAddress || card?.address || "" };
    const never = (NEVER_AUTO[d.party] || []).includes(d.intent);
    const x = d.exception;
    if (d.status === "draft") {
      // Their yes landed on a house we passed on (2026-10-15): the most
      // important row of the day, said plainly.
      const yesAfter = d.yesAfterPass?.offerId ? d.yesAfterPass : null;
      const hot = never || (x && !x.passed) || Boolean(yesAfter);
      const title = yesAfter
        ? `They said yes after we passed: ${d.contactName || "an agent"} on ${String(yesAfter.address || base.address || "the house").split(",")[0]}`
        : x && !x.passed && x.theirAmount && x.ceiling
        ? `Counter ${money(x.theirAmount)} is ${money(x.theirAmount - x.ceiling)} over the ${money(x.ceiling)} ceiling`
        : d.outbound?.forMatt ? `Matt's 15: ${d.contactName || "an agent"}, a check-in to make your own`
        : `${d.contactName || "Someone"}: ${String(d.intent || "reply").replace(/_/g, " ")}`;
      const id = push({ ...base, kind: "draft_waiting", severity: hot ? "now" : "soon", title,
        ...(yesAfter ? { yesAfterPass: true } : {}),
        detail: yesAfter
          ? `they took our ${money(yesAfter.amount)} after we marked it we passed — reopen it, or tell them yourself; the bot's reply waits for you`
          : x && !x.passed ? (x.basis || x.reason || "") : (d.autoSend?.reason || ""), ops: [] });
      if (card) card.actionIds.push(id);
    } else if (d.status === "scheduled" && d.outbound?.kind === "blast_open") {
      // A blast is one decision, not two hundred rows: one line per deal.
      const key = `blast:${d.outbound.offerId || d.propertyAddress || "deal"}`;
      const existing = actions.find((a) => a.id === key);
      if (existing) { existing.count++; existing.title = `Blast on ${existing.address || "a deal"}: ${existing.count} texts sending themselves`; }
      else {
        const id = push({ ...base, id: key, kind: "draft_scheduled", severity: "fyi", count: 1,
          address: d.outbound.address || base.address, title: `Blast on ${d.outbound.address || base.address || "a deal"}: 1 text sending itself`, detail: "staggered over the auto-send hours",
          next: { what: "the blast sends itself, staggered over the auto-send hours", at: d.sendAt || null }, ops: [] });
        if (card) card.actionIds.push(id);
      }
    } else if (d.status === "scheduled") {
      const id = push({ ...base, kind: "draft_scheduled", severity: "fyi",
        title: `${d.contactName || "Someone"}: sends itself${d.sendAt ? ` at ${d.sendAt}` : ""}`, detail: "",
        next: { what: "sends itself", at: d.sendAt || null }, ops: [] });
      if (card) card.actionIds.push(id);
    }
    for (const a of d.actions || []) {
      // The hand-offs: the structurally ask-only actions, plus the offer
      // documents when their own switch says ask.
      if (a?.status !== "pending" || !(ASK_ONLY_ACTIONS.has(a.type) || (a.type === "send_offer" && a.mode !== "auto"))) continue;
      const id = push({ ...base, kind: "handoff", severity: "now", actionId: a.id,
        title: ACTION_LABEL[a.type] || String(a.type).replace(/_/g, " "),
        detail: a.why || (base.address ? `on ${base.address}` : ""),
        ops: [{ key: "apply", label: "Do it", intent: "primary" }, { key: "show_draft", label: "See the draft", intent: "secondary" }] });
      if (card) card.actionIds.push(id);
    }
  }

  /* cold agents: reached out from the app, the ladder ran out, nothing back */
  // Counted, not queued: there is nothing for a person to do about an agent
  // who never answered, so it is a number on Reports and not a row on Today.
  // The moment they answer they leave the count; the moment we offer on
  // something, they have a card.
  const outreachLadder = ladders.agent?.ladders?.outreach_nudge || null;
  if (ladders.agent?.enabled && outreachLadder?.enabled) {
    const cold = new Map();
    for (const e of events) {
      if (!e?.contactId) continue;
      if (e.type === "outreach_sent" || (e.type === "follow_up_sent" && e.data?.kind === "outreach_nudge")
          || e.type === "text_summary" || e.type === "call_summary") {
        if (!cold.has(e.contactId)) cold.set(e.contactId, []);
        cold.get(e.contactId).push(e);
      }
    }
    for (const [contactId, list] of cold) {
      if (byContact.has(contactId)) continue;                 // they have an offer now
      list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
      const opened = list.filter((e) => e.type === "outreach_sent").at(-1);
      if (!opened) continue;
      const answered = list.some((e) => (e.type === "text_summary" || e.type === "call_summary") && String(e.at) > String(opened.at));
      if (answered) continue;
      const sentSteps = list.filter((e) => e.type === "follow_up_sent" && String(e.at) > String(opened.at)).map((e) => Number(e.data?.step));
      if (!exhausted({ steps: outreachLadder.steps, sentSteps, startedAt: opened.at, now })) continue;
      counts.coldNoReply++;
    }
  }

  /* --- promises we made and haven't kept (promise-sweep.js) --- */
  // Owed until a promise_kept for that contact lands after it; three days on,
  // the thread has moved and the row would only be noise. Each row carries
  // the machine's own next move (promise-resolver.js) and the button for it;
  // a promise that was never owed is not a row at all.
  for (const p of openPromises(events, { now })) {
    if (!p.owedAt) continue;
    const mine = byContact.get(p.contactId) || [];
    const v = resolvePromise({
      promise: p, offers: mine, jobs,
      drafts: [...sentDrafts, ...drafts].filter((d) => d?.contactId === p.contactId),
      heldTriageByOffer, events, qualifyFirst: Boolean(config?.parties?.agent?.qualifyFirst?.enabled), now,
    });
    if (v.move === "not_owed") continue;
    // The investor book only knows buyers; an agent's name is on their
    // offers and on the drafts in their thread.
    const named = contactNames[p.contactId] || mine.find((o) => o?.contactName)?.contactName
      || [...sentDrafts, ...drafts].find((d) => d?.contactId === p.contactId && d.contactName)?.contactName || "";
    const who = named || "An agent";
    const heldReason = v.offerId && ["rerun", "ask_numbers", "yours", "wait"].includes(v.move) && mine.some((o) => o.id === v.offerId && aiHoldReasons(o).length)
      ? String(aiHoldReasons(mine.find((o) => o.id === v.offerId))[0]).split(" — ")[0].slice(0, 120) : "";
    // A question the bot couldn't answer: the row is the question, with a
    // box. What they asked is the inbound of the reply that deflected.
    const theirs = [...sentDrafts, ...drafts].filter((d) => d?.contactId === p.contactId);
    const from = v.kind === "partner_answer" ? (theirs.find((d) => d.id === p.draftId) || null) : null;
    const question = from ? questionIn(from.inbound) : "";
    const moveOps = question ? [{ key: "answer", label: "Answer", intent: "primary" }] : (PROMISE_OPS[v.move] || []);
    // Where the row sits. You stopped it: yours, with Resume. Waiting on an
    // underwrite or on them: the machine's. A move the driver will make when
    // it is switched on: the machine's, with Stop. A hold nobody's numbers
    // clear: stuck. Everything else: yours.
    const hold = botHold({ events: events.filter((e) => e?.contactId === p.contactId), now });
    const stopped = hold.held;
    const driving = Boolean(config?.enabled && config?.driver?.promises?.enabled) && Boolean(DRIVER_NEXT[v.move]);
    const group = stopped ? "yours" : v.move === "wait" || driving ? "machine" : v.move === "yours" && v.offerId ? "stuck" : "yours";
    const next = group === "machine" ? { what: v.move === "wait" ? (v.reason || "waiting") : DRIVER_NEXT[v.move], at: null } : null;
    const ops = [...moveOps,
      ...(stopped ? [{ key: "resume_drive", label: "Resume", intent: "secondary" }] : []),
      ...(group === "machine" && driving ? [{ key: "stop_drive", label: "Stop", intent: "secondary" }] : [])];
    push({ id: `promise_owed:${p.contactId}:${p.owedAt}`, kind: "promise_owed", severity: "now", contactId: p.contactId, contactName: named,
      address: p.address || "", offerId: v.offerId || null, move: v.move, why: v.reason || "", askingPrice: v.askingPrice || 0,
      draftId: null, fromDraftId: p.draftId || null, ...(question ? { question } : {}), group, ...(next ? { next } : {}),
      title: `${who}: we owe them ${p.what === "number" ? "a number" : p.what === "paper" ? "the written offer" : "an answer"}${p.address ? ` on ${String(p.address).split(",")[0]}` : ""}`,
      detail: [stopped ? (hold.kind === "paused" ? holdLine(hold) : `you stopped it${hold.reason ? `: ${hold.reason.slice(0, 80)}` : ""}`) : "", PROMISE_MOVE_LABEL[v.move] || "", heldReason ? `underwrite held: ${heldReason}` : "", p.text ? `we said "${String(p.text).slice(0, 90)}"` : ""].filter(Boolean).join(" · "),
      // Settled some other way (a call, a no that never reached the offer):
      // the row can always be closed by hand, with why. Marking the offer
      // sent / passed closes it too.
      ops: [...ops.filter((o) => v.offerId || !NEEDS_OFFER.has(o.key)), { key: "dismiss_promise", label: "Dismiss" }] });
  }

  /* --- a number or the offer we promised, still owed a day on (2026-10-14) --- */
  // The row above lasts three days. This one lasts until the number goes
  // out, we pass, or you dismiss it (promise-owed.js owedPromises): the
  // agents we promised were the ones answering us. While the row above is
  // up for someone, it speaks for them.
  const promiseRowFor = new Set(actions.filter((a) => a.kind === "promise_owed").map((a) => a.contactId));
  for (const p of owedPromises({ events, sentDrafts, offers, now })) {
    if (promiseRowFor.has(p.contactId)) continue;
    const mine = byContact.get(p.contactId) || [];
    const theirs = [...sentDrafts, ...drafts].filter((d) => d?.contactId === p.contactId);
    const v = resolvePromise({ promise: { ...p, asksThem: false, owedAt: null }, offers: mine, jobs, drafts: theirs,
      heldTriageByOffer, events, qualifyFirst: Boolean(config?.parties?.agent?.qualifyFirst?.enabled), now });
    if (v.move === "not_owed") continue;
    const named = contactNames[p.contactId] || mine.find((o) => o?.contactName)?.contactName || theirs.find((d) => d.contactName)?.contactName || "";
    const first = String(named).trim().split(/\s+/)[0] || "";
    const street = p.address ? String(p.address).split(",")[0] : "";
    const heldOffer = v.offerId ? mine.find((o) => o.id === v.offerId && aiHoldReasons(o).length) : null;
    const days = Math.floor((now - (ms(p.since) ?? now)) / DAY_MS);
    push({ id: `number_owed:${p.contactId}:${p.since}`, kind: "number_owed", severity: "now", contactId: p.contactId, contactName: named,
      address: p.address || "", offerId: v.offerId || null, move: v.move, why: v.reason || "", askingPrice: v.askingPrice || 0,
      draftId: null, fromDraftId: p.draftId || null, promisedAt: p.lastAt,
      // An underwrite still running is the machine's; everything else waits on you.
      group: v.move === "wait" ? "machine" : "yours", ...(v.move === "wait" ? { next: { what: v.reason || "waiting", at: null } } : {}),
      title: `Owed: ${p.what === "paper" ? "the written offer" : "a number"} to ${first || "an agent"}${street ? ` on ${street}` : ""}`,
      detail: [`promised ${p.dates.join(", again ")}`, days >= 2 ? `${days} days ago` : "", PROMISE_MOVE_LABEL[v.move] || "",
        heldOffer ? `underwrite held: ${String(aiHoldReasons(heldOffer)[0]).split(" — ")[0].slice(0, 120)}` : "",
        p.text ? `we said "${String(p.text).slice(0, 90)}"` : p.by === "you" ? "you said it yourself" : ""].filter(Boolean).join(" · "),
      ops: [...(PROMISE_OPS[v.move] || []).filter((o) => v.offerId || !NEEDS_OFFER.has(o.key)), { key: "dismiss_promise", label: "Dismiss" }] });
  }

  /* --- a call, a time to walk it, the earnest money we promised (2026-10-15) --- */
  // Only a person keeps these (promise-owed.js owedPersonPromises). A call is
  // a Call row at the top of the day's calls; the other two are owed rows
  // like the number above, until they're kept or you dismiss them.
  for (const p of owedPersonPromises({ events, sentDrafts, offers, now })) {
    const mine = byContact.get(p.contactId) || [];
    const theirs = [...sentDrafts, ...drafts].filter((d) => d?.contactId === p.contactId);
    const named = contactNames[p.contactId] || mine.find((o) => o?.contactName)?.contactName || theirs.find((d) => d.contactName)?.contactName || "";
    const first = String(named).trim().split(/\s+/)[0] || "";
    const street = p.address ? String(p.address).split(",")[0] : "";
    const v = resolvePromise({ promise: { ...p, asksThem: false, owedAt: null }, offers: mine, drafts: theirs, now });
    const offer = p.address ? mine.find((o) => o?.address && streetKey(o.address) === streetKey(p.address)) : null;
    const days = Math.floor((now - (ms(p.since) ?? now)) / DAY_MS);
    const detail = [`promised ${p.dates.join(", again ")}`, days >= 2 ? `${days} days ago` : "",
      p.text ? `we said "${String(p.text).slice(0, 90)}"` : p.by === "you" ? "you said it yourself" : ""].filter(Boolean).join(" · ");
    const base = { contactId: p.contactId, contactName: named, address: p.address || "", offerId: offer?.id || null, move: v.move, why: v.reason || "",
      draftId: null, fromDraftId: p.draftId || null, promisedAt: p.lastAt, severity: "now", group: "yours",
      title: `Owed: ${PERSON_PROMISE_WORDS[p.what]} to ${first || "an agent"}${street ? ` on ${street}` : ""}`, detail };
    if (v.move === "call_owed") {
      push({ ...base, id: `call_owed:${p.contactId}:${p.since}`, kind: "call_owed", section: "call", score: CALL_OWED_SCORE,
        call: { reason: "call_owed", why: "we said we'd call them", since: p.since, tries: 0, houses: [],
          goal: `We told them we'd call${street ? ` about ${street}` : ""} (${detail}). Make the call, or text them a time that works and keep it.`,
          opener: `Hi ${first || "there"}, it's Matt — calling like I said I would${street ? ` about ${street}` : ""}.` },
        ops: [{ key: "dismiss_promise", label: "Dismiss" }] });
    } else {
      push({ ...base, id: `number_owed:${p.contactId}:${p.what}:${p.since}`, kind: "number_owed", what: p.what,
        ops: [...(offer ? [{ key: "open_editor", label: "Open the offer", intent: "secondary" }] : []), { key: "dismiss_promise", label: "Dismiss" }] });
    }
  }

  // Timers: rows the machine clears by itself after a wait (driver.timers).
  // The row says what happens and when, and sits with the machine's.
  for (const m of timerMoves(actions, { config, now })) {
    const a = actions.find((x) => x.id === m.actionId);
    if (!a) continue;
    counts.actions.byGroup[a.group]--;
    a.group = "machine"; a.next = { what: m.what, at: m.due ? null : m.dueAt };
    counts.actions.byGroup.machine++;
  }

  actions.sort((a, b) => (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]) || String(a.title).localeCompare(String(b.title)));
  cards.sort((a, b) => b.ageDays - a.ageDays);

  const lanes = ALL_LANES.map((l) => ({ ...l, count: counts.lanes[l.key], cardIds: cards.filter((c) => c.lane === l.key).map((c) => c.id) }));
  return { lanes, cards, actions, counts };
}

/* ---------- timers ---------- */

// A failure that was the network's or the model's, not the house's: worth one
// more try. A scan cut short at the token limit says "try again" itself.
const RETRYABLE_ERROR = /timed?\s?out|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|socket hang up|\b50[0234]\b|\b429\b|rate.?limit|overloaded|output truncated/i;

/**
 * timerMoves(actions, { config, now }) → [{ actionId, kind, move, what, dueAt, due, offerId, jobId, contactId, address }]
 *
 * What the machine does by itself about a row, and when (driver.timers, off
 * by default). One table for the row's "Next:" line and for the runner
 * (ghl-broker/today-timers.js), so they can never disagree.
 *
 *   offer_ready        floated `floatAfterHours` after it was priced. Never
 *                      when the float was skipped: that row is stuck, with why.
 *   gone_quiet         marked no response (the row only exists once they have
 *                      been silent `goneQuietDays` with the ladder off).
 *   underwrite_failed  retried, once, when the failure was the network's.
 *
 * Deliberately not here: `ladder_exhausted` (the follow-up sweep already
 * marks no response unless the ladder says "stop", and "stop" is a setting,
 * not an oversight); `blast_no_opens` (the dispo sweep's next wave is the
 * move — buyers who never answered are not nudged); closings, hand-offs, deals with
 * no buyers and failed bands, which are a person's.
 */
export function timerMoves(actions = [], { config = null, now = Date.now() } = {}) {
  const t = config?.driver?.timers;
  if (!config?.enabled || !t?.enabled) return [];
  const out = [];
  for (const a of actions) {
    const base = { actionId: a.id, kind: a.kind, offerId: a.offerId || null, jobId: a.jobId || null, contactId: a.contactId || null, address: a.address || "" };
    // A hand-made offer is never floated by the machine: it's yours.
    if (a.kind === "offer_ready" && !a.why && a.offerId && !a.handMade) {
      const dueMs = (ms(a.readyAt) ?? now) + t.floatAfterHours * 3600000;
      out.push({ ...base, move: "float", what: "floats the number", dueAt: new Date(dueMs).toISOString(), due: dueMs <= now });
    } else if (a.kind === "gone_quiet" && a.offerId) {
      out.push({ ...base, move: "mark_no_response", what: "marks it no response on the next pass", dueAt: new Date(now).toISOString(), due: true });
    } else if (a.kind === "underwrite_failed" && a.contactId && a.address && RETRYABLE_ERROR.test(a.error || "")) {
      out.push({ ...base, move: "retry_underwrite", what: "retries the underwrite once", dueAt: new Date(now).toISOString(), due: true, askingPrice: a.askingPrice || 0 });
    }
  }
  return out;
}

/* ---------- placement ---------- */

/**
 * laneFor(offer) → { lane, side, stageSince, deadReason? } | null
 *
 * The board's placement for one offer, on its own — the GHL mirror asks
 * this so it never re-derives what the board already decided.
 */
export function laneFor(o) {
  if (!o?.id) return null;
  const status = effectiveStatus(o);
  if (status === "draft" && !isAiGenerated(o)) return null;
  const aiHeld = needsAiReview(o) && aiHoldReasons(o).length > 0;
  return placeOffer(o, { status, aiHeld });
}

// Lane is a function of recorded state only: the deal stage, the AI hold,
// the status you set. The clock never moves a card (see the expiry chip).
function placeOffer(o, { status, aiHeld }) {
  const d = o.deal;
  if (d) {
    const since = (d.stageHistory || []).filter((h) => h?.ts).at(-1)?.ts || d.updatedAt || d.createdAt || o.statusAt || o.createdAt;
    if (LIVE_DEAL_STAGES.has(d.stage)) return { lane: d.stage, side: "dispo", stageSince: since };
    if (d.stage === "closed") return { lane: "closed", side: "dispo", stageSince: since };
    return { lane: "dead", side: "dispo", stageSince: since, deadReason: "fell_through" };
  }
  if (aiHeld) return { lane: "needs_review", side: "agent", stageSince: o.autoUnderwrite?.finishedAt || o.autoUnderwrite?.startedAt || o.createdAt };
  if (status === "draft") return null;
  if (DEAD_STATUSES.has(status)) return { lane: "dead", side: "agent", stageSince: o.statusAt || o.createdAt, deadReason: status };
  if (status === "countered") return { lane: "countered", side: "agent", stageSince: o.statusAt || o.counter?.at || o.createdAt };
  if (status === "sent") {
    const last = (o.sends || []).filter((s) => s?.ts).map((s) => s.ts).sort().at(-1);
    return { lane: "sent", side: "agent", stageSince: last || o.statusAt || o.createdAt };
  }
  if (status === "accepted") return { lane: "countered", side: "agent", stageSince: o.statusAt || o.createdAt }; // accepted without a deal: rare, keep visible
  const t = ms(o.proactive?.takeCheckAt), r = ms(o.proactive?.realmCheckAt);
  if (t != null || r != null) return { lane: "floated", side: "agent", stageSince: new Date(Math.max(t ?? 0, r ?? 0)).toISOString() };
  return { lane: "ready", side: "agent", stageSince: o.createdAt };
}

/* ---------- events ---------- */

function indexEvents(events) {
  const byOffer = new Map();
  const byStreet = new Map();
  const lastInbound = new Map();
  for (const e of events) {
    if (!e?.type) continue;
    if ((e.type === "text_summary" || e.type === "call_summary") && e.contactId) {
      const prev = lastInbound.get(e.contactId);
      if (!prev || String(e.at) > String(prev)) lastInbound.set(e.contactId, e.at);
      continue;
    }
    if (e.offerId) {
      if (!byOffer.has(e.offerId)) byOffer.set(e.offerId, []);
      byOffer.get(e.offerId).push(e);
    } else if (e.address) {
      // A blast carries the street line as its label and no offer id.
      const k = streetKey(e.address);
      if (!byStreet.has(k)) byStreet.set(k, []);
      byStreet.get(k).push(e);
    }
  }
  return { byOffer, byStreet, lastInbound };
}

function investorChips(deal, myEvents, contactNames) {
  const state = new Map();
  const set = (contactId, s, at, extra = {}) => {
    if (!contactId) return;
    const cur = state.get(contactId);
    if (!cur || INVESTOR_RANK[s] > INVESTOR_RANK[cur.state] || (INVESTOR_RANK[s] === INVESTOR_RANK[cur.state] && String(at) > String(cur.at))) {
      state.set(contactId, { ...(cur || {}), state: s, at: at || cur?.at || null, ...extra });
    } else if (extra.viewCount != null) {
      state.set(contactId, { ...cur, viewCount: extra.viewCount });
    }
  };
  for (const e of myEvents) {
    if (e.type === "blast_sent") set(e.contactId, "blasted", e.at);
    else if (e.type === "dataroom_sent") set(e.contactId, "sent", e.at);
    else if (e.type === "dataroom_viewed") set(e.contactId, "opened", e.at, { viewCount: Number(e.data?.viewCount) || undefined });
  }
  for (const i of deal.investors || []) {
    if (!i?.contactId) continue;
    set(i.contactId, investorStatus(i.status), i.updatedAt || i.addedAt, { name: i.name });
  }
  return [...state.entries()]
    .map(([contactId, s]) => ({ contactId, name: s.name || contactNames[contactId] || "buyer", state: s.state, at: s.at, viewCount: s.viewCount ?? null }))
    .sort((a, b) => INVESTOR_ORDER.indexOf(a.state) - INVESTOR_ORDER.indexOf(b.state) || String(a.name).localeCompare(String(b.name)));
}

/* ---------- drafts ---------- */

/**
 * draftOfferId(draft, byContact, offers) → offerId | null
 *
 * The offer a draft is about: the one it names, else the same contact's offer
 * at the address it mentions, else the contact's only live offer. Anything
 * less certain stays unattached — it is still in the queue, just not pinned
 * to a card.
 */
export function draftOfferId(draft, byContact, offers = []) {
  if (draft?.outbound?.offerId) return draft.outbound.offerId;
  const mine = byContact.get(draft?.contactId) || [];
  if (!mine.length) return null;
  const want = addressKey(draft?.propertyAddress || "");
  if (want) {
    const hit = mine.find((o) => addressKey(o.address) === want) || mine.find((o) => streetKey(o.address) === streetKey(draft.propertyAddress));
    if (hit) return hit.id;
  }
  const live = mine.filter((o) => !DEAD_STATUSES.has(effectiveStatus(o)) && effectiveStatus(o) !== "draft");
  return live.length === 1 ? live[0].id : null;
}

/* ---------- dates ---------- */

// Whole days until a yyyy-mm-dd, treating the date as the end of that local
// day the way the Deals page does — "closes in 0d" means today.
export function daysUntilYmd(ymd, now = Date.now()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ""));
  if (!m) return null;
  const then = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date(now);
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((then - todayUtc) / DAY_MS);
}
