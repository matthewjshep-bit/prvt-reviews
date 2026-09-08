// ContactDrawer.jsx — everything the app knows about one person, in a
// slide-over. Opened from any contact name (ContactLink.jsx); mounted once at
// the app root so both hosts have it.
//
// The record is the app's own (contact_profiles + contact_events); the GHL
// contact is a digest of it. So: facts carry where they came from — violet
// when the AI inferred them from a text, a call or the sweep, slate when a
// person stated them or a record produced them — and removing one here is
// the one place a fact is genuinely forgotten (the sweep can't put it back)
// and the GHL field is re-rendered without it.

import React, { useEffect, useMemo, useState } from "react";
import {
  X, ExternalLink, RefreshCw, Loader2, Plus, Send, RefreshCw as Revise, ArrowLeftRight, XCircle, Clock, CheckCircle2,
  ThumbsUp, ThumbsDown, FileSignature, Milestone, Eye, Handshake, MessageSquareQuote, Megaphone, FolderOpen, Phone,
  MessageSquare, StickyNote, Sparkles, Tag, Crosshair, Lightbulb, Eraser, Download, Circle, Trash2,
} from "lucide-react";
import { EVENT_LABEL, EVENT_ICON, FACT_KEYS, factKeysFor, AI_SOURCES, SOURCE_LABEL, groupByDay } from "@shared/contact-record.js";
import { PASS_REASON_LABEL } from "@shared/conversation-ai.js";
import { summarizeFeedback } from "@shared/conversation-ai.js";
import { fmtMoney } from "@shared/offer-calc.js";
import { getContactProfile, saveContactFacts, addContactEvent, ghlContactUrl } from "./api.js";
import { BTN, BTN_PRIMARY, Pill, StatusPill, StagePill } from "./ui.jsx";
import { PartyPill, DraftRow } from "./ConversationOutbox.jsx";

