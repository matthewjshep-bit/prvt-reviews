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

// A workspace write is inside a live one (the PUT carries the snapshot), so
// the bigger save absorbs the smaller.
const RANK = { workspace: 1, draft: 2, live: 3 };
const merge = (a, b) => (!a ? b : !b ? a : RANK[b] >= RANK[a] ? b : a);

/**
 * createAutosaver({ run, onState, timers }) → { schedule, flush, cancel, idle }
 *   run(kind, { final })  does the save; reads the form at call time, so a
 *                         save queued behind a slow one sends the latest
 *   onState({ phase, at?, error? })  "pending" | "saving" | "saved" | "error"
 *   timers                { setTimeout, clearTimeout } (tests pass fakes)
 *
 *   schedule(kind)        debounce a save of this kind
 *   flush({ final })      run what's pending now; final: you're leaving
 *   cancel()              drop what's pending (the form is moving to another row)
 *   idle()                nothing pending, nothing running
 */
export function createAutosaver({ run, onState = () => {}, timers = globalThis } = {}) {
  let timer = null;
  let pending = null;
  let running = 0;
  let tries = 0;
  let chain = Promise.resolve();
  let dead = false;

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

  function flush({ final = false } = {}) {
    if (timer) { timers.clearTimeout(timer); timer = null; }
    const kind = pending;
    pending = null;
    if (dead || (!kind && !final)) return chain;
    running += 1;
    chain = chain.then(async () => {
      onState({ phase: "saving" });
      try {
        await run(kind, { final });
        tries = 0;
        onState(pending ? { phase: "pending" } : { phase: "saved", at: Date.now() });
      } catch (error) {
        // Put it back and try again shortly — unless the next edit already did.
        pending = merge(pending, kind);
        tries += 1;
        onState({ phase: "error", error });
        if (tries < MAX_RETRIES && !final) arm(RETRY_MS);
      } finally {
        running -= 1;
      }
    });
    return chain;
  }

  function cancel() {
    if (timer) timers.clearTimeout(timer);
    timer = null;
    pending = null;
    dead = true;
  }

  return { schedule, flush, cancel, idle: () => !pending && !timer && running === 0 };
}
