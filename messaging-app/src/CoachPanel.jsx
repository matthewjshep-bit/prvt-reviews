// CoachPanel.jsx — the bottom of Today's work pane: teach the bot on this row.
//
// Three things, left to right:
//   • Teach it — the four chips and a note, always open (RowFeedback). What
//     you say here is a row_feedback event the nightly coach reads.
//   • Taught before — what you already said on this person's rows.
//   • The coach proposes — lessons the nightly coach drew from this person's
//     drafts or from what you taught on their rows, each with Apply / Reject.
//     Nothing applies itself; this is the same proposal the coach card shows.

import React from "react";
import { getCoachForContact } from "./api.js";
import { ProposalRow } from "./CoachCard.jsx";
import RowFeedback from "./RowFeedback.jsx";
import { feedbackItemOf } from "./RowOps.jsx";
import { useLoad } from "./work-data.js";
import { teachRowId } from "./work-queue.js";

export const TEACH_NOTE_ID = "work-teach";
export const coachKey = (contactId) => (contactId ? `coach:${contactId}` : null);
export const loadCoach = (contactId) => () => getCoachForContact(contactId);
const day = (ts) => (ts ? new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" }) : "");

/** Given its data; what the tests render. */
export function CoachPanelBody({ item, targets, feedback = null, coach = null, onChanged }) {
  const rowId = teachRowId(item);
  const taught = (coach?.taught || []).filter((t) => t.eventId !== feedback?.eventId).slice(0, 4);
  const proposals = coach?.proposals || [];
  return (
    <div className="grid gap-x-6 gap-y-3 px-4 py-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div>
        <div className="mb-1.5 text-xs font-semibold text-slate-600"><span className="uppercase tracking-wide text-slate-500">Teach the bot</span> · what should it have done here?</div>
        <RowFeedback key={rowId} rowId={rowId} rowKind={item.kind} alwaysOpen noteId={TEACH_NOTE_ID} feedback={feedback}
          item={{ ...feedbackItemOf(item), contactId: targets.contactId || item.contactId || null, draftId: item.draftId || targets.draftId || null, offerId: targets.offerId || item.offerId || null }} />
      </div>
      <div className="min-w-0 space-y-2">
        {proposals.length > 0 && (
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">The coach proposes, from this thread</div>
            <ul className="divide-y divide-slate-100">
              {proposals.map((p) => <ProposalRow key={p.id} p={p} canFile={Boolean(coach?.canFile)} onDone={onChanged} />)}
            </ul>
          </div>
        )}
        {taught.length > 0 && (
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">You taught it before</div>
            <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
              {taught.map((t) => (
                <li key={t.eventId}><span className="tabular-nums text-slate-500">{day(t.at)}</span> · {t.label}{t.note ? <span className="text-slate-500"> — {t.note}</span> : null}</li>
              ))}
            </ul>
          </div>
        )}
        {!proposals.length && !taught.length && (
          <p className="text-xs text-slate-500">
            {targets.contactId ? "Nothing learned from this thread yet. What you teach here is read by the nightly coach, which proposes a lesson for you to apply." : "Nothing learned from this row yet."}
          </p>
        )}
      </div>
    </div>
  );
}

export default function CoachPanel({ item, targets, feedback }) {
  const c = useLoad(coachKey(targets.contactId), loadCoach(targets.contactId), { maxAgeMs: 120000 });
  return <CoachPanelBody item={item} targets={targets} feedback={feedback} coach={c.data} onChanged={c.reload} />;
}
