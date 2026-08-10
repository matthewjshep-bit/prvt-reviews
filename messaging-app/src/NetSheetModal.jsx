// NetSheetModal.jsx — the Seller Net Comparison one-pager for one offer: our
// cash offer (no buyer's-agent commission) vs. the list price a traditional
// sale needs to gross for the seller to net the same amount. Renders the
// branded PDF server-side and drafts a ready-to-paste message for the agent.
// Regenerating rehydrates the last-used percentages from offer.netSheet.fields.

import React, { useEffect, useState } from "react";
import { Check, Copy, FileText, Loader2, X } from "lucide-react";
import { fmtMoney, netComparison } from "@shared/offer-calc.js";
import { generateNetSheet } from "./api.js";

const INPUT_CLS =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none";
const LABEL_CLS = "mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500";

const round100 = (v) => Math.round(v / 100) * 100;

function buildMessage(offer, net) {
  const first = (offer.contactName || "").split(" ")[0] || "there";
  const addr = offer.address || "the property";
  return (
    `Hi ${first} — here's our written cash offer on ${addr}: ${fmtMoney(offer.cashAmount)}, ` +
    `as-is, closing on your timeline (attached).\n\n` +
    `Worth framing it this way: we're buying directly, so no buyer's-agent commission comes off the top. ` +
    `At our offer the seller nets about ${fmtMoney(Math.round(net.netA))} after the listing side's ${net.sellerPct}%. ` +
    `To net that same amount through a traditional sale paying both agents (${net.sellerPct}% + ${net.buyerPct}%), ` +
    `it would need to sell at roughly ${fmtMoney(round100(net.listPrice))} — and that's before repairs, ` +
    `holding costs, or time on market.\n\n` +
    `Happy to walk through any of it.`
  );
}

export default function NetSheetModal({ offer, settings, onClose, onGenerated }) {
  const saved = offer.netSheet?.fields || null;
  const [fields, setFields] = useState(() => ({
    sellerAgentPct: saved?.sellerAgentPct ?? settings?.sellerAgentPct ?? 3,
    buyerAgentPct: saved?.buyerAgentPct ?? settings?.buyerAgentPct ?? 3,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pdfUrl, setPdfUrl] = useState(offer.netSheetPdfUrl || "");
  const [copied, setCopied] = useState(false);

  const net = netComparison(offer.cashAmount, fields);

  // The draft message follows the percentages until the user edits it.
  const [message, setMessage] = useState(() => (net ? buildMessage(offer, net) : ""));
  const [msgDirty, setMsgDirty] = useState(false);
  useEffect(() => {
    if (!msgDirty && net) setMessage(buildMessage(offer, net));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields.sellerAgentPct, fields.buyerAgentPct]);

  const patch = (k) => (e) => setFields((f) => ({ ...f, [k]: e.target.value }));

  async function doGenerate() {
    setError("");
    setBusy(true);
    try {
      const r = await generateNetSheet(offer.id, fields);
      setPdfUrl(r.offer.netSheetPdfUrl);
      onGenerated?.(r.offer);
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  }

  function copyMessage() {
    navigator.clipboard?.writeText(message).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <div className="text-lg font-bold">Seller net comparison</div>
            <div className="text-sm text-slate-500">
              {offer.address || "Offer"} · {fmtMoney(offer.cashAmount)} cash
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1.5 text-slate-400 hover:bg-slate-100">
            <X size={18} />
          </button>
        </div>

        {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <span className={LABEL_CLS}>Seller's agent commission</span>
            <input className={INPUT_CLS} inputMode="decimal" value={fields.sellerAgentPct} onChange={patch("sellerAgentPct")} placeholder="3" />
          </div>
          <div>
            <span className={LABEL_CLS}>Buyer's agent commission</span>
            <input className={INPUT_CLS} inputMode="decimal" value={fields.buyerAgentPct} onChange={patch("buyerAgentPct")} placeholder="3" />
          </div>
        </div>

        {net ? (
          <div className="mt-3 rounded-xl bg-slate-50 p-3 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-slate-500">Our cash offer, minus the listing side's {net.sellerPct}%</span>
              <span className="font-semibold tabular-nums">nets {fmtMoney(Math.round(net.netA))}</span>
            </div>
            <div className="mt-1 flex justify-between gap-4">
              <span className="text-slate-500">Traditional sale paying both agents must gross</span>
              <span className="font-semibold tabular-nums">{fmtMoney(Math.round(net.listPrice))}</span>
            </div>
            <div className="mt-1 flex justify-between gap-4 border-t border-slate-200 pt-1">
              <span className="text-slate-500">Extra price needed just to match our net</span>
              <span className="font-bold tabular-nums text-emerald-700">{fmtMoney(Math.round(net.listPrice - net.offer))}</span>
            </div>
          </div>
        ) : (
          <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Enter commission percentages under 100% (and the offer needs a positive amount).
          </div>
        )}

        <div className="mt-4">
          <div className="mb-1 flex items-center justify-between">
            <span className={`${LABEL_CLS} mb-0`}>Message to send with it</span>
            <span className="flex items-center gap-2">
              {msgDirty && net && (
                <button type="button" className="text-xs font-medium text-slate-500 underline hover:text-slate-800"
                  onClick={() => { setMsgDirty(false); setMessage(buildMessage(offer, net)); }}>
                  Reset to suggested
                </button>
              )}
              <button type="button" onClick={copyMessage}
                className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-semibold hover:bg-slate-50">
                {copied ? <Check size={13} className="text-emerald-600" /> : <Copy size={13} />}
                {copied ? "Copied" : "Copy"}
              </button>
            </span>
          </div>
          <textarea rows={7} className={INPUT_CLS} value={message}
            onChange={(e) => { setMsgDirty(true); setMessage(e.target.value); }} />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" onClick={doGenerate} disabled={busy || !net}
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />}
            {pdfUrl ? "Regenerate PDF" : "Generate PDF"}
          </button>
          {pdfUrl && !busy && (
            <a href={pdfUrl} target="_blank" rel="noreferrer"
              className="flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold hover:bg-slate-50">
              <FileText size={16} /> Open net comparison PDF
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
