// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// deal-moments.js — the work pane's timeline strip: what happened on one
// house with one person, oldest first, a few words each.
//
// Matt, 2026-10-01: "a tiny timeline of events where the person's name is".
// The pane's header shows the last few of these and, after them, the next
// move (shared/next-follow-up.js). Until then the history was a drawer away
// (Record) or four lines of status changes on the offer side.
//
// Pure: the offer document, this person's timeline events and their reply
// drafts go in. Sources, in order of trust:
//   - the offer: priced, the letter going out, re-quotes, what they said
//     (statusHistory), the realm answer, an agreed price, hot, the deal;
//   - the drafts: their texts, and what actually went out — a nudge is a
//     moment when its draft was SENT, not when the sweep claimed the rung;
//   - the events: calls, a text you typed, stop / pause / pace, promises,
//     the listing going off or back on, an unsubscribe.
//
// Never the words: no message text, no phone, no email, no reason a person
// typed. A moment is a kind, a time, who, and at most a number on the house.

import { MACHINE_STARTED_KINDS } from "./follow-up.js";
import { sameHouse } from "./us-address.js";
import { PACE_LABEL, pauseDay } from "./bot-hold.js";

const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };
const HOUR_MS = 3600000;

/** 385000 → "385K", 416500 → "416.5K", 1250000 → "1.25M". */
export function shortMoney(n) {
  const v = Math.round(Number(n) || 0);
  if (v <= 0) return "";
  if (v >= 1e6) return `${(v / 1e6).toFixed(2).replace(/\.?0+$/, "")}M`;
  return `${(v / 1000).toFixed(1).replace(/\.0$/, "")}K`;
}

// What each machine-started text reads as.
const MACHINE_LABEL = {
  offer_nudge: ["nudge", "nudge went"], counter_nudge: ["nudge", "nudge on their counter"], hot_push: ["pushed", "pushed for paper"],
  passed_checkin: ["checked_in", "checked back in"], agent_pulse: ["checked_in", "checked in"], checkin_due: ["checked_in", "the check-in they asked for"],
  realm_check: ["floated", "floated our number"], take_check: ["asked_take", "asked for their read"], take_ask: ["asked_take", "asked for their read"],
  promise_due: ["update", "told them we're still on it"], price_drop: ["nudge", "price-drop text"], address_chase: ["asked", "asked for the address"],
  outreach_open: ["reached_out", "reached out"], outreach_nudge: ["nudge", "outreach nudge"],
  blast_nudge: ["nudge", "deal nudge"], dataroom_nudge: ["nudge", "package nudge"], buyer_pulse: ["checked_in", "checked in"],
  showing_reminder: ["reminded", "walkthrough reminder"], showing_followup: ["checked_in", "walkthrough follow-up"],
};
const STATUS_MOMENT = {
  countered: ["countered", "them", (h) => `countered ${shortMoney(h.amount)}`.trim()],
  passed: ["passed", "them", () => "they passed"],
  no_response: ["went_quiet", "machine", () => "marked gone quiet"],
  we_passed: ["we_passed", "us", () => "we passed"],
  unavailable: ["unavailable", "them", () => "no longer available"],
  accepted: ["accepted", "them", () => "accepted"],
};
const STAGE_LABEL = { under_contract: "under contract", assigned: "assigned", closed: "closed", fell_through: "fell through" };
// The moments of a back-and-forth.
const CONVERSATION = new Set(["they_wrote", "we_replied", "bot_replied", "you_texted"]);

/**
 * dealMoments({ contactId, offer, events, drafts, now, limit, collapseHours })
 *   → { moments: [{ at, kind, label, who, amount?, count? }], total }
 *
 *   who      "us" (a person on our side), "them", or "machine"
 *   count    a run of the same moment collapsed ("they wrote ×3")
 *   total    how many there were before the newest `limit` were kept
 */
