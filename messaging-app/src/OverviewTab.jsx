// OverviewTab.jsx — Autopilot's front page (2026-10-20): what the bot sent
// agents and buyers, and what's coming, in a few numbers. Everything to
// change is a click away: the texts on Agents and Investors, the rest on
// Advanced settings.
//
// The counts are Reports → Follow-up's (GET /api/dashboard/followup),
// folded into two sides by shared/autopilot-overview.js.

import React, { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { autopilotOverview } from "@shared/autopilot-overview.js";
import { getConversationAi, getDashboardFollowUp } from "./api.js";
import { ErrorBar } from "./ui.jsx";

const PERIODS = [["today", "Today"], ["week", "This week"], ["month", "This month"]];

/** "today 3pm", "Wed 10am", "Oct 28" — when the next text goes. */
export function whenLabel(at, now = Date.now()) {
  const t = Date.parse(at || "");
  if (!Number.isFinite(t)) return "";
  if (t <= now + 60000) return "now";
  const d = new Date(t);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: d.getMinutes() ? "2-digit" : undefined, timeZone: "America/Los_Angeles" }).replace(" ", "").toLowerCase();
  const day = (x) => new Date(x).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" });
  if (day(t) === day(now)) return `today ${time}`;
  if (t - now < 6 * 86400000) return `${d.toLocaleDateString("en-US", { weekday: "short", timeZone: "America/Los_Angeles" })} ${time}`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
}

function Stat({ value, label, sub }) {
  return (
    <div>
      <div className="text-3xl font-bold tabular-nums text-slate-900">{value}</div>
      <div className="text-xs font-medium text-slate-600">{label}</div>
      {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}

/** One side: three numbers, the lines behind them, and the next text coming. */
export function SideCard({ side, onOpen }) {
  return (
    <section className="flex flex-col rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold text-slate-900">{side.label}</h2>
        {onOpen && (
          <button type="button" onClick={onOpen} className="inline-flex items-center gap-1 text-sm font-semibold text-blue-700 hover:underline">
            See the texts <ArrowRight size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="mt-4 grid grid-cols-3 gap-4">
        <Stat value={side.sent} label="Sent" sub={side.sent ? `${side.replied} replied` : ""} />
        <Stat value={side.coming} label="Coming up" />
        <Stat value={side.waiting} label="Waiting on you" />
      </div>
      {side.lines.length > 0 ? (
        <ul className="mt-5 divide-y divide-slate-100 border-t border-slate-100 text-sm">
          {side.lines.map((l) => (
            <li key={l.key} className="flex items-baseline justify-between gap-3 py-2">
              <span className="text-slate-700">{l.label}</span>
              <span className="whitespace-nowrap tabular-nums text-xs text-slate-500">
                {[l.sent ? `${l.sent} sent` : "", l.coming ? `${l.coming} coming` : "", l.waiting ? `${l.waiting} waiting` : ""].filter(Boolean).join(" · ")}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-5 border-t border-slate-100 pt-4 text-sm text-slate-500">Nothing sent or coming in this period.</p>
      )}
      {side.next && (
        <p className="mt-auto pt-4 text-xs text-slate-600">
          <span className="font-semibold">Next:</span> {side.next.label}{side.next.count > 1 ? ` to ${side.next.count}` : side.next.name ? ` to ${side.next.name}` : ""}, {whenLabel(side.next.at)}
        </p>
      )}
    </section>
  );
}

export default function OverviewTab({ onOpen }) {
  const [period, setPeriod] = useState("week");
  const [page, setPage] = useState(null);
  const [bot, setBot] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    setPage(null);
    getDashboardFollowUp({ period })
      .then((r) => { if (live) { setPage(r); setError(""); } })
      .catch((e) => { if (live) setError(e.message || "Couldn't load what the bot is doing."); });
    return () => { live = false; };
  }, [period]);
  useEffect(() => {
    getConversationAi().then((r) => setBot({ on: Boolean(r.config?.enabled), sends: r.sendsEnabled !== false })).catch(() => setBot(null));
  }, []);

  const { sides } = autopilotOverview(page || {});
  const state = !bot ? null : !bot.on ? ["bg-red-500", "The bot is off. Nothing is written or sent."]
    : !bot.sends ? ["bg-amber-500", "The bot is on and drafting. Sends are off on the broker, so nothing leaves."]
    : ["bg-emerald-500", "The bot is on."];

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        {state && (
          <span className="inline-flex items-center gap-2 text-sm text-slate-700">
            <span className={`h-2 w-2 rounded-full ${state[0]}`} aria-hidden="true" /> {state[1]}
          </span>
        )}
        <div className="ml-auto inline-flex rounded-lg border border-slate-200 bg-white p-0.5" role="tablist" aria-label="Period">
          {PERIODS.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={period === k} onClick={() => setPeriod(k)}
              className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${period === k ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {error && <ErrorBar>{error}</ErrorBar>}
      <div className={`grid gap-5 md:grid-cols-2 ${page ? "" : "opacity-50"}`} aria-busy={!page}>
        {sides.map((s) => <SideCard key={s.key} side={s} onOpen={onOpen ? () => onOpen(s.key) : null} />)}
      </div>
      <p className="text-xs text-slate-500">Counts every text the bot starts on its own. Replies to people who text in aren't counted here.</p>
    </div>
  );
}
