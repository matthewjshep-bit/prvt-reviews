// promise-owed.js — a number or the written offer we promised, owed past the
// day until it is delivered.
//
// Pure. Its own module (not promise-resolver.js) so the held-underwrite
// triage can read it without an import cycle (promise-resolver →
// paper-follows → held-underwrites).

import { sameStreet } from "./us-address.js";
import { effectiveStatus, weDecline } from "./offer-status.js";
import { detectPromise, isConditionalPromise, PERSON_PROMISES } from "./follow-up.js";
import { ourReplyPasses } from "./flip-read.js";
import { callEventConnected } from "./talked-to.js";

const HOUR_MS = 3600000;
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

/* ---------- a number we promised, owed past the day ---------- */

// 2026-10-14, reading 2,014 threads: in fifteen of them we told an agent
// "I'll get back to you today with a number" (or the LOI) and nothing
// followed. The promise row (promise-resolver.js) leaves Today after three
// days, and several of the houses were then closed out by the nightly
// sweep without a word to the agent. These were the agents who were
// answering us. A number or the written offer we promised stays owed until
// it goes out, we pass, or you dismiss it.
export const OWED_AFTER_HOURS = 24;
// Older than this it is history, not a debt (the board reads 90 days).
export const OWED_WINDOW_DAYS = 60;
// Our number, not earnest money or a repair figure.
const PRICE_FLOOR = 50000;
// "449kish" is how the floats say it (2026-10-14 replay: read as no number).
const PRICE_RE = /\$\s?\d[\d,]*(?:\.\d+)?\s?(?:[kKmM](?:ish)?)?\b|\b\d+(?:\.\d+)?\s?[kK](?:ish)?\b|\b\d+(?:\.\d+)?\s?[mM](?:ish)?\b|\b\d{1,3}(?:,\d{3})+\b/g;

/** namesAPrice(text) → true when the text says a house-sized dollar figure ("$410,000", "410k", "1.2M"). */
export function namesAPrice(text = "") {
  for (const m of String(text || "").matchAll(PRICE_RE)) {
    const s = m[0].replace(/[$,\s]/g, "").replace(/ish$/i, "");
    const suffix = s.slice(-1).toLowerCase();
    const base = Number(suffix === "k" || suffix === "m" ? s.slice(0, -1) : s);
    if (!Number.isFinite(base)) continue;
    if ((suffix === "k" ? base * 1e3 : suffix === "m" ? base * 1e6 : base) >= PRICE_FLOOR) return true;
  }
  return false;
}

/**
 * keepsOurWord(text) → "pass" | "number" | null
 *
 * Whether a text of ours delivers what we promised: our pass on the house,
 * or a price. A text that promises a number again keeps nothing — "Got it,
 * 480k, let me run that and get back to you" is their number said back.
 * A price beside a promise of the paper ("we'd be at 598k … I'll get the
 * formal offer over") is the number delivered and the paper still owed.
 */
export function keepsOurWord(text = "") {
  const t = String(text || "");
  if (!t.trim()) return null;
  if (ourReplyPasses(t) || weDecline(t) || WE_ARE_OUT.test(t)) return "pass";
  const again = detectPromise(t);
  if (again && again !== "paper") return null;
  return namesAPrice(t) ? "number" : null;
}

// Our pass in the words the replay found (2026-10-14) that the reply-side
// readers don't: "I don't think we're going to get there", "we're out on
// this one", "not doing condos at the moment", "it doesn't pencil for us".
const WE_ARE_OUT = /\b(?:not|n't)\s+(?:going\s+to|gonna)\s+(?:be\s+able\s+to\s+)?get\s+there\b|\bdon'?t\s+think\s+we(?:'?re|\s+are)\s+(?:going\s+to|gonna)\s+get\s+there\b|\bwe(?:'re|\s+are)\s+(?:going\s+to\s+)?(?:be\s+)?out\s+on\s+(?:this|that|it|\d)|\bnot\s+doing\s+(?:condos|townhomes|townhouses|mobile|manufactured|duplexes|multi)|\b(?:doesn'?t|does\s+not|won'?t|didn'?t)\s+pencil\b|\b(?:didn'?t|doesn'?t|won'?t|isn'?t\s+going\s+to)\s+work\s+(?:out\s+)?for\s+us\b|\btoo\s+far\s+apart\b|\btoo\s+(?:rural|far\s+out|finished|turnkey|nice)\s+for\s+us\b/i;

// Machine texts that are our number, or our pass, whatever their words.
const NUMBER_TEXT_KINDS = new Set(["realm_check", "take_check"]);
const PASS_TEXT_KINDS = new Set(["kind_pass", "pass_note"]);
// The agent told us: they passed, or the house is gone. Nothing is owed.
const THEIR_WORD_STATUSES = new Set(["passed", "unavailable"]);

const sentAtOf = (d) => ms(d?.sentAt) ?? ms(d?.updatedAt) ?? ms(d?.createdAt);
const sendWent = (s) => s?.ts && (!s.results || Object.values(s.results).some((r) => r?.ok));
const pacificDay = (v) => new Date(v).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });

