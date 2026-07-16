// journeys/JourneyEditor.jsx — the journey mapper. A vertical timeline of
// steps (card + message + "wait N days" connector labels), an at-a-glance map
// strip up top, and an enrollment rail. Steps are fired MANUALLY ("Send to N
// at this step") — the broker enforces DND/cap/dedupe and advances enrollees.

import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowDown, Trash2, Users } from "lucide-react";
import * as api from "../home/api.js";
import { listTemplates } from "../studio/api.js";
import { API_BASE, getLocationId } from "../studio/api.js";
import TemplatePreview from "../studio/TemplatePreview.jsx";
import { Card, Pill, SendButton, SecondaryButton, ErrorBanner } from "../home/ui.jsx";

function Thumb({ template, className = "" }) {
  if (!template) {
    return <div className={`flex items-center justify-center bg-gray-100 text-2xl text-gray-300 ${className}`}>🃏</div>;
  }
  const w = template.canvas?.width || 1;
  const h = template.canvas?.height || 1;
  return (
    <div className={`flex items-center justify-center overflow-hidden bg-[#0b0b0c] ${className}`}>
      <div style={{ width: h > w ? `${(w / h) * 100}%` : "100%" }}>
        <TemplatePreview template={template} />
      </div>
    </div>
  );
}

