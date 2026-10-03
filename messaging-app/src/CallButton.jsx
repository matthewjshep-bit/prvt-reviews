// CallButton.jsx — "Call" in Today's work pane header.
//
// Two ways to ring them, and a box for afterwards:
//   • Call from this device — a tel: link (the phone app, or FaceTime /
//     iPhone on a Mac).
//   • Call in GHL — their contact in GoHighLevel, whose dialer records and
//     transcribes the call; the transcript reaches the thread on its own
//     (POST /api/offers/automations/call).
//   • Didn't connect? — No answer / Left voicemail / Call back on a date: a
//     call_attempt on their record (no words), which the Desk's call list
//     reads (shared/call-list.js).
//   • Log the call — a call made from your own phone is invisible to the
//     machine, so say what was agreed. It is a call_summary on their record
//     (POST /api/contacts/:id/events), which the audit and the thread's last
//     activity read like any other call.
//
// The number comes from their record (GET /api/contacts/:id/record) and is
// only shown on screen.

import React, { useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2, Phone, X } from "lucide-react";
import { addContactEvent, getContactProfile, ghlContactUrl, logCallAttempt } from "./api.js";
import { useLoad } from "./work-data.js";

const ACT = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-40";
const LINK = "flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-semibold hover:bg-slate-50";
const CHIP = "rounded-full border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40";
const tomorrowYmd = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);

/** telHref("(206) 555-0123") → "tel:+12065550123"; ten digits are taken as US. */
export function telHref(phone) {
  const digits = String(phone || "").replace(/[^\d+]/g, "");
  const bare = digits.replace(/\+/g, "");
  if (bare.length < 7) return null;
  if (digits.startsWith("+")) return `tel:+${bare}`;
  return `tel:+${bare.length === 10 ? `1${bare}` : bare}`;
}

export const recordKey = (contactId) => (contactId ? `record:${contactId}` : null);

/** No answer · Left voicemail · Call back ▾ — what happened when it didn't connect. */
export function CallOutcomes({ contactId, party = null, offerId = null, address = "", onLogged }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [backOpen, setBackOpen] = useState(false);
  const [backDay, setBackDay] = useState(tomorrowYmd);
  async function log(outcome, callBackAt = null) {
    if (busy) return;
    setBusy(true); setNote(null);
    try {
      await logCallAttempt(contactId, { outcome, callBackAt, party, offerId, address });
      setNote({ tone: "green", text: outcome === "call_back" ? `Back on the list ${new Date(callBackAt).toLocaleDateString([], { month: "short", day: "numeric" })}.` : "Noted." });
      setBackOpen(false);
      onLogged?.();
    } catch (e) {
      setNote({ tone: "red", text: e.message || "That didn't save." });
    } finally { setBusy(false); }
  }
  // 9am Pacific-ish on the day picked, in the browser's own clock.
  const backAt = () => new Date(`${backDay}T09:00:00`).toISOString();
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" role="group" aria-label="If the call didn't connect">
      <button type="button" className={CHIP} disabled={busy} onClick={() => log("no_answer")}>No answer</button>
      <button type="button" className={CHIP} disabled={busy} onClick={() => log("voicemail")}>Left voicemail</button>
      <button type="button" className={CHIP} disabled={busy} aria-expanded={backOpen} onClick={() => setBackOpen((v) => !v)}>Call back…</button>
      {backOpen && (
        <span className="inline-flex items-center gap-1">
          <input type="date" aria-label="Call back on" className="rounded-lg border border-slate-300 bg-white px-2 py-0.5 text-xs" value={backDay} min={tomorrowYmd()}
            onChange={(e) => setBackDay(e.target.value)} />
          <button type="button" className={ACT} disabled={busy || !backDay} onClick={() => log("call_back", backAt())}>Set</button>
        </span>
      )}
      {note && <span className={`text-xs ${note.tone === "red" ? "text-red-700" : "text-emerald-700"}`}>{note.text}</span>}
    </span>
  );
}

