// outreach-scorecard.js — which text wins: every first text, follow-up and
// check-in, scored by what came back.
//
// 2026-11-09: nothing in the app said which text works. The recent-lister
// first texts ran about 11% opt-outs and no houses, and only a hand-built
// read found it; the 10-15 funnel review and the 10-26 STOP analysis were
// scratch scripts too. Matt's check-in rewrite needs personal against
// generic measured. This is that read, kept: the texts that went 7 or more
// days ago, grouped by the text they were (its template, or the model's
// opening move), length, county, day and detail, and per group how many got
// a useful reply within 3 and 7 days, a STOP within 72 hours, a real call,
// a house named, an offer and a deal.
//
// REPORT ONLY. Nothing here retires a text or changes a setting; a group
// under SCORE_MIN_N sends is shown greyed, never ranked. Each outcome is
// credited to the last text we sent that person before it (last touch), so
// one reply never counts for two texts.
//
// Pure. The nightly runner (ghl-broker/outreach-scorecard.js) does the reads
// and keeps the card on its cursor; pages read the kept card.

import { optOutInTranscript, CONVERSATION_AI_DEFAULTS } from "./conversation-ai.js";
import { usefulReply } from "./flow.js";
import { realCall } from "./talked-to.js";

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const ms = (v) => { const t = typeof v === "number" ? v : Date.parse(v || ""); return Number.isFinite(t) ? t : null; };
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

// Only texts this old are scored, so every one had its full week to answer.
export const SCORE_MIN_AGE_DAYS = 7;
// Under this many sends a group is shown greyed: too few to call.
export const SCORE_MIN_N = 30;
// The windows each outcome is credited inside.
export const SCORE_WINDOWS = { reply3: 3 * DAY_MS, reply7: 7 * DAY_MS, stop: 72 * HOUR_MS, talked: 14 * DAY_MS, house: 14 * DAY_MS, offer: 30 * DAY_MS };
export const SCORE_KINDS = ["first_text", "follow_up", "check_in"];
export const SCORE_KIND_LABEL = { first_text: "First texts", follow_up: "Follow-ups", check_in: "Check-ins" };
// The ways each kind is split, in the order the card shows them.
export const SCORE_DIMENSIONS = {
  first_text: ["template", "move", "length", "county", "batch", "who"],
  follow_up: ["template", "step", "length", "county", "who"],
  check_in: ["template", "detail", "segment", "length", "who"],
};
export const SCORE_DIMENSION_LABEL = {
  template: "Text", move: "Opening move", length: "Length", county: "County", batch: "Day sent", who: "Who sent it",
  step: "Follow-up step", detail: "What it named", segment: "Agent",
};
const MAX_ROWS = 25;

// Which of Matt's fixed texts a set name is (shared/standard-texts.js standardText).
export const TEMPLATE_SET_LABEL = {
  opener: "First text", county_opener: "County first text", past_listing: "Recent-lister first text",
  follow_up: "Follow-up", nudge: "Follow-up pool", check_in: "Check-in",
  checkin: "Check-in", checkin_cold: "Cold check-in", listing: "Listing check-in", listing_cold: "Cold listing check-in",
};

/**
 * templateHash(template) → a short stable fingerprint of the unfilled text, or ""
 *
 * Stamped on the send (outreach_sent, outreach_nudge_sent, agent_pulse_texted)
 * so a text Matt rewrites in Autopilot → Agents scores apart from the one it
 * replaced, though both sit at the same place in the list.
 */
