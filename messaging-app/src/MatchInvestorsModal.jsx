// MatchInvestorsModal.jsx — "who could buy this?" for one under-contract deal.
// Derives a query from the deal (area from the address, the price the investor
// would actually pay, rehab level from the repair estimate against ARV), filters
// the investor book by buy box, and ranks the survivors.
//
// Deliberately a different question from the "Suggest from conversations"
// button next to it: that one asks who is ALREADY talking about this property;
// this one asks whose stated buy box FITS it, including buyers who have never
// heard of it. Both are surfaced, because a good dispo list needs both.

import React, { useEffect, useState } from "react";
import { ExternalLink, Loader2, Megaphone, X } from "lucide-react";
import { PROPERTY_TYPE_LABELS, REHAB_APPETITE_LABELS, priceBandText } from "@shared/buybox.js";
import { blastInvestors, ghlContactUrl, matchInvestorsToDeal } from "./api.js";

const FIT_CLS = {
  strong: "bg-emerald-100 text-emerald-800",
  possible: "bg-slate-100 text-slate-700",
  weak: "bg-slate-50 text-slate-500",
};

export default function MatchInvestorsModal({ offer, existingIds, onClose, onLink }) {
  const [data, setData] = useState(null); // null | {error} | match response
  const [strict, setStrict] = useState(false);
  const [linking, setLinking] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [blast, setBlast] = useState(null);
  const [blasting, setBlasting] = useState(false);

  const load = async (opts = {}) => {
    setData(null);
    try {
      setData(await matchInvestorsToDeal(offer.id, opts));
    } catch (e) {
      setData({ error: e.message });
    }
  };
  useEffect(() => { load({ strict }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [strict]);

  const link = async (r) => {
    setLinking(r.contactId);
    try {
      await onLink({ contactId: r.contactId, name: r.name });
    } finally {
      setLinking("");
    }
  };

  const toggle = (id) =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const doBlast = async () => {
    const n = selected.size;
    if (!window.confirm(`Tag ${n} investor${n === 1 ? "" : "s"} in GoHighLevel so the blast workflow sends them ${offer.address}?`)) return;
    setBlasting(true);
    try {
      const r = await blastInvestors({
        contactIds: [...selected],
        label: offer.address,
        applyTag: true,
        dryRun: false,
      });
      setBlast(r);
      if (!r.dryRun) setSelected(new Set());
    } catch (e) {
      setBlast({ error: e.message });
    } finally {
      setBlasting(false);
    }
  };

  const q = data?.parsed;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
      onClick={onClose}>
      <div className="w-full max-w-3xl rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold tracking-tight text-slate-900">Find buyers</h2>
            <p className="text-xs text-slate-500">
              Investors whose buy box fits {offer.address || "this deal"}.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100">
            <X size={16} />
          </button>
        </div>

        {/* what the deal was read as — so a bad match is explainable */}
        {q && (
          <div className="mb-3 flex flex-wrap items-center gap-1.5 rounded-lg bg-slate-50 px-3 py-2">
            <span className="text-xs text-slate-500">Matching on</span>
            {q.areas.map((a) => <Chip key={a}>{a}</Chip>)}
            {priceBandText(q) && <Chip>{priceBandText(q)} to the buyer</Chip>}
            {q.propertyTypes.map((t) => <Chip key={t}>{PROPERTY_TYPE_LABELS[t]}</Chip>)}
            {q.rehabAppetite && <Chip>{REHAB_APPETITE_LABELS[q.rehabAppetite]} rehab</Chip>}
            <label className="ml-auto flex items-center gap-1.5 text-xs text-slate-600"
              title="Strict drops investors whose buy box is silent on something this deal needs.">
              <input type="checkbox" checked={strict} onChange={(e) => setStrict(e.target.checked)} />
              Only documented fits
            </label>
          </div>
        )}

        {!data && (
          <div className="flex items-center justify-center gap-2 p-10 text-sm text-slate-500">
            <Loader2 className="animate-spin text-slate-400" /> Ranking your buyer list…
          </div>
        )}

        {data?.error && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{data.error}</div>
        )}

        {data?.results && data.results.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">
            {data.scanned === 0
              ? "Your investor book is empty — open Investors and sync from GoHighLevel first."
              : strict
                ? `None of your ${data.scanned} investors have a documented buy box covering this. Turn off "only documented fits" to see the plausible ones.`
                : `None of your ${data.scanned} investors fit this deal.`}
          </div>
        )}

        {data?.results?.length > 0 && (
          <>
            <div className="max-h-[26rem] space-y-1.5 overflow-y-auto">
              {data.results.map((r) => {
                const already = existingIds?.has(r.contactId);
                return (
                  <div key={r.contactId} className="rounded-lg border border-slate-200 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2">
                        <input type="checkbox" checked={selected.has(r.contactId)}
                          onChange={() => toggle(r.contactId)} />
                        <a href={ghlContactUrl(r.contactId)} target="_blank" rel="noreferrer"
                          className="inline-flex min-w-0 items-center gap-1 text-sm font-semibold text-slate-900 hover:text-blue-700">
                          <span className="truncate">{r.name || "Unnamed"}</span>
                          <ExternalLink size={11} className="shrink-0 text-slate-400" />
                        </a>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${FIT_CLS[r.fit] || FIT_CLS.possible}`}
                          title={`Match score ${r.score}/100`}>
                          {r.fit}
                        </span>
                      </span>
                      <button type="button" disabled={already || linking === r.contactId}
                        onClick={() => link(r)}
                        className="shrink-0 rounded-lg bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-40">
                        {already ? "On deal" : linking === r.contactId ? "Linking…" : "Link to deal"}
                      </button>
                    </div>
                    {r.reason && <div className="mt-1 text-xs leading-tight text-slate-600">{r.reason}</div>}
                    <div className="mt-1 text-[11px] text-slate-500">
                      {[r.buybox?.areasRaw, priceBandText(r.buybox), r.buybox?.rehabAppetite &&
                        REHAB_APPETITE_LABELS[r.buybox.rehabAppetite]].filter(Boolean).join(" · ") || "No buy box on file"}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3">
              <span className="text-xs text-slate-500">
                {data.filtered} of {data.scanned} fit
                {data.rankedByAi > 0 ? " · ranked by AI" : " · ordered by criteria matched"}
                {data.linked?.length > 0 && ` · ${data.linked.length} already on the deal`}
              </span>
              <button type="button" onClick={doBlast} disabled={!selected.size || blasting}
                className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3.5 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40">
                {blasting ? <Loader2 size={14} className="animate-spin" /> : <Megaphone size={14} />}
                Tag &amp; blast {selected.size || ""}
              </button>
            </div>

            {blast && (
              <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
                {blast.error ? <span className="text-red-700">{blast.error}</span> : (
                  <span className={blast.dryRun ? "text-amber-800" : "text-emerald-800"}>
                    {blast.dryRun
                      ? "Server ran a dry run (DISPO_BLASTS_ENABLED is off) — nothing was tagged."
                      : `Tagged ${blast.blasted} investor${blast.blasted === 1 ? "" : "s"} with "${blast.blastTag}".`}
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const Chip = ({ children }) => (
  <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-700 ring-1 ring-slate-200">
    {children}
  </span>
);
