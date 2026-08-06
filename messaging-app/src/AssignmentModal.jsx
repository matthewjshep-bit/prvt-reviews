// AssignmentModal.jsx — fill in the blanks of the Assignment of Contract
// agreement for one offer and render it as a text PDF on the server. This is
// the DISPOSITIONS document: it goes to the end buyer (Assignee), never the
// seller. Clause wording is edited in Settings → Assignment contract.
// Regenerating rehydrates the last-used fields from offer.assignment.fields.

import React, { useState } from "react";
import { FileText, Loader2, X } from "lucide-react";
import { generateAssignment } from "./api.js";

const INPUT_CLS =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none";
const LABEL_CLS = "mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500";

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

export default function AssignmentModal({ offer, settings, onClose, onGenerated }) {
  const saved = offer.assignment?.fields || null;
  // Prefill the total price with contract price + assignment fee when both are
  // known (the assignment price is defined as exactly that sum).
  const contractPrice = Number(offer.contract?.fields?.price) || Number(offer.cashAmount) || 0;
  const fee = Number(offer.calc?.settings?.wholesaleFee ?? settings?.wholesaleFee) || 0;
  const [fields, setFields] = useState(() => ({
    effectiveDate: saved?.effectiveDate || ymd(new Date()),
    assignorName: saved?.assignorName || settings?.company?.signer || "",
    assignorCompany: saved?.assignorCompany || settings?.company?.name || "",
    assigneeName: saved?.assigneeName || "",
    assigneeCompany: saved?.assigneeCompany || "",
    address: saved?.address || offer.address || "",
    totalPrice: saved?.totalPrice || (contractPrice ? contractPrice + fee : ""),
    deposit: saved?.deposit || "",
    depositDueDate: saved?.depositDueDate || "",
    closingDate: saved?.closingDate || offer.contract?.fields?.closingDate || "",
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pdfUrl, setPdfUrl] = useState(offer.assignmentPdfUrl || "");

  const patch = (k) => (e) => setFields((f) => ({ ...f, [k]: e.target.value }));

  async function doGenerate() {
    setError("");
    setBusy(true);
    try {
      const r = await generateAssignment(offer.id, fields);
      setPdfUrl(r.offer.assignmentPdfUrl);
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
            <div className="text-lg font-bold">Assignment of contract</div>
            <div className="text-sm text-gray-500">
              {offer.address || "Offer"} · for the end buyer (dispositions) — not the seller
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1.5 text-gray-400 hover:bg-gray-100">
            <X size={18} />
          </button>
        </div>

        {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Agreement date" type="date" value={fields.effectiveDate} onChange={patch("effectiveDate")} />
          <Field label="Property address" value={fields.address} onChange={patch("address")} />
          <Field label="Assignor (you)" value={fields.assignorName} onChange={patch("assignorName")} placeholder="Your name" />
          <Field label="Assignor company" value={fields.assignorCompany} onChange={patch("assignorCompany")} placeholder="Your LLC" />
          <Field label="Assignee / buyer" value={fields.assigneeName} onChange={patch("assigneeName")} placeholder="End buyer's name" />
          <Field label="Assignee company" value={fields.assigneeCompany} onChange={patch("assigneeCompany")} placeholder="Buyer's LLC" />
          <Field label="Total purchase price" value={fields.totalPrice} onChange={patch("totalPrice")}
            placeholder="$ — contract price + your fee" />
          <Field label="Deposit (non-refundable)" value={fields.deposit} onChange={patch("deposit")} placeholder="$" />
          <Field label="Deposit due on or before" type="date" value={fields.depositDueDate} onChange={patch("depositDueDate")} />
          <Field label="Closing on or before" type="date" value={fields.closingDate} onChange={patch("closingDate")} />
        </div>

        <div className="mt-2 text-xs text-gray-500">
          The total price includes the original contract price plus your assignment fee. Empty fields print
          as blank lines to fill in by hand. Clause wording is edited in Settings → Assignment contract.
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" onClick={doGenerate} disabled={busy}
            className="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-60">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />}
            {pdfUrl ? "Regenerate assignment" : "Generate assignment"}
          </button>
          {pdfUrl && !busy && (
            <a href={pdfUrl} target="_blank" rel="noreferrer"
              className="flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-semibold hover:bg-gray-50">
              <FileText size={16} /> Open assignment PDF
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
