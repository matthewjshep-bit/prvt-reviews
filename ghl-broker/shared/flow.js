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
 *   → { stages, feed, totals, items, itemsTotal, itemsTruncated }
 *
 *   stages  [{ key, side, label, hint, count, machine, person, sub, conversion }]
 *           conversion = share of the previous stage in the same row that
 *           reached this one (null on a row's first stage or when the
 *           previous is 0)
 *   feed    newest first, capped: [{ id, at, type, label, address, contactId,
 *           contactName, offerId, machine, side, detail }]
 *   totals  { machine, person, events }
 *   items   the records behind ONE stage — the drill-down. Empty unless
 *           `itemsFor` names a stage key.
 *
 * `itemsFor` is how a tile explains itself: the count alone says twelve
 * agents replied, and the only useful next question is WHICH twelve. It is
 * opt-in because /flow is polled every thirty seconds — collecting all twelve
 * stages' rows on every poll would multiply the payload to say nothing new,
 * since most of them are already in the feed. With itemsFor null the output
 * is what it always was, byte for byte.
 *
 * The invariant that matters: one bump is one item. The tile's count and the
 * drill-down's length are incremented by the same call, so they cannot drift.
 */
export function buildFlow({ offers = [], events = [], drafts = [], jobs = [], now = Date.now(), windowStartMs, windowEndMs, feedLimit = 200, itemsFor = null, itemsLimit = 300 } = {}) {
  const a = windowStartMs ?? now - 7 * 86400000;
  const b = windowEndMs ?? now;
  const counts = Object.fromEntries(FLOW_STAGES.map((s) => [s.key, { count: 0, machine: 0, person: 0, sub: "" }]));
  const items = [];
  const bump = (key, machine, item = null) => {
    const c = counts[key];
    c.count += 1;
    if (machine) c.machine += 1; else c.person += 1;
    // The stage's verdict wins over the row's own source. A reply is a
    // person's act whoever wrote it down — a text_summary row carries source
    // "conversation" because the BOT summarised the text, not because the
    // agent's text was automated. Stamping the item from the same argument
    // that moved the counter is what makes the two unable to drift.
    if (item && key === itemsFor) items.push(item.machine === machine ? item : { ...item, machine });
  };

  const names = new Map();
  for (const o of offers) if (o?.contactId && o.contactName) names.set(o.contactId, o.contactName);
  for (const d of drafts) if (d?.contactId && d.contactName) names.set(d.contactId, d.contactName);
  for (const e of events) if (e?.contactId && e.data?.contactName) names.set(e.contactId, e.data.contactName);

  /* --- events-driven stages --- */
  const replied = new Set();
  // deal key → the blast event that first put it in front of a buyer. A Map,
  // not a Set, because the machine/person split has to be answerable PER DEAL
  // (see below) and the drill-down needs the row itself.
  const blastedDeals = new Map(); const keylessBlasts = []; let blastedBuyers = 0;
  const openedBuyers = new Set();
  const outreachOpen = new Map(); // contactId → first outreach_sent ms
  for (const e of events) {
    const t = ms(e.at);
    if (!inWin(t, a, b)) continue;
    const m = machineDid(e);
    switch (e.type) {
      case "import": bump("found", m, feedRow(e, names)); break;
      case "outreach_enrolled": if (e.data?.kind === "followup") break; // a second text, not a first
      // falls through — a workflow enrollment is the first text, sent by GHL
      case "outreach_sent": bump("first_text", m, feedRow(e, names)); if (!outreachOpen.has(e.contactId)) outreachOpen.set(e.contactId, t); break;
      case "text_summary":
      case "call_summary": {
        // A reply is a person's act, always. Counted once per contact.
        if (e.contactId && !replied.has(e.contactId)) { replied.add(e.contactId); bump("replied", false, feedRow(e, names)); }
        break;
      }
      case "offer_sent": bump("offered", m, feedRow(e, names)); break;
      case "realm_yes": break; // shown on the float's sub-line
      case "deal_promoted": bump("contract", false, feedRow(e, names)); break;
      case "blast_sent": {
        blastedBuyers++;
        const key = e.offerId || e.address;
        if (key) { if (!blastedDeals.has(key)) blastedDeals.set(key, e); } else keylessBlasts.push(e);
        break;
      }
      case "dataroom_viewed": if (e.contactId && !openedBuyers.has(`${e.contactId}|${e.offerId || e.address}`)) { openedBuyers.add(`${e.contactId}|${e.offerId || e.address}`); bump("opened", false, feedRow(e, names)); } break;
      case "investor_committed": bump("buyer", false, feedRow(e, names)); break;
      case "deal_stage": if (e.data?.stage === "assigned" || e.data?.stage === "closed") bump("closed", false, feedRow(e, names)); break;
      default: break;
    }
  }
  // Blasted counts DEALS, not buyers — one house in front of four hundred
  // people is one blast — so the buyers ride on the sub-line. The split is
  // per deal: it used to ask "was ANY blast in this window automatic?" and
  // then mark every deal that way, which meant one hand-sent blast among ten
  // automatic ones coloured the whole tile by hand. One bump per deal fixes
  // that and is what lets the drill-down agree with the number above it.
  for (const e of blastedDeals.values()) bump("blasted", machineDid(e), feedRow(e, names));
  // A blast that named neither an offer nor an address can't be folded into a
  // deal; counted on its own only when nothing else claimed the stage.
  if (!blastedDeals.size) for (const e of keylessBlasts) bump("blasted", machineDid(e), feedRow(e, names));
  if (counts.blasted.count) counts.blasted.sub = `${blastedBuyers} buyer${blastedBuyers === 1 ? "" : "s"}`;

  /* --- offer-driven stages --- */
  let held = 0, clear = 0, realmYes = 0;
  const counteredInWin = (o) => (o.statusHistory || []).some((h) => h.status === "countered" && inWin(ms(h.ts), a, b))
    || (o.counter?.at && inWin(ms(o.counter.at), a, b));
  const sentInWin = (o) => (o.sends || []).some((s) => inWin(ms(s.ts), a, b));
  const hasOfferSentEvent = events.some((e) => e.type === "offer_sent");
  for (const o of offers) {
    if (!o?.id) continue;
    const created = ms(o.createdAt);
    // Every offer item is stamped with the timestamp that QUALIFIED it for
    // the stage — not createdAt — or the drill-down's day grouping would file
    // a Tuesday underwrite of a Friday offer under Friday.
    const uwAt = o.autoUnderwrite?.finishedAt || o.createdAt;
    if (isAiGenerated(o) && inWin(ms(uwAt), a, b)) {
      bump("underwritten", true, offerItem(o, uwAt, true));
      if (needsAiReview(o) && effectiveStatus(o) === "draft") held++; else clear++;
    }
    // Sends: the offer's own send ledger, when the timeline has no offer_sent
    // rows (sends from the button write the ledger; the automation writes both).
    if (!hasOfferSentEvent && sentInWin(o)) {
      const sentAt = (o.sends || []).filter((s) => inWin(ms(s.ts), a, b)).map((s) => s.ts).sort().at(-1);
      bump("offered", false, offerItem(o, sentAt, false));
    }
    const t = ms(o.proactive?.takeCheckAt), r = ms(o.proactive?.realmCheckAt);
    if (inWin(t, a, b) || inWin(r, a, b)) {
      const floatAt = [o.proactive?.takeCheckAt, o.proactive?.realmCheckAt].filter((x) => inWin(ms(x), a, b)).sort().at(-1);
      bump("floated", true, offerItem(o, floatAt, true));
    }
    if (o.realm?.answer === "yes" && inWin(ms(o.realm?.at), a, b)) realmYes++;
    if (counteredInWin(o)) {
      const cAt = (o.statusHistory || []).filter((h) => h.status === "countered" && inWin(ms(h.ts), a, b)).map((h) => h.ts).sort().at(-1) || o.counter?.at;
      bump("countered", false, offerItem(o, cAt, false));
    }
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
    .map((e) => feedRow(e, names))
    .sort((x, y) => String(y.at).localeCompare(String(x.at)))
    .slice(0, feedLimit);

  /* --- the drill-down --- */
  // Newest first BEFORE the cap: the store hands events back oldest-first, so
  // capping during collection would keep the stalest rows and call them the
  // top of the list.
  const itemsTotal = items.length;
  items.sort((x, y) => String(y.at).localeCompare(String(x.at)));
  const capped = items.slice(0, itemsLimit);

  const totals = {
    machine: stages.reduce((n, s) => n + s.machine, 0) + autoSent,
    person: stages.reduce((n, s) => n + s.person, 0) + personSent,
    events: feed.length,
    messages: { autoSent, personSent },
  };
  return { stages, feed, totals, items: capped, itemsTotal, itemsTruncated: itemsTotal > capped.length };
}

// One timeline row, in the shape both the feed and the drill-down render.
// Built in exactly one place so a row means the same thing wherever it is
// shown — the contact link, the offer link, the machine tint and the detail
// line all key off these fields.
export function feedRow(e, names) {
  return {
    kind: "event",
    id: e.id || e.dedupeKey || `${e.type}:${e.contactId}:${e.at}`,
    at: e.at, type: e.type, label: EVENT_LABEL[e.type] || e.type, address: e.address || "",
    contactId: e.contactId || null, contactName: names.get(e.contactId) || e.data?.contactName || "",
    offerId: e.offerId || null, machine: machineDid(e), side: DISPO_EVENTS.has(e.type) ? "dispo" : "agent",
    detail: feedDetail(e),
    source: e.source || "",
  };
}

// The four offer-driven stages have no timeline row to show — the record IS
// the offer — so they carry the house, the number and where it stands.
export function offerItem(o, at, machine) {
  return {
    kind: "offer",
    id: o.id, at: at || o.createdAt || null, offerId: o.id,
    contactId: o.contactId || null, contactName: o.contactName || "",
    address: o.address || "", cashAmount: o.cashAmount ?? null,
    status: effectiveStatus(o), machine: Boolean(machine),
  };
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
