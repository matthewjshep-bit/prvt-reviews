import test from "node:test";
import assert from "node:assert/strict";
import { pickDelayMs, nextSendTime, zonedParts, sendDueDrafts, STUCK_SENDING_MS } from "./conversation-scheduler.js";

const CFG = { autoSend: { delayMinSec: 120, delayMaxSec: 240 } };
const QH = { start: "08:00", end: "20:00", timeZone: "America/Los_Angeles" };
// 2026-09-04 is PDT (UTC-7). 17:30Z = 10:30 local.
const T = (iso) => Date.parse(iso);

test("the delay lands inside the band, on either edge", () => {
  assert.equal(pickDelayMs(CFG, () => 0), 120_000);
  assert.equal(pickDelayMs(CFG, () => 1), 240_000);
  assert.equal(pickDelayMs(CFG, () => 0.5), 180_000);
  assert.equal(pickDelayMs({ autoSend: { delayMinSec: 300, delayMaxSec: 60 } }, () => 1), 300_000, "max never below min");
});

test("inside the window, it's just now plus the delay", () => {
  const now = T("2026-09-04T17:30:00Z");
  assert.equal(nextSendTime({ now, delayMs: 180_000, quietHours: QH }), "2026-09-04T17:33:00.000Z");
});

test("before the window opens, it waits for the opening — plus the delay", () => {
  const now = T("2026-09-04T12:00:00Z");   // 05:00 local
  assert.equal(nextSendTime({ now, delayMs: 180_000, quietHours: QH }), "2026-09-04T15:03:00.000Z");
});

test("after the window closes, it's tomorrow morning", () => {
  const now = T("2026-09-05T04:30:00Z");   // 21:30 local on the 4th
  assert.equal(nextSendTime({ now, delayMs: 120_000, quietHours: QH }), "2026-09-05T15:02:00.000Z");
});

test("a delay that crosses the close is pushed to the next opening", () => {
  const now = T("2026-09-05T02:59:00Z");   // 19:59 local
  assert.equal(nextSendTime({ now, delayMs: 180_000, quietHours: QH }), "2026-09-05T15:03:00.000Z");
});

test("no window at all when start equals end, and an overnight window works", () => {
  const now = T("2026-09-05T04:30:00Z");
  assert.equal(nextSendTime({ now, delayMs: 60_000, quietHours: { ...QH, start: "00:00", end: "00:00" } }), "2026-09-05T04:31:00.000Z");
  // 20:00–08:00: 21:30 local is inside
  assert.equal(nextSendTime({ now, delayMs: 60_000, quietHours: { ...QH, start: "20:00", end: "08:00" } }), "2026-09-05T04:31:00.000Z");
  // 10:30 local is outside an overnight window → tonight at 20:00
  assert.equal(nextSendTime({ now: T("2026-09-04T17:30:00Z"), delayMs: 60_000, quietHours: { ...QH, start: "20:00", end: "08:00" } }), "2026-09-05T03:01:00.000Z");
});

test("zoned parts read the wall clock in the zone", () => {
  const p = zonedParts(T("2026-09-04T17:30:00Z"), "America/Los_Angeles");
  assert.deepEqual([p.y, p.m, p.d, p.hh, p.mm], [2026, 9, 4, 10, 30]);
});

/* ---------- the ticker ---------- */

const fakeStore = (drafts) => {
  const rows = new Map(drafts.map((d) => [d.id, d]));
  return {
    rows,
    listReplyDrafts: async (_loc, { status } = {}) => [...rows.values()].filter((d) => d.status === status),
    getReplyDraft: async (id) => rows.get(id) || null,
    updateReplyDraft: async (id, doc) => { rows.set(id, doc); return true; },
  };
};
const now = T("2026-09-04T17:30:00Z");
const draft = (over) => ({ id: "d1", locationId: "LOC", status: "scheduled", sendAt: "2026-09-04T17:29:00Z", flags: [], intent: "question", ...over });

test("due drafts are claimed and sent; future ones wait", async () => {
  const store = fakeStore([draft(), draft({ id: "d2", sendAt: "2026-09-04T18:00:00Z" })]);
  const sent = [];
  const r = await sendDueDrafts({
    store, locations: [{ locationId: "LOC", client: {} }], live: true, now,
    send: async (args) => { sent.push(args); store.rows.set(args.draftId, { ...store.rows.get(args.draftId), status: "sent" }); },
  });
  assert.equal(r.sent, 1);
  assert.equal(sent[0].draftId, "d1");
  assert.equal(sent[0].auto, true);
  assert.equal(sent[0].live, true);
  assert.equal(store.rows.get("d2").status, "scheduled");
});

test("a failed send goes back to the outbox with the reason, and is not retried by the next tick", async () => {
  const store = fakeStore([draft()]);
  let calls = 0;
  const send = async () => { calls++; throw new Error("GHL 500"); };
  await sendDueDrafts({ store, locations: [{ locationId: "LOC", client: {} }], live: true, now, send });
  const d = store.rows.get("d1");
  assert.equal(d.status, "draft");
  assert.equal(d.sendAt, null);
  assert.match(d.flags.join(" · "), /auto-send failed: GHL 500/);
  await sendDueDrafts({ store, locations: [{ locationId: "LOC", client: {} }], live: true, now: now + 60_000, send });
  assert.equal(calls, 1);
});

test("a draft stuck in sending is handed back to a person after five minutes", async () => {
  const store = fakeStore([
    draft({ status: "sending", sendingAt: new Date(now - STUCK_SENDING_MS - 1000).toISOString() }),
    draft({ id: "d2", status: "sending", sendingAt: new Date(now - 10_000).toISOString() }),
  ]);
  const r = await sendDueDrafts({ store, locations: [{ locationId: "LOC", client: {} }], live: true, now, send: async () => {} });
  assert.equal(r.recovered, 1);
  assert.equal(store.rows.get("d1").status, "draft");
  assert.match(store.rows.get("d1").flags[0], /interrupted/);
  assert.equal(store.rows.get("d2").status, "sending", "a send that started ten seconds ago is left alone");
});

test("with sends off on the broker nothing goes out, and the countdown doesn't lie", async () => {
  const store = fakeStore([draft()]);
  let calls = 0;
  const r = await sendDueDrafts({ store, locations: [{ locationId: "LOC", client: {} }], live: false, now, send: async () => { calls++; } });
  assert.equal(calls, 0);
  assert.equal(r.returned, 1);
  assert.equal(store.rows.get("d1").status, "draft");
  assert.match(store.rows.get("d1").flags[0], /CARD_SENDS_ENABLED/);
});
