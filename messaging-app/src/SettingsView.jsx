// SettingsView.jsx — location-wide calculation defaults and the company info
// printed on every offer document. Saved server-side per location.

import React, { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronUp, Loader2, Plus, RotateCcw, Trash2 } from "lucide-react";
import { DEFAULT_OFFER_SETTINGS, effectiveSettings } from "@shared/offer-calc.js";
import {
  CONTRACT_TOKENS, DEFAULT_CONTRACT_CLAUSES,
  ASSIGNMENT_TOKENS, DEFAULT_ASSIGNMENT_CLAUSES,
} from "@shared/contract-template.js";
import { saveSettings } from "./api.js";

const INPUT_CLS =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none";

// Thousands separators as you type (dollar fields only — save() strips them).
const fmtTyped = (v) => {
  const d = String(v).replace(/[^\d]/g, "");
  return d ? Number(d).toLocaleString("en-US") : "";
};

function Num({ label, value, onChange, suffix, money }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">
        {label}{suffix ? ` (${suffix})` : ""}
      </span>
      <input className={INPUT_CLS} inputMode={money ? "numeric" : "decimal"}
        value={money ? fmtTyped(value) : value}
        onChange={(e) => onChange(money ? fmtTyped(e.target.value) : e.target.value)} />
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

// Clause-template editor shared by the Purchase & Sale and Assignment contract
// sections. `value` is the saved override ([{id, title, body}] or null/empty
// for the built-in defaults); the first edit materializes a copy via onChange;
// Reset passes null back.
function ClauseEditor({ value, defaults, tokens, onChange }) {
  const list = Array.isArray(value) && value.length ? value : defaults;
  const isDefault = !Array.isArray(value) || !value.length;
  const mutate = (fn) => onChange(fn(list.map((c) => ({ ...c }))));
  const patchClause = (i, k) => (e) => mutate((l) => { l[i] = { ...l[i], [k]: e.target.value }; return l; });
  const moveClause = (i, dir) => mutate((l) => {
    const j = i + dir;
    if (j < 0 || j >= l.length) return l;
    [l[i], l[j]] = [l[j], l[i]];
    return l;
  });
  const removeClause = (i) => mutate((l) => l.filter((_, x) => x !== i));
  const addClause = () => mutate((l) => [...l, { id: `c-${Date.now()}`, title: "", body: "" }]);
  return (
    <>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {tokens.map((t) => (
          <span key={t.key} className="rounded-full bg-gray-100 px-2 py-0.5 font-mono text-[11px] text-gray-600"
            title={`${t.label} — filled from the contract form; empty prints a blank line`}>
            {`{{${t.key}}}`}
          </span>
        ))}
      </div>
      {list.map((c, i) => (
        <div key={c.id || i} className="mb-2 rounded-lg border border-gray-200 p-2.5">
          <div className="mb-2 flex items-center gap-2">
            <span className="w-6 shrink-0 text-right text-xs font-bold text-gray-400">{i + 1}.</span>
            <input className={INPUT_CLS} value={c.title} onChange={patchClause(i, "title")} placeholder="Clause title" />
            <button type="button" onClick={() => moveClause(i, -1)} disabled={i === 0}
              className="rounded p-1 text-gray-400 hover:bg-gray-100 disabled:opacity-30" title="Move up">
              <ChevronUp size={15} />
            </button>
            <button type="button" onClick={() => moveClause(i, 1)} disabled={i === list.length - 1}
              className="rounded p-1 text-gray-400 hover:bg-gray-100 disabled:opacity-30" title="Move down">
              <ChevronDown size={15} />
            </button>
            <button type="button" onClick={() => removeClause(i)}
              className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600" title="Remove clause">
              <Trash2 size={15} />
            </button>
          </div>
          <textarea rows={3} className={INPUT_CLS} value={c.body} onChange={patchClause(i, "body")}
            placeholder="Clause text — use {{tokens}} for the fill-in fields" />
        </div>
      ))}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={addClause}
          className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-semibold hover:bg-gray-50">
          <Plus size={14} /> Add clause
        </button>
        <button type="button" onClick={() => onChange(null)} disabled={isDefault}
          className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-semibold hover:bg-gray-50 disabled:opacity-40"
          title="Discard edits and go back to the built-in wholesale-friendly language">
          <RotateCcw size={14} /> Reset to default language
        </button>
      </div>
    </>
  );
}

// mode: "offers" shows everything; "outreach" (the standalone Agent Outreach
// site) shows only the RentCast section — same per-location settings blob
// underneath, so saves from either site merge safely via the full form state.
export default function SettingsView({ settings, onSaved, mode = "offers" }) {
  const [form, setForm] = useState(effectiveSettings(settings || {}));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (settings) setForm(effectiveSettings(settings));
  }, [settings]);

  const set = (k) => (v) => { setSaved(false); setForm((f) => ({ ...f, [k]: v })); };
  const setCo = (k) => (v) => { setSaved(false); setForm((f) => ({ ...f, company: { ...f.company, [k]: v } })); };

  // Contract clause templates (Purchase & Sale + Assignment). null/empty → the
  // built-in default language; the first edit materializes a copy into the form
  // (same pattern as the letter-terms template on the New Offer page).
  const setTemplate = (key) => (v) => { setSaved(false); setForm((f) => ({ ...f, [key]: v })); };

  async function save() {
    setSaving(true); setError("");
    try {
      // Coerce numerics (stripping comma formatting); anything unparseable
      // falls back to the default.
      const clean = { ...form };
      for (const k of Object.keys(DEFAULT_OFFER_SETTINGS)) {
        if (typeof DEFAULT_OFFER_SETTINGS[k] === "number") {
          const n = Number(String(clean[k]).replace(/[$,\s]/g, ""));
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
      {mode === "offers" && (<>
      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">Cash offer</h2>
        <p className="mb-3 text-xs text-gray-500">
          offer = %ARV − repair adjustment − fee. Repairs under the buffer cost repairs+buffer;
          normal repairs are multiplied; the portion above the heavy threshold uses the heavy multiplier.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Num label="Percent of ARV" suffix="%" value={form.cashPctOfArv} onChange={set("cashPctOfArv")} />
          <Num label="Assignment fee / spread" suffix="$" money value={form.wholesaleFee} onChange={set("wholesaleFee")} />
          <Num label="Small-repair buffer" suffix="$" money value={form.repairBuffer} onChange={set("repairBuffer")} />
          <Num label="Repair multiplier" suffix="×" value={form.repairBaseMult} onChange={set("repairBaseMult")} />
          <Num label="Heavy-repair threshold" suffix="% of ARV" value={form.repairHeavyPctOfArv} onChange={set("repairHeavyPctOfArv")} />
          <Num label="Heavy-repair multiplier" suffix="×" value={form.repairHeavyMult} onChange={set("repairHeavyMult")} />
          <Num label="Offer valid for" suffix="days" value={form.validityDays} onChange={set("validityDays")} />
          <Num label="Earnest money" suffix="$" money value={form.earnestMoney} onChange={set("earnestMoney")} />
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={Boolean(form.precisionJitter)}
            onChange={(e) => { setSaved(false); setForm((f) => ({ ...f, precisionJitter: e.target.checked })); }} />
          Precision jitter — non-round offer amounts (e.g. $161,847.23) for lowball anchoring
        </label>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">Comps map (RealEstateAPI.com)</h2>
        <p className="mb-3 text-xs text-gray-500">
          Powers the sold-comps map on the New Offer page (closed sales, same beds/baths/county, similar
          sqft). Sign up at realestateapi.com for a trial key. Leave blank to use manual comps only.
        </p>
        <Txt label="RealEstateAPI key" value={form.compsApiKey || ""} onChange={set("compsApiKey")} placeholder="APIKEY-..." />
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">AI photo scan (Anthropic)</h2>
        <p className="mb-3 text-xs text-gray-500">
          Powers "AI scan listing photos" in the rehab estimator — Claude reviews the MLS photos and
          pre-fills the scope of work. Get a key at console.anthropic.com → API Keys. Uses your
          RealEstateAPI key to fetch the photos. Each scan costs roughly $0.15–0.50 in API usage.
        </p>
        <Txt label="Anthropic API key" value={form.aiApiKey || ""} onChange={set("aiApiKey")} placeholder="sk-ant-..." />
        <div className="mt-3">
          <p className="mb-2 text-xs text-gray-500">
            Automatic listing photos for the scan via Apify's Zillow scraper (~$0.002 per lookup,
            $5/month free credits): apify.com → sign up → Settings → API tokens → copy. Unofficial
            scraper — can break if Zillow changes defenses; uploading photos always works as the fallback.
          </p>
          <Txt label="Apify API token" value={form.apifyToken || ""} onChange={set("apifyToken")} placeholder="apify_api_..." />
        </div>
      </section>
      </>)}

      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">Agent Outreach (RentCast)</h2>
        <p className="mb-3 text-xs text-gray-500">
          Powers the Agent Outreach page — active MLS listings with listing-agent contact info.
          Sign up at rentcast.io/api (free Developer tier: 50 requests/month, each returns up to
          500 listings). The zips/city here prefill the pull form.
        </p>
        <Txt label="RentCast API key" value={form.rentcastApiKey || ""} onChange={set("rentcastApiKey")} placeholder="..." />
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Txt label="Default zip codes" value={form.outreachZips || ""} onChange={set("outreachZips")} placeholder="98092, 98002" />
          <div className="grid grid-cols-2 gap-3">
            <Txt label="City" value={form.outreachCity || ""} onChange={set("outreachCity")} placeholder="Auburn" />
            <Txt label="State" value={form.outreachState || ""} onChange={set("outreachState")} placeholder="WA" />
          </div>
          <Num label="Max listing age" suffix="days" value={form.outreachDaysOld} onChange={set("outreachDaysOld")} />
        </div>
      </section>

      {mode === "offers" && (<>
      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">Company (printed on the document)</h2>
        <div className="grid grid-cols-2 gap-3">
          <Txt label="Company name" value={form.company.name} onChange={setCo("name")} placeholder="PRVT MKT" />
          <Txt label="Tagline" value={form.company.tagline} onChange={setCo("tagline")} placeholder="Private Market Home Buyers" />
          <Txt label="Signer" value={form.company.signer} onChange={setCo("signer")} placeholder="Matt Shepherd" />
          <Txt label="Phone" value={form.company.phone} onChange={setCo("phone")} placeholder="(206) 555-0142" />
          <Txt label="Email" value={form.company.email} onChange={setCo("email")} placeholder="matt@prvtmkt.com" />
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-1 text-sm font-bold">Purchase &amp; sale contract</h2>
        <p className="mb-3 text-xs text-gray-500">
          Clause language for the generated contract (New Offer → result → Generate purchase contract).
          Clauses are numbered by their position here, so reference other clauses by name ("under the
          Inspection Period paragraph"), never by number. Not legal advice — have your attorney review
          your template.
        </p>
        <ClauseEditor value={form.contractTemplate} defaults={DEFAULT_CONTRACT_CLAUSES}
          tokens={CONTRACT_TOKENS} onChange={setTemplate("contractTemplate")} />
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-1 text-sm font-bold">Assignment contract (dispositions)</h2>
        <p className="mb-3 text-xs text-gray-500">
          Clause language for the Assignment of Contract agreement — the document your dispositions
          side sends to the END BUYER (assignee), never the seller. Generated from an offer's result
          page or History → Generate assignment. Clauses are numbered by their position here, so
          reference other clauses by name, never by number. Not legal advice — have your attorney
          review your template.
        </p>
        <ClauseEditor value={form.assignmentTemplate} defaults={DEFAULT_ASSIGNMENT_CLAUSES}
          tokens={ASSIGNMENT_TOKENS} onChange={setTemplate("assignmentTemplate")} />
      </section>
      </>)}

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
