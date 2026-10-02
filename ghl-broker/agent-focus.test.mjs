// agent-focus.test.mjs — the doors other than the sweep ask too: the nightly
// audit's nudges and the agent check-in go through startProactive, and it
// refuses an unprompted text that would talk around one-house-at-a-time.

import test from "node:test";
import assert from "node:assert/strict";
import { agentTurnReason } from "./agent-focus.js";
import { startProactive, outboundDescriptor, _resetJobs } from "./reply-agent.js";
import { normalizeConversationAi } from "./shared/conversation-ai.js";

const DAY = 86400000;
const NOW = Date.now();
const ago = (d) => new Date(NOW - d * DAY).toISOString();

const LIVE = { id: "live", locationId: "LOC", contactId: "c1", address: "10625 SE 304th Way, Auburn, WA 98092", cashAmount: 258250,
  status: "sent", statusAt: ago(6), createdAt: ago(6), proactive: { realmCheckAt: ago(6) } };
const PASSED = { id: "mil", locationId: "LOC", contactId: "c1", address: "28422 Military Rd S, Federal Way, WA 98003", cashAmount: 165150,
  status: "passed", statusAt: ago(40), createdAt: ago(55), sends: [{ ts: ago(55) }], statusHistory: [{ status: "passed", ts: ago(40) }] };
const sentText = (day, kind = "offer_nudge") => ({ id: `t${day}`, locationId: "LOC", contactId: "c1", status: "sent", inbound: "", reply: "…",
  outbound: { kind, offerId: "live" }, createdAt: ago(day), updatedAt: ago(day), sentAt: ago(day) });

const storeWith = ({ offers = [LIVE, PASSED], drafts = [] } = {}) => ({
  async listReplyDrafts(_loc, { contactId = null, status = null } = {}) {
    return drafts.filter((d) => (!contactId || d.contactId === contactId) && (!status || d.status === status));
  },
  async listOffers(_loc, { contactId = null } = {}) { return offers.filter((o) => !contactId || o.contactId === contactId); },
  async listContactEvents() { return []; },
});

const config = normalizeConversationAi({
  enabled: true,
  parties: { agent: { followUp: { enabled: true, ladders: {
    offer_nudge: { enabled: true, steps: [3, 7, 14] }, passed_checkin: { enabled: true, steps: [10, 20, 30] },
  } } } },
});
const SAVED = { aiApiKey: "k", conversationAi: config };

test("a check-in on a house they passed on waits while their live offer is out, from any door", async () => {
  const why = await agentTurnReason({ store: storeWith(), locationId: "LOC", contactId: "c1", kind: "passed_checkin", address: PASSED.address, config, now: NOW });
  assert.match(why, /one house at a time — the live offer on 10625 SE 304th Way/);
  assert.match(await agentTurnReason({ store: storeWith(), locationId: "LOC", contactId: "c1", kind: "agent_pulse", config, now: NOW }), /one house at a time/);
  assert.equal(await agentTurnReason({ store: storeWith({ offers: [PASSED] }), locationId: "LOC", contactId: "c1", kind: "passed_checkin", address: PASSED.address, config, now: NOW }), null,
    "nothing live: the check-in may go");
});

test("the audit's nudge two days after our last unprompted text waits; a number they're owed never does", async () => {
  const store = storeWith({ drafts: [sentText(2)] });
  assert.match(await agentTurnReason({ store, locationId: "LOC", contactId: "c1", kind: "offer_nudge", config, now: NOW }), /we texted them 48h ago — unprompted texts are 72h apart/);
  assert.equal(await agentTurnReason({ store: storeWith({ drafts: [sentText(3.2)] }), locationId: "LOC", contactId: "c1", kind: "offer_nudge", config, now: NOW }), null);
  for (const kind of ["hot_push", "realm_check", "promise_due", "price_drop"]) {
    assert.equal(await agentTurnReason({ store, locationId: "LOC", contactId: "c1", kind, config, now: NOW }), null, kind);
  }
});

test("a store that can't be read holds nothing back", async () => {
  const broken = { async listReplyDrafts() { throw new Error("db down"); }, async listOffers() { throw new Error("db down"); } };
  assert.equal(await agentTurnReason({ store: broken, locationId: "LOC", contactId: "c1", kind: "passed_checkin", address: PASSED.address, config, now: NOW }), null);
});

test("startProactive refuses a passed-house check-in before any model call while another house is live", async () => {
  _resetJobs();
  let drafted = false;
  const r = await startProactive({
    client: { call: async () => { throw new Error("offline"); } }, locationId: "LOC", saved: SAVED, store: storeWith(), contactId: "c1",
    kind: "passed_checkin", offer: PASSED, subject: { address: PASSED.address, step: 30, steps: [10, 20, 30] },
    deps: { draft: async () => { drafted = true; return {}; } },
  });
  assert.equal(r.job, null);
  assert.equal(r.spaced, true);
  assert.match(r.skipped, /one house at a time/);
  assert.equal(drafted, false);

  const nudge = await startProactive({
    client: { call: async () => { throw new Error("offline"); } }, locationId: "LOC", saved: SAVED, store: storeWith({ drafts: [sentText(1)] }), contactId: "c1",
    kind: "offer_nudge", offer: LIVE, subject: { address: LIVE.address },
  });
  assert.match(nudge.skipped, /we texted them 24h ago/, "the nightly audit's nudge a day after our last text");
});

test("the sweep's line about a passed house and its repeating ladder reach the nudge's prompt", () => {
  const o = outboundDescriptor({ kind: "offer_nudge", offer: LIVE, saved: SAVED,
    subject: { address: LIVE.address, step: 7, steps: [3, 7, 14], repeatEvery: 7, aside: { address: PASSED.address, quiet: false } } });
  assert.deepEqual(o.aside, { street: "28422 Military Rd S", quiet: false });
  assert.equal(o.repeats, true);
  assert.equal(o.went, "number");
  const plain = outboundDescriptor({ kind: "offer_nudge", offer: LIVE, saved: SAVED, subject: { address: LIVE.address, step: 3, steps: [3, 7, 14] } });
  assert.equal(plain.aside, undefined);
  assert.equal(plain.repeats, undefined);
});
