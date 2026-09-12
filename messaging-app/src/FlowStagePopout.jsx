// FlowStagePopout.jsx — the records behind one Flow tile.
//
// A count on its own can only be trusted or not. "191 replied" invites
// exactly one question — which 191 — and until now the answer was to go and
// read the feed. Clicking the tile answers it.
//
// A centred modal rather than a side drawer, deliberately: the rows in here
// carry contact links, and the contact drawer is itself a right-edge
// slide-over. Two stacked right panels would be unreadable; a centred sheet
// with the drawer sliding over it reads correctly with no z-index games.
//
// Fetched on open and never polled — a drill-down is a snapshot of the
// window you clicked, and rows appearing under the cursor would be worse
// than slightly stale ones.

import React, { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { getDashboardFlowStage, offerEditorUrl } from "./api.js";
import { groupByDay } from "@shared/contact-record.js";
import { fmtMoney } from "@shared/offer-calc.js";
import { OFFER_STATUS } from "@shared/offer-status.js";
import { ErrorBar, FilterChips, SkeletonRows } from "./ui.jsx";
import { EventDayGroups, when } from "./EventFeed.jsx";
import ContactLink from "./ContactLink.jsx";

const FILTERS = [
  { key: "all", label: "Everything" },
  { key: "machine", label: "The machine" },
  { key: "person", label: "People" },
];

// The offer-driven stages (underwritten, offered, floated, countered) have no
// timeline row to draw — the record IS the offer — so they get the house, the
// number and where it stands.
function OfferRows({ rows }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-500">
          <th scope="col" className="py-1.5 pr-3">Property</th>
          <th scope="col" className="py-1.5 pr-3">Agent</th>
          <th scope="col" className="py-1.5 pr-3 text-right">Cash offer</th>
          <th scope="col" className="py-1.5 pr-3">Status</th>
          <th scope="col" className="py-1.5 text-right">When</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="border-b border-slate-100 last:border-0">
            <td className="max-w-[18rem] truncate py-1.5 pr-3" title={r.address || undefined}>
              {r.offerId
                ? <a href={offerEditorUrl(r.offerId)} target="_blank" rel="noreferrer" className="text-slate-700 hover:text-blue-700">{r.address || "—"}</a>
                : (r.address || "—")}
            </td>
            <td className="py-1.5 pr-3 text-slate-600">
              {r.contactId ? <ContactLink contactId={r.contactId} name={r.contactName || "contact"} party="agent" /> : (r.contactName || "—")}
            </td>
            <td className="py-1.5 pr-3 text-right font-semibold tabular-nums">{r.cashAmount != null ? fmtMoney(r.cashAmount) : "—"}</td>
            <td className="py-1.5 pr-3 text-slate-600">{OFFER_STATUS[r.status]?.label || r.status || "—"}</td>
            <td className="py-1.5 text-right text-[11px] text-slate-400">{when(r.at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function FlowStagePopout({ stageKey, label, days, end, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");

  useEffect(() => {
    let live = true;
    setData(null); setError(""); setFilter("all");
    getDashboardFlowStage(stageKey, days, end)
      .then((r) => { if (live) setData(r); })
      .catch((e) => { if (live) setError(e.message || "Couldn't load that stage."); });
    return () => { live = false; };
  }, [stageKey, days, end]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rows = useMemo(() => (data?.items || []).filter((i) =>
    filter === "all" ? true : filter === "machine" ? i.machine : !i.machine), [data, filter]);
  const events = rows.filter((r) => r.kind !== "offer");
  const offers = rows.filter((r) => r.kind === "offer");
  const machine = (data?.items || []).filter((i) => i.machine).length;
  const person = (data?.items || []).length - machine;

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={`${label}: what happened`}
        className="w-full max-w-3xl rounded-xl bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-bold">{label}</h2>
          {data && (
            <span className="text-xs text-slate-500">
              {data.total} record{data.total === 1 ? "" : "s"} · <span className="text-violet-600">{machine} machine</span> · {person} you
              {data.truncated ? ` · newest ${data.items.length} shown` : ""}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {data?.items?.length > 0 && <FilterChips value={filter} onChange={setFilter} label="Show" options={FILTERS} />}
            <button type="button" onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Close">
              <X size={16} />
            </button>
          </div>
        </div>
        {data?.stage?.hint && <p className="mb-3 text-xs text-slate-400">{data.stage.hint}</p>}

        {error && <ErrorBar>{error}</ErrorBar>}
        {!data && !error && <SkeletonRows rows={4} />}
        {data && !data.items.length && (
          <div className="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-400">
            Nothing reached this stage in the window.
          </div>
        )}
        {rows.length > 0 && (
          <div className="space-y-4">
            {offers.length > 0 && <OfferRows rows={offers} />}
            {events.length > 0 && <EventDayGroups groups={groupByDay(events)} withLinks />}
          </div>
        )}
        {data?.items?.length > 0 && !rows.length && (
          <div className="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-400">
            Nothing here with that filter.
          </div>
        )}
      </div>
    </div>
  );
}
