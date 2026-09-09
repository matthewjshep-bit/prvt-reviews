// PipelineView.jsx — the Pipeline tab: where everything stands, and the
// queue of what needs a person.
//
// One endpoint, polled every fifteen seconds (paused while the tab is
// hidden). Anything a button does bumps the refresh, so the board and the
// queue move together. On a fetch error the last good data stays up with a
// bar above it rather than the page going blank.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { getDashboardPipeline } from "./api.js";
import { BTN, ErrorBar, FilterChips, KpiRow, SearchInput, SkeletonRows } from "./ui.jsx";
import ActionQueue from "./ActionQueue.jsx";
import PipelineBoard from "./PipelineBoard.jsx";

const POLL_MS = 15000;
const SIDES = [{ key: "all", label: "Everything" }, { key: "agent", label: "Acquisition" }, { key: "dispo", label: "Disposition" }];

export default function PipelineView() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [side, setSide] = useState("all");
  const [showHidden, setShowHidden] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [highlightDraftId, setHighlightDraftId] = useState(null);
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

  function showDraft(draftId) {
    setHighlightDraftId(draftId);
    const el = document.getElementById(`draft-${draftId}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  if (!data && !error) return <SkeletonRows rows={5} />;

  const cards = data?.cards || [];
  const actions = data?.actions || [];
  const drafts = data?.drafts || [];
  const counts = data?.counts || { actions: {}, lanes: {}, hidden: {} };
  const draftsById = Object.fromEntries(drafts.map((d) => [d.id, d]));

  const needle = search.trim().toLowerCase();
  const visible = cards.filter((c) =>
    (side === "all" || c.side === side) &&
    (!needle || `${c.address} ${c.contactName}`.toLowerCase().includes(needle)));
  const working = cards.filter((c) => c.side === "agent" && c.lane !== "dead").length;
  const liveDeals = cards.filter((c) => c.side === "dispo" && !["closed", "dead"].includes(c.lane)).length;
  const hiddenCount = (counts.hidden?.dead || 0) + (counts.hidden?.closed || 0);

  return (
    <div className="space-y-4">
      {error && <ErrorBar>{error}{data ? " — showing what loaded last." : ""}</ErrorBar>}
      {data && !data.conversationEnabled && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          The Conversation AI is switched off, so nothing here is moving on its own.
        </div>
      )}
      {data?.counts?.eventsTruncated && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          More than the board reads in one go happened in the last 90 days — the newest buyer activity may be missing.
        </div>
      )}

      <KpiRow cols="sm:grid-cols-5" items={[
        { label: "Now", value: counts.actions?.now ?? 0, hint: "waiting on you, urgently" },
        { label: "Soon", value: counts.actions?.soon ?? 0 },
        { label: "FYI", value: counts.actions?.fyi ?? 0 },
        { label: "Working offers", value: working, hint: "priced, floated, sent or countered" },
        { label: "Live deals", value: liveDeals },
      ]} />

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-bold">Needs you</h2>
          <button type="button" className={BTN} onClick={refresh} title="Refresh now">
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
        <ActionQueue actions={actions} draftsById={draftsById} sendsEnabled={data?.sendsEnabled}
          serverOffsetMs={offsetRef.current} onDone={refresh} highlightDraftId={highlightDraftId} onShowDraft={showDraft} />
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 className="mr-2 text-sm font-bold">The board</h2>
          <FilterChips value={side} onChange={setSide} options={SIDES} label="Side" />
          <button type="button" className={BTN} onClick={() => setShowHidden((v) => !v)} aria-pressed={showHidden}>
            {showHidden ? "Hide" : "Show"} closed &amp; dead{hiddenCount ? ` (${hiddenCount})` : ""}
          </button>
          <div className="ml-auto w-64"><SearchInput value={search} onChange={setSearch} placeholder="Address or name…" label="Search the board" /></div>
        </div>
        <PipelineBoard cards={visible} actions={actions} drafts={drafts} showHidden={showHidden}
          sendsEnabled={data?.sendsEnabled} serverOffsetMs={offsetRef.current} onDone={refresh}
          expandedId={expandedId} setExpandedId={setExpandedId} />
      </div>
    </div>
  );
}
