// DealsView.jsx — active deals: offers under signed contract, tracked through
// disposition. Acquisition side = the agent contact already on the offer;
// disposition side = one or more investor contacts (existing GHL contacts)
// evaluating the property until one commits. Stage and investor changes save
// immediately; terms (price / fee / inspection / closing / notes) save via the modal.

import React, { useEffect, useRef, useState } from "react";
import {
  ExternalLink, FileText, Loader2, Lock, Paperclip, Pencil, Sparkles, Target, Trash2, Upload, X,
} from "lucide-react";
import { fmtMoney } from "@shared/offer-calc.js";
import {
  addDealInvestor, dealDocUrl, deleteDealDoc, getOffer, ghlContactUrl, listDealDocs, listDeals,
  removeDeal, removeDealInvestor, searchContacts, suggestInvestors, updateDeal, updateDealInvestor,
  uploadDealDoc, zillowUrl,
} from "./api.js";
import AssignmentModal from "./AssignmentModal.jsx";
import DataroomModal from "./DataroomModal.jsx";
import EnrichModal from "./EnrichModal.jsx";
import MatchInvestorsModal from "./MatchInvestorsModal.jsx";
import {
  DEAL_STAGES, EmptyState, ErrorBar, KpiRow, STAGE, SkeletonRows, StagePill, TableCard,
  rowActivation,
} from "./ui.jsx";

// Stage vocabulary and the pill live in ui.jsx so History can render a stage
// without importing from a sibling view. Re-exported here for the modules that
// already reach for them through DealsView.
export { DEAL_STAGES, STAGE, StagePill };
const TERMINAL = new Set(["closed", "fell_through"]);

const INVESTOR_STATUSES = ["sent", "evaluating", "passed", "committed"];
const STATUS_DOT = {
  sent: "bg-slate-400",
  evaluating: "bg-blue-500",
  passed: "bg-red-400",
  committed: "bg-emerald-500",
};

// Display order everywhere investors are listed: hottest first, passed last,
// alphabetical within a status so the list is stable as statuses change.
const STATUS_ORDER = { committed: 0, evaluating: 1, sent: 2, passed: 3 };
const sortInvestors = (list) =>
  [...(list || [])].sort((a, b) =>
    (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
    String(a.name || "").localeCompare(String(b.name || "")));

// yyyy-mm-dd parsed as a LOCAL date (same convention as the contract PDFs) so
// the countdown never drifts a day across timezones.
function dateInfo(ymdStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymdStr || "").trim());
  if (!m) return null;
  const target = new Date(+m[1], +m[2] - 1, +m[3]);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((target - today) / 86400000);
  const label = target.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return { label, days };
}

// A closing date in the past is a problem; an inspection date in the past just
// means the contingency has expired.
const closingSub = (days) => (days > 0 ? `in ${days}d` : days === 0 ? "today" : `${-days}d overdue`);
const inspectionSub = (days) => (days > 0 ? `in ${days}d` : days === 0 ? "today" : "ended");

const num = (v) => Number(String(v ?? "").replace(/[$,\s]/g, "")) || 0;
const assignmentTotal = (contractPrice, assignmentFee) => num(contractPrice) + num(assignmentFee);

const shortDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";

