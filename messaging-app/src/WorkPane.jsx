// WorkPane.jsx — one Today row, worked in one place.
//
//   ┌ who and which house, why it's here            3 of 12  ‹ › ┐
//   │ the row's buttons  Status ▾ · Edit offer · Call · Record · Coach │
//   ├ the offer(s)               │ the conversation + the reply box  ┤
//   └                            │ Feedback ▸                        ┘
//
// Every row kind gets the same surfaces. What differs is only what the
// header says and which buttons the row names (shared/pipeline.js). The
// header's right-hand buttons are the app's own, on whichever offer the left
// side shows: the status menu (status, Hot, Current) is the one the Offers
// list uses, Edit offer is the full editor (over Today), Call rings them
// (this device or GHL) and logs it, Record is the contact drawer.

import React, { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Keyboard, Pencil, UserRound } from "lucide-react";
import { annotateCurrent } from "@shared/current-offer.js";
import { BTN, Pill, StatusMenu } from "./ui.jsx";
import { RowOpsBar, SEV, feedbackItemOf, whenLabel } from "./RowOps.jsx";
import { useOpenContact } from "./ContactLink.jsx";
import { ghlContactUrl, setOfferStatus } from "./api.js";
import { OfferPanelBody, loadSiblings, siblingsKey, useOfferSide, useRequote } from "./OfferPanel.jsx";
import ConversationPanel, { ConversationPanelBody } from "./ConversationPanel.jsx";
import { IntentPill } from "./ConversationOutbox.jsx";
import CoachIdeas, { coachKey, loadCoach } from "./CoachIdeas.jsx";
import CallButton from "./CallButton.jsx";
import OfferEditorSheet from "./OfferEditorSheet.jsx";
import { useRowFeedback } from "./RowFeedback.jsx";
import { useLoad } from "./work-data.js";
import { GROUP_LABEL, KEYS_HELP, KIND_LABEL, canDismissRow, defaultOfferFor, groupOf, railLabel, teachRowId } from "./work-queue.js";

const GROUP_CLS = { yours: "bg-blue-50 text-blue-800", stuck: "bg-amber-100 text-amber-800", machine: "bg-violet-100 text-violet-800" };
const NAV = "rounded-lg border border-slate-300 bg-white p-1.5 text-slate-600 hover:bg-slate-50 disabled:cursor-default disabled:opacity-40";
const ACT = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-40";
// The pane's O key: open the offer over Today.
export const OPEN_OFFER_EVENT = "work-open-offer";

export function KeysHelp() {
  return (
    <div role="note" className="absolute right-0 top-full z-20 mt-1 w-56 rounded-xl border border-slate-200 bg-white p-3 text-xs shadow-lg">
      <div className="mb-1.5 font-semibold text-slate-700">Keys</div>
      <dl className="grid grid-cols-[3.5rem_1fr] gap-y-1">
        {KEYS_HELP.map(([k, what]) => <React.Fragment key={k}><dt className="font-semibold text-slate-700">{k}</dt><dd className="text-slate-600">{what}</dd></React.Fragment>)}
      </dl>
    </div>
  );
}

// "Shelley Michael · 3004 E Yesler Way" — who and which house, which is
// what you need to know before reading anything else; the pipeline's title
// (why the row is here) goes under it. Rows about no one person keep the
// title as the heading.
export function rowHeading(item, offer = null) {
  const street = String(item.address || offer?.address || "").split(",")[0].trim();
  if (item.contactName && street) return `${item.contactName} · ${street}`;
  if (item.contactName && item.kind?.startsWith("draft")) return item.contactName;
  return item.title || railLabel(item);
}

// The status menu wants to know whether this is its house's current row.
function menuOfferOf(offer, siblings) {
  if (!offer) return null;
  const book = annotateCurrent(siblings.some((o) => o.id === offer.id) ? siblings.map((o) => (o.id === offer.id ? offer : o)) : [offer, ...siblings]);
  const me = book.find((o) => o.id === offer.id) || {};
  return { ...offer, isCurrent: me.isCurrent, supersededBy: me.supersededBy, currentPinned: me.currentPinned, houseOffers: me.houseOffers };
}

