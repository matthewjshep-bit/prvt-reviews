// AutopilotCard.jsx — what the machine is doing on its own, on one card.
//
// Every automation ships off and graduates to "drafting" (it writes, you
// send) before "on" (it sends). Until this card the only way to know which
// state each one was in was to read Settings and the Conversation AI tab
// side by side. Now it is the first thing on the Pipeline tab, and a line at
// the bottom says how many intents have earned promotion.

import React from "react";
import { PARTY_LABEL } from "@shared/conversation-ai.js";
import { Pill } from "./ui.jsx";

const STATE = {
  on:       { label: "on",       cls: "bg-emerald-100 text-emerald-800" },
  drafting: { label: "drafting", cls: "bg-amber-100 text-amber-800" },
  off:      { label: "off",      cls: "bg-slate-100 text-slate-500" },
};
const GROUPS = [["broker", "Broker"], ["agent", `${PARTY_LABEL.agent}s`], ["investor", `${PARTY_LABEL.investor}s`]];

function conversationHref() {
  try {
    const u = new URL(window.location.href);
    u.searchParams.set("view", "conversation");
    return u.pathname + u.search;
  } catch { return "?view=conversation"; }
}

export default function AutopilotCard({ autopilot }) {
  if (!autopilot) return null;
  const { switches = [], counts = {}, readyToGraduate = 0, windowDays } = autopilot;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-bold">Autopilot</h2>
        <span className="text-xs text-slate-500">
          <b className="text-emerald-700">{counts.on || 0}</b> sending itself ·{" "}
          <b className="text-amber-700">{counts.drafting || 0}</b> drafting for you ·{" "}
          <b>{counts.off || 0}</b> off
        </span>
        {readyToGraduate > 0 && (
          <a href={conversationHref()} className="ml-auto text-xs font-semibold text-blue-700 hover:underline">
            {readyToGraduate} intent{readyToGraduate === 1 ? " is" : "s are"} ready to send on their own →
          </a>
        )}
        {readyToGraduate === 0 && windowDays && (
          <span className="ml-auto text-xs text-slate-400">nothing new to promote in the last {windowDays} days</span>
        )}
      </div>
      <div className="grid gap-x-6 gap-y-1 md:grid-cols-3">
        {GROUPS.map(([group, title]) => {
          const rows = switches.filter((s) => s.group === group);
          if (!rows.length) return null;
          return (
            <div key={group}>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{title}</div>
              <ul className="space-y-1">
                {rows.map((s) => {
                  const st = STATE[s.state] || STATE.off;
                  return (
                    <li key={s.key} className="flex items-start gap-2 text-sm" title={s.note}>
                      <Pill small label={st.label} cls={`${st.cls} w-16 justify-center`} />
                      <span className="min-w-0">
                        <span className={s.state === "off" ? "text-slate-500" : "text-slate-800"}>{s.label}</span>
                        {s.note && <span className="block truncate text-xs text-slate-400">{s.note}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}
