// WorkRail.jsx — Today's queue as a slim list down the left of the work pane.
//
// Your call, then Stuck, then The machine is on it (folded unless you are in
// it). Each row is the street (or the person), what kind of row it is, and a
// dot for how soon. Click one, or J/K, and the pane beside it becomes that row.

import React from "react";
import { Check, ChevronDown } from "lucide-react";
import { SearchInput } from "./ui.jsx";
import { SEV } from "./RowOps.jsx";
import { GROUP_LABEL, GROUP_ORDER, KIND_LABEL, groupOf, railLabel } from "./work-queue.js";

const GROUP_HINT = {
  yours: "Decisions only you make.",
  stuck: "The machine tried and couldn't.",
  machine: "Already moving.",
};

function RailRow({ item, selected, onSelect, taught }) {
  const sev = SEV[item.severity] || SEV.fyi;
  return (
    <li>
      <button type="button" onClick={() => onSelect(item.id)} aria-current={selected ? "true" : undefined}
        className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors ${selected ? "bg-blue-50 ring-1 ring-inset ring-blue-200" : "hover:bg-slate-50"}`}>
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${sev.dot}`} title={sev.label} />
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-sm ${selected ? "font-semibold text-blue-900" : "font-medium text-slate-800"}`} title={item.address || item.title}>{railLabel(item)}</span>
          <span className="block truncate text-xs text-slate-500">
            {KIND_LABEL[item.kind] || item.kind}{item.contactName && item.address ? ` · ${item.contactName}` : ""}
          </span>
        </span>
        {taught && <Check size={12} className="mt-1 shrink-0 text-emerald-600" aria-label="taught" />}
      </button>
    </li>
  );
}

/**
 * <WorkRail rows selectedId onSelect filter onFilter machineOpen onMachineOpen isTaught />
 *   rows: already in work order (orderRows) and already filtered
 */
export default function WorkRail({ rows = [], total = 0, selectedId, onSelect, filter = "", onFilter, machineOpen = false, onMachineOpen, isTaught = () => false }) {
  const byGroup = Object.fromEntries(GROUP_ORDER.map((g) => [g, rows.filter((r) => groupOf(r) === g)]));
  const selectedGroup = groupOf(rows.find((r) => r.id === selectedId) || {});
  return (
    <nav aria-label="Today's rows" className="flex h-full min-h-0 flex-col rounded-xl border border-slate-200 bg-white">
      <div className="shrink-0 border-b border-slate-100 p-2">
        <SearchInput value={filter} onChange={onFilter} placeholder="Street or name…" label="Filter Today's rows" className="py-1.5" />
        {filter && <div className="mt-1 px-1 text-xs text-slate-500">{rows.length} of {total}</div>}
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2">
        {GROUP_ORDER.map((g) => {
          const items = byGroup[g];
          if (g !== "yours" && !items.length) return null;
          const folds = g === "machine";
          const open = !folds || machineOpen || selectedGroup === "machine";
          const heading = (
            <span className="flex items-baseline gap-2 px-1">
              <span className="text-xs font-bold uppercase tracking-wide text-slate-700">{GROUP_LABEL[g]}</span>
              <span className="text-xs font-semibold tabular-nums text-slate-500">{items.length}</span>
              {folds && <ChevronDown size={12} className={`self-center text-slate-500 transition-transform ${open ? "rotate-180" : ""}`} />}
            </span>
          );
          return (
            <section key={g} aria-label={GROUP_LABEL[g]}>
              {folds
                ? <button type="button" className="w-full text-left" onClick={() => onMachineOpen?.(!open)} aria-expanded={open} title={GROUP_HINT[g]}>{heading}</button>
                : <div title={GROUP_HINT[g]}>{heading}</div>}
              {open && (items.length
                ? <ul className="mt-1 space-y-0.5">{items.map((item) => <RailRow key={item.id} item={item} selected={item.id === selectedId} onSelect={onSelect} taught={isTaught(item)} />)}</ul>
                : <div className="mt-1 rounded-lg border border-dashed border-slate-200 px-3 py-3 text-center text-xs text-slate-500">Nothing is waiting on you.</div>)}
            </section>
          );
        })}
      </div>
    </nav>
  );
}
