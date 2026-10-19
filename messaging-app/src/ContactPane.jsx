// ContactPane.jsx — one person, worked in one pane, the same wherever you open
// them: the Desk, the Offers split, Tier 1 and the companion window (Matt,
// 2026-10-18: "it should be a simple, really good, easy UI that's all the
// same across the board").
//
//   ┌ Bill Sauneuf · 5426 S Lawrence St  [GHL: Offer Out ▾]     1 of 59 ‹ › ┐
//   │ why it's here (the Desk only)                                        │
//   │ [the page's button]   Status ▾ · Edit offer · Call · Coach · ⋯       │
//   ├ the offer                  │ the conversation + the reply box        ┤
//   └                            │                                         ┘
//
// A page says only what is its own, through slots: `nav` (n of N ‹ › ✕),
// `why` (a Desk row's one line), `lead` (its one or two buttons) and
// `moreItems` (anything else, in ⋯). The parts are PaneParts.jsx.

import React from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { PaneActions, PaneBody, PaneHeading } from "./PaneParts.jsx";

const NAV = "rounded-lg border border-slate-300 bg-white p-1.5 text-slate-600 hover:bg-slate-50 disabled:cursor-default disabled:opacity-40";

/**
 * <PaneNav index total onPrev onNext onClose noun picker>{children}</PaneNav>
 * "3 of 12" ‹ › and, on a page with a table behind it, ✕.
 *   noun      what J/K step through: "row" (the Desk) or "offer"
 *   children  anything that hangs off the nav (the Desk's key help)
 */
export function PaneNav({ index, total, onPrev, onNext, onClose = null, noun = "row", picker = null, children = null }) {
  return (
    <div className="relative flex shrink-0 items-center gap-1.5">
      {picker}
      {total > 0 && index >= 0 && <span className="hidden text-xs tabular-nums text-slate-500 sm:inline">{index + 1} of {total}</span>}
      <button type="button" className={NAV} onClick={onPrev} disabled={!onPrev} title={`Previous ${noun} (K)`} aria-label={`Previous ${noun}`}><ChevronLeft size={16} /></button>
      <button type="button" className={NAV} onClick={onNext} disabled={!onNext} title={`Next ${noun} (J)`} aria-label={`Next ${noun}`}><ChevronRight size={16} /></button>
      {onClose && <button type="button" className={NAV} onClick={onClose} title="Back to the table (Esc)" aria-label="Back to the table"><X size={16} /></button>}
      {children}
    </div>
  );
}

/**
 * <ContactPane … />
 *   pane, item, targets, convo   usePane's answer and what it read (PaneParts.jsx)
 *   label                        the section's aria-label
 *   nav, why, lead, moreItems    the page's own slots (above)
 *   rowOfferId, onStatusChanged, onDeal   PaneActions' and the editor's
 *   defaultTab                   below laptop width: "conversation" or "offer"
 *   className                    the box's height, where the page sets one
 */
export default function ContactPane({
  pane, item, targets, convo, label = "Their offer and conversation", nav = null, why = null, lead = null, moreItems = [],
  rowOfferId = null, onStatusChanged, onDeal = null, defaultTab = "conversation", settings = null, bodies = null, onDone, className = "flex-1",
}) {
  return (
    <section aria-label={label} className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white ${className}`}>
      <div className="shrink-0 space-y-2 border-b border-slate-200 px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <PaneHeading item={item} targets={targets} pane={pane} fallback={String(item.address || item.title || "").split(",")[0]} />
            {why}
          </div>
          {nav}
        </div>
        <div className="flex flex-wrap items-start gap-1.5">
          {lead}
          <PaneActions pane={pane} item={item} targets={targets} rowOfferId={rowOfferId} onStatusChanged={onStatusChanged} onDealNav={onDeal} moreItems={moreItems} />
        </div>
      </div>
      <PaneBody pane={pane} item={item} targets={targets} convo={convo} settings={settings} bodies={bodies} onDone={onDone} onDeal={onDeal} defaultTab={defaultTab} />
    </section>
  );
}