// Deliberately NOT a list of names: on a deal that's been blasted to twenty
// buyers the chips were taller than the row itself. The overview answers "how
// far along is disposition", the modal answers "who, exactly".
function InvestorSummary({ deal }) {
  const inv = deal.investors || [];
  if (!inv.length) return <span className="text-xs text-slate-400">none yet</span>;
  const live = inv.filter((i) => i.status !== "passed").length;
  const committed = inv.some((i) => i.status === "committed");
  return (
    <span title={sortInvestors(inv).map((i) => `${i.name} — ${i.status}`).join("\n")}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${
        committed ? "bg-emerald-100 text-emerald-900" : "bg-slate-100 text-slate-700"
      }`}>
      <span className={`h-1.5 w-1.5 rounded-full ${committed ? STATUS_DOT.committed : STATUS_DOT.sent}`} />
      {committed ? "buyer committed" : `${live} of ${inv.length} live`}
    </span>
  );
}

const DOC_KINDS = [
  "Purchase & sale", "Assignment", "Addendum", "Inspection", "Title", "Photos / other", "Other",
];

const fileSize = (n) =>
  n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

const readAsDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("could not be read"));
    r.readAsDataURL(file);
  });

// Files that live with the deal rather than with the offer: the signed purchase
// & sale, addenda, title work, inspection reports. Fetched on open instead of
// riding along on the deals list — most deals are never opened, and the list
// endpoint is deliberately lean.
function DealDocuments({ offerId }) {
  const [docs, setDocs] = useState(null);
  const [kind, setKind] = useState(DOC_KINDS[0]);
  const [uploading, setUploading] = useState(null); // null | { done, total }
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    let live = true;
    listDealDocs(offerId)
      .then((d) => { if (live) setDocs(d); })
      .catch((e) => { if (live) { setError(e.message); setDocs([]); } });
    return () => { live = false; };
  }, [offerId]);

  // One file per request, and each result replaces the whole list — so a
  // failure halfway through a batch still leaves what did land on screen.
  async function addFiles(list) {
    const files = [...(list || [])];
    if (!files.length) return;
    setError("");
    setUploading({ done: 0, total: files.length });
    const failed = [];
    for (const [i, file] of files.entries()) {
      try {
        setDocs(await uploadDealDoc(offerId, { name: file.name, kind, data: await readAsDataUrl(file) }));
      } catch (e) {
        failed.push(`${file.name} — ${e.message}`);
      }
      setUploading({ done: i + 1, total: files.length });
    }
    setUploading(null);
    if (failed.length) setError(failed.join(" · "));
  }

  async function remove(doc) {
    if (!window.confirm(`Delete "${doc.name}"? This can't be undone.`)) return;
    setError("");
    try {
      setDocs(await deleteDealDoc(offerId, doc.id));
    } catch (e) {
      setError(e.message);
    }
  }

  const busy = Boolean(uploading);

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Documents</span>
        {uploading && (
          <span className="text-[11px] text-slate-500">Uploading {uploading.done}/{uploading.total}…</span>
        )}
      </div>

      {docs === null ? (
        <div className="flex justify-center py-3"><Loader2 size={16} className="animate-spin text-slate-400" /></div>
      ) : (
        <>
          {docs.length > 0 && (
            <div className="mb-2 space-y-1.5">
              {docs.map((d) => (
                <div key={d.id} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5">
                  <a href={dealDocUrl(offerId, d.id)} target="_blank" rel="noreferrer"
                    className="inline-flex min-w-0 items-center gap-1.5" title={`Open ${d.name}`}>
                    <FileText size={13} className="shrink-0 text-slate-400" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium underline decoration-slate-300 underline-offset-2">
                        {d.name}
                      </span>
                      <span className="block text-[11px] text-slate-500">
                        {d.kind} · {fileSize(d.size)} · {shortDate(d.createdAt)}
                      </span>
                    </span>
                  </a>
                  <button type="button" title="Delete this document" onClick={() => remove(d)}
                    className="shrink-0 rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600">
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* The kind is stamped at upload time — pick it first, then drop the
              files in. Re-labelling later is delete + re-upload, on purpose:
              these are signed originals, not a filing cabinet to reorganize. */}
          <div
            onDragOver={(e) => { e.preventDefault(); if (!busy) setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (!busy) addFiles(e.dataTransfer?.files);
            }}
            className={`rounded-lg border border-dashed p-2.5 transition-colors ${
              dragging ? "border-blue-500 bg-blue-50" : "border-slate-300"
            }`}>
            <div className="flex flex-wrap items-center gap-2">
              <select value={kind} onChange={(e) => setKind(e.target.value)} disabled={busy}
                aria-label="Document type"
                className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs focus:border-blue-500 focus:outline-none">
                {DOC_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}
                className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold hover:bg-slate-50 disabled:opacity-60">
                {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                {docs.length ? "Attach more" : "Attach files"}
              </button>
              <input ref={fileRef} type="file" multiple className="hidden"
                accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.doc,.docx,.xls,.xlsx"
                onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
              <span className="text-[11px] text-slate-500">
                {dragging ? "Drop them here" : "or drag them in"}
              </span>
            </div>
          </div>

          {error && <div className="mt-1.5 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{error}</div>}
          {docs.length === 0 && !error && (
            <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-tight text-slate-400">
              <Paperclip size={12} className="mt-px shrink-0" />
              The signed purchase &amp; sale, addenda, title and inspection paperwork. PDF, image or
              Office file, up to 15MB each.
            </p>
          )}
        </>
      )}
    </div>
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
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-60"
      />
      {searching && <Loader2 size={14} className="absolute right-3 top-3 animate-spin text-slate-400" />}
      {open && results.length > 0 && (
        <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          {results.map((c) => {
            const linked = existingIds.has(c.id);
            return (
              <button key={c.id} type="button" disabled={linked}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onPick(c); setQuery(""); setResults([]); setOpen(false); }}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-50 disabled:opacity-50">
                <span>
                  <span className="font-medium">{c.name || "(no name)"}</span>
                  <span className="ml-2 text-xs text-slate-500">{[c.phone, c.email].filter(Boolean).join(" · ")}</span>
                </span>
                {linked && <span className="text-[11px] text-slate-400">linked</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DealModal({ offer, settings, onClose, onUpdated, onRemoved, onAssignment, onDataroom, onEdit, onEnrich }) {
  const deal = offer.deal;
  const [terms, setTerms] = useState(() => ({
    contractPrice: deal.contractPrice ?? "",
    assignmentFee: deal.assignmentFee ?? "",
    closingDate: deal.closingDate || "",
    inspectionDate: deal.inspectionDate || "",
    notes: deal.notes || "",
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [suggest, setSuggest] = useState(null); // null | {busy} | suggest-investors response | {error}
  const [matching, setMatching] = useState(false); // buy-box match modal open
  const termsDirty =
    String(terms.contractPrice) !== String(deal.contractPrice ?? "") ||
    String(terms.assignmentFee) !== String(deal.assignmentFee ?? "") ||
    terms.closingDate !== (deal.closingDate || "") ||
    terms.inspectionDate !== (deal.inspectionDate || "") ||
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

  async function runSuggest() {
    setSuggest({ busy: true });
    try {
      setSuggest(await suggestInvestors(offer.id));
    } catch (e) {
      setSuggest({ error: e.message });
    }
  }

  // Link a suggested investor, then set their AI-suggested status ("committed"
  // auto-advances the stage server-side, same as a manual status change).
  async function addSuggested(s) {
    const r = await run(() => addDealInvestor(offer.id, { contactId: s.contactId, name: s.name }));
    if (!r?.ok) return;
    if (s.status && s.status !== "sent") await run(() => updateDealInvestor(offer.id, s.contactId, s.status));
    setSuggest((v) => (v?.suggestions ? { ...v, suggestions: v.suggestions.filter((x) => x.contactId !== s.contactId) } : v));
  }
  const inputCls = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none";
  const labelCls = "mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500";

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8" onClick={onClose}>
      <div className="w-full max-w-7xl rounded-2xl bg-white p-5 sm:p-7 shadow-xl" onClick={(e) => e.stopPropagation()}>
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
            <div className="text-sm text-slate-500">
              Agent:{" "}
              {offer.contactId ? (
                <a href={ghlContactUrl(offer.contactId)} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 text-slate-700 underline hover:text-slate-900">
                  {offer.contactName || offer.contactId} <ExternalLink size={12} />
                </a>
              ) : (
                offer.contactName || "—"
              )}
              {" · "}under contract since {shortDate(deal.createdAt)}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {busy && <Loader2 size={16} className="animate-spin text-slate-400" />}
            <button type="button" onClick={() => onEdit?.(offer)}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold hover:bg-slate-50"
              title="Open this offer in the editor — rehab scope, comps, document">
              <Pencil size={14} /> Open offer
            </button>
            <button type="button" onClick={onClose} className="rounded p-1.5 text-slate-400 hover:bg-slate-100">
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
                  deal.stage === s.key ? s.cls + " ring-2 ring-blue-600/25" : "bg-slate-50 text-slate-500 hover:bg-slate-100"
                }`}>
                {s.label}
              </button>
            ))}
          </div>
          {deal.stage === "fell_through" && deal.fellThroughReason && (
            <div className="mt-1.5 text-xs text-slate-500">Reason: {deal.fellThroughReason}</div>
          )}
        </div>

        {/* Three lanes on a wide screen — terms, disposition, paperwork — so a
            deal with twenty investors doesn't push the documents off the fold. */}
        <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.15fr)_minmax(0,1fr)]">
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
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <span className={labelCls}>Assignment contract</span>
              <div className="font-semibold tabular-nums">
                {assignmentTotal(terms.contractPrice, terms.assignmentFee)
                  ? fmtMoney(assignmentTotal(terms.contractPrice, terms.assignmentFee))
                  : "—"}
              </div>
              <div className="text-xs text-slate-500">Contract price + fee — what the end buyer pays.</div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className={labelCls}>Inspection ends</span>
                <input type="date" className={inputCls} value={terms.inspectionDate}
                  onChange={(e) => setTerms((t) => ({ ...t, inspectionDate: e.target.value }))} />
              </div>
              <div>
                <span className={labelCls}>Closing date</span>
                <input type="date" className={inputCls} value={terms.closingDate}
                  onChange={(e) => setTerms((t) => ({ ...t, closingDate: e.target.value }))} />
              </div>
            </div>
            <div>
              <span className={labelCls}>Notes</span>
              <textarea rows={3} className={inputCls} value={terms.notes} placeholder="Deal notes…"
                onChange={(e) => setTerms((t) => ({ ...t, notes: e.target.value }))} />
            </div>
            {termsDirty && (
              <button type="button" onClick={saveTerms} disabled={busy}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
                Save terms
              </button>
            )}
          </div>

          {/* Disposition — who the deal is being shopped to */}
          <div className="space-y-4">
            <div>
              <span className={labelCls}>Disposition investors</span>
              <div className="space-y-1.5">
                {sortInvestors(deal.investors).map((i) => (
                  <div key={i.contactId} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5">
                    <a href={ghlContactUrl(i.contactId)} target="_blank" rel="noreferrer"
                      className="inline-flex min-w-0 items-center gap-1 text-sm font-medium underline decoration-slate-300 underline-offset-2 hover:text-slate-900">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[i.status] || "bg-slate-400"}`} />
                      <span className="truncate">{i.name}</span> <ExternalLink size={11} className="shrink-0 text-slate-400" />
                    </a>
                    <span className="flex shrink-0 items-center gap-1">
                      <select value={i.status} disabled={busy}
                        onChange={(e) => run(() => updateDealInvestor(offer.id, i.contactId, e.target.value))}
                        className="rounded-md border border-slate-300 px-1.5 py-1 text-xs focus:border-blue-500 focus:outline-none">
                        {INVESTOR_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                      <button type="button" disabled={busy}
                        title="AI enrichment — summarize the conversation and fill CRM fields"
                        onClick={() => onEnrich?.(i)}
                        className="rounded p-1 text-amber-500 hover:bg-amber-50">
                        <Sparkles size={14} />
                      </button>
                      <button type="button" disabled={busy} title="Unlink investor"
                        onClick={() => run(() => removeDealInvestor(offer.id, i.contactId))}
                        className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600">
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
              <div className="mt-1 text-[11px] text-slate-400">
                Set an investor to <span className="font-semibold">committed</span> when they take the deal —
                the stage advances to Buyer found automatically.
              </div>

              {/* Two different questions, deliberately kept apart: whose buy
                  box FITS this deal (including buyers who've never heard of
                  it), and who is ALREADY talking about it. */}
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" disabled={busy} onClick={() => setMatching(true)}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                  title="Rank your investor book by how well each buy box fits this property">
                  <Target size={13} /> Find buyers
                </button>
                <button type="button" disabled={busy || suggest?.busy} onClick={runSuggest}
                  className="flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-60"
                  title="Scan investor conversations for interest in this property">
                  {suggest?.busy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                  Suggest from conversations
                </button>
              </div>
              <div className="mt-2">
                {suggest?.busy && (
                  <div className="mt-1.5 text-[11px] text-slate-400">
                    Scanning investor conversations for this property — 30–90 seconds…
                  </div>
                )}
                {suggest?.error && (
                  <div className="mt-1.5 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{suggest.error}</div>
                )}
                {suggest?.scopeMissing && (
                  <div className="mt-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
                    Needs the <span className="font-semibold">conversations.readonly</span> scope on the GHL private integration.
                  </div>
                )}
                {suggest?.empty && (
                  <div className="mt-1.5 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600">{suggest.reason}</div>
                )}
                {suggest?.ok && suggest.suggestions.length === 0 && (
                  <div className="mt-1.5 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600">
                    Scanned {suggest.scanned} investor conversation{suggest.scanned === 1 ? "" : "s"} — no one is talking about this property yet.
                  </div>
                )}
                {suggest?.ok && suggest.suggestions.length > 0 && (
                  <div className="mt-1.5 space-y-1.5">
                    {suggest.suggestions.map((s) => (
                      <div key={s.contactId} className="rounded-lg border border-amber-200 bg-amber-50/60 px-2.5 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <a href={ghlContactUrl(s.contactId)} target="_blank" rel="noreferrer"
                            className="inline-flex items-center gap-1 text-sm font-semibold underline decoration-amber-300 underline-offset-2">
                            {s.name} <ExternalLink size={11} className="text-slate-400" />
                          </a>
                          <span className="flex items-center gap-1.5">
                            <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-600">{s.status}</span>
                            <button type="button" disabled={busy} onClick={() => addSuggested(s)}
                              className="rounded-lg bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
                              Add
                            </button>
                          </span>
                        </div>
                        {s.reason && <div className="mt-1 text-[11px] leading-tight text-slate-500">{s.reason}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Paperwork — generated documents, uploaded originals, timeline */}
          <div className="space-y-4">
            <DealDocuments offerId={offer.id} />

            <div>
              <span className={labelCls}>Timeline</span>
              <div className="space-y-0.5 text-xs text-slate-600">
                {(deal.stageHistory || []).map((h, idx) => (
                  <div key={idx} className="flex justify-between gap-3">
                    <span>{STAGE[h.stage]?.label || h.stage}</span>
                    <span className="text-slate-400">{shortDate(h.ts)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {offer.contractPdfUrl && (
                <a href={offer.contractPdfUrl} target="_blank" rel="noreferrer"
                  className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold hover:bg-slate-50">
                  <FileText size={13} /> Contract PDF
                </a>
              )}
              {offer.assignmentPdfUrl && (
                <a href={offer.assignmentPdfUrl} target="_blank" rel="noreferrer"
                  className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold hover:bg-slate-50">
                  <FileText size={13} /> Assignment PDF
                </a>
              )}
              <button type="button" onClick={() => onAssignment(offer)}
                className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold hover:bg-slate-50"
                title="Generate or update the assignment of contract for the committed buyer">
                <FileText size={13} /> {offer.assignmentPdfUrl ? "Update assignment" : "Generate assignment"}
              </button>
              <button type="button" onClick={() => onDataroom(offer)}
                className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold hover:bg-slate-50"
                title="Build a secure investor package and text personal links to your buyers">
                <Lock size={13} /> Investor dataroom
              </button>
            </div>

            <button type="button" onClick={removeThisDeal} disabled={busy}
              className="flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-red-600">
              <Trash2 size={13} /> Remove deal tracking (keeps the offer)
            </button>
          </div>
        </div>
      </div>

      {matching && (
        <MatchInvestorsModal
          offer={offer}
          existingIds={investorIds}
          onClose={() => setMatching(false)}
          onLink={(investor) => run(() => addDealInvestor(offer.id, investor))}
        />
      )}
    </div>
  );
}

export default function DealsView({ settings, onEdit }) {
  const [deals, setDeals] = useState(null);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const [assigning, setAssigning] = useState(null);
  const [dataroom, setDataroom] = useState(null); // offer whose investor dataroom is open
  const [enriching, setEnriching] = useState(null); // { contactId, name } investor in EnrichModal

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

  if (error) return <ErrorBar>{error}</ErrorBar>;
  if (!deals) return <SkeletonRows cols={9} rows={5} />;

  const active = deals.filter((o) => !TERMINAL.has(o.deal.stage));
  const closed = deals.filter((o) => o.deal.stage === "closed");
  const fell = deals.filter((o) => o.deal.stage === "fell_through");
  const potentialFees = active.reduce((s, o) => s + (Number(o.deal.assignmentFee) || 0), 0);
  const shown = showTerminal ? deals : active;
  const selected = selectedId ? deals.find((o) => o.id === selectedId) : null;

  const kpis = [
    { label: "Active deals", value: active.length },
    { label: "Potential assignment fees", value: potentialFees ? fmtMoney(potentialFees) : "—" },
    { label: "Closed", value: closed.length },
  ];

  return (
    <>
      <div className="mb-3">
        <KpiRow items={kpis} cols="sm:grid-cols-3" />
      </div>

      {deals.length === 0 ? (
        <EmptyState>
          No deals yet — when an agent accepts, set that offer's status to
          <span className="mx-1 font-semibold text-slate-500">Accepted</span> on the Offers tab.
        </EmptyState>
      ) : (
        <>
          <TableCard>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2.5">Property</th>
                  <th className="px-4 py-2.5">Agent</th>
                  <th className="px-4 py-2.5">Stage</th>
                  <th className="px-4 py-2.5">Disposition</th>
                  <th className="px-4 py-2.5 text-right">Contract</th>
                  <th className="px-4 py-2.5 text-right">Fee</th>
                  <th className="px-4 py-2.5 text-right">Assignment</th>
                  <th className="px-4 py-2.5">Inspection</th>
                  <th className="px-4 py-2.5">Closing</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {shown.map((o) => {
                  const d = o.deal;
                  const closing = dateInfo(d.closingDate);
                  const inspection = dateInfo(d.inspectionDate);
                  const assignment = assignmentTotal(d.contractPrice, d.assignmentFee);
                  return (
                    <tr key={o.id} {...rowActivation(() => setSelectedId(o.id))}
                      aria-label={`${o.address || "Deal"} — ${STAGE[d.stage]?.label || d.stage}`}
                      className="group cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="max-w-[24rem] truncate px-4 py-2.5 font-medium" title={o.address || undefined}>{o.address || "—"}</td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        {o.contactId ? (
                          <a href={ghlContactUrl(o.contactId)} target="_blank" rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1 underline decoration-slate-300 underline-offset-2 hover:text-slate-900"
                            title="Open contact in GHL">
                            {o.contactName || o.contactId} <ExternalLink size={12} className="text-slate-400" />
                          </a>
                        ) : (o.contactName || "—")}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5"><StagePill stage={d.stage} /></td>
                      <td className="whitespace-nowrap px-4 py-2.5"><InvestorSummary deal={d} /></td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right font-semibold tabular-nums">
                        {d.contractPrice ? fmtMoney(d.contractPrice) : "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right font-semibold tabular-nums text-emerald-700">
                        {d.assignmentFee ? fmtMoney(d.assignmentFee) : "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right font-semibold tabular-nums">
                        {assignment ? fmtMoney(assignment) : "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        {inspection ? (
                          <span className={inspection.days < 0 ? "text-slate-400" : ""}>
                            {inspection.label}
                            <span className="ml-1 text-xs text-slate-400">{TERMINAL.has(d.stage) ? "" : inspectionSub(inspection.days)}</span>
                          </span>
                        ) : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        {closing ? (
                          <span className={closing.days < 0 && !TERMINAL.has(d.stage) ? "font-semibold text-red-600" : ""}>
                            {closing.label}
                            <span className="ml-1 text-xs text-slate-400">{TERMINAL.has(d.stage) ? "" : closingSub(closing.days)}</span>
                          </span>
                        ) : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                        {/* Revealed on hover, but never hidden from the keyboard:
                            focus-within brings it back for tab users. */}
                        <button type="button" onClick={() => setSelectedId(o.id)}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 opacity-0 hover:bg-slate-50 focus:opacity-100 group-hover:opacity-100">
                          <Pencil size={13} aria-hidden="true" /> Manage
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableCard>
          {(closed.length > 0 || fell.length > 0) && (
            <button type="button" onClick={() => setShowTerminal((v) => !v)}
              className="mt-2 text-xs font-medium text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-900">
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
          onDataroom={(o) => setDataroom(o)}
          onEdit={openOffer}
          onEnrich={(inv) => setEnriching(inv)} />
      )}
      {dataroom && (
        <DataroomModal offer={dataroom}
          deals={(deals || []).filter((d) => !TERMINAL.has(d.deal?.stage))}
          onSwitch={(d) => { setDataroom(d); setSelectedId(d.id); }}
          onBackToDeals={() => { setDataroom(null); setSelectedId(null); }}
          onClose={() => setDataroom(null)} />
      )}
      {enriching && (
        <EnrichModal contactId={enriching.contactId} contactName={enriching.name}
          defaultType="investor" onClose={() => setEnriching(null)} />
      )}
      {assigning && (
        <AssignmentModal offer={assigning} settings={settings}
          onClose={() => setAssigning(null)}
          onGenerated={patchDeal} />
      )}
    </>
  );
}
