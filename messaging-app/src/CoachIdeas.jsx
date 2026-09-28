// CoachIdeas.jsx — "Coach · 2 ideas" in the work pane's header: the lessons
// the nightly coach drew from this person's drafts, or from the feedback you
// gave on their rows, each with Apply / Reject. Nothing applies itself.
//
// It replaced the Teach-the-bot footer's right half (2026-09-28): a lesson
// is rare, so it gets a button when there is one and no space when there
// isn't. What you said before sits in the Feedback control instead.

import React, { useEffect, useRef, useState } from "react";
import { GraduationCap, X } from "lucide-react";
import { getCoachForContact } from "./api.js";
import { ProposalRow } from "./CoachCard.jsx";

export const coachKey = (contactId) => (contactId ? `coach:${contactId}` : null);
export const loadCoach = (contactId) => () => getCoachForContact(contactId);

/** <CoachIdeas coach onChanged /> — nothing at all when there is nothing to decide. */
export default function CoachIdeas({ coach, onChanged }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const proposals = coach?.proposals || [];
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    const onClick = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onClick); };
  }, [open]);
  if (!proposals.length) return null;
  return (
    <span ref={wrap} className="relative inline-flex">
      <button type="button" className="inline-flex items-center gap-1.5 rounded-lg border border-violet-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-violet-800 transition-colors hover:bg-violet-50" aria-expanded={open} onClick={() => setOpen((v) => !v)}
        title="What the nightly coach learned from this thread">
        <GraduationCap size={13} /> Coach · {proposals.length} {proposals.length === 1 ? "idea" : "ideas"}
      </button>
      {open && (
        <div role="dialog" aria-label="The coach proposes" className="absolute right-0 top-full z-30 mt-1 w-[26rem] max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">The coach proposes, from this thread</span>
            <button type="button" className="rounded p-0.5 text-slate-500 hover:bg-slate-100" onClick={() => setOpen(false)} aria-label="Close"><X size={14} /></button>
          </div>
          <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto">
            {proposals.map((p) => <ProposalRow key={p.id} p={p} canFile={Boolean(coach?.canFile)} onDone={onChanged} />)}
          </ul>
        </div>
      )}
    </span>
  );
}
