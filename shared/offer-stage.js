// offer-stage.js — the three stages of an offer, as Matt drew them (2026-10-13).
//
//   Draft      priced, our number hasn't gone out yet (auto-underwrite got the #)
//   Sent       our number is out: the written offer, or a number texted (floated)
//   Responded  they answered it:  Passed · Countered · Hot · Accepted
//
// Derived on read, never stored — like offerHeat. The stored statuses stay
// what they were: the counter band, the follow-up ladders, the audit, the
// Postgres status column and every `offer_${status}` event key on them, and a
// hot offer must still be sent or countered for those to keep working.
//
// "Passed" is every way an offer ends without a deal: they passed, we passed,
// the house is gone, nobody answered after the follow-ups (Matt: no reply
// counts as passed), or the deal fell through. `why` says which.
//
// The agent's GHL card follows the stage (shared/ghl-stages.js targetStage).

import { effectiveStatus, isHot, LIVE_DEAL_STAGES } from "./offer-status.js";

export const OFFER_STAGES = Object.freeze([
  { key: "draft", label: "Draft", title: "Priced — our number hasn't gone out yet" },
  { key: "sent", label: "Sent", title: "Our number is out — the written offer, or a number we texted" },
  { key: "responded", label: "Responded", title: "They answered it: passed, countered, hot or accepted" },
]);

export const RESPONDED_SUBS = Object.freeze([
  { key: "hot", label: "🔥 Hot", title: "Close to a contract — the price is agreed, or it's flagged" },
  { key: "countered", label: "Countered", title: "They came back with a number" },
  { key: "accepted", label: "Accepted", title: "Under contract — tracked as a deal" },
  { key: "passed", label: "Passed", title: "They passed, we passed, it's gone, or no reply after the follow-ups" },
]);

const PASSED_WHY = {
  passed: "they passed",
  we_passed: "we passed",
  unavailable: "no longer available",
  no_response: "no reply",
};

const ms = (t) => { const v = typeof t === "number" ? t : Date.parse(t || ""); return Number.isFinite(v) ? v : null; };

/** Our number went out by text: a sent realm-check (stamped on the offer, or attached to the row as floatedAt). */
export const floatedAt = (o) => o?.floatSentAt || o?.floatedAt || null;

/**
 * offerStage(o, { texted }) → { stage: "draft"|"sent"|"responded", sub: null|"passed"|"countered"|"hot"|"accepted", why }
 *
 *   texted  does a number we only texted count as sent? Yes for the GHL
 *           card (Offer Out) and the dashboard; the Offers page's tabs pass
 *           false — there Sent is the written offer going out, and a float
 *           waits in Draft for its letter (Matt, 2026-10-23).
 */
export function offerStage(o, { texted = true } = {}) {
  if (!o) return { stage: "draft", sub: null, why: "" };
  const status = effectiveStatus(o);
  if (o.deal) {
    if (o.deal.stage === "fell_through") return { stage: "responded", sub: "passed", why: "the deal fell through" };
    return { stage: "responded", sub: "accepted", why: o.deal.stage === "closed" ? "closed" : "under contract" };
  }
  if (status === "accepted") return { stage: "responded", sub: "accepted", why: "accepted" };
  if (PASSED_WHY[status]) return { stage: "responded", sub: "passed", why: PASSED_WHY[status] };
  if (status !== "draft" && isHot(o)) return { stage: "responded", sub: "hot", why: "hot" };
  if (status === "countered") return { stage: "responded", sub: "countered", why: "they countered" };
  if (status === "sent") return { stage: "sent", sub: null, why: "the written offer went" };
  if (status === "new" && floatedAt(o) && texted) return { stage: "sent", sub: null, why: "our number went by text" };
  return { stage: "draft", sub: null, why: status === "draft" ? "held for a look" : floatedAt(o) ? "our number went by text; the letter hasn't" : "priced, not out yet" };
}

/** A live deal, by stage — the card's Contract stage. */
export const onLiveDeal = (o) => Boolean(o?.deal && LIVE_DEAL_STAGES.has(o.deal.stage));

/**
 * offerStageAt(o) → epoch ms | null
 *
 * When the offer last moved stage: its status, a send, the float, heat, a
 * deal stage. The newest of these against the GHL card's lastStageChangeAt
 * decides who moved last — the app or a person in GHL.
 */
export function offerStageAt(o) {
  if (!o) return null;
  const times = [
    o.createdAt, o.statusAt, floatedAt(o),
    ...(o.sends || []).map((s) => s?.ts || s?.at),
    o.hot?.at, o.agreed?.at, o.counterBand?.acceptedAt, o.realm?.ts,
    o.deal?.createdAt, ...(o.deal?.stageHistory || []).map((h) => h?.ts || h?.at),
  ].map(ms).filter((t) => t != null);
  return times.length ? Math.max(...times) : null;
}

/** stageCounts(rows) → { draft, sent, responded, hot, countered, accepted, passed } */
export function stageCounts(rows = []) {
  const out = { draft: 0, sent: 0, responded: 0, hot: 0, countered: 0, accepted: 0, passed: 0 };
  for (const o of rows || []) {
    const s = offerStage(o);
    out[s.stage]++;
    if (s.sub) out[s.sub]++;
  }
  return out;
}
