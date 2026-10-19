// OfferPane.jsx — one offer, worked in the Offers split and on Tier 1 in the
// same pane as a Desk row (ContactPane.jsx).
//
// What's the Offers page's own: "n of N" and ‹ › walk the rail, ✕ (Esc)
// goes back to the table, Send texts or emails the offer, and Details (the
// full offer window: documents, PSA, contract, assignment, net sheet) is in
// ⋯. Their open draft comes from GET /automations/conversation?contact_id= —
// the box is that draft when the bot has one, a plain reply box otherwise.

import React, { useMemo } from "react";
import { FileText, Send } from "lucide-react";
import { getReplyDrafts } from "./api.js";
import { BTN } from "./ui.jsx";
import { usePane } from "./PaneParts.jsx";
import ContactPane, { PaneNav } from "./ContactPane.jsx";
import { forget, useLoad } from "./work-data.js";
import { rowTargets } from "./work-queue.js";
import { offerPaneItem } from "./offers-split.js";

export const draftsKey = (contactId) => (contactId ? `drafts-of:${contactId}` : null);
export const loadDrafts = (contactId) => () => getReplyDrafts({ contactId });

/**
 * <OfferPane offer index total onPrev onNext onClose onDetails onSend onChanged onStatusChanged onDeal settings picker bodies />
 *   offer            the lean list row (the full document is read by the pane)
 *   onChanged()      something about this person moved (a send, the Bot menu): re-read their rows
 *   onStatusChanged(r) the status menu's answer, to patch the table's copy
 *   bodies           tests only: { offer, siblings, thread, coach, timeline, drafts }
 */
export default function OfferPane({ offer, index, total, onPrev, onNext, onClose, onDetails, onSend, onChanged, onStatusChanged, onDeal = null, settings = null, picker = null, bodies = null }) {
  const item = useMemo(() => offerPaneItem(offer), [offer.id, offer.contactId, offer.contactName, offer.address]);   // eslint-disable-line react-hooks/exhaustive-deps
  const dl = useLoad(bodies ? null : draftsKey(offer.contactId), loadDrafts(offer.contactId), { maxAgeMs: 30000 });
  const data = bodies ? { drafts: bodies.drafts || [], sendsEnabled: Boolean(bodies.sendsEnabled), now: null } : dl.data;
  const targets = useMemo(() => rowTargets(item, data?.drafts || []), [item, data]);
  const serverOffsetMs = data?.now ? Date.now() - Date.parse(data.now) : 0;
  const done = () => { forget(draftsKey(offer.contactId)); dl.reload(); onChanged?.(offer); };
  const pane = usePane({ item, targets, bodies, onDone: done });
  const convo = { item, targets, sendsEnabled: Boolean(data?.sendsEnabled), serverOffsetMs, onDone: done, fb: pane.fb, taught: pane.coach?.taught || [], bot: pane.timeline?.bot || null };
  const shown = pane.side.offer || offer;
  return (
    <ContactPane pane={pane} item={item} targets={targets} convo={convo} label="The offer you're working" rowOfferId={offer.id}
      onStatusChanged={onStatusChanged} onDeal={onDeal} settings={settings} bodies={bodies} onDone={done}
      nav={<PaneNav index={index} total={total} onPrev={onPrev} onNext={onNext} onClose={onClose} noun="offer" picker={picker} />}
      lead={offer.contactId && offer.status !== "draft" && (
        <button type="button" className={BTN} onClick={() => onSend?.(shown)} title="Text or email the offer documents">
          <Send size={13} /> Send
        </button>
      )}
      moreItems={onDetails ? [{ key: "details", label: "Details: documents, PSA, contract", icon: <FileText size={13} />, onSelect: () => onDetails(offer) }] : []} />
  );
}
