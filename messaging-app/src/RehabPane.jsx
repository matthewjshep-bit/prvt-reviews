// RehabPane.jsx — room-aware scope-of-work rehab estimator for the New Offer
// page. Bedroom and bathroom rows are generated from the subject record
// pulled by "Load comps" (editable counts), each with a tier dropdown;
// kitchen / living / systems / exterior are checklists with editable costs.
// Per-sqft items price off the subject sqft. One click applies the total to
// Estimated Repairs; the applied scope is saved on the offer and written into
// the GHL contact note.

import React, { useEffect, useMemo, useState } from "react";
import { Hammer, Plus, X } from "lucide-react";
import { fmtMoney } from "@shared/offer-calc.js";

// mode: "flat" ($ once) | "qty" ($ × count) | "sqft" ($ × subject sqft)
const CATALOG = [
  { group: "Kitchen", items: [
    { id: "kit-reface", label: "Cabinet paint / reface", mode: "flat", unit: 3000 },
    { id: "kit-cab", label: "New cabinets & countertops", mode: "flat", unit: 12000 },
    { id: "kit-counter", label: "Countertops only", mode: "flat", unit: 3500 },
    { id: "kit-appl", label: "Appliance package", mode: "flat", unit: 4500 },
    { id: "kit-sink", label: "Sink & faucet", mode: "flat", unit: 600 },
    { id: "kit-bs", label: "Backsplash", mode: "flat", unit: 800 },
    { id: "kit-floor", label: "Kitchen flooring", mode: "flat", unit: 1500 },
    { id: "kit-gut", label: "Full kitchen gut remodel", mode: "flat", unit: 25000 },
  ]},
  { group: "Living areas & interior", items: [
    { id: "paint-int", label: "Interior paint (whole house)", mode: "sqft", unit: 3 },
    { id: "lvp", label: "LVP flooring throughout", mode: "sqft", unit: 6 },
    { id: "living", label: "Living / dining refresh", mode: "flat", unit: 1500 },
    { id: "fireplace", label: "Fireplace refacing", mode: "flat", unit: 1200 },
    { id: "popcorn", label: "Popcorn ceiling removal", mode: "sqft", unit: 2 },
    { id: "drywall", label: "Drywall / wall repairs", mode: "flat", unit: 2000 },
    { id: "doors", label: "Interior doors & trim", mode: "flat", unit: 2500 },
    { id: "fixtures", label: "Light fixtures & hardware", mode: "flat", unit: 1200 },
    { id: "blinds", label: "Blinds / window coverings", mode: "flat", unit: 800 },
  ]},
  { group: "Systems", items: [
    { id: "roof", label: "Roof replacement", mode: "flat", unit: 12000 },
    { id: "hvac", label: "HVAC / furnace", mode: "flat", unit: 8000 },
    { id: "wh", label: "Water heater", mode: "flat", unit: 1800 },
    { id: "elec", label: "Electrical panel / updates", mode: "flat", unit: 4000 },
    { id: "plumb", label: "Plumbing updates", mode: "flat", unit: 5000 },
    { id: "sewer", label: "Sewer line repair", mode: "flat", unit: 8000 },
    { id: "insul", label: "Insulation / attic", mode: "flat", unit: 1500 },
    { id: "windows", label: "Windows", mode: "qty", unit: 650 },
  ]},
  { group: "Exterior", items: [
    { id: "paint-ext", label: "Exterior paint", mode: "flat", unit: 6000 },
    { id: "siding", label: "Siding repair", mode: "flat", unit: 4000 },
    { id: "gutters", label: "Gutters", mode: "flat", unit: 900 },
    { id: "landscape", label: "Yard cleanup & landscaping", mode: "flat", unit: 2500 },
    { id: "deck", label: "Deck / fence repair", mode: "flat", unit: 3500 },
    { id: "concrete", label: "Driveway / concrete", mode: "flat", unit: 2500 },
    { id: "garage", label: "Garage door", mode: "flat", unit: 1200 },
  ]},
  { group: "Other", items: [
    { id: "junk", label: "Junk-out / cleanout", mode: "flat", unit: 1500 },
    { id: "pest", label: "Pest / dry-rot repair", mode: "flat", unit: 3000 },
    { id: "found", label: "Foundation repair", mode: "flat", unit: 10000 },
    { id: "permits", label: "Permits & misc", mode: "flat", unit: 1500 },
  ]},
];

const BED_TIERS = [
  { id: "none", label: "No work", unit: 0 },
  { id: "refresh", label: "Refresh (paint + carpet)", unit: 900 },
  { id: "full", label: "Full redo (floor/paint/closet/door)", unit: 2200 },
];
const BATH_TIERS = [
  { id: "none", label: "No work", unit: 0 },
  { id: "refresh", label: "Refresh (vanity/toilet/fixtures)", unit: 1800 },
  { id: "mid", label: "Mid remodel (surround/tile/vanity)", unit: 8000 },
  { id: "gut", label: "Full gut", unit: 12000 },
];

