// RehabPane.jsx — quick scope-of-work rehab estimator for the New Offer page.
// Tick what the listing shows (kitchen, floors, roof…), tweak unit costs
// inline, and apply the total to the Estimated Repairs field. Per-sqft items
// price off the subject sqft (shared with the comps pane). The applied scope
// is saved on the offer and included in the GHL contact note.

import React, { useMemo, useState } from "react";
import { Hammer, Plus, X } from "lucide-react";
import { fmtMoney } from "@shared/offer-calc.js";

// mode: "flat" ($ once) | "qty" ($ × count) | "sqft" ($ × subject sqft)
const CATALOG = [
  { group: "Kitchen", items: [
    { id: "kit-cab", label: "Cabinets & countertops", mode: "flat", unit: 12000 },
    { id: "kit-appl", label: "Appliance package", mode: "flat", unit: 4500 },
    { id: "kit-floor", label: "Kitchen flooring", mode: "flat", unit: 1500 },
    { id: "kit-gut", label: "Full kitchen gut remodel", mode: "flat", unit: 25000 },
  ]},
  { group: "Bathrooms", items: [
    { id: "bath-full", label: "Full bath remodel", mode: "qty", unit: 8000 },
    { id: "bath-light", label: "Bath refresh (vanity/fixtures)", mode: "qty", unit: 1800 },
  ]},
  { group: "Interior", items: [
    { id: "paint-int", label: "Interior paint", mode: "sqft", unit: 3 },
    { id: "lvp", label: "LVP flooring throughout", mode: "sqft", unit: 6 },
    { id: "carpet", label: "Carpet (bedrooms)", mode: "flat", unit: 3000 },
    { id: "drywall", label: "Drywall / wall repairs", mode: "flat", unit: 2000 },
    { id: "doors", label: "Interior doors & trim", mode: "flat", unit: 2500 },
  ]},
  { group: "Systems", items: [
    { id: "roof", label: "Roof replacement", mode: "flat", unit: 12000 },
    { id: "hvac", label: "HVAC / furnace", mode: "flat", unit: 8000 },
    { id: "wh", label: "Water heater", mode: "flat", unit: 1800 },
    { id: "elec", label: "Electrical panel / updates", mode: "flat", unit: 4000 },
    { id: "plumb", label: "Plumbing updates", mode: "flat", unit: 5000 },
    { id: "windows", label: "Windows", mode: "qty", unit: 650 },
  ]},
  { group: "Exterior", items: [
    { id: "paint-ext", label: "Exterior paint", mode: "flat", unit: 6000 },
    { id: "siding", label: "Siding repair", mode: "flat", unit: 4000 },
    { id: "landscape", label: "Yard cleanup & landscaping", mode: "flat", unit: 2500 },
    { id: "deck", label: "Deck / fence repair", mode: "flat", unit: 3500 },
  ]},
  { group: "Other", items: [
    { id: "junk", label: "Junk-out / cleanout", mode: "flat", unit: 1500 },
    { id: "found", label: "Foundation repair", mode: "flat", unit: 10000 },
  ]},
];

const ALL_ITEMS = CATALOG.flatMap((g) => g.items);
const parse = (v) => Number(String(v).replace(/[^\d.]/g, "")) || 0;

export default function RehabPane({ sqft, onApply }) {
  // per-item state: { on, unit, qty }
  const [rows, setRows] = useState(() =>
    Object.fromEntries(ALL_ITEMS.map((i) => [i.id, { on: false, unit: i.unit, qty: 1 }]))
  );
  const [custom, setCustom] = useState([]);
  const [draft, setDraft] = useState({ label: "", cost: "" });
  const [contingency, setContingency] = useState("10");
  const [applied, setApplied] = useState(false);

  const sqftNum = parse(sqft);

  const patch = (id, p) => { setApplied(false); setRows((r) => ({ ...r, [id]: { ...r[id], ...p } })); };

  const lineCost = (item, row) => {
    if (item.mode === "sqft") return row.unit * sqftNum;
    if (item.mode === "qty") return row.unit * (parse(row.qty) || 1);
    return row.unit;
  };

  const { lines, subtotal, total } = useMemo(() => {
    const lines = [];
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
  }, [rows, custom, contingency, sqftNum]);

  function addCustom() {
    const cost = parse(draft.cost);
    if (!cost || !draft.label.trim()) return;
    setApplied(false);
    setCustom((c) => [...c, { id: `c-${Date.now()}`, label: draft.label.trim(), cost }]);
    setDraft({ label: "", cost: "" });
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold">Rehab estimate — scope of work</h2>
        <div className="text-xs text-gray-400">
          {sqftNum ? `per-sqft items use ${sqftNum.toLocaleString()} sqft` : "load comps (or enter sqft there) to price per-sqft items"}
        </div>
      </div>

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
          placeholder="Custom item (e.g. sewer line)" value={draft.label}
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
