// UnderwriteStrip.jsx — what the robot is doing right now.
//
// An auto-underwrite is kicked off by a GHL workflow when a listing agent
// texts in, and takes two to five minutes (the Zillow photo scrapes dominate).
// That is long enough that "did my text actually start anything?" is a real
// question, and short enough that a whole page for it would be silly. So: a
// strip at the top of History, which is where you'd come to look at the result
// anyway, that disappears when there's nothing to say.
//
// It shows two things and nothing else — runs in flight, and runs that stopped
// and want a human. A finished offer is not listed here; it's in the table
// below with every other offer, which is the point.

import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, X } from "lucide-react";
import { fmtMoney } from "@shared/offer-calc.js";
import { cancelUnderwrite, getUnderwrites } from "./api.js";
import { BTN, Pill } from "./ui.jsx";

const POLL_MS = 5000;
const RECENT_MS = 60 * 60 * 1000;   // how long a held run keeps nagging

// Phase names the operator recognizes, not the ones the code uses.
const PHASE = {
  queued: "Queued",
  extracting: "Reading the address",
  subject: "Reading the listing",
  comps: "Pulling comps",
  grading: "Sorting comps by condition",
  arv: "Deriving ARV",
  rehab: "Scanning listing photos",
  creating: "Building the offer",
};

const LIVE = new Set(["queued", "running"]);

const elapsed = (job) => {
  const from = Date.parse(job.startedAt || "");
  if (!Number.isFinite(from)) return "";
  const to = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  const s = Math.max(0, Math.round((to - from) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

// A job is worth a row while it's live, and for an hour after it stopped
// needing attention. Successful runs drop off immediately — the offer they
// made is in the table underneath.
const worthShowing = (job) => {
  if (LIVE.has(job.status)) return true;
  if (job.status !== "held" && job.status !== "error") return false;
  const done = Date.parse(job.finishedAt || "");
  return !Number.isFinite(done) || Date.now() - done < RECENT_MS;
};

export default function UnderwriteStrip({ onReview }) {
  const [jobs, setJobs] = useState([]);
  const [dismissed, setDismissed] = useState(() => new Set());
  const timer = useRef(null);

  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const r = await getUnderwrites();
        if (!alive) return;
        const list = (r.jobs || []).filter(worthShowing);
        setJobs(list);
        // Poll fast only while something is actually moving. An idle History
        // tab left open all day shouldn't hit the broker every five seconds.
        const live = list.some((j) => LIVE.has(j.status));
        timer.current = setTimeout(tick, live ? POLL_MS : POLL_MS * 12);
      } catch {
        // The strip is decoration on a working page — a broker blip must not
        // put an error bar over History. Back off and try again.
        if (alive) timer.current = setTimeout(tick, POLL_MS * 12);
      }
    }
    tick();
    return () => { alive = false; clearTimeout(timer.current); };
  }, []);

  const shown = jobs.filter((j) => !dismissed.has(j.id));
  if (!shown.length) return null;

  return (
    <div className="mb-3 overflow-hidden rounded-xl border border-slate-300 bg-white shadow-sm">
      <div className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600">
        Auto-underwrites
      </div>
      <ul className="divide-y divide-slate-200">
        {shown.map((job) => (
          <li key={job.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
            <StatusIcon job={job} />
            <span className="font-semibold text-slate-900">
              {job.address || <span className="font-normal italic text-slate-500">no address found</span>}
            </span>
            {job.contactName && <span className="text-xs text-slate-500">{job.contactName}</span>}
            {job.dryRun && <Pill label="dry run" cls="bg-amber-100 text-amber-800" small />}

            <Detail job={job} />

            <div className="ml-auto flex items-center gap-2">
              <span className="tabular-nums text-xs text-slate-500">{elapsed(job)}</span>
              {LIVE.has(job.status) && (
                <button type="button" className={BTN} disabled={job.stopping}
                  onClick={() => cancelUnderwrite(job.id).catch(() => {})}>
                  {job.stopping ? "Stopping…" : "Stop"}
                </button>
              )}
              {job.status === "held" && job.offerId && (
                <button type="button" className={BTN} onClick={() => onReview?.(job.offerId)}>
                  Review draft
                </button>
              )}
              {!LIVE.has(job.status) && (
                <button type="button" aria-label="Dismiss"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                  onClick={() => setDismissed((d) => new Set([...d, job.id]))}>
                  <X size={14} />
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusIcon({ job }) {
  if (LIVE.has(job.status)) return <Loader2 size={14} className="shrink-0 animate-spin text-blue-600" />;
  if (job.status === "held") return <AlertTriangle size={14} className="shrink-0 text-amber-600" />;
  if (job.status === "error") return <AlertTriangle size={14} className="shrink-0 text-red-600" />;
  return <Check size={14} className="shrink-0 text-emerald-600" />;
}

// The middle column earns its space differently per state: a live run needs to
// say what it's doing, a held one needs to say why it stopped.
function Detail({ job }) {
  if (LIVE.has(job.status)) {
    return (
      <span className="text-xs text-slate-600">
        {PHASE[job.phase] || "Working"}
        {job.arv ? ` · ARV ${fmtMoney(job.arv)}` : ""}
      </span>
    );
  }
  if (job.status === "error") {
    return <span className="text-xs text-red-700">{job.error || "failed"}</span>;
  }
  if (job.status === "held") {
    return (
      <span className="text-xs text-amber-800">
        {(job.held || []).join(" · ") || "held for review"}
      </span>
    );
  }
  return (
    <span className="text-xs text-slate-600">
      {job.cashAmount ? `Offer ${fmtMoney(job.cashAmount)}` : "Done"}
    </span>
  );
}
