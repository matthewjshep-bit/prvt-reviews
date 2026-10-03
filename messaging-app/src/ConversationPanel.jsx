// ConversationPanel.jsx — the right side of Today's work pane: everything
// said with this person, and the box to answer them in.
//
// The box holds the bot's open draft when it has one (DraftComposer: the
// draft is just the text, with Send, Dismiss, Hold and the bot's suggested
// actions; the coach still sees your edits). When it has none,
// it is a plain text box that goes out as you (POST /api/contacts/:id/reply)
// and leaves the thread to you for three days. A row that is a question the
// bot couldn't answer gets the answer box here instead (drafted in the bot's
// voice and kept for next time), with the plain box one click away.
//
// Under the box, the Feedback control for the whole row (RowFeedback.jsx),
// tucked away until T or the pane's ⋯ asks for it (Matt, 2026-10-01).

import React, { useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2, RefreshCw, Send } from "lucide-react";
import { getContactThread, ghlContactUrl, sendHandReply } from "./api.js";
import { PartyPill } from "./ConversationOutbox.jsx";
import { DraftComposer } from "./Composer.jsx";
import { PaneFeedback } from "./RowFeedback.jsx";
import ContactLink from "./ContactLink.jsx";
import ThreadView from "./ThreadView.jsx";
import { BTN_PRIMARY } from "./ui.jsx";
import { useLoad } from "./work-data.js";
import { AnswerBox } from "./RowOps.jsx";
import { COMPOSE_EVENT } from "./work-queue.js";

export const REPLY_BOX_ID = "work-reply";
export const threadKey = (contactId) => (contactId ? `thread:${contactId}` : null);
export const loadThread = (contactId) => () => getContactThread(contactId, 100);
const THREAD_POLL_MS = 30000;

/** The reply box when the bot has nothing drafted. */
export function HandReply({ contactId, offerId, name, sendsEnabled, onSent }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);   // { tone, text }
  // The Desk's counter answers write here (COMPOSE_EVENT); nothing sends until Send.
  useEffect(() => {
    const onCompose = (e) => { if (e?.detail?.text) { setText(String(e.detail.text)); setNote(null); document.getElementById(REPLY_BOX_ID)?.focus(); } };
    window.addEventListener(COMPOSE_EVENT, onCompose);
    return () => window.removeEventListener(COMPOSE_EVENT, onCompose);
  }, []);
  const chars = text.length;
  async function send() {
    if (!text.trim() || busy) return;
    setBusy(true); setNote(null);
    try {
      const r = await sendHandReply(contactId, { text, offerId });
      if (r.dryRun) { setNote({ tone: "amber", text: "Previewed only — set CARD_SENDS_ENABLED=true on the broker to send." }); return; }
      setText("");
      setNote({ tone: "green", text: r.standAside ? "Sent. The bot's draft stood aside, and it leaves this thread to you for three days." : "Sent. The bot leaves this thread to you for three days." });
      onSent?.();
    } catch (e) {
      setNote({ tone: "red", text: e.message || "That didn't send." });
    } finally { setBusy(false); }
  }
  return (
    <div className="px-3 py-2.5">
      <div className="mb-1 text-xs text-slate-500">
        The bot has nothing drafted. What you type goes out as you{sendsEnabled ? "" : " (sends are off — this previews only)"}.
      </div>
      <textarea id={REPLY_BOX_ID} value={text} rows={Math.min(6, Math.max(2, Math.ceil(chars / 90)))}
        onChange={(e) => { setText(e.target.value); setNote(null); }}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); send(); } }}
        placeholder={`Text ${name || "them"}…`} aria-label={`Text ${name || "them"}`} maxLength={1600}
        className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <span className="text-xs tabular-nums text-slate-500">{chars} chars{chars > 160 ? ` · ${Math.ceil(chars / 153)} texts` : ""}</span>
        {note && <span className={`text-xs ${note.tone === "red" ? "text-red-700" : note.tone === "amber" ? "text-amber-700" : "text-emerald-700"}`}>{note.text}</span>}
        <button type="button" className={`${BTN_PRIMARY} ml-auto`} disabled={busy || !text.trim()} onClick={send} title="⌘↵">
          <Send size={13} /> {busy ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}

/**
 * <ConversationPanelBody … /> — given the thread; what the tests render.
 */
