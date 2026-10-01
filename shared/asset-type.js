// asset-type.js — what kind of house this is, and which buyers want that kind.
//
// 1510 Maple Lane, Kent (2026-10-01) was a 1978 mobile home in a park. The
// offer had no type on it, so the deal had none, so the blast on promote went
// to twenty-five Kent flippers as a "3bd 2ba" house — and none of the twenty
// buyers who had told us they buy mobile homes. Zillow had said MANUFACTURED
// the whole time, on the underwrite's subject record, where nothing read it.
//
// One vocabulary, three kinds: single family, multi-family, manufactured. A
// manufactured home also says whether the land comes with it, because that is
// the first thing a mobile home buyer asks ("no park homes").
//
// Pure. The offer editor, the Deals modal, the blast text, the ranking and the
// reply bot all read the kind from here.

export const ASSET_TYPES = ["sfr", "multi_family", "manufactured"];

export const ASSET_TYPE_LABELS = {
  sfr: "Single family",
  multi_family: "Multi-family",
  manufactured: "Manufactured / mobile",
};

export const MH_LAND = ["park", "own_lot"];

export const MH_LAND_LABELS = {
  park: "In a park (lot rent)",
  own_lot: "On its own lot",
};

// Zillow's homeType (SINGLE_FAMILY…) and RentCast's propertyType ("Single
// Family"…) both land here. Townhouses and condos are left unknown rather
// than guessed into a kind a buyer may refuse.
const HOME_TYPE_TO_ASSET = {
  single_family: "sfr",
  multi_family: "multi_family",
  manufactured: "manufactured",
  mobile: "manufactured",
  mobile_home: "manufactured",
};

