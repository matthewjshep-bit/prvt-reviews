// PaneParts.jsx — the contact pane's parts. ContactPane.jsx puts them
// together, the same on the Desk, the Offers split, Tier 1 and the companion
// window (Matt, 2026-10-18: "every single place you jump has a slightly
// different sort of interface"):
//
//   PaneHeading   the person (their name opens their record) · the house ·
//                 their GHL stage, which moves from here (GhlStageMenu)
//   PaneActions   the app's own buttons: Status ▾ · Edit offer · Call ·
//                 Coach · ⋯ (Feedback, their record, GHL, and the page's own)
//   PaneBody      the offer on the left, the conversation and the reply box
//                 on the right (two tabs below laptop width), and the full
//                 editor over it when asked for
//   usePane       what those read: the offer and their other offers, the
//                 coach's ideas, the bot's state, the Feedback control's state
//
// Gone (Matt, 2026-10-18, "way too overcrowded"): the timeline strip under
// the name and the Bot menu. The Record button went 2026-10-01: the name
// opens the record, and so does the ⋯ menu.

import React, { useEffect, useState } from "react";
import { ChevronDown, Ellipsis, ExternalLink, History, Loader2, MessageSquareWarning, Pencil } from "lucide-react";
import { CARD_STAGES, CARD_STAGE_LABEL } from "@shared/ghl-stages.js";
import { annotateCurrent } from "@shared/current-offer.js";
import { Menu, StatusMenu } from "./ui.jsx";
import { useOpenContact } from "./ContactLink.jsx";
import ContactLink from "./ContactLink.jsx";
import { getContactTimeline, getGhlCard, ghlContactUrl, setGhlCardStage, setOfferStatus } from "./api.js";
import { OfferPanelBody, loadSiblings, siblingsKey, useOfferSide, useRequote } from "./OfferPanel.jsx";
import ConversationPanel, { ConversationPanelBody, REPLY_BOX_ID } from "./ConversationPanel.jsx";
import CoachIdeas, { coachKey, loadCoach } from "./CoachIdeas.jsx";
import CallButton from "./CallButton.jsx";
import OfferEditorSheet from "./OfferEditorSheet.jsx";
import { TEACH_EVENT, useRowFeedback } from "./RowFeedback.jsx";
import { forget, useLoad } from "./work-data.js";
import { defaultOfferFor, teachRowId } from "./work-queue.js";
import { feedbackItemOf } from "./RowOps.jsx";

const ACT = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-40";
// The pane's O key: open the offer over the page.
export const OPEN_OFFER_EVENT = "work-open-offer";

export const timelineKey = (contactId, offerId) => (contactId ? `timeline:${contactId}:${offerId || "-"}` : null);
export const loadTimeline = (contactId, offerId, party) => () => getContactTimeline(contactId, { offerId, party: party === "investor" ? "investor" : "" });

// The status menu wants to know whether this is its house's current row.
function menuOfferOf(offer, siblings) {
  if (!offer) return null;
  const book = annotateCurrent(siblings.some((o) => o.id === offer.id) ? siblings.map((o) => (o.id === offer.id ? offer : o)) : [offer, ...siblings]);
  const me = book.find((o) => o.id === offer.id) || {};
  return { ...offer, isCurrent: me.isCurrent, supersededBy: me.supersededBy, currentPinned: me.currentPinned, houseOffers: me.houseOffers };
}

/**
 * usePane({ item, targets, bodies, feedback, onDone }) → pane
 *   item     a Today row, or the Offers split's stand-in for an offer
 *   targets  rowTargets(item, drafts): { contactId, party, offerId, draft }
 *   bodies   tests only: { offer, siblings, thread, coach, timeline }
 */
