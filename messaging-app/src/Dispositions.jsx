// Dispositions.jsx — the cash-buyer book. Mirrors the investor contacts out of
// GHL, and puts the people we've actually talked with first: the tabs split
// the book by relationship (shared/talked-to.js), a plain search box and a few
// dropdowns narrow it, a live deal can rank it, and a shortlist gets tagged so
// a GHL workflow blasts them the deal. The buy box is edited in place and
// written back to GHL.

import React, { useEffect, useMemo, useState } from "react";
import {
  AlertCircle, ChevronDown, ChevronUp, Loader2, Map as MapIcon, Megaphone,
  Pencil, RefreshCw, Search, X, Eye } from "lucide-react";
import {
  PROPERTY_TYPES, PROPERTY_TYPE_LABELS, REHAB_APPETITES, REHAB_APPETITE_LABELS,
  buyboxIsEmpty, priceBandText,
} from "@shared/buybox.js";
import {
  blastInvestors, getInvestor, getInvestors, saveBuybox,
  setInvestorStatus, syncInvestors,
} from "./api.js";
import { BTN, EmptyState, ErrorBar, Spinner, TableCard } from "./ui.jsx";
import { RELATIONSHIPS, matchesText, relationshipOf } from "@shared/talked-to.js";
import { REGIONS, REGION_KEYS, STRATEGIES, cityLabel, regionFor } from "@shared/dispo-regions.js";
import { TIERS } from "@shared/buyer-score.js";
import { getDispoInsights, listDeals, rankBuyersForDeal } from "./api.js";
import BuyerMap from "./BuyerMap.jsx";
import DispoCharts from "./DispoCharts.jsx";

const TIER_CLS = { vip: "bg-violet-100 text-violet-800", active: "bg-emerald-100 text-emerald-800", cold: "bg-slate-100 text-slate-500" };
const LIVE_DEAL = new Set(["under_contract", "buyer_found", "assigned"]);

function TierBadge({ inv }) {
  if (!inv?.tier) return null;
  const why = [`Score ${inv.score}/100`, inv.scoreParts ? `activity ${inv.scoreParts.activity} · engagement ${inv.scoreParts.engagement} · reach ${inv.scoreParts.reach}` : "", ...(inv.scoreReasons || [])].filter(Boolean).join("\n");
  return (
    <span className={`ml-2 rounded px-1.5 py-0.5 text-[11px] font-semibold ${TIER_CLS[inv.tier]}`} title={why}>
      {TIERS[inv.tier]} {inv.score}
    </span>
  );
}

const fmtMoneyShort = (n) => {
  const v = Number(n) || 0;
  if (!v) return "—";
  return v >= 1e6 ? `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M` : `$${Math.round(v / 1000)}k`;
};
const fmtMonth = (iso) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", year: "numeric" }) : "");

// Sortable columns. Each reads a comparable value off a row; empty sorts last.
const SORTS = {
  name: (i) => String(i.name || "").toLowerCase(),
  region: (i) => (i.markets?.regions?.[0] ? REGIONS[i.markets.regions[0]]?.label || "" : ""),
  lastFlip: (i) => i.flips?.lastAt || "",
  largest: (i) => i.flips?.largest || 0,
  reply: (i) => i.lastRepliedAt || i.lastMessageAt || "",
  blasted: (i) => i.lastBlastAt || "",
  score: (i) => i.score ?? 0,
  match: (i) => i.rank ?? 0,
};
const readSort = () => {
  try {
    const [key, dir] = String(new URLSearchParams(window.location.search).get("sort") || "").split(":");
    return SORTS[key] ? { key, dir: dir === "asc" ? "asc" : "desc" } : null;
  } catch { return null; }
};

