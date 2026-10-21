// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// deal-reply-match.js — which deal a buyer's reply is about, when they were
// sent more than one (2026-10-21).
//
// 3831 Bagley Ave N and 1538 NW 61st St were live the same week and went to
// the same buyers. One walked Bagley and texted "It's all lath and plaster,
// you gotta go down to the studs, that's 400k not 110k" — Bagley's rehab was
// 102k; 61st had none. It was filed on 61st, the newer blast, because the
// thread mentioned 61st last and the model named it. Bagley's post-mortem
// lost the one read from a buyer who'd walked it.
//
// So with two or more deals in play for a buyer: the street they name, then
// their numbers and words against each deal's, then the model's read, and
// when nothing tells them apart, no deal at all (a person files it).
//
// Pure.

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** sentDeal(offer, contactId) → true when this buyer was sent the deal or is on it. */
export function sentDeal(offer, contactId) {
  if (!offer?.deal || !contactId) return false;
  if ((offer.deal.investors || []).some((i) => i?.contactId === contactId)) return true;
  return (offer.deal.blasts || []).some((b) => (b?.contactIds || []).includes(contactId));
}

// "3831 Bagley Ave N, Seattle" → ["3831", "bagley"]; "1538 Nw 61st St" → ["1538", "61st"].
const GENERIC = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw", "north", "south", "east", "west",
  "st", "street", "ave", "avenue", "rd", "road", "dr", "drive", "pl", "place", "ln", "lane", "way", "ct", "court", "blvd", "hwy", "highway", "ter", "terrace", "cir", "loop"]);
function streetKeys(address = "") {
  const line = String(address || "").split(",")[0].toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();
  const words = line.split(/\s+/).filter(Boolean);
  const out = [];
  if (/^\d{2,6}$/.test(words[0] || "")) out.push(words[0]);
  const core = words.slice(1).find((w) => !GENERIC.has(w) && w.length >= 4);
  if (core) out.push(core);
  return out;
}
const says = (text, word) => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);

// Dollar figures in a text: "400k", "$750k", "1.15", "$911", "110,000".
// A bare 100–2,500 reads as thousands (how buyers write prices); a bare
// 1–5 with a decimal reads as millions ("comps that support 1.15").
export function buyerAmounts(text = "") {
  const out = [];
  const re = /\$?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|m|mil|million)?\b/gi;
  for (let m = re.exec(String(text || "")); m; m = re.exec(String(text || ""))) {
    const v = num(m[1].replace(/,/g, ""));
    const unit = String(m[2] || "").toLowerCase();
    let dollars = 0;
    if (unit === "k") dollars = v * 1000;
    else if (unit) dollars = v * 1e6;
    else if (v >= 10000) dollars = v;
    else if (v >= 100 && v <= 2500 && !/\./.test(m[1])) dollars = v * 1000;
    else if (v >= 1 && v < 6 && /\./.test(m[1])) dollars = v * 1e6;
    if (dollars > 0) out.push(Math.round(dollars));
  }
  return out;
}

// What a deal looks like from the buyer's side: its buyer price, ARV and rehab.
function dealFigures(offer = {}) {
  const d = offer.deal || {};
  const price = num(d.contractPrice) + num(d.assignmentFee);
  const arv = num(offer.arv ?? offer.calc?.inputs?.arv);
  const repairs = num(offer.repairs ?? offer.calc?.inputs?.repairs) || Math.round((offer.scope || []).reduce((t, s) => t + num(s?.cost), 0));
  return [price, arv, repairs, ...(d.blasts || []).map((b) => num(b?.price))].filter((v) => v > 0);
}
const near = (a, b, pct = 0.12) => a > 0 && b > 0 && Math.abs(a - b) <= b * pct;

const isLand = (offer) => offer?.asset?.type === "land";
const LAND_WORDS = /\b(?:land|lot|dirt|build(?:er|ing)?|townhomes?|townhouses?|d?adus?|zon(?:ed|ing)|units?|new construction|teardown)\b/i;
const HOUSE_WORDS = /\b(?:lath|plaster|studs|kitchen|baths?|bathroom|basement|roof|siding|floors?|rehab|remodel|reno|walked it|walk(?:ed)? through)\b/i;

/**
 * pickDealForReply(deals, { hint, said }) → { offer, why } | { offer: null, why }
 *
 *   deals  the open deals this buyer was sent (sentDeal)
 *   hint   the house the model read out of the reply
 *   said   their words (the reply, and the reason the model wrote down)
 *
 * why: "only" | "named" | "figures" | "words" | "hint" | "unclear"
 */
export function pickDealForReply(deals = [], { hint = "", said = "" } = {}) {
  const list = (deals || []).filter(Boolean);
  if (!list.length) return { offer: null, why: "unclear" };
  if (list.length === 1) return { offer: list[0], why: "only" };
  const text = String(said || "");

  // 1. The street or house number they wrote.
  const named = list.filter((o) => streetKeys(o.address).some((k) => says(text, k)));
  if (named.length === 1) return { offer: named[0], why: "named" };

  // 2. Their numbers against each deal's, then what kind of property they mean.
  const amounts = buyerAmounts(text);
  const score = (o) => {
    const figs = dealFigures(o);
    return amounts.filter((a) => figs.some((f) => near(a, f))).length;
  };
  const best = (fn) => {
    const scored = list.map((o) => ({ o, s: fn(o) })).sort((a, b) => b.s - a.s);
    return scored[0].s > 0 && scored[0].s > scored[1].s ? scored[0].o : null;
  };
  const byFigures = amounts.length ? best(score) : null;
  if (byFigures) return { offer: byFigures, why: "figures" };
  const land = LAND_WORDS.test(text), house = HOUSE_WORDS.test(text);
  if (land !== house) {
    const kind = list.filter((o) => isLand(o) === land);
    if (kind.length === 1) return { offer: kind[0], why: "words" };
  }

  // 3. The house the model named.
  const h = String(hint || "").trim();
  if (h) {
    const keys = streetKeys(h);
    const byHint = list.filter((o) => { const mine = streetKeys(o.address); return keys.length && keys.every((k) => mine.includes(k)); });
    if (byHint.length === 1) return { offer: byHint[0], why: "hint" };
  }
  return { offer: null, why: "unclear" };
}

export const _test = { streetKeys, dealFigures };
