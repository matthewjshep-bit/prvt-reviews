// CompsPane.jsx — comps map for the New Offer page. Centers on the subject
// property (OSM/Leaflet), pulls nearby comps from RentCast when an API key is
// configured in Settings, lets the user tick the comps that are truly
// comparable (or add manual ones), and turns the selection into a suggested
// ARV (avg $/sqft × subject sqft, else median price) with one click to apply.

import React, { useEffect, useMemo, useState } from "react";
import { MapContainer, TileLayer, CircleMarker, Tooltip } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { ExternalLink, Loader2, MapPin, Plus, Sparkles, X } from "lucide-react";
import { fmtMoney } from "@shared/offer-calc.js";
import { geocode, getComps, gradeComps, zillowUrl } from "./api.js";

const INPUT_CLS =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none";

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Renovation condition of a comp at time of sale. ARV is an AFTER-REPAIR
// value, so renovated/updated comps are the ones that should drive it.
const CONDITIONS = ["renovated", "updated", "dated", "distressed", "unknown"];
const COND_LABELS = { renovated: "Renovated", updated: "Updated", dated: "Dated", distressed: "Distressed", unknown: "Unknown" };
const COND_CLS = {
  renovated: "bg-emerald-100 text-emerald-800",
  updated: "bg-blue-100 text-blue-800",
  dated: "bg-amber-100 text-amber-800",
  distressed: "bg-red-100 text-red-700",
  unknown: "bg-gray-100 text-gray-500",
  "": "bg-gray-50 text-gray-400",
};

// Location/site detractors that discount the subject relative to the comps
// (external obsolescence). Percent of base ARV; defaults from published
// study ranges, editable per offer. Positive percentages work too (premiums).
const ADJ_PRESETS = [
  { key: "busy_road", label: "Busy road", pct: -5 },
  { key: "power_lines", label: "Power lines / easement", pct: -6 },
  { key: "backs_commercial", label: "Backs commercial / industrial", pct: -5 },
  { key: "railroad", label: "Railroad / highway noise", pct: -6 },
  { key: "steep_lot", label: "Steep / difficult lot", pct: -4 },
  { key: "flood_zone", label: "Flood zone", pct: -7 },
  { key: "airport", label: "Airport flight path", pct: -5 },
  { key: "cell_tower", label: "Cell tower / substation", pct: -3 },
];

