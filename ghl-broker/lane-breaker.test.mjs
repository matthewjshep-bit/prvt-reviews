// lane-breaker.test.mjs — a send lane whose texts get blocked or STOPped
// pauses itself (lane-breaker.js, 2026-11-23 audit AH-4).
//
// On 11-23 the first 49 lot-owner texts had 15 carrier blocks before anyone
// changed the words, and nothing stopped the lane: the delivery check only
// reads sends 2 hours old and up. The store is the JSON-file backend in a
// temp folder; GHL and Slack are stubs. Every name, street and word below is
// made up.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lane-breaker-test-"));
process.env.DATA_DIR = DIR;
delete process.env.DATABASE_URL;

const { store, laneSendsQuery, laneSendInWindow, updateReplyDraftIfQuery } = await import("./store.js");
await store.init();
const { runLaneBreaker, maybeRunLaneBreaker, clearLane, laneHoldsFor, laneBreakerStatus, _resetLaneBreaker, CURSOR_NAME } = await import("./lane-breaker.js");
const { sendDueDrafts } = await import("./conversation-scheduler.js");
const { recordEvent } = await import("./contact-record.js");
const { default: express } = await import("express");
const { default: createLaneBreakerRouter } = await import("./routes/lane-breaker.js");
test.after(async () => { await new Promise((r) => setTimeout(r, 120)); fs.rmSync(DIR, { recursive: true, force: true }); });

// Monday 2026-11-24, 11am Pacific.
const NOW = Date.parse("2026-11-24T19:00:00Z");
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();
const minsOn = (m) => new Date(NOW + m * 60000).toISOString();

// A fake GHL: each message's delivery by id; every call recorded.
function ghlStub(statuses = {}) {
  const calls = [];
  return {
    calls,
    sends: () => calls.filter((c) => c.method === "POST"),
    async call(p, { method = "GET", body } = {}) {
      calls.push({ method, path: p, body });
      const m = /^\/conversations\/messages\/([^/?]+)$/.exec(p);
      if (m && method === "GET") {
        const s = statuses[decodeURIComponent(m[1])];
        if (!s) throw Object.assign(new Error(`GHL GET ${p} -> 404`), { status: 404 });
        return { message: { id: m[1], ...s } };
      }
      return {};
    },
  };
}
const BLOCKED = { status: "failed", error: "Error 30007: Message blocked due to carrier policies" };
const OK = { status: "delivered" };
const SLACK = { slackBotToken: "xoxb-test", slack: { enabled: true, mattUserId: "U0MATT123", streams: { needsMatt: true }, channels: { needsMatt: "C0NEEDSMAT" } } };

const sentText = (L, i, kind, over = {}) => store.createReplyDraft({
  locationId: L, contactId: `${L}-c${i}`, contactName: "Pat Lindqvist", status: "sent", channel: "sms", party: "lot_owner", inbound: "",
  reply: "Hi Pat, a quick question about the lot on Larch.", autoSent: true, outbound: { kind }, ghlMessageId: `${L}-m${i}`, ...over,
});
const queued = (L, i, kind, over = {}) => store.createReplyDraft({
  locationId: L, contactId: `${L}-q${i}`, contactName: "Pat Lindqvist", status: "scheduled", channel: "sms", party: "lot_owner", inbound: "",
  reply: "Hi Pat, a quick question about the lot on Larch.", autoSent: false, outbound: { kind }, flags: [], sendAt: minsOn(30 + i), ...over,
});

/* ---------- the store's read ---------- */

const placeholders = (text) => [...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));

