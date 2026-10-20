// InvestorsTab.jsx — Autopilot → Investors (2026-10-20): what goes out to
// buyers when a deal goes under contract, and between deals, in order; then
// the buyer list (what was Dispositions), its import and its setup folded
// away.
//
// The deal text is Matt's wording with blanks the deal fills in as each one
// sends (shared/blast-text.js, dispoAutopilot.dealTexts; none saved is the
// built-in wording): pick a deal and the chart shows it as a buyer would get
// it now, and the editor shows an edit the same way as you type. The
// wording, counts, days and the check-in's voice save through PATCH
// /settings (dispoAutopilot only); the deal follow-up's day through the
// Conversation AI config, re-read before it's written.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, X } from "lucide-react";
import { DEFAULT_DEAL_TEXTS, normalizeDealTexts } from "@shared/blast-text.js";
import { investorFlow } from "@shared/autopilot-flows.js";
import { LIVE_DEAL_STAGES } from "@shared/offer-status.js";
import { getConversationAi, getDashboardPipeline, getSettings, getWavesPreview, listDeals, patchSettings, saveConversationAi } from "./api.js";
import { BTN, BTN_PRIMARY, ErrorBar, SkeletonRows } from "./ui.jsx";
import DealTextsEditor, { sameTexts } from "./DealTextsEditor.jsx";
import FlowChart from "./FlowChart.jsx";
import Dispositions from "./Dispositions.jsx";
import DispoImport from "./DispoImport.jsx";
import SettingsView from "./SettingsView.jsx";

const NUM = "w-20 rounded-lg border border-slate-300 px-2 py-1 text-sm";
const AREA = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm leading-snug focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100";

function NumRow({ label, value, onChange, min, max, suffix }) {
  return (
    <label className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
      <span className="min-w-[13rem]">{label}</span>
      <input type="number" className={NUM} min={min} max={max} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
      {suffix && <span className="text-xs text-slate-500">{suffix}</span>}
    </label>
  );
}

function Check({ label, hint, checked, onChange }) {
  return (
    <label className="flex items-start gap-2 text-sm text-slate-700">
      <input type="checkbox" className="mt-1" checked={Boolean(checked)} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}{hint && <span className="block text-xs text-slate-500">{hint}</span>}</span>
    </label>
  );
}

// What each editor shows and saves, from the saved values (Settings' own
// defaults when unset).
const FIELDS = {
  wave1: ["autoBlastOnPromote", "autoBlastCount", "minMatchScore"],
  waveN: ["secondWaveHours", "secondWaveCount", "secondWaveMinScore", "maxWaves"],
  pulse: ["enabled", "everyDays", "dailyCap", "voice"],
};
const DEFAULTS = { autoBlastOnPromote: false, autoBlastCount: 25, minMatchScore: 50, secondWaveHours: 48, secondWaveCount: 25, secondWaveMinScore: 35, maxWaves: 2 };
const PULSE_DEFAULTS = { enabled: false, everyDays: 90, dailyCap: 10, voice: "" };
const asNumbers = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "string" && k !== "voice" && v !== "" ? Number(v) : v]));

