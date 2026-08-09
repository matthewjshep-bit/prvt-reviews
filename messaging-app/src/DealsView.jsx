// DealsView.jsx — active deals: offers under signed contract, tracked through
// disposition. Acquisition side = the agent contact already on the offer;
// disposition side = one or more investor contacts (existing GHL contacts)
// evaluating the property until one commits. Stage and investor changes save
// immediately; terms (price / fee / closing / notes) save via the modal.

import React, { useEffect, useRef, useState } from "react";
import { ExternalLink, FileText, Loader2, Pencil, Trash2, X } from "lucide-react";
import { fmtMoney } from "@shared/offer-calc.js";
import {
  addDealInvestor, getOffer, ghlContactUrl, listDeals, removeDeal, removeDealInvestor,
  searchContacts, updateDeal, updateDealInvestor, zillowUrl,
} from "./api.js";
import AssignmentModal from "./AssignmentModal.jsx";

export const DEAL_STAGES = [
  { key: "under_contract", label: "Under contract", cls: "bg-amber-100 text-amber-800" },
  { key: "buyer_found", label: "Buyer found", cls: "bg-blue-100 text-blue-800" },
  { key: "assigned", label: "Assigned", cls: "bg-violet-100 text-violet-800" },
  { key: "closed", label: "Closed", cls: "bg-emerald-100 text-emerald-800" },
  { key: "fell_through", label: "Fell through", cls: "bg-gray-200 text-gray-600" },
];
export const STAGE = Object.fromEntries(DEAL_STAGES.map((s) => [s.key, s]));
const TERMINAL = new Set(["closed", "fell_through"]);

const INVESTOR_STATUSES = ["sent", "evaluating", "passed", "committed"];
const STATUS_DOT = {
  sent: "bg-gray-400",
  evaluating: "bg-blue-500",
  passed: "bg-red-400",
  committed: "bg-emerald-500",
};

export function StagePill({ stage, small }) {
  const s = STAGE[stage] || { label: stage, cls: "bg-gray-100 text-gray-600" };
  return (
    <span className={`rounded-full font-semibold ${s.cls} ${small ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs"}`}>
      {s.label}
    </span>
  );
}

const daysSince = (iso) =>
  iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)) : null;

// yyyy-mm-dd parsed as a LOCAL date (same convention as the contract PDFs) so
// the countdown never drifts a day across timezones.
function closingInfo(ymdStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymdStr || "").trim());
  if (!m) return null;
  const target = new Date(+m[1], +m[2] - 1, +m[3]);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((target - today) / 86400000);
  const label = target.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (days > 0) return { label, sub: `in ${days}d`, overdue: false };
  if (days === 0) return { label, sub: "today", overdue: false };
  return { label, sub: `${-days}d overdue`, overdue: true };
}

const shortDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";

function InvestorChips({ deal }) {
  const inv = deal.investors || [];
  if (!inv.length) return <span className="text-xs text-gray-400">none yet</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {inv.map((i) => (
        <span key={i.contactId} title={`${i.name} — ${i.status}`}
          className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${
            i.status === "committed" ? "bg-emerald-100 text-emerald-800" : "bg-gray-100 text-gray-700"
          }`}>
          <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[i.status] || "bg-gray-400"}`} />
          {i.name}
        </span>
      ))}
    </span>
  );
}

