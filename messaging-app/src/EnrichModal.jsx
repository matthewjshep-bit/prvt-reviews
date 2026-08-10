// EnrichModal.jsx — AI contact enrichment. Reads the contact's GHL
// conversation history server-side, has Claude propose custom-field values +
// tag changes, and shows a current → proposed diff the user edits and
// approves before anything is written back to GHL (preview-then-apply).

import React, { useState } from "react";
import { Check, ExternalLink, Loader2, Sparkles, X } from "lucide-react";
import { applyEnrichment, enrichContact, ghlContactUrl } from "./api.js";

const TYPES = [
  { key: "agent", label: "Listing agent" },
  { key: "investor", label: "Investor" },
];

const CONF_CLS = {
  high: "bg-emerald-100 text-emerald-800",
  medium: "bg-amber-100 text-amber-800",
  low: "bg-slate-200 text-slate-600",
};

const prettyEnum = (v) => String(v || "").replace(/_/g, " ");

export default function EnrichModal({ contactId, contactName, defaultType, onClose, onApplied }) {
  const [type, setType] = useState(defaultType || null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null); // enrich preview response
  const [rows, setRows] = useState(null); // editable copy: {..., proposed, checked}
  const [tagState, setTagState] = useState(null); // { add: {tag: bool}, remove: {tag: bool} }
  const [summary, setSummary] = useState("");
  const [saveNote, setSaveNote] = useState(true);
  const [applied, setApplied] = useState(null); // { warnings }

  async function analyze(t = type) {
    setBusy(true);
    setError("");
    setApplied(null);
    try {
      const r = await enrichContact(contactId, { type: t });
      if (r.needsType) { setResult({ needsType: true }); return; }
      if (r.scopeMissing) { setResult({ scopeMissing: true }); return; }
      if (r.empty) { setResult({ empty: true, typeInferred: r.typeInferred }); return; }
      setType(r.type);
      setResult(r);
      setRows(r.proposal.fields.map((f) => ({
        ...f,
        proposed: f.proposed ?? "",
        checked: f.proposed != null && String(f.proposed) !== String(f.current ?? ""),
      })));
      setTagState({
        add: Object.fromEntries(r.proposal.tags.add.map((t2) => [t2, true])),
        remove: Object.fromEntries(r.proposal.tags.remove.map((t2) => [t2, true])),
      });
      setSummary(r.proposal.summary || "");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    setBusy(true);
    setError("");
    try {
      const fields = {};
      for (const r of rows) {
        if (r.checked && String(r.proposed).trim()) fields[r.key] = String(r.proposed).trim();
      }
      const payload = {
        type,
        fields,
        tags: {
          add: Object.entries(tagState.add).filter(([, on]) => on).map(([t]) => t),
          remove: Object.entries(tagState.remove).filter(([, on]) => on).map(([t]) => t),
        },
        note: saveNote && summary.trim() ? summary.trim() : "",
      };
      const r = await applyEnrichment(contactId, payload);
      setApplied({ warnings: r.warnings || [] });
      onApplied?.(r.updated);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const patchRow = (key, patch) =>
    setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const stats = result?.transcriptStats;
  const checkedCount = (rows || []).filter((r) => r.checked && String(r.proposed).trim()).length;
  const tagCount = tagState
    ? Object.values(tagState.add).filter(Boolean).length + Object.values(tagState.remove).filter(Boolean).length
    : 0;
  const inputCls = "w-full rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8" onClick={onClose}>
      <div className="w-full max-w-3xl rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-lg font-bold">
              <Sparkles size={18} className="text-amber-500" /> AI enrichment
            </div>
            <div className="text-sm text-slate-500">
              {contactName || contactId} — summarize the conversation and fill in CRM fields. Nothing is written until you apply.
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1.5 text-slate-400 hover:bg-slate-100">
            <X size={18} />
          </button>
        </div>

        {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        {/* Type picker + analyze */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Contact type</span>
          {TYPES.map((t) => (
            <button key={t.key} type="button" disabled={busy}
              onClick={() => setType(t.key)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                type === t.key ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}>
              {t.label}
            </button>
          ))}
          <button type="button" disabled={busy || !type} onClick={() => analyze()}
            className="ml-auto flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
            {busy && !rows ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
            {rows ? "Re-analyze" : "Analyze conversation"}
          </button>
        </div>

        {busy && !rows && (
          <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
            Reading the conversation history and analyzing — this can take 30–90 seconds…
          </div>
        )}

        {result?.needsType && !type && (
          <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Couldn't tell from the tags whether this is an agent or an investor — pick a type above, then Analyze.
          </div>
        )}
        {result?.scopeMissing && (
          <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            The GHL token is missing the <span className="font-semibold">conversations.readonly</span> scope.
            Add it in GHL → Settings → Private Integrations, then try again.
          </div>
        )}
        {result?.empty && (
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
            No conversation history found on this contact (last 180 days) — nothing to analyze.
          </div>
        )}

        {rows && (
          <>
            {/* Stats + confidence */}
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span className={`rounded-full px-2 py-0.5 font-semibold ${CONF_CLS[result.proposal.confidence] || CONF_CLS.low}`}>
                {result.proposal.confidence} confidence
              </span>
              {stats && (
                <span>
                  {stats.conversations} conversation{stats.conversations === 1 ? "" : "s"} · {stats.messages} message{stats.messages === 1 ? "" : "s"}
                  {stats.calls > 0 && ` · ${stats.callsTranscribed}/${stats.calls} call${stats.calls === 1 ? "" : "s"} transcribed`}
                  {stats.firstAt && ` · ${stats.firstAt.slice(0, 10)} → ${(stats.lastAt || "").slice(0, 10)}`}
                  {stats.truncated && " · truncated"}
                </span>
              )}
            </div>
            {stats?.callTranscriptsUnavailable && (
              <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Call transcripts were skipped — add the <span className="font-semibold">conversations/message.readonly</span> scope
                to the GHL private integration to include what was said on calls.
              </div>
            )}

            {/* Field diff */}
            <div className="mb-4 overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="w-8 px-3 py-2" />
                    <th className="px-3 py-2">Field</th>
                    <th className="px-3 py-2">Current</th>
                    <th className="px-3 py-2">Proposed</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} className={`border-b border-slate-100 last:border-0 ${r.checked ? "" : "opacity-50"}`}>
                      <td className="px-3 py-2">
                        <input type="checkbox" checked={r.checked}
                          onChange={(e) => patchRow(r.key, { checked: e.target.checked })} />
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{r.name}</div>
                        {r.reason && <div className="mt-0.5 max-w-[16rem] text-[11px] leading-tight text-slate-400">{r.reason}</div>}
                      </td>
                      <td className={`px-3 py-2 text-slate-500 ${r.append ? "whitespace-pre-line" : ""}`}>{r.current ? (r.append ? r.current : prettyEnum(r.current)) : "—"}</td>
                      <td className="px-3 py-2">
                        {r.values && !r.multi ? (
                          <select className={inputCls} value={r.proposed}
                            onChange={(e) => patchRow(r.key, { proposed: e.target.value, checked: Boolean(e.target.value) })}>
                            <option value="">—</option>
                            {r.values.map((v) => <option key={v} value={v}>{prettyEnum(v)}</option>)}
                          </select>
                        ) : r.append ? (
                          <textarea rows={4} className={inputCls}
                            value={r.proposed}
                            placeholder="—"
                            onChange={(e) => patchRow(r.key, { proposed: e.target.value, checked: Boolean(e.target.value.trim()) })} />
                        ) : (
                          <input className={inputCls}
                            type={r.dataType === "NUMERICAL" ? "number" : "text"}
                            value={r.proposed}
                            placeholder="—"
                            onChange={(e) => patchRow(r.key, { proposed: e.target.value, checked: Boolean(e.target.value.trim()) })} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Tags */}
            {(Object.keys(tagState.add).length > 0 || Object.keys(tagState.remove).length > 0) && (
              <div className="mb-4">
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Tag changes (click to toggle)</div>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(tagState.add).map(([t, on]) => (
                    <button key={`a-${t}`} type="button"
                      onClick={() => setTagState((s) => ({ ...s, add: { ...s.add, [t]: !on } }))}
                      className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                        on ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-500 line-through"
                      }`}>
                      + {t}
                    </button>
                  ))}
                  {Object.entries(tagState.remove).map(([t, on]) => (
                    <button key={`r-${t}`} type="button"
                      onClick={() => setTagState((s) => ({ ...s, remove: { ...s.remove, [t]: !on } }))}
                      className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                        on ? "bg-red-100 text-red-800" : "bg-slate-100 text-slate-500 line-through"
                      }`}>
                      − {t}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Summary */}
            <div className="mb-4">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Relationship summary</div>
              <textarea rows={3} value={summary} onChange={(e) => setSummary(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
              <label className="mt-1 flex items-center gap-2 text-xs text-slate-600">
                <input type="checkbox" checked={saveNote} onChange={(e) => setSaveNote(e.target.checked)} />
                Save the summary as a note on the contact
              </label>
            </div>

            {/* Apply */}
            {applied ? (
              <div className="rounded-lg bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800">
                <div className="flex items-center gap-1.5 font-semibold"><Check size={15} /> Applied to the contact.</div>
                {applied.warnings.length > 0 && (
                  <ul className="mt-1 list-inside list-disc text-xs text-amber-700">
                    {applied.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                )}
                <a href={ghlContactUrl(contactId)} target="_blank" rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1 text-xs font-medium underline">
                  Open contact in GHL <ExternalLink size={11} />
                </a>
              </div>
            ) : (
              <button type="button" disabled={busy || (checkedCount === 0 && tagCount === 0 && !(saveNote && summary.trim()))}
                onClick={apply}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                Apply {checkedCount} field{checkedCount === 1 ? "" : "s"}{tagCount ? ` + ${tagCount} tag${tagCount === 1 ? "" : "s"}` : ""}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
