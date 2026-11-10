import test from "node:test";
import assert from "node:assert/strict";
import { spreadAcrossDay, isWeekend, pickDelayMs, nextSendTime, zonedParts, sendDueDrafts, STUCK_SENDING_MS, machineHours, MACHINE_BURST } from "./conversation-scheduler.js";
import { weekdayIn } from "./conversation-scheduler.js";
import { scheduleFor } from "./reply-agent.js";
import { normalizeConversationAi as normalizeAi } from "./shared/conversation-ai.js";

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

test("a switched-off bot never sends what was already counting down", async () => {
  const store = fakeStore([draft(), draft({ id: "d2", sendAt: "2026-09-04T19:00:00Z" })]);
  let calls = 0;
  const r = await sendDueDrafts({
    store, locations: [{ locationId: "LOC", client: {} }], live: true, now,
    send: async () => { calls++; }, enabledFor: async () => false,
  });
  assert.equal(calls, 0);
  assert.equal(r.returned, 1, "the due one is handed back");
  assert.equal(store.rows.get("d1").status, "draft");
  assert.equal(store.rows.get("d1").sendAt, null);
  assert.match(store.rows.get("d1").flags.join(" · "), /switched off/);
  assert.equal(store.rows.get("d2").status, "scheduled", "one that isn't due yet is left alone");
});

test("the enabled check costs nothing when there is nothing due", async () => {
  const store = fakeStore([draft({ sendAt: "2026-09-04T19:00:00Z" })]);
  let asked = 0;
  await sendDueDrafts({
    store, locations: [{ locationId: "LOC", client: {} }], live: true, now,
    send: async () => {}, enabledFor: async () => { asked++; return true; },
  });
  assert.equal(asked, 0, "no settings read on an idle tick");
});

/* ---------- human texture ---------- */

test("the delay follows the intent: quick things fast, slow things slow, and never faster than typing", () => {
  const config = { autoSend: { delayMinSec: 120, delayMaxSec: 240, quick: { minSec: 45, maxSec: 180 }, slow: { minSec: 600, maxSec: 2400 } } };
  const lo = () => 0, hi = () => 1;
  assert.equal(pickDelayMs(config, lo, { intent: "question" }), 45000);
  assert.equal(pickDelayMs(config, hi, { intent: "question" }), 180000);
  assert.equal(pickDelayMs(config, lo, { intent: "counter" }), 600000);
  assert.equal(pickDelayMs(config, lo, { intent: "other" }), 120000, "unknown intents keep the default band");
  assert.equal(pickDelayMs(config, lo, { intent: "question", replyLength: 400 }), 100000, "400 chars at 4/sec is 100s, over the 45s floor");
  assert.equal(pickDelayMs(config, lo), 120000, "the old call shape still works");
});

test("what the machine starts is spread across the day and skips the weekend unless allowed", () => {
  const quietHours = { start: "08:00", end: "20:00", timeZone: "America/Los_Angeles" };
  const fri = T("2026-09-11T16:00:00Z");   // Fri 9am PT
  const sat = T("2026-09-12T16:00:00Z");   // Sat 9am PT
  assert.equal(isWeekend(sat, "America/Los_Angeles"), true);
  assert.equal(isWeekend(fri, "America/Los_Angeles"), false);
  // inside the window on a weekday: somewhere in the next N hours
  const a = Date.parse(spreadAcrossDay({ now: fri, quietHours, hours: 8, random: () => 0.5 }));
  assert.ok(a > fri && a < fri + 8 * 3600000, new Date(a).toISOString());
  // saturday, replies only: rolls to monday's opening window
  const mon = Date.parse(spreadAcrossDay({ now: sat, quietHours, hours: 8, random: () => 0, weekends: "replies_only" }));
  assert.equal(new Date(mon).toISOString(), "2026-09-14T15:00:00.000Z", "Mon 8am PT");
  // saturday, allowed: today
  const today = Date.parse(spreadAcrossDay({ now: sat, quietHours, hours: 8, random: () => 0, weekends: "all" }));
  assert.equal(new Date(today).toISOString(), new Date(sat).toISOString());
  // before the window opens: from the opening, not from now
  const early = T("2026-09-11T12:00:00Z"); // Fri 5am PT
  const e = Date.parse(spreadAcrossDay({ now: early, quietHours, hours: 8, random: () => 0 }));
  assert.equal(new Date(e).toISOString(), "2026-09-11T15:00:00.000Z");
});

