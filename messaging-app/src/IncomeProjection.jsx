// IncomeProjection.jsx — the hold, drawn: where each year's NOI goes, and how
// the loan and our equity split the property's value until the sale.
//
// Shown under the income analyzer for multi-family and commercial only. The
// numbers come from projection() in shared/income-underwrite.js; this file
// only draws them. Hand-rolled SVG like the Dashboard charts — no chart
// library.

import React, { useState } from "react";
import { fmtMoney } from "@shared/offer-calc.js";
import { projection } from "@shared/income-underwrite.js";

const money = (v) => (Number.isFinite(v) ? `${v < 0 ? "−" : ""}${fmtMoney(Math.abs(Math.round(v)))}` : "—");
const pct = (v, d = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : "—");
const short = (v) => {
  const a = Math.abs(v), s = v < 0 ? "−" : "";
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${s}$${Math.round(a / 1e3)}K`;
  return `${s}$${Math.round(a)}`;
};

// Orange is the bank's, blue is ours, aqua is cash in hand — the same in both
// charts. Validated as a set on white (dataviz palette slots 1–3); aqua is
// under 3:1, so the numbers table below carries every value too.
const BANK = "#eb6834";
const OURS = "#2a78d6";
const CASH = "#1baf7a";

/* ---------- the stacked-column chart both views share ---------- */

const W = 520, H = 220, M = { top: 18, right: 8, bottom: 22, left: 48 };

function niceStep(span) {
  const raw = span / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

/** A column segment with optional 4px rounded corners on its free end. */
function segPath(x, y, w, h, roundTop, roundBottom) {
  const r = Math.min(4, w / 2, h);
  const rt = roundTop ? r : 0, rb = roundBottom ? r : 0;
  return `M${x},${y + rt}a${rt},${rt} 0 0 1 ${rt},${-rt}h${w - 2 * rt}a${rt},${rt} 0 0 1 ${rt},${rt}`
    + `v${h - rt - rb}a${rb},${rb} 0 0 1 ${-rb},${rb}h${-(w - 2 * rb)}a${rb},${rb} 0 0 1 ${-rb},${-rb}z`;
}

/**
 * StackedColumns — one column per row, `series` stacked from zero in order.
 * Positive values stack up; a negative value (a year the NOI doesn't cover
 * the mortgage) hangs below the baseline. `endLabel` is the one direct label,
 * over the last column.
 */
function StackedColumns({ title, sub, rows, series, xLabel, endLabel, ariaLabel }) {
  const [hover, setHover] = useState(null);
  const top = Math.max(1, ...rows.map((r) => series.reduce((s, k) => s + Math.max(0, r[k.key]), 0)));
  const bottom = Math.min(0, ...rows.map((r) => series.reduce((s, k) => s + Math.min(0, r[k.key]), 0)));
  const step = niceStep(top - bottom);
  const yMax = Math.ceil(top / step) * step;
  const yMin = Math.floor(bottom / step) * step;
  const iw = W - M.left - M.right, ih = H - M.top - M.bottom;
  const y = (v) => M.top + ((yMax - v) / (yMax - yMin)) * ih;
  const band = iw / rows.length;
  const bw = Math.min(24, band * 0.6);
  const ticks = [];
  for (let v = yMin; v <= yMax + step / 2; v += step) ticks.push(v);
  const h = hover === null ? null : rows[hover];

  return (
    <figure className="min-w-0">
      <figcaption className="mb-1">
        <div className="text-sm font-semibold text-slate-800">{title}</div>
        <div className="text-xs text-slate-500">{sub}</div>
      </figcaption>
      <div className="mb-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />{s.label}
          </span>
        ))}
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={ariaLabel}
          onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? "#94a3b8" : "#e2e8f0"} strokeWidth="1" />
              <text x={M.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize="10" fill="#64748b">{short(t)}</text>
            </g>
          ))}
          {rows.map((r, i) => {
            const cx = M.left + band * i + band / 2;
            const x = cx - bw / 2;
            const pos = series.filter((s) => r[s.key] > 0);
            let base = 0;
            const segs = pos.map((s, j) => {
              const y0 = y(base), y1 = y(base + r[s.key]);
              base += r[s.key];
              const gap = j > 0 ? 2 : 0;
              const hh = y0 - y1 - gap;
              return hh > 0.5 ? <path key={s.key} d={segPath(x, y1, bw, hh, j === pos.length - 1, false)} fill={s.color} /> : null;
            });
            const negs = series.filter((s) => r[s.key] < 0).map((s) => {
              const hh = y(r[s.key]) - y(0);
              return hh > 0.5 ? <path key={s.key} d={segPath(x, y(0), bw, hh, false, true)} fill={s.color} /> : null;
            });
            return (
              <g key={r.year} opacity={hover === null || hover === i ? 1 : 0.45}>
                {segs}{negs}
                <text x={cx} y={H - 6} textAnchor="middle" fontSize="10" fill="#64748b">{xLabel(r)}</text>
                <rect x={M.left + band * i} y={M.top} width={band} height={ih} fill="transparent"
                  tabIndex={0} aria-label={`${xLabel(r)}: ${series.map((s) => `${s.label} ${money(r[s.tip || s.key])}`).join(", ")}`}
                  onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />
              </g>
            );
          })}
          {endLabel && (
            <text x={M.left + band * (rows.length - 0.5)} y={y(top) - 6} textAnchor="end" fontSize="10" fontWeight="600" fill="#334155">
              {endLabel}
            </text>
          )}
        </svg>
        {h && (
          <div className="pointer-events-none absolute top-0 z-10 w-max min-w-[9rem] rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-md"
            style={{ left: `${((M.left + band * hover + band / 2) / W) * 100}%`, transform: `translateX(${hover > rows.length / 2 ? "-105%" : "5%"})` }}>
            <div className="mb-1 font-semibold text-slate-700">{xLabel(h)}</div>
            {series.map((s) => (
              <div key={s.key} className="flex items-center gap-2">
                <span className="inline-block h-0.5 w-3" style={{ background: s.color }} />
                <span className="font-semibold tabular-nums text-slate-900">{money(h[s.tip || s.key])}</span>
                <span className="text-slate-500">{s.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </figure>
  );
}

/* ---------- the card ---------- */

function Tile({ label, value, note }) {
  return (
    <div className="min-w-0 rounded-lg bg-slate-50 px-3 py-2">
      <div className="truncate text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-lg font-bold tabular-nums text-slate-900">{value}</div>
      {note && <div className="text-[11px] text-slate-500">{note}</div>}
    </div>
  );
}

/**
 * IncomeProjection — `run` is underwriteIncome(); charts the max offer by
 * default, or the asking price, so Matt can see why asking doesn't work.
 */
export default function IncomeProjection({ run }) {
  const atMax = run?.result?.at || null;
  const [view, setView] = useState("max");
  const which = view === "max" && atMax ? "max" : "asking";
  const a = which === "max" ? atMax : run?.asking;
  if (!run?.ok || !a) return null;

  const rows = projection(run.deal, a);
  const years = rows.slice(1);
  const hold = years.length;
  const cashFlow = years.reduce((s, r) => s + r.cashFlow, 0);
  const paid = years.find((r) => r.cumCash - (r.year === hold ? a.netSale : 0) >= 0);
  const payback = a.equity <= 0
    ? "The loan covers the whole purchase, so there's no cash in to pay back."
    : paid ? `The yearly cash flow alone pays back your cash in by year ${paid.year}.`
      : `The yearly cash flow alone doesn't pay back your cash in. The sale does the rest.`;
  const bars = years.map((r) => ({ ...r, cash: r.cashFlow }));
  const stack = rows.map((r) => ({ ...r, loan: r.balance, ours: Math.max(0, r.equity) }));
  const lastEquity = rows[hold].equity;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold">The hold, year by year</h2>
        <div className="inline-flex rounded-lg border border-slate-300 p-0.5 text-xs font-semibold" role="group" aria-label="Price to chart">
          {[["max", `At our max offer${atMax ? ` (${short(atMax.price)})` : ""}`], ["asking", `At asking (${short(run.asking.price)})`]].map(([k, label]) => (
            <button key={k} type="button" disabled={k === "max" && !atMax} aria-pressed={which === k} onClick={() => setView(k)}
              className={`rounded-md px-2.5 py-1 ${which === k ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-50 disabled:text-slate-300"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Cash in at close" value={money(a.equity)} note={`${money(a.loan)} loan`} />
        <Tile label={`Cash flow, ${hold} yr${hold === 1 ? "" : "s"}`} value={money(cashFlow)} />
        <Tile label="Net from the sale" value={money(a.netSale)} note={`sold at ${money(a.salePrice)}`} />
        <Tile label="IRR · multiple" value={pct(a.metrics.irr)} note={Number.isFinite(a.metrics.equityMultiple) ? `${a.metrics.equityMultiple.toFixed(2)}× your cash` : ""} />
      </div>
      <p className="mt-2 text-xs text-slate-600">{payback}</p>

      <div className="mt-4 grid gap-6 lg:grid-cols-2">
        <StackedColumns
          title="Where each year's NOI goes"
          sub={`The full column is the NOI: interest to the bank, principal paid down (yours at the sale), and cash to you.${years.some((r) => r.cashFlow < 0) ? " Cash below zero is a year the NOI doesn't cover the mortgage." : ""}`}
          rows={bars}
          series={[
            { key: "interest", label: "Interest", color: BANK },
            { key: "principal", label: "Principal paid down", color: OURS },
            { key: "cash", label: "Cash to you", color: CASH },
          ]}
          xLabel={(r) => `Yr ${r.year}`}
          endLabel={`+ ${short(a.netSale)} at the sale`}
          ariaLabel={`NOI split into interest, principal and cash flow for each of ${hold} years`}
        />
        <StackedColumns
          title="Value, loan and your equity"
          sub="The full column is the property's value at the exit cap; the loan is the bank's share, the rest is yours."
          rows={stack}
          series={[
            { key: "loan", label: "Loan balance", color: BANK },
            { key: "ours", label: "Your equity", color: OURS, tip: "equity" },
          ]}
          xLabel={(r) => (r.year === 0 ? "Buy" : `Yr ${r.year}`)}
          endLabel={`${short(lastEquity)} equity at the sale`}
          ariaLabel={`Property value split into loan balance and equity from purchase to year ${hold}`}
        />
      </div>

      <p className="mt-3 text-[11px] text-slate-500">
        Year values are the next year's NOI ÷ the {pct(a.exitCap, 2)} exit cap, the same rule the sale uses. Buy is the price paid; the rehab and closing costs are in your cash in, not the value.
      </p>

      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-xs font-semibold text-slate-600">Show the numbers</summary>
        <div className="-mx-4 mt-2 overflow-x-auto px-4">
          <table className="w-full text-xs tabular-nums" style={{ minWidth: `${10 + rows.length * 5}rem` }}>
            <thead>
              <tr className="border-b border-slate-200 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <th className="pb-1.5 text-left" />
                {rows.map((r) => <th key={r.year} className="pb-1.5 pl-3 text-right">{r.year === 0 ? "Buy" : `Yr ${r.year}`}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {[
                ["NOI", "noi"], ["Interest", "interest"], ["Principal", "principal"], ["Cash to you", "cashFlow"],
                ["Loan balance", "balance"], ["Value", "value"], ["Your equity", "equity"], ["Running cash, sale incl.", "cumCash"],
              ].map(([label, k]) => (
                <tr key={k}>
                  <td className="py-1 text-slate-600">{label}</td>
                  {rows.map((r) => <td key={r.year} className={`py-1 pl-3 text-right ${r[k] < 0 ? "text-red-700" : ""}`}>{r.year === 0 && ["noi", "interest", "principal", "cashFlow"].includes(k) ? "" : money(r[k])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
