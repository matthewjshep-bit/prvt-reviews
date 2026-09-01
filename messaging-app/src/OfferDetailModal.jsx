// OfferDetailModal.jsx — one offer, opened over whatever you were doing. The
// same window from the Offers table and from the editor, so "what did we send
// this agent, and what came back" is one thing you learn once.
//
// Three things it owes the operator, and the layout follows from them:
//   • the document as sent — big enough to read, not a thumbnail
//   • the numbers behind it — the three options, and what the rehab assumed
//   • what to do next — send it, paper it, or record what the agent said
// So the header (identity + verbs) and the agent's other offers (the rail at
// the bottom) are pinned, and only the middle scrolls. A modal whose actions
// scroll off the top makes you hunt for the button you opened it for.
//
// It owns no state that matters: every action is a callback, so the parent
// keeps being the one place an offer is mutated.

import React, { useEffect, useRef, useState } from "react";
import {
  Briefcase, ChevronLeft, ChevronRight, ExternalLink, FileSignature, FileText, Link2, Pencil, Send, X,
} from "lucide-react";
import { fmtMoney } from "@shared/offer-calc.js";
import { OFFER_STATUS, aiHoldReasons } from "@shared/offer-status.js";
import { ghlContactUrl, zillowUrl } from "./api.js";
import { CHANNEL_LABELS } from "./SendModal.jsx";
import { AttachWarning, StagePill, StatusMenu, StatusPill } from "./ui.jsx";

const CARD = "rounded-xl border border-slate-200 bg-white p-3.5";
const CARD_LABEL = "text-[11px] font-bold uppercase tracking-wider text-slate-500";
const DOC_LINK =
  "flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50";

const stamp = (ts) => (ts || "").slice(0, 16).replace("T", " ");
// "14416 369th Avenue SE, Sultan, WA" → "14416 369th Avenue SE": the rail is
// narrow and the city repeats on every card anyway.
const street = (address) => String(address || "").split(",")[0] || "Untitled";

function Row({ label, value }) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

// Where an auto-underwritten number came from.
//
// This is the whole reason a robot is allowed to build an offer at all: every
// input it chose is shown, so the review is "do I agree with these four comps"
// rather than "do I trust the machine". A held run leads with why it stopped —
// that's the sentence the operator actually needs.
function AiProvenance({ offer }) {
  const uw = offer.autoUnderwrite;
  if (!uw) return null;
  const held = aiHoldReasons(offer);
  return (
    <div className={held.length ? "rounded-xl border border-amber-300 bg-amber-50 p-3.5" : "rounded-xl border border-violet-200 bg-violet-50 p-3.5"}>
      <div className={`mb-1.5 ${CARD_LABEL} ${held.length ? "text-amber-700" : "text-violet-700"}`}>
        {held.length ? "Auto-underwrite — held for review" : "Auto-underwritten"}
      </div>

      {held.length > 0 && (
        <ul className="mb-2 list-inside list-disc text-xs text-amber-900">
          {held.map((h, i) => <li key={i}>{h}</li>)}
        </ul>
      )}

      <Row label="Property" value={uw.address || "—"} />
      <Row
        label="Address from"
        value={uw.addressSource === "workflow" ? "the GHL workflow"
          : uw.addressSource === "subject_property" ? "the Subject Property field"
          : `the conversation (${uw.confidence || "?"} confidence)`}
      />
      <Row label="Comps used" value={uw.compsUsedCount != null ? `${uw.compsUsedCount} renovated` : "—"} />
      <Row
        label="Comps from"
        value={`${uw.compsSource === "realestateapi" ? "RealEstateAPI" : "Zillow"}, condition by ${
          uw.conditionSource === "ai" ? "photo scan" : "$/sqft"}`}
      />
      <Row label="Photos scanned" value={uw.photosAnalyzed ?? 0} />
      {uw.mode && <Row label="Underwrite" value={uw.mode} />}
      {uw.dryRun && <Row label="Mode" value="dry run" />}

      {uw.arvBasis && (
        <p className="mt-2 border-t border-black/5 pt-2 text-xs text-slate-600">ARV from {uw.arvBasis}</p>
      )}
      {uw.message && (
        <p className="mt-2 text-xs italic text-slate-500">The text this came from: "{uw.message}"</p>
      )}
    </div>
  );
}

