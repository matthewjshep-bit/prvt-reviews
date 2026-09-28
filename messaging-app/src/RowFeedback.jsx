// RowFeedback.jsx — Feedback: what was wrong, or what should the bot have done?
//
// Every row on Today is a place the bot stopped and a person had to act.
// This is where you say so — one category and your own words — for the
// nightly coach to learn from. One list (shared/row-feedback.js): what was
// wrong with the draft's words, asked only when there is a draft, and what
// the machine should have done with the row. It replaced the draft's own
// "What was wrong with it?" chips and the Teach-the-bot footer (2026-09-28),
// which said the same thing twice on one screen.
//
// Saving changes nothing about the row. In the work pane a chip you picked
// but didn't save rides along when you Send or Dismiss the draft
// (useRowFeedback's commit), so it's one gesture, not two.
//
// After a save the row reads "noted · <category>"; saving again is a newer
// verdict (the coach reads the newest).

import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  ROW_FEEDBACK_ACTS, ROW_FEEDBACK_WORDS, ROW_FEEDBACK_LABEL, ROW_FEEDBACK_HINT, ROW_FEEDBACK_NOTE_MAX,
} from "@shared/row-feedback.js";
import { sendRowFeedback } from "./api.js";
import { BTN, BTN_PRIMARY } from "./ui.jsx";

