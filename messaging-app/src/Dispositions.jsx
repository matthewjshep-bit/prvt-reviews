// Dispositions.jsx — the cash-buyer book. Mirrors the investor contacts out of
// GHL, searches them in plain English against their buy box, lets you fix a buy
// box in place (writing back to GHL), and tags a shortlist so a GHL workflow
// blasts them the deal.
//
// One idea holds the page together: there is a single query object. Typing a
// question fills it in via the AI; the filter controls and the chips edit the
// same object directly and re-filter with no AI call. So the model is never a
// black box — you can always see what it understood and correct it.

import React, { useEffect, useMemo, useState } from "react";
import {
  AlertCircle, ChevronDown, ChevronUp, ExternalLink, Loader2, Megaphone,
  Pencil, RefreshCw, Search, X,
} from "lucide-react";
import {
  PROPERTY_TYPES, PROPERTY_TYPE_LABELS, REHAB_APPETITES, REHAB_APPETITE_LABELS,
  buyboxIsEmpty, normalizeQuery, priceBandText, queryChips, queryIsEmpty, removeChip,
} from "@shared/buybox.js";
import {
  blastInvestors, getInvestor, getInvestors, ghlContactUrl, saveBuybox,
  searchInvestors, setInvestorStatus, syncInvestors,
} from "./api.js";

const INPUT_CLS =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none";
const LABEL_CLS = "mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500";
const PILL_CLS = "rounded-full px-3 py-1 text-xs font-medium transition-colors";

const fmtAgo = (iso) => {
  if (!iso) return "never";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
};

const FIT_CLS = {
  strong: "bg-emerald-100 text-emerald-800",
  possible: "bg-slate-100 text-slate-700",
  weak: "bg-slate-50 text-slate-500",
};

