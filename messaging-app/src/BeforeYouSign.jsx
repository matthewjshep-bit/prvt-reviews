// BeforeYouSign.jsx — what nobody has checked on an offer about to be signed
// (shared/pre-contract.js), on the offer side of the pane (2026-10-21).
//
// 1538 NW 61st St and 3831 Bagley Ave N were both signed with every warning
// open: the warnings were on Today, and Today was gone. This shows only while
// the offer is close to paper (needsPreContract) — a yes, a write-up, the
// agent's paperwork — warnings first. Advisory: it never blocks anything, and
// "Checked" closes an item you looked at some other way.

import React, { useState } from "react";
import { AlertTriangle, Check, CircleHelp } from "lucide-react";
import { needsPreContract } from "@shared/pre-contract.js";
import { getPreContract, tickPreContract } from "./api.js";
import { forget, useLoad } from "./work-data.js";

export const preContractKey = (offerId) => (offerId ? `precontract:${offerId}` : null);
const RANK = { warn: 0, unknown: 1, ok: 2 };

/** openFirst(checks) → the open items, warnings first. */
export const openFirst = (checks = []) => (checks || []).filter((c) => c && c.state !== "ok").sort((a, b) => (RANK[a.state] ?? 3) - (RANK[b.state] ?? 3));

/**
 * <BeforeYouSign offer checks />
 *   offer   the full offer document (needsPreContract decides whether it shows)
 *   checks  tests only: the checks, in place of GET /:id/precontract
 */
export default function BeforeYouSign({ offer, checks: given = null }) {
  const show = Boolean(offer?.id) && needsPreContract(offer);
  const key = show && !given ? preContractKey(offer.id) : null;
  const ld = useLoad(key, () => getPreContract(offer.id), { maxAgeMs: 60000 });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  if (!show) return null;
  const checks = given || ld.data?.checks || [];
  const open = openFirst(checks);
  const warns = open.filter((c) => c.state === "warn").length;

  async function tick(c) {
    setBusy(c.key);
    setError("");
    try { await tickPreContract(offer.id, c.key); forget(key); ld.reload(); }
    catch (e) { setError(e.message); }
    setBusy("");
  }

  return (
    <section aria-label="Before you sign" className={`mx-4 mt-3 rounded-lg border px-3 py-2.5 ${warns ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-slate-50"}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-600">Before you sign</h3>
        <span className="text-[11px] text-slate-500">
          {ld.loading && !given ? "reading the agent's texts…" : warns ? `${warns} warning${warns === 1 ? "" : "s"}` : open.length ? `${open.length} not checked` : "all checked"}
        </span>
      </div>
      {open.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {open.map((c) => (
            <li key={c.key} className="flex items-start gap-2 text-xs">
              {c.state === "warn"
                ? <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-600" aria-label="warning" />
                : <CircleHelp size={13} className="mt-0.5 shrink-0 text-slate-400" aria-label="not checked" />}
              <span className="min-w-0 flex-1">
                <span className="font-semibold text-slate-800">{c.label}</span>
                {c.detail ? <span className="text-slate-600"> — {c.detail}</span> : null}
              </span>
              <button type="button" disabled={busy === c.key} onClick={() => tick(c)}
                className="inline-flex shrink-0 items-center gap-1 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-40"
                title="You checked it some other way (a call, a walkthrough, the agent remarks)">
                <Check size={11} /> Checked
              </button>
            </li>
          ))}
        </ul>
      )}
      {warns > 0 && (
        <p className="mt-2 text-[11px] text-slate-600">Ask for a feasibility period with the earnest money due after it, or don't sign.</p>
      )}
      {(error || ld.error) && <p className="mt-1 text-[11px] text-red-600">{error || ld.error}</p>}
    </section>
  );
}

/**
 * confirmSigned(offerId) → true to go ahead
 *
 * "Mark under contract" asks once when something is still a warning, and
 * says what. It never stops you: OK promotes. A read that fails asks nothing.
 */
export async function confirmSigned(offerId, { read = getPreContract, ask = (msg) => window.confirm(msg) } = {}) {
  let checks = [];
  try { checks = (await read(offerId))?.checks || []; } catch { return true; }
  const warns = (checks || []).filter((c) => c?.state === "warn");
  if (!warns.length) return true;
  const lines = warns.slice(0, 6).map((c) => `• ${c.label}: ${c.detail || ""}`.slice(0, 180));
  return ask(`Before you sign — ${warns.length} warning${warns.length === 1 ? "" : "s"}:\n\n${lines.join("\n")}\n\nMark it under contract anyway?`);
}

