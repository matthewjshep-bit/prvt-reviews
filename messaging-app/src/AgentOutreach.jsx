// AgentOutreach.jsx — pull active MLS listings from RentCast, grouped by
// listing agent with each agent's most-likely-a-fixer listing as the outreach
// hook. Flags agents already in GHL, then bulk-imports selected agents as
// contacts (hook custom fields + the outreach tag that fires the GHL texting
// workflow). Completely separate from the offers flow.

import React, { useEffect, useMemo, useState } from "react";
import {
  ChevronDown, ChevronUp, Download, ExternalLink, EyeOff, Loader2,
  Pencil, Plus, RefreshCw, RotateCcw, Search, Trash2, X,
} from "lucide-react";
import {
  getOutreachAgents, getAgentListings, pullOutreach, importOutreachAgents,
  setOutreachStatus, clearOutreach, getOutreachBatches, createOutreachBatch,
  renameOutreachBatch, deleteOutreachBatch,
  ghlContactUrl, getLocationId, getLocationKey, zillowUrl,
} from "./api.js";

// RentCast propertyType values.
const PROPERTY_TYPES = ["Single Family", "Condo", "Townhouse", "Multi-Family", "Manufactured", "Land"];

const INPUT_CLS =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none";
const LABEL_CLS = "mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500";

const fmtPrice = (n) =>
  n != null && n !== "" ? `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "—";

const fmtAgo = (iso) => {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d}d ago`;
};

// Address rendered as a Zillow deep link (falls back to plain text when the
// address doesn't produce a usable slug).
function ZLink({ address, className = "" }) {
  const url = address ? zillowUrl(address) : "";
  if (!url) return <span className={className}>{address || "—"}</span>;
  return (
    <a href={url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
      className={`underline decoration-slate-300 underline-offset-2 hover:text-slate-900 ${className}`}
      title="Open on Zillow">
      {address}
    </a>
  );
}

// Deep link into the offers app (same site, root path) for a saved offer.
// Carries the ?key= access key through so key-protected locations still work.
const offerAppUrl = (offerId) => {
  const p = new URLSearchParams({ location_id: getLocationId(), offer_id: offerId });
  const key = getLocationKey();
  if (key) p.set("key", key);
  return `/?${p}`;
};

// Condo/apartment detection for the hook listing: RentCast's propertyType when
// present, plus an address-suffix heuristic (Apt/Unit/Ste/#) — unit-numbered
// addresses are condos or apartments regardless of how the feed labeled them.
const isCondoish = (a) => {
  const t = String(a.hook?.propertyType || "").toLowerCase();
  if (t.includes("condo") || t.includes("apartment")) return true;
  return /(\b(apt|unit|ste|suite)\b|#)/i.test(String(a.hook?.address || ""));
};

const parseMoney = (s) => Number(String(s).replace(/[^0-9]/g, "")) || 0;

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
    return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-400">Skipped</span>;
  if (agent.ghl?.contactId)
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700">
        In GHL
        <a href={ghlContactUrl(agent.ghl.contactId)} target="_blank" rel="noreferrer" title="Open contact in GHL">
          <ExternalLink size={11} />
        </a>
      </span>
    );
  return <span className="rounded-full bg-slate-900/5 px-2 py-0.5 text-xs font-semibold text-slate-700">New</span>;
}

