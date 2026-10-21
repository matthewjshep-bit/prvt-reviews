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
import { rehabBand, gutSignal, gutRehab, GUT_PER_SQFT } from "./rehab-catalog.js";
import { assetOf, assetPhrase } from "./asset-type.js";
import { isOffMarket, onMarketCue } from "./off-market.js";
import { buyerCeiling, amountsIn } from "./post-mortem.js";
import { parseThread } from "./deal-feedback.js";
import { underwriteModel } from "./underwrite-model.js";
import { priceAgreed, pushesToPaper, offerHeat, effectiveStatus, DEAD_STATUSES } from "./offer-status.js";

// The order they're read in, and what each is called on the row.
// 2026-10-21: the agent's own texts joined the list. In 8 of the 10 deals that
// fell through, what killed it was in the listing agent's thread before we
// signed — "it's a teardown", "one other offer", "a back up at 750k", the
// park and its lot rent — and the price we signed at was the number they
// named first (1538 NW 61st St, 3831 Bagley Ave N, 5232 S Yakima, Bellevue).
export const PRE_CONTRACT_ITEMS = [
  { key: "remarks", label: "Listing remarks read" },
  { key: "agent_words", label: "What the agent said about it" },
  { key: "title", label: "Kind of house and title" },
  { key: "eyes", label: "Eyes on the house" },
  { key: "rehab_floor", label: "Rehab at or above the floor" },
  { key: "arv_actives", label: "ARV under today's listings" },
  { key: "land_value", label: "Land priced off land sales" },
  { key: "our_number", label: "At or under our number and the buyer ceiling" },
  { key: "their_number", label: "Our number, not theirs" },
  { key: "competing", label: "Nobody else bidding" },
  { key: "fast_yes", label: "Not a same-day yes" },
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
 * houseWordsUpdate(offer, { onMarket, paper, draftId }, now) → { offMarket?, paperAt? } | null
 *
 * What the listing agent just said about how the house is being sold, as
 * fields to write on its row:
 *   onMarket  their words say someone else is bidding or it's listed
 *             (shared/off-market.js onMarketCue) — a machine's off-market
 *             mark comes off; yours stays (3831 Bagley Ave N, 2026-10-13).
 *   paper     the paperwork is coming or signed (contract-signed.js
 *             paperworkSignal, or their "I'll write it up") — the signing
 *             moment, which needsPreContract reads (1538 NW 61st St).
 * Null when there's nothing to change.
 */
export function houseWordsUpdate(offer, { onMarket = "", paper = "", draftId = null } = {}, now = Date.now()) {
  if (!offer || offer.deal) return null;
  const at = new Date(now).toISOString();
  const out = {};
  const mark = offer.offMarket;
  if (onMarket && mark?.value === true && mark.by !== "you") {
    out.offMarket = { value: false, by: "machine", why: `they said "${str(onMarket, 60).toLowerCase()}"`, at };
  }
  const rank = { writing_up: 1, sent_to_sign: 2, signed: 3 };
  const had = offer.paperAt;
  const fresh = had?.at && now - (Date.parse(had.at) || 0) <= PRE_CONTRACT_FRESH_DAYS * 86400000;
  if (paper && rank[paper] && (!fresh || (rank[paper] || 0) > (rank[had.kind] || 0))) {
    out.paperAt = { at: fresh ? had.at : at, kind: paper, signalAt: at, ...(draftId ? { draftId } : {}) };
  }
  return Object.keys(out).length ? out : null;
}

/**
 * needsPreContract(offer) → boolean
 *
 * The offer is close to paper: the price is agreed, you flagged it, or the
 * agent said they're writing it up — and it isn't a deal yet. Only inside
 * PRE_CONTRACT_FRESH_DAYS of that moment: an old yes is history.
 */
// A yes or a write-up older than this is history, not a signing (2026-10-15:
// the first live read had six rows for agreements weeks old).
export const PRE_CONTRACT_FRESH_DAYS = 14;

export function needsPreContract(offer, { now = Date.now(), freshDays = PRE_CONTRACT_FRESH_DAYS } = {}) {
  if (!offer || offer.deal) return false;
  const status = effectiveStatus(offer);
  const fresh = (at) => { const t = Date.parse(at || ""); return Number.isFinite(t) && now - t <= freshDays * 86400000; };
  if (DEAD_STATUSES.has(status)) return false;
  // The agent sent the paper, or said it's signed: the signing moment, on a
  // held draft too — the app may never have priced it (1538 NW 61st St).
  if (fresh(offer.paperAt?.at)) return true;
  if (status === "draft") return false;
  if (offer.hot?.signal === "writing_up" && fresh(offer.hot.at)) return true;
  if (!pushesToPaper(offer)) return false;
  // A fresh yes, or a house you flagged hot yourself lately.
  const heat = offerHeat(offer);
  return fresh(priceAgreed(offer)?.at) || (heat?.by === "you" && fresh(heat.at));
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

const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

// A yes inside this many hours of our first number on the house is a same-day yes.
export const FAST_YES_HOURS = 24;

// When our first number on the house went out: a send, a float, the
// status history's first "sent".
function firstNumberMs(offer) {
  const at = [
    ...(Array.isArray(offer?.sends) ? offer.sends.map((x) => ms(x?.ts)) : []),
    ms(offer?.proactive?.realmCheckAt), ms(offer?.floatSentAt),
    ...(offer?.statusHistory || []).filter((h) => h?.status === "sent").map((h) => ms(h.ts)),
  ].filter((v) => v != null);
  return at.length ? Math.min(...at) : null;
}

// The photo scan's graded areas, where the snapshot keeps them.
function scanAreas(offer) {
  const s = snapOf(offer) || {};
  return s.rehab?.aiResult?.areas || s.rehabState?.aiResult?.areas || [];
}

// The thread as [{ dir: "US" | "THEM", text, at }], from the transcript text
// (enrich.js buildTranscript) or lines already split.
function threadLines(thread) {
  if (Array.isArray(thread)) {
    return thread.map((l) => ({ dir: String(l?.dir || "").toUpperCase() === "IN" || l?.dir === "THEM" ? "THEM" : "US", text: String(l?.body ?? l?.text ?? ""), at: l?.at || null }))
      .filter((l) => l.text.trim());
  }
  if (!thread) return [];
  return parseThread(String(thread)).map((l) => ({
    dir: l.dir === "THEM" ? "THEM" : "US",
    text: [l.body, ...(l.transcript || []).map((t) => t.text)].filter(Boolean).join(" "),
    at: l.at,
  })).filter((l) => l.text.trim());
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
export function preContractChecks({ offer = {}, settings = {}, videos = [], price = null, fee, thread = null, now = Date.now() } = {}) {
  const ticks = normalizePreContract(offer?.preContract).ticks;
  const out = [];
  // `short` is the warn in a few words, for the one-line verdict a ping carries.
  const add = (key, state, detail, short = "") => {
    const t = ticks[key];
    if (t && state !== "ok") out.push({ key, label: LABEL[key], state: "ok", detail: `you checked it${t.note ? `: ${t.note}` : ""}`, ticked: true });
    else out.push({ key, label: LABEL[key], state, detail, ...(state === "warn" && short ? { short } : {}) });
  };

  const remarks = remarksOf(offer);
  const signals = remarks ? remarkSignals(remarks) : null;
  const flags = checkFlagKeys(offer);
  // The listing agent's thread (enrich.js buildTranscript text), when read.
  const lines = threadLines(thread);
  const theirs = lines.filter((l) => l.dir === "THEM").map((l) => l.text).join("\n");
  const land = assetOf(offer)?.type === "land";

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

  /* --- what the agent said about it --- */
  const gut = gutSignal({ said: theirs, remarks, areas: scanAreas(offer) });
  if (lines.length) {
    const told = remarkSignals(theirs);
    const said = [
      ...(gut?.source === "agent" ? [gut.why.replace(/^the agent said /, "")] : []),
      ...told.defects.map((d) => d.label),
      // What killed deals, not what a buyer asks about: a park or land lease
      // (1510 Maple Ln), unpermitted work. Septic or an HOA isn't a warning.
      ...told.legal.filter((l) => l.key === "land_lease" || l.key === "unpermitted").map((l) => l.label),
      ...(/\b(?:was |been |has been )?moved\b(?: (?:twice|two times|2x|once))?/i.test(theirs) && /\b(?:mobile|manufactured|home|house)\b/i.test(theirs) ? ["moved"] : []),
    ];
    if (said.length) add("agent_words", "warn", `the agent said ${[...new Set(said)].join(", ")} — is it in the price?`, `the agent said ${[...new Set(said)][0]}`);
    else add("agent_words", "ok", "nothing in the agent's texts the price doesn't cover");
  } else {
    add("agent_words", "unknown", "the agent's texts weren't read — what did they say about its condition?");
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
  if (land) {
    // Land is priced off land sales (land_value), not a rehab.
  } else if (gut && sqft > 0 && repairs < gutRehab(sqft)) {
    add("rehab_floor", "warn", `rehab ${kText(repairs)} is under the gut tier (${kText(gutRehab(sqft))} at $${GUT_PER_SQFT}/sqft) — ${gut.why}`,
      `rehab ${kText(repairs)} vs ${kText(gutRehab(sqft))} for a gut`);
  } else if (!band || !repairs) {
    add("rehab_floor", "unknown", !repairs ? "no rehab figure on file" : "no size on file to measure the rehab against");
  } else if (repairs < band.light[0]) {
    add("rehab_floor", "warn", `rehab ${kText(repairs)} is under the light floor (${kText(band.light[0])}) for ${sqft.toLocaleString("en-US")} sqft — the deals that died had rehab low`,
      `rehab ${kText(repairs)} under the floor`);
  } else {
    add("rehab_floor", "ok", `rehab ${kText(repairs)} for ${sqft.toLocaleString("en-US")} sqft (light floor ${kText(band.light[0])})`);
  }

  /* --- the ARV against what similar houses list for --- */
  const arv = arvOf(offer);
  const full = snapOf(offer)?.checks;
  const cap = full?.cap;
  const capped = full?.arv?.capped || null;
  if (land) {
    // An "ARV" on land is whatever the form held — the asking price, on
    // 1538 NW 61st St. What land sells for is the question (land_value).
  } else if (!arv) add("arv_actives", "unknown", "no ARV on file");
  else if (capped?.to > 0) {
    add("arv_actives", arv > round(capped.to) * 1.01 ? "warn" : "ok",
      arv > round(capped.to) * 1.01 ? `ARV ${kText(arv)} is above the listings cap (${kText(capped.to)}) it was held to` : `held to today's listings (${kText(capped.to)})`);
  } else if (cap?.status === "ok" && Number(cap.amount) > 0) {
    add("arv_actives", arv > round(cap.amount) ? "warn" : "ok",
      arv > round(cap.amount)
        ? `ARV ${kText(arv)} is above what ${cap.n || "similar"} similar houses list for (${kText(cap.amount)}) — the deals that died had ARV high`
        : `ARV ${kText(arv)} vs ${kText(cap.amount)} listed`,
      `ARV ${kText(arv)} over listings at ${kText(cap.amount)}`);
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
  // A land "ARV" is no value at all, so there is no buyer ceiling on land.
  const ceiling = land ? { computable: false } : (() => { try { return buyerCeiling({ offer, settings, ...(fee != null ? { fee } : {}) }); } catch { return { computable: false }; } })();
  const over = [];
  const shorts = [];
  const unpriced = !ours || effectiveStatus(offer) === "draft";
  if (unpriced) { over.push(`we never priced this house${at ? ` — ${kText(at)} is a number nobody here underwrote` : ""}`); shorts.push("we never priced it"); }
  if (!unpriced && at > ours + Math.max(1000, ours * 0.005)) { over.push(`${kText(at)} is above our number (${kText(ours)})`); shorts.push(`${kText(at - ours)} over our ${kText(ours)}`); }
  if (ceiling.computable && at > ceiling.withFee) { over.push(`${kText(at)} is over the buyer ceiling (${kText(ceiling.withFee)}: ${ceiling.pct}% of ARV less rehab and our fee)`); shorts.push(`over the ${kText(ceiling.withFee)} ceiling`); }
  if (over.length) add("our_number", "warn", over.join("; "), shorts.join(", "));
  else if (!at) add("our_number", "unknown", "no price on file");
  else if (!ceiling.computable) add("our_number", "unknown", `${kText(at)} — ${land ? "land has no buyer ceiling; see the land value" : "no ARV for the buyer ceiling"}`);
  else add("our_number", "ok", `${kText(at)}: at or under our ${kText(ours || at)} and the buyer ceiling ${kText(ceiling.withFee)}`);

  /* --- land, priced off land sales --- */
  if (land) {
    const uw = underwriteModel(offer) === "land" ? offer?.calc?.underwrite : null;
    const value = round(uw?.value);
    const sales = Array.isArray(uw?.comps) ? uw.comps.length : 0;
    if (value > 0 && sales > 0) {
      add("land_value", at > value ? "warn" : "ok",
        at > value ? `${kText(at)} is above the land value (${kText(value)} off ${sales} land sale${sales === 1 ? "" : "s"})` : `land valued at ${kText(value)} off ${sales} land sale${sales === 1 ? "" : "s"}`,
        `over the ${kText(value)} land value`);
    } else {
      add("land_value", "warn", "nobody valued the land — price it off land sales (per lot or per buildable unit), not the asking price or the agent's word",
        "the land was never valued");
    }
  }

  /* --- their number, or ours --- */
  // The first line on the thread that names the price we'd sign at: theirs
  // means their number became the contract (1538 NW 61st St: "that dirt lot
  // is worth about $900,000" → signed at 890k; 3831 Bagley: "you might need
  // to be more like 740k" → 740k).
  if (at && lines.length) {
    const first = lines.find((l) => amountsIn(l.text).some((a) => Math.abs(a - at) <= Math.max(2000, at * 0.015)));
    if (first?.dir === "THEM") add("their_number", "warn", `${kText(at)} is the number the agent named first ("${str(first.text, 90)}")`, `${kText(at)} is the agent's number`);
    else if (first) add("their_number", "ok", `${kText(at)} came from us`);
    else add("their_number", "ok", `nobody named ${kText(at)} on the thread before`);
  } else if (at) {
    add("their_number", "unknown", "the agent's texts weren't read — whose number is this?");
  }

  /* --- someone else bidding --- */
  if (lines.length) {
    const cue = lines.filter((l) => l.dir === "THEM").map((l) => onMarketCue(l.text)).find(Boolean) || "";
    if (cue) add("competing", "warn", `the agent said "${cue}" — someone else is bidding; an end-user's price leaves no wholesale spread`, `someone else is bidding ("${cue}")`);
    else add("competing", "ok", "no other offer or backup mentioned");
  } else {
    add("competing", "unknown", "ask whether there are other offers or a backup");
  }

  /* --- a same-day yes --- */
  // Every deal signed inside about a day of our first number died; the
  // ones that closed took 5–11 days of back and forth.
  const firstNumberAt = firstNumberMs(offer);
  const yesAt = ms(agreed?.at) ?? ms(offer?.paperAt?.at) ?? now;
  // Unpriced is our_number's warning; there's no first number to time.
  if (unpriced) add("fast_yes", "unknown", "we never priced it, so there's no first number to time");
  else if (firstNumberAt != null && yesAt - firstNumberAt < FAST_YES_HOURS * 3600000) {
    add("fast_yes", "warn", `a yes ${Math.max(1, Math.round((yesAt - firstNumberAt) / 3600000))}h after our first number — every deal signed that fast fell through; ask for feasibility and the earnest money after it`, "a same-day yes");
  } else if (firstNumberAt != null) add("fast_yes", "ok", `${Math.round((yesAt - firstNumberAt) / 86400000)} days from our first number`);
  else add("fast_yes", "unknown", "when our first number went isn't on file");

  /* --- an extension, not a signature on their deadline --- */
  add("extension", "unknown", "if they want it signed by a date, ask for more time instead of signing to it");

  /* --- a listed house is pre-sold before we sign --- */
  if (!isOffMarket(offer)) {
    const n = new Set((offer?.presell?.contactIds || []).filter(Boolean)).size;
    if (n >= PRESELL_MIN_BUYERS) add("presell", "ok", `${n} buyers have it${offer.presell?.at ? ` (${String(offer.presell.at).slice(0, 10)})` : ""}`);
    else add("presell", "warn", n ? `only ${n} buyer${n === 1 ? "" : "s"} so far — pre-sell to ${PRESELL_MIN_BUYERS}` : `no buyer has seen it — pre-sell to ${PRESELL_MIN_BUYERS} before you sign`,
      n ? `pre-sold to ${n}` : "not pre-sold");
  }
  return out;
}

/**
 * preContractVerdict(checks, { address, price }) → one line, at most 300 characters
 *
 * What a GHL ping to Matt carries at the signing moment: the warns in a few
 * words each, and the move. "1538 NW 61st St at 890k: we never priced it ·
 * the agent said "teardown" · 890k is the agent's number · not pre-sold —
 * ask for feasibility with the earnest money after it, or don't sign."
 */
export function preContractVerdict(checks = [], { address = "", price = 0 } = {}) {
  const street = String(address || "").split(",")[0].trim();
  const head = `${street || "This house"}${round(price) ? ` at ${kText(price)}` : ""}`;
  const warns = (checks || []).filter((c) => c?.state === "warn");
  const unknown = (checks || []).filter((c) => c?.state === "unknown").length;
  const tail = warns.length ? " — ask for feasibility with the earnest money after it, or don't sign." : " — ask for feasibility with the earnest money after it.";
  if (!warns.length) return `${head}: nothing flagged${unknown ? `, ${unknown} not checked` : ""}${tail}`.slice(0, 300);
  const bits = warns.map((c) => c.short || c.label.toLowerCase());
  // Fit 300: drop from the end, and say how many more.
  for (let n = bits.length; n > 0; n--) {
    const more = bits.length - n;
    const line = `${head}: ${bits.slice(0, n).join(" · ")}${more ? ` · ${more} more` : ""}${tail}`;
    if (line.length <= 300) return line;
  }
  return `${head}: ${warns.length} warnings${tail}`.slice(0, 300);
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
