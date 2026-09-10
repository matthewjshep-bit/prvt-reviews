// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// flow.js — the river: how work moved from stage to stage in a window, and
// how much of each hop the machine did on its own.
//
// The Pipeline tab says where every card sits right now. The Funnel says what
// became of the offers we sent. Neither answers "how is the automated system
// flowing today" — agents found, first texts, replies, underwrites, offers,
// floats, counters, contracts, blasts, packages opened, buyers, closes — with
// the machine's share of each. This does, from the same rows those two read:
// contact_events (the timeline), lean offers, and the reply drafts.
//
// Pure. `now`, the window and every row are passed in.

import { effectiveStatus, isAiGenerated, needsAiReview } from "./offer-status.js";
import { EVENT_LABEL, AI_SOURCES } from "./contact-record.js";

const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };
const inWin = (t, a, b) => t != null && t >= a && t < b;

// The twelve stages, in river order. `side` groups the two rows.
export const FLOW_STAGES = [
  { key: "found",      side: "agent", label: "Found",          hint: "listing agents imported from a pull" },
  { key: "first_text", side: "agent", label: "First text",     hint: "the cold open went out" },
  { key: "replied",    side: "agent", label: "Replied",        hint: "an agent answered, by text or call" },
  { key: "underwritten", side: "agent", label: "Underwritten", hint: "an auto-underwrite finished" },
  { key: "offered",    side: "agent", label: "Offered",        hint: "the documents went to the agent" },
  { key: "floated",    side: "agent", label: "Floated",        hint: "our read or a soft number went out" },
  { key: "countered",  side: "agent", label: "Countered",      hint: "they came back with a number" },
  { key: "contract",   side: "agent", label: "Under contract", hint: "promoted to a deal" },
  { key: "blasted",    side: "dispo", label: "Blasted",        hint: "deals put in front of buyers" },
  { key: "opened",     side: "dispo", label: "Opened",         hint: "a buyer opened the package" },
  { key: "buyer",      side: "dispo", label: "Buyer",          hint: "a committed buyer" },
  { key: "closed",     side: "dispo", label: "Assigned / closed", hint: "assigned, or closed" },
];

// Which side of the river an event belongs to, for the feed's filter.
const DISPO_EVENTS = new Set(["blast_sent", "dataroom_sent", "dataroom_viewed", "investor_evaluating", "investor_committed", "investor_passed", "deal_stage", "feedback"]);

// Did the machine do this? The timeline's own source tells most of it; a
// few events carry an explicit flag.
export function machineDid(ev) {
  const d = ev?.data || {};
  if (d.auto === true) return true;
  if (d.auto === false) return false;
  if (ev.type === "offer_sent") return d.by === "conversation" || d.by === "underwrite";
  if (ev.type === "import") return d.trigger === "daily" || d.auto === true;
  return AI_SOURCES.has(ev?.source);
}

/**
 * buildFlow({ offers, events, drafts, jobs, now, windowStartMs, windowEndMs })
 *   → { stages, feed, totals }
 *
 *   stages  [{ key, side, label, hint, count, machine, person, sub, conversion }]
 *           conversion = share of the previous stage in the same row that
 *           reached this one (null on a row's first stage or when the
 *           previous is 0)
 *   feed    newest first, capped: [{ id, at, type, label, address, contactId,
 *           contactName, offerId, machine, side, detail }]
 *   totals  { machine, person, events }
 */
