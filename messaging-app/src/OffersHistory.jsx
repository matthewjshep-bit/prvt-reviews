// OffersHistory.jsx — every offer created for this location: who, what,
// the numbers, and links to the generated documents.

import React, { useEffect, useState } from "react";
import { FileText, Loader2, Trash2 } from "lucide-react";
import { fmtMoney } from "@shared/offer-calc.js";
import { deleteOffer, listOffers } from "./api.js";

export default function OffersHistory() {
  const [offers, setOffers] = useState(null);
  const [error, setError] = useState("");

  const load = () =>
    listOffers({ limit: 100 })
      .then(setOffers)
      .catch((e) => setError(e.message));

  useEffect(() => { load(); }, []);

  async function remove(id) {
    if (!window.confirm("Delete this offer record? The generated documents stay at their URLs.")) return;
    try {
      await deleteOffer(id);
      setOffers((list) => list.filter((o) => o.id !== id));
    } catch (e) { setError(e.message); }
  }

  if (error) return <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>;
  if (!offers) return <div className="flex justify-center p-10"><Loader2 className="animate-spin text-gray-400" /></div>;
  if (!offers.length) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-400">
        No offers yet — create your first one from the New Offer tab.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
            <th className="px-4 py-2.5">Date</th>
            <th className="px-4 py-2.5">Contact</th>
            <th className="px-4 py-2.5">Property</th>
            <th className="px-4 py-2.5 text-right">Cash offer</th>
            <th className="px-4 py-2.5">Document</th>
            <th className="px-4 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {offers.map((o) => (
            <tr key={o.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
              <td className="whitespace-nowrap px-4 py-2.5 text-gray-500">
                {(o.createdAt || "").slice(0, 10)}
              </td>
              <td className="px-4 py-2.5 font-medium">{o.contactName || o.contactId || "—"}</td>
              <td className="max-w-[16rem] truncate px-4 py-2.5">{o.address || "—"}</td>
              <td className="whitespace-nowrap px-4 py-2.5 text-right font-semibold">{fmtMoney(o.cashAmount)}</td>
              <td className="whitespace-nowrap px-4 py-2.5">
                <span className="flex gap-2">
                  {o.pdfUrl && (
                    <a href={o.pdfUrl} target="_blank" rel="noreferrer"
                      className="inline-flex items-center gap-1 text-gray-600 underline hover:text-gray-900">
                      <FileText size={14} /> PDF
                    </a>
                  )}
                  {o.imageUrl && (
                    <a href={o.imageUrl} target="_blank" rel="noreferrer"
                      className="inline-flex items-center gap-1 text-gray-600 underline hover:text-gray-900">
                      <FileText size={14} /> Image
                    </a>
                  )}
                </span>
              </td>
              <td className="px-4 py-2.5 text-right">
                <button type="button" onClick={() => remove(o.id)}
                  className="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600" title="Delete offer">
                  <Trash2 size={15} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