// Typeahead over existing GHL contacts — same debounced pattern as NewOffer's
// ContactPicker, trimmed down to add-investor.
function InvestorPicker({ existingIds, onPick, busy }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    clearTimeout(timer.current);
    if (!query.trim() || query.trim().length < 2) {
      setResults([]);
      return;
    }
    timer.current = setTimeout(() => {
      setSearching(true);
      searchContacts(query.trim())
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(timer.current);
  }, [query]);

  return (
    <div className="relative">
      <input
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Add investor — search your GHL contacts…"
        disabled={busy}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none disabled:opacity-60"
      />
      {searching && <Loader2 size={14} className="absolute right-3 top-3 animate-spin text-gray-400" />}
      {open && results.length > 0 && (
        <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
          {results.map((c) => {
            const linked = existingIds.has(c.id);
            return (
              <button key={c.id} type="button" disabled={linked}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onPick(c); setQuery(""); setResults([]); setOpen(false); }}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-gray-50 disabled:opacity-50">
                <span>
                  <span className="font-medium">{c.name || "(no name)"}</span>
                  <span className="ml-2 text-xs text-gray-500">{[c.phone, c.email].filter(Boolean).join(" · ")}</span>
                </span>
                {linked && <span className="text-[11px] text-gray-400">linked</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DealModal({ offer, settings, onClose, onUpdated, onRemoved, onAssignment, onEdit }) {
  const deal = offer.deal;
  const [terms, setTerms] = useState(() => ({
    contractPrice: deal.contractPrice ?? "",
    assignmentFee: deal.assignmentFee ?? "",
    closingDate: deal.closingDate || "",
    notes: deal.notes || "",
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const termsDirty =
    String(terms.contractPrice) !== String(deal.contractPrice ?? "") ||
    String(terms.assignmentFee) !== String(deal.assignmentFee ?? "") ||
    terms.closingDate !== (deal.closingDate || "") ||
    terms.notes !== (deal.notes || "");

  async function run(fn) {
    setError("");
    setBusy(true);
    try {
      const r = await fn();
      if (r?.offer) onUpdated(r.offer);
      return r;
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const setStage = (stage) => {
    if (stage === deal.stage) return;
    let extra = {};
    if (stage === "fell_through") {
      const reason = window.prompt("Why did it fall through? (optional — saved for your KPIs)", deal.fellThroughReason || "");
      if (reason === null) return; // cancelled
      extra = { fellThroughReason: reason };
    }
    run(() => updateDeal(offer.id, { stage, ...extra }));
  };

  const saveTerms = () => run(() => updateDeal(offer.id, terms));

  const removeThisDeal = async () => {
    if (!window.confirm("Remove deal tracking from this offer? The offer itself is kept.")) return;
    const r = await run(() => removeDeal(offer.id));
    if (r?.ok) onRemoved(offer.id);
  };

  const investorIds = new Set((deal.investors || []).map((i) => i.contactId));
  const inputCls = "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none";
  const labelCls = "mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500";

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8" onClick={onClose}>
      <div className="w-full max-w-3xl rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <div className="text-lg font-bold">
              {offer.address || "Deal"}
              {offer.address && (
                <a href={zillowUrl(offer.address)} target="_blank" rel="noreferrer"
                  className="ml-2 align-middle text-xs font-medium text-blue-700 underline hover:text-blue-900">
                  Zillow ↗
                </a>
              )}
            </div>
            <div className="text-sm text-gray-500">
              Agent:{" "}
              {offer.contactId ? (
                <a href={ghlContactUrl(offer.contactId)} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 text-gray-700 underline hover:text-gray-900">
                  {offer.contactName || offer.contactId} <ExternalLink size={12} />
                </a>
              ) : (
                offer.contactName || "—"
              )}
              {" · "}under contract since {shortDate(deal.createdAt)}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {busy && <Loader2 size={16} className="animate-spin text-gray-400" />}
            <button type="button" onClick={() => onEdit?.(offer)}
              className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-semibold hover:bg-gray-50"
              title="Open this offer in the editor — rehab scope, comps, document">
              <Pencil size={14} /> Open offer
            </button>
            <button type="button" onClick={onClose} className="rounded p-1.5 text-gray-400 hover:bg-gray-100">
              <X size={18} />
            </button>
          </div>
        </div>

        {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        {/* Stage */}
        <div className="mb-4">
          <span className={labelCls}>Stage</span>
          <div className="flex flex-wrap gap-1.5">
            {DEAL_STAGES.map((s) => (
              <button key={s.key} type="button" disabled={busy} onClick={() => setStage(s.key)}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                  deal.stage === s.key ? s.cls + " ring-2 ring-gray-900/20" : "bg-gray-50 text-gray-500 hover:bg-gray-100"
                }`}>
                {s.label}
              </button>
            ))}
          </div>
          {deal.stage === "fell_through" && deal.fellThroughReason && (
            <div className="mt-1.5 text-xs text-gray-500">Reason: {deal.fellThroughReason}</div>
          )}
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          {/* Terms */}
          <div className="space-y-3">
            <div>
              <span className={labelCls}>Contract price</span>
              <input className={inputCls} value={terms.contractPrice} placeholder="$"
                onChange={(e) => setTerms((t) => ({ ...t, contractPrice: e.target.value }))} />
            </div>
            <div>
              <span className={labelCls}>Assignment fee</span>
              <input className={inputCls} value={terms.assignmentFee} placeholder={`$ — e.g. ${fmtMoney(settings?.wholesaleFee || 15000)}`}
                onChange={(e) => setTerms((t) => ({ ...t, assignmentFee: e.target.value }))} />
            </div>
            <div>
              <span className={labelCls}>Closing date</span>
              <input type="date" className={inputCls} value={terms.closingDate}
                onChange={(e) => setTerms((t) => ({ ...t, closingDate: e.target.value }))} />
            </div>
            <div>
              <span className={labelCls}>Notes</span>
              <textarea rows={3} className={inputCls} value={terms.notes} placeholder="Deal notes…"
                onChange={(e) => setTerms((t) => ({ ...t, notes: e.target.value }))} />
            </div>
            {termsDirty && (
              <button type="button" onClick={saveTerms} disabled={busy}
                className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-60">
                Save terms
              </button>
            )}
          </div>

          {/* Investors + timeline + documents */}
          <div className="space-y-4">
            <div>
              <span className={labelCls}>Disposition investors</span>
              <div className="space-y-1.5">
                {(deal.investors || []).map((i) => (
                  <div key={i.contactId} className="flex items-center justify-between gap-2 rounded-lg bg-gray-50 px-2.5 py-1.5">
                    <a href={ghlContactUrl(i.contactId)} target="_blank" rel="noreferrer"
                      className="inline-flex min-w-0 items-center gap-1 text-sm font-medium underline decoration-gray-300 underline-offset-2 hover:text-gray-900">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[i.status] || "bg-gray-400"}`} />
                      <span className="truncate">{i.name}</span> <ExternalLink size={11} className="shrink-0 text-gray-400" />
                    </a>
                    <span className="flex shrink-0 items-center gap-1">
                      <select value={i.status} disabled={busy}
                        onChange={(e) => run(() => updateDealInvestor(offer.id, i.contactId, e.target.value))}
                        className="rounded-md border border-gray-300 px-1.5 py-1 text-xs focus:border-gray-900 focus:outline-none">
                        {INVESTOR_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                      <button type="button" disabled={busy} title="Unlink investor"
                        onClick={() => run(() => removeDealInvestor(offer.id, i.contactId))}
                        className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600">
                        <X size={14} />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-2">
                <InvestorPicker existingIds={investorIds} busy={busy}
                  onPick={(c) => run(() => addDealInvestor(offer.id, { contactId: c.id, name: c.name }))} />
              </div>
              <div className="mt-1 text-[11px] text-gray-400">
                Set an investor to <span className="font-semibold">committed</span> when they take the deal —
                the stage advances to Buyer found automatically.
              </div>
            </div>

            <div>
              <span className={labelCls}>Timeline</span>
              <div className="space-y-0.5 text-xs text-gray-600">
                {(deal.stageHistory || []).map((h, idx) => (
                  <div key={idx} className="flex justify-between gap-3">
                    <span>{STAGE[h.stage]?.label || h.stage}</span>
                    <span className="text-gray-400">{shortDate(h.ts)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {offer.contractPdfUrl && (
                <a href={offer.contractPdfUrl} target="_blank" rel="noreferrer"
                  className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold hover:bg-gray-50">
                  <FileText size={13} /> Contract PDF
                </a>
              )}
              {offer.assignmentPdfUrl && (
                <a href={offer.assignmentPdfUrl} target="_blank" rel="noreferrer"
                  className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold hover:bg-gray-50">
                  <FileText size={13} /> Assignment PDF
                </a>
              )}
              <button type="button" onClick={() => onAssignment(offer)}
                className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold hover:bg-gray-50"
                title="Generate or update the assignment of contract for the committed buyer">
                <FileText size={13} /> {offer.assignmentPdfUrl ? "Update assignment" : "Generate assignment"}
              </button>
            </div>

            <button type="button" onClick={removeThisDeal} disabled={busy}
              className="flex items-center gap-1.5 text-xs font-medium text-gray-400 hover:text-red-600">
              <Trash2 size={13} /> Remove deal tracking (keeps the offer)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function DealsView({ settings, onEdit }) {
  const [deals, setDeals] = useState(null);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const [assigning, setAssigning] = useState(null);

  useEffect(() => {
    listDeals().then(setDeals).catch((e) => setError(e.message));
  }, []);

  const patchDeal = (updated) => {
    setDeals((list) => (list || []).map((o) => (o.id === updated.id ? updated : o)));
    setAssigning((o) => (o && o.id === updated.id ? updated : o));
  };
  const dropDeal = (id) => {
    setDeals((list) => (list || []).filter((o) => o.id !== id));
    setSelectedId(null);
  };

  // The deals list is served without the fat calc/snapshot blobs — fetch the
  // full offer before handing it to the editor (rehab scope, comps, form state).
  const openOffer = (o) => {
    getOffer(o.id)
      .then((full) => onEdit?.(full || o))
      .catch(() => onEdit?.(o));
  };

  if (error) return <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>;
  if (!deals) return <div className="flex justify-center p-10"><Loader2 className="animate-spin text-gray-400" /></div>;

  const active = deals.filter((o) => !TERMINAL.has(o.deal.stage));
  const closed = deals.filter((o) => o.deal.stage === "closed");
  const fell = deals.filter((o) => o.deal.stage === "fell_through");
  const feesCollected = closed.reduce((s, o) => s + (Number(o.deal.assignmentFee) || 0), 0);
  const decided = closed.length + fell.length;
  const shown = showTerminal ? deals : active;
  const selected = selectedId ? deals.find((o) => o.id === selectedId) : null;

  const kpis = [
    { label: "Active deals", value: active.length },
    { label: "Closed", value: closed.length },
    { label: "Fees collected", value: feesCollected ? fmtMoney(feesCollected) : "—" },
    { label: "Fall-through", value: decided ? `${Math.round((fell.length / decided) * 100)}%` : "—" },
  ];

  return (
    <>
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.label} className="rounded-xl border border-gray-200 bg-white px-3 py-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{k.label}</div>
            <div className="text-lg font-bold">{k.value}</div>
          </div>
        ))}
      </div>

      {deals.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-400">
          No deals yet — when an offer gets an accepted contract, open History and hit
          <span className="mx-1 font-semibold text-gray-500">Mark under contract</span>.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                  <th className="px-4 py-2.5">Property</th>
                  <th className="px-4 py-2.5">Agent</th>
                  <th className="px-4 py-2.5">Stage</th>
                  <th className="px-4 py-2.5">Investors</th>
                  <th className="px-4 py-2.5 text-right">Contract</th>
                  <th className="px-4 py-2.5 text-right">Fee</th>
                  <th className="px-4 py-2.5">Closing</th>
                  <th className="px-4 py-2.5 text-right">In stage</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {shown.map((o) => {
                  const d = o.deal;
                  const closing = closingInfo(d.closingDate);
                  const lastTs = d.stageHistory?.[d.stageHistory.length - 1]?.ts || d.createdAt;
                  return (
                    <tr key={o.id} onClick={() => setSelectedId(o.id)}
                      className="group cursor-pointer border-b border-gray-100 last:border-0 hover:bg-gray-50">
                      <td className="max-w-[14rem] truncate px-4 py-2.5 font-medium">{o.address || "—"}</td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        {o.contactId ? (
                          <a href={ghlContactUrl(o.contactId)} target="_blank" rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1 underline decoration-gray-300 underline-offset-2 hover:text-gray-900"
                            title="Open contact in GHL">
                            {o.contactName || o.contactId} <ExternalLink size={12} className="text-gray-400" />
                          </a>
                        ) : (o.contactName || "—")}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5"><StagePill stage={d.stage} /></td>
                      <td className="px-4 py-2.5"><InvestorChips deal={d} /></td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right font-semibold">
                        {d.contractPrice ? fmtMoney(d.contractPrice) : "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right font-semibold text-emerald-700">
                        {d.assignmentFee ? fmtMoney(d.assignmentFee) : "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        {closing ? (
                          <span className={closing.overdue && !TERMINAL.has(d.stage) ? "font-semibold text-red-600" : ""}>
                            {closing.label}
                            <span className="ml-1 text-xs text-gray-400">{TERMINAL.has(d.stage) ? "" : closing.sub}</span>
                          </span>
                        ) : <span className="text-gray-400">—</span>}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right text-gray-500">
                        {daysSince(lastTs)}d
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                        <button type="button" onClick={() => setSelectedId(o.id)}
                          className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-2.5 py-1 text-xs font-semibold text-gray-700 opacity-0 hover:bg-gray-50 group-hover:opacity-100">
                          <Pencil size={13} /> Manage
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {(closed.length > 0 || fell.length > 0) && (
            <button type="button" onClick={() => setShowTerminal((v) => !v)}
              className="mt-2 text-xs font-medium text-gray-500 underline decoration-gray-300 underline-offset-2 hover:text-gray-900">
              {showTerminal ? "Hide" : "Show"} closed & fell-through ({closed.length + fell.length})
            </button>
          )}
        </>
      )}

      {selected && (
        <DealModal offer={selected} settings={settings}
          onClose={() => setSelectedId(null)}
          onUpdated={patchDeal}
          onRemoved={dropDeal}
          onAssignment={(o) => setAssigning(o)}
          onEdit={openOffer} />
      )}
      {assigning && (
        <AssignmentModal offer={assigning} settings={settings}
          onClose={() => setAssigning(null)}
          onGenerated={patchDeal} />
      )}
    </>
  );
}
