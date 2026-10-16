// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// thread-health.js — when the machine stops pushing.
//
// The goal is offer out → hot → accepted → contract with the machine always
// driving. "Always" needs a brake: a deal that is dead, an agent who is
// annoyed, a thread a person has picked up, somebody who never answers. Every
// driver (promise-driver.js and the ones after it) asks this before it claims
// anything. Pure: the offer, the contact's drafts and events go in.
//
// The existing ladders keep their own rules (stop on any inbound, a weekly
// cap, six rungs for a cold agent by design). This is for what is NEW: moves
// the machine starts by itself between rungs.

import { DEAD_STATUSES, LIVE_DEAL_STAGES, OPEN_STATUSES, effectiveStatus, isHot, priceAgreed, saidYes } from "./offer-status.js";
import { OVER_PLAIN } from "./held-underwrites.js";
import { botHold, holdLine } from "./bot-hold.js";
import { callEventConnected } from "./talked-to.js";
import { isAutoReply } from "./brush-offs.js";

const DAY_MS = 86400000;
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

// Strongest first: the first one found is the one reported.
export const STOP_REASONS = ["opted_out", "stopped_by_you", "live_deal", "rejected", "pending_or_sold", "irritated", "person_has_it", "two_unanswered"];
export const STOP_LABEL = {
  opted_out: "they opted out",
  stopped_by_you: "you stopped it",
  live_deal: "it is a deal now",
  rejected: "they passed",
  pending_or_sold: "the house is pending or sold",
  irritated: "they sound annoyed",
  person_has_it: "you have the thread",
  two_unanswered: "two texts from us, nothing back",
};

// The stops that say the house is over for us, not just paused: they said
// no (and the first-no ask went nowhere), or it went pending or sold. An
// open offer the machine stands down on for one of these is no conversation
// to wait on — the agent check-in asks for their next one
// (shared/agent-pulse.js openOfferIdle, ghl-broker/agent-focus.js).
export const HOUSE_OVER_REASONS = new Set(["rejected", "pending_or_sold"]);

// How many texts of ours, with nothing back, before the machine stops adding
// to them. The next move is a phone call, which is a person's.
export const UNANSWERED_LIMIT = 2;
// A thread a person answered by hand is theirs for this long.
export const PERSON_HAS_IT_DAYS = 3;
// A phone conversation (the GHL dialer's transcript, or one Matt logged by
// hand) is his for this long: a nudge landing on top of a call he just had
// undoes it. The call's own follow-up text is the reply agent's, not a
// driver's, so it is not held by this.
export const CALL_HAS_IT_HOURS = 48;
// The timeline event a text typed on Today's work pane writes
// (ghl-broker/hand-reply.js).
export const HAND_REPLY_EVENT = "hand_reply";
// Only their newest few messages: an agent who snapped last month and has
// since sent the contract is not annoyed.
const RECENT_INBOUNDS = 3;