// The scope is the longest thing in here by far — 30+ lines on a full gut,
// which used to push the offer numbers and every action off the screen. Show
// the top of it (sorted by cost, so the top IS the story) and let it open.
function RehabScope({ scope }) {
  const [open, setOpen] = useState(false);
  const lines = [...scope].sort((a, b) => (Number(b.cost) || 0) - (Number(a.cost) || 0));
  const total = lines.reduce((s, l) => s + (Number(l.cost) || 0), 0);
  const shown = open ? lines : lines.slice(0, 8);
  return (
    <div className={CARD}>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className={CARD_LABEL}>Rehab scope</span>
        <span className="text-sm font-bold tabular-nums">{fmtMoney(total)}</span>
      </div>
      <div className="space-y-0.5">
        {shown.map((s, i) => (
          <div key={i} className="flex justify-between gap-4 text-sm">
            <span className="text-slate-600">{s.label}</span>
            <span className="font-medium tabular-nums">{fmtMoney(s.cost)}</span>
          </div>
        ))}
      </div>
      {lines.length > shown.length && (
        <button type="button" onClick={() => setOpen(true)}
          className="mt-1.5 text-xs font-semibold text-blue-700 underline underline-offset-2 hover:text-blue-900">
          Show all {lines.length} line items
        </button>
      )}
      {open && lines.length > 8 && (
        <button type="button" onClick={() => setOpen(false)}
          className="mt-1.5 text-xs font-semibold text-slate-500 underline underline-offset-2 hover:text-slate-800">
          Show less
        </button>
      )}
    </div>
  );
}