/** The app's own actions on this row's person and offer. */
function RowActions({ offer, siblings, offerId, rowOfferId, contactId, name, party, onOpenContact, onEdit, onStatusChanged, coach, onCoachChanged }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);   // { tone, text }
  const menuOffer = menuOfferOf(offer, siblings);
  async function onStatus(key) {
    if (!offer || busy) return;
    setBusy(true); setNote(null);
    try {
      const r = await setOfferStatus(offer.id, key);
      if (r.promoted) setNote({ tone: "green", text: "It's a deal now — it's on the Deals board." });
      onStatusChanged?.();
    } catch (e) {
      setNote({ tone: "red", text: e.message || "That didn't change." });
    } finally { setBusy(false); }
  }
  return (
    <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
      {note && <span className={`text-xs ${note.tone === "red" ? "text-red-700" : "text-emerald-700"}`}>{note.text}</span>}
      {menuOffer && (
        <span className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 py-1" title="Status, Hot and Current for this offer">
          {/* Another of their offers is showing: say which one the menu changes. */}
          <span className="max-w-[12rem] truncate text-xs text-slate-500">{offer.id !== rowOfferId && offer.address ? `${offer.address.split(",")[0]} ·` : "Status"}</span>
          <StatusMenu offer={menuOffer} busy={busy} onSelect={onStatus} onDealNav={() => { window.location.href = `/deals${window.location.search}`; }} />
        </span>
      )}
      {(offer || offerId) && <button type="button" className={ACT} disabled={!offer} onClick={() => onEdit(offer)} title="The full offer (O)"><Pencil size={12} /> Edit offer</button>}
      <CallButton contactId={contactId} name={name} party={party} offerId={offer?.id || offerId || null} address={offer?.address || ""} />
      {contactId && <button type="button" className={ACT} onClick={onOpenContact} title="Their record: facts, offers, timeline"><UserRound size={13} /> Record</button>}
      <CoachIdeas coach={coach} onChanged={onCoachChanged} />
    </div>
  );
}

/** The row's own header: who, which house, why it's here, and its buttons. */
export function RowHeader({ item, targets, index, total, onPrev, onNext, picker, onDone, onDismiss = null, showKeys, onToggleKeys, offer = null, actions = null }) {
  const sev = SEV[item.severity] || SEV.fyi;
  const g = groupOf(item);
  const intent = targets.draft?.intent;
  const heading = rowHeading(item, offer);
  // The pipeline's title says why the row is here; a draft row's is only
  // "name: intent", which the heading and the pills already say.
  // "Sam Lee: we owe them a number" under "Sam Lee · 23706 Sample Dr" says
  // the name twice, so the title loses it.
  const titled = item.contactName && String(item.title || "").startsWith(`${item.contactName}: `) ? item.title.slice(item.contactName.length + 2) : item.title || "";
  const why = titled && item.title !== heading && !String(item.kind || "").startsWith("draft_") ? titled.charAt(0).toUpperCase() + titled.slice(1) : "";
  return (
    <div className="shrink-0 space-y-2 border-b border-slate-200 px-4 py-3">
      <div className="flex items-start gap-3">
        <span className={`mt-2 h-2.5 w-2.5 shrink-0 rounded-full ${sev.dot}`} title={sev.label} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Pill small label={GROUP_LABEL[g]} cls={GROUP_CLS[g]} />
            <Pill small label={KIND_LABEL[item.kind] || item.kind} />
            {item.severity === "now" && <Pill small label="now" cls={SEV.now.cls} />}
            {intent && intent !== "other" && <IntentPill party={targets.party} intent={intent} />}
          </div>
          <h2 className="mt-1 text-base font-bold leading-snug text-slate-900">{heading}</h2>
          {why && <p className="mt-0.5 text-sm font-medium text-slate-800">{why}</p>}
          {item.detail && <p className="mt-0.5 text-sm text-slate-600">{item.detail}</p>}
          {g === "stuck" && item.why && <p className="mt-0.5 text-sm text-amber-800">Stuck because: {item.why}</p>}
          {item.next?.what && <p className="mt-0.5 text-sm text-violet-700">Next: {item.next.what}{item.next.at ? ` · ${whenLabel(item.next.at)}` : ""}</p>}
        </div>
        <div className="relative flex shrink-0 items-center gap-1.5">
          {picker}
          <span className="hidden text-xs tabular-nums text-slate-500 sm:inline">{index + 1} of {total}</span>
          <button type="button" className={NAV} onClick={onPrev} disabled={!onPrev} title="Previous row (K)" aria-label="Previous row"><ChevronLeft size={16} /></button>
          <button type="button" className={NAV} onClick={onNext} disabled={!onNext} title="Next row (J)" aria-label="Next row"><ChevronRight size={16} /></button>
          <button type="button" className={`${NAV} hidden lg:inline-flex`} onClick={onToggleKeys} aria-expanded={showKeys} title="Keys (?)" aria-label="Keyboard keys"><Keyboard size={16} /></button>
          {showKeys && <KeysHelp />}
        </div>
      </div>
      <div className="flex flex-wrap items-start gap-1.5">
        <RowOpsBar item={item} onDone={onDone} onOpenContact={actions?.openContact} hasDraft={Boolean(targets.draft)} hasRecord={Boolean(targets.contactId)} />
        {onDismiss && canDismissRow(item) && (
          <button type="button" className={BTN} onClick={() => onDismiss(item)} title="Take it off Today and go to the next row (D). It comes back if it changes.">Dismiss</button>
        )}
        {actions?.node}
      </div>
    </div>
  );
}