export function buildFlow({ offers = [], events = [], drafts = [], jobs = [], now = Date.now(), windowStartMs, windowEndMs, feedLimit = 200 } = {}) {
  const a = windowStartMs ?? now - 7 * 86400000;
  const b = windowEndMs ?? now;
  const counts = Object.fromEntries(FLOW_STAGES.map((s) => [s.key, { count: 0, machine: 0, person: 0, sub: "" }]));
  const bump = (key, machine, n = 1) => { const c = counts[key]; c.count += n; if (machine) c.machine += n; else c.person += n; };

  const names = new Map();
  for (const o of offers) if (o?.contactId && o.contactName) names.set(o.contactId, o.contactName);
  for (const d of drafts) if (d?.contactId && d.contactName) names.set(d.contactId, d.contactName);
  for (const e of events) if (e?.contactId && e.data?.contactName) names.set(e.contactId, e.data.contactName);

  /* --- events-driven stages --- */
  const replied = new Set();
  const blastedDeals = new Set(); let blastedBuyers = 0;
  const openedBuyers = new Set();
  const outreachOpen = new Map(); // contactId → first outreach_sent ms
  for (const e of events) {
    const t = ms(e.at);
    if (!inWin(t, a, b)) continue;
    const m = machineDid(e);
    switch (e.type) {
      case "import": bump("found", m); break;
      case "outreach_sent": bump("first_text", m); if (!outreachOpen.has(e.contactId)) outreachOpen.set(e.contactId, t); break;
      case "text_summary":
      case "call_summary": {
        // A reply is a person's act, always. Counted once per contact.
        if (e.contactId && !replied.has(e.contactId)) { replied.add(e.contactId); bump("replied", false); }
        break;
      }
      case "offer_sent": bump("offered", m); break;
      case "realm_yes": break; // shown on the float's sub-line
      case "deal_promoted": bump("contract", false); break;
      case "blast_sent": if (e.offerId || e.address) blastedDeals.add(e.offerId || e.address); blastedBuyers++; if (!blastedDeals.size) bump("blasted", m); break;
      case "dataroom_viewed": if (e.contactId && !openedBuyers.has(`${e.contactId}|${e.offerId || e.address}`)) { openedBuyers.add(`${e.contactId}|${e.offerId || e.address}`); bump("opened", false); } break;
      case "investor_committed": bump("buyer", false); break;
      case "deal_stage": if (e.data?.stage === "assigned" || e.data?.stage === "closed") bump("closed", false); break;
      default: break;
    }
  }
  // Blasted counts deals, buyers ride on the sub-line.
  if (blastedDeals.size) {
    counts.blasted.count = blastedDeals.size;
    const machineBlast = events.some((e) => e.type === "blast_sent" && inWin(ms(e.at), a, b) && machineDid(e));
    counts.blasted.machine = machineBlast ? blastedDeals.size : 0;
    counts.blasted.person = machineBlast ? 0 : blastedDeals.size;
    counts.blasted.sub = `${blastedBuyers} buyer${blastedBuyers === 1 ? "" : "s"}`;
  }

  /* --- offer-driven stages --- */
  let held = 0, clear = 0, realmYes = 0;
  const counteredInWin = (o) => (o.statusHistory || []).some((h) => h.status === "countered" && inWin(ms(h.ts), a, b))
    || (o.counter?.at && inWin(ms(o.counter.at), a, b));
  const sentInWin = (o) => (o.sends || []).some((s) => inWin(ms(s.ts), a, b));
  const hasOfferSentEvent = events.some((e) => e.type === "offer_sent");
  for (const o of offers) {
    if (!o?.id) continue;
    const created = ms(o.createdAt);
    if (isAiGenerated(o) && inWin(ms(o.autoUnderwrite?.finishedAt || o.createdAt), a, b)) {
      bump("underwritten", true);
      if (needsAiReview(o) && effectiveStatus(o) === "draft") held++; else clear++;
    }
    // Sends: the offer's own send ledger, when the timeline has no offer_sent
    // rows (sends from the button write the ledger; the automation writes both).
    if (!hasOfferSentEvent && sentInWin(o)) bump("offered", false);
    const t = ms(o.proactive?.takeCheckAt), r = ms(o.proactive?.realmCheckAt);
    if (inWin(t, a, b) || inWin(r, a, b)) bump("floated", true);
    if (o.realm?.answer === "yes" && inWin(ms(o.realm?.at), a, b)) realmYes++;
    if (counteredInWin(o)) bump("countered", false);
    void created;
  }
  if (counts.underwritten.count) counts.underwritten.sub = `${clear} clear · ${held} held`;
  if (realmYes) counts.floated.sub = `${realmYes} said the number works`;
  const running = jobs.filter((j) => j?.status === "running" || j?.status === "queued").length;
  if (running) counts.underwritten.sub = `${counts.underwritten.sub ? `${counts.underwritten.sub} · ` : ""}${running} running now`;

  /* --- the messaging half's machine share, from drafts --- */
  let autoSent = 0, personSent = 0;
  for (const d of drafts) {
    if (d?.status !== "sent" || !inWin(ms(d.sentAt || d.updatedAt), a, b)) continue;
    if (d.autoSent) autoSent++; else personSent++;
  }

  /* --- conversion, per row --- */
  const stages = FLOW_STAGES.map((s, i) => {
    const c = counts[s.key];
    const prev = i > 0 && FLOW_STAGES[i - 1].side === s.side ? counts[FLOW_STAGES[i - 1].key] : null;
    const conversion = prev && prev.count > 0 ? Math.round((c.count / prev.count) * 100) : null;
    return { ...s, ...c, conversion };
  });

  /* --- the feed --- */
  const feed = events
    .filter((e) => inWin(ms(e.at), a, b) && !["tag_added", "tag_removed", "fact_learned", "fact_removed", "enrich_run", "note", "subject_property_set", "property_details"].includes(e.type))
    .map((e) => ({
      id: e.id || e.dedupeKey || `${e.type}:${e.contactId}:${e.at}`,
      at: e.at, type: e.type, label: EVENT_LABEL[e.type] || e.type, address: e.address || "",
      contactId: e.contactId || null, contactName: names.get(e.contactId) || e.data?.contactName || "",
      offerId: e.offerId || null, machine: machineDid(e), side: DISPO_EVENTS.has(e.type) ? "dispo" : "agent",
      detail: feedDetail(e),
      source: e.source || "",
    }))
    .sort((x, y) => String(y.at).localeCompare(String(x.at)))
    .slice(0, feedLimit);

  const totals = {
    machine: stages.reduce((n, s) => n + s.machine, 0) + autoSent,
    person: stages.reduce((n, s) => n + s.person, 0) + personSent,
    events: feed.length,
    messages: { autoSent, personSent },
  };
  return { stages, feed, totals };
}

// The one line under a feed row.
export function feedDetail(e) {
  const d = e?.data || {};
  switch (e?.type) {
    case "call_summary": return d.summary || (d.transcribed === false ? "no transcript" : "");
    case "text_summary": return d.summary || "";
    case "follow_up_sent": return `${String(d.kind || "").replace(/_/g, " ")}${d.step ? ` · day ${d.step}` : ""}`;
    case "blast_sent": return d.label ? String(d.label).replace(/^dispo-/, "") : "";
    case "offer_countered": return d.amount ? `at $${Number(d.amount).toLocaleString("en-US")}` : "";
    case "offer_sent": return [d.channels?.join(" + "), d.by === "underwrite" ? "after a clean underwrite" : d.by === "conversation" ? "from a reply" : ""].filter(Boolean).join(" · ");
    case "deal_stage": return String(d.stage || "").replace(/_/g, " ");
    case "call_booked": return d.label || "";
    case "dataroom_viewed": return d.viewCount > 1 ? `view ${d.viewCount}` : "first view";
    case "import": return d.batchName ? `from ${d.batchName}` : "";
    case "investor_passed":
    case "feedback": return d.reasonNote || d.code || "";
    default: return d.note || "";
  }
}
