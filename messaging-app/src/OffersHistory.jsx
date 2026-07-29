// OffersHistory.jsx — every offer created for this location. The contact links
// to the GHL contact record; clicking a row opens the full offer detail
// (document, all three options, attach status).

import React, { useEffect, useState } from "react";
import { ExternalLink, FileText, Loader2, Pencil, Search, Send, Trash2, X } from "lucide-react";
import { fmtMoney } from "@shared/offer-calc.js";
import { deleteOffer, ghlContactUrl, listOffers, zillowUrl } from "./api.js";
import SendModal, { CHANNEL_LABELS } from "./SendModal.jsx";

function AttachStatus({ offer }) {
  if (offer.status === "draft") {
    return <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-800">Draft</span>;
  }
  if (!offer.ghl) return <span className="text-gray-400">—</span>;
  const ok = offer.ghl.fields && offer.ghl.note && offer.ghl.tag;
  return ok ? (
    <span className="font-medium text-emerald-700">✓ contact</span>
  ) : (
    <span className="font-medium text-amber-700" title={(offer.warnings || []).join("\n")}>
      ⚠ partial
    </span>
  );
}

// Compact "what went out" label for a sends entry: "text+email · 07-29".
const sendLabel = (s) =>
  `${s.channels.map((c) => CHANNEL_LABELS[c] || c).join("+")} · ${(s.ts || "").slice(5, 10)}`;

function SentBadge({ offer }) {
  const sends = offer.sends || [];
  if (!sends.length) return null;
  const last = sends[sends.length - 1];
  const failed = Object.values(last.results || {}).some((r) => !r.ok);
  const cls = failed ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800";
  const title = sends
    .map((s) => `${(s.ts || "").slice(0, 16).replace("T", " ")} — ${s.channels
      .map((c) => `${CHANNEL_LABELS[c] || c}${s.results?.[c]?.ok === false ? ` (failed: ${s.results[c].error})` : ""}`)
      .join(", ")} · docs: ${(s.docs || []).join(", ")}`)
    .join("\n");
  return (
    <span className={`ml-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`} title={title}>
      {failed ? "⚠ " : ""}Sent {sendLabel(last)}
    </span>
  );
}

