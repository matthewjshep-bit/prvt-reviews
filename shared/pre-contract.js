// pre-contract.js — what to look at before we sign (2026-10-15).
//
// The Jul–Oct funnel review: 7 of 8 listed-house contracts fell through,
// against 1 of 5 off-market. The dead deals had the rehab low or the ARV high;
// two mobile homes were signed and then backed out of; one was signed with no
// buyer lined up. Each of those was knowable before the signature.
//
// This lists them from what the offer already holds, so a hot offer's Today
// row and the promote both say what nobody has looked at yet. Advisory: it
// never blocks a signature or a promote. Matt ticks an item by hand when he
// has checked it some other way (a call, a walkthrough, the agent remarks).
//
// Pure. `offer` is a full document or a lean row. A lean row has no listing
// remarks and no size, so those items read "not checked" on it; the Today
// route reads the full documents for the few hot offers.

import { remarkSignals } from "./house-facts.js";
import { rehabBand } from "./rehab-catalog.js";
import { assetOf, assetPhrase } from "./asset-type.js";
import { isOffMarket } from "./off-market.js";
import { buyerCeiling } from "./post-mortem.js";
import { priceAgreed, pushesToPaper, effectiveStatus, DEAD_STATUSES } from "./offer-status.js";

// The order they're read in, and what each is called on the row.
export const PRE_CONTRACT_ITEMS = [
  { key: "remarks", label: "Listing remarks read" },
  { key: "title", label: "Kind of house and title" },
  { key: "eyes", label: "Eyes on the house" },
  { key: "rehab_floor", label: "Rehab at or above the light floor" },
  { key: "arv_actives", label: "ARV under today's listings" },
  { key: "our_number", label: "At or under our number and the buyer ceiling" },
  { key: "extension", label: "An extension, not their deadline" },
  { key: "presell", label: "Pre-sold to 3 buyers" },
];
export const PRE_CONTRACT_KEYS = PRE_CONTRACT_ITEMS.map((i) => i.key);
const LABEL = Object.fromEntries(PRE_CONTRACT_ITEMS.map((i) => [i.key, i.label]));

// Fewer listing photos than this is not a look inside (the underwrite's own
// floor for a scope of work, auto-underwrite.js UW_MIN_SUBJECT_PHOTOS).
export const PRE_CONTRACT_MIN_PHOTOS = 8;
// A listed house is pre-sold when this many buyers have seen it.
export const PRESELL_MIN_BUYERS = 3;

const round = (v) => Math.round(Number(v) || 0);
const kText = (n) => {
  const v = round(n);
  return v >= 1e6 ? `${+(v / 1e6).toFixed(2)}M` : `${Math.round(v / 1000)}k`;
};
const str = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** normalizePreContract(raw) → { ticks: { key: { at, note } } }. Unknown keys are dropped. */
export function normalizePreContract(raw) {
  const src = raw && typeof raw === "object" && raw.ticks && typeof raw.ticks === "object" ? raw.ticks : {};
  const ticks = {};
  for (const key of PRE_CONTRACT_KEYS) {
    const t = src[key];
    if (!t || typeof t !== "object" || !t.at) continue;
    ticks[key] = { at: String(t.at), ...(str(t.note, 200) ? { note: str(t.note, 200) } : {}) };
  }
  return { ticks };
}

/**
 * tickPreContract(preContract, { key, done, note }, now) → preContract
 * A hand tick, or taking one back (`done: false`). Unknown key → unchanged.
 */
export function tickPreContract(pc, { key, done = true, note = "" } = {}, now = Date.now()) {
  const cur = normalizePreContract(pc);
  if (!PRE_CONTRACT_KEYS.includes(key)) return cur;
  const ticks = { ...cur.ticks };
  if (done) ticks[key] = { at: new Date(now).toISOString(), ...(str(note, 200) ? { note: str(note, 200) } : {}) };
  else delete ticks[key];
  return { ticks };
}

/**
 * needsPreContract(offer) → boolean
 *
 * The offer is close to paper: the price is agreed, you flagged it, or the
 * agent said they're writing it up — and it isn't a deal yet.
 */
export function needsPreContract(offer) {
  if (!offer || offer.deal) return false;
  const status = effectiveStatus(offer);
  if (DEAD_STATUSES.has(status) || status === "draft") return false;
  return pushesToPaper(offer) || offer.hot?.signal === "writing_up";
}

// The snapshot a priced offer keeps, or a held draft's workspace.
const snapOf = (offer) => offer?.snapshot || offer?.draft || null;

function remarksOf(offer) {
  const s = snapOf(offer);
  return String(s?.rehab?.listing?.remarks || "").trim();
}

// The buyer-view checks' flag keys: the full record's, else the lean row's.
function checkFlagKeys(offer) {
  const full = snapOf(offer)?.checks?.flags;
  if (Array.isArray(full)) return full.map((f) => f?.key).filter(Boolean);
  return Array.isArray(offer?.checks?.flags) ? offer.checks.flags.filter((k) => typeof k === "string") : [];
}

