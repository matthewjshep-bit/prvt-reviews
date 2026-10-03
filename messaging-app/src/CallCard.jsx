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
import SendModal from "./SendModal.jsx";
import { Copy, ExternalLink, Phone } from "lucide-react";
import { dismissReplyDraft, getContactProfile, getHoldText, ghlContactUrl, requoteOffer, setOfferStatus } from "./api.js";
import { useLoad } from "./work-data.js";
import { CallOutcomes, recordKey, telHref } from "./CallButton.jsx";
import { whenLabel } from "./RowOps.jsx";
import { BTN, BTN_DANGER, BTN_PRIMARY } from "./ui.jsx";
import { COMPOSE_EVENT } from "./work-queue.js";
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

const dollars = (v) => `$${Math.round(Number(v) || 0).toLocaleString("en-US")}`;
const toNumber = (v) => {
  const t = String(v || "").trim().toLowerCase().replace(/[$,\s]/g, "");
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(t);
  if (!m) return 0;
  return Math.round(Number(m[1]) * (m[2] === "m" ? 1e6 : m[2] === "k" ? 1e3 : 1));
};

/**
 * A counter above our number — Matt's call, never the machine's
 * (never-above-what-we-sent). Four answers, each a tap:
 *   Hold our number  the words, at the lowest number we've put to them, go in
 *                    the reply box (GET /:id/hold); Send is yours
 *   Meet at $X       re-quote to X (ours < X ≤ theirs), then the letter goes
 *                    out through the usual Send window
 *   Call them        the card's Call in GHL
 *   Walk away        we pass on the house; the machine stops texting about it
 */
export function CounterAnswers({ item, onDone }) {
  const c = item?.counter;
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState(null);
  const [meetOpen, setMeetOpen] = useState(false);
  const [meet, setMeet] = useState("");
  const [walkAsk, setWalkAsk] = useState(false);
  const [sending, setSending] = useState(null);   // the re-quoted offer, for the Send window
  if (!c || !item.offerId) return null;
  const run = async (label, fn) => {
    setBusy(label); setNote(null);
    try { await fn(); } catch (e) { setNote({ tone: "red", text: e.message || "That didn't work." }); }
    finally { setBusy(""); }
  };
  const hold = () => run("hold", async () => {
    const r = await getHoldText(item.offerId);
    window.dispatchEvent(new CustomEvent(COMPOSE_EVENT, { detail: { text: r.text } }));
    setNote({ tone: "green", text: `In the reply box at ${dollars(r.amount)}. Read it, then Send.` });
  });
  const x = toNumber(meet);
  const meetProblem = !meet ? "" : !x ? "a number, like 705000 or 705k"
    : x <= c.ours ? `that's not above our ${dollars(c.ours)}` : x > c.theirs ? `that's more than they asked (${dollars(c.theirs)})` : "";
  const overCeiling = x && c.ceiling && x > c.ceiling;
  const doMeet = () => run("meet", async () => {
    const r = await requoteOffer(item.offerId, x);
    setMeetOpen(false);
    setSending(r.offer || null);
    setNote({ tone: "green", text: `Re-quoted at ${dollars(x)}. Send the letter when it's ready.` });
  });
  const walk = () => run("walk", async () => {
    await setOfferStatus(item.offerId, "we_passed", `walked away from their ${dollars(c.theirs)} counter at our ${dollars(c.ours)}`);
    if (c.draftId) await dismissReplyDraft(c.draftId).catch(() => {});
    onDone?.();
  });
  return (
    <div className="space-y-1.5" role="group" aria-label="Answer the counter">
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" className={BTN} disabled={Boolean(busy)} onClick={hold} title="Re-state the lowest number we've put to them, in the reply box">
          {busy === "hold" ? "…" : "Hold our number"}
        </button>
        <button type="button" className={BTN} disabled={Boolean(busy)} aria-expanded={meetOpen} onClick={() => setMeetOpen((v) => !v)}>Meet at…</button>
        {walkAsk ? (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-950">
            Pass on {String(item.address || "it").split(",")[0]}?
            <button type="button" className={BTN_DANGER} disabled={Boolean(busy)} onClick={walk}>{busy === "walk" ? "…" : "Yes, walk away"}</button>
            <button type="button" className={BTN} onClick={() => setWalkAsk(false)}>No</button>
          </span>
        ) : (
          <button type="button" className={BTN_DANGER} disabled={Boolean(busy)} onClick={() => setWalkAsk(true)}>Walk away</button>
        )}
      </div>
      {meetOpen && (
        <div className="flex flex-wrap items-center gap-1.5">
          <input aria-label="Meet at" inputMode="numeric" placeholder={`between ${dollars(c.ours + 1000)} and ${dollars(c.theirs)}`} value={meet} onChange={(e) => setMeet(e.target.value)}
            className="w-52 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-sm focus:border-blue-500 focus:outline-none" />
          <button type="button" className={BTN_PRIMARY} disabled={!x || Boolean(meetProblem) || Boolean(busy)} onClick={doMeet}>{busy === "meet" ? "…" : `Re-quote at ${x ? dollars(x) : "…"}`}</button>
          {meetProblem && <span className="text-xs text-red-700">{meetProblem}</span>}
          {!meetProblem && overCeiling && <span className="text-xs text-amber-800">{dollars(x - c.ceiling)} over the buyer ceiling: your call.</span>}
        </div>
      )}
      {note && <p className={`text-xs ${note.tone === "red" ? "text-red-700" : "text-emerald-800"}`}>{note.text}</p>}
      {sending && <SendModal offer={sending} onClose={() => setSending(null)} onSent={async () => {
        setSending(null);
        if (c.draftId) await dismissReplyDraft(c.draftId).catch(() => {});
        onDone?.();
      }} />}
    </div>
  );
}

/** <CallCard item targets onDone /> — nothing for a row that isn't a call. *//** <CallCard item targets onDone /> — nothing for a row that isn't a call. */
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
      <CounterAnswers item={item} onDone={onDone} />
      {call.tries ? <p className="text-xs text-emerald-800">Tried {call.tries}×{call.lastTryAt ? ` · last ${whenLabel(call.lastTryAt)}` : ""}</p> : null}
    </div>
  );
}
