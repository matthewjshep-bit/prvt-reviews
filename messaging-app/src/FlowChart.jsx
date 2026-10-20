// FlowChart.jsx — a flow of texts drawn top to bottom, like a GHL workflow
// (Autopilot → Agents and Investors, 2026-10-20). The steps come from
// shared/autopilot-flows.js; this only draws them, and opens a step's editor
// in place when the tab passes one.

import React from "react";
import { Clock, GitBranch, MessageSquare, Pencil, Repeat, Zap } from "lucide-react";
import { FLOW_STATUS_LABEL } from "@shared/autopilot-flows.js";
import { carrierFlags } from "@shared/carrier-words.js";
import { fillTemplate } from "@shared/standard-texts.js";
import { BTN, Pill } from "./ui.jsx";

const ICON = { trigger: Zap, text: MessageSquare, wait: Clock, branch: GitBranch, loop: Repeat };
const DOT = {
  trigger: "bg-blue-600 text-white", text: "bg-white text-blue-700 ring-1 ring-blue-200",
  wait: "bg-slate-100 text-slate-600", branch: "bg-amber-100 text-amber-800", loop: "bg-emerald-100 text-emerald-800",
};
export const STATUS_CLS = {
  on: "bg-emerald-100 text-emerald-800", drafting: "bg-amber-100 text-amber-800",
  off: "bg-slate-100 text-slate-600", ghl: "bg-violet-100 text-violet-800",
  auto: "bg-emerald-100 text-emerald-800", dry: "bg-amber-100 text-amber-800",
};

// The agent a text is shown filled in for. A real-looking name and street,
// so the length on screen is the length that goes out.
export const SAMPLE_AGENT = { first: "Brenda", address: "14820 SE 172nd St", street: "SE 172nd St", town: "Renton", county: "King" };

/** The text as it reads to one agent; a template it can't fill shows as written. */
export const sampleOf = (t) => fillTemplate(t, SAMPLE_AGENT) || t;

/** What would stop a cold text getting through, as you type it. */
export function textWarnings(t = "") {
  const out = [];
  const flags = carrierFlags(t);
  if (flags.length) out.push(`carriers block cold texts with: ${flags.join(", ")}`);
  if (/\$/.test(t)) out.push("no dollar signs in a cold text");
  if (/https?:\/\/|www\.|\.com\b/i.test(t)) out.push("no links in a cold text");
  const filled = sampleOf(t);
  if (filled.length > 230) out.push(`${filled.length} characters filled in. It saves, but first texts under about 230 got more replies`);
  return out;
}

export function StatusPill({ status }) {
  if (!status) return null;
  return <Pill small cls={STATUS_CLS[status] || STATUS_CLS.off} label={FLOW_STATUS_LABEL[status] || status} />;
}

function Bubble({ children }) {
  return (
    <div className="max-w-xl whitespace-pre-wrap rounded-2xl rounded-tl-sm bg-blue-50 px-3 py-2 text-sm leading-snug text-slate-800 ring-1 ring-blue-100">
      {children}
    </div>
  );
}

function Step({ step, last, editing, onEdit, renderEditor }) {
  const Icon = ICON[step.type] || MessageSquare;
  const open = editing === step.id;
  const small = step.type === "wait";
  return (
    <li className="relative flex gap-3">
      {/* The line down to the next step. */}
      {!last && <span aria-hidden="true" className="absolute left-[15px] top-8 bottom-0 w-px bg-slate-200" />}
      <span className={`relative z-10 mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${DOT[step.type] || DOT.text}`}>
        <Icon size={15} aria-hidden="true" />
      </span>
      <div className={`min-w-0 flex-1 ${last ? "" : "pb-4"}`}>
        {small ? (
          <div className="pt-2 text-xs text-slate-500">
            <span className="font-semibold text-slate-600">{step.title}</span>{step.detail ? ` · ${step.detail}` : ""}
          </div>
        ) : (
          <div className={`rounded-xl border bg-white p-3 ${open ? "border-blue-300 ring-2 ring-blue-100" : "border-slate-200"}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-slate-900">{step.title}</span>
              <StatusPill status={step.status} />
              {step.edit && onEdit && !open && (
                <button type="button" className={`${BTN} ml-auto`} onClick={() => onEdit(step.id)}>
                  <Pencil size={12} aria-hidden="true" /> Edit
                </button>
              )}
            </div>
            {step.detail && <p className="mt-1 text-xs leading-relaxed text-slate-500">{step.detail}</p>}
            {open ? (
              <div className="mt-3">{renderEditor(step)}</div>
            ) : (
              <>
                {(step.texts || []).length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    {step.texts.map((t, i) => <Bubble key={i}>{sampleOf(t)}</Bubble>)}
                  </div>
                )}
                {step.voice && <p className="mt-2 text-xs text-slate-600"><span className="font-semibold">How it should sound:</span> {step.voice}</p>}
              </>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * <FlowChart steps editing onEdit renderEditor />
 *
 * `editing` is the id of the step whose editor is open; `onEdit(id)` opens
 * one; `renderEditor(step)` draws it. Without `onEdit` the chart is read-only.
 */
export default function FlowChart({ steps = [], editing = null, onEdit = null, renderEditor = () => null }) {
  return (
    <ol className="list-none">
      {steps.map((s, i) => (
        <Step key={s.id} step={s} last={i === steps.length - 1} editing={editing} onEdit={onEdit} renderEditor={renderEditor} />
      ))}
    </ol>
  );
}