// Expanded row: the agent's listings ranked by fixer score.
function AgentListings({ agentKey, batchId }) {
  const [listings, setListings] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    getAgentListings(agentKey, batchId).then(setListings).catch((e) => setError(e.message));
  }, [agentKey, batchId]);
  if (error) return <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>;
  if (!listings) return <div className="flex justify-center p-4"><Loader2 size={18} className="animate-spin text-slate-400" /></div>;
  return (
    <div className="space-y-1.5">
      {listings.map((l) => (
        <div key={l.listingKey}
          className={`flex items-center justify-between gap-3 rounded-lg bg-white px-3 py-2 text-sm ${l.qualifies === false ? "opacity-60" : ""}`}>
          <div className="min-w-0">
            <div className="truncate font-medium"><ZLink address={l.address} /></div>
            <div className="text-xs text-slate-500">
              {fmtPrice(l.price)} · {l.daysOnMarket != null ? `${l.daysOnMarket} DOM` : "DOM —"}
              {l.propertyType ? ` · ${l.propertyType}` : ""}
              {l.yearBuilt ? ` · built ${l.yearBuilt}` : ""}
              {l.sqft ? ` · ${Number(l.sqft).toLocaleString()} sqft` : ""}
            </div>
          </div>
          {l.distress && (l.distress.stale || l.distress.cut || l.distress.cheap) && (
            <div className="flex shrink-0 flex-wrap justify-end gap-1">
              {l.distress.stale && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">stale</span>}
              {l.distress.cut && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">price cut</span>}
              {l.distress.cheap && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">cheap $/sqft</span>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function AgentOutreach({ settings }) {
  const [data, setData] = useState(null); // { enabled, agents, tag, importsEnabled, batch, usage }
  const [error, setError] = useState("");

  // Batches (saved pull cohorts). Active selection sticks per location.
  const BATCH_LS = `outreach.batch.${getLocationId()}`;
  const [batches, setBatches] = useState(null);
  const [batchId, setBatchId] = useState(() => {
    try { return localStorage.getItem(BATCH_LS) || ""; } catch { return ""; }
  });
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);
  const activeBatch = (batches || []).find((b) => b.id === batchId) || null;
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all"); // all | new | inghl | imported | skipped
  const [kindFilter, setKindFilter] = useState("all"); // all | house | condo
  const [minActive, setMinActive] = useState("0"); // min active listings per agent, 0 = any
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [expanded, setExpanded] = useState("");

  // Pull controls (prefilled from settings once loaded).
  const [zips, setZips] = useState("");
  const [county, setCounty] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [daysOld, setDaysOld] = useState("");
  const [propertyType, setPropertyType] = useState("Single Family");
  const [priceBandPct, setPriceBandPct] = useState("0"); // 0 = off
  const [distressOnly, setDistressOnly] = useState(true);
  const [staleDom, setStaleDom] = useState("45"); // DOM at which a listing counts as stale
  const [pulling, setPulling] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [pullMsg, setPullMsg] = useState(null); // { ok, text }

  // Import flow. Each import session gets its own tag (batch tag + this
  // suffix) so same-day imports stay individually filterable in GHL.
  const sessionSuffixNow = () => {
    const d = new Date();
    const md = d.toLocaleDateString("en-US", { month: "short", day: "numeric" }).toLowerCase().replace(" ", "");
    return `${md}-${d.getHours()}${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const [sessionTag, setSessionTag] = useState(sessionSuffixNow);
  const [applyTag, setApplyTag] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState(null); // dry-run response
  const [importResult, setImportResult] = useState(null); // live response

  useEffect(() => {
    if (!settings) return;
    setZips((z) => z || settings.outreachZips || "");
    setCounty((c) => c || settings.outreachCounty || "");
    setCity((c) => c || settings.outreachCity || "");
    setState((s) => s || settings.outreachState || "");
    setDaysOld((d) => d || String(settings.outreachDaysOld || 180));
  }, [settings]);

  const refresh = (bid = batchId) => getOutreachAgents(bid).then(setData).catch((e) => setError(e.message));

  // Load batches once, then keep the active id honest: stick with the saved
  // one when it still exists, else fall back to the most recent.
  const loadBatches = async () => {
    const list = await getOutreachBatches();
    setBatches(list);
    setBatchId((cur) => (list.some((b) => b.id === cur) ? cur : list[0]?.id || ""));
    return list;
  };
  useEffect(() => { loadBatches().catch((e) => setError(e.message)); }, []);
  useEffect(() => {
    try { localStorage.setItem(BATCH_LS, batchId || ""); } catch { /* ignore */ }
  }, [batchId]);

  // (Re)load the batch's agents once batches are known; switching batches
  // resets everything scoped to the previous one.
  useEffect(() => {
    if (batches === null) return;
    setSelected(new Set());
    setExpanded("");
    setPreview(null);
    setImportResult(null);
    refresh(batchId);
  }, [batchId, batches === null]);

  const agents = data?.agents || [];
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const min = parseMoney(priceMin);
    const max = parseMoney(priceMax);
    return agents.filter((a) => {
      if (filter === "new" && (a.status !== "new" || a.ghl?.contactId)) return false;
      if (filter === "inghl" && !(a.status === "new" && a.ghl?.contactId)) return false;
      if (filter === "imported" && a.status !== "imported") return false;
      if (filter === "skipped" && a.status !== "skipped") return false;
      if (minActive !== "0" && (Number(a.listingCount) || 0) < Number(minActive)) return false;
      if (kindFilter !== "all") {
        const condo = isCondoish(a);
        if (kindFilter === "condo" && !condo) return false;
        if (kindFilter === "house" && condo) return false;
      }
      if (min || max) {
        const price = Number(a.hook?.price) || 0;
        if (!price) return false; // price filters active → hide unknown-price rows
        if (min && price < min) return false;
        if (max && price > max) return false;
      }
      if (!needle) return true;
      return [a.name, a.email, a.phone, a.brokerage, a.hook?.address].some((v) =>
        (v || "").toLowerCase().includes(needle)
      );
    });
  }, [agents, q, filter, kindFilter, minActive, priceMin, priceMax]);

  // Selection describes the CURRENT view — changing any filter clears it so
  // "N selected" never includes rows hidden by the active filters (importing
  // invisible agents is a footgun).
  useEffect(() => { setSelected(new Set()); }, [q, filter, kindFilter, minActive, priceMin, priceMax]);

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
        zipCodes: zips, county, city, state,
        daysOld: parseInt(daysOld, 10) || undefined,
        propertyType,
        priceBandPct: parseInt(priceBandPct, 10) || 0,
        distressOnly,
        staleDom: parseInt(staleDom, 10) || 45,
        ...(batchId ? { batchId } : {}),
      });
      const kept = r.listingsKept != null && r.listingsKept !== r.listingsFetched
        ? ` (kept ${r.listingsKept} after filters)` : "";
      setPullMsg({
        ok: true,
        text:
          `Pulled ${r.listingsFetched} listings${kept} into "${r.batchName}" → ${r.agentsTotal} agents (${r.agentsNew} new)` +
          ` — ${r.requestsUsed} RentCast request${r.requestsUsed === 1 ? "" : "s"}${r.cached ? " (cached)" : ""}` +
          (r.warnings?.length ? ` · ${r.warnings.join(" · ")}` : ""),
      });
      // The server may have created or renamed the batch (first pull).
      setBatchId(r.batchId);
      await loadBatches();
      await refresh(r.batchId);
    } catch (e) {
      setPullMsg({ ok: false, text: e.message });
    } finally {
      setPulling(false);
    }
  };

  const doNewBatch = async () => {
    setBatchBusy(true);
    setPullMsg(null);
    try {
      const b = await createOutreachBatch();
      await loadBatches();
      setBatchId(b.id);
    } catch (e) {
      setError(e.message);
    } finally {
      setBatchBusy(false);
    }
  };

  const doRenameBatch = async () => {
    const name = renameDraft.trim();
    setRenaming(false);
    if (!name || !batchId || name === activeBatch?.name) return;
    setBatchBusy(true);
    try {
      await renameOutreachBatch(batchId, name);
      await loadBatches();
      await refresh(batchId); // picks up the renamed batch's new import tag
    } catch (e) {
      setError(e.message);
    } finally {
      setBatchBusy(false);
    }
  };

  const doDeleteBatch = async () => {
    if (!activeBatch) return;
    const n = activeBatch.agentCount;
    if (!window.confirm(
      `Delete batch "${activeBatch.name}" and its ${n} agent${n === 1 ? "" : "s"}? ` +
      `Contacts already imported to GoHighLevel are not affected.`
    )) return;
    setBatchBusy(true);
    setPullMsg(null);
    try {
      await deleteOutreachBatch(batchId);
      await loadBatches(); // falls back to the most recent remaining batch
    } catch (e) {
      setError(e.message);
    } finally {
      setBatchBusy(false);
    }
  };

  const doPreview = async () => {
    setPreviewing(true);
    setPreview(null);
    setImportResult(null);
    try {
      setPreview(await importOutreachAgents({ agentKeys: [...selected], applyTag, dryRun: true, batchId, sessionTag: sessionTag.trim() }));
    } catch (e) {
      setPreview({ error: e.message });
    } finally {
      setPreviewing(false);
    }
  };

  const doImport = async () => {
    const n = selected.size;
    const batchTag = data?.batch?.tag || "";
    const suffix = sessionTag.trim();
    const tagList = [batchTag, ...(suffix ? [`${batchTag}-${suffix}`] : [])].map((t) => `"${t}"`).join(" + ");
    if (!window.confirm(
      `Import ${n} agent${n === 1 ? "" : "s"} to GoHighLevel with tags ${tagList}` +
      `${applyTag ? ` and the "${data?.tag}" trigger tag (starts outreach)` : " (no trigger tag — start the automation manually)"}?`
    )) return;
    setImporting(true);
    try {
      const r = await importOutreachAgents({ agentKeys: [...selected], applyTag, dryRun: false, batchId, sessionTag: suffix });
      setImportResult(r);
      setPreview(null);
      if (!r.dryRun) {
        setSelected(new Set());
        setSessionTag(sessionSuffixNow()); // fresh suffix for the next import session
      }
      await refresh();
      await loadBatches(); // imported counts changed
    } catch (e) {
      setImportResult({ error: e.message });
    } finally {
      setImporting(false);
    }
  };

  const doClear = async () => {
    if (!window.confirm(`Remove all non-imported agents from "${activeBatch?.name || "this batch"}"? Imported agents are kept. Your next pull into it starts fresh with the current filters.`)) return;
    setClearing(true);
    setPullMsg(null);
    try {
      const r = await clearOutreach(batchId);
      setSelected(new Set());
      setExpanded("");
      setPullMsg({ ok: true, text: `Cleared ${r.removed} agent${r.removed === 1 ? "" : "s"}.` });
      await refresh();
      await loadBatches();
    } catch (e) {
      setPullMsg({ ok: false, text: e.message });
    } finally {
      setClearing(false);
    }
  };

  const skip = async (agent, undo) => {
    try {
      await setOutreachStatus(agent.agentKey, undo ? "new" : "skipped", batchId);
      const next = new Set(selected);
      next.delete(agent.agentKey);
      setSelected(next);
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  };

  if (error) return <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>;
  if (!data) return <div className="flex justify-center p-10"><Loader2 className="animate-spin text-slate-400" /></div>;

  const usage = data.usage || {};
  const meterAmber = (usage.requestsThisMonth || 0) >= 40;

  return (
    <div className="space-y-4">
      {/* ---- pull controls ---- */}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-bold">Pull listings</div>
          <div className={`text-xs ${meterAmber ? "font-semibold text-amber-600" : "text-slate-400"}`}>
            {usage.requestsThisMonth || 0} / 50 RentCast requests this month
          </div>
        </div>

        {/* ---- batch picker ---- */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Batch</span>
          {renaming ? (
            <input autoFocus value={renameDraft} onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") doRenameBatch();
                if (e.key === "Escape") setRenaming(false);
              }}
              onBlur={doRenameBatch}
              className="w-64 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none" />
          ) : (
            <select value={batchId} onChange={(e) => setBatchId(e.target.value)}
              disabled={batchBusy || !batches?.length}
              className="max-w-[24rem] rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none">
              {(batches || []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} — {b.agentCount} agent{b.agentCount === 1 ? "" : "s"} ({b.importedCount} imported)
                </option>
              ))}
              {!batches?.length && <option value="">No batches yet — pull to create one</option>}
            </select>
          )}
          <button type="button" onClick={doNewBatch} disabled={batchBusy}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40">
            <Plus size={13} /> New batch
          </button>
          {activeBatch && !renaming && (
            <button type="button" disabled={batchBusy}
              onClick={() => { setRenameDraft(activeBatch.name); setRenaming(true); }}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40">
              <Pencil size={13} /> Rename
            </button>
          )}
          {activeBatch && (
            <button type="button" onClick={doDeleteBatch} disabled={batchBusy}
              title="Delete this batch and its agents (imported GHL contacts are unaffected)"
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-40">
              {batchBusy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} Delete
            </button>
          )}
          {data.batch?.tag && (
            <span className="text-xs text-slate-400" title="GHL tag applied to every contact imported from this batch">
              Import tag: {data.batch.tag}
            </span>
          )}
        </div>

        {!data.enabled ? (
          <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400">
            Add your RentCast API key in Settings to enable Agent Outreach.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
              <div className="col-span-2">
                <label className={LABEL_CLS}>Zip codes (comma-separated)</label>
                <input className={INPUT_CLS} value={zips} onChange={(e) => setZips(e.target.value)} placeholder="98092, 98002" />
              </div>
              <div>
                <label className={LABEL_CLS} title="Pulls the whole county (needs the state). Zips win when set; county beats city.">
                  County
                </label>
                <input className={INPUT_CLS} value={county} onChange={(e) => setCounty(e.target.value)} placeholder="King" />
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
                <label className={LABEL_CLS} title="A listing counts as distressed once it has sat this many days on market (one of the three distress signals)">
                  Stale after (days)
                </label>
                <input className={INPUT_CLS} type="number" min="1" value={staleDom}
                  onChange={(e) => setStaleDom(e.target.value)} placeholder="45" disabled={!distressOnly} />
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
              <div className="col-span-2 flex items-end pb-2 sm:col-span-3">
                <label className="flex items-center gap-1.5 text-sm text-slate-700"
                  title="Keep only listings with at least one distress signal: stale (see days input), a price-cut history, or priced ≤90% of the area's median $/sqft. Agents keep their full listing count either way.">
                  <input type="checkbox" checked={distressOnly} onChange={(e) => setDistressOnly(e.target.checked)} />
                  Distress signals only (stale, price-cut, or cheap $/sqft)
                </label>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button type="button" onClick={doPull} disabled={pulling || clearing}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40">
                {pulling ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
                Pull listings
              </button>
              {agents.length > 0 && (
                <button type="button" onClick={doClear} disabled={pulling || clearing}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3.5 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                  title="Remove this batch's non-imported agents so a re-filtered pull starts fresh (imported agents are kept)">
                  {clearing ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                  Clear non-imported
                </button>
              )}
              <span className="text-xs text-slate-400">
                Pulls add to the selected batch — create a New batch for a fresh list.
                Zips are used when set; else county + state; else city + state. Same-filter re-pulls are cached 24h.
              </span>
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
                className={`rounded-full px-3 py-1 text-xs font-medium ${filter === key ? "bg-blue-600 text-white" : "bg-white text-slate-600 hover:bg-slate-100"}`}>
                {label}
              </button>
            ))}
            <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 focus:border-blue-500 focus:outline-none"
              title="Classified by RentCast's property type plus address suffix (Apt/Unit/#)">
              <option value="all">All types</option>
              <option value="house">Houses only</option>
              <option value="condo">Condos &amp; apts only</option>
            </select>
            <select value={minActive} onChange={(e) => setMinActive(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 focus:border-blue-500 focus:outline-none"
              title="Filter by how many active listings the agent has in this market (from the full pull)">
              <option value="0">Any activity</option>
              <option value="2">2+ listings</option>
              <option value="3">3+ listings</option>
            </select>
            <input value={priceMin} onChange={(e) => setPriceMin(e.target.value)} placeholder="Min $" inputMode="numeric"
              className="w-24 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs focus:border-blue-500 focus:outline-none" />
            <input value={priceMax} onChange={(e) => setPriceMax(e.target.value)} placeholder="Max $" inputMode="numeric"
              className="w-24 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs focus:border-blue-500 focus:outline-none" />
            <div className="ml-auto flex min-w-[14rem] items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5">
              <Search size={14} className="text-slate-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search agents…"
                className="w-full text-sm focus:outline-none" />
              {q && (
                <button type="button" onClick={() => setQ("")} className="rounded p-0.5 text-slate-400 hover:bg-slate-100">
                  <X size={13} />
                </button>
              )}
            </div>
          </div>

          {/* ---- import bar ---- */}
          {selected.size > 0 && (
            <div className="sticky top-14 z-20 rounded-xl border border-slate-300 bg-white p-3 shadow-sm">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm font-semibold">{selected.size} selected</span>
                <label className="flex items-center gap-1.5 text-sm text-slate-700">
                  <input type="checkbox" checked={applyTag} onChange={(e) => setApplyTag(e.target.checked)} />
                  Apply "{data.tag}" tag (starts the outreach texts)
                </label>
                <label className="flex items-center gap-1.5 text-xs text-slate-500"
                  title="This import session's tag = batch tag + this suffix, so same-day imports stay individually filterable in GHL. Clear it to apply only the batch tag.">
                  Import tag:
                  <span className="text-slate-400">{data.batch?.tag}-</span>
                  <input value={sessionTag} onChange={(e) => setSessionTag(e.target.value)}
                    className="w-28 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs focus:border-blue-500 focus:outline-none" />
                </label>
                <div className="ml-auto flex gap-2">
                  <button type="button" onClick={doPreview} disabled={previewing || importing}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3.5 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40">
                    {previewing ? <Loader2 size={14} className="animate-spin" /> : null} Preview import
                  </button>
                  <button type="button" onClick={doImport} disabled={importing || previewing}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40">
                    {importing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                    Import {selected.size} to GoHighLevel
                  </button>
                </div>
              </div>
              {preview && (
                <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
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
                <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
                  {importResult.error ? (
                    <span className="text-red-700">{importResult.error}</span>
                  ) : (
                    <>
                      <span className={importResult.dryRun ? "text-amber-800" : "text-emerald-800"}>
                        {importResult.dryRun
                          ? "Server ran a dry-run (imports disabled) — nothing was written."
                          : `Imported ${importResult.imported} agent${importResult.imported === 1 ? "" : "s"} with tag${importResult.sessionTag ? `s "${importResult.batchTag}" + "${importResult.sessionTag}"` : ` "${importResult.batchTag}"`}.`}
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
            <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-400">
              No agents match.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-3 py-2.5">
                      <input type="checkbox" checked={allSelected} onChange={toggleAll} title="Select all shown" />
                    </th>
                    <th className="px-4 py-2.5">Agent</th>
                    <th className="px-4 py-2.5">Brokerage</th>
                    <th className="px-4 py-2.5 text-center">Listings</th>
                    <th className="px-4 py-2.5">Hook listing</th>
                    <th className="sticky right-0 bg-white px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((a) => (
                    <React.Fragment key={a.agentKey}>
                      <tr className="group border-b border-slate-100 last:border-0 hover:bg-slate-50">
                        <td className="px-3 py-2.5">
                          <input type="checkbox" checked={selected.has(a.agentKey)}
                            disabled={a.status === "imported" || a.status === "skipped"}
                            onChange={() => toggle(a.agentKey)} />
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2 font-medium">
                            {a.name || "—"} <StatusBadge agent={a} />
                          </div>
                          <div className="text-xs text-slate-500">
                            {[a.phone, a.email].filter(Boolean).join(" · ") || "no contact info"}
                          </div>
                          {a.ghl?.lastMessageAt && (
                            <div className="text-xs text-slate-400" title={new Date(a.ghl.lastMessageAt).toLocaleString()}>
                              last messaged {fmtAgo(a.ghl.lastMessageAt)}
                            </div>
                          )}
                          {(a.offers || []).map((o) => (
                            <div key={o.id} className="text-xs">
                              <a href={offerAppUrl(o.id)} target="_blank" rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-emerald-700 underline decoration-emerald-200 underline-offset-2 hover:text-emerald-900"
                                title={`Open this offer (${o.address || ""})`}>
                                Offer {fmtPrice(o.cashAmount)} · {(o.createdAt || "").slice(0, 10)}
                              </a>
                            </div>
                          ))}
                        </td>
                        <td className="max-w-[10rem] truncate px-4 py-2.5 text-slate-600">{a.brokerage || "—"}</td>
                        <td className="px-4 py-2.5 text-center text-slate-600">
                          {a.listingCount}
                          {a.distressedCount != null && (
                            <div className="text-[11px] text-amber-600">{a.distressedCount} distressed</div>
                          )}
                        </td>
                        <td className="max-w-[16rem] px-4 py-2.5">
                          <div className="truncate"><ZLink address={a.hook?.address} /></div>
                          <div className="text-xs text-slate-500">
                            {fmtPrice(a.hook?.price)} · {a.hook?.dom != null ? `${a.hook.dom} DOM` : "DOM —"}
                            {a.hook?.propertyType ? ` · ${a.hook.propertyType}` : ""}
                          </div>
                        </td>
                        <td className="sticky right-0 whitespace-nowrap bg-white px-3 py-2.5 text-right group-hover:bg-slate-50">
                          <button type="button"
                            onClick={() => setExpanded(expanded === a.agentKey ? "" : a.agentKey)}
                            className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                            title="Show this agent's listings">
                            {expanded === a.agentKey ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                          </button>
                          {a.status !== "imported" && (
                            <button type="button" onClick={() => skip(a, a.status === "skipped")}
                              className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                              title={a.status === "skipped" ? "Unskip" : "Skip this agent"}>
                              {a.status === "skipped" ? <RotateCcw size={15} /> : <EyeOff size={15} />}
                            </button>
                          )}
                        </td>
                      </tr>
                      {expanded === a.agentKey && (
                        <tr className="border-b border-slate-100 bg-slate-50">
                          <td colSpan={6} className="px-6 py-3">
                            <AgentListings agentKey={a.agentKey} batchId={batchId} />
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
        <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-400">
          {activeBatch ? `No agents in "${activeBatch.name}" yet — pull listings above.` : "No agents yet — pull listings above to get started."}
        </div>
      )}
    </div>
  );
}