function SortTh({ label, sortKey, sort, onSort, className = "" }) {
  const on = sort?.key === sortKey;
  return (
    <th className={`px-4 py-2.5 ${className}`}>
      <button type="button" onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 uppercase tracking-wide ${on ? "text-slate-900" : "hover:text-slate-700"}`}
        title="Sort">
        {label}{on ? (sort.dir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : null}
      </button>
    </th>
  );
}
import ContactLink from "./ContactLink.jsx";

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

const fmtPhone = (p) => {
  const d = String(p || "").replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p || "";
};

const REL_CLS = {
  talking: "bg-emerald-100 text-emerald-800",
  replied: "bg-sky-100 text-sky-800",
  no_reply: "bg-amber-50 text-amber-800",
  never: "bg-slate-100 text-slate-500",
  opted_out: "bg-red-50 text-red-700",
};

// When they last wrote to us, and how much talking there's been — the second
// line is what separates a relationship from one "who is this?".
function RelationshipCell({ inv }) {
  const r = inv.relationship || relationshipOf(inv);
  const t = inv.talk;
  const bits = [];
  if (t?.replies) bits.push(`${t.replies} repl${t.replies === 1 ? "y" : "ies"}`);
  if (t?.calls) bits.push(`${t.calls} call${t.calls === 1 ? "" : "s"}`);
  if (inv.engagement?.talks) bits.push(`${inv.engagement.talks} logged`);
  const when = inv.lastRepliedAt ? fmtAgo(inv.lastRepliedAt) : inv.lastMessageAt ? `messaged ${fmtAgo(inv.lastMessageAt)}` : "";
  return (
    <div title={RELATIONSHIPS[r]?.hint}>
      <div className="flex items-center gap-1.5">
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${REL_CLS[r]}`}>{RELATIONSHIPS[r]?.label}</span>
        {inv.lastRepliedAt && <span className="text-xs text-slate-600">{when}</span>}
      </div>
      {(bits.length > 0 || (!inv.lastRepliedAt && when)) && (
        <div className="mt-0.5 text-[11px] text-slate-500">{bits.length ? bits.join(" · ") : when}</div>
      )}
    </div>
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
  const purchases = detail?.purchases || [];
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

        {purchases.length > 0 && (
          <div className="mb-3">
            <span className={LABEL_CLS}>Properties they financed</span>
            <ul className="space-y-1 text-sm">
              {purchases.map((p, idx) => (
                <li key={idx} className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-slate-700" title={p.address}>{p.address || p.city}</span>
                  <span className="shrink-0 text-xs text-slate-500">
                    {fmtMonth(p.at)} · {fmtMoneyShort(p.amount)} · {p.lender}{p.strategy ? ` · ${STRATEGIES[p.strategy] || p.strategy}` : ""}
                  </span>
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
          <ContactLink contactId={investor.contactId} party="investor" className="text-xs font-semibold text-blue-600" title="Their full record">
            Full record
          </ContactLink>
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

// Who the page opens on. The book is a few thousand names off borrower lists;
// the people worth a text today are the few we've actually talked with.
const WHO_KEYS = ["talking", "replied", "no_reply", "never", "all", "opted_out"];
const readWho = () => {
  try {
    const w = new URLSearchParams(window.location.search).get("who");
    return WHO_KEYS.includes(w) ? w : "talking";
  } catch { return "talking"; }
};
const setParam = (k, v) => {
  try { const u = new URL(window.location.href); v ? u.searchParams.set(k, v) : u.searchParams.delete(k); window.history.replaceState(window.history.state, "", u.pathname + u.search); } catch { /* the filter still works */ }
};

const SELECT_CLS = "rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm text-slate-700 focus:border-blue-500 focus:outline-none";

export default function Dispositions() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);

  const [who, setWho] = useState(readWho);
  const [text, setText] = useState("");
  const [region, setRegion] = useState("");
  const [city, setCity] = useState("");
  const [type, setType] = useState("");
  const [tier, setTier] = useState("");
  const [buyboxStatus, setBuyboxStatus] = useState(""); // "" | documented | missing
  const [excludeOnDeal, setExcludeOnDeal] = useState(false);
  // Matching the book against one live deal: ranked buyers replace the order.
  const [deals, setDeals] = useState([]);
  const [dealId, setDealId] = useState("");
  const [ranking, setRanking] = useState(null); // null | {busy} | {error} | rank response
  const [showInsights, setShowInsights] = useState(false);
  const [insights, setInsights] = useState(null);
  const [sort, setSort] = useState(readSort);
  const onSort = (key) => {
    const next = sort?.key === key ? { key, dir: sort.dir === "desc" ? "asc" : "desc" } : { key, dir: key === "name" || key === "region" ? "asc" : "desc" };
    setSort(next);
    setParam("sort", `${next.key}:${next.dir}`);
  };

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
  useEffect(() => {
    listDeals().then((r) => {
      const list = Array.isArray(r) ? r : r?.deals || r?.offers || [];
      setDeals(list.filter((o) => LIVE_DEAL.has(o.deal?.stage)));
    }).catch(() => {});
  }, []);

  const pickDeal = async (id) => {
    setDealId(id);
    setSelected(new Set());
    if (!id) { setRanking(null); return; }
    setRanking({ busy: true });
    try {
      const r = await rankBuyersForDeal(id);
      setRanking(r);
      if (!blastLabel) setBlastLabel((r.deal?.address || "").split(",")[0]);
    } catch (e) { setRanking({ error: e.message }); }
  };

  useEffect(() => {
    if (!showInsights) return undefined;
    let live = true;
    getDispoInsights({ region, city, type, tier })
      .then((r) => { if (live) setInsights(r); })
      .catch((e) => { if (live) setInsights({ error: e.message }); });
    return () => { live = false; };
  }, [showInsights, region, city, type, tier]);

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
    } catch (e) {
      setSyncMsg({ ok: false, text: e.message });
    } finally {
      setSyncing(false);
    }
  };

  const pickWho = (k) => { setWho(k); setSelected(new Set()); setParam("who", k === "talking" ? "" : k); };
  const clearFilters = () => {
    setText(""); setRegion(""); setCity(""); setType(""); setTier(""); setBuyboxStatus(""); setExcludeOnDeal(false);
    setSelected(new Set());
  };
  const filtersOn = !!(text || region || city || type || tier || buyboxStatus || excludeOnDeal);

  // Every row carries its relationship from the server; a row from before the
  // server learned to send it is worked out here the same way.
  const investors = useMemo(
    () => (data?.investors || []).map((i) => ({ ...i, relationship: i.relationship || relationshipOf(i) })),
    [data]
  );
  const byId = useMemo(() => new Map(investors.map((i) => [i.contactId, i])), [investors]);

  const whoCounts = useMemo(() => {
    const c = { all: 0 };
    for (const i of investors) {
      if (i.status === "archived") continue;
      c[i.relationship] = (c[i.relationship] || 0) + 1;
      if (i.relationship !== "opted_out") c.all++;
    }
    return c;
  }, [investors]);

  // Everything but the relationship filter, so each tab's count can say what
  // it would show with the other filters as they are.
  const filtered = useMemo(() => {
    let base = ranking?.results
      ? ranking.results.map((r) => ({ ...byId.get(r.contactId), ...r })).filter((i) => i.name !== undefined)
      : investors;
    base = base.filter((i) => i.status !== "archived");
    if (excludeOnDeal) base = base.filter((i) => !i.onLiveDeal);
    if (buyboxStatus === "documented") base = base.filter((i) => !buyboxIsEmpty(i.buybox));
    if (buyboxStatus === "missing") base = base.filter((i) => buyboxIsEmpty(i.buybox));
    if (region) base = base.filter((i) => i.markets?.regions?.includes(region));
    if (city) base = base.filter((i) => i.markets?.cities?.includes(city));
    if (type) base = base.filter((i) => i.markets?.types?.includes(type));
    if (tier) base = base.filter((i) => i.tier === tier);
    if (text.trim()) base = base.filter((i) => matchesText(i, text));
    return base;
  }, [ranking, investors, byId, excludeOnDeal, buyboxStatus, region, city, type, tier, text]);

  const shownCounts = useMemo(() => {
    const c = { all: 0 };
    for (const i of filtered) {
      c[i.relationship] = (c[i.relationship] || 0) + 1;
      if (i.relationship !== "opted_out") c.all++;
    }
    return c;
  }, [filtered]);

  const rows = useMemo(() => {
    const base = who === "all" ? filtered.filter((i) => i.relationship !== "opted_out") : filtered.filter((i) => i.relationship === who);
    // Ranked for a deal: the rank order is the point unless you pick a column.
    const s = sort || (ranking?.results ? null : { key: "reply", dir: "desc" });
    if (!s) return base;
    const val = SORTS[s.key];
    const dir = s.dir === "asc" ? 1 : -1;
    return [...base].sort((a, b) => {
      const va = val(a), vb = val(b);
      const ea = va === "" || va === 0, eb = vb === "" || vb === 0;
      if (ea !== eb) return ea ? 1 : -1; // empties last either way
      return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
    });
  }, [filtered, who, sort, ranking]);

  // Cities under the chosen region, with how many investors bought there.
  const regionCities = useMemo(() => {
    if (!region) return [];
    return Object.entries(data?.counts?.cities || {})
      .filter(([c]) => regionFor(c.replace(/-/g, " ")) === region)
      .sort((a, b) => b[1] - a[1]);
  }, [region, data]);

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
        offerId: ranking?.deal?.offerId || "",
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
        offerId: ranking?.deal?.offerId || "",
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
  };

  if (error) return <ErrorBar>{error}</ErrorBar>;
  if (!data) return <Spinner />;

  const cols = 8 + (ranking?.results ? 1 : 0);

  return (
    <div className="space-y-3">
      {/* ---- header ---- */}
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-base font-bold text-slate-900">Buyers</h2>
          <p className="text-xs text-slate-500">
            {data.counts.active.toLocaleString()} in the book · synced {fmtAgo(data.syncedAt)}
            {data.counts.total > data.counts.active && <> · {data.counts.total - data.counts.active} archived</>}
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={() => setShowInsights((v) => !v)} aria-expanded={showInsights} className={BTN}>
            <MapIcon size={13} /> {showInsights ? "Hide map" : "Map & charts"}
          </button>
          <button type="button" onClick={doSync} disabled={syncing} className={BTN}
            title="Re-read every investor-tagged contact from GoHighLevel, with how much each has talked to us. Runs nightly too.">
            {syncing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Sync
          </button>
        </div>
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

      {/* ---- who: the relationship tabs ---- */}
      <div role="tablist" aria-label="Relationship" className="flex flex-wrap gap-1 border-b border-slate-200">
        {WHO_KEYS.map((k) => {
          const on = who === k;
          const n = shownCounts[k] || 0;
          if (k === "opted_out" && !whoCounts.opted_out) return null;
          return (
            <button key={k} type="button" role="tab" aria-selected={on} onClick={() => pickWho(k)}
              title={RELATIONSHIPS[k]?.hint || "Everyone who hasn't opted out"}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold transition-colors ${
                on ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-800"} ${k === "opted_out" ? "ml-auto font-normal" : ""}`}>
              {k === "all" ? "Everyone" : RELATIONSHIPS[k].label}
              <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[11px] tabular-nums ${on ? "bg-blue-100 text-blue-800" : "bg-slate-100 text-slate-500"}`}>
                {n.toLocaleString()}
              </span>
            </button>
          );
        })}
      </div>

      {/* ---- search + filters ---- */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-[16rem] flex-1 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 focus-within:border-blue-500">
          <Search size={14} className="shrink-0 text-slate-400" />
          <input value={text} onChange={(e) => { setText(e.target.value); setSelected(new Set()); }}
            placeholder="Search name, email, phone, city, tag…" aria-label="Search buyers"
            className="w-full text-sm focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0" />
          {text && (
            <button type="button" onClick={() => setText("")} aria-label="Clear search" className="rounded p-0.5 text-slate-400 hover:bg-slate-100">
              <X size={13} />
            </button>
          )}
        </div>
        <select value={region} onChange={(e) => { setRegion(e.target.value); setCity(""); setSelected(new Set()); }} className={SELECT_CLS} aria-label="Region">
          <option value="">Any region</option>
          {REGION_KEYS.filter((k) => data.counts.regions?.[k]).map((k) => (
            <option key={k} value={k}>{REGIONS[k].label} ({data.counts.regions[k]})</option>
          ))}
        </select>
        {regionCities.length > 1 && (
          <select value={city} onChange={(e) => { setCity(e.target.value); setSelected(new Set()); }} className={SELECT_CLS} aria-label="City">
            <option value="">Any city</option>
            {regionCities.map(([c, n]) => <option key={c} value={c}>{cityLabel(c)} ({n})</option>)}
          </select>
        )}
        <select value={type} onChange={(e) => { setType(e.target.value); setSelected(new Set()); }} className={SELECT_CLS} aria-label="What they buy">
          <option value="">Any strategy</option>
          {Object.entries(STRATEGIES).map(([k, label]) => (
            <option key={k} value={k}>{label} ({data.counts.types?.[k] || 0})</option>
          ))}
        </select>
        <select value={tier} onChange={(e) => { setTier(e.target.value); setSelected(new Set()); }} className={SELECT_CLS} aria-label="Tier">
          <option value="">Any tier</option>
          {["vip", "active", "cold"].map((k) => <option key={k} value={k}>{TIERS[k]} ({data.counts.tiers?.[k] || 0})</option>)}
        </select>
        <select value={buyboxStatus} onChange={(e) => { setBuyboxStatus(e.target.value); setSelected(new Set()); }} className={SELECT_CLS} aria-label="Buy box">
          <option value="">Buy box: any</option>
          <option value="documented">Has a buy box</option>
          <option value="missing">No buy box yet</option>
        </select>
        <label className="flex items-center gap-1.5 text-xs text-slate-600"
          title="Hides investors already linked to a deal that is still live. Someone who passed on a deal stays in — they're free for the next one.">
          <input type="checkbox" checked={excludeOnDeal} onChange={(e) => { setExcludeOnDeal(e.target.checked); setSelected(new Set()); }} />
          Not on a live deal
        </label>
        {filtersOn && (
          <button type="button" onClick={clearFilters} className="text-xs font-semibold text-slate-500 hover:text-slate-800">Clear filters</button>
        )}
      </div>

      {/* ---- rank for a deal ---- */}
      {deals.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2">
          <span className="text-xs font-semibold text-slate-600">Rank for a deal</span>
          <select value={dealId} onChange={(e) => pickDeal(e.target.value)} className={SELECT_CLS + " py-1.5"} aria-label="Rank for a deal">
            <option value="">— pick a live deal —</option>
            {deals.map((o) => (
              <option key={o.id} value={o.id}>{(o.address || "").split(",").slice(0, 2).join(",")} · {String(o.deal?.stage || "").replace(/_/g, " ")}</option>
            ))}
          </select>
          {ranking?.busy && <Loader2 size={14} className="animate-spin text-slate-400" />}
          {ranking?.error && <span className="text-xs text-red-700">{ranking.error}</span>}
          {ranking?.results && (
            <>
              <span className="text-xs text-slate-500">
                {ranking.deal.city ? cityLabel(ranking.deal.city) : "no city"}{ranking.deal.region ? ` · ${REGIONS[ranking.deal.region]?.label}` : ""}
                {ranking.deal.price ? ` · buyer price ~$${Math.round(ranking.deal.price / 1000)}k` : ""}
              </span>
              <div className="ml-auto flex gap-1.5">
                <button type="button" className={BTN}
                  onClick={() => setSelected(new Set(rows.filter((r) => r.tier === "vip" && r.rank >= 50 && !r.alreadyBlasted).map((r) => r.contactId)))}
                  title="VIP buyers with a match score of 50+ who haven't been sent this deal — the first wave">
                  Select VIP wave
                </button>
                <button type="button" className={BTN}
                  onClick={() => setSelected(new Set(rows.filter((r) => !r.alreadyBlasted).slice(0, 25).map((r) => r.contactId)))}>
                  Select top 25
                </button>
                <button type="button" className="text-xs font-semibold text-slate-500 hover:text-slate-700" onClick={() => pickDeal("")}>Clear</button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ---- map & charts ---- */}
      {showInsights && (
        <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          {insights?.error && <div className="text-sm text-red-700">{insights.error}</div>}
          {!insights && <Loader2 size={14} className="animate-spin text-slate-400" />}
          {insights && !insights.error && (
            <>
              <p className="text-xs text-slate-500">
                {insights.investors} investors · {insights.purchases} properties financed
              </p>
              <div className="grid gap-3 xl:grid-cols-[3fr_2fr]">
                <BuyerMap points={insights.cityPoints} deal={ranking?.deal} selectedCity={city}
                  onPickCity={(c) => { setCity(c); if (c) setRegion(regionFor(c.replace(/-/g, " ")) || region); }} />
                <DispoCharts insights={insights} region={region} onPickRegion={(r) => { setRegion(r); setCity(""); }} />
              </div>
            </>
          )}
        </div>
      )}

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
      {rows.length === 0 ? (
        <EmptyState action={filtersOn ? <button type="button" className={BTN} onClick={clearFilters}>Clear filters</button> : null}>
          {investors.length === 0
            ? "No investors yet — Sync to pull in every contact carrying your investor tags."
            : who === "talking" && !filtersOn
              ? "Nobody here yet. Once the next sync counts replies and calls, everyone you've had a real back-and-forth with lands on this tab."
              : "Nobody matches that."}
        </EmptyState>
      ) : (
        <TableCard>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="w-8 px-3 py-2.5">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} title="Select all shown" aria-label="Select all shown" />
                </th>
                <SortTh label="Buyer" sortKey="name" sort={sort} onSort={onSort} />
                {ranking?.results && <SortTh label="Match" sortKey="match" sort={sort} onSort={onSort} />}
                <SortTh label="Last heard from" sortKey="reply" sort={sort} onSort={onSort} />
                <SortTh label="Market" sortKey="region" sort={sort} onSort={onSort} />
                <th className="px-4 py-2.5">Buys</th>
                <SortTh label="Score" sortKey="score" sort={sort} onSort={onSort} />
                <SortTh label="Blasted" sortKey="blasted" sort={sort} onSort={onSort} />
                <th className="sticky right-0 bg-white px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((inv) => {
                const b = inv.buybox || {};
                const open = expanded === inv.contactId;
                const m = inv.markets || {};
                const cities = (m.cities || []).map(cityLabel);
                const regionText = (m.regions || []).map((r) => REGIONS[r]?.label || r).join(", ");
                return (
                  <React.Fragment key={inv.contactId}>
                    <tr className="group border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="px-3 py-2.5 align-top">
                        <input type="checkbox" checked={selected.has(inv.contactId)} aria-label={`Select ${inv.name || "buyer"}`}
                          onChange={() => toggle(inv.contactId)} onClick={(e) => e.stopPropagation()} />
                      </td>
                      <td className="max-w-[16rem] px-4 py-2.5 align-top">
                        <button type="button" onClick={() => setExpanded(open ? "" : inv.contactId)}
                          className="text-left font-semibold text-slate-900 hover:text-blue-700">
                          {inv.name || "Unnamed"}
                        </button>
                        {inv.onLiveDeal && (
                          <span className="ml-1.5 rounded bg-blue-100 px-1.5 py-0.5 text-[11px] font-semibold text-blue-800"
                            title="Already linked to a deal that's still in flight">on a deal</span>
                        )}
                        <div className="truncate text-xs text-slate-500">{[inv.email, fmtPhone(inv.phone)].filter(Boolean).join(" · ") || "—"}</div>
                      </td>
                      {ranking?.results && (
                        <td className="max-w-[14rem] px-4 py-2.5 align-top">
                          <div className="flex items-center gap-1.5">
                            <span className="w-8 tabular-nums font-semibold text-slate-900">{inv.rank}</span>
                            <span className="h-1.5 w-16 overflow-hidden rounded bg-slate-100"><span className="block h-full rounded bg-blue-600" style={{ width: `${inv.rank}%` }} /></span>
                            {inv.alreadyBlasted && <span className="rounded bg-slate-100 px-1 text-[10px] font-semibold text-slate-600">sent</span>}
                          </div>
                          <div className="truncate text-[11px] text-slate-500"
                            title={inv.rankParts ? `location ${inv.rankParts.location} · price ${inv.rankParts.price} · recency ${inv.rankParts.recency} · tier ${inv.rankParts.tier} · strategy ${inv.rankParts.strategy}` : ""}>
                            {(inv.rankReasons || []).join(" · ") || "—"}
                          </div>
                        </td>
                      )}
                      <td className="px-4 py-2.5 align-top"><RelationshipCell inv={inv} /></td>
                      <td className="max-w-[14rem] px-4 py-2.5 align-top text-slate-700">
                        {!regionText && !cities.length && !m.states?.length ? (
                          <span className="block truncate text-slate-500" title={b.areasRaw || ""}>{b.areasRaw || "—"}</span>
                        ) : (
                          <>
                            <div className="truncate font-medium text-slate-900">{regionText || (m.states || []).join(", ")}</div>
                            {cities.length > 0 && (
                              <div className="truncate text-xs text-slate-500" title={cities.join(", ")}>
                                {cities.slice(0, 3).join(", ")}{cities.length > 3 ? ` +${cities.length - 3}` : ""}
                              </div>
                            )}
                          </>
                        )}
                      </td>
                      <td className="max-w-[14rem] px-4 py-2.5 align-top">
                        <div className="truncate text-slate-900">
                          {(m.types || []).map((t) => STRATEGIES[t] || t).join(", ") || <span className="text-slate-400">—</span>}
                          {priceBandText(b) && <span className="ml-1.5 font-semibold tabular-nums">{priceBandText(b)}</span>}
                        </div>
                        <div className="truncate text-xs text-slate-500" title={(inv.flips?.lenders || []).join(", ")}>
                          {buyboxIsEmpty(b)
                            ? <span className="text-amber-700">no buy box</span>
                            : [
                              (b.propertyTypes || []).map((t) => PROPERTY_TYPE_LABELS[t]).join(", "),
                              b.rehabAppetite ? REHAB_APPETITE_LABELS[b.rehabAppetite] : "",
                              b.exclusions,
                            ].filter(Boolean).join(" · ") || b.areasRaw}
                          {inv.flips && <> · last loan {fmtMonth(inv.flips.lastAt)}{inv.flips.count > 1 ? ` (${inv.flips.count})` : ""}</>}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 align-top"><TierBadge inv={inv} /></td>
                      <td className="px-4 py-2.5 align-top text-xs text-slate-500">{inv.lastBlastAt ? fmtAgo(inv.lastBlastAt) : "—"}</td>
                      <td className="sticky right-0 bg-white px-4 py-2.5 align-top group-hover:bg-slate-50">
                        <div className="flex items-center justify-end gap-2">
                          <ContactLink contactId={inv.contactId} party="investor" iconOnly stopPropagation title="Their full record">
                            <Eye size={14} />
                          </ContactLink>
                          <button type="button" onClick={() => setExpanded(open ? "" : inv.contactId)} aria-label={open ? "Collapse" : "Expand"}
                            className="text-slate-400 hover:text-slate-700">
                            {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {open && (
                      <tr className="border-b border-slate-100 bg-slate-50 last:border-0">
                        <td colSpan={cols} className="px-4 py-4">
                          <InvestorDetail investor={inv} onSaved={onBuyboxSaved} />
                          <button type="button" onClick={() => archive(inv)}
                            className="mt-3 text-xs font-semibold text-slate-500 hover:text-slate-700">
                            {inv.status === "archived" ? "Restore to the active book" : "Archive (hide from the book)"}
                          </button>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </TableCard>
      )}
      {rows.length > 0 && (
        <p className="text-xs text-slate-400">{rows.length.toLocaleString()} shown</p>
      )}
    </div>
  );
}
