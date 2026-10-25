// slack-notify.test.mjs — the app's news, told to Slack (slack-notify.js).
// The store is the JSON-file backend in a temp folder; Slack's Web API is a
// recorded stub on globalThis.fetch.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slack-notify-test-"));
process.env.DATA_DIR = DIR;
delete process.env.DATABASE_URL;

const { store } = await import("./store.js");
const { runSlackEvents, runSlackEventsNow, runSlackPings, maybeRunSlackEvents, testSlack, CURSOR_NAME, _resetSlack } = await import("./slack-notify.js");
const { recordEvent } = await import("./contact-record.js");
const { recordError } = await import("./app-errors.js");
await store.init();
const realFetch = globalThis.fetch;
test.after(async () => { globalThis.fetch = realFetch; await new Promise((r) => setTimeout(r, 120)); fs.rmSync(DIR, { recursive: true, force: true }); });

// Saturday 2026-10-24, 10:00am Pacific.
const T0 = Date.parse("2026-10-24T17:00:00Z");
const min = (n) => T0 + n * 60000;
const at = (n) => new Date(min(n)).toISOString();
const CH = { acquisitions: "C0ACQ00001", underwrites: "C0UW000001", dispositions: "C0DISPO001", needsMatt: "C0NEED0001", machine: "C0MACH0001", daily: "C0DAILY001" };
const ON = {
  slackBotToken: "xoxb-test-token",
  slack: { enabled: true, channels: CH, streams: { acquisitions: true, underwrites: true, dispositions: true, needsMatt: true, machine: true, daily: true }, mattUserId: "U012MATT34" },
};
const HOUSE = "1010 Bellevue Way NE, Bellevue, WA 98004";

// Slack's Web API: every call recorded; `fail` answers one method with an error.
function slack({ fail = null } = {}) {
  const calls = [];
  let n = 0;
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/api/")[1];
    const body = JSON.parse(init.body);
    calls.push({ method, body, auth: init.headers.authorization });
    if (fail && fail.method === method && (fail.times ?? 1) > 0) {
      fail.times = (fail.times ?? 1) - 1;
      if (fail.error === "rate_limited") return new Response("", { status: 429, headers: { "retry-after": "1" } });
      return Response.json({ ok: false, error: fail.error });
    }
    n++;
    return Response.json({ ok: true, ts: body.ts || `17000000${n}.0001`, channel: body.channel });
  };
  return { calls, of: (m) => calls.filter((c) => c.method === m) };
}
const said = (c) => [c.body.text, ...(c.body.blocks || []).flatMap((b) => [b.text?.text, ...(b.elements || []).map((e) => e.text)])].join("\n");
const ev = (loc, contactId, type, minute, extra = {}) => recordEvent({ store, locationId: loc, contactId, party: "agent", type, at: at(minute), source: "sweep", ...extra });

// The first run after Slack is switched on marks where it starts: a week of
// history must not land in the channels all at once.
test("switching Slack on posts nothing from before; what happens after it does", async () => {
  const LOC = "loc-start";
  await ev(LOC, "ann", "tier1_added", -30, { address: HOUSE });
  const s = slack();
  const first = await runSlackEvents({ store, locationId: LOC, saved: ON, now: min(0) });
  assert.match(first.error, /started/);
  assert.equal(s.calls.length, 0);
  await ev(LOC, "bo", "tier1_added", 1, { address: "609 168th Ave NE, Bellevue, WA 98008" });
  const r = await runSlackEvents({ store, locationId: LOC, saved: ON, now: min(2) });
  assert.equal(r.posted.length, 1);
  assert.equal(s.of("chat.postMessage")[0].body.channel, CH.acquisitions);
  assert.match(said(s.calls[0]), /609 168th Ave NE/);
  assert.equal(s.calls[0].auth, "Bearer xoxb-test-token");
});