/**
 * owedPromises({ events, sentDrafts, offers, now, afterHours, windowDays })
 *   → [{ contactId, since, lastAt, dates, address, what, text, draftId, by }]
 *
 * One per contact: the numbers and written offers we promised that are at
 * least `afterHours` old and that nothing has delivered since. A promise is
 * delivered by
 *   - a `promise_kept` after it (the sweep saw numbers go out, a status you
 *     set, a dismissal, a text of ours with a price or a pass in it);
 *   - a sent text of ours on that house with a price in it (a number only)
 *     or our pass (anything);
 *   - the written offer going out on that house (anything), or the number
 *     floated (a number only);
 *   - the agent's own word that they passed or it's gone, a deal, or a pass
 *     a person made. A house the nightly sweep closed out by itself is not
 *     delivered: the agent hasn't heard (held-underwrites.js tells them).
 * A promise whose text ended with a question to them is not owed (the
 * written offer always is). "An answer" is the 72-hour row's business.
 */
export function owedPromises({ events = [], sentDrafts = [], offers = [], now = Date.now(), afterHours = OWED_AFTER_HOURS, windowDays = OWED_WINDOW_DAYS } = {}) {
  const floor = now - windowDays * 86400000;
  const byContact = new Map();
  for (const e of events || []) {
    if (!e?.contactId || (e.type !== "promise_made" && e.type !== "promise_kept")) continue;
    if ((ms(e.at) ?? 0) < floor) continue;
    if (!byContact.has(e.contactId)) byContact.set(e.contactId, []);
    byContact.get(e.contactId).push(e);
  }
  const out = [];
  for (const [contactId, list] of byContact) {
    list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const ours = (sentDrafts || []).filter((d) => d?.contactId === contactId && d.status === "sent");
    const theirOffers = (offers || []).filter((o) => o?.contactId === contactId);
    const open = [];
    for (const p of list) {
      if (p.type !== "promise_made") continue;
      const what = p.data?.what;
      if (what !== "number" && what !== "paper") continue;
      if (what === "number" && p.data?.asksThem === true) continue;
      // "…and circle back if it pencils out": a look, not a number we owe.
      if (p.data?.conditional === true || (p.data?.text && isConditionalPromise(p.data.text))) continue;
      const t = ms(p.at) ?? 0;
      if (list.some((k) => k.type === "promise_kept" && (ms(k.at) ?? 0) >= t)) continue;
      const on = (a) => !p.address || !a || sameStreet(a, p.address);
      const said = ours.some((d) => {
        if ((sentAtOf(d) ?? 0) <= t || !on(d.propertyAddress || d.outbound?.address)) return false;
        const kind = d.outbound?.kind || d.intent;
        if (PASS_TEXT_KINDS.has(kind)) return true;
        if (NUMBER_TEXT_KINDS.has(kind)) return what === "number";
        const kept = keepsOurWord(d.sentText || d.reply || d.body || "");
        return kept === "pass" || (kept === "number" && what === "number");
      });
      if (said) continue;
      const done = theirOffers.some((o) => {
        if (!on(o.address)) return false;
        if ((o.sends || []).some((s) => sendWent(s) && (ms(s.ts) ?? 0) > t)) return true;
        if (what === "number" && Math.max(ms(o.proactive?.takeCheckAt) ?? 0, ms(o.proactive?.realmCheckAt) ?? 0) > t) return true;
        if (o.deal) return true;
        const status = effectiveStatus(o);
        const at = ms(o.statusAt) ?? 0;
        if (THEIR_WORD_STATUSES.has(status) && at > t) return true;
        return status === "we_passed" && at > t && o.retired?.by !== "held-sweep";
      });
      if (done) continue;
      open.push(p);
    }
    if (!open.length || now - (ms(open[0].at) ?? now) < afterHours * HOUR_MS) continue;
    const newest = open.at(-1);
    out.push({
      contactId,
      since: open[0].at,
      lastAt: newest.at,
      dates: [...new Set(open.map((p) => pacificDay(ms(p.at))))],
      address: [...open].reverse().find((p) => p.address)?.address || "",
      what: open.some((p) => p.data?.what === "number") ? "number" : "paper",
      text: String(newest.data?.text || ""),
      draftId: newest.data?.draftId || null,
      by: newest.data?.by || "",
    });
  }
  return out;
}

/* ---------- a call, a time to walk it, the earnest money (2026-10-15) ---------- */

// The funnel review: in 37 of the 58 negotiations we dropped, a promise
// wasn't kept, and the ones nothing tracked were these. "I'll give you a call
// tomorrow", "I'll get you a time to walk it", "we'll get the earnest money
// over". Only a person keeps them, so they're rows, never a machine text.
// A time in a text of ours: "Thursday at 2", "tomorrow at 10am", "3pm".
const TIME_RX = /\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|\btomorrow\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\bat\s+\d{1,2}(?::\d{2})?\b|\bnoon\b/i;
export const PERSON_PROMISE_WORDS = { call: "a call", tour: "a time to walk it", emd: "the earnest money" };

