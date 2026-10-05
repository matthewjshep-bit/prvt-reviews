import test from "node:test";
import assert from "node:assert/strict";
import { misreadHold, releaseMisreadHolds } from "./misread-holds.js";
import { conversationConfig } from "./reply-agent.js";

/* ---------- fixtures ---------- */

const NOW = Date.parse("2026-10-05T20:00:00Z");
const SAVED = { conversationAi: { enabled: true, parties: { agent: { autoSend: { enabled: true, intents: ["outreach_open", "outreach_nudge"] } } } } };
const CONFIG = conversationConfig(SAVED);

// A first text as runProactive stored it on 2026-10-05 before SHORT_STREET:
// the reader took the street number for a price and the gate held it.
const flag = "the draft names $1,301,000, which is not in the offer book";
const HELD = {
  id: "d1", locationId: "LOC", contactId: "c1", status: "draft", channel: "sms", party: "agent",
  intent: "outreach_open", inbound: "", needsHuman: false, createdAt: "2026-10-05T17:10:00Z",
  outbound: { kind: "outreach_open", address: "1301 225th Pl SE", county: "King" },
  reply: "Hi Janet, came across your listing at 1301 225th Pl SE. I'm in Seattle looking for my next flip anywhere in King County. Is it more of a project or pretty turnkey?",
  autoSendable: false, gateClean: false, flags: [flag],
  autoSend: { decided: false, reason: `needs a person: ${flag}` },
};

const fakeStore = (drafts = []) => {
  const rows = new Map(drafts.map((d) => [d.id, d]));
  return {
    rows,
    listReplyDrafts: async (_loc, { status = null, contactId = null } = {}) =>
      [...rows.values()].filter((d) => (!status || d.status === status) && (!contactId || d.contactId === contactId)),
    updateReplyDraft: async (id, doc) => { rows.set(id, doc); return true; },
  };
};

/* ---------- the misread ---------- */

test("a first text held because its street number read as a price goes back on its clock once the reader is fixed", async () => {
  assert.deepEqual(misreadHold(HELD, { config: CONFIG, sendsEnabled: true, now: NOW }), { ok: true, reason: "", amounts: [1301000] });
  const store = fakeStore([HELD]);
  const r = await releaseMisreadHolds({ store, locationId: "LOC", saved: SAVED, sendsEnabled: true, now: NOW, random: () => 0 });
  assert.equal(r.released, 1);
  const d = store.rows.get("d1");
  assert.equal(d.status, "scheduled");
  assert.ok(Date.parse(d.sendAt) >= NOW);
  assert.equal(d.gateClean, true);
  assert.equal(d.autoSend.decided, true);
  assert.doesNotMatch(d.autoSend.reason, /needs a person/);
  assert.deepEqual(d.flags.filter((f) => /not in the offer book/.test(f)), []);
});

test("a held text that still names the number, or was held for anything else, stays with you", () => {
  const ok = (over, opts = {}) => misreadHold({ ...HELD, ...over }, { config: CONFIG, sendsEnabled: true, now: NOW, ...opts }).ok;
  // The reader still sees it: a real price the book doesn't have.
  const priced = "the draft names $410,000, which is not in the offer book";
  assert.equal(ok({ reply: "Could you do 410k on 1301 225th Pl SE?", flags: [priced], autoSend: { decided: false, reason: `needs a person: ${priced}` } }), false);
  assert.equal(ok({ reply: "Would they look at $410,000 cash?", flags: [priced], autoSend: { decided: false, reason: `needs a person: ${priced}` } }), false);
  // Held for the number and something else too.
  assert.equal(ok({ flags: [flag, "the draft says \"cash offer\" — carriers block it"] }), false);
  // Our contract price or fee is a different flag, never released here.
  const leak = "the draft names $1,301,000, which is our contract price or assignment fee";
  assert.equal(ok({ flags: [leak], autoSend: { decided: false, reason: `needs a person: ${leak}` } }), false);
  // You stopped the bot on them first: the reason is the stop, not the number.
  assert.equal(ok({ autoSend: { decided: false, reason: "you stopped the bot on them — it waits for you" } }), false);
  // A reply to their text, not one the machine started.
  assert.equal(ok({ inbound: "Is this a cash offer?" }), false);
  assert.equal(ok({ outbound: null }), false);
  // The model asked for a person.
  assert.equal(ok({ needsHuman: true }), false);
  // Gone, sent or dismissed already.
  assert.equal(ok({ status: "dismissed" }), false);
  // Too old to still be news about their listing.
  assert.equal(ok({ createdAt: "2026-10-01T17:10:00Z" }), false);
  // The switches as they stand would not send it.
  assert.equal(ok({}, { sendsEnabled: false }), false);
  assert.equal(ok({}, { config: conversationConfig({ conversationAi: { ...SAVED.conversationAi, enabled: false } }) }), false);
  assert.equal(ok({}, { config: conversationConfig({ conversationAi: { enabled: true, parties: { agent: { autoSend: { enabled: true, intents: ["outreach_nudge"] } } } } }) }), false);
  assert.equal(ok({ party: "unknown" }), false);
});

test("a dry run says what would go and changes nothing", async () => {
  const store = fakeStore([HELD]);
  const r = await releaseMisreadHolds({ store, locationId: "LOC", saved: SAVED, sendsEnabled: true, now: NOW, dryRun: true });
  assert.equal(r.released, 1);
  assert.equal(store.rows.get("d1").status, "draft");
});

test("a contact with another open draft keeps the newer one and the misread waits", async () => {
  const newer = { ...HELD, id: "d2", status: "scheduled", flags: [], createdAt: "2026-10-05T18:00:00Z", autoSend: { decided: true, reason: "" } };
  const store = fakeStore([HELD, newer]);
  const r = await releaseMisreadHolds({ store, locationId: "LOC", saved: SAVED, sendsEnabled: true, now: NOW });
  assert.equal(r.released, 0);
  assert.equal(store.rows.get("d1").status, "draft");
});
