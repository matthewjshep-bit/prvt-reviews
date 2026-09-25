// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// auto-accept.js — the most we would say yes to without a person in the room.
//
// It is the most a BUYER would pay us for the contract, less the smallest fee
// we'd work for: the maximum-offer model (N% of ARV − repairs, the classic
// flipper's rule, N from settings) recomputed at a $10,000 assignment fee.
// Above that number a counter is a decision; at or below it, a buyer still
// takes the deal.
//
// It used to be the HIGHEST of the three underwriting models, which on a
// big-ARV, light-rehab house is "90% ARV − 2× rehab" — well above what any
// flipper pays. On 2026-09-14 that let an agent's $550k counter on 39811 226th
// Ave SE through a $584k ceiling when the buyer line was about $500k, and the
// bot re-issued and sent the offer at $550k. The post-mortem finding
// (buyers pay ≤ ~70% of ARV − repairs, all-in) is the ceiling now.
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
// The share of list price the bot may never go above, unless the location's
// settings say otherwise (maxOfferPctOfList). Matches the auto-underwrite's.
export const MAX_PCT_OF_LIST = 90;
// How far over the ceiling a counter may be and still get an automatic answer.
// Within it, the band counters back AT the ceiling (the most we'd pay); past
// it — or on a second counter after we already moved — it is their pass.
export const COUNTER_MARGIN = 0.10;

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

  // The buyer's line, not our most generous model. All three stay on the
  // verdict for the audit trail; only "mao" may set the ceiling.
  const top = modes.find((m) => m.key === "mao");
  if (!top) return no("the maximum-offer model is missing, so there's no buyer line to hold the band to");
  let ceiling = top.amount;
  if (!(ceiling > 0)) return no("a buyer's maximum comes out underwater on this property");
  // …and never above a share of the list price (default 90%). A counter or a
  // re-quote must not talk an offer back over the cap the underwrite set —
  // 5016 7th Ave NE priced $1,061,750 on a $925,000 listing (2026-09-14).
  const listPrice = round(offer.askingPrice ?? offer.calc?.inputs?.askingPrice);
  const pctOfList = Number(base.maxOfferPctOfList) > 0 ? Number(base.maxOfferPctOfList) : MAX_PCT_OF_LIST;
  let listCapped = false;
  if (listPrice > 0) {
    const cap = Math.round((listPrice * pctOfList) / 100);
    if (cap < ceiling) { ceiling = cap; listCapped = true; }
  }
  // An offer whose printed price was hand-raised above every model has no band
  // at all. The honest answer is "never auto-accepts", not "auto-accepts
  // anything above the number we inflated".
  const ours = round(offer.cashAmount);
  if (ours > 0 && ceiling <= ours) return no("our own number is already at or above the ceiling");

  return {
    ceiling, computable: true, reason: "",
    mode: top.key, modes, arv, repairs, source, fee: AUTO_ACCEPT_FEE, listCapped,
    basis: listCapped
      ? `${pctOfList}% of the ${fmtK(listPrice)} list price (under ${top.label} at a ${fmtK(AUTO_ACCEPT_FEE)} assignment)`
      : `${top.label} at a ${fmtK(AUTO_ACCEPT_FEE)} assignment`,
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
  openOffers = [], releasedToday = 0, now = Date.now(), moneyIn = defaultMoneyIn, comeDown = null,
} = {}) {
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail }); return Boolean(ok); };
  const theirAmount = round(draft.counterAmount);
  const ceiling = autoAcceptCeiling({ offer, settings });
  // 0. The offer's number is the thread's number. `comeDown` is a lower one
  //    WE texted after the offer last moved (ourComeDown, current-offer.js):
  //    the ceiling and "above ours" would be measured from a number we've
  //    already left, so the band stays shut until someone re-quotes.
  check("current_number", !comeDown,
    comeDown ? `we texted ${money(comeDown.amount)} after this offer's ${money(round(offer?.cashAmount))} — re-quote first` : "");
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
  const usedAt = offer?.counterBand?.at || offer?.counterBand?.acceptedAt;
  check("once_per_offer", !usedAt, usedAt ? "this offer already used its exception" : "");

  // 9. The daily cap, counted from the store rather than memory — a crash
  //    loop must not hand a misconfigured setup a fresh budget.
  const dailyCap = Math.max(1, round(band.dailyCap) || 1);
  check("under_daily_cap", releasedToday < dailyCap, `${releasedToday}/${dailyCap} today`);

  // Counter back. When the ONLY thing wrong is that their number is a little
  // over the ceiling — within COUNTER_MARGIN — and the ceiling is still above
  // our own offer, the band answers at the ceiling instead of parking it for a
  // person (Matt, 2026-09-14: "just have the counter go automatically"). Every
  // other check — their words, one offer, sure, once per offer, daily cap —
  // still has to pass; this relaxes the arithmetic and nothing else.
  const onlyOver = checks.filter((c) => !c.ok).map((c) => c.name);
  const counterBack = onlyOver.length === 1 && onlyOver[0] === "under_ceiling"
    // Not when the operator's hard cap is what binds — that dial means "a
    // person decides above this", and countering back would walk around it.
    && ceiling.computable && !(cap > 0 && cap < ceiling.ceiling) && limit > round(offer?.cashAmount)
    && theirAmount <= Math.round(limit * (1 + COUNTER_MARGIN));
  if (counterBack) {
    const c = checks.find((x) => x.name === "under_ceiling");
    c.ok = true;
    c.detail = `${theirAmount} is over ${limit} by ${theirAmount - limit} — countering back at ${limit}`;
  }
  const passed = checks.every((c) => c.ok);
  const failed = checks.find((c) => !c.ok);
  return {
    kind: "counter_band", passed, checks, counterBack,
    releaseAmount: passed ? (counterBack ? limit : theirAmount) : 0,
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
  releasedToday = 0, now = Date.now(), moneyIn = defaultMoneyIn, comeDown = null,
} = {}) {
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail }); return Boolean(ok); };
  const ours = round(offer?.cashAmount);
  // "They accepted our number" — only if the offer's number IS our number.
  // 13041 SE 208th St (2026-09-25): the thread was at 400K, the row said
  // 416,500, and "I'll draw it up" was released as an acceptance of it.
  check("current_number", !comeDown,
    comeDown ? `we texted ${money(comeDown.amount)} after this offer's ${money(ours)} — re-quote first` : "");
  const said = moneyIn(inboundMessage).map(round);
  // "They agreed to accept 825,000" on our $825,240.29 is our number, rounded
  // the way people say it — Heather Vandyken's seller accepted (2026-09-14) and
  // it held as "a counter". Within $1k or 0.5% of ours, it's ours.
  const slack = Math.max(1000, Math.round(ours * 0.005));
  const strangers = said.filter((n) => !(ours > 0 && Math.abs(n - ours) <= slack));

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

