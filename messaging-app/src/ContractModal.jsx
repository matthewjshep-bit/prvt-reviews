// ContractModal.jsx — fill in the blanks of the Purchase & Sale contract for
// one offer and render it as a text PDF on the server. Only the fill-ins live
// here; clause wording is edited in Settings → Purchase & sale contract.
// Regenerating rehydrates the last-used fields from offer.contract.fields.

import React, { useState } from "react";
import { FileText, Loader2, X } from "lucide-react";
import { generateContract } from "./api.js";

const INPUT_CLS =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none";
const LABEL_CLS = "mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500";

const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Defined outside the modal so the input keeps its identity (and focus)
// across parent re-renders.
function Field({ label, value, onChange, type = "text", span, placeholder }) {
  return (
    <div className={span ? "sm:col-span-2" : ""}>
      <span className={LABEL_CLS}>{label}</span>
      <input type={type} className={INPUT_CLS} value={value} onChange={onChange} placeholder={placeholder} />
    </div>
  );
}

export default function ContractModal({ offer, settings, onClose, onGenerated }) {
  const saved = offer.contract?.fields || null;
  const [fields, setFields] = useState(() => ({
    effectiveDate: saved?.effectiveDate || ymd(new Date()),
    buyerName: saved?.buyerName || settings?.company?.name || settings?.company?.signer || "",
    sellerName: saved?.sellerName || offer.contactName || "",
    address: saved?.address || offer.address || "",
    price: saved?.price || offer.cashAmount || "",
    earnestMoney: saved?.earnestMoney ?? offer.calc?.settings?.earnestMoney ?? "",
    inspectionDays: saved?.inspectionDays || 10,
    closingDate: saved?.closingDate || ymd(new Date(Date.now() + 30 * 24 * 3600 * 1000)),
    titleCompany: saved?.titleCompany || "",
    specialProvisions: saved?.specialProvisions || "",
    state: saved?.state || "",
    county: saved?.county || "",
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pdfUrl, setPdfUrl] = useState(offer.contractPdfUrl || "");

  const patch = (k) => (e) => setFields((f) => ({ ...f, [k]: e.target.value }));

  async function doGenerate() {
    setError("");
    setBusy(true);
    try {
      const r = await generateContract(offer.id, fields);
      setPdfUrl(r.offer.contractPdfUrl);
      onGenerated?.(r.offer);
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <div className="text-lg font-bold">Purchase &amp; sale contract</div>
            <div className="text-sm text-slate-500">
              {offer.address || "Offer"} · {offer.contactName || offer.contactId}
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1.5 text-slate-400 hover:bg-slate-100">
            <X size={18} />
          </button>
        </div>

        {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Effective date" type="date" value={fields.effectiveDate} onChange={patch("effectiveDate")} />
          <Field label="Buyer (you / your entity)" value={fields.buyerName} onChange={patch("buyerName")} placeholder="Your LLC and/or assigns" />
          <Field label="Seller" value={fields.sellerName} onChange={patch("sellerName")} />
          <Field label="Property address" value={fields.address} onChange={patch("address")} />
          <Field label="Purchase price" value={fields.price} onChange={patch("price")} placeholder="$" />
          <Field label="Earnest money" value={fields.earnestMoney} onChange={patch("earnestMoney")} placeholder="$" />
          <Field label="Inspection period (days)" type="number" value={fields.inspectionDays} onChange={patch("inspectionDays")} />
          <Field label="Closing on or before" type="date" value={fields.closingDate} onChange={patch("closingDate")} />
          <Field label="Title / escrow company" value={fields.titleCompany} onChange={patch("titleCompany")} placeholder="left blank prints a fill-in line" />
          <Field label="State" value={fields.state} onChange={patch("state")} placeholder="Washington" />
          <Field label="County" value={fields.county} onChange={patch("county")} placeholder="Pierce" />
          <div className="sm:col-span-2">
            <span className={LABEL_CLS}>Special provisions</span>
            <textarea rows={3} className={INPUT_CLS} value={fields.specialProvisions} onChange={patch("specialProvisions")}
              placeholder="Optional extra terms — printed as the Special Provisions clause" />
          </div>
        </div>

        <div className="mt-2 text-xs text-slate-500">
          Empty fields print as blank lines to fill in by hand. Clause wording is edited in Settings → Purchase &amp; sale contract.
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" onClick={doGenerate} disabled={busy}
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />}
            {pdfUrl ? "Regenerate contract" : "Generate contract"}
          </button>
          {pdfUrl && !busy && (
            <a href={pdfUrl} target="_blank" rel="noreferrer"
              className="flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold hover:bg-slate-50">
              <FileText size={16} /> Open contract PDF
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
