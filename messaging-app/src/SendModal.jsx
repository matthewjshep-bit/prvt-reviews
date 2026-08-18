// SendModal.jsx — send an offer's documents to the contact via text and/or
// email through GHL. Compose (pick channels + documents, edit the message) →
// Preview (server dry run shows exactly what each channel sends) → Confirm.
// Live sends still require CARD_SENDS_ENABLED=true on the server.

import React, { useEffect, useState } from "react";
import { ArrowLeft, Check, FileText, Link2, Loader2, Mail, MessageSquare, Send, X } from "lucide-react";
import { fmtMoney } from "@shared/offer-calc.js";
import { createOfferPage, getContactDetail, listOfferPages, sendOffer } from "./api.js";
import { defaultAgentNote } from "./OfferPageModal.jsx";
import { BTN } from "./ui.jsx";

const INPUT_CLS =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none";
const LABEL_CLS = "mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500";

const DOC_OPTIONS = [
  { key: "pdf", label: "Offer letter (PDF)", urlKey: "pdfUrl" },
  { key: "scope", label: "Rehab scope of work", urlKey: "scopePdfUrl" },
  { key: "comps", label: "Comparable sales analysis", urlKey: "compsPdfUrl" },
  { key: "netsheet", label: "Seller net comparison", urlKey: "netSheetPdfUrl" },
  { key: "image", label: "Offer letter (image)", urlKey: "imageUrl", caption: "goes out as the picture in the text" },
];

export const CHANNEL_LABELS = { sms: "text", email: "email" };

// The covering message: what this is, on what property, for how much. The
// offer page carries the reasoning — its own note does the talking there
// (defaultAgentNote in OfferPageModal.jsx) — so this one stays a delivery
// note. Kept in sync with the server's fallback in routes/offers.js.
export const defaultSendMessage = (offer) =>
  `Hi ${(offer.contactName || "").split(" ")[0] || "there"}, here's our written cash offer on ` +
  `${offer.address || "your property"} — ${fmtMoney(offer.cashAmount)}, as-is, close on your timeline ` +
  `(attached). Happy to answer any questions.`;

// The offer-page link rides at the end of the message rather than as a
// separate field, so the textarea stays the whole truth about what goes out —
// the operator can move it, wrap words around it, or delete it by hand.
const withLink = (text, url) =>
  !url || text.includes(url) ? text : `${text.replace(/\s+$/, "")}\n\n${url}`;
const withoutLink = (text, url) =>
  !url ? text : text.split(url).join("").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");

// "a", "a and b", "a, b and c" — the text-channel hint lists whatever actually
// travels with the message, and a stray "and" reads like a bug in a product
// whose whole job is writing to other people.
const sentenceList = (parts) =>
  parts.length < 2 ? parts[0] || "" : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