export default function JourneyEditor({ journeyId, onBack }) {
  const [journey, setJourney] = useState(null);
  const [enrollments, setEnrollments] = useState([]);
  const [sendsEnabled, setSendsEnabled] = useState(true);
  const [templates, setTemplates] = useState([]);
  const [error, setError] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);

  // enrollment rail state
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [picked, setPicked] = useState([]); // [{id, name}]
  const [tagList, setTagList] = useState([]);
  const [enrollTag, setEnrollTag] = useState("");
  const [enrollBusy, setEnrollBusy] = useState(false);

  // step-send state
  const [stepBusy, setStepBusy] = useState(null); // index while busy
  const [stepPreview, setStepPreview] = useState({}); // index -> dryRun result

  const showToast = (m) => { setToast(m); clearTimeout(showToast._t); showToast._t = setTimeout(() => setToast(null), 2600); };

  const load = () =>
    api.getJourney(journeyId).then((d) => {
      setJourney(d.journey);
      setEnrollments(d.enrollments || []);
      setSendsEnabled(d.sendsEnabled !== false);
    }).catch((e) => setError(e.message || "Couldn’t load"));

  useEffect(() => { load(); }, [journeyId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { listTemplates().then((l) => setTemplates(l || [])).catch(() => {}); }, []);
  useEffect(() => {
    fetch(`${API_BASE}/api/tags?location_id=${encodeURIComponent(getLocationId())}`)
      .then((r) => r.json()).then((d) => setTagList((d.tags || []).map((t) => t.name || t))).catch(() => {});
  }, []);

  // debounced contact search
  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    const t = setTimeout(() => {
      api.listContacts({ query: query.trim() }).then((d) => setResults((d.contacts || []).slice(0, 8))).catch(() => setResults([]));
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  const tplById = useMemo(() => new Map(templates.map((t) => [t.id, t])), [templates]);
  const countsByStep = useMemo(() => {
    const m = {};
    for (const e of enrollments) if (e.status === "active") m[e.stepIndex] = (m[e.stepIndex] || 0) + 1;
    return m;
  }, [enrollments]);
  const completedCount = enrollments.filter((e) => e.status === "completed").length;

  function patch(p) { setJourney((j) => ({ ...j, ...p })); setDirty(true); }
  function patchStep(i, p) {
    setJourney((j) => ({ ...j, steps: j.steps.map((s, idx) => (idx === i ? { ...s, ...p } : s)) }));
    setDirty(true);
  }
  function addStep() { patch({ steps: [...(journey.steps || []), { templateId: "", message: "", waitDays: 3 }] }); }
  function removeStep(i) {
    if ((countsByStep[i] || 0) > 0 && !window.confirm("Contacts are currently at this step — remove it anyway?")) return;
    patch({ steps: journey.steps.filter((_, idx) => idx !== i) });
  }

  async function save() {
    setSaving(true);
    try {
      const j = await api.updateJourney(journeyId, journey);
      setJourney(j);
      setDirty(false);
      showToast("Journey saved");
    } catch (e) {
      showToast("Save failed: " + (e.message || "error"));
    } finally {
      setSaving(false);
    }
  }

  async function enroll() {
    if (!picked.length && !enrollTag) return;
    setEnrollBusy(true);
    try {
      const r = await api.enrollInJourney(journeyId, { contactIds: picked.map((p) => p.id), tag: enrollTag || undefined });
      showToast(`Enrolled ${r.enrolled}${r.skippedExisting ? ` (${r.skippedExisting} already in)` : ""}`);
      setPicked([]); setEnrollTag("");
      load();
    } catch (e) {
      showToast("Enroll failed: " + (e.message || "error"));
    } finally {
      setEnrollBusy(false);
    }
  }

  async function stepSend(i, dryRun) {
    if (dirty) { showToast("Save the journey first"); return; }
    setStepBusy(i);
    try {
      if (dryRun) {
        const r = await api.sendJourneyStep(journeyId, i, { dryRun: true });
        setStepPreview((p) => ({ ...p, [i]: r }));
      } else {
        const p = stepPreview[i];
        const n = p?.willSend ?? countsByStep[i] ?? 0;
        if (!window.confirm(`Send step ${i + 1} to ${n} contact${n === 1 ? "" : "s"} and advance them?\n\nThis texts real people and can’t be undone.`)) return;
        const r = await api.sendJourneyStep(journeyId, i, { dryRun: false });
        showToast(`Sent ${r.sent}${r.failed ? ` · ${r.failed} failed` : ""}${r.completed ? ` · ${r.completed} completed the journey` : ""}`);
        setStepPreview((p2) => ({ ...p2, [i]: null }));
        load();
      }
    } catch (e) {
      showToast("Step send failed: " + (e.message || "error"));
    } finally {
      setStepBusy(null);
    }
  }

  if (error) return <Card className="p-6"><ErrorBanner onRetry={() => { setError(null); load(); }}>{error}</ErrorBanner></Card>;
  if (!journey) return <Card className="p-6"><div className="h-40 animate-pulse rounded-xl bg-gray-100" /></Card>;

  const steps = journey.steps || [];

  return (
    <div>
      {/* header */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button type="button" onClick={onBack} className="rounded-lg border border-gray-300 bg-white p-2 text-gray-600 hover:bg-gray-50" title="Back to journeys">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <input
          value={journey.name}
          onChange={(e) => patch({ name: e.target.value })}
          className="w-64 rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold"
        />
        <span className="text-xs text-gray-400">
          {enrollments.filter((e) => e.status === "active").length} active · {completedCount} completed
        </span>
        <div className="ml-auto w-32">
          <SendButton onClick={save} busy={saving} disabled={!dirty}>{dirty ? "Save" : "Saved"}</SendButton>
        </div>
      </div>

      {/* map strip — the at-a-glance lifecycle */}
      <div className="mb-5 overflow-x-auto rounded-xl border border-gray-200 bg-white p-3">
        <div className="flex items-center gap-2">
          {steps.map((s, i) => (
            <React.Fragment key={i}>
              {i > 0 ? (
                <div className="flex shrink-0 flex-col items-center px-1 text-[10px] text-gray-400">
                  <span>wait</span>
                  <span className="font-semibold text-gray-600">{s.waitDays}d</span>
                  <span>→</span>
                </div>
              ) : null}
              <div className="w-20 shrink-0">
                <Thumb template={tplById.get(s.templateId)} className="aspect-square w-full rounded-lg" />
                <div className="mt-1 truncate text-center text-[10px] font-medium text-gray-500">
                  {i + 1}. {tplById.get(s.templateId)?.name || "pick a card"}
                </div>
              </div>
            </React.Fragment>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        {/* timeline editor */}
        <div>
          {steps.map((s, i) => {
            const tpl = tplById.get(s.templateId);
            const atHere = countsByStep[i] || 0;
            const pv = stepPreview[i];
            return (
              <div key={i}>
                {i > 0 ? (
                  <div className="my-2 flex items-center gap-2 pl-6 text-xs text-gray-500">
                    <ArrowDown className="h-4 w-4 text-gray-300" />
                    wait
                    <input
                      type="number"
                      min={0}
                      max={365}
                      value={s.waitDays}
                      onChange={(e) => patchStep(i, { waitDays: parseInt(e.target.value, 10) || 0 })}
                      className="w-16 rounded-md border border-gray-300 px-2 py-1 text-center text-xs"
                    />
                    days <span className="text-gray-300">(you fire it — nothing sends automatically)</span>
                  </div>
                ) : null}

                <div className="rounded-xl border border-gray-200 bg-white p-4">
                  <div className="flex flex-wrap items-start gap-4">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-900 text-sm font-bold text-white">{i + 1}</div>
                    <Thumb template={tpl} className="h-28 w-28 shrink-0 rounded-lg" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          value={s.templateId}
                          onChange={(e) => patchStep(i, { templateId: e.target.value })}
                          className="min-w-0 flex-1 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                        >
                          <option value="">Pick a card…</option>
                          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                        {atHere > 0 ? <Pill variant="scheduled"><Users className="h-3 w-3" /> {atHere} here</Pill> : null}
                        <button type="button" onClick={() => removeStep(i)} className="rounded-lg p-1.5 text-gray-300 hover:bg-red-50 hover:text-red-500" title="Remove step">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                      <textarea
                        value={s.message}
                        onChange={(e) => patchStep(i, { message: e.target.value })}
                        rows={2}
                        placeholder={tpl?.message ? `Card's message: “${tpl.message.slice(0, 90)}…” (leave blank to use it)` : "Message for this step…"}
                        className="w-full rounded-lg border border-gray-300 p-2 text-xs outline-none focus:border-blue-500"
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="w-40">
                          <SecondaryButton onClick={() => stepSend(i, true)} disabled={stepBusy === i || !s.templateId || atHere === 0}>
                            {stepBusy === i ? "…" : "Preview audience"}
                          </SecondaryButton>
                        </div>
                        <div className="w-44">
                          <SendButton
                            onClick={() => stepSend(i, false)}
                            busy={stepBusy === i}
                            disabled={!pv || !sendsEnabled || (pv.willSend ?? 0) === 0}
                          >
                            {pv ? `Send to ${pv.willSend} here →` : `Send step ${i + 1} →`}
                          </SendButton>
                        </div>
                        {pv ? (
                          <span className="text-xs text-gray-500">
                            {pv.willSend} will get it{pv.skippedDnd ? ` · ${pv.skippedDnd} DND` : ""}{pv.sample?.length ? ` · e.g. ${pv.sample.join(", ")}` : ""}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          <button
            type="button"
            onClick={addStep}
            className="mt-3 w-full rounded-xl border border-dashed border-gray-300 bg-gray-50 py-3 text-sm font-semibold text-gray-500 hover:border-blue-300 hover:text-blue-600"
          >
            ＋ Add step
          </button>
          {!sendsEnabled ? (
            <p className="mt-2 text-[11px] text-amber-600">Live sending is off (CARD_SENDS_ENABLED) — step sends run as dry runs.</p>
          ) : null}
        </div>

        {/* enrollment rail */}
        <div className="lg:sticky lg:top-24 lg:self-start">
          <div className="rounded-xl border border-gray-200 bg-white p-3">
            <div className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-400">Enroll contacts</div>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search contacts…"
              className="w-full rounded-lg border border-gray-300 px-2.5 py-2 text-sm outline-none focus:border-blue-500"
            />
            {results.length > 0 && (
              <div className="mt-1 max-h-40 overflow-auto rounded-lg border border-gray-200">
                {results.map((c) => (
                  <button key={c.id} type="button"
                    onClick={() => { if (!picked.some((p) => p.id === c.id)) setPicked([...picked, { id: c.id, name: c.name }]); setQuery(""); setResults([]); }}
                    className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-sm hover:bg-gray-50">
                    <span className="truncate">{c.name}</span>
                    <span className="ml-2 text-[10px] text-gray-400">{c.phone}</span>
                  </button>
                ))}
              </div>
            )}
            {picked.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {picked.map((p) => (
                  <span key={p.id} className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs">
                    {p.name}
                    <button type="button" onClick={() => setPicked(picked.filter((x) => x.id !== p.id))} className="text-gray-400 hover:text-gray-700">×</button>
                  </span>
                ))}
              </div>
            )}
            <select value={enrollTag} onChange={(e) => setEnrollTag(e.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-2 py-2 text-sm">
              <option value="">…or everyone with a tag</option>
              {tagList.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <div className="mt-2">
              <SendButton onClick={enroll} busy={enrollBusy} disabled={!picked.length && !enrollTag}>
                Enroll{picked.length ? ` ${picked.length}` : ""}{enrollTag ? ` + tag` : ""}
              </SendButton>
            </div>
            <p className="mt-1.5 text-[10px] text-gray-400">Everyone starts at step 1. DND contacts are skipped at send time.</p>
          </div>

          {/* roster grouped by step */}
          <div className="mt-3 rounded-xl border border-gray-200 bg-white p-3">
            <div className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-400">Where everyone is</div>
            {enrollments.filter((e) => e.status === "active").length === 0 ? (
              <p className="py-3 text-center text-xs text-gray-400">Nobody enrolled yet.</p>
            ) : (
              steps.map((_, i) => {
                const here = enrollments.filter((e) => e.status === "active" && e.stepIndex === i);
                if (!here.length) return null;
                return (
                  <div key={i} className="mb-2">
                    <div className="mb-1 text-[10px] font-semibold uppercase text-gray-400">Step {i + 1} · {here.length}</div>
                    {here.map((e) => (
                      <div key={e.contactId} className="flex items-center justify-between border-t border-gray-50 py-1 text-xs text-gray-700">
                        <span className="truncate font-mono text-[10px]">{e.contactId.slice(0, 10)}…</span>
                        <button type="button" onClick={() => api.removeFromJourney(journeyId, e.contactId).then(load)} className="text-gray-300 hover:text-red-500" title="Remove from journey">×</button>
                      </div>
                    ))}
                  </div>
                );
              })
            )}
            {completedCount ? <div className="border-t border-gray-100 pt-2 text-[11px] text-green-700">✓ {completedCount} completed the journey</div> : null}
          </div>
        </div>
      </div>

      {toast ? (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white shadow-lg">{toast}</div>
      ) : null}
    </div>
  );
}
