// InPlayView.jsx — Today → In play: every agent with something live, one row
// each (shared/in-play.js). It replaces walking GHL's Tier 1 stage and the
// Offers tab every morning: who, where their best house stands, ours against
// theirs, when anyone last spoke, what the machine does next, and a flag when
// something has fallen off. Click a row and the agent's lead offer opens in
// the same pane the Offers split uses (OfferPane), the list shrunk to a rail.
// "By house" is the lane board that used to be its own tab.
//
// Loads when the tab opens and on Refresh — no 15-second poll.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, RefreshCw } from "lucide-react";
import { buildInPlay, inPlayCounts, IN_PLAY_STAGES } from "@shared/in-play.js";
import { kText } from "@shared/call-list.js";
import { listOffers } from "./api.js";
import { appHref } from "./links.js";
import { ActivityStamp, BTN, ErrorBar, FilterChips, Pill, SearchInput, SkeletonRows } from "./ui.jsx";
import NextFollowUp from "./NextFollowUp.jsx";
import OfferRail from "./OfferRail.jsx";
import OfferPane from "./OfferPane.jsx";
import SendModal from "./SendModal.jsx";
import PipelineView from "./PipelineView.jsx";
import { railStep, splitKey } from "./offers-split.js";

const STAGE_LABEL = Object.fromEntries(IN_PLAY_STAGES.map((s) => [s.key, s.label]));
const STAGE_CLS = { deal: "bg-emerald-100 text-emerald-800", hot: "bg-orange-100 text-orange-800", countered: "bg-violet-100 text-violet-800", sent: "bg-blue-50 text-blue-800",
  floated: "bg-sky-50 text-sky-800", ready: "bg-slate-100 text-slate-700", held: "bg-amber-100 text-amber-800", recent: "bg-slate-100 text-slate-600" };
const street = (a) => String(a || "").split(",")[0].trim();

// The chips: what's live (the default), what fell off, what waits on you, and the stages worth a look.
export function inPlayFilter(key) {
  switch (key) {
    case "leaks": return (r) => r.leak === "nothing" || r.leak === "missed";
    case "yours": return (r) => r.leak === "waiting_on_you";
    case "hot": return (r) => r.stage === "hot";
    case "countered": return (r) => r.stage === "countered";
    case "deal": return (r) => r.stage === "deal";
    case "recent": return (r) => r.stage === "recent";
    default: return (r) => r.stage !== "recent";
  }
}

/** The table, given its rows; what the tests render. */
export function InPlayTable({ rows = [], onOpen }) {
  if (!rows.length) return <div className="rounded-xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-500">Nobody here.</div>;
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="min-w-full text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
          <tr><th className="px-3 py-2">Agent</th><th className="px-3 py-2">Where it stands</th><th className="px-3 py-2">Houses · ours / theirs</th><th className="px-3 py-2">Last touch</th><th className="px-3 py-2">Next</th></tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.contactId} className="cursor-pointer hover:bg-slate-50" onClick={() => onOpen?.(r)}>
              <td className="px-3 py-2 font-semibold text-slate-900">
                {r.contactName || "Unnamed agent"}
                {r.leak && <div className={`text-xs font-medium ${r.leak === "waiting_on_you" ? "text-blue-700" : "text-amber-700"}`}>{r.leakLabel}</div>}
              </td>
              <td className="px-3 py-2"><Pill small label={STAGE_LABEL[r.stage] || r.stage} cls={STAGE_CLS[r.stage]} /></td>
              <td className="px-3 py-2 text-slate-700">
                {r.houses.slice(0, 3).map((h) => (
                  <div key={h.offerId} className="whitespace-nowrap">
                    {street(h.address)}{h.ours ? <span className="tabular-nums text-slate-500"> · {kText(h.ours)}{h.theirs ? ` / ${kText(h.theirs)}` : ""}</span> : null}
                  </div>
                ))}
                {r.houses.length > 3 && <div className="text-xs text-slate-500">+{r.houses.length - 3} more</div>}
              </td>
              <td className="px-3 py-2"><ActivityStamp activity={r.lastActivity} /></td>
              <td className="px-3 py-2"><NextFollowUp next={r.next} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** <InPlayView settings initialMode /> — "agent" (the table) or "house" (the lane board). */
