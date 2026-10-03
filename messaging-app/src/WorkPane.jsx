// WorkPane.jsx — one Today row, worked in one place.
//
//   ┌ group · kind                                        3 of 12  ‹ › ┐
//   │ Dana Smith · 12 Elm St          ← the name opens their record     │
//   │ priced 385K 9/12 · sent · nudge 9/15 · … → next: nudge Thu · History │
//   │ why it's here · Next: …                                          │
//   │ the row's buttons   Status ▾ · Bot ▾ · Edit offer · Call · Coach · ⋯ │
//   ├ the offer(s)               │ the conversation + the reply box     ┤
//   └                            │ (Feedback, tucked away: T or ⋯)      ┘
//
// Every row kind gets the same surfaces. What differs is only what the
// header says and which buttons the row names (shared/pipeline.js). The
// person, the strip, the app's own buttons and the body are PaneParts.jsx,
// shared with the Offers split.

import React from "react";
import { ChevronLeft, ChevronRight, Keyboard } from "lucide-react";
import { BTN, Pill } from "./ui.jsx";
import { RowOpsBar, SEV, whenLabel } from "./RowOps.jsx";
import { IntentPill } from "./ConversationOutbox.jsx";
import { PaneActions, PaneBody, PaneHeading, usePane } from "./PaneParts.jsx";
import { KEYS_HELP, KIND_LABEL, SECTION_LABEL, canDismissRow, groupOf, railLabel } from "./work-queue.js";

export { OPEN_OFFER_EVENT } from "./PaneParts.jsx";

const GROUP_CLS = { call: "bg-emerald-50 text-emerald-800", decide: "bg-blue-50 text-blue-800", yours: "bg-blue-50 text-blue-800", stuck: "bg-amber-100 text-amber-800", machine: "bg-violet-100 text-violet-800" };
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

// "Shelley Michael · 3004 E Yesler Way" — who and which house, which is
// what you need to know before reading anything else; the pipeline's title
// (why the row is here) goes under it. Rows about no one person keep the
// title as the heading.
export function rowHeading(item, offer = null) {
  const street = String(item.address || offer?.address || "").split(",")[0].trim();
  if (item.contactName && street) return `${item.contactName} · ${street}`;
  if (item.contactName && item.kind?.startsWith("draft")) return item.contactName;
  return item.title || railLabel(item);
}

/**
 * The other things on this person (a Desk row folds them, shared/desk.js):
 * each says what it is and keeps its own buttons, so one pane clears them all.
 */
export function FoldedReasons({ item, targets, pane, onDone }) {
  const also = item.also || [];
  if (!also.length) return null;
  const who = item.contactName ? `${item.contactName}` : "this";
  // "Sam Lee: we owe them a number" under Sam Lee's row: the name once is enough.
  const said = (r) => (r.contactName && String(r.title || "").startsWith(`${r.contactName}: `) ? r.title.slice(r.contactName.length + 2) : r.title || "");
  return (
    <div className="mt-2 space-y-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2" aria-label={`Also on ${who}`}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Also on {who}</div>
      {also.map((r) => (
        <div key={r.id} className="space-y-1">
          <div className="text-sm text-slate-800"><span className="font-semibold">{KIND_LABEL[r.kind] || String(r.kind || "").replace(/_/g, " ")}</span>{said(r) ? ` · ${said(r)}` : ""}</div>
          {r.detail && <div className="text-xs text-slate-600">{r.detail}</div>}
          {r.next?.what && <div className="text-xs text-violet-700">Next: {r.next.what}{r.next.at ? ` · ${whenLabel(r.next.at)}` : ""}</div>}
          <RowOpsBar item={r} onDone={onDone} onOpenContact={pane.openContact} hasDraft={Boolean(targets.draft)} hasRecord={Boolean(targets.contactId)} />
        </div>
      ))}
    </div>
  );
}

