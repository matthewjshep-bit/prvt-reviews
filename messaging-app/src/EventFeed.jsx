// EventFeed.jsx — the timeline, as one renderer.
//
// Lifted from the contact drawer so a person's record and the location-wide
// Flow feed draw an event the same way: the icon, the label, the address,
// the one-line detail, the time, and a violet tint when the machine did it.
// Rows may carry a contact link and an offer link; the drawer passes neither.

import React from "react";
import {
  Send, RefreshCw, ArrowLeftRight, XCircle, Clock, CheckCircle2, ThumbsUp, ThumbsDown, FileSignature, Milestone, Eye, Handshake,
  MessageSquareQuote, Megaphone, FolderOpen, Phone, MessageSquare, StickyNote, Sparkles, Tag, Crosshair, Lightbulb, Eraser, Download,
  Calculator, ClipboardList, Circle, BellRing, CalendarCheck,
} from "lucide-react";
import { EVENT_LABEL, EVENT_ICON, AI_SOURCES, FACT_KEYS, PROPERTY_DETAIL_FIELDS } from "@shared/contact-record.js";
import { PASS_REASON_LABEL } from "@shared/conversation-ai.js";
import { fmtMoney } from "@shared/offer-calc.js";
import ContactLink from "./ContactLink.jsx";
import { offerEditorUrl } from "./api.js";

const ICONS = {
  Send, RefreshCw, ArrowLeftRight, XCircle, Clock, CheckCircle2, ThumbsUp, ThumbsDown, FileSignature, Milestone, Eye, Handshake,
  MessageSquareQuote, Megaphone, FolderOpen, Phone, MessageSquare, StickyNote, Sparkles, Tag, Crosshair, Lightbulb, Eraser, Download,
  Calculator, ClipboardList, BellRing, CalendarCheck,
};
export const EventIcon = ({ type, size = 13 }) => { const I = ICONS[EVENT_ICON[type]] || Circle; return <I size={size} className="shrink-0" />; };

const money = (v) => (Number(v) > 0 ? fmtMoney(Number(v)) : String(v));
const fmtFact = (key, v) => (FACT_KEYS[key]?.number ? money(v) : FACT_KEYS[key]?.values ? String(v).replace(/_/g, " ") : v);
export const when = (iso) => { try { return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch { return ""; } };
export const dayLabel = (ymd) => { try { return new Date(`${ymd}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }); } catch { return ymd; } };

export function eventLine(ev) {
  const d = ev.data || {};
  switch (ev.type) {
    case "investor_passed":
    case "feedback": return d.code ? `${PASS_REASON_LABEL[d.code] || d.code}${d.reasonNote ? ` — “${d.reasonNote}”` : ""}` : d.note || "";
    case "text_summary":
    case "call_summary": return d.summary || (d.transcribed === false ? "no transcript" : "");
    case "note": return d.text || "";
    case "fact_learned":
    case "fact_removed": return `${FACT_KEYS[d.key]?.label || d.key}: ${fmtFact(d.key, d.value)}`;
    case "tag_added":
    case "tag_removed": return d.tag || "";
    case "deal_stage": return String(d.stage || "").replace(/_/g, " ") + (d.note ? ` — ${d.note}` : "");
    case "offer_sent":
    case "offer_revised": return d.amountText ? `${d.amountText}${d.note ? ` — ${d.note}` : ""}` : [d.channels?.join(" + "), d.by === "underwrite" ? "after a clean underwrite" : d.by === "conversation" ? "from a reply" : ""].filter(Boolean).join(" · ") || d.note || "";
    case "offer_countered": return d.amount ? `at ${money(d.amount)}` : d.note || "";
    case "dataroom_viewed": return d.viewCount > 1 ? `view ${d.viewCount}` : "first view";
    case "property_details": return PROPERTY_DETAIL_FIELDS.filter((f) => d[f.key] != null).map((f) => `${f.label.toLowerCase()}: ${f.number ? money(d[f.key]) : f.values ? String(d[f.key]).replace(/_/g, " ") : d[f.key]}`).join(" · ");
    case "agent_estimate": return [d.arv ? `worth ${money(d.arv)} done` : "", d.rehab ? `about ${money(d.rehab)} of work` : ""].filter(Boolean).join(" · ") + (d.note ? ` — “${d.note}”` : "");
    case "enrich_run": return d.summary || "";
    case "import": return d.batchName ? `from batch ${d.batchName}` : "";
    case "follow_up_sent": return `${String(d.kind || "").replace(/_/g, " ")}${d.step ? ` · day ${d.step}` : ""}`;
    case "blast_sent": return d.label ? String(d.label).replace(/^dispo-/, "") : "";
    case "call_booked": return d.label || "";
    default: return d.note || "";
  }
}

/**
 * <EventDayGroups groups={[{ day, events }]} withLinks />
 * `withLinks` adds the contact name (opens the drawer) and the address as an
 * offer link when the row carries an offerId — the Flow feed's shape.
 */
export function EventDayGroups({ groups = [], withLinks = false, party = null }) {
  return (
    <ol className="space-y-2">
      {groups.map((g) => (
        <li key={g.day}>
          <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{dayLabel(g.day)}</div>
          <ul className="space-y-0.5">
            {g.events.map((ev) => {
              const machine = ev.machine ?? AI_SOURCES.has(ev.source);
              const line = ev.detail ?? eventLine(ev);
              return (
                <li key={ev.id || ev.dedupeKey || `${ev.type}:${ev.at}`} className="flex items-start gap-2 text-sm">
                  <span className={`mt-1 ${machine ? "text-violet-500" : "text-slate-400"}`} title={machine ? "the machine did this" : "a person did this"}><EventIcon type={ev.type} /></span>
                  <span className="min-w-0 flex-1">
                    {withLinks && ev.contactId && (
                      <span className="mr-1"><ContactLink contactId={ev.contactId} name={ev.contactName || "contact"} party={ev.side === "dispo" ? "investor" : party || "agent"} stopPropagation /></span>
                    )}
                    <span className="font-medium text-slate-800">{ev.label || EVENT_LABEL[ev.type] || ev.type}</span>
                    {ev.address && (withLinks && ev.offerId
                      ? <a href={offerEditorUrl(ev.offerId)} target="_blank" rel="noreferrer" className="text-slate-500 hover:text-blue-700"> · {ev.address}</a>
                      : <span className="text-slate-500"> · {ev.address}</span>)}
                    {line && <span className="block text-xs text-slate-600">{line}</span>}
                  </span>
                  <span className="shrink-0 text-[11px] text-slate-400" title={ev.source}>{when(ev.at).replace(/^[A-Za-z]+ \d+, /, "")}</span>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ol>
  );
}
