// OfferEditorSheet.jsx — the full offer, opened over Today instead of in a
// new tab: the same editor as the Offers app (NewOffer), in a wide sheet.
// Save, and the row underneath re-reads the numbers; close it and you are
// back on the row you were working.
//
// The editor is imported on first open: it pulls in the map library, which
// needs a browser, so Today's server-rendered tests never load it.
// The sheet sits under the editor's own windows (Send, PSA, …: z-40/50).

import React, { Suspense, lazy, useEffect, useRef } from "react";
import { ExternalLink, Loader2, X } from "lucide-react";
import { offerEditorUrl } from "./api.js";

const NewOffer = lazy(() => import("./NewOffer.jsx"));

/**
 * <OfferEditorSheet offer settings contactId onClose onSaved onOpenOffer />
 *   offer     the offer to edit; null starts a new one for contactId
 *   settings  the app's saved settings (OfferApp); null while they load
 */
export default function OfferEditorSheet({ offer, settings, contactId = null, onClose, onSaved, onOpenOffer }) {
  const panel = useRef(null);
  const opener = useRef(typeof document !== "undefined" ? document.activeElement : null);
  useEffect(() => {
    panel.current?.focus();
    const back = opener.current;
    const onKey = (e) => {
      // A window the editor opened owns Escape.
      if (e.key !== "Escape" || document.querySelectorAll('[aria-modal="true"]').length > 1 || document.querySelector('[role="menu"]')) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); back?.focus?.(); };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const tabHref = offer ? offerEditorUrl(offer.id) : `${offerEditorUrl(null, { view: "new" })}${contactId ? `&contact_id=${encodeURIComponent(contactId)}` : ""}`;
  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/30" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={offer ? `Offer on ${offer.address || "this house"}` : "New offer"}
        className="flex h-full w-full max-w-[1400px] flex-col bg-slate-50 shadow-2xl outline-none sm:w-[92vw]">
        <div className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5">
          <h2 className="min-w-0 flex-1 truncate text-sm font-bold text-slate-900">{offer ? offer.address || "Offer" : "New offer"}</h2>
          <a href={tabHref} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800">
            Open in a tab <ExternalLink size={11} />
          </a>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800" aria-label="Close the offer" title="Close (Esc)">
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 sm:px-6">
          {!settings ? (
            <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={14} className="animate-spin" /> Loading your settings…</div>
          ) : (
            <Suspense fallback={<div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={14} className="animate-spin" /> Opening the offer…</div>}>
              <NewOffer key={offer?.id || "new"} settings={settings} restore={offer} initialContactId={offer ? undefined : contactId || undefined}
                onReset={onClose} onSettingsSaved={() => {}} onOpenOffer={onOpenOffer} onOfferSaved={onSaved}
                onDeal={() => { window.location.href = `/deals${window.location.search}`; }} />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
}
