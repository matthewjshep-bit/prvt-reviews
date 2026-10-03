// AllowanceChips.jsx — the buyer-view checks' scope lines in the Rehab pane.

import React from "react";
import { X } from "lucide-react";
import { fmtMoney } from "@shared/offer-calc.js";

// The buyer-view checks' scope lines (shared/rehab-checks.js): each a
// "Buyer allowance" a person can take off, with the evidence on hover, plus
// the floor note and anything named but not priceable. Exported for tests.
export default function AllowanceChips({ result, declined = [], onDecline, onRestore, bucketAmount = 0 }) {
  if (!result) return null;
  const { rows = [], flags = [], floor = null, after = 0 } = result;
  if (!rows.length && !flags.length && !declined.length) return null;
  return (
    <div className="mt-2 rounded-lg border border-sky-200 bg-sky-50 p-2 text-xs" data-testid="allowance">
      <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-sky-900">What a buyer will price</div>
      {rows.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {rows.map((r) => (
            <span key={r.id} title={r.evidence || ""} className="inline-flex items-center gap-1 rounded-full bg-sky-700 px-2 py-0.5 text-[11px] font-medium text-white">
              {r.label.replace(/^Buyer allowance — /, "")} · {fmtMoney(r.cost)}
              <button type="button" aria-label={`Remove ${r.label}`} onClick={() => onDecline?.(r.key)} className="rounded-full p-0.5 hover:bg-sky-800"><X size={10} /></button>
            </span>
          ))}
        </div>
      )}
      {floor?.distressed && <div className="mt-1 text-sky-900">Distressed listing ({floor.why}) — held to at least {fmtMoney(floor.amount)}.</div>}
      {bucketAmount > 0 && after > bucketAmount && (
        <div className="mt-1 font-semibold text-amber-800">The quick estimate ({fmtMoney(bucketAmount)}) is under what a buyer will price ({fmtMoney(after)}).</div>
      )}
      {flags.length > 0 && <ul className="mt-1 list-disc pl-4 text-sky-900">{flags.map((f) => <li key={f.key}>{f.label}</li>)}</ul>}
      {declined.length > 0 && (
        <div className="mt-1 text-sky-900">
          Removed:{" "}
          {declined.map((k) => <button key={k} type="button" onClick={() => onRestore?.(k)} className="mr-2 underline">{k.replace(/_/g, " ")} (put back)</button>)}
        </div>
      )}
    </div>
  );
}
