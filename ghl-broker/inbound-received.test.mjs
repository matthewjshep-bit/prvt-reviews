// inbound-received.test.mjs — every text is written down the moment it
// arrives, so a restart can neither lose it nor draft it twice
// (reply-agent.js recordInbound, conversation-audit.js maybeRunBootPass).
//
// A reply job lives in memory: a debounce timer, then the lane. A deploy in
// that minute dropped the job with no trace, and GHL sending the same
// webhook again after the restart found an empty duplicate check and drafted
// it a second time. Names, streets and words here are invented.
//
//   node --test inbound-received.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "inbound-received-test-"));
delete process.env.DATABASE_URL;
delete process.env.CARD_SENDS_ENABLED;
process.env.AUTO_UNDERWRITE_SECRET = "inbound-test-secret";

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { startReply, recordInbound, inboundKey, _resetJobs, INBOUND_RECEIVED, INBOUND_IN_HAND_MS } = await import("./reply-agent.js");
const { maybeRunBootPass, BOOT_PASS_CURSOR, BOOT_PASS_DELAY_MS } = await import("./conversation-audit.js");
const { starterConfig } = await import("./shared/conversation-ai.js");
const { followUpEngineFor, repliesFrom, _resetPlanMemo } = await import("./follow-up-engine.js");
const { default: createOffersRouter } = await import("./routes/offers.js");
await store.init();

const MIN = 60000;
const settle = () => new Promise((r) => setTimeout(r, 60));
const STARTER = starterConfig({ signer: "Matt" });
const SAVED = { aiApiKey: "k", company: { signer: "Matt" }, conversationAi: { ...STARTER, autoSend: { ...STARTER.autoSend, debounceSec: 0 } } };
const WITH_BOOT_PASS = { ...SAVED, conversationAi: { ...SAVED.conversationAi, nightlyAudit: { ...(STARTER.nightlyAudit || {}), bootPass: true } } };
const DRAFT = {
  intent: "question", confidence: "high", needsHuman: false, humanReason: "",
  reply: "It is, want me to send the numbers on 18 Juniper Ct?", summary: "Agent asked if we still want the house.",
  propertyAddress: "18 Juniper Ct", counterAmount: 0,
};

// GHL: one agent contact, no conversations, notes and tags recorded.
function ghl() {
  const notes = [];
  const client = {
    call: async (p, opts = {}) => {
      const m = /^\/contacts\/([\w-]+)$/.exec(p);
      if (m && !opts.method) return { contact: { id: m[1], firstName: "Robin", lastName: "Vale", tags: ["agent"] } };
      if (m) return { contact: {} };
      if (p.endsWith("/customFields") && !opts.method) return { customFields: [] };
      if (p.endsWith("/notes")) { notes.push(opts.body?.body || ""); return {}; }
      if (p.endsWith("/tags")) return {};
      if (p.startsWith("/conversations/search")) return { conversations: [] };
      if (p.includes("/workflow/")) return { succeeded: true };
      return {};
    },
  };
  return { client, notes };
}
const draftsFor = async (loc, contactId) => (await store.listReplyDrafts(loc, { contactId, limit: 50 })).filter((d) => String(d.inbound || "").trim());
const receivedFor = async (loc, contactId) => store.listContactEvents(loc, contactId, { types: [INBOUND_RECEIVED] });

