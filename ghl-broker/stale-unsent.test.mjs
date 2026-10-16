// stale-unsent.test.mjs — the nightly held sweep closes a number we priced
// and never sent, quietly: a status and a reason on the row, a timeline line,
// nothing texted, nothing to GHL. Offline: store and client are stubs.

import test from "node:test";
import assert from "node:assert/strict";
import { sweepHeldUnderwrites, retireStaleUnsent } from "./held-underwrites.js";
import { normalizeConversationAi } from "./shared/conversation-ai.js";

const DAY = 86400000;
const NOW = Date.parse("2026-10-16T02:00:00Z");   // 7pm Pacific, the audit's hour
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const savedWith = (followUp = {}) => ({ aiApiKey: "k", conversationAi: normalizeConversationAi({ enabled: true, parties: { agent: { followUp: { enabled: true, ...followUp } } } }) });
const SAVED = savedWith();

const unsent = (over = {}) => ({
  id: "o1", locationId: "L", contactId: "c1", contactName: "Pat Agent", address: "804 Willow Rd, Puyallup, WA 98371", cashAmount: 255000,
  status: "new", createdAt: ago(12), autoUnderwrite: { jobId: "j1", finishedAt: ago(12) }, sends: [], ...over,
});

const fakeStore = ({ offers = [], drafts = [], events = [] } = {}) => {
  const rows = [...events];
  const book = new Map(offers.map((o) => [o.id, o]));
  const outbox = new Map(drafts.map((d) => [d.id, d]));
  return {
    events: rows, book, outbox,
    async listOffers() { return [...book.values()]; },
    async getOffer(id) { return book.get(id) || null; },
    async updateOffer(id, doc) { book.set(id, doc); return doc; },
    async deleteOffer(id) { book.delete(id); },
    async listContactEvents(_l, contactId) { return rows.filter((e) => e.contactId === contactId); },
    async listReplyDrafts(_l, { contactId = null, status = null } = {}) {
      return [...outbox.values()].filter((d) => (!contactId || d.contactId === contactId) && (!status || (Array.isArray(status) ? status.includes(d.status) : d.status === status)));
    },
    async updateReplyDraft(id, doc) { outbox.set(id, doc); return true; },
    async appendContactEvents(_l, contactId, add) {
      let inserted = 0;
      for (const r of add) { if (r.dedupeKey && rows.some((e) => e.contactId === contactId && e.dedupeKey === r.dedupeKey)) continue; rows.push({ ...r, contactId }); inserted++; }
      return { inserted, skipped: add.length - inserted };
    },
    async getContactProfile() { return null; }, async upsertContactProfile() { return {}; },
  };
};
// Any GHL call is a failure here: closing our own row touches nothing outside.
const client = { calls: [], async call(path, opts = {}) { this.calls.push([opts.method || "GET", path]); return { pipelines: [] }; } };

test("a number we priced and never sent is closed by the nightly sweep after ten days, quietly", async () => {
  client.calls.length = 0;
  const queued = { id: "q1", contactId: "c1", status: "draft", inbound: "", outbound: { kind: "offer_nudge", offerId: "o1" }, createdAt: ago(11), flags: [] };
  const store = fakeStore({ offers: [unsent()], drafts: [queued] });
  const starts = [];
  const r = await sweepHeldUnderwrites({ client, locationId: "L", saved: SAVED, store, deps: { startProactive: async (a) => { starts.push(a); return {}; } }, now: NOW, pace: 0 });
  const row = store.book.get("o1");
  assert.equal(row.status, "we_passed");
  assert.equal(row.statusNote, "never sent: closed after 12 days");
  assert.equal(row.retired.by, "stale-unsent");
  assert.ok(store.events.some((e) => e.type === "offer_we_passed" && e.dedupeKey === "stale_unsent:o1"));
  assert.equal(store.outbox.get("q1").status, "dismissed", "a machine text still queued about it is binned");
  assert.equal(starts.length, 0, "nothing is texted");
  // The only GHL write is the outbox tag coming off with the binned draft,
  // as the status menu's "we passed" does: no note, no text.
  assert.deepEqual(client.calls.filter(([, p]) => p.includes("/contacts/") || p.includes("/conversations/")).map(([m, p]) => [m, p]), [["DELETE", "/contacts/c1/tags"]]);
  assert.deepEqual(r.findings.map((f) => [f.kind, f.severity, f.why]), [["stale_unsent", "fyi", "never sent: closed after 12 days"]]);
  assert.deepEqual(r.acted.map((a) => [a.kind, a.status]), [["stale_unsent", "closed"]]);
});

test("a dry run reports it and changes nothing; at 0 the setting is off", async () => {
  const store = fakeStore({ offers: [unsent()] });
  const dry = await sweepHeldUnderwrites({ client, locationId: "L", saved: SAVED, store, now: NOW, pace: 0, dryRun: true });
  assert.equal(store.book.get("o1").status, "new");
  assert.equal(dry.findings[0].kind, "stale_unsent");
  const off = await retireStaleUnsent({ locationId: "L", saved: savedWith({ retireUnsentDays: 0 }), store, now: NOW });
  assert.deepEqual(off, { retired: 0, findings: [], acted: [] });
});

test("a number texted in a plain reply, a row the house moved past, or a thread you have is left alone", async () => {
  const floated = unsent({ floatSentAt: ago(9) });
  // An older unsent row on the same house, replaced by a newer one that went out.
  const older = unsent({ id: "o-old", createdAt: ago(40) });
  const newer = unsent({ id: "o-new", createdAt: ago(20), sends: [{ ts: ago(20), results: { sms: { ok: true } } }], status: "sent", statusAt: ago(20) });
  const store = fakeStore({ offers: [floated, older, newer].map((o, i) => (i === 0 ? { ...o, id: "o-float", address: "9 Fern Ct, Puyallup, WA" } : o)) });
  const r = await retireStaleUnsent({ locationId: "L", saved: SAVED, store, now: NOW });
  assert.equal(r.retired, 0);
  assert.equal(store.book.get("o-float").status, "new");
  assert.equal(store.book.get("o-old").status, "new", "superseded: not this sweep's to close");

  const yours = fakeStore({ offers: [unsent()], events: [{ contactId: "c1", type: "hand_reply", at: ago(1) }] });
  assert.equal((await retireStaleUnsent({ locationId: "L", saved: SAVED, store: yours, now: NOW })).retired, 0);
});
