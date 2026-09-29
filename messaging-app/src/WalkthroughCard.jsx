import React, { useEffect, useState } from "react";
import {
  ACCESS_MODES, ACCESS_LABEL, RSVP_STATUSES, RSVP_LABEL, MAX_WINDOWS, normalizeShowing, windowLabel, upcomingWindows,
} from "@shared/showing.js";
import { updateDeal, getAgentAskText, askAgentForWindow, setShowingRsvp } from "./api.js";
import { BTN, BTN_PRIMARY } from "./ui.jsx";

const labelCls = "mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500";
const inputCls = "w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:border-blue-500 focus:outline-none";

const pad = (n) => String(n).padStart(2, "0");
// A stored window, as the three inputs show it (the browser's own time zone —
// the operator's).
const toInputs = (w) => {
  const a = new Date(w.start), b = new Date(w.end);
  return {
    date: `${a.getFullYear()}-${pad(a.getMonth() + 1)}-${pad(a.getDate())}`,
    from: `${pad(a.getHours())}:${pad(a.getMinutes())}`,
    to: `${pad(b.getHours())}:${pad(b.getMinutes())}`,
  };
};
const fromInputs = (r) => {
  if (!r.date || !r.from) return null;
  const start = new Date(`${r.date}T${r.from}`);
  const end = r.to ? new Date(`${r.date}T${r.to}`) : null;
  if (!Number.isFinite(start.getTime())) return null;
  return { start: start.toISOString(), end: end && Number.isFinite(end.getTime()) ? end.toISOString() : null };
};

const RSVP_CLS = {
  interested: "bg-sky-100 text-sky-800", coming: "bg-emerald-100 text-emerald-800", cant_make_it: "bg-slate-200 text-slate-700",
  attended: "bg-emerald-600 text-white", no_show: "bg-rose-100 text-rose-700",
};

/**
 * The buyer walkthrough on a deal (shared/showing.js): the window every buyer
 * text invites them to, who opens the door, the ask to the listing agent, and
 * who has said they're coming.
 */