export function templateHash(template = "") {
  const t = String(template || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  let h = 0;
  for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h.toString(36);
}

/** lengthBucket(chars) → "under 120" | "120–159" | "160–199" | "200 and over" | "unknown" */
export function lengthBucket(chars) {
  const n = Number(chars);
  if (!(n > 0)) return "unknown";
  if (n < 120) return "under 120";
  if (n < 160) return "120–159";
  if (n < 200) return "160–199";
  return "200 and over";
}

/**
 * stopReply(text) → true when their words ask us to stop
 *
 * The thread rule (shared/conversation-ai.js optOutInTranscript): a phrase
 * anywhere ("take me off your list"), a single keyword only when it is
 * nearly the whole message, so "stop by the open house" is not one.
 */
export function stopReply(text = "") {
  const line = String(text || "").replace(/\s+/g, " ").trim();
  if (!line) return false;
  return Boolean(optOutInTranscript(`[2000-01-01 00:00] THEM sms: ${line}`, CONVERSATION_AI_DEFAULTS.optOut));
}

/**
 * checkInDetail(data) → what a check-in named: detailKind when the send
 * stamped one (the composer: last words, street, listing, personal, past
 * deal, town, none), else read from what it carried.
 */
export function checkInDetail(d = {}) {
  if (d.detailKind) return String(d.detailKind);
  if (d.reason === "deal_thanks") return "past deal";
  if (d.reason === "matt15") return "personal";
  const set = String(d.standard?.set || "");
  if (/^listing/.test(set) || d.hook === "listing" || d.reason === "fresh_listing" || d.listingKey) return "listing";
  if (d.hook === "mentioned") return "street";
  if (d.hook === "closed_nearby") return "town";
  if (d.standard) return "none";
  return d.hook ? `the model, ${String(d.hook).replace(/_/g, " ")}` : "unknown";
}

const pacificDay = (t) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(t));

// The text a send was: its fingerprint, else its place in the set, else who wrote it.
function templateOf(std, fallback) {
  if (std?.templateHash) return `h:${std.templateHash}`;
  if (std?.set) return `s:${std.set}#${Number(std.index) || 0}`;
  return fallback;
}

/**
 * sendsFrom({ events, ledger }) → [send]
 *
 *   events  outreach_sent, outreach_enrolled, outreach_nudge_sent, agent_pulse_texted
 *   ledger  the outbox's sent rows (store.listReplyDraftLedger): the
 *           follow-ups that went before outreach_nudge_sent was written,
 *           and the fixed text a first text was (outbound.standard)
 *
 * send: { id, kind, contactId, at, template, set, index, move, chars, county,
 *         batch, who, step, detail, segment }
 */
export function sendsFrom({ events = [], ledger = [] } = {}) {
  const byDraft = new Map((ledger || []).filter((d) => d?.id).map((d) => [d.id, d]));
  const nudgeDrafts = new Set();
  const out = [];
  const who = (d, auto) => (auto ? "the machine" : d?.edited ? "you, edited" : "you");
  for (const e of events || []) {
    const t = ms(e?.at);
    if (!e?.contactId || t == null) continue;
    const d = e.data || {};
    const base = { id: e.id || `${e.type}:${e.contactId}:${e.at}`, contactId: e.contactId, at: t, batch: pacificDay(t) };
    if (e.type === "outreach_sent") {
      const std = d.standard || byDraft.get(d.draftId)?.outbound?.standard || null;
      out.push({ ...base, kind: "first_text",
        template: templateOf(std, d.style === "standard" ? (d.pastListing ? "s:past_listing" : "s:opener") : "model"),
        set: std?.set || null, index: std ? Number(std.index) || 0 : null,
        move: d.openingMove != null && !std && d.style !== "standard" ? `m:${d.openingMove}` : std || d.style === "standard" ? "fixed text" : "unknown",
        chars: Number(d.chars) || 0, county: d.county || "unknown", who: who(d, d.auto === true) });
    } else if (e.type === "outreach_enrolled") {
      const follow = d.kind === "followup";
      out.push({ ...base, kind: follow ? "follow_up" : "first_text", template: follow ? "ghl:followup" : "ghl:first", move: "GHL workflow",
        chars: 0, county: d.county || "unknown", who: "GHL", step: follow ? "GHL workflow" : null });
    } else if (e.type === "outreach_nudge_sent") {
      if (d.draftId) nudgeDrafts.add(d.draftId);
      const std = d.set ? { set: d.set, index: d.index, templateHash: d.templateHash } : null;
      out.push({ ...base, kind: "follow_up", template: templateOf(std, "model"), set: d.set || null, index: std ? Number(d.index) || 0 : null,
        step: d.step != null ? `day ${d.step}` : "unknown", chars: Number(d.chars) || 0, county: d.county || "unknown", who: who(d, d.auto === true) });
    } else if (e.type === "agent_pulse_texted") {
      const std = d.standard || byDraft.get(d.draftId)?.outbound?.standard || null;
      out.push({ ...base, kind: "check_in", template: templateOf(std, "model"), set: std?.set || null, index: std ? Number(std.index) || 0 : null,
        detail: checkInDetail({ ...d, standard: std, detailKind: d.detailKind || byDraft.get(d.draftId)?.outbound?.detailKind }),
        segment: d.segment || "unknown", chars: Number(d.chars) || 0, county: d.county || "unknown",
        who: d.reason === "matt15" ? "Matt's 15" : who(d, d.auto === true) });
    }
  }
  // Follow-ups from before outreach_nudge_sent existed: the outbox's own rows.
  for (const r of ledger || []) {
    if (r?.status !== "sent" || r.hasInbound || r.outbound?.kind !== "outreach_nudge" || nudgeDrafts.has(r.id) || !r.contactId) continue;
    const t = ms(r.sentAt || r.createdAt);
    if (t == null) continue;
    const std = r.outbound.standard || null;
    out.push({ id: `draft:${r.id}`, kind: "follow_up", contactId: r.contactId, at: t, batch: pacificDay(t), template: templateOf(std, "model"),
      set: std?.set || null, index: std ? Number(std.index) || 0 : null, step: r.outbound.step != null ? `day ${r.outbound.step}` : "unknown",
      chars: 0, county: "unknown", who: r.autoSent ? "the machine" : "you" });
  }
  return out;
}

