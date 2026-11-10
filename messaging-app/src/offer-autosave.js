// offer-autosave.js — the offer editor saves as you type (2026-10-23).
//
// Matt: "whatever we type just saves in real time … we can send it and then
// it'll update the status when sent and we can just triage from there." The
// editor used to have Save draft, Update draft, Create offer, Save changes and
// Save as new offer, and the same address kept collecting rows.
//
// What a save is depends on the row the form is on:
//   no row yet  → "draft"      POST /draft, once the form names a house and
//                              holds something worth keeping
//   a draft     → "draft"      POST /draft, the same row
//   an offer    → "live"       PUT /:id with live: the letter, the agent's
//                              link and the bot's number follow what you type
//               → "workspace"  PATCH /:id/workspace: comps or rehab work that
//                              doesn't change the letter
//
// The timing lives here, apart from the component, so it can be tested
// without a browser: one save at a time and in order, the latest form wins,
// a failure retries a few times, and leaving the form flushes what's pending.

import { parseUsAddress } from "@shared/us-address.js";

export const DRAFT_DELAY_MS = 800;
// A live save re-renders the letter, so it waits for the typing to settle.
export const LIVE_DELAY_MS = 2500;
export const RETRY_MS = 5000;
export const MAX_RETRIES = 3;

/** A house number and a street: enough to be a house. "12" and "Main St" are not. */
export function namesAHouse(address) {
  const p = parseUsAddress(String(address || ""));
  return Boolean(p.houseNo && /[a-z]/i.test(p.street || ""));
}

/** The row has paper (a letter, a PDF): it's an offer, not a draft. */
export const hasPaper = (row) => Boolean(row && (row.pdfUrl || row.documents));

/**
 * saveKindFor({ row, letterChanged }) → "draft" | "live" | "workspace"
 *   row            the row the form is on, or null for a blank form
 *   letterChanged  a figure, a term, the address — something the letter prints
 */
export function saveKindFor({ row = null, letterChanged = false } = {}) {
  if (!row || !hasPaper(row)) return "draft";
  return letterChanged ? "live" : "workspace";
}

/** Delay before a save of this kind runs. */
export const delayFor = (kind) => (kind === "live" ? LIVE_DELAY_MS : DRAFT_DELAY_MS);

/* ---------- a sent offer reopens at the price it went out at (2026-11-09) ---------- */
// The engine sent 254k; opening it to fix a term re-priced the letter to 300k on the first
// keystroke (UWM-03). The form was rebuilt from the saved workspace — whose figures are our comps'
// ARV and the bare scope, with no override — and today's location settings. A row with paper now
// reopens from what priced its letter: calc.inputs (the override included) and the price settings
// in calc.settings. A draft, or a blank form, is unchanged.

// The settings that set a comps price (shared/offer-calc.js calculateOffers). Presentation (the
// terms, the company, the expiry) stays today's.
export const PRICE_SETTING_KEYS = [
  "underwriteMode", "sellingCostPct", "flipProfitPct", "holdMonths", "holdingModel", "holdMonthlyCost",
  "loanToCostPct", "loanRatePct", "loanPointsPct", "taxRatePct", "insuranceRatePct", "utilitiesMonthly",
  "maoPctOfArv", "cashPctOfArv", "repairBuffer", "repairHeavyPctOfArv", "repairBaseMult", "repairHeavyMult",
  "wholesaleFee", "precisionJitter",
];
const BLANK_INPUTS = { address: "", askingPrice: "", arv: "", repairs: "", priceOverride: "" };
const fmtN = (n) => (Number(n) ? Number(n).toLocaleString("en-US") : "");
// A row with paper priced by comps: income and land rows are priced from their deal, which the
// form restores as it always has.
const pricedRow = (row) => (row && row.status !== "draft" && row.calc?.inputs
  && (!row.calc.model || row.calc.model === "comps") ? row : null);