export function usePane({ item, targets, bodies = null, feedback = null, onDone }) {
  // Which of their offers the left side shows; the row's own to start.
  const [offerId, setOfferId] = useState(targets.offerId || null);
  const [editing, setEditing] = useState(null);     // { offer } | { offer: null } (a new one) | null
  const loaded = useOfferSide(bodies ? null : offerId);
  // A row that names no offer (a reply to a text about nothing in
  // particular) still has a person: show their offer, not "No offer yet".
  // The offer on screen is gone (a draft that Create or a re-run turned into
  // an offer, Matt 2026-10-21): show what's left of theirs instead.
  const gone = !bodies && loaded.gone;
  const theirs = useLoad(bodies || (targets.offerId && !gone) || !targets.contactId ? null : siblingsKey(targets.contactId), loadSiblings(targets.contactId));
  useEffect(() => {
    // Re-read their list: one cached before Create doesn't have the new offer.
    if (gone) { forget(siblingsKey(targets.contactId)); theirs.reload(); }
  }, [gone]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if ((offerId && !gone) || !theirs.data) return;
    const left = gone ? theirs.data.filter((o) => o.id !== offerId) : theirs.data;
    const pick = defaultOfferFor(left, item.address || targets.draft?.propertyAddress || "");
    if (pick) setOfferId(pick.id);
    else if (gone) setOfferId(null);
  }, [theirs.data, gone]);   // eslint-disable-line react-hooks/exhaustive-deps
  const fromBodies = bodies && (offerId === targets.offerId || !offerId ? bodies.offer : (bodies.siblings || []).find((o) => o.id === offerId) || null);
  const side = bodies
    ? { offer: fromBodies, siblings: bodies.siblings || [], replaced: null, loading: false, error: "", reload: () => {} }
    : loaded;
  const { requote, requoting } = useRequote(() => { side.reload(); onDone?.(); });
  const coachLoad = useLoad(bodies ? null : coachKey(targets.contactId), loadCoach(targets.contactId), { maxAgeMs: 120000 });
  const coach = bodies ? bodies.coach : coachLoad.data;
  // The bot's state for the offer on screen: the reply box says when it's stopped.
  const shownId = side.offer?.id || offerId || null;
  const tl = useLoad(bodies ? null : timelineKey(targets.contactId, shownId), loadTimeline(targets.contactId, shownId, targets.party), { maxAgeMs: 60000 });
  const timeline = bodies ? (bodies.timeline ?? null) : tl.data;

  const fb = useRowFeedback({
    rowId: teachRowId(item), rowKind: item.kind, feedback,
    item: { ...feedbackItemOf(item), contactId: targets.contactId || item.contactId || null, draftId: item.draftId || targets.draftId || null, offerId: targets.offerId || item.offerId || null },
  });

  const drawer = useOpenContact();
  const name = item.contactName || targets.draft?.contactName || side.offer?.contactName || "";
  const openContact = targets.contactId ? () => {
    if (drawer) drawer.open(targets.contactId, { party: targets.party, name: name || null });
    else window.open(ghlContactUrl(targets.contactId), "_blank", "noreferrer");
  } : null;
  const edit = (offer) => setEditing({ offer: offer || null });
  useEffect(() => {
    const onOpen = () => { if (side.offer) edit(side.offer); };
    window.addEventListener(OPEN_OFFER_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_OFFER_EVENT, onOpen);
  });
  return {
    offerId, setOfferId, editing, setEditing, edit, side, theirs, requote, requoting,
    coach, coachReload: coachLoad.reload, timeline, fb, name, openContact,
  };
}

// Where the agent sits on GHL's Acquisitions board, beside their name
// (Matt, 2026-10-13), and the menu that moves it (2026-10-17, the companion's
// picker; 2026-10-18, the same menu everywhere). Agents only; a buyer has no
// card there.
export const GHL_STAGE_CLS = {
  tier2: "bg-slate-100 text-slate-700", tier1: "bg-amber-100 text-amber-800",
  offerOut: "bg-blue-100 text-blue-800", contract: "bg-emerald-100 text-emerald-800",
};
export const ghlCardKey = (contactId) => (contactId ? `ghlcard:${contactId}` : null);

