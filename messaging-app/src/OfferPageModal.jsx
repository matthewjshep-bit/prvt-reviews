// OfferPageModal.jsx — build and manage the agent-facing page for one offer.
//
// The investor DataroomModal's smaller sibling: no invites, no photos, no
// teaser, no public feed. An agent gets one forwardable link, because the page
// is meant to travel — to their broker, to their seller — and a per-recipient
// link would break the moment it was forwarded, which is the whole point of
// sending it.
//
// The only genuinely dangerous control here is the breakdown toggle, so it
// carries the explanation rather than a warning: it never shows our fee (see
// shared/offer-breakdown.js), and saying so is what stops it being avoided out
// of vague caution.

import React, { useEffect, useState } from "react";
import { ExternalLink, Eye, Link2, Loader2, RefreshCw, ShieldOff, Trash2, X } from "lucide-react";
import {
  createOfferPage, deleteOfferPage, getOfferPage, listOfferPages,
  revokeOfferPage, rotateOfferPageLink, updateOfferPage,
} from "./api.js";
import { BTN, BTN_PRIMARY, CopyButton, ErrorBar, Spinner } from "./ui.jsx";

// Order here is the order the toggles appear — roughly the order an agent
// reads the page.
const SECTIONS = [
  ["note", "Your note", "A short message at the top, in your words"],
  ["breakdown", "How we got to this number", "The arithmetic behind the offer — never shows your fee"],
  ["netsheet", "What the seller nets", "Your offer vs. the list price needed to net the same"],
  ["comps", "Comparable sales", "The comps the ARV was built from"],
  ["scope", "Renovation scope", "The line-item budget behind the repair number"],
  ["documents", "Documents", "The offer, comps, scope and net-sheet PDFs"],
];

const INPUT_CLS =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none";
const LABEL_CLS = "mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500";

const when = (iso) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";

