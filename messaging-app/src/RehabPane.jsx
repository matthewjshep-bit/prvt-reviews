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
} from "@shared/rehab-catalog.js";
import { scanRehab } from "./api.js";

const CATALOG = CATALOG_SHARED;
const BED_TIERS = BED_TIERS_SHARED;
const BATH_TIERS = BATH_TIERS_SHARED;
const ALL_ITEMS = ALL_REHAB_ITEMS;

const parse = (v) => Number(String(v).replace(/[^\d.]/g, "")) || 0;

// Downscale an uploaded photo client-side (max 1400px, JPEG) so a batch of
// listing photos stays a few MB.
async function fileToDataUrl(file, maxDim = 1400) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.8);
}

const resizeRooms = (rooms, n) => {
  const next = rooms.slice(0, n);
  while (next.length < n) next.push({ tier: "none", unit: 0 });
  return next;
};

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
    ...Object.fromEntries(ALL_ITEMS.map((i) => [i.id, { on: false, unit: i.unit, qty: 1 }])),
    ...(initialState?.rows || {}),
  }));
  const [bedCount, setBedCount] = useState(initialState?.bedCount || 0);
  const [bathCount, setBathCount] = useState(initialState?.bathCount || 0);
  const [bedRooms, setBedRooms] = useState(initialState?.bedRooms || []);
  const [bathRooms, setBathRooms] = useState(initialState?.bathRooms || []);
  const [custom, setCustom] = useState(initialState?.custom || []);
  const [draft, setDraft] = useState({ label: "", cost: "" });
  const [contingency, setContingency] = useState(initialState?.contingency ?? "10");
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
      const s = r.suggestion || {};
      setApplied(false);
      // Tick suggested catalog items
      setRows((prev) => {
        const next = { ...prev };
        for (const it of s.items || []) if (next[it.id]) next[it.id] = { ...next[it.id], on: true };
        return next;
      });
      // Apply bathroom/bedroom tiers in order (expanding counts if photos show more rooms)
      if ((s.bathrooms || []).length) {
        const n = Math.min(10, Math.max(bathCount, s.bathrooms.length));
        setBathCount(n);
        setBathRooms((prev) => resizeRooms(prev, n).map((room, i) => {
          const t = s.bathrooms[i] && BATH_TIERS.find((x) => x.id === s.bathrooms[i].tier);
          return t ? { tier: t.id, unit: t.unit } : room;
        }));
      }
      if ((s.bedrooms || []).length) {
        const n = Math.min(10, Math.max(bedCount, s.bedrooms.length));
        setBedCount(n);
        setBedRooms((prev) => resizeRooms(prev, n).map((room, i) => {
          const t = s.bedrooms[i] && BED_TIERS.find((x) => x.id === s.bedrooms[i].tier);
          return t ? { tier: t.id, unit: t.unit } : room;
        }));
      }
      // Custom items the catalog doesn't cover
      if ((s.custom || []).length) {
        setCustom((c) => [
          ...c,
          ...s.custom.filter((x) => Number(x.cost) > 0)
            .map((x, i) => ({ id: `ai-${Date.now()}-${i}`, label: x.label, cost: Math.round(Number(x.cost)) })),
        ]);
      }
      const labelOf = (id) => ALL_ITEMS.find((i) => i.id === id)?.label || id;
      setAiResult({
        summary: s.summary || "",
        photosAnalyzed: r.photosAnalyzed,
        areas: Array.isArray(s.areas) ? s.areas : [],
        notes: [
          ...(s.items || []).map((it) => ({ label: labelOf(it.id), note: it.note })),
          ...(s.bathrooms || []).map((b, i) => ({ label: `Bathroom ${i + 1} — ${b.tier}`, note: b.note })),
          ...(s.bedrooms || []).map((b, i) => ({ label: `Bedroom ${i + 1} — ${b.tier}`, note: b.note })),
          ...(s.custom || []).map((c) => ({ label: c.label, note: c.note })),
        ].filter((n) => n.note),
      });
    } catch (e) { setScanError(e.message); }
    setScanning(false);
  }

  // Report state upward so drafts/offers can snapshot the whole scope.
  useEffect(() => {
    onStateChange?.({ rows, bedCount, bathCount, bedRooms, bathRooms, custom, contingency, aiResult });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, bedCount, bathCount, bedRooms, bathRooms, custom, contingency, aiResult]);

  const sqftNum = parse(sqft);

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

  const lineCost = (item, row) => {
    if (item.mode === "sqft") return row.unit * sqftNum;
    if (item.mode === "qty") return row.unit * (parse(row.qty) || 1);
    return row.unit;
  };

  const { lines, subtotal, total } = useMemo(() => {
    const lines = [];
    bathRooms.forEach((room, i) => {
      if (room.tier === "none" || room.unit <= 0) return;
      const t = BATH_TIERS.find((x) => x.id === room.tier);
      lines.push({ label: `Bathroom ${i + 1} — ${t?.label.toLowerCase() || room.tier}`, cost: Math.round(room.unit) });
    });
    bedRooms.forEach((room, i) => {
      if (room.tier === "none" || room.unit <= 0) return;
      const t = BED_TIERS.find((x) => x.id === room.tier);
      lines.push({ label: `Bedroom ${i + 1} — ${t?.label.toLowerCase() || room.tier}`, cost: Math.round(room.unit) });
    });
    for (const item of ALL_ITEMS) {
      const row = rows[item.id];
      if (!row.on) continue;
      const cost = Math.round(lineCost(item, row));
      if (cost <= 0) continue;
      const qty = item.mode === "qty" && parse(row.qty) > 1 ? ` ×${parse(row.qty)}` : "";
      lines.push({ label: `${item.label}${qty}`, cost });
    }
    for (const c of custom) lines.push({ label: c.label, cost: c.cost });
    const subtotal = lines.reduce((t, l) => t + l.cost, 0);
    const total = Math.round((subtotal * (1 + (parse(contingency) || 0) / 100)) / 500) * 500;
    return { lines, subtotal, total };
  }, [rows, bedRooms, bathRooms, custom, contingency, sqftNum]);

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

      {lines.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5">
          <div className="text-sm">
            <span className="text-slate-600">{lines.length} item{lines.length > 1 ? "s" : ""} · subtotal {fmtMoney(subtotal)} +</span>{" "}
            <input className="w-10 rounded border border-slate-300 px-1 py-0.5 text-center text-xs" value={contingency}
              onChange={(e) => { setApplied(false); setContingency(e.target.value.replace(/[^\d]/g, "")); }} />
            <span className="text-slate-600">% contingency =</span>{" "}
            <span className="text-lg font-black">{fmtMoney(total)}</span>
          </div>
          <button type="button" onClick={() => { onApply(total, lines); setApplied(true); }}
            className={`flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold text-white ${applied ? "bg-emerald-700" : "bg-blue-600 hover:bg-blue-700"}`}>
            <Hammer size={14} /> {applied ? "Applied ✓" : "Use as repairs estimate"}
          </button>
        </div>
      )}
    </div>
  );
}