test("the same webhook twice across a restart drafts once", async () => {
  _resetJobs();
  const LOC = "loc-twice";
  const contactId = "c-twice";
  const { client } = ghl();
  let modelCalls = 0;
  const deps = { draft: async () => { modelCalls++; return DRAFT; }, debounceMs: 0 };
  const deliver = async () => {
    const received = await recordInbound({ store, locationId: LOC, contactId, channel: "sms", messageId: "ghl-msg-1", message: "still want 18 Juniper Ct?" });
    return startReply({ client, locationId: LOC, saved: SAVED, store, contactId, message: "still want 18 Juniper Ct?", channel: "sms", deps, received });
  };
  const first = await deliver();
  await settle();
  assert.equal(first.job.status, "done", first.job.error);
  _resetJobs();   // the restart: every reply job in memory is gone
  const second = await deliver();
  await settle();
  assert.equal(second.job, null);
  assert.match(second.skipped, /duplicate of the text that came in at/);
  assert.equal(modelCalls, 1, "one model call");
  assert.equal((await draftsFor(LOC, contactId)).length, 1, "one draft");
  assert.equal((await receivedFor(LOC, contactId)).length, 1, "one record of the text");
});

test("a second delivery of a text whose first job died, with nothing drafted in ten minutes, is answered", async () => {
  _resetJobs();
  const LOC = "loc-lost";
  const contactId = "c-lost";
  const { client } = ghl();
  let modelCalls = 0;
  const deps = { draft: async () => { modelCalls++; return DRAFT; }, debounceMs: 0 };
  // The first delivery, written down 20 minutes ago; its job went with a crash.
  await recordInbound({ store, locationId: LOC, contactId, messageId: "ghl-msg-9", message: "any update?", now: Date.now() - 20 * MIN });
  const again = await recordInbound({ store, locationId: LOC, contactId, messageId: "ghl-msg-9", message: "any update?" });
  assert.equal(again.duplicate, true);
  assert.ok(Date.now() - Date.parse(again.firstAt) > INBOUND_IN_HAND_MS);
  const r = await startReply({ client, locationId: LOC, saved: SAVED, store, contactId, message: "any update?", deps, received: again });
  await settle();
  assert.ok(r.job, r.skipped);
  assert.equal(modelCalls, 1);
});

test("without GHL's message id the key is the words and the minute, and never the words themselves", async () => {
  const at = Date.parse("2026-11-09T20:15:30.000Z");
  const k = inboundKey({ contactId: "c1", message: "the Larkspur house is ready to show", at });
  assert.match(k, /^inbound:c1:[0-9a-f]{16}:2026-11-09T20:15$/);
  assert.equal(k.includes("Larkspur"), false);
  assert.equal(inboundKey({ contactId: "c1", message: "the Larkspur house is ready to show", at: at + 20000 }), k, "same minute, same key");
  assert.equal(inboundKey({ messageId: "abc123", contactId: "c1", message: "x" }), "inbound:abc123");
  // The same words across the minute's turn are still one text.
  const LOC = "loc-minute";
  await recordInbound({ store, locationId: LOC, contactId: "c-min", message: "call me after four", now: at });
  const next = await recordInbound({ store, locationId: LOC, contactId: "c-min", message: "call me after four", now: at + 40000 });
  assert.equal(next.duplicate, true);
});