export const TEACH_NOTE_ID = "work-teach";
// The pane's T key: open the control and put the cursor in the note.
export const TEACH_EVENT = "work-teach";
const day = (ts) => (ts ? new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" }) : "");

/**
 * useRowFeedback({ rowId, rowKind, item, feedback }) — the control's state,
 * held by whoever also needs it (the pane's reply box reads `pick` on Send).
 *   item: { contactId?, draftId?, offerId?, jobId?, auditKind?, address?, title?, detail? }
 *   feedback: what the pipeline already holds for this row, or null
 */
export function useRowFeedback({ rowId, rowKind = "", item = {}, feedback = null }) {
  const [saved, setSaved] = useState(feedback);
  const [category, setCategory] = useState(feedback?.category || "");
  const [note, setNote] = useState(feedback?.note || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty = Boolean(category) && (category !== saved?.category || note.trim() !== (saved?.note || ""));

  async function save() {
    if (!category) return null;
    setBusy(true); setError("");
    try {
      const r = await sendRowFeedback({
        rowId, rowKind, category, note,
        contactId: item.contactId || null, draftId: item.draftId || null, offerId: item.offerId || null, jobId: item.jobId || null,
        auditKind: item.auditKind || "", address: item.address || "", title: item.title || "", detail: item.detail || "",
      });
      setSaved(r.feedback);
      return r.feedback;
    } catch (e) {
      setError(e.message || "That didn't save.");
      return null;
    } finally { setBusy(false); }
  }
  // Send / Dismiss: save what was picked and not yet saved. Never throws —
  // feedback is optional and must not stand between you and the send.
  const commit = async () => (dirty ? save() : null);
  return { rowId, rowKind, saved, category, setCategory, note, setNote, busy, error, dirty, save, commit };
}

function Chips({ codes, category, onPick, busy }) {
  return codes.map((code) => (
    <button key={code} type="button" disabled={busy} aria-pressed={category === code} title={ROW_FEEDBACK_HINT[code]}
      onClick={() => onPick(category === code ? "" : code)}
      className={`rounded-full border px-2 py-0.5 text-xs ${category === code ? "border-blue-600 bg-blue-50 text-blue-800" : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"}`}>
      {ROW_FEEDBACK_LABEL[code]}
    </button>
  ));
}

const notedLine = (saved) => saved
  ? <span className="text-emerald-700">noted · {saved.label}{saved.note ? <span className="text-slate-500"> — {saved.note}</span> : null}</span>
  : null;

/**
 * <PaneFeedback fb withWords taught /> — the work pane's version: one line
 * under the reply box, opened by a click or the T key.
 *   fb        useRowFeedback(…)
 *   withWords the row has a draft, so "what was wrong with the words" is asked
 *   taught    what you said on this person's other rows ({ eventId, label, note, at })
 *   defaultOpen  start open (tests; nothing clicks in a server render)
 */
export function PaneFeedback({ fb, withWords = false, taught = [], defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const noteRef = useRef(null);
  const focusNote = useRef(false);
  useEffect(() => {
    const onTeach = () => { focusNote.current = true; setOpen(true); };
    window.addEventListener(TEACH_EVENT, onTeach);
    return () => window.removeEventListener(TEACH_EVENT, onTeach);
  }, []);
  useEffect(() => { if (open && focusNote.current) { focusNote.current = false; noteRef.current?.focus(); } }, [open]);

  const earlier = taught.filter((t) => t.eventId !== fb.saved?.eventId).slice(0, 3);
  const hint = fb.error ? <span className="text-red-700">{fb.error}</span>
    : fb.category && fb.dirty ? <span className="text-slate-500">{ROW_FEEDBACK_HINT[fb.category]}{withWords ? " Goes with the draft if you Send or Dismiss it." : ""}</span>
    : null;
  return (
    <div className="border-t border-slate-100 px-3 py-1.5 text-xs" role="group" aria-label="Feedback for the bot">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="inline-flex max-w-full items-center gap-1 font-semibold text-slate-600 hover:text-slate-900" title="Tell the bot what it got wrong (T)">
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Feedback
        {!open && fb.saved && <span className="ml-1 truncate font-normal">{notedLine(fb.saved)}</span>}
        {!open && !fb.saved && fb.category && <span className="ml-1 font-normal text-blue-700">· {ROW_FEEDBACK_LABEL[fb.category]}</span>}
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5">
          {withWords && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="w-24 shrink-0 text-slate-500">The words</span>
              <Chips codes={ROW_FEEDBACK_WORDS} category={fb.category} onPick={fb.setCategory} busy={fb.busy} />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-24 shrink-0 text-slate-500">What it did</span>
            <Chips codes={ROW_FEEDBACK_ACTS} category={fb.category} onPick={fb.setCategory} busy={fb.busy} />
          </div>
          <div className="flex items-start gap-2">
            <textarea id={TEACH_NOTE_ID} ref={noteRef} rows={1} value={fb.note} onChange={(e) => fb.setNote(e.target.value)} maxLength={ROW_FEEDBACK_NOTE_MAX}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); fb.save(); } }}
              placeholder="In your words: what should it have done or said, and why?" aria-label="Feedback, in your words"
              className="min-w-0 flex-1 resize-y rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:border-blue-500 focus:outline-none" />
            <button type="button" className={BTN} disabled={fb.busy || !fb.dirty} onClick={fb.save} title={fb.category ? "" : "Pick one first"}>
              {fb.busy ? "…" : "Save"}
            </button>
          </div>
          {(hint || fb.saved) && <div>{hint || notedLine(fb.saved)}</div>}
          {earlier.length > 0 && (
            <ul className="space-y-0.5 text-slate-500" aria-label="What you said on their other rows">
              {earlier.map((t) => (
                <li key={t.eventId}><span className="tabular-nums">{day(t.at)}</span> · {t.label}{t.note ? ` — ${t.note}` : ""}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * <RowFeedback rowId rowKind item feedback /> — the collapsed version for
 * lists (the outbox): "Teach it", or what was noted and "edit".
 */
export default function RowFeedback({ rowId, rowKind = "", item = {}, feedback = null }) {
  const fb = useRowFeedback({ rowId, rowKind, item, feedback });
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="flex w-full flex-wrap items-center gap-2 text-xs">
        {notedLine(fb.saved)}
        <button type="button" className="text-blue-700 hover:underline" onClick={() => setOpen(true)} aria-label={fb.saved ? "Change what you taught it" : "Teach it"}>
          {fb.saved ? "edit" : "Teach it"}
        </button>
      </div>
    );
  }
  return (
    <div className="w-full space-y-1.5 rounded-lg bg-slate-50 px-3 py-2" role="group" aria-label="What should the bot have done?">
      <div className="text-xs font-medium text-slate-600">What should the bot have done?</div>
      <div className="flex flex-wrap gap-1.5">
        <Chips codes={ROW_FEEDBACK_ACTS} category={fb.category} onPick={fb.setCategory} busy={fb.busy} />
      </div>
      {fb.category && <div className="text-[11px] text-slate-500">{ROW_FEEDBACK_HINT[fb.category]}</div>}
      <textarea rows={2} value={fb.note} onChange={(e) => fb.setNote(e.target.value)} maxLength={ROW_FEEDBACK_NOTE_MAX}
        placeholder="In your words: what should it have done, or said, and why. The coach reads this."
        aria-label="What it should have done, in your words"
        className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm" />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] tabular-nums text-slate-400">{fb.note.length}/{ROW_FEEDBACK_NOTE_MAX}</span>
        {fb.error && <span className="text-xs text-red-700">{fb.error}</span>}
        <div className="ml-auto flex items-center gap-2">
          <button type="button" className={BTN} disabled={fb.busy} onClick={() => setOpen(false)}>Cancel</button>
          <button type="button" className={BTN_PRIMARY} disabled={fb.busy || !fb.category}
            onClick={async () => { if (await fb.save()) setOpen(false); }}>{fb.busy ? "…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}