/**
 * outcomesFrom({ events, offers }) → { inbound, talks, houses, offers }
 *
 *   inbound  their texts and calls: { contactId, at, useful, stop } — a STOP is
 *            their words asking us to stop, an opt_out read, or GHL's DND
 *   talks    a real call (shared/talked-to.js realCall)
 *   houses   a house or someone with one they named
 *   offers   an offer on a house that came through outreach (the lead-source
 *            annotation: hook or agent_brought), with whether it became a deal
 */
export function outcomesFrom({ events = [], offers = [] } = {}) {
  const inbound = [], talks = [], houses = [];
  for (const e of events || []) {
    const t = ms(e?.at);
    if (!e?.contactId || t == null || e.party === "investor") continue;
    if (e.type === "text_summary") {
      const words = String(e.data?.inbound || "").trim();
      if (!words) continue;
      const stop = e.data?.intent === "opt_out" || stopReply(words);
      inbound.push({ contactId: e.contactId, at: t, stop, useful: !stop && usefulReply(e) });
    } else if (e.type === "call_summary") {
      const real = realCall(e);
      inbound.push({ contactId: e.contactId, at: t, stop: false, useful: real });
      if (real) talks.push({ contactId: e.contactId, at: t });
    } else if (e.type === "unsubscribed") {
      inbound.push({ contactId: e.contactId, at: t, stop: true, useful: false });
    } else if (e.type === "house_mentioned" || e.type === "referral_mentioned") {
      houses.push({ contactId: e.contactId, at: t });
    }
  }
  const deals = [];
  for (const o of offers || []) {
    const t = ms(o?.createdAt);
    const src = o?.leadSource?.source;
    if (!o?.contactId || t == null || (src !== "hook" && src !== "agent_brought")) continue;
    deals.push({ contactId: o.contactId, at: t, deal: Boolean(o.deal) });
  }
  return { inbound, talks, houses, offers: deals };
}

const blankRow = (key, label) => ({ key, label, n: 0, replied3: 0, replied7: 0, stopped: 0, talked: 0, house: 0, offer: 0, deal: 0 });
const OUTCOME_FIELDS = ["replied3", "replied7", "stopped", "talked", "house", "offer", "deal"];

function finishRow(r, minN) {
  const rates = Object.fromEntries(OUTCOME_FIELDS.map((k) => [k, pct(r[k], r.n)]));
  return { ...r, rates, small: r.n < minN };
}

// The label a group key reads as.
function labelOf(dim, key, labels = {}) {
  if (dim === "template") {
    if (key === "model") return "Written by the model";
    if (key === "ghl:first") return "GHL first-text workflow";
    if (key === "ghl:followup") return "GHL follow-up workflow";
    if (key.startsWith("h:")) return labels.templates?.[key.slice(2)] || `A fixed text (${key.slice(2)})`;
    if (key.startsWith("s:")) {
      const [set, i] = key.slice(2).split("#");
      return `${TEMPLATE_SET_LABEL[set] || set}${i != null ? ` #${Number(i) + 1}` : ""}`;
    }
  }
  if (dim === "move" && key.startsWith("m:")) {
    const i = Number(key.slice(2));
    return labels.moves?.[i] ? `Move ${i + 1}: ${labels.moves[i]}` : `Move ${i + 1}`;
  }
  return key;
}