const ALL_ITEMS = CATALOG.flatMap((g) => g.items);
const parse = (v) => Number(String(v).replace(/[^\d.]/g, "")) || 0;

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
        className="min-w-0 flex-1 rounded border border-gray-300 px-1.5 py-1 text-xs focus:outline-none"
      >
        {tiers.map((t) => (
          <option key={t.id} value={t.id}>{t.label}{t.unit ? ` — $${t.unit.toLocaleString()}` : ""}</option>
        ))}
      </select>
      {room.tier !== "none" && (
        <div className="flex items-center text-xs text-gray-500">
          $<input className="w-14 rounded border border-gray-300 px-1 py-0.5 text-right text-xs tabular-nums"
            value={room.unit} onChange={(e) => onChange({ ...room, unit: parse(e.target.value) })} />
        </div>
      )}
    </div>
  );
}

export default function RehabPane({ sqft, beds, baths, onApply, initialState, onStateChange }) {
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

  // Report state upward so drafts can snapshot the whole scope.
  useEffect(() => {
    onStateChange?.({ rows, bedCount, bathCount, bedRooms, bathRooms, custom, contingency });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, bedCount, bathCount, bedRooms, bathRooms, custom, contingency]);

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
    <input className="w-10 rounded border border-gray-300 px-1 py-0.5 text-center text-xs" inputMode="numeric"
      value={v} onChange={onChange} />
  );

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold">Rehab estimate — scope of work</h2>
        <div className="flex items-center gap-3 text-xs text-gray-500">
          <span className="flex items-center gap-1">Beds {countInput(bedCount, setCount("bed"))}</span>
          <span className="flex items-center gap-1">Baths {countInput(bathCount, setCount("bath"))}</span>
          <span className="text-gray-400">
            {sqftNum ? `${sqftNum.toLocaleString()} sqft` : "load comps for sqft + bed/bath counts"}
          </span>
        </div>
      </div>

      {(bedCount > 0 || bathCount > 0) && (
        <div className="mb-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {bathCount > 0 && (
            <div>
              <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-gray-400">Bathrooms</div>
              {bathRooms.map((room, i) => (
                <RoomRow key={i} label={`Bathroom ${i + 1}`} tiers={BATH_TIERS} room={room}
                  onChange={(r) => { setApplied(false); setBathRooms((rs) => rs.map((x, j) => (j === i ? r : x))); }} />
              ))}
            </div>
          )}
          {bedCount > 0 && (
            <div>
              <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-gray-400">Bedrooms</div>
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
            <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-gray-400">{g.group}</div>
            {g.items.map((item) => {
              const row = rows[item.id];
              return (
                <div key={item.id} className={`flex items-center gap-2 rounded-lg px-1.5 py-1 text-sm ${row.on ? "bg-amber-50" : ""}`}>
                  <input type="checkbox" checked={row.on} onChange={(e) => patch(item.id, { on: e.target.checked })} />
                  <span className="min-w-0 flex-1 truncate" title={item.label}>{item.label}</span>
                  {item.mode === "qty" && row.on && (
                    <input className="w-10 rounded border border-gray-300 px-1 py-0.5 text-center text-xs"
                      value={row.qty} onChange={(e) => patch(item.id, { qty: e.target.value.replace(/[^\d]/g, "") })} />
                  )}
                  <div className="flex items-center text-xs text-gray-500">
                    $<input
                      className="w-14 rounded border border-gray-300 px-1 py-0.5 text-right text-xs tabular-nums"
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

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
        <input className="w-56 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-gray-900 focus:outline-none"
          placeholder="Custom item (e.g. retaining wall)" value={draft.label}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
        <input className="w-24 rounded-lg border border-gray-300 px-2 py-1.5 text-sm focus:outline-none" placeholder="Cost"
          inputMode="numeric" value={draft.cost} onChange={(e) => setDraft({ ...draft, cost: e.target.value })} />
        <button type="button" onClick={addCustom}
          className="rounded-lg border border-gray-300 p-1.5 text-gray-600 hover:bg-gray-50" title="Add custom item">
          <Plus size={15} />
        </button>
        {custom.map((c) => (
          <span key={c.id} className="flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-1 text-xs">
            {c.label} · {fmtMoney(c.cost)}
            <button type="button" onClick={() => { setApplied(false); setCustom((x) => x.filter((y) => y.id !== c.id)); }}
              className="text-gray-400 hover:text-red-600"><X size={12} /></button>
          </span>
        ))}
      </div>

      {lines.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5">
          <div className="text-sm">
            <span className="text-gray-600">{lines.length} item{lines.length > 1 ? "s" : ""} · subtotal {fmtMoney(subtotal)} +</span>{" "}
            <input className="w-10 rounded border border-gray-300 px-1 py-0.5 text-center text-xs" value={contingency}
              onChange={(e) => { setApplied(false); setContingency(e.target.value.replace(/[^\d]/g, "")); }} />
            <span className="text-gray-600">% contingency =</span>{" "}
            <span className="text-lg font-black">{fmtMoney(total)}</span>
          </div>
          <button type="button" onClick={() => { onApply(total, lines); setApplied(true); }}
            className={`flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold text-white ${applied ? "bg-emerald-700" : "bg-gray-900 hover:bg-gray-800"}`}>
            <Hammer size={14} /> {applied ? "Applied ✓" : "Use as repairs estimate"}
          </button>
        </div>
      )}
    </div>
  );
}
