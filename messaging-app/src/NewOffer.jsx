// NewOffer.jsx — the core flow: contact → property numbers → three live
// offers → generate the document and attach everything to the GHL contact.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, FileText, Loader2, Save, Search, Send, X } from "lucide-react";
import { calculateOffers, fmtMoney } from "@shared/offer-calc.js";
import {
  createOffer, getContactDetail, previewDocument, saveDraft, searchContacts, sendOffer, suggestAddresses, zillowUrl,
} from "./api.js";
import CompsPane from "./CompsPane.jsx";
import RehabPane from "./RehabPane.jsx";

// Pick the best address from a contact's custom fields: prefer a
// "…address…short…" key (the Property Address Short Hand field), then any
// property-address field, then anything address-like.
function pickContactAddress(custom) {
  const score = (k) => {
    const n = k.toLowerCase().replace(/[^a-z]/g, "");
    if (n.includes("address") && n.includes("short")) return 3;
    if (n.includes("property") && n.includes("address")) return 2;
    if (n.includes("address")) return 1;
    return 0;
  };
  let best = "", bestScore = 0;
  for (const [k, v] of Object.entries(custom || {})) {
    const val = String(v || "").trim();
    if (!val) continue;
    const s = score(k);
    if (s > bestScore) { bestScore = s; best = val; }
  }
  return best;
}

