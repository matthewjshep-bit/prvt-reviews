// RehabPane.jsx — room-aware scope-of-work rehab estimator for the New Offer
// page. Bedroom and bathroom rows are generated from the subject record
// pulled by "Load comps" (editable counts), each with a tier dropdown;
// kitchen / living / systems / exterior are checklists with editable costs.
// Per-sqft items price off the subject sqft. One click applies the total to
// Estimated Repairs; the applied scope is saved on the offer and written into
// the GHL contact note.

import React, { useEffect, useMemo, useState } from "react";
import { Hammer, Loader2, Plus, Sparkles, X } from "lucide-react";
import { fmtMoney } from "@shared/offer-calc.js";
import {
  REHAB_CATALOG as CATALOG_SHARED, BED_TIERS as BED_TIERS_SHARED,
  BATH_TIERS as BATH_TIERS_SHARED, ALL_REHAB_ITEMS,
  lineCost as sharedLineCost, rehabBand, bandMidpoint, REHAB_LEVELS,
} from "@shared/rehab-catalog.js";
// The checklist's state shape, what a scan does to it, and what it costs. Lives
// in shared/ because the auto-underwrite pipeline runs the same scan on the
// server — if the pane priced a scope its own way the offer and the scope-of-
// work PDF could disagree about the repair number.
import {
  blankRehabState, applyScanSuggestion, priceScope, resizeRooms,
} from "@shared/rehab-scope.js";
import { scanRehab } from "./api.js";
import { downscale } from "./image.js";

const CATALOG = CATALOG_SHARED;
const BED_TIERS = BED_TIERS_SHARED;
const BATH_TIERS = BATH_TIERS_SHARED;
const ALL_ITEMS = ALL_REHAB_ITEMS;

const parse = (v) => Number(String(v).replace(/[^\d.]/g, "")) || 0;

// Downscale an uploaded photo client-side (max 1400px, JPEG) so a batch of
// listing photos stays a few MB. Shared with the dataroom's photo upload.
const fileToDataUrl = async (file, maxDim = 1400) =>
  (await downscale(file, maxDim, 0.8)).dataUrl;

function RoomRow({ label, tiers, room, onChange }) {
  const tier = tiers.find((t) => t.id === room.tier) || tiers[0];
  return (
    <div className={`flex items-center gap-2 rounded-lg px-1.5 py-1 text-sm ${room.tier !== "none" ? "bg-amber-50" : ""}`}>
      <span className="w-24 shrink-0 font-medium">{label}</span>
      <select
        value={room.tier}
        onChange={(e) => {
          const t = tiers.find((x) => x.id === e.target.value);
          onChange({ tier: t.id, unit: t.unit });
        }}
        className="min-w-0 flex-1 rounded border border-slate-300 px-1.5 py-1 text-xs focus:outline-none"
      >
        {tiers.map((t) => (
          <option key={t.id} value={t.id}>{t.label}{t.unit ? ` — $${t.unit.toLocaleString()}` : ""}</option>
        ))}
      </select>
      {room.tier !== "none" && (
        <div className="flex items-center text-xs text-slate-500">
          $<input className="w-14 rounded border border-slate-300 px-1 py-0.5 text-right text-xs tabular-nums"
            value={room.unit} onChange={(e) => onChange({ ...room, unit: parse(e.target.value) })} />
        </div>
      )}
    </div>
  );
}

// Area-by-area condition grades from the AI scan (chips + SOW notes page).
const AREA_LABELS = {
  roof: "Roof", exterior: "Exterior", kitchen: "Kitchen", bathrooms: "Bathrooms",
  flooring: "Flooring", paint_walls: "Paint/Walls", windows: "Windows", hvac: "HVAC",
  plumbing: "Plumbing", electrical: "Electrical", yard: "Yard", foundation_structure: "Foundation",
};
const AREA_GRADE_CLS = {
  good: "bg-emerald-100 text-emerald-800",
  fair: "bg-blue-100 text-blue-800",
  dated: "bg-amber-100 text-amber-800",
  poor: "bg-red-100 text-red-700",
  not_visible: "bg-slate-100 text-slate-500",
};

