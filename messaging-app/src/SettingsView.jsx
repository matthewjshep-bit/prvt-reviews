// SettingsView.jsx — location-wide calculation defaults and the company info
// printed on every offer document. Saved server-side per location.

import React, { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronUp, Loader2, Plus, RotateCcw, Trash2 } from "lucide-react";
import { DEFAULT_OFFER_SETTINGS, effectiveSettings } from "@shared/offer-calc.js";
import {
  CONTRACT_TOKENS, DEFAULT_CONTRACT_CLAUSES,
  ASSIGNMENT_TOKENS, DEFAULT_ASSIGNMENT_CLAUSES,
} from "@shared/contract-template.js";
import { getCompBookmarklet, getUnderwrites, regenerateCompToken, saveSettings, uploadPsaExhibit } from "./api.js";
import FieldsManager from "./FieldsManager.jsx";
import EnrichSweep from "./EnrichSweep.jsx";
import ConversationTryIt from "./ConversationTryIt.jsx";

const INPUT_CLS =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none";

// Thousands separators as you type (dollar fields only — save() strips them).
const fmtTyped = (v) => {
  const d = String(v).replace(/[^\d]/g, "");
  return d ? Number(d).toLocaleString("en-US") : "";
};

function Num({ label, value, onChange, suffix, money }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
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
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      <input className={INPUT_CLS} value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

// One standing PSA exhibit — the earnest money check copy or the proof-of-funds
// letter. Either upload a file (stored server-side, content-addressed, and the
// URL comes back) or paste a URL you already host. Blank is a valid answer: the
// agreement then drops both the exhibit page AND every reference to it, so it
// never cites something that isn't in the envelope.
function ExhibitField({ label, kind, value, onChange, hint }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function pick(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same file be re-picked after a failure
    if (!file) return;
    setError("");
    setBusy(true);
    try {
      const dataUri = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error("couldn't read that file"));
        fr.readAsDataURL(file);
      });
      const r = await uploadPsaExhibit(kind, dataUri);
      onChange(r.url);
    } catch (err) { setError(err.message); }
    setBusy(false);
  }

  return (
    <div>
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      <div className="flex gap-2">
        <input className={INPUT_CLS} value={value || ""} placeholder="https://… or upload a file"
          onChange={(e) => onChange(e.target.value)} />
        <label className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 px-3 text-sm font-semibold ${
          busy ? "opacity-60" : "hover:bg-slate-50"}`}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} File
          <input type="file" className="hidden" accept="application/pdf,image/jpeg,image/png"
            disabled={busy} onChange={pick} />
        </label>
      </div>
      {error && <div className="mt-1 text-xs text-red-600">{error}</div>}
      {hint && !error && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

// Hex color with a live swatch. The broker's brandFrom() validates against this
// same pattern and falls back to the system default, so a malformed value
// degrades the header rather than breaking it — the swatch just goes blank.
const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;

function Hex({ label, value, onChange, placeholder }) {
  const v = String(value || "");
  const ok = HEX_RE.test(v);
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      <div className="flex items-center gap-2">
        <span className="h-[38px] w-[38px] shrink-0 rounded-lg border border-slate-300"
          style={ok ? { background: v } : undefined}
          title={ok ? v : `Not a hex color — investor pages fall back to ${placeholder}`} />
        <input className={INPUT_CLS} value={v} placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)} />
      </div>
    </label>
  );
}

// Nav links across the top of every investor page. The first one is the
// wordmark's home link; the rest render as nav, and any marked CTA becomes a
// filled button that survives on phones (the plain links hide under 640px).
// The broker keeps the first 6 that have both a label and an http(s) URL.
const MAX_BRAND_LINKS = 6;

function BrandLinksEditor({ value, onChange }) {
  const list = Array.isArray(value) ? value : [];
  const mutate = (fn) => onChange(fn(list.map((l) => ({ ...l }))));
  const patch = (i, k) => (e) => mutate((l) => { l[i] = { ...l[i], [k]: e.target.value }; return l; });
  const toggleCta = (i) => mutate((l) => { l[i] = { ...l[i], cta: !l[i].cta }; return l; });
  const remove = (i) => mutate((l) => l.filter((_, x) => x !== i));
  const add = () => mutate((l) => [...l, { label: "", url: "", cta: false }]);
  return (
    <>
      {list.map((l, i) => (
        <div key={i} className="mb-2 flex items-center gap-2">
          <span className="w-14 shrink-0 text-right text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {i === 0 ? "Home" : `Link ${i}`}
          </span>
          <input className={INPUT_CLS} value={l.label || ""} onChange={patch(i, "label")} placeholder="Label" />
          <input className={INPUT_CLS} value={l.url || ""} onChange={patch(i, "url")}
            placeholder="https://shepflips.com" />
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs font-semibold text-slate-600"
            title="Render as a filled button. Stays visible on phones when the other nav links hide.">
            <input type="checkbox" className="cursor-pointer" checked={Boolean(l.cta)}
              onChange={() => toggleCta(i)} disabled={i === 0} />
            CTA
          </label>
          <button type="button" onClick={() => remove(i)}
            className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" title="Remove link">
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      <button type="button" onClick={add} disabled={list.length >= MAX_BRAND_LINKS}
        className="mt-1 flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold hover:bg-slate-50 disabled:opacity-40"
        title={list.length >= MAX_BRAND_LINKS ? `${MAX_BRAND_LINKS} links is the maximum` : ""}>
        <Plus size={14} /> Add link
      </button>
    </>
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
          <span key={t.key} className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-600"
            title={`${t.label} — filled from the contract form; empty prints a blank line`}>
            {`{{${t.key}}}`}
          </span>
        ))}
      </div>
      {list.map((c, i) => (
        <div key={c.id || i} className="mb-2 rounded-lg border border-slate-200 p-2.5">
          <div className="mb-2 flex items-center gap-2">
            <span className="w-6 shrink-0 text-right text-xs font-bold text-slate-400">{i + 1}.</span>
            <input className={INPUT_CLS} value={c.title} onChange={patchClause(i, "title")} placeholder="Clause title" />
            <button type="button" onClick={() => moveClause(i, -1)} disabled={i === 0}
              className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30" title="Move up">
              <ChevronUp size={15} />
            </button>
            <button type="button" onClick={() => moveClause(i, 1)} disabled={i === list.length - 1}
              className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30" title="Move down">
              <ChevronDown size={15} />
            </button>
            <button type="button" onClick={() => removeClause(i)}
              className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" title="Remove clause">
              <Trash2 size={15} />
            </button>
          </div>
          <textarea rows={3} className={INPUT_CLS} value={c.body} onChange={patchClause(i, "body")}
            placeholder="Clause text — use {{tokens}} for the fill-in fields" />
        </div>
      ))}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={addClause}
          className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold hover:bg-slate-50">
          <Plus size={14} /> Add clause
        </button>
        <button type="button" onClick={() => onChange(null)} disabled={isDefault}
          className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold hover:bg-slate-50 disabled:opacity-40"
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
  const [showFields, setShowFields] = useState(false); // FieldsManager modal (own lifecycle, not part of the settings blob)
  const [error, setError] = useState("");

  useEffect(() => {
    if (settings) setForm(effectiveSettings(settings));
  }, [settings]);

  // Whether the broker will actually publish an auto-underwrite. This is env
  // (AUTO_UNDERWRITE_ENABLED), not a setting, so it can only be reported — and
  // it matters enough to report, because without it every run silently ends as
  // a draft and the operator has no way to tell that from a quality hold.
  const [underwriteEnabled, setUnderwriteEnabled] = useState(false);
  useEffect(() => {
    if (mode !== "offers") return;
    getUnderwrites().then((r) => setUnderwriteEnabled(Boolean(r.enabled))).catch(() => {});
  }, [mode]);

  // Zillow capture bookmarklet. The href is built server-side (one definition
  // of the loader URL) and fetched rather than derived from the settings blob.
  const [bookmarklet, setBookmarklet] = useState("");
  const [bmBusy, setBmBusy] = useState(false);
  const [bmError, setBmError] = useState("");
  const [bmHint, setBmHint] = useState(false);
  useEffect(() => {
    if (mode !== "offers") return;
    getCompBookmarklet().then((r) => setBookmarklet(r.bookmarklet || "")).catch(() => {});
  }, [mode]);
  async function makeBookmarklet() {
    setBmBusy(true); setBmError("");
    try {
      const r = await regenerateCompToken();
      setBookmarklet(r.bookmarklet || "");
      // Fold the new token into the form so a Save built from a pre-token load
      // can't write the old (empty) value straight back over it.
      setForm((f) => ({ ...f, captureToken: r.captureToken }));
      setBmHint(false);
    } catch (e) { setBmError(e.message); }
    setBmBusy(false);
  }

  const set = (k) => (v) => { setSaved(false); setForm((f) => ({ ...f, [k]: v })); };
  const setCo = (k) => (v) => { setSaved(false); setForm((f) => ({ ...f, company: { ...f.company, [k]: v } })); };
  const setPsa = (k) => (v) => { setSaved(false); setForm((f) => ({ ...f, psa: { ...f.psa, [k]: v } })); };

  // Contract clause templates (Purchase & Sale + Assignment). null/empty → the
  // built-in default language; the first edit materializes a copy into the form
  // (same pattern as the letter-terms template on the New Offer page).
  const setTemplate = (key) => (v) => { setSaved(false); setForm((f) => ({ ...f, [key]: v })); };

  async function save() {
    setSaving(true); setError("");
    try {
      // Coerce numerics (stripping comma formatting); anything unparseable
      // falls back to the default.
      const coerce = (obj, defaults) => {
        const out = { ...obj };
        for (const k of Object.keys(defaults)) {
          if (typeof defaults[k] === "number") {
            const n = Number(String(out[k]).replace(/[$,\s]/g, ""));
            out[k] = Number.isFinite(n) ? n : defaults[k];
          }
        }
        return out;
      };
      const clean = coerce(form, DEFAULT_OFFER_SETTINGS);
      // settings.psa is a nested blob with its own day counts — the top-level
      // walk above never reaches them, and a string "10" would come back from
      // the server as a string forever.
      clean.psa = coerce(form.psa || {}, DEFAULT_OFFER_SETTINGS.psa);
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
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">Underwriting — back-stack from ARV</h2>
        <p className="mb-3 text-xs text-slate-500">
          The default model, and the one that survives scrutiny: every cost between the ARV and your
          offer, stacked backwards. <b>MAO = ARV − selling costs − flip profit − repairs − holding − assignment
          fee.</b> Each figure is overridable per offer from the New Offer page.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Num label="Selling costs" suffix="% of ARV" value={form.sellingCostPct} onChange={set("sellingCostPct")} />
          <Num label="Flipper profit" suffix="% of ARV" value={form.flipProfitPct} onChange={set("flipProfitPct")} />
          <Num label="Holding period" suffix="months" value={form.holdMonths} onChange={set("holdMonths")} />
          <Num label="Assignment fee / spread" suffix="$" money value={form.wholesaleFee} onChange={set("wholesaleFee")} />
          <Num label="Classic 70% rule" suffix="% of ARV" value={form.maoPctOfArv} onChange={set("maoPctOfArv")} />
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Selling costs default to 7% — 3% listing + 3% buyer agent + ~1% closing. Holding is sized off the
          deal below. "Classic 70% rule" only applies to the 70%-ARV mode. The <b>Blended</b> mode averages
          the back-stack, the 90%-ARV anchor and the 70% rule, so these figures reach it too.
        </p>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">Holding costs</h2>
        <p className="mb-3 text-xs text-slate-500">
          One flat $/month can't be right across a $180k cosmetic and a $900k gut — the loan carry alone moves
          by an order of magnitude, and it's the biggest line. So the carry is estimated from the deal itself:
          <b> points + months × (loan interest + taxes + insurance + utilities)</b>, with the loan sized off the
          purchase price plus the rehab. Nothing extra to enter per deal — set the hold length on the New Offer
          page and everything else follows.
        </p>
        <label className="mb-3 flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={form.holdingModel !== "flat"}
            onChange={(e) => { setSaved(false); setForm((f) => ({ ...f, holdingModel: e.target.checked ? "scaled" : "flat" })); }} />
          Size the carry off the deal (uncheck for a flat monthly figure)
        </label>
        {form.holdingModel === "flat" ? (
          <div className="grid grid-cols-2 gap-3">
            <Num label="Holding cost" suffix="$ / month" money value={form.holdMonthlyCost} onChange={set("holdMonthlyCost")} />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Num label="Loan to cost" suffix="% of purchase + rehab" value={form.loanToCostPct} onChange={set("loanToCostPct")} />
              <Num label="Loan rate" suffix="% / year, interest-only" value={form.loanRatePct} onChange={set("loanRatePct")} />
              <Num label="Origination points" suffix="% of loan, once" value={form.loanPointsPct} onChange={set("loanPointsPct")} />
              <Num label="Property tax" suffix="% of ARV / year" value={form.taxRatePct} onChange={set("taxRatePct")} />
              <Num label="Insurance" suffix="% of ARV / year" value={form.insuranceRatePct} onChange={set("insuranceRatePct")} />
              <Num label="Utilities & upkeep" suffix="$ / month" money value={form.utilitiesMonthly} onChange={set("utilitiesMonthly")} />
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Defaults are typical hard-money terms — 85% LTC at 11% with 2 points. Set loan to cost to <b>0</b>
              {" "}for an all-cash buyer and only taxes, insurance and utilities carry. Insurance assumes a vacant
              or builder's-risk policy, which runs well above an owner-occupied one.
            </p>
          </>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">Lowball anchoring model</h2>
        <p className="mb-3 text-xs text-slate-500">
          The aggressive alternative mode: offer = %ARV − repair adjustment − fee. Repairs under the buffer
          cost repairs+buffer; normal repairs are multiplied; the portion above the heavy threshold uses the
          heavy multiplier. Not used by the back-stack model.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Num label="Percent of ARV" suffix="%" value={form.cashPctOfArv} onChange={set("cashPctOfArv")} />
          <Num label="Small-repair buffer" suffix="$" money value={form.repairBuffer} onChange={set("repairBuffer")} />
          <Num label="Repair multiplier" suffix="×" value={form.repairBaseMult} onChange={set("repairBaseMult")} />
          <Num label="Heavy-repair threshold" suffix="% of ARV" value={form.repairHeavyPctOfArv} onChange={set("repairHeavyPctOfArv")} />
          <Num label="Heavy-repair multiplier" suffix="×" value={form.repairHeavyMult} onChange={set("repairHeavyMult")} />
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={Boolean(form.precisionJitter)}
            onChange={(e) => { setSaved(false); setForm((f) => ({ ...f, precisionJitter: e.target.checked })); }} />
          Precision jitter — non-round offer amounts (e.g. $161,847.23) for lowball anchoring
        </label>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">Letter &amp; seller net</h2>
        <div className="grid grid-cols-2 gap-3">
          <Num label="Offer valid for" suffix="days" value={form.validityDays} onChange={set("validityDays")} />
          <Num label="Earnest money" suffix="$" money value={form.earnestMoney} onChange={set("earnestMoney")} />
          <Num label="Seller's agent commission" suffix="%" value={form.sellerAgentPct} onChange={set("sellerAgentPct")} />
          <Num label="Buyer's agent commission" suffix="%" value={form.buyerAgentPct} onChange={set("buyerAgentPct")} />
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">Comps map (RealEstateAPI.com)</h2>
        <p className="mb-3 text-xs text-slate-500">
          Powers the sold-comps map on the New Offer page (closed sales, same beds/baths/county, similar
          sqft). Sign up at realestateapi.com for a trial key. Leave blank to use manual comps only.
        </p>
        <Txt label="RealEstateAPI key" value={form.compsApiKey || ""} onChange={set("compsApiKey")} placeholder="APIKEY-..." />
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">Zillow comp capture</h2>
        <p className="mb-3 text-xs text-slate-500">
          For the comps you find by eye. Drag the button below to your bookmarks bar, then on any Zillow page
          click it: on a property page it grabs that one comp, on a search-results page it offers to grab every
          result. They land in the <b>Zillow inbox</b> on the Comps &amp; ARV step, with photos, year built,
          stories, construction and subdivision attached — the facts the match score needs and the comps API
          often doesn't have. Because the photos come along, AI condition grading costs no Apify credits.
        </p>
        {bmError && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{bmError}</div>}
        {bookmarklet ? (
          <div className="flex flex-wrap items-center gap-3">
            {/* eslint-disable-next-line jsx-a11y/anchor-is-valid */}
            <a href={bookmarklet}
              onClick={(e) => { e.preventDefault(); setBmHint(true); }}
              title="Drag me to your bookmarks bar"
              className="cursor-grab rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
              📍 Grab comp
            </a>
            <button type="button" onClick={makeBookmarklet} disabled={bmBusy}
              className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60">
              {bmBusy ? <Loader2 size={13} className="inline animate-spin" /> : null} Regenerate
            </button>
            {bmHint && (
              <span className="text-xs text-amber-700">
                Don't click it here — <b>drag</b> it onto your bookmarks bar, then click it while you're on Zillow.
              </span>
            )}
          </div>
        ) : (
          <button type="button" onClick={makeBookmarklet} disabled={bmBusy}
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
            {bmBusy ? <Loader2 size={14} className="animate-spin" /> : null} Create the bookmarklet
          </button>
        )}
        <p className="mt-3 text-xs text-slate-500">
          The bookmarklet carries a capture key that can only add comps to your inbox — nothing else, and it
          can't read anything back out. <b>Regenerate</b> revokes it: the old bookmark stops working and you
          drag the new one over.
        </p>
      </section>

      </>)}

      {(mode === "offers" || mode === "dispo") && (
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">AI features (Anthropic)</h2>
        <p className="mb-3 text-xs text-slate-500">
          Powers "AI scan listing photos" in the rehab estimator, the ✨ contact enrichment
          (conversation summary → CRM fields), and plain-English buy-box search on the Investors
          page. Get a key at console.anthropic.com → API Keys. Photo scans cost roughly $0.15–0.50
          each; enrichments and buy-box searches roughly $0.02–0.05.
        </p>
        <Txt label="Anthropic API key" value={form.aiApiKey || ""} onChange={set("aiApiKey")} placeholder="sk-ant-..." />
        {mode === "offers" && (<>
        <div className="mt-3">
          <p className="mb-2 text-xs text-slate-500">
            Automatic listing photos for the scan via Apify's Zillow scraper (~$0.002 per lookup,
            $5/month free credits): apify.com → sign up → Settings → API tokens → copy. Unofficial
            scraper — can break if Zillow changes defenses; uploading photos always works as the fallback.
          </p>
          <Txt label="Apify API token" value={form.apifyToken || ""} onChange={set("apifyToken")} placeholder="apify_api_..." />
        </div>
        <div className="mt-3">
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Extra enrichment instructions (optional)
          </label>
          <textarea rows={3} value={form.enrichExtraInstructions || ""}
            onChange={(e) => set("enrichExtraInstructions")(e.target.value)}
            placeholder="e.g. local market vocabulary, what 'hot' means for our team, agents to treat differently…"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
          <p className="mt-1 text-xs text-slate-400">
            Appended to the AI's instructions when it analyzes a contact's conversation history,
            and when it reads a buy-box search.
          </p>
        </div>
        </>)}
      </section>
      )}

      {mode === "offers" && (<>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">Auto-underwrite</h2>
        <p className="mb-3 text-xs text-slate-500">
          A GoHighLevel workflow can webhook an inbound agent text straight into a finished offer:
          it reads the address, pulls comps within half a mile, has the AI grade each comp's
          renovation condition from its sold photos, derives the ARV from the renovated ones only,
          scans the subject's listing photos into a scope of work, and creates a <strong>blended</strong> offer.
          Nothing is ever sent to the agent — the offer lands in History for you to review.
          A run that can't find three renovated comps nearby, or enough photos to scan, stops and
          saves a draft instead. Each run costs roughly $1–3 in Apify and Anthropic usage.
        </p>
        <div className="mb-3 flex items-center gap-2 text-xs">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-semibold ${
            underwriteEnabled ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-700"}`}>
            {underwriteEnabled ? "Live on the broker" : "Dry run only"}
          </span>
          <span className="text-slate-500">
            {underwriteEnabled
              ? "AUTO_UNDERWRITE_ENABLED is set — runs publish real offers."
              : "Set AUTO_UNDERWRITE_ENABLED=true on the broker to let runs publish. Until then every run saves a draft."}
          </span>
        </div>
        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Comps from</span>
            <select value={form.compsSource || "zillow"} onChange={(e) => set("compsSource")(e.target.value)}
              className={INPUT_CLS}>
              <option value="zillow">Zillow sold map (Apify)</option>
              <option value="realestateapi">RealEstateAPI (county + MLS records)</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Renovated comps decided by</span>
            <select value={form.compsCondition || "price"} onChange={(e) => set("compsCondition")(e.target.value)}
              className={INPUT_CLS}>
              <option value="price">Top of the $/sqft spread (free)</option>
              <option value="ai">Reading each comp's sold photos (slow, ~$1)</option>
            </select>
          </label>
        </div>
        <p className="mb-3 text-xs text-slate-400">
          Zillow needs only the Apify token above — no RealEstateAPI account. Because Zillow's sold map has
          no subject record, the Comps pane won't auto-fill beds/baths/sqft for you; type them and the search
          uses them. The price proxy takes the top of the $/sqft spread inside an already-tight comp set
          (same beds/baths, ±20% size, half a mile) as a stand-in for renovated — it refuses when there
          aren't at least 6 nearby sales to rank, rather than calling the best 3 of 3 "renovated".
        </p>
        <Txt label="Daily cap (runs per day)"
          value={String(form.autoUnderwriteDailyCap ?? "")}
          onChange={(v) => set("autoUnderwriteDailyCap")(v.replace(/[^\d]/g, ""))}
          placeholder="25" />
        <p className="mt-1 text-xs text-slate-400">
          The spend ceiling. A misconfigured workflow that fires on every inbound text stops here
          rather than at your Apify balance. Blank uses the default of 25.
        </p>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">Conversation AI</h2>
        <p className="text-xs text-slate-500">
          The bot that answers inbound agent and investor texts has its own tab now — <strong>Conversation AI</strong>,
          in the header. Its voice, the rules for agents and for investors, who counts as which, what it may send on
          its own and what it triggers in GHL all live there, along with a try-it panel and the outbox. The daily cap
          and standing instructions that used to sit here were carried over the first time the tab opened. It still
          uses the Anthropic key above.
        </p>
        <div className="mt-3">
          <ConversationTryIt compact />
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">AI conversation sweep</h2>
        <p className="mb-3 text-xs text-slate-500">
          Scans every agent/investor contact with conversation activity in the window and auto-fills
          their CRM fields from what was said — buy box for investors, areas served for agents,
          personal details for both — leaving an audit note on each updated contact. Skips contacts
          already enriched since their last message, DND
          contacts and (by default) anyone who didn't reply in the window. Uses the Anthropic key
          above (~$0.02–0.05 per contact scanned).
        </p>
        <EnrichSweep />
        <label className="mt-3 flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={Boolean(form.enrichSweepNightly)}
            onChange={(e) => { setSaved(false); setForm((f) => ({ ...f, enrichSweepNightly: e.target.checked })); }} />
          Nightly sweep — automatically scan the last 24h of conversations every night (~2–3am Pacific)
        </label>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">CRM fields</h2>
        <p className="mb-3 text-xs text-slate-500">
          Every contact custom field in one place — the fields this app manages (offers, outreach, AI
          enrichment), anything else in your GHL location, and a live contact preview where you can
          see and edit all of a contact's values.
        </p>
        <button type="button" onClick={() => setShowFields(true)}
          className="rounded-lg border border-slate-300 px-3.5 py-2 text-sm font-semibold hover:bg-slate-50">
          Open fields manager
        </button>
      </section>
      </>)}

      {(mode === "offers" || mode === "outreach") && (
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">Agent Outreach (RentCast)</h2>
        <p className="mb-3 text-xs text-slate-500">
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
      )}

      {(mode === "offers" || mode === "dispo") && (
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">Dispositions (investor book)</h2>
        <p className="mb-3 text-xs text-slate-500">
          Which GHL contacts count as cash buyers, and how a blast is tagged. Syncing pulls every
          contact carrying one of these tags into the Investors page. Buy-box search uses the
          Anthropic key above; without one the structured filters still work, just without AI
          ranking and reasons.
        </p>
        <Txt label="Investor tags" value={form.dispoTags || ""} onChange={set("dispoTags")}
          placeholder="investor, investor-active, investor-stale, on-deal, disposition-*" />
        <p className="mt-1 text-xs text-slate-500">
          Comma separated. A trailing <span className="font-mono">*</span> matches a family of tags —
          <span className="font-mono"> disposition-*</span> picks up every market you blast to, including
          ones you add later, without editing this again. Leave blank for the defaults
          (<span className="font-mono">investor, investor-active, investor-stale, on-deal</span>).
        </p>
        <div className="mt-3">
          <Txt label="Blast tag prefix" value={form.dispoBlastTagPrefix || ""} onChange={set("dispoBlastTagPrefix")}
            placeholder="dispo" />
          <p className="mt-1 text-xs text-slate-500">
            Each blast gets its own "&lt;prefix&gt;-&lt;deal&gt;" tag so you can target one blast in GHL later.
            Live sends also need DISPO_BLASTS_ENABLED=true on the broker.
          </p>
        </div>
      </section>
      )}

      {(mode === "offers" || mode === "dispo") && (
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">Property photos from Google Drive</h2>
        <p className="mb-3 text-xs text-slate-500">
          Lets the dataroom photo box take a Drive <em>folder</em> link and import everything in it,
          instead of one photo at a time. A plain API key is all it needs — no Google sign-in — because
          it only ever reads folders you've shared "Anyone with the link".
        </p>
        <Txt label="Google API key" value={form.googleApiKey || ""} onChange={set("googleApiKey")} placeholder="AIza..." />
        <p className="mt-1 text-xs text-slate-500">
          console.cloud.google.com → APIs &amp; Services → <span className="font-mono">Enable APIs</span> →
          Google Drive API, then Credentials → Create credentials → API key. Restrict it to the Drive API.
          Leave any HTTP-referrer restriction off — the broker calls from a server, not a browser.
        </p>
      </section>
      )}

      {mode === "offers" && (<>
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">Company (printed on the document)</h2>
        <div className="grid grid-cols-2 gap-3">
          <Txt label="Company name" value={form.company.name} onChange={setCo("name")} placeholder="Shep Flips" />
          <Txt label="Tagline" value={form.company.tagline} onChange={setCo("tagline")} placeholder="Cash offers on listed property" />
          <Txt label="Signer" value={form.company.signer} onChange={setCo("signer")} placeholder="Matt Shepherd" />
          <Txt label="Phone" value={form.company.phone} onChange={setCo("phone")} placeholder="(206) 555-0142" />
          <Txt label="Email" value={form.company.email} onChange={setCo("email")} placeholder="matt@shepflips.com" />
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-1 text-sm font-bold">Investor page header</h2>
        <p className="mb-3 text-xs text-slate-500">
          The wordmark across the top of every investor-facing page — deal packages, teasers, and the
          portfolio. These are read live, so editing them here rebrands links you have already sent.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Txt label="Wordmark" value={form.company.wordmark || ""} onChange={setCo("wordmark")}
            placeholder="Shep·Flips" />
          <Txt label="Logo image URL (optional)" value={form.company.logoUrl || ""} onChange={setCo("logoUrl")}
            placeholder="https://shepflips.com/logo.png" />
          <Hex label="Wordmark color" value={form.company.brandPrimary || ""} onChange={setCo("brandPrimary")}
            placeholder="#0F172A" />
          <Hex label="Accent color" value={form.company.brandAccent || ""} onChange={setCo("brandAccent")}
            placeholder="#2563EB" />
        </div>
        <p className="mt-1 text-xs text-slate-500">
          A middle dot (·) in the wordmark renders in the accent color — "Shep·Flips" reads as SHEP·FLIPS
          with a colored dot. Blank falls back to the company name, and the tagline above prints beneath it.
          Leave the logo URL blank to use the built-in house mark, drawn in the two colors above; point it
          at your own image (https only) to use that instead.
        </p>
        <div className="mt-4">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Header links</h3>
          <p className="mb-3 text-xs text-slate-500">
            The first link is where the wordmark points; the rest become nav. Mark one as CTA to render it
            as a button — on phones the plain links hide and only the CTA survives.
          </p>
          <BrandLinksEditor value={form.company.brandLinks} onChange={setCo("brandLinks")} />
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-1 text-sm font-bold">Purchase &amp; sale agreement (the official offer)</h2>
        <p className="mb-3 text-xs text-slate-500">
          Standing values for the Washington PSA — the signable agreement generated from an offer
          (New Offer → result → <b>Generate Offer PSA</b>). These are the parts that are the same on
          every deal; price, dates and the legal description are filled in per offer. The clause
          language itself is fixed: its section numbers are cross-referenced inside the document, so
          it isn't edited here. Not legal advice — have a Washington real estate attorney read the
          document once before you send it.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Txt label="Buyer entity" value={form.psa.buyerEntity} onChange={setPsa("buyerEntity")}
            placeholder="Shep Flips Holdings LLC" />
          <Txt label="Entity formed in" value={form.psa.buyerEntityState} onChange={setPsa("buyerEntityState")}
            placeholder="Washington" />
          <Txt label="Title / escrow company" value={form.psa.titleCompany} onChange={setPsa("titleCompany")}
            placeholder="Rainier Title" />
          <Txt label="Escrow officer" value={form.psa.titleOfficer} onChange={setPsa("titleOfficer")} />
          <Txt label="Escrow phone" value={form.psa.titlePhone} onChange={setPsa("titlePhone")} />
          <Txt label="Hard money lender" value={form.psa.lenderName} onChange={setPsa("lenderName")}
            placeholder="Named on the proof-of-funds letter" />
          <Num label="Feasibility period" suffix="days" value={form.psa.feasibilityDays} onChange={setPsa("feasibilityDays")} />
          <Num label="Closing after approval" suffix="days" value={form.psa.closingDays} onChange={setPsa("closingDays")} />
          <Num label="Accept changed terms within" suffix="business days" value={form.psa.counterDays} onChange={setPsa("counterDays")} />
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3">
          <ExhibitField label="Exhibit — earnest money check" kind="emdCheck"
            value={form.psa.emdCheckUrl} onChange={setPsa("emdCheckUrl")}
            hint="A scan or photo of the check made out to the closing agent. PDF, JPEG or PNG, up to 8MB." />
          <ExhibitField label="Exhibit — proof of funds letter" kind="proofOfFunds"
            value={form.psa.proofOfFundsUrl} onChange={setPsa("proofOfFundsUrl")}
            hint="Your lender's POF letter. Attached and cited only when a lender is named above." />
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Exhibits are read fresh each time an agreement is generated, so replacing a file here updates
          every agreement you produce afterwards. Leave one blank and the agreement quietly drops both
          its page and the sentence that cites it.
        </p>

        <div className="mt-4 border-t border-slate-100 pt-4">
          <label className="flex cursor-pointer items-start gap-2.5">
            <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-slate-300"
              checked={Boolean(form.psa.autoSign)}
              onChange={(e) => setPsa("autoSign")(e.target.checked)} />
            <span>
              <span className="block text-sm font-semibold">Pre-sign every agreement</span>
              <span className="block text-xs text-slate-500">
                Signs the buyer line on the agreement and both addenda in script, dated to the
                agreement's effective date, so ten offers a day isn't ten signatures a day. The
                seller's line is always left blank.
              </span>
            </span>
          </label>
          {form.psa.autoSign && (
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Txt label="Signature" value={form.psa.signatureName} onChange={setPsa("signatureName")}
                placeholder={form.company.signer || "Matthew Shepherd"} />
              <Txt label="Title / capacity" value={form.psa.signatureCapacity} onChange={setPsa("signatureCapacity")}
                placeholder="Manager" />
              <p className="col-span-2 text-xs text-amber-700">
                A pre-signed offer is binding the moment the seller signs it. Your exits are the
                feasibility period (§ 6) and the expiry date on each offer — check both are set the way
                you want before turning this on. Blank falls back to the signer name above.
              </p>
            </div>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-1 text-sm font-bold">Generic purchase contract (non-WA)</h2>
        <p className="mb-3 text-xs text-slate-500">
          Clause language for the generic, multi-state contract (New Offer → result → Generate purchase
          contract). The Washington agreement above is the one to send on a WA listing; this is the
          fallback for everything else.
          Clauses are numbered by their position here, so reference other clauses by name ("under the
          Inspection Period paragraph"), never by number. Not legal advice — have your attorney review
          your template.
        </p>
        <ClauseEditor value={form.contractTemplate} defaults={DEFAULT_CONTRACT_CLAUSES}
          tokens={CONTRACT_TOKENS} onChange={setTemplate("contractTemplate")} />
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-1 text-sm font-bold">Assignment contract (dispositions)</h2>
        <p className="mb-3 text-xs text-slate-500">
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
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40 hover:bg-blue-700">
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
          Save settings
        </button>
        {saved && <span className="text-sm font-medium text-emerald-700">Saved ✓</span>}
        {error && <span className="text-sm text-red-700">{error}</span>}
      </div>
      {showFields && <FieldsManager onClose={() => setShowFields(false)} />}
    </div>
  );
}