function OfferDetail({ offer, onClose, onEdit, onSend }) {
  const { cash, sellerFinance: sf, leaseOption: lo } = offer.calc?.offers || {};
  const Row = ({ label, value }) => (
    <div className="flex justify-between gap-4 text-sm">
      <span className="text-gray-500">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8" onClick={onClose}>
      <div className="w-full max-w-3xl rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <div className="text-lg font-bold">
              {offer.address || "Offer"}
              {offer.address && (
                <a href={zillowUrl(offer.address)} target="_blank" rel="noreferrer"
                  className="ml-2 align-middle text-xs font-medium text-blue-700 underline hover:text-blue-900">
                  Zillow ↗
                </a>
              )}
            </div>
            <div className="text-sm text-gray-500">
              {offer.dateLabel} ·{" "}
              <a href={ghlContactUrl(offer.contactId)} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1 text-gray-700 underline hover:text-gray-900">
                {offer.contactName || offer.contactId} <ExternalLink size={12} />
              </a>{" "}
              · <AttachStatus offer={offer} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            {offer.contactId && (
              <button type="button" onClick={() => onSend?.(offer)}
                className="flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-gray-800">
                <Send size={14} /> Send
              </button>
            )}
            <button type="button" onClick={() => onEdit?.(offer)}
              className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-semibold hover:bg-gray-50">
              <Pencil size={14} /> Edit offer
            </button>
            <button type="button" onClick={onClose} className="rounded p-1.5 text-gray-400 hover:bg-gray-100">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <img src={offer.imageUrl} alt="Offer document" className="w-full rounded-xl border border-gray-200 shadow-sm" />
          <div className="space-y-4">
            {cash && (
              <div className="rounded-xl border border-amber-300 bg-amber-50 p-3">
                <div className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Option A — Cash</div>
                <div className="text-xl font-black">{fmtMoney(cash.amount)}</div>
              </div>
            )}
            {sf && (
              <div className="rounded-xl border border-gray-200 p-3">
                <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-gray-500">Option B — Seller finance</div>
                <Row label="Price" value={fmtMoney(sf.price)} />
                <Row label="Down" value={fmtMoney(sf.down)} />
                <Row label="Monthly" value={`${fmtMoney(sf.monthly)} × ${sf.termYears} yrs${sf.annualRatePct ? ` @ ${sf.annualRatePct}%` : " @ 0%"}`} />
                {sf.balloon > 0 && <Row label="Balloon" value={`${fmtMoney(sf.balloon)} @ yr ${sf.balloonYears}`} />}
              </div>
            )}
            {lo && (
              <div className="rounded-xl border border-gray-200 p-3">
                <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-gray-500">Option C — Lease option</div>
                <Row label="Price" value={fmtMoney(lo.price)} />
                <Row label="Option fee" value={fmtMoney(lo.optionFee)} />
                <Row label="Monthly" value={`${fmtMoney(lo.monthly)} × ${lo.termMonths} mo`} />
              </div>
            )}
            {(offer.scope || []).length > 0 && (
              <div className="rounded-xl border border-gray-200 p-3">
                <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-gray-500">Rehab scope</div>
                {offer.scope.map((s, i) => (
                  <div key={i} className="flex justify-between gap-4 text-sm">
                    <span className="text-gray-600">{s.label}</span>
                    <span className="font-medium tabular-nums">{fmtMoney(s.cost)}</span>
                  </div>
                ))}
              </div>
            )}
            {(offer.warnings || []).length > 0 && (
              <ul className="list-inside list-disc rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
                {offer.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}
            {(offer.sends || []).length > 0 && (
              <div className="rounded-xl border border-gray-200 p-3">
                <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-gray-500">Send history</div>
                {offer.sends.map((s, i) => (
                  <div key={i} className="flex items-start justify-between gap-3 py-0.5 text-xs">
                    <span className="whitespace-nowrap text-gray-500">{(s.ts || "").slice(0, 16).replace("T", " ")}</span>
                    <span className="text-right">
                      {s.channels.map((c) => (
                        <span key={c} className={s.results?.[c]?.ok === false ? "text-red-600" : "text-emerald-700"}
                          title={s.results?.[c]?.error || ""}>
                          {CHANNEL_LABELS[c] || c}{s.results?.[c]?.ok === false ? " ✗" : " ✓"}{" "}
                        </span>
                      ))}
                      <span className="text-gray-500">· {(s.docs || []).join(", ")}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <a href={offer.pdfUrl} target="_blank" rel="noreferrer"
                className="flex items-center gap-2 rounded-lg bg-gray-900 px-3.5 py-2 text-sm font-semibold text-white hover:bg-gray-800">
                <FileText size={15} /> Offer PDF
              </a>
              {offer.scopePdfUrl && (
                <a href={offer.scopePdfUrl} target="_blank" rel="noreferrer"
                  className="flex items-center gap-2 rounded-lg border border-gray-300 px-3.5 py-2 text-sm font-semibold hover:bg-gray-50">
                  <FileText size={15} /> Rehab SOW
                </a>
              )}
              {offer.compsPdfUrl && (
                <a href={offer.compsPdfUrl} target="_blank" rel="noreferrer"
                  className="flex items-center gap-2 rounded-lg border border-gray-300 px-3.5 py-2 text-sm font-semibold hover:bg-gray-50">
                  <FileText size={15} /> Comps PDF
                </a>
              )}
              <a href={offer.imageUrl} target="_blank" rel="noreferrer"
                className="flex items-center gap-2 rounded-lg border border-gray-300 px-3.5 py-2 text-sm font-semibold hover:bg-gray-50">
                <FileText size={15} /> Image
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function OffersHistory({ onEdit }) {
  const [offers, setOffers] = useState(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);
  const [sending, setSending] = useState(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    listOffers({ limit: 100 })
      .then(setOffers)
      .catch((e) => setError(e.message));
  }, []);

  async function remove(id) {
    if (!window.confirm("Delete this offer record and its documents?")) return;
    try {
      await deleteOffer(id);
      setOffers((list) => list.filter((o) => o.id !== id));
    } catch (e) { setError(e.message); }
  }

  // A live send appends to offer.sends — refresh every copy of the row we hold.
  function handleSent(id, sends) {
    const patch = (o) => (o && o.id === id ? { ...o, sends } : o);
    setOffers((list) => (list || []).map(patch));
    setSelected(patch);
    setSending(patch);
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

  const needle = q.trim().toLowerCase();
  const shown = !needle
    ? offers
    : offers.filter((o) =>
        [
          o.contactName,
          o.address,
          (o.createdAt || "").slice(0, 10),
          o.cashAmount != null ? String(o.cashAmount) : "",
          o.cashAmount != null ? fmtMoney(o.cashAmount) : "",
        ].some((v) => (v || "").toLowerCase().includes(needle)));

  return (
    <>
      <div className="mb-3 flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2">
        <Search size={15} className="text-gray-400" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by contact, address, amount, or date…"
          className="w-full text-sm focus:outline-none"
        />
        {q && (
          <button type="button" onClick={() => setQ("")} className="rounded p-0.5 text-gray-400 hover:bg-gray-100">
            <X size={14} />
          </button>
        )}
      </div>
      {shown.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-400">
          No offers match "{q.trim()}".
        </div>
      ) : (
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
              <th className="px-4 py-2.5">Date</th>
              <th className="px-4 py-2.5">Contact</th>
              <th className="px-4 py-2.5">Property</th>
              <th className="px-4 py-2.5 text-right">Cash offer</th>
              <th className="px-4 py-2.5">Document</th>
              <th className="px-4 py-2.5">Attached</th>
              <th className="sticky right-0 bg-white px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {shown.map((o) => (
              <tr key={o.id}
                onClick={() => (o.status === "draft" ? onEdit?.(o) : setSelected(o))}
                className="group cursor-pointer border-b border-gray-100 last:border-0 hover:bg-gray-50">
                <td className="whitespace-nowrap px-4 py-2.5 text-gray-500">
                  {(o.createdAt || "").slice(0, 10)}
                </td>
                <td className="px-4 py-2.5">
                  {o.contactId ? (
                    <a href={ghlContactUrl(o.contactId)} target="_blank" rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-1 font-medium underline decoration-gray-300 underline-offset-2 hover:text-gray-900"
                      title="Open contact in GHL">
                      {o.contactName || o.contactId} <ExternalLink size={12} className="text-gray-400" />
                    </a>
                  ) : (
                    <span className="font-medium">{o.contactName || "—"}</span>
                  )}
                </td>
                <td className="max-w-[13rem] truncate px-4 py-2.5">{o.address || "—"}</td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right font-semibold">
                  {o.cashAmount != null ? fmtMoney(o.cashAmount) : "—"}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                  <span className="flex gap-2 text-gray-600">
                    {o.pdfUrl && (
                      <a href={o.pdfUrl} target="_blank" rel="noreferrer" className="underline hover:text-gray-900">PDF</a>
                    )}
                    {o.scopePdfUrl && (
                      <a href={o.scopePdfUrl} target="_blank" rel="noreferrer" className="underline hover:text-gray-900">SOW</a>
                    )}
                    {o.compsPdfUrl && (
                      <a href={o.compsPdfUrl} target="_blank" rel="noreferrer" className="underline hover:text-gray-900">Comps</a>
                    )}
                    {o.imageUrl && (
                      <a href={o.imageUrl} target="_blank" rel="noreferrer" className="underline hover:text-gray-900">Image</a>
                    )}
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-xs">
                  <AttachStatus offer={o} />
                  <SentBadge offer={o} />
                </td>
                <td className="sticky right-0 whitespace-nowrap bg-white px-4 py-2.5 text-right group-hover:bg-gray-50" onClick={(e) => e.stopPropagation()}>
                  {o.status !== "draft" && o.contactId && (
                    <button type="button" onClick={() => setSending(o)}
                      className="mr-1 inline-flex items-center gap-1 rounded-lg border border-gray-300 px-2.5 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                      title="Text or email the offer documents">
                      <Send size={13} /> Send
                    </button>
                  )}
                  <button type="button" onClick={() => onEdit?.(o)}
                    className="mr-1 inline-flex items-center gap-1 rounded-lg border border-gray-300 px-2.5 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                    title={o.status === "draft" ? "Continue editing draft" : "Reopen as a new working copy"}>
                    <Pencil size={13} /> Edit
                  </button>
                  <button type="button" onClick={() => remove(o.id)}
                    className="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600" title="Delete">
                    <Trash2 size={15} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
      {selected && <OfferDetail offer={selected} onClose={() => setSelected(null)}
        onEdit={(o) => { setSelected(null); onEdit?.(o); }}
        onSend={(o) => setSending(o)} />}
      {sending && <SendModal offer={sending} onClose={() => setSending(null)} onSent={handleSent} />}
    </>
  );
}
