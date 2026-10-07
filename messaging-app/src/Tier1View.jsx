// Tier1View.jsx — Today → Tier 1 (Matt, 2026-10-07): GHL's Acquisitions
// "Tier 1" stage, in the app, with the machine's first look at every card.
//
// Tier 1 is agents with a live house that needs work, right now. Agents
// oversell, so each card wears the flags that say it probably isn't one
// (sold, not a flip, not single-family, no house, already passed, gone
// quiet). Then one of two things per card, fast:
//
//   Pass     — we looked, it isn't ours. The offer → we passed, GHL's card →
//              Passed on Offer, tier-1 off; the agent check-in keeps in touch
//              about the next house and never names this one.
//   Offer →  — open the offer beside the list, check the numbers, Send. The
//              send moves the GHL card to Offer Out; the machine follows up.
//
// Kick out is for a card that shouldn't have been there at all. "Belongs"
// lists agents the app reads as Tier 1 that GHL has elsewhere — Add puts
// them on GHL's Tier 1. Tier 2 is everyone who wrote back with nothing in
// hand, and what keeps each warm.
//
// Loads when the tab opens and on Refresh — no poll. The broker caches the
// GHL read for five minutes; Refresh skips the cache.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ExternalLink, RefreshCw } from "lucide-react";
import { annotateCurrent } from "@shared/current-offer.js";
import { kText } from "@shared/call-list.js";
import { OFFER_STATUS } from "@shared/offer-status.js";
import { getTierOne, ghlContactUrl, listOffers, rerunHeldUnderwrite, tierOneAdd, tierOneKick, tierOnePass } from "./api.js";
import ContactLink from "./ContactLink.jsx";
import { appHref } from "./links.js";
import { ActivityStamp, BTN, BTN_PRIMARY, ErrorBar, FilterChips, Pill, SearchInput, SkeletonRows } from "./ui.jsx";
import OfferRail from "./OfferRail.jsx";
import OfferPane from "./OfferPane.jsx";
import SendModal from "./SendModal.jsx";
import { railStep, splitKey } from "./offers-split.js";

const street = (a) => String(a || "").split(",")[0].trim();
const daysSince = (t, now = Date.now()) => { const ms = Date.parse(t || ""); return Number.isFinite(ms) ? Math.max(0, Math.floor((now - ms) / 86400000)) : null; };
const FLAG_CLS = { sure: "bg-red-50 text-red-800 ring-1 ring-red-200", soft: "bg-amber-50 text-amber-800 ring-1 ring-amber-200", stale: "bg-slate-100 text-slate-600" };
const STATUS_CLS = { new: "bg-slate-100 text-slate-700", sent: "bg-blue-50 text-blue-800", countered: "bg-violet-100 text-violet-800", accepted: "bg-emerald-100 text-emerald-800" };