export function dealMoments({ contactId = "", offer = null, events = [], drafts = [], now = Date.now(), limit = 40, collapseHours = 36 } = {}) {
  const out = [];
  const add = (at, kind, label, who, extra = {}) => { if (ms(at) != null && label) out.push({ at: new Date(ms(at)).toISOString(), kind, label, who, ...extra }); };
  const address = offer?.address || "";
  // This house, or no house at all (a call, a stop, a text about nothing in
  // particular). Another house of theirs is that house's strip.
  const onThisHouse = ({ offerId = null, address: a = "" } = {}) => {
    if (offer?.id && offerId) return offerId === offer.id;
    if (!a) return true;
    return Boolean(address) && sameHouse(a, address);
  };
  const theirs = (contactId ? (drafts || []).filter((x) => x?.contactId === contactId) : drafts || []).filter(Boolean);
  const mine = (contactId ? (events || []).filter((e) => !e?.contactId || e.contactId === contactId) : events || []).filter(Boolean);

  /* ---- the offer ---- */
  if (offer && (!contactId || !offer.contactId || offer.contactId === contactId)) {
    const first = offer.revisions?.length ? offer.revisions[0].from : offer.cashAmount;
    if (offer.createdAt && Number(first) > 0) add(offer.createdAt, "priced", `priced ${shortMoney(first)}`, offer.autoUnderwrite ? "machine" : "us", { amount: Math.round(Number(first)) });
    // A letter the machine sent leaves an offer_sent event with `by`
    // (a clean underwrite, a reply's action) within a few minutes of it.
    const machineSends = mine.filter((e) => e.type === "offer_sent" && e.data?.by && (!e.offerId || e.offerId === offer.id)).map((e) => ms(e.at));
    for (const s of offer.sends || []) {
      const ok = !s?.results || Object.values(s.results).some((r) => r?.ok);
      if (!s?.ts || !ok) continue;
      const t = ms(s.ts);
      const byMachine = machineSends.some((m) => m != null && Math.abs(m - t) <= 5 * 60000);
      add(s.ts, "sent", "offer sent", byMachine ? "machine" : "us");
    }
    if (offer.proactive?.realmCheckAt && !theirs.some((x) => x.outbound?.kind === "realm_check" && x.status === "sent")) {
      add(offer.proactive.realmCheckAt, "floated", `floated ${shortMoney(offer.cashAmount)}`.trim(), "machine");
    }
    const requoteAt = new Set((offer.requotes || []).map((r) => r?.ts).filter(Boolean));
    for (const r of offer.revisions || []) {
      if (r?.ts && Number(r.to) > 0) add(r.ts, "requoted", `re-quoted ${shortMoney(r.to)}`, requoteAt.has(r.ts) ? "machine" : "us", { amount: Math.round(Number(r.to)) });
    }
    for (const h of offer.statusHistory || []) {
      const m = STATUS_MOMENT[h?.status];
      if (m && h.ts) add(h.ts, m[0], m[2](h), m[1], Number(h.amount) > 0 ? { amount: Math.round(Number(h.amount)) } : {});
    }
    if (offer.realm?.ts) add(offer.realm.ts, offer.realm.answer === "yes" ? "realm_yes" : "realm_no", offer.realm.answer === "yes" ? "in the realm" : "not in the realm", "them");
    if (Number(offer.agreed?.amount) > 0 && offer.agreed.at) add(offer.agreed.at, "agreed", `agreed ${shortMoney(offer.agreed.amount)}`, "them", { amount: Math.round(Number(offer.agreed.amount)) });
    if (offer.hot?.at && !offer.hot.off) add(offer.hot.at, "hot", "hot", offer.hot.by === "operator" ? "us" : "machine");
    for (const s of offer.deal?.stageHistory || []) {
      if (s?.ts && STAGE_LABEL[s.stage]) add(s.ts, `deal_${s.stage}`, STAGE_LABEL[s.stage], "us");
    }
  }

  /* ---- the drafts: their texts, and what actually went out ---- */
  for (const x of theirs) {
    const where = { offerId: x.outbound?.offerId || null, address: x.outbound?.address || x.propertyAddress || "" };
    if (!onThisHouse(where)) continue;
    if (String(x.inbound || "").trim()) add(x.createdAt, "they_wrote", "they wrote", "them");
    if (x.status !== "sent" || !x.sentAt) continue;
    const kind = x.outbound?.kind;
    if (kind && MACHINE_STARTED_KINDS.has(kind) && !String(x.inbound || "").trim()) {
      const [k, label] = MACHINE_LABEL[kind] || ["nudge", kind.replace(/_/g, " ")];
      add(x.sentAt, k, label, x.autoSent === false ? "us" : "machine");
    } else if (String(x.inbound || "").trim()) {
      add(x.sentAt, x.autoSent ? "bot_replied" : "we_replied", x.autoSent ? "bot replied" : "we replied", x.autoSent ? "machine" : "us");
    } else if (kind) {
      add(x.sentAt, "we_texted", "we texted", x.autoSent ? "machine" : "us");
    }
  }

  /* ---- the timeline events ---- */
  const toggles = [];
  for (const e of mine) {
    if (!onThisHouse({ offerId: e.offerId || null, address: e.address || "" })) continue;
    switch (e.type) {
      case "hand_reply": add(e.at, "you_texted", "you texted them", "us"); break;
      case "call_summary": add(e.at, "call", "call", "us"); break;
      case "call_booked": add(e.at, "call_booked", "call booked", "us"); break;
      case "email_received": add(e.at, "they_emailed", "they emailed", "them"); break;
      case "email_sent": add(e.at, "we_emailed", "we emailed", "us"); break;
      case "promise_made": add(e.at, "promised", e.data?.what === "number" ? "we promised a number" : "we promised an answer", "machine"); break;
      case "listing_off_market": add(e.at, "off_market", "listing went off the market", "them"); break;
      case "listing_back_on_market": add(e.at, "back_on_market", "back on the market", "them"); break;
      case "unsubscribed": add(e.at, "unsubscribed", "they unsubscribed", "them"); break;
      case "cadence_set": add(e.at, "pace", PACE_LABEL[e.data?.pace] ? PACE_LABEL[e.data.pace].toLowerCase() : "", "us"); break;
      case "drive_stopped":
      case "drive_resumed": toggles.push(e); break;
      default: break;
    }
  }
  // Stop / pause / resume, and the end of a pause, which writes nothing.
  toggles.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  toggles.forEach((e, i) => {
    if (e.type === "drive_resumed") { add(e.at, "resumed", "bot back on", "us"); return; }
    const until = ms(e.data?.until);
    if (until == null) { add(e.at, "stopped", "you stopped the bot", "us"); return; }
    add(e.at, "paused", `paused until ${pauseDay(e.data.until)}`, "us");
    const next = toggles[i + 1];
    if (until <= now && (!next || (ms(next.at) ?? Infinity) > until)) add(new Date(until).toISOString(), "pause_ended", "pause ended", "machine");
  });

  /* ---- order, collapse runs, keep the newest ---- */
  // A run of the same moment within `collapseHours` is one ("nudge ×2"). A
  // back-and-forth collapses per side: their texts and our replies in one
  // stretch read "they wrote ×3 · bot replied ×3", not six dots.
  out.sort((a, b) => a.at.localeCompare(b.at));
  const collapsed = [];
  const within = (a, b) => ms(b.at) - ms(a.at) <= collapseHours * HOUR_MS;
  for (const m of out) {
    let into = null;
    for (let i = collapsed.length - 1; i >= 0; i--) {
      const c = collapsed[i];
      if (c.kind === m.kind && c.who === m.who && !c.amount && !m.amount && within(c, m)) { into = c; break; }
      // Only a conversation run is looked through; anything else ends it.
      if (!(CONVERSATION.has(c.kind) && CONVERSATION.has(m.kind))) break;
    }
    if (into) {
      into.count = (into.count || 1) + 1;
      into.at = m.at;
      into.label = `${into.base} ×${into.count}`;
      continue;
    }
    collapsed.push({ ...m, base: m.label });
  }
  const moments = collapsed.map(({ base, ...m }) => m).sort((a, b) => a.at.localeCompare(b.at));
  return { moments: moments.slice(-Math.max(1, limit)), total: moments.length };
}
