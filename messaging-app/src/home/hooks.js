// home/hooks.js — data hooks for the Home sections. Each section owns its own
// hook instance; nothing is shared globally (split-ready). Fetching is lazy:
// a section only calls the broker once it becomes `active` (in view).

import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api.js";

// Load one section's queue. Fetches at most once until reload(), and only after
// `active` flips true (scroll-triggered lazy-load).
export function useSection(section, active) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const loadedRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api.getSection(section);
      setData(d);
    } catch (e) {
      setError(e.message || "Couldn’t load");
    } finally {
      setLoading(false);
    }
  }, [section]);

  useEffect(() => {
    if (active && !loadedRef.current) {
      loadedRef.current = true;
      load();
    }
  }, [active, load]);

  const reload = useCallback(() => { loadedRef.current = true; return load(); }, [load]);
  return { data, loading, error, reload };
}

// Render a per-contact card + message when a row is selected. Debounced-safe:
// stale responses for a previously-selected contact are discarded.
export function usePreview(section, contactId) {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!contactId) { setPreview(null); setError(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.previewRow(section, contactId)
      .then((p) => { if (!cancelled) setPreview(p); })
      .catch((e) => { if (!cancelled) setError(e.message || "Couldn’t render"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [section, contactId]);

  return { preview, loading, error };
}

// Imperative send actions with a small busy/result state machine.
export function useSend(section) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [audience, setAudience] = useState(null); // dry-run batch preview

  const sendOne = useCallback(async (contactId, opts) => {
    setBusy(true); setResult(null);
    try { const r = await api.sendOne(section, contactId, opts); setResult(r); return r; }
    finally { setBusy(false); }
  }, [section]);

  const previewAudience = useCallback(async (contactIds) => {
    setBusy(true); setAudience(null);
    try { const r = await api.sendBatch(section, { contactIds, dryRun: true }); setAudience(r); return r; }
    finally { setBusy(false); }
  }, [section]);

  const sendBatch = useCallback(async (contactIds) => {
    setBusy(true); setResult(null);
    try { const r = await api.sendBatch(section, { contactIds, dryRun: false }); setResult(r); return r; }
    finally { setBusy(false); }
  }, [section]);

  return { busy, result, audience, setAudience, sendOne, previewAudience, sendBatch };
}
