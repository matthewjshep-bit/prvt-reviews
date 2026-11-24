// LastNightCard.jsx — what the nightly conversation audit checked, what it
// did on its own, and what it owes you, with a Run now. It lived on Reports →
// Activity until that page was retired (2026-11-23 audit, nav-2); it sits on
// More → Autopilot settings now, beside the coach. One local read on open,
// polled only while a run you started is going.

import React, { useEffect, useState } from "react";
import { getDashboardAudit, runDashboardAudit } from "./api.js";
import { AUDIT_KINDS } from "@shared/conversation-audit.js";

function Card({ title, children, right }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <h2 className="text-sm font-bold">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function ErrorNote({ message, onRetry }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-700">
      <span>Couldn't load — {message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="font-semibold underline">Retry</button>
      )}
    </div>
  );
}

// Last night: what the nightly audit checked, what it did on its own, and
// what it owes you: the day read and acted on. Matt, 2026-09-16.
export function LastNightCard({ audit, error, onRetry, onRun, running }) {
  if (error) return <Card title="Last night"><ErrorNote message={error} onRetry={onRetry} /></Card>;
  if (!audit) return null;
  const last = audit.last;
  const labelOf = Object.fromEntries(AUDIT_KINDS.map((k) => [k.key, k.label]));
  const when = (v) => (v ? new Date(v).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
  const yours = (last?.findings || []).filter((f) => f.severity !== "fyi" && (!f.action || f.action.type === "book_checkin"));
  const done = (last?.acted || []).filter((a) => ["started", "queued", "clocked", "closed"].includes(a.status));
  const fyi = (last?.findings || []).filter((f) => f.severity === "fyi");
  const row = (f, i) => (
    <li key={`${f.kind}-${f.contactId || f.offerId || i}-${i}`} className="text-sm text-slate-700">
      <span className="font-medium">{f.contactName || "An agent"}</span>
      {f.address ? <span className="text-slate-500"> · {String(f.address).split(",")[0]}</span> : null}
      <span className="text-slate-400"> — {labelOf[f.kind] || f.kind}{f.why ? `: ${f.why}` : ""}</span>
    </li>
  );
  return (
    <Card
      title="Last night"
      right={<span className="flex items-center gap-2 text-[11px] text-slate-400">
        {last ? `${last.trigger === "daily" ? "ran" : "run by hand"} ${when(last.finishedAt)}${last.dryRun ? " · dry run" : ""}` : `runs at ${audit.hour}:00 Pacific`}
        {audit.run && !audit.job ? " · a run started and never finished — retrying" : ""}
        <button type="button" disabled={running} onClick={onRun}
          className="rounded-md border border-slate-300 px-2 py-0.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40">
          {running ? "running…" : "Run now"}
        </button>
      </span>}
    >
      {!last ? (
        <div className="text-sm text-slate-400">Hasn't run yet.</div>
      ) : last.status === "error" ? (
        <div className="text-sm text-red-700">Failed: {last.error}</div>
      ) : (
        <>
          <div className="mb-3 text-sm text-slate-600">
            Checked <b>{last.counts?.touched ?? 0}</b> threads · <b>{last.counts?.answered ?? 0}</b> answered · <b>{last.counts?.queued ?? 0}</b> queued for this morning · <b>{last.counts?.clocked ?? 0}</b> put on a clock · <b>{yours.length}</b> need you
            {last.ghlRead === false ? <span className="text-amber-700"> · GHL wasn't read, so a text with no draft at all can't be seen</span> : null}
            {last.reason ? <span className="text-slate-400"> · {last.reason}</span> : null}
          </div>
          {last.counts?.held && !last.counts.held.error ? (
            <div className="mb-3 text-sm text-slate-600">
              Held underwrites: <b>{last.counts.held.held}</b> on the list · <b>{last.counts.held.dropped}</b> dropped · <b>{last.counts.held.retired}</b> closed out · <b>{last.counts.held.reran}</b> re-run on the agent's numbers · <b>{last.counts.held.asked}</b> asked for their read · <b>{last.counts.held.waiting}</b> waiting on them · <b>{last.counts.held.yours}</b> need you
            </div>
          ) : last.counts?.held?.error ? <div className="mb-3 text-sm text-amber-700">Held underwrites weren't swept: {last.counts.held.error}</div> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <div className="text-xs font-semibold text-slate-600">Need you <span className="font-normal text-slate-400">· {yours.length}</span></div>
              {yours.length ? <ul className="mt-1 space-y-0.5">{yours.slice(0, 12).map(row)}{yours.length > 12 && <li className="text-xs text-slate-400">+{yours.length - 12} more</li>}</ul>
                : <div className="mt-1 text-sm text-slate-400">Nothing — every thread is answered or on a clock.</div>}
            </div>
            <div>
              <div className="text-xs font-semibold text-slate-600">Done on its own <span className="font-normal text-slate-400">· {done.length}</span></div>
              {done.length ? (
                <ul className="mt-1 space-y-0.5">
                  {done.slice(0, 12).map((a, i) => (
                    <li key={`${a.kind}-${a.contactId}-${i}`} className="text-sm text-slate-700">
                      <span className="font-medium">{a.contactName || "An agent"}</span>
                      {a.address ? <span className="text-slate-500"> · {String(a.address).split(",")[0]}</span> : null}
                      <span className="text-slate-400"> — {String(a.action).replace(/_/g, " ")} ({a.status}{a.reason ? `: ${a.reason}` : ""})</span>
                    </li>
                  ))}
                </ul>
              ) : <div className="mt-1 text-sm text-slate-400">Nothing needed starting.</div>}
              {fyi.length ? <div className="mt-2 text-xs text-slate-400">{fyi.length} for information only ({[...new Set(fyi.map((f) => labelOf[f.kind] || f.kind))].join(", ")})</div> : null}
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

export default function LastNightPanel() {
  const [audit, setAudit] = useState(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const load = () => getDashboardAudit().then((a) => { setAudit(a); setError(""); setRunning(a?.job?.status === "running"); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  const run = async () => {
    setRunning(true);
    try { await runDashboardAudit({ dryRun: false }); } catch (e) { setError(e.message); setRunning(false); return; }
    const poll = setInterval(async () => {
      const a = await getDashboardAudit().catch(() => null);
      if (a) setAudit(a);
      if (!a || a.job?.status !== "running") { clearInterval(poll); setRunning(false); }
    }, 3000);
  };
  return <LastNightCard audit={audit} error={error} onRetry={load} onRun={run} running={running} />;
}