function sqftOf(offer) {
  const s = snapOf(offer) || {};
  return round(s.subjectSqft) || round(s.subjectInfo?.sqft || s.subjectInfo?.livingArea) || round(s.comps?.result?.info?.sqft) || 0;
}

function arvOf(offer) {
  return round(offer?.arv ?? offer?.calc?.inputs?.arv ?? offer?.draftInputs?.arv ?? offer?.draft?.inputs?.arv);
}

function repairsOf(offer) {
  const named = round(offer?.repairs ?? offer?.calc?.inputs?.repairs ?? offer?.draftInputs?.repairs ?? offer?.draft?.inputs?.repairs);
  if (named) return named;
  return round((offer?.scope || []).reduce((t, s) => t + (Number(s?.cost) || 0), 0));
}

// Title and use words a listing can carry (shared/house-facts.js LEGAL).
const TITLE_KEYS = ["land_lease", "hoa", "easement", "right_of_way", "unpermitted"];
const TITLE_WORDS = { land_lease: "leased land, park rules or 55+", hoa: "an HOA", easement: "an easement", right_of_way: "a right-of-way", unpermitted: "unpermitted work" };

/**
 * preContractChecks({ offer, settings, videos, price, fee }) →
 *   [{ key, label, state: "ok" | "warn" | "unknown", detail }]
 *
 *   settings  the location's offer settings (the buyer ceiling's percent and fee)
 *   videos    the offer's videos (store.listOfferVideos), when read
 *   price     the price we'd sign at; default: the agreed price, else our number
 *   fee       our fee, for the buyer ceiling; default: the settings'
 *
 * "warn" is something the record says is wrong; "unknown" is something
 * nobody has looked at. Both are open; only "ok" is done.
 */
