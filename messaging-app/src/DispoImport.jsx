// DispoImport.jsx — bring a borrower list in as buyers. Upload the CSV, see
// who's in it (where they buy, what they do) before anything touches GHL, tick
// who to bring in, dry-run it, then import. The job runs on the broker; this
// page just watches it.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Upload, X } from "lucide-react";
import { REGIONS, REGION_KEYS, STRATEGIES, cityLabel } from "@shared/dispo-regions.js";
import { cancelBuyerImport, getBuyerImportStatus, previewBuyerImport, startBuyerImport, syncInvestors } from "./api.js";
import { BTN, BTN_PRIMARY, ErrorBar, TableCard } from "./ui.jsx";

const money = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n ? `$${Math.round(n / 1000)}k` : "—");

export default function DispoImport() {
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [region, setRegion] = useState("");
  const [batch, setBatch] = useState("");
  const [job, setJob] = useState(null);
  const [importsEnabled, setImportsEnabled] = useState(null);
  const poll = useRef(null);

  const watch = () => {
    clearTimeout(poll.current);
    getBuyerImportStatus().then((r) => {
      setJob(r.job); setImportsEnabled(r.importsEnabled);
      if (r.job?.status === "running") poll.current = setTimeout(watch, 2000);
      else if (r.job && !r.job.dryRun && r.job.status === "done") syncInvestors().catch(() => {});
    }).catch(() => {});
  };
  useEffect(() => { watch(); return () => clearTimeout(poll.current); }, []);

  const onFile = async (file) => {
    if (!file) return;
    setBusy("preview"); setError(""); setJob(null);
    try {
      const r = await previewBuyerImport(await file.text(), file.name);
      setPreview(r); setImportsEnabled(r.importsEnabled);
      setSelected(new Set(r.buyers.filter((b) => b.phone || b.email).map((b) => b.key)));
      setBatch(file.name.replace(/\.csv$/i, "").replace(/enhanced_borrower_list_builder_?/i, "").trim().slice(0, 40));
    } catch (e) { setError(e.message); }
    setBusy("");
  };

  const rows = useMemo(() => (preview?.buyers || []).filter((b) => !region || b.regions.includes(region)), [preview, region]);
  const allOn = rows.length > 0 && rows.every((b) => selected.has(b.key));
  const toggle = (k) => setSelected((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const run = async (dryRun) => {
    if (!dryRun && !window.confirm(`Import ${selected.size} buyers into GoHighLevel? Matches get tags added and blanks filled; the rest are created.`)) return;
    setBusy(dryRun ? "dry" : "live"); setError("");
    try {
      const r = await startBuyerImport({ previewId: preview.previewId, keys: [...selected], batch, dryRun });
      setJob(r.job); watch();
    } catch (e) { setError(e.message); }
    setBusy("");
  };

  const running = job?.status === "running";

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-bold">Import buyers from a borrower list</h2>
        <p className="mt-1 text-xs text-slate-500">
          Upload the CSV export (hard-money recordings). Each person is tagged by every city and region they financed in and by what they do
          (flip, new construction, rental), and every property goes on their record. Nothing is written until you import.
        </p>
        <label className={`${BTN} mt-3 inline-flex cursor-pointer`}>
          {busy === "preview" ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} Choose CSV
          <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
        </label>
        {importsEnabled === false && (
          <span className="ml-3 rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
            DISPO_IMPORTS_ENABLED is off on the broker — imports run as dry runs
          </span>
        )}
      </div>

      {error && <ErrorBar>{error}</ErrorBar>}

      {job && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-semibold">{job.dryRun ? "Dry run" : "Import"} {job.status === "running" ? "running" : job.status}</span>
            <span className="text-slate-500">{job.done}/{job.total}</span>
            <span className="text-slate-700">
              {job.counts.created} {job.dryRun ? "would be created" : "created"} · {job.counts.updated} {job.dryRun ? "would be tagged" : "tagged"} · {job.counts.skipped} skipped
              {job.counts.errors ? ` · ${job.counts.errors} errors` : ""}{!job.dryRun ? ` · ${job.counts.purchases} properties recorded` : ""}
            </span>
            <span className="font-mono text-xs text-slate-500">{job.batchTag}</span>
            {running && <button type="button" className={`${BTN} ml-auto`} onClick={() => cancelBuyerImport().then(watch)}><X size={12} /> Stop</button>}
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded bg-slate-100">
            <div className="h-full bg-blue-600 transition-all" style={{ width: `${job.total ? Math.round((job.done / job.total) * 100) : 0}%` }} />
          </div>
          {job.requestedLive && job.dryRun && <p className="mt-2 text-xs text-amber-800">You asked for a live import, but imports are disabled on the broker, so this ran dry.</p>}
        </div>
      )}

      {preview && (
        <>
          <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
            <p className="text-slate-700">
              <b>{preview.counts.buyers}</b> buyers from {preview.rows} rows · {preview.counts.contactable} reachable
              {preview.counts.noContactInfo ? ` · ${preview.counts.noContactInfo} with no phone or email (skipped)` : ""}
              {preview.skipped ? ` · ${preview.skipped} rows had no name` : ""}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button type="button" onClick={() => setRegion("")}
                className={`rounded-full px-3 py-1 text-xs font-medium ${!region ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600"}`}>All</button>
              {REGION_KEYS.filter((k) => preview.counts.regions[k]).map((k) => (
                <button key={k} type="button" onClick={() => setRegion(region === k ? "" : k)}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${region === k ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600"}`}>
                  {REGIONS[k].label} {preview.counts.regions[k]}
                </button>
              ))}
              <span className="mx-1 text-xs text-slate-400">|</span>
              {Object.entries(preview.counts.types).map(([k, n]) => <span key={k} className="text-xs text-slate-500">{STRATEGIES[k]} {n}</span>)}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <label className="text-xs text-slate-500">Batch tag
                <input value={batch} onChange={(e) => setBatch(e.target.value)} className="ml-1.5 w-48 rounded border border-slate-300 px-1.5 py-0.5 text-xs" />
              </label>
              <span className="text-xs text-slate-500">{selected.size} selected</span>
              <div className="ml-auto flex gap-2">
                <button type="button" className={BTN} disabled={running || !selected.size || Boolean(busy)} onClick={() => run(true)}>
                  {busy === "dry" && <Loader2 size={13} className="animate-spin" />} Dry run
                </button>
                <button type="button" className={BTN_PRIMARY} disabled={running || !selected.size || Boolean(busy)} onClick={() => run(false)}>
                  {busy === "live" && <Loader2 size={13} className="animate-spin" />} Import {selected.size}
                </button>
              </div>
            </div>
          </div>

          <TableCard>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-2"><input type="checkbox" checked={allOn}
                    onChange={() => setSelected((s) => { const n = new Set(s); for (const b of rows) allOn ? n.delete(b.key) : n.add(b.key); return n; })} /></th>
                  <th className="px-3 py-2">Buyer</th><th className="px-3 py-2">Contact</th><th className="px-3 py-2">Market</th>
                  <th className="px-3 py-2">Does</th><th className="px-3 py-2">Loans</th><th className="px-3 py-2">Last</th><th className="px-3 py-2">Largest</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 1000).map((b) => (
                  <tr key={b.key} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-1.5"><input type="checkbox" checked={selected.has(b.key)} onChange={() => toggle(b.key)} /></td>
                    <td className="px-3 py-1.5 font-medium">{b.name}</td>
                    <td className="px-3 py-1.5 text-xs text-slate-500">{b.phone || b.email || <span className="text-amber-700">none</span>}</td>
                    <td className="max-w-[18rem] truncate px-3 py-1.5 text-xs" title={b.cities.map(cityLabel).join(", ")}>
                      {b.regions.map((r) => REGIONS[r]?.label).join(", ") || b.states.join(", ") || "—"}
                      {b.cities.length > 0 && <span className="text-slate-500"> · {b.cities.slice(0, 3).map(cityLabel).join(", ")}</span>}
                    </td>
                    <td className="px-3 py-1.5 text-xs">{b.types.map((t) => STRATEGIES[t]).join(", ")}</td>
                    <td className="px-3 py-1.5 text-xs tabular-nums">{b.purchases}</td>
                    <td className="px-3 py-1.5 text-xs">{b.lastAt?.slice(0, 7)}</td>
                    <td className="px-3 py-1.5 text-xs tabular-nums">{money(b.largest)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 1000 && <p className="px-3 py-2 text-xs text-slate-500">Showing the first 1,000 of {rows.length}; all selected rows import.</p>}
          </TableCard>
        </>
      )}
    </div>
  );
}
