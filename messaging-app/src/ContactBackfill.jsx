// ContactBackfill.jsx — Settings → "Contact record": fill the app's record
// of every agent and investor from what already exists (offers, deals,
// drafts, dataroom views, and the GHL contact fields), and show how full it
// is. Safe to run again: a second pass inserts nothing.

import React, { useEffect, useRef, useState } from "react";
import { Database, Loader2, Square } from "lucide-react";
import { runContactBackfill, getContactBackfill, cancelContactBackfill } from "./api.js";
import { BTN, BTN_PRIMARY } from "./ui.jsx";

const PHASE = { collecting: "finding everyone", app: "reading offers, deals, drafts and dataroom views", ghl: "reading GHL contacts" };

export default function ContactBackfill() {
  const [state, setState] = useState({ job: null, stats: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef(null);
  const running = state.job?.status === "running";

  const refresh = () => getContactBackfill().then(setState).catch(() => {});
  useEffect(() => { refresh(); return () => clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (!running) return undefined;
    timer.current = setTimeout(refresh, 2000);
    return () => clearTimeout(timer.current);
  }, [running, state]);

  const start = async () => {
    setBusy(true); setError("");
    try { await runContactBackfill({}); await refresh(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const { job, stats } = state;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm text-slate-700">
        <span className="inline-flex items-center gap-1.5"><Database size={14} className="text-slate-400" />
          {stats ? <><span className="font-semibold tabular-nums">{stats.profiles}</span> people · <span className="font-semibold tabular-nums">{stats.events}</span> events on record</> : "…"}
        </span>
        {stats?.lastImportAt && <span className="text-xs text-slate-400">last filled {new Date(stats.lastImportAt).toLocaleString()}</span>}
        <span className="ml-auto flex items-center gap-2">
          {running ? (
            <button type="button" className={BTN} onClick={() => cancelContactBackfill().then(refresh)}><Square size={13} /> Stop</button>
          ) : (
            <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={start}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Database size={13} />} Fill the record
            </button>
          )}
        </span>
      </div>
      {job && (
        <div className={`rounded-lg px-3 py-2 text-xs ${job.status === "error" ? "bg-red-50 text-red-700" : running ? "bg-amber-50 text-amber-800" : "bg-slate-50 text-slate-600"}`}>
          {running
            ? <><Loader2 size={12} className="mr-1 inline animate-spin" />{PHASE[job.phase] || job.phase}{job.phase === "ghl" ? ` — ${job.done} of ${job.total}${job.currentName ? ` · ${job.currentName}` : ""}` : ""}</>
            : job.status === "error" ? `Stopped: ${job.error}`
            : `${job.status === "canceled" ? "Stopped early" : "Done"} — ${job.counts.contacts} people, ${job.counts.events} new events, ${job.counts.facts} new facts${job.counts.skipped ? `, ${job.counts.skipped} already on record` : ""}${job.counts.errors ? `, ${job.counts.errors} errors` : ""}`}
          {job.errors?.length > 0 && !running && (
            <ul className="mt-1 list-disc pl-4 text-red-700">{job.errors.slice(0, 5).map((e, i) => <li key={i}>{e}</li>)}</ul>
          )}
        </div>
      )}
      {error && <div className="text-xs text-red-700">{error}</div>}
    </div>
  );
}
