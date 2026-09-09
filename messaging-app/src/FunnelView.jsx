// FunnelView.jsx — what happened to the offers we sent.
//
// READ ONLY, and it says so on the page. Nothing here changes the offer math,
// the follow-up ladder or the buy box: it is the evidence for a decision the
// operator makes, not one the machine makes quietly. That distinction is the
// whole reason the section is separate from the settings tabs.

import React, { useEffect, useState } from "react";
import { PASS_REASON_LABEL } from "@shared/conversation-ai.js";
import { getDashboardFunnel } from "./api.js";
import { ErrorBar, FilterChips, KpiRow, SkeletonRows, TableCard } from "./ui.jsx";

const money = (n) => `$${Math.round(Number(n) || 0).toLocaleString()}`;
const pctText = (n) => `${Number(n) || 0}%`;

const GROUPS = [
  { key: "area", label: "By area" },
  { key: "priceBand", label: "By price" },
  { key: "deal", label: "By deal" },
  { key: "buyer", label: "By buyer" },
];

const KIND_LABEL = {
  offer_nudge: "Offer, no reply",
  blast_nudge: "Deal sent, no reply",
  dataroom_nudge: "Opened the package",
};

// One bar per stage, each as a share of the widest one, so the drop-off is
// the thing you see rather than a column of numbers you have to divide.
function FunnelBars({ f }) {
  const rows = [
    { label: "Sent", n: f.sent, cls: "bg-slate-400" },
    { label: "Countered", n: f.countered, cls: "bg-violet-400" },
    { label: "Accepted", n: f.accepted, cls: "bg-emerald-500" },
    { label: "Passed", n: f.passed, cls: "bg-rose-400" },
    { label: "No response", n: f.noResponse, cls: "bg-amber-400" },
  ];
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2 text-xs">
          <span className="w-24 shrink-0 text-slate-500">{r.label}</span>
          <div className="h-4 flex-1 overflow-hidden rounded bg-slate-100">
            <div className={`h-full rounded ${r.cls}`} style={{ width: `${(r.n / max) * 100}%` }} />
          </div>
          <span className="w-8 shrink-0 text-right font-semibold tabular-nums">{r.n}</span>
        </div>
      ))}
    </div>
  );
}

