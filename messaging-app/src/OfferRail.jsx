// OfferRail.jsx — the Offers table, shrunk to a list down the left while an
// offer is open in the split: the rows the table was showing, in its order.
// Street, agent, our number, where it stands, and what's next.

import React, { useEffect, useRef } from "react";
import { fmtMoney } from "@shared/offer-calc.js";
import { StatusPill } from "./ui.jsx";
import NextFollowUp from "./NextFollowUp.jsx";

const street = (o) => String(o?.address || "Untitled").split(",")[0];

/** <OfferRail rows selectedId onSelect label /> */
export default function OfferRail({ rows = [], selectedId = null, onSelect, label = "" }) {
  const box = useRef(null);
  // Keep the open row in view as J/K walk the list.
  useEffect(() => {
    const el = box.current?.querySelector?.('[aria-current="true"]');
    el?.scrollIntoView?.({ block: "nearest" });
  }, [selectedId]);
  return (
    <nav aria-label="Offers" className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="shrink-0 border-b border-slate-200 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label || "Offers"} · {rows.length}
      </div>
      <ul ref={box} className="min-h-0 flex-1 divide-y divide-slate-100 overflow-y-auto">
        {rows.map((o) => {
          const on = o.id === selectedId;
          return (
            <li key={o.id}>
              <button type="button" onClick={() => onSelect?.(o.id)} aria-current={on ? "true" : undefined}
                className={`block w-full px-3 py-2 text-left ${on ? "bg-blue-50" : "hover:bg-slate-50"} ${o.supersededBy ? "opacity-60" : ""}`}>
                <span className="flex items-baseline justify-between gap-2">
                  <span className={`min-w-0 truncate text-sm ${on ? "font-semibold text-slate-900" : "font-medium text-slate-800"}`} title={o.address || undefined}>{street(o)}</span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-700">{o.cashAmount != null ? fmtMoney(o.cashAmount) : "—"}</span>
                </span>
                <span className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                  <span className="min-w-0 truncate">{o.contactName || "No contact"}</span>
                  <span className="ml-auto shrink-0"><StatusPill offer={o} small /></span>
                </span>
                <span className="mt-0.5 block text-xs"><NextFollowUp next={o.nextFollowUp} enriched={o.nextFollowUp !== undefined} muted={Boolean(o.supersededBy)} /></span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