test("the ticker paces its sends and stops at the per-tick cap", async () => {
  const rows = Array.from({ length: 5 }, (_, i) => draft({ id: `p${i}` }));
  const store = fakeStore(rows);
  const sent = [];
  const r = await sendDueDrafts({
    store, locations: [{ locationId: "LOC", client: {} }], live: true, now, maxPerTick: 3, paceMs: 0,
    send: async (args) => { sent.push(args.draftId); store.rows.set(args.draftId, { ...store.rows.get(args.draftId), status: "sent" }); },
  });
  assert.equal(r.sent, 3);
  assert.equal(r.deferred, 2, "the rest wait for the next tick");
  assert.equal([...store.rows.values()].filter((d) => d.status === "scheduled").length, 2);
});

// 2026-10-22 audit: three check-ins from 10/19 and a reply sat "held — waiting
// on you" for days because GHL answered 429 at the 9am rush. Nothing went, so
// it goes again; a 500 or a timeout may have sent it, so that still waits.
test("a check-in GHL refused with 429 goes again, and comes back to a person after the last try", async () => {
  const store = fakeStore([draft()]);
  let calls = 0;
  const send = async () => { calls++; throw Object.assign(new Error('GHL POST /conversations/messages -> 429 {"statusCode":429,"message":"Too Many Requests"}'), { status: 429 }); };
  const tick = (t) => sendDueDrafts({ store, locations: [{ locationId: "LOC", client: {} }], live: true, now: t, send });
  const r = await tick(now);
  let d = store.rows.get("d1");
  assert.equal(r.retried, 1);
  assert.equal(r.failed, 0);
  assert.equal(d.status, "scheduled");
  assert.equal(d.sendAt, new Date(now + 10 * 60000).toISOString());
  assert.doesNotMatch(d.flags.join(" · "), /auto-send failed/);
  let t = now;
  for (const wait of [10, 30, 60]) { t += wait * 60000 + 1000; await tick(t); }
  d = store.rows.get("d1");
  assert.equal(calls, 4);
  assert.equal(d.status, "draft");
  assert.match(d.flags.join(" · "), /auto-send failed: GHL POST \/conversations\/messages -> 429/);
});

test("a 500 from GHL may have sent it, so it comes back to a person and is never retried", async () => {
  const store = fakeStore([draft()]);
  const send = async () => { throw new Error("GHL POST /conversations/messages -> 500 upstream"); };
  const r = await sendDueDrafts({ store, locations: [{ locationId: "LOC", client: {} }], live: true, now, send });
  assert.equal(r.retried, undefined);
  assert.equal(store.rows.get("d1").status, "draft");
});

// 2026-09-16: GHL's own refusal — "Cannot send message as +1… has
// unsubscribed" — is not a chore for a person; nobody can send that text.
test("a send GHL refuses as unsubscribed is dismissed, not handed back as 'Needs you'", async () => {
  const store = fakeStore([draft()]);
  const send = async () => { throw new Error('GHL POST /conversations/messages -> 400 {"message":"Cannot send message as +14255907078 has unsubscribed"}'); };
  const r = await sendDueDrafts({ store, locations: [{ locationId: "LOC", client: {} }], live: true, now, send });
  const d = store.rows.get("d1");
  assert.equal(d.status, "dismissed");
  assert.equal(r.failed, 0);
  assert.equal(r.unsubscribed, 1);
  assert.match(d.flags.join(" · "), /unsubscribed — not sent/);
  assert.doesNotMatch(d.flags.join(" · "), /auto-send failed/);
});

// Two deals for one buyer go as one text (2026-10-05): sending the first
// stands the second down. The tick listed both at its top, and claiming the
// stale copy of the second would have sent it anyway.
test("a text another send took with it in the same tick is not sent again", async () => {
  const store = fakeStore([draft(), draft({ id: "d2" })]);
  const sent = [];
  await sendDueDrafts({
    store, locations: [{ locationId: "LOC", client: {} }], live: true, now, paceMs: 0,
    send: async (args) => {
      sent.push(args.draftId);
      store.rows.set(args.draftId, { ...store.rows.get(args.draftId), status: "sent" });
      if (args.draftId === "d1") store.rows.set("d2", { ...store.rows.get("d2"), status: "superseded", combinedInto: "d1" });
    },
  });
  assert.deepEqual(sent, ["d1"]);
  assert.equal(store.rows.get("d2").status, "superseded");
});