test("one kind's sends are listed the same by the file store and Postgres, without answers or emails", async () => {
  const L = "loc-store";
  const rows = [
    { id: "ls-old", sentAt: minsAgo(60 * 24 * 20) },
    { id: "ls-a", sentAt: minsAgo(90) },
    { id: "ls-b", sentAt: minsAgo(30) },
    { id: "ls-reply", sentAt: minsAgo(40), inbound: "who is this?" },
    { id: "ls-email", sentAt: minsAgo(50), channel: "email" },
    { id: "ls-other", sentAt: minsAgo(45), outbound: { kind: "agent_pulse" } },
  ];
  for (const [i, r] of rows.entries()) await sentText(L, i, "lot_owner_open", r);
  const since = minsAgo(60 * 24 * 14);
  assert.deepEqual((await store.listLaneSends(L, "lot_owner_open", { sinceIso: since, order: "desc", limit: 50 })).map((d) => d.id), ["ls-b", "ls-a"]);
  const asc = await store.listLaneSends(L, "lot_owner_open", { sinceIso: since, order: "asc", limit: 1 });
  assert.deepEqual(asc.map((d) => d.id), ["ls-a"], "oldest first, and the limit holds");
  assert.deepEqual(Object.keys(asc[0]).sort(), ["autoSent", "channel", "contactId", "delivery", "ghlMessageId", "id", "kind", "laneRead", "sentAt"], "trimmed to how it went, no words");
  assert.equal(laneSendInWindow({ ...rows[1], locationId: L, status: "sent", outbound: { kind: "lot_owner_open" } }, { locationId: L, kind: "lot_owner_open", sinceIso: since }), true);
  const q = laneSendsQuery({ locationId: L, kind: "lot_owner_open", sinceIso: since, order: "asc", limit: 20 });
  assert.deepEqual([...new Set(placeholders(q.text))].sort((a, b) => a - b), q.params.map((_, i) => i + 1), "every value bound, nothing inlined");
  assert.match(q.text, /status = 'sent'/);
  assert.match(q.text, /\(doc #>> '\{outbound,kind\}'\) = \$2/);
  assert.match(q.text, /btrim\(doc->>'inbound'\)/);
  assert.match(q.text, /order by \(doc->>'sentAt'\) asc limit \$4/);
  const u = updateReplyDraftIfQuery({ id: "x", from: "scheduled", doc: { status: "draft" }, at: minsAgo(0) });
  assert.match(u.text, /where id = \$1 and status = \$2/);
  // The file store's conditional write.
  const d = await queued(L, 1, "lot_owner_open");
  assert.equal(await store.updateReplyDraftIf(d.id, "draft", { ...d, status: "dismissed" }), false, "not written: it isn't a draft");
  assert.equal((await store.getReplyDraft(d.id)).status, "scheduled");
});

/* ---------- the runner ---------- */

test("a text GHL only says it handed to the carrier is read again next run, not taken as arrived", async () => {
  const L = "loc-handed";
  const d = await sentText(L, 1, "outreach_open", { sentAt: minsAgo(20) });
  const r = await runLaneBreaker({ client: ghlStub({ [`${L}-m1`]: { status: "sent" } }), locationId: L, saved: {}, store, now: NOW, pace: 0 });
  assert.equal(r.reads, 1);
  assert.equal((await store.getReplyDraft(d.id)).laneRead, undefined, "no verdict yet");
  const r2 = await runLaneBreaker({ client: ghlStub({ [`${L}-m1`]: BLOCKED }), locationId: L, saved: {}, store, now: NOW + 15 * 60000, pace: 0 });
  assert.equal(r2.kinds.outreach_open.early.blocked, 1, "the block the carrier sent later is counted");
});

test("a lane whose first twenty owner texts are carrier-blocked holds the rest of the day's texts", async () => {
  const L = "loc-owners";
  const statuses = {};
  for (let i = 0; i < 8; i++) {
    await sentText(L, i, "lot_owner_open", { sentAt: minsAgo(60 - i * 5) });
    statuses[`${L}-m${i}`] = i % 2 === 0 ? BLOCKED : OK;
  }
  const rest = [];
  for (let i = 0; i < 30; i++) rest.push(await queued(L, i, "lot_owner_open"));
  const reply = await queued(L, 90, "lot_owner_open", { inbound: "what lot?" });
  const pulse = await queued(L, 91, "agent_pulse", { party: "agent" });
  const ghl = ghlStub(statuses);
  const posts = [];
  const r = await runLaneBreaker({ client: ghl, locationId: L, saved: SLACK, store, now: NOW, pace: 0, deps: { slackApi: async (...a) => { posts.push(a); return { ok: true }; } } });

  assert.deepEqual(r.tripped, [{ kind: "lot_owner_open", rule: "early_blocked" }]);
  assert.equal(r.held.lot_owner_open, 30, "every queued owner first text went back to drafts");
  assert.equal(r.reads, 8, "today's sends were read from GHL, not left for the 2-hour check");
  for (const d of rest) {
    const h = await store.getReplyDraft(d.id);
    assert.equal(h.status, "draft");
    assert.equal(h.sendAt, null);
    assert.equal(h.laneHold.kind, "lot_owner_open");
    assert.match(h.flags.at(-1), /^held: the lane breaker stopped lot owner first texts — 4 of the first 8 lot owner first texts today were blocked by the carrier \(30007\)/);
  }
  assert.equal((await store.getReplyDraft(reply.id)).status, "scheduled", "an answer to their own text is never held");
  assert.equal((await store.getReplyDraft(pulse.id)).status, "scheduled", "another lane keeps going");
  // The read went on the draft beside the delivery check's field, not in it.
  const first = (await store.listLaneSends(L, "lot_owner_open", { sinceIso: minsAgo(600), order: "asc", limit: 1 }))[0];
  assert.equal(first.laneRead.code, "30007");
  assert.equal(first.delivery, null, "the delivery check still reads it and does its own work");

  const cur = (await store.getJobCursor(L, CURSOR_NAME)).doc;
  assert.equal(cur.trips.lot_owner_open.rule, "early_blocked");
  assert.equal(cur.trips.lot_owner_open.held, 30);
  assert.equal(posts.length, 1, "one Slack line");
  const text = posts[0][2].text;
  assert.equal(posts[0][2].channel, "C0NEEDSMAT");
  assert.match(text, /^<@U0MATT123> Lane breaker: lot owner first texts are stopped\. 4 of the first 8/);
  assert.match(text, /30 queued texts went back to drafts/);
  assert.doesNotMatch(text, /Pat|Lindqvist|Larch/, "no one's name or street");

  // The next run: nothing new to say, and a text scheduled since is held too.
  const late = await queued(L, 50, "lot_owner_open");
  const r2 = await runLaneBreaker({ client: ghl, locationId: L, saved: SLACK, store, now: NOW + 15 * 60000, pace: 0, deps: { slackApi: async (...a) => { posts.push(a); return { ok: true }; } } });
  assert.deepEqual(r2.tripped, []);
  assert.equal(r2.held.lot_owner_open, 1);
  assert.equal((await store.getReplyDraft(late.id)).status, "draft");
  assert.equal(posts.length, 1, "still one Slack line");
  assert.equal(ghl.sends().length, 0);
});

test("a STOP spike on day-two nudges holds the nudges, not the replies", async () => {
  const L = "loc-nudges";
  const statuses = {};
  for (let i = 0; i < 20; i++) {
    // Yesterday's first text, today's nudge, same agent.
    await sentText(L, `o${i}`, "outreach_open", { contactId: `${L}-a${i}`, party: "agent", sentAt: minsAgo(60 * 26 + i), ghlMessageId: `${L}-mo${i}`, delivery: { status: "delivered", code: null } });
    await sentText(L, `n${i}`, "outreach_nudge", { contactId: `${L}-a${i}`, party: "agent", sentAt: minsAgo(180 - i * 5), ghlMessageId: `${L}-mn${i}` });
    statuses[`${L}-mn${i}`] = OK;
  }
  for (const i of [1, 4, 7, 12]) {
    await recordEvent({ store, locationId: L, contactId: `${L}-a${i}`, party: "agent", type: "unsubscribed", at: minsAgo(30), address: "", source: "conversation", dedupeKey: `unsubscribed:${L}-a${i}`, data: { via: "sms_keyword", channel: "sms" } });
  }
  const nudge = await queued(L, 1, "outreach_nudge", { party: "agent" });
  const opener = await queued(L, 2, "outreach_open", { party: "agent" });
  const answer = await queued(L, 3, "", { party: "agent", outbound: null, inbound: "is this still available?" });
  const r = await runLaneBreaker({ client: ghlStub(statuses), locationId: L, saved: {}, store, now: NOW, pace: 0 });
  assert.deepEqual(r.tripped, [{ kind: "outreach_nudge", rule: "early_stops" }], JSON.stringify(r.kinds.outreach_nudge));
  assert.equal(r.kinds.outreach_open.rolling.stops, 0, "the STOPs after the nudge aren't the first text's");
  assert.equal((await store.getReplyDraft(nudge.id)).status, "draft");
  assert.equal((await store.getReplyDraft(opener.id)).status, "scheduled");
  assert.equal((await store.getReplyDraft(answer.id)).status, "scheduled");
});

test("the breaker never sends anything, and the send loop holds a stopped kind instead of sending it", async () => {
  const L = "loc-never";
  for (let i = 0; i < 6; i++) await sentText(L, i, "buyer_pulse", { party: "investor", sentAt: minsAgo(40 + i) });
  const statuses = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`${L}-m${i}`, i < 4 ? BLOCKED : OK]));
  const ghl = ghlStub(statuses);
  const r = await runLaneBreaker({ client: ghl, locationId: L, saved: {}, store, now: NOW, pace: 0 });
  assert.equal(r.tripped[0]?.kind, "buyer_pulse");
  assert.equal(ghl.sends().length, 0);
  assert.ok(ghl.calls.every((c) => c.method === "GET"), "it only reads GHL");

  // Scheduled after the run, now due: the send loop turns it back into a draft.
  const due = await queued(L, 1, "buyer_pulse", { party: "investor", sendAt: minsAgo(1) });
  const answer = await queued(L, 2, "buyer_pulse", { party: "investor", sendAt: minsAgo(1), inbound: "what's the price?" });
  const sent = [];
  const out = await sendDueDrafts({
    store, locations: [{ locationId: L, client: ghl }], live: true, now: NOW, paceMs: 0,
    send: async ({ draftId }) => { sent.push(draftId); const d = await store.getReplyDraft(draftId); await store.updateReplyDraft(draftId, { ...d, status: "sent", sentAt: minsAgo(0) }); return { ok: true }; },
    heldKindsFor: (loc) => laneHoldsFor({ store, locationId: loc, saved: {} }),
  });
  assert.equal(out.laneHeld, 1);
  assert.deepEqual(sent, [answer.id], "only the answer to their own text went");
  const h = await store.getReplyDraft(due.id);
  assert.equal(h.status, "draft");
  assert.match(h.flags.at(-1), /lane breaker stopped buyer check-ins/);

  // Switched off, the breaker holds nothing.
  assert.equal((await laneHoldsFor({ store, locationId: L, saved: { conversationAi: { laneBreaker: { enabled: false } } } })).size, 0);
});