test("a house's counter replies quietly in its Tier 1 thread; a replay posts nothing", async () => {
  const LOC = "loc-thread";
  const s = slack();
  await runSlackEvents({ store, locationId: LOC, saved: ON, now: min(0) });
  await store.upsertContactProfile(LOC, "ann", { party: "agent", name: "Ann Lee" });
  await ev(LOC, "ann", "ghl_stage_moved", 1, { address: HOUSE, data: { from: "Tier 2", to: "Tier 1", why: "a house they raised" } });
  await runSlackEvents({ store, locationId: LOC, saved: ON, now: min(2) });
  const top = s.of("chat.postMessage")[0];
  // Matt, 2026-10-25: "the agent's full name not just Ann".
  assert.match(said(top), /Tier 1 flagged: 1010 Bellevue Way NE\*\n\*Agent:\* Ann Lee\n/);

  await ev(LOC, "ann", "offer_countered", 3, { address: HOUSE, data: { amount: 410000 } });
  await runSlackEvents({ store, locationId: LOC, saved: ON, now: min(4) });
  const reply = s.of("chat.postMessage")[1];
  assert.equal(reply.body.thread_ts, "170000001.0001");
  assert.equal(reply.body.reply_broadcast, undefined, "the channel shows Tier 1s, not the back-and-forth");
  assert.match(said(reply), /Counter on \*1010 Bellevue Way NE\*: \$410,000/);

  const again = await runSlackEvents({ store, locationId: LOC, saved: ON, now: min(5) });
  assert.equal(again.posted.length, 0);
  assert.equal(s.calls.length, 2);
});

test("an underwrite is one message, edited when it lands; its result doesn't open a house in #acquisitions", async () => {
  const LOC = "loc-uw";
  const s = slack();
  await runSlackEvents({ store, locationId: LOC, saved: ON, now: min(0) });
  await ev(LOC, "cy", "underwrite_started", 1, { address: HOUSE, dedupeKey: "underwrite_started:j1", data: { jobId: "j1" } });
  await runSlackEvents({ store, locationId: LOC, saved: ON, now: min(2) });
  await ev(LOC, "cy", "underwrite_held", 3, { address: HOUSE, dedupeKey: "underwrite_held:j1", data: { jobId: "j1", held: ["fewer than 8 photos"] } });
  const r = await runSlackEvents({ store, locationId: LOC, saved: ON, now: min(4) });
  assert.equal(s.of("chat.postMessage").length, 1);
  const upd = s.of("chat.update")[0];
  assert.equal(upd.body.ts, "170000001.0001");
  assert.equal(upd.body.channel, CH.underwrites);
  assert.match(said(upd), /Underwrite held on \*1010 Bellevue Way NE\*\n• fewer than 8 photos/);
  assert.equal(r.skipped, 1, "the #acquisitions reply had no thread to go in");
});

test("a channel Slack refuses is a recorded failure, not a crash, and isn't retried every minute", async () => {
  const LOC = "loc-refused";
  const s = slack({ fail: { method: "chat.postMessage", error: "not_in_channel", times: 1 } });
  await runSlackEvents({ store, locationId: LOC, saved: ON, now: min(0) });
  await ev(LOC, "dee", "tier1_added", 1, { address: HOUSE });
  const r = await runSlackEvents({ store, locationId: LOC, saved: ON, now: min(2) });
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].error, "slack chat.postMessage: not_in_channel");
  const errors = await store.listAppErrorsSince(LOC, at(-60));
  assert.ok(errors.some((e) => e.area === "slack"));
  const next = await runSlackEvents({ store, locationId: LOC, saved: ON, now: min(3) });
  assert.equal(next.posted.length, 0);
  assert.equal(s.calls.length, 1);
});

test("Slack's rate limit gives the claim back: it posts on the next run", async () => {
  const LOC = "loc-429";
  const s = slack({ fail: { method: "chat.postMessage", error: "rate_limited", times: 1 } });
  await runSlackEvents({ store, locationId: LOC, saved: ON, now: min(0) });
  await ev(LOC, "eve", "tier1_added", 1, { address: HOUSE });
  const r = await runSlackEvents({ store, locationId: LOC, saved: ON, now: min(2) });
  assert.match(r.error, /rate limited/);
  const next = await runSlackEvents({ store, locationId: LOC, saved: ON, now: min(3) });
  assert.equal(next.posted.length, 1);
  assert.equal(s.calls.length, 2);
});

test("at most 30 posts a run; the rest go next run", async () => {
  const LOC = "loc-cap";
  const s = slack();
  await runSlackEvents({ store, locationId: LOC, saved: ON, now: min(0) });
  for (let i = 0; i < 34; i++) await ev(LOC, `c${i}`, "tier1_added", 1, { address: `${100 + i} Main St, Kent, WA 98032` });
  const r = await runSlackEvents({ store, locationId: LOC, saved: ON, now: min(2) });
  assert.equal(r.posted.length, 30);
  assert.equal(r.skipped, 4);
  const next = await runSlackEvents({ store, locationId: LOC, saved: ON, now: min(3) });
  assert.equal(next.posted.length, 4);
  assert.equal(s.calls.length, 34);
});

