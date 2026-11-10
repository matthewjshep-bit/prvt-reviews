// deal-ledger.test.mjs — who already has a deal, read back from the threads
// (2026-11-09).
//
// Matt's scripts texted deals to about 1,140 buyers after 10/21 and the app
// recorded none of it. The backfill reads the threads since the deal was made
// and writes a deal_hand_sent for each buyer we texted it to, so a Resume or
// the morning catch-up doesn't text them again. The listing agent's thread
// names the street too, and a text the carrier blocked never reached anyone.

import test from "node:test";
import assert from "node:assert/strict";
import { startLedgerBackfill, getLedgerJob, _resetLedgerJobs, dealTextIn } from "./deal-ledger.js";
import { pitchPatterns } from "./feedback-scan.js";

const settle = () => new Promise((r) => setTimeout(r, 30));
const OFFER = { id: "o1", locationId: "LOC", contactId: "agent1", address: "4410 Fernhill Rd SE, Bellevue, WA 98006",
  deal: { stage: "under_contract", createdAt: "2026-11-02T18:00:00.000Z", parties: { title: { contactId: "title1", name: "Escrow Co" } } } };

function fakeGhl({ conversations, messages }) {
  return { call: async (path) => {
    if (path.startsWith("/conversations/search")) return { conversations: /startAfterDate/.test(path) ? [] : conversations, total: conversations.length };
    const m = /\/conversations\/([^/]+)\/messages/.exec(path);
    if (m) return { messages: { messages: messages[m[1]] || [], nextPage: false } };
    throw new Error(`unexpected ${path}`);
  } };
}
const fakeStore = ({ book = [], events = [] } = {}) => ({
  events: [...events],
  async getInvestor(_loc, contactId) { return book.includes(contactId) ? { contactId, doc: {} } : null; },
  async listContactEventsSince(_loc, _since, { types } = {}) { return this.events.filter((e) => !types || types.includes(e.type)); },
  async appendContactEvents(_loc, contactId, rows) {
    let inserted = 0;
    for (const r of rows) { if (this.events.some((e) => e.contactId === contactId && e.dedupeKey === r.dedupeKey)) continue; this.events.push({ ...r, contactId }); inserted++; }
    return { inserted, skipped: rows.length - inserted };
  },
  async getContactProfile() { return null; }, async upsertContactProfile() { return {}; },
});
let n = 0;
const msg = (direction, body, at, extra = {}) => ({ id: `m${++n}`, direction, body, dateAdded: at, messageType: "TYPE_SMS", ...extra });
const convo = (id, contactId, at = "2026-11-03T20:00:00Z") => ({ id, contactId, lastMessageDate: Date.parse(at) });

