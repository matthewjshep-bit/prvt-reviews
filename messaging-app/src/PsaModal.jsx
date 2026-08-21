// PsaModal.jsx — fill in the blanks of the Washington Purchase & Sale
// Agreement for one offer and render it as a text PDF on the server.
//
// This is the document that answers "that's an LOI, not a real offer": a
// branded Offer Summary, twenty-two numbered sections, Addendum A, and — on a
// short sale — Addendum B with every timeline keyed to lienholder approval.
// The clause language is authored and locked (its section numbers are
// cross-referenced inside the document); only these fill-ins vary per deal.
//
// Standing values — buyer entity, title company, lender, the exhibit files —
// come from Settings → Purchase & sale agreement. Regenerating rehydrates the
// last-used fields from offer.psa.fields.

import React, { useState } from "react";
import { FileSignature, Loader2, X } from "lucide-react";
import { generatePsa } from "./api.js";

const INPUT_CLS =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none";
const LABEL_CLS = "mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500";

const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const inDays = (n) => ymd(new Date(Date.now() + n * 24 * 3600 * 1000));

// Defined outside the modal so the input keeps its identity (and focus)
// across parent re-renders.
function Field({ label, value, onChange, type = "text", span, placeholder, hint }) {
  return (
    <div className={span ? "sm:col-span-2" : ""}>
      <span className={LABEL_CLS}>{label}</span>
      <input type={type} className={INPUT_CLS} value={value} onChange={onChange} placeholder={placeholder} />
      {hint && <div className="mt-1 text-[11px] text-slate-500">{hint}</div>}
    </div>
  );
}