export function ConversationPanelBody({
  item, targets, thread = null, threadError = "", loading = false, onReload,
  sendsEnabled, serverOffsetMs = 0, onDone, onSent, fb = null, taught = [], bot = null,
}) {
  const bottom = useRef(null);
  const [typeInstead, setTypeInstead] = useState(false);
  const asked = Boolean(item.question && (item.ops || []).some((op) => op.key === "answer"));
  const count = thread?.messages?.length || 0;
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [count, targets.contactId]);
  const feedback = fb ? <PaneFeedback fb={fb} withWords={Boolean(targets.draft)} taught={taught} tucked /> : null;
  // You stopped the bot on them (the timeline's `bot`): the draft waits for you.
  const holdNote = bot?.held ? "The bot is stopped on them — nothing goes by itself; this waits for your Send." : "";
  // When they last wrote: a draft older than that was written to an earlier message.
  const lastInboundAt = (thread?.messages || []).filter((m) => m.dir === "in" && m.at).map((m) => m.at).sort().at(-1) || null;

  if (!targets.contactId) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-slate-500">
          This row isn't a conversation with one person{item.address ? ` — it's about ${item.address.split(",")[0]}` : ""}. Its buttons are above.
        </div>
        {feedback}
      </div>
    );
  }
  const name = item.contactName || targets.draft?.contactName || "";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Conversation</span>
        <ContactLink contactId={targets.contactId} name={name || "contact"} party={targets.party} className="truncate text-sm font-semibold text-slate-900" />
        <PartyPill party={targets.party} />
        <span className="ml-auto flex items-center gap-1">
          <a href={ghlContactUrl(targets.contactId)} target="_blank" rel="noreferrer" title="Open them in GHL"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-800">
            GHL <ExternalLink size={11} />
          </a>
          <button type="button" className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800" onClick={onReload} title="Load the latest messages" aria-label="Load the latest messages">
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          </button>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50 px-3 py-3">
        {!thread && !threadError && <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={13} className="animate-spin" /> Loading the conversation…</div>}
        {threadError && !thread && <div className="text-sm text-red-700">Couldn't load the conversation — {threadError}</div>}
        {thread && !count && <div className="text-sm text-slate-500">No messages with them in GHL yet.</div>}
        {thread && count > 0 && <ThreadView messages={thread.messages} more={thread.more} dayBreaks moreHint="GHL has the older ones" />}
        <div ref={bottom} />
      </div>

      <div className="max-h-[60%] shrink-0 overflow-y-auto border-t border-slate-200 bg-white">
        {targets.draft
          ? <DraftComposer key={targets.draft.id} draft={targets.draft} sendsEnabled={sendsEnabled} serverOffsetMs={serverOffsetMs}
              onDone={onSent || onDone} textareaId={REPLY_BOX_ID} lastInboundAt={lastInboundAt} fb={fb} holdNote={holdNote} />
          : asked && !typeInstead
          ? (
            <div className="px-3 py-2.5">
              <AnswerBox key={item.id} item={item} onDone={onSent || onDone} textareaId={REPLY_BOX_ID} />
              <button type="button" className="mt-1 text-xs text-blue-700 hover:underline" onClick={() => setTypeInstead(true)}>Text them yourself instead</button>
            </div>
          )
          : <HandReply key={targets.contactId} contactId={targets.contactId} offerId={targets.offerId} name={name.split(" ")[0]} sendsEnabled={sendsEnabled} onSent={onSent || onDone} />}
        {feedback}
      </div>
    </div>
  );
}

export default function ConversationPanel({ item, targets, sendsEnabled, serverOffsetMs, onDone, fb, taught, bot = null }) {
  const key = threadKey(targets.contactId);
  const t = useLoad(key, loadThread(targets.contactId), { maxAgeMs: THREAD_POLL_MS, pollMs: THREAD_POLL_MS });
  // After anything is sent: the thread is stale, and so is the queue. The old
  // thread stays on screen while the new one loads.
  const onSent = () => { t.reload(); onDone?.(); };
  return (
    <ConversationPanelBody item={item} targets={targets} thread={t.data} threadError={t.error} loading={t.loading}
      onReload={t.reload} sendsEnabled={sendsEnabled} serverOffsetMs={serverOffsetMs} onDone={onDone} onSent={onSent} fb={fb} taught={taught} bot={bot} />
  );
}