/** What the stage menu says about their card before a pick. */
export function cardNote(card) {
  if (!card) return "";
  if (!card.stage) return "No card in Acquisitions yet. Pick a stage to make one.";
  if ((card.open || 0) > 1) return "They have two open cards in Acquisitions. Move the right one in GHL.";
  if (card.status === "won") return "Their card is won. Picking a stage makes a new one.";
  if (card.status && card.status !== "open") return `Their card is ${card.status} (was ${card.stage}). Picking a stage reopens it.`;
  if (!card.key || !CARD_STAGES.includes(card.key)) return `In ${card.name || card.stage}, an old stage. Pick one of these to move it.`;
  return "";
}

// The stage their card is in, when it's open in one of the four.
const currentStage = (card) => (card?.status === "open" && CARD_STAGES.includes(card?.key) ? card.key : null);

/** The menu's items: GHL's four stages in the board's order, theirs ticked. */
export function stageMenuItems(card, { busy = false, onPick = () => {} } = {}) {
  const current = currentStage(card);
  return CARD_STAGES.map((k) => ({
    key: k, label: CARD_STAGE_LABEL[k], selected: current === k, disabled: busy,
    title: current === k ? `In ${CARD_STAGE_LABEL[k]} now` : `Move their card to ${CARD_STAGE_LABEL[k]}`,
    onSelect: () => onPick(k),
  }));
}

/**
 * <GhlStageMenu contactId party card? />
 * The stage pill; a press opens GHL's four stages in the board's order. A
 * pick is Matt's move, the same as dragging the card in GHL: the broker
 * records it as his, so the offers leave the card there until something new
 * happens on one of their offers (POST /api/dashboard/ghl/card).
 *   card  tests only: the card as GET /api/dashboard/ghl/card answers
 */
export function GhlStageMenu({ contactId, party, card = undefined }) {
  const on = Boolean(contactId) && party !== "investor";
  const loaded = useLoad(on && card === undefined ? ghlCardKey(contactId) : null, () => getGhlCard(contactId), { maxAgeMs: 120000 });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);     // { tone, text }
  if (!on) return null;
  const data = card !== undefined ? card : loaded.data;
  if (card === undefined && loaded.loading && !data) return <span className="ml-2 inline-block h-4 w-16 animate-pulse rounded-full bg-slate-100 align-middle" aria-hidden="true" />;
  const current = currentStage(data);
  const closed = data?.status && data.status !== "open";
  const label = data?.stage ? `GHL: ${data.stage}${closed ? ` (${data.status})` : ""}` : "GHL: no card";
  const pick = async (to) => {
    if (busy || to === current) return;
    setBusy(true); setNote(null);
    try {
      const r = await setGhlCardStage(contactId, to);
      if (r.skip) setNote({ tone: "slate", text: r.skip });
      else setNote(r.warning
        ? { tone: "amber", text: r.warning }
        : { tone: "green", text: `${r.created ? "Made a card in" : "Moved to"} ${r.to}. It stays there until something new happens on one of their offers.` });
      forget(ghlCardKey(contactId));
      loaded.reload();
    } catch (e) {
      setNote({ tone: "red", text: e.message || "It didn't move." });
    } finally { setBusy(false); }
  };
  const before = cardNote(data);
  const items = stageMenuItems(data, { busy: busy || (!data && !loaded.error), onPick: pick });
  const tone = (t) => (t === "red" ? "text-red-700" : t === "amber" ? "text-amber-700" : t === "green" ? "text-emerald-700" : "text-slate-500");
  return (
    <>
      <Menu label={`GHL stage: ${data?.stage || "no card"}. Move their card`} align="left" items={items} trigger={(
        <span className={`ml-2 inline-flex items-center gap-0.5 whitespace-nowrap rounded-full px-2 py-0.5 align-middle text-[11px] font-semibold ${data?.stage ? GHL_STAGE_CLS[data.key] || "bg-slate-100 text-slate-700" : "bg-slate-50 text-slate-500"}`}
          title={[data?.name ? `GHL Acquisitions stage: ${data.name}${data.cards > 1 ? ` · ${data.cards} cards` : ""}` : "No card on GHL's Acquisitions board", before].filter(Boolean).join(". ")}>
          {busy && <Loader2 size={10} className="animate-spin" aria-hidden="true" />}
          {label}
          <ChevronDown size={11} aria-hidden="true" />
        </span>
      )} />
      {note && <span className={`ml-2 align-middle text-xs font-normal ${tone(note.tone)}`} role="status">{note.text}</span>}
      {!note && loaded.error && <span className="ml-2 align-middle text-xs font-normal text-red-700">Couldn't read their GHL card</span>}
    </>
  );
}

