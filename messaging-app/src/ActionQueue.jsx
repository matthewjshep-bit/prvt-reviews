// ActionQueue.jsx — the things waiting on a person, grouped, with the button
// that does each one right there.
//
// Drafts render through the same DraftRow the outbox uses, so send / edit /
// dismiss / hold / apply come for free and behave identically. Everything
// else is a compact row: who, where, what, and the ops the endpoint named.

import React, { useState } from "react";
import { ChevronDown } from "lucide-react";
import { ACTION_KINDS } from "@shared/pipeline.js";
import { BTN, BTN_DANGER, BTN_PRIMARY, Pill } from "./ui.jsx";
import { DraftRow } from "./ConversationOutbox.jsx";
import ContactLink from "./ContactLink.jsx";
import { CONFIRM, describeResult, linkFor, runOp } from "./pipeline-ops.js";

const SEV = {
  now: { dot: "bg-rose-500", label: "now", cls: "bg-rose-100 text-rose-700" },
  soon: { dot: "bg-amber-400", label: "soon", cls: "bg-amber-100 text-amber-800" },
  fyi: { dot: "bg-slate-300", label: "fyi", cls: "bg-slate-100 text-slate-600" },
};
const DRAFT_KINDS = new Set(["draft_waiting", "draft_scheduled"]);

function OpButton({ op, item, onDone }) {
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
      {note && <span className="text-[11px] text-slate-500">{note}</span>}
    </span>
  );
}

function ActionRow({ item, onDone, onShowDraft }) {
  const sev = SEV[item.severity] || SEV.fyi;
  return (
    <li className="flex flex-wrap items-start gap-3 px-3 py-2.5">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${sev.dot}`} title={sev.label} />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-slate-800">{item.title}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
          {item.contactId && <ContactLink contactId={item.contactId} name={item.contactName || "contact"} party={item.kind.startsWith("deal") || item.kind === "blast_no_opens" ? "investor" : "agent"} stopPropagation />}
          {item.address && <span>{item.address}</span>}
          {item.detail && <span className="text-slate-400">· {item.detail}</span>}
        </div>
      </div>
      <div className="flex flex-wrap items-start gap-1.5">
        {item.ops.map((op) => op.key === "show_draft"
          ? <button key={op.key} type="button" className={BTN} onClick={() => onShowDraft?.(item.draftId)}>{op.label}</button>
          : <OpButton key={op.key} op={op} item={item} onDone={onDone} />)}
      </div>
    </li>
  );
}

export default function ActionQueue({ actions = [], draftsById = {}, sendsEnabled, serverOffsetMs = 0, onDone, highlightDraftId, onShowDraft }) {
  const groups = ACTION_KINDS
    .map((k) => ({ ...k, items: actions.filter((a) => a.kind === k.key) }))
    .filter((g) => g.items.length);
  if (!groups.length) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-400">
        Nothing is waiting on you.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {groups.map((g) => {
        const now = g.items.filter((i) => i.severity === "now").length;
        const open = now > 0 || g.items.some((i) => i.draftId === highlightDraftId);
        return (
          <details key={g.key} open={open} className="group rounded-xl border border-slate-200 bg-white">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-sm font-semibold">
              <ChevronDown size={14} className="text-slate-400 transition-transform group-open:rotate-180" />
              {g.label}
              <Pill small label={String(g.items.length)} />
              {now > 0 && <Pill small label={`${now} now`} cls={SEV.now.cls} />}
            </summary>
            <ul className="divide-y divide-slate-100 border-t border-slate-100">
              {g.items.map((item) => {
                if (DRAFT_KINDS.has(g.key) && draftsById[item.draftId]) {
                  return (
                    <li key={item.id} className={item.draftId === highlightDraftId ? "ring-2 ring-inset ring-blue-300" : ""} id={`draft-${item.draftId}`}>
                      <ul><DraftRow draft={draftsById[item.draftId]} sendsEnabled={sendsEnabled} serverOffsetMs={serverOffsetMs} onDone={onDone} /></ul>
                    </li>
                  );
                }
                return <ActionRow key={item.id} item={item} onDone={onDone} onShowDraft={onShowDraft} />;
              })}
            </ul>
          </details>
        );
      })}
    </div>
  );
}