/* ---------- the investor band (2026-09-17) ---------- */

// Matt, 2026-09-17: a buyer who pushes back on price ("it's a deal for me
// around 400k") used to wait for a person every time. The bot may now come
// down by itself, inside a band, and the band is the whole safety argument:
//
//   - the figure is THEIR OWN, typed in their message — never one we made up
//   - never under our contract price plus a minimum assignment fee
//   - never more than a few percent off asking, whatever the fee — a second,
//     independent rail, because the contract price on the deal is one typed
//     field and the floor is only as right as it is
//   - one concession per deal, ever, to anyone; a daily cap across deals
//   - a high-confidence read the model didn't flag for a person
//
// It never counters back at a number they didn't say, never mints a second
// concession, and never commits the buyer: marking them committed is still a
// person's press. Off by default; the autonomy dial turns it on at Full only.

// No setting may push the minimum fee under this.
export const INVESTOR_MIN_FEE_FLOOR = 5000;

/**
 * evaluateInvestorBand({ offer, asking, contactId, liveDeals, draft, inboundMessage,
 *                        band, releasedToday, now, moneyIn }) → verdict
 *
 *   offer      the deal (an offer with `.deal`) the pushback is about, or null
 *   asking     the price this buyer has been quoted (investorFacingPrice)
 *   liveDeals  every live deal this buyer is on, for "which one?"
 *
 * Every check is recorded, pass or fail, like the counter band's.
 */