export default function InPlayView({ settings = null, initialMode = "agent" }) {
  const [mode, setMode] = useState(initialMode);
  const [offers, setOffers] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("live");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState(null);   // the lead offer open in the split
  const [sending, setSending] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setOffers(await listOffers({ lean: true, limit: 2000, activity: true, next: true })); setError(""); }
    catch (e) { setError(e.message || "Couldn't load who's in play."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { if (mode === "agent") load(); }, [mode, load]);

  const rows = useMemo(() => buildInPlay(offers || []), [offers]);
  const counts = useMemo(() => inPlayCounts(rows), [rows]);
  const needle = q.trim().toLowerCase();
  const shown = rows.filter(inPlayFilter(filter)).filter((r) => !needle || `${r.contactName} ${r.houses.map((h) => h.address).join(" ")}`.toLowerCase().includes(needle));
  const rail = shown.map((r) => r.lead);
  const open = rail.find((o) => o.id === openId) || null;

  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      const k = splitKey(e, { blocked: Boolean(sending) });
      if (!k) return;
      if (k === "close") { e.preventDefault(); setOpenId(null); }
      else if (k === "next" || k === "prev") { e.preventDefault(); const id = railStep(rail, openId, k === "next" ? 1 : -1); if (id) setOpenId(id); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const toggle = (
    <FilterChips value={mode} onChange={(m) => { setMode(m); setOpenId(null); }} label="Group by"
      options={[{ key: "agent", label: "By agent" }, { key: "house", label: "By house" }]} />
  );
  if (mode === "house") return <div className="space-y-3">{toggle}<PipelineView section="board" /></div>;

  const chips = [
    { key: "live", label: "Live", count: counts.live },
    { key: "leaks", label: "Fell off", count: counts.leaks, title: "An open offer with nothing scheduled, or a follow-up that's late" },
    { key: "yours", label: "Waiting on you", count: counts.yours },
    { key: "hot", label: "Hot", count: counts.byStage.hot },
    { key: "countered", label: "Countered", count: counts.byStage.countered },
    { key: "deal", label: "Deals", count: counts.byStage.deal },
    { key: "recent", label: "Passed lately", count: counts.byStage.recent },
  ];
  const refreshBtn = <button type="button" className={BTN} onClick={load} title="Refresh"><RefreshCw size={13} className={loading ? "animate-spin" : ""} /></button>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {toggle}
        {open && <button type="button" className={BTN} onClick={() => setOpenId(null)} title="Back to the list (Esc)"><ChevronLeft size={13} /> List</button>}
        <FilterChips value={filter} onChange={setFilter} options={chips} label="Filter who's in play" />
        <SearchInput value={q} onChange={setQ} className="ml-auto min-w-[14rem] flex-1 sm:max-w-xs" placeholder="Agent or street…" label="Search who's in play" />
        {refreshBtn}
      </div>
      {error && <ErrorBar>{error}{offers ? " — showing what loaded last." : ""}</ErrorBar>}
      {!offers && !error ? <SkeletonRows rows={6} /> : open ? (
        <div className="relative flex min-h-[560px] gap-3 lg:h-[calc(100vh-11rem)]">
          <div className="hidden w-80 shrink-0 lg:block"><OfferRail rows={rail} selectedId={open.id} onSelect={setOpenId} label="In play" /></div>
          <OfferPane key={open.id} offer={open} index={rail.indexOf(open)} total={rail.length}
            onPrev={railStep(rail, open.id, -1) ? () => setOpenId(railStep(rail, open.id, -1)) : null}
            onNext={railStep(rail, open.id, 1) ? () => setOpenId(railStep(rail, open.id, 1)) : null}
            onClose={() => setOpenId(null)} onSend={(o) => setSending(o)}
            onDetails={(o) => window.open(`${appHref("/", "history")}&offer=${encodeURIComponent(o.id)}`, "_blank", "noopener")}
            onChanged={() => load()} onStatusChanged={() => load()} settings={settings} />
        </div>
      ) : (
        <InPlayTable rows={shown} onOpen={(r) => setOpenId(r.lead.id)} />
      )}
      {sending && <SendModal offer={sending} onClose={() => setSending(null)} onSent={() => { setSending(null); load(); }} />}
    </div>
  );
}
