// WorkPane.jsx — one Today row, worked in one place.
//
//   ┌ what this row is, why it's here, its buttons      3 of 12  ‹ › ┐
//   ├ the offer                  │ the conversation + the reply box  ┤
//   └ teach the bot: this row, what you taught before, the coach's   ┘
//
// Every row kind gets the same three surfaces. What differs is only what
// the header says and which buttons the row names (shared/pipeline.js).

import React, { useState } from "react";
import { ChevronLeft, ChevronRight, Keyboard } from "lucide-react";
import { Pill } from "./ui.jsx";
import { RowOpsBar, SEV, whenLabel } from "./RowOps.jsx";
import { useOpenContact } from "./ContactLink.jsx";
import { ghlContactUrl } from "./api.js";
import OfferPanel, { OfferPanelBody } from "./OfferPanel.jsx";
import ConversationPanel, { ConversationPanelBody } from "./ConversationPanel.jsx";
import CoachPanel, { CoachPanelBody } from "./CoachPanel.jsx";
import { GROUP_LABEL, KEYS_HELP, KIND_LABEL, groupOf, railLabel } from "./work-queue.js";

const GROUP_CLS = { yours: "bg-blue-50 text-blue-800", stuck: "bg-amber-100 text-amber-800", machine: "bg-violet-100 text-violet-800" };
const NAV = "rounded-lg border border-slate-300 bg-white p-1.5 text-slate-600 hover:bg-slate-50 disabled:cursor-default disabled:opacity-40";

export function KeysHelp() {
  return (
    <div role="note" className="absolute right-0 top-full z-20 mt-1 w-56 rounded-xl border border-slate-200 bg-white p-3 text-xs shadow-lg">
      <div className="mb-1.5 font-semibold text-slate-700">Keys</div>
      <dl className="grid grid-cols-[3.5rem_1fr] gap-y-1">
        {KEYS_HELP.map(([k, what]) => <React.Fragment key={k}><dt className="font-semibold text-slate-700">{k}</dt><dd className="text-slate-600">{what}</dd></React.Fragment>)}
      </dl>
    </div>
  );
}

/** The row's own header: what it is, why it's here, and its buttons. */
export function RowHeader({ item, targets, index, total, onPrev, onNext, picker, onDone, showKeys, onToggleKeys }) {
  const sev = SEV[item.severity] || SEV.fyi;
  const g = groupOf(item);
  const drawer = useOpenContact();
  const openContact = () => {
    if (!targets.contactId) return;
    if (drawer) drawer.open(targets.contactId, { party: targets.party, name: item.contactName || null });
    else window.open(ghlContactUrl(targets.contactId), "_blank", "noreferrer");
  };
  const draftHere = Boolean(targets.draft);
  return (
    <div className="shrink-0 space-y-2 border-b border-slate-200 px-4 py-3">
      <div className="flex items-start gap-3">
        <span className={`mt-2 h-2.5 w-2.5 shrink-0 rounded-full ${sev.dot}`} title={sev.label} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Pill small label={GROUP_LABEL[g]} cls={GROUP_CLS[g]} />
            <Pill small label={KIND_LABEL[item.kind] || item.kind} />
            {item.severity === "now" && <Pill small label="now" cls={SEV.now.cls} />}
          </div>
          <h2 className="mt-1 text-base font-bold leading-snug text-slate-900">{item.title || railLabel(item)}</h2>
          {item.detail && <p className="mt-0.5 text-sm text-slate-600">{item.detail}</p>}
          {g === "stuck" && item.why && <p className="mt-0.5 text-sm text-amber-800">Stuck because: {item.why}</p>}
          {item.next?.what && <p className="mt-0.5 text-sm text-violet-700">Next: {item.next.what}{item.next.at ? ` · ${whenLabel(item.next.at)}` : ""}</p>}
        </div>
        <div className="relative flex shrink-0 items-center gap-1.5">
          {picker}
          <span className="hidden text-xs tabular-nums text-slate-500 sm:inline">{index + 1} of {total}</span>
          <button type="button" className={NAV} onClick={onPrev} disabled={!onPrev} title="Previous row (K)" aria-label="Previous row"><ChevronLeft size={16} /></button>
          <button type="button" className={NAV} onClick={onNext} disabled={!onNext} title="Next row (J)" aria-label="Next row"><ChevronRight size={16} /></button>
          <button type="button" className={`${NAV} hidden lg:inline-flex`} onClick={onToggleKeys} aria-expanded={showKeys} title="Keys (?)" aria-label="Keyboard keys"><Keyboard size={16} /></button>
          {showKeys && <KeysHelp />}
        </div>
      </div>
      <RowOpsBar item={item} onDone={onDone} onOpenContact={openContact} hasDraft={draftHere} />
      {!draftHere && !(item.ops || []).length && targets.contactId && (
        <p className="text-xs text-slate-500">Nothing to press on this one — answer them in the conversation, or teach the bot below.</p>
      )}
      {draftHere && ["draft_waiting", "draft_scheduled", "handoff", "audit_owed"].includes(item.kind) && (
        <p className="text-xs text-slate-500">The bot's draft is in the conversation, ready to edit and send.</p>
      )}
      {!draftHere && item.question && (item.ops || []).some((op) => op.key === "answer") && (
        <p className="text-xs text-slate-500">They asked something only you can answer — the box is under the conversation.</p>
      )}
    </div>
  );
}

