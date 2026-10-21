// pass-note.js — the runner for shared/pass-note.js.
//
// Matt, 2026-10-19: mark a house an agent sent "We passed: <reason>" and the
// bot thanks them and says why, unless you text them first. The status route
// starts it the moment you mark (startPassNote); the 15-minute tick
// (sweepPassNotes) starts any that couldn't be yet — a reply of theirs was
// waiting on you, a deploy dropped the draft — and settles the ones a person
// answered: a note dismissed by your own text is yours, not sent again.
//
// Ids and addresses only in the logs, never a name or a message.

import { store as defaultStore } from "./store.js";
import { passNoteHouses, passNoteNotBefore, PASS_NOTE_KEEP_MS } from "./shared/pass-note.js";
import { normalizeConversationAi } from "./shared/conversation-ai.js";

const iso = (ms) => new Date(ms).toISOString();
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

const switchedOn = (saved) => Boolean(normalizeConversationAi(saved?.conversationAi).parties?.agent?.passNote?.enabled);

async function stamp(store, offerId, patch) {
  const o = await store.getOffer(offerId).catch(() => null);
  if (!o) return;
  await store.updateOffer(o.id, { ...o, passNote: { ...(o.passNote || {}), ...patch } }).catch(() => {});
}

/**
 * startPassNote({ client, locationId, saved, store, contactId, sendsEnabled, startProactive, deps, now })
 *   → { started, draftWill, houses } | { skipped }
 *
 * One note for every house of theirs waiting on one. The houses it names are
 * stamped "drafted" with the draft once it's written; a note that couldn't be
 * started leaves them "due" for the tick.
 */
export async function startPassNote({ client, locationId, saved = {}, store = defaultStore, contactId, sendsEnabled = false, startProactive, deps = {}, now = Date.now() }) {
  if (!contactId) return { skipped: "no contact" };
  if (!switchedOn(saved)) return { skipped: "the pass note is off (Conversation AI → agent playbook)" };
  const offers = await store.listOffers(locationId, { contactId, limit: 100 }).catch(() => []);
  const houses = passNoteHouses(offers, { now });
  if (!houses.length) return { skipped: "no house you marked is waiting on a note" };
  const newest = offers.find((o) => o.id === houses.at(-1).offerId) || null;
  const r = await startProactive({
    client, locationId, saved, store, contactId, kind: "pass_note", offer: newest,
    subject: { houses, notBefore: passNoteNotBefore(houses) }, sendsEnabled,
    deps: {
      ...deps,
      onSettled: async (job) => {
        if (!job?.draftId) return;
        for (const h of houses) await stamp(store, h.offerId, { status: "drafted", draftId: job.draftId, why: "" });
      },
    },
  }).catch((e) => ({ skipped: String(e?.message || e).slice(0, 160) }));
  if (r?.skipped) {
    for (const h of houses) await stamp(store, h.offerId, { status: "due", why: String(r.skipped).slice(0, 160), triedAt: iso(now) });
    return { skipped: r.skipped, houses: houses.length };
  }
  return { started: true, houses: houses.length, jobId: r?.job?.id || null };
}

/**
 * sweepPassNotes({ client, locationId, saved, store, sendsEnabled, startProactive, deps, now }) → { contacts, started, settled }
 *
 * The tick's half. A note drafted and then dismissed (your own text, your
 * Dismiss) is yours; superseded by another note, the newer one carries it;
 * gone or past a day, it's dropped. Contacts with houses still due are
 * started again — at most a few a tick.
 */
export async function sweepPassNotes({ client, locationId, saved = {}, store = defaultStore, sendsEnabled = false, startProactive, deps = {}, now = Date.now(), limit = 10 }) {
  const out = { contacts: 0, started: 0, settled: 0 };
  if (!switchedOn(saved)) return out;
  const offers = await store.listOffers(locationId, { limit: 2000, lean: true }).catch(() => []);
  const waiting = (offers || []).filter((o) => o?.contactId && ["due", "drafted"].includes(o.passNote?.status));
  const due = new Set();
  for (const o of waiting) {
    const n = o.passNote;
    if (now - (ms(n.markedAt) ?? 0) > PASS_NOTE_KEEP_MS) { await stamp(store, o.id, { status: "off", why: "waited a day with no note sent" }); out.settled++; continue; }
    if (n.status === "due") { due.add(o.contactId); continue; }
    const d = n.draftId && store.getReplyDraft ? await store.getReplyDraft(n.draftId).catch(() => null) : null;
    if (d?.status === "sent") { await stamp(store, o.id, { status: "sent", sentAt: d.sentAt || iso(now) }); out.settled++; }
    else if (d?.status === "dismissed") { await stamp(store, o.id, { status: "yours", why: "the note was dismissed — a text of yours, or your Dismiss" }); out.settled++; }
    // Superseded, or lost with a deploy: written again.
    else if (!d || d.status === "superseded") { await stamp(store, o.id, { status: "due" }); due.add(o.contactId); }
  }
  for (const contactId of [...due].slice(0, limit)) {
    out.contacts++;
    const r = await startPassNote({ client, locationId, saved, store, contactId, sendsEnabled, startProactive, deps, now });
    if (r.started) out.started++;
  }
  return out;
}
