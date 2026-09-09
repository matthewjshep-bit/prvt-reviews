// requote.js — when the agent says our number is way off, run it again on
// THEIR numbers.
//
// This is the cheapest autonomy in the system, and the argument for it is that
// it concedes nothing. The bot is not moving our price to meet theirs; it is
// re-running our own arithmetic with the ARV and rehab they just gave us, and
// whatever falls out falls out. If their numbers are real our offer moves and
// we look responsive; if they are wishful the clamps below bite and the offer
// barely moves, which is also the right answer.
//
// It exists because the alternative — letting a counter auto-send — is a
// concession, and a bot should exhaust "check your working" before it ever
// reaches for "fine, we'll pay more".
//
// Pure. calculateOffers is the only thing it calls, and that is pure too.

import { calculateOffers, effectiveSettings } from "./offer-calc.js";
// The guard's defaults live with the rest of the Conversation AI config —
// offer-calc reaches back into that module, so it has to be the end of the
// import chain rather than a link in it. Re-exported for callers who only
// want the planner.
import { REQUOTE_DEFAULTS } from "./conversation-ai.js";
export { REQUOTE_DEFAULTS };

const round = (v) => Math.round(Number(v) || 0);
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

/**
 * clampToOurs({ theirArv, theirRehab, ourArv, ourRehab, band })
 *   → { arv, repairs, clamped, basis }
 *
 * The two levers an agent can pull on our price, each bounded in the direction
 * that inflates it. Raising the ARV and cutting the repairs both make our
 * number go up, so both are capped against what we underwrote — an agent
 * claiming an ARV 40% above ours moves our number by at most `maxArvLiftPct`
 * of ours.
 *
 * Their numbers may also be WORSE than ours (a lower ARV, more work). Those
 * are taken whole: nothing needs protecting from a number that costs us less.
 */
export function clampToOurs({ theirArv = 0, theirRehab = 0, ourArv = 0, ourRehab = 0, band = REQUOTE_DEFAULTS } = {}) {
  const lift = Math.max(0, Number(band.maxArvLiftPct) || 0) / 100;
  const cut = Math.max(0, Number(band.maxRepairCutPct) || 0) / 100;
  const notes = [];

  let arv = round(theirArv) || round(ourArv);
  const arvCeiling = round(ourArv * (1 + lift));
  if (ourArv > 0 && arv > arvCeiling) { arv = arvCeiling; notes.push("their ARV was capped against ours"); }

  let repairs = round(theirRehab) || round(ourRehab);
  const repairFloor = round(ourRehab * (1 - cut));
  if (ourRehab > 0 && repairs < repairFloor) { repairs = repairFloor; notes.push("their rehab was floored against ours"); }

  return { arv, repairs, clamped: notes.length > 0, basis: notes.join(" and ") };
}

/**
 * planRequote({ offer, take, band, settings, ceiling, now }) → plan
 *
 *   { ok: true, arv, repairs, from, to, clamped, basis }
 *   { ok: false, reason }
 *
 * `take` is what the agent told us — { arv, rehab, at } off their
 * agent_estimate events, never parsed from free text and never their counter
 * PRICE, which is a number they want rather than an input to our math.
 *
 * `ceiling` is the auto-accept ceiling for this offer. Bounding the re-quote
 * by the same number the counter band uses is the point: the bot can never
 * talk ITSELF up past the price it would have been allowed to say yes to
 * THEM at. Two features, one bound, one thing to reason about.
 */
export function planRequote({ offer, take = {}, band = REQUOTE_DEFAULTS, settings = {}, ceiling = 0, now = Date.now() } = {}) {
  if (!band?.enabled) return { ok: false, reason: "re-quoting is switched off" };
  if (!offer?.id) return { ok: false, reason: "no offer to re-quote" };

  const done = (offer.requotes || []).length;
  const max = Math.max(1, Number(band.maxPerOffer) || 1);
  if (done >= max) return { ok: false, reason: `already re-quoted ${done === 1 ? "once" : `${done} times`} — this one is a person's call` };

  const ourArv = round(offer.arv ?? offer.calc?.inputs?.arv);
  const ourRehab = round(offer.repairs ?? offer.calc?.inputs?.repairs);
  const theirArv = round(take.arv);
  const theirRehab = round(take.rehab);
  if (!theirArv && !theirRehab) return { ok: false, reason: "nothing new from them to re-quote on" };

  // A take we already priced against is not new information. Re-running the
  // same arithmetic on the same inputs produces the same number, and sending
  // it again is the bot arguing with itself.
  const takenAt = ms(take.at);
  const pricedAt = ms(offer.calc?.at || offer.statusAt || offer.createdAt);
  if (takenAt != null && pricedAt != null && takenAt <= pricedAt) {
    return { ok: false, reason: "their read predates our underwrite — nothing new" };
  }

  const { arv, repairs, clamped, basis } = clampToOurs({ theirArv, theirRehab, ourArv, ourRehab, band });
  if (!(arv > 0)) return { ok: false, reason: "no ARV to work from" };

  const from = round(offer.cashAmount);
  let to = 0;
  try {
    const base = { ...(offer.calc?.settings || effectiveSettings(settings)) };
    delete base.conversationAi;   // idempotent but wasted work in effectiveSettings
    to = round(calculateOffers(
      { address: offer.address || "", arv, repairs, askingPrice: 0, priceOverride: 0 },
      base,
    ).offers.cash.amount);
  } catch (e) {
    return { ok: false, reason: `the numbers wouldn't compute: ${e.message}` };
  }

  if (!(to > 0)) return { ok: false, reason: "their numbers put the deal underwater" };
  if (to === from) return { ok: false, reason: "their numbers land on the same price we already sent" };
  // The shared bound. See the docblock: the re-quote may not talk us above the
  // point where we would have accepted their counter outright.
  if (ceiling > 0 && to > ceiling) {
    return { ok: false, reason: "their numbers would put us above what we'd pay — a person should look at this" };
  }
  return { ok: true, arv, repairs, from, to, clamped, basis };
}