const ICONS = {
  Send, RefreshCw: Revise, ArrowLeftRight, XCircle, Clock, CheckCircle2, ThumbsUp, ThumbsDown, FileSignature, Milestone, Eye, Handshake,
  MessageSquareQuote, Megaphone, FolderOpen, Phone, MessageSquare, StickyNote, Sparkles, Tag, Crosshair, Lightbulb, Eraser, Download,
};
const EventIcon = ({ type, size = 13 }) => { const I = ICONS[EVENT_ICON[type]] || Circle; return <I size={size} className="shrink-0" />; };
const INPUT = "rounded-lg border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none";
const money = (v) => (Number(v) > 0 ? fmtMoney(Number(v)) : String(v));
const fmtFact = (key, v) => (FACT_KEYS[key]?.number ? money(v) : FACT_KEYS[key]?.values ? String(v).replace(/_/g, " ") : v);
const when = (iso) => { try { return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch { return ""; } };
const dayLabel = (ymd) => { try { return new Date(`${ymd}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }); } catch { return ymd; } };

function SourceChip({ entry }) {
  const ai = AI_SOURCES.has(entry.source);
  return (
    <span title={`${SOURCE_LABEL[entry.source] || entry.source}${entry.at ? ` · ${when(entry.at)}` : ""}${entry.ref ? ` · ${entry.ref}` : ""}`}
      className={`rounded px-1 text-[10px] font-semibold uppercase tracking-wide ${ai ? "bg-violet-100 text-violet-700" : "bg-slate-200 text-slate-600"}`}>
      {ai ? "AI" : entry.source === "operator" ? "you" : entry.source}
    </span>
  );
}

function Section({ title, children, aside }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function FactsSection({ title, keys, record, busy, onRemove, onAdd }) {
  const [key, setKey] = useState(keys[0]);
  const [value, setValue] = useState("");
  const any = keys.some((k) => (record.entries[k] || []).length);
  useEffect(() => { if (!keys.includes(key)) setKey(keys[0]); }, [keys, key]);
  return (
    <Section title={title}>
      {!any && <div className="text-xs text-slate-400">Nothing on record yet.</div>}
      <div className="space-y-1.5">
        {keys.map((k) => {
          const entries = record.entries[k] || [];
          if (!entries.length) return null;
          const show = FACT_KEYS[k].kind === "list" ? entries : entries.slice(-1);
          return (
            <div key={k} className="flex flex-wrap items-start gap-1.5 text-sm">
              <span className="w-28 shrink-0 pt-0.5 text-xs text-slate-500">{FACT_KEYS[k].label}</span>
              <span className="flex min-w-0 flex-1 flex-wrap gap-1">
                {show.map((e) => (
                  <span key={`${k}:${e.value}`} className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pl-2 pr-1 text-xs text-slate-800">
                    {fmtFact(k, e.value)} <SourceChip entry={e} />
                    <button type="button" disabled={busy} title="Forget this" onClick={() => onRemove(k, e.value)} className="rounded p-0.5 text-slate-400 hover:bg-red-50 hover:text-red-600"><X size={11} /></button>
                  </span>
                ))}
                {FACT_KEYS[k].kind === "scalar" && entries.length > 1 && (
                  <span className="text-[11px] text-slate-400" title={entries.slice(0, -1).map((e) => `${fmtFact(k, e.value)} · ${when(e.at)}`).join("\n")}>was {fmtFact(k, entries[entries.length - 2].value)}</span>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <form className="mt-2 flex flex-wrap items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); if (value.trim()) { onAdd(key, value.trim()); setValue(""); } }}>
        <select value={key} onChange={(e) => setKey(e.target.value)} className={INPUT}>
          {keys.map((k) => <option key={k} value={k}>{FACT_KEYS[k].label}</option>)}
        </select>
        {FACT_KEYS[key]?.values
          ? <select value={value} onChange={(e) => setValue(e.target.value)} className={INPUT}><option value="">choose…</option>{FACT_KEYS[key].values.map((v) => <option key={v} value={v}>{v.replace(/_/g, " ")}</option>)}</select>
          : <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={FACT_KEYS[key]?.number ? "e.g. 450000" : "add…"} className={`${INPUT} min-w-[10rem] flex-1`} />}
        <button type="submit" disabled={busy || !value.trim()} className={BTN}><Plus size={12} /> Add</button>
      </form>
    </Section>
  );
}

function eventLine(ev) {
  const d = ev.data || {};
  switch (ev.type) {
    case "investor_passed":
    case "feedback": return d.code ? `${PASS_REASON_LABEL[d.code] || d.code}${d.reasonNote ? ` — “${d.reasonNote}”` : ""}` : d.note || "";
    case "text_summary":
    case "call_summary": return d.summary || "";
    case "note": return d.text || "";
    case "fact_learned":
    case "fact_removed": return `${FACT_KEYS[d.key]?.label || d.key}: ${fmtFact(d.key, d.value)}`;
    case "tag_added":
    case "tag_removed": return d.tag || "";
    case "deal_stage": return String(d.stage || "").replace(/_/g, " ") + (d.note ? ` — ${d.note}` : "");
    case "offer_sent":
    case "offer_revised": return d.amountText ? `${d.amountText}${d.note ? ` — ${d.note}` : ""}` : d.note || "";
    case "dataroom_viewed": return d.viewCount > 1 ? `view ${d.viewCount}` : "first view";
    case "enrich_run": return d.summary || "";
    case "import": return d.batchName ? `from batch ${d.batchName}` : "";
    default: return d.note || "";
  }
}

export default function ContactDrawer({ contactId, party: hint = null, onClose }) {
  const [rec, setRec] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [showAll, setShowAll] = useState(false);

  const load = async (pull = false) => {
    setError("");
    try { setRec(await getContactProfile(contactId, { pull, party: hint || "" })); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => { setRec(null); if (contactId) load(false); }, [contactId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const party = rec?.party || hint || null;
  const groups = useMemo(() => groupByDay(rec?.events || []), [rec]);
  const shown = showAll ? groups : groups.slice(0, 8);

  const run = async (fn) => { setBusy(true); setError(""); try { const r = await fn(); if (r?.events) setRec(r); else await load(false); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  const removeFact = (key, value) => run(() => saveContactFacts(contactId, { party, remove: [{ key, value }] }));
  const addFact = (key, value) => run(() => saveContactFacts(contactId, { party, add: [{ key, value }] }));
  const addNote = () => { const text = note.trim(); if (!text) return; setNote(""); run(() => addContactEvent(contactId, { type: "note", text, party })); };

  if (!contactId) return null;
  const p = rec?.profile;
  const buyKeys = factKeysFor("investor").filter((k) => k.startsWith("buybox") || k === "rehab_appetite");
  const aboutKeys = (party === "investor" ? factKeysFor("investor") : factKeysFor("agent")).filter((k) => !buyKeys.includes(k));

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div className="flex h-full w-[600px] max-w-full flex-col overflow-y-auto bg-slate-50 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="sticky top-0 z-10 flex items-start gap-3 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-base font-bold text-slate-900">{p?.name || rec?.drafts?.[0]?.contactName || rec?.investor?.name || "Contact"}</span>
              {party && <PartyPill party={party} />}
              {(p?.tags || []).slice(0, 6).map((t) => <Pill key={t} label={t} small />)}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-3 text-xs text-slate-500">
              {p?.phone && <span>{p.phone}</span>}
              {p?.email && <span>{p.email}</span>}
              <a href={ghlContactUrl(contactId)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-blue-600 hover:text-blue-700">Open in GoHighLevel <ExternalLink size={11} /></a>
              <button type="button" disabled={busy} onClick={() => load(true)} className="inline-flex items-center gap-1 hover:text-slate-800" title="Read the GHL contact again and fill any gaps"><RefreshCw size={11} /> Pull from GHL</button>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Close"><X size={18} /></button>
        </header>

        <div className="space-y-3 p-4">
          {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}
          {!rec && !error && <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={14} className="animate-spin" /> Loading their record…</div>}
          {rec && (<>
            {party === "investor" && <FactsSection title="What they buy" keys={buyKeys} record={rec} busy={busy} onRemove={removeFact} onAdd={addFact} />}
            <FactsSection title={party === "investor" ? "About them" : "About them and where they work"} keys={aboutKeys} record={rec} busy={busy} onRemove={removeFact} onAdd={addFact} />

            {(rec.offers.length > 0 || rec.deals.length > 0) && (
              <Section title={party === "investor" ? "Deals they've been on" : "Offers and deals"}>
                <ul className="space-y-1">
                  {rec.offers.map((o) => (
                    <li key={o.id} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-sm">
                      <span className="min-w-0 truncate">{o.address}</span>
                      <span className="flex shrink-0 items-center gap-2 text-xs text-slate-500">{o.cashAmount ? fmtMoney(o.cashAmount) : ""}<StatusPill offer={o} small /></span>
                    </li>
                  ))}
                  {rec.deals.map((d) => (
                    <li key={d.offer.id} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-sm">
                      <span className="min-w-0 truncate">{d.offer.address}</span>
                      <span className="flex shrink-0 items-center gap-2 text-xs">
                        {d.standing && <Pill small label={d.standing.status} cls={d.standing.status === "committed" ? "bg-emerald-100 text-emerald-800" : d.standing.status === "passed" ? "bg-red-100 text-red-700" : "bg-blue-100 text-blue-800"} />}
                        {d.standing?.reason?.code && <span className="text-slate-500" title={d.standing.reason.note || ""}>{PASS_REASON_LABEL[d.standing.reason.code]}</span>}
                        <StagePill stage={d.offer.deal?.stage} small />
                      </span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {rec.feedback.length > 0 && (
              <Section title="What they said about our deals">
                <div className="mb-1.5 flex flex-wrap gap-1">
                  {summarizeFeedback(rec.feedback).byCode.map((c) => <Pill key={c.code} small label={`${c.label}${c.count > 1 ? ` ×${c.count}` : ""}`} cls="bg-amber-50 text-amber-900" />)}
                </div>
                <ul className="space-y-0.5 text-xs text-slate-600">
                  {rec.feedback.slice(0, 8).map((f, i) => <li key={i}><span className="text-slate-400">{f.address}:</span> {f.note ? `“${f.note}”` : PASS_REASON_LABEL[f.code]}</li>)}
                </ul>
              </Section>
            )}

            <Section title="Timeline" aside={<span className="text-[11px] text-slate-400">{rec.events.length} events</span>}>
              <form className="mb-2 flex gap-1.5" onSubmit={(e) => { e.preventDefault(); addNote(); }}>
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note to their record…" className={`${INPUT} flex-1`} />
                <button type="submit" disabled={busy || !note.trim()} className={BTN}><StickyNote size={12} /> Note</button>
              </form>
              {!rec.events.length && <div className="text-xs text-slate-400">Nothing yet. Fill the record from Settings, or pull from GHL above.</div>}
              <ol className="space-y-2">
                {shown.map((g) => (
                  <li key={g.day}>
                    <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{dayLabel(g.day)}</div>
                    <ul className="space-y-0.5">
                      {g.events.map((ev) => (
                        <li key={ev.id || ev.dedupeKey || `${ev.type}:${ev.at}`} className="flex items-start gap-2 text-sm">
                          <span className={`mt-1 ${AI_SOURCES.has(ev.source) ? "text-violet-500" : "text-slate-400"}`}><EventIcon type={ev.type} /></span>
                          <span className="min-w-0 flex-1">
                            <span className="font-medium text-slate-800">{EVENT_LABEL[ev.type] || ev.type}</span>
                            {ev.address && <span className="text-slate-500"> · {ev.address}</span>}
                            {eventLine(ev) && <span className="block text-xs text-slate-600">{eventLine(ev)}</span>}
                          </span>
                          <span className="shrink-0 text-[11px] text-slate-400" title={ev.source}>{when(ev.at).replace(/^[A-Za-z]+ \d+, /, "")}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
              {groups.length > 8 && !showAll && <button type="button" className={`${BTN} mt-2`} onClick={() => setShowAll(true)}>Show all {groups.length} days</button>}
            </Section>

            {rec.drafts.length > 0 && (
              <Section title="Recent conversation AI drafts">
                <ul className="space-y-2">
                  {rec.drafts.slice(0, 5).map((d) => <DraftRow key={d.id} draft={d} sendsEnabled={false} onDone={() => load(false)} />)}
                </ul>
              </Section>
            )}

            {rec.invites.length > 0 && (
              <Section title="Dataroom links">
                <ul className="space-y-0.5 text-xs text-slate-600">
                  {rec.invites.map((i) => (
                    <li key={i.id} className="flex items-center justify-between gap-2">
                      <span>{i.sentAt ? `sent ${when(i.sentAt)}` : "issued, not sent"}{i.status && i.status !== "active" ? ` · ${i.status}` : ""}</span>
                      <span className="text-slate-400">{i.viewCount ? `opened ${i.viewCount}× · last ${when(i.lastViewedAt)}` : "not opened"}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </>)}
        </div>
      </div>
    </div>
  );
}
