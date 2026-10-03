// CallCard.jsx — a Call row's brief, at the top of the work pane.
//
//   ┌ Get it written up today: ask them to represent you …        ┐
//   │ 9311 12th Pl SE · ours 198K · theirs 210K (12K apart)        │
//   │ Say: "Hi Maryanne, it's Matt — on 9311 12th Pl SE, …"  Copy  │
//   │ [Call in GHL]  (425) 555-0101   No answer · Left voicemail · Call back ▾ │
//   └ Tried 1× · last 2:14 PM                                      ┘
//
// The GHL dialer records and transcribes the call; call-intake reads the
// transcript, the row clears itself, and the follow-up text the call leads to
// lands under Decide. A call that didn't connect gets a chip — a call_attempt
// on their record (no words): the row drops for the day, a call-back date
// hides it until then, and after two tries it goes back to the machine.

import React, { useState } from "react";
import { Copy, ExternalLink, Phone } from "lucide-react";
import { getContactProfile, ghlContactUrl } from "./api.js";
import { useLoad } from "./work-data.js";
import { CallOutcomes, recordKey, telHref } from "./CallButton.jsx";
import { whenLabel } from "./RowOps.jsx";
import { BTN, BTN_PRIMARY } from "./ui.jsx";
import { kText } from "@shared/call-list.js";

const street = (a) => String(a || "").split(",")[0].trim();

/** The houses, ours against theirs. */
export function CallHouses({ houses = [], counter = null }) {
  if (!houses.length) return null;
  return (
    <ul className="space-y-0.5 text-sm text-emerald-950">
      {houses.slice(0, 3).map((h) => (
        <li key={h.offerId || h.address}>
          <span className="font-medium">{street(h.address)}</span>
          {h.ours ? <> · ours <b className="tabular-nums">{kText(h.ours)}</b></> : null}
          {h.theirs ? <> · theirs <b className="tabular-nums">{kText(h.theirs)}</b> <span className="text-emerald-800">({kText(h.theirs - h.ours)} apart)</span></> : null}
        </li>
      ))}
      {counter?.ceiling ? (
        <li className="text-xs text-emerald-800">
          Buyer ceiling {kText(counter.ceiling)}{counter.overCeiling ? `: their number is ${kText(counter.overCeiling)} over it` : ": their number is inside it"}
        </li>
      ) : null}
    </ul>
  );
}

/** <CallCard item targets onDone /> — nothing for a row that isn't a call. */
export default function CallCard({ item, targets = {}, onDone, phone: givenPhone = null }) {
  const call = item?.call;
  const contactId = item?.contactId || targets.contactId;
  const rec = useLoad(call && contactId && givenPhone == null ? recordKey(contactId) : null, () => getContactProfile(contactId, { party: targets.party || "" }), { maxAgeMs: 300000 });
  const [copied, setCopied] = useState(false);
  if (!call || !contactId) return null;
  const phone = givenPhone ?? rec.data?.profile?.phone ?? "";
  const tel = telHref(phone);
  const copy = async () => {
    try { await navigator.clipboard.writeText(call.opener); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* the iframe can refuse the clipboard */ }
  };
  return (
    <div className="mt-2 space-y-1.5 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2" aria-label="The call">
      {call.goal && <p className="text-sm font-semibold text-emerald-900">{call.goal}</p>}
      <CallHouses houses={call.houses || []} counter={item.counter || null} />
      {call.opener && (
        <p className="text-sm text-emerald-950">
          <span className="font-semibold text-emerald-800">Say: </span>“{call.opener}”
          <button type="button" className="ml-1.5 inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline" onClick={copy}>
            <Copy size={11} /> {copied ? "Copied" : "Copy"}
          </button>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <a href={ghlContactUrl(contactId)} target="_blank" rel="noreferrer" className={BTN_PRIMARY} title="GHL's dialer records the call, and the transcript clears this row by itself">
          <Phone size={14} /> Call in GHL <ExternalLink size={12} className="opacity-70" />
        </a>
        {tel && <a href={tel} className={BTN} title="Call from this device — then say what happened, or log it from Call">{phone}</a>}
        <CallOutcomes contactId={contactId} party={targets.party || null} offerId={item.offerId || null} address={item.address || ""} onLogged={onDone} />
      </div>
      {call.tries ? <p className="text-xs text-emerald-800">Tried {call.tries}×{call.lastTryAt ? ` · last ${whenLabel(call.lastTryAt)}` : ""}</p> : null}
    </div>
  );
}