export function evaluateInvestorBand({
  offer = null, asking = 0, contactId = "", liveDeals = [], draft = {}, inboundMessage = "", band = {},
  releasedToday = 0, now = Date.now(), moneyIn = defaultMoneyIn,
} = {}) {
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail }); return Boolean(ok); };
  const theirAmount = round(draft.counterAmount);
  const deal = offer?.deal || null;
  const contractPrice = round(deal?.contractPrice) || round(offer?.cashAmount);
  const minFee = Math.max(INVESTOR_MIN_FEE_FLOOR, round(band.minFee));
  const floor = contractPrice > 0 ? contractPrice + minFee : 0;
  const ask = round(asking);
  const dropPct = Math.min(15, Math.max(1, Number(band.maxDropPct) || 5));
  const dropLimit = ask > 0 ? Math.ceil(ask * (1 - dropPct / 100)) : 0;

  const said = moneyIn(inboundMessage).map(round);
  check("their_own_words", theirAmount > 0 && said.includes(theirAmount),
    theirAmount > 0 ? (said.includes(theirAmount) ? `they typed ${theirAmount}` : `${theirAmount} is not in their message`) : "no number read");
  check("one_deal", Boolean(offer?.id) && (liveDeals.length <= 1 || Boolean(draft.propertyAddress)),
    !offer?.id ? "no live deal of theirs to answer on" : liveDeals.length > 1 && !draft.propertyAddress ? `${liveDeals.length} live deals and no address named` : "one deal");
  const taken = (deal?.investors || []).some((i) => i?.status === "committed" && i.contactId !== contactId);
  check("deal_live", deal?.stage === "under_contract" && !taken,
    !deal ? "not a deal" : taken ? "spoken for by another buyer" : deal.stage === "under_contract" ? "under contract, still shopping" : `the deal is ${String(deal.stage).replace(/_/g, " ")}`);
  check("below_asking", ask > 0 && theirAmount > 0 && theirAmount < ask,
    ask > 0 ? (theirAmount < ask ? `${theirAmount} is under the ${ask} they were quoted` : `${theirAmount} is not under the ${ask} they were quoted`) : "no asking price on the deal");
  check("above_floor", floor > 0 && theirAmount >= floor,
    floor > 0 ? `${theirAmount} against a floor of ${floor} (contract plus the ${minFee} minimum fee)` : "no contract price on the deal");
  check("within_drop", dropLimit > 0 && theirAmount >= dropLimit,
    dropLimit > 0 ? `${theirAmount} against ${dropLimit}, ${dropPct}% off asking` : "no asking price on the deal");
  check("sure", draft.confidence === "high" && !draft.needsHuman,
    draft.needsHuman ? "the model flagged it for a person" : `confidence ${draft.confidence || "unknown"}`);
  check("once_per_deal", !deal?.investorBand?.at, deal?.investorBand?.at ? "this deal already came down once" : "first concession on this deal");
  const cap = Math.max(0, round(band.dailyCap));
  check("under_daily_cap", cap === 0 ? false : releasedToday < cap, cap === 0 ? "the daily cap is zero" : `${releasedToday} of ${cap} today`);

  const on = band.enabled === true;
  const bad = checks.find((c) => !c.ok);
  const passed = on && !bad;
  return {
    kind: "investor_band", passed, checks, theirAmount, asking: ask, floor, dropLimit, releaseAmount: passed ? theirAmount : 0,
    counterBack: false, offerId: offer?.id || null, at: new Date(now).toISOString(),
    reason: !on ? "the investor band is switched off" : bad ? bad.detail : `${theirAmount} is at or above the ${Math.max(floor, dropLimit)} limit`,
  };
}
