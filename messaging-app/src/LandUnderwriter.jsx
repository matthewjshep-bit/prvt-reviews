// LandUnderwriter.jsx — the land analyzer in the offer editor.
//
// Land has no rent and no rehab: what nearby land sold for per acre (or per
// lot), times this parcel, at a share of value, less the site work. All the
// math is shared/land-underwrite.js; this lays it out and takes the inputs.

import React from "react";
import { Plus, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { fmtMoney } from "@shared/offer-calc.js";
import { blankLandDeal, sampleLandDeal } from "@shared/land-underwrite.js";
import { NumField, StepHead, TestBars, VerdictCard } from "./IncomeUnderwriter.jsx";

const money = (v) => (Number.isFinite(v) ? fmtMoney(Math.round(v)) : "—");
const CELL_INPUT = "w-full min-w-0 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none";
const LABEL = "mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500";

/**
 * LandUnderwriter — steps 3–5 of the offer editor for land.
 *   deal / setDeal   the land deal (shared/land-underwrite.js)
 *   run              underwriteLand(deal with the form's asking price)
 *   asking, priceOverride, setPriceOverride, fmtTyped — as the income analyzer takes them
 */
export default function LandUnderwriter({ deal, setDeal, run, asking, priceOverride, setPriceOverride, fmtTyped }) {
  const patch = (p) => setDeal({ ...deal, ...p, kind: "land" });
  const comps = deal.comps || [];
  const unit = deal.basis === "lot" ? "lot" : "acre";
  const units = deal.basis === "lot" ? "lots" : "acres";
  const setComp = (i, p) => patch({ comps: comps.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  const site = deal.siteCosts || {};
  const setSite = (k, v) => patch({ siteCosts: { ...site, [k]: v } });
  const r = run?.ok ? run.result : null;

  return (
    <>
      {/* 3 · Land comps */}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <StepHead n={3} right={
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5 text-xs font-semibold" role="group" aria-label="Price comps by">
              {[["acre", "Per acre"], ["lot", "Per lot"]].map(([k, l]) => (
                <button key={k} type="button" onClick={() => patch({ basis: k })} aria-pressed={deal.basis === k}
                  className={`rounded-md px-2.5 py-1 ${deal.basis === k ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-100"}`}>{l}</button>
              ))}
            </div>
            {comps.length > 0 && (
              <button type="button" onClick={() => setDeal(blankLandDeal())}
                className="flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50">
                <RotateCcw className="h-3 w-3" /> Reset
              </button>
            )}
          </div>
        }>
          Sold land nearby
        </StepHead>

        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="block">
            <span className={LABEL}>This parcel</span>
            <NumField ariaLabel={`Parcel size in ${units}`} value={deal.size} onChange={(v) => patch({ size: v })} suffix={units} />
          </label>
        </div>

        {comps.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 p-5 text-center">
            <p className="text-sm text-slate-600">Add land that sold nearby: its price and how many {units} it was. The median price per {unit} sets the value.</p>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
              <button type="button" onClick={() => patch({ comps: [{ label: "", price: 0, size: 0 }] })}
                className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700">
                <Plus className="h-3.5 w-3.5" /> Add a sold comp
              </button>
              <button type="button" onClick={() => setDeal(sampleLandDeal())}
                className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                <Sparkles className="h-3.5 w-3.5" /> Load sample deal (example figures)
              </button>
            </div>
          </div>
        ) : (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[30rem] text-sm">
              <thead>
                <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  <th className="pb-1.5 pr-2 font-semibold">Comp</th>
                  <th className="w-32 pb-1.5 pr-2 text-right font-semibold">Sold for</th>
                  <th className="w-24 pb-1.5 pr-2 text-right font-semibold">{units}</th>
                  <th className="w-28 pb-1.5 pr-2 text-right font-semibold">$ / {unit}</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {comps.map((c, i) => (
                  <tr key={i}>
                    <td className="py-1 pr-2"><input className={CELL_INPUT} value={c.label} placeholder="Address or note" aria-label="Comp" onChange={(e) => setComp(i, { label: e.target.value })} /></td>
                    <td className="py-1 pr-2"><NumField ariaLabel="Sold price" money prefix="$" value={c.price} onChange={(v) => setComp(i, { price: v })} /></td>
                    <td className="py-1 pr-2"><NumField ariaLabel={units} value={c.size} onChange={(v) => setComp(i, { size: v })} /></td>
                    <td className="py-1 pr-2 text-right text-xs tabular-nums text-slate-600">{c.price > 0 && c.size > 0 ? money(c.price / c.size) : "—"}</td>
                    <td className="py-1 text-right">
                      <button type="button" onClick={() => patch({ comps: comps.filter((_, j) => j !== i) })} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600" aria-label="Remove comp">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button type="button" onClick={() => patch({ comps: [...comps, { label: "", price: 0, size: 0 }] })}
              className="mt-2 flex items-center gap-1 text-xs font-semibold text-blue-700 hover:text-blue-900">
              <Plus className="h-3.5 w-3.5" /> Add a sold comp
            </button>
          </div>
        )}
        {deal.name && /example figures/i.test(deal.name) && (
          <p className="mt-2 text-[11px] font-medium text-amber-700">{deal.name} — replace these with the real numbers before you send anything.</p>
        )}
      </div>

      {/* 4 · Site work and our share */}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <StepHead n={4}>Site work &amp; our share</StepHead>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {[["clearing", "Clearing & grading"], ["utilities", "Utilities / septic / well"], ["permits", "Permits & survey"], ["other", "Other"]].map(([k, l]) => (
            <label key={k} className="block min-w-0">
              <span className={LABEL}>{l}</span>
              <NumField ariaLabel={l} money prefix="$" value={site[k]} onChange={(v) => setSite(k, v)} />
            </label>
          ))}
          <label className="block">
            <span className={LABEL}>Offer, % of value</span>
            <NumField ariaLabel="Offer percent of value" pct suffix="%" value={deal.offerPct} onChange={(v) => patch({ offerPct: v })} />
          </label>
          <label className="block">
            <span className={LABEL}>Closing costs</span>
            <NumField ariaLabel="Closing costs" pct suffix="%" value={deal.closingPct} onChange={(v) => patch({ closingPct: v })} />
          </label>
        </div>
      </div>

      {/* 5 · The offer */}
      {!r ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-5">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-slate-600">
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-bold leading-none text-white">5</span>
            Land offer
          </div>
          <p className="mb-2 text-sm text-slate-600">To price it:</p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
            {(run?.errors || []).map((e) => <li key={e}>{e}</li>)}
          </ul>
        </div>
      ) : (
        <VerdictCard step={5} title="Land offer"
          maxOffer={r.maxOffer} asking={asking} per={deal.size > 0 ? r.maxOffer / deal.size : 0} perLabel={unit}
          sentence={`${r.comps} sold comp${r.comps === 1 ? "" : "s"} put land here at ${money(r.perUnit)} per ${unit}, so ${deal.size} ${units} is worth about ${money(r.value)}. At ${Math.round(deal.offerPct * 100)}% of that, less ${money(r.siteTotal)} of site work and closing, the offer is ${money(r.maxOffer)}.`}
          priceOverride={priceOverride} setPriceOverride={setPriceOverride} fmtTyped={fmtTyped}>
          <TestBars tests={r.tests.map((t) => (t.key === "market" ? { ...t, info: false } : t))} asking={asking} />
        </VerdictCard>
      )}
    </>
  );
}
