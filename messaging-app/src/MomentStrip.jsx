// MomentStrip.jsx — the line under the person's name in the work pane: what
// happened on this house with them, oldest first, then what happens next.
//
//   priced 385K 9/12 · sent 9/12 · nudge went 9/15 · they wrote ×2 9/16 · countered 425K 9/18 → next: nudge Thu · History
//
// Matt, 2026-10-01: "a tiny timeline of events where the person's name is".
// The data is GET /api/contacts/:id/timeline (shared/deal-moments.js). Dots
// say who: them slate, us blue, the machine violet. History opens their
// whole record. Renders nothing until the timeline has loaded, and nothing
// at all against a broker that doesn't have the route.

import React, { useState } from "react";
import { nextWords, shortDate } from "./bot-state.js";

const DOT = { them: "bg-slate-400", us: "bg-blue-500", machine: "bg-violet-500" };
const WHO = { them: "them", us: "us", machine: "the machine" };
const NEXT_CLS = { machine: "text-violet-700", you: "text-amber-800" };

/**
 * <MomentStrip timeline onHistory max />
 *   timeline  { moments, total, next } or null
 *   onHistory open their record (the contact drawer), or null
 */
export default function MomentStrip({ timeline, onHistory = null, max = 6, now = Date.now() }) {
  const [all, setAll] = useState(false);
  if (!timeline) return null;
  const moments = timeline.moments || [];
  const shown = all ? moments : moments.slice(-max);
  const earlier = (timeline.total || moments.length) - shown.length;
  const next = nextWords(timeline.next, now);
  if (!moments.length && !next) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-slate-600" aria-label="What happened, and what's next">
      {earlier > 0 && (
        moments.length > shown.length
          ? <button type="button" onClick={() => setAll(true)} className="text-slate-500 hover:text-slate-800 hover:underline">+{earlier} earlier</button>
          : <span className="text-slate-400">+{earlier} earlier</span>
      )}
      {shown.map((m, i) => (
        <React.Fragment key={`${m.kind}:${m.at}:${i}`}>
          {(i > 0 || earlier > 0) && <span className="text-slate-300" aria-hidden="true">·</span>}
          <span className="inline-flex items-center gap-1 whitespace-nowrap"
            title={`${new Date(m.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · ${WHO[m.who] || ""}`}>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[m.who] || "bg-slate-300"}`} aria-hidden="true" />
            <span>{m.label}</span>
            <span className="tabular-nums text-slate-400">{shortDate(m.at)}</span>
          </span>
        </React.Fragment>
      ))}
      {next?.text && (
        <span className={`whitespace-nowrap font-medium ${NEXT_CLS[next.who] || "text-slate-500"}`} title={next.title}>
          {moments.length ? "→ " : ""}{next.text}
        </span>
      )}
      {onHistory && (
        <button type="button" onClick={onHistory} className="ml-0.5 text-blue-700 hover:underline" title="Their whole record: facts, offers, every event">History</button>
      )}
    </div>
  );
}