export default function PsaModal({ offer, settings, onClose, onGenerated }) {
  const saved = offer.psa?.fields || null;
  const psa = settings?.psa || {};
  const company = settings?.company || {};
  // The offer's own expiry, chosen when the letter was built, so the agreement
  // and the letter can't quietly disagree about when the offer dies.
  const offerExpires = offer.snapshot?.offerExpires || offer.calc?.settings?.offerExpires || "";

  const [fields, setFields] = useState(() => ({
    mode: saved?.mode || "standard",
    effectiveDate: saved?.effectiveDate || ymd(new Date()),
    buyerEntity: saved?.buyerEntity || psa.buyerEntity || company.name || "",
    buyerEntityState: saved?.buyerEntityState || psa.buyerEntityState || "Washington",
    sellerName: saved?.sellerName || "",
    address: saved?.address || offer.address || "",
    apn: saved?.apn || "",
    legalDescription: saved?.legalDescription || "",
    county: saved?.county || "",
    price: saved?.price || offer.cashAmount || "",
    earnestMoney: saved?.earnestMoney ?? offer.calc?.settings?.earnestMoney ?? "",
    feasibilityDays: saved?.feasibilityDays ?? psa.feasibilityDays ?? 10,
    closingDays: saved?.closingDays ?? psa.closingDays ?? 21,
    closingDate: saved?.closingDate || inDays(30),
    backstopDate: saved?.backstopDate || inDays(90),
    titleCompany: saved?.titleCompany || psa.titleCompany || "",
    titleOfficer: saved?.titleOfficer || psa.titleOfficer || "",
    titlePhone: saved?.titlePhone || psa.titlePhone || "",
    lenderName: saved?.lenderName || psa.lenderName || "",
    approvalDeadline: saved?.approvalDeadline || inDays(60),
    counterDays: saved?.counterDays ?? psa.counterDays ?? 5,
    offerExpires: saved?.offerExpires || offerExpires || inDays(7),
    offerExpiresTime: saved?.offerExpiresTime || "5:00 PM",
    additionalTerms: saved?.additionalTerms || "",
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pdfUrl, setPdfUrl] = useState(offer.psaPdfUrl || "");

  const patch = (k) => (e) => setFields((f) => ({ ...f, [k]: e.target.value }));
  const shortSale = fields.mode === "short_sale";

  async function doGenerate() {
    setError("");
    setBusy(true);
    try {
      const r = await generatePsa(offer.id, fields);
      setPdfUrl(r.offer.psaPdfUrl);
      onGenerated?.(r.offer);
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  }

  const ModeTab = ({ value, label, sub }) => (
    <button type="button" onClick={() => setFields((f) => ({ ...f, mode: value }))}
      className={`flex-1 rounded-lg border px-3 py-2 text-left transition ${
        fields.mode === value
          ? "border-blue-600 bg-blue-50 text-blue-900"
          : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
      }`}>
      <div className="text-sm font-semibold">{label}</div>
      <div className="text-[11px] leading-tight opacity-80">{sub}</div>
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <div className="text-lg font-bold">Offer purchase &amp; sale agreement</div>
            <div className="text-sm text-slate-500">
              {offer.address || "Offer"} · {offer.contactName || offer.contactId}
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1.5 text-slate-400 hover:bg-slate-100">
            <X size={18} />
          </button>
        </div>

        {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        <div className="mb-4 flex gap-2">
          <ModeTab value="standard" label="Standard sale"
            sub="Timelines run from mutual acceptance" />
          <ModeTab value="short_sale" label="Short sale"
            sub="Timelines run from lienholder approval · adds Addendum B" />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Effective date" type="date" value={fields.effectiveDate} onChange={patch("effectiveDate")} />
          <Field label="Buyer entity (you)" value={fields.buyerEntity} onChange={patch("buyerEntity")}
            placeholder="Your LLC — signs and/or assigns" />
          <Field label="Seller name(s)" value={fields.sellerName} onChange={patch("sellerName")}
            placeholder="As shown on title" />
          <Field label="Property address" value={fields.address} onChange={patch("address")} />
          <Field label="Tax parcel / APN" value={fields.apn} onChange={patch("apn")} />
          <Field label="County" value={fields.county} onChange={patch("county")} placeholder="Pierce" />
          <Field label="Purchase price" value={fields.price} onChange={patch("price")} placeholder="$" />
          <Field label="Earnest money" value={fields.earnestMoney} onChange={patch("earnestMoney")} placeholder="$" />
          <Field label="Feasibility period (days)" type="number" value={fields.feasibilityDays} onChange={patch("feasibilityDays")}
            hint={shortSale ? "Runs from written lienholder approval" : "Runs from mutual acceptance"} />
          {shortSale ? (
            <Field label="Days to close after approval" type="number" value={fields.closingDays} onChange={patch("closingDays")} />
          ) : (
            <Field label="Closing on or before" type="date" value={fields.closingDate} onChange={patch("closingDate")} />
          )}
          <Field label="Title / escrow company" value={fields.titleCompany} onChange={patch("titleCompany")}
            placeholder="left blank prints a fill-in line" />
          <Field label="Escrow officer" value={fields.titleOfficer} onChange={patch("titleOfficer")} />
          <Field label="Escrow phone" value={fields.titlePhone} onChange={patch("titlePhone")} />
          <Field label="Offer expires" type="date" value={fields.offerExpires} onChange={patch("offerExpires")} />
          <Field label="Expires at (Pacific)" value={fields.offerExpiresTime} onChange={patch("offerExpiresTime")}
            placeholder="5:00 PM" />

          <div className="sm:col-span-2">
            <span className={LABEL_CLS}>Legal description</span>
            <textarea rows={2} className={INPUT_CLS} value={fields.legalDescription} onChange={patch("legalDescription")}
              placeholder="Lot, block, plat name, volume/page and county — or full metes-and-bounds. From the closing agent or county records." />
            <div className="mt-1 text-[11px] text-slate-500">
              Leave blank to print a fill-in line — § 2 lets the closing agent insert the description of record.
            </div>
          </div>
        </div>

        {shortSale && (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-amber-800">
              Short sale — Addendum B
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Hard money lender" value={fields.lenderName} onChange={patch("lenderName")}
                hint="Named on the proof-of-funds exhibit" />
              <Field label="Lienholder approval deadline" type="date" value={fields.approvalDeadline} onChange={patch("approvalDeadline")} />
              <Field label="Backstop closing date" type="date" value={fields.backstopDate} onChange={patch("backstopDate")}
                hint="Closing is the later of this or approval + closing days" />
              <Field label="Days to accept changed terms" type="number" value={fields.counterDays} onChange={patch("counterDays")}
                hint="Lienholder counteroffers under B-4" />
            </div>
          </div>
        )}

        <div className="mt-3">
          <span className={LABEL_CLS}>Additional terms</span>
          <textarea rows={2} className={INPUT_CLS} value={fields.additionalTerms} onChange={patch("additionalTerms")}
            placeholder="Optional — printed unnumbered after § 22 and controlling over conflicting sections" />
        </div>

        <div className="mt-3 text-xs text-slate-500">
          Empty fields print as blank lines to fill in by hand. The earnest money check and proof-of-funds
          letter attach as exhibits when they're set in Settings → Purchase &amp; sale agreement.
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" onClick={doGenerate} disabled={busy}
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <FileSignature size={16} />}
            {pdfUrl ? "Regenerate offer PSA" : "Generate offer PSA"}
          </button>
          {pdfUrl && !busy && (
            <a href={pdfUrl} target="_blank" rel="noreferrer"
              className="flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold hover:bg-slate-50">
              <FileSignature size={16} /> Open offer PSA (PDF)
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
