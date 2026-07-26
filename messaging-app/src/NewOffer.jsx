// NewOffer.jsx — the core flow: contact → property numbers → three live
// offers → generate the document and attach everything to the GHL contact.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, FileText, Loader2, Search, Send, X } from "lucide-react";
import { calculateOffers, fmtMoney } from "@shared/offer-calc.js";
import { createOffer, previewDocument, searchContacts, sendOffer } from "./api.js";

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

/* ---------------- offer option cards ---------------- */

function OptionCard({ tag, title, amount, lines, accent }) {
  return (
    <div className={`rounded-xl border p-4 ${accent ? "border-amber-400 bg-amber-50" : "border-gray-200 bg-white"}`}>
      <div className="text-[11px] font-bold uppercase tracking-wider text-gray-500">{tag}</div>
      <div className="mt-0.5 text-sm font-semibold text-gray-700">{title}</div>
      <div className="mt-1 text-2xl font-black tracking-tight">{amount}</div>
      <ul className="mt-2 space-y-1 text-xs text-gray-600">
        {lines.map((l, i) => <li key={i}>{l}</li>)}
      </ul>
    </div>
  );
}

function OfferCards({ calc }) {
  if (!calc) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400">
        Enter an asking price to see the three offers.
      </div>
    );
  }
  const { cash, sellerFinance: sf, leaseOption: lo } = calc.offers;
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <OptionCard
        tag="Option A" title="All cash" amount={fmtMoney(cash.amount)} accent
        lines={[
          `${cash.pctOfArv}% of ARV minus repairs`,
          `≈ ${cash.pctOfAsking}% of asking`,
          `As-is · close in ~${cash.closeDays} days`,
        ]}
      />
      <OptionCard
        tag="Option B" title="Seller finance" amount={fmtMoney(sf.price)}
        lines={[
          `${fmtMoney(sf.down)} down · ${fmtMoney(sf.monthly)}/mo`,
          sf.annualRatePct > 0 ? `${sf.annualRatePct}% over ${sf.termYears} yrs` : `0% interest · ${sf.termYears} yrs`,
          sf.balloon > 0 ? `Balloon ${fmtMoney(sf.balloon)} @ yr ${sf.balloonYears}` : `Total to seller ${fmtMoney(sf.totalToSeller)}`,
        ]}
      />
      {lo ? (
        <OptionCard
          tag="Option C" title="Lease option" amount={fmtMoney(lo.price)}
          lines={[
            `${fmtMoney(lo.optionFee)} option fee`,
            `${fmtMoney(lo.monthly)}/mo · ${lo.termMonths} months`,
            `${lo.rentCreditPct}% rent credit (${fmtMoney(lo.monthlyCredit)}/mo)`,
          ]}
        />
      ) : (
        <div className="rounded-xl border border-dashed border-gray-300 p-4 text-xs text-gray-400">
          <div className="font-bold uppercase tracking-wider">Option C</div>
          Add a monthly rent estimate to include a lease-option offer.
        </div>
      )}
    </div>
  );
}

/* ---------------- main view ---------------- */

export default function NewOffer({ settings }) {
  const [mode, setMode] = useState("existing");
  const [contact, setContact] = useState(null);
  const [newContact, setNewContact] = useState({ name: "", phone: "" });
  const [inputs, setInputs] = useState({ address: "", askingPrice: "", arv: "", repairs: "", monthlyRent: "" });
  const [preview, setPreview] = useState(null);   // data-url image
  const [previewing, setPreviewing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState(null);     // { offer, ghl, warnings }
  const [error, setError] = useState("");
  const [sendState, setSendState] = useState(null); // { dryRun info } | { sent }

  const set = (k) => (e) => setInputs((s) => ({ ...s, [k]: e.target.value }));

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
      });
      setResult(r);
      setPreview(null);
    } catch (e) { setError(e.message); }
    setCreating(false);
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
        selected={contact} onSelect={setContact}
        newContact={newContact} setNewContact={setNewContact}
        mode={mode} setMode={setMode}
      />

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">Property</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Property address">
              <input className={INPUT_CLS} value={inputs.address} onChange={set("address")}
                placeholder="412 Maple Ave SW, Tacoma, WA 98466" />
            </Field>
          </div>
          <Field label="Asking price ($)">
            <input className={INPUT_CLS} inputMode="numeric" value={inputs.askingPrice} onChange={set("askingPrice")} placeholder="200,000" />
          </Field>
          <Field label="After-repair value / ARV ($)">
            <input className={INPUT_CLS} inputMode="numeric" value={inputs.arv} onChange={set("arv")} placeholder="defaults to asking" />
          </Field>
          <Field label="Estimated repairs ($)">
            <input className={INPUT_CLS} inputMode="numeric" value={inputs.repairs} onChange={set("repairs")} placeholder="0" />
          </Field>
          <Field label="Market rent ($/mo, optional)">
            <input className={INPUT_CLS} inputMode="numeric" value={inputs.monthlyRent} onChange={set("monthlyRent")} placeholder="enables lease option" />
          </Field>
        </div>
      </div>

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
