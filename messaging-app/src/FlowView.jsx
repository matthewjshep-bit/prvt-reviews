// FlowView.jsx — the river: how work moved from stage to stage in the
// window, and how much of each hop the machine did on its own.
//
// Two rows of stages (acquisition, then disposition), each a column with
// its count, a bar, and the machine/person split; arrows carry the share
// of the previous stage that reached this one. Under it: the switchboard,
// the queue, and the feed of everything that moved. One endpoint, polled
// every thirty seconds while the tab is visible.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, ArrowRight } from "lucide-react";
import { getDashboardFlow } from "./api.js";
import { groupByDay } from "@shared/contact-record.js";
import { BTN, ErrorBar, FilterChips, SkeletonRows } from "./ui.jsx";
import AutopilotCard from "./AutopilotCard.jsx";
import { EventDayGroups } from "./EventFeed.jsx";
import FlowStagePopout from "./FlowStagePopout.jsx";

const POLL_MS = 30000;
const RANGES = [{ days: 1, label: "Today" }, { days: 7, label: "Last 7 days" }, { days: 30, label: "Last 30 days" }];
const FEED_FILTERS = [
  { key: "all", label: "Everything" }, { key: "machine", label: "The machine" }, { key: "person", label: "People" },
  { key: "agent", label: "Acquisition" }, { key: "dispo", label: "Disposition" },
];
const localDayKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

function pipelineHref() {
  try { const u = new URL(window.location.href); u.searchParams.set("view", "pipeline"); return u.pathname + u.search; } catch { return "?view=pipeline"; }
}

/* ---------- the river ---------- */

// Every tile is clickable, zeros included: a dead tile reads as broken, and
// "nothing reached this stage" is an answer worth being able to ask for.
function Stage({ s, max, onPick }) {
  const h = max > 0 ? Math.max(s.count > 0 ? 6 : 0, Math.round((s.count / max) * 56)) : 0;
  const mh = s.count > 0 ? Math.round((s.machine / s.count) * h) : 0;
  return (
    <button type="button" onClick={() => onPick(s)} aria-haspopup="dialog"
      className="flex min-w-0 flex-1 flex-col items-center rounded-lg px-1 py-1 text-inherit transition-colors hover:bg-slate-50 hover:ring-1 hover:ring-slate-200"
      title={`${s.hint} — click to see which`}>
      <div className="text-2xl font-bold tabular-nums text-slate-900">{s.count}</div>
      <div className="flex h-14 w-full items-end justify-center">
        <div className="w-8 overflow-hidden rounded-t bg-slate-200" style={{ height: `${h}px` }}>
          <div className="w-full bg-violet-500" style={{ height: `${mh}px`, marginTop: `${h - mh}px` }} />
        </div>
      </div>
      <div className="mt-1 text-center text-xs font-semibold text-slate-700">{s.label}</div>
      <div className="text-center text-[11px] text-slate-400">
        {s.count > 0 ? <><span className="text-violet-600">{s.machine} machine</span> · {s.person} you</> : "—"}
      </div>
      {s.sub && <div className="text-center text-[11px] text-slate-500">{s.sub}</div>}
    </button>
  );
}

function Arrow({ pct }) {
  return (
    <div className="flex w-10 shrink-0 flex-col items-center justify-center pt-2 text-slate-300">
      <ArrowRight size={14} />
      {pct != null && <div className="text-[10px] tabular-nums text-slate-500">{pct}%</div>}
    </div>
  );
}

function River({ stages, onPick }) {
  const rows = [["agent", "Acquisition"], ["dispo", "Disposition"]].map(([side, title]) => ({ side, title, stages: stages.filter((s) => s.side === side) }));
  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
      {rows.map((r) => {
        const max = Math.max(1, ...r.stages.map((s) => s.count));
        return (
          <div key={r.side}>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{r.title}</div>
            <div className="flex items-start overflow-x-auto">
              {r.stages.map((s, i) => (
                <React.Fragment key={s.key}>
                  {i > 0 && <Arrow pct={s.conversion} />}
                  <Stage s={s} max={max} onPick={onPick} />
                </React.Fragment>
              ))}
            </div>
          </div>
        );
      })}
      <div className="flex items-center gap-3 text-[11px] text-slate-400">
        <span className="inline-block h-2.5 w-2.5 rounded-sm bg-violet-500" /> the machine on its own
        <span className="ml-2 inline-block h-2.5 w-2.5 rounded-sm bg-slate-200" /> a person
        <span className="ml-auto">arrows: share of the previous stage that reached this one</span>
      </div>
    </div>
  );
}

/* ---------- the page ---------- */

