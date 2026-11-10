// TextScoreboard.jsx — which text wins (shared/outreach-scorecard.js).
//
// Every first text, follow-up and check-in that went 7 or more days ago,
// grouped by the text it was, and per group how many got a useful reply in 3
// and 7 days, a STOP inside 72 hours, a real call, a house named, an offer
// and a deal. The card is worked out once a night on the broker and kept;
// this only reads it. Report only: nothing here retires a text.
//
// Shown on Reports → Follow-up and on Autopilot → Agents.

import React, { useEffect, useState } from "react";
import { getOutreachScorecard } from "./api.js";
import { Card, FilterChips } from "./ui.jsx";
import { SCORE_KINDS, SCORE_KIND_LABEL, SCORE_DIMENSIONS, SCORE_DIMENSION_LABEL } from "@shared/outreach-scorecard.js";

const n = (v) => (v == null ? "—" : Number(v).toLocaleString("en-US"));
const pctText = (v) => (v == null ? "—" : `${v}%`);
const TZ = "America/Los_Angeles";
const whenText = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");

// The columns, in the order the line runs: answered, stopped, then what it led to.
const COLUMNS = [
  { key: "replied3", label: "Reply in 3 days", hint: "A useful reply inside 3 days: not a STOP, an auto-reply or small talk" },
  { key: "replied7", label: "Reply in 7 days", hint: "A useful reply inside 7 days" },
  { key: "stopped", label: "STOP", hint: "They asked us to stop inside 72 hours" },
  { key: "talked", label: "Talked", hint: "A real call inside 14 days" },
  { key: "house", label: "House named", hint: "They named a house, or someone with one, inside 14 days" },
  { key: "offer", label: "Offer", hint: "An offer on a house that came through outreach, inside 30 days" },
  { key: "deal", label: "Deal", hint: "That offer became a deal" },
];

/**
 * The card body (no fetch: the tests render it).
 *   data  GET /api/dashboard/outreach-scorecard → { card, at, status, error }
 *   kind  the kind of text to open on
 */
export function TextScoreboard({ data, kind: startKind = "first_text", title = "Text scoreboard" }) {
  const card = data?.card || null;
  const [kind, setKind] = useState(startKind);
  const k = card?.kinds?.[kind] || null;
  const dims = (SCORE_DIMENSIONS[kind] || []).filter((d) => k?.dims?.[d]?.length);
  const [dim, setDim] = useState("template");
  const shown = dims.includes(dim) ? dim : dims[0] || null;
  const rows = shown ? k.dims[shown] : [];
  const minN = card?.minN ?? 30;
  return (
    <Card title={title} right={<span className="text-[11px] text-slate-500">{data?.at ? `worked out ${whenText(data.at)}` : "worked out each night"} · report only, nothing retires itself</span>}>
      {!card ? (
        <p className="text-sm text-slate-500">
          {data?.status === "error" ? `Last night's read failed (${data.error || "an error"}); the next one is tonight.` : "No scoreboard yet. It is worked out each night at 4am Pacific."}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <FilterChips value={kind} onChange={setKind} label="Kind of text"
              options={SCORE_KINDS.map((x) => ({ key: x, label: SCORE_KIND_LABEL[x], count: card.kinds?.[x]?.n ?? 0 }))} />
            {dims.length > 1 ? (
              <FilterChips value={shown} onChange={setDim} label="Split by" options={dims.map((d) => ({ key: d, label: SCORE_DIMENSION_LABEL[d] || d }))} />
            ) : null}
          </div>
          <p className="mt-2 text-[11px] leading-snug text-slate-500">
            Texts sent {card.minAgeDays ?? 7} or more days ago{k?.young ? ` (${n(k.young)} newer left out until they've had their week)` : ""}.
            {" "}Each answer goes to the last text we sent them before it. Groups under {minN} sends are greyed: too few to call.
            {card.truncated ? " More history than one night's read holds: the oldest texts are missing." : ""}
          </p>
          {k?.totals?.n ? (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                    <th className="py-1 pr-3 font-semibold">{SCORE_DIMENSION_LABEL[shown] || "Group"}</th>
                    <th className="py-1 pr-3 text-right font-semibold">Sent</th>
                    {COLUMNS.map((c) => <th key={c.key} title={c.hint} className="py-1 pr-3 text-right font-semibold">{c.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {[...rows, { ...k.totals, key: "__all", label: "All" }].map((r) => (
                    <tr key={r.key} className={`border-t border-slate-100 align-top ${r.key === "__all" ? "font-semibold" : ""} ${r.small && r.key !== "__all" ? "text-slate-400" : "text-slate-700"}`}
                      title={r.small && r.key !== "__all" ? `Only ${r.n} sent: too few to call` : undefined}>
                      <td className="max-w-md py-1.5 pr-3 break-words">{r.label}{r.small && r.key !== "__all" ? <span className="ml-1 text-[10px]">few</span> : null}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{n(r.n)}</td>
                      {COLUMNS.map((c) => (
                        <td key={c.key} className={`py-1.5 pr-3 text-right tabular-nums ${c.key === "stopped" && r[c.key] && !r.small ? "text-red-700" : ""}`}>
                          {n(r[c.key])} <span className="text-[10px] text-slate-400">{pctText(r.rates?.[c.key])}</span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="mt-3 text-sm text-slate-500">Nothing of this kind went 7 or more days ago.</p>}
        </>
      )}
    </Card>
  );
}

/** The card with its read: the kept card, fetched once on mount. */
export default function TextScoreboardCard({ kind = "first_text", title }) {
  const [data, setData] = useState(null);
  useEffect(() => { getOutreachScorecard().then(setData).catch(() => setData(null)); }, []);
  return <TextScoreboard data={data} kind={kind} title={title} />;
}
