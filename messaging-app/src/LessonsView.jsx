// LessonsView.jsx — what the deals that died have to teach the next offer.
//
// The dashboard's Lessons block. Everything here is a READ of the deals on
// the location; the only writes are the two buttons a person presses: Apply
// (a settings delta, confirmed first) and Save digest (the lines the
// Conversation AI may carry, once its own switch is on). Nothing moves on
// its own — that is the deal the funnel made and this keeps.

import React, { useEffect, useState } from "react";
import { Check, Loader2, Wand2 } from "lucide-react";
import { fmtMoney } from "@shared/offer-calc.js";
import { getDashboardLessons, getSettings, saveSettings } from "./api.js";
import { BTN, BTN_PRIMARY, ErrorBar, KpiRow, SkeletonRows } from "./ui.jsx";

const pctText = (n) => (n == null ? "—" : `${Math.round(n * 10) / 10}%`);
const CONF = { high: "bg-emerald-100 text-emerald-800", medium: "bg-amber-100 text-amber-800", low: "bg-slate-100 text-slate-600" };
const KIND = { negotiation: "At the table", settings: "Settings", process: "Process" };
const SETTING_LABEL = { underwriteMode: "Underwrite mode", maoPctOfArv: "Buyer line (% of ARV)", wholesaleFee: "Assignment fee in the model", cashPctOfArv: "Cash % of ARV", repairBuffer: "Repair buffer" };
const fmtSetting = (k, v) => (k === "wholesaleFee" || k === "repairBuffer" ? fmtMoney(v) : k === "maoPctOfArv" || k === "cashPctOfArv" ? `${v}%` : String(v));

/**
 * The recommendation cards. Exported so a test can render them from a
 * fixture; `onApply` / `onDigest` are the two writes.
 */
export function LessonsBody({ data, onApply, onDigest, applying = "", digestBusy = false }) {
  const sep = data.metrics.filter((m) => m.separates);
  return (
    <div className="space-y-4">
      <div className="text-xs text-slate-500">
        {data.sample.failed} fell through ({data.sample.failedDeals.join(", ") || "none"}) · {data.sample.controls} sold or found a buyer ({data.sample.controlDeals.join(", ") || "none"})
      </div>
      {sep.length > 0 && (
        <KpiRow cols="sm:grid-cols-3 lg:grid-cols-4" items={sep.slice(0, 8).map((m) => ({
          label: m.label,
          value: `${m.unit === "%" ? pctText(m.failed.median) : m.failed.median ?? "—"} vs ${m.unit === "%" ? pctText(m.controls.median) : m.controls.median ?? "—"}`,
          hint: `Fell through vs sold (medians). ${m.failed.n} / ${m.controls.n} deals.`,
        }))} />
      )}
      {data.recommendations.length === 0 && <p className="text-sm text-slate-500">Nothing to learn yet — no deal has fallen through, or none has a post-mortem.</p>}
      <ul className="space-y-3">
        {data.recommendations.map((r) => (
          <li key={r.id} className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">{KIND[r.kind] || r.kind}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${CONF[r.confidence] || CONF.low}`}>{r.confidence} confidence</span>
                </div>
                <h3 className="mt-1 text-sm font-bold">{r.title}</h3>
              </div>
              {r.suggestedSettings && (
                <button type="button" className={BTN_PRIMARY} disabled={Boolean(applying)} onClick={() => onApply?.(r)}
                  title="Change these settings — confirmed first, nothing else moves">
                  {applying === r.id ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                  Apply {Object.entries(r.suggestedSettings).map(([k, v]) => `${SETTING_LABEL[k] || k} → ${fmtSetting(k, v)}`).join(", ")}
                </button>
              )}
            </div>
            {r.negotiationRule && <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-sm font-medium text-slate-800">{r.negotiationRule}</p>}
            <ul className="mt-2 space-y-0.5 text-xs text-slate-600">
              {r.evidence.map((e, i) => <li key={i}>· {e}</li>)}
            </ul>
            {r.suggestedSettings && (
              <div className="mt-2 text-[11px] text-slate-400">
                Now: {Object.keys(r.suggestedSettings).map((k) => `${SETTING_LABEL[k] || k} ${fmtSetting(k, data.current[k])}`).join(" · ")}
              </div>
            )}
          </li>
        ))}
      </ul>
      {data.digest && (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-sm font-bold">The digest the bot may carry</h3>
              <p className="text-xs text-slate-500">Percentages only, no dollar figures. Saved here, then switched on per playbook under Conversation AI → agents → "Carry the lessons".</p>
            </div>
            <button type="button" className={BTN} disabled={digestBusy || data.digestSaved === data.digest} onClick={() => onDigest?.(data.digest)}>
              {digestBusy ? <Loader2 size={13} className="animate-spin" /> : data.digestSaved === data.digest ? <Check size={13} /> : null}
              {data.digestSaved === data.digest ? "Saved" : data.digestSaved ? "Update saved digest" : "Save digest"}
            </button>
          </div>
          <p className="mt-2 text-sm text-slate-700">{data.digest}</p>
        </div>
      )}
    </div>
  );
}

export default function LessonsView({ onSettingsSaved }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [applying, setApplying] = useState("");
  const [digestBusy, setDigestBusy] = useState(false);

  const load = () => getDashboardLessons().then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function apply(r) {
    const lines = Object.entries(r.suggestedSettings).map(([k, v]) => `${SETTING_LABEL[k] || k}: ${fmtSetting(k, data.current[k])} → ${fmtSetting(k, v)}`).join("\n");
    if (!window.confirm(`Change these settings?\n\n${lines}\n\nEvery new offer underwrites with them from now on. Existing offers keep their snapshot.`)) return;
    setApplying(r.id); setError("");
    try {
      const cur = await getSettings();
      const saved = await saveSettings({ ...cur, ...r.suggestedSettings });
      onSettingsSaved?.(saved.settings || saved);
      await load();
    } catch (e) { setError(e.message); }
    setApplying("");
  }
  async function saveDigest(digest) {
    setDigestBusy(true); setError("");
    try {
      const cur = await getSettings();
      const saved = await saveSettings({ ...cur, postMortem: { ...(cur.postMortem || {}), digest, digestSavedAt: new Date().toISOString() } });
      onSettingsSaved?.(saved.settings || saved);
      await load();
    } catch (e) { setError(e.message); }
    setDigestBusy(false);
  }

  if (error && !data) return <ErrorBar>{error}</ErrorBar>;
  if (!data) return <SkeletonRows cols={3} rows={3} />;
  return (
    <div>
      {error && <div className="mb-2"><ErrorBar>{error}</ErrorBar></div>}
      <LessonsBody data={data} onApply={apply} onDigest={saveDigest} applying={applying} digestBusy={digestBusy} />
    </div>
  );
}
