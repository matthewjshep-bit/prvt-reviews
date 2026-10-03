// OfferPanel.jsx — the left side of Today's work pane: the offer this row is
// about, read so the next text can be written against it.
//
// The numbers first (ours, theirs, the house), then the one ratio that has
// decided every deal so far — what a buyer is in for against the ARV — then
// what happened. Above it, every offer with this person, so switching between
// their houses happens here rather than in another tab. Our number can be
// re-quoted in place; the full editor opens over Today (OfferEditorSheet).
// Status, Hot and Current are the header's menu, not repeated here.

import React, { useState } from "react";
import { Check, ExternalLink, FileText, Pencil, X } from "lucide-react";
import { fmtMoney } from "@shared/offer-calc.js";
import { OFFER_STATUS, offerHeat, priceAgreed, priceLocked } from "@shared/offer-status.js";
import { clearAgreedPrice, getOffer, listOffers, offerEditorUrl, requoteOffer, zillowUrl } from "./api.js";
import { annotateCurrent } from "@shared/current-offer.js";
import { BTN, ChecksLine, CurrentPill, HotPill, PaperHeldBanner, StagePill, StatusPill } from "./ui.jsx";
import { AiProvenance, RehabScope } from "./OfferDetailModal.jsx";
import { forget, useLoad } from "./work-data.js";
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

// "774", "774k", "$774,000" → 774000. A bare number under 10,000 is thousands:
// nobody offers $774 on a house.
export function parseAmount(v) {
  const t = String(v || "").trim().toLowerCase().replace(/[$,\s]/g, "");
  const m = t.match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!m) return 0;
  let n = Number(m[1]) * (m[2] === "m" ? 1e6 : m[2] === "k" ? 1e3 : 1);
  if (!m[2] && n < 10000) n *= 1000;
  return Math.round(n);
}