export default function FlowView() {
  const [days, setDays] = useState(7);
  const [endDate, setEndDate] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [filter, setFilter] = useState("all");
  // The open drill-down, mirrored into ?stage= so a tile can be linked to and
  // survives a reload. Held here rather than at the app root because a stage
  // popout means nothing outside this view.
  const [stage, setStage] = useState(() => {
    try { const s = new URL(window.location.href).searchParams.get("stage"); return s ? { key: s, label: "" } : null; } catch { return null; }
  });
  const gen = useRef(0);
  const viewDays = endDate ? 1 : days;

  function pickStage(s) {
    setStage(s ? { key: s.key, label: s.label } : null);
    try {
      const u = new URL(window.location.href);
      if (s) u.searchParams.set("stage", s.key); else u.searchParams.delete("stage");
      window.history.replaceState({}, "", u.pathname + u.search);
    } catch { /* the popout still works without the URL */ }
  }

  useEffect(() => {
    let live = true; let timer = null; const g = ++gen.current;
    async function tick() {
      if (!document.hidden) {
        setLoading(true);
        try { const r = await getDashboardFlow(viewDays, endDate); if (!live || g !== gen.current) return; setData(r); setError(""); }
        catch (e) { if (live) setError(e.message || "Couldn't load the flow."); }
        finally { if (live) setLoading(false); }
      }
      if (live) timer = setTimeout(tick, POLL_MS);
    }
    tick();
    return () => { live = false; clearTimeout(timer); };
  }, [viewDays, endDate, refreshKey]);

  const feed = useMemo(() => {
    const rows = (data?.feed || []).filter((f) =>
      filter === "all" ? true : filter === "machine" ? f.machine : filter === "person" ? !f.machine : f.side === filter);
    return groupByDay(rows);
  }, [data, filter]);

  if (!data && !error) return <SkeletonRows rows={5} />;
  const t = data?.totals || {};
  const q = data?.queue || {};

  return (
    <div className="space-y-4">
      {error && <ErrorBar>{error}{data ? " — showing what loaded last." : ""}</ErrorBar>}
      {data && !data.conversationEnabled && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">The Conversation AI is switched off, so nothing here is moving on its own.</div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <FilterChips value={endDate ? 0 : days} onChange={(d) => { setEndDate(""); setDays(d); }} label="Window"
          options={RANGES.map((r) => ({ key: r.days, label: r.label }))} />
        <input type="date" value={endDate} max={localDayKey()} onChange={(e) => setEndDate(e.target.value)}
          className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs" title="A single past day" />
        <span className="ml-auto text-xs text-slate-500">
          <b className="text-violet-600">{t.machine ?? 0}</b> moves by the machine · <b>{t.person ?? 0}</b> by you
          {t.messages ? ` · texts: ${t.messages.autoSent} sent itself, ${t.messages.personSent} by you` : ""}
        </span>
        <button type="button" className={BTN} onClick={() => setRefreshKey((k) => k + 1)} title="Refresh now">
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <River stages={data?.stages || []} onPick={pickStage} />
      {stage && (
        <FlowStagePopout stageKey={stage.key} days={viewDays} end={endDate}
          label={stage.label || (data?.stages || []).find((s) => s.key === stage.key)?.label || "Stage"}
          onClose={() => pickStage(null)} />
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2"><AutopilotCard autopilot={data?.autopilot} onDone={() => setRefreshKey((k) => k + 1)} /></div>
        <a href={pipelineHref()} className="block rounded-xl border border-slate-200 bg-white p-4 hover:border-blue-300">
          <div className="text-sm font-bold">Waiting on you</div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-center">
            {[["now", "Now", "text-rose-700"], ["soon", "Soon", "text-amber-700"], ["fyi", "FYI", "text-slate-600"]].map(([k, label, cls]) => (
              <div key={k}><div className={`text-2xl font-bold tabular-nums ${cls}`}>{q[k] ?? 0}</div><div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div></div>
            ))}
          </div>
          <div className="mt-2 text-xs text-blue-700">Open the queue →</div>
        </a>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-bold">What moved</h2>
          <FilterChips value={filter} onChange={setFilter} label="Show" options={FEED_FILTERS} />
          <span className="ml-auto text-xs text-slate-400">{(data?.feed || []).length} movements in the window{(data?.feed || []).length >= 200 ? " (newest 200)" : ""}</span>
        </div>
        {feed.length
          ? <EventDayGroups groups={feed} withLinks />
          : <div className="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-400">Nothing moved in this window{filter !== "all" ? " with that filter" : ""}.</div>}
      </div>
    </div>
  );
}