/** The machine's flags on one card: red when it's sure, amber when it's their words, grey when it's only quiet. */
export function FlagChips({ flags = [] }) {
  if (!flags.length) return <span className="text-xs font-medium text-emerald-700">Looks live</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {flags.map((f) => (
        <span key={f.key} title={f.why} className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${f.key === "stale" ? FLAG_CLS.stale : f.sure ? FLAG_CLS.sure : FLAG_CLS.soft}`}>
          {f.label}
        </span>
      ))}
    </span>
  );
}

/** Our numbers on the house: offer · ARV · repairs · their ask — or that it isn't priced. */
export function OurNumbers({ offer = null, house = null }) {
  if (!offer) {
    return <span className="text-xs text-slate-500">{house?.source === "named" ? "Named, not priced yet" : house ? "Not priced" : "—"}</span>;
  }
  const bits = [
    offer.arv ? `ARV ${kText(offer.arv)}` : "",
    offer.repairs ? `repairs ${kText(offer.repairs)}` : "",
    offer.askingPrice ? `ask ${kText(offer.askingPrice)}` : "",
  ].filter(Boolean);
  return (
    <span className="block whitespace-nowrap">
      <span className="font-semibold tabular-nums text-slate-900">{offer.cashAmount ? kText(offer.cashAmount) : "—"}</span>
      {bits.length > 0 && <span className="ml-1.5 text-xs tabular-nums text-slate-500">{bits.join(" · ")}</span>}
    </span>
  );
}

function StatusCell({ offer }) {
  if (!offer) return null;
  return (
    <span className="flex items-center gap-1">
      <Pill small label={OFFER_STATUS[offer.status]?.label || offer.status} cls={STATUS_CLS[offer.status] || "bg-slate-100 text-slate-600"} />
      {offer.hot && <span className="text-xs" title="Hot — close to a contract">🔥</span>}
    </span>
  );
}

/**
 * The Tier 1 table. `kind` is "tier1" (GHL's cards: Pass · Offer · Kick out)
 * or "belongs" (not on GHL's Tier 1: Add). What the tests render.
 */
export function TierOneTable({ rows = [], kind = "tier1", busy = null, onPass, onKick, onOffer, onUnderwrite, onAdd, now = Date.now() }) {
  if (!rows.length) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
        {kind === "tier1" ? "GHL's Tier 1 is empty." : "Nobody the app reads as Tier 1 is missing from GHL's Tier 1."}
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="min-w-full text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-3 py-2">Agent</th><th className="px-3 py-2">House</th><th className="px-3 py-2">Our numbers</th>
            <th className="px-3 py-2">Machine's look</th><th className="px-3 py-2">Their last word</th><th className="px-3 py-2"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => {
            const inTier = daysSince(r.inStageSince, now);
            const working = busy === r.contactId;
            const flagged = !r.ok;
            const priced = Boolean(r.offer?.id);
            return (
              <tr key={r.contactId} data-tier-row={r.contactId} className={`${flagged ? "bg-red-50/30" : ""} ${working ? "opacity-60" : ""}`}>
                <td className="px-3 py-2 align-top">
                  <ContactLink contactId={r.contactId} name={r.name || "Unnamed agent"} party="agent" className="font-semibold text-slate-900" />
                  {kind === "tier1" && inTier != null && <div className="text-xs text-slate-500">{inTier === 0 ? "in Tier 1 today" : `${inTier}d in Tier 1`}{r.openCards > 1 ? " · 2 open cards" : ""}</div>}
                </td>
                <td className="max-w-[16rem] px-3 py-2 align-top">
                  <span className="block truncate text-slate-800" title={r.house?.address || undefined}>{r.house ? street(r.house.address) : "—"}</span>
                  <StatusCell offer={r.offer} />
                </td>
                <td className="px-3 py-2 align-top"><OurNumbers offer={r.offer} house={r.house} /></td>
                <td className="px-3 py-2 align-top"><FlagChips flags={r.flags} /></td>
                <td className="max-w-[18rem] px-3 py-2 align-top">
                  {r.lastWord?.text
                    ? <span className="line-clamp-2 text-xs text-slate-600" title={r.lastWord.text}>“{r.lastWord.text}”</span>
                    : null}
                  <ActivityStamp activity={r.lastInboundAt ? { at: r.lastInboundAt, dir: "in", type: "text_summary", machine: false } : null} enriched />
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right align-top">
                  {kind === "tier1" ? (
                    <span className="inline-flex gap-1">
                      {priced
                        ? <button type="button" className={BTN_PRIMARY} disabled={working} onClick={() => onOffer?.(r)} title="Open the offer, check the numbers, send it">Offer →</button>
                        : r.house?.address
                        ? <button type="button" className={BTN_PRIMARY} disabled={working} onClick={() => onUnderwrite?.(r)} title="Run the numbers on this house">Underwrite</button>
                        : null}
                      <button type="button" className={BTN} disabled={working} onClick={() => onPass?.(r)} title="We looked and it isn't ours: we passed, the GHL card goes to Passed on Offer">Pass</button>
                      <button type="button" className={`${BTN} ${flagged ? "border-red-300 text-red-700 hover:bg-red-50" : ""}`} disabled={working} onClick={() => onKick?.(r)}
                        title="It never belonged (sold, not a flip, no house): the GHL card goes to Not a Good Deal">Kick out</button>
                      <a className={BTN} href={ghlContactUrl(r.contactId)} target="_blank" rel="noreferrer" title="Open in GHL"><ExternalLink size={13} aria-hidden="true" /><span className="sr-only">Open in GHL</span></a>
                    </span>
                  ) : (
                    <button type="button" className={BTN_PRIMARY} disabled={working} onClick={() => onAdd?.(r)} title="Put their card on GHL's Tier 1">Add to GHL Tier 1</button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const CARE_CLS = { off: "text-amber-800", dropped: "text-slate-500", stopped: "text-slate-500", due: "text-emerald-700", clock: "text-slate-700", waiting: "text-slate-600" };

/** Tier 2: written back, nothing in hand, and what keeps each one warm. */
export function TierTwoTable({ rows = [], pulseOn = true }) {
  return (
    <div className="space-y-2">
      {!pulseOn && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          The agent check-in is off, so nothing keeps these agents warm between houses. Turn it on in Settings → Agent Outreach (RentCast) → “Check in with every agent”.
        </div>
      )}
      {!rows.length ? <div className="rounded-xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-500">Nobody here.</div> : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr><th className="px-3 py-2">Agent</th><th className="px-3 py-2">Where they are</th><th className="px-3 py-2">Last wrote</th><th className="px-3 py-2">What keeps them warm</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.contactId}>
                  <td className="px-3 py-2 font-semibold text-slate-900"><ContactLink contactId={r.contactId} name={r.name || "Unnamed agent"} party="agent" />{r.segment === "partner" && <span className="ml-1.5 text-xs font-medium text-emerald-700">done business</span>}</td>
                  <td className="px-3 py-2 text-slate-700">{r.why}</td>
                  <td className="px-3 py-2"><ActivityStamp activity={r.lastInboundAt ? { at: r.lastInboundAt, dir: "in", type: "text_summary", machine: false } : null} /></td>
                  <td className={`px-3 py-2 ${CARE_CLS[r.care?.kind] || "text-slate-600"}`}>{r.care?.text || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// What a Pass / Kick out does, said before it happens.
export function passEffects(r) {
  const s = street(r.house?.address) || "this house";
  return [
    r.offer?.id ? `Marks our offer on ${s} “We passed” — machine texts about it stop.` : `Records that we passed on ${s}.`,
    "Moves the GHL card to Passed on Offer and takes the tier-1 tag off (no tier-2, so GHL's nurture doesn't start).",
    "The agent check-in keeps in touch about other distressed / off-market houses and never brings this one up.",
  ];
}
export function kickEffects(r) {
  const gone = (r.flags || []).some((f) => f.key === "gone");
  const s = street(r.house?.address) || "this card";
  return [
    r.offer?.id ? `Marks our offer on ${s} “${gone ? "No longer available" : "We passed"}”.` : `Records that ${s} came off Tier 1.`,
    "Moves the GHL card to Not a Good Deal and takes the tier-1 tag off.",
  ];
}
const ask = (title, lines) => typeof window === "undefined" || window.confirm(`${title}\n\n${lines.map((l) => `• ${l}`).join("\n")}`);

export default function Tier1View({ settings = null }) {
  const [data, setData] = useState(null);   // { rows, belongs, counts, tier2, mirrorOwnsBoard }
  const [book, setBook] = useState(null);   // lean offers, for the pane
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState("tier1");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [sending, setSending] = useState(null);

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    try {
      const [t, offers] = await Promise.all([getTierOne(fresh), listOffers({ lean: true, limit: 2000, activity: true, next: true })]);
      if (t?.ok === false && t.error) setError(t.error); else setError("");
      setData(t);
      setBook(annotateCurrent(offers || []));
    } catch (e) { setError(e.message || "Couldn't read GHL's Tier 1."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const needle = q.trim().toLowerCase();
  const match = (r) => !needle || `${r.name} ${r.house?.address || ""}`.toLowerCase().includes(needle);
  const rows = (data?.rows || []).filter(match);
  const belongs = (data?.belongs || []).filter(match);
  const tier2 = (data?.tier2?.rows || []).filter((r) => !needle || `${r.name} ${r.why}`.toLowerCase().includes(needle));

  // The split: the Tier 1 cards that have an offer, in the table's order.
  const byId = useMemo(() => new Map((book || []).map((o) => [o.id, o])), [book]);
  const rail = rows.map((r) => byId.get(r.offer?.id)).filter(Boolean);
  const open = openId ? byId.get(openId) || null : null;
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      const k = splitKey(e, { blocked: Boolean(sending) });
      if (!k) return;
      if (k === "close") { e.preventDefault(); setOpenId(null); }
      else if (k === "next" || k === "prev") { e.preventDefault(); const id = railStep(rail, openId, k === "next" ? 1 : -1); if (id) setOpenId(id); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const act = async (r, run, done) => {
    setBusy(r.contactId); setError(""); setNote("");
    try {
      const out = await run();
      setNote(done(out));
      await load(true);
    } catch (e) { setError(e.message || "That didn't go through."); }
    finally { setBusy(null); }
  };
  const cardWord = (c) => (c?.opportunityId ? (c.verified ? `GHL card → ${c.to}` : `GHL card → ${c.to} (not confirmed yet)`) : c?.created ? "new GHL card in Tier 1" : c?.skip ? `GHL card left alone: ${c.skip}` : c?.error ? `GHL card not moved: ${c.error}` : "");
  const onPass = (r) => {
    if (!ask(`Pass on ${street(r.house?.address) || r.name || "this card"}?`, passEffects(r))) return;
    act(r, () => tierOnePass(r.contactId, { offerId: r.offer?.id, address: r.house?.address, flags: (r.flags || []).map((f) => f.key) }),
      (out) => [`Passed on ${street(out.address) || "it"}`, cardWord(out.card)].filter(Boolean).join(" · "));
  };
  const onKick = (r) => {
    if (!ask(`Take ${street(r.house?.address) || r.name || "this card"} off Tier 1?`, kickEffects(r))) return;
    const reason = (r.flags || []).find((f) => f.key !== "stale")?.key || "";
    act(r, () => tierOneKick(r.contactId, { offerId: r.offer?.id, address: r.house?.address, reason, flags: (r.flags || []).map((f) => f.key) }),
      (out) => [`Off Tier 1: ${street(out.address) || "it"}`, cardWord(out.card)].filter(Boolean).join(" · "));
  };
  const onAdd = (r) => act(r, () => tierOneAdd(r.contactId, { address: r.house?.address, name: r.name }), (out) => `${r.name || "Agent"} on GHL's Tier 1 · ${cardWord(out.card)}`);
  const onUnderwrite = (r) => act(r, () => rerunHeldUnderwrite({ contactId: r.contactId, address: r.house.address }),
    () => `Underwriting ${street(r.house.address)} — it shows here with numbers when it's done`);

  const counts = data?.counts || {};
  const tabs = (
    <FilterChips value={tab} onChange={(t) => { setTab(t); setOpenId(null); }} label="Tier"
      options={[
        { key: "tier1", label: "Tier 1 · GHL", count: data ? (data.rows || []).length : undefined, title: "GHL's Acquisitions Tier 1 stage — a live house that needs work, right now" },
        { key: "belongs", label: "Belongs, not in GHL", count: data ? (data.belongs || []).length : undefined, title: "The app reads them as Tier 1 and the machine's look is clean, but GHL has their card elsewhere" },
        { key: "tier2", label: "Tier 2", count: data?.tier2 ? (data.tier2.rows || []).length : undefined, title: "Written back, nothing in hand: the check-in keeps them warm" },
      ]} />
  );
  const header = (
    <div className="flex flex-wrap items-center gap-2">
      {open && <button type="button" className={BTN} onClick={() => setOpenId(null)} title="Back to the list (Esc)"><ChevronLeft size={13} /> List</button>}
      {tabs}
      <SearchInput value={q} onChange={setQ} className="ml-auto min-w-[14rem] flex-1 sm:max-w-xs" placeholder="Agent or street…" label="Search Tier 1" />
      <button type="button" className={BTN} onClick={() => load(true)} title="Read GHL again"><RefreshCw size={13} className={loading ? "animate-spin" : ""} /></button>
    </div>
  );

  return (
    <div className="space-y-3">
      {header}
      {tab === "tier1" && data && (
        <p className="text-xs text-slate-500">
          GHL's Tier 1 stage{counts.flagged ? `, ${counts.flagged} flagged by the machine` : ""}. For each: <span className="font-semibold">Offer →</span> to check the numbers and send it (the card moves to Offer Out),
          or <span className="font-semibold">Pass</span>. Both keep GHL's board in step.
        </p>
      )}
      {data?.mirrorOwnsBoard && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">The GHL mirror is on and owns the board, so Pass, Kick out and Add can't move cards from here.</div>
      )}
      {error && <ErrorBar>{error}</ErrorBar>}
      {note && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900" role="status">{note}</div>}
      {!data && !error ? <SkeletonRows rows={6} /> : open ? (
        <div className="relative flex min-h-[560px] gap-3 lg:h-[calc(100vh-11rem)]">
          <div className="hidden w-80 shrink-0 lg:block"><OfferRail rows={rail} selectedId={open.id} onSelect={setOpenId} label="Tier 1" /></div>
          <OfferPane key={open.id} offer={open} index={rail.indexOf(open)} total={rail.length}
            onPrev={railStep(rail, open.id, -1) ? () => setOpenId(railStep(rail, open.id, -1)) : null}
            onNext={railStep(rail, open.id, 1) ? () => setOpenId(railStep(rail, open.id, 1)) : null}
            onClose={() => setOpenId(null)} onSend={(o) => setSending(o)}
            onDetails={(o) => window.open(`${appHref("/", "history")}&offer=${encodeURIComponent(o.id)}`, "_blank", "noopener")}
            onChanged={() => load(true)} onStatusChanged={() => load(true)} settings={settings} />
        </div>
      ) : tab === "tier2" ? (
        <TierTwoTable rows={tier2} pulseOn={data?.tier2?.pulseOn !== false} />
      ) : (
        <TierOneTable rows={tab === "belongs" ? belongs : rows} kind={tab === "belongs" ? "belongs" : "tier1"} busy={busy}
          onPass={onPass} onKick={onKick} onAdd={onAdd} onUnderwrite={onUnderwrite}
          onOffer={(r) => { if (byId.has(r.offer.id)) setOpenId(r.offer.id); else setError("That offer isn't in the book yet — Refresh."); }} />
      )}
      {sending && <SendModal offer={sending} onClose={() => setSending(null)} onSent={() => { setSending(null); load(true); }} />}
    </div>
  );
}
