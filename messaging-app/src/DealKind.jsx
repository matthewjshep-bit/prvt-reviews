import React, { useState } from "react";
import { Home } from "lucide-react";
import { ASSET_TYPES, ASSET_TYPE_LABELS, MH_LAND, MH_LAND_LABELS, normalizeAsset } from "@shared/asset-type.js";
import { setOfferAsset } from "./api.js";

/**
 * What kind of house the deal is (shared/asset-type.js): single family,
 * multi-family, or a manufactured home and whether the land comes with it.
 * The waves, the blast text, the buyer package and the bot all read it — a
 * mobile home goes to the buyers who said they buy them. 1510 Maple Lane
 * (2026-10-01) had no kind and went to Kent flippers.
 */
export default function DealKind({ offer, onUpdated }) {
  const saved = normalizeAsset(offer.asset);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(next) {
    setError(""); setBusy(true);
    try {
      const r = await setOfferAsset(offer.id, next);
      if (r?.offer) onUpdated(r.offer);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  const chip = (on) => `rounded-lg border px-2 py-1.5 text-xs font-semibold transition-colors ${on ? "border-blue-600 bg-blue-50 text-blue-900" : "border-slate-300 text-slate-600 hover:border-slate-400"}`;

  return (
    <div className="space-y-2">
      <span className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
        <Home size={13} aria-hidden="true" /> Property type
      </span>
      <div className="space-y-3 rounded-lg border border-slate-200 p-3">
        <div role="radiogroup" aria-label="Property type" className="grid grid-cols-3 gap-1.5">
          {ASSET_TYPES.map((t) => (
            <button key={t} type="button" role="radio" aria-checked={saved?.type === t} disabled={busy}
              className={chip(saved?.type === t)}
              onClick={() => save({ type: t, land: t === "manufactured" ? saved?.land || "" : "" })}>
              {ASSET_TYPE_LABELS[t]}
            </button>
          ))}
        </div>
        {saved?.type === "manufactured" && (
          <div>
            <span className="mb-1 block text-xs text-slate-500">Land</span>
            <div role="radiogroup" aria-label="Land" className="grid grid-cols-2 gap-1.5">
              {MH_LAND.map((l) => (
                <button key={l} type="button" role="radio" aria-checked={saved.land === l} disabled={busy}
                  className={chip(saved.land === l)} onClick={() => save({ type: "manufactured", land: l })}>
                  {MH_LAND_LABELS[l]}
                </button>
              ))}
            </div>
          </div>
        )}
        <p className="text-xs text-slate-500">
          {!saved ? "Not set, and Zillow didn't say. Pick one so the deal reaches the right buyers."
            : saved.by === "underwrite" ? "From Zillow. Pick one to make it yours."
            : saved.type === "manufactured" ? "Goes only to buyers who said they buy mobile homes."
            : "Yours. Waves and the blast text go by it."}
        </p>
        {error && <p className="text-xs text-rose-700">{error}</p>}
      </div>
    </div>
  );
}