// Deal texts can now wait days for a buyer's week. Fifty of them created
// after a reply that is due now must not hide it: the scheduler asks the
// store for what's due, longest-due first.
test("a reply due now goes even behind fifty newer deal texts waiting for next week", async () => {
  const rows = [draft({ id: "due", sendAt: "2026-09-04T17:00:00Z", createdAt: "2026-09-01T00:00:00Z" })];
  for (let i = 0; i < 60; i++) rows.push(draft({ id: `wait${i}`, sendAt: "2026-09-09T16:00:00Z", createdAt: `2026-09-03T00:${String(i).padStart(2, "0")}:00Z`, intent: "blast_open" }));
  const store = fakeStore(rows);
  let asked = null;
  store.listReplyDrafts = async (_loc, opts = {}) => {
    if (opts.status === "scheduled") asked = opts;
    // The real store's order: newest-created first, unless asked for what's due.
    return [...store.rows.values()].filter((d) => d.status === opts.status)
      .filter((d) => !opts.dueBy || d.sendAt <= opts.dueBy)
      .sort(opts.dueBy ? (a, b) => a.sendAt.localeCompare(b.sendAt) : (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, opts.limit ?? 100);
  };
  const sent = [];
  await sendDueDrafts({ store, locations: [{ locationId: "LOC", client: {} }], live: true, now, paceMs: 0,
    send: async (args) => { sent.push(args.draftId); store.rows.set(args.draftId, { ...store.rows.get(args.draftId), status: "sent" }); } });
  assert.ok(asked?.dueBy, "asked for what's due");
  assert.deepEqual(sent, ["due"]);
});

/* ---------- the machine's own texts stop at 5pm (Matt, 2026-10-05) ---------- */

// Check-ins went out at 7 and 8pm: "can we pls not send outreach texts
// after 5pm… feel like it hurts our chances". Replies keep the full window.
const PT = { start: "08:00", end: "21:00", timeZone: "America/Los_Angeles" };
const pacificHour = (iso) => zonedParts(Date.parse(iso), "America/Los_Angeles");

test("texts the machine starts run 8am to 5pm; the window for replies is untouched", () => {
  assert.deepEqual(machineHours({ quietHours: PT, machineUntil: "17:00" }), { ...PT, end: "17:00" });
  assert.deepEqual(machineHours({ quietHours: { ...PT, end: "16:00" }, machineUntil: "17:00" }), { ...PT, end: "16:00" }, "an earlier close wins");
  assert.deepEqual(machineHours({ quietHours: PT }), PT, "no cutoff set: the window as it is");
});

test("a noon sweep spread over eight hours lands before 5pm today, not in a burst at 8am tomorrow", () => {
  const noon = T("2026-10-06T19:00:00Z");   // Tuesday, noon Pacific
  const win = machineHours({ quietHours: PT, machineUntil: "17:00" });
  for (const r of [0, 0.5, 0.99]) {
    const at = spreadAcrossDay({ now: noon, quietHours: win, hours: 8, random: () => r });
    const p = pacificHour(at);
    assert.equal(p.d, 6, `${at} stays today`);
    assert.ok(p.hh >= 12 && p.hh < 17, `${at} is ${p.hh}:${String(p.mm).padStart(2, "0")} Pacific`);
  }
});

test("a text the machine started that comes due after 5pm waits for tomorrow's window; a reply still goes", async () => {
  const seven = T("2026-10-06T02:00:00Z");   // Monday 7pm Pacific
  const due = new Date(seven - 1000).toISOString();
  const store = fakeStore([
    draft({ id: "m1", sendAt: due, intent: "agent_pulse", outbound: { kind: "agent_pulse" }, inbound: "" }),
    draft({ id: "r1", sendAt: due, inbound: "Is it still available?" }),
  ]);
  const sent = [];
  const r = await sendDueDrafts({
    store, locations: [{ locationId: "LOC", client: {} }], live: true, now: seven, paceMs: 0, random: () => 0.5,
    send: async (args) => { sent.push(args.draftId); store.rows.set(args.draftId, { ...store.rows.get(args.draftId), status: "sent" }); },
    windowFor: async () => ({ quietHours: PT, machineUntil: "17:00", nudgeSpreadHours: 8, weekends: "all" }),
  });
  assert.deepEqual(sent, ["r1"], "the reply to their text goes");
  const m = store.rows.get("m1");
  assert.equal(m.status, "scheduled");
  const p = pacificHour(m.sendAt);
  assert.ok(p.d === 6 && p.hh >= 8 && p.hh < 17, `moved to ${m.sendAt}`);
  assert.equal(r.afterHours, 1);
});

test("a pile of machine texts due at the same minute goes a few at a time; the rest spread across the day", async () => {
  // 2026-10-06: ~80 check-ins rolled onto 8:00:00 sharp.
  const eight = T("2026-10-06T15:00:00Z");   // Tuesday 8am Pacific
  const pile = Array.from({ length: 12 }, (_, i) => draft({ id: `c${i}`, sendAt: "2026-10-06T15:00:00.000Z", intent: "agent_pulse", outbound: { kind: "agent_pulse" }, inbound: "" }));
  const store = fakeStore([...pile, draft({ id: "r1", sendAt: "2026-10-06T15:00:00.000Z", inbound: "Still interested?" })]);
  const sent = [];
  const r = await sendDueDrafts({
    store, locations: [{ locationId: "LOC", client: {} }], live: true, now: eight, paceMs: 0, random: () => 0.5,
    send: async (args) => { sent.push(args.draftId); store.rows.set(args.draftId, { ...store.rows.get(args.draftId), status: "sent" }); },
    windowFor: async () => ({ quietHours: PT, machineUntil: "17:00", nudgeSpreadHours: 8, weekends: "all" }),
  });
  assert.equal(sent.filter((id) => id.startsWith("c")).length, MACHINE_BURST);
  assert.ok(sent.includes("r1"), "a reply is never held back");
  assert.equal(r.respread, 12 - MACHINE_BURST);
  for (const d of [...store.rows.values()].filter((d) => d.status === "scheduled")) {
    const p = pacificHour(d.sendAt);
    assert.ok(Date.parse(d.sendAt) > eight && p.d === 6 && p.hh < 17, `${d.id} → ${d.sendAt}`);
  }
});

/* ---------- weekends and days off (2026-11) ---------- */

// Texts the machine started on its own (pass notes, address chases, "still
// working the numbers") went to agents on two weekends, many at 8:01am:
// scheduleFor rolled only the spread kinds past Saturday and Sunday, and the
// ticker looked at the hour, never the day. There was no list of days off.
// Answers to their own texts still go, and so does a buyer's showing text.
const offCfg = (autoSend = {}) => normalizeAi({ autoSend: { quietHours: PT, weekends: "replies_only", ...autoSend } });
const pacificDay = (at) => ({ ...pacificHour(at), wd: weekdayIn(Date.parse(at), "America/Los_Angeles") });
const FRI_7PM = T("2026-11-14T03:00:00Z");    // Friday 11/13, 7pm Pacific
const SAT_10AM = T("2026-11-14T18:00:00Z");   // Saturday 11/14
const SUN_10AM = T("2026-11-15T18:00:00Z");   // Sunday 11/15
const THU_10AM = T("2026-11-26T18:00:00Z");   // Thanksgiving, 10am Pacific
const machineRow = (id, kind, at, over = {}) => draft({ id, sendAt: new Date(at - 60000).toISOString(), intent: kind, outbound: { kind }, inbound: "", ...over });
const tickAt = async (store, now, autoSend = {}) => {
  const sent = [];
  const r = await sendDueDrafts({
    store, locations: [{ locationId: "LOC", client: {} }], live: true, now, paceMs: 0, random: () => 0.5,
    send: async (args) => { sent.push(args.draftId); store.rows.set(args.draftId, { ...store.rows.get(args.draftId), status: "sent" }); },
    windowFor: async () => offCfg(autoSend).autoSend,
  });
  return { r, sent };
};
const mondayMorning = (at, d = 16) => {
  const p = pacificDay(at);
  return p.wd === 1 && p.d === d && p.hh >= 8 && p.hh < 17;
};

test("a pass note queued Friday night goes Monday morning, not Saturday", () => {
  for (const r of [0, 0.5, 0.99]) {
    const at = scheduleFor({ config: offCfg(), now: FRI_7PM, kind: "pass_note", random: () => r });
    assert.ok(mondayMorning(at), `${at} → ${JSON.stringify(pacificDay(at))}`);
  }
});

test("an address chase due Sunday waits for Monday", async () => {
  const at = scheduleFor({ config: offCfg(), now: SUN_10AM, kind: "address_chase", random: () => 0.5 });
  assert.ok(mondayMorning(at), `scheduled ${at}`);
  const store = fakeStore([machineRow("a1", "address_chase", SUN_10AM)]);
  const { r, sent } = await tickAt(store, SUN_10AM);
  assert.deepEqual(sent, []);
  const a = store.rows.get("a1");
  assert.equal(a.status, "scheduled");
  assert.ok(mondayMorning(a.sendAt), `moved to ${a.sendAt}`);
  assert.equal(r.offDay, 1);
});

test("a machine text due on Saturday is moved to Monday", async () => {
  // Queued before the page said weekends are off, or spilled over from
  // Friday's deal wave: the ticker catches it on the day.
  const store = fakeStore([
    machineRow("p1", "promise_due", SAT_10AM),
    machineRow("b1", "blast_open", SAT_10AM, { party: "investor" }),
    machineRow("e1", "outreach_email", SAT_10AM, { channel: "email" }),
  ]);
  const { r, sent } = await tickAt(store, SAT_10AM);
  assert.deepEqual(sent, []);
  for (const id of ["p1", "b1", "e1"]) {
    const d = store.rows.get(id);
    assert.equal(d.status, "scheduled", id);
    assert.ok(mondayMorning(d.sendAt), `${id} → ${d.sendAt}`);
  }
  assert.equal(r.offDay, 3);
  // Weekends worked on the page: it goes.
  const open = fakeStore([machineRow("p2", "promise_due", SAT_10AM)]);
  assert.deepEqual((await tickAt(open, SAT_10AM, { weekends: "all" })).sent, ["p2"]);
});

test("an answer to a text they sent Saturday still goes Saturday", async () => {
  const reply = pacificDay(scheduleFor({ config: offCfg(), now: SAT_10AM, intent: "question", replyLength: 40, random: () => 0 }));
  assert.ok(reply.wd === 6 && reply.d === 14, JSON.stringify(reply));
  const answering = pacificDay(scheduleFor({ config: offCfg(), now: SAT_10AM, kind: "address_chase", answering: true, random: () => 0 }));
  assert.ok(answering.wd === 6 && answering.d === 14, JSON.stringify(answering));
  const store = fakeStore([draft({ id: "r1", sendAt: new Date(SAT_10AM - 60000).toISOString(), inbound: "Does the garage have power?" })]);
  const { sent } = await tickAt(store, SAT_10AM);
  assert.deepEqual(sent, ["r1"]);
});

test("a buyer's showing reminder still goes on Saturday", async () => {
  for (const kind of ["showing_reminder", "showing_followup"]) {
    const p = pacificDay(scheduleFor({ config: offCfg(), now: SAT_10AM, kind, random: () => 0 }));
    assert.ok(p.wd === 6 && p.d === 14, `${kind} → ${JSON.stringify(p)}`);
  }
  const store = fakeStore([machineRow("s1", "showing_reminder", SAT_10AM, { party: "investor" })]);
  const { sent } = await tickAt(store, SAT_10AM);
  assert.deepEqual(sent, ["s1"]);
});

test("nothing the machine starts goes on an off day", async () => {
  const cfg = offCfg({ offDays: ["2026-11-26"] });
  for (const kind of ["address_chase", "pass_note", "offer_nudge", "agent_pulse", "realm_check"]) {
    const p = pacificDay(scheduleFor({ config: cfg, now: THU_10AM, kind, random: () => 0.5 }));
    assert.ok(p.d === 27 && p.hh >= 8 && p.hh < 17, `${kind} → ${JSON.stringify(p)}`);
  }
  const spread = pacificDay(spreadAcrossDay({ now: THU_10AM, quietHours: machineHours(cfg.autoSend), hours: 8, random: () => 0, weekends: "replies_only", offDays: ["2026-11-26"] }));
  assert.ok(spread.d === 27 && spread.hh === 8 && spread.mm === 0, JSON.stringify(spread));
  // Even with weekends worked, a day off is off.
  const worked = pacificDay(spreadAcrossDay({ now: THU_10AM, quietHours: machineHours(cfg.autoSend), hours: 8, random: () => 0, weekends: "all", offDays: ["2026-11-26", "2026-11-27"] }));
  assert.ok(worked.d === 28 && worked.wd === 6, JSON.stringify(worked));
  // Their text on the day off is still answered that day.
  const reply = pacificDay(scheduleFor({ config: cfg, now: THU_10AM, intent: "question", replyLength: 40, random: () => 0 }));
  assert.equal(reply.d, 26);
  const store = fakeStore([
    machineRow("n1", "outreach_nudge", THU_10AM),
    draft({ id: "r1", sendAt: new Date(THU_10AM - 60000).toISOString(), inbound: "Which one was this?" }),
  ]);
  const { r, sent } = await tickAt(store, THU_10AM, { offDays: ["2026-11-26"] });
  assert.deepEqual(sent, ["r1"]);
  const n = pacificDay(store.rows.get("n1").sendAt);
  assert.ok(n.d === 27 && n.hh >= 8 && n.hh < 17, JSON.stringify(n));
  assert.equal(r.offDay, 1);
});

test("a check-in due on Thanksgiving goes the next working day", () => {
  const cfg = offCfg({ offDays: ["2026-11-26", "2026-11-27"] });
  const WED_6PM = T("2026-11-26T02:00:00Z");   // Wednesday 11/25, 6pm Pacific
  for (const kind of ["agent_pulse", "checkin_due", "buyer_pulse"]) {
    for (const r of [0, 0.5, 0.99]) {
      const at = scheduleFor({ config: cfg, now: WED_6PM, kind, random: () => r });
      assert.ok(mondayMorning(at, 30), `${kind} → ${JSON.stringify(pacificDay(at))}`);
    }
  }
});

test("with no days off saved, nothing changes", () => {
  for (const kind of ["agent_pulse", "address_chase", "showing_reminder"]) {
    for (const r of [0, 0.5, 0.99]) {
      const plain = scheduleFor({ config: offCfg(), now: THU_10AM, kind, random: () => r });
      assert.equal(scheduleFor({ config: offCfg({ offDays: [] }), now: THU_10AM, kind, random: () => r }), plain);
      assert.equal(pacificDay(plain).d, 26, `${kind} goes on a Thursday that isn't listed`);
    }
  }
  const win = machineHours(offCfg().autoSend);
  assert.equal(spreadAcrossDay({ now: THU_10AM, quietHours: win, hours: 8, random: () => 0.5, weekends: "replies_only" }),
    spreadAcrossDay({ now: THU_10AM, quietHours: win, hours: 8, random: () => 0.5, weekends: "replies_only", offDays: [] }));
});

test("a one-minute machine window doesn't skip a day", async () => {
  // The 10/12 holiday pause set machineUntil to 08:01: a nudge spread at
  // 1:35pm went to the day after next, not the next morning.
  const cfg = offCfg({ machineUntil: "08:01" });
  const MON_135PM = T("2026-11-16T21:35:00Z");   // Monday 11/16, 1:35pm Pacific
  for (const r of [0, 0.5, 0.99]) {
    const p = pacificDay(scheduleFor({ config: cfg, now: MON_135PM, kind: "agent_pulse", random: () => r }));
    assert.ok(p.d === 17 && p.hh === 8 && p.mm === 0, JSON.stringify(p));
  }
  const store = fakeStore([machineRow("c1", "agent_pulse", MON_135PM)]);
  await tickAt(store, MON_135PM, { machineUntil: "08:01" });
  const c = pacificDay(store.rows.get("c1").sendAt);
  assert.ok(c.d === 17 && c.hh === 8, JSON.stringify(c));
});
