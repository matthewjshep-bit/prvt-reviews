// OfferPanel.jsx — the left side of Today's work pane: the offer this row is
// about, read so the next text can be written against it.
//
// The numbers first (ours, theirs, the house), then the one ratio that has
// decided every deal so far — what a buyer is in for against the ARV — then
// what happened, then the agent's other offers. The documents and the full
// editor are a click away, not repeated here.

import React from "react";
import { ExternalLink, FileText, Pencil } from "lucide-react";
import { fmtMoney } from "@shared/offer-calc.js";
import { OFFER_STATUS, offerHeat, priceAgreed } from "@shared/offer-status.js";
import { getOffer, listOffers, offerEditorUrl, zillowUrl } from "./api.js";
import { HotPill, StagePill, StatusPill } from "./ui.jsx";
import { AiProvenance, RehabScope } from "./OfferDetailModal.jsx";
import { useLoad } from "./work-data.js";
import { allInPct, allInTone } from "./work-queue.js";

const LABEL = "text-xs font-semibold uppercase tracking-wide text-slate-500";
const day = (ts) => (ts ? new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" }) : "");
const money = (n) => (Number(n) > 0 ? fmtMoney(n) : "—");

const TONE = {
  good: { bar: "bg-emerald-500", text: "text-emerald-700", say: "inside what buyers pay" },
  close: { bar: "bg-amber-400", text: "text-amber-800", say: "tight — buyers stop at 70%" },
  over: { bar: "bg-rose-500", text: "text-rose-700", say: "over what buyers pay (70%)" },
};

// What a buyer would be in for, against the ARV. The bar is scaled 50–90%
// with a mark at 70, so "just over" and "way over" look different.
export function AllIn({ label, price, repairs, arv }) {
  const pct = allInPct({ price, repairs, arv });
  if (pct == null) return null;
  const tone = TONE[allInTone(pct)];
  const at = (v) => `${Math.max(0, Math.min(100, ((v - 50) / 40) * 100))}%`;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-slate-600">{label}</span>
        <span className={`font-bold tabular-nums ${tone.text}`}>{pct}% of ARV</span>
      </div>
      <div className="relative mt-1 h-1.5 rounded-full bg-slate-100" aria-hidden="true">
        <div className={`absolute inset-y-0 left-0 rounded-full ${tone.bar}`} style={{ width: at(pct) }} />
        <div className="absolute inset-y-[-3px] w-px bg-slate-500" style={{ left: at(70) }} />
      </div>
      <div className={`mt-0.5 text-xs ${tone.text}`}>{fmtMoney(Number(price) + (Number(repairs) || 0))} all-in · {tone.say}</div>
    </div>
  );
}

function Figure({ label, value, strong = false, tone = "" }) {
  return (
    <div>
      <div className={LABEL}>{label}</div>
      <div className={`tabular-nums ${strong ? "text-lg font-bold" : "text-sm font-semibold"} ${tone || "text-slate-900"}`}>{value}</div>
    </div>
  );
}

/**
 * <OfferPanelBody offer siblings item loading error />
 * What the tests render; OfferPanel below loads it.
 */