// Our number, re-quotable in place: the same revision the editor makes, and
// nothing is sent. Not on a deal. On a price they agreed to, re-quoting takes
// the agreement back first, and says so before you press it.
function OurOffer({ offer, onRequote }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ours = Number(offer.cashAmount) || 0;
  const why = offer.deal ? "It's a deal — change the price on the deal"
    : offer.status === "draft" ? "Publish the draft first"
    : "";
  const agreed = priceLocked(offer) ? priceAgreed(offer) : null;
  const amount = parseAmount(value);
  async function save() {
    if (!(amount > 0) || busy) return;
    setBusy(true); setError("");
    if (agreed) {
      try { await clearAgreedPrice(offer.id); } catch (e) { setBusy(false); setError(e.message); return; }
    }
    const r = await onRequote(offer, amount);
    setBusy(false);
    if (r?.error) setError(r.error);
    else setEditing(false);
  }
  if (!editing) {
    return (
      <div>
        <div className={LABEL}>Our offer</div>
        <div className="flex items-center gap-1.5">
          <span className="text-lg font-bold tabular-nums text-slate-900">{money(ours)}</span>
          {onRequote && (
            <button type="button" disabled={Boolean(why)} title={why || (agreed ? `Agreed at ${money(agreed.amount)} — re-quoting takes that back (sends nothing)` : "Re-quote at a new number (sends nothing)")} aria-label="Change our offer"
              onClick={() => { setValue(ours ? String(Math.round(ours / 1000)) + "k" : ""); setEditing(true); }}
              className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40">
              <Pencil size={12} />
            </button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="col-span-2">
      <label className={LABEL} htmlFor="work-our-offer">Re-quote our offer</label>
      <div className="mt-0.5 flex items-center gap-1.5">
        <input id="work-our-offer" autoFocus value={value} onChange={(e) => { setValue(e.target.value); setError(""); }}
          onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
          className="w-28 rounded-lg border border-slate-300 px-2 py-1 text-sm tabular-nums focus:border-blue-500 focus:outline-none" placeholder="e.g. 750k" />
        <button type="button" className={BTN} disabled={busy || !(amount > 0)} onClick={save}><Check size={12} /> {busy ? "…" : "Re-quote"}</button>
        <button type="button" className="rounded p-1 text-slate-500 hover:bg-slate-100" onClick={() => setEditing(false)} aria-label="Cancel"><X size={14} /></button>
      </div>
      <div className="mt-0.5 text-xs text-slate-500">
        {error ? <span className="text-red-700">{error}</span>
          : amount > 0 ? `${fmtMoney(amount)} — ${agreed ? `takes back the agreed ${fmtMoney(agreed.amount)}, and ` : ""}the letter is redone at this number. Nothing is sent.`
          : "A number, like 750k."}
      </div>
    </div>
  );
}

// Every offer with this person, newest first: which house, our number, where
// it stands. Picking one shows it here.
function OfferSwitcher({ book, selectedId, rowOfferId, name, onSelect }) {
  const [all, setAll] = useState(false);
  if (book.length < 2) return null;
  const shown = all ? book : book.slice(0, 6);
  return (
    <div>
      <div className={LABEL}>Offers with {name || "them"} · {book.length}</div>
      <ul className="mt-1 divide-y divide-slate-100 rounded-xl border border-slate-200">
        {shown.map((o) => {
          const on = o.id === selectedId;
          return (
            <li key={o.id}>
              <button type="button" onClick={() => onSelect?.(o.id)} aria-current={on ? "true" : undefined}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${on ? "bg-blue-50" : "hover:bg-slate-50"}`}>
                <span className={`min-w-0 flex-1 truncate ${on ? "font-semibold text-slate-900" : "text-slate-800"}`} title={o.address}>
                  {String(o.address || "Untitled").split(",")[0]}
                  {o.id === rowOfferId && !on && <span className="ml-1 text-xs font-normal text-slate-500">· this row</span>}
                </span>
                <span className="tabular-nums font-semibold text-slate-700">{money(o.cashAmount)}</span>
                <StatusPill offer={o} small />
                <HotPill heat={offerHeat(o)} />
                <CurrentPill offer={o} />
              </button>
            </li>
          );
        })}
      </ul>
      {book.length > shown.length && (
        <button type="button" className="mt-1 text-xs text-blue-700 hover:underline" onClick={() => setAll(true)}>+{book.length - shown.length} more</button>
      )}
    </div>
  );
}

/**
 * <OfferPanelBody offer siblings item … /> — what the tests render; WorkPane
 * loads it with useOfferSide below.
 *   onSelectOffer(id)        show another of their offers here
 *   onEdit(offer | null)     open the full editor (null: start a new one)
 *   onRequote(offer, amount) → { error? }
 */
export function OfferPanelBody({ offer, siblings = [], item = {}, loading = false, error = "", replaced = null, onRequote = null, requoting = false, onSelectOffer = null, onEdit = null }) {
  // Still looking for their offers (a row that names none): not "none" yet.
  if (!item.offerId && !offer && !loading) {
    const startHref = item.contactId ? `${offerEditorUrl(null, { view: "new" })}&contact_id=${encodeURIComponent(item.contactId)}` : offerEditorUrl(null, { view: "new" });
    const cls = "mt-3 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700";
    return (
      <div className="space-y-3 p-4">
        <div className={LABEL}>Offer</div>
        <div className="rounded-xl border border-dashed border-slate-300 px-4 py-5 text-sm text-slate-600">
          <div className="font-semibold text-slate-800">No offer yet{item.address ? ` on ${item.address.split(",")[0]}` : ""}.</div>
          {Number(item.askingPrice) > 0 && <div className="mt-1">Asking {fmtMoney(item.askingPrice)}.</div>}
          {onEdit
            ? <button type="button" className={cls} onClick={() => onEdit(null)}><Pencil size={13} /> Start one</button>
            : <a href={startHref} target="_blank" rel="noreferrer" className={cls}><Pencil size={13} /> Start one</a>}
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

  const agreed = priceAgreed(offer);
  const counter = Number(offer.counter?.amount) > 0 ? offer.counter : null;
  const arv = Number(offer.arv ?? offer.calc?.inputs?.arv) || 0;
  const repairs = Number(offer.repairs ?? offer.calc?.inputs?.repairs) || 0;
  const asking = Number(offer.askingPrice ?? offer.calc?.inputs?.askingPrice) || 0;
  const ours = Number(offer.cashAmount) || 0;
  const history = [...(offer.statusHistory || [])].filter((h) => h?.ts).sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, 4);
  const lastSend = (offer.sends || []).at(-1);
  // Every offer with them, each told which row on its house is current
  // (shared/current-offer.js).
  const book = annotateCurrent(siblings.some((o) => o.id === offer.id) ? siblings.map((o) => (o.id === offer.id ? offer : o)) : [offer, ...siblings]);
  const me = book.find((o) => o.id === offer.id) || offer;
  const first = String(item.contactName || offer.contactName || "").split(" ")[0];
  const editBtn = onEdit
    ? <button type="button" onClick={() => onEdit(offer)} title="Open the full offer (O)" className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline"><Pencil size={12} /> Edit offer</button>
    : <a href={offerEditorUrl(offer.id)} target="_blank" rel="noreferrer" title="Open it in the editor (O)" className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline"><Pencil size={12} /> Open</a>;

  return (
    <div className="space-y-4 p-4">
      <OfferSwitcher book={book} selectedId={offer.id} rowOfferId={replaced ? replaced.id : item.offerId} name={first} onSelect={onSelectOffer} />

      <div>
        <div className="flex items-center justify-between gap-2">
          <span className={LABEL}>Offer</span>
          {editBtn}
        </div>
        <div className="mt-1 text-base font-bold leading-snug text-slate-900">{offer.address || "Untitled"}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <CurrentPill offer={me} />
          {offer.deal && <StagePill stage={offer.deal.stage} small />}
          {offer.address && (
            <a href={zillowUrl(offer.address)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-xs text-slate-500 hover:text-slate-800">
              Zillow <ExternalLink size={11} />
            </a>
          )}
          {offer.pdfUrl && <a href={offer.pdfUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-xs text-slate-500 hover:text-slate-800"><FileText size={11} /> PDF</a>}
          {offer.imageUrl && <a href={offer.imageUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-xs text-slate-500 hover:text-slate-800"><FileText size={11} /> Letter</a>}
        </div>
      </div>

      {replaced && (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          This row pointed at an older offer ({money(replaced.cashAmount)}, superseded). Showing the current one — it's the number the bot works from.
        </div>
      )}
      <PaperHeldBanner offer={offer} busy={requoting} onRequote={onRequote ? (amount) => onRequote(offer, amount) : null} />
      {error && <div className="text-xs text-red-700">{error}</div>}

      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        <OurOffer key={offer.id} offer={offer} onRequote={onRequote} />
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

      {offer.checks && <ChecksLine checks={offer.checks} full />}

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
    </div>
  );
}

export const offerKey = (id) => (id ? `offer:${id}` : null);
export const siblingsKey = (contactId) => (contactId ? `offers-of:${contactId}` : null);
export const loadOffer = (id) => () => getOffer(id);
export const loadSiblings = (contactId) => () => listOffers({ contactId, lean: true, limit: 20 });

/**
 * useOfferSide(offerId) — the offer a row is about, and every other offer
 * with the same agent. A row that points at a superseded offer shows its
 * house's current one instead: that's the number the bot, the nudges and the
 * paper work from. Shared by the pane's header (status menu) and its left side.
 */
export function useOfferSide(offerId) {
  const one = useLoad(offerKey(offerId), loadOffer(offerId));
  // An investor row's contact is the buyer; the other offers are the agent's.
  const agent = one.data?.contactId || null;
  const rest = useLoad(siblingsKey(agent), loadSiblings(agent));
  const replacedBy = one.data && rest.data ? annotateCurrent([one.data, ...rest.data.filter((o) => o.id !== one.data.id)])[0]?.supersededBy : null;
  const cur = useLoad(replacedBy ? offerKey(replacedBy.id) : null, loadOffer(replacedBy?.id));
  const offer = replacedBy ? cur.data : one.data;
  const reload = () => {
    forget(offerKey(offerId), siblingsKey(agent), replacedBy ? offerKey(replacedBy.id) : null);
    one.reload(); rest.reload(); cur.reload();
  };
  return {
    offer, siblings: rest.data || [], replaced: replacedBy ? one.data : null,
    loading: one.loading || (Boolean(replacedBy) && cur.loading), error: one.error || cur.error || "", reload,
  };
}

/**
 * useRequote(reload) → { requoting, requote(offer, amount) → { error? } }
 * Re-price in place, then re-read. Never throws: the caller shows the error.
 */
export function useRequote(reload) {
  const [requoting, setRequoting] = useState(false);
  async function requote(o, amount) {
    if (requoting || !o?.id) return { error: "busy" };
    setRequoting(true);
    try { await requoteOffer(o.id, amount); reload(); return {}; }
    catch (e) { return { error: e.message || "That didn't re-quote." }; }
    finally { setRequoting(false); }
  }
  return { requoting, requote };
}
