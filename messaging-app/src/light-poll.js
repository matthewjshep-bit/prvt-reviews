// light-poll.js — re-read a cheap endpoint now and then, and only while the
// page is in front of someone (2026-11-23 audit, table-never-refreshes).
//
// The broker that serves these reads also takes GHL's webhooks, and a burst
// of heavy reads knocked it over on 11-09. So: one request at a time, every
// few minutes at most, none while the tab is hidden, and one when Matt comes
// back to the tab if the last read is a minute old. Only ever for the light
// reads (the lean offer rows, the Needs Matt cursor), never the activity or
// follow-up planners.

import { useEffect, useRef } from "react";

export const LIGHT_POLL_MS = 3 * 60 * 1000;
export const ON_RETURN_MIN_GAP_MS = 60 * 1000;

/** pollDue({ hidden, busy, lastAt, now, minGapMs }) → whether to read now. */
export function pollDue({ hidden = false, busy = false, lastAt = 0, now = Date.now(), minGapMs = 0 } = {}) {
  if (hidden || busy) return false;
  return now - (lastAt || 0) >= minGapMs;
}

/**
 * useLightPoll(read, { everyMs, enabled }) — calls `read` every `everyMs`
 * while the tab shows, and when the tab comes back after a minute away.
 * Never on mount: the page's own first load does that.
 */
export function useLightPoll(read, { everyMs = LIGHT_POLL_MS, enabled = true } = {}) {
  const ref = useRef(read);
  ref.current = read;
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return undefined;
    let busy = false;
    let lastAt = Date.now();
    const run = async (minGapMs) => {
      if (!pollDue({ hidden: document.hidden, busy, lastAt, minGapMs })) return;
      busy = true;
      lastAt = Date.now();
      try { await ref.current(); } catch { /* the next tick tries again */ } finally { busy = false; }
    };
    const timer = setInterval(() => run(everyMs - 1000), everyMs);
    const onVisible = () => { if (!document.hidden) run(ON_RETURN_MIN_GAP_MS); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [enabled, everyMs]);
}
