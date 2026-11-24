// RowOps.jsx — what is left of the Today row's controls (the Desk was
// retired 2026-10-20; its op buttons went with it, 2026-11-23): the answer
// box for a question the bot couldn't answer (ConversationPanel), and the
// ids the Feedback control sends (PaneParts).

import React, { useState } from "react";
import { answerNamesMoney } from "@shared/promise-resolver.js";
import { BTN_PRIMARY } from "./ui.jsx";
import { answerPartnerQuestion, forgetStandingAnswer } from "./api.js";

// What the Teach control needs to know about a row — ids only, plus the
// title and detail as a fallback for rows with no draft behind them.
export const feedbackItemOf = (item) => ({
  contactId: item.contactId || null, draftId: item.draftId || null, offerId: item.offerId || null, jobId: item.jobId || null,
  auditKind: item.kind === "audit_owed" ? String(item.id || "").split(":")[1] || "" : "", address: item.address || "", title: item.title || "", detail: item.detail || "",
});

// A question the bot couldn't answer. What is typed here goes to them in the
// bot's voice (as a draft, so Send is still yours) and is kept so the bot
// answers it itself next time.
export function AnswerBox({ item, onDone, textareaId }) {
  const [text, setText] = useState("");
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [done, setDone] = useState(null);
  async function send() {
    setBusy(true); setNote("");
    try {
      const r = await answerPartnerQuestion({ contactId: item.contactId, draftId: item.fromDraftId, address: item.address, question: item.question, answer: text, saveAsFact: keep });
      if (!r.started) { setNote(`Didn't draft it: ${r.skipped}`); return; }
      setDone(r);
      onDone?.();
    } catch (e) {
      setNote(e.message || "That didn't work.");
    } finally { setBusy(false); }
  }
  async function undo() {
    setBusy(true);
    try { await forgetStandingAnswer(done.savedAnswerId); setDone({ ...done, savedAnswerId: null, undone: true }); }
    catch (e) { setNote(e.message || "Couldn't undo that."); }
    finally { setBusy(false); }
  }
  if (done) {
    return (
      <div className="w-full rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
        Drafting your answer now. It lands in the conversation as a draft, for your Send.
        {done.savedAnswerId && <> Kept for next time. <button type="button" className="text-blue-700 underline" disabled={busy} onClick={undo}>Undo</button></>}
        {done.undone && " Not kept."}
        {done.notSaved && ` Not kept: ${done.notSaved}.`}
      </div>
    );
  }
  return (
    <div className="w-full space-y-1.5">
      <label className="block text-xs font-medium text-slate-600" htmlFor={textareaId || `answer-${item.id}`}>They asked: “{item.question}”</label>
      <textarea id={textareaId || `answer-${item.id}`} rows={2} value={text} onChange={(e) => setText(e.target.value)} maxLength={600}
        placeholder="Your answer, in your own words. The bot puts it in its voice."
        className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:border-blue-500 focus:outline-none" />
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Save for next time, so the bot answers this itself
        </label>
        {keep && answerNamesMoney(text) && <span className="text-xs text-amber-700">This names a dollar amount. The bot will draft it next time, but it will wait for you each time.</span>}
        {note && <span className="text-xs text-red-700">{note}</span>}
        <button type="button" className={`${BTN_PRIMARY} ml-auto`} disabled={busy || !text.trim()} onClick={send}>{busy ? "…" : "Draft the reply"}</button>
      </div>
    </div>
  );
}
