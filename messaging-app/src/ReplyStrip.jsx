// ReplyStrip.jsx — the Conversation AI's outbox, as a strip.
//
// A GHL workflow hands an inbound text to the broker, which works out whether
// it came from a listing agent or an investor, reads the right record book,
// and drafts what we'd say. A draft sits here until a person sends it (edited
// or not) or dismisses it — or, for the intents the Conversation AI page has
// cleared, counts down to sending itself, with a Hold button for the minutes
// in between. Same shape and place as the auto-underwrite strip, and like it,
// the strip disappears when there is nothing to show — unless `emptyText` is
// given, in which case it is a card that says so (the tab's own outbox).

import React, { useEffect, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import { getReplyDrafts } from "./api.js";
import { LIVE, OutboxList } from "./ConversationOutbox.jsx";

const POLL_MS = 5000;

export default function ReplyStrip({ title = "Conversation AI", emptyText = null, refreshKey = 0 }) {
  const [drafts, setDrafts] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [sendsEnabled, setSendsEnabled] = useState(true);
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const timer = useRef(null);

  const refresh = async () => {
    const r = await getReplyDrafts();
    setDrafts(r.drafts || []);
    setJobs((r.jobs || []).filter((j) => LIVE.has(j.status) || j.status === "error" || j.status === "held"));
    setSendsEnabled(Boolean(r.sendsEnabled));
    if (r.now) setServerOffsetMs(Date.now() - Date.parse(r.now));
    return r;
  };

  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const r = await refresh();
        if (!alive) return;
        // Fast while something is moving or counting down; slow when idle.
        const live = (r.jobs || []).some((j) => LIVE.has(j.status)) || (r.drafts || []).some((d) => d.status === "scheduled");
        timer.current = setTimeout(tick, live ? POLL_MS : POLL_MS * 12);
      } catch {
        if (alive) timer.current = setTimeout(tick, POLL_MS * 12);
      }
    }
    tick();
    return () => { alive = false; clearTimeout(timer.current); };
  }, [refreshKey]);

  const showing = drafts.length || jobs.some((j) => LIVE.has(j.status)) ||
    jobs.some((j) => (j.status === "error" || j.status === "held") && Date.now() - Date.parse(j.finishedAt || 0) < 3600_000);
  if (!showing && !emptyText) return null;

  return (
    <div className="mb-3 overflow-hidden rounded-xl border border-slate-300 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600">
        <MessageSquare size={13} /> {title}
        {!sendsEnabled && (
          <span className="ml-auto normal-case font-normal tracking-normal text-amber-700">
            Sends are off on the broker (CARD_SENDS_ENABLED) — Send will preview only, nothing auto-sends
          </span>
        )}
      </div>
      {showing
        ? <OutboxList jobs={jobs} drafts={drafts} sendsEnabled={sendsEnabled} serverOffsetMs={serverOffsetMs}
            onDone={() => { refresh().catch(() => {}); }} />
        : <div className="px-3 py-4 text-sm text-slate-400">{emptyText}</div>}
    </div>
  );
}