export default function WalkthroughCard({ offer, onUpdated }) {
  const deal = offer.deal;
  const showing = normalizeShowing(deal.showing);
  const [rows, setRows] = useState(() => showing.windows.map(toInputs));
  const [access, setAccess] = useState(showing.access);
  const [ask, setAsk] = useState(null); // null | { text } while the ask editor is open
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  // A reply filed a new RSVP while the modal was open: keep the editor's
  // unsaved windows, pick up the rest.
  useEffect(() => { setAccess(normalizeShowing(offer.deal.showing).access); }, [offer.deal.showing?.access?.mode]);

  const saved = JSON.stringify({ w: showing.windows.map(toInputs), a: showing.access });
  const dirty = JSON.stringify({ w: rows, a: access }) !== saved;

  async function run(fn, done = "") {
    setError(""); setNote(""); setBusy(true);
    try {
      const r = await fn();
      if (r?.offer) onUpdated(r.offer);
      if (done) setNote(typeof done === "function" ? done(r) : done);
      return r;
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  const save = () => run(() => updateDeal(offer.id, { showing: { windows: rows.map(fromInputs).filter(Boolean), access } }), "Saved. Every buyer text from here invites them to it.");
  const openAsk = async () => {
    const r = await run(() => getAgentAskText(offer.id));
    if (r?.text) setAsk({ text: r.text });
  };
  const sendAsk = async () => {
    const r = await run(() => askAgentForWindow(offer.id, ask.text),
      (x) => (x?.status === "scheduled" ? "Asked. It goes out at the next open minute." : `In the outbox as a draft${x?.reason ? ` (${x.reason})` : ""}.`));
    if (r?.ok) { setAsk(null); onUpdated({ ...offer, deal: { ...deal, showing: { ...showing, agentAsk: { status: "asked", at: new Date().toISOString(), draftId: r.draftId } } } }); }
  };
  const setRsvp = async (contactId, name, status) => {
    const r = await run(() => setShowingRsvp(offer.id, { contactId, name, status }));
    if (r?.showing) onUpdated({ ...offer, deal: { ...deal, showing: r.showing } });
  };

  const next = upcomingWindows(showing)[0];
  const invitable = (deal.investors || []).filter((i) => !showing.rsvps.some((r) => r.contactId === i.contactId));
  const askLine = showing.agentAsk.status === "asked"
    ? `Asked the agent ${showing.agentAsk.at ? new Date(showing.agentAsk.at).toLocaleDateString() : ""} — set the window when they answer.`
    : showing.agentAsk.status === "confirmed" ? "Window agreed with the agent." : "Not asked yet.";

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className={labelCls}>Buyer walkthrough</span>
        <span className="text-xs text-slate-500">{next ? windowLabel(next) : "no window yet"}</span>
      </div>
      <p className="text-xs text-slate-500">
        Every blast and reply asks buyers to commit to this window. With none set, they're asked when they could come.
      </p>

      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-1.5">
          <input type="date" className={inputCls} value={r.date} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, date: e.target.value } : y)))} />
          <input type="time" className={inputCls} value={r.from} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, from: e.target.value } : y)))} />
          <input type="time" className={inputCls} value={r.to} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, to: e.target.value } : y)))} />
          <button type="button" className="px-1 text-slate-400 hover:text-rose-600" title="Remove this window" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      {rows.length < MAX_WINDOWS && (
        <button type="button" className={BTN} onClick={() => setRows((x) => [...x, { date: "", from: "10:00", to: "11:00" }])}>+ Add a window</button>
      )}

      <div className="grid grid-cols-[auto_1fr] items-center gap-2">
        <select value={access.mode} onChange={(e) => setAccess((a) => ({ ...a, mode: e.target.value }))}
          className="rounded-md border border-slate-300 px-1.5 py-1 text-xs focus:border-blue-500 focus:outline-none">
          {ACCESS_MODES.map((m) => <option key={m} value={m}>{m ? ACCESS_LABEL[m] : "Access: not set"}</option>)}
        </select>
        <input className={inputCls} value={access.note} placeholder="Note for you (never texted)" onChange={(e) => setAccess((a) => ({ ...a, note: e.target.value }))} />
      </div>
      {dirty && <button type="button" onClick={save} disabled={busy} className={BTN_PRIMARY}>Save walkthrough</button>}

      <div className="rounded-md bg-slate-50 px-2.5 py-2 text-xs text-slate-600">
        <div className="flex items-center justify-between gap-2">
          <span>Listing agent: {askLine}</span>
          {!ask && <button type="button" className={BTN} disabled={busy} onClick={openAsk}>{showing.agentAsk.status === "none" ? "Ask for a window" : "Ask again"}</button>}
        </div>
        {ask && (
          <div className="mt-2 space-y-1.5">
            <textarea rows={3} className={inputCls} value={ask.text} onChange={(e) => setAsk({ text: e.target.value })} />
            <div className="flex gap-1.5">
              <button type="button" className={BTN_PRIMARY} disabled={busy || !ask.text.trim()} onClick={sendAsk}>Send to {offer.contactName?.split(" ")[0] || "the agent"}</button>
              <button type="button" className={BTN} onClick={() => setAsk(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {(showing.rsvps.length > 0 || invitable.length > 0) && (
        <div className="space-y-1">
          <span className={labelCls}>Who's coming</span>
          {showing.rsvps.map((r) => (
            <div key={r.contactId} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate">{r.name || "a buyer"}</span>
              <select value={r.status} disabled={busy} onChange={(e) => setRsvp(r.contactId, r.name, e.target.value)}
                className={`rounded-full px-2 py-0.5 text-xs font-semibold ${RSVP_CLS[r.status] || ""}`}>
                {RSVP_STATUSES.map((s) => <option key={s} value={s}>{RSVP_LABEL[s]}</option>)}
              </select>
            </div>
          ))}
          {invitable.length > 0 && (
            <select value="" disabled={busy} onChange={(e) => { const i = invitable.find((x) => x.contactId === e.target.value); if (i) setRsvp(i.contactId, i.name, "coming"); }}
              className="mt-1 rounded-md border border-slate-300 px-1.5 py-1 text-xs">
              <option value="">+ Mark a buyer on the deal as coming…</option>
              {invitable.map((i) => <option key={i.contactId} value={i.contactId}>{i.name || i.contactId}</option>)}
            </select>
          )}
        </div>
      )}
      {note && <p className="text-xs text-emerald-700">{note}</p>}
      {error && <p className="text-xs text-rose-700">{error}</p>}
    </div>
  );
}
