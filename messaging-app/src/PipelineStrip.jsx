// PipelineStrip — Matt's diagram (2026-10-13) as two rows on the Offers page:
// GHL's Acquisitions stages on top (where each agent is), the offers' stages
// below (where each house is). The app row is the page's own counts and
// switches the tab; the GHL row is read from the broker
// (GET /api/dashboard/ghl/pipeline) and says what would move when GHL
// doesn't follow the offers yet.

import { useEffect, useState } from "react";
import { getGhlPipeline } from "./api.js";

const GHL_STAGES = [
  { key: "tier2", label: "Tier 2", title: "Replied, nothing live — the check-in keeps in touch" },
  { key: "tier1", label: "Tier 1", title: "A house being priced" },
  { key: "offerOut", label: "Offer Out", title: "Our number is out, they countered, or it's hot" },
  { key: "contract", label: "Contract", title: "Under contract" },
];

function Cell({ label, value, title, active, onClick }) {
  const cls = `flex min-w-[5.5rem] flex-col rounded-lg px-3 py-1.5 text-left ${active ? "bg-slate-800 text-white" : "bg-white text-slate-700"} ${onClick ? "hover:bg-slate-100 hover:text-slate-900" : ""}`;
  const body = (
    <>
      <span className="text-[11px] font-medium uppercase tracking-wide opacity-70">{label}</span>
      <span className="text-base font-semibold tabular-nums">{value ?? "—"}</span>
    </>
  );
  return onClick
    ? <button type="button" className={cls} title={title} onClick={onClick}>{body}</button>
    : <div className={cls} title={title}>{body}</div>;
}

export default function PipelineStrip({ offerCounts = {}, stage, onStage }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    getGhlPipeline().then((d) => { if (live) setData(d); }).catch((e) => { if (live) setError(e.message || "couldn't read GHL"); });
    return () => { live = false; };
  }, []);
  const ghl = data?.ok ? data.ghl : null;
  const plan = data?.plan?.counts || {};
  const following = data?.mode === "on";
  const note = !data ? (error ? `GHL: ${error}` : "Reading GHL…")
    : !data.ok ? data.error
    : [following ? "GHL follows the offers" : "GHL doesn't follow the offers yet",
      plan.planned ? `${plan.planned} card${plan.planned === 1 ? "" : "s"} ${following ? "to move" : "would move"}` : "",
      plan.created ? `${plan.created} to make` : "",
      plan.youMoved ? `${plan.youMoved} moved by hand since` : "",
      ghl?.old ? `${ghl.old} in old stages` : ""].filter(Boolean).join(" · ");
  return (
    <div className="mb-3 rounded-xl border border-slate-200 bg-slate-50 p-2" data-testid="pipeline-strip">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-16 text-[11px] font-semibold uppercase tracking-wide text-slate-500">GHL</span>
        {GHL_STAGES.map((s) => <Cell key={s.key} label={s.label} title={s.title} value={ghl ? ghl[s.key] : null} />)}
        <span className="ml-auto max-w-full text-xs text-slate-500">{note}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="w-16 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Offers</span>
        {[["draft", "Draft"], ["sent", "Sent"], ["responded", "Responded"]].map(([key, label]) => (
          <Cell key={key} label={label} value={offerCounts[key] ?? 0} active={stage === key} onClick={onStage ? () => onStage(key) : null} />
        ))}
      </div>
    </div>
  );
}