/** pricedSettings(row) → the price settings a sent offer was priced at, or null (a draft, a blank form). */
export function pricedSettings(row) {
  const r = pricedRow(row);
  const s = r?.calc?.settings;
  if (!s) return null;
  const out = {};
  for (const k of PRICE_SETTING_KEYS) if (s[k] !== undefined && s[k] !== null && s[k] !== "") out[k] = s[k];
  return Object.keys(out).length ? out : null;
}

/**
 * engineOf({ restore, snap }) → the offer engine's read on a draft ({ grade, arv, rehab, rehabWhy,
 * open, walkAway, triage, reasons }), or null. The engine branch puts it on the held draft's form
 * copy (draft.engine); absent, nothing here changes.
 */
export function engineOf({ restore = null, snap = null } = {}) {
  const e = snap?.engine || restore?.draft?.engine || null;
  return e && typeof e === "object" ? e : null;
}

/** restoredInputs({ restore, snap, initialAddress }) → the form's first inputs. */
export function restoredInputs({ restore = null, snap = null, initialAddress = "" } = {}) {
  const r = pricedRow(restore);
  const figures = r ? {
    askingPrice: fmtN(r.calc.inputs.askingPrice),
    arv: fmtN(r.calc.inputs.arv),
    repairs: fmtN(r.calc.inputs.repairs),
    priceOverride: fmtN(r.calc.inputs.priceOverride),
  } : null;
  // A held engine draft nobody has saved yet opens on the engine's ARV and its rehab (the age
  // floor, never the bare scope). Once a person saves it, the form copy says so (engineApplied)
  // and it opens on what they typed. The price stays theirs to set.
  const engine = !r && restore?.status === "draft" && !snap?.engineApplied ? engineOf({ restore, snap }) : null;
  const fromEngine = engine ? {
    ...(Number(engine.arv) > 0 ? { arv: fmtN(engine.arv) } : {}),
    ...(Number(engine.rehab) > 0 ? { repairs: fmtN(engine.rehab) } : {}),
  } : null;
  if (snap?.inputs) return { ...BLANK_INPUTS, ...snap.inputs, ...(figures || fromEngine || {}) };
  if (!restore && /,/.test(initialAddress)) return { ...BLANK_INPUTS, address: initialAddress };
  if (r) return { ...BLANK_INPUTS, address: r.calc.inputs.address || "", ...figures };
  return { ...BLANK_INPUTS };
}

/** restoredUnderwriteMode({ restore, snap, settings }) → the mode the form opens on. */
export function restoredUnderwriteMode({ restore = null, snap = null, settings = null, fallback = "" } = {}) {
  const priced = pricedSettings(restore)?.underwriteMode;
  return priced || snap?.underwriteMode || (restore && restore.status !== "draft" ? restore.calc?.settings?.underwriteMode : "")
    || settings?.underwriteMode || fallback;
}

/**
 * editorSettings({ settings, priced, underwriteMode, feeOverride, uwOverrides, offerExpires, letterTerms })
 *   → what the preview, the letter and every save price with: today's settings, the price settings
 *     a sent offer went out at over them, and what you set on this offer over both.
 */
export function editorSettings({ settings = null, priced = null, underwriteMode = "", feeOverride = "", uwOverrides = {}, offerExpires = "", letterTerms = [] } = {}) {
  const s = { ...(settings || {}), ...(priced || {}), ...(underwriteMode ? { underwriteMode } : {}) };
  if (String(feeOverride).trim() !== "") {
    s.wholesaleFee = Number(String(feeOverride).replace(/[^\d]/g, "")) || 0;
  }
  for (const [k, v] of Object.entries(uwOverrides || {})) {
    const raw = String(v).trim();
    if (raw === "") continue;            // blank means "use the saved default"
    // Mid-typing garbage ("7." is fine, "7.5.5" isn't) keeps the default
    // rather than silently underwriting at zero.
    const n = Number(raw);
    if (Number.isFinite(n)) s[k] = n;
  }
  if (offerExpires) s.offerExpires = offerExpires;
  // The letter prints exactly these rows (after Purchase Price) — an empty
  // list is honored, so deleted rows stay deleted.
  s.letterTerms = (letterTerms || [])
    .map((r) => ({ label: String(r.label || "").trim(), value: String(r.value || "").trim() }))
    .filter((r) => r.label && r.value);
  return s;
}

