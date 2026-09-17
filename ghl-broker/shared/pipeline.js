// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

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
  effectiveStatus, isExpired, offerExpiresAt, investorStatus, needsAiReview, aiHoldReasons, isAiGenerated,
  DEAD_STATUSES, LIVE_DEAL_STAGES,
  offerHeat,
} from "./offer-status.js";
import { stepLabel, exhausted, normalizeSteps, questionIn } from "./follow-up.js";
import { NEVER_AUTO, ASK_ONLY_ACTIONS, ACTION_LABEL } from "./conversation-ai.js";
import { addressKey } from "./contact-record.js";
import { openPromises, resolvePromise } from "./promise-resolver.js";

const DAY_MS = 86400000;
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };
const round = (v) => Math.round(Number(v) || 0);
const money = (n) => `$${round(n).toLocaleString("en-US")}`;
const streetKey = (address) => addressKey(String(address || "").split(",")[0]);

/* ---------- the vocabulary ---------- */

export const AGENT_LANES = [
  { key: "underwriting", label: "Underwriting", hint: "the robot is pricing it right now" },
  { key: "needs_review", label: "Needs review", hint: "an underwrite stopped on a quality gate" },
  { key: "ready",        label: "Not sent",     hint: "priced, nothing has gone out" },
  { key: "floated",      label: "Floated",      hint: "our read or a soft number is out; waiting on theirs" },
  { key: "sent",         label: "Sent",         hint: "the offer is with the agent" },
  { key: "countered",    label: "Countered",    hint: "they came back with a number" },
  { key: "hot",          label: "Hot",          hint: "close to a contract — the price is agreed, or you flagged it" },
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

// The order the queue shows its groups in, and what each is called.
export const ACTION_KINDS = [
  { key: "promise_owed",      label: "Owed a number" },
  { key: "draft_waiting",     label: "Drafts waiting on you" },
  { key: "handoff",           label: "One click from you" },
  { key: "closing_soon",      label: "Closing" },
  { key: "underwrite_held",   label: "Underwrites that need a look" },
  { key: "offer_ready",       label: "Priced, not floated" },
  { key: "ladder_exhausted",  label: "Followed up, no reply" },
  { key: "deal_no_buyers",    label: "Deals with nobody on them" },
  { key: "blast_no_opens",    label: "Blasted, nobody opened it" },
  { key: "draft_scheduled",   label: "Sending itself" },
  { key: "stage_lag",         label: "Stage is behind" },
  { key: "gone_quiet",        label: "Gone quiet" },
  { key: "underwrite_failed", label: "Underwrites that failed" },
];

// Investor state on a deal card, and its precedence. A buyer who committed
// is committed whatever else the events say; a buyer who only got a blast is
// the coldest thing on the card.
// A soft commit sits just under committed: it outranks evaluating (it is the
// most it can be without being signed) and loses to the real thing.
const INVESTOR_RANK = { committed: 7, soft_commit: 6, passed: 5, evaluating: 4, opened: 3, sent: 2, blasted: 1 };
const INVESTOR_ORDER = ["committed", "soft_commit", "evaluating", "opened", "sent", "blasted", "passed"];

// What a promise row offers for each of the resolver's moves. `wait`,
// `ask_numbers` and `start_underwrite` have no button yet: the row says so.
const PROMISE_OPS = {
  send_number: [{ key: "float_take", label: "Float our read", intent: "primary" }, { key: "float_realm", label: "Float the number", intent: "secondary" }],
  rerun: [{ key: "rerun_held", label: "Re-run on their numbers", intent: "primary" }, { key: "open_editor", label: "Open and fix", intent: "secondary" }],
  ask_numbers: [{ key: "open_editor", label: "Open and fix", intent: "secondary" }],
  wait: [],
  start_underwrite: [],
  yours: [{ key: "open_editor", label: "Open and fix", intent: "primary" }],
};
const NEEDS_OFFER = new Set(["float_take", "float_realm", "rerun_held", "open_editor"]);
const PROMISE_MOVE_LABEL = {
  send_number: "the number is ready and hasn't gone out",
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
 */
export function buildPipeline({
  offers = [], drafts = [], events = [], jobs = [], config = null, contactNames = {},
  sentDrafts = [], heldTriageByOffer = {},
  now = Date.now(), eventsLimit = 0,
} = {}) {
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
    actions: { now: 0, soon: 0, fyi: 0 },
    hidden: { dead: 0, closed: 0, drafts: 0 },
    coldNoReply: 0,
    eventsTruncated: eventsLimit > 0 && events.length >= eventsLimit,
  };
  const push = (a) => {
    a.id = a.id || `${a.kind}:${a.offerId || a.draftId || a.jobId || a.contactId}`;
    actions.push(a);
    counts.actions[a.severity]++;
    return a.id;
  };

  // Offers by contact, for attaching drafts that name no offer.
  const byContact = new Map();
  for (const o of offers) {
    if (!o?.contactId) continue;
    if (!byContact.has(o.contactId)) byContact.set(o.contactId, []);
    byContact.get(o.contactId).push(o);
  }
  // Drafts by offer, resolved once.
  const draftsByOffer = new Map();
  const unattached = [];
  for (const d of openDrafts) {
    const oid = draftOfferId(d, byContact, offers);
    if (oid) { if (!draftsByOffer.has(oid)) draftsByOffer.set(oid, []); draftsByOffer.get(oid).push(d); }
    else unattached.push(d);
  }

  /* --- one card per offer --- */
  for (const o of offers) {
    if (!o?.id) continue;
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
      };
      if (closingInDays != null && closingInDays <= 7 && LIVE_DEAL_STAGES.has(d.stage)) {
        card.chips.push({ key: "closing", label: closingInDays < 0 ? `closing ${-closingInDays}d overdue` : closingInDays === 0 ? "closes today" : `closes in ${closingInDays}d`, tone: closingInDays < 0 ? "bad" : "warn" });
      }
    }

    /* actions on this card */
    const base = { offerId: o.id, contactId: card.contactId, contactName: card.contactName, address: card.address };
    if (aiHeld) {
      card.actionIds.push(push({ ...base, kind: "underwrite_held", severity: "soon",
        title: `Underwrite held on ${card.address}`, detail: held.join(" · "),
        ops: [{ key: "open_editor", label: "Open and fix", intent: "primary" }, { key: "drop", label: "Drop it", intent: "danger" }] }));
    }
    if (lane === "ready" && card.ai.made && !(o.sends || []).length) {
      card.actionIds.push(push({ ...base, kind: "offer_ready", severity: "soon",
        title: `${card.address} is priced and nothing has gone out`,
        detail: [`cash ${money(o.cashAmount)}`, o.proactive?.skipped?.reason ? `didn't float: ${String(o.proactive.skipped.reason).slice(0, 140)}` : ""].filter(Boolean).join(" · "),
        ops: [{ key: "float_take", label: "Float our read", intent: "primary" }, { key: "float_realm", label: "Float the number", intent: "secondary" }, { key: "open_editor", label: "Open", intent: "secondary" }] }));
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
          card.actionIds.push(push({ ...base, kind: "blast_no_opens", severity: "soon",
            title: `${card.address}: blasted ${blastDays}d ago, nobody opened it`, detail: `${blasts.length} blast${blasts.length === 1 ? "" : "s"}`,
            ops: [{ key: "preview_follow_ups", label: "Who'd get a nudge", intent: "secondary" }, { key: "run_follow_ups", label: "Nudge them", intent: "primary" }, { key: "open_deals", label: "Open the deal", intent: "secondary" }] }));
        }
      }
      if (dd.stage === "under_contract" && dd.investors.some((i) => i.state === "committed")) {
        card.actionIds.push(push({ ...base, kind: "stage_lag", severity: "fyi",
          title: `${card.address} has a committed buyer but is still under contract`, detail: "",
          ops: [{ key: "advance", label: "Move to buyer found", intent: "primary" }] }));
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
      push({ kind: "underwrite_failed", severity: "fyi", jobId: j.id, contactId: j.contactId || null, contactName: j.contactName || "",
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
      const hot = never || (x && !x.passed);
      const title = x && !x.passed && x.theirAmount && x.ceiling
        ? `Counter ${money(x.theirAmount)} is ${money(x.theirAmount - x.ceiling)} over the ${money(x.ceiling)} ceiling`
        : `${d.contactName || "Someone"}: ${String(d.intent || "reply").replace(/_/g, " ")}`;
      const id = push({ ...base, kind: "draft_waiting", severity: hot ? "now" : "soon", title,
        detail: x && !x.passed ? (x.basis || x.reason || "") : (d.autoSend?.reason || ""), ops: [] });
      if (card) card.actionIds.push(id);
    } else if (d.status === "scheduled" && d.outbound?.kind === "blast_open") {
      // A blast is one decision, not two hundred rows: one line per deal.
      const key = `blast:${d.outbound.offerId || d.propertyAddress || "deal"}`;
      const existing = actions.find((a) => a.id === key);
      if (existing) { existing.count++; existing.title = `Blast on ${existing.address || "a deal"}: ${existing.count} texts sending themselves`; }
      else {
        const id = push({ ...base, id: key, kind: "draft_scheduled", severity: "fyi", count: 1,
          address: d.outbound.address || base.address, title: `Blast on ${d.outbound.address || base.address || "a deal"}: 1 text sending itself`, detail: "staggered over the auto-send hours", ops: [] });
        if (card) card.actionIds.push(id);
      }
    } else if (d.status === "scheduled") {
      const id = push({ ...base, kind: "draft_scheduled", severity: "fyi",
        title: `${d.contactName || "Someone"}: sends itself${d.sendAt ? ` at ${d.sendAt}` : ""}`, detail: "", ops: [] });
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
      heldTriageByOffer, now,
    });
    if (v.move === "not_owed") continue;
    const who = contactNames[p.contactId] || "An agent";
    const heldReason = v.offerId && ["rerun", "ask_numbers", "yours", "wait"].includes(v.move) && mine.some((o) => o.id === v.offerId && aiHoldReasons(o).length)
      ? String(aiHoldReasons(mine.find((o) => o.id === v.offerId))[0]).split(" — ")[0].slice(0, 120) : "";
    // A question the bot couldn't answer: the row is the question, with a
    // box. What they asked is the inbound of the reply that deflected.
    const theirs = [...sentDrafts, ...drafts].filter((d) => d?.contactId === p.contactId);
    const from = v.kind === "partner_answer" ? (theirs.find((d) => d.id === p.draftId) || null) : null;
    const question = from ? questionIn(from.inbound) : "";
    const ops = question ? [{ key: "answer", label: "Answer", intent: "primary" }] : (PROMISE_OPS[v.move] || []);
    push({ id: `promise_owed:${p.contactId}:${p.owedAt}`, kind: "promise_owed", severity: "now", contactId: p.contactId, contactName: contactNames[p.contactId] || "",
      address: p.address || "", offerId: v.offerId || null, move: v.move, why: v.reason || "", askingPrice: v.askingPrice || 0,
      draftId: null, fromDraftId: p.draftId || null, ...(question ? { question } : {}),
      title: `${who}: we owe them ${p.what === "number" ? "a number" : "an answer"}${p.address ? ` on ${String(p.address).split(",")[0]}` : ""}`,
      detail: [PROMISE_MOVE_LABEL[v.move] || "", heldReason ? `underwrite held: ${heldReason}` : "", p.text ? `we said "${String(p.text).slice(0, 90)}"` : ""].filter(Boolean).join(" · "),
      // Settled some other way (a call, a no that never reached the offer):
      // the row can always be closed by hand, with why. Marking the offer
      // sent / passed closes it too.
      ops: [...ops.filter((o) => v.offerId || !NEEDS_OFFER.has(o.key)), { key: "dismiss_promise", label: "Dismiss" }] });
  }

  actions.sort((a, b) => (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]) || String(a.title).localeCompare(String(b.title)));
  cards.sort((a, b) => b.ageDays - a.ageDays);

  const lanes = ALL_LANES.map((l) => ({ ...l, count: counts.lanes[l.key], cardIds: cards.filter((c) => c.lane === l.key).map((c) => c.id) }));
  return { lanes, cards, actions, counts };
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
