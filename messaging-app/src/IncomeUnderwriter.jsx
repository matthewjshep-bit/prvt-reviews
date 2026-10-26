// IncomeUnderwriter.jsx — the multi-family and commercial analyzer.
//
// What the offer editor shows in place of comps, rehab and the flip stack
// when the property is priced by its income (shared/underwrite-model.js).
// Every number comes from shared/income-underwrite.js — this file only reads
// inputs and lays out the answer: rent roll, assumptions, the max offer and
// the test that set it, then the detail tabs.

import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { fmtMoney } from "@shared/offer-calc.js";
import { blankIncomeDeal, sampleIncomeDeal, verdictOf } from "@shared/income-underwrite.js";
import IncomeProjection from "./IncomeProjection.jsx";

/* ---------- small formatting helpers ---------- */

const money = (v) => (Number.isFinite(v) ? fmtMoney(Math.round(v)) : "—");
const pct = (v, d = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : "—");
const times = (v) => (Number.isFinite(v) ? `${v.toFixed(2)}×` : "—");
const signedMoney = (v) => (Number.isFinite(v) ? `${v < 0 ? "−" : "+"}${fmtMoney(Math.abs(Math.round(v)))}` : "—");

const CELL_INPUT = "w-full min-w-0 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm tabular-nums focus:border-blue-500 focus:outline-none";
const LABEL = "mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500";

export function StepHead({ n, children, right }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-sm font-bold">
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-bold leading-none text-white">{n}</span>
        {children}
      </h2>
      {right}
    </div>
  );
}

/**
 * NumField — a number input that keeps what you're typing ("7.") while it
 * has focus and stores a real number. `pct` shows 0.05 as 5. `money` shows
 * thousands separators once you leave the field.
 */
