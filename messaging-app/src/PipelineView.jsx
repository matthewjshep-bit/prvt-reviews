// PipelineView.jsx — the Today app (/dashboard): where everything stands,
// and the queue of what needs a person. Two tabs share it: section="queue"
// (the Desk — the work pane, WorkView.jsx) and section="board" (The board).
//
// The Desk (2026-10-02, shared/desk.js) is the queue one row per person, in
// Call · Decide · The machine is on it, with today's numbers against the
// line's targets above it. A broker that predates it sends only `actions`,
// and the old groups come back.
//
// One endpoint, polled every fifteen seconds (paused while the tab is
// hidden). Anything a button does bumps the refresh, so the board and the
// queue move together. On a fetch error the last good data stays up with a
// bar above it rather than the page going blank. The autopilot switches live
// on /autopilot; here it is one status line that links there.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { getDashboardPipeline } from "./api.js";
import { appHref } from "./links.js";
import { BTN, ErrorBar, FilterChips, SearchInput, SkeletonRows } from "./ui.jsx";
import WorkView from "./WorkView.jsx";
import { DESK_GROUPS, TODAY_GROUPS } from "./work-queue.js";
import PipelineBoard from "./PipelineBoard.jsx";

const POLL_MS = 15000;
const SIDES = [{ key: "all", label: "Everything" }, { key: "agent", label: "Acquisition" }, { key: "dispo", label: "Disposition" }];

// Today against the line's targets: the calls (the one job that is yours),
// the offers out, what's hot, and contracts this month. Settings → Line
// targets sets the targets.
export function DeskKpis({ kpis }) {
  if (!kpis) return null;
  const { calls = {}, offers = {}, contracts = {} } = kpis;
  const tone = (n, target) => (target > 0 && n >= target ? "text-emerald-700" : "text-slate-900");
  const Tile = ({ label, children, title }) => (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-1.5" title={title}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-sm text-slate-600">{children}</div>
    </div>
  );
  return (
    <div className="flex flex-wrap gap-2" aria-label="Today's numbers">
      <Tile label="Calls today" title="Calls placed today, and how many were a conversation">
        <b className="text-base tabular-nums text-slate-900">{calls.tried || 0}</b> placed · <b className="tabular-nums text-slate-900">{calls.talked || 0}</b> talked
      </Tile>
      <Tile label="Offers out today" title="Written offers sent today against the daily target, and numbers floated">
        <b className={`text-base tabular-nums ${tone(offers.sent || 0, offers.target)}`}>{offers.sent || 0}</b>{offers.target ? <span className="tabular-nums"> / {offers.target}</span> : null}
        {offers.floated ? <span> · {offers.floated} floated</span> : null}
      </Tile>
      <Tile label="Hot" title="Offers with a price agreed or flagged hot, not yet a deal">
        <b className="text-base tabular-nums text-slate-900">{kpis.hot || 0}</b>
      </Tile>
      <Tile label="Contracts this month" title="Deals that went under contract this month against the monthly target">
        <b className={`text-base tabular-nums ${tone(contracts.count || 0, contracts.target)}`}>{contracts.count || 0}</b>{contracts.target ? <span className="tabular-nums"> / {contracts.target}</span> : null}
      </Tile>
    </div>
  );
}

// One line above the work pane: the autopilot (links to its controls), the
// two numbers that were tiles, and when the daytime pass last ran. The group
// counts live on the rail's headings now, so the pane gets the height.
function StatusStrip({ autopilot, working, liveDeals, daytime, leaks, refreshBtn }) {
  const c = autopilot?.counts || {};
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
      {autopilot && (
        <a href={appHref("/autopilot", "controls")} className="rounded-md hover:text-blue-700" title="Autopilot controls">
          <span className="font-semibold text-slate-700">Autopilot</span> <b className="text-slate-900">{autopilot.modeLabel || autopilot.mode || "Custom"}</b>
          {" "}· <b className="text-emerald-700">{c.on || 0}</b> sending itself · <b className="text-amber-700">{c.drafting || 0}</b> drafting · <b className="text-slate-700">{c.off || 0}</b> off
          {autopilot.readyToGraduate > 0 && <span className="text-blue-700"> · {autopilot.readyToGraduate} ready to promote</span>}
        </a>
      )}
      <span><b className="tabular-nums text-slate-700">{working}</b> working offers</span>
      <span><b className="tabular-nums text-slate-700">{liveDeals}</b> live deals</span>
      {leaks && (
        <a href={appHref("/reports", "line")} className="rounded-md hover:text-blue-700" title="What fell off the line with nothing scheduled — the Line view">
          Leaks last night: <b className={`tabular-nums ${leaks.total ? "text-amber-700" : "text-emerald-700"}`}>{leaks.total}</b>
          {leaks.backlog ? <span className="text-slate-400"> · {leaks.backlog} waiting for a check-in seat</span> : null}
        </a>
      )}
      {daytime && (
        <span>
          Daytime pass {new Date(daytime.finishedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}: {daytime.started} started
          {daytime.stopped ? `, ${daytime.stopped} left alone by the brake` : ""}{daytime.error ? <span className="text-red-700"> — it failed: {daytime.error}</span> : ""}
        </span>
      )}
      <span className="ml-auto">{refreshBtn}</span>
    </div>
  );
}