test("a wave of buyer texts on one deal is one line in its #dispositions thread", async () => {
  const LOC = "loc-dispo";
  const s = slack();
  await runSlackEvents({ store, locationId: LOC, saved: ON, now: min(0) });
  await ev(LOC, "seller-agent", "deal_promoted", 1, { address: HOUSE, offerId: "o1", data: { contractPrice: 386000, assignmentFee: 30000 } });
  for (const b of ["b1", "b2", "b3"]) await recordEvent({ store, locationId: LOC, contactId: b, party: "investor", type: "blast_sent", at: at(2), address: HOUSE, offerId: "o1", source: "blast", dedupeKey: `blast:${b}` });
  await runSlackEvents({ store, locationId: LOC, saved: ON, now: min(3) });
  const dispo = s.of("chat.postMessage").filter((c) => c.body.channel === CH.dispositions);
  assert.equal(dispo.length, 2);
  assert.match(said(dispo[0]), /New deal: \*1010 Bellevue Way NE\* — contract \$386,000, fee \$30,000/);
  assert.match(said(dispo[1]), /Deal sent to 3 buyers/);
  assert.equal(dispo[1].body.thread_ts, "170000001.0001", "the wave replies under the deal");
  assert.equal(s.of("chat.postMessage").filter((c) => c.body.channel === CH.acquisitions).length, 0, "a contract on a house never in Tier 1 opens nothing there");
});

test("Slack off, or no token: the minute loop calls nothing", async () => {
  _resetSlack();
  const s = slack();
  assert.equal(await maybeRunSlackEvents({ locationId: "loc-off", saved: { slack: { ...ON.slack, enabled: false }, slackBotToken: "xoxb-1" }, store, now: min(0) }), null);
  assert.equal(await maybeRunSlackEvents({ locationId: "loc-off", saved: { slack: ON.slack }, store, now: min(0) }), null);
  assert.equal(s.calls.length, 0);
  assert.equal(await store.getJobCursor("loc-off", CURSOR_NAME), null);
});

test("what only Matt can do posts to #needs-matt once, with an @-mention", async () => {
  const LOC = "loc-pings";
  const s = slack();
  const rows = [
    { id: "paper_to_sign:o1", kind: "paper_to_sign", contactId: "ann", offerId: "o1", title: "1010 Bellevue Way: paperwork to sign" },
    { id: "price_it:o3", kind: "price_it", contactId: "cy", offerId: "o3", title: "Price it: 609 168th Ave NE" },
  ];
  const deps = { pipelineFor: async () => ({ deskAll: { rows }, desk: { rows }, drafts: [] }) };
  const r = await runSlackPings({ store, locationId: LOC, saved: ON, deps, now: min(0) });
  const need = s.of("chat.postMessage").filter((c) => c.body.channel === CH.needsMatt);
  assert.equal(need.length, 1, "a house to price isn't a ping");
  assert.match(said(need[0]), /<@U012MATT34> 1010 Bellevue Way: paperwork to sign — in Offers → Hot/);
  assert.equal(r.failed.length, 0);
  await runSlackPings({ store, locationId: LOC, saved: ON, deps, now: min(15) });
  assert.equal(s.of("chat.postMessage").filter((c) => c.body.channel === CH.needsMatt).length, 1);
});

test("the test button says hello in every channel that's set and says which didn't take", async () => {
  const s = slack({ fail: { method: "chat.postMessage", error: "channel_not_found", times: 1 } });
  const r = await testSlack({ saved: { slackBotToken: "xoxb-1", slack: { channels: { acquisitions: CH.acquisitions, daily: CH.daily } } } });
  assert.deepEqual(r.results.map((x) => [x.stream, x.ok, x.error || null]), [["acquisitions", false, "channel_not_found"], ["daily", true, null]]);
  assert.equal(s.calls.length, 2);
  assert.match((await testSlack({ saved: {} })).error, /token/);
});