// Address input with debounced suggestions (broker-proxied geocoder).
function AddressInput({ value, onChange, placeholder }) {
  const [options, setOptions] = useState([]);
  const [open, setOpen] = useState(false);
  const timer = useRef(null);
  const skipNext = useRef(false);

  useEffect(() => {
    clearTimeout(timer.current);
    if (skipNext.current) { skipNext.current = false; return; }
    if (!open || value.trim().length < 5) { setOptions([]); return; }
    timer.current = setTimeout(() => {
      suggestAddresses(value.trim()).then((s) => setOptions(s || [])).catch(() => setOptions([]));
    }, 350);
    return () => clearTimeout(timer.current);
  }, [value, open]);

  return (
    <div className="relative">
      <input
        className={INPUT_CLS}
        value={value}
        placeholder={placeholder}
        onChange={(e) => { setOpen(true); onChange(e.target.value); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        autoComplete="off"
      />
      {open && options.length > 0 && (
        <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
          {options.map((o) => (
            <button
              key={o}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { skipNext.current = true; onChange(o); setOptions([]); setOpen(false); }}
              className="block w-full px-3 py-2 text-left text-sm hover:bg-gray-50"
            >
              {o}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const INPUT_CLS =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none";
const LABEL_CLS = "mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500";

function Field({ label, children }) {
  return (
    <div>
      <span className={LABEL_CLS}>{label}</span>
      {children}
    </div>
  );
}

/* ---------------- contact picker ---------------- */

function ContactPicker({ selected, onSelect, newContact, setNewContact, mode, setMode }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    clearTimeout(timer.current);
    if (!query.trim() || query.trim().length < 2) {
      setResults([]);
      return;
    }
    timer.current = setTimeout(() => {
      setSearching(true);
      searchContacts(query.trim())
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(timer.current);
  }, [query]);

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold">Seller contact</h2>
        <div className="flex gap-1 text-xs">
          {["existing", "new"].map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-full px-2.5 py-1 font-medium ${
                mode === m ? "bg-gray-900 text-white" : "text-gray-500 hover:bg-gray-100"
              }`}
            >
              {m === "existing" ? "Existing" : "New contact"}
            </button>
          ))}
        </div>
      </div>

      {mode === "existing" ? (
        selected ? (
          <div className="flex items-center justify-between rounded-lg bg-gray-100 px-3 py-2">
            <div>
              <div className="text-sm font-semibold">{selected.name || "(no name)"}</div>
              <div className="text-xs text-gray-500">{[selected.phone, selected.email].filter(Boolean).join(" · ")}</div>
            </div>
            <button type="button" onClick={() => onSelect(null)} className="rounded p-1 text-gray-400 hover:bg-gray-200">
              <X size={16} />
            </button>
          </div>
        ) : (
          <div className="relative">
            <div className="flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2">
              <Search size={15} className="text-gray-400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search contacts by name, phone, or email…"
                className="w-full text-sm focus:outline-none"
              />
              {searching && <Loader2 size={15} className="animate-spin text-gray-400" />}
            </div>
            {results.length > 0 && (
              <div className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-gray-200 bg-white shadow-lg">
                {results.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => { onSelect(c); setQuery(""); setResults([]); }}
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-gray-50"
                  >
                    <span className="font-medium">{c.name || "(no name)"}</span>
                    <span className="ml-2 text-xs text-gray-500">{[c.phone, c.email].filter(Boolean).join(" · ")}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input className={INPUT_CLS} value={newContact.name}
              onChange={(e) => setNewContact({ ...newContact, name: e.target.value })} placeholder="Dana Whitfield" />
          </Field>
          <Field label="Phone (required)">
            <input className={INPUT_CLS} value={newContact.phone}
              onChange={(e) => setNewContact({ ...newContact, phone: e.target.value })} placeholder="+1 253 555 0142" />
          </Field>
        </div>
      )}
    </div>
  );
}

/* ---------------- the cash offer card ---------------- */

function OfferCards({ calc }) {
  if (!calc) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400">
        Enter an ARV (or use the comps below) to see the cash offer.
      </div>
    );
  }
  const { cash } = calc.offers;
  const Row = ({ label, value }) => (
    <div className="flex justify-between gap-4 text-sm">
      <span className="text-gray-500">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
  return (
    <div className="rounded-xl border border-amber-400 bg-amber-50 p-5 sm:flex sm:items-center sm:justify-between sm:gap-8">
      <div>
        <div className="text-[11px] font-bold uppercase tracking-wider text-gray-500">All-cash offer</div>
        <div className="mt-1 text-4xl font-black tracking-tight">{fmtMoney(cash.amount)}</div>
        <div className="mt-1 text-xs text-gray-500">
          {cash.pctOfAsking != null ? `≈ ${cash.pctOfAsking}% of asking · ` : ""}as-is · close in ~{cash.closeDays} days
        </div>
      </div>
      <div className="mt-4 w-full max-w-xs space-y-1 border-t border-amber-200 pt-3 sm:mt-0 sm:border-l sm:border-t-0 sm:pl-6 sm:pt-0">
        <Row label={`~${cash.pctOfArv}% of ARV`} value={fmtMoney(cash.base)} />
        <Row label="Repair adjustment" value={`− ${fmtMoney(cash.repairAdjustment)}`} />
        <Row label="Fee / spread" value={`− ${fmtMoney(cash.wholesaleFee)}`} />
      </div>
    </div>
  );
}

/* ---------------- main view ---------------- */

export default function NewOffer({ settings, initialContactId, restore }) {
  // `restore` reopens a saved draft (full form state) or an existing offer
  // (inputs + scope become a fresh working copy).
  const fromDraft = restore?.status === "draft" ? restore.draft : null;
  const fromOffer = restore && restore.status !== "draft" ? restore : null;
  const fmtN = (n) => (Number(n) ? Number(n).toLocaleString("en-US") : "");

  const [mode, setMode] = useState(fromDraft?.mode || "existing");
  const [contact, setContact] = useState(
    fromDraft?.contact ||
    (fromOffer?.contactId ? { id: fromOffer.contactId, name: fromOffer.contactName || "", phone: "", email: "" } : null)
  );
  const [newContact, setNewContact] = useState(fromDraft?.newContact || { name: "", phone: "" });
  const [inputs, setInputs] = useState(
    fromDraft?.inputs ||
    (fromOffer?.calc
      ? {
          address: fromOffer.calc.inputs.address || "",
          askingPrice: fmtN(fromOffer.calc.inputs.askingPrice),
          arv: fmtN(fromOffer.calc.inputs.arv),
          repairs: fmtN(fromOffer.calc.inputs.repairs),
        }
      : { address: "", askingPrice: "", arv: "", repairs: "" })
  );
  const [subjectSqft, setSubjectSqft] = useState(fromDraft?.subjectSqft || ""); // shared: comps $/sqft + rehab per-sqft items
  const [subjectInfo, setSubjectInfo] = useState(fromDraft?.subjectInfo || null); // beds/baths from the comps subject record
  const [scope, setScope] = useState(fromDraft?.scope || fromOffer?.scope || []); // applied rehab line items
  const [draftId, setDraftId] = useState(fromDraft ? restore.id : null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const rehabStateRef = useRef(fromDraft?.rehab || null);
  const rehabInit =
    fromDraft?.rehab ||
    (fromOffer?.scope?.length
      ? { custom: fromOffer.scope.map((s, i) => ({ id: `c-${i}`, label: s.label, cost: s.cost })) }
      : undefined);
  const [preview, setPreview] = useState(null);   // data-url image
  const [previewing, setPreviewing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState(null);     // { offer, ghl, warnings }
  const [error, setError] = useState("");
  const [sendState, setSendState] = useState(null); // { dryRun info } | { sent }

  // Money fields format with thousands separators as you type; the calc
  // engine strips $ , and spaces, so the formatted string feeds it directly.
  const fmtTyped = (v) => { const d = String(v).replace(/[^\d]/g, ""); return d ? Number(d).toLocaleString("en-US") : ""; };
  const setMoney = (k) => (e) => setInputs((s) => ({ ...s, [k]: fmtTyped(e.target.value) }));

  // Deep link (?contact_id= from the GHL contact panel): preselect the
  // contact and prefill their property address.
  useEffect(() => {
    if (!initialContactId || contact) return;
    getContactDetail(initialContactId)
      .then((d) => {
        setContact({ id: d.id, name: d.name, phone: d.phone, email: d.email });
        const addr = pickContactAddress(d.custom);
        if (addr) setInputs((s) => (s.address.trim() ? s : { ...s, address: addr }));
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialContactId]);

  // Selecting a contact pulls their custom fields and prefills the address
  // (Property Address Short Hand etc.) — without clobbering anything typed.
  function selectContact(c) {
    setContact(c);
    if (!c?.id) return;
    getContactDetail(c.id)
      .then((d) => {
        const addr = pickContactAddress(d.custom);
        if (addr) setInputs((s) => (s.address.trim() ? s : { ...s, address: addr }));
      })
      .catch(() => {});
  }

  const calc = useMemo(() => {
    try {
      return calculateOffers(inputs, settings || {});
    } catch {
      return null;
    }
  }, [inputs, settings]);

  const contactName = mode === "existing" ? contact?.name || "" : newContact.name;
  const canCreate = Boolean(calc && (mode === "existing" ? contact?.id : newContact.phone.trim()));

  async function doPreview() {
    setError(""); setPreviewing(true);
    try {
      const r = await previewDocument(inputs, settings || {}, contactName);
      setPreview(r.image);
    } catch (e) { setError(e.message); }
    setPreviewing(false);
  }

  async function doCreate() {
    setError(""); setCreating(true); setSendState(null);
    try {
      const r = await createOffer({
        contactId: mode === "existing" ? contact?.id : undefined,
        newContact: mode === "new" ? newContact : undefined,
        inputs,
        settings: settings || {},
        scope,
        draftId,
      });
      setResult(r);
      setPreview(null);
      setDraftId(null);
    } catch (e) { setError(e.message); }
    setCreating(false);
  }

  async function doSaveDraft() {
    setError(""); setSavingDraft(true);
    try {
      const r = await saveDraft(draftId, {
        mode, contact, newContact, inputs, subjectSqft, subjectInfo, scope,
        rehab: rehabStateRef.current,
        cashPreview: calc?.offers?.cash?.amount ?? null,
      });
      setDraftId(r.offer.id);
      setDraftSaved(true);
      setTimeout(() => setDraftSaved(false), 2500);
    } catch (e) { setError(e.message); }
    setSavingDraft(false);
  }

  async function doSend(live) {
    try {
      const r = await sendOffer(result.offer.id, { dryRun: !live });
      setSendState(r);
    } catch (e) { setError(e.message); }
  }

  if (result) {
    const { offer, ghl, warnings } = result;
    const Badge = ({ ok, label }) => (
      <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
        ok ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
      }`}>
        {ok ? <Check size={12} /> : <X size={12} />} {label}
      </span>
    );
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4">
          <div className="text-sm font-bold text-emerald-900">
            Offer created for {offer.contactName || "contact"} — {offer.address || "property"}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge ok={ghl.fields} label="Custom fields" />
            <Badge ok={ghl.note} label="Contact note" />
            <Badge ok={ghl.tag} label="Tag" />
          </div>
          {warnings?.length > 0 && (
            <ul className="mt-2 list-inside list-disc text-xs text-amber-800">
              {warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <img src={offer.imageUrl} alt="Offer document" className="w-full rounded-xl border border-gray-200 shadow-sm" />
          <div className="space-y-3">
            <a href={offer.pdfUrl} target="_blank" rel="noreferrer"
              className="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800">
              <FileText size={16} /> Open PDF document
            </a>
            {offer.scopePdfUrl && (
              <a href={offer.scopePdfUrl} target="_blank" rel="noreferrer"
                className="flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-semibold hover:bg-gray-50">
                <FileText size={16} /> Open Rehab Scope of Work (PDF)
              </a>
            )}
            <a href={offer.imageUrl} target="_blank" rel="noreferrer"
              className="flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-semibold hover:bg-gray-50">
              <FileText size={16} /> Open image version
            </a>
            {!sendState?.sent && (
              <button type="button" onClick={() => doSend(Boolean(sendState?.dryRun))}
                className="flex w-full items-center gap-2 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-semibold hover:bg-gray-50">
                <Send size={16} />
                {sendState?.dryRun ? "Confirm — text it to the contact now" : "Text this offer to the contact"}
              </button>
            )}
            {sendState?.dryRun && !sendState?.sent && (
              <div className="rounded-lg bg-gray-100 p-3 text-xs text-gray-600">
                <div className="font-semibold text-gray-800">Dry run — nothing sent yet.</div>
                <p className="mt-1 whitespace-pre-wrap">{sendState.message}</p>
                {!sendState.sendsEnabled && (
                  <p className="mt-1 text-amber-700">Live sends are disabled on the server (CARD_SENDS_ENABLED).</p>
                )}
              </div>
            )}
            {sendState?.sent && (
              <div className="rounded-lg bg-emerald-100 px-3 py-2 text-sm font-medium text-emerald-800">Sent ✓</div>
            )}
            {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
            <button type="button" onClick={() => { setResult(null); setSendState(null); setError(""); }}
              className="text-sm font-medium text-gray-500 underline hover:text-gray-800">
              Start another offer
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ContactPicker
        selected={contact} onSelect={selectContact}
        newContact={newContact} setNewContact={setNewContact}
        mode={mode} setMode={setMode}
      />

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">Property</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Property address">
              <AddressInput
                value={inputs.address}
                onChange={(v) => setInputs((s) => ({ ...s, address: v }))}
                placeholder="412 Maple Ave SW, Tacoma, WA 98466"
              />
            </Field>
            {inputs.address.trim() && (
              <a href={zillowUrl(inputs.address)} target="_blank" rel="noreferrer"
                className="mt-1 inline-block text-xs font-medium text-blue-700 underline hover:text-blue-900">
                View on Zillow ↗
              </a>
            )}
          </div>
          <Field label="After-repair value / ARV ($)">
            <input className={INPUT_CLS} inputMode="numeric" value={inputs.arv} onChange={setMoney("arv")} placeholder="from comps below" />
          </Field>
          <Field label="Estimated repairs ($)">
            <input className={INPUT_CLS} inputMode="numeric" value={inputs.repairs} onChange={setMoney("repairs")} placeholder="from scope below" />
          </Field>
          <Field label="Asking price ($, optional)">
            <input className={INPUT_CLS} inputMode="numeric" value={inputs.askingPrice} onChange={setMoney("askingPrice")} placeholder="for %-of-asking context" />
          </Field>
        </div>
      </div>

      <CompsPane
        address={inputs.address}
        sqft={subjectSqft}
        setSqft={setSubjectSqft}
        onSubjectInfo={setSubjectInfo}
        onUseArv={(arv) => setInputs((s) => ({ ...s, arv: Number(arv).toLocaleString("en-US") }))}
      />

      <RehabPane
        sqft={subjectSqft}
        beds={Number(subjectInfo?.beds) || 0}
        baths={Number(subjectInfo?.baths) || 0}
        address={inputs.address}
        initialState={rehabInit}
        onStateChange={(s) => { rehabStateRef.current = s; }}
        onApply={(total, lines) => {
          setInputs((s) => ({ ...s, repairs: Number(total).toLocaleString("en-US") }));
          setScope(lines);
        }}
      />

      <OfferCards calc={calc} />

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={!calc || previewing} onClick={doPreview}
          className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-semibold disabled:opacity-40 hover:bg-gray-50">
          {previewing ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />}
          Preview document
        </button>
        <button type="button" disabled={!canCreate || creating} onClick={doCreate}
          className="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40 hover:bg-gray-800">
          {creating ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
          Create offer & attach to contact
        </button>
        <button type="button" disabled={savingDraft} onClick={doSaveDraft}
          className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-semibold disabled:opacity-40 hover:bg-gray-50">
          {savingDraft ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
          {draftSaved ? "Draft saved ✓" : draftId ? "Update draft" : "Save draft"}
        </button>
        {!canCreate && calc && (
          <span className="text-xs text-gray-400">Pick a contact (or enter a phone) to create the offer.</span>
        )}
      </div>

      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {preview && (
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-bold">Document preview</h2>
            <button type="button" onClick={() => setPreview(null)} className="rounded p-1 text-gray-400 hover:bg-gray-100">
              <X size={16} />
            </button>
          </div>
          <img src={preview} alt="Offer document preview" className="mx-auto w-full max-w-lg rounded-lg border border-gray-200 shadow" />
        </div>
      )}
    </div>
  );
}
