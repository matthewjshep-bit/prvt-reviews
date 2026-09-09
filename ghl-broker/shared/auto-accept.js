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

/* ---------- the guard ---------- */

/**
 * evaluateCounterBand({ offer, draft, inboundMessage, settings, band,
 *                       openOffers, releasedToday, now }) → verdict
 *
 * Every check must pass, and every check is recorded either way — a failed
 * band is the most useful row in the outbox, because it says exactly how far
 * off the counter was and why the bot didn't take it.
 *
 * Pure. `moneyIn` is passed in rather than imported so this module stays free
 * of the reply agent.
 */
export function evaluateCounterBand({
  offer, draft = {}, inboundMessage = "", settings = {}, band = {},
  openOffers = [], releasedToday = 0, now = Date.now(), moneyIn = defaultMoneyIn,
} = {}) {
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail }); return Boolean(ok); };
  const theirAmount = round(draft.counterAmount);
  const ceiling = autoAcceptCeiling({ offer, settings });
  const cap = round(band.maxAmount);
  const limit = cap > 0 ? Math.min(ceiling.ceiling, cap) : ceiling.ceiling;

  // 1. Their own words. The model's extraction alone is never enough: the
  //    exact number has to appear in the message the agent actually sent.
  //    This is the check that makes the whole feature defensible — everything
  //    else is arithmetic, and this is the one that says we didn't imagine it.
  const said = moneyIn(inboundMessage).map(round);
  check("their_own_words", theirAmount > 0 && said.includes(theirAmount),
    theirAmount > 0 ? (said.includes(theirAmount) ? `they typed ${theirAmount}` : `${theirAmount} is not in their message`) : "no number read");

  // 2. One offer, unambiguously. Saying yes on the wrong house is worse than
  //    not saying yes at all.
  const live = openOffers.filter((o) => o && !o.deal);
  check("one_offer", Boolean(offer?.id) && (live.length <= 1 || Boolean(draft.propertyAddress)),
    live.length > 1 && !draft.propertyAddress ? `${live.length} open offers and no address named` : "");

  // 3. Still ours to answer.
  check("offer_live", Boolean(offer) && !offer.deal, offer?.deal ? "already a deal" : "");

  // 4. Above our number. A counter BELOW what we offered is a parse error or
  //    something strange, not a bargain.
  check("above_ours", theirAmount > round(offer?.cashAmount), theirAmount <= round(offer?.cashAmount) ? "at or under our own number" : "");

  // 5 & 6. The ceiling, and whether one could be computed at all.
  check("ceiling_computable", ceiling.computable, ceiling.reason);
  check("under_ceiling", ceiling.computable && theirAmount > 0 && theirAmount <= limit,
    ceiling.computable ? `${theirAmount} vs ${limit}` : "no ceiling");

  // 7. Sure. Hard-coded high — NOT the page's minConfidence. An operator who
  //    relaxed the bar for questions did not thereby relax it for money.
  check("sure", draft.confidence === "high" && !draft.needsHuman,
    draft.confidence !== "high" ? `only ${draft.confidence} confidence` : draft.needsHuman ? (draft.humanReason || "the model asked for a person") : "");

  // 8. One automatic concession per offer, ever. A second one is a
  //    negotiation, and this feature does not negotiate.
  check("once_per_offer", !offer?.counterBand?.at, offer?.counterBand?.at ? "this offer already used its exception" : "");

  // 9. The daily cap, counted from the store rather than memory — a crash
  //    loop must not hand a misconfigured setup a fresh budget.
  const dailyCap = Math.max(1, round(band.dailyCap) || 1);
  check("under_daily_cap", releasedToday < dailyCap, `${releasedToday}/${dailyCap} today`);

  const passed = checks.every((c) => c.ok);
  const failed = checks.find((c) => !c.ok);
  return {
    kind: "counter_band", passed, checks,
    theirAmount, ceiling: limit, rawCeiling: ceiling.ceiling,
    basis: ceiling.basis || "", mode: ceiling.mode || "", modes: ceiling.modes || [],
    source: ceiling.source || "", offerId: offer?.id || null,
    at: new Date(now).toISOString(),
    reason: passed ? "" : bandReason(failed, theirAmount, limit, ceiling),
  };
}

