// FollowUpView.jsx — the follow-up engine. The Follow-up tab of /reports.
//
// Every text the app sends on its own, by the mechanism that sends it: what
// went in the period, what is written and queued, and what each sweep's own
// planner says comes next (shared/follow-up-engine.js). Matt's sketch: agent
// outreach, agent follow-up, offer follow-up (sent and passed), and buyers,
// over today, this week, this month or the year. It reads only.

import React, { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { getDashboardFollowUp, getDashboardFollowUpItems, offerEditorUrl, ghlContactUrl } from "./api.js";
import { BTN, Card, ErrorBar, FilterChips, KpiRow } from "./ui.jsx";
import { whenText } from "./NextFollowUp.jsx";

const TZ = "America/Los_Angeles";
const n = (v) => (v == null ? "—" : Number(v).toLocaleString("en-US"));
const pctOf = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);

export const PERIODS = [
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
  { key: "ytd", label: "Year to date" },
];

// One hue per block, in the sketch's order (validated: dataviz
// validate_palette, light surface). Identity is never colour alone: the
// legend names each, and every number is in the tables below.
export const GROUP_COLORS = {
  outreach: "#2a78d6",
  agent: "#eb6834",
  offer_live: "#1baf7a",
  offer_passed: "#eda100",
  buyer: "#6250d6",
};
const INK_MUTED = "#898781";
const GRID = "#e1e0d9";
const BASELINE = "#c3c2b7";
const NOW_LINE = "#334155";

const STATUS_TONE = {
  on: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  drafts: "bg-amber-50 text-amber-800 ring-amber-200",
  off: "bg-slate-100 text-slate-500 ring-slate-200",
  ghl: "bg-sky-50 text-sky-700 ring-sky-200",
};
const STATE_LABEL = { sent: "Sent", queued: "Queued", planned: "Planned", held: "Waiting on you" };
const STATE_TONE = {
  sent: "bg-slate-100 text-slate-600",
  queued: "bg-sky-50 text-sky-700",
  planned: "bg-white text-slate-600 ring-1 ring-inset ring-slate-300",
  held: "bg-amber-50 text-amber-800",
};

const dayText = (iso) => new Date(iso).toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric" });
const timeText = (iso) => new Date(iso).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).replace(":00", "").replace(" ", "").toLowerCase();
const agoText = (iso, now) => {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "never";
  const h = (now - t) / 3600000;
  if (h < 1) return "just now";
  if (h < 24) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

/* ---------- the chart ---------- */

function niceMax(max) {
  if (max <= 4) return Math.max(1, max);
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 5, 10]) if (m * pow >= max) return m * pow;
  return max;
}

const cellTotal = (c) => (c ? c.sent + c.queued + c.planned : 0);

/**
 * Stacked bars: one per bucket, a segment per block. A past bucket is what
 * went (solid); a future one is queued (lighter) then planned (outlined).
 */
