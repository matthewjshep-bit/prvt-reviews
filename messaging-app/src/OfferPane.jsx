// OfferPane.jsx — one offer, worked in the Offers split the way a Today row
// is: the person and the house with the timeline strip, the app's own buttons
// (Status, Bot, Edit offer, Call, Coach, ⋯), the offer on the left and the
// conversation with a reply box on the right (PaneParts.jsx).
//
// What's the Offers page's own: "n of N" and ‹ › walk the rail, ✕ (Esc)
// goes back to the table, Details opens the full offer window (documents,
// PSA, contract, assignment, net sheet), and Send texts or emails the offer.
// Their open draft comes from GET /automations/conversation?contact_id= —
// the box is that draft when the bot has one, a plain reply box otherwise.

import React, { useMemo } from "react";
import { ChevronLeft, ChevronRight, FileText, Send, X } from "lucide-react";
import { offerHeat } from "@shared/offer-status.js";
import { getReplyDrafts } from "./api.js";
import { BTN, CurrentPill, HotPill, StatusPill } from "./ui.jsx";
import { PaneActions, PaneBody, PaneHeading, usePane } from "./PaneParts.jsx";
import { forget, useLoad } from "./work-data.js";
import { rowTargets } from "./work-queue.js";
import { offerPaneItem } from "./offers-split.js";

const NAV = "rounded-lg border border-slate-300 bg-white p-1.5 text-slate-600 hover:bg-slate-50 disabled:cursor-default disabled:opacity-40";
export const draftsKey = (contactId) => (contactId ? `drafts-of:${contactId}` : null);
export const loadDrafts = (contactId) => () => getReplyDrafts({ contactId });

/**
 * <OfferPane offer index total onPrev onNext onClose onDetails onSend onChanged onStatusChanged onDeal settings picker bodies />
 *   offer            the lean list row (the full document is read by the pane)
 *   onChanged()      something about this person moved (a send, the Bot menu): re-read their rows
 *   onStatusChanged(r) the status menu's answer, to patch the table's copy
 *   bodies           tests only: { offer, siblings, thread, coach, timeline, drafts }
 */
export default function OfferPane({ offer, index, total, onPrev, onNext, onClose, onDetails, onSend, onChanged, onStatusChanged, onDeal = null, settings = null, picker = null, bodies = null }) {
  const item = useMemo(() => offerPaneItem(offer), [offer.id, offer.contactId, offer.contactName, offer.address]);   // eslint-disable-line react-hooks/exhaustive-deps
  const dl = useLoad(bodies ? null : draftsKey(offer.contactId), loadDrafts(offer.contactId), { maxAgeMs: 30000 });
  const data = bodies ? { drafts: bodies.drafts || [], sendsEnabled: Boolean(bodies.sendsEnabled), now: null } : dl.data;
  const targets = useMemo(() => rowTargets(item, data?.drafts || []), [item, data]);
  const serverOffsetMs = data?.now ? Date.now() - Date.parse(data.now) : 0;
  const done = () => { forget(draftsKey(offer.contactId)); dl.reload(); onChanged?.(offer); };
  const pane = usePane({ item, targets, bodies, onDone: done });
  const convo = { item, targets, sendsEnabled: Boolean(data?.sendsEnabled), serverOffsetMs, onDone: done, fb: pane.fb, taught: pane.coach?.taught || [], bot: pane.timeline?.bot || null };
  const shown = pane.side.offer || offer;
  return (
    <section aria-label="The offer you're working" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="shrink-0 space-y-2 border-b border-slate-200 px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusPill offer={shown} small />
              <HotPill heat={offerHeat(shown)} />
              <CurrentPill offer={offer} />
            </div>
            <PaneHeading item={item} targets={targets} pane={pane} fallback={String(offer.address || "Untitled").split(",")[0]} />
          </div>
          <div className="relative flex shrink-0 items-center gap-1.5">
            {picker}
            {total > 0 && index >= 0 && <span className="hidden text-xs tabular-nums text-slate-500 sm:inline">{index + 1} of {total}</span>}
            <button type="button" className={NAV} onClick={onPrev} disabled={!onPrev} title="Previous offer (K)" aria-label="Previous offer"><ChevronLeft size={16} /></button>
            <button type="button" className={NAV} onClick={onNext} disabled={!onNext} title="Next offer (J)" aria-label="Next offer"><ChevronRight size={16} /></button>
            <button type="button" className={NAV} onClick={onClose} title="Back to the table (Esc)" aria-label="Back to the table"><X size={16} /></button>
          </div>
        </div>
        <div className="flex flex-wrap items-start gap-1.5">
          <button type="button" className={BTN} onClick={() => onDetails?.(offer)} title="The full offer: documents, PSA, contract, assignment, net sheet">
            <FileText size={13} /> Details
          </button>
          {offer.contactId && offer.status !== "draft" && (
            <button type="button" className={BTN} onClick={() => onSend?.(shown)} title="Text or email the offer documents">
              <Send size={13} /> Send
            </button>
          )}
          <PaneActions pane={pane} item={item} targets={targets} rowOfferId={offer.id} onStatusChanged={onStatusChanged} onDealNav={onDeal} />
        </div>
      </div>
      <PaneBody pane={pane} item={item} targets={targets} convo={convo} settings={settings} bodies={bodies} onDone={done} onDeal={onDeal} />
    </section>
  );
}
