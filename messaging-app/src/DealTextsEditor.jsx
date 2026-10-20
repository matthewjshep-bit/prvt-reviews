// DealTextsEditor.jsx — the deal text to buyers in Matt's own words, on
// Autopilot → Investors (2026-10-20): up to three versions with blanks the
// deal fills in as each one sends (shared/blast-text.js fillDealText), each
// shown as it reads for the picked deal while it's typed.

import React from "react";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { blastMessage, DEAL_TEXT_BLANKS, DEAL_TEXT_MAX, DEFAULT_DEAL_TEXTS } from "@shared/blast-text.js";
import { carrierFlags } from "@shared/carrier-words.js";
import { BTN, BTN_DANGER } from "./ui.jsx";

const AREA = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm leading-snug focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100";

// What would stop a deal text, or make it read wrong, as you type it.
function dealTextWarnings(t = "") {
  const out = [];
  const flags = carrierFlags(t.replace(/\{\w+\}/g, ""));
  if (flags.length) out.push(`carriers block texts to new buyers with: ${flags.join(", ")}`);
  if (/\$/.test(t)) out.push("dollar signs are taken out: write 261k, not $261,000");
  if (/https?:\/\/|www\./i.test(t)) out.push("the package link goes in {close}; a typed link is held by the carriers");
  if (!/\{(?:price|numbers)\}/.test(t)) out.push("it doesn't say the price: add {numbers} or {price}");
  return out;
}
export const sameTexts = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The deal text's versions, each with how it reads for the picked deal. */
export default function DealTextsEditor({ texts, onChange, input }) {
  const set = (i, v) => onChange(texts.map((t, j) => (j === i ? v : t)));
  return (
    <div className="space-y-3 border-t border-slate-200 pt-3">
      <div className="text-sm font-semibold text-slate-800">The text</div>
      <p className="text-xs text-slate-500">
        {texts.length === 1 ? "Every buyer gets this one." : `Each buyer gets one of these ${texts.length}, in turn.`} The blanks are filled from the deal as each text sends, so the price is the deal's price that minute.
      </p>
      {texts.map((t, i) => {
        const warn = dealTextWarnings(t);
        const reads = input ? blastMessage({ ...input, variant: i, templates: texts }) : "";
        return (
          <div key={i} className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-600">Version {i + 1}</span>
              {texts.length > 1 && (
                <button type="button" className={`${BTN_DANGER} ml-auto`} onClick={() => onChange(texts.filter((_, j) => j !== i))}>
                  <Trash2 size={12} aria-hidden="true" /> Remove
                </button>
              )}
            </div>
            <textarea className={AREA} rows={3} value={t} onChange={(e) => set(i, e.target.value)} />
            {reads
              ? <p className="text-xs text-slate-600"><span className="font-semibold">Reads:</span> {reads}</p>
              : <p className="text-xs text-slate-500">Pick a deal above to see how it reads.</p>}
            {warn.map((w) => <p key={w} className="text-xs font-medium text-amber-700">{w}</p>)}
          </div>
        );
      })}
      <div className="flex flex-wrap gap-2">
        {texts.length < DEAL_TEXT_MAX && (
          <button type="button" className={BTN} onClick={() => onChange([...texts, DEFAULT_DEAL_TEXTS[texts.length % DEFAULT_DEAL_TEXTS.length]])}>
            <Plus size={12} aria-hidden="true" /> Add a version
          </button>
        )}
        {!sameTexts(texts, DEFAULT_DEAL_TEXTS) && (
          <button type="button" className={BTN} onClick={() => onChange([...DEFAULT_DEAL_TEXTS])}>
            <RotateCcw size={12} aria-hidden="true" /> Back to the built-in wording
          </button>
        )}
      </div>
      <details className="text-xs text-slate-600">
        <summary className="cursor-pointer font-semibold">The blanks</summary>
        <ul className="mt-1 space-y-0.5">
          {Object.entries(DEAL_TEXT_BLANKS).map(([k, v]) => <li key={k}><code className="rounded bg-slate-100 px-1">{`{${k}}`}</code> {v}</li>)}
        </ul>
      </details>
    </div>
  );
}