export default function PipelineView({ section = "queue", settings = null }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [side, setSide] = useState("all");
  const [showHidden, setShowHidden] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const offsetRef = useRef(0);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    let live = true;
    let timer = null;
    async function tick() {
      if (!document.hidden) {
        setLoading(true);
        try {
          const r = await getDashboardPipeline();
          if (!live) return;
          offsetRef.current = Date.now() - Date.parse(r.now);
          setData(r);
          setError("");
        } catch (e) {
          if (live) setError(e.message || "Couldn't load the pipeline.");
        } finally { if (live) setLoading(false); }
      }
      if (live) timer = setTimeout(tick, POLL_MS);
    }
    tick();
    return () => { live = false; clearTimeout(timer); };
  }, [refreshKey]);

  if (!data && !error) return <SkeletonRows rows={5} />;

  const cards = data?.cards || [];
  const actions = data?.actions || [];
  const drafts = data?.drafts || [];
  const counts = data?.counts || { actions: {}, lanes: {}, hidden: {} };

  const needle = search.trim().toLowerCase();
  const visible = cards.filter((c) =>
    (side === "all" || c.side === side) &&
    (!needle || `${c.address} ${c.contactName}`.toLowerCase().includes(needle)));
  const working = cards.filter((c) => c.side === "agent" && c.lane !== "dead").length;
  const liveDeals = cards.filter((c) => c.side === "dispo" && !["closed", "dead"].includes(c.lane)).length;
  const hiddenCount = (counts.hidden?.dead || 0) + (counts.hidden?.closed || 0);

  const refreshBtn = (
    <button type="button" className={BTN} onClick={refresh} title="Refresh now">
      <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
    </button>
  );

  return (
    <div className="space-y-4">
      {error && <ErrorBar>{error}{data ? " — showing what loaded last." : ""}</ErrorBar>}
      {data && !data.conversationEnabled && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          The Conversation AI is switched off, so nothing here is moving on its own.
        </div>
      )}

      {section === "queue" && (
        <>
          <DeskKpis kpis={data?.desk?.kpis} />
          <StatusStrip autopilot={data?.autopilot} working={working} liveDeals={liveDeals} daytime={data?.daytime} leaks={data?.audit?.leaks || null} refreshBtn={refreshBtn} />
          <WorkView actions={data?.desk ? data.desk.rows : actions} groups={data?.desk ? DESK_GROUPS : TODAY_GROUPS} drafts={drafts} rowFeedback={data?.rowFeedback || {}} sendsEnabled={data?.sendsEnabled}
            serverOffsetMs={offsetRef.current} onDone={refresh} settings={settings} />
        </>
      )}

      {section === "board" && (
        <div>
          {data?.counts?.eventsTruncated && (
            <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
              More than the board reads in one go happened in the last 90 days — the oldest activity in that window may be missing.
            </div>
          )}
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h2 className="mr-2 text-sm font-bold">The board</h2>
            <FilterChips value={side} onChange={setSide} options={SIDES} label="Side" />
            <button type="button" className={BTN} onClick={() => setShowHidden((v) => !v)} aria-pressed={showHidden}>
              {showHidden ? "Hide" : "Show"} closed &amp; dead{hiddenCount ? ` (${hiddenCount})` : ""}
            </button>
            <div className="ml-auto flex items-center gap-2">
              <div className="w-64"><SearchInput value={search} onChange={setSearch} placeholder="Address or name…" label="Search the board" /></div>
              {refreshBtn}
            </div>
          </div>
          <PipelineBoard cards={visible} actions={actions} drafts={drafts} showHidden={showHidden}
            sendsEnabled={data?.sendsEnabled} serverOffsetMs={offsetRef.current} onDone={refresh}
            expandedId={expandedId} setExpandedId={setExpandedId} />
        </div>
      )}
    </div>
  );
}
