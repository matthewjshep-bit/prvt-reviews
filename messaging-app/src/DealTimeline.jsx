import React, { useState } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import { GATES, GATE_LABEL, resolveChecklist, dueWords } from "@shared/deal-checklist.js";
import { OWNER_KEYS, OWNER_LABEL, partyName } from "@shared/deal-parties.js";
import { updateDealChecklist } from "./api.js";

const STEPS = [...GATES, "closed"];
const DUE_CLS = {
  overdue: "bg-rose-100 text-rose-800",
  due_soon: "bg-amber-100 text-amber-900",
  open: "bg-slate-100 text-slate-700",
  later: "bg-slate-100 text-slate-600",
  done: "bg-emerald-50 text-emerald-800",
};

/**
 * The closing timeline (shared/deal-checklist.js): a stepper across the deal
 * stages, and under it the gate you're looking at — what has to be done,
 * who owes it, by when. Tick, re-date, reassign, delete, add.
 */
export default function DealTimeline({ offer, parties = {}, onUpdated }) {
  const deal = offer.deal;
  const c = resolveChecklist(deal);
  const stageIdx = STEPS.indexOf(deal.stage);
  const [view, setView] = useState(c.currentGate || "assigned");
  const [adding, setAdding] = useState(null); // null | { label, owner, due }
  const [editDate, setEditDate] = useState(null); // item id
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function edit(body) {
    setError(""); setBusy(true);
    try {
      const r = await updateDealChecklist(offer.id, body);
      if (r?.offer) onUpdated(r.offer);
      return r;
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  const ownerName = (k) => (k === "us" ? "Us" : partyName(parties[k]) || OWNER_LABEL[k]);
  const items = c.items.filter((i) => i.gate === view);
  const openCount = items.filter((i) => !i.done).length;

  return (
    <div className="space-y-4">
      {/* The stepper. A stage the deal is past is filled; the one it's in is ringed. */}
      <ol className="flex items-start">
        {STEPS.map((s, i) => {
          const past = stageIdx > i || deal.stage === "closed";
          const here = stageIdx === i && deal.stage !== "closed";
          const g = c.gates[s];
          const selectable = s !== "closed";
          return (
            <li key={s} className="flex flex-1 items-start last:flex-none">
              <button type="button" disabled={!selectable} onClick={() => selectable && setView(s)}
                className={`group flex min-w-0 flex-col items-center gap-1 text-center ${selectable ? "cursor-pointer" : "cursor-default"}`}>
                <span className={`flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs font-bold transition-colors
                  ${past ? "border-emerald-600 bg-emerald-600 text-white" : here ? "border-blue-600 bg-white text-blue-700" : "border-slate-300 bg-white text-slate-400"}
                  ${view === s ? "ring-4 ring-blue-600/15" : ""}`}>
                  {past ? <Check size={15} strokeWidth={3} /> : i + 1}
                </span>
                <span className={`text-xs font-semibold ${here ? "text-slate-900" : "text-slate-500"}`}>{GATE_LABEL[s]}</span>
                {g && g.total > 0 && <span className="text-[11px] tabular-nums text-slate-400">{g.done}/{g.total}</span>}
              </button>
              {i < STEPS.length - 1 && <span className={`mx-1 mt-4 h-0.5 flex-1 ${past ? "bg-emerald-600" : "bg-slate-200"}`} />}
            </li>
          );
        })}
      </ol>

      <div>
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <span className="text-sm font-semibold text-slate-900">
            {view === c.currentGate ? "To do before " : ""}{GATE_LABEL[view]}{view === c.currentGate ? ` is done` : ""}
          </span>
          <span className="text-xs text-slate-500">{openCount ? `${openCount} open` : "all done"}</span>
        </div>
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {items.map((it) => (
            <li key={it.id} className="group flex items-center gap-3 px-3 py-2">
              <button type="button" disabled={busy} aria-label={it.done ? `Mark "${it.label}" not done` : `Mark "${it.label}" done`}
                onClick={() => edit({ id: it.id, done: !it.done })}
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 transition-colors
                  ${it.done ? "border-emerald-600 bg-emerald-600 text-white" : "border-slate-300 hover:border-blue-500"}`}>
                {it.done && <Check size={12} strokeWidth={3} />}
              </button>
              <span className={`min-w-0 flex-1 text-sm ${it.done ? "text-slate-400 line-through" : "text-slate-800"}`}>
                {it.label}
                {it.note && <span className="block text-xs text-slate-500 no-underline">{it.note}</span>}
              </span>
              <select value={it.owner} disabled={busy} onChange={(e) => edit({ id: it.id, owner: e.target.value })}
                title="Who owes it"
                className="max-w-[9.5rem] shrink-0 truncate rounded-full border-0 bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 focus:ring-2 focus:ring-blue-500">
                {OWNER_KEYS.map((k) => <option key={k} value={k}>{ownerName(k)}</option>)}
              </select>
              {editDate === it.id ? (
                <input type="date" autoFocus defaultValue={it.dueYmd} disabled={busy}
                  onBlur={(e) => { setEditDate(null); if (e.target.value !== it.dueYmd) edit({ id: it.id, due: e.target.value }); }}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setEditDate(null); }}
                  className="w-36 shrink-0 rounded-md border border-slate-300 px-1.5 py-0.5 text-xs" />
              ) : (
                <button type="button" onClick={() => setEditDate(it.id)} title="Change the date"
                  className={`w-28 shrink-0 rounded-full px-2 py-0.5 text-center text-xs font-medium tabular-nums ${DUE_CLS[it.state]}`}>
                  {it.done ? "done" : dueWords(it) || (it.state === "later" ? "when it gets here" : "set a date")}
                </button>
              )}
              <button type="button" disabled={busy} title="Remove from this deal"
                onClick={() => window.confirm(`Remove "${it.label}" from this deal's checklist?`) && edit({ id: it.id, remove: true })}
                className="shrink-0 rounded p-1 text-slate-300 opacity-0 hover:bg-rose-50 hover:text-rose-600 focus:opacity-100 group-hover:opacity-100">
                <Trash2 size={13} />
              </button>
            </li>
          ))}
          {adding ? (
            <li className="flex items-center gap-2 px-3 py-2">
              <input autoFocus value={adding.label} placeholder="What has to happen" disabled={busy}
                onChange={(e) => setAdding((a) => ({ ...a, label: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Escape") setAdding(null); }}
                className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none" />
              <select value={adding.owner} onChange={(e) => setAdding((a) => ({ ...a, owner: e.target.value }))}
                className="rounded-md border border-slate-300 px-1.5 py-1 text-xs">
                {OWNER_KEYS.map((k) => <option key={k} value={k}>{ownerName(k)}</option>)}
              </select>
              <input type="date" value={adding.due} onChange={(e) => setAdding((a) => ({ ...a, due: e.target.value }))}
                className="w-36 rounded-md border border-slate-300 px-1.5 py-1 text-xs" />
              <button type="button" disabled={busy || !adding.label.trim()}
                onClick={async () => { const r = await edit({ add: { gate: view, ...adding } }); if (r?.ok) setAdding(null); }}
                className="rounded-lg bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-40">Add</button>
            </li>
          ) : (
            <li>
              <button type="button" onClick={() => setAdding({ label: "", owner: "us", due: "" })}
                className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-semibold text-blue-600 hover:bg-slate-50">
                <Plus size={13} /> Add an item to {GATE_LABEL[view]}
              </button>
            </li>
          )}
        </ul>
        {error && <p className="mt-1 text-xs text-rose-700">{error}</p>}
      </div>
    </div>
  );
}
