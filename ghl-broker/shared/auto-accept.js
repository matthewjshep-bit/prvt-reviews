// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// auto-accept.js — the most we would say yes to without a person in the room.
//
// It is what our own calculator would have produced on this property at its
// most generous: the highest of the three underwriting models, recomputed as
// if we were willing to work for a $10,000 assignment fee instead of our
// usual one. Above that number a counter is a decision; at or below it, it is
// a number we could always have justified.
//
// Derived, not configured. There is deliberately no percentage knob and no
// per-offer override — every input here already comes from settings the
// operator tuned, and a second set of dials layered on top is a second thing
// to get wrong and to forget. Retune the calculator and this moves with it.
//
// Pure.

import { calculateOffers, effectiveSettings } from "./offer-calc.js";

// The fee we would drop to. Not a setting: it is the definition of "at our
// most generous", and an operator who wants a different ceiling should change
// their underwriting, not this.
export const AUTO_ACCEPT_FEE = 10000;

const round = (v) => Math.round(Number(v) || 0);

/**
 * autoAcceptCeiling({ offer, settings }) → {
 *   ceiling,      // whole dollars, 0 when not computable
 *   computable,   // false → the band can never open on this offer
 *   reason,       // why not, in the operator's words
 *   mode, modes,  // which model won, and all three, for the audit trail
 *   arv, repairs, source, fee
 * }
 *
 * `settings` is the location's CURRENT settings and is used only when the
 * offer carries no calc snapshot of its own — the snapshot is the right
 * source, because it is what we actually underwrote at. When we fall back,
 * `source` says so and the draft records it.
 */
export function autoAcceptCeiling({ offer, settings = {} } = {}) {
  const no = (reason) => ({ ceiling: 0, computable: false, reason, mode: "", modes: [], arv: 0, repairs: 0, source: "", fee: AUTO_ACCEPT_FEE });
  if (!offer) return no("no offer");

  // Read ARV explicitly. calculateOffers falls back to the ASKING PRICE when
  // arv is 0 — which would derive our walk-away from the agent's list price
  // instead of an underwrite, biased high in exactly the wrong direction. So
  // askingPrice is never passed anywhere it could substitute.
  const arv = round(offer.arv ?? offer.calc?.inputs?.arv);
  const repairs = round(offer.repairs ?? offer.calc?.inputs?.repairs);
  if (!(arv > 0)) return no("no ARV on this offer");
  // Zero repairs on a wholesaling offer is almost always "we never captured
  // it", not "the house needs nothing" — and every model subtracts repairs,
  // so a missing figure inflates all three.
  if (!(repairs > 0)) return no("no repair estimate on this offer");

  const snapshot = offer.calc?.settings;
  const source = snapshot ? "offer_snapshot" : "location_settings";
  const base = { ...(snapshot || effectiveSettings(settings)) };
  delete base.conversationAi;

  let modes = [];
  try {
    // "blended" already computes every BLEND_MODES component and hands them
    // back on offers.cash.components — so one call is all three models. Going
    // through the blend rather than three explicit calls means a fourth model
    // added to it is picked up here without anyone remembering to come back.
    const calc = calculateOffers(
      { address: offer.address || "", arv, repairs, askingPrice: 0, priceOverride: 0 },
      { ...base, underwriteMode: "blended", wholesaleFee: AUTO_ACCEPT_FEE },
    );
    modes = (calc.offers?.cash?.components || []).map((c) => ({ key: c.key, label: c.label, amount: round(c.amount) }));
  } catch (e) {
    // calculateOffers throws by contract. A pure function that can explode is
    // one nobody dares call from inside a gate, so a throw becomes an answer.
    return no(`the numbers wouldn't compute: ${e.message}`);
  }
  if (!modes.length) return no("the calculator returned no models");

  const top = modes.reduce((a, b) => (b.amount > a.amount ? b : a), modes[0]);
  const ceiling = top.amount;
  if (!(ceiling > 0)) return no("every model comes out underwater on this property");
  // An offer whose printed price was hand-raised above every model has no band
  // at all. The honest answer is "never auto-accepts", not "auto-accepts
  // anything above the number we inflated".
  const ours = round(offer.cashAmount);
  if (ours > 0 && ceiling <= ours) return no("our own number is already at or above the ceiling");

  return {
    ceiling, computable: true, reason: "",
    mode: top.key, modes, arv, repairs, source, fee: AUTO_ACCEPT_FEE,
    basis: `${top.label} at a ${fmtK(AUTO_ACCEPT_FEE)} assignment`,
  };
}

const fmtK = (n) => `$${Math.round(n / 1000)}k`;