export function FollowUpChart({ buckets = [], groups = [], selected = "", onBucket = null }) {
  const [hover, setHover] = useState(null);
  const W = 680, H = 170;
  const M = { top: 8, right: 6, bottom: 20, left: 34 };
  const plotW = W - M.left - M.right, plotH = H - M.top - M.bottom;
  const count = buckets.length || 1;
  const band = plotW / count;
  const keys = groups.map((g) => g.key);
  const totals = buckets.map((b) => keys.reduce((s, k) => s + cellTotal(b.byGroup?.[k]), 0));
  const top = niceMax(Math.max(...totals, 1));
  const yOf = (v) => plotH * (v / top);
  const thick = Math.min(22, band * 0.66);
  const labelEvery = Math.max(1, Math.ceil(count / 10));
  const marks = [];
  buckets.forEach((b, i) => {
    const x = M.left + i * band + (band - thick) / 2;
    let cum = 0;
    const segs = [];
    for (const k of keys) {
      const c = b.byGroup?.[k];
      if (!c) continue;
      for (const state of ["sent", "queued", "planned"]) if (c[state] > 0) segs.push({ k, state, v: c[state] });
    }
    segs.forEach((s, j) => {
      const yBottom = M.top + plotH - yOf(cum);
      const yTop = M.top + plotH - yOf(cum + s.v);
      const h = Math.max(0.5, yBottom - yTop - (j > 0 ? 2 : 0));
      const color = GROUP_COLORS[s.k] || INK_MUTED;
      const props = s.state === "planned"
        ? { fill: "#ffffff", stroke: color, strokeWidth: 1.5, strokeDasharray: "3 2" }
        : { fill: color, fillOpacity: s.state === "queued" ? 0.5 : 1 };
      marks.push(<rect key={`${i}-${s.k}-${s.state}`} x={s.state === "planned" ? x + 0.75 : x} y={yTop} width={s.state === "planned" ? thick - 1.5 : thick} height={h} rx={j === segs.length - 1 ? 3 : 0} {...props} />);
      cum += s.v;
    });
  });
  const nowIdx = buckets.findIndex((b) => b.current);
  const hb = hover != null ? buckets[hover] : null;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Follow-up texts per period, sent and coming">
        {[0, 0.5, 1].map((f) => {
          const y = M.top + plotH - plotH * f;
          return (
            <g key={f}>
              <line x1={M.left} x2={W - M.right} y1={y} y2={y} stroke={f === 0 ? BASELINE : GRID} strokeWidth="1" />
              <text x={M.left - 5} y={y + 3} textAnchor="end" fontSize="9" fill={INK_MUTED}>{Math.round(top * f).toLocaleString("en-US")}</text>
            </g>
          );
        })}
        {buckets.map((b, i) => (selected === b.key ? (
          <rect key={`sel-${b.key}`} x={M.left + i * band} y={M.top} width={band} height={plotH} fill="#e2e8f0" opacity="0.6" />
        ) : null))}
        {marks}
        {nowIdx >= 0 && (
          <g>
            <line x1={M.left + (nowIdx + 0.5) * band} x2={M.left + (nowIdx + 0.5) * band} y1={M.top} y2={M.top + plotH} stroke={NOW_LINE} strokeWidth="1" strokeDasharray="2 3" />
            <text x={M.left + (nowIdx + 0.5) * band + 3} y={M.top + 8} fontSize="9" fill={NOW_LINE}>now</text>
          </g>
        )}
        {buckets.map((b, i) => (i % labelEvery === 0 ? (
          <text key={`l-${b.key}`} x={M.left + (i + 0.5) * band} y={H - 6} textAnchor="middle" fontSize="9" fill={INK_MUTED}>{b.label}</text>
        ) : null))}
        {buckets.map((b, i) => (
          <rect key={`hit-${b.key}`} x={M.left + i * band} y={M.top} width={band} height={plotH} fill="transparent"
            style={{ cursor: onBucket && totals[i] ? "pointer" : "default" }}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
            onClick={() => (onBucket && totals[i] ? onBucket(b.key) : null)} />
        ))}
      </svg>
      {hb && (
        <div className="pointer-events-none absolute top-0 z-10 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[11px] shadow-sm"
          style={{ left: `${Math.min(75, Math.max(0, ((hover + 0.5) / count) * 100 - 10))}%` }}>
          <div className="mb-1 font-semibold text-slate-700">{hb.label}{hb.current ? " · now" : ""}</div>
          {groups.map((g) => {
            const c = hb.byGroup?.[g.key];
            if (!cellTotal(c)) return null;
            const parts = [c.sent && `${c.sent} sent`, c.queued && `${c.queued} queued`, c.planned && `${c.planned} planned`].filter(Boolean).join(" · ");
            return (
              <div key={g.key} className="flex items-center gap-1.5 text-slate-600">
                <span className="inline-block h-2 w-2 rounded-sm" style={{ background: GROUP_COLORS[g.key] }} />
                <span>{g.label}</span><span className="tabular-nums text-slate-500">{parts}</span>
              </div>
            );
          })}
          {!totals[hover] && <div className="text-slate-400">Nothing</div>}
        </div>
      )}
    </div>
  );
}

function Legend({ groups = [] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-600">
      {groups.map((g) => (
        <span key={g.key} className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: GROUP_COLORS[g.key] }} />{g.label}
        </span>
      ))}
      <span className="ml-auto inline-flex items-center gap-3 text-slate-500">
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-slate-500" />Sent</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-slate-500 opacity-50" />Queued</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm border border-dashed border-slate-500 bg-white" />Planned</span>
      </span>
    </div>
  );
}

/* ---------- the rows behind a click ---------- */

