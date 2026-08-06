// Dashboard.jsx — the standalone analytics page (/dashboard). Three data
// sources loaded independently so one failure never blanks the page:
//   • /api/dashboard/summary      local: offers, app sends, outreach funnel
//   • /api/dashboard/ghl/tags     live GHL contact counts per tag
//   • /api/dashboard/ghl/messages GHL calls/texts/emails (bounded scan, cached;
//     long scans answer { pending } and the page polls until the result lands)
// The GHL panels degrade to an amber scope banner when the location's token
// lacks contacts.readonly / conversations.readonly.
//
// Charts are hand-rolled SVG. Color assignments are per-entity and validated
// (dataviz palette): texts #2a78d6, email #eb6834, calls #4a3aa7, funnel
// green #008300 / violet #4a3aa7. Text never wears series color; identity
// comes from legend swatches and tooltip line-keys.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Pencil, X } from "lucide-react";
import { fmtMoney } from "@shared/offer-calc.js";
import {
  getDashboardSummary, getDashboardTagCounts, getDashboardMessages, getDashboardContacts, saveSettings,
} from "./api.js";

/* ---------- palette (validated, light surface) ---------- */
const C_TEXTS = "#2a78d6";  // blue
const C_EMAIL = "#eb6834";  // orange
const C_CALLS = "#4a3aa7";  // violet
const C_NEW = "#4a3aa7";    // violet — new agents found
const C_IMPORTED = "#008300"; // green — imported to GHL
const C_OFFERS = "#2a78d6";
const C_CONTACTS = "#008300"; // green — a contact added to GHL (same meaning as funnel imports)
const INK_MUTED = "#898781";
const GRID = "#e1e0d9";
const BASELINE = "#c3c2b7";