// Matt, 2026-10-22: what only he can do lands in GHL's Needs Matt stage.
// #needs-matt hears the same list, in the same words, once per thing.
test("with the stage rule on, #needs-matt posts what landed in Needs Matt, once each", async () => {
  const LOC = "loc-needs";
  const s = slack();
  await store.setJobCursor(LOC, "needsMatt", { at: at(0), doc: { needs: {
    ann: { kind: "yes", rowKind: "approve_number", why: "They agreed on 1010 Bellevue Way at 410k: approve the number in Offers → Hot, then the machine asks for the write-up", key: "needs_matt_noted:approve_number:o1", offerId: "o1" },
    cy: { kind: "price", rowKind: "price_it", why: "Price it on 609 168th Ave NE: the agent has waited 26 hours for our number", key: "needs_matt_noted:price_it:o3" },
  } } });
  const saved = { ...ON, ghlStages: { mode: "on" } };
  const deps = { pipelineFor: async () => { throw new Error("the stage's list is read, not the pipeline"); } };
  await runSlackPings({ store, locationId: LOC, saved, deps, now: min(0) });
  const need = s.of("chat.postMessage").filter((c) => c.body.channel === CH.needsMatt);
  assert.equal(need.length, 2);
  assert.match(said(need[0]), /:handshake: <@U012MATT34> They agreed on 1010 Bellevue Way at 410k/);
  assert.match(said(need[1]), /:moneybag: <@U012MATT34> Price it on 609 168th Ave NE/);
  await runSlackPings({ store, locationId: LOC, saved, deps, now: min(15) });
  assert.equal(s.of("chat.postMessage").filter((c) => c.body.channel === CH.needsMatt).length, 2);
});

test("a new kind of error goes to #machine once; Slack's own errors don't loop back into Slack", async () => {
  const LOC = "loc-machine";
  const s = slack();
  await recordError(store, { locationId: LOC, area: "underwrite", err: new Error("Apify actor timed out after 300s") });
  await recordError(store, { locationId: LOC, area: "slack", err: new Error("slack chat.postMessage: not_in_channel") });
  const now = Date.now();
  await runSlackPings({ store, locationId: LOC, saved: ON, deps: { pipelineFor: async () => ({ deskAll: { rows: [] }, drafts: [] }) }, now });
  const mach = s.of("chat.postMessage").filter((c) => c.body.channel === CH.machine);
  assert.equal(mach.length, 1);
  assert.match(said(mach[0]), /New error in \*underwrite\*\n_Apify actor timed out after 300s_/);
  await runSlackPings({ store, locationId: LOC, saved: ON, deps: { pipelineFor: async () => ({ deskAll: { rows: [] }, drafts: [] }) }, now: now + 60000 });
  assert.equal(s.of("chat.postMessage").filter((c) => c.body.channel === CH.machine).length, 1);
});

// Matt, 2026-10-25: #acquisitions is the Tier 1 list, not the conversation.
test("a counter or an offer on a house that never reached Tier 1 posts nothing in #acquisitions", async () => {
  const LOC = "loc-not-tier1";
  const s = slack();
  await runSlackEvents({ store, locationId: LOC, saved: ON, now: min(0) });
  await ev(LOC, "fay", "house_mentioned", 1, { address: HOUSE, dedupeKey: "hm:fay" });
  await ev(LOC, "fay", "offer_sent", 2, { address: HOUSE, data: { amountText: "$300,000" } });
  await ev(LOC, "fay", "offer_countered", 3, { address: HOUSE, data: { amount: 340000 } });
  const r = await runSlackEvents({ store, locationId: LOC, saved: ON, now: min(4) });
  assert.equal(s.calls.length, 0);
  assert.equal(r.skipped, 2);
});

test("a house moved back into Tier 1 isn't posted twice", async () => {
  const LOC = "loc-tier1-twice";
  const s = slack();
  await runSlackEvents({ store, locationId: LOC, saved: ON, now: min(0) });
  await ev(LOC, "gus", "ghl_stage_moved", 1, { address: HOUSE, dedupeKey: "m1", data: { from: "Tier 2", to: "Tier 1" } });
  await ev(LOC, "gus", "ghl_stage_moved", 2, { address: HOUSE, dedupeKey: "m2", data: { from: "Tier 2", to: "Tier 1" } });
  await runSlackEvents({ store, locationId: LOC, saved: ON, now: min(3) });
  assert.equal(s.calls.length, 1);
});

