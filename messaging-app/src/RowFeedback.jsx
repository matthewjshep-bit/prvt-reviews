// RowFeedback.jsx — "Teach it": what should the bot have done with this row?
//
// Every row on Today is a place the bot stopped and a person had to act.
// This is where you say what it should have done instead — one of four
// categories and your own words — for the nightly coach to learn from. It is
// separate from resolving the row: saving here changes nothing about the
// row, and the row's own buttons still do what they did.
//
// After a save the row reads "noted · <category>"; saving again is a newer
// verdict (the coach reads the newest).

import React, { useState } from "react";
import { ROW_FEEDBACK, ROW_FEEDBACK_LABEL, ROW_FEEDBACK_HINT, ROW_FEEDBACK_NOTE_MAX } from "@shared/row-feedback.js";
import { sendRowFeedback } from "./api.js";
import { BTN, BTN_PRIMARY } from "./ui.jsx";

/**
 * <RowFeedback rowId rowKind item feedback />
 *   item: { contactId?, draftId?, offerId?, jobId?, auditKind?, address?, title?, detail? }
 *   feedback: what the pipeline already holds for this row ({ category, label, note, at }) or null
 *   alwaysOpen: the chips and note are always showing (Today's work pane), with
 *     what was saved above them; noteId names the note box for the T key
 */
export default function RowFeedback({ rowId, rowKind = "", item = {}, feedback = null, alwaysOpen = false, noteId }) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(feedback);
  const [category, setCategory] = useState(feedback?.category || "");
  const [note, setNote] = useState(feedback?.note || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    if (!category) return;
    setBusy(true); setError("");
    try {
      const r = await sendRowFeedback({
        rowId, rowKind, category, note,
        contactId: item.contactId || null, draftId: item.draftId || null, offerId: item.offerId || null, jobId: item.jobId || null,
        auditKind: item.auditKind || "", address: item.address || "", title: item.title || "", detail: item.detail || "",
      });
      setSaved(r.feedback);
      setOpen(false);
    } catch (e) {
      setError(e.message || "That didn't save.");
    } finally { setBusy(false); }
  }

  // The work pane's version: chips on one line, the note beside Save, and one
  // quiet line under them for what was saved, the chip's hint, or an error.
  if (alwaysOpen) {
    const line = error ? <span className="text-red-700">{error}</span>
      : saved ? <span className="text-emerald-700">noted · {saved.label}{saved.note ? <span className="text-slate-500"> — {saved.note}</span> : null}</span>
      : category ? <span className="text-slate-500">{ROW_FEEDBACK_HINT[category]}</span> : null;
    return (
      <div className="w-full space-y-1.5" role="group" aria-label="What should the bot have done?">
        <div className="flex flex-wrap gap-1.5">
          {ROW_FEEDBACK.map((code) => (
            <button key={code} type="button" disabled={busy} aria-pressed={category === code} title={ROW_FEEDBACK_HINT[code]}
              onClick={() => setCategory(code)}
              className={`rounded-full border px-2 py-0.5 text-xs ${category === code ? "border-blue-600 bg-blue-50 text-blue-800" : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"}`}>
              {ROW_FEEDBACK_LABEL[code]}
            </button>
          ))}
        </div>
        <div className="flex items-start gap-2">
          <textarea id={noteId} rows={1} value={note} onChange={(e) => setNote(e.target.value)} maxLength={ROW_FEEDBACK_NOTE_MAX}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); save(); } }}
            placeholder="What should it have done or said, and why?" aria-label="What it should have done, in your words"
            className="min-w-0 flex-1 resize-y rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:border-blue-500 focus:outline-none" />
          <button type="button" className={BTN_PRIMARY} disabled={busy || !category} onClick={save} title={category ? "" : "Pick one of the four first"}>
            {busy ? "…" : saved ? "Save again" : "Save"}
          </button>
        </div>
        {line && <div className="text-xs">{line}</div>}
      </div>
    );
  }

  if (!open) {
    return (
      <div className="flex w-full flex-wrap items-center gap-2 text-xs">
        {saved
          ? <span className="text-emerald-700">noted · {saved.label}{saved.note ? <span className="text-slate-500"> — {saved.note}</span> : null}</span>
          : null}
        <button type="button" className="text-blue-700 hover:underline" onClick={() => setOpen(true)} aria-label={saved ? "Change what you taught it" : "Teach it"}>
          {saved ? "edit" : "Teach it"}
        </button>
      </div>
    );
  }
  return (
    <div className="w-full space-y-1.5 rounded-lg bg-slate-50 px-3 py-2" role="group" aria-label="What should the bot have done?">
      <div className="text-xs font-medium text-slate-600">What should the bot have done?</div>
      <div className="flex flex-wrap gap-1.5">
        {ROW_FEEDBACK.map((code) => (
          <button key={code} type="button" disabled={busy} aria-pressed={category === code} title={ROW_FEEDBACK_HINT[code]}
            onClick={() => setCategory(code)}
            className={`rounded-full border px-2 py-0.5 text-xs ${category === code ? "border-blue-600 bg-blue-50 text-blue-800" : "border-slate-300 text-slate-600 hover:bg-white"}`}>
            {ROW_FEEDBACK_LABEL[code]}
          </button>
        ))}
      </div>
      {category && <div className="text-[11px] text-slate-500">{ROW_FEEDBACK_HINT[category]}</div>}
      <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={ROW_FEEDBACK_NOTE_MAX}
        placeholder="In your words: what should it have done, or said, and why. The coach reads this."
        aria-label="What it should have done, in your words"
        className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm" />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] tabular-nums text-slate-400">{note.length}/{ROW_FEEDBACK_NOTE_MAX}</span>
        {error && <span className="text-xs text-red-700">{error}</span>}
        <div className="ml-auto flex items-center gap-2">
          <button type="button" className={BTN} disabled={busy} onClick={() => { setOpen(false); setError(""); }}>Cancel</button>
          <button type="button" className={BTN_PRIMARY} disabled={busy || !category} onClick={save}>{busy ? "…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}
