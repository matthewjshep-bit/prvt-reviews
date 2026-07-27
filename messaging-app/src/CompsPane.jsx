// CompsPane.jsx — comps map for the New Offer page. Centers on the subject
// property (OSM/Leaflet), pulls nearby comps from RentCast when an API key is
// configured in Settings, lets the user tick the comps that are truly
// comparable (or add manual ones), and turns the selection into a suggested
// ARV (avg $/sqft × subject sqft, else median price) with one click to apply.

import React, { useMemo, useState } from "react";
import { MapContainer, TileLayer, CircleMarker, Tooltip } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { Loader2, MapPin, Plus, X } from "lucide-react";
import { fmtMoney } from "@shared/offer-calc.js";
import { geocode, getComps } from "./api.js";

const INPUT_CLS =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none";

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export default function CompsPane({ address, onUseArv, sqft: subjectSqft, setSqft: setSubjectSqft, onSubjectInfo }) {
  const [state, setState] = useState(null); // { subject:{lat,lng}, info, comps, estimate, enabled }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [manual, setManual] = useState([]);
  const [draft, setDraft] = useState({ label: "", price: "", sqft: "" });
    const [months, setMonths] = useState(12);

  const parse = (v) => Number(String(v).replace(/[^\d.]/g, "")) || 0;

  async function load() {
    if (!address?.trim()) { setError("Enter the property address first."); return; }
    setLoading(true); setError("");
    try {
      const [geo, comps] = await Promise.all([
        geocode(address.trim()).catch(() => null),
        getComps(address.trim(), { sqft: parse(subjectSqft) || undefined, months }),
      ]);
      // Prefer the data provider's subject coordinates; fall back to geocode.
      const center = comps.subject?.lat
        ? { lat: comps.subject.lat, lng: comps.subject.lng }
        : geo;
      if (!center) throw new Error("couldn't locate that address on the map");
      setState({ subject: center, info: comps.subject || null, ...comps });
      if (comps.subject) onSubjectInfo?.(comps.subject);
      // The subject's recorded sqft powers the $/sqft math if none was typed.
      if (!parse(subjectSqft) && comps.subject?.sqft) {
        setSubjectSqft(String(comps.subject.sqft));
      }
      // Preselect the closest comps (max 6).
      const pre = (comps.comps || [])
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

  const picked = useMemo(() => {
    const auto = (state?.comps || []).filter((c) => selected.has(c.id));
    return [...auto, ...manual];
  }, [state, selected, manual]);

  const suggestion = useMemo(() => {
    if (!picked.length) return null;
    const withSqft = picked.filter((c) => c.sqft > 0);
    const sqft = parse(subjectSqft);
    if (sqft > 0 && withSqft.length) {
      const ppsf = withSqft.reduce((t, c) => t + c.price / c.sqft, 0) / withSqft.length;
      return { arv: Math.round((ppsf * sqft) / 1000) * 1000, ppsf: Math.round(ppsf), basis: `${withSqft.length} comps × ${sqft.toLocaleString()} sqft` };
    }
    return { arv: Math.round(median(picked.map((c) => c.price)) / 1000) * 1000, ppsf: null, basis: `median of ${picked.length} comps` };
  }, [picked, subjectSqft]);

  function addManual() {
    const price = parse(draft.price);
    if (!price) return;
    setManual((m) => [...m, { id: `manual-${Date.now()}`, address: draft.label || "Manual comp", price, sqft: parse(draft.sqft), manual: true }]);
    setDraft({ label: "", price: "", sqft: "" });
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold">Comps &amp; ARV</h2>
        <div className="flex items-center gap-2">
          <select value={months} onChange={(e) => setMonths(Number(e.target.value))}
            className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm focus:border-gray-900 focus:outline-none">
            <option value={6}>Sold ≤ 6 mo</option>
            <option value={9}>Sold ≤ 9 mo</option>
            <option value={12}>Sold ≤ 12 mo</option>
          </select>
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
      {state?.info && (
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
            {state.estimate && (
              <div className="mb-2 rounded-lg bg-gray-100 px-3 py-2 text-xs text-gray-700">
                AVM estimate: <b>{fmtMoney(state.estimate.price)}</b>
                {state.estimate.low ? <> (range {fmtMoney(state.estimate.low)} – {fmtMoney(state.estimate.high)})</> : null}
              </div>
            )}
            <div className="max-h-56 flex-1 space-y-1 overflow-y-auto pr-1">
              {(state.comps || []).map((c) => (
                <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-gray-50">
                  <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                  <span className="min-w-0 flex-1 truncate">{c.address}</span>
                  <span className="whitespace-nowrap text-xs text-gray-500">
                    {[
                      c.beds != null ? `${c.beds}/${c.baths ?? "?"}` : "",
                      c.sqft ? `${c.sqft.toLocaleString()} sf` : "",
                      c.saleDate ? c.saleDate.slice(0, 7) : "",
                      c.distance != null ? `${c.distance} mi` : "",
                    ].filter(Boolean).join(" · ")}
                  </span>
                  <span className="whitespace-nowrap font-semibold tabular-nums">{fmtMoney(c.price)}</span>
                </label>
              ))}
              {manual.map((c) => (
                <div key={c.id} className="flex items-center gap-2 rounded-lg bg-blue-50/60 px-2 py-1.5 text-sm">
                  <span className="min-w-0 flex-1 truncate">{c.address}</span>
                  <span className="whitespace-nowrap text-xs text-gray-500">{c.sqft ? `${c.sqft.toLocaleString()} sf · ` : ""}manual</span>
                  <span className="whitespace-nowrap font-semibold tabular-nums">{fmtMoney(c.price)}</span>
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
              <div className="mt-3 flex items-center justify-between rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2.5">
                <div>
                  <div className="text-xs text-emerald-800">
                    Suggested ARV ({suggestion.basis}{suggestion.ppsf ? ` @ ${fmtMoney(suggestion.ppsf)}/sqft` : ""})
                  </div>
                  <div className="text-lg font-black text-emerald-900">{fmtMoney(suggestion.arv)}</div>
                </div>
                <button type="button" onClick={() => onUseArv(suggestion.arv)}
                  className="rounded-lg bg-emerald-700 px-3.5 py-2 text-sm font-semibold text-white hover:bg-emerald-800">
                  Use as ARV
                </button>
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