/**
 * buildOutreachScorecard({ sends, inbound, talks, houses, offers, now, labels, minN, minAgeDays })
 *   → { generatedAt, through, minN, minAgeDays, kinds: { [kind]: { n, young, totals, dims: { [dim]: [row] } } } }
 *
 *   labels  { templates: { [hash]: text }, moves: [text] } — what a group key reads as
 *   row     { key, label, n, replied3, replied7, stopped, talked, house, offer, deal, rates, small }
 */
export function buildOutreachScorecard({ sends = [], inbound = [], talks = [], houses = [], offers = [], now = Date.now(), labels = {}, minN = SCORE_MIN_N, minAgeDays = SCORE_MIN_AGE_DAYS } = {}) {
  const through = now - minAgeDays * DAY_MS;
  // Every send, scored or not, by contact and in time order: a younger text
  // still takes the credit for what came after it.
  const byContact = new Map();
  const tally = new Map();
  for (const s of sends || []) {
    if (!s?.contactId || ms(s.at) == null) continue;
    const at = ms(s.at);
    const row = { ...s, at };
    (byContact.get(s.contactId) || byContact.set(s.contactId, []).get(s.contactId)).push(row);
    tally.set(row, { replied3: false, replied7: false, stopped: false, talked: false, house: false, offer: false, deal: false });
  }
  for (const list of byContact.values()) list.sort((a, b) => a.at - b.at);
  const lastBefore = (contactId, t) => {
    const list = byContact.get(contactId);
    if (!list) return null;
    let hit = null;
    for (const s of list) { if (s.at < t) hit = s; else break; }
    return hit;
  };
  const credit = (x, window, mark) => {
    const t = ms(x?.at);
    if (t == null) return;
    const s = lastBefore(x.contactId, t);
    if (!s || t - s.at > window) return;
    mark(tally.get(s), t - s.at);
  };
  for (const x of inbound) {
    if (x.stop) credit(x, SCORE_WINDOWS.stop, (m) => { m.stopped = true; });
    else if (x.useful) credit(x, SCORE_WINDOWS.reply7, (m, dt) => { m.replied7 = true; if (dt <= SCORE_WINDOWS.reply3) m.replied3 = true; });
  }
  for (const x of talks) credit(x, SCORE_WINDOWS.talked, (m) => { m.talked = true; });
  for (const x of houses) credit(x, SCORE_WINDOWS.house, (m) => { m.house = true; });
  for (const x of offers) credit(x, SCORE_WINDOWS.offer, (m) => { m.offer = true; if (x.deal) m.deal = true; });

  const kinds = {};
  for (const kind of SCORE_KINDS) {
    const dims = Object.fromEntries(SCORE_DIMENSIONS[kind].map((d) => [d, new Map()]));
    const totals = blankRow("all", SCORE_KIND_LABEL[kind]);
    let young = 0;
    for (const [s, m] of tally) {
      if (s.kind !== kind) continue;
      if (s.at > through) { young++; continue; }
      // A send answered by STOP is stopped, not replied.
      const hit = m.stopped ? { ...m, replied3: false, replied7: false } : m;
      const add = (r) => { r.n++; for (const k of OUTCOME_FIELDS) if (hit[k]) r[k]++; };
      add(totals);
      for (const dim of SCORE_DIMENSIONS[kind]) {
        const key = dim === "length" ? lengthBucket(s.chars) : String(s[dim] ?? "unknown");
        const g = dims[dim];
        if (!g.has(key)) g.set(key, blankRow(key, labelOf(dim, key, labels)));
        add(g.get(key));
      }
    }
    const out = {};
    for (const [dim, g] of Object.entries(dims)) {
      const rows = [...g.values()].map((r) => finishRow(r, minN));
      rows.sort(dim === "batch" ? (a, b) => b.key.localeCompare(a.key) : dim === "step" || dim === "length" ? (a, b) => a.key.localeCompare(b.key, "en", { numeric: true }) : (a, b) => b.n - a.n || a.label.localeCompare(b.label));
      // A split with one group says nothing.
      if (rows.length > 1) out[dim] = rows.slice(0, MAX_ROWS);
    }
    kinds[kind] = { n: totals.n, young, totals: finishRow(totals, minN), dims: out };
  }
  return { generatedAt: new Date(now).toISOString(), through: new Date(through).toISOString(), minN, minAgeDays, kinds };
}