/**
 * <WorkPane … /> — the row's three surfaces around one header.
 * `bodies` (tests): { offer, siblings, thread, coach } — render the
 * presentational halves with this data instead of loading it.
 */
export default function WorkPane({ item, targets, index, total, onPrev, onNext, picker, onDone, sendsEnabled, serverOffsetMs, feedback, showKeys, onToggleKeys, bodies = null }) {
  const [tab, setTab] = useState("conversation");   // below lg the two sides are tabs
  const tabBtn = (key, label) => (
    <button type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
      className={`flex-1 border-b-2 px-3 py-2 text-sm font-semibold ${tab === key ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
      {label}
    </button>
  );
  return (
    <section aria-label="The row you're working" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white">
      <RowHeader item={item} targets={targets} index={index} total={total} onPrev={onPrev} onNext={onNext} picker={picker}
        onDone={onDone} showKeys={showKeys} onToggleKeys={onToggleKeys} />

      <div role="tablist" className="flex shrink-0 border-b border-slate-200 lg:hidden">
        {tabBtn("conversation", "Conversation")}
        {tabBtn("offer", "Offer")}
      </div>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className={`${tab === "offer" ? "block" : "hidden"} min-h-0 overflow-y-auto lg:block lg:border-r lg:border-slate-200`}>
          {bodies
            ? <OfferPanelBody offer={bodies.offer} siblings={bodies.siblings || []} item={{ ...item, offerId: targets.offerId }} />
            : <OfferPanel item={item} offerId={targets.offerId} />}
        </div>
        <div className={`${tab === "conversation" ? "flex" : "hidden"} h-[65vh] min-h-0 flex-col lg:flex lg:h-auto`}>
          {bodies
            ? <ConversationPanelBody item={item} targets={targets} thread={bodies.thread} sendsEnabled={sendsEnabled} serverOffsetMs={serverOffsetMs} onDone={onDone} />
            : <ConversationPanel item={item} targets={targets} sendsEnabled={sendsEnabled} serverOffsetMs={serverOffsetMs} onDone={onDone} />}
        </div>
      </div>

      <div className="max-h-[38%] shrink-0 overflow-y-auto border-t border-slate-200 bg-slate-50/60">
        {bodies
          ? <CoachPanelBody item={item} targets={targets} feedback={feedback} coach={bodies.coach} />
          : <CoachPanel item={item} targets={targets} feedback={feedback} />}
      </div>
    </section>
  );
}