/** raiseAskFrom(error) → { from, to, line } when the server refused a save as a raise on a sent offer. */
export function raiseAskFrom(error) {
  if (!error || error.needsConfirm !== "raise") return null;
  return { from: Number(error.from) || 0, to: Number(error.to) || 0, line: String(error.message || "") };
}

// A workspace write is inside a live one (the PUT carries the snapshot), so
// the bigger save absorbs the smaller.
const RANK = { workspace: 1, draft: 2, live: 3 };
const merge = (a, b) => (!a ? b : !b ? a : RANK[b] >= RANK[a] ? b : a);

/**
 * createAutosaver({ run, onState, timers }) → { schedule, flush, confirm, cancel, idle }
 *   run(kind, { final, confirmRaise? })  does the save; reads the form at call
 *                         time, so a save queued behind a slow one sends the latest
 *   onState({ phase, at?, error?, ask? })  "pending" | "saving" | "saved" |
 *                         "error" | "confirm" (the save would raise a sent
 *                         offer: `ask` is { from, to, line })
 *   timers                { setTimeout, clearTimeout } (tests pass fakes)
 *
 *   schedule(kind)        debounce a save of this kind
 *   flush({ final })      run what's pending now; final: you're leaving
 *   confirm()             you said yes to the raise: send it, marked confirmed
 *   cancel()              drop what's pending (the form is moving to another row)
 *   idle()                nothing pending, nothing running
 *
 * A save the server refuses as a raise on a sent offer (409 needsConfirm,
 * 2026-11-09) is not retried: what you typed stays in the form and pending,
 * and the next edit tries again (a lower number goes through). Only confirm()
 * sends the raise.
 */
export function createAutosaver({ run, onState = () => {}, timers = globalThis } = {}) {
  let timer = null;
  let pending = null;
  let running = 0;
  let tries = 0;
  let chain = Promise.resolve();
  let dead = false;
  let held = null;   // the raise the server asked about, until you confirm or a save goes through

  function arm(ms) {
    if (timer) timers.clearTimeout(timer);
    timer = timers.setTimeout(() => { timer = null; flush(); }, ms);
  }

  function schedule(kind) {
    if (dead || !kind) return;
    pending = merge(pending, kind);
    tries = 0;
    onState({ phase: "pending" });
    arm(delayFor(pending));
  }

  function flush({ final = false, confirmRaise = false } = {}) {
    if (timer) { timers.clearTimeout(timer); timer = null; }
    const kind = pending;
    pending = null;
    if (dead || (!kind && !final)) return chain;
    running += 1;
    chain = chain.then(async () => {
      onState({ phase: "saving" });
      try {
        await run(kind, confirmRaise ? { final, confirmRaise: true } : { final });
        tries = 0;
        held = null;
        onState(pending ? { phase: "pending" } : { phase: "saved", at: Date.now() });
      } catch (error) {
        // Put it back and try again shortly — unless the next edit already did.
        pending = merge(pending, kind);
        const ask = raiseAskFrom(error);
        if (ask) {
          // A raise on a sent offer waits for you: no retry.
          held = ask;
          onState({ phase: "confirm", ask, error });
        } else {
          tries += 1;
          onState({ phase: "error", error });
          if (tries < MAX_RETRIES && !final) arm(RETRY_MS);
        }
      } finally {
        running -= 1;
      }
    });
    return chain;
  }

  function confirm() {
    if (dead || !held) return chain;
    held = null;
    return flush({ confirmRaise: true });
  }

  function cancel() {
    if (timer) timers.clearTimeout(timer);
    timer = null;
    pending = null;
    dead = true;
  }

  return { schedule, flush, confirm, cancel, idle: () => !pending && !timer && running === 0 };
}
