import React, { useState } from "react";
import { KeyRound } from "lucide-react";
import { OCCUPANCY, OCCUPANCY_LABEL, ACCESS_METHODS, ACCESS_METHOD_LABEL, accessFor } from "@shared/deal-access.js";
import { updateDeal } from "./api.js";
import { BTN_PRIMARY } from "./ui.jsx";

const inputCls = "w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:border-blue-500 focus:outline-none";

/**
 * Whether anyone lives in the house and how buyers get in
 * (shared/deal-access.js). The investor bot says exactly this about the house
 * and nothing more — Rajesh Kasturi was told "it's open right now" about a
 * house nobody had said was open.
 */
export default function DealAccess({ offer, onUpdated }) {
  const saved = accessFor(offer.deal);
  const [a, setA] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty = JSON.stringify(a) !== JSON.stringify(saved);
  const lived = a.occupancy === "owner_occupied" || a.occupancy === "tenant_occupied";

  async function save() {
    setError(""); setBusy(true);
    try {
      const r = await updateDeal(offer.id, { access: a });
      if (r?.offer) { onUpdated(r.offer); setA(accessFor(r.offer.deal)); }
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-2">
      <span className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
        <KeyRound size={13} aria-hidden="true" /> Access
      </span>
      <div className="space-y-3 rounded-lg border border-slate-200 p-3">
        <div>
          <span className="mb-1 block text-xs text-slate-500">Occupancy</span>
          <div role="radiogroup" aria-label="Occupancy" className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {OCCUPANCY.map((o) => (
              <button key={o || "unset"} type="button" role="radio" aria-checked={a.occupancy === o} onClick={() => setA((x) => ({ ...x, occupancy: o }))}
                className={`rounded-lg border px-2 py-1.5 text-xs font-semibold transition-colors ${a.occupancy === o ? "border-blue-600 bg-blue-50 text-blue-800" : "border-slate-200 text-slate-600 hover:border-slate-300"}`}>
                {o ? OCCUPANCY_LABEL[o] : "Not sure"}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-[1fr_auto] items-end gap-2">
          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">How buyers get in</span>
            <select value={a.method} onChange={(e) => setA((x) => ({ ...x, method: e.target.value }))} className={inputCls}>
              {ACCESS_METHODS.map((m) => <option key={m || "unset"} value={m}>{ACCESS_METHOD_LABEL[m]}</option>)}
            </select>
          </label>
          <label className="block w-28">
            <span className="mb-1 block text-xs text-slate-500">Notice</span>
            <span className="flex items-center gap-1">
              <input type="number" min="0" max="168" className={inputCls} value={a.noticeHours || ""} placeholder={lived ? "24" : "0"}
                onChange={(e) => setA((x) => ({ ...x, noticeHours: Number(e.target.value) || 0 }))} />
              <span className="text-xs text-slate-500">h</span>
            </span>
          </label>
        </div>
        <input className={inputCls} value={a.note} placeholder="Private: lockbox code, tenant's name, showing service…"
          onChange={(e) => setA((x) => ({ ...x, note: e.target.value }))} />
        <p className="text-xs text-slate-500">
          {!a.occupancy && !a.method
            ? "Not recorded, so the bot tells buyers you'll confirm access and never says it's open or vacant."
            : lived
              ? "The bot tells buyers someone lives there: no drive-bys, no knocking, only at a set time."
              : "The bot says only what's set here. The private note is never shown to it."}
        </p>
        {dirty && <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={save}>Save access</button>}
        {error && <p className="text-xs text-rose-700">{error}</p>}
      </div>
    </div>
  );
}
