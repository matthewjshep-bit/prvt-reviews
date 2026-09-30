// LineView.jsx — the line, measured. The Line tab of /reports.
//
// Flow says what moved; this says whether the line is keeping pace (each
// station against its target), where work waits (the time between
// stations), and what fell off it with nothing scheduled — counted by the
// same code that schedules the work (shared/line.js). Then the jobs that run
// the line, the errors, and what buyers paid all-in beside the offer
// setting. It reads only: nothing on this page changes a setting.

import React, { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { getDashboardLine, offerEditorUrl } from "./api.js";
import { BTN, Card, ErrorBar } from "./ui.jsx";

const n = (v) => (v == null ? "—" : Number(v).toLocaleString("en-US"));
const days = (v) => (v == null ? "—" : `${v}d`);
const pctText = (v) => (v == null ? "—" : `${v}%`);

function paceTone(p) {
  if (p == null) return "text-slate-400";
  if (p >= 1) return "text-emerald-700";
  if (p >= 0.6) return "text-amber-700";
  return "text-red-700";
}

function Stations({ stations = [], method }) {
  return (
    <Card title="Stations — last 30 days against target" right={method ? (
      <span className="text-[11px] text-slate-500">
        {n(method.offers30)} offers out → the method expects <b>{method.expectedContracts}</b> contract{method.expectedContracts === 1 ? "" : "s"}; you have <b>{n(method.contracts30)}</b> ·
        {" "}{n(method.offersForTarget)} offers a month make the target
      </span>
    ) : null}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
              <th className="py-1 pr-3 font-semibold">Station</th>
              <th className="py-1 pr-3 text-right font-semibold">7 days</th>
              <th className="py-1 pr-3 text-right font-semibold">30 days</th>
              <th className="py-1 pr-3 text-right font-semibold">A day</th>
              <th className="py-1 pr-3 font-semibold">Target</th>
              <th className="py-1 text-right font-semibold">Pace</th>
            </tr>
          </thead>
          <tbody>
            {stations.map((s) => (
              <tr key={s.key} className="border-t border-slate-100" title={s.hint}>
                <td className="py-1.5 pr-3">
                  <span className="font-medium text-slate-800">{s.label}</span>
                  <span className="ml-1 text-[11px] text-slate-400">{s.side === "dispo" ? "disposition" : "acquisition"}</span>
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{n(s.week)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{n(s.month)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{s.perDay}</td>
                <td className="py-1.5 pr-3 text-slate-500">{s.target ? s.target.words : ""}</td>
                <td className={`py-1.5 text-right font-semibold tabular-nums ${paceTone(s.pace)}`}>{s.pace == null ? "" : `${Math.round(s.pace * 100)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Cycle({ cycle = [] }) {
  return (
    <Card title="Waiting between stations — hops finished in the last 30 days">
      <ul className="space-y-1 text-sm">
        {cycle.map((h) => (
          <li key={h.key} className="flex items-baseline justify-between gap-3">
            <span className="text-slate-700">{h.label}</span>
            <span className="tabular-nums text-slate-500">
              {h.n ? <>median <b className="text-slate-800">{days(h.medianDays)}</b> · slowest tenth {days(h.p90Days)} · {h.n}</> : "none finished"}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function LeakRows({ rows = [] }) {
  if (!rows.length) return null;
  return (
    <ul className="mt-2 space-y-0.5">
      {rows.slice(0, 12).map((r, i) => (
        <li key={`${r.offerId || r.kind}-${i}`} className="text-sm text-slate-700">
          {r.offerId ? <a className="font-medium hover:text-blue-700" href={offerEditorUrl(r.offerId)}>{String(r.address || "").split(",")[0] || "An offer"}</a>
            : <span className="font-medium">{String(r.address || "").split(",")[0]}</span>}
          <span className="text-slate-400"> — {r.title || r.label}{r.reason ? `: ${r.reason}` : ""}</span>
        </li>
      ))}
      {rows.length > 12 && <li className="text-xs text-slate-400">+{rows.length - 12} more</li>}
    </ul>
  );
}

function Leaks({ leaks = {}, total, backlog = 0 }) {
  const o = leaks.offers || {};
  const a = leaks.agents;
  const b = leaks.buyers;
  const d = leaks.deals || {};
  return (
    <Card title={`Leaks — ${n(total)} fell off with nothing scheduled`} right={backlog ? (
      <span className="text-[11px] text-slate-500">Backlog: <b>{n(backlog)}</b> due a check-in, queued behind today's seats</span>
    ) : null}>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <div className="text-xs font-semibold text-slate-600">Offers</div>
          <div className="text-sm text-slate-700">
            <b>{n(o.nothing)}</b> open with nothing coming · <b>{n(o.missed)}</b> a machine clock missed by a day ·
            <span className="text-slate-500"> {n(o.waitingOnYou)} waiting on you (not lost)</span>
          </div>
          <LeakRows rows={(o.rows || []).filter((r) => r.leak !== "waiting_on_you")} />
        </div>
        <div>
          <div className="text-xs font-semibold text-slate-600">Deals</div>
          <div className="text-sm text-slate-700"><b>{n(d.total)}</b> live deals not moving toward a buyer</div>
          <LeakRows rows={d.rows || []} />
        </div>
        <div>
          <div className="text-xs font-semibold text-slate-600">Agents</div>
          {a ? (
            <div className="text-sm text-slate-700">
              {a.enabled
                ? <><b>{n(a.dueNoSeat)}</b> due a check-in, queued behind today's seats (backlog)</>
                : <><b>{n(a.dueWhileOff)}</b> due a check-in, and the agent check-in is off</>}
              {a.freshListings ? <> · {n(a.freshListings)} with a fresh listing</> : null}
              {a.coldDropped ? <span className="text-slate-500"> · {n(a.coldDropped)} cold agents dropped after three unanswered</span> : null}
            </div>
          ) : <div className="text-sm text-slate-400">Couldn't read the agent check-in's plan.</div>}
        </div>
        <div>
          <div className="text-xs font-semibold text-slate-600">Buyers</div>
          {b ? (
            <div className="text-sm text-slate-700">
              {b.enabled
                ? <><b>{n(b.dueNoSeat)}</b> due a check-in, queued behind today's seats (backlog)</>
                : <><b>{n(b.dueWhileOff)}</b> due a check-in, and the buyer check-in is off</>}
              {b.passWorkdays != null ? <> · one pass through the pool takes <b className={b.passTooLong ? "text-amber-700" : ""}>{n(b.passWorkdays)} workdays</b></> : null}
            </div>
          ) : <div className="text-sm text-slate-400">Couldn't read the buyer check-in's plan.</div>}
        </div>
      </div>
    </Card>
  );
}

function Coverage({ coverage = {}, targets = {} }) {
  const a = coverage.agents;
  const b = coverage.buyers;
  return (
    <Card title="Coverage">
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <div className="text-2xl font-bold tabular-nums">{pctText(a?.pct)}</div>
          <div className="text-slate-600">of agents who've written back were touched in the last {targets.agentTouchDays || 21} days</div>
          {a ? <div className="text-xs text-slate-400">{n(a.touched)} of {n(a.pool)}</div> : null}
        </div>
        <div>
          <div className="text-2xl font-bold tabular-nums">{pctText(b?.pct)}</div>
          <div className="text-slate-600">of reachable buyers are inside their check-in cadence</div>
          {b ? <div className="text-xs text-slate-400">{n(b.inCadence)} of {n(b.reachable)}</div> : null}
        </div>
      </div>
    </Card>
  );
}

function Jobs({ jobs = [], errors = [] }) {
  const when = (h) => (h == null ? "" : h < 1 ? "under an hour ago" : h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`);
  return (
    <Card title="The jobs that run the line">
      <ul className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {jobs.map((j) => (
          <li key={j.name} className="flex items-baseline justify-between gap-3">
            <span className="text-slate-700">{j.label}</span>
            <span className={`text-xs ${j.failed ? "text-red-700" : "text-slate-500"}`}>
              {j.never ? "never ran" : j.failed ? `failed ${when(j.hoursAgo)}${j.error ? `: ${j.error}` : ""}` : `ran ${when(j.hoursAgo)}`}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-3 text-xs font-semibold text-slate-600">Errors, last 7 days</div>
      {errors.length ? (
        <ul className="mt-1 space-y-0.5 text-sm">
          {errors.slice(0, 8).map((e) => (
            <li key={e.area} className="text-slate-700"><span className="font-medium">{e.area}</span> <span className="text-slate-400">· {n(e.count)} · {e.message}</span></li>
          ))}
        </ul>
      ) : <div className="mt-1 text-sm text-slate-400">None.</div>}
    </Card>
  );
}

function Pricing({ pricing }) {
  if (!pricing) return null;
  return (
    <Card title="What buyers paid, all-in (price + fee + repairs, as a share of ARV)">
      <div className="text-sm text-slate-700">
        Offers are set at <b>{pctText(pricing.setting)}</b> of ARV minus repairs, fee inside it. Deals that sold: median <b>{pctText(pricing.sold?.medianPct)}</b> ({n(pricing.sold?.n)}).
        {" "}Deals that died: median <b>{pctText(pricing.died?.medianPct)}</b> ({n(pricing.died?.n)}).
        {pricing.gapToSold != null ? <span className="text-slate-500"> The setting sits {pricing.gapToSold} points above what the sold deals paid.</span> : null}
      </div>
      {pricing.rows?.length ? (
        <ul className="mt-2 flex flex-wrap gap-2 text-xs">
          {pricing.rows.map((r) => (
            <li key={r.offerId || r.street} className={`rounded-md px-2 py-0.5 ${r.outcome === "fell_through" ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}>
              {r.street} · {r.allInPct}%
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-2 text-[11px] text-slate-400">Evidence only. Nothing here changes the offer setting.</div>
    </Card>
  );
}

// The page under the toolbar, from one /line response. Its own export so it
// renders without a fetch (the test renders it from buildLine's output).
export function LineBody({ data }) {
  if (!data) return null;
  return (
    <>
      <Leaks leaks={data.leaks} total={data.leakTotal} backlog={data.backlog} />
      <Stations stations={data.stations} method={data.method} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Cycle cycle={data.cycle} />
        <Coverage coverage={data.coverage} targets={data.targets} />
      </div>
      <Jobs jobs={data.jobs} errors={data.errors} />
      <Pricing pricing={data.pricing} />
    </>
  );
}

export default function LineView() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const load = (fresh = false) => {
    setLoading(true);
    setError("");
    getDashboardLine({ fresh })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(false); }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-slate-500">
          {data ? `As of ${new Date(data.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : loading ? "Reading the line…" : ""}
          {data?.eventsTruncated ? <span className="text-amber-700"> · the month's events were more than one read holds; the counts are low</span> : null}
        </div>
        <button type="button" className={BTN} disabled={loading} onClick={() => load(true)}>
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>
      {error && <ErrorBar>{error}</ErrorBar>}
      <LineBody data={data} />
    </div>
  );
}
