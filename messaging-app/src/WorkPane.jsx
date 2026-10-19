// WorkPane.jsx — one Desk row, worked in the same pane as everywhere else
// (ContactPane.jsx). What's the Desk's own:
//
//   - one line under the name: why the row is here, and what else is on
//     the person ("Also: drafts waiting on you")
//   - the row's one button (its primary op) and Dismiss; its other ops, and
//     the ops of what else is on the person, in ⋯
//   - a call row's call card
//   - "3 of 12" ‹ ›, and the key help on ?
//
// Gone (Matt, 2026-10-18, "way too overcrowded"): the section, kind, "now"
// and intent pills (the rail's dot and the reply box say those), the
// before-you-sign checklist, the "Also on" box, the keyboard button.

import React, { useState } from "react";
import { BTN } from "./ui.jsx";
import { OpControl, opMenuItem, paneOps, splitOps, whenLabel } from "./RowOps.jsx";
import { usePane } from "./PaneParts.jsx";
import ContactPane, { PaneNav } from "./ContactPane.jsx";
import CallCard from "./CallCard.jsx";
import { KEYS_HELP, KIND_LABEL, canDismissRow, railLabel } from "./work-queue.js";

export { OPEN_OFFER_EVENT } from "./PaneParts.jsx";

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
// what you need to know before reading anything else. Rows about no one
// person keep the title as the heading.
export function rowHeading(item, offer = null) {
  const street = String(item.address || offer?.address || "").split(",")[0].trim();
  if (item.contactName && street) return `${item.contactName} · ${street}`;
  if (item.contactName && item.kind?.startsWith("draft")) return item.contactName;
  return item.title || railLabel(item);
}

// The pipeline's title without what the heading already says: "Sam Lee: we
// owe them a number" and "5426 S Lawrence St, Tacoma: before you sign" lose
// the name and the address.
function bareTitle(r) {
  let t = String(r.title || "");
  for (const lead of [r.contactName, r.address]) if (lead && t.startsWith(`${lead}: `)) t = t.slice(lead.length + 2);
  return t;
}
const capital = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : "");

/**
 * whyLine(item) → the one line under the name: why the row is here, and its
 * detail when there is one. A draft row's title is only "name: intent",
 * which the reply box already says.
 */
export function whyLine(item) {
  const title = String(item.kind || "").startsWith("draft_") ? "" : capital(bareTitle(item));
  const detail = item.call ? "" : String(item.detail || "");
  return [title, detail].filter(Boolean).join(" · ");
}

/** "Also: Drafts waiting on you · Acceptance" — what else the Desk folded into this row. */
export function alsoLine(item) {
  const also = item.also || [];
  if (!also.length) return "";
  const said = (r) => {
    const kind = KIND_LABEL[r.kind] || String(r.kind || "").replace(/_/g, " ");
    const title = capital(bareTitle(r));
    return title && title.toLowerCase() !== kind.toLowerCase() ? `${kind} · ${title}` : kind;
  };
  return `Also: ${also.map(said).join("; ")}`;
}

/**
 * rowOps(item, { hasDraft, hasRecord }) → { lead, dismiss, more }
 * The one button: the row's own primary, or — a row with none of its own,
 * like a draft — the first primary of what's folded into it. Then the
 * rest of the row's ops and each folded reason's (less the ones the row
 * already has on the same offer), as ⋯ items. Each is { op, row }: an op
 * runs against the reason it came from.
 */
export function rowOps(item, { hasDraft, hasRecord }) {
  const own = splitOps(paneOps(item, { hasDraft, hasRecord }));
  const folded = (item.also || []).flatMap((r) => paneOps(r, { hasDraft, hasRecord })
    .filter((op) => !(r.offerId && r.offerId === item.offerId && (item.ops || []).some((o) => o.key === op.key)))
    .map((op) => ({ op, row: r })));
  let lead = own.lead ? { op: own.lead, row: item } : null;
  if (!lead && folded.length) {
    const i = Math.max(0, folded.findIndex(({ op }) => op.intent === "primary"));
    [lead] = folded.splice(i, 1);
  }
  return { lead, dismiss: own.dismiss ? { op: own.dismiss, row: item } : null, more: [...own.rest.map((op) => ({ op, row: item })), ...folded] };
}

/** The ⋯ half of rowOps, for tests and the menu. */
export const rowMoreOps = (item, has) => rowOps(item, has).more;

/**
 * <WorkPane … /> — the Desk row in the contact pane.
 * `bodies` (tests): { offer, siblings, thread, coach, timeline } — render the
 * presentational halves with this data instead of loading it.
 * `settings`: the app's saved settings, for the offer editor.
 */
export default function WorkPane({ item, targets, index, total, onPrev, onNext, picker, onDone, onDismiss = null, sendsEnabled, serverOffsetMs, feedback, showKeys, settings = null, bodies = null }) {
  const pane = usePane({ item, targets, bodies, feedback, onDone });
  const [note, setNote] = useState("");
  const rowOfferId = pane.side.replaced?.id === targets.offerId ? pane.side.offer?.id : targets.offerId;
  const convo = { item, targets, sendsEnabled, serverOffsetMs, onDone, fb: pane.fb, taught: pane.coach?.taught || [], bot: pane.timeline?.bot || null };
  const has = { hasDraft: Boolean(targets.draft), hasRecord: Boolean(targets.contactId) };
  const { lead, dismiss, more } = rowOps(item, has);
  const moreItems = more.map(({ op, row }) => opMenuItem(op, row, { onDone, onOpenContact: pane.openContact, onNote: setNote }));
  const why = whyLine(item);
  const also = alsoLine(item);
  const after = item.group === "stuck" && item.why ? `Stuck because: ${item.why}` : item.next?.what ? `Next: ${item.next.what}${item.next.at ? ` · ${whenLabel(item.next.at)}` : ""}` : "";
  return (
    <ContactPane pane={pane} item={item} targets={targets} convo={convo} label="The row you're working" rowOfferId={rowOfferId}
      settings={settings} bodies={bodies} onDone={onDone} moreItems={moreItems}
      nav={<PaneNav index={index} total={total} onPrev={onPrev} onNext={onNext} picker={picker}>{showKeys && <KeysHelp />}</PaneNav>}
      why={(
        <>
          {why && <p className="mt-0.5 text-sm font-medium text-slate-800">{why}</p>}
          {after && <p className={`mt-0.5 text-xs ${item.group === "stuck" ? "text-amber-800" : "text-violet-700"}`}>{after}</p>}
          {also && <p className="mt-0.5 text-xs text-slate-500">{also}</p>}
          <CallCard item={item} targets={targets} onDone={onDone} />
        </>
      )}
      lead={(
        <>
          {lead && <OpControl op={lead.op} item={lead.row} onDone={onDone} onOpenContact={pane.openContact} />}
          {dismiss && <OpControl op={dismiss.op} item={dismiss.row} onDone={onDone} onOpenContact={pane.openContact} />}
          {onDismiss && canDismissRow(item) && (
            <button type="button" className={BTN} onClick={() => onDismiss(item)} title="Take it off Today and go to the next row (D). It comes back if it changes.">Dismiss</button>
          )}
          {note && <span className="self-center text-xs text-slate-500" role="status">{note}</span>}
        </>
      )} />
  );
}
