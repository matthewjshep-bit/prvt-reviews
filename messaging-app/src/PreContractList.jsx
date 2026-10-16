// PreContractList.jsx — what nobody has checked on an offer about to be
// signed (shared/pre-contract.js), on its Today row. Each open item says why
// it's open; "Checked" ticks it by hand when you've looked some other way.

import React, { useState } from "react";
import { runOp } from "./pipeline-ops.js";

const DOT = { ok: "bg-emerald-500", warn: "bg-rose-500", unknown: "bg-amber-400" };

export default function PreContractList({ item, onDone }) {
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const checks = item?.checks || [];
  if (!checks.length) return null;
  async function tick(key) {
    setBusy(key); setNote("");
    try { await runOp("precontract_tick", item, { key }); onDone?.(); }
    catch (e) { setNote(e.message || "That didn't work."); }
    finally { setBusy(""); }
  }
  return (
    <ul aria-label="Before you sign" className="mt-2 space-y-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      {checks.map((c) => (
        <li key={c.key} className="flex items-start gap-2 text-sm">
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[c.state] || DOT.unknown}`} title={c.state} />
          <span className="min-w-0 flex-1">
            <span className={c.state === "ok" ? "text-slate-500" : "font-medium text-slate-800"}>{c.label}</span>
            {c.detail && <span className="text-slate-600"> · {c.detail}</span>}
          </span>
          {c.state !== "ok" && (
            <button type="button" className="shrink-0 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-100"
              disabled={busy === c.key} onClick={() => tick(c.key)}>{busy === c.key ? "…" : "Checked"}</button>
          )}
        </li>
      ))}
      {note && <li className="text-xs text-rose-700">{note}</li>}
    </ul>
  );
}
