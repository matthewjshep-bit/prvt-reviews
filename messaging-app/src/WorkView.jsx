// WorkView.jsx — Today as an inbox: the queue down the left, the row you are
// working filling the rest (WorkPane).
//
// It owns which row is open: from ?row= on load, J/K and ‹ › to move, and,
// when the row you were on is resolved and leaves the queue, the one after
// it. The next row's offer, thread and lessons are read ahead so moving is
// instant. Keys are ignored while you type or while the contact record is open.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { offerEditorUrl } from "./api.js";
import WorkRail from "./WorkRail.jsx";
import WorkPane from "./WorkPane.jsx";
import { REPLY_BOX_ID, loadThread, threadKey } from "./ConversationPanel.jsx";
import { TEACH_NOTE_ID, coachKey, loadCoach } from "./CoachPanel.jsx";
import { loadOffer, offerKey } from "./OfferPanel.jsx";
import { forget, prefetch } from "./work-data.js";
import { GROUP_LABEL, KIND_LABEL, keyIntent, neighborId, nextAfterRemoval, orderRows, railLabel, rowTargets, teachRowId } from "./work-queue.js";

const readRowParam = () => {
  try { return new URLSearchParams(window.location.search).get("row") || null; } catch { return null; }
};
const writeRowParam = (id) => {
  try {
    const p = new URLSearchParams(window.location.search);
    if (id) p.set("row", id); else p.delete("row");
    window.history.replaceState(window.history.state, "", `${window.location.pathname}?${p}`);
  } catch { /* the iframe can refuse history calls */ }
};
const modalOpen = () => typeof document !== "undefined" && Boolean(document.querySelector('[aria-modal="true"]'));

/**
 * <WorkView actions drafts rowFeedback sendsEnabled serverOffsetMs onDone bodies? initialRowId? />
 *   onDone   refresh Today (the queue and its drafts)
 *   bodies   tests only: data for the pane's three sides instead of loading it
 */
export default function WorkView({ actions = [], drafts = [], rowFeedback = {}, sendsEnabled, serverOffsetMs = 0, onDone, bodies = null, initialRowId = null }) {
  const ordered = useMemo(() => orderRows(actions), [actions]);
  const [selectedId, setSelectedId] = useState(() => initialRowId || (typeof window !== "undefined" ? readRowParam() : null));
  const [filter, setFilter] = useState("");
  const [machineOpen, setMachineOpen] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [toast, setToast] = useState("");
  const prevOrdered = useRef(ordered);
  const shownId = useRef(null);   // the row on screen at the last render

  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? ordered.filter((r) => `${r.address || ""} ${r.contactName || ""} ${r.title || ""}`.toLowerCase().includes(needle))
    : ordered;
  const current = visible.find((r) => r.id === selectedId) || visible[0] || null;
  const index = current ? visible.indexOf(current) : -1;
  const targets = useMemo(() => rowTargets(current, drafts), [current, drafts]);
  const prevId = current ? neighborId(visible, current.id, -1) : null;
  const nextId = current ? neighborId(visible, current.id, 1) : null;

  // The queue refreshed: if the row on screen was resolved, move to the one
  // after it (not back to the top).
  useEffect(() => {
    const before = prevOrdered.current;
    prevOrdered.current = ordered;
    const was = shownId.current;
    if (!was || before === ordered) return;
    const next = nextAfterRemoval(before, ordered, was);
    if (next !== was) {
      setSelectedId(next);
      const row = ordered.find((r) => r.id === next);
      setToast(row ? `Done — next: ${railLabel(row)}` : "Done — that was the last one.");
    }
  }, [ordered]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(""), 3500); return () => clearTimeout(t); }, [toast]);
  useEffect(() => { shownId.current = current?.id || null; if (current) writeRowParam(current.id); }, [current?.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Read the next row ahead.
  useEffect(() => {
    const next = visible.find((r) => r.id === nextId);
    if (!next) return;
    const t = rowTargets(next, drafts);
    if (t.offerId) prefetch(offerKey(t.offerId), loadOffer(t.offerId));
    if (t.contactId) {
      prefetch(threadKey(t.contactId), loadThread(t.contactId), 30000);
      prefetch(coachKey(t.contactId), loadCoach(t.contactId), 120000);
    }
  }, [nextId]);   // eslint-disable-line react-hooks/exhaustive-deps

  const go = (id) => { if (id) { setSelectedId(id); setShowKeys(false); } };

  // Something on this row changed: its offer and lessons are stale, and so is
  // the queue.
  const done = () => { forget(offerKey(targets.offerId), coachKey(targets.contactId)); onDone?.(); };

  useEffect(() => {
    function onKey(e) {
      if (modalOpen()) return;
      const intent = keyIntent(e);
      if (!intent) return;
      e.preventDefault();
      if (intent === "next") go(nextId);
      else if (intent === "prev") go(prevId);
      else if (intent === "reply") document.getElementById(REPLY_BOX_ID)?.focus();
      else if (intent === "teach") document.getElementById(TEACH_NOTE_ID)?.focus();
      else if (intent === "offer" && targets.offerId) window.open(offerEditorUrl(targets.offerId), "_blank", "noreferrer");
      else if (intent === "help") setShowKeys((v) => !v);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const taughtIds = new Set(Object.keys(rowFeedback || {}));
  const isTaught = (r) => Boolean(r.feedback) || taughtIds.has(teachRowId(r));
  const feedback = current ? current.feedback || rowFeedback[teachRowId(current)] || null : null;

  // Below lg the rail is a picker in the header.
  const picker = (
    <select className="max-w-[9rem] rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs lg:hidden" aria-label="Pick a row"
      value={current?.id || ""} onChange={(e) => go(e.target.value)}>
      {["yours", "stuck", "machine"].map((g) => {
        const rows = visible.filter((r) => (r.group || "yours") === g);
        return rows.length ? (
          <optgroup key={g} label={`${GROUP_LABEL[g]} (${rows.length})`}>
            {rows.map((r) => <option key={r.id} value={r.id}>{railLabel(r)} — {KIND_LABEL[r.kind] || r.kind}</option>)}
          </optgroup>
        ) : null;
      })}
    </select>
  );

  return (
    <div className="relative flex min-h-[560px] gap-3 lg:h-[calc(100vh-9.75rem)]">
      <div className="hidden w-72 shrink-0 lg:block">
        <WorkRail rows={visible} total={ordered.length} selectedId={current?.id} onSelect={go} filter={filter} onFilter={setFilter}
          machineOpen={machineOpen} onMachineOpen={setMachineOpen} isTaught={isTaught} />
      </div>
      {current ? (
        <WorkPane key={current.id} item={current} targets={targets} index={index} total={visible.length}
          onPrev={prevId ? () => go(prevId) : null} onNext={nextId ? () => go(nextId) : null} picker={picker}
          onDone={done} sendsEnabled={sendsEnabled} serverOffsetMs={serverOffsetMs} feedback={feedback}
          showKeys={showKeys} onToggleKeys={() => setShowKeys((v) => !v)} bodies={bodies} />
      ) : (
        <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          {needle ? "Nothing matches that filter." : "Nothing is waiting on you. The machine has the rest."}
        </div>
      )}
      {toast && (
        <div role="status" className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
