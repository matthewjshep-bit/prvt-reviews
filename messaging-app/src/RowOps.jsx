// RowOps.jsx — the buttons a Today row carries, and the answer box.
//
// The pipeline names each op by a key (shared/pipeline.js); pipeline-ops.js
// turns keys into calls. These are the controls for them, moved here from
// the old list unchanged so the work pane's header behaves exactly as the
// rows did: the same confirms, the same one-tap "why" on a dismissed promise,
// the same toast under the button.

import React, { useState } from "react";
import { PROMISE_DISMISS_REASONS, PROMISE_DISMISS_LABEL, answerNamesMoney } from "@shared/promise-resolver.js";
import { BTN, BTN_DANGER, BTN_PRIMARY } from "./ui.jsx";
import { answerPartnerQuestion, forgetStandingAnswer } from "./api.js";
import { CONFIRM, describeResult, linkFor, runOp } from "./pipeline-ops.js";

export const SEV = {
  now: { dot: "bg-rose-500", label: "now", cls: "bg-rose-100 text-rose-700" },
  soon: { dot: "bg-amber-400", label: "soon", cls: "bg-amber-100 text-amber-800" },
  fyi: { dot: "bg-slate-300", label: "fyi", cls: "bg-slate-100 text-slate-600" },
};

// "1:05 PM" today, "Thu 9:00 AM" otherwise.
export const whenLabel = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
};

// What the Teach control needs to know about a row — ids only, plus the
// title and detail as a fallback for rows with no draft behind them.
export const feedbackItemOf = (item) => ({
  contactId: item.contactId || null, draftId: item.draftId || null, offerId: item.offerId || null, jobId: item.jobId || null,
  auditKind: item.kind === "audit_owed" ? String(item.id || "").split(":")[1] || "" : "", address: item.address || "", title: item.title || "", detail: item.detail || "",
});

export function OpButton({ op, item, onDone }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const href = linkFor(op.key, item);
  if (href) {
    return <a href={href} target="_blank" rel="noreferrer" className={op.intent === "primary" ? BTN_PRIMARY : BTN}>{op.label}</a>;
  }
  const cls = op.intent === "danger" ? BTN_DANGER : op.intent === "primary" ? BTN_PRIMARY : BTN;
  async function go() {
    if (CONFIRM[op.key] && !window.confirm(CONFIRM[op.key](item))) return;
    setBusy(true); setNote("");
    try {
      const r = await runOp(op.key, item);
      setNote(describeResult(op.key, r));
      onDone?.();
    } catch (e) {
      setNote(e.message || "That didn't work.");
    } finally { setBusy(false); }
  }
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button type="button" className={cls} disabled={busy} onClick={go}>{busy ? "…" : op.label}</button>
      {note && <span className="text-xs text-slate-500">{note}</span>}
    </span>
  );
}

// Dismissing an owed promise asks why in one tap, the way a dismissed draft
// does: the nightly coach reads the answer. A second press skips the why.
export function DismissPromise({ op, item, onDone }) {
  const [askWhy, setAskWhy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  async function go(code = "") {
    setBusy(true); setNote("");
    try {
      const r = await runOp(op.key, item, code ? { reason: { code } } : null);
      setNote(describeResult(op.key, r));
      onDone?.();
    } catch (e) {
      setNote(e.message || "That didn't work.");
    } finally { setBusy(false); }
  }
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button type="button" className={BTN} disabled={busy} onClick={() => (askWhy ? go() : setAskWhy(true))}>
        {busy ? "…" : askWhy ? "Just dismiss" : op.label}
      </button>
      {askWhy && (
        <span className="flex max-w-sm flex-wrap gap-1" role="group" aria-label="Why dismiss it">
          {PROMISE_DISMISS_REASONS.map((code) => (
            <button key={code} type="button" disabled={busy} onClick={() => go(code)}
              className="rounded-full border border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50">
              {PROMISE_DISMISS_LABEL[code]}
            </button>
          ))}
        </span>
      )}
      {note && <span className="text-xs text-slate-500">{note}</span>}
    </span>
  );
}

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

// Ops the pane carries out itself rather than as a button: the draft is
// already open in the conversation, so "show the draft" has nowhere to go.
const PANE_HANDLES = new Set(["show_draft", "answer"]);

/**
 * <RowOpsBar item onDone onOpenContact hasDraft />
 * Every op the row names, in its order. open_outbox is the draft when the
 * conversation has it, the contact's record when it doesn't.
 */
export function RowOpsBar({ item, onDone, onOpenContact, hasDraft = false }) {
  const ops = (item.ops || []).filter((op) => !PANE_HANDLES.has(op.key) && !(op.key === "open_outbox" && hasDraft));
  if (!ops.length) return null;
  return (
    <div className="flex flex-wrap items-start gap-1.5">
      {ops.map((op) => op.key === "open_contact" || op.key === "open_outbox"
        ? <button key={op.key} type="button" className={op.intent === "primary" ? BTN_PRIMARY : BTN} onClick={onOpenContact}>{op.label}</button>
        : op.key === "dismiss_promise"
        ? <DismissPromise key={op.key} op={op} item={item} onDone={onDone} />
        : <OpButton key={op.key} op={op} item={item} onDone={onDone} />)}
    </div>
  );
}