/** The row's own header: why it's here, the person and the house, and its buttons. */
export function RowHeader({ item, targets, index, total, onPrev, onNext, picker, onDone, onDismiss = null, showKeys, onToggleKeys, pane, actions = null }) {
  const sev = SEV[item.severity] || SEV.fyi;
  // A Desk row says its section (Call / Decide / Machine); an old row its group.
  const g = item.section || groupOf(item);
  const intent = targets.draft?.intent;
  const heading = rowHeading(item, pane.side.offer);
  // The pipeline's title says why the row is here; a draft row's is only
  // "name: intent", which the heading and the pills already say.
  // "Sam Lee: we owe them a number" under "Sam Lee · 23706 Sample Dr" says
  // the name twice, so the title loses it.
  const titled = item.contactName && String(item.title || "").startsWith(`${item.contactName}: `) ? item.title.slice(item.contactName.length + 2) : item.title || "";
  const why = titled && item.title !== heading && !String(item.kind || "").startsWith("draft_") ? titled.charAt(0).toUpperCase() + titled.slice(1) : "";
  return (
    <div className="shrink-0 space-y-2 border-b border-slate-200 px-4 py-3">
      <div className="flex items-start gap-3">
        <span className={`mt-2 h-2.5 w-2.5 shrink-0 rounded-full ${sev.dot}`} title={sev.label} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Pill small label={SECTION_LABEL[g] || g} cls={GROUP_CLS[g]} />
            <Pill small label={KIND_LABEL[item.kind] || item.kind} />
            {item.severity === "now" && <Pill small label="now" cls={SEV.now.cls} />}
            {intent && intent !== "other" && <IntentPill party={targets.party} intent={intent} />}
          </div>
          <PaneHeading item={item} targets={targets} pane={pane} fallback={heading} />
          {why && <p className="mt-0.5 text-sm font-medium text-slate-800">{why}</p>}
          {item.detail && <p className="mt-0.5 text-sm text-slate-600">{item.detail}</p>}
          {item.group === "stuck" && item.why && <p className="mt-0.5 text-sm text-amber-800">Stuck because: {item.why}</p>}
          {item.next?.what && <p className="mt-0.5 text-sm text-violet-700">Next: {item.next.what}{item.next.at ? ` · ${whenLabel(item.next.at)}` : ""}</p>}
          <FoldedReasons item={item} targets={targets} pane={pane} onDone={onDone} />
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
      <div className="flex flex-wrap items-start gap-1.5">
        <RowOpsBar item={item} onDone={onDone} onOpenContact={pane.openContact} hasDraft={Boolean(targets.draft)} hasRecord={Boolean(targets.contactId)} />
        {onDismiss && canDismissRow(item) && (
          <button type="button" className={BTN} onClick={() => onDismiss(item)} title="Take it off Today and go to the next row (D). It comes back if it changes.">Dismiss</button>
        )}
        {actions}
      </div>
    </div>
  );
}

/**
 * <WorkPane … /> — the row's surfaces around one header.
 * `bodies` (tests): { offer, siblings, thread, coach, timeline } — render the
 * presentational halves with this data instead of loading it.
 * `settings`: the app's saved settings, for the offer editor.
 */
export default function WorkPane({ item, targets, index, total, onPrev, onNext, picker, onDone, onDismiss = null, sendsEnabled, serverOffsetMs, feedback, showKeys, onToggleKeys, settings = null, bodies = null }) {
  const pane = usePane({ item, targets, bodies, feedback, onDone });
  const rowOfferId = pane.side.replaced?.id === targets.offerId ? pane.side.offer?.id : targets.offerId;
  const convo = { item, targets, sendsEnabled, serverOffsetMs, onDone, fb: pane.fb, taught: pane.coach?.taught || [], bot: pane.timeline?.bot || null };
  return (
    <section aria-label="The row you're working" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white">
      <RowHeader item={item} targets={targets} index={index} total={total} onPrev={onPrev} onNext={onNext} picker={picker}
        onDone={onDone} onDismiss={onDismiss} showKeys={showKeys} onToggleKeys={onToggleKeys} pane={pane}
        actions={<PaneActions pane={pane} item={item} targets={targets} rowOfferId={rowOfferId} />} />
      <PaneBody pane={pane} item={item} targets={targets} convo={convo} settings={settings} bodies={bodies} onDone={onDone} />
    </section>
  );
}