export default function FunnelView({ days = 30, end = "" }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [group, setGroup] = useState("area");

  useEffect(() => {
    let live = true;
    setData(null);
    getDashboardFunnel(days, end)
      .then((r) => { if (live) setData(r); })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [days, end]);

  if (error) return <ErrorBar>{error}</ErrorBar>;
  if (!data) return <SkeletonRows rows={4} />;

  const { funnel: f, counters: c, passReasons: pr, followUps } = data;
  const groups = pr?.[group] || [];

  return (
    <div className="space-y-4">
      <KpiRow items={[
        { label: "Offers sent", value: f.sent },
        { label: "Countered", value: `${f.countered} · ${pctText(f.rates.counteredOfSent)}`, hint: "of the offers we sent" },
        { label: "Accepted", value: `${f.accepted} · ${pctText(f.rates.acceptedOfSent)}`, hint: "of the offers we sent" },
        { label: "Still working", value: f.open, hint: "sent, and not yet passed, dead or accepted" },
      ]} />

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="mb-1 text-sm font-bold">Where they go</h3>
          <p className="mb-3 text-xs text-slate-500">
            Counted once per stage per offer, the first time it got there — so chasing an offer twice doesn’t inflate the
            top of the funnel.
          </p>
          <FunnelBars f={f} />
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="mb-1 text-sm font-bold">How far apart we are</h3>
          <p className="mb-3 text-xs text-slate-500">
            When an agent counters, how much over our number — and what happened next. If the ones that get accepted cluster
            low and the ones that die cluster high, that gap is where your ceiling belongs.
          </p>
          {c.n === 0 ? (
            <p className="text-xs text-slate-400">No counters with a number on them yet.</p>
          ) : (
            <>
              <div className="mb-3 flex gap-4 text-sm">
                <div><div className="text-[11px] uppercase tracking-wide text-slate-400">Median over</div>
                  <div className="text-lg font-bold tabular-nums">{pctText(c.medianLiftPct)}</div></div>
                <div><div className="text-[11px] uppercase tracking-wide text-slate-400">In dollars</div>
                  <div className="text-lg font-bold tabular-nums">{money(c.medianLiftDollars)}</div></div>
                <div><div className="text-[11px] uppercase tracking-wide text-slate-400">Counters</div>
                  <div className="text-lg font-bold tabular-nums">{c.n}</div></div>
              </div>
              <TableCard>
                <table className="w-full text-xs">
                  <thead className="text-left text-slate-400">
                    <tr><th className="py-1 font-medium">Property</th><th className="font-medium">Ours</th>
                      <th className="font-medium">Theirs</th><th className="font-medium">Over</th><th className="font-medium">Then</th></tr>
                  </thead>
                  <tbody>
                    {c.items.slice(0, 12).map((i) => (
                      <tr key={i.offerId} className="border-t border-slate-100">
                        <td className="py-1 pr-2">{i.address}</td>
                        <td className="tabular-nums">{money(i.ours)}</td>
                        <td className="tabular-nums">{money(i.theirs)}</td>
                        <td className="tabular-nums font-medium">{pctText(i.liftPct)}</td>
                        <td className={i.outcome === "accepted" ? "text-emerald-700" : i.outcome === "open" ? "text-slate-400" : "text-rose-600"}>
                          {i.outcome.replace(/_/g, " ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableCard>
            </>
          )}
        </section>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold">Why buyers said no</h3>
            <p className="text-xs text-slate-500">Each buyer’s reason counted once per deal, however many places it got written down.</p>
          </div>
          <FilterChips value={group} onChange={setGroup} options={GROUPS} label="Group" />
        </div>
        {groups.length === 0 ? (
          <p className="text-xs text-slate-400">No pass reasons filed yet.</p>
        ) : (
          <div className="space-y-2">
            {groups.slice(0, 10).map((g) => (
              <div key={g.key} className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2 text-xs first:border-0 first:pt-0">
                <span className="w-40 shrink-0 font-medium">{g.label}</span>
                <span className="w-10 shrink-0 tabular-nums text-slate-400">{g.total}</span>
                {g.byCode.map((b) => (
                  <span key={b.code} className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-700">
                    {PASS_REASON_LABEL[b.code] || b.code} · {b.count}
                  </span>
                ))}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="mb-1 text-sm font-bold">Did the follow-ups work</h3>
        <p className="mb-3 text-xs text-slate-500">Replies within five days of each nudge, per rung.</p>
        {(!followUps || followUps.length === 0) ? (
          <p className="text-xs text-slate-400">No follow-ups have gone out in this window.</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-left text-slate-400">
              <tr><th className="py-1 font-medium">Ladder</th><th className="font-medium">Day</th><th className="font-medium">Sent</th>
                <th className="font-medium">Replied</th><th className="font-medium">Rate</th><th className="font-medium">Typical wait</th></tr>
            </thead>
            <tbody>
              {followUps.map((r) => (
                <tr key={`${r.kind}-${r.step}`} className="border-t border-slate-100">
                  <td className="py-1 pr-2">{KIND_LABEL[r.kind] || r.kind}</td>
                  <td className="tabular-nums">{r.step}</td>
                  <td className="tabular-nums">{r.sent}</td>
                  <td className="tabular-nums">{r.replied}</td>
                  <td className="tabular-nums font-medium">{pctText(r.replyRate)}</td>
                  <td className="tabular-nums text-slate-500">{r.medianHoursToReply ? `${r.medianHoursToReply}h` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-3 text-[11px] text-slate-400">
          Read this and change the ladder yourself — nothing here tunes itself.
        </p>
      </section>
    </div>
  );
}