function FitBadge({ fit, score }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${FIT_CLS[fit] || FIT_CLS.possible}`}
      title={`Match score ${score}/100`}>
      {fit}
    </span>
  );
}

/* ---------------- buy box editor ---------------- */

// Edits are diffed server-side, so only what you actually change is written to
// GHL — the enrichment sweep's other findings are never clobbered.
function BuyboxEditor({ investor, onSaved, onCancel }) {
  const b = investor.buybox || {};
  const [form, setForm] = useState({
    buybox_areas: b.areasRaw || "",
    buybox_price_min: b.priceMin ?? "",
    buybox_price_max: b.priceMax ?? "",
    buybox_property_types: (b.propertyTypes || []).join(", "),
    buybox_lot_min: b.lotMin ?? "",
    rehab_appetite: b.rehabAppetite || "",
    buybox_exclusions: b.exclusions || "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleType = (t) => {
    const cur = form.buybox_property_types.split(",").map((s) => s.trim()).filter(Boolean);
    const next = cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t];
    set("buybox_property_types")(next.join(", "));
  };

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await saveBuybox(investor.contactId, form);
      onSaved(r.investor, r.changed);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const types = form.buybox_property_types.split(",").map((s) => s.trim()).filter(Boolean);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className={LABEL_CLS}>Areas</label>
          <input className={INPUT_CLS} value={form.buybox_areas} onChange={(e) => set("buybox_areas")(e.target.value)}
            placeholder="Tacoma, Spanaway, 98444" />
          <p className="mt-1 text-xs text-slate-500">Cities, neighborhoods, or zips — comma separated.</p>
        </div>
        <div>
          <label className={LABEL_CLS}>Price min</label>
          <input className={INPUT_CLS} inputMode="numeric" value={form.buybox_price_min}
            onChange={(e) => set("buybox_price_min")(e.target.value)} placeholder="200000" />
        </div>
        <div>
          <label className={LABEL_CLS}>Price max</label>
          <input className={INPUT_CLS} inputMode="numeric" value={form.buybox_price_max}
            onChange={(e) => set("buybox_price_max")(e.target.value)} placeholder="400000" />
        </div>
        <div className="sm:col-span-2">
          <label className={LABEL_CLS}>Property types</label>
          <div className="flex flex-wrap gap-1.5">
            {PROPERTY_TYPES.map((t) => (
              <button key={t} type="button" onClick={() => toggleType(t)}
                className={`${PILL_CLS} ${types.includes(t) ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
                {PROPERTY_TYPE_LABELS[t]}
              </button>
            ))}
          </div>
        </div>
        <div className="sm:col-span-2">
          <label className={LABEL_CLS}>Rehab appetite — the most work they'll take on</label>
          <div className="flex flex-wrap gap-1.5">
            {REHAB_APPETITES.map((r) => (
              <button key={r} type="button"
                onClick={() => set("rehab_appetite")(form.rehab_appetite === r ? "" : r)}
                className={`${PILL_CLS} ${form.rehab_appetite === r ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
                {REHAB_APPETITE_LABELS[r]}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className={LABEL_CLS}>Min lot (sqft)</label>
          <input className={INPUT_CLS} inputMode="numeric" value={form.buybox_lot_min}
            onChange={(e) => set("buybox_lot_min")(e.target.value)} placeholder="5000" />
        </div>
        <div>
          <label className={LABEL_CLS}>Must-haves / dealbreakers</label>
          <input className={INPUT_CLS} value={form.buybox_exclusions}
            onChange={(e) => set("buybox_exclusions")(e.target.value)} placeholder="no flood zones, needs garage" />
        </div>
      </div>

      {error && <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className="mt-3 flex items-center gap-2">
        <button type="button" onClick={save} disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40">
          {busy ? <Loader2 size={14} className="animate-spin" /> : null} Save to GoHighLevel
        </button>
        <button type="button" onClick={onCancel} disabled={busy}
          className="rounded-lg border border-slate-300 px-3.5 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
          Cancel
        </button>
        {investor.enrichLastRun && (
          <span className="text-xs text-slate-500">
            AI last enriched this contact {String(investor.enrichLastRun).slice(0, 10)}
          </span>
        )}
      </div>
    </div>
  );
}

/* ---------------- expanded row ---------------- */

function InvestorDetail({ investor, onSaved }) {
  const [editing, setEditing] = useState(false);
  // Which of OUR deals this investor is actually on — a different thing from
  // the AI-written property history below, which records what they said about
  // properties whether or not it ever became a deal.
  // The table row is trimmed to keep a few-thousand-investor book loadable, so
  // the conversation summary and property history come from this one fetch
  // rather than riding along on every row.
  const [detail, setDetail] = useState(null);
  useEffect(() => {
    let live = true;
    getInvestor(investor.contactId)
      .then((r) => { if (live) setDetail(r); })
      .catch(() => { if (live) setDetail({ deals: [] }); });
    return () => { live = false; };
  }, [investor.contactId]);

  const full = { ...investor, ...(detail?.investor || {}) };
  const deals = detail?.deals || null;
  const b = full.buybox || investor.buybox || {};
  const history = String(full.dealHistory || "").split(/\r?\n/).filter(Boolean).slice(-8).reverse();

  if (editing) {
    return (
      <BuyboxEditor
        investor={full}
        onCancel={() => setEditing(false)}
        onSaved={(next, changed) => { setEditing(false); onSaved(next, changed); }}
      />
    );
  }

  const facts = [
    ["Areas", b.areasRaw || null],
    ["Price", priceBandText(b)],
    ["Types", b.propertyTypes?.length ? b.propertyTypes.map((t) => PROPERTY_TYPE_LABELS[t]).join(", ") : null],
    ["Rehab appetite", b.rehabAppetite ? REHAB_APPETITE_LABELS[b.rehabAppetite] : null],
    ["Min lot", b.lotMin != null ? `${Math.round(b.lotMin).toLocaleString("en-US")} sqft` : null],
    ["Must-haves / dealbreakers", b.exclusions || null],
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div>
        <div className="mb-2 flex items-center gap-2">
          <span className={LABEL_CLS + " mb-0"}>Buy box</span>
          <button type="button" onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2 py-0.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
            <Pencil size={11} /> Edit
          </button>
        </div>
        {buyboxIsEmpty(b) ? (
          <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            No buy box on file — this investor will match almost anything and rank last. Ask them what they buy,
            then fill it in here.
          </div>
        ) : (
          <dl className="space-y-1 text-sm">
            {facts.filter(([, v]) => v).map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <dt className="w-44 shrink-0 text-slate-500">{k}</dt>
                <dd className="text-slate-900">{v}</dd>
              </div>
            ))}
          </dl>
        )}
        {full.lastConvoSummary && (
          <p className="mt-3 text-sm text-slate-600">
            <span className="font-semibold text-slate-700">Last conversation</span>
            {full.lastConvoDate ? ` (${String(full.lastConvoDate).slice(0, 10)})` : ""}: {full.lastConvoSummary}
          </p>
        )}
      </div>

      <div>
        {deals?.length > 0 && (
          <div className="mb-3">
            <span className={LABEL_CLS}>On your deals</span>
            <ul className="space-y-1 text-sm">
              {deals.map((d) => (
                <li key={d.offerId} className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-slate-700" title={d.address}>{d.address}</span>
                  <span className="shrink-0 text-xs text-slate-500">{d.status} · {d.stage.replace(/_/g, " ")}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <span className={LABEL_CLS}>Property history</span>
        {history.length === 0 ? (
          <p className="text-sm text-slate-400">Nothing recorded yet.</p>
        ) : (
          <ul className="space-y-1 text-sm text-slate-700">
            {history.map((line, i) => <li key={i} className="font-mono text-xs">{line}</li>)}
          </ul>
        )}
        <div className="mt-3 flex items-center gap-3">
          <a href={ghlContactUrl(investor.contactId)} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-700">
            Open in GoHighLevel <ExternalLink size={11} />
          </a>
          {investor.lastBlastAt && (
            <span className="text-xs text-slate-500">Last blasted {fmtAgo(investor.lastBlastAt)}</span>
          )}
          {!detail && <Loader2 size={12} className="animate-spin text-slate-300" />}
        </div>
      </div>
    </div>
  );
}

/* ---------------- page ---------------- */

export default function Dispositions() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);

  // The one query object. `null` = browsing the whole book.
  const [query, setQuery] = useState(null);
  const [question, setQuestion] = useState("");
  const [strict, setStrict] = useState(false);
  const [search, setSearch] = useState(null); // null | {busy} | search response
  const [nameFilter, setNameFilter] = useState("");

  // Book-level filters: WHO to consider at all. Distinct from the buy-box
  // criteria in `query`, which decide whether their buy box fits.
  const [excludeOnDeal, setExcludeOnDeal] = useState(false);
  const [buyboxStatus, setBuyboxStatus] = useState("all"); // all | documented | missing
  const [areaText, setAreaText] = useState("");
  const [priceText, setPriceText] = useState("");

  const [selected, setSelected] = useState(() => new Set());
  const [expanded, setExpanded] = useState("");

  const [blastLabel, setBlastLabel] = useState("");
  const [applyTag, setApplyTag] = useState(true);
  const [preview, setPreview] = useState(null);
  const [blastResult, setBlastResult] = useState(null);
  const [blasting, setBlasting] = useState(false);

  const refresh = async () => {
    try {
      setData(await getInvestors());
    } catch (e) {
      setError(e.message);
    }
  };
  useEffect(() => { refresh(); }, []);

  const doSync = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const r = await syncInvestors();
      setSyncMsg({
        ok: true,
        text: `Synced ${r.synced} investor${r.synced === 1 ? "" : "s"} — ${r.created} new, ${r.updated} updated` +
          (r.removed ? `, ${r.removed} no longer tagged` : "") + ".",
        warnings: r.warnings || [],
      });
      await refresh();
      if (query) await runSearch({ parsed: query });
    } catch (e) {
      setSyncMsg({ ok: false, text: e.message });
    } finally {
      setSyncing(false);
    }
  };

  // One entry point for every search: free text parses first, a parsed query
  // re-filters locally. Both land in the same place.
  const runSearch = async ({ text, parsed, over = {} }) => {
    setSearch({ busy: true });
    setSelected(new Set());
    const filters = {
      excludeOnDeal, buyboxStatus,
      ...over, // a control that just changed hasn't re-rendered its state yet
    };
    try {
      const r = await searchInvestors({ query: text, parsed, strict, filters });
      setSearch(r);
      setQuery(r.parsed);
    } catch (e) {
      setSearch({ error: e.message });
    }
  };

  const clearSearch = () => {
    setSearch(null);
    setQuery(null);
    setQuestion("");
    setAreaText("");
    setPriceText("");
    setSelected(new Set());
  };

  // Book-level filters apply in browse mode too, so flipping one re-runs an
  // active search and otherwise just re-filters the table client-side.
  const setBookFilter = (over) => {
    if (over.excludeOnDeal !== undefined) setExcludeOnDeal(over.excludeOnDeal);
    if (over.buyboxStatus !== undefined) setBuyboxStatus(over.buyboxStatus);
    if (query) runSearch({ parsed: query, over });
  };

  // Areas and price are buy-box CRITERIA, so they edit the query itself —
  // same object the AI fills in and the chips display.
  const applyAreas = (text) => {
    const areas = text.split(",").map((a) => a.trim()).filter(Boolean);
    editQuery({ ...(query || {}), areas });
  };
  const applyPrice = (text) => {
    // "400k" / "250-400k" / "400000" — one box instead of two, because a deal
    // is a price point far more often than a range.
    const nums = text.match(/[\d.]+\s*[kKmM]?/g) || [];
    const parse = (t) => {
      const n = parseFloat(t);
      if (!Number.isFinite(n)) return null;
      return /[kK]/.test(t) ? n * 1e3 : /[mM]/.test(t) ? n * 1e6 : n;
    };
    const vals = nums.map(parse).filter((n) => n != null);
    if (!vals.length) return editQuery({ ...(query || {}), priceMin: null, priceMax: null });
    if (vals.length === 1) return editQuery({ ...(query || {}), priceMin: null, priceMax: vals[0] });
    editQuery({ ...(query || {}), priceMin: Math.min(...vals), priceMax: Math.max(...vals) });
  };

  // Editing a chip or a filter control mutates the query and re-filters —
  // never a second AI call.
  const editQuery = (next) => {
    const q = normalizeQuery(next);
    if (queryIsEmpty(q)) return clearSearch();
    runSearch({ parsed: q });
  };

  const investors = data?.investors || [];
  const byId = useMemo(
    () => new Map(investors.map((i) => [i.contactId, i])),
    [investors]
  );

  // What the table shows: search results when a search is live, else the book.
  // The book-level filters are applied server-side during a search and here
  // when browsing, so the two views agree about who's in scope.
  const rows = useMemo(() => {
    let base;
    if (search?.results) {
      base = search.results.map((r) => ({ ...byId.get(r.contactId), ...r }));
    } else {
      base = investors.filter((i) => i.status !== "archived");
      if (excludeOnDeal) base = base.filter((i) => !i.onLiveDeal);
      if (buyboxStatus === "documented") base = base.filter((i) => !buyboxIsEmpty(i.buybox));
      if (buyboxStatus === "missing") base = base.filter((i) => buyboxIsEmpty(i.buybox));
    }
    const needle = nameFilter.trim().toLowerCase();
    if (!needle) return base;
    return base.filter((i) =>
      `${i.name || ""} ${i.buybox?.areasRaw || ""}`.toLowerCase().includes(needle)
    );
  }, [search, investors, byId, nameFilter, excludeOnDeal, buyboxStatus]);

  const chips = query ? queryChips(query) : [];
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.contactId));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.contactId)));
  const toggle = (id) =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const doPreview = async () => {
    setBlastResult(null);
    setPreview({ busy: true });
    try {
      setPreview(await blastInvestors({
        contactIds: [...selected], label: blastLabel.trim(), applyTag, dryRun: true,
      }));
    } catch (e) {
      setPreview({ error: e.message });
    }
  };

  const doBlast = async () => {
    const n = selected.size;
    const tag = preview?.blastTag || "the blast tag";
    if (!window.confirm(
      `Tag ${n} investor${n === 1 ? "" : "s"} in GoHighLevel with "${tag}"` +
      `${applyTag ? ` and the trigger tag (starts the blast)` : " (no trigger tag — start the workflow manually)"}?`
    )) return;
    setBlasting(true);
    try {
      const r = await blastInvestors({
        contactIds: [...selected], label: blastLabel.trim(), applyTag, dryRun: false,
      });
      setBlastResult(r);
      setPreview(null);
      // The server downgrades to a dry run when blasts are disabled — believe
      // the response, not the button that was clicked.
      if (!r.dryRun) {
        setSelected(new Set());
        await refresh();
      }
    } catch (e) {
      setBlastResult({ error: e.message });
    } finally {
      setBlasting(false);
    }
  };

  const archive = async (investor) => {
    const next = investor.status === "archived" ? "active" : "archived";
    try {
      await setInvestorStatus(investor.contactId, next);
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  };

  const onBuyboxSaved = async (next, changed) => {
    setSyncMsg({ ok: true, text: `Updated ${changed.length} field${changed.length === 1 ? "" : "s"} on ${next.name || "this investor"} in GoHighLevel.` });
    await refresh();
    if (query) await runSearch({ parsed: query });
  };

  if (error) return <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>;
  if (!data) return <div className="flex justify-center p-10"><Loader2 className="animate-spin text-slate-400" /></div>;

  return (
    <div className="space-y-4">
      {/* ---- header ---- */}
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-sm font-bold text-slate-900">
            {data.counts.active} investor{data.counts.active === 1 ? "" : "s"}
            {data.counts.total > data.counts.active && (
              <span className="font-normal text-slate-500"> · {data.counts.total - data.counts.active} archived</span>
            )}
          </h2>
          <p className="text-xs text-slate-500">
            Synced {fmtAgo(data.syncedAt)} from tags {data.tags.map((t) => `"${t}"`).join(", ")}
            {data.counts.needsBuybox > 0 && (
              <> · <span className="font-semibold text-amber-700">{data.counts.needsBuybox} with no buy box</span></>
            )}
          </p>
        </div>
        <button type="button" onClick={doSync} disabled={syncing}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3.5 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40">
          {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Sync from GoHighLevel
        </button>
      </div>

      {syncMsg && (
        <div className={`rounded-lg px-3 py-2 text-sm ${syncMsg.ok ? "bg-slate-50 text-slate-700" : "bg-red-50 text-red-700"}`}>
          {syncMsg.text}
          {(syncMsg.warnings || []).map((w, i) => (
            <div key={i} className="mt-1 flex items-start gap-1.5 text-xs text-amber-800">
              <AlertCircle size={12} className="mt-0.5 shrink-0" /> {w}
            </div>
          ))}
        </div>
      )}

      {/* ---- search ---- */}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <form onSubmit={(e) => { e.preventDefault(); if (question.trim()) runSearch({ text: question.trim() }); }}>
          <label className={LABEL_CLS}>Find a buyer</label>
          <div className="flex flex-wrap gap-2">
            <div className="flex min-w-[18rem] flex-1 items-center gap-2 rounded-lg border border-slate-300 px-3 py-2">
              <Search size={14} className="shrink-0 text-slate-400" />
              <input value={question} onChange={(e) => setQuestion(e.target.value)}
                placeholder="cash buyers for a gut-job duplex in Tacoma under 400k"
                className="w-full text-sm focus:outline-none" />
              {question && (
                <button type="button" onClick={clearSearch} className="rounded p-0.5 text-slate-400 hover:bg-slate-100">
                  <X size={13} />
                </button>
              )}
            </div>
            <button type="submit" disabled={!question.trim() || search?.busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40">
              {search?.busy ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} Search
            </button>
          </div>
        </form>

        {/* what the AI understood — every chip removable, no re-parse */}
        {chips.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-slate-500">Matching on</span>
            {chips.map((chip) => (
              <button key={`${chip.field}:${chip.value}`} type="button"
                onClick={() => editQuery(removeChip(query, chip))}
                title="Remove this criterion"
                className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-800 hover:bg-blue-100">
                {chip.label} <X size={11} />
              </button>
            ))}
            <button type="button" onClick={clearSearch}
              className="ml-1 text-xs font-semibold text-slate-500 hover:text-slate-700">Clear</button>
          </div>
        )}

        {/* buy-box criteria you can set by hand — no AI key needed */}
        <div className="mt-3 grid gap-2 border-t border-slate-100 pt-3 sm:grid-cols-2">
          <div>
            <label className={LABEL_CLS}>Areas they buy in</label>
            <input className={INPUT_CLS} value={areaText}
              onChange={(e) => setAreaText(e.target.value)}
              onBlur={(e) => applyAreas(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyAreas(e.target.value); } }}
              placeholder="Tacoma, 98444 — matches their buy box areas" />
          </div>
          <div>
            <label className={LABEL_CLS}>Deal price</label>
            <input className={INPUT_CLS} value={priceText}
              onChange={(e) => setPriceText(e.target.value)}
              onBlur={(e) => applyPrice(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyPrice(e.target.value); } }}
              placeholder="400k, or 250-400k — overlaps their price band" />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-slate-500">Or filter:</span>
          {PROPERTY_TYPES.map((t) => {
            const on = query?.propertyTypes?.includes(t);
            return (
              <button key={t} type="button"
                onClick={() => editQuery({
                  ...(query || {}),
                  propertyTypes: on
                    ? query.propertyTypes.filter((x) => x !== t)
                    : [...(query?.propertyTypes || []), t],
                })}
                className={`${PILL_CLS} ${on ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
                {PROPERTY_TYPE_LABELS[t]}
              </button>
            );
          })}
          <span className="mx-1 h-4 w-px bg-slate-200" />
          {REHAB_APPETITES.map((r) => {
            const on = query?.rehabAppetite === r;
            return (
              <button key={r} type="button"
                onClick={() => editQuery({ ...(query || {}), rehabAppetite: on ? null : r })}
                className={`${PILL_CLS} ${on ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
                {REHAB_APPETITE_LABELS[r]}
              </button>
            );
          })}
          <label className="ml-auto flex items-center gap-1.5 text-xs text-slate-600"
            title="Strict drops investors whose buy box is silent on something you asked for. Loose (the default) keeps them — a blank field means nobody has asked them yet, not that they said no.">
            <input type="checkbox" checked={strict}
              onChange={(e) => { setStrict(e.target.checked); if (query) runSearch({ parsed: query }); }} />
            Only documented fits
          </label>
        </div>

        {/* who to consider at all — separate from whether their buy box fits */}
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3">
          <span className="text-xs text-slate-500">Who to include:</span>
          <div className="flex overflow-hidden rounded-lg border border-slate-300">
            {[
              ["all", `Everyone${data ? ` (${data.counts.active})` : ""}`],
              ["documented", `Has a buy box${data ? ` (${data.counts.documented ?? 0})` : ""}`],
              ["missing", `Needs one${data ? ` (${data.counts.needsBuybox})` : ""}`],
            ].map(([key, label]) => (
              <button key={key} type="button" onClick={() => setBookFilter({ buyboxStatus: key })}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  buyboxStatus === key ? "bg-blue-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>
                {label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-xs text-slate-600"
            title="Hides investors already linked to a deal that is still live. Someone who passed on a deal stays in — they're free for the next one.">
            <input type="checkbox" checked={excludeOnDeal}
              onChange={(e) => setBookFilter({ excludeOnDeal: e.target.checked })} />
            Not already on a live deal{data?.counts.onLiveDeal ? ` (${data.counts.onLiveDeal} are)` : ""}
          </label>
        </div>

        {search?.error && (
          <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{search.error}</div>
        )}
        {search?.results && (
          <p className="mt-3 text-xs text-slate-500">
            <span className="font-semibold text-slate-700">{search.documented}</span> documented fit
            {search.documented === 1 ? "" : "s"} out of {search.scanned} considered
            {search.rankedByAi > 0
              ? " — ranked by AI."
              : " — ordered by how many criteria matched (add an Anthropic key in Settings for AI ranking and reasons)."}
            {search.truncated && ` Showing the top ${search.shortlisted}.`}
            {search.undocumented > 0 && (
              <> {search.undocumented} more have no buy box on file and sit at the bottom —
                they aren't ruled out, nobody has asked them yet.</>
            )}
            {(search.warnings || []).map((w, i) => (
              <span key={i} className="ml-1 text-amber-800">{w}</span>
            ))}
          </p>
        )}
      </div>

      {/* ---- blast bar ---- */}
      {selected.size > 0 && (
        <div className="sticky top-14 z-20 rounded-xl border border-slate-300 bg-white p-3 shadow-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-semibold">{selected.size} selected</span>
            <label className="flex items-center gap-1.5 text-sm text-slate-700">
              <input type="checkbox" checked={applyTag} onChange={(e) => setApplyTag(e.target.checked)} />
              Apply the trigger tag (starts the blast workflow)
            </label>
            <label className="flex items-center gap-1.5 text-xs text-slate-500"
              title="Names this blast's own tag so you can target it in GHL later — usually the deal address.">
              Blast tag:
              <input value={blastLabel} onChange={(e) => setBlastLabel(e.target.value)} placeholder="2010 NE 54th St"
                className="w-40 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs focus:border-blue-500 focus:outline-none" />
            </label>
            <div className="ml-auto flex gap-2">
              <button type="button" onClick={doPreview} disabled={preview?.busy || blasting}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3.5 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40">
                {preview?.busy ? <Loader2 size={14} className="animate-spin" /> : null} Preview
              </button>
              <button type="button" onClick={doBlast} disabled={blasting || preview?.busy}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40">
                {blasting ? <Loader2 size={14} className="animate-spin" /> : <Megaphone size={14} />}
                Tag &amp; blast {selected.size}
              </button>
            </div>
          </div>

          {preview && !preview.busy && (
            <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
              {preview.error ? <span className="text-red-700">{preview.error}</span> : (
                <>
                  Will tag {preview.results.filter((r) => r.ok).length} investor
                  {preview.results.filter((r) => r.ok).length === 1 ? "" : "s"} with{" "}
                  <span className="font-mono text-xs">{preview.blastTag}</span>
                  {applyTag && preview.triggerTag ? <> + <span className="font-mono text-xs">{preview.triggerTag}</span></> : ", no trigger tag"}.
                  {!preview.blastsEnabled && (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-800">
                      DISPO_BLASTS_ENABLED is off on the server — blasts stay dry-run
                    </span>
                  )}
                </>
              )}
            </div>
          )}

          {blastResult && (
            <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
              {blastResult.error ? <span className="text-red-700">{blastResult.error}</span> : (
                <>
                  <span className={blastResult.dryRun ? "text-amber-800" : "text-emerald-800"}>
                    {blastResult.dryRun
                      ? "Server ran a dry run (blasts disabled) — nothing was tagged."
                      : `Tagged ${blastResult.blasted} investor${blastResult.blasted === 1 ? "" : "s"} with "${blastResult.blastTag}".`}
                  </span>
                  {blastResult.results.filter((r) => !r.ok).map((r) => (
                    <div key={r.contactId} className="mt-1 text-xs text-red-700">{r.contactId}: {r.error}</div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* ---- table ---- */}
      <div className="flex items-center gap-2">
        <div className="flex min-w-[14rem] items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5">
          <Search size={14} className="text-slate-400" />
          <input value={nameFilter} onChange={(e) => setNameFilter(e.target.value)} placeholder="Filter by name or area…"
            className="w-full text-sm focus:outline-none" />
          {nameFilter && (
            <button type="button" onClick={() => setNameFilter("")} className="rounded p-0.5 text-slate-400 hover:bg-slate-100">
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-400">
          {search?.results
            ? "No investor's buy box fits that. Try removing a criterion above, or sync if your book looks stale."
            : investors.length === 0
              ? "No investors yet — Sync from GoHighLevel to pull in every contact carrying your investor tags."
              : "No investors match that filter."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-3 py-2.5">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} title="Select all shown" />
                </th>
                <th className="px-4 py-2.5">Investor</th>
                <th className="px-4 py-2.5">Areas</th>
                <th className="px-4 py-2.5">Price band</th>
                <th className="px-4 py-2.5">Types</th>
                <th className="px-4 py-2.5">Rehab</th>
                {search?.results && <th className="px-4 py-2.5">Fit</th>}
                <th className="sticky right-0 bg-white px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((inv) => {
                const b = inv.buybox || {};
                const open = expanded === inv.contactId;
                return (
                  <React.Fragment key={inv.contactId}>
                    <tr className="group border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="px-3 py-2.5">
                        <input type="checkbox" checked={selected.has(inv.contactId)}
                          onChange={() => toggle(inv.contactId)} onClick={(e) => e.stopPropagation()} />
                      </td>
                      <td className="px-4 py-2.5">
                        <button type="button" onClick={() => setExpanded(open ? "" : inv.contactId)}
                          className="text-left font-semibold text-slate-900 hover:text-blue-700">
                          {inv.name || "Unnamed"}
                        </button>
                        {buyboxIsEmpty(b) && (
                          <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800">
                            no buy box
                          </span>
                        )}
                        {inv.onLiveDeal && (
                          <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-[11px] font-semibold text-blue-800"
                            title="Already linked to a deal that's still in flight">
                            on a deal
                          </span>
                        )}
                        {inv.reason && <div className="mt-0.5 text-xs text-slate-600">{inv.reason}</div>}
                      </td>
                      <td className="max-w-[16rem] truncate px-4 py-2.5 text-slate-700" title={b.areasRaw || ""}>
                        {b.areasRaw || "—"}
                      </td>
                      <td className="px-4 py-2.5 font-semibold tabular-nums text-slate-900">{priceBandText(b) || "—"}</td>
                      <td className="px-4 py-2.5 text-slate-700">
                        {b.propertyTypes?.length ? b.propertyTypes.map((t) => PROPERTY_TYPE_LABELS[t]).join(", ") : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-slate-700">
                        {b.rehabAppetite ? REHAB_APPETITE_LABELS[b.rehabAppetite] : "—"}
                      </td>
                      {search?.results && (
                        <td className="px-4 py-2.5"><FitBadge fit={inv.fit} score={inv.score} /></td>
                      )}
                      <td className="sticky right-0 bg-white px-4 py-2.5 group-hover:bg-slate-50">
                        <div className="flex items-center justify-end gap-2">
                          <a href={ghlContactUrl(inv.contactId)} target="_blank" rel="noreferrer"
                            onClick={(e) => e.stopPropagation()} title="Open in GoHighLevel"
                            className="text-slate-400 hover:text-slate-700">
                            <ExternalLink size={14} />
                          </a>
                          <button type="button" onClick={() => setExpanded(open ? "" : inv.contactId)}
                            className="text-slate-400 hover:text-slate-700">
                            {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {open && (
                      <tr className="border-b border-slate-100 bg-slate-50 last:border-0">
                        <td colSpan={search?.results ? 8 : 7} className="px-4 py-4">
                          <InvestorDetail investor={inv} onSaved={onBuyboxSaved} />
                          <button type="button" onClick={() => archive(inv)}
                            className="mt-3 text-xs font-semibold text-slate-500 hover:text-slate-700">
                            {inv.status === "archived" ? "Restore to the active book" : "Archive (hide from search)"}
                          </button>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