/** assetFromHomeType("MANUFACTURED") → "manufactured"; anything else not ours → "" */
export function assetFromHomeType(v) {
  const k = String(v || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return HOME_TYPE_TO_ASSET[k] || "";
}

const asType = (v) => {
  const k = String(v || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (ASSET_TYPES.includes(k)) return k;
  if (k === "single_family" || k === "sfh") return "sfr";
  if (k === "mobile" || k === "mobile_home") return "manufactured";
  return "";
};

/**
 * normalizeAsset(v) → { type, land, by, at } | null
 *
 * `land` is kept only for a manufactured home. `by` says who decided: "you"
 * (picked on the offer or the deal) or "underwrite" (read off Zillow).
 */
export function normalizeAsset(v) {
  if (!v || typeof v !== "object") return null;
  const type = asType(v.type);
  if (!type) return null;
  const land = type === "manufactured" && MH_LAND.includes(v.land) ? v.land : "";
  const by = v.by === "underwrite" ? "underwrite" : "you";
  return { type, land, by, ...(v.at ? { at: String(v.at) } : {}) };
}

// The subject record the underwrite saved — the same place the blast and the
// dataroom read beds and baths from.
const subjectHomeType = (offer = {}) => {
  // A held draft keeps its workspace under `draft`, a priced offer under `snapshot`.
  const snap = offer?.snapshot || offer?.draft || {};
  return snap.subjectInfo?.homeType || snap.comps?.result?.info?.homeType || "";
};

/** assetFromSnapshot(offer) → { type, land: "", by: "underwrite" } | null */
export function assetFromSnapshot(offer = {}) {
  const type = assetFromHomeType(subjectHomeType(offer));
  return type ? { type, land: "", by: "underwrite" } : null;
}

/**
 * assetOf(offer) → { type, land, by } | null
 *
 * What the offer says it is; failing that, what Zillow said on its underwrite.
 * The deal lives on the offer, so this is the deal's kind too.
 */
export function assetOf(offer = {}) {
  return normalizeAsset(offer?.asset) || assetFromSnapshot(offer);
}

/** assetLabel(asset) → "Manufactured / mobile · in a park" | "" */
export function assetLabel(asset) {
  const a = normalizeAsset(asset);
  if (!a) return "";
  const land = a.land === "park" ? "in a park" : a.land === "own_lot" ? "own lot" : "";
  return [ASSET_TYPE_LABELS[a.type], land].filter(Boolean).join(" · ");
}

/**
 * assetPhrase(asset) → the words a buyer reads: "mobile home in a park",
 * "mobile home on its own lot", "mobile home", "multi-family". Single family
 * says nothing, so every house blast reads exactly as it always has.
 */
export function assetPhrase(asset) {
  const a = normalizeAsset(asset);
  if (!a) return "";
  if (a.type === "manufactured") {
    return a.land === "park" ? "mobile home in a park" : a.land === "own_lot" ? "mobile home on its own lot" : "mobile home";
  }
  return a.type === "multi_family" ? "multi-family" : "";
}

/* ---------- which buyers want it ---------- */

// A buy box's exclusions are one line of what they said, comma-joined
// ("no manufactured homes in parks, multi-family up to fourplex only"). Read
// clause by clause so "only" in one clause never leaks into another.
const clauses = (s) => String(s || "").toLowerCase().split(/[,;.\n]+/).map((c) => c.trim()).filter(Boolean);
const MOBILE_RE = /\b(manufactured|mobile|trailer|single[- ]wide|double[- ]wide)\b/;
const PARK_RE = /\b(park|parks|lot rent)\b/;
const NO_RE = /\b(no|not|never|won'?t|don'?t)\b/;
const ONLY_RE = /\bonly\b/;

/** exclusionsSay("…") → { noMobile, noPark, mobileOnly } */
export function exclusionsSay(text = "") {
  const out = { noMobile: false, noPark: false, mobileOnly: false };
  for (const c of clauses(text)) {
    if (/\bno\s+site[- ]built\b/.test(c)) { out.mobileOnly = true; continue; }
    const mobile = MOBILE_RE.test(c);
    if (NO_RE.test(c) && PARK_RE.test(c)) { out.noPark = true; continue; }   // "no manufactured homes in parks"
    if (mobile && NO_RE.test(c)) { out.noMobile = true; continue; }          // "no mobile homes"
    if (mobile && ONLY_RE.test(c)) out.mobileOnly = true;                    // "manufactured homes only"
  }
  return out;
}

const boxTypes = (b = {}) => (b.propertyTypes || []).map(asType).filter(Boolean);

/**
 * buyerTypeFit(buyer, asset) → { wants, refuses, reason }
 *
 * `buyer` carries `markets.types` (the dispo-type-* tags) and `buybox`
 * ({ propertyTypes, exclusions }). `wants` is something they told us; a buyer
 * nobody has asked is neither. `refuses` is a stated no:
 *   - "no mobile homes", or "no park homes" on a park deal;
 *   - on a mobile home, a documented list of kinds that leaves it out, from
 *     someone who hasn't otherwise said they want one. A tag beats a stale
 *     list: a buyer tagged mobile-home whose list says sfr and multi-family
 *     still wants one;
 *   - "mobile homes only" / "no site-built" on anything else. A house deal
 *     whose kind a buyer's list leaves out is NOT a refusal here — that stays
 *     the buy box's own -20 in rankForDeal, as it was before there was a kind.
 */
export function buyerTypeFit(buyer = {}, asset = null) {
  const a = normalizeAsset(asset);
  if (!a) return { wants: false, refuses: false, reason: "" };
  const b = buyer?.buybox || {};
  const said = exclusionsSay(b.exclusions);
  const types = boxTypes(b);
  if (a.type === "manufactured") {
    const wants = (buyer?.markets?.types || []).includes("mobile-home") || types.includes("manufactured") || said.mobileOnly;
    if (said.noMobile) return { wants, refuses: true, reason: "said no mobile homes" };
    if (a.land === "park" && said.noPark) return { wants, refuses: true, reason: "said no park homes" };
    if (!wants && types.length) return { wants, refuses: true, reason: "buys other kinds of houses" };
    return { wants, refuses: false, reason: wants ? "buys mobile homes" : "" };
  }
  const wants = types.includes(a.type);
  if (said.mobileOnly) return { wants: false, refuses: true, reason: "buys mobile homes only" };
  return { wants, refuses: false, reason: "" };
}

/* ---------- what we're buying right now ---------- */

// Matt, 2026-10-01: "focus on Single Family Residences." Multi-family stays
// a kind an offer can carry — it will be expanded into later — but it is not
// underwritten on its own yet, and neither is a townhouse, a condo, a mobile
// home or land. `settings.focusKinds` lists what the auto-underwrite prices;
// anything else is held for a person ("not our kind of house").
export const FOCUS_KINDS_DEFAULT = ["sfr"];

/** normalizeFocusKinds(v) → the kinds the machine underwrites; never empty. */
export function normalizeFocusKinds(v) {
  const out = (Array.isArray(v) ? v : []).map(asType).filter(Boolean);
  return out.length ? [...new Set(out)] : [...FOCUS_KINDS_DEFAULT];
}

// Zillow's word for a house we don't have a kind for, in plain English.
const OTHER_HOME_WORDS = { TOWNHOUSE: "a townhouse", CONDO: "a condo", LOT: "land", APARTMENT: "an apartment", COOPERATIVE: "a co-op" };
const KIND_WORDS = { sfr: "a single-family house", multi_family: "a multi-family", manufactured: "a mobile home" };

// What every not-our-kind hold reason starts with (held-underwrites.js keys on it).
export const KIND_HOLD_PREFIX = "not our kind of house";
export const KIND_HOLD = /^not our kind of house\b/i;

/**
 * kindHold(homeType, focusKinds) → the hold reason, or "" to go ahead.
 *
 * Unknown (Zillow didn't say) goes ahead: a house we can't type is more
 * likely a house than not, and holding every untyped listing would hold most
 * of what comes in by text.
 */
export function kindHold(homeType, focusKinds = FOCUS_KINDS_DEFAULT) {
  const raw = String(homeType || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!raw) return "";
  const kind = assetFromHomeType(raw);
  const focus = normalizeFocusKinds(focusKinds);
  if (kind && focus.includes(kind)) return "";
  const word = kind ? KIND_WORDS[kind] : OTHER_HOME_WORDS[raw] || `a ${raw.toLowerCase().replace(/_/g, " ")}`;
  const want = focus.length === 1 && focus[0] === "sfr" ? "single-family only right now" : `buying ${focus.map((k) => ASSET_TYPE_LABELS[k].toLowerCase()).join(", ")} right now`;
  return `${KIND_HOLD_PREFIX} — ${word} (${want})`;
}

/**
 * agentFocusRule(focusKinds) → the line the agent-side bot reads about what
 * we buy. Single-family only (the default): a condo, a townhouse, a mobile
 * home, a multi-family or land is said no to plainly, and the agent is asked
 * for single-family fixers instead — never strung along with "let me run
 * numbers" on a house the underwrite will hold.
 */
export function agentFocusRule(focusKinds = FOCUS_KINDS_DEFAULT) {
  const focus = normalizeFocusKinds(focusKinds);
  const buy = focus.map((k) => ({ sfr: "single-family houses", multi_family: "multi-family (2-4 units)", manufactured: "mobile homes" }[k])).join(" and ");
  const skip = ["condos", "townhouses", ...(focus.includes("manufactured") ? [] : ["mobile or manufactured homes"]),
    ...(focus.includes("multi_family") ? [] : ["multi-family"]), "land"].join(", ");
  return `WHAT WE BUY RIGHT NOW: ${buy} only. If the agent's house is plainly one of these — ${skip} — don't promise numbers on it: ` +
    `say kindly that we're only buying ${buy} right now and ask if they have any ${focus.includes("sfr") ? "single-family fixers" : buy} coming up. ` +
    "If you can't tell what kind of house it is, treat it as a house.";
}
