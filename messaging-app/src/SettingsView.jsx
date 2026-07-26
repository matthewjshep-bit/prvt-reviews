// SettingsView.jsx — location-wide calculation defaults and the company info
// printed on every offer document. Saved server-side per location.

import React, { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { DEFAULT_OFFER_SETTINGS, effectiveSettings } from "@shared/offer-calc.js";
import { saveSettings } from "./api.js";

const INPUT_CLS =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none";

function Num({ label, value, onChange, suffix }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">
        {label}{suffix ? ` (${suffix})` : ""}
      </span>
      <input className={INPUT_CLS} inputMode="decimal" value={value}
        onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function Txt({ label, value, onChange, placeholder }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</span>
      <input className={INPUT_CLS} value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export default function SettingsView({ settings, onSaved }) {
  const [form, setForm] = useState(effectiveSettings(settings || {}));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (settings) setForm(effectiveSettings(settings));
  }, [settings]);

  const set = (k) => (v) => { setSaved(false); setForm((f) => ({ ...f, [k]: v })); };
  const setCo = (k) => (v) => { setSaved(false); setForm((f) => ({ ...f, company: { ...f.company, [k]: v } })); };

  async function save() {
    setSaving(true); setError("");
    try {
      // Coerce numerics; anything unparseable falls back to the default.
      const clean = { ...form };
      for (const k of Object.keys(DEFAULT_OFFER_SETTINGS)) {
        if (typeof DEFAULT_OFFER_SETTINGS[k] === "number") {
          const n = Number(clean[k]);
          clean[k] = Number.isFinite(n) ? n : DEFAULT_OFFER_SETTINGS[k];
        }
      }
      const r = await saveSettings(clean);
      onSaved?.(r.settings);
      setForm(effectiveSettings(r.settings));
      setSaved(true);
    } catch (e) { setError(e.message); }
    setSaving(false);
  }

  return (
    <div className="max-w-2xl space-y-5">
      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">Cash offer</h2>
        <div className="grid grid-cols-2 gap-3">
          <Num label="Percent of ARV" suffix="%" value={form.cashPctOfArv} onChange={set("cashPctOfArv")} />
          <Num label="Wholesale / assignment fee" suffix="$" value={form.wholesaleFee} onChange={set("wholesaleFee")} />
          <Num label="Advertised close" suffix="days" value={form.closeDays} onChange={set("closeDays")} />
          <Num label="Offer valid for" suffix="days" value={form.validityDays} onChange={set("validityDays")} />
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">Seller financing</h2>
        <div className="grid grid-cols-2 gap-3">
          <Num label="Price" suffix="% of asking" value={form.sfPricePctOfAsking} onChange={set("sfPricePctOfAsking")} />
          <Num label="Down payment" suffix="%" value={form.sfDownPct} onChange={set("sfDownPct")} />
          <Num label="Interest rate" suffix="%/yr" value={form.sfAnnualRatePct} onChange={set("sfAnnualRatePct")} />
          <Num label="Term" suffix="years" value={form.sfTermYears} onChange={set("sfTermYears")} />
          <Num label="Balloon at" suffix="years, 0 = none" value={form.sfBalloonYears} onChange={set("sfBalloonYears")} />
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">Lease option</h2>
        <div className="grid grid-cols-2 gap-3">
          <Num label="Strike price" suffix="% of asking" value={form.loPricePctOfAsking} onChange={set("loPricePctOfAsking")} />
          <Num label="Option fee" suffix="% of price" value={form.loOptionFeePct} onChange={set("loOptionFeePct")} />
          <Num label="Term" suffix="months" value={form.loTermMonths} onChange={set("loTermMonths")} />
          <Num label="Rent credit" suffix="%" value={form.loRentCreditPct} onChange={set("loRentCreditPct")} />
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">Company (printed on the document)</h2>
        <div className="grid grid-cols-2 gap-3">
          <Txt label="Company name" value={form.company.name} onChange={setCo("name")} placeholder="Goldstar Capital" />
          <Txt label="Signer" value={form.company.signer} onChange={setCo("signer")} placeholder="Matt Shepherd" />
          <Txt label="Phone" value={form.company.phone} onChange={setCo("phone")} placeholder="(206) 555-0142" />
          <Txt label="Email" value={form.company.email} onChange={setCo("email")} placeholder="offers@example.com" />
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button type="button" disabled={saving} onClick={save}
          className="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40 hover:bg-gray-800">
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
          Save settings
        </button>
        {saved && <span className="text-sm font-medium text-emerald-700">Saved ✓</span>}
        {error && <span className="text-sm text-red-700">{error}</span>}
      </div>
    </div>
  );
}