test("the webhook writes the text down before its reply starts, with the channel and id but not the words", async () => {
  const LOC = "loc-webhook";
  const { client } = ghl();
  await store.saveOfferSettings(LOC, { aiApiKey: "k", conversationAi: { ...STARTER, enabled: false } });
  const app = express();
  app.use(express.json());
  app.use("/api/offers", createOffersRouter({ resolveLocation: () => ({ locationId: LOC, client }), uploadDir: process.env.DATA_DIR }));
  const server = app.listen(0);
  const B = `http://127.0.0.1:${server.address().port}`;
  try {
    const body = { location_id: LOC, secret: "inbound-test-secret", contactId: "c-hook", message: { body: "is the Wren St duplex still open?", id: "ghl-msg-77", type: "SMS" } };
    const post = async () => (await fetch(`${B}/api/offers/automations/conversation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    const r = await post();
    assert.equal(r.ok, true);
    assert.match(r.skipped, /switched off/, "the bot is off here, so nothing is drafted or spent");
    await post();
    const rows = await receivedFor(LOC, "c-hook");
    assert.equal(rows.length, 1, "GHL sending it twice is one record");
    assert.equal(rows[0].dedupeKey, "inbound:ghl-msg-77");
    assert.deepEqual(rows[0].data, { channel: "sms", messageId: "ghl-msg-77" });
    assert.equal(JSON.stringify(rows).includes("Wren"), false, "the words are not on the record");
  } finally { server.close(); }
});

test("a text whose reply job a restart dropped is answered after the broker comes back when the boot pass is on", async () => {
  _resetJobs();
  const LOC = "loc-boot-on";
  const contactId = "c-dropped";
  const { client } = ghl();
  let modelCalls = 0;
  const words = "can you do a walkthrough on 40 Alder Way Friday?";
  // The webhook took it, and its job was waiting out the debounce when the deploy landed.
  const received = await recordInbound({ store, locationId: LOC, contactId, messageId: "ghl-msg-dropped", message: words });
  const before = await startReply({ client, locationId: LOC, saved: WITH_BOOT_PASS, store, contactId, message: words, received,
    deps: { draft: async () => { modelCalls++; return DRAFT; }, debounceMs: 60000 } });
  assert.equal(before.job.phase, "waiting");
  _resetJobs();
  assert.equal(modelCalls, 0);

  const bootAt = Date.now();
  const read = [];
  const deps = {
    draft: async () => { modelCalls++; return DRAFT; }, debounceMs: 0,
    latestInbound: async (id) => { read.push(id); return { body: words, at: received.at, type: "SMS", attachments: 0 }; },
  };
  assert.equal(await maybeRunBootPass({ client, locationId: LOC, saved: WITH_BOOT_PASS, store, deps, now: bootAt + 60000, bootAt, pace: 0 }), false, "not in the first minutes");
  assert.equal(await maybeRunBootPass({ client, locationId: LOC, saved: WITH_BOOT_PASS, store, deps, now: bootAt + BOOT_PASS_DELAY_MS + 1000, bootAt, pace: 0 }), true);
  await settle();
  assert.deepEqual(read, [contactId], "the words were read back from GHL, not from the record");
  assert.equal(modelCalls, 1);
  assert.equal((await draftsFor(LOC, contactId)).length, 1, "answered");
  const cur = await store.getJobCursor(LOC, BOOT_PASS_CURSOR);
  assert.equal(cur.doc.last.status, "done");
  assert.equal(cur.doc.last.started, 1);
  // Once per start.
  assert.equal(await maybeRunBootPass({ client, locationId: LOC, saved: WITH_BOOT_PASS, store, deps, now: bootAt + 20 * MIN, bootAt, pace: 0 }), false);
  // The next start sees the draft and leaves it.
  const later = bootAt + 30 * MIN;
  assert.equal(await maybeRunBootPass({ client, locationId: LOC, saved: WITH_BOOT_PASS, store, deps, now: later + BOOT_PASS_DELAY_MS, bootAt: later, pace: 0 }), true);
  await settle();
  assert.equal(modelCalls, 1, "an answered text is not answered again");
});

test("the boot pass leaves what was answered, what the bot let go, an auto-reply, and a photo it can't read back", async () => {
  _resetJobs();
  const LOC = "loc-boot-leaves";
  const now = Date.now();
  const started = [];
  const deps = {
    startReply: async (a) => { started.push(a.contactId); return { job: { id: `j-${a.contactId}` } }; },
    latestInbound: async (id) => (id === "c-photo"
      ? { body: "an older text with words", at: new Date(now - 50 * MIN).toISOString(), type: "SMS" }
      : { body: "words from GHL", at: new Date(now - 5 * MIN).toISOString(), type: "SMS" }),
  };
  const rec = (contactId, extra = {}) => recordInbound({ store, locationId: LOC, contactId, message: `text from ${contactId}`, now: now - 5 * MIN, ...extra });
  await rec("c-answered");
  await store.createReplyDraft({ locationId: LOC, contactId: "c-answered", status: "draft", inbound: "text from c-answered", reply: "Sure." });
  await rec("c-let-go");
  await store.appendContactEvents(LOC, "c-let-go", [{ type: "reply_held", at: new Date(now - 4 * MIN).toISOString(), source: "conversation", dedupeKey: "rh-1", data: { reason: "bot is off" } }]);
  await rec("c-auto", { message: "This number does not accept text messages. Please call the office." });
  await rec("c-photo");
  await rec("c-owed");
  const bootAt = now - BOOT_PASS_DELAY_MS - 1000;
  assert.equal(await maybeRunBootPass({ client: {}, locationId: LOC, saved: WITH_BOOT_PASS, store, deps, now, bootAt, pace: 0 }), true);
  assert.deepEqual(started, ["c-owed"]);
  const last = (await store.getJobCursor(LOC, BOOT_PASS_CURSOR)).doc.last;
  assert.equal(last.left, 3, "answered, let go, and the photo; the auto-reply isn't even considered");
});

test("with the boot pass off nothing is re-driven", async () => {
  _resetJobs();
  const LOC = "loc-boot-off";
  const now = Date.now();
  await recordInbound({ store, locationId: LOC, contactId: "c-waiting", messageId: "ghl-msg-off", message: "is it still available?", now: now - 5 * MIN });
  const started = [];
  const deps = { startReply: async (a) => { started.push(a.contactId); return { job: { id: "j" } }; }, latestInbound: async () => ({ body: "is it still available?", at: new Date(now - 5 * MIN).toISOString() }) };
  assert.equal(SAVED.conversationAi.nightlyAudit?.bootPass, false, "off unless switched on");
  assert.equal(await maybeRunBootPass({ client: {}, locationId: LOC, saved: SAVED, store, deps, now, bootAt: now - 10 * MIN, pace: 0 }), false);
  assert.deepEqual(started, []);
  assert.equal(await store.getJobCursor(LOC, BOOT_PASS_CURSOR), null, "nothing claimed either");
});

test("a reply the bot never drafted still counts as a reply on Follow-up", async () => {
  const LOC = "loc-follow-up-replies";
  const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();
  // Two cold-agent follow-ups went yesterday.
  for (const id of ["c-wrote-back", "c-auto-only"]) {
    await store.createReplyDraft({ locationId: LOC, contactId: id, contactName: "Agent", status: "sent", sentAt: ago(24), autoSent: true, inbound: "",
      outbound: { kind: "outreach_nudge" }, intent: "outreach_nudge", reply: "Checking back on your listing on Poplar." });
  }
  // One wrote back while the bot was switched off: no draft, no summary, only the record.
  await recordInbound({ store, locationId: LOC, contactId: "c-wrote-back", message: "send me your number", now: Date.now() - 23 * 3600000 });
  // The other's phone answered for them.
  await recordInbound({ store, locationId: LOC, contactId: "c-auto-only", message: "Thank you for your message, we will get back to you shortly.", now: Date.now() - 23 * 3600000 });
  _resetPlanMemo();
  const page = await followUpEngineFor({ store, locationId: LOC, saved: {}, period: "ytd" });
  const cold = page.groups.find((g) => g.key === "agent").mechanisms.find((m) => m.key === "outreach_nudge");
  assert.equal(cold.sent, 2);
  assert.equal(cold.replied, 1, "the reply counts; the auto-reply doesn't");
  assert.deepEqual(repliesFrom([
    { type: "inbound_received", contactId: "a", at: "t1", data: { channel: "sms" } },
    { type: "inbound_received", contactId: "b", at: "t1", data: { noise: "echo" } },
    { type: "text_summary", contactId: "c", at: "t2", data: { inbound: "" } },
    { type: "call_summary", contactId: "d", at: "t3", data: {} },
  ]), [{ contactId: "a", at: "t1" }, { contactId: "d", at: "t3" }]);
});