export function ItemList({ items = [], total = 0, labels = {}, now = Date.now(), loading = false, title = "", onClose = null }) {
  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50/60 p-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
        <span className="font-semibold text-slate-700">{title}{total ? ` · ${n(total)}` : ""}{total > items.length ? ` (first ${items.length})` : ""}</span>
        {onClose && <button type="button" className="text-slate-400 hover:text-slate-700" onClick={onClose}>Close</button>}
      </div>
      {loading ? <div className="text-xs text-slate-400">Reading…</div> : !items.length ? <div className="text-xs text-slate-400">Nothing here.</div> : (
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full text-xs">
            <tbody>
              {items.map((x, i) => (
                <tr key={`${x.mech}-${x.contactId || ""}-${x.offerId || ""}-${x.at}-${i}`} className="border-t border-slate-100 align-top">
                  <td className="whitespace-nowrap py-1 pr-2 tabular-nums text-slate-500">
                    {x.state === "sent" ? `${dayText(x.at)} ${timeText(x.at)}` : x.state === "held" ? `since ${dayText(x.at)}` : whenText(x.at, now, { withTime: x.state === "queued" })}
                  </td>
                  <td className="py-1 pr-2"><span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATE_TONE[x.state] || ""}`}>{STATE_LABEL[x.state] || x.state}</span></td>
                  <td className="py-1 pr-2 text-slate-700">{labels[x.mech] || x.mech}</td>
                  <td className="py-1 pr-2">
                    {x.contactId
                      ? <a className="font-medium text-slate-800 hover:text-blue-700" href={ghlContactUrl(x.contactId)} target="_blank" rel="noreferrer">{x.name || "Contact"}</a>
                      : <span className="text-slate-500">{x.count > 1 ? `${n(x.count)} people` : "—"}</span>}
                  </td>
                  <td className="py-1 pr-2">
                    {x.offerId
                      ? <a className="text-slate-600 hover:text-blue-700" href={offerEditorUrl(x.offerId)} target="_blank" rel="noreferrer">{String(x.address || "").split(",")[0] || "Offer"}</a>
                      : <span className="text-slate-500">{String(x.address || "").split(",")[0]}</span>}
                  </td>
                  <td className="py-1 pr-2 text-slate-500">
                    {x.state === "sent" ? (x.replied ? <span className="font-semibold text-emerald-700">replied</span> : "") : x.who === "you" ? "for you" : "goes itself"}
                    {x.overdue ? <span className="text-amber-700"> · due now</span> : null}
                  </td>
                  <td className="py-1 text-slate-400">{x.note || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ---------- one block of the sketch ---------- */

function StatusPill({ m, now }) {
  const title = [m.statusWhy, m.lastRun ? `Last ran ${agoText(m.lastRun, now)}` : ""].filter(Boolean).join(" · ");
  return <span title={title} className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${STATUS_TONE[m.status] || STATUS_TONE.off}`}>{m.statusLabel}</span>;
}

function aheadCell(m) {
  const k = m.queued + m.planned;
  if (m.ahead === "event" && !k) return <span className="text-slate-400" title={`Fires ${m.fires}`}>—</span>;
  if (!k) return <span className="text-slate-400">0</span>;
  return (
    <span title={`${m.queued} queued · ${m.planned} planned`}>
      <b>{n(k)}</b>
      {m.queued ? <span className="text-[10px] text-slate-400"> {m.planned ? `(${n(m.queued)} queued)` : "queued"}</span> : null}
    </span>
  );
}

export function GroupCard({ group, now = Date.now(), open = "", onMechanism = null, children = null }) {
  const t = group.totals;
  return (
    <Card
      title={<span className="inline-flex items-center gap-2"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: GROUP_COLORS[group.key] }} />{group.label}</span>}
      right={<span className="text-[11px] text-slate-500">{group.hint}{group.key !== "outreach" ? ` · ${n(t.sent)} sent · ${n(t.queued + t.planned)} coming` : ""}</span>}
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] table-fixed text-sm">
          {/* One set of widths for every block, so the columns line up down the page. */}
          <colgroup><col className="w-[44%]" /><col className="w-[17%]" /><col className="w-[7%]" /><col className="w-[9%]" /><col className="w-[10%]" /><col className="w-[13%]" /></colgroup>
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
              <th className="py-1 pr-3 font-semibold">What it is</th>
              <th className="py-1 pr-3 font-semibold">Status</th>
              <th className="py-1 pr-3 text-right font-semibold">Sent</th>
              <th className="py-1 pr-3 text-right font-semibold" title="They wrote or called back within 72 hours, before our next text">Replied</th>
              <th className="py-1 pr-3 text-right font-semibold" title="Queued (written, with a send time) plus planned (each thread's next touch)">Next touches</th>
              <th className="py-1 font-semibold">Next send</th>
            </tr>
          </thead>
          <tbody>
            {group.mechanisms.map((m) => {
              const quiet = m.status === "off" && !m.sent && !m.queued && !m.planned && !m.held;
              return (
                <tr key={m.key} onClick={onMechanism ? () => onMechanism(m.key) : undefined}
                  className={`border-t border-slate-100 align-top ${onMechanism ? "cursor-pointer hover:bg-slate-50" : ""} ${open === m.key ? "bg-slate-50" : ""} ${quiet ? "opacity-60" : ""}`}>
                  <td className="py-1.5 pr-3 break-words">
                    <div className="font-medium text-slate-800">{m.label}{!m.followUp ? <span className="ml-1 text-[10px] font-normal text-slate-400">first touch</span> : null}</div>
                    <div className="max-w-xl text-[11px] leading-snug text-slate-500">{m.what}</div>
                    {m.countedFrom ? <div className="text-[10px] text-slate-400">counted from {dayText(m.countedFrom)} (the outbox keeps 180 days)</div> : null}
                  </td>
                  <td className="py-1.5 pr-3">
                    <StatusPill m={m} now={now} />
                    {m.statusWhy ? <div className="mt-0.5 max-w-[11rem] text-[10px] leading-snug text-slate-400">{m.statusWhy}</div> : null}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{n(m.sent)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{m.sent ? <>{n(m.replied)} <span className="text-[10px] text-slate-400">{pctOf(m.replied, m.sent)}%</span></> : <span className="text-slate-400">—</span>}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{aheadCell(m)}{m.held ? <div className="text-[10px] text-amber-700">{n(m.held)} waiting on you</div> : null}</td>
                  <td className="py-1.5 text-xs text-slate-600">
                    {m.next ? <>{whenText(m.next.at, now, { withTime: m.next.state === "queued" })}<div className="text-[10px] text-slate-400">{m.next.count > 1 ? `${n(m.next.count)} people` : m.next.name || String(m.next.address || "").split(",")[0]}</div></>
                      : m.ahead === "event" ? <span className="text-[11px] text-slate-400">fires {m.fires}</span> : <span className="text-slate-400">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {children}
    </Card>
  );
}

function NothingScheduled({ data }) {
  if (!data?.count) return null;
  return (
    <Card title={`Live offers with nothing scheduled · ${n(data.count)}`} right={<span className="text-[11px] text-slate-500">the Line counts these as leaks</span>}>
      <ul className="space-y-1 text-xs">
        {(data.rows || []).slice(0, 25).map((r) => (
          <li key={r.offerId} className="flex flex-wrap gap-x-2">
            <a className="font-medium text-slate-800 hover:text-blue-700" href={offerEditorUrl(r.offerId)} target="_blank" rel="noreferrer">{String(r.address || "").split(",")[0] || "An offer"}</a>
            {r.name ? <span className="text-slate-500">{r.name}</span> : null}
            <span className="text-slate-400">{String(r.status || "").replace(/_/g, " ")} · {r.reason || r.label}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ---------- the page body (no fetch: the test renders it) ---------- */

/**
 *   data       GET /api/dashboard/followup
 *   pick       { kind: "bucket" | "mechanism", key, items, total, loading } — the open drill-down
 *   onBucket / onMechanism   (key) → open its rows
 */
export function FollowUpBody({ data, now = Date.now(), pick = null, onBucket = null, onMechanism = null, onClose = null }) {
  if (!data) return null;
  const k = data.kpis || {};
  const labels = Object.fromEntries((data.groups || []).flatMap((g) => g.mechanisms.map((m) => [m.key, m.label])));
  const bucketLabel = pick?.kind === "bucket" ? (data.buckets || []).find((b) => b.key === pick.key)?.label : "";
  const list = (title) => <ItemList items={pick.items || []} total={pick.total || 0} labels={labels} now={now} loading={pick.loading} title={title} onClose={onClose} />;
  return (
    <>
      {data.truncated ? <ErrorBar>More history than one read holds: the counts here are low. Try a shorter period.</ErrorBar> : null}
      <KpiRow cols="sm:grid-cols-3 lg:grid-cols-6" items={[
        { label: "Agents reached out to", value: n(k.reached), hint: "New agents texted for the first time in the period (the app's text or the GHL workflow's), as Flow counts them" },
        { label: "Agents responded", value: k.reached ? `${n(k.responded)} · ${k.respondedPct ?? 0}%` : n(k.responded), hint: "Of those agents, how many wrote or called back" },
        { label: "Follow-ups sent", value: k.sent ? `${n(k.sent)} · ${k.repliedPct ?? 0}% replied` : n(k.sent), hint: "Every follow-up the app sent in the period. Replied: they answered within 72 hours, before our next text" },
        { label: "Scheduled ahead", value: n((k.queued || 0) + (k.planned || 0)), hint: `${n(k.queued)} queued (written, with a send time) · ${n(k.planned)} planned (the next sweep's own plan)` },
        { label: "Waiting on you", value: n(k.waitingOnYou), hint: "Machine follow-ups written and held for you to send or dismiss" },
        { label: "Live offers, nothing scheduled", value: n(k.nothingScheduled), hint: "An open offer whose next follow-up is none — the Line's leak" },
      ]} />

      <Card title="Follow-up over the period" right={<span className="text-[11px] text-slate-500">click a bar for who and what</span>}>
        <Legend groups={data.groups || []} />
        <div className="mt-2"><FollowUpChart buckets={data.buckets || []} groups={data.groups || []} selected={pick?.kind === "bucket" ? pick.key : ""} onBucket={onBucket} /></div>
        <p className="mt-1 text-[11px] leading-snug text-slate-500">
          Queued: written, with a send time. Planned: what the next sweep would start, by the same rules it uses. That's a plan, not a guarantee, and it counts each thread's next touch only.
          {data.floors?.draftsFrom ? ` Most follow-up kinds are counted from ${dayText(data.floors.draftsFrom)}: the outbox keeps sent texts 180 days. Check-ins, first texts, deal blasts and second looks are counted from their send records, which are kept.` : ""}
        </p>
        {pick?.kind === "bucket" && list(bucketLabel || "")}
      </Card>

      {(data.groups || []).map((g) => (
        <GroupCard key={g.key} group={g} now={now} open={pick?.kind === "mechanism" ? pick.key : ""} onMechanism={onMechanism}>
          {pick?.kind === "mechanism" && g.mechanisms.some((m) => m.key === pick.key) ? list(labels[pick.key]) : null}
        </GroupCard>
      ))}

      <NothingScheduled data={data.nothingScheduled} />
      {data.tierCardsRead === false ? <p className="text-[11px] text-slate-400">GHL's Tier 2/3 cards couldn't be read just now: agents only on a card are missing from the check-in plan.</p> : null}
    </>
  );
}

// ?period= opens a period by link (today | week | month | ytd).
function periodFromUrl() {
  try {
    const p = new URLSearchParams(window.location.search).get("period");
    return PERIODS.some((x) => x.key === p) ? p : "week";
  } catch { return "week"; }
}

export default function FollowUpView() {
  const [period, setPeriod] = useState(periodFromUrl);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [pick, setPick] = useState(null);
  const load = (fresh = false, p = period) => {
    setLoading(true);
    setError("");
    getDashboardFollowUp({ period: p, fresh })
      .then((d) => { setData(d); setPick(null); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(false, period); }, [period]);
  const open = (kind, key) => {
    if (pick?.kind === kind && pick.key === key) return setPick(null);
    setPick({ kind, key, loading: true, items: [], total: 0 });
    getDashboardFollowUpItems({ period, ...(kind === "bucket" ? { bucket: key } : { mechanism: key }) })
      .then((r) => setPick({ kind, key, loading: false, items: r.items || [], total: r.total || 0 }))
      .catch((e) => { setPick(null); setError(e.message); });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterChips value={period} onChange={setPeriod} options={PERIODS} label="Period" />
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500">{data ? `As of ${new Date(data.now).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : loading ? "Reading the follow-up…" : ""}</span>
          <button type="button" className={BTN} disabled={loading} onClick={() => load(true)}>
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
      </div>
      {error && <ErrorBar>{error}</ErrorBar>}
      <FollowUpBody data={data} pick={pick} onBucket={(key) => open("bucket", key)} onMechanism={(key) => open("mechanism", key)} onClose={() => setPick(null)} />
    </div>
  );
}
