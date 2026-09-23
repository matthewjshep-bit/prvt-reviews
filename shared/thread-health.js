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

import { DEAD_STATUSES, LIVE_DEAL_STAGES, effectiveStatus } from "./offer-status.js";
import { OVER_PLAIN } from "./held-underwrites.js";

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

// How many texts of ours, with nothing back, before the machine stops adding
// to them. The next move is a phone call, which is a person's.
export const UNANSWERED_LIMIT = 2;
// A thread a person answered by hand is theirs for this long.
export const PERSON_HAS_IT_DAYS = 3;
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

  // Stop on Today, until Resume. A stop names a house or the whole thread.
  const mine = (e) => !e.offerId || !offer?.id || e.offerId === offer.id;
  const toggles = (events || []).filter((e) => (e?.type === "drive_stopped" || e?.type === "drive_resumed") && mine(e))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const lastToggle = toggles.at(-1);
  if (lastToggle?.type === "drive_stopped") {
    const why = String(lastToggle.data?.reason || "").trim();
    return stop("stopped_by_you", why ? `you stopped it: ${why.slice(0, 120)}` : "", lastToggle.at);
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

  const n = unansweredMachineTexts(drafts, events);
  if (n >= UNANSWERED_LIMIT) return stop("two_unanswered", `${n} texts from us since they last wrote, nothing back`);

  return { drive: true, reason: "", detail: "", since: null };
}