export default function RehabPane({ sqft, beds, baths, yearBuilt, address, onApply, initialState, onStateChange }) {
  const [rows, setRows] = useState(() => ({
    ...blankRehabState().rows,
    ...(initialState?.rows || {}),
  }));
  const [bedCount, setBedCount] = useState(initialState?.bedCount || 0);
  const [bathCount, setBathCount] = useState(initialState?.bathCount || 0);
  const [bedRooms, setBedRooms] = useState(initialState?.bedRooms || []);
  const [bathRooms, setBathRooms] = useState(initialState?.bathRooms || []);
  const [custom, setCustom] = useState(initialState?.custom || []);
  const [draft, setDraft] = useState({ label: "", cost: "" });
  const [contingency, setContingency] = useState(initialState?.contingency ?? "10");
  // Quick-bucket override: a level id from the cheat sheet plus the dollar
  // figure it seeded (editable). Null means the itemized total drives the offer.
  const [bucket, setBucket] = useState(initialState?.bucket ?? null);
  const [bucketAmount, setBucketAmount] = useState(initialState?.bucketAmount ?? "");
  const [applied, setApplied] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const [aiResult, setAiResult] = useState(initialState?.aiResult || null);

  // AI scan: MLS photos (or user-uploaded photos) → suggested scope, applied
  // onto the checklist for review.
  async function doScan(files) {
    if (!address?.trim()) { setScanError("Enter the property address first."); return; }
    setScanning(true); setScanError("");
    try {
      let images;
      if (files?.length) {
        images = await Promise.all([...files].slice(0, 40).map((f) => fileToDataUrl(f)));
      }
      const r = await scanRehab(address.trim(), {
        beds: bedCount || undefined, baths: bathCount || undefined, sqft: parse(sqft) || undefined,
        yearBuilt: yearBuilt || undefined,
        images,
      });
      setApplied(false);
      // One shared reducer decides what a scan does to the checklist: tick the
      // suggested items (never untick), set room tiers in photo order, expand
      // the room counts if the photos show more rooms than the county record
      // claims, and append the custom lines. Fanned back out into the pane's
      // individual pieces of state below.
      const next = applyScanSuggestion(
        { rows, bedCount, bathCount, bedRooms, bathRooms, custom, contingency, bucket, bucketAmount, aiResult },
        r.suggestion,
        { photosAnalyzed: r.photosAnalyzed },
      );
      setRows(next.rows);
      setBathCount(next.bathCount);
      setBathRooms(next.bathRooms);
      setBedCount(next.bedCount);
      setBedRooms(next.bedRooms);
      setCustom(next.custom);
      setAiResult(next.aiResult);
    } catch (e) { setScanError(e.message); }
    setScanning(false);
  }

  // Report state upward so drafts/offers can snapshot the whole scope.
  useEffect(() => {
    onStateChange?.({ rows, bedCount, bathCount, bedRooms, bathRooms, custom, contingency, bucket, bucketAmount, aiResult });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, bedCount, bathCount, bedRooms, bathRooms, custom, contingency, bucket, bucketAmount, aiResult]);

  const sqftNum = parse(sqft);
  const fmtTyped = (v) => { const d = String(v).replace(/[^\d]/g, ""); return d ? Number(d).toLocaleString("en-US") : ""; };

  // Subject record from Load Comps drives the room counts (editable after).
  useEffect(() => {
    if (beds > 0) { setBedCount(Math.round(beds)); setBedRooms((r) => resizeRooms(r, Math.round(beds))); }
    if (baths > 0) { const n = Math.ceil(baths); setBathCount(n); setBathRooms((r) => resizeRooms(r, n)); }
  }, [beds, baths]);

  const setCount = (kind) => (e) => {
    const n = Math.max(0, Math.min(10, parse(e.target.value)));
    setApplied(false);
    if (kind === "bed") { setBedCount(n); setBedRooms((r) => resizeRooms(r, n)); }
    else { setBathCount(n); setBathRooms((r) => resizeRooms(r, n)); }
  };

  const patch = (id, p) => { setApplied(false); setRows((r) => ({ ...r, [id]: { ...r[id], ...p } })); };

  // Shared with the catalog so the pane, the scope PDF and the AI prompt can't
  // disagree. Flat costs are priced for a 1,500 sqft house and scaled from
  // there — without that, a 770 sqft cottage was billed the full $6,000 to
  // paint an exterior a third the size.
  const lineCost = (item, row) => sharedLineCost(item, row, sqftNum);

  // The priced scope. Shared with the broker so an auto-underwrite and a
  // hand-built offer can never quote different repair numbers for the same
  // scope — see shared/rehab-scope.js.
  const { lines, subtotal, total } = useMemo(
    () => priceScope({ rows, bedRooms, bathRooms, custom, contingency }, sqftNum),
    [rows, bedRooms, bathRooms, custom, contingency, sqftNum]
  );

  // The cheat-sheet band for this house size (null when sqft is unknown — a
  // guess would anchor the repair number on nothing).
  const band = useMemo(() => rehabBand(sqftNum), [sqftNum]);

  // Which number actually becomes the offer's repair figure.
  const applyAmount = bucket ? (parse(bucketAmount) || 0) : total;

  // Where the itemized total sits against the bands, so a scope that has run
  // away from the cheat sheet says so instead of just looking authoritative.
  const bandCheck = useMemo(() => {
    if (!band || total <= 0) return null;
    if (total <= band.light[1]) return { level: "light", over: false };
    if (total <= band.medium[1]) return { level: "medium", over: false };
    if (total <= band.heavy[1]) return { level: "heavy", over: false };
    return { level: "heavy", over: true };
  }, [band, total]);

  function addCustom() {
    const cost = parse(draft.cost);
    if (!cost || !draft.label.trim()) return;
    setApplied(false);
    setCustom((c) => [...c, { id: `c-${Date.now()}`, label: draft.label.trim(), cost }]);
    setDraft({ label: "", cost: "" });
  }

  const countInput = (v, onChange) => (
    <input className="w-10 rounded border border-slate-300 px-1 py-0.5 text-center text-xs" inputMode="numeric"
      value={v} onChange={onChange} />
  );

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-bold">
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-bold leading-none text-white">4</span>
          Rehab estimate — scope of work
        </h2>
        <div className="flex items-center gap-3 text-xs text-slate-500">
          <span className="flex items-center gap-1">Beds {countInput(bedCount, setCount("bed"))}</span>
          <span className="flex items-center gap-1">Baths {countInput(bathCount, setCount("bath"))}</span>
          <span className="text-slate-400">
            {sqftNum ? `${sqftNum.toLocaleString()} sqft` : "load comps for sqft + bed/bath counts"}
          </span>
          <button type="button" onClick={() => doScan()} disabled={scanning}
            className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40 hover:bg-violet-700"
            title="Analyze the MLS listing photos and pre-fill this scope">
            {scanning ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            {scanning ? "Scanning photos…" : "AI scan MLS photos"}
          </button>
          <label className="cursor-pointer rounded-lg border border-violet-300 px-3 py-1.5 text-xs font-semibold text-violet-700 hover:bg-violet-50"
            title="Upload listing photos (screenshots or saved images) for the AI to analyze">
            or upload photos
            <input type="file" accept="image/*" multiple className="hidden" disabled={scanning}
              onChange={(e) => { if (e.target.files?.length) doScan(e.target.files); e.target.value = ""; }} />
          </label>
        </div>
      </div>

      {scanError && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{scanError}</div>}
      {aiResult && (
        <div className="mb-3 rounded-lg border border-violet-200 bg-violet-50 p-3">
          <div className="mb-1 flex items-center justify-between">
            <div className="text-xs font-bold text-violet-900">
              AI assessment ({aiResult.photosAnalyzed} photos) — review the pre-filled scope below
            </div>
            <button type="button" onClick={() => setAiResult(null)} className="text-violet-400 hover:text-violet-700">
              <X size={14} />
            </button>
          </div>
          <p className="text-sm text-violet-900">{aiResult.summary}</p>
          {(aiResult.areas || []).length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {aiResult.areas.filter((a) => AREA_LABELS[a.area] && AREA_GRADE_CLS[a.grade]).map((a) => (
                <span key={a.area} title={a.note || undefined}
                  className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${AREA_GRADE_CLS[a.grade]}`}>
                  {AREA_LABELS[a.area]}: {a.grade === "not_visible" ? "not visible" : a.grade}
                </span>
              ))}
            </div>
          )}
          {aiResult.notes.length > 0 && (
            <details className="mt-1.5">
              <summary className="cursor-pointer text-xs font-medium text-violet-700">
                Why each item ({aiResult.notes.length})
              </summary>
              <ul className="mt-1 space-y-0.5 text-xs text-violet-800">
                {aiResult.notes.map((n, i) => (
                  <li key={i}><span className="font-semibold">{n.label}:</span> {n.note}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {(bedCount > 0 || bathCount > 0) && (
        <div className="mb-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {bathCount > 0 && (
            <div>
              <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-slate-400">Bathrooms</div>
              {bathRooms.map((room, i) => (
                <RoomRow key={i} label={`Bathroom ${i + 1}`} tiers={BATH_TIERS} room={room}
                  onChange={(r) => { setApplied(false); setBathRooms((rs) => rs.map((x, j) => (j === i ? r : x))); }} />
              ))}
            </div>
          )}
          {bedCount > 0 && (
            <div>
              <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-slate-400">Bedrooms</div>
              {bedRooms.map((room, i) => (
                <RoomRow key={i} label={`Bedroom ${i + 1}`} tiers={BED_TIERS} room={room}
                  onChange={(r) => { setApplied(false); setBedRooms((rs) => rs.map((x, j) => (j === i ? r : x))); }} />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        {CATALOG.map((g) => (
          <div key={g.group}>
            <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-slate-400">{g.group}</div>
            {g.items.map((item) => {
              const row = rows[item.id];
              return (
                <div key={item.id} className={`flex items-center gap-2 rounded-lg px-1.5 py-1 text-sm ${row.on ? "bg-amber-50" : ""}`}>
                  <input type="checkbox" checked={row.on} onChange={(e) => patch(item.id, { on: e.target.checked })} />
                  <span className="min-w-0 flex-1 truncate" title={item.label}>{item.label}</span>
                  {item.mode === "qty" && row.on && (
                    <input className="w-10 rounded border border-slate-300 px-1 py-0.5 text-center text-xs"
                      value={row.qty} onChange={(e) => patch(item.id, { qty: e.target.value.replace(/[^\d]/g, "") })} />
                  )}
                  <div className="flex items-center text-xs text-slate-500">
                    $<input
                      className="w-14 rounded border border-slate-300 px-1 py-0.5 text-right text-xs tabular-nums"
                      value={row.unit}
                      onChange={(e) => patch(item.id, { unit: parse(e.target.value) })}
                    />
                    {item.mode === "sqft" && <span className="ml-0.5">/sf</span>}
                  </div>
                  {row.on && (
                    <span className="w-16 text-right text-xs font-semibold tabular-nums">
                      {fmtMoney(Math.round(lineCost(item, row)))}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
        <input className="w-56 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          placeholder="Custom item (e.g. retaining wall)" value={draft.label}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
        <input className="w-24 rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:outline-none" placeholder="Cost"
          inputMode="numeric" value={draft.cost} onChange={(e) => setDraft({ ...draft, cost: e.target.value })} />
        <button type="button" onClick={addCustom}
          className="rounded-lg border border-slate-300 p-1.5 text-slate-600 hover:bg-slate-50" title="Add custom item">
          <Plus size={15} />
        </button>
        {custom.map((c) => (
          <span key={c.id} className="flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-1 text-xs">
            {c.label} · {fmtMoney(c.cost)}
            <button type="button" onClick={() => { setApplied(false); setCustom((x) => x.filter((y) => y.id !== c.id)); }}
              className="text-slate-400 hover:text-red-600"><X size={12} /></button>
          </span>
        ))}
      </div>

      {/* Quick buckets — the cheat-sheet ranges by house size, for when you
          want a number now rather than a scope. Picking one doesn't disturb the
          itemized work below; clicking it again hands control back. */}
      {band && (
        <div className="mt-3 rounded-lg border border-slate-200 p-2.5">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
              Quick estimate — {band.label}
            </span>
            <span className="text-[11px] text-slate-500">whole-project ranges from your cheat sheet</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {REHAB_LEVELS.map((lv) => {
              const [lo, hi] = band[lv.id];
              const on = bucket === lv.id;
              return (
                <button key={lv.id} type="button"
                  onClick={() => { setApplied(false); setBucket(on ? null : lv.id); setBucketAmount(on ? "" : String(bandMidpoint(sqftNum, lv.id))); }}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                    on ? "bg-blue-600 text-white" : "border border-slate-300 text-slate-700 hover:bg-slate-100"
                  }`}>
                  {lv.label} ${(lo / 1000).toFixed(0)}–{(hi / 1000).toFixed(0)}k{lv.id === "heavy" ? "+" : ""}
                </button>
              );
            })}
            {bucket && (
              <label className="flex items-center gap-1.5 text-xs text-slate-600">
                <span>=</span> $
                <input className="w-24 rounded border border-slate-300 px-1.5 py-1 text-right text-sm font-semibold tabular-nums focus:border-blue-500 focus:outline-none"
                  inputMode="numeric" value={fmtTyped(bucketAmount)}
                  onChange={(e) => { setApplied(false); setBucketAmount(e.target.value.replace(/[^\d]/g, "")); }} />
              </label>
            )}
          </div>
        </div>
      )}

      {(lines.length > 0 || bucket) && (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              {bucket ? (
                <>
                  <span className="text-slate-600">{REHAB_LEVELS.find((l) => l.id === bucket)?.label} rehab · {band.label} =</span>{" "}
                  <span className="text-lg font-black">{fmtMoney(applyAmount)}</span>
                </>
              ) : (
                <>
                  <span className="text-slate-600">{lines.length} item{lines.length > 1 ? "s" : ""} · subtotal {fmtMoney(subtotal)} +</span>{" "}
                  <input className="w-10 rounded border border-slate-300 px-1 py-0.5 text-center text-xs" value={contingency}
                    onChange={(e) => { setApplied(false); setContingency(e.target.value.replace(/[^\d]/g, "")); }} />
                  <span className="text-slate-600">% contingency =</span>{" "}
                  <span className="text-lg font-black">{fmtMoney(total)}</span>
                </>
              )}
            </div>
            <button type="button" onClick={() => { onApply(applyAmount, lines); setApplied(true); }}
              className={`flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold text-white ${applied ? "bg-emerald-700" : "bg-blue-600 hover:bg-blue-700"}`}>
              <Hammer size={14} /> {applied ? "Applied ✓" : "Use as repairs estimate"}
            </button>
          </div>
          {/* Whichever number isn't driving the offer still gets said out loud,
              so the two can never quietly disagree. */}
          {bucket && lines.length > 0 && (
            <div className="mt-1.5 text-[11px] text-slate-600">
              The itemized scope below totals {fmtMoney(total)} and still prints on the scope of work — only the
              number above goes into the offer.
            </div>
          )}
          {!bucket && bandCheck && (
            <div className={`mt-1.5 text-[11px] ${bandCheck.over ? "font-semibold text-amber-800" : "text-slate-600"}`}>
              {bandCheck.over
                ? `Above your ${bandCheck.level} band for ${band.label} (${fmtMoney(band[bandCheck.level][0])}–${fmtMoney(band[bandCheck.level][1])}+) — fine for a true gut, worth a second look otherwise.`
                : `Within your ${bandCheck.level} band for ${band.label}.`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