test("a backfill posts the day's Tier 1 houses and their thread once; the minute loop doesn't post them again", async () => {
  const LOC = "loc-backfill";
  _resetSlack();
  const s = slack();
  // Switched on at 10:30; the morning happened before.
  await ev(LOC, "hal", "tier1_added", -120, { address: HOUSE });
  await ev(LOC, "hal", "offer_sent", -90, { address: HOUSE, data: { amountText: "$386,500" } });
  await ev(LOC, "ivy", "offer_countered", -60, { address: "609 168th Ave NE, Bellevue, WA 98008", data: { amount: 500000 } });
  await runSlackEvents({ store, locationId: LOC, saved: ON, now: min(30) });
  assert.equal(s.calls.length, 0, "switching on posts no history");

  const preview = await runSlackEventsNow({ store, locationId: LOC, saved: ON, now: min(31), dryRun: true, since: at(-180) });
  assert.deepEqual(preview.posted.map((p) => [p.kind, p.status, p.house]), [["tier1", "would post", "1010 Bellevue Way NE"], ["offer_sent", "would reply", "1010 Bellevue Way NE"]]);
  assert.equal(s.calls.length, 0, "a preview posts nothing");

  const r = await runSlackEventsNow({ store, locationId: LOC, saved: ON, now: min(32), since: at(-180) });
  assert.equal(r.posted.length, 2);
  const [top, reply] = s.of("chat.postMessage");
  assert.equal(reply.body.thread_ts, "170000001.0001");
  assert.match(said(top), /Tier 1 flagged: 1010 Bellevue Way NE/);

  const again = await runSlackEventsNow({ store, locationId: LOC, saved: ON, now: min(33), since: at(-180) });
  assert.equal(again.posted.length, 0);
  await maybeRunSlackEvents({ locationId: LOC, saved: ON, store, now: min(50) });
  assert.equal(s.calls.length, 2);
  // A new event on that house still threads under the backfilled post.
  await ev(LOC, "hal", "offer_countered", 51, { address: HOUSE, data: { amount: 410000 } });
  await maybeRunSlackEvents({ locationId: LOC, saved: ON, store, now: min(70) });
  assert.equal(s.of("chat.postMessage")[2].body.thread_ts, "170000001.0001");
});

// Matt, 2026-10-25: a new look for the Tier 1 post; the ones already in the
// channel are edited to it, not posted again.
test("a refresh re-renders the Tier 1 posts already in Slack, in place, once per house", async () => {
  const LOC = "loc-refresh";
  _resetSlack();
  const s = slack();
  await runSlackEvents({ store, locationId: LOC, saved: ON, now: min(0) });
  await ev(LOC, "jo", "tier1_added", 1, { address: HOUSE });
  await ev(LOC, "jo", "ghl_stage_moved", 2, { address: HOUSE, dedupeKey: "jo-m", data: { from: "Tier 2", to: "Tier 1" } });
  await runSlackEvents({ store, locationId: LOC, saved: ON, now: min(3) });
  assert.equal(s.of("chat.postMessage").length, 1);
  const preview = await runSlackEventsNow({ store, locationId: LOC, saved: ON, now: min(4), dryRun: true, since: at(0), refresh: true });
  assert.deepEqual(preview.posted.map((p) => p.status), ["would refresh"]);
  const r = await runSlackEventsNow({ store, locationId: LOC, saved: ON, now: min(5), since: at(0), refresh: true });
  assert.deepEqual(r.posted.map((p) => p.status), ["refreshed"]);
  const upd = s.of("chat.update");
  assert.equal(upd.length, 1);
  assert.equal(upd[0].body.ts, "170000001.0001");
  assert.equal(upd[0].body.channel, CH.acquisitions);
  assert.equal(s.of("chat.postMessage").length, 1, "nothing posted again");
});

test("a Tier 1 agent the record has no name for is named from GHL", async () => {
  const LOC = "loc-name-from-ghl";
  const s = slack();
  const client = { calls: [], call: async (p) => { client.calls.push(p); return { contact: { id: "kim", firstName: "Kim", lastName: "Ortega" } }; } };
  await runSlackEvents({ store, locationId: LOC, client, saved: ON, now: min(0) });
  await ev(LOC, "kim", "tier1_added", 1, { address: HOUSE });
  await runSlackEvents({ store, locationId: LOC, client, saved: ON, now: min(2) });
  assert.match(said(s.of("chat.postMessage")[0]), /\*Agent:\* Kim Ortega\n/);
  assert.deepEqual(client.calls, ["/contacts/kim"]);
});

test("with the GHL link set, Open in app opens the app inside GHL; Contact in GHL opens the person", async () => {
  const LOC = "loc-app-link";
  const s = slack();
  const GHL_APP = "https://app.gohighlevel.com/v2/location/LOC1/custom-menu-link/7f7c8c1e-f2d4-4734-9848-136d7078252a";
  const saved = { ...ON, slack: { ...ON.slack, appLink: GHL_APP } };
  await runSlackEvents({ store, locationId: LOC, saved, now: min(0) });
  await ev(LOC, "lou", "tier1_added", 1, { address: HOUSE });
  await runSlackEvents({ store, locationId: LOC, saved, now: min(2) });
  const t = said(s.of("chat.postMessage")[0]);
  assert.ok(t.includes(`<${GHL_APP}|Open in app>`), t);
  assert.match(t, /contacts\/detail\/lou\|Contact in GHL>/);
});