test("a lane stays stopped until Matt clears it, and clearing sends nothing and judges it afresh", async () => {
  const L = "loc-clear";
  for (let i = 0; i < 5; i++) await sentText(L, i, "agent_pulse", { party: "agent", sentAt: minsAgo(50 + i) });
  const statuses = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`${L}-m${i}`, BLOCKED]));
  const ghl = ghlStub(statuses);
  const q = await queued(L, 1, "agent_pulse", { party: "agent" });
  await runLaneBreaker({ client: ghl, locationId: L, saved: {}, store, now: NOW, pace: 0 });
  assert.equal((await store.getReplyDraft(q.id)).status, "draft");
  const st = await laneBreakerStatus({ store, locationId: L, saved: {} });
  assert.deepEqual(st.trips.map((t) => [t.kind, t.label, t.held]), [["agent_pulse", "agent check-ins", 1]]);

  const c = await clearLane({ store, locationId: L, kind: "agent_pulse", now: NOW + 60000 });
  assert.deepEqual(c, { cleared: true, kind: "agent_pulse", released: 1 });
  const after = await store.getReplyDraft(q.id);
  assert.equal(after.status, "draft", "still a draft: clearing schedules nothing");
  assert.equal(after.laneHold, undefined);
  assert.ok(!after.flags.some((f) => /lane breaker/.test(f)), "the breaker's flag is off");
  assert.equal((await laneHoldsFor({ store, locationId: L, saved: {} })).size, 0);

  // The sends that tripped it no longer count: the next run leaves it open.
  const r = await runLaneBreaker({ client: ghl, locationId: L, saved: {}, store, now: NOW + 16 * 60000, pace: 0 });
  assert.deepEqual(r.tripped, []);
  assert.equal(ghl.sends().length, 0);
  const doc = (await store.getJobCursor(L, CURSOR_NAME)).doc;
  assert.equal(doc.history[0].kind, "agent_pulse", "the trip is kept for the record");
});

