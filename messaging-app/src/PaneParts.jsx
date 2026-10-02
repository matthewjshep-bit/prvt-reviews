// PaneParts.jsx — the work pane's parts, shared by Today (WorkPane) and the
// Offers split (OfferPane):
//
//   PaneHeading   the person (their name opens their record) · the house,
//                 and under it the timeline strip (MomentStrip)
//   PaneActions   the app's own buttons: Status ▾ · Bot ▾ · Edit offer ·
//                 Call · Coach · ⋯ (Feedback, History, GHL)
//   PaneBody      the offer on the left, the conversation and the reply box
//                 on the right (two tabs below laptop width), and the full
//                 editor over it when asked for
//   usePane       what those read: the offer and their other offers, the
//                 coach's ideas, the timeline, the Feedback control's state
//
// The Record button is gone (Matt, 2026-10-01: he didn't know what it was):
// the name opens the record, and so do the strip's History and the ⋯ menu.

import React, { useEffect, useState } from "react";
import { Ellipsis, ExternalLink, History, MessageSquareWarning, Pencil } from "lucide-react";
import { annotateCurrent } from "@shared/current-offer.js";
import { Menu, StatusMenu } from "./ui.jsx";
import { useOpenContact } from "./ContactLink.jsx";
import ContactLink from "./ContactLink.jsx";
import { getContactTimeline, ghlContactUrl, setOfferStatus } from "./api.js";
import { OfferPanelBody, loadSiblings, siblingsKey, useOfferSide, useRequote } from "./OfferPanel.jsx";
import ConversationPanel, { ConversationPanelBody } from "./ConversationPanel.jsx";
import CoachIdeas, { coachKey, loadCoach } from "./CoachIdeas.jsx";
import CallButton from "./CallButton.jsx";
import OfferEditorSheet from "./OfferEditorSheet.jsx";
import MomentStrip from "./MomentStrip.jsx";
import BotMenu from "./BotMenu.jsx";
import { TEACH_EVENT, useRowFeedback } from "./RowFeedback.jsx";
import { forgetPrefix, useLoad } from "./work-data.js";
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
  const theirs = useLoad(bodies || targets.offerId || !targets.contactId ? null : siblingsKey(targets.contactId), loadSiblings(targets.contactId));
  useEffect(() => {
    if (offerId || !theirs.data) return;
    const pick = defaultOfferFor(theirs.data, item.address || targets.draft?.propertyAddress || "");
    if (pick) setOfferId(pick.id);
  }, [theirs.data]);   // eslint-disable-line react-hooks/exhaustive-deps
  const fromBodies = bodies && (offerId === targets.offerId || !offerId ? bodies.offer : (bodies.siblings || []).find((o) => o.id === offerId) || null);
  const side = bodies
    ? { offer: fromBodies, siblings: bodies.siblings || [], replaced: null, loading: false, error: "", reload: () => {} }
    : loaded;
  const { requote, requoting } = useRequote(() => { side.reload(); onDone?.(); });
  const coachLoad = useLoad(bodies ? null : coachKey(targets.contactId), loadCoach(targets.contactId), { maxAgeMs: 120000 });
  const coach = bodies ? bodies.coach : coachLoad.data;
  // The strip and the Bot menu, for the offer on screen.
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
  // A press on the Bot menu: the strip, the offer's next follow-up and the
  // queue all read it.
  const botChanged = () => {
    forgetPrefix(`timeline:${targets.contactId}:`);
    tl.reload();
    side.reload();
    onDone?.();
  };
  return {
    offerId, setOfferId, editing, setEditing, edit, side, theirs, requote, requoting,
    coach, coachReload: coachLoad.reload, timeline, botChanged, fb, name, openContact,
  };
}

/** The person (their name opens their record) · the house, and the strip under it. */
export function PaneHeading({ item, targets, pane, fallback = "" }) {
  const street = String(item.address || pane.side.offer?.address || "").split(",")[0].trim();
  const name = pane.name;
  return (
    <div className="min-w-0">
      <h2 className="mt-1 text-base font-bold leading-snug text-slate-900">
        {targets.contactId && name
          ? <><ContactLink contactId={targets.contactId} name={name} party={targets.party} className="font-bold">{name}</ContactLink>{street ? <span> · {street}</span> : null}</>
          : (fallback || street || name || "Untitled")}
      </h2>
      {targets.contactId && <MomentStrip timeline={pane.timeline} onHistory={pane.openContact} />}
    </div>
  );
}

/** ⋯ — what the pane keeps out of the way: Feedback (T), their record, GHL. */
function PaneMore({ pane, contactId }) {
  const items = [
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
 * <PaneActions pane item targets rowOfferId onStatusChanged onDealNav extra />
 * The app's own buttons on the person and the offer the left side shows.
 *   onStatusChanged(r)  after a status, Hot or Current change (r: the API's answer)
 *   onDealNav()         the Deals view, once a status made it a deal
 */
export function PaneActions({ pane, item, targets, rowOfferId = null, onStatusChanged, onDealNav = null, extra = null }) {
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
      pane.side.reload();
      pane.botChanged?.();
      onStatusChanged?.(r);
    } catch (e) {
      setNote({ tone: "red", text: e.message || "That didn't change." });
    } finally { setBusy(false); }
  }
  const goDeals = onDealNav || (() => { window.location.href = `/deals${window.location.search}`; });
  return (
    <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
      {note && <span className={`text-xs ${note.tone === "red" ? "text-red-700" : "text-emerald-700"}`}>{note.text}</span>}
      {menuOffer && (
        <span className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 py-1" title="Status, Hot and Current for this offer">
          {/* Another of their offers is showing: say which one the menu changes. */}
          <span className="max-w-[12rem] truncate text-xs text-slate-500">{rowOfferId && offer.id !== rowOfferId && offer.address ? `${offer.address.split(",")[0]} ·` : "Status"}</span>
          <StatusMenu offer={menuOffer} busy={busy} onSelect={onStatus} onDealNav={goDeals} />
        </span>
      )}
      <BotMenu contactId={targets.contactId} party={targets.party} name={pane.name} bot={pane.timeline?.bot || null} onChanged={pane.botChanged} />
      {(offer || pane.offerId) && <button type="button" className={ACT} disabled={!offer} onClick={() => pane.edit(offer)} title="The full offer (O)"><Pencil size={12} /> Edit offer</button>}
      <CallButton contactId={targets.contactId} name={pane.name} party={targets.party} offerId={offer?.id || pane.offerId || null} address={offer?.address || item.address || ""} />
      <CoachIdeas coach={pane.coach} onChanged={pane.coachReload} />
      {extra}
      <PaneMore pane={pane} contactId={targets.contactId} />
    </div>
  );
}

/**
 * <PaneBody pane item targets convo settings bodies onDeal />
 * The offer on the left, the conversation on the right; tabs below lg.
 */
export function PaneBody({ pane, item, targets, convo, settings = null, bodies = null, onDone, onDeal = null }) {
  const [tab, setTab] = useState("conversation");   // below lg the two sides are tabs
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
          onSaved={(o) => { side.reload(); onDone?.(); if (o?.id && !pane.editing.offer) pane.setOfferId(o.id); }}
          onOpenOffer={(o) => { pane.setEditing({ offer: o }); if (o?.id) pane.setOfferId(o.id); }} />
      )}
    </>
  );
}
