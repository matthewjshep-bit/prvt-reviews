// LotUnderwriter.jsx — the luxury teardown-lot analyzer in the offer editor.
//
// An old house on a big lot in a builders' pocket is worth what a builder pays
// for the lot. We offer that less what the seller would pay to list, so they
// net the same with no showings, and a builder takes the contract at about
// the lot value. All the math is shared/lot-underwrite.js; this lays it out.
// The spread shows here, for Matt. The letter never prints it.

import React from "react";
import { Plus, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { fmtMoney } from "@shared/offer-calc.js";
import { blankLotDeal, sampleLotDeal } from "@shared/lot-underwrite.js";
import { NumField, StepHead, TestBars, VerdictCard } from "./IncomeUnderwriter.jsx";

const money = (v) => (Number.isFinite(v) ? fmtMoney(Math.round(v)) : "—");
const CELL_INPUT = "w-full min-w-0 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none";
const LABEL = "mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500";

const sameComp = (a, b) => String(a.label || "").trim().toLowerCase() === String(b.label || "").trim().toLowerCase() && Number(a.price) === Number(b.price);

/**
 * SuggestedTeardowns — what the pocket scan found nearby, each with Add. Not
 * in the price until added: the comps table above is the only thing counted.
 */
export function SuggestedTeardowns({ suggestions, comps = [], onAdd }) {
  const left = (suggestions?.comps || []).filter((s) => !comps.some((c) => sameComp(c, s)));
  if (!left.length) return null;
  const when = suggestions.scannedAt ? new Date(suggestions.scannedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
  return (
    <div className="mt-4 rounded-lg border border-dashed border-blue-200 bg-blue-50/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-slate-700">
          Suggested: sold teardowns the {suggestions.pocket?.name || "pocket"} scan found{when ? ` (${when})` : ""}
          <span className="block font-normal text-slate-500">Not in the price until you add them. Check each one is a lot like this.</span>
        </p>
        <button type="button" onClick={() => onAdd(left)} className="flex items-center gap-1 rounded-md border border-blue-300 bg-white px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-50">
          <Plus className="h-3 w-3" /> Add all {left.length}
        </button>
      </div>
      <ul className="mt-2 divide-y divide-blue-100 text-sm">
        {left.map((c, i) => (
          <li key={`${c.label}-${i}`} className="flex items-center gap-3 py-1">
            <span className="min-w-0 flex-1 truncate text-slate-700">{c.label}{c.soldAt ? <span className="text-slate-400"> · sold {c.soldAt}</span> : null}</span>
            <span className="tabular-nums text-slate-700">{money(c.price)}</span>
            <span className="w-24 text-right tabular-nums text-slate-500">{c.lotSqft ? `${c.lotSqft.toLocaleString("en-US")} sqft` : "—"}</span>
            <span className="w-12 text-right tabular-nums text-slate-500">{c.yearBuilt || "—"}</span>
            <button type="button" onClick={() => onAdd([c])} className="text-xs font-semibold text-blue-700 hover:text-blue-900" aria-label={`Add ${c.label}`}>Add</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * LotUnderwriter — steps 3–5 of the offer editor for a luxury lot.
 *   deal / setDeal   the lot deal (shared/lot-underwrite.js)
 *   run              underwriteLot(deal with the form's asking price)
 *   asking, priceOverride, setPriceOverride, fmtTyped — as the land analyzer takes them
 *   suggestions      { pocket, scannedAt, comps } — the sold teardowns the lot
 *                    finder's pocket scan read (GET /api/lot-finder/teardowns).
 *                    Offered to add; none counts until it's added.
 */
export default function LotUnderwriter({ deal, setDeal, run, asking, priceOverride, setPriceOverride, fmtTyped, suggestions = null }) {
  const patch = (p) => setDeal({ ...deal, ...p, kind: "lot" });
  const comps = deal.comps || [];
  const screens = deal.screens || {};
  const setComp = (i, p) => patch({ comps: comps.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  const setScreen = (k, v) => patch({ screens: { ...screens, [k]: v } });
  const r = run?.ok ? run.result : null;
  const pct = Math.round((deal.sellingCostPct || 0) * 1000) / 10;
  const blankComp = { label: "", price: 0, lotSqft: 0, yearBuilt: 0, houseSqft: 0, soldAt: "" };

  return (
    <>
      {/* 3 · Sold teardowns */}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <StepHead n={3} right={comps.length > 0 && (
          <button type="button" onClick={() => setDeal(blankLotDeal())}
            className="flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50">
            <RotateCcw className="h-3 w-3" /> Reset
          </button>
        )}>
          Sold teardowns nearby
        </StepHead>

        <div className="mb-4 grid grid-cols-3 gap-3">
          <label className="block">
            <span className={LABEL}>This lot</span>
            <NumField ariaLabel="Lot size in sqft" value={deal.lotSqft} onChange={(v) => patch({ lotSqft: v })} suffix="sqft" />
          </label>
          <label className="block">
            <span className={LABEL}>Built</span>
            <NumField ariaLabel="Year built" value={deal.yearBuilt} onChange={(v) => patch({ yearBuilt: v })} />
          </label>
          <label className="block">
            <span className={LABEL}>House</span>
            <NumField ariaLabel="House size in sqft" value={deal.houseSqft} onChange={(v) => patch({ houseSqft: v })} suffix="sqft" />
          </label>
        </div>

        {comps.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 p-5 text-center">
            <p className="text-sm text-slate-600">Add old houses on lots like this one that sold nearby — the ones a builder bought. The median price is the lot value.</p>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
              <button type="button" onClick={() => patch({ comps: [blankComp] })}
                className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700">
                <Plus className="h-3.5 w-3.5" /> Add a sold teardown
              </button>
              <button type="button" onClick={() => setDeal(sampleLotDeal())}
                className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                <Sparkles className="h-3.5 w-3.5" /> Load sample deal (example figures)
              </button>
            </div>
          </div>
        ) : (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[34rem] text-sm">
              <thead>
                <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  <th className="pb-1.5 pr-2 font-semibold">Sold teardown</th>
                  <th className="w-32 pb-1.5 pr-2 text-right font-semibold">Sold for</th>
                  <th className="w-24 pb-1.5 pr-2 text-right font-semibold">Lot sqft</th>
                  <th className="w-20 pb-1.5 pr-2 text-right font-semibold">Built</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {comps.map((c, i) => (
                  <tr key={i}>
                    <td className="py-1 pr-2"><input className={CELL_INPUT} value={c.label} placeholder="Address or note" aria-label="Sold teardown" onChange={(e) => setComp(i, { label: e.target.value })} /></td>
                    <td className="py-1 pr-2"><NumField ariaLabel="Sold price" money prefix="$" value={c.price} onChange={(v) => setComp(i, { price: v })} /></td>
                    <td className="py-1 pr-2"><NumField ariaLabel="Comp lot sqft" value={c.lotSqft} onChange={(v) => setComp(i, { lotSqft: v })} /></td>
                    <td className="py-1 pr-2"><NumField ariaLabel="Comp year built" value={c.yearBuilt} onChange={(v) => setComp(i, { yearBuilt: v })} /></td>
                    <td className="py-1 text-right">
                      <button type="button" onClick={() => patch({ comps: comps.filter((_, j) => j !== i) })} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600" aria-label="Remove comp">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button type="button" onClick={() => patch({ comps: [...comps, blankComp] })}
              className="mt-2 flex items-center gap-1 text-xs font-semibold text-blue-700 hover:text-blue-900">
              <Plus className="h-3.5 w-3.5" /> Add a sold teardown
            </button>
          </div>
        )}
        <SuggestedTeardowns suggestions={suggestions} comps={comps} onAdd={(add) => patch({ comps: [...comps.filter((c) => c.label || c.price), ...add].slice(0, 30) })} />
        {deal.name && /example figures/i.test(deal.name) && (
          <p className="mt-2 text-[11px] font-medium text-amber-700">{deal.name} — replace these with the real numbers before you send anything.</p>
        )}
      </div>

      {/* 4 · What the seller saves, and our spread */}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <StepHead n={4}>What the seller saves &amp; our spread</StepHead>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <label className="block">
            <span className={LABEL}>Seller's selling costs</span>
            <NumField ariaLabel="Seller's selling costs percent" pct suffix="%" value={deal.sellingCostPct} onChange={(v) => patch({ sellingCostPct: v })} />
          </label>
          <label className="block">
            <span className={LABEL}>Builder's agent fee</span>
            <NumField ariaLabel="Builder's agent fee percent" pct suffix="%" value={deal.agentFeePct} onChange={(v) => patch({ agentFeePct: v })} />
          </label>
          <label className="block">
            <span className={LABEL}>Minimum spread</span>
            <NumField ariaLabel="Minimum spread" money prefix="$" value={deal.minSpread} onChange={(v) => patch({ minSpread: v })} />
          </label>
          <label className="block">
            <span className={LABEL}>Assign to a builder at</span>
            <NumField ariaLabel="Assign at" money prefix="$" value={deal.assignAt} onChange={(v) => patch({ assignAt: v })} placeholder="lot value" />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-4 text-sm text-slate-700">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={Boolean(screens.arterial)} onChange={(e) => setScreen("arterial", e.target.checked)} /> On a main road
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={Boolean(screens.corner)} onChange={(e) => setScreen("corner", e.target.checked)} /> Corner lot
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={Boolean(screens.listed)} onChange={(e) => setScreen("listed", e.target.checked)} /> Already listed
          </label>
          {screens.listed && (
            <label className="flex items-center gap-2">
              Price cuts <span className="w-14"><NumField ariaLabel="Price cuts" value={screens.priceCuts} onChange={(v) => setScreen("priceCuts", v)} /></span>
            </label>
          )}
        </div>
        <p className="mt-2 text-[11px] text-slate-500">Commission plus closing, not REET — the seller pays that either way. Builders of $4M+ homes want an interior lot.</p>
      </div>

      {/* 5 · The offer */}
      {!r ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-5">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-slate-600">
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-bold leading-none text-white">5</span>
            Lot offer
          </div>
          <p className="mb-2 text-sm text-slate-600">To price it:</p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
            {(run?.errors || []).map((e) => <li key={e}>{e}</li>)}
          </ul>
        </div>
      ) : (
        <VerdictCard step={5} title="Lot offer"
          maxOffer={r.maxOffer} asking={asking} per={deal.lotSqft > 0 ? r.maxOffer / deal.lotSqft : 0} perLabel="sqft of lot"
          sentence={`${r.comps} sold teardown${r.comps === 1 ? "" : "s"} put lots here at about ${money(r.lotValue)}. Listing would cost the seller about ${money(r.sellingCosts)} (${pct}%), so the offer is ${money(r.maxOffer)} and they net the same. A builder takes it at ${deal.assignAt > 0 ? "" : "about "}${money(r.assignAt)}, leaving a ${money(r.spread)} spread${r.agentFee > 0 ? ` after the ${money(r.agentFee)} agent fee` : ""}.`}
          priceOverride={priceOverride} setPriceOverride={setPriceOverride} fmtTyped={fmtTyped}>
          <TestBars tests={r.tests.map((t) => (t.key === "assign" ? { ...t, info: false } : t))} asking={asking} />
          {r.warnings.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-amber-800">
              {r.warnings.map((w, i) => <li key={`${w.key}-${i}`}>Look at this: {w.text}.</li>)}
            </ul>
          )}
        </VerdictCard>
      )}
    </>
  );
}