/**
 * <WorkPane … /> — the row's surfaces around one header.
 * `bodies` (tests): { offer, siblings, thread, coach } — render the
 * presentational halves with this data instead of loading it.
 * `settings`: the app's saved settings, for the offer editor.
 */
export default function WorkPane({ item, targets, index, total, onPrev, onNext, picker, onDone, onDismiss = null, sendsEnabled, serverOffsetMs, feedback, showKeys, onToggleKeys, settings = null, bodies = null }) {
  const [tab, setTab] = useState("conversation");   // below lg the two sides are tabs
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

  const fb = useRowFeedback({
    rowId: teachRowId(item), rowKind: item.kind, feedback,
    item: { ...feedbackItemOf(item), contactId: targets.contactId || item.contactId || null, draftId: item.draftId || targets.draftId || null, offerId: targets.offerId || item.offerId || null },
  });

  const drawer = useOpenContact();
  const openContact = () => {
    if (!targets.contactId) return;
    if (drawer) drawer.open(targets.contactId, { party: targets.party, name: item.contactName || null });
    else window.open(ghlContactUrl(targets.contactId), "_blank", "noreferrer");
  };
  const edit = (offer) => setEditing({ offer: offer || null });
  useEffect(() => {
    const onOpen = () => { if (side.offer) edit(side.offer); };
    window.addEventListener(OPEN_OFFER_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_OFFER_EVENT, onOpen);
  });

  const tabBtn = (key, label) => (
    <button type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
      className={`flex-1 border-b-2 px-3 py-2 text-sm font-semibold ${tab === key ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
      {label}
    </button>
  );
  const actions = {
    openContact,
    node: (
      <RowActions offer={side.offer} siblings={side.siblings} offerId={offerId} rowOfferId={side.replaced?.id === targets.offerId ? side.offer?.id : targets.offerId} contactId={targets.contactId}
        name={item.contactName || targets.draft?.contactName || ""} party={targets.party}
        onOpenContact={openContact} onEdit={edit} onStatusChanged={() => { side.reload(); onDone?.(); }}
        coach={coach} onCoachChanged={coachLoad.reload} />
    ),
  };
  const convo = { item, targets, sendsEnabled, serverOffsetMs, onDone, fb, taught: coach?.taught || [] };
  return (
    <section aria-label="The row you're working" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white">
      <RowHeader item={item} targets={targets} index={index} total={total} onPrev={onPrev} onNext={onNext} picker={picker}
        onDone={onDone} onDismiss={onDismiss} showKeys={showKeys} onToggleKeys={onToggleKeys} offer={side.offer} actions={actions} />

      <div role="tablist" className="flex shrink-0 border-b border-slate-200 lg:hidden">
        {tabBtn("conversation", "Conversation")}
        {tabBtn("offer", "Offer")}
      </div>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className={`${tab === "offer" ? "block" : "hidden"} min-h-0 overflow-y-auto lg:block lg:border-r lg:border-slate-200`}>
          <OfferPanelBody offer={side.offer} siblings={side.siblings} item={{ ...item, offerId }} loading={side.loading || theirs.loading} error={side.error}
            replaced={side.replaced} onRequote={requote} requoting={requoting} onSelectOffer={setOfferId} onEdit={edit} />
        </div>
        <div className={`${tab === "conversation" ? "flex" : "hidden"} h-[65vh] min-h-0 flex-col lg:flex lg:h-auto`}>
          {bodies
            ? <ConversationPanelBody {...convo} thread={bodies.thread} />
            : <ConversationPanel {...convo} />}
        </div>
      </div>

      {editing && (
        <OfferEditorSheet offer={editing.offer} settings={settings} contactId={targets.contactId}
          onClose={() => setEditing(null)}
          onSaved={(o) => { side.reload(); onDone?.(); if (o?.id && !editing.offer) setOfferId(o.id); }}
          onOpenOffer={(o) => { setEditing({ offer: o }); if (o?.id) setOfferId(o.id); }} />
      )}
    </section>
  );
}