export function preContractChecks({ offer = {}, settings = {}, videos = [], price = null, fee } = {}) {
  const ticks = normalizePreContract(offer?.preContract).ticks;
  const out = [];
  const add = (key, state, detail) => {
    const t = ticks[key];
    if (t && state !== "ok") out.push({ key, label: LABEL[key], state: "ok", detail: `you checked it${t.note ? `: ${t.note}` : ""}`, ticked: true });
    else out.push({ key, label: LABEL[key], state, detail });
  };

  const remarks = remarksOf(offer);
  const signals = remarks ? remarkSignals(remarks) : null;
  const flags = checkFlagKeys(offer);

  /* --- the listing remarks --- */
  if (signals) {
    const named = [
      ...signals.defects.map((d) => d.label),
      ...signals.layout.filter((l) => l.key === "low_ceiling" || l.key === "converted_rooms").map((l) => l.label),
      ...(signals.contents ? ["contents left behind"] : []),
    ];
    add("remarks", named.length ? "warn" : "ok",
      named.length ? `the listing mentions ${named.join(", ")} — is it in the rehab?` : "read: nothing the rehab doesn't cover");
  } else if (flags.some((k) => k.startsWith("remarks_"))) {
    add("remarks", "warn", "the listing names a defect — open the offer and check it's priced");
  } else {
    add("remarks", "unknown", "no listing remarks on file — ask the agent what the remarks and agent remarks say");
  }

  /* --- the kind of house and its title --- */
  const asset = assetOf(offer);
  const titleHits = new Set([
    ...(signals ? signals.legal.map((l) => l.key) : []),
    ...flags.filter((k) => k.startsWith("legal_")).map((k) => k.slice("legal_".length)),
  ].filter((k) => TITLE_KEYS.includes(k)));
  if (asset?.type === "manufactured") {
    add("title", "warn", `a ${assetPhrase(asset) || "mobile home"} — we don't buy mobile or manufactured homes`);
  } else if (titleHits.size) {
    add("title", "warn", `the listing shows ${[...titleHits].map((k) => TITLE_WORDS[k]).join(", ")} — check title before you sign`);
  } else if (signals || flags.length) {
    add("title", "ok", "no land lease, 55+, HOA or easement in the listing");
  } else {
    add("title", "unknown", "not checked — ask the agent about a land lease, 55+, an HOA or an easement");
  }

  /* --- eyes on the house --- */
  const photos = round(offer?.autoUnderwrite?.photosAnalyzed);
  const vids = (Array.isArray(videos) ? videos : []).filter((v) => v && v.status !== "uploading").length;
  if (vids > 0) add("eyes", "ok", `${vids} video${vids === 1 ? "" : "s"} on file`);
  else if (photos >= PRE_CONTRACT_MIN_PHOTOS) add("eyes", "ok", `${photos} listing photos scanned`);
  else if (photos > 0) add("eyes", "warn", `only ${photos} listing photo${photos === 1 ? "" : "s"} — ask for a video or walk it`);
  else add("eyes", "unknown", "nobody has seen inside — ask for a video or walk it");

  /* --- the rehab floor --- */
  const sqft = sqftOf(offer);
  const repairs = repairsOf(offer);
  const band = rehabBand(sqft);
  if (!band || !repairs) {
    add("rehab_floor", "unknown", !repairs ? "no rehab figure on file" : "no size on file to measure the rehab against");
  } else if (repairs < band.light[0]) {
    add("rehab_floor", "warn", `rehab ${kText(repairs)} is under the light floor (${kText(band.light[0])}) for ${sqft.toLocaleString("en-US")} sqft — the deals that died had rehab low`);
  } else {
    add("rehab_floor", "ok", `rehab ${kText(repairs)} for ${sqft.toLocaleString("en-US")} sqft (light floor ${kText(band.light[0])})`);
  }

  /* --- the ARV against what similar houses list for --- */
  const arv = arvOf(offer);
  const full = snapOf(offer)?.checks;
  const cap = full?.cap;
  const capped = full?.arv?.capped || null;
  if (!arv) add("arv_actives", "unknown", "no ARV on file");
  else if (capped?.to > 0) {
    add("arv_actives", arv > round(capped.to) * 1.01 ? "warn" : "ok",
      arv > round(capped.to) * 1.01 ? `ARV ${kText(arv)} is above the listings cap (${kText(capped.to)}) it was held to` : `held to today's listings (${kText(capped.to)})`);
  } else if (cap?.status === "ok" && Number(cap.amount) > 0) {
    add("arv_actives", arv > round(cap.amount) ? "warn" : "ok",
      arv > round(cap.amount)
        ? `ARV ${kText(arv)} is above what ${cap.n || "similar"} similar houses list for (${kText(cap.amount)}) — the deals that died had ARV high`
        : `ARV ${kText(arv)} vs ${kText(cap.amount)} listed`);
  } else if (!full && offer?.checks?.capped) {
    add("arv_actives", "ok", "held to today's listings");
  } else if (cap?.status === "thin") {
    add("arv_actives", "unknown", `too few similar listings to compare${cap.label ? ` (${cap.label})` : ""}`);
  } else {
    add("arv_actives", "unknown", "the listings check didn't run on this offer — look at what similar houses list for");
  }

  /* --- never above our own number, or what a buyer will pay --- */
  const ours = round(offer?.cashAmount);
  const agreed = priceAgreed(offer);
  const at = round(price) || round(agreed?.amount) || round(offer?.contract?.fields?.price) || ours;
  const ceiling = (() => { try { return buyerCeiling({ offer, settings, ...(fee != null ? { fee } : {}) }); } catch { return { computable: false }; } })();
  const over = [];
  if (ours && at > ours + Math.max(1000, ours * 0.005)) over.push(`${kText(at)} is above our number (${kText(ours)})`);
  if (ceiling.computable && at > ceiling.withFee) over.push(`${kText(at)} is over the buyer ceiling (${kText(ceiling.withFee)}: ${ceiling.pct}% of ARV less rehab and our fee)`);
  if (!at) add("our_number", "unknown", "no price on file");
  else if (over.length) add("our_number", "warn", over.join("; "));
  else if (!ceiling.computable) add("our_number", "unknown", `${kText(at)} — no ARV for the buyer ceiling`);
  else add("our_number", "ok", `${kText(at)}: at or under our ${kText(ours || at)} and the buyer ceiling ${kText(ceiling.withFee)}`);

  /* --- an extension, not a signature on their deadline --- */
  add("extension", "unknown", "if they want it signed by a date, ask for more time instead of signing to it");

  /* --- a listed house is pre-sold before we sign --- */
  if (!isOffMarket(offer)) {
    const n = new Set((offer?.presell?.contactIds || []).filter(Boolean)).size;
    if (n >= PRESELL_MIN_BUYERS) add("presell", "ok", `${n} buyers have it${offer.presell?.at ? ` (${String(offer.presell.at).slice(0, 10)})` : ""}`);
    else add("presell", "warn", n ? `only ${n} buyer${n === 1 ? "" : "s"} so far — pre-sell to ${PRESELL_MIN_BUYERS}` : `no buyer has seen it — pre-sell to ${PRESELL_MIN_BUYERS} before you sign`);
  }
  return out;
}

/** openChecks(checks) → the ones not done ("warn" first, then "unknown"). */
export function openChecks(checks = []) {
  const rank = { warn: 0, unknown: 1 };
  return (checks || []).filter((c) => c && c.state !== "ok").sort((a, b) => (rank[a.state] ?? 2) - (rank[b.state] ?? 2));
}

/**
 * preContractRecord(checks, now) → what a deal keeps at promote:
 * { at, open: [keys], checks: [{ key, state, detail }] }
 */
export function preContractRecord(checks = [], now = Date.now()) {
  return {
    at: new Date(now).toISOString(),
    open: openChecks(checks).map((c) => c.key),
    checks: (checks || []).map((c) => ({ key: c.key, state: c.state, detail: str(c.detail, 200) })),
  };
}
