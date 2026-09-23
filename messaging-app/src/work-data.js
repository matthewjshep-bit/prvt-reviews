// work-data.js — what Today's work pane has already loaded, kept by key, so
// walking back and forth with J/K is instant and the next row can be read
// ahead of time.
//
// One cache for the page (keys like "thread:<contactId>"). An entry older
// than its maxAge is shown while a fresh read runs behind it. `forget`
// drops keys after something changed them (a send, an op on the row).

import { useCallback, useEffect, useState } from "react";

const cache = new Map();      // key → { at, data, error }
const inflight = new Map();   // key → Promise

export function load(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve()
    .then(fn)
    .then((data) => { cache.set(key, { at: Date.now(), data, error: "" }); return data; })
    .catch((e) => { cache.set(key, { at: Date.now(), data: cache.get(key)?.data ?? null, error: e?.message || "couldn't load it" }); return null; })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Read ahead: load it now if it isn't fresh, and ignore the result. */
export function prefetch(key, fn, maxAgeMs = 60000) {
  if (!key) return;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < maxAgeMs) return;
  load(key, fn);
}

export function forget(...keys) { for (const k of keys) if (k) cache.delete(k); }

/**
 * useLoad(key, fn, { maxAgeMs, pollMs }) → { data, error, loading, reload }
 * A null key loads nothing (a row with no offer, no contact).
 */
export function useLoad(key, fn, { maxAgeMs = 60000, pollMs = 0 } = {}) {
  const [, bump] = useState(0);
  const hit = key ? cache.get(key) : null;
  const reload = useCallback(() => { if (key) load(key, fn).then(() => bump((n) => n + 1)); }, [key]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!key) return undefined;
    let live = true;
    const fresh = cache.get(key);
    if (!fresh || Date.now() - fresh.at >= maxAgeMs) load(key, fn).then(() => { if (live) bump((n) => n + 1); });
    let timer = null;
    if (pollMs > 0) {
      timer = setInterval(() => {
        if (typeof document !== "undefined" && document.hidden) return;
        load(key, fn).then(() => { if (live) bump((n) => n + 1); });
      }, pollMs);
    }
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [key]);   // eslint-disable-line react-hooks/exhaustive-deps

  return { data: hit?.data ?? null, error: hit?.error || "", loading: Boolean(key) && !hit, reload };
}
