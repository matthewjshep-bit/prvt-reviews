// AgentOutreach.jsx — pull active MLS listings from RentCast, grouped by
// listing agent with each agent's most-likely-a-fixer listing as the outreach
// hook. Flags agents already in GHL, then bulk-imports selected agents as
// contacts (hook custom fields + the outreach tag that fires the GHL texting
// workflow). Completely separate from the offers flow.

import React, { useEffect, useMemo, useState } from "react";
import {
  ChevronDown, ChevronUp, Download, ExternalLink, EyeOff, Loader2,
  RefreshCw, RotateCcw, Search, Trash2, X,
} from "lucide-react";
import {
  getOutreachAgents, getAgentListings, pullOutreach, importOutreachAgents,
  setOutreachStatus, clearOutreach, ghlContactUrl,
} from "./api.js";

// RentCast propertyType values.
const PROPERTY_TYPES = ["Single Family", "Condo", "Townhouse", "Multi-Family", "Manufactured", "Land"];

const INPUT_CLS =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none";
const LABEL_CLS = "mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500";

const fmtPrice = (n) =>
  n != null && n !== "" ? `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "—";

function ScorePill({ score, components }) {
  const cls =
    score >= 70 ? "bg-red-100 text-red-700" : score >= 40 ? "bg-amber-100 text-amber-800" : "bg-gray-100 text-gray-600";
  const tip = (components || [])
    .map((c) => `${c.label}: ${c.points}/${c.max} — ${c.detail}`)
    .join("\n");
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`} title={tip}>
      {score}
    </span>
  );
}

function StatusBadge({ agent }) {
  if (agent.status === "imported")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
        Imported
        {agent.contactId && (
          <a href={ghlContactUrl(agent.contactId)} target="_blank" rel="noreferrer" title="Open contact in GHL">
            <ExternalLink size={11} />
          </a>
        )}
      </span>
    );
  if (agent.status === "skipped")
    return <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-400">Skipped</span>;
  if (agent.ghl?.contactId)
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700">
        In GHL
        <a href={ghlContactUrl(agent.ghl.contactId)} target="_blank" rel="noreferrer" title="Open contact in GHL">
          <ExternalLink size={11} />
        </a>
      </span>
    );
  return <span className="rounded-full bg-gray-900/5 px-2 py-0.5 text-xs font-semibold text-gray-700">New</span>;
}

// Expanded row: the agent's listings ranked by fixer score.
function AgentListings({ agentKey }) {
  const [listings, setListings] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    getAgentListings(agentKey).then(setListings).catch((e) => setError(e.message));
  }, [agentKey]);
  if (error) return <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>;
  if (!listings) return <div className="flex justify-center p-4"><Loader2 size={18} className="animate-spin text-gray-400" /></div>;
  return (
    <div className="space-y-1.5">
      {listings.map((l) => (
        <div key={l.listingKey} className="flex items-center justify-between gap-3 rounded-lg bg-white px-3 py-2 text-sm">
          <div className="min-w-0">
            <div className="truncate font-medium">{l.address}</div>
            <div className="text-xs text-gray-500">
              {fmtPrice(l.price)} · {l.daysOnMarket != null ? `${l.daysOnMarket} DOM` : "DOM —"}
              {l.yearBuilt ? ` · built ${l.yearBuilt}` : ""}
              {l.sqft ? ` · ${Number(l.sqft).toLocaleString()} sqft` : ""}
            </div>
          </div>
          <ScorePill score={l.score || 0} components={l.components} />
        </div>
      ))}
    </div>
  );
}

