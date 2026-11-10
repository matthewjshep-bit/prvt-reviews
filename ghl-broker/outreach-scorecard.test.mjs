// outreach-scorecard.test.mjs — the text scoreboard: what each send records,
// the nightly read, and the card Reports show.
//
// What would go wrong without these:
//   - a first text, follow-up or check-in would go with nothing saying which
//     of Matt's fixed texts it was, so no report could tell them apart
//   - the read would run on every page open (the 11-09 crash) or twice a night
//   - a run that died would leave Reports with nothing until the next night
//
//   node --test outreach-scorecard.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-scorecard-test-"));
delete process.env.DATABASE_URL;

const { store } = await import("./store.js");
const { startProactive, sendReplyDraft } = await import("./reply-agent.js");
const { templateHash } = await import("./shared/outreach-scorecard.js");
const { normalizeOpener } = await import("./shared/outreach-opener.js");
const { maybeRunOutreachScorecard, runOutreachScorecard, storedOutreachScorecard, templateLabels, CURSOR_NAME, _resetInFlight } = await import("./outreach-scorecard.js");
await store.init();

const client = { call: async (p) => (p === "/conversations/messages" ? { messageId: `m-${Math.random().toString(36).slice(2)}` } : {}) };
const settle = async (job) => { for (let i = 0; i < 200 && !["done", "held", "error"].includes(job.status); i++) await new Promise((r) => setTimeout(r, 10)); };
// 4:15am Pacific on a Tuesday (PST, UTC−8).
const NIGHT = Date.parse("2026-11-10T12:15:00Z");

test("outreach_sent names the fixed text that went", async () => {
  const L = "loc-score-first";
  const saved = { aiApiKey: "test-key", conversationAi: { enabled: true, parties: { agent: { outreach: { enabled: true } } } } };
  const subject = { address: "48 Quill Ave, Renton, WA 98055", county: "King", city: "Renton", variant: 5 };
  const { job, skipped } = await startProactive({ client, locationId: L, saved, store, contactId: "c-quill", kind: "outreach_open", subject,
    deps: { draft: async () => { throw new Error("a fixed text needs no model"); } } });
  assert.ok(job, skipped);
  await settle(job);
  assert.equal(job.status, "done", job.error || job.heldReason);
  const d = await store.getReplyDraft(job.draftId);
  const examples = normalizeOpener(saved.outreachAutopilot?.opener).examples;
  const std = d.outbound.standard;
  assert.equal(std.set, "opener");
  assert.equal(std.templateHash, templateHash(examples[std.index]), "the fingerprint of the unfilled text it came from");

  await sendReplyDraft({ client, store, locationId: L, draftId: d.id, text: d.reply, live: true });
  const [sent] = await store.listContactEvents(L, "c-quill", { types: ["outreach_sent"] });
  assert.deepEqual(sent.data.standard, std);
  assert.equal(templateLabels(saved).templates[std.templateHash].slice(0, 20), examples[std.index].slice(0, 20), "the card can show the text itself");
});

test("a follow-up and a check-in that went say which text, which step and what it named", async () => {
  const L = "loc-score-nudge";
  const nudge = await store.createReplyDraft({ locationId: L, contactId: "c-larch", status: "draft", channel: "sms", inbound: "", party: "agent",
    reply: "Hi Ines, any other fixers come across your desk?", intent: "outreach_nudge", updatedAt: new Date().toISOString(),
    outbound: { kind: "outreach_nudge", address: "9 Larch Ln, Kent, WA", step: 2, county: "King", standard: { set: "follow_up", index: 0, templateHash: "f00" } } });
  await sendReplyDraft({ client, store, locationId: L, draftId: nudge.id, text: nudge.reply, live: true });
  const [n] = await store.listContactEvents(L, "c-larch", { types: ["outreach_nudge_sent"] });
  assert.ok(n, "the send-time record of the follow-up");
  assert.deepEqual([n.data.step, n.data.set, n.data.index, n.data.templateHash, n.data.draftId], [2, "follow_up", 0, "f00", nudge.id]);

  const pulse = await store.createReplyDraft({ locationId: L, contactId: "c-birch", status: "draft", channel: "sms", inbound: "", party: "agent",
    reply: "Hey Omar, did the one on Birch ever come together?", intent: "agent_pulse", updatedAt: new Date().toISOString(),
    outbound: { kind: "agent_pulse", address: "", segment: "engaged", reason: "general", hook: "mentioned", detailKind: "street" } });
  await sendReplyDraft({ client, store, locationId: L, draftId: pulse.id, text: pulse.reply, live: true });
  const [p] = await store.listContactEvents(L, "c-birch", { types: ["agent_pulse_texted"] });
  assert.equal(p.data.detailKind, "street");
  assert.equal(p.data.hook, "mentioned");
});