// The line the outbox row shows. It has to be enough for the operator to
// decide whether the ceiling is in the right place.
function bandReason(failed, theirAmount, limit, ceiling) {
  if (!failed) return "";
  if (failed.name === "under_ceiling" && ceiling.computable) {
    return `${money(theirAmount)} is ${money(theirAmount - limit)} over the ${money(limit)} ceiling (${ceiling.basis})`;
  }
  return failed.detail || failed.name.replace(/_/g, " ");
}

const money = (n) => `$${Math.round(Number(n) || 0).toLocaleString("en-US")}`;

// Every dollar figure in a string, as whole numbers. The same pattern the
// reply agent uses, and the caller passes that one in production so there is
// only ever one reader — this is the standalone fallback, kept identical.
//
// Note what it deliberately does NOT match: a bare run of digits. "98056" is a
// zip, "1450" is a square footage, "280000" typed with no dollar sign and no
// separator is ambiguous. A number has to look like money to count as money,
// which is the conservative direction for a check that opens the band.
const MONEY_RE = /\$\s?\d[\d,]*(?:\.\d+)?\s?[kKmM]?\b|\b\d+(?:\.\d+)?\s?[kK]\b|\b\d+(?:\.\d+)?\s?[mM]\b|\b\d{1,3}(?:,\d{3})+\b/g;
function defaultMoneyIn(text = "") {
  const out = [];
  for (const m of String(text || "").matchAll(MONEY_RE)) {
    const t = m[0].replace(/[$,\s]/g, "");
    const suffix = t.slice(-1).toLowerCase();
    const base = Number(suffix === "k" || suffix === "m" ? t.slice(0, -1) : t);
    if (!Number.isFinite(base)) continue;
    out.push(Math.round(suffix === "k" ? base * 1e3 : suffix === "m" ? base * 1e6 : base));
  }
  return out;
}

/**
 * evaluateAcceptance({ offer, draft, inboundMessage, band, ... }) → verdict
 *
 * "The seller accepted OUR number." Deliberately much narrower than a counter:
 * there is no arithmetic to check, only the absence of a new number. If they
 * named one, this is a counter and belongs to the branch above.
 */
export function evaluateAcceptance({
  offer, draft = {}, inboundMessage = "", band = {}, openOffers = [],
  releasedToday = 0, now = Date.now(), moneyIn = defaultMoneyIn,
} = {}) {
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail }); return Boolean(ok); };
  const ours = round(offer?.cashAmount);
  const said = moneyIn(inboundMessage).map(round);
  const strangers = said.filter((n) => n !== ours);

  check("acceptance_enabled", band.acceptance === true, band.acceptance ? "" : "acceptance is off");
  check("no_new_number", !round(draft.counterAmount) && strangers.length === 0,
    strangers.length ? `they named ${strangers.map(money).join(", ")} — that is a counter, not an acceptance` : "");
  const live = openOffers.filter((o) => o && !o.deal);
  check("one_offer", Boolean(offer?.id) && (live.length <= 1 || Boolean(draft.propertyAddress)), "");
  check("offer_live", Boolean(offer) && !offer.deal, offer?.deal ? "already a deal" : "");
  check("sure", draft.confidence === "high" && !draft.needsHuman, draft.confidence !== "high" ? `only ${draft.confidence} confidence` : "");
  check("once_per_offer", !offer?.acceptanceSignal?.at, offer?.acceptanceSignal?.at ? "already signalled" : "");
  const dailyCap = Math.max(1, round(band.dailyCap) || 1);
  check("under_daily_cap", releasedToday < dailyCap, `${releasedToday}/${dailyCap} today`);

  const passed = checks.every((c) => c.ok);
  const failed = checks.find((c) => !c.ok);
  return {
    kind: "acceptance_band", passed, checks, theirAmount: 0, ceiling: 0,
    offerId: offer?.id || null, at: new Date(now).toISOString(),
    reason: passed ? "" : (failed?.detail || failed?.name.replace(/_/g, " ") || ""),
  };
}