export function NumField({ value, onChange, pct: isPct = false, money: isMoney = false, prefix, suffix, placeholder, className = "", ariaLabel }) {
  const toText = (v) => {
    if (v === null || v === undefined || v === "" || !Number.isFinite(Number(v))) return "";
    const n = Number(v);
    if (isPct) return String(Math.round(n * 100 * 10000) / 10000);
    return isMoney ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(n);
  };
  const [text, setText] = useState(() => toText(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(toText(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`relative min-w-0 ${className}`}>
      {prefix && <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-slate-400">{prefix}</span>}
      <input
        aria-label={ariaLabel}
        inputMode="decimal"
        className={`${CELL_INPUT} ${prefix ? "pl-5" : ""} ${suffix ? (String(suffix).length > 2 ? "pr-12" : "pr-7") : ""} text-right`}
        value={text}
        placeholder={placeholder}
        onFocus={() => { focused.current = true; }}
        onBlur={() => { focused.current = false; setText(toText(value)); }}
        onChange={(e) => {
          const t = e.target.value.replace(/[^\d.,-]/g, "");
          setText(t);
          if (t.trim() === "") return onChange(0);
          const n = Number(t.replace(/,/g, ""));
          if (Number.isFinite(n)) onChange(isPct ? n / 100 : n);
        }}
      />
      {suffix && <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400">{suffix}</span>}
    </div>
  );
}

function Labeled({ label, children, hint }) {
  return (
    <label className="block min-w-0">
      <span className={`${LABEL} truncate`} title={label}>{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-[11px] text-slate-400">{hint}</span>}
    </label>
  );
}

/* ---------- the verdict, shared with the land analyzer ---------- */

const STATUS = {
  works: { label: "Works at asking", cls: "bg-emerald-100 text-emerald-800 border-emerald-300" },
  close: { label: "Close, negotiate", cls: "bg-amber-100 text-amber-800 border-amber-300" },
  over: { label: "Overpriced for your targets", cls: "bg-red-100 text-red-700 border-red-300" },
};

/**
 * VerdictCard — the max offer, asking, the gap, the status pill, one sentence
 * on why, and the letter's price override. Shared by income and land.
 */
export function VerdictCard({ step, title, maxOffer, asking, per, perLabel, sentence, priceOverride, setPriceOverride, fmtTyped, children }) {
  const v = verdictOf(maxOffer, asking);
  const s = STATUS[v.status];
  const typed = Number(String(priceOverride || "").replace(/[^\d]/g, "")) || 0;
  return (
    <div className="rounded-xl border border-amber-400 bg-amber-50 p-5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-slate-600">
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-bold leading-none text-white">{step}</span>
          {title}
        </div>
        {asking > 0 && <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${s.cls}`}>{s.label}</span>}
      </div>
      <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Max offer</div>
          <div className="text-4xl font-black tracking-tight tabular-nums">{money(maxOffer)}</div>
          {per > 0 && <div className="mt-0.5 text-xs text-slate-600 tabular-nums">{money(per)} per {perLabel}</div>}
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:text-right">
          <dt className="text-slate-600">Asking</dt><dd className="font-medium tabular-nums">{asking > 0 ? money(asking) : "—"}</dd>
          <dt className="text-slate-600">Gap</dt>
          <dd className={`font-semibold tabular-nums ${v.gap >= 0 ? "text-emerald-700" : "text-red-700"}`}>
            {asking > 0 ? `${signedMoney(v.gap)} (${v.gapPct >= 0 ? "+" : "−"}${Math.abs(v.gapPct * 100).toFixed(1)}%)` : "—"}
          </dd>
        </dl>
      </div>
      {sentence && <p className="mt-3 text-sm text-slate-700">{sentence}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-amber-200 pt-3 text-xs text-slate-600">
        <label className="flex items-center gap-2">
          Offer amount on letter $
          <input
            className="w-32 rounded-lg border border-amber-300 bg-white px-2 py-1.5 text-right text-sm font-semibold tabular-nums focus:border-blue-500 focus:outline-none"
            inputMode="numeric" placeholder="max offer"
            value={priceOverride || ""}
            onChange={(e) => setPriceOverride(fmtTyped(e.target.value))}
          />
        </label>
        {typed > 0 && (
          <span>
            the max offer is {money(maxOffer)} —{" "}
            <button type="button" onClick={() => setPriceOverride("")} className="font-semibold underline hover:text-slate-800">use it</button>
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * TestBars — "What each test lets you pay": one bar per test on one scale,
 * the asking price as a red line across all of them, the binding test blue.
 */
export function TestBars({ tests = [], asking = 0, note }) {
  const top = Math.max(asking, ...tests.map((t) => t.price || 0), 1) * 1.08;
  const at = (v) => `${Math.max(0, Math.min(100, (v / top) * 100))}%`;
  return (
    <div className="mt-4 rounded-lg border border-amber-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">What each test lets you pay</h3>
        {asking > 0 && (
          <span className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <span className="inline-block h-3 w-0.5 bg-red-500" /> asking {money(asking)}
          </span>
        )}
      </div>
      <ul className="space-y-2.5">
        {tests.map((t) => (
          <li key={t.key} className="grid grid-cols-[7.5rem_1fr_5.5rem] items-center gap-2 text-xs sm:grid-cols-[9rem_1fr_6rem]">
            <span className={`truncate ${t.binding ? "font-bold text-slate-900" : t.info ? "text-slate-400" : "text-slate-600"}`}>
              {t.label}
              {t.info && <span className="ml-1 rounded bg-slate-100 px-1 py-px text-[10px] font-semibold text-slate-500">Loan sizing</span>}
            </span>
            <span className="relative h-5 rounded bg-slate-100">
              <span className={`absolute inset-y-0 left-0 rounded ${t.binding ? "bg-blue-600" : t.info ? "bg-slate-200" : "bg-slate-400"}`} style={{ width: at(t.price) }} />
              {asking > 0 && <span className="absolute -inset-y-0.5 w-0.5 bg-red-500" style={{ left: at(asking) }} />}
            </span>
            <span className={`text-right tabular-nums ${t.binding ? "font-bold" : t.info ? "text-slate-400" : ""}`}>
              {money(t.price)}
              {t.binding && <span className="block text-[10px] font-semibold uppercase text-blue-700">Sets offer</span>}
            </span>
          </li>
        ))}
      </ul>
      {note && <p className="mt-3 text-[11px] text-slate-500">{note}</p>}
    </div>
  );
}

/* ---------- the rent roll ---------- */

function RemoveBtn({ onClick }) {
  return (
    <button type="button" onClick={onClick} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600" title="Remove row" aria-label="Remove row">
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  );
}

function UnitRoll({ deal, patch }) {
  const rows = deal.units || [];
  const set = (i, p) => patch({ units: rows.map((r, j) => (j === i ? { ...r, ...p } : r)) });
  const totals = rows.reduce((t, r) => ({ n: t.n + (Number(r.count) || 0), cur: t.cur + (r.count || 0) * (r.rent || 0), mkt: t.mkt + (r.count || 0) * (r.marketRent || 0) }), { n: 0, cur: 0, mkt: 0 });
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="w-full min-w-[34rem] text-sm">
        <thead>
          <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            <th className="pb-1.5 pr-2 font-semibold">Unit type</th>
            <th className="w-20 pb-1.5 pr-2 text-right font-semibold">Units</th>
            <th className="w-32 pb-1.5 pr-2 text-right font-semibold">Current rent /mo</th>
            <th className="w-32 pb-1.5 pr-2 text-right font-semibold">Market rent /mo</th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="py-1 pr-2"><input className={CELL_INPUT} value={r.label} placeholder="2bd/1ba" aria-label="Unit type" onChange={(e) => set(i, { label: e.target.value })} /></td>
              <td className="py-1 pr-2"><NumField ariaLabel="Units" value={r.count} onChange={(v) => set(i, { count: v })} /></td>
              <td className="py-1 pr-2"><NumField ariaLabel="Current rent" money prefix="$" value={r.rent} onChange={(v) => set(i, { rent: v })} /></td>
              <td className="py-1 pr-2"><NumField ariaLabel="Market rent" money prefix="$" value={r.marketRent} onChange={(v) => set(i, { marketRent: v })} /></td>
              <td className="py-1 text-right"><RemoveBtn onClick={() => patch({ units: rows.filter((_, j) => j !== i) })} /></td>
            </tr>
          ))}
        </tbody>
        {rows.length > 0 && (
          <tfoot>
            <tr className="border-t border-slate-200 text-xs text-slate-600">
              <td className="pt-2 font-semibold">Total</td>
              <td className="pt-2 pr-2 text-right font-semibold tabular-nums">{totals.n}</td>
              <td className="pt-2 pr-2 text-right tabular-nums">{money(totals.cur)}/mo</td>
              <td className="pt-2 pr-2 text-right tabular-nums">{money(totals.mkt)}/mo</td>
              <td />
            </tr>
          </tfoot>
        )}
      </table>
      <button type="button" onClick={() => patch({ units: [...rows, { label: "", count: 1, rent: 0, marketRent: 0 }] })}
        className="mt-2 flex items-center gap-1 text-xs font-semibold text-blue-700 hover:text-blue-900">
        <Plus className="h-3.5 w-3.5" /> Add unit type
      </button>
    </div>
  );
}

function TenantRoll({ deal, patch }) {
  const rows = deal.tenants || [];
  const set = (i, p) => patch({ tenants: rows.map((r, j) => (j === i ? { ...r, ...p } : r)) });
  const sf = rows.reduce((s, r) => s + (Number(r.sqft) || 0), 0);
  const leased = rows.filter((r) => (r.rentPsf || 0) > 0).reduce((s, r) => s + (Number(r.sqft) || 0), 0);
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="w-full min-w-[44rem] text-sm">
        <thead>
          <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            <th className="pb-1.5 pr-2 font-semibold">Tenant / suite</th>
            <th className="w-24 pb-1.5 pr-2 text-right font-semibold">Sq ft</th>
            <th className="w-24 pb-1.5 pr-2 text-right font-semibold">Rent $/sf/yr</th>
            <th className="w-24 pb-1.5 pr-2 text-right font-semibold">Market $/sf/yr</th>
            <th className="w-28 pb-1.5 pr-2 text-right font-semibold" title="What the tenant pays back each year toward taxes, insurance and common area (NNN)">NNN paid /yr</th>
            <th className="w-20 pb-1.5 pr-2 text-right font-semibold" title="Years left on the lease. 0 = vacant or month-to-month">Yrs left</th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="py-1 pr-2"><input className={CELL_INPUT} value={r.name} placeholder="Suite A" aria-label="Tenant" onChange={(e) => set(i, { name: e.target.value })} /></td>
              <td className="py-1 pr-2"><NumField ariaLabel="Square feet" money value={r.sqft} onChange={(v) => set(i, { sqft: v })} /></td>
              <td className="py-1 pr-2"><NumField ariaLabel="Rent per square foot" prefix="$" value={r.rentPsf} onChange={(v) => set(i, { rentPsf: v })} /></td>
              <td className="py-1 pr-2"><NumField ariaLabel="Market rent per square foot" prefix="$" value={r.marketRentPsf} onChange={(v) => set(i, { marketRentPsf: v })} /></td>
              <td className="py-1 pr-2"><NumField ariaLabel="NNN recoveries" money prefix="$" value={r.recoveries} onChange={(v) => set(i, { recoveries: v })} /></td>
              <td className="py-1 pr-2"><NumField ariaLabel="Years left on lease" value={r.yearsLeft} onChange={(v) => set(i, { yearsLeft: v })} /></td>
              <td className="py-1 text-right"><RemoveBtn onClick={() => patch({ tenants: rows.filter((_, j) => j !== i) })} /></td>
            </tr>
          ))}
        </tbody>
        {rows.length > 0 && (
          <tfoot>
            <tr className="border-t border-slate-200 text-xs text-slate-600">
              <td className="pt-2 font-semibold">Total</td>
              <td className="pt-2 pr-2 text-right font-semibold tabular-nums">{sf.toLocaleString("en-US")}</td>
              <td className="pt-2 pr-2 text-right" colSpan={4}>{sf > 0 ? `${pct(leased / sf, 0)} leased` : ""}</td>
              <td />
            </tr>
          </tfoot>
        )}
      </table>
      <button type="button" onClick={() => patch({ tenants: [...rows, { name: "", sqft: 0, rentPsf: 0, marketRentPsf: 0, recoveries: 0, yearsLeft: 0 }] })}
        className="mt-2 flex items-center gap-1 text-xs font-semibold text-blue-700 hover:text-blue-900">
        <Plus className="h-3.5 w-3.5" /> Add tenant or suite
      </button>
    </div>
  );
}

/* ---------- assumptions ---------- */

function Section({ title, summary, open, onToggle, children }) {
  return (
    <div className="rounded-lg border border-slate-200">
      <button type="button" onClick={onToggle} aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-slate-50">
        <span className="text-sm font-semibold text-slate-800">{title}</span>
        <span className="flex min-w-0 items-center gap-2">
          {!open && <span className="truncate text-xs text-slate-500 tabular-nums">{summary}</span>}
          <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>
      {open && <div className="grid grid-cols-2 gap-3 border-t border-slate-100 p-3 sm:grid-cols-3">{children}</div>}
    </div>
  );
}

/* ---------- the detail tabs ---------- */

function pill(level) {
  return level === "good" ? "bg-emerald-100 text-emerald-800" : level === "warn" ? "bg-amber-100 text-amber-800" : level === "bad" ? "bg-red-100 text-red-700" : "";
}

function MetricsTable({ deal, asking, atMax, sizeLabel }) {
  const lvl = {
    yoc: (v) => (v >= deal.targetYoc ? "good" : v >= deal.marketCap ? "warn" : "bad"),
    dscr: (v) => (v >= deal.minDscr ? "good" : v >= 1 ? "warn" : "bad"),
    coc2: (v) => (v >= deal.targetCoc ? "good" : v >= 0 ? "warn" : "bad"),
    irr: (v) => (v >= deal.targetIrr ? "good" : v >= deal.targetIrr - 0.05 ? "warn" : "bad"),
    breakEven: (v) => (v <= 0.8 ? "good" : v <= 0.88 ? "warn" : "bad"),
  };
  const rows = [
    ["Price", (a) => money(a.price)],
    [`Price per ${sizeLabel}`, (a) => money(a.metrics.pricePer)],
    ["Loan", (a) => `${money(a.loan)}${a.dscrCut ? " ◆" : ""}`],
    ["Effective LTV", (a) => pct(a.effectiveLtv)],
    ["Cash in (down + closing + rehab)", (a) => money(a.equity)],
    ["In-place cap rate", (a) => pct(a.metrics.inPlaceCap, 2)],
    ["Yield on cost", (a) => pct(a.metrics.yieldOnCost, 2), "yoc", (a) => a.metrics.yieldOnCost],
    ["DSCR", (a) => times(a.metrics.dscr), "dscr", (a) => a.metrics.dscr],
    ["Cash-on-cash, year 1", (a) => pct(a.metrics.coc1)],
    ["Cash-on-cash, year 2", (a) => pct(a.metrics.coc2), "coc2", (a) => a.metrics.coc2],
    ["Levered IRR", (a) => pct(a.metrics.irr), "irr", (a) => a.metrics.irr],
    ["Equity multiple", (a) => times(a.metrics.equityMultiple)],
    ["Debt yield", (a) => pct(a.metrics.debtYield)],
    ["Gross rent multiplier", (a) => (Number.isFinite(a.metrics.grm) ? a.metrics.grm.toFixed(1) : "—")],
    ["Leverage spread", (a) => (Number.isFinite(a.metrics.leverageSpread) ? `${a.metrics.leverageSpread >= 0 ? "+" : ""}${(a.metrics.leverageSpread * 100).toFixed(2)} pts` : "—")],
    ["Break-even occupancy", (a) => pct(a.metrics.breakEven), "breakEven", (a) => a.metrics.breakEven],
  ];
  const cell = (a, fmt, key, get) => {
    if (!a) return <td className="py-1.5 text-right text-slate-400">—</td>;
    const v = get ? get(a) : null;
    const l = key && Number.isFinite(v) ? lvl[key](v) : "";
    return (
      <td className="py-1.5 pl-3 text-right tabular-nums">
        <span className={l ? `rounded px-1.5 py-0.5 font-medium ${pill(l)}` : ""}>{fmt(a)}</span>
      </td>
    );
  };
  const cut = asking?.dscrCut || atMax?.dscrCut;
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="w-full min-w-[22rem] text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            <th className="pb-1.5 text-left font-semibold" />
            <th className="pb-1.5 pl-3 text-right font-semibold">At asking</th>
            <th className="pb-1.5 pl-3 text-right font-semibold">At max offer</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map(([label, fmt, key, get]) => (
            <tr key={label}>
              <td className="py-1.5 text-slate-600">{label}</td>
              {cell(asking, fmt, key, get)}
              {cell(atMax, fmt, key, get)}
            </tr>
          ))}
        </tbody>
      </table>
      {cut && <p className="mt-2 text-[11px] text-slate-500">◆ The income, not the price, set this loan: today's NOI only covers this much debt at a {times(deal.minDscr)} DSCR. You bring the rest in cash.</p>}
    </div>
  );
}

function OperatingStatement({ deal, inPlace, stabilized }) {
  const commercial = deal.kind === "commercial";
  const line = (label, a, b, { neg = false, bold = false, fmt = money } = {}) => (
    <tr key={label} className={bold ? "font-semibold" : ""}>
      <td className={`py-1.5 ${bold ? "text-slate-900" : "text-slate-600"}`}>{label}</td>
      <td className="py-1.5 pl-3 text-right tabular-nums">{neg && a ? "−" : ""}{fmt(a)}</td>
      <td className="py-1.5 pl-3 text-right tabular-nums">{neg && b ? "−" : ""}{fmt(b)}</td>
    </tr>
  );
  const e = (k) => [inPlace.expenses[k], stabilized.expenses[k]];
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="w-full min-w-[22rem] text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            <th className="pb-1.5 text-left font-semibold" />
            <th className="pb-1.5 pl-3 text-right font-semibold">In place</th>
            <th className="pb-1.5 pl-3 text-right font-semibold">Stabilized (yr 2)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {line(commercial ? "Base rent" : "Gross potential rent", inPlace.gpr, stabilized.gpr)}
          {line("Other income", inPlace.other, stabilized.other)}
          {commercial && line("NNN recoveries", inPlace.recoveries, stabilized.recoveries)}
          {line(`Vacancy (${pct(inPlace.vacancyRate, 0)} / ${pct(stabilized.vacancyRate, 0)})`, inPlace.vacancyLoss, stabilized.vacancyLoss, { neg: true })}
          {line("Credit loss", inPlace.creditLoss, stabilized.creditLoss, { neg: true })}
          {commercial && (inPlace.rollover > 0 || stabilized.rollover > 0) && line("Re-leasing downtime", inPlace.rollover, stabilized.rollover, { neg: true })}
          {line("Effective gross income", inPlace.egi, stabilized.egi, { bold: true })}
          {line("Taxes", ...e("taxes"), { neg: true })}
          {line("Insurance", ...e("insurance"), { neg: true })}
          {line("Utilities (owner-paid)", ...e("utilities"), { neg: true })}
          {line("Admin, legal & other", ...e("admin"), { neg: true })}
          {line("Repairs & maintenance", ...e("rm"), { neg: true })}
          {line("Reserves", ...e("reserves"), { neg: true })}
          {line(`Management (${pct(deal.mgmtPct, 0)} of EGI)`, ...e("management"), { neg: true })}
          {line("Total expenses", inPlace.opex, stabilized.opex, { neg: true, bold: true })}
          {line("Net operating income", inPlace.noi, stabilized.noi, { bold: true })}
          {line("Expense ratio", inPlace.expenseRatio, stabilized.expenseRatio, { fmt: (v) => pct(v) })}
          {line(`Value at ${pct(deal.marketCap, 2)} market cap`, deal.marketCap > 0 ? inPlace.noi / deal.marketCap : NaN, deal.marketCap > 0 ? stabilized.noi / deal.marketCap : NaN, { bold: true })}
        </tbody>
      </table>
    </div>
  );
}

function CashFlowTable({ deal, atMax }) {
  if (!atMax) return <p className="text-sm text-slate-500">No price passes your targets, so there's no cash flow to show.</p>;
  const hold = atMax.years.length;
  return (
    <div>
      <div className="-mx-4 overflow-x-auto px-4">
        <table className="w-full text-sm" style={{ minWidth: `${10 + hold * 6}rem` }}>
          <thead>
            <tr className="border-b border-slate-200 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <th className="pb-1.5 text-left font-semibold" />
              {atMax.years.map((y) => <th key={y.year} className="pb-1.5 pl-3 text-right font-semibold">Yr {y.year}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 tabular-nums">
            <tr><td className="py-1.5 text-slate-600">NOI</td>{atMax.years.map((y) => <td key={y.year} className="py-1.5 pl-3 text-right">{money(y.noi)}</td>)}</tr>
            <tr><td className="py-1.5 text-slate-600">Debt service</td>{atMax.years.map((y) => <td key={y.year} className="py-1.5 pl-3 text-right">−{money(y.debtService)}</td>)}</tr>
            <tr className="font-semibold"><td className="py-1.5">Cash flow</td>{atMax.years.map((y) => <td key={y.year} className={`py-1.5 pl-3 text-right ${y.cashFlow < 0 ? "text-red-700" : ""}`}>{money(y.cashFlow)}</td>)}</tr>
            <tr><td className="py-1.5 text-slate-600">Net sale proceeds</td>{atMax.years.map((y, i) => <td key={y.year} className="py-1.5 pl-3 text-right">{i === hold - 1 ? money(atMax.netSale) : ""}</td>)}</tr>
            <tr className="font-bold"><td className="py-1.5">Total to you</td>{atMax.flows.slice(1).map((v, i) => <td key={i} className="py-1.5 pl-3 text-right">{money(v)}</td>)}</tr>
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-slate-600">
        You put in {money(atMax.equity)} at the start. At the end of year {hold} you sell: year {hold + 1}'s NOI of {money(atMax.exitNoi)} ÷ a {pct(atMax.exitCap, 2)} exit cap = {money(atMax.salePrice)},
        less {pct(deal.saleCostPct, 1)} to sell ({money(atMax.saleCosts)}) and the {money(atMax.balance)} loan payoff = {money(atMax.netSale)} back to you.
      </p>
    </div>
  );
}

function SensitivityGrid({ deal, sens, base }) {
  const tone = (v) => (!Number.isFinite(v) ? "bg-slate-50 text-slate-400" : v >= deal.targetIrr ? "bg-emerald-50 text-emerald-800" : v >= deal.targetIrr - 0.03 ? "bg-amber-50 text-amber-800" : "bg-red-50 text-red-700");
  return (
    <div>
      <div className="-mx-4 overflow-x-auto px-4">
        <table className="w-full min-w-[28rem] text-sm tabular-nums">
          <thead>
            <tr className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <th className="pb-1.5 text-left font-semibold">Price ↓ · exit cap →</th>
              {sens.caps.map((c, j) => <th key={j} className="pb-1.5 text-center font-semibold">{pct(c, 2)}</th>)}
            </tr>
          </thead>
          <tbody>
            {sens.prices.map((p, i) => (
              <tr key={i}>
                <td className="py-0.5 pr-2 text-xs text-slate-600">{money(p)}{i === 2 ? " · max" : ""}</td>
                {sens.irr[i].map((v, j) => (
                  <td key={j} className="p-0.5">
                    <div className={`rounded px-1 py-1.5 text-center text-xs font-medium ${tone(v)} ${i === 2 && j === 2 ? "ring-2 ring-slate-900" : ""}`}>{pct(v)}</div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-slate-500">
        Levered IRR. Green meets your {pct(deal.targetIrr, 0)} target, amber is within 3 points, red is short. The outlined cell is {base > 0 ? "the max offer" : "asking"} at your exit cap.
      </p>
    </div>
  );
}

function Checks({ flags }) {
  const dot = { good: "bg-emerald-500", warn: "bg-amber-500", bad: "bg-red-500" };
  if (!flags.length) return <p className="text-sm text-slate-500">Nothing to flag.</p>;
  return (
    <ul className="space-y-2">
      {flags.map((f) => (
        <li key={f.key} className="flex gap-2.5 text-sm">
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot[f.level]}`} />
          <span className="text-slate-700">{f.text}</span>
        </li>
      ))}
    </ul>
  );
}

const GLOSSARY = [
  ["NOI (net operating income)", "Rent and other income, less vacancy and every operating cost — but before the mortgage. It's what the building earns on its own. Think of it as the commercial version of ARV: the value comes from it."],
  ["Cap rate", "NOI ÷ price. Flip that around and value = NOI ÷ cap rate. A $60,000 NOI at a 6% cap is worth $1,000,000. A lower cap means a higher price for the same income."],
  ["DSCR (debt service coverage)", "NOI ÷ the yearly mortgage payment. Lenders want about 1.20–1.25×. If today's income can't cover the loan they'd give at full LTV, they lend less and you bring more cash."],
  ["Positive vs negative leverage", "If the cap rate is above the loan constant (the yearly payment per $1 borrowed), borrowing raises your return. If it's below, every borrowed dollar lowers it — you're paying more for the money than the building earns on it."],
  ["Cash-on-cash", "One year's cash flow after the mortgage ÷ the cash you put in. The rental version of 'what did my money make this year'."],
  ["Yield on cost", "Stabilized NOI ÷ everything you spent (price, closing, rehab). It should beat the market cap rate by a margin — that gap is the value you created, like the spread between your all-in and ARV on a flip."],
  ["IRR (levered)", "Your annual return across the whole hold, counting every year's cash flow and the sale, and when you got each dollar. The closest thing to a flip's profit percentage, adjusted for time."],
  ["Equity multiple", "Everything you get back ÷ what you put in. 2.0× means you doubled your money over the hold."],
  ["Break-even occupancy", "How full the building has to be to pay every expense and the mortgage. Under about 80% is comfortable; over 88% means a few empty units hurts."],
];

/* ---------- the analyzer ---------- */

const TABS = [
  { key: "metrics", label: "Metrics" },
  { key: "ops", label: "Operating statement" },
  { key: "cash", label: "Cash flow" },
  { key: "sens", label: "Sensitivity" },
  { key: "checks", label: "Checks" },
];

/**
 * IncomeUnderwriter — steps 3–5 of the offer editor for an income property.
 *
 *   kind          "multi_family" | "commercial"
 *   deal          the deal object (shared/income-underwrite.js), as typed
 *   setDeal       (deal) => void
 *   run           underwriteIncome(deal with the form's asking price)
 *   asking        the form's asking price (a number)
 *   priceOverride / setPriceOverride / fmtTyped — the letter's number, as the comps card has it
 *   onUseComps    optional: price this one with comps instead (a 2–4 unit)
 */
export default function IncomeUnderwriter({ kind, deal, setDeal, run, asking, priceOverride, setPriceOverride, fmtTyped, onUseComps }) {
  const [open, setOpen] = useState({ expenses: true, financing: false, market: false, targets: false });
  const [tab, setTab] = useState("metrics");
  const patch = (p) => setDeal({ ...deal, ...p, kind });
  const commercial = kind === "commercial";
  const rows = commercial ? deal.tenants || [] : deal.units || [];
  const perLabel = commercial ? "sf" : "unit";
  const field = (k, label, opts = {}) => (
    <Labeled key={k} label={label} hint={opts.hint}>
      <NumField ariaLabel={label} value={deal[k]} onChange={(v) => patch({ [k]: v })} {...opts} />
    </Labeled>
  );

  const r = run?.ok ? run.result : null;
  const atMax = r?.at || null;
  const askingRun = run?.ok ? run.asking : null;
  const binding = r?.tests.find((t) => t.binding);
  const totalUnits = r?.inPlace?.size || 0;
  const sentence = r && atMax
    ? `${binding.label} sets the offer. At ${money(r.maxOffer)} you'd buy at a ${pct(atMax.metrics.inPlaceCap, 2)} in-place cap, reach a ${pct(atMax.metrics.yieldOnCost, 2)} yield on cost after the ${money(deal.rehab)} rehab, and put ${money(atMax.equity)} in.`
    : r ? "No price passes every test — even $1 misses one of your targets. Check the rents and expenses, or loosen a target." : "";

  const summary = {
    expenses: `Taxes ${money(deal.taxes)} · Ins ${money(deal.insurance)} · Mgmt ${pct(deal.mgmtPct, 0)}`,
    financing: `${pct(deal.ltv, 0)} LTV · ${pct(deal.rate, 2)} · ${deal.amortYears}yr · ${times(deal.minDscr)} DSCR`,
    market: `${pct(deal.marketCap, 2)} cap · exit ${pct(deal.exitCap, 2)} · ${deal.holdYears}yr hold`,
    targets: `CoC ${pct(deal.targetCoc, 1)} · YoC ${pct(deal.targetYoc, 1)} · IRR ${pct(deal.targetIrr, 0)}`,
  };
  const toggle = (k) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const perSize = commercial ? "/sf/yr" : "/unit/yr";

  return (
    <>
      {/* 3 · Rent roll */}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <StepHead n={3} right={
          <div className="flex items-center gap-2">
            {onUseComps && (
              <button type="button" onClick={onUseComps} className="text-xs font-medium text-slate-500 underline hover:text-slate-800">
                Price this one with comps instead
              </button>
            )}
            {rows.length > 0 && (
              <button type="button" onClick={() => setDeal(blankIncomeDeal(kind))}
                className="flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50" title="Clear the rent roll and go back to the default assumptions">
                <RotateCcw className="h-3 w-3" /> Reset
              </button>
            )}
          </div>
        }>
          {commercial ? "Rent roll — tenants & leases" : "Rent roll"}
        </StepHead>

        {rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 p-5 text-center">
            <p className="text-sm text-slate-600">
              {commercial
                ? "Add each tenant or suite: its square feet, what it pays now, what it would rent for today, and how long the lease runs."
                : "Add each unit type: how many, what they rent for now, and what they'd rent for after the work."}
            </p>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
              <button type="button"
                onClick={() => patch(commercial ? { tenants: [{ name: "", sqft: 0, rentPsf: 0, marketRentPsf: 0, recoveries: 0, yearsLeft: 0 }] } : { units: [{ label: "", count: 1, rent: 0, marketRent: 0 }] })}
                className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700">
                <Plus className="h-3.5 w-3.5" /> {commercial ? "Add a tenant" : "Add a unit type"}
              </button>
              <button type="button" onClick={() => setDeal(sampleIncomeDeal(kind))}
                className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                <Sparkles className="h-3.5 w-3.5" /> Load sample deal (example figures)
              </button>
            </div>
          </div>
        ) : commercial ? <TenantRoll deal={deal} patch={patch} /> : <UnitRoll deal={deal} patch={patch} />}

        {deal.name && /example figures/i.test(deal.name) && (
          <p className="mt-2 text-[11px] font-medium text-amber-700">{deal.name} — replace these with the real numbers before you send anything.</p>
        )}

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {field("otherIncome", commercial ? "Other income /yr" : "Other income /unit/mo", { money: true, prefix: "$", hint: commercial ? "parking, signage" : "laundry, parking, pets" })}
          {field("vacancy", "Vacancy", { pct: true, suffix: "%" })}
          {field("creditLoss", "Credit loss", { pct: true, suffix: "%" })}
          {field("rehabVacancy", commercial ? "Lease-up vacancy, yr 1" : "Rehab vacancy, yr 1", { pct: true, suffix: "%", hint: "extra, while units turn" })}
          {commercial && field("downtimeMonths", "Re-lease downtime", { suffix: "mo", hint: "when a lease ends" })}
        </div>
      </div>

      {/* 4 · Assumptions */}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <StepHead n={4}>Plan &amp; assumptions</StepHead>
        <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {field("rehab", "Rehab / value-add budget", { money: true, prefix: "$" })}
        </div>
        <div className="space-y-2">
          <Section title="Operating expenses (yearly)" summary={summary.expenses} open={open.expenses} onToggle={() => toggle("expenses")}>
            {field("taxes", "Property taxes", { money: true, prefix: "$" })}
            {field("insurance", "Insurance", { money: true, prefix: "$" })}
            {field("utilities", "Owner-paid utilities", { money: true, prefix: "$" })}
            {field("admin", "Admin, legal & other", { money: true, prefix: "$" })}
            {field("rmPerUnit", `Repairs & maint. ${perSize}`, { money: true, prefix: "$" })}
            {field("reservesPerUnit", `Reserves ${perSize}`, { money: true, prefix: "$" })}
            {field("mgmtPct", "Management, % of EGI", { pct: true, suffix: "%" })}
          </Section>
          <Section title="Financing" summary={summary.financing} open={open.financing} onToggle={() => toggle("financing")}>
            {field("ltv", "Max LTV", { pct: true, suffix: "%" })}
            {field("rate", "Interest rate", { pct: true, suffix: "%" })}
            {field("amortYears", "Amortization", { suffix: "yrs" })}
            {field("ioYears", "Interest-only", { suffix: "yrs" })}
            {field("minDscr", "Minimum DSCR", { suffix: "×" })}
            {field("closingPct", "Closing costs", { pct: true, suffix: "%", hint: "% of price" })}
          </Section>
          <Section title="Market & exit" summary={summary.market} open={open.market} onToggle={() => toggle("market")}>
            {field("marketCap", "Market cap rate", { pct: true, suffix: "%" })}
            {field("exitCap", "Exit cap rate", { pct: true, suffix: "%" })}
            {field("holdYears", "Hold period", { suffix: "yrs", hint: "1 to 15" })}
            {field("rentGrowth", "Rent growth /yr", { pct: true, suffix: "%" })}
            {field("expGrowth", "Expense growth /yr", { pct: true, suffix: "%" })}
            {field("saleCostPct", "Sale costs", { pct: true, suffix: "%" })}
          </Section>
          <Section title="Return targets" summary={summary.targets} open={open.targets} onToggle={() => toggle("targets")}>
            {field("targetCoc", "Cash-on-cash, yr 2", { pct: true, suffix: "%" })}
            {field("targetYoc", "Yield on cost", { pct: true, suffix: "%" })}
            {field("targetIrr", "Levered IRR", { pct: true, suffix: "%" })}
          </Section>
        </div>
      </div>

      {/* 5 · The offer */}
      {!run?.ok ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-5">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-slate-600">
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-bold leading-none text-white">5</span>
            Income offer
          </div>
          <p className="mb-2 text-sm text-slate-600">To price it:</p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
            {(run?.errors || []).map((e) => <li key={e}>{e}</li>)}
          </ul>
        </div>
      ) : (
        <VerdictCard step={5} title="Income offer"
          maxOffer={r.maxOffer} asking={asking} per={totalUnits > 0 ? r.maxOffer / totalUnits : 0} perLabel={perLabel}
          sentence={sentence} priceOverride={priceOverride} setPriceOverride={setPriceOverride} fmtTyped={fmtTyped}>
          <TestBars tests={r.tests} asking={asking}
            note="The offer is the lowest of the four return tests. Lender DSCR is shown for loan sizing only: above it the bank lends less and you bring more cash, which the cash-on-cash and IRR tests already count." />
        </VerdictCard>
      )}

      {run?.ok && (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="-mx-4 mb-4 overflow-x-auto border-b border-slate-200 px-4">
            <div className="flex gap-1" role="tablist">
              {TABS.map((t) => (
                <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
                  className={`whitespace-nowrap border-b-2 px-3 py-2 text-xs font-semibold ${tab === t.key ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
                  {t.label}
                  {t.key === "checks" && run.flags.some((f) => f.level !== "good") && (
                    <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 text-[10px] text-amber-800">{run.flags.filter((f) => f.level !== "good").length}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
          {tab === "metrics" && <MetricsTable deal={run.deal} asking={askingRun} atMax={atMax} sizeLabel={commercial ? "sq ft" : "unit"} />}
          {tab === "ops" && <OperatingStatement deal={run.deal} inPlace={r.inPlace} stabilized={r.stabilized} />}
          {tab === "cash" && <CashFlowTable deal={run.deal} atMax={atMax} />}
          {tab === "sens" && <SensitivityGrid deal={run.deal} sens={run.sensitivity} base={r.maxOffer} />}
          {tab === "checks" && <Checks flags={run.flags} />}

          <details className="mt-5 rounded-lg bg-slate-50 p-3 text-sm">
            <summary className="cursor-pointer text-xs font-semibold text-slate-600">What these mean (coming from flips)</summary>
            <dl className="mt-3 space-y-2.5">
              {GLOSSARY.map(([t, d]) => (
                <div key={t}>
                  <dt className="font-semibold text-slate-800">{t}</dt>
                  <dd className="text-slate-600">{d}</dd>
                </div>
              ))}
            </dl>
          </details>
        </div>
      )}

      {run?.ok && <IncomeProjection run={run} />}
    </>
  );
}