// No classifier field for tone exists (conversation-prompt.js schemaFor), so
// this is words. Narrow on purpose: "stop by the house" is not "stop".
export const IRRITATED_RX = /\bstop\s+(?:texting|messaging|contacting|calling|bothering|harassing)\b|\bquit\s+(?:texting|messaging|contacting|calling)\b|\b(?:i|we)(?:'ve|\s+have)?\s+already\s+(?:told|said|answered)\b|\bhow\s+many\s+times\b|\bleave\s+me\s+alone\b|\b(?:is|are)\s+(?:this|you)\s+an?\s+(?:bot|robot|ai)\b|\bnot\s+interested,?\s+(?:please\s+)?stop\b|\btake\s+me\s+off\b|\blose\s+my\s+number\b/i;

const inboundsNewestFirst = (drafts) => (drafts || [])
  .filter((d) => d && String(d.inbound || "").trim())
  .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

/**
 * unansweredMachineTexts(drafts, events) → number
 *
 * Texts WE started (a nudge, a float, a check-in — anything with an outbound
 * kind) that went out since they last wrote. A reply to something they said
 * is not one: they are in the conversation.
 */
export function unansweredMachineTexts(drafts = [], events = []) {
  const lastIn = Math.max(
    ...inboundsNewestFirst(drafts).slice(0, 1).map((d) => ms(d.createdAt) ?? 0),
    ...(events || []).filter((e) => e?.type === "text_summary" || e?.type === "call_summary").map((e) => ms(e.at) ?? 0),
    0,
  );
  return (drafts || []).filter((d) => d && d.status === "sent" && d.outbound?.kind && !String(d.inbound || "").trim()
    && (ms(d.sentAt || d.createdAt) ?? 0) > lastIn).length;
}

/**
 * threadHealth({ offer, drafts, events, now }) → { drive, reason, detail, since }
 *
 *   offer   the offer being driven, or null to judge the thread alone
 *   drafts  this contact's reply drafts, any status
 *   events  this contact's timeline
 */
export function threadHealth({ offer = null, drafts = [], events = [], now = Date.now() } = {}) {
  const stop = (reason, detail = "", since = null) => ({ drive: false, reason, detail: detail || STOP_LABEL[reason], since });
  const ins = inboundsNewestFirst(drafts);

  const unsub = (events || []).find((e) => e?.type === "unsubscribed");
  if (unsub) return stop("opted_out", "", unsub.at);
  const opted = ins.find((d) => d.intent === "opt_out");
  if (opted) return stop("opted_out", "", opted.createdAt);

  // Stop or Pause, until Resume or the pause's date (shared/bot-hold.js).
  // A stop names a house or the whole thread.
  const hold = botHold({ events, offerId: offer?.id || null, now });
  if (hold.held) {
    const detail = hold.kind === "paused" ? holdLine(hold) : hold.reason ? `you stopped it: ${hold.reason.slice(0, 120)}` : "";
    return stop("stopped_by_you", detail, hold.since);
  }

  if (offer?.deal && (LIVE_DEAL_STAGES.has(offer.deal.stage) || effectiveStatus(offer) === "accepted")) return stop("live_deal");
  if (offer && DEAD_STATUSES.has(effectiveStatus(offer))) return stop("rejected", `the offer is marked ${effectiveStatus(offer).replace(/_/g, " ")}`);

  const recent = ins.slice(0, RECENT_INBOUNDS);
  if (recent[0]?.intent === "rejection") return stop("rejected", "", recent[0].createdAt);
  const over = recent.find((d) => OVER_PLAIN.test(d.inbound));
  if (over) return stop("pending_or_sold", "", over.createdAt);
  const cross = recent.find((d) => IRRITATED_RX.test(d.inbound));
  if (cross) return stop("irritated", "", cross.createdAt);

  const byHand = (drafts || []).find((d) => d?.answeredBy === "you" && now - (ms(d.updatedAt || d.createdAt) ?? 0) <= PERSON_HAS_IT_DAYS * DAY_MS);
  if (byHand) return stop("person_has_it", "", byHand.createdAt);
  // A text typed on Today's work pane with no draft open leaves no draft to
  // carry answeredBy; its timeline event says the same thing.
  const typed = (events || []).find((e) => e?.type === HAND_REPLY_EVENT && now - (ms(e.at) ?? 0) <= PERSON_HAS_IT_DAYS * DAY_MS);
  if (typed) return stop("person_has_it", "", typed.at);
  const call = (events || []).find((e) => callEventConnected(e) && now - (ms(e.at) ?? 0) <= CALL_HAS_IT_HOURS * 3600000 && (ms(e.at) ?? 0) <= now);
  // `via: "call"`: the promise driver still keeps a number promised on that
  // very call (ghl-broker/promise-driver.js) — the brake is for nudges.
  if (call) return { ...stop("person_has_it", "you spoke on the phone", call.at), via: "call" };

  const n = unansweredMachineTexts(drafts, events);
  if (n >= UNANSWERED_LIMIT) return stop("two_unanswered", `${n} texts from us since they last wrote, nothing back`);

  return { drive: true, reason: "", detail: "", since: null };
}

/* ---------- the machine stays out of a live thread (2026-10-15) ---------- */

// The funnel review: machine texts landed in the middle of 92 of 485
// threads, and the worst of them walked away from a yes. Two rules, asked by
// every door a text the machine starts goes through (startProactive, and the
// send itself in sendReplyDraft).
//
// 48 hours: they wrote to us (not an auto-reply) and a house is live — a
// check-in, a nudge, a "still working on it" lands on top of a conversation
// somebody is having. The floats (realm_check, take_check) are the answer to
// that conversation, so they are not held by it.
export const LIVE_THREAD_HOURS = 48;
export const LIVE_THREAD_KINDS = new Set([
  "kind_pass", "passed_checkin", "agent_pulse", "checkin_due", "offer_nudge", "counter_nudge", "outreach_nudge",
  "address_chase", "price_drop", "promise_due", "take_ask", "hot_push", "second_look",
]);
// The yes rule: a text that walks away from the house never goes out after
// they said yes to our number (shared/offer-status.js saidYes).
export const PASS_SHAPED_KINDS = new Set(["kind_pass", "passed_checkin"]);
// A house they named this recently is live even with no offer on it yet.
const NAMED_HOUSE_DAYS = 14;
const HOUSE_TALK = new Set(["deal_available", "new_property", "counter", "acceptance", "realm_yes"]);

/** liveHouse({ offers, events, drafts, now }) → the house that is live for this contact, or null */
export function liveHouse({ offers = [], events = [], drafts = [], now = Date.now() } = {}) {
  for (const o of offers || []) {
    if (!o || (o.deal && !LIVE_DEAL_STAGES.has(o.deal.stage))) continue;
    const status = effectiveStatus(o);
    if (DEAD_STATUSES.has(status)) continue;
    if (OPEN_STATUSES.has(status) || isHot(o) || priceAgreed(o)) return { address: o.address || "", offerId: o.id || null, why: `the offer on ${String(o.address || "a house").split(",")[0]} is ${status.replace(/_/g, " ")}` };
  }
  const named = (events || []).find((e) => e?.type === "house_mentioned" && e.address && now - (ms(e.at) ?? 0) <= NAMED_HOUSE_DAYS * DAY_MS);
  if (named) return { address: named.address, offerId: null, why: `they named ${String(named.address).split(",")[0]}` };
  const talk = (drafts || []).find((d) => d && String(d.inbound || "").trim() && d.propertyAddress && HOUSE_TALK.has(d.intent)
    && now - (ms(d.createdAt) ?? 0) <= NAMED_HOUSE_DAYS * DAY_MS);
  if (talk) return { address: talk.propertyAddress, offerId: null, why: `they're talking about ${String(talk.propertyAddress).split(",")[0]}` };
  return null;
}

/**
 * machineMayStart({ kind, drafts, events, offers, address, passes, now }) → { ok, rule?, reason?, since? }
 *
 *   kind     the outbound kind the machine would start (or is about to send)
 *   drafts   this contact's reply drafts, any status
 *   events   this contact's timeline
 *   offers   this contact's offers (lean rows are enough)
 *   address  the house the text is about, when it names one
 *   passes   the text itself walks away (ourReplyPasses on a reply's body)
 *
 * Pure. `ok: false` says which rule held it and why, in words for the row.
 */
export function machineMayStart({ kind = "", why = "", drafts = [], events = [], offers = [], address = "", passes = false, now = Date.now() } = {}) {
  if (PASS_SHAPED_KINDS.has(kind) || passes) {
    const yes = saidYes({ offers, drafts, events, address, now });
    if (yes) {
      const where = yes.address ? ` on ${String(yes.address).split(",")[0]}` : "";
      return { ok: false, rule: "said_yes", since: yes.at, yes,
        reason: `they said yes to our number${where} — nothing that walks away from it goes out by itself` };
    }
  }
  // The no-fit on a listed house (shared/number-stance.js listedFit) IS the
  // answer to the text they just sent: no number, a kind no and an ask for
  // their other fixers. The live-thread rule is for texts that start
  // something new, so it lets this one through; the yes rule above still holds.
  if (LIVE_THREAD_KINDS.has(kind) && !(kind === "kind_pass" && why === "too_far")) {
    const last = inboundsNewestFirst(drafts).find((d) => !isAutoReply(d.inbound));
    const at = ms(last?.createdAt);
    if (at != null && now - at < LIVE_THREAD_HOURS * 3600000 && at <= now + 60000) {
      const house = liveHouse({ offers, events, drafts, now });
      if (house) {
        const hours = Math.max(1, Math.round((now - at) / 3600000));
        return { ok: false, rule: "live_thread", since: last.createdAt, house,
          reason: `they texted ${hours}h ago and ${house.why} — the machine stays out of a live thread for ${LIVE_THREAD_HOURS}h` };
      }
    }
  }
  return { ok: true };
}