test("the nightly read scores what went from the store, and Reports read the kept card", async () => {
  const L = "loc-score-night";
  const at = new Date(NIGHT - 20 * 86400000).toISOString();
  for (let i = 0; i < 3; i++) {
    await store.appendContactEvents(L, `a${i}`, [{ type: "outreach_sent", at, source: "conversation", dedupeKey: `os:a${i}`,
      data: { auto: true, chars: 100, county: "King", standard: { set: "opener", index: 0, templateHash: "aaa" } } }]);
  }
  await store.appendContactEvents(L, "a0", [{ type: "text_summary", at: new Date(Date.parse(at) + 3600000).toISOString(), source: "conversation", party: "agent",
    dedupeKey: "ts:a0", data: { inbound: "I have a duplex that needs work", intent: "has_property" } }]);
  await store.appendContactEvents(L, "a1", [{ type: "text_summary", at: new Date(Date.parse(at) + 7200000).toISOString(), source: "conversation", party: "agent",
    dedupeKey: "ts:a1", data: { inbound: "STOP", intent: "opt_out" } }]);
  const card = await runOutreachScorecard({ store, locationId: L, now: NIGHT });
  const t = card.kinds.first_text.totals;
  assert.deepEqual([t.n, t.replied7, t.stopped], [3, 1, 1]);

  _resetInFlight();
  assert.equal(await storedOutreachScorecard({ store, locationId: L }), null, "nothing kept before the first night");
  const r = await maybeRunOutreachScorecard({ store, locationId: L, now: NIGHT });
  assert.equal(r.ran, true);
  const kept = await storedOutreachScorecard({ store, locationId: L });
  assert.equal(kept.card.kinds.first_text.totals.n, 3);
  assert.equal(kept.status, "done");
});

test("the read runs once a night in its hour, the cursor first; a run that failed is tried again, at most three times", async () => {
  const L = "loc-score-gate";
  _resetInFlight();
  const calls = [];
  let fail = true;
  const build = async ({ locationId }) => {
    const c = await store.getJobCursor(locationId, CURSOR_NAME);
    calls.push(c?.doc?.run?.startedAt ? "cursor first" : "no cursor");
    if (fail) throw new Error("read failed");
    return { kinds: {}, generatedAt: new Date(NIGHT).toISOString() };
  };
  assert.equal(await maybeRunOutreachScorecard({ store, locationId: L, now: NIGHT - 2 * 3600000, deps: { build } }), null, "2am is not its hour");
  const first = await maybeRunOutreachScorecard({ store, locationId: L, now: NIGHT, deps: { build } });
  assert.equal(first.ran, false);
  assert.deepEqual(calls, ["cursor first"]);
  assert.equal((await store.getJobCursor(L, CURSOR_NAME)).doc.failed, true);
  // Too soon to try again.
  assert.equal(await maybeRunOutreachScorecard({ store, locationId: L, now: NIGHT + 5 * 60000, deps: { build } }), null);
  fail = false;
  const again = await maybeRunOutreachScorecard({ store, locationId: L, now: NIGHT + 30 * 60000, deps: { build } });
  assert.equal(again.ran, true);
  assert.equal((await store.getJobCursor(L, CURSOR_NAME)).doc.tries, 2);
  // Done for the night.
  assert.equal(await maybeRunOutreachScorecard({ store, locationId: L, now: NIGHT + 60 * 60000, deps: { build } }), null);
  assert.equal(calls.length, 2);
});