export default function CompsPane({ address, onUseArv, sqft: subjectSqft, setSqft: setSubjectSqft, onSubjectInfo, initialState, onStateChange }) {
  const [state, setState] = useState(initialState?.result || null); // { subject:{lat,lng}, info, comps, estimate, enabled }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(() => new Set(initialState?.selected || []));
  const [manual, setManual] = useState(initialState?.manual || []);
  const [draft, setDraft] = useState({ label: "", price: "", sqft: "" });
  const [months, setMonths] = useState(initialState?.months || 12);
  // User-corrected subject beds/baths — the provider's record is sometimes
  // wrong; these drive the comps filters and the rehab room counts.
  const [beds, setBeds] = useState(initialState?.beds || "");
  const [baths, setBaths] = useState(initialState?.baths || "");
  // Condition per comp id: {condition, confidence?, note?, source: "ai"|"manual"}.
  // Manual settings always win over AI grading.
  const [grades, setGrades] = useState(initialState?.grades || {});
  const [grading, setGrading] = useState(null); // {done, total} while the AI pass runs
  // ARV adjustments: [{key, label, pct}] — pct stays a string while editing.
  const [adjustments, setAdjustments] = useState(initialState?.adjustments || []);
  const [adjDraft, setAdjDraft] = useState({ label: "", pct: "" });

  const toggleAdjustment = (preset) =>
    setAdjustments((list) =>
      list.some((a) => a.key === preset.key)
        ? list.filter((a) => a.key !== preset.key)
        : [...list, { key: preset.key, label: preset.label, pct: String(preset.pct) }]
    );
  const setAdjPct = (key, pct) =>
    setAdjustments((list) => list.map((a) => (a.key === key ? { ...a, pct } : a)));
  const removeAdjustment = (key) => setAdjustments((list) => list.filter((a) => a.key !== key));
  const addCustomAdjustment = () => {
    const pct = Number(adjDraft.pct);
    if (!adjDraft.label.trim() || !pct) return;
    setAdjustments((list) => [...list, { key: `custom-${Date.now()}`, label: adjDraft.label.trim(), pct: String(pct) }]);
    setAdjDraft({ label: "", pct: "" });
  };

  // Keep the rehab pane's room counts in sync with corrected beds/baths.
  const editSubjectFacts = (nextBeds, nextBaths) => {
    setBeds(nextBeds); setBaths(nextBaths);
    if (state?.info) {
      const info = {
        ...state.info,
        ...(Number(nextBeds) > 0 ? { beds: Number(nextBeds) } : {}),
        ...(Number(nextBaths) > 0 ? { baths: Number(nextBaths) } : {}),
      };
      onSubjectInfo?.(info);
    }
  };

  const parse = (v) => Number(String(v).replace(/[^\d.]/g, "")) || 0;

  async function load() {
    if (!address?.trim()) { setError("Enter the property address first."); return; }
    setLoading(true); setError("");
    try {
      const [geo, comps] = await Promise.all([
        geocode(address.trim()).catch(() => null),
        getComps(address.trim(), {
          sqft: parse(subjectSqft) || undefined,
          months,
          beds: Number(beds) > 0 ? Number(beds) : undefined,
          baths: Number(baths) > 0 ? Number(baths) : undefined,
        }),
      ]);
      // Prefer the data provider's subject coordinates; fall back to geocode.
      const center = comps.subject?.lat
        ? { lat: comps.subject.lat, lng: comps.subject.lng }
        : geo;
      if (!center) throw new Error("couldn't locate that address on the map");
      // Spread first: comps carries its own `subject` (the provider record,
      // which can be all-null when the address has no record) and must not
      // clobber the resolved map center.
      setState({ ...comps, subject: center, info: comps.subject || null, loadedFor: address.trim() });
      // User-typed beds/baths win over the provider record everywhere.
      if (comps.subject) {
        onSubjectInfo?.({
          ...comps.subject,
          ...(Number(beds) > 0 ? { beds: Number(beds) } : {}),
          ...(Number(baths) > 0 ? { baths: Number(baths) } : {}),
        });
      }
      // The subject's recorded facts prefill anything not already typed.
      if (!parse(subjectSqft) && comps.subject?.sqft) {
        setSubjectSqft(String(comps.subject.sqft));
      }
      if (!Number(beds) && comps.subject?.beds != null) setBeds(String(comps.subject.beds));
      if (!Number(baths) && comps.subject?.baths != null) setBaths(String(comps.subject.baths));
      // Preselect the closest comps (max 6) — but not when the server relaxed
      // the bed/bath match: those need a deliberate look before they count.
      const pre = comps.bedBathRelaxed
        ? []
        : (comps.comps || [])
            .slice()
            .sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99))
            .slice(0, 6)
            .map((c) => c.id);
      setSelected(new Set(pre));
    } catch (e) { setError(e.message); setState(null); }
    setLoading(false);
  }

  const toggle = (id) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });

  // Manual comps default to renovated — the user picked them deliberately,
  // usually from vetted research — but the dropdown can demote them.
  const condOf = (c) => grades[c.id]?.condition ?? (c.manual ? "renovated" : undefined);

  const setCondition = (id, condition) =>
    setGrades((g) => {
      if (!condition) {
        const { [id]: _drop, ...rest } = g;
        return rest;
      }
      return { ...g, [id]: { ...(g[id] || {}), condition, source: "manual" } };
    });

  // AI-grade the loaded comps in small chunks (each chunk = a few Zillow
  // scrapes + one AI call server-side) so requests stay fast and progress is
  // visible. Manual settings are never overwritten; partial results are kept.
  async function gradeAll() {
    const targets = (state?.comps || []).filter((c) => grades[c.id]?.source !== "manual").slice(0, 12);
    if (!targets.length) return;
    setGrading({ done: 0, total: targets.length });
    setError("");
    try {
      for (let i = 0; i < targets.length; i += 4) {
        const chunk = targets.slice(i, i + 4)
          .map(({ id, address: a, price, sqft, beds: b, baths: ba, saleDate }) => ({ id, address: a, price, sqft, beds: b, baths: ba, saleDate }));
        const r = await gradeComps(address.trim(), chunk);
        setGrades((g) => {
          const next = { ...g };
          for (const [id, gr] of Object.entries(r.grades || {})) {
            if (next[id]?.source !== "manual") next[id] = { ...gr, source: "ai" };
          }
          return next;
        });
        setGrading((p) => (p ? { ...p, done: Math.min(p.total, i + chunk.length) } : p));
      }
    } catch (e) {
      setError(`Grading stopped: ${e.message} — grades so far are kept.`);
    }
    setGrading(null);
  }

  const picked = useMemo(() => {
    const auto = (state?.comps || []).filter((c) => selected.has(c.id));
    return [...auto, ...manual];
  }, [state, selected, manual]);

  const suggestion = useMemo(() => {
    if (!picked.length) return null;
    const sqft = parse(subjectSqft);

    // Base ARV from the comps (three paths, unchanged math), then subject
    // detractor/premium adjustments applied on top.
    let base = 0;
    let baseBasis = "";
    let ppsf = null;
    let graded = false;

    // Graded path: ARV from renovated/updated comps only — size-adjusted to
    // the subject (marginal sqft ≈ half the average $/sqft, the standard
    // appraiser rule) and outlier-trimmed, then the median. Dated/distressed
    // comps stay visible but don't drag the after-repair value down.
    const pool = picked.filter((c) => c.price > 0 && ["renovated", "updated"].includes(condOf(c)));
    if (sqft > 0 && pool.length >= 2) {
      const withSqft = pool.filter((c) => c.sqft > 0);
      const avgPpsf = withSqft.length ? withSqft.reduce((t, c) => t + c.price / c.sqft, 0) / withSqft.length : 0;
      let kept = pool;
      let dropped = 0;
      if (withSqft.length >= 5) {
        const ps = withSqft.map((c) => c.price / c.sqft).sort((a, b) => a - b);
        const q1 = ps[Math.floor(ps.length * 0.25)];
        const q3 = ps[Math.floor(ps.length * 0.75)];
        const iqr = q3 - q1;
        const inRange = (c) => {
          if (!(c.sqft > 0)) return true;
          const p = c.price / c.sqft;
          return p >= q1 - 1.5 * iqr && p <= q3 + 1.5 * iqr;
        };
        const trimmed = pool.filter(inRange);
        if (trimmed.length >= 2) { dropped = pool.length - trimmed.length; kept = trimmed; }
      }
      const sizeAdj = kept.map((c) => (c.sqft > 0 && avgPpsf > 0 ? c.price + (sqft - c.sqft) * 0.5 * avgPpsf : c.price));
      base = Math.round(median(sizeAdj) / 1000) * 1000;
      graded = true;
      baseBasis = `${kept.length} renovated/updated comps, size-adjusted${dropped ? `, ${dropped} outlier dropped` : ""}`;
    } else {
      const withSqft = picked.filter((c) => c.sqft > 0);
      if (sqft > 0 && withSqft.length) {
        const rawPpsf = withSqft.reduce((t, c) => t + c.price / c.sqft, 0) / withSqft.length;
        base = Math.round((rawPpsf * sqft) / 1000) * 1000;
        ppsf = Math.round(rawPpsf);
        baseBasis = `${withSqft.length} comps × ${sqft.toLocaleString()} sqft`;
      } else {
        base = Math.round(median(picked.map((c) => c.price)) / 1000) * 1000;
        baseBasis = `median of ${picked.length} comps`;
      }
    }

    // Subject adjustments (busy road, power lines, …) — % of the base ARV.
    const applied = adjustments
      .map((a) => ({ key: a.key, label: a.label, pct: Number(a.pct) || 0 }))
      .filter((a) => a.pct !== 0);
    const totalPct = applied.reduce((t, a) => t + a.pct, 0);
    const arv = applied.length ? Math.round((base * (1 + totalPct / 100)) / 1000) * 1000 : base;
    const adjStr = applied.map((a) => `${a.label} ${a.pct > 0 ? "+" : "−"}${Math.abs(a.pct)}%`).join(", ");
    return {
      arv, base, ppsf, graded, totalPct,
      adjustments: applied,
      basis: applied.length ? `${baseBasis}; ${adjStr}` : baseBasis,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, subjectSqft, grades, adjustments]);

  // Report state upward so drafts/offers can snapshot the comps workspace
  // (grades + the ARV basis ride along for restore and the comps PDF).
  useEffect(() => {
    onStateChange?.({
      result: state, selected: [...selected], manual, months, beds, baths, grades,
      adjustments, arvBase: suggestion?.base ?? null, arvBasis: suggestion?.basis || "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, selected, manual, months, beds, baths, grades, adjustments, suggestion]);

  function addManual() {
    const price = parse(draft.price);
    if (!price) return;
    setManual((m) => [...m, { id: `manual-${Date.now()}`, address: draft.label || "Manual comp", price, sqft: parse(draft.sqft), manual: true }]);
    setDraft({ label: "", price: "", sqft: "" });
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-bold">
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-900 text-[11px] font-bold leading-none text-white">3</span>
          Comps &amp; ARV
        </h2>
        <div className="flex items-center gap-2">
          <select value={months} onChange={(e) => setMonths(Number(e.target.value))}
            className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm focus:border-gray-900 focus:outline-none">
            <option value={6}>Sold ≤ 6 mo</option>
            <option value={9}>Sold ≤ 9 mo</option>
            <option value={12}>Sold ≤ 12 mo</option>
          </select>
          <input
            className="w-16 rounded-lg border border-gray-300 px-2 py-1.5 text-sm focus:border-gray-900 focus:outline-none"
            inputMode="numeric" placeholder="Beds" title="Subject beds — corrects the record and filters comps"
            value={beds}
            onChange={(e) => editSubjectFacts(e.target.value.replace(/[^\d]/g, ""), baths)}
          />
          <input
            className="w-16 rounded-lg border border-gray-300 px-2 py-1.5 text-sm focus:border-gray-900 focus:outline-none"
            inputMode="decimal" placeholder="Baths" title="Subject baths — corrects the record and filters comps"
            value={baths}
            onChange={(e) => editSubjectFacts(beds, e.target.value.replace(/[^\d.]/g, ""))}
          />
          <input
            className="w-32 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-gray-900 focus:outline-none"
            inputMode="numeric" placeholder="Subject sqft"
            value={subjectSqft}
            onChange={(e) => setSubjectSqft(e.target.value.replace(/[^\d,]/g, ""))}
          />
          <button type="button" onClick={load} disabled={loading}
            className="flex items-center gap-1.5 rounded-lg bg-gray-900 px-3.5 py-1.5 text-sm font-semibold text-white disabled:opacity-40 hover:bg-gray-800">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <MapPin size={14} />} Load comps
          </button>
        </div>
      </div>
      {state?.info && (state.info.beds != null || state.info.sqft || state.info.lastSalePrice) && (
        <div className="mb-2 text-xs text-gray-500">
          Subject record: {[
            state.info.beds != null ? `${state.info.beds} bd` : "",
            state.info.baths != null ? `${state.info.baths} ba` : "",
            state.info.sqft ? `${state.info.sqft.toLocaleString()} sqft` : "",
            state.info.yearBuilt ? `built ${state.info.yearBuilt}` : "",
            state.info.lastSalePrice ? `last sold ${fmtMoney(state.info.lastSalePrice)} (${(state.info.lastSaleDate || "").slice(0, 7)})` : "",
          ].filter(Boolean).join(" · ")}
          {" — comps: same beds/baths/county, arms-length, ±20% sqft"}
        </div>
      )}

      {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {state?.loadedFor && address?.trim() && state.loadedFor !== address.trim() && (
        <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          The address changed since these comps loaded (they're for {state.loadedFor}) — hit <b>Load comps</b> to refresh.
        </div>
      )}

      {state && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="overflow-hidden rounded-lg border border-gray-200">
            <MapContainer
              key={`${state.subject.lat},${state.subject.lng}`}
              center={[state.subject.lat, state.subject.lng]}
              zoom={14} scrollWheelZoom={false} style={{ height: 320, width: "100%" }}>
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              <CircleMarker center={[state.subject.lat, state.subject.lng]} radius={10}
                pathOptions={{ color: "#b45309", fillColor: "#f59e0b", fillOpacity: 0.9, weight: 2 }}>
                <Tooltip permanent direction="top" offset={[0, -10]}>Subject</Tooltip>
              </CircleMarker>
              {(state.comps || []).map((c) => (
                <CircleMarker key={c.id} center={[c.lat, c.lng]} radius={7}
                  eventHandlers={{ click: () => toggle(c.id) }}
                  pathOptions={{
                    color: "#1d4ed8",
                    fillColor: selected.has(c.id) ? "#3b82f6" : "#ffffff",
                    fillOpacity: selected.has(c.id) ? 0.9 : 0.6,
                    weight: 2,
                  }}>
                  <Tooltip direction="top" offset={[0, -8]}>
                    {fmtMoney(c.price)}{c.saleDate ? ` sold ${c.saleDate.slice(0, 7)}` : ""}{c.sqft ? ` · ${c.sqft.toLocaleString()} sqft` : ""} — click to {selected.has(c.id) ? "remove" : "include"}
                  </Tooltip>
                </CircleMarker>
              ))}
            </MapContainer>
          </div>

          <div className="flex flex-col">
            {!state.enabled && (
              <div className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Automatic sold comps are off — add your RealEstateAPI key in Settings. You can still add comps manually below.
              </div>
            )}
            {state.enabled && !(state.comps || []).length && (
              <div className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {state.info?.sqft || state.info?.beds != null || Number(beds) > 0 || Number(baths) > 0
                  ? <>No sold comps matched {[
                      Number(beds) > 0 ? `${Number(beds)} bd` : state.info?.beds != null ? `${state.info.beds} bd` : "",
                      Number(baths) > 0 ? `${Number(baths)} ba` : state.info?.baths != null ? `${state.info.baths} ba` : "",
                      parse(subjectSqft) > 0 ? `${parse(subjectSqft).toLocaleString()} sqft` : state.info?.sqft ? `${state.info.sqft.toLocaleString()} sqft` : "",
                    ].filter(Boolean).join(" / ")} in the sold window. Widen the window, adjust beds/baths/sqft and reload — or add comps manually below.</>
                  : <>No property record found for this address — automatic comps unavailable. Add comps manually below.</>}
              </div>
            )}
            {state.enabled && state.widened && (state.comps || []).length > 0 && (
              <div className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Not enough recent sales close by — the search was expanded to {state.widened}. Check each comp's
                distance and sale date before ticking.
              </div>
            )}
            {state.enabled && state.bedBathRelaxed && (state.comps || []).length > 0 && (
              <div className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                No sold comps matched {[Number(beds) > 0 ? `${Number(beds)} bd` : "", Number(baths) > 0 ? `${Number(baths)} ba` : ""].filter(Boolean).join(" / ")} exactly —
                showing other nearby similar-size sales instead. Tick only the ones that truly compare.
              </div>
            )}
            {state.estimate && (
              <div className="mb-2 rounded-lg bg-gray-100 px-3 py-2 text-xs text-gray-700">
                AVM estimate: <b>{fmtMoney(state.estimate.price)}</b>
                {state.estimate.low ? <> (range {fmtMoney(state.estimate.low)} – {fmtMoney(state.estimate.high)})</> : null}
              </div>
            )}
            {state.gradeEnabled && (state.comps || []).length > 0 && (
              <div className="mb-2 flex items-center justify-between gap-2">
                <button type="button" onClick={gradeAll} disabled={Boolean(grading)}
                  className="flex items-center gap-1.5 rounded-lg border border-violet-300 bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-800 hover:bg-violet-100 disabled:opacity-60"
                  title="Pull each comp's sold-listing photos and grade its renovation condition — ARV should come from renovated comps">
                  {grading
                    ? <><Loader2 size={13} className="animate-spin" /> Grading {grading.done}/{grading.total}…</>
                    : <><Sparkles size={13} /> Grade condition (AI)</>}
                </button>
                <span className="text-[11px] text-gray-400">ARV uses renovated/updated comps once graded</span>
              </div>
            )}
            <div className="max-h-56 flex-1 space-y-1 overflow-y-auto pr-1">
              {(state.comps || []).map((c) => (
                <div key={c.id} className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm hover:bg-gray-50">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                    <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                    <span className="min-w-0 flex-1 truncate">{c.address}</span>
                    <span className="whitespace-nowrap text-xs text-gray-500"
                      title={c.yearBuilt ? `Built ${c.yearBuilt}` : undefined}>
                      {[
                        c.beds != null ? `${c.beds}/${c.baths ?? "?"}` : "",
                        c.yearBuilt ? `'${String(c.yearBuilt).slice(2)}` : "",
                        c.sqft ? `${c.sqft.toLocaleString()} sf` : "",
                        c.saleDate ? c.saleDate.slice(0, 7) : "",
                        c.distance != null ? `${c.distance} mi` : "",
                      ].filter(Boolean).join(" · ")}
                    </span>
                    <span className="whitespace-nowrap font-semibold tabular-nums">{fmtMoney(c.price)}</span>
                  </label>
                  <select
                    value={grades[c.id]?.condition || ""}
                    onChange={(e) => setCondition(c.id, e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    title={grades[c.id]?.note
                      ? `${grades[c.id].note}${grades[c.id].confidence ? ` (${grades[c.id].confidence} confidence${grades[c.id].source === "ai" ? ", AI" : ""})` : ""}`
                      : "Condition at sale — set manually or use Grade condition (AI)"}
                    className={`shrink-0 cursor-pointer appearance-none rounded-full border-0 px-2 py-0.5 text-[11px] font-semibold focus:outline-none ${COND_CLS[grades[c.id]?.condition || ""]}`}>
                    <option value="">cond?</option>
                    {CONDITIONS.map((k) => <option key={k} value={k}>{COND_LABELS[k]}</option>)}
                  </select>
                  <a href={zillowUrl(c.address)} target="_blank" rel="noreferrer" title="Open on Zillow (photos)"
                    className="shrink-0 rounded p-1 text-gray-400 hover:bg-blue-50 hover:text-blue-700">
                    <ExternalLink size={14} />
                  </a>
                </div>
              ))}
              {manual.map((c) => (
                <div key={c.id} className="flex items-center gap-2 rounded-lg bg-blue-50/60 px-2 py-1.5 text-sm">
                  <span className="min-w-0 flex-1 truncate">{c.address}</span>
                  <span className="whitespace-nowrap text-xs text-gray-500">{c.sqft ? `${c.sqft.toLocaleString()} sf · ` : ""}manual</span>
                  <span className="whitespace-nowrap font-semibold tabular-nums">{fmtMoney(c.price)}</span>
                  <select
                    value={condOf(c)}
                    onChange={(e) => setCondition(c.id, e.target.value)}
                    title="Condition at sale — manual comps count as renovated unless demoted"
                    className={`shrink-0 cursor-pointer appearance-none rounded-full border-0 px-2 py-0.5 text-[11px] font-semibold focus:outline-none ${COND_CLS[condOf(c)]}`}>
                    {CONDITIONS.map((k) => <option key={k} value={k}>{COND_LABELS[k]}</option>)}
                  </select>
                  <button type="button" onClick={() => setManual((m) => m.filter((x) => x.id !== c.id))}
                    className="rounded p-0.5 text-gray-400 hover:text-red-600"><X size={13} /></button>
                </div>
              ))}
            </div>

            <div className="mt-2 flex items-center gap-2">
              <input className={INPUT_CLS} placeholder="Comp label (optional)" value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
              <input className="w-28 rounded-lg border border-gray-300 px-2 py-2 text-sm focus:outline-none" placeholder="Price"
                inputMode="numeric" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} />
              <input className="w-20 rounded-lg border border-gray-300 px-2 py-2 text-sm focus:outline-none" placeholder="Sqft"
                inputMode="numeric" value={draft.sqft} onChange={(e) => setDraft({ ...draft, sqft: e.target.value })} />
              <button type="button" onClick={addManual}
                className="rounded-lg border border-gray-300 p-2 text-gray-600 hover:bg-gray-50" title="Add manual comp">
                <Plus size={15} />
              </button>
            </div>

            {suggestion && (
              <div className="mt-3 rounded-lg border border-gray-200 p-2.5">
                <div className="mb-1.5 flex items-baseline justify-between">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">ARV adjustments</span>
                  <span className="text-[11px] text-gray-400">site/location detractors — % of base ARV</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {ADJ_PRESETS.map((p) => {
                    const active = adjustments.some((a) => a.key === p.key);
                    return (
                      <button key={p.key} type="button" onClick={() => toggleAdjustment(p)}
                        className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
                          active ? "bg-gray-900 text-white" : "border border-gray-300 text-gray-600 hover:bg-gray-100"
                        }`}>
                        {p.label} {p.pct}%
                      </button>
                    );
                  })}
                </div>
                {adjustments.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {adjustments.map((a) => (
                      <div key={a.key} className="flex items-center gap-2 text-xs">
                        <span className="min-w-0 flex-1 truncate text-gray-700">{a.label}</span>
                        <input
                          className="w-14 rounded border border-gray-300 px-1.5 py-0.5 text-right text-xs tabular-nums focus:border-gray-900 focus:outline-none"
                          inputMode="decimal" value={a.pct}
                          onChange={(e) => setAdjPct(a.key, e.target.value.replace(/[^\d.+-]/g, ""))}
                        />
                        <span className="text-gray-500">%</span>
                        <button type="button" onClick={() => removeAdjustment(a.key)}
                          className="rounded p-0.5 text-gray-400 hover:text-red-600"><X size={12} /></button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-2 flex items-center gap-2">
                  <input className="min-w-0 flex-1 rounded-lg border border-gray-300 px-2 py-1.5 text-xs focus:border-gray-900 focus:outline-none"
                    placeholder="Custom (e.g. Territorial view)" value={adjDraft.label}
                    onChange={(e) => setAdjDraft({ ...adjDraft, label: e.target.value })} />
                  <input className="w-16 rounded-lg border border-gray-300 px-2 py-1.5 text-right text-xs focus:border-gray-900 focus:outline-none"
                    placeholder="+/−%" inputMode="decimal" value={adjDraft.pct}
                    onChange={(e) => setAdjDraft({ ...adjDraft, pct: e.target.value.replace(/[^\d.+-]/g, "") })} />
                  <button type="button" onClick={addCustomAdjustment}
                    className="rounded-lg border border-gray-300 p-1.5 text-gray-600 hover:bg-gray-50" title="Add custom adjustment">
                    <Plus size={13} />
                  </button>
                </div>
              </div>
            )}

            {suggestion && (
              <div className="mt-3 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2.5">
                {suggestion.adjustments.length > 0 && (
                  <div className="mb-1.5 space-y-0.5 border-b border-emerald-200 pb-1.5 text-xs">
                    <div className="flex justify-between text-emerald-800">
                      <span>Base ARV ({suggestion.basis.split(";")[0]})</span>
                      <span className="font-semibold tabular-nums">{fmtMoney(suggestion.base)}</span>
                    </div>
                    {suggestion.adjustments.map((a) => {
                      const amt = Math.round((suggestion.base * a.pct) / 100);
                      return (
                        <div key={a.key} className="flex justify-between">
                          <span className="text-gray-600">{a.label} ({a.pct > 0 ? "+" : "−"}{Math.abs(a.pct)}%)</span>
                          <span className={`font-medium tabular-nums ${amt < 0 ? "text-red-600" : "text-emerald-700"}`}>
                            {amt < 0 ? "−" : "+"}{fmtMoney(Math.abs(amt))}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs text-emerald-800">
                      {suggestion.adjustments.length
                        ? `Adjusted ARV (${suggestion.totalPct > 0 ? "+" : "−"}${Math.abs(suggestion.totalPct)}%)`
                        : `Suggested ARV (${suggestion.basis}${suggestion.ppsf ? ` @ ${fmtMoney(suggestion.ppsf)}/sqft` : ""})`}
                    </div>
                    <div className="text-lg font-black text-emerald-900">{fmtMoney(suggestion.arv)}</div>
                  </div>
                  <button type="button" onClick={() => onUseArv(suggestion.arv)}
                    className="rounded-lg bg-emerald-700 px-3.5 py-2 text-sm font-semibold text-white hover:bg-emerald-800">
                    Use as ARV
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {!state && !error && (
        <p className="text-xs text-gray-400">
          Enter the property address above, then load comps to see closed sales around the subject on a map
          (same beds/baths/county, similar sqft) and derive the ARV. Automatic comps use RealEstateAPI.com
          (key in Settings); manual comps always work.
        </p>
      )}
    </div>
  );
}
