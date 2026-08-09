// EnrichSweep.jsx — the "scan conversations at will" panel (Settings → AI
// conversation sweep). Picks a time window, starts a batch enrichment job on
// the broker, and polls progress while it walks every recently-active
// agent/investor contact: transcript → Claude → buy box / areas served /
// personal details auto-applied, with an audit note per contact.

import React, { useEffect, useRef, useState } from "react";
import { Loader2, Radar, Square } from "lucide-react";
import { startEnrichSweep, getEnrichSweep, cancelEnrichSweep } from "./api.js";

const WINDOWS = [
  { key: "today", label: "Today" },
  { key: "24h", label: "Last 24 hours" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
];

function sinceFor(key) {
  if (key === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
  const hours = { "24h": 24, "7d": 24 * 7, "30d": 24 * 30 }[key] || 24;
  return new Date(Date.now() - hours * 3600000).toISOString();
}

const STATUS_STYLE = {
  updated: "bg-emerald-100 text-emerald-800",
  no_changes: "bg-slate-100 text-slate-600",
  skipped: "bg-amber-50 text-amber-700",
  error: "bg-red-100 text-red-700",
};
const STATUS_LABEL = { updated: "updated", no_changes: "no changes", skipped: "skipped", error: "error" };

export default function EnrichSweep() {
  const [win, setWin] = useState("today");
  const [types, setTypes] = useState({ investor: true, agent: true });
  const [repliesOnly, setRepliesOnly] = useState(true);
  const [job, setJob] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showAll, setShowAll] = useState(false);
  const timer = useRef(null);

  const running = job?.status === "running";

  // Restore any in-flight or recent job on mount; poll while one runs.
  useEffect(() => {
    getEnrichSweep().then(setJob).catch(() => {});
    return () => clearTimeout(timer.current);
  }, []);
  useEffect(() => {
    if (!running) return undefined;
    timer.current = setTimeout(async () => {
      try { setJob(await getEnrichSweep()); } catch { /* poll again next tick */ }
    }, 2500);
    return () => clearTimeout(timer.current);
  }, [job, running]);

  async function start() {
    setBusy(true);
    setError("");
    setShowAll(false);
    try {
      const selected = ["agent", "investor"].filter((t) => types[t]);
      const j = await startEnrichSweep({
        since: sinceFor(win),
        windowLabel: WINDOWS.find((w) => w.key === win)?.label || win,
        types: selected,
        repliesOnly,
      });
      setJob(j);
    } catch (e) {
      setError(e.message);
      // 409 = already running (maybe from another tab) — surface it instead.
      if (e.status === 409) getEnrichSweep().then(setJob).catch(() => {});
    }
    setBusy(false);
  }

  async function cancel() {
    try { await cancelEnrichSweep(); } catch { /* next poll shows the truth */ }
  }

  const toggleType = (t) => setTypes((s) => {
    const next = { ...s, [t]: !s[t] };
    return next.investor || next.agent ? next : s; // at least one stays on
  });

  const results = job?.results || [];
  const interesting = results.filter((r) => r.status === "updated" || r.status === "error");
  const shown = showAll ? results : interesting;
  const c = job?.counts || {};

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <select value={win} onChange={(e) => setWin(e.target.value)} disabled={running}
          className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none">
          {WINDOWS.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
        </select>
        {["investor", "agent"].map((t) => (
          <label key={t} className="flex items-center gap-1.5 text-sm text-slate-700">
            <input type="checkbox" checked={types[t]} disabled={running} onChange={() => toggleType(t)} />
            {t === "investor" ? "Investors" : "Agents"}
          </label>
        ))}
        <label className="flex items-center gap-1.5 text-sm text-slate-700"
          title="Skip contacts whose only activity in the window is our own outbound messages — no reply, no AI cost">
          <input type="checkbox" checked={repliesOnly} disabled={running}
            onChange={(e) => setRepliesOnly(e.target.checked)} />
          Replied only
        </label>
        {!running ? (
          <button type="button" disabled={busy} onClick={start}
            className="ml-auto flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Radar size={15} />}
            Scan conversations
          </button>
        ) : (
          <button type="button" onClick={cancel}
            className="ml-auto flex items-center gap-1.5 rounded-lg border border-slate-300 px-3.5 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            <Square size={13} /> Stop
          </button>
        )}
      </div>
      {error && <div className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}

      {job && (
        <div className="mt-3 rounded-lg border border-slate-200 p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
            {running && <Loader2 size={13} className="animate-spin text-blue-600" />}
            <span className="font-semibold">
              {running
                ? job.phase === "collecting"
                  ? "Finding active conversations…"
                  : `Enriching ${job.done + 1} of ${job.total}${job.currentName ? ` — ${job.currentName}` : ""}`
                : job.status === "done" ? "Sweep finished"
                : job.status === "canceled" ? "Sweep stopped"
                : `Sweep failed${job.error ? ` — ${job.error}` : ""}`}
            </span>
            <span className="ml-auto text-slate-400">
              {job.windowLabel}{job.trigger === "nightly" ? " · nightly" : ""}
              {job.startedAt ? ` · ${new Date(job.startedAt).toLocaleString()}` : ""}
            </span>
          </div>
          {job.total > 0 && (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-blue-600 transition-all"
                style={{ width: `${Math.round((job.done / job.total) * 100)}%` }} />
            </div>
          )}
          {(job.done > 0 || !running) && (
            <div className="mt-2 text-xs text-slate-500">
              {c.updated || 0} updated · {c.no_changes || 0} no changes · {c.skipped || 0} skipped · {c.errors || 0} errors
              {job.overCap > 0 && ` · ${job.overCap} active contacts beyond the per-run cap`}
            </div>
          )}

          {shown.length > 0 && (
            <ul className="mt-2 max-h-64 divide-y divide-slate-100 overflow-y-auto text-sm">
              {shown.map((r) => (
                <li key={r.contactId} className="flex items-start gap-2 py-1.5">
                  <span className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[r.status] || STATUS_STYLE.no_changes}`}>
                    {STATUS_LABEL[r.status] || r.status}
                  </span>
                  <div className="min-w-0">
                    <span className="font-medium text-slate-800">{r.name}</span>
                    {r.type && <span className="ml-1.5 text-[11px] uppercase tracking-wide text-slate-400">{r.type}</span>}
                    <div className="text-xs text-slate-500">
                      {r.status === "updated" && [
                        ...(r.fields || []).map((f) => `${f.name}: ${f.value}`),
                        ...(r.tagsAdded || []).map((t) => `+${t}`),
                        ...(r.tagsRemoved || []).map((t) => `−${t}`),
                      ].join(" · ")}
                      {r.status === "skipped" && r.reason}
                      {r.status === "error" && r.error}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {results.length > interesting.length && (
            <button type="button" onClick={() => setShowAll((v) => !v)}
              className="mt-1.5 text-xs font-semibold text-blue-600 hover:underline">
              {showAll ? "Show only updates and errors" : `Show all ${results.length} contacts`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
