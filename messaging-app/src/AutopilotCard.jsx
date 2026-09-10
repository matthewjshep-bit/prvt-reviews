// AutopilotCard.jsx — what the machine is doing on its own, on one card.
//
// Every automation ships off and graduates to "drafting" (it writes, you
// send) before "on" (it sends). Until this card the only way to know which
// state each one was in was to read Settings and the Conversation AI tab
// side by side. Now it is the first thing on the Pipeline tab, and a line at
// the bottom says how many intents have earned promotion.
//
// The dial at the top (2026-09-10) sets every switch at once: Off, Cautious,
// Normal, Fully autonomous. The rows underneath are what that came to. A
// blob set by hand shows as "Custom" — a mode button replaces it.

import React, { useState } from "react";
import { PARTY_LABEL } from "@shared/conversation-ai.js";
import { AUTONOMY_MODES, AUTONOMY_LABEL, AUTONOMY_GLOSS, AUTONOMY_DOES } from "@shared/autonomy.js";
import { Pill } from "./ui.jsx";
import { setAutonomy } from "./api.js";

const STATE = {
  on:       { label: "on",       cls: "bg-emerald-100 text-emerald-800" },
  drafting: { label: "drafting", cls: "bg-amber-100 text-amber-800" },
  off:      { label: "off",      cls: "bg-slate-100 text-slate-500" },
};
const GROUPS = [["broker", "Broker"], ["agent", `${PARTY_LABEL.agent}s`], ["investor", `${PARTY_LABEL.investor}s`]];

const MODE_CLS = {
  off: "bg-slate-700 text-white border-slate-700",
  cautious: "bg-amber-500 text-white border-amber-500",
  normal: "bg-blue-600 text-white border-blue-600",
  full: "bg-emerald-600 text-white border-emerald-600",
};

function conversationHref() {
  try {
    const u = new URL(window.location.href);
    u.searchParams.set("view", "conversation");
    return u.pathname + u.search;
  } catch { return "?view=conversation"; }
}

// The dial. Four buttons; the current one is filled. Picking one asks once,
// with the list of what it does, then saves at once — like the kill switch,
// not like a form field.
export function AutonomyDial({ mode, onChange, busy }) {
  const current = AUTONOMY_MODES.includes(mode) ? mode : "custom";
  return (
    <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Self-driving</span>
        <div className="inline-flex overflow-hidden rounded-lg border border-slate-300 bg-white" role="radiogroup" aria-label="Self-driving mode">
          {AUTONOMY_MODES.map((m) => {
            const on = m === current;
            return (
              <button key={m} type="button" role="radio" aria-checked={on} disabled={busy}
                onClick={() => !on && onChange?.(m)}
                className={`border-r px-3 py-1.5 text-xs font-semibold last:border-r-0 transition-colors disabled:opacity-50 ${on ? MODE_CLS[m] : "border-slate-200 text-slate-700 hover:bg-slate-100"}`}>
                {AUTONOMY_LABEL[m]}
              </button>
            );
          })}
        </div>
        {current === "custom" && <Pill small label="Custom" cls="bg-violet-100 text-violet-800" title={AUTONOMY_GLOSS.custom} />}
        {busy && <span className="text-xs text-slate-400">saving…</span>}
      </div>
      <p className="mt-1.5 text-xs text-slate-600">{AUTONOMY_GLOSS[current]}</p>
    </div>
  );
}

export default function AutopilotCard({ autopilot, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  if (!autopilot) return null;
  const { switches = [], counts = {}, readyToGraduate = 0, windowDays, mode } = autopilot;

  const pick = async (m) => {
    const does = (AUTONOMY_DOES[m] || []).map((l) => `• ${l}`).join("\n");
    const ok = typeof window === "undefined" || window.confirm(`Set the autopilot to ${AUTONOMY_LABEL[m]}?\n\n${does}\n\nEvery self-driving switch moves to this position. Playbooks, ladders and caps stay as they are.`);
    if (!ok) return;
    setBusy(true); setErr(""); setNote("");
    try {
      const r = await setAutonomy(m);
      setNote(r.held ? `${AUTONOMY_LABEL[m]} — held ${r.held} repl${r.held === 1 ? "y" : "ies"} that ${r.held === 1 ? "was" : "were"} counting down.` : `${AUTONOMY_LABEL[m]}.`);
      onDone?.();
    } catch (e) {
      setErr(e?.message || "could not set the mode");
    } finally { setBusy(false); }
  };

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
      <AutonomyDial mode={mode} onChange={pick} busy={busy} />
      {err && <div className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700">{err}</div>}
      {note && !err && <div className="mb-2 text-xs text-emerald-700">{note}</div>}
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
