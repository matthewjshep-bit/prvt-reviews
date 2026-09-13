// DispoCharts.jsx — when and at what price the (filtered) book has been buying.
//
// Single-series bars only, so one hue (the dashboard's validated blue) and no
// legend: each card's title names its series. Values live in ink, not in the
// bar color; hovering a bar shows its number. Thin bars, 2px gaps, 4px rounded
// data-ends on the baseline, recessive axis.

import React, { useState } from "react";
import { REGIONS, STRATEGIES } from "@shared/dispo-regions.js";

const BAR = "#2a78d6";
const BAR_HOVER = "#1d5fb0";

function Card({ title, sub, children }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold text-slate-700">{title}</h3>
        {sub && <span className="text-[11px] text-slate-500">{sub}</span>}
      </div>
      {children}
    </div>
  );
}

// Vertical bars over time. Hover a column (the whole column is the hit
// target, not just the bar) to read its month and count.
function MonthBars({ data = [] }) {
  const [hover, setHover] = useState(-1);
  const max = Math.max(1, ...data.map((d) => d.count));
  const label = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
  const h = hover >= 0 ? data[hover] : null;
  return (
    <div>
      <div className="h-4 text-[11px] text-slate-700">{h ? <><b className="tabular-nums">{h.count}</b> financed in {label(h.month)}</> : null}</div>
      <div className="flex h-28 items-end gap-[2px] border-b border-slate-200" onMouseLeave={() => setHover(-1)}>
        {data.map((d, i) => (
          <div key={d.month} className="flex h-full flex-1 cursor-default items-end" onMouseEnter={() => setHover(i)}
            role="img" aria-label={`${label(d.month)}: ${d.count}`}>
            <div className="w-full rounded-t-[4px]"
              style={{ height: `${d.count ? Math.max(3, (d.count / max) * 100) : 0}%`, background: i === hover ? BAR_HOVER : BAR }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-500">
        <span>{data[0] ? label(data[0].month) : ""}</span>
        <span>{data.length ? label(data[data.length - 1].month) : ""}</span>
      </div>
    </div>
  );
}

// Horizontal bars for categories, sorted as given. Count sits in ink at the
// end of each row, so the chart doubles as its own table.
function HBars({ rows = [], onPick, picked = "" }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => {
        const on = picked && picked === r.key;
        const Row = onPick ? "button" : "div";
        return (
          <li key={r.key || r.label}>
            <Row type={onPick ? "button" : undefined} onClick={onPick ? () => onPick(on ? "" : r.key) : undefined}
              className={`grid w-full grid-cols-[7rem_1fr_2.5rem] items-center gap-2 rounded text-left text-xs ${onPick ? "hover:bg-slate-50" : ""}`}
              title={`${r.label}: ${r.count}`}>
              <span className={`truncate ${on ? "font-semibold text-slate-900" : "text-slate-600"}`}>{r.label}</span>
              <span className="h-2.5 rounded-r-[4px]" style={{ width: `${r.count ? Math.max(2, (r.count / max) * 100) : 0}%`, background: on ? BAR_HOVER : BAR }} />
              <span className="text-right tabular-nums text-slate-700">{r.count}</span>
            </Row>
          </li>
        );
      })}
    </ul>
  );
}

export default function DispoCharts({ insights, region = "", onPickRegion }) {
  if (!insights) return null;
  const regions = Object.entries(insights.byRegion || {})
    .map(([k, count]) => ({ key: k, label: REGIONS[k]?.label || k, count }))
    .sort((a, b) => b.count - a.count);
  const types = Object.entries(insights.byType || {})
    .map(([k, count]) => ({ key: k, label: STRATEGIES[k] || k, count }))
    .sort((a, b) => b.count - a.count);
  const last12 = (insights.byMonth || []).slice(-12).reduce((s, d) => s + d.count, 0);
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card title="Properties financed per month" sub={`${last12} in the last 12 months`}>
        <MonthBars data={insights.byMonth} />
      </Card>
      <Card title="Loan size" sub={`${insights.purchases} properties`}>
        <HBars rows={(insights.byPrice || []).map((p) => ({ key: p.label, ...p }))} />
      </Card>
      <Card title="By region" sub="click to filter">
        <HBars rows={regions} onPick={onPickRegion} picked={region} />
      </Card>
      <Card title="What they bought for" sub="per property">
        <HBars rows={types} />
      </Card>
    </div>
  );
}