// Every offer this agent has, as a rail along the bottom. Pinned rather than
// in the scroll, because "what else did we send them" is a question you ask
// while looking at something else — and it's how you move between offers
// without closing the window and finding the next row.
function AgentRail({ offers, currentId, contactName, onSelect }) {
  const stripRef = useRef(null);
  // Keep the open offer visible when you arrow past the edge of the rail.
  useEffect(() => {
    const el = stripRef.current?.querySelector('[data-current="true"]');
    el?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [currentId]);

  return (
    <div className="shrink-0 border-t border-slate-200 bg-slate-50 px-4 py-2.5 sm:px-5">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
        {contactName ? `${contactName} — ` : ""}{offers.length} offer{offers.length === 1 ? "" : "s"}
      </div>
      <div ref={stripRef} className="flex gap-2 overflow-x-auto pb-1">
        {offers.map((o) => {
          const current = o.id === currentId;
          return (
            <button key={o.id} type="button" data-current={current || undefined}
              onClick={() => !current && onSelect?.(o)}
              aria-current={current ? "true" : undefined}
              title={`${o.address || "Offer"} — ${(o.createdAt || "").slice(0, 10)}`}
              className={`w-52 shrink-0 rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
                current
                  ? "border-blue-500 bg-white ring-1 ring-blue-500"
                  : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
              }`}>
              <span className="block truncate text-xs font-semibold text-slate-800">{street(o.address)}</span>
              <span className="mt-0.5 flex items-center justify-between gap-2">
                <span className="text-[11px] text-slate-500">{(o.createdAt || "").slice(0, 10)}</span>
                <span className="text-[11px] font-semibold tabular-nums text-slate-700">
                  {o.cashAmount != null ? fmtMoney(o.cashAmount) : "—"}
                </span>
              </span>
              <span className="mt-1 block"><StatusPill offer={o} small /></span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function OfferDetailModal({
  offer, siblings = [], contactName, queue = null, queueLabel = "",
  onClose, onSelect, onEdit, onSend, onPsa, onContract, onAssignment, onNetSheet,
  onPromote, onDealNav, onOfferPage, onStatus, statusBusy = false,
}) {
  const { cash, sellerFinance: sf, leaseOption: lo } = offer.calc?.offers || {};
  const history = offer.statusHistory || [];
  const sends = offer.sends || [];
  const scope = offer.scope || [];
  const draft = offer.status === "draft";

  // The agent's offers, newest first, with this one guaranteed present even if
  // the caller's list hasn't caught up with a just-created offer.
  const rail = siblings.some((o) => o.id === offer.id) ? siblings : [offer, ...siblings];

  // What the arrows walk. The QUEUE — the rows of the list you opened this
  // from, in the order that list shows them — when the open offer is in it,
  // because working a filter is walking a list: 37 awaiting reply is 37
  // arrow presses, not 37 rounds of close-the-window-find-the-next-row.
  // Otherwise the agent's own offers, which is what the rail below shows and
  // what the editor's peek passes.
  const inQueue = Boolean(queue?.some((o) => o.id === offer.id));
  const walk = inQueue ? queue : rail;
  const index = walk.findIndex((o) => o.id === offer.id);
  const prev = index > 0 ? walk[index - 1] : null;
  const next = index >= 0 && index < walk.length - 1 ? walk[index + 1] : null;
  const canNavigate = Boolean(onSelect) && walk.length > 1;
  const walkLabel = inQueue ? (queueLabel || "this list").toLowerCase() : "";

  // Esc closes; ←/→ walk the list. A modal you can only leave by aiming at a
  // 32px × is a modal that feels like a trap.
  useEffect(() => {
    const onKey = (e) => {
      // A dropdown open inside the window (the status menu) owns the keyboard
      // while it's up: Escape closes the menu, not the window behind it.
      if (document.querySelector('[role="menu"]')) return;
      if (e.key === "Escape") { onClose?.(); return; }
      if (!canNavigate || e.target.closest?.("input, textarea, select")) return;
      if (e.key === "ArrowLeft" && prev) onSelect(prev);
      if (e.key === "ArrowRight" && next) onSelect(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onSelect, canNavigate, prev, next]);

  const navBtn = "rounded-lg border border-slate-300 bg-white p-1.5 text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-30";

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-2 sm:p-6"
      onClick={onClose}>
      {/* Height-capped with its own scroll region: the header verbs and the
          agent rail stay put no matter how long the scope runs. */}
      <div role="dialog" aria-modal="true" aria-label={offer.address || "Offer"}
        className="flex max-h-[95vh] w-full max-w-7xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}>

        <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-start gap-2">
            {canNavigate && (
              <span className="mt-0.5 flex items-center gap-1">
                <button type="button" className={navBtn} disabled={!prev} onClick={() => prev && onSelect(prev)}
                  aria-label={`Previous offer${walkLabel ? ` in ${walkLabel}` : ""}`}
                  title={prev ? `← ${prev.address || "Previous offer"}` : "No earlier offer in this list"}>
                  <ChevronLeft size={16} />
                </button>
                <button type="button" className={navBtn} disabled={!next} onClick={() => next && onSelect(next)}
                  aria-label={`Next offer${walkLabel ? ` in ${walkLabel}` : ""}`}
                  title={next ? `→ ${next.address || "Next offer"}` : "No later offer in this list"}>
                  <ChevronRight size={16} />
                </button>
              </span>
            )}
            <div className="min-w-0">
              <div className="text-lg font-bold leading-tight">
                {offer.address || "Offer"}
                {offer.address && (
                  <a href={zillowUrl(offer.address)} target="_blank" rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="ml-2 align-middle text-xs font-medium text-blue-700 underline hover:text-blue-900">
                    Zillow ↗
                  </a>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-sm text-slate-500">
                <span>{offer.dateLabel || (offer.createdAt || "").slice(0, 10)}</span>
                {offer.contactId && <span aria-hidden="true">·</span>}
                {offer.contactId && (
                  <a href={ghlContactUrl(offer.contactId)} target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1 text-slate-700 underline hover:text-slate-900">
                    {offer.contactName || offer.contactId} <ExternalLink size={12} />
                  </a>
                )}
                <span aria-hidden="true">·</span>
                {/* The outcome is a control here, exactly as it is in the
                    Offers table: the window is where you read what came back,
                    so it's where you should be able to record it. A draft has
                    no outcome to set (the server rejects one), so it stays a
                    label until the offer is created. */}
                {onStatus && !draft
                  ? <StatusMenu offer={offer} busy={statusBusy} onDealNav={onDealNav}
                      onSelect={(status) => onStatus(offer, status)} />
                  : <StatusPill offer={offer} small />}
                <AttachWarning offer={offer} />
                {canNavigate && index >= 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="text-xs">
                      {index + 1} of {walk.length}{walkLabel ? ` in ${walkLabel}` : " for this agent"}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!draft && !offer.deal && onPromote && (
              <button type="button" onClick={() => onPromote(offer)}
                className="flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-semibold text-amber-800 hover:bg-amber-100"
                title="Accepted offer — start tracking it as an active deal">
                <Briefcase size={14} /> Mark under contract
              </button>
            )}
            {offer.deal && onDealNav && (
              <button type="button" onClick={() => onDealNav(offer)} title="Open the Deals tab">
                <StagePill stage={offer.deal.stage} />
              </button>
            )}
            {offer.contactId && onSend && (
              <button type="button" onClick={() => onSend(offer)}
                className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700">
                <Send size={14} /> Send
              </button>
            )}
            {onEdit && (
              <button type="button" onClick={() => onEdit(offer)}
                className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold hover:bg-slate-50">
                <Pencil size={14} /> Edit offer
              </button>
            )}
            <button type="button" onClick={onClose} aria-label="Close"
              className="rounded p-1.5 text-slate-400 hover:bg-slate-100">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Three lanes: the document, the numbers, the paperwork. Below xl they
            stack in that same order of importance. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)_minmax(0,1fr)]">
            {/* Sticky and height-capped: the document is the thing you read
                back to the agent, so it stays put while the history scrolls,
                and a full letter page can't push everything else off screen.
                Click for the real thing. */}
            <div className="lg:sticky lg:top-0 lg:self-start">
              {offer.imageUrl ? (
                <a href={offer.imageUrl} target="_blank" rel="noreferrer" title="Open the full-size document"
                  className="block">
                  <img src={offer.imageUrl} alt="Offer document"
                    className="max-h-[70vh] w-full rounded-xl border border-slate-200 object-contain object-top shadow-sm transition-shadow hover:shadow-md" />
                </a>
              ) : (
                <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-slate-300 text-sm text-slate-400">
                  {draft ? "Draft — no document generated yet" : "No document image"}
                </div>
              )}
            </div>

            <div className="space-y-3">
              {cash && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 p-3.5">
                  <div className={CARD_LABEL}>Option A — Cash</div>
                  <div className="text-2xl font-black">{fmtMoney(cash.amount)}</div>
                </div>
              )}
              {sf && (
                <div className={CARD}>
                  <div className={`mb-1 ${CARD_LABEL}`}>Option B — Seller finance</div>
                  <Row label="Price" value={fmtMoney(sf.price)} />
                  <Row label="Down" value={fmtMoney(sf.down)} />
                  <Row label="Monthly" value={`${fmtMoney(sf.monthly)} × ${sf.termYears} yrs${sf.annualRatePct ? ` @ ${sf.annualRatePct}%` : " @ 0%"}`} />
                  {sf.balloon > 0 && <Row label="Balloon" value={`${fmtMoney(sf.balloon)} @ yr ${sf.balloonYears}`} />}
                </div>
              )}
              {lo && (
                <div className={CARD}>
                  <div className={`mb-1 ${CARD_LABEL}`}>Option C — Lease option</div>
                  <Row label="Price" value={fmtMoney(lo.price)} />
                  <Row label="Option fee" value={fmtMoney(lo.optionFee)} />
                  <Row label="Monthly" value={`${fmtMoney(lo.monthly)} × ${lo.termMonths} mo`} />
                </div>
              )}
              <AiProvenance offer={offer} />
              {scope.length > 0 && <RehabScope scope={scope} />}
              {(offer.warnings || []).length > 0 && (
                <ul className="list-inside list-disc rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
                  {offer.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}
            </div>

            <div className="space-y-3">
              <div className={CARD}>
                <div className={`mb-2 ${CARD_LABEL}`}>Documents</div>
                <div className="flex flex-wrap gap-2">
                  {offer.pdfUrl && (
                    <a href={offer.pdfUrl} target="_blank" rel="noreferrer"
                      className="flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700">
                      <FileText size={15} /> Offer PDF
                    </a>
                  )}
                  {offer.scopePdfUrl && (
                    <a href={offer.scopePdfUrl} target="_blank" rel="noreferrer" className={DOC_LINK}>
                      <FileText size={15} /> Rehab SOW
                    </a>
                  )}
                  {offer.compsPdfUrl && (
                    <a href={offer.compsPdfUrl} target="_blank" rel="noreferrer" className={DOC_LINK}>
                      <FileText size={15} /> Comps PDF
                    </a>
                  )}
                  {offer.imageUrl && (
                    <a href={offer.imageUrl} target="_blank" rel="noreferrer" className={DOC_LINK}>
                      <FileText size={15} /> Image
                    </a>
                  )}
                  {offer.psaPdfUrl && (
                    <a href={offer.psaPdfUrl} target="_blank" rel="noreferrer" className={DOC_LINK}>
                      <FileSignature size={15} /> Offer PSA
                    </a>
                  )}
                  {offer.contractPdfUrl && (
                    <a href={offer.contractPdfUrl} target="_blank" rel="noreferrer" className={DOC_LINK}>
                      <FileText size={15} /> Contract PDF
                    </a>
                  )}
                </div>
                {!draft && (onOfferPage || onPsa || onContract || onNetSheet) && (
                  <div className="mt-2.5 flex flex-wrap gap-2 border-t border-slate-100 pt-2.5">
                    {onOfferPage && (
                      <button type="button" onClick={() => onOfferPage(offer)} className={DOC_LINK}
                        title="One shareable web page for the agent: the offer, the comps, the scope and the seller's net">
                        <Link2 size={15} /> Agent offer page
                      </button>
                    )}
                    {onPsa && (
                      <button type="button" onClick={() => onPsa(offer)}
                        className="flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-800"
                        title="The signable Washington purchase & sale agreement — the official offer, not a letter of intent">
                        <FileSignature size={15} /> {offer.psaPdfUrl ? "Update offer PSA" : "Generate offer PSA"}
                      </button>
                    )}
                    {onContract && (
                      <button type="button" onClick={() => onContract(offer)} className={DOC_LINK}
                        title="Generate or update the generic purchase & sale contract">
                        <FileText size={15} /> {offer.contractPdfUrl ? "Update contract" : "Generate contract"}
                      </button>
                    )}
                    {onNetSheet && (
                      <button type="button" onClick={() => onNetSheet(offer)} className={DOC_LINK}
                        title="One-pager: our offer with no buyer's commission vs. the list price needed to net the same">
                        <FileText size={15} /> Net comparison
                      </button>
                    )}
                  </div>
                )}
              </div>

              {!draft && onAssignment && (
                <div className={CARD}>
                  <div className={`mb-2 ${CARD_LABEL}`}>Dispositions — for the end buyer, not the seller</div>
                  <div className="flex flex-wrap gap-2">
                    {offer.assignmentPdfUrl && (
                      <a href={offer.assignmentPdfUrl} target="_blank" rel="noreferrer" className={DOC_LINK}>
                        <FileText size={15} /> Assignment PDF
                      </a>
                    )}
                    <button type="button" onClick={() => onAssignment(offer)} className={DOC_LINK}
                      title="Generate or update the assignment of contract for the end buyer">
                      <FileText size={15} /> {offer.assignmentPdfUrl ? "Update assignment" : "Generate assignment"}
                    </button>
                  </div>
                </div>
              )}

              {history.length > 0 && (
                <div className={CARD}>
                  <div className={`mb-1 ${CARD_LABEL}`}>Status history</div>
                  {history.map((h, i) => (
                    <div key={i} className="flex items-start justify-between gap-3 py-0.5 text-xs">
                      <span className="whitespace-nowrap text-slate-500">{stamp(h.ts)}</span>
                      <span className="text-right">
                        <span className="font-medium text-slate-700">{OFFER_STATUS[h.status]?.label || h.status}</span>
                        {h.note && <span className="text-slate-500"> · {h.note}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {sends.length > 0 && (
                <div className={CARD}>
                  <div className={`mb-1 ${CARD_LABEL}`}>Send history</div>
                  {sends.map((s, i) => (
                    <div key={i} className="flex items-start justify-between gap-3 py-0.5 text-xs">
                      <span className="whitespace-nowrap text-slate-500">{stamp(s.ts)}</span>
                      <span className="text-right">
                        {s.channels.map((c) => (
                          <span key={c} className={s.results?.[c]?.ok === false ? "text-red-600" : "text-emerald-700"}
                            title={s.results?.[c]?.error || ""}>
                            {CHANNEL_LABELS[c] || c}{s.results?.[c]?.ok === false ? " ✗" : " ✓"}{" "}
                          </span>
                        ))}
                        <span className="text-slate-500">· {(s.docs || []).join(", ")}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {canNavigate && (
          <AgentRail offers={rail} currentId={offer.id} onSelect={onSelect}
            contactName={contactName || offer.contactName} />
        )}
      </div>
    </div>
  );
}
