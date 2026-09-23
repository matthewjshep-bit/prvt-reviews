// ThreadView.jsx — a conversation with one person, as bubbles. Theirs on the
// left, ours on the right in blue; calls and voicemails in italics; email
// and other channels labelled. Messages come oldest first from
// GET /api/contacts/:id/thread.
//
// Presentational: the draft's "Show conversation" peek and Today's work pane
// both load the thread themselves and hand it here.

import React from "react";

const stamp = (at) => (at ? new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const dayOf = (at) => (at ? new Date(at).toDateString() : "");

export function Bubble({ m }) {
  const ours = m.dir === "out";
  const call = m.channel === "call" || m.channel === "voicemail";
  return (
    <div className={`flex ${ours ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[80%] rounded-lg px-2.5 py-1.5 text-sm ${ours ? "bg-blue-600 text-white" : "border border-slate-200 bg-white text-slate-900"}`}>
        {call
          ? <span className="italic">{ours ? "We called" : "They called"}{m.channel === "voicemail" ? " · voicemail" : ""}{m.body ? ` — ${m.body}` : ""}</span>
          : <span className="whitespace-pre-wrap break-words">{m.body}</span>}
        <div className={`mt-0.5 text-[11px] ${ours ? "text-blue-100" : "text-slate-500"}`}>
          {m.channel !== "sms" ? `${m.channel} · ` : ""}{stamp(m.at)}
        </div>
      </div>
    </div>
  );
}

/**
 * <ThreadView messages more dayBreaks />
 *   more       the broker had older messages than it sent
 *   dayBreaks  a quiet date line between days (the work pane's long view)
 */
export default function ThreadView({ messages = [], more = false, dayBreaks = false, moreHint = "open the contact for the rest" }) {
  return (
    <div className="space-y-1.5">
      {more && <div className="text-center text-xs text-slate-500">Showing the latest {messages.length} — {moreHint}.</div>}
      {messages.map((m, i) => {
        const breakHere = dayBreaks && dayOf(m.at) && dayOf(m.at) !== dayOf(messages[i - 1]?.at);
        return (
          <React.Fragment key={m.id || i}>
            {breakHere && (
              <div className="pt-1.5 text-center text-xs font-medium text-slate-500">
                {new Date(m.at).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}
              </div>
            )}
            <Bubble m={m} />
          </React.Fragment>
        );
      })}
    </div>
  );
}
