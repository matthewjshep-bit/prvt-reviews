// BuyerViewPanel.jsx — the buyer-view checks' lines in the Comps pane.
// Kept apart from CompsPane (which pulls in Leaflet) so it renders anywhere.

import React from "react";
import { Loader2, X } from "lucide-react";
import { fmtMoney } from "@shared/offer-calc.js";

// The buyer-view checks' lines for the ticked comps (shared/underwrite-checks.js):
// the auto adjustments as chips a person can take off, the listings cap, and
// the flags (exposure, septic, easement, a thin buyer pool). Renders nothing
// when the checks are off. Exported for the tests.
export default function BuyerViewPanel({ view, busy = false, declined = { arv: [], cap: false }, onDecline, onRestore, onCap }) {
  if (!view) return null;
  const auto = (view.adjustments || []).filter((a) => a.source === "auto");
  const capped = view.arv?.capped || null;
  const cap = view.cap || null;
  const site = view.status?.site;
  const removed = declined?.arv || [];
  const quiet = !auto.length && !capped && !(view.flags || []).length && site === "ok";
  return (
    <div className="mb-2 rounded-lg border border-sky-200 bg-sky-50 p-2 text-xs" data-testid="buyer-view">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase tracking-wider text-sky-900">Buyer view</span>
        {busy && <Loader2 size={12} className="animate-spin text-sky-700" />}
      </div>
      {auto.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {auto.map((a) => (
            <span key={a.key} title={a.note || ""} className="inline-flex items-center gap-1 rounded-full bg-sky-700 px-2 py-0.5 text-[11px] font-medium text-white">
              {a.label} {a.pct > 0 ? "+" : "−"}{Math.abs(a.pct)}%
              <span className="text-sky-100">auto</span>
              <button type="button" aria-label={`Remove ${a.label}`} onClick={() => onDecline?.(a.key)} className="rounded-full p-0.5 hover:bg-sky-800">
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      {capped && (
        <div className="mt-1 flex items-center justify-between gap-2 text-sky-900">
          <span>Held to today's listings: {fmtMoney(capped.to)}{capped.label ? ` — ${capped.label}` : ""}</span>
          <button type="button" onClick={() => onCap?.(true)} className="shrink-0 underline">remove</button>
        </div>
      )}
      {declined?.cap && cap?.status === "ok" && (
        <div className="mt-1 text-sky-900">Listings cap removed — <button type="button" onClick={() => onCap?.(false)} className="underline">put it back</button></div>
      )}
      {cap && cap.status !== "ok" && cap.label && <div className="mt-1 text-sky-900">Listings: not applied — {cap.label}</div>}
      {site === "unavailable" && <div className="mt-1 text-amber-800">Street not checked — the map service didn't answer.</div>}
      {removed.length > 0 && (
        <div className="mt-1 text-sky-900">
          Removed:{" "}
          {removed.map((k) => (
            <button key={k} type="button" onClick={() => onRestore?.(k)} className="mr-2 underline">{k.replace(/_/g, " ")} (put back)</button>
          ))}
        </div>
      )}
      {(view.flags || []).length > 0 && (
        <ul className="mt-1 list-disc pl-4 text-sky-900">
          {view.flags.map((f) => <li key={f.key}>{f.label}</li>)}
        </ul>
      )}
      {quiet && <div className="text-sky-900">Nothing to adjust: a quiet street, and nothing on the record says otherwise.</div>}
    </div>
  );
}