function ChannelChip({ icon: Icon, label, detail, active, disabled, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex-1 rounded-xl border px-3 py-2.5 text-left transition ${
        disabled
          ? "cursor-not-allowed border-slate-200 opacity-50"
          : active
          ? "border-blue-600 bg-blue-600 text-white"
          : "border-slate-300 hover:bg-slate-50"
      }`}
    >
      <span className="flex items-center gap-2 text-sm font-semibold">
        <Icon size={15} /> {label}
        {active && !disabled && <Check size={14} className="ml-auto" />}
      </span>
      <span className={`mt-0.5 block truncate text-xs ${active && !disabled ? "text-slate-300" : "text-slate-500"}`}>
        {detail}
      </span>
    </button>
  );
}

export default function SendModal({ offer, onClose, onSent }) {
  const available = DOC_OPTIONS.filter((d) => offer[d.urlKey]);

  const [contact, setContact] = useState(null);
  const [contactLoading, setContactLoading] = useState(true);
  const [contactErr, setContactErr] = useState("");
  const [channels, setChannels] = useState({ sms: true, email: false });
  const [docs, setDocs] = useState(() => new Set(available.filter((d) => d.key === "image" || d.key === "pdf").map((d) => d.key)));
  const [message, setMessage] = useState(() => defaultSendMessage(offer));
  // The agent-facing offer page — the "why" the message points at. Loaded
  // rather than assumed: most offers have one, and the ones that don't can
  // have it built from here rather than in another window.
  const [page, setPage] = useState(null);
  const [pageLoading, setPageLoading] = useState(true);
  const [pageBusy, setPageBusy] = useState(false);
  const [includeLink, setIncludeLink] = useState(true);
  const [emailSubject, setEmailSubject] = useState(`Cash offer — ${offer.address || "your property"}`);
  const [step, setStep] = useState("compose"); // compose | preview | sent
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(null); // dry-run response
  const [result, setResult] = useState(null); // live-send response

  useEffect(() => {
    // An offer has at most one page; only a live one has a link worth sending.
    listOfferPages(offer.id)
      .then((list) => {
        const p = (list || [])[0] || null;
        setPage(p);
        if (p?.status === "active" && p.shareLink) setMessage((m) => withLink(m, p.shareLink));
      })
      .catch(() => { /* the link is optional — never block the send on it */ })
      .finally(() => setPageLoading(false));
  }, [offer.id]);

  useEffect(() => {
    getContactDetail(offer.contactId)
      .then((c) => {
        setContact(c);
        // Steer toward a channel that can actually deliver.
        if (!c.phone) setChannels({ sms: false, email: Boolean(c.email) });
      })
      .catch((e) => setContactErr(e.message))
      .finally(() => setContactLoading(false));
  }, [offer.contactId]);

  const activeChannels = Object.keys(channels).filter((c) => channels[c]);
  const canPreview = activeChannels.length > 0 && docs.size > 0 && !busy;

  const pageLink = page?.status === "active" ? page.shareLink || "" : "";
  const toggleLink = () => {
    const next = !includeLink;
    setIncludeLink(next);
    setMessage((m) => (next ? withLink(m, pageLink) : withoutLink(m, pageLink)));
  };

  // No page yet: build one with the standard sections (everything but our
  // arithmetic) rather than sending the operator to another window mid-send.
  async function buildPage() {
    setPageBusy(true);
    setError("");
    try {
      const p = await createOfferPage(offer.id, { note: defaultAgentNote(offer.contactName) });
      // A build that comes back without a link is a failure wearing a success:
      // say so rather than leaving the operator clicking a button that does
      // nothing visible.
      if (!p?.shareLink) throw new Error("the page was built but came back without a link");
      setPage(p);
      setIncludeLink(true);
      setMessage((m) => withLink(m, p.shareLink));
    } catch (e) { setError(e.message); }
    setPageBusy(false);
  }

  const toggleDoc = (key) =>
    setDocs((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  async function doPreview() {
    setBusy(true);
    setError("");
    try {
      const r = await sendOffer(offer.id, {
        message, emailSubject, channels: activeChannels, docs: [...docs], dryRun: true,
      });
      setPreview(r);
      setStep("preview");
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  async function doConfirm() {
    setBusy(true);
    setError("");
    try {
      const r = await sendOffer(offer.id, {
        message, emailSubject, channels: activeChannels, docs: [...docs], dryRun: false,
      });
      if (r.sent !== true) {
        // Server gate downgraded the send to a dry run — never claim success.
        setPreview(r);
        setError("Live sends are disabled on the server (CARD_SENDS_ENABLED) — nothing was sent.");
      } else {
        setResult(r);
        setStep("sent");
        // A live send can also advance the offer's status server-side.
        onSent?.(offer.id, r.sends, { status: r.status, statusHistory: r.statusHistory });
      }
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  const previewBlocked = preview && preview.sendsEnabled === false;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <div className="text-lg font-bold">Send offer documents</div>
            <div className="text-sm text-slate-500">
              {offer.address || "Offer"} · {offer.contactName || offer.contactId} · {fmtMoney(offer.cashAmount)}
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1.5 text-slate-400 hover:bg-slate-100">
            <X size={18} />
          </button>
        </div>

        {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        {contactErr && step === "compose" && (
          <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Couldn't load contact details ({contactErr}) — you can still preview; delivery problems will show per channel.
          </div>
        )}

        {step === "compose" && (
          <div className="space-y-4">
            <div>
              <span className={LABEL_CLS}>Send via</span>
              {contactLoading ? (
                <div className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-3 text-sm text-slate-500">
                  <Loader2 size={15} className="animate-spin" /> Loading contact…
                </div>
              ) : (
                <div className="flex gap-2">
                  <ChannelChip
                    icon={MessageSquare}
                    label="Text"
                    detail={contact?.phone || "no phone on contact"}
                    active={channels.sms}
                    disabled={Boolean(contact) && !contact.phone}
                    onClick={() => setChannels((ch) => ({ ...ch, sms: !ch.sms }))}
                  />
                  <ChannelChip
                    icon={Mail}
                    label="Email"
                    detail={contact?.email || "no email on contact"}
                    active={channels.email}
                    disabled={Boolean(contact) && !contact.email}
                    onClick={() => setChannels((ch) => ({ ...ch, email: !ch.email }))}
                  />
                </div>
              )}
            </div>

            <div>
              <span className={LABEL_CLS}>Documents</span>
              <div className="space-y-1.5 rounded-xl border border-slate-200 p-3">
                {available.map((d) => (
                  <label key={d.key} className="flex cursor-pointer items-start gap-2.5 text-sm">
                    <input
                      type="checkbox"
                      checked={docs.has(d.key)}
                      onChange={() => toggleDoc(d.key)}
                      className="mt-0.5 h-4 w-4 accent-blue-600"
                    />
                    <span>
                      <span className="font-medium">{d.label}</span>
                      {d.key === "image" && channels.sms && (
                        <span className="block text-xs text-slate-500">{d.caption}</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
              {channels.sms && [...docs].some((k) => k !== "image") && (
                <p className="mt-1 text-xs text-slate-500">
                  PDFs go out on email only — the text sends {sentenceList([
                    "the message",
                    ...(docs.has("image") ? ["the offer image"] : []),
                    ...(includeLink && pageLink ? ["the offer-page link"] : []),
                  ])}.
                </p>
              )}
            </div>

            <div>
              <span className={LABEL_CLS}>Offer page</span>
              <div className="rounded-xl border border-slate-200 p-3 text-sm">
                {pageLoading ? (
                  <span className="flex items-center gap-2 text-slate-500">
                    <Loader2 size={14} className="animate-spin" /> Checking for an offer page…
                  </span>
                ) : pageLink ? (
                  <label className="flex cursor-pointer items-start gap-2.5">
                    <input type="checkbox" checked={includeLink} onChange={toggleLink}
                      className="mt-0.5 h-4 w-4 accent-blue-600" />
                    <span className="min-w-0">
                      <span className="font-medium">Include the link to the offer page</span>
                      <span className="block truncate text-xs text-slate-500">{pageLink}</span>
                    </span>
                  </label>
                ) : page ? (
                  <span className="text-slate-600">
                    This offer's page is switched off — turn it back on from the offer window to send its link.
                  </span>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-slate-600">
                      No page yet — one link with the comps, the scope and what the seller nets.
                    </span>
                    <button type="button" className={BTN} disabled={pageBusy} onClick={buildPage}>
                      {pageBusy ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />} Build it
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div>
              <span className={LABEL_CLS}>Message</span>
              <textarea rows={6} value={message} onChange={(e) => setMessage(e.target.value)} className={INPUT_CLS} />
            </div>

            {channels.email && (
              <div>
                <span className={LABEL_CLS}>Email subject</span>
                <input value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} className={INPUT_CLS} />
              </div>
            )}

            <div className="flex justify-end">
              <button
                type="button"
                onClick={doPreview}
                disabled={!canPreview}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} Preview
              </button>
            </div>
          </div>
        )}

        {step === "preview" && preview && (
          <div className="space-y-3">
            {previewBlocked && (
              <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Live sends are disabled on the server (CARD_SENDS_ENABLED) — you can preview but not send.
              </div>
            )}
            {preview.contactError && (
              <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Contact lookup failed: {preview.contactError}
              </div>
            )}

            {preview.previews?.sms && (
              <div className="rounded-xl border border-slate-200 p-3">
                <div className="mb-1.5 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-500">
                  <MessageSquare size={13} /> Text
                  <span className="font-medium normal-case tracking-normal text-slate-400">
                    to {preview.previews.sms.to || "—"}
                  </span>
                </div>
                {preview.previews.sms.error ? (
                  <div className="text-sm text-red-600">{preview.previews.sms.error}</div>
                ) : (
                  <>
                    <p className="whitespace-pre-wrap rounded-lg bg-slate-50 p-2.5 text-sm">{preview.previews.sms.message}</p>
                    {(preview.previews.sms.attachments || []).length > 0 && (
                      <p className="mt-1.5 flex items-center gap-1.5 text-xs text-slate-500">
                        <FileText size={12} /> Offer image attached as the picture
                      </p>
                    )}
                  </>
                )}
              </div>
            )}

            {preview.previews?.email && (
              <div className="rounded-xl border border-slate-200 p-3">
                <div className="mb-1.5 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-500">
                  <Mail size={13} /> Email
                  <span className="font-medium normal-case tracking-normal text-slate-400">
                    to {preview.previews.email.to || "—"}
                  </span>
                </div>
                {preview.previews.email.error ? (
                  <div className="text-sm text-red-600">{preview.previews.email.error}</div>
                ) : (
                  <>
                    <div className="mb-1.5 text-sm"><span className="text-slate-500">Subject:</span>{" "}
                      <span className="font-medium">{preview.previews.email.subject}</span>
                    </div>
                    <div
                      className="rounded-lg border border-slate-100 bg-slate-50 p-2.5 text-sm [&_ul]:list-inside [&_ul]:list-disc"
                      /* HTML is composed server-side from escaped values — safe to render */
                      dangerouslySetInnerHTML={{ __html: preview.previews.email.html }}
                    />
                    {(preview.previews.email.docs || []).length > 0 && (
                      <p className="mt-1.5 flex items-center gap-1.5 text-xs text-slate-500">
                        <FileText size={12} /> Attached: {preview.previews.email.docs.map((d) => d.label).join(", ")}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}

            <div className="flex items-center justify-between">
              <button type="button" onClick={() => { setStep("compose"); setError(""); }}
                className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold hover:bg-slate-50">
                <ArrowLeft size={14} /> Edit
              </button>
              <button
                type="button"
                onClick={doConfirm}
                disabled={busy || previewBlocked}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                Send {activeChannels.map((c) => CHANNEL_LABELS[c]).join(" + ")} now
              </button>
            </div>
          </div>
        )}

        {step === "sent" && result && (
          <div className="space-y-3">
            {Object.entries(result.results || {}).map(([ch, r]) => (
              <div key={ch}
                className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${r.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>
                {r.ok ? <Check size={15} /> : <X size={15} />}
                <span className="font-semibold capitalize">{CHANNEL_LABELS[ch]}</span>
                {r.ok ? "sent ✓" : `failed — ${r.error}`}
              </div>
            ))}
            <div className="flex justify-end">
              <button type="button" onClick={onClose}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-slate-50">
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