export default function OfferPageModal({ offer, onClose }) {
  const [page, setPage] = useState(null);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [headline, setHeadline] = useState("");
  const [note, setNote] = useState("");

  // An offer has at most one page. Reuse it rather than minting a second link
  // for the same property — two live links is a support problem, not a feature.
  useEffect(() => {
    listOfferPages(offer.id)
      .then(async (list) => {
        const existing = list?.[0];
        if (!existing) return setLoading(false);
        const full = await getOfferPage(existing.id).catch(() => ({ offerPage: existing, events: [] }));
        adopt(full.offerPage, full.events);
        setLoading(false);
      })
      .catch((e) => { setError(e.message); setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offer.id]);

  function adopt(p, ev) {
    setPage(p);
    if (ev) setEvents(ev);
    setHeadline(p?.snapshot?.headline || "");
    setNote(p?.snapshot?.note || "");
  }

  const run = async (fn) => {
    setBusy(true); setError("");
    try { await fn(); } catch (e) { setError(e.message); }
    setBusy(false);
  };

  const build = () => run(async () => adopt(await createOfferPage(offer.id, { headline, note })));
  const patch = (body) => run(async () => adopt(await updateOfferPage(page.id, body)));

  const toggle = (key) => {
    const next = { ...(page.snapshot?.sections || {}), [key]: !page.snapshot?.sections?.[key] };
    // Optimistic: the toggle should feel instant, and a failure re-reads anyway.
    setPage((p) => ({ ...p, snapshot: { ...p.snapshot, sections: next } }));
    patch({ sections: next });
  };

  const rotate = () => run(async () => {
    if (!window.confirm("Anyone holding the current link loses access immediately. Continue?")) return;
    const link = await rotateOfferPageLink(page.id);
    setPage((p) => ({ ...p, shareLink: link }));
  });

  const remove = () => run(async () => {
    if (!window.confirm("Delete this page? The link stops working for good.")) return;
    await deleteOfferPage(page.id);
    onClose?.();
  });

  const sections = page?.snapshot?.sections || {};
  const revoked = page?.status === "revoked";

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Offer page"
        className="w-full max-w-2xl rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <div className="text-lg font-bold">Offer page for the agent</div>
            <div className="text-sm text-slate-500">{offer.address || "this property"}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
            className="rounded p-1.5 text-slate-400 hover:bg-slate-100">
            <X size={18} />
          </button>
        </div>

        {error && <div className="mb-3"><ErrorBar>{error}</ErrorBar></div>}
        {loading ? <Spinner /> : !page ? (
          /* ---- nothing built yet ---- */
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              A single web page you can text or email to the listing agent: the offer, the comps behind it,
              the renovation scope and what their seller actually nets. You choose what's on it, and you can
              switch the link off at any time.
            </p>
            <div>
              <span className={LABEL_CLS}>Headline (optional)</span>
              <input className={INPUT_CLS} value={headline} onChange={(e) => setHeadline(e.target.value)}
                placeholder="Why this offer works" />
            </div>
            <div>
              <span className={LABEL_CLS}>Note to the agent (optional)</span>
              <textarea className={`${INPUT_CLS} h-24`} value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="Happy to move faster on closing if that helps your seller — just say the word." />
            </div>
            <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={build}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />} Build the page
            </button>
          </div>
        ) : (
          /* ---- built ---- */
          <div className="space-y-4">
            {revoked && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                <span>This page is switched off — the link shows a "not available" notice.</span>
                <button type="button" className={BTN} disabled={busy}
                  onClick={() => run(async () => adopt(await revokeOfferPage(page.id, false)))}>
                  Turn back on
                </button>
              </div>
            )}

            <div className="rounded-xl border border-slate-200 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className={LABEL_CLS} style={{ marginBottom: 0 }}>The link</span>
                <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                  <Eye size={12} aria-hidden="true" />
                  {page.views ? `Opened ${page.views}×${page.lastViewedAt ? ` · ${when(page.lastViewedAt)}` : ""}` : "Not opened yet"}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input readOnly value={page.shareLink || ""} onFocus={(e) => e.target.select()}
                  aria-label="Shareable offer page link"
                  className={`${INPUT_CLS} min-w-[14rem] flex-1 bg-slate-50 font-mono text-xs`} />
                <CopyButton value={page.shareLink || ""} className={BTN} />
                <a href={page.shareLink} target="_blank" rel="noreferrer" className={BTN}>
                  <ExternalLink size={13} aria-hidden="true" /> View
                </a>
                <button type="button" className={BTN} disabled={busy} onClick={rotate}
                  title="Kill this link and mint a new one">
                  <RefreshCw size={13} aria-hidden="true" /> Rotate
                </button>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Forwardable on purpose — the agent will send it to their seller. Rotate it to cut off a link
                that travelled further than you meant.
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 p-3">
              <span className={LABEL_CLS}>What's on the page</span>
              <div className="space-y-1.5">
                {SECTIONS.map(([key, label, hint]) => (
                  <label key={key} className="flex cursor-pointer items-start gap-2 rounded-lg px-1.5 py-1 hover:bg-slate-50">
                    <input type="checkbox" className="mt-0.5" checked={sections[key] !== false && Boolean(sections[key])}
                      disabled={busy} onChange={() => toggle(key)} />
                    <span>
                      <span className="block text-sm font-medium">{label}</span>
                      <span className="block text-xs text-slate-500">{hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 p-3">
              <span className={LABEL_CLS}>Headline</span>
              <input className={INPUT_CLS} value={headline} disabled={busy}
                onChange={(e) => setHeadline(e.target.value)}
                onBlur={() => headline !== (page.snapshot?.headline || "") && patch({ headline })}
                placeholder="Why this offer works" />
              <span className={`${LABEL_CLS} mt-3`}>Note to the agent</span>
              <textarea className={`${INPUT_CLS} h-24`} value={note} disabled={busy}
                onChange={(e) => setNote(e.target.value)}
                onBlur={() => note !== (page.snapshot?.note || "") && patch({ note })}
                placeholder="Happy to move faster on closing if that helps your seller." />
              <p className="mt-1 text-xs text-slate-400">Saves when you click away.</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={BTN} disabled={busy} onClick={() => patch({ refresh: true })}
                title="Re-read the offer — the page is frozen at build time so numbers can't move under the agent">
                <RefreshCw size={13} aria-hidden="true" /> Refresh from the offer
              </button>
              <span className="text-xs text-slate-400">Built {when(page.snapshot?.builtAt)}</span>
              <div className="ml-auto flex gap-2">
                {!revoked && (
                  <button type="button" className={BTN} disabled={busy}
                    onClick={() => run(async () => adopt(await revokeOfferPage(page.id, true)))}>
                    <ShieldOff size={13} aria-hidden="true" /> Switch off
                  </button>
                )}
                <button type="button" className={`${BTN} text-red-700 hover:border-red-300 hover:bg-red-50`}
                  disabled={busy} onClick={remove}>
                  <Trash2 size={13} aria-hidden="true" /> Delete
                </button>
              </div>
            </div>

            {events.length > 0 && (
              <details className="rounded-xl border border-slate-200 p-3">
                <summary className="cursor-pointer select-none text-xs font-semibold text-slate-600">
                  Access log ({events.length})
                </summary>
                <div className="mt-2 max-h-48 space-y-1 overflow-y-auto text-xs text-slate-600">
                  {events.map((e, i) => (
                    <div key={i} className="flex justify-between gap-3">
                      <span>{e.kind}{e.detail?.kind ? ` · ${e.detail.kind}` : ""}</span>
                      <span className="text-slate-400">{when(e.createdAt)}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