export default function AgentOutreach({ settings }) {
  const [data, setData] = useState(null); // { enabled, agents, tag, importsEnabled, usage }
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all"); // all | new | inghl | imported | skipped
  const [selected, setSelected] = useState(() => new Set());
  const [expanded, setExpanded] = useState("");

  // Pull controls (prefilled from settings once loaded).
  const [zips, setZips] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [daysOld, setDaysOld] = useState("");
  const [propertyType, setPropertyType] = useState("Single Family");
  const [priceBandPct, setPriceBandPct] = useState("0"); // 0 = off
  const [belowMarketOnly, setBelowMarketOnly] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [pullMsg, setPullMsg] = useState(null); // { ok, text }

  // Import flow.
  const [applyTag, setApplyTag] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState(null); // dry-run response
  const [importResult, setImportResult] = useState(null); // live response

  useEffect(() => {
    if (!settings) return;
    setZips((z) => z || settings.outreachZips || "");
    setCity((c) => c || settings.outreachCity || "");
    setState((s) => s || settings.outreachState || "");
    setDaysOld((d) => d || String(settings.outreachDaysOld || 180));
  }, [settings]);

  const refresh = () => getOutreachAgents().then(setData).catch((e) => setError(e.message));
  useEffect(() => { refresh(); }, []);

  const agents = data?.agents || [];
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return agents.filter((a) => {
      if (filter === "new" && (a.status !== "new" || a.ghl?.contactId)) return false;
      if (filter === "inghl" && !(a.status === "new" && a.ghl?.contactId)) return false;
      if (filter === "imported" && a.status !== "imported") return false;
      if (filter === "skipped" && a.status !== "skipped") return false;
      if (!needle) return true;
      return [a.name, a.email, a.phone, a.brokerage, a.hook?.address].some((v) =>
        (v || "").toLowerCase().includes(needle)
      );
    });
  }, [agents, q, filter]);

  const selectable = shown.filter((a) => a.status !== "imported" && a.status !== "skipped");
  const allSelected = selectable.length > 0 && selectable.every((a) => selected.has(a.agentKey));

  const toggleAll = () => {
    const next = new Set(selected);
    if (allSelected) selectable.forEach((a) => next.delete(a.agentKey));
    else selectable.forEach((a) => next.add(a.agentKey));
    setSelected(next);
  };
  const toggle = (key) => {
    const next = new Set(selected);
    next.has(key) ? next.delete(key) : next.add(key);
    setSelected(next);
  };

  const doPull = async () => {
    setPulling(true);
    setPullMsg(null);
    try {
      const r = await pullOutreach({
        zipCodes: zips, city, state,
        daysOld: parseInt(daysOld, 10) || undefined,
        propertyType,
        priceBandPct: parseInt(priceBandPct, 10) || 0,
        belowMarketOnly,
      });
      const kept = r.listingsKept != null && r.listingsKept !== r.listingsFetched
        ? ` (kept ${r.listingsKept} after filters)` : "";
      setPullMsg({
        ok: true,
        text:
          `Pulled ${r.listingsFetched} listings${kept} → ${r.agentsTotal} agents (${r.agentsNew} new)` +
          ` — ${r.requestsUsed} RentCast request${r.requestsUsed === 1 ? "" : "s"}${r.cached ? " (cached)" : ""}` +
          (r.warnings?.length ? ` · ${r.warnings.join(" · ")}` : ""),
      });
      await refresh();
    } catch (e) {
      setPullMsg({ ok: false, text: e.message });
    } finally {
      setPulling(false);
    }
  };

  const doPreview = async () => {
    setPreviewing(true);
    setPreview(null);
    setImportResult(null);
    try {
      setPreview(await importOutreachAgents({ agentKeys: [...selected], applyTag, dryRun: true }));
    } catch (e) {
      setPreview({ error: e.message });
    } finally {
      setPreviewing(false);
    }
  };

  const doImport = async () => {
    const n = selected.size;
    if (!window.confirm(`Import ${n} agent${n === 1 ? "" : "s"} to GoHighLevel${applyTag ? ` and apply the "${data?.tag}" tag (starts outreach)` : ""}?`)) return;
    setImporting(true);
    try {
      const r = await importOutreachAgents({ agentKeys: [...selected], applyTag, dryRun: false });
      setImportResult(r);
      setPreview(null);
      if (!r.dryRun) setSelected(new Set());
      await refresh();
    } catch (e) {
      setImportResult({ error: e.message });
    } finally {
      setImporting(false);
    }
  };

  const doClear = async () => {
    if (!window.confirm("Remove all non-imported agents from the list? Imported agents are kept. Your next pull starts fresh with the current filters.")) return;
    setClearing(true);
    setPullMsg(null);
    try {
      const r = await clearOutreach();
      setSelected(new Set());
      setExpanded("");
      setPullMsg({ ok: true, text: `Cleared ${r.removed} agent${r.removed === 1 ? "" : "s"}.` });
      await refresh();
    } catch (e) {
      setPullMsg({ ok: false, text: e.message });
    } finally {
      setClearing(false);
    }
  };

  const skip = async (agent, undo) => {
    try {
      await setOutreachStatus(agent.agentKey, undo ? "new" : "skipped");
      const next = new Set(selected);
      next.delete(agent.agentKey);
      setSelected(next);
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  };

  if (error) return <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>;
  if (!data) return <div className="flex justify-center p-10"><Loader2 className="animate-spin text-gray-400" /></div>;

  const usage = data.usage || {};
  const meterAmber = (usage.requestsThisMonth || 0) >= 40;

  return (
    <div className="space-y-4">
      {/* ---- pull controls ---- */}
      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-bold">Pull listings</div>
          <div className={`text-xs ${meterAmber ? "font-semibold text-amber-600" : "text-gray-400"}`}>
            {usage.requestsThisMonth || 0} / 50 RentCast requests this month
          </div>
        </div>
        {!data.enabled ? (
          <div className="rounded-xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400">
            Add your RentCast API key in Settings to enable Agent Outreach.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <div className="col-span-2">
                <label className={LABEL_CLS}>Zip codes (comma-separated)</label>
                <input className={INPUT_CLS} value={zips} onChange={(e) => setZips(e.target.value)} placeholder="98092, 98002" />
              </div>
              <div>
                <label className={LABEL_CLS}>City</label>
                <input className={INPUT_CLS} value={city} onChange={(e) => setCity(e.target.value)} placeholder="Auburn" />
              </div>
              <div>
                <label className={LABEL_CLS}>State</label>
                <input className={INPUT_CLS} value={state} onChange={(e) => setState(e.target.value)} placeholder="WA" maxLength={2} />
              </div>
              <div>
                <label className={LABEL_CLS}>Max listing age (days)</label>
                <input className={INPUT_CLS} type="number" value={daysOld} onChange={(e) => setDaysOld(e.target.value)} />
              </div>
              <div className="col-span-2 sm:col-span-1">
                <label className={LABEL_CLS}>Property type</label>
                <select className={INPUT_CLS} value={propertyType} onChange={(e) => setPropertyType(e.target.value)}>
                  <option value="">Any</option>
                  {PROPERTY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="col-span-2 sm:col-span-1">
                <label className={LABEL_CLS} title="Keep only listings near the pull's median price — where the deepest buyer pool is">
                  Price band (± of median)
                </label>
                <select className={INPUT_CLS} value={priceBandPct} onChange={(e) => setPriceBandPct(e.target.value)}>
                  <option value="0">Off</option>
                  <option value="25">±25%</option>
                  <option value="35">±35%</option>
                  <option value="50">±50%</option>
                </select>
              </div>
              <div className="col-span-2 flex items-end pb-2 sm:col-span-2">
                <label className="flex items-center gap-1.5 text-sm text-gray-700"
                  title="Keep only listings priced ≤90% of the area's median $/sqft or that have taken a price cut">
                  <input type="checkbox" checked={belowMarketOnly} onChange={(e) => setBelowMarketOnly(e.target.checked)} />
                  Below-market only (cheap $/sqft or price-cut)
                </label>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button type="button" onClick={doPull} disabled={pulling || clearing}
                className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-40">
                {pulling ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
                Pull listings
              </button>
              {agents.length > 0 && (
                <button type="button" onClick={doClear} disabled={pulling || clearing}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3.5 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                  title="Remove all non-imported agents so a re-filtered pull starts fresh (imported agents are kept)">
                  {clearing ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                  Clear list
                </button>
              )}
              <span className="text-xs text-gray-400">Zips are used when set; otherwise city + state. Results cache for 24h.</span>
            </div>
            {pullMsg && (
              <div className={`mt-3 rounded-lg px-3 py-2 text-sm ${pullMsg.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>
                {pullMsg.text}
              </div>
            )}
          </>
        )}
      </div>

      {/* ---- filters ---- */}
      {agents.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {[
              ["all", "All"], ["new", "New"], ["inghl", "Already in GHL"],
              ["imported", "Imported"], ["skipped", "Skipped"],
            ].map(([key, label]) => (
              <button key={key} type="button" onClick={() => setFilter(key)}
                className={`rounded-full px-3 py-1 text-xs font-medium ${filter === key ? "bg-gray-900 text-white" : "bg-white text-gray-600 hover:bg-gray-100"}`}>
                {label}
              </button>
            ))}
            <div className="ml-auto flex min-w-[14rem] items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-1.5">
              <Search size={14} className="text-gray-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search agents…"
                className="w-full text-sm focus:outline-none" />
              {q && (
                <button type="button" onClick={() => setQ("")} className="rounded p-0.5 text-gray-400 hover:bg-gray-100">
                  <X size={13} />
                </button>
              )}
            </div>
          </div>

          {/* ---- import bar ---- */}
          {selected.size > 0 && (
            <div className="sticky top-14 z-20 rounded-xl border border-gray-300 bg-white p-3 shadow-sm">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm font-semibold">{selected.size} selected</span>
                <label className="flex items-center gap-1.5 text-sm text-gray-700">
                  <input type="checkbox" checked={applyTag} onChange={(e) => setApplyTag(e.target.checked)} />
                  Apply "{data.tag}" tag (starts the outreach texts)
                </label>
                <div className="ml-auto flex gap-2">
                  <button type="button" onClick={doPreview} disabled={previewing || importing}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3.5 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-40">
                    {previewing ? <Loader2 size={14} className="animate-spin" /> : null} Preview import
                  </button>
                  <button type="button" onClick={doImport} disabled={importing || previewing}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-40">
                    {importing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                    Import {selected.size} to GoHighLevel
                  </button>
                </div>
              </div>
              {preview && (
                <div className="mt-2 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
                  {preview.error ? (
                    <span className="text-red-700">{preview.error}</span>
                  ) : (
                    <>
                      Will create {preview.results.filter((r) => r.wouldCreate).length}, update{" "}
                      {preview.results.filter((r) => r.wouldUpdate).length}
                      {applyTag ? `, tag ${preview.results.filter((r) => r.ok).length}` : ", no tag"}.
                      {!preview.importsEnabled && (
                        <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-800">
                          OUTREACH_IMPORTS_ENABLED is off on the server — imports stay dry-run
                        </span>
                      )}
                    </>
                  )}
                </div>
              )}
              {importResult && (
                <div className="mt-2 rounded-lg bg-gray-50 px-3 py-2 text-sm">
                  {importResult.error ? (
                    <span className="text-red-700">{importResult.error}</span>
                  ) : (
                    <>
                      <span className={importResult.dryRun ? "text-amber-800" : "text-emerald-800"}>
                        {importResult.dryRun
                          ? "Server ran a dry-run (imports disabled) — nothing was written."
                          : `Imported ${importResult.imported} agent${importResult.imported === 1 ? "" : "s"}.`}
                      </span>
                      {importResult.results.filter((r) => !r.ok).map((r) => (
                        <div key={r.agentKey} className="mt-1 text-xs text-red-700">{r.agentKey}: {r.error}</div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ---- agent table ---- */}
          {shown.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-400">
              No agents match.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                    <th className="px-3 py-2.5">
                      <input type="checkbox" checked={allSelected} onChange={toggleAll} title="Select all shown" />
                    </th>
                    <th className="px-4 py-2.5">Agent</th>
                    <th className="px-4 py-2.5">Brokerage</th>
                    <th className="px-4 py-2.5 text-center">Listings</th>
                    <th className="px-4 py-2.5">Hook listing</th>
                    <th className="px-4 py-2.5 text-center">Score</th>
                    <th className="sticky right-0 bg-white px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((a) => (
                    <React.Fragment key={a.agentKey}>
                      <tr className="group border-b border-gray-100 last:border-0 hover:bg-gray-50">
                        <td className="px-3 py-2.5">
                          <input type="checkbox" checked={selected.has(a.agentKey)}
                            disabled={a.status === "imported" || a.status === "skipped"}
                            onChange={() => toggle(a.agentKey)} />
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2 font-medium">
                            {a.name || "—"} <StatusBadge agent={a} />
                          </div>
                          <div className="text-xs text-gray-500">
                            {[a.phone, a.email].filter(Boolean).join(" · ") || "no contact info"}
                          </div>
                        </td>
                        <td className="max-w-[10rem] truncate px-4 py-2.5 text-gray-600">{a.brokerage || "—"}</td>
                        <td className="px-4 py-2.5 text-center text-gray-600">{a.listingCount}</td>
                        <td className="max-w-[16rem] px-4 py-2.5">
                          <div className="truncate">{a.hook?.address || "—"}</div>
                          <div className="text-xs text-gray-500">
                            {fmtPrice(a.hook?.price)} · {a.hook?.dom != null ? `${a.hook.dom} DOM` : "DOM —"}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          <ScorePill score={a.hook?.score || 0} components={a.hook?.components} />
                        </td>
                        <td className="sticky right-0 whitespace-nowrap bg-white px-3 py-2.5 text-right group-hover:bg-gray-50">
                          <button type="button"
                            onClick={() => setExpanded(expanded === a.agentKey ? "" : a.agentKey)}
                            className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                            title="Show this agent's listings">
                            {expanded === a.agentKey ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                          </button>
                          {a.status !== "imported" && (
                            <button type="button" onClick={() => skip(a, a.status === "skipped")}
                              className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                              title={a.status === "skipped" ? "Unskip" : "Skip this agent"}>
                              {a.status === "skipped" ? <RotateCcw size={15} /> : <EyeOff size={15} />}
                            </button>
                          )}
                        </td>
                      </tr>
                      {expanded === a.agentKey && (
                        <tr className="border-b border-gray-100 bg-gray-50">
                          <td colSpan={7} className="px-6 py-3">
                            <AgentListings agentKey={a.agentKey} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {data.enabled && agents.length === 0 && (
        <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-400">
          No agents yet — pull listings above to get started.
        </div>
      )}
    </div>
  );
}