export default function InvestorsTab({ settings: appSettings, onSettingsSaved }) {
  const [settings, setSettings] = useState(null);
  const [config, setConfig] = useState(null);
  const [switches, setSwitches] = useState([]);
  const [deals, setDeals] = useState([]);
  const [dealId, setDealId] = useState("");
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [setupVersion, setSetupVersion] = useState(0);

  const load = useCallback(() => Promise.all([getSettings(), getConversationAi(), getDashboardPipeline().catch(() => null), listDeals().catch(() => [])])
    .then(([s, c, p, d]) => {
      setSettings(s); setConfig(c.config); setSwitches(p?.autopilot?.switches || []);
      const live = (d || []).filter((o) => LIVE_DEAL_STAGES.has(o.deal?.stage || "under_contract"));
      setDeals(live);
      setDealId((cur) => cur || live[0]?.id || "");
      setError("");
    })
    .catch((e) => setError(e.message || "Couldn't load the investor flow.")), []);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!dealId) { setPreview(null); return; }
    let live = true;
    getWavesPreview(dealId).then((r) => { if (live) setPreview(r); }).catch(() => { if (live) setPreview(null); });
    return () => { live = false; };
  }, [dealId, settings]);

  const flow = useMemo(() => (settings && config ? investorFlow({ settings, config, switches, samples: preview?.samples || [] }) : null), [settings, config, switches, preview]);
  const da = settings?.dispoAutopilot || {};
  const followDay = config?.parties?.investor?.followUp?.ladders?.deal_followup?.steps?.[0] ?? 3;

  const open = (id) => {
    const step = [...(flow?.deal || []), ...(flow?.between || [])].find((s) => s.id === id);
    const f = step?.edit?.field;
    if (f === "pulse") setDraft(Object.fromEntries(FIELDS.pulse.map((k) => [k, da.pulse?.[k] ?? PULSE_DEFAULTS[k]])));
    else if (f === "dealFollowUp") setDraft({ day: followDay });
    else if (f === "wave1") {
      const saved = normalizeDealTexts(da.dealTexts);
      setDraft({ ...Object.fromEntries(FIELDS.wave1.map((k) => [k, da[k] ?? DEFAULTS[k]])), dealTexts: saved.length ? saved : [...DEFAULT_DEAL_TEXTS] });
    }
    else if (FIELDS[f]) setDraft(Object.fromEntries(FIELDS[f].map((k) => [k, da[k] ?? DEFAULTS[k]])));
    setEditing(id);
  };
  const close = () => { setEditing(null); setDraft(null); };

  async function run(fn) {
    setBusy(true); setError("");
    try {
      await fn();
      onSettingsSaved?.(await getSettings());
      setSetupVersion((v) => v + 1);
      await load();
      close();
    } catch (e) { setError(e.message || "Couldn't save."); }
    setBusy(false);
  }

  async function saveFollowDay(day) {
    const fresh = (await getConversationAi()).config;
    const fu = fresh.parties.investor.followUp;
    await saveConversationAi({ ...fresh, parties: { ...fresh.parties, investor: { ...fresh.parties.investor,
      followUp: { ...fu, ladders: { ...fu.ladders, deal_followup: { ...fu.ladders.deal_followup, steps: [day] } } } } } });
  }

  const set = (k) => (v) => setDraft((d) => ({ ...d, [k]: v }));
  const bar = (onSave) => (
    <div className="flex flex-wrap items-center gap-2 pt-2">
      <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={onSave}>
        {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} Save
      </button>
      <button type="button" className={BTN} disabled={busy} onClick={close}><X size={12} aria-hidden="true" /> Cancel</button>
    </div>
  );

  function renderEditor(step) {
    const f = step.edit.field;
    if (f === "wave1") return (
      <div className="space-y-2">
        <Check label="Start the first wave when a deal goes under contract" hint="Off: you pick the buyers from the deal, and no later wave goes on its own." checked={draft.autoBlastOnPromote} onChange={set("autoBlastOnPromote")} />
        <NumRow label="Buyers on the first wave" value={draft.autoBlastCount} onChange={set("autoBlastCount")} min={1} max={200} />
        <NumRow label="Lowest match score" value={draft.minMatchScore} onChange={set("minMatchScore")} min={0} max={100} suffix="out of 100" />
        <DealTextsEditor texts={draft.dealTexts} onChange={set("dealTexts")} input={preview?.input || null} />
        {bar(() => {
          const texts = normalizeDealTexts(draft.dealTexts);
          if (!texts.length) { setError("Write at least one version of the deal text."); return; }
          // The built-in three, untouched, are saved as "the built-in
          // wording", so they keep reading exactly as they always have.
          const { dealTexts: _t, ...rest } = draft;
          run(() => patchSettings({ dispoAutopilot: { ...asNumbers(rest), dealTexts: sameTexts(texts, DEFAULT_DEAL_TEXTS) ? [] : texts } }));
        })}
      </div>
    );
    if (f === "waveN") return (
      <div className="space-y-2">
        <NumRow label="Hours after the wave before" value={draft.secondWaveHours} onChange={set("secondWaveHours")} min={6} max={720} />
        <NumRow label="Buyers on each later wave" value={draft.secondWaveCount} onChange={set("secondWaveCount")} min={1} max={200} />
        <NumRow label="Lowest match score" value={draft.secondWaveMinScore} onChange={set("secondWaveMinScore")} min={0} max={100} suffix="out of 100" />
        <NumRow label="Waves in all" value={draft.maxWaves} onChange={set("maxWaves")} min={1} max={4} suffix="1 = the first wave only" />
        {bar(() => run(() => patchSettings({ dispoAutopilot: asNumbers(draft) })))}
      </div>
    );
    if (f === "dealFollowUp") return (
      <div className="space-y-2">
        <NumRow label="Days after their last word" value={draft.day} onChange={set("day")} min={1} max={30} />
        {bar(() => {
          const day = Number(draft.day);
          if (!Number.isInteger(day) || day < 1 || day > 30) { setError("The follow-up goes 1 to 30 days after their last word."); return; }
          run(() => saveFollowDay(day));
        })}
      </div>
    );
    if (f === "pulse") return (
      <div className="space-y-2">
        <Check label="Write the day's check-ins" hint="Whether they send themselves is under Setup → Pulse check between deals." checked={draft.enabled} onChange={set("enabled")} />
        <NumRow label="Every" value={draft.everyDays} onChange={set("everyDays")} min={30} max={365} suffix="days per buyer" />
        <NumRow label="Buyers a day" value={draft.dailyCap} onChange={set("dailyCap")} min={1} max={50} />
        <label className="block text-sm text-slate-700">
          How it should sound
          <textarea className={`${AREA} mt-1`} rows={3} maxLength={600} value={draft.voice || ""} onChange={(e) => set("voice")(e.target.value)}
            placeholder="In your words: short, friendly, like a text to someone you've done a deal with" />
        </label>
        {bar(() => run(() => patchSettings({ dispoAutopilot: { pulse: asNumbers(draft) } })))}
      </div>
    );
    return null;
  }

  const next = preview?.next;
  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-bold text-slate-900">What goes out to buyers</h2>
            <p className="text-sm text-slate-500">The deal's numbers are filled in as each text sends. Pick a deal to see it as a buyer named Alex would get it now; Edit on Wave 1 changes the wording.</p>
          </div>
          <label className="text-sm text-slate-700">
            <span className="mr-2">Deal</span>
            <select className="max-w-[18rem] rounded-lg border border-slate-300 px-2 py-1.5 text-sm" value={dealId} onChange={(e) => setDealId(e.target.value)}>
              {!deals.length && <option value="">No deal under contract</option>}
              {deals.map((d) => <option key={d.id} value={d.id}>{String(d.address || "").split(",")[0]}</option>)}
            </select>
          </label>
        </div>
        {preview && (
          <p className="mb-3 text-xs text-slate-600">
            {(preview.waves || []).length ? `${preview.waves.length} wave${preview.waves.length === 1 ? "" : "s"} sent on this deal. ` : "No wave sent on this deal yet. "}
            {next?.wave ? `Wave ${next.wave}: ${preview.wouldGet?.length || 0} buyers would get it${next.due ? " at the next morning run" : next.dueAt ? ` from ${new Date(next.dueAt).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric" })}` : ""}.` : next?.why ? `No next wave: ${next.why}.` : ""}
          </p>
        )}
        {error && <div className="mb-3"><ErrorBar>{error}</ErrorBar></div>}
        {!flow ? <SkeletonRows rows={4} cols={2} /> : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <div>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">When a deal goes under contract</h3>
              <FlowChart steps={flow.deal} editing={editing} onEdit={open} renderEditor={renderEditor} />
            </div>
            <div>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Between deals</h3>
              <FlowChart steps={flow.between} editing={editing} onEdit={open} renderEditor={renderEditor} />
              {flow.note && <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{flow.note}</p>}
            </div>
          </div>
        )}
      </section>

      <Dispositions />

      <details className="rounded-xl border border-slate-200 bg-white">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">
          Import buyers
          <span className="ml-2 font-normal text-slate-500">a borrower list or a CSV, previewed before anything is written</span>
        </summary>
        <div className="border-t border-slate-200 p-4"><DispoImport /></div>
      </details>

      <details className="rounded-xl border border-slate-200 bg-white">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">
          Setup
          <span className="ml-2 font-normal text-slate-500">how deals are sent, the package link, email, walkthroughs, the weekly limit</span>
        </summary>
        <div className="border-t border-slate-200 p-4">
          <SettingsView key={setupVersion} settings={appSettings} onSaved={(s) => { onSettingsSaved?.(s); load(); }} mode="dispo" />
        </div>
      </details>
    </div>
  );
}
