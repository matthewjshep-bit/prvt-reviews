// Composer.jsx — the reply box in Today's work pane when the bot has drafted
// something: the draft is simply the text in the box, yours to edit and send.
//
// Everything the old draft card said about the draft (what they said, the
// summary, the gates' flags, what was filed to their profile) is already in
// the thread beside it or on their record, so it isn't repeated here. What
// stays is what can change what you press: the draft's age (and whether they
// have written since), a countdown with Hold when it is about to send itself,
// a counter the band refused, and the actions the bot suggested.
//
// Send and Dismiss are the outbox's (the coach still sees your edit). The
// Feedback control under the box travels with them: a chip you picked is
// saved, and a chip about the words is also the draft's own why.

import React, { useEffect, useState } from "react";
import { AlertTriangle, Check, Clock, Pause, Play, Send } from "lucide-react";
import { isWordFeedback } from "@shared/row-feedback.js";
import { applyDraftAction, dismissReplyDraft, holdReplyDraft, sendReplyDraft } from "./api.js";
import { actionLabel, ago, countdown, money } from "./ConversationOutbox.jsx";
import { BTN, BTN_PRIMARY, Pill } from "./ui.jsx";

/**
 * draftReason(fb) → { code, note } | null — the draft's own why, from the
 * row's Feedback pick. Only a chip about the words (or "shouldn't have
 * replied") is one; "should have taken an action" is about the row.
 */
export const draftReason = (fb) => (fb?.category && isWordFeedback(fb.category) ? { code: fb.category, note: String(fb.note || "").trim() } : null);

/**
 * <DraftComposer draft offerId sendsEnabled serverOffsetMs onDone textareaId lastInboundAt fb />
 *   lastInboundAt  when they last wrote (from the thread), so a draft older than that says so
 *   fb             useRowFeedback(…) of this row, or null
 */
export function DraftComposer({ draft: d, sendsEnabled, serverOffsetMs = 0, onDone, textareaId, lastInboundAt = null, fb = null }) {
  const [text, setText] = useState(d.reply || "");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(false);
  const [, tick] = useState(0);
  const scheduled = d.status === "scheduled" && d.sendAt;

  useEffect(() => {
    if (!scheduled) return undefined;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [scheduled]);

  const edited = text.trim() !== String(d.reply || "").trim();
  const chars = text.length;
  const remaining = scheduled ? Date.parse(d.sendAt) - (Date.now() - serverOffsetMs) : 0;
  const pending = (d.actions || []).filter((a) => a.status === "pending");
  const failedBand = d.exception && !d.exception.passed ? d.exception : null;
  const stale = lastInboundAt && d.createdAt && Date.parse(lastInboundAt) > Date.parse(d.createdAt);
  const reason = () => draftReason(fb);

  const run = async (label, fn) => {
    setBusy(label); setError("");
    try { await fn(); onDone?.(); }
    catch (e) { setError(e.message); }
    setBusy("");
  };
  const dismiss = () => run("dismiss", async () => {
    await fb?.commit();
    await dismissReplyDraft(d.id, reason());
  });
  const send = async () => {
    if (busy || !text.trim()) return;
    setBusy("send"); setError("");
    try {
      await fb?.commit();
      const r = await sendReplyDraft(d.id, text, edited ? reason() : null);
      if (r.dryRun) { setPreview(true); setBusy(""); return; }
      onDone?.();
    } catch (e) { setError(e.message); setBusy(""); }
  };

  return (
    <div className="px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <label htmlFor={textareaId} className="font-semibold uppercase tracking-wide text-slate-500">Reply</label>
        <span className="text-slate-500">drafted by the bot · {ago(d.createdAt)}</span>
        {stale && <span className="inline-flex items-center gap-1 font-medium text-amber-800"><AlertTriangle size={12} /> they've written since — read it before sending</span>}
        {d.channel === "email" && <Pill label="email" small />}
      </div>

      {scheduled && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
          <Clock size={12} />
          {remaining > 0 ? <>Sending itself in <span className="tabular-nums font-semibold">{countdown(remaining)}</span></> : "Sending now…"}
          <button type="button" className={`${BTN} ml-auto`} disabled={Boolean(busy)} onClick={() => run("hold", () => holdReplyDraft(d.id))}>
            <Pause size={12} /> {busy === "hold" ? "Holding…" : "Hold"}
          </button>
        </div>
      )}

      <textarea
        id={textareaId}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); send(); } }}
        className="mt-1.5 w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        rows={Math.min(6, Math.max(2, Math.ceil(text.length / 90)))}
        value={text}
        onChange={(e) => { setText(e.target.value); setPreview(false); }}
        placeholder="Write the reply here"
      />

      {failedBand && (
        <div className="mt-1 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-900">
          <span className="font-medium">Outside the band</span>{failedBand.reason ? ` — ${failedBand.reason}` : ""}
          {Number(failedBand.theirAmount) > 0 && Number(failedBand.ceiling) > 0 ? ` (${money(failedBand.theirAmount)} against a ${money(failedBand.ceiling)} ceiling)` : ""}.
        </div>
      )}

      {pending.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-slate-500">The bot suggests</span>
          {pending.map((a) => (
            <button key={a.id} type="button" disabled={Boolean(busy)} onClick={() => run(a.id, () => applyDraftAction(d.id, a.id))}
              className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700 transition-colors hover:bg-violet-100 disabled:opacity-40"
              title="Click to apply">
              <Play size={11} /> {busy === a.id ? "Applying…" : actionLabel(a)}
            </button>
          ))}
        </div>
      )}
      {(d.actions || []).some((a) => a.status === "failed") && (
        <div className="mt-1 text-xs text-red-700">
          {(d.actions || []).filter((a) => a.status === "failed").map((a) => `${a.type.replace(/_/g, " ")} failed${a.error ? `: ${a.error}` : ""}`).join(" · ")}
        </div>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <span className="text-xs tabular-nums text-slate-500">
          {chars} chars{d.channel !== "email" && chars > 160 ? ` · ${Math.ceil(chars / 153)} texts` : ""}{edited ? " · edited" : ""}
        </span>
        {error && <span className="text-xs text-red-700">{error}</span>}
        {preview && !error && (
          <span className="text-xs text-amber-700">Previewed only — {sendsEnabled ? "try again" : "set CARD_SENDS_ENABLED=true on the broker to send"}</span>
        )}
        {!preview && !error && (d.actions || []).some((a) => a.status !== "pending" && a.status !== "failed") && (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-700"><Check size={11} /> suggestions applied</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button type="button" className={BTN} disabled={Boolean(busy)} onClick={dismiss} title="Bin the draft. Feedback you picked below goes with it.">
            {busy === "dismiss" ? "Dismissing…" : "Dismiss"}
          </button>
          <button type="button" className={BTN_PRIMARY} disabled={Boolean(busy) || !text.trim()} onClick={send} title="⌘↵">
            <Send size={13} /> {busy === "send" ? "Sending…" : scheduled ? "Send now" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