test("switched off, the breaker reads nothing and holds nothing", async () => {
  const L = "loc-off";
  for (let i = 0; i < 5; i++) await sentText(L, i, "outreach_open", { sentAt: minsAgo(30 + i) });
  const ghl = ghlStub(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`${L}-m${i}`, BLOCKED])));
  const q = await queued(L, 1, "outreach_open");
  const saved = { conversationAi: { laneBreaker: { enabled: false } } };
  assert.equal(await maybeRunLaneBreaker({ client: ghl, locationId: L, saved, store, now: NOW, pace: 0 }), null);
  const r = await runLaneBreaker({ client: ghl, locationId: L, saved, store, now: NOW, pace: 0 });
  assert.equal(r.off, true);
  assert.equal(ghl.calls.length, 0);
  assert.equal((await store.getReplyDraft(q.id)).status, "scheduled");
});

test("the tick writes the cursor before the run and doesn't run twice in fifteen minutes", async () => {
  _resetLaneBreaker();
  const L = "loc-tick";
  const ghl = ghlStub({});
  const go = await maybeRunLaneBreaker({ client: ghl, locationId: L, saved: {}, store, now: NOW, pace: 0 });
  assert.equal(go.started, true);
  assert.equal(go.tries, 1);
  await go.done;
  const doc = (await store.getJobCursor(L, CURSOR_NAME)).doc;
  assert.equal(doc.run, null);
  assert.equal(doc.lastRun, minsAgo(0));
  assert.ok(doc.last.finishedAt);
  assert.equal(await maybeRunLaneBreaker({ client: ghl, locationId: L, saved: {}, store, now: NOW + 5 * 60000, pace: 0 }), null);
  const again = await maybeRunLaneBreaker({ client: ghl, locationId: L, saved: {}, store, now: NOW + 15 * 60000, pace: 0 });
  assert.equal(again.tries, 2);
  await again.done;
});