test("the backfill skips the listing agent's own thread and a text the carrier blocked", async () => {
  _resetLedgerJobs();
  const client = fakeGhl({
    conversations: [convo("c1", "b1"), convo("c2", "agent1"), convo("c3", "b2"), convo("c4", "title1"), convo("c5", "b3"), convo("c6", "stranger"), convo("c7", "b4"), convo("c8", "b5")],
    messages: {
      c1: [msg("outbound", "Hey Dana, I've got a lot at 4410 Fernhill Rd SE in Bellevue. Any interest?", "2026-11-03T19:00:00Z")],
      c2: [msg("outbound", "Thanks, we're set on 4410 Fernhill Rd SE, title is opened", "2026-11-03T18:30:00Z")],
      c3: [msg("outbound", "Hey Lee, I've got a lot at 4410 Fernhill Rd SE. Any interest?", "2026-11-03T19:01:00Z", { status: "undelivered" })],
      c4: [msg("outbound", "Opening escrow on 4410 Fernhill Rd SE", "2026-11-03T18:00:00Z")],
      c5: [msg("outbound", "Hey Kit, got one at 77 Other Pl in Kent", "2026-11-03T19:02:00Z")],
      c6: [msg("outbound", "Hey, I've got a lot at 4410 Fernhill Rd SE", "2026-11-03T19:03:00Z")],
      // Blocked once, then the resend went through.
      c7: [msg("outbound", "Hey Ash, 4410 Fernhill Rd SE https://deals.example/d/x", "2026-11-03T19:04:00Z", { status: "failed" }),
        msg("outbound", "Hey Ash, I've got a lot at 4410 Fernhill Rd SE. Want the package?", "2026-11-03T19:40:00Z")],
      // Texted before the deal existed.
      c8: [msg("outbound", "Might have one coming at 4410 Fernhill Rd SE", "2026-10-30T19:00:00Z")],
    },
  });
  const store = fakeStore({ book: ["b1", "b2", "b3", "b4", "b5", "agent1", "title1"] });

  const dry = startLedgerBackfill({ client, store, locationId: "LOC", offer: OFFER, deps: { paceMs: 0 } });
  await settle();
  assert.equal(dry.status, "done", dry.error);
  assert.equal(dry.dryRun, true, "dry unless told otherwise");
  assert.equal(dry.buyers, 2, "b1, and b4 whose resend went through");
  assert.equal(dry.written, 0);
  assert.deepEqual(dry.skipped, { listingAgent: 1, dealParties: 1, failedSend: 1, notInBook: 1, already: 0 });
  assert.equal(store.events.length, 0, "a dry run writes nothing");
  assert.equal(JSON.stringify(dry).includes("Dana"), false, "counts only: nobody's name or words");

  const live = startLedgerBackfill({ client, store, locationId: "LOC", offer: OFFER, dryRun: false, deps: { paceMs: 0 } });
  await settle();
  assert.equal(live.status, "done", live.error);
  assert.equal(live.written, 2);
  assert.deepEqual(store.events.map((e) => [e.contactId, e.type, e.offerId]).sort(), [["b1", "deal_hand_sent", "o1"], ["b4", "deal_hand_sent", "o1"]]);
  assert.equal(store.events.find((e) => e.contactId === "b4").at, "2026-11-03T19:40:00.000Z", "the text that arrived");
  assert.equal(getLedgerJob("o1").id, live.id);

  // Run again: everyone is on the ledger already.
  const again = startLedgerBackfill({ client, store, locationId: "LOC", offer: OFFER, dryRun: false, deps: { paceMs: 0 } });
  await settle();
  assert.equal(again.written, 0);
  assert.equal(again.skipped.already, 2);
});

test("a text names the deal by its street; a failed one doesn't count", () => {
  const pats = pitchPatterns(OFFER.address);
  const since = Date.parse(OFFER.deal.createdAt);
  assert.equal(dealTextIn([msg("inbound", "is 4410 Fernhill Rd SE still around?", "2026-11-03T19:00:00Z")], { pats, since }), null, "their words aren't our send");
  assert.deepEqual(dealTextIn([msg("outbound", "4410 Fernhill Rd SE", "2026-11-03T19:00:00Z", { status: "undelivered" })], { pats, since }), { failed: true });
  assert.equal(dealTextIn([msg("outbound", "4410 Fernhill Rd SE", "2026-11-03T19:00:00Z", { messageType: "TYPE_CALL" })], { pats, since }), null);
  assert.equal(dealTextIn([msg("outbound", "4410 Fernhill Rd SE", "2026-11-03T19:00:00Z")], { pats, since }).at, "2026-11-03T19:00:00.000Z");
});

test("the backfill only runs on a deal, one at a time", async () => {
  _resetLedgerJobs();
  assert.throws(() => startLedgerBackfill({ client: fakeGhl({ conversations: [], messages: {} }), store: fakeStore(), locationId: "LOC", offer: { id: "o9", address: "1 Elm St" } }), /not a deal/);
  const slow = { call: () => new Promise(() => {}) };
  startLedgerBackfill({ client: slow, store: fakeStore(), locationId: "LOC", offer: OFFER, deps: { paceMs: 0 } });
  assert.throws(() => startLedgerBackfill({ client: slow, store: fakeStore(), locationId: "LOC", offer: OFFER }), (e) => e.http === 409);
  _resetLedgerJobs();
});