const compact = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${v}`;
};
const shortDay = (iso) => {
  const [, m, d] = iso.split("-");
  return `${Number(m)}/${Number(d)}`;
};

// Clean y-axis top: 1-2-5 progression covering max.
function niceMax(max) {
  if (max <= 4) return Math.max(1, max);
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 5, 10]) if (m * pow >= max) return m * pow;
  return max;
}

/* ---------- chart primitives ---------- */

// Stacked or grouped daily bars. data: [{ date, values: [n, ...] }] (dense).
// series: [{ label, color }]. One tooltip lists every series at the hovered X.
function DailyBars({ data, series, mode = "stack", height = 150, valueFmt = (v) => String(v) }) {
  const [hover, setHover] = useState(null); // band index
  const W = 640, H = height;
  const M = { top: 8, right: 6, bottom: 18, left: 34 };
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const n = data.length || 1;
  const band = plotW / n;

  const totals = data.map((d) =>
    mode === "stack" ? d.values.reduce((s, v) => s + v, 0) : Math.max(...d.values, 0));
  const top = niceMax(Math.max(...totals, 1));
  const yOf = (v) => plotH * (v / top);

  // Rounded cap on the data end only; square at the baseline.
  const roundedTop = (x, y, w, h) => {
    const r = Math.min(4, w / 2, h);
    return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
  };

  const bars = [];
  data.forEach((d, i) => {
    const x0 = M.left + i * band;
    if (mode === "stack") {
      const thickness = Math.min(24, band * 0.66);
      const x = x0 + (band - thickness) / 2;
      // Draw bottom-up with 2px surface gaps between segments; only the
      // stack's top segment gets the rounded data-end.
      let cum = 0;
      const segs = d.values.map((v, si) => ({ v, si })).filter((s) => s.v > 0);
      segs.forEach((s, k) => {
        const yBottom = M.top + plotH - yOf(cum);
        const yTop = M.top + plotH - yOf(cum + s.v);
        const gap = k > 0 ? 2 : 0;
        const h = Math.max(0.5, yBottom - yTop - gap);
        const isTopSeg = k === segs.length - 1;
        bars.push(
          isTopSeg ? (
            <path key={`${i}-${s.si}`} d={roundedTop(x, yTop, thickness, h)} fill={series[s.si].color} />
          ) : (
            <rect key={`${i}-${s.si}`} x={x} y={yTop} width={thickness} height={h} fill={series[s.si].color} />
          )
        );
        cum += s.v;
      });
    } else {
      const k = series.length;
      const thickness = Math.min(24, (band * 0.72) / k);
      const groupW = thickness * k + 2 * (k - 1);
      const gx = x0 + (band - groupW) / 2;
      d.values.forEach((v, si) => {
        if (v <= 0) return;
        const h = Math.max(0.5, yOf(v));
        const x = gx + si * (thickness + 2);
        bars.push(
          <path key={`${i}-${si}`} d={roundedTop(x, M.top + plotH - h, thickness, h)} fill={series[si].color} />
        );
      });
    }
  });

  const labelEvery = Math.max(1, Math.ceil(n / 8));
  const hoverBand = hover != null && data[hover] ? data[hover] : null;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img">
        {/* gridlines + y ticks */}
        {[0, 0.5, 1].map((f) => {
          const y = M.top + plotH - plotH * f;
          const val = Math.round(top * f);
          return (
            <g key={f}>
              <line x1={M.left} x2={W - M.right} y1={y} y2={y}
                stroke={f === 0 ? BASELINE : GRID} strokeWidth="1" />
              <text x={M.left - 5} y={y + 3} textAnchor="end" fontSize="9" fill={INK_MUTED}>
                {val.toLocaleString("en-US")}
              </text>
            </g>
          );
        })}
        {bars}
        {/* x labels */}
        {data.map((d, i) =>
          i % labelEvery === 0 ? (
            <text key={d.date} x={M.left + (i + 0.5) * band} y={H - 5}
              textAnchor="middle" fontSize="9" fill={INK_MUTED}>
              {shortDay(d.date)}
            </text>
          ) : null
        )}
        {/* hover wash + full-band hit targets (bigger than the marks) */}
        {hover != null && (
          <rect x={M.left + hover * band} y={M.top} width={band} height={plotH}
            fill="#0b0b0b" opacity="0.05" pointerEvents="none" />
        )}
        {data.map((d, i) => (
          <rect key={`hit-${i}`} x={M.left + i * band} y={M.top} width={band} height={plotH}
            fill="transparent"
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
        ))}
      </svg>
      {hoverBand && (
        <div
          className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs shadow-md"
          style={{ left: `${((M.left + (hover + 0.5) * band) / W) * 100}%` }}
        >
          <div className="mb-0.5 font-semibold text-gray-500">{hoverBand.date}</div>
          {series.map((s, si) => (
            <div key={s.label} className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="inline-block h-0.5 w-3 rounded" style={{ background: s.color }} />
              <span className="font-semibold tabular-nums text-gray-900">{valueFmt(hoverBand.values[si])}</span>
              <span className="text-gray-500">{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Legend({ series }) {
  return (
    <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-600">
      {series.map((s) => (
        <span key={s.label} className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

function KpiTile({ label, value, sub }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3.5">
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className="mt-0.5 text-2xl font-semibold text-gray-900">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-gray-500">{sub}</div>}
    </div>
  );
}

// RentCast request meter: fill carries severity, track is a light step of the
// fill's own ramp.
function Meter({ value, max }) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  const fill = value >= 48 ? "#d03b3b" : value >= 40 ? "#fab219" : "#2a78d6";
  const track = value >= 40 ? "#f0efec" : "#cde2fb";
  return (
    <div className="h-2 w-full overflow-hidden rounded-full" style={{ background: track }}>
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: fill }} />
    </div>
  );
}

function Card({ title, children, right }) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <h2 className="text-sm font-bold">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function ScopeBanner({ scope }) {
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
      GoHighLevel data unavailable — the Private Integration token is missing the{" "}
      <code className="rounded bg-amber-100 px-1 font-mono text-xs">{scope}</code> scope.
      Add it in GHL → Settings → Private Integrations, then reload.
    </div>
  );
}

function ErrorNote({ message, onRetry }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-700">
      <span>Couldn't load — {message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="font-semibold underline">Retry</button>
      )}
    </div>
  );
}

const Empty = ({ children }) => (
  <div className="py-6 text-center text-sm text-gray-400">{children}</div>
);

/* ---------- the page ---------- */

const RANGES = [7, 30, 90];

export default function Dashboard({ settings, onSettingsSaved }) {
  const [days, setDays] = useState(30);

  // Local summary (fast).
  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState("");
  const loadSummary = () => {
    setSummaryLoading(true);
    setSummaryError("");
    getDashboardSummary(days)
      .then(setSummary)
      .catch((e) => setSummaryError(e.message))
      .finally(() => setSummaryLoading(false));
  };
  useEffect(loadSummary, [days]); // eslint-disable-line react-hooks/exhaustive-deps

  // GHL tag counts (waits for settings; point-in-time, not range-scoped).
  const tags = settings?.dashboardTags || [];
  const tagsKey = tags.join(",");
  const [tagCounts, setTagCounts] = useState(null);
  const [tagsError, setTagsError] = useState("");
  const [tagsScopeMissing, setTagsScopeMissing] = useState(false);
  const [tagsLoading, setTagsLoading] = useState(false);
  const loadTags = () => {
    if (!settings) return;
    setTagsLoading(true);
    setTagsError("");
    setTagsScopeMissing(false);
    getDashboardTagCounts(tags)
      .then((r) => (r.scopeMissing ? setTagsScopeMissing(true) : setTagCounts(r.counts)))
      .catch((e) => setTagsError(e.message))
      .finally(() => setTagsLoading(false));
  };
  useEffect(loadTags, [Boolean(settings), tagsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The GHL scans can outlive one request — the server answers
  // { pending: true } while a scan is still running, so poll until the real
  // payload lands. The generation counter cancels a poll loop the moment the
  // range changes (or the page unmounts) so a stale response never wins.
  const usePolledScan = (fetcher) => {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [scopeMissing, setScopeMissing] = useState(false);
    const gen = useRef(0);
    const load = () => {
      const g = ++gen.current;
      setLoading(true);
      setError("");
      setScopeMissing(false);
      const tick = () =>
        fetcher(days)
          .then((r) => {
            if (g !== gen.current) return;
            if (r.pending) { setTimeout(tick, 4000); return; }
            if (r.scopeMissing) setScopeMissing(true);
            else setData(r);
            setLoading(false);
          })
          .catch((e) => {
            if (g !== gen.current) return;
            setError(e.message);
            setLoading(false);
          });
      tick();
    };
    useEffect(() => { load(); return () => { gen.current += 1; }; }, [days]); // eslint-disable-line react-hooks/exhaustive-deps
    return { data, loading, error, scopeMissing, load };
  };

  // GHL message/call volume (slow first load; server caches 10 min).
  const {
    data: ghlMsgs, loading: msgsLoading, error: msgsError,
    scopeMissing: msgsScopeMissing, load: loadMsgs,
  } = usePolledScan(getDashboardMessages);

  // GHL contacts created (dateAdded scan; server caches 10 min).
  const {
    data: ghlContacts, loading: contactsLoading, error: contactsError,
    scopeMissing: contactsScopeMissing, load: loadContacts,
  } = usePolledScan(getDashboardContacts);

  // Inline tag-list editor (saves through the shared settings blob).
  const [editingTags, setEditingTags] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [tagSaving, setTagSaving] = useState(false);
  const editRef = useRef(null);
  useEffect(() => { if (editingTags) editRef.current?.focus(); }, [editingTags]);
  async function saveTags() {
    const list = tagDraft.split(",").map((s) => s.trim()).filter(Boolean);
    setTagSaving(true);
    try {
      const r = await saveSettings({ ...settings, dashboardTags: list });
      onSettingsSaved?.(r.settings);
      setEditingTags(false);
    } catch (e) {
      setTagsError(e.message);
    }
    setTagSaving(false);
  }

  const offersSeries = [{ label: "Offers", color: C_OFFERS }];
  const sendsSeries = [
    { label: "Texts", color: C_TEXTS },
    { label: "Emails", color: C_EMAIL },
  ];
  const ghlSeries = [
    { label: "Calls", color: C_CALLS },
    { label: "Texts", color: C_TEXTS },
    { label: "Emails", color: C_EMAIL },
  ];
  const funnelSeries = [
    { label: "New agents", color: C_NEW },
    { label: "Imported to GHL", color: C_IMPORTED },
  ];

  const offersData = useMemo(
    () => (summary?.offers.daily || []).map((d) => ({ date: d.date, values: [d.count] })),
    [summary]);
  const sendsData = useMemo(
    () => (summary?.sends.daily || []).map((d) => ({ date: d.date, values: [d.sms, d.email] })),
    [summary]);
  const funnelData = useMemo(
    () => (summary?.outreach.daily || []).map((d) => ({ date: d.date, values: [d.newAgents, d.imported] })),
    [summary]);
  const ghlData = useMemo(
    () => (ghlMsgs?.daily || []).map((d) => ({ date: d.date, values: [d.calls, d.sms, d.email] })),
    [ghlMsgs]);
  const contactsData = useMemo(
    () => (ghlContacts?.daily || []).map((d) => ({ date: d.date, values: [d.count] })),
    [ghlContacts]);
  const contactsSeries = [{ label: "Contacts created", color: C_CONTACTS }];

  const usage = summary?.outreach.usage;
  const agentsImported = (summary?.outreach.daily || []).reduce((s, d) => s + d.imported, 0);

  // Texts/emails KPIs come from GHL (all outbound activity, incl. workflow
  // sends) when the scan is available; app-send counts are the fallback so
  // the tiles never sit empty when the scope is missing or the scan fails.
  const ghlTotals = useMemo(() => {
    if (!ghlMsgs?.daily) return null;
    return ghlMsgs.daily.reduce(
      (a, d) => ({ calls: a.calls + d.calls, sms: a.sms + d.sms, email: a.email + d.email }),
      { calls: 0, sms: 0, email: 0 });
  }, [ghlMsgs]);
  const ghlKpisReady = Boolean(ghlTotals) && !msgsScopeMissing;
  // A capped scan is a floor, not a total — say so on the tile ("N+").
  const ghlCapped = Boolean(ghlMsgs?.approx?.capped);
  const ghlKpi = (n) => ({
    value: ghlCapped ? `${n.toLocaleString("en-US")}+` : n,
    sub: ghlCapped ? "outbound, via GHL (partial scan)" : "outbound, via GHL",
  });
  const textsKpi = ghlKpisReady
    ? ghlKpi(ghlTotals.sms)
    : msgsScopeMissing || msgsError
    ? { value: summary?.sends.totalSms ?? 0, sub: "from this app" }
    : { value: "…", sub: "scanning GHL…" };
  const emailsKpi = ghlKpisReady
    ? ghlKpi(ghlTotals.email)
    : msgsScopeMissing || msgsError
    ? { value: summary?.sends.totalEmail ?? 0, sub: "from this app" }
    : { value: "…", sub: "scanning GHL…" };

  // Refetch keeps the frame: previous render held at reduced opacity.
  const dim = (loading, has) => (loading && has ? "opacity-60 transition-opacity" : "");

  return (
    <div className="space-y-4">
      {/* filter row — date range scopes everything below */}
      <div className="flex flex-wrap items-center gap-2">
        {RANGES.map((r) => (
          <button key={r} type="button" onClick={() => setDays(r)}
            className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
              days === r ? "bg-gray-900 text-white" : "bg-white text-gray-600 hover:bg-gray-100 border border-gray-200"
            }`}>
            Last {r} days
          </button>
        ))}
        {summaryLoading && <Loader2 size={15} className="animate-spin text-gray-400" />}
      </div>

      {summaryError && <ErrorNote message={summaryError} onRetry={loadSummary} />}

      {/* KPI row */}
      {summary && (
        <div className={`grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6 ${dim(summaryLoading, summary)}`}>
          <KpiTile label="Offers created" value={summary.offers.total} sub={`last ${summary.days} days`} />
          <KpiTile label="Total offered" value={compact(summary.offers.cashTotal)} sub="cash offers" />
          <KpiTile label="Contacts created"
            value={contactsScopeMissing ? "—" : ghlContacts ? ghlContacts.total : "…"}
            sub="added to GHL" />
          <KpiTile label="Texts sent" value={textsKpi.value} sub={textsKpi.sub} />
          <KpiTile label="Emails sent" value={emailsKpi.value} sub={emailsKpi.sub} />
          <div className="rounded-xl border border-gray-200 bg-white p-3.5">
            <div className="text-xs font-medium text-gray-500">RentCast requests</div>
            <div className="mt-0.5 text-2xl font-semibold text-gray-900">
              {usage?.requestsThisMonth ?? 0}
              <span className="text-sm font-normal text-gray-400"> / {usage?.limit ?? 50}</span>
            </div>
            <div className="mt-2"><Meter value={usage?.requestsThisMonth ?? 0} max={usage?.limit ?? 50} /></div>
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Offers per day">
          {summary ? (
            summary.offers.total === 0 ? (
              <Empty>No offers in this window.</Empty>
            ) : (
              <div className={dim(summaryLoading, summary)}>
                <DailyBars data={offersData} series={offersSeries} />
              </div>
            )
          ) : (
            !summaryError && <Empty><Loader2 size={16} className="mx-auto animate-spin" /></Empty>
          )}
        </Card>

        <Card
          title="Contacts created per day — live from GHL"
          right={ghlContacts?.cachedAt && !contactsLoading ? (
            <span className="text-[11px] text-gray-400">
              as of {new Date(ghlContacts.cachedAt).toLocaleTimeString()}
            </span>
          ) : null}
        >
          {contactsScopeMissing ? (
            <ScopeBanner scope="contacts.readonly" />
          ) : contactsError ? (
            <ErrorNote message={contactsError} onRetry={loadContacts} />
          ) : !ghlContacts ? (
            <Empty><Loader2 size={16} className="mx-auto animate-spin" /></Empty>
          ) : ghlContacts.total === 0 ? (
            <Empty>No contacts created in this window.</Empty>
          ) : (
            <div className={dim(contactsLoading, ghlContacts)}>
              <DailyBars data={contactsData} series={contactsSeries} />
              {ghlContacts.approx?.capped && (
                <div className="mt-2 text-[11px] text-gray-400">
                  Daily bars cover the {ghlContacts.approx.contactsScanned.toLocaleString("en-US")} newest
                  of {ghlContacts.total.toLocaleString("en-US")} contacts created in this window — older
                  days may be undercounted (the total above is exact).
                </div>
              )}
            </div>
          )}
        </Card>

        <Card title="Sends per day — from this app">
          {summary ? (
            summary.sends.totalSms + summary.sends.totalEmail === 0 ? (
              <Empty>No texts or emails sent from the app in this window.</Empty>
            ) : (
              <div className={dim(summaryLoading, summary)}>
                <DailyBars data={sendsData} series={sendsSeries} />
                <Legend series={sendsSeries} />
              </div>
            )
          ) : (
            !summaryError && <Empty><Loader2 size={16} className="mx-auto animate-spin" /></Empty>
          )}
        </Card>

        <Card
          title="GHL activity per day — calls, texts, emails"
          right={ghlMsgs?.cachedAt && !msgsLoading ? (
            <span className="text-[11px] text-gray-400">
              as of {new Date(ghlMsgs.cachedAt).toLocaleTimeString()}
            </span>
          ) : null}
        >
          {msgsScopeMissing ? (
            <ScopeBanner scope="conversations.readonly" />
          ) : msgsError ? (
            <ErrorNote message={msgsError} onRetry={loadMsgs} />
          ) : msgsLoading && !ghlMsgs ? (
            <Empty>
              <Loader2 size={16} className="mx-auto mb-2 animate-spin" />
              Scanning recent conversations — the first load can take a few minutes…
            </Empty>
          ) : ghlMsgs ? (
            <div className={dim(msgsLoading, ghlMsgs)}>
              {ghlData.every((d) => d.values.every((v) => v === 0)) ? (
                <Empty>No GHL calls, texts, or emails in this window.</Empty>
              ) : (
                <>
                  <DailyBars data={ghlData} series={ghlSeries} />
                  <Legend series={ghlSeries} />
                </>
              )}
              <div className="mt-2 text-[11px] text-gray-400">
                Calls count both directions; texts and emails count outbound only.
                {ghlMsgs.approx?.capped && (
                  <> Showing the {ghlMsgs.approx.conversationsScanned} most recently active
                  conversations — older activity in this window may be undercounted.</>
                )}
              </div>
            </div>
          ) : null}
        </Card>

        <Card title="Outreach funnel per day">
          {summary ? (
            funnelData.every((d) => d.values.every((v) => v === 0)) ? (
              <Empty>No RentCast pulls or imports in this window.</Empty>
            ) : (
              <div className={dim(summaryLoading, summary)}>
                <DailyBars data={funnelData} series={funnelSeries} mode="group" />
                <Legend series={funnelSeries} />
                <div className="mt-2 text-[11px] text-gray-400">
                  {agentsImported} agent{agentsImported === 1 ? "" : "s"} imported in this window
                  {usage?.lastPullAt && <> · last pull {new Date(usage.lastPullAt).toLocaleDateString()}</>}
                </div>
              </div>
            )
          ) : (
            !summaryError && <Empty><Loader2 size={16} className="mx-auto animate-spin" /></Empty>
          )}
        </Card>
      </div>

      <Card
        title="Contacts by tag — live from GHL"
        right={!editingTags ? (
          <button type="button"
            onClick={() => { setTagDraft(tags.join(", ")); setEditingTags(true); }}
            className="rounded p-1 text-gray-400 hover:bg-gray-100" title="Edit the tag list">
            <Pencil size={14} />
          </button>
        ) : null}
      >
        {editingTags && (
          <div className="mb-3 flex items-center gap-2">
            <input ref={editRef} value={tagDraft} onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveTags(); if (e.key === "Escape") setEditingTags(false); }}
              placeholder="offer-created, agent-outreach"
              className="w-full max-w-md rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-gray-900 focus:outline-none" />
            <button type="button" onClick={saveTags} disabled={tagSaving}
              className="flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
              {tagSaving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save
            </button>
            <button type="button" onClick={() => setEditingTags(false)}
              className="rounded p-1.5 text-gray-400 hover:bg-gray-100"><X size={16} /></button>
          </div>
        )}
        {tagsScopeMissing ? (
          <ScopeBanner scope="contacts.readonly" />
        ) : tagsError ? (
          <ErrorNote message={tagsError} onRetry={loadTags} />
        ) : !settings || (tagsLoading && !tagCounts) ? (
          <Empty><Loader2 size={16} className="mx-auto animate-spin" /></Empty>
        ) : !tags.length ? (
          <Empty>No tags configured — use the pencil to add some.</Empty>
        ) : (
          <div className={`flex flex-wrap gap-2 ${dim(tagsLoading, tagCounts)}`}>
            {(tagCounts || []).map((t) => (
              <span key={t.tag}
                className="inline-flex items-center gap-2 rounded-full border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm">
                <span className="font-mono text-xs text-gray-600">{t.tag}</span>
                <span className="font-semibold text-gray-900">{t.count.toLocaleString("en-US")}</span>
              </span>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