/** The popover's contents; what the tests render. */
export function CallPanel({ contactId, name = "", phone = "", loading = false, party = null, offerId = null, address = "" }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);   // { tone, text }
  const tel = telHref(phone);
  async function log() {
    if (!text.trim() || busy) return;
    setBusy(true); setNote(null);
    try {
      await addContactEvent(contactId, { type: "call_summary", text, party, offerId, address });
      setText("");
      setNote({ tone: "green", text: "Logged on their record." });
    } catch (e) {
      setNote({ tone: "red", text: e.message || "That didn't save." });
    } finally { setBusy(false); }
  }
  return (
    <div className="space-y-2">
      <div className="text-xs text-slate-500">
        {loading ? <span className="inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> Reading their number…</span>
          : phone ? <>Call {name || "them"} at <span className="font-semibold tabular-nums text-slate-800">{phone}</span></>
          : "No phone on their record."}
      </div>
      <div className="grid gap-1">
        {tel && <a href={tel} className={`${LINK} text-blue-700`}><Phone size={14} /> Call from this device</a>}
        <a href={ghlContactUrl(contactId)} target="_blank" rel="noreferrer" className={`${LINK} text-slate-700`}
          title="GHL's dialer records the call, and the transcript reaches the thread">
          <ExternalLink size={14} className="shrink-0" />
          <span>Call in GHL<span className="block text-xs font-normal text-slate-500">Recorded and transcribed into the thread</span></span>
        </a>
      </div>
      <div className="border-t border-slate-100 pt-2">
        <div className="mb-1 text-xs font-semibold text-slate-600">Didn't connect?</div>
        <CallOutcomes contactId={contactId} party={party} offerId={offerId} address={address} />
      </div>
      <div className="border-t border-slate-100 pt-2">
        <label htmlFor="work-call-log" className="text-xs font-semibold text-slate-600">Log the call</label>
        <textarea id="work-call-log" rows={2} value={text} maxLength={2000} onChange={(e) => { setText(e.target.value); setNote(null); }}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); log(); } }}
          placeholder="Called from your own phone? What was said and agreed."
          className="mt-1 w-full resize-y rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:border-blue-500 focus:outline-none" />
        <div className="mt-1 flex items-center gap-2">
          {note && <span className={`text-xs ${note.tone === "red" ? "text-red-700" : "text-emerald-700"}`}>{note.text}</span>}
          <button type="button" className={`${ACT} ml-auto`} disabled={busy || !text.trim()} onClick={log}>{busy ? "…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

/** <CallButton contactId name party offerId address /> */
export default function CallButton({ contactId, name = "", party = null, offerId = null, address = "" }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  // Read only once the button is pressed: most rows are answered by text.
  const rec = useLoad(open ? recordKey(contactId) : null, () => getContactProfile(contactId, { party: party || "" }), { maxAgeMs: 300000 });
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    const onClick = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onClick); };
  }, [open]);
  if (!contactId) return null;
  return (
    <span ref={wrap} className="relative inline-flex">
      <button type="button" className={ACT} aria-expanded={open} onClick={() => setOpen((v) => !v)} title="Call them">
        <Phone size={13} /> Call
      </button>
      {open && (
        <div role="dialog" aria-label={`Call ${name || "them"}`} className="absolute right-0 top-full z-30 mt-1 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Call</span>
            <button type="button" className="rounded p-0.5 text-slate-500 hover:bg-slate-100" onClick={() => setOpen(false)} aria-label="Close"><X size={14} /></button>
          </div>
          <CallPanel contactId={contactId} name={name} party={party} offerId={offerId} address={address}
            phone={rec.data?.profile?.phone || ""} loading={rec.loading} />
          {rec.error && <div className="mt-1 text-xs text-red-700">Couldn't read their record — {rec.error}</div>}
        </div>
      )}
    </span>
  );
}