/** The person (their name opens their record) · the house · their GHL stage. */
export function PaneHeading({ item, targets, pane, fallback = "" }) {
  const street = String(item.address || pane.side.offer?.address || "").split(",")[0].trim();
  const name = pane.name;
  return (
    <h2 className="min-w-0 text-base font-bold leading-snug text-slate-900">
      {targets.contactId && name
        ? <><ContactLink contactId={targets.contactId} name={name} party={targets.party} className="font-bold">{name}</ContactLink>{street ? <span> · {street}</span> : null}<GhlStageMenu contactId={targets.contactId} party={targets.party} /></>
        : (fallback || street || name || "Untitled")}
    </h2>
  );
}

/** ⋯ — what the pane keeps out of the way: the page's own extras, then Feedback (T), their record, GHL. */
function PaneMore({ pane, contactId, extra = [] }) {
  const items = [
    ...(extra.length ? [...extra, { key: "extra-divider", divider: true }] : []),
    { key: "feedback", label: "Feedback for the bot (T)", icon: <MessageSquareWarning size={13} />, onSelect: () => window.dispatchEvent(new Event(TEACH_EVENT)) },
    ...(contactId && pane.openContact ? [{ key: "history", label: "Their record and history", icon: <History size={13} />, onSelect: pane.openContact }] : []),
    ...(contactId ? [{ key: "ghl", label: "Open in GHL", icon: <ExternalLink size={13} />, onSelect: () => window.open(ghlContactUrl(contactId), "_blank", "noreferrer") }] : []),
  ];
  return (
    <Menu label="More" items={items} trigger={(
      <span className="inline-flex items-center rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-slate-600 transition-colors hover:bg-slate-50" title="More">
        <Ellipsis size={14} />
      </span>
    )} />
  );
}

/**
 * <PaneActions pane item targets rowOfferId onStatusChanged onDealNav moreItems />
 * The app's own buttons on the person and the offer the left side shows.
 *   onStatusChanged(r)  after a status, Hot or Current change (r: the API's answer)
 *   onDealNav()         the Deals view, once a status made it a deal
 *   moreItems           the page's own ⋯ items (Menu items), on top
 */
export function PaneActions({ pane, item, targets, rowOfferId = null, onStatusChanged, onDealNav = null, moreItems = [] }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);   // { tone, text }
  const offer = pane.side.offer;
  const menuOffer = menuOfferOf(offer, pane.side.siblings);
  async function onStatus(key) {
    if (!offer || busy) return;
    setBusy(true); setNote(null);
    try {
      const r = await setOfferStatus(offer.id, key);
      if (r.promoted) setNote({ tone: "green", text: "It's a deal now — it's on the Deals board." });
      // A pass that leaves the GHL card where it is says which house holds it.
      else if (r.card?.text) setNote({ tone: "amber", text: r.card.text });
      pane.side.reload();
      onStatusChanged?.(r);
    } catch (e) {
      setNote({ tone: "red", text: e.message || "That didn't change." });
    } finally { setBusy(false); }
  }
  const goDeals = onDealNav || (() => { window.location.href = `/deals${window.location.search}`; });
  return (
    <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
      {note && <span className={`text-xs ${note.tone === "red" ? "text-red-700" : note.tone === "amber" ? "text-amber-700" : "text-emerald-700"}`}>{note.text}</span>}
      {menuOffer && (
        <span className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 py-1" title="Status, Hot and Current for this offer">
          {/* Another of their offers is showing: say which one the menu changes. */}
          <span className="max-w-[12rem] truncate text-xs text-slate-500">{rowOfferId && offer.id !== rowOfferId && offer.address ? `${offer.address.split(",")[0]} ·` : "Status"}</span>
          <StatusMenu offer={menuOffer} busy={busy} onSelect={onStatus} onDealNav={goDeals} />
        </span>
      )}
      {(offer || pane.offerId) && <button type="button" className={ACT} disabled={!offer} onClick={() => pane.edit(offer)} title="The full offer (O)"><Pencil size={12} /> Edit offer</button>}
      <CallButton contactId={targets.contactId} name={pane.name} party={targets.party} offerId={offer?.id || pane.offerId || null} address={offer?.address || item.address || ""} />
      <CoachIdeas coach={pane.coach} onChanged={pane.coachReload} />
      <PaneMore pane={pane} contactId={targets.contactId} extra={moreItems} />
    </div>
  );
}

