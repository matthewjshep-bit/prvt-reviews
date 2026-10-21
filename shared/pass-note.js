// pass-note.js — the bot tells the agent we're passing on a house you marked.
//
// Matt, 2026-10-19: "when someone surfaces an address (or multiple addresses
// or links) we can then quickly eyeball it and mark it on the offer — the
// app/bot will then respond to them (if we don't ourselves) with thanks for
// sending but gonna pass on X property because of Y reason."
//
// A draft (a skeleton or any row nothing went out on) marked "We passed:
// <reason>" is due a pass note. The bot writes one text for every house of
// theirs marked that way and still waiting, and it goes PASS_NOTE_WAIT_MIN
// after the last mark — so marking three of their houses in a row is one
// text, and a text of your own in those minutes takes its place (a hand
// reply dismisses what the machine had queued). Marked after its hours, it
// goes when they open (machineUntil).
//
// `offer.passNote`: { status, markedAt, draftId?, sentAt?, why? }
//   due      marked; the note isn't drafted yet (or has to be again)
//   drafted  the note is written and waiting to go (draftId)
//   sent     it went
//   yours    you texted them yourself, or dismissed the note
//   off      dropped: the status changed since, or it waited too long
//
// Pure. The runner is ghl-broker/pass-note.js.

import { effectiveStatus, WE_PASS_REASON } from "./offer-status.js";

export const PASS_NOTE_WAIT_MIN = 10;
// A mark the note never went out on in a day (the bot stopped on them, a
// reply of theirs waiting on you all day) is dropped, not sent late.
export const PASS_NOTE_KEEP_MS = 24 * 3600 * 1000;
export const PASS_NOTE_WAITING = new Set(["due", "drafted"]);

const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

/**
 * wantsPassNote({ before, status, reason }) → boolean
 *
 * A house nothing went out on — a draft, or a priced row we never sent or
 * floated — that you mark "We passed" with a reason. A pass on an offer they
 * have is the conversation's, not this note's.
 */
export function wantsPassNote({ before = null, status = "", reason = null } = {}) {
  if (status !== "we_passed" || !reason || !WE_PASS_REASON[reason] || !before || before.deal) return false;
  if (before.status === "draft") return true;
  return before.status === "new" && !(before.sends || []).length && !before.floatSentAt;
}

/**
 * passNoteHouses(offers, { now }) → [{ offerId, address, code, label, words, markedAt, statusAt }]
 *
 * This agent's houses waiting on a pass note, oldest mark first: still "we
 * passed" with a reason, not a deal, marked within PASS_NOTE_KEEP_MS.
 */
export function passNoteHouses(offers = [], { now = Date.now() } = {}) {
  const out = [];
  for (const o of offers || []) {
    const n = o?.passNote;
    if (!o?.id || !o.address || o.deal || !n || !PASS_NOTE_WAITING.has(n.status)) continue;
    if (effectiveStatus(o) !== "we_passed") continue;
    const r = WE_PASS_REASON[o.passReason?.code];
    const at = ms(n.markedAt);
    if (!r || at == null || now - at > PASS_NOTE_KEEP_MS) continue;
    out.push({ offerId: o.id, address: o.address, code: r.code, label: r.label, words: r.words, markedAt: n.markedAt, statusAt: o.statusAt || null });
  }
  return out.sort((a, b) => ms(a.markedAt) - ms(b.markedAt));
}

/** passNoteNotBefore(houses, { waitMin }) → ISO: the last mark plus the wait. */
export function passNoteNotBefore(houses = [], { waitMin = PASS_NOTE_WAIT_MIN } = {}) {
  const last = Math.max(0, ...(houses || []).map((h) => ms(h.markedAt) ?? 0));
  return new Date(last + waitMin * 60000).toISOString();
}

/**
 * passNoteStale(houses, offersById) → "" | why
 *
 * At send: every house the note names must still be the pass you marked —
 * the same status, set at the same moment. A house you priced, un-passed or
 * re-marked since stops the note (a new mark drafts a new one).
 */
export function passNoteStale(houses = [], offersById = new Map()) {
  for (const h of houses || []) {
    const o = offersById.get(h.offerId);
    if (!o) return `${h.address} is gone from the book`;
    if (effectiveStatus(o) !== "we_passed" || o.deal) return `${h.address} isn't marked "we passed" any more`;
    if (h.statusAt && o.statusAt && h.statusAt !== o.statusAt) return `${h.address} was marked again since`;
  }
  return "";
}