/* ---------- the route ---------- */

test("the Offers strip lists a stopped lane and Matt's click clears it without sending", async () => {
  const L = "loc-route";
  for (let i = 0; i < 4; i++) await sentText(L, i, "lot_owner_follow", { sentAt: minsAgo(30 + i) });
  const ghl = ghlStub(Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`${L}-m${i}`, BLOCKED])));
  await runLaneBreaker({ client: ghl, locationId: L, saved: {}, store, now: NOW, pace: 0 });

  const app = express();
  app.use(express.json());
  app.use("/api/lane-breaker", createLaneBreakerRouter({ resolveLocation: () => ({ locationId: L, client: ghl }), getSettings: async () => ({}) }));
  const server = app.listen(0);
  const B = `http://127.0.0.1:${server.address().port}`;
  try {
    const s = await (await fetch(`${B}/api/lane-breaker`)).json();
    assert.equal(s.enabled, true);
    assert.deepEqual(s.trips.map((t) => t.kind), ["lot_owner_follow"]);
    assert.match(s.trips[0].why, /blocked by the carrier/);
    const bad = await fetch(`${B}/api/lane-breaker/clear`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "anything" }) });
    assert.equal(bad.status, 400);
    const ok = await (await fetch(`${B}/api/lane-breaker/clear`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "lot_owner_follow" }) })).json();
    assert.equal(ok.ok, true);
    assert.equal(ok.cleared, true);
    assert.deepEqual((await (await fetch(`${B}/api/lane-breaker`)).json()).trips, []);
    assert.equal(ghl.sends().length, 0);
  } finally { server.close(); }
});