/**
 * <PaneBody pane item targets convo settings bodies onDeal defaultTab />
 * The offer on the left, the conversation on the right; tabs below lg.
 *   defaultTab  which tab shows first below lg: "conversation" (the Desk), or
 *               "offer" (the companion window, which sits beside GHL's own
 *               conversation)
 */
export function PaneBody({ pane, item, targets, convo, settings = null, bodies = null, onDone, onDeal = null, defaultTab = "conversation" }) {
  const [tab, setTab] = useState(defaultTab === "offer" ? "offer" : "conversation");   // below lg the two sides are tabs
  // T below laptop width: the Feedback control is on the Conversation tab.
  useEffect(() => {
    const onTeach = () => setTab("conversation");
    window.addEventListener(TEACH_EVENT, onTeach);
    return () => window.removeEventListener(TEACH_EVENT, onTeach);
  }, []);
  const { side } = pane;
  const tabBtn = (key, label) => (
    <button type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
      className={`flex-1 border-b-2 px-3 py-2 text-sm font-semibold ${tab === key ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
      {label}
    </button>
  );
  return (
    <>
      <div role="tablist" className="flex shrink-0 border-b border-slate-200 lg:hidden">
        {tabBtn("conversation", "Conversation")}
        {tabBtn("offer", "Offer")}
      </div>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className={`${tab === "offer" ? "block" : "hidden"} min-h-0 overflow-y-auto lg:block lg:border-r lg:border-slate-200`}>
          <OfferPanelBody offer={side.offer} siblings={side.siblings} item={{ ...item, offerId: pane.offerId }} loading={side.loading || pane.theirs.loading} error={side.error}
            replaced={side.replaced} onRequote={pane.requote} requoting={pane.requoting} onSelectOffer={pane.setOfferId} onEdit={pane.edit} />
        </div>
        <div className={`${tab === "conversation" ? "flex" : "hidden"} h-[65vh] min-h-0 flex-col lg:flex lg:h-auto`}>
          {bodies
            ? <ConversationPanelBody {...convo} thread={bodies.thread} />
            : <ConversationPanel {...convo} />}
        </div>
      </div>

      {pane.editing && (
        <OfferEditorSheet offer={pane.editing.offer} settings={settings} contactId={targets.contactId} onDeal={onDeal}
          onClose={() => pane.setEditing(null)}
          onSaved={(o) => { side.reload(); onDone?.(); if (o?.id && o.id !== pane.editing?.offer?.id) pane.setOfferId(o.id); }}
          onOpenOffer={(o) => { pane.setEditing({ offer: o }); if (o?.id) pane.setOfferId(o.id); }} />
      )}
    </>
  );
}

/**
 * runPaneKey(intent) — what R, T and O do in any pane (work-queue.js
 * keyIntent): the reply box, the Feedback control, the full offer.
 * True when it was one of those.
 */
export function runPaneKey(intent) {
  if (intent === "reply") document.getElementById(REPLY_BOX_ID)?.focus();
  else if (intent === "teach") window.dispatchEvent(new Event(TEACH_EVENT));
  else if (intent === "offer") window.dispatchEvent(new Event(OPEN_OFFER_EVENT));
  else return false;
  return true;
}