/**
 * owedPersonPromises({ events, sentDrafts, offers, now, afterHours, windowDays })
 *   → [{ contactId, what, since, lastAt, dates, address, text, draftId, by }]
 *
 * One per contact and kind: the calls, walk-through times and earnest money
 * we promised that are `afterHours` old and nothing has kept since.
 *   call  a call that connected, or one of ours that was tried (a call_attempt);
 *   tour  a booking (call_booked), or a text of ours that names a time;
 *   emd   the deal's earnest-money item ticked on the closing checklist.
 * A Dismiss (promise_kept by "dismissed") clears any of them; the machine's
 * own promise_kept (a number went out) doesn't — a price isn't a call.
 */
export function owedPersonPromises({ events = [], sentDrafts = [], offers = [], now = Date.now(), afterHours = OWED_AFTER_HOURS, windowDays = OWED_WINDOW_DAYS } = {}) {
  const floor = now - windowDays * 86400000;
  const byContact = new Map();
  for (const e of events || []) {
    if (!e?.contactId || (ms(e.at) ?? 0) < floor) continue;
    if (!byContact.has(e.contactId)) byContact.set(e.contactId, []);
    byContact.get(e.contactId).push(e);
  }
  const out = [];
  for (const [contactId, list] of byContact) {
    list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const ours = (sentDrafts || []).filter((d) => d?.contactId === contactId && d.status === "sent");
    const theirOffers = (offers || []).filter((o) => o?.contactId === contactId);
    const open = new Map();
    for (const p of list) {
      if (p.type !== "promise_made" || !PERSON_PROMISES.has(p.data?.what)) continue;
      if (p.data?.conditional === true || (p.data?.text && isConditionalPromise(p.data.text))) continue;
      const what = p.data.what;
      const t = ms(p.at) ?? 0;
      const after = (x) => (ms(x) ?? 0) > t;
      if (list.some((k) => k.type === "promise_kept" && k.data?.by === "dismissed" && (ms(k.at) ?? 0) >= t)) continue;
      const on = (a) => !p.address || !a || sameStreet(a, p.address);
      let kept = false;
      if (what === "call") kept = list.some((e) => after(e.at) && (callEventConnected(e) || (e.type === "call_attempt" && e.data?.direction !== "inbound")));
      if (what === "tour") {
        kept = list.some((e) => after(e.at) && e.type === "call_booked")
          || ours.some((d) => (sentAtOf(d) ?? 0) > t && !d.outbound?.kind && TIME_RX.test(d.sentText || d.reply || d.body || ""));
      }
      if (what === "emd") {
        kept = theirOffers.some((o) => on(o.address) && (o.deal?.checklist?.items || []).some((i) => i?.id === "earnest_money" && i.done));
      }
      if (kept) continue;
      open.set(what, [...(open.get(what) || []), p]);
    }
    for (const [what, ps] of open) {
      if (now - (ms(ps[0].at) ?? now) < afterHours * HOUR_MS) continue;
      const newest = ps.at(-1);
      out.push({
        contactId, what,
        since: ps[0].at,
        lastAt: newest.at,
        dates: [...new Set(ps.map((p) => pacificDay(ms(p.at))))],
        address: [...ps].reverse().find((p) => p.address)?.address || "",
        text: String(newest.data?.text || ""),
        draftId: newest.data?.draftId || null,
        by: newest.data?.by || "",
      });
    }
  }
  return out;
}

/**
 * owedOnHouse({ events, drafts, address, now }) → { what, at } | null
 *
 * For the nightly sweep closing a held house out: a number or the offer we
 * promised on THIS house (or on no house in particular) that nothing has
 * delivered, else the agent's own last word on it that we never answered.
 * Either way they are waiting on us, and a quiet close leaves them waiting.
 */
export function owedOnHouse({ events = [], drafts = [], offers = [], address = "", now = Date.now() } = {}) {
  if (!String(address || "").trim()) return null;
  const onHouse = (a) => !a || sameStreet(a, address);
  const promised = owedPromises({ events: (events || []).filter((e) => e?.type !== "promise_made" || onHouse(e.address)), sentDrafts: drafts, offers, now, afterHours: 0 })[0];
  if (promised) return { what: promised.what, at: promised.lastAt };
  // Their newest text about this house, and whether anything of ours went after it.
  const theirs = (drafts || []).filter((d) => d && String(d.inbound || "").trim() && onHouse(d.propertyAddress))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0];
  if (!theirs || theirs.status === "sent" || theirs.answeredBy === "you") return null;
  const at = ms(theirs.createdAt) ?? 0;
  const answered = (drafts || []).some((d) => d && d.status === "sent" && (sentAtOf(d) ?? 0) > at)
    || (events || []).some((e) => e?.type === "hand_reply" && (ms(e.at) ?? 0) > at);
  return answered ? null : { what: "answer", at: theirs.createdAt };
}
