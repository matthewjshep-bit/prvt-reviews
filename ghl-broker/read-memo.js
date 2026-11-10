// read-memo.js — the heavy pages share one compute (2026-11-09).
//
// On 11-09 the one broker that takes GHL's webhooks flapped 502 for about six
// minutes right after Reports → Line was opened: /line and /followup cached a
// minute AFTER they finished, with nothing in flight, so two opens at once
// both ran both check-in planners (each reads up to 100,000 events), and
// /outreach/pulse ran the agent planner again with no cache at all (28
// seconds). Three pieces here keep that from happening again:
//
//   createMemo   one compute per key at a time: a second asker joins the one
//                running (even with ?fresh=1), and a finished result is kept
//                `ttlMs`. Keep DERIVED results in it (a page, a plan), never
//                the raw reads behind them.
//   heavyGate    the heavy computes run one at a time, across every route. A
//                compute already inside the gate (Line asking for the
//                check-in plan) passes straight through.
//   settingsSig  a short fingerprint of the saved settings. A memo keyed on
//                it is cleared by a settings save, whichever route saved.

import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

/** settingsSig(saved) → 16 hex characters; any change to the settings changes it. */
export function settingsSig(saved) {
  return crypto.createHash("sha1").update(JSON.stringify(saved ?? {})).digest("hex").slice(0, 16);
}

/**
 * createGate(limit) → gate(run): at most `limit` runs at once; the rest wait
 * their turn in order. A run started inside a run of the same gate doesn't
 * wait (it would wait on itself).
 */
export function createGate(limit = 1) {
  const inside = new AsyncLocalStorage();
  const waiting = [];
  let active = 0;
  const gate = async (run) => {
    if (inside.getStore()) return run();
    if (active < limit) active++;
    else await new Promise((r) => waiting.push(r)); // the slot is handed over
    try {
      return await inside.run(true, run);
    } finally {
      const next = waiting.shift();
      if (next) next(); else active--;
    }
  };
  gate.stats = () => ({ active, waiting: waiting.length });
  return gate;
}

// The one gate the heavy page computes share: Line, Follow-up, Flow and the
// check-in plans.
export const heavyGate = createGate(1);

/**
 * createMemo({ ttlMs, gate, maxKeys }) → { get(key, run, opts), peek(key), clear() }
 *
 *   get(key, run, { sig, fresh, now })
 *     joins a compute of `key` already running with the same `sig`; else
 *     answers a result younger than `ttlMs` with the same `sig` (unless
 *     `fresh`); else runs `run()` behind `gate` and keeps what it returns.
 *     A failure is never kept. A different `sig` (the settings changed)
 *     never reuses an old result.
 *   `now` is the caller's clock (tests); age is |now - at|.
 */
export function createMemo({ ttlMs, gate = null, maxKeys = 64 } = {}) {
  const done = new Map();      // key -> { at, sig, value }
  const inflight = new Map();  // key -> { sig, promise }
  const usable = (hit, sig, now, since) => hit && hit.sig === sig && Math.abs(now - hit.at) < ttlMs && hit.at >= since;
  function start(key, sig, now, run) {
    const promise = Promise.resolve().then(run).then((value) => {
      done.delete(key);
      done.set(key, { at: now, sig, value });
      while (done.size > maxKeys) done.delete(done.keys().next().value);
      return value;
    }).finally(() => { if (inflight.get(key)?.promise === promise) inflight.delete(key); });
    inflight.set(key, { sig, promise });
    return promise;
  }
  function get(key, run, { sig = "", fresh = false, now = Date.now() } = {}) {
    const going = inflight.get(key);
    if (going && going.sig === sig) return going.promise;
    // ?fresh=1 takes only a result computed after it asked.
    const since = fresh ? now : -Infinity;
    const hit = done.get(key);
    if (usable(hit, sig, now, since)) return Promise.resolve(hit.value);
    if (!gate) return start(key, sig, now, run);
    // Behind the gate, look again: whoever held it may have just made this.
    return gate(() => {
      const g = inflight.get(key);
      if (g && g.sig === sig) return g.promise;
      const h = done.get(key);
      if (usable(h, sig, now, since)) return h.value;
      return start(key, sig, now, run);
    });
  }
  return {
    get,
    peek: (key) => done.get(key) || null,
    running: (key) => inflight.has(key),
    clear: () => { done.clear(); },
  };
}