export function OfferPanelBody({ offer, siblings = [], item = {}, loading = false, error = "" }) {
  if (!item.offerId && !offer) {
    const startHref = item.contactId ? `${offerEditorUrl(null, { view: "new" })}&contact_id=${encodeURIComponent(item.contactId)}` : offerEditorUrl(null, { view: "new" });
    return (
      <div className="space-y-3 p-4">
        <div className={LABEL}>Offer</div>
        <div className="rounded-xl border border-dashed border-slate-300 px-4 py-5 text-sm text-slate-600">
          <div className="font-semibold text-slate-800">No offer yet{item.address ? ` on ${item.address.split(",")[0]}` : ""}.</div>
          {Number(item.askingPrice) > 0 && <div className="mt-1">Asking {fmtMoney(item.askingPrice)}.</div>}
          <a href={startHref} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700">
            <Pencil size={13} /> Start one
          </a>
        </div>
      </div>
    );
  }
  if (!offer) {
    return (
      <div className="space-y-3 p-4" aria-busy={loading}>
        <div className={LABEL}>Offer</div>
        {error
          ? <div className="text-sm text-red-700">Couldn't load the offer — {error}</div>
          : <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-5 animate-pulse rounded bg-slate-100" />)}</div>}
      </div>
    );
  }

  const heat = offerHeat(offer);
  const agreed = priceAgreed(offer);
  const counter = Number(offer.counter?.amount) > 0 ? offer.counter : null;
  const arv = Number(offer.arv ?? offer.calc?.inputs?.arv) || 0;
  const repairs = Number(offer.repairs ?? offer.calc?.inputs?.repairs) || 0;
  const asking = Number(offer.askingPrice ?? offer.calc?.inputs?.askingPrice) || 0;
  const ours = Number(offer.cashAmount) || 0;
  const history = [...(offer.statusHistory || [])].filter((h) => h?.ts).sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, 4);
  const lastSend = (offer.sends || []).at(-1);
  const others = siblings.filter((o) => o.id !== offer.id).slice(0, 6);

  return (
    <div className="space-y-4 p-4">
      <div>
        <div className="flex items-center justify-between gap-2">
          <span className={LABEL}>Offer</span>
          <a href={offerEditorUrl(offer.id)} target="_blank" rel="noreferrer" title="Open it in the editor (O)"
            className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline">
            <Pencil size={12} /> Open
          </a>
        </div>
        <div className="mt-1 text-base font-bold leading-snug text-slate-900">{offer.address || "Untitled"}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <StatusPill offer={offer} small />
          <HotPill heat={heat} />
          {offer.deal && <StagePill stage={offer.deal.stage} small />}
          {offer.address && (
            <a href={zillowUrl(offer.address)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-xs text-slate-500 hover:text-slate-800">
              Zillow <ExternalLink size={11} />
            </a>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        <Figure label="Our offer" value={money(ours)} strong />
        <Figure label="Asking" value={money(asking)} strong />
        {counter && <Figure label="Their counter" value={money(counter.amount)} tone="text-violet-800" />}
        {agreed && <Figure label="Agreed" value={money(agreed.amount)} tone="text-emerald-700" />}
        <Figure label="ARV" value={money(arv)} />
        <Figure label="Repairs" value={money(repairs)} />
      </div>

      {arv > 0 && (
        <div className="space-y-2.5 rounded-xl border border-slate-200 p-3">
          <AllIn label="At our offer" price={ours} repairs={repairs} arv={arv} />
          {counter && <AllIn label="At their counter" price={counter.amount} repairs={repairs} arv={arv} />}
          {agreed && !counter && agreed.amount !== ours && <AllIn label="At the agreed price" price={agreed.amount} repairs={repairs} arv={arv} />}
        </div>
      )}

      {(lastSend || history.length > 0) && (
        <div>
          <div className={LABEL}>What happened</div>
          <ul className="mt-1 space-y-0.5 text-sm text-slate-700">
            {lastSend && <li><span className="tabular-nums text-slate-500">{day(lastSend.ts)}</span> · sent{lastSend.channels?.length ? ` by ${lastSend.channels.join(" + ")}` : ""}</li>}
            {history.map((h, i) => (
              <li key={i}>
                <span className="tabular-nums text-slate-500">{day(h.ts)}</span> · {OFFER_STATUS[h.status]?.label?.toLowerCase() || String(h.status || "").replace(/_/g, " ")}
                {Number(h.amount) > 0 ? ` at ${fmtMoney(h.amount)}` : ""}{h.note ? <span className="text-slate-500"> — {h.note}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(offer.pdfUrl || offer.imageUrl) && (
        <div className="flex flex-wrap gap-2">
          {offer.pdfUrl && <a href={offer.pdfUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline"><FileText size={12} /> Offer PDF</a>}
          {offer.imageUrl && <a href={offer.imageUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline"><FileText size={12} /> Letter image</a>}
        </div>
      )}

      {offer.autoUnderwrite && (
        <details className="group">
          <summary className="cursor-pointer text-xs font-semibold text-slate-600 hover:text-slate-900">How the machine priced it</summary>
          <div className="mt-2"><AiProvenance offer={offer} /></div>
        </details>
      )}
      {(offer.scope || []).length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs font-semibold text-slate-600 hover:text-slate-900">Rehab scope</summary>
          <div className="mt-2"><RehabScope scope={offer.scope} /></div>
        </details>
      )}

      {others.length > 0 && (
        <div>
          <div className={LABEL}>Their other offers</div>
          <ul className="mt-1 divide-y divide-slate-100 rounded-xl border border-slate-200">
            {others.map((o) => (
              <li key={o.id}>
                <a href={offerEditorUrl(o.id)} target="_blank" rel="noreferrer" className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-50">
                  <span className="min-w-0 flex-1 truncate text-slate-800" title={o.address}>{String(o.address || "Untitled").split(",")[0]}</span>
                  <span className="tabular-nums font-semibold text-slate-700">{money(o.cashAmount)}</span>
                  <StatusPill offer={o} small />
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export const offerKey = (id) => (id ? `offer:${id}` : null);
export const siblingsKey = (contactId) => (contactId ? `offers-of:${contactId}` : null);
export const loadOffer = (id) => () => getOffer(id);
export const loadSiblings = (contactId) => () => listOffers({ contactId, lean: true, limit: 20 });

export default function OfferPanel({ item, offerId }) {
  const one = useLoad(offerKey(offerId), loadOffer(offerId));
  // An investor row's contact is the buyer; the other offers are the agent's.
  const agent = one.data?.contactId || null;
  const rest = useLoad(siblingsKey(agent), loadSiblings(agent));
  return <OfferPanelBody offer={one.data} siblings={rest.data || []} item={{ ...item, offerId }} loading={one.loading} error={one.error} />;
}
