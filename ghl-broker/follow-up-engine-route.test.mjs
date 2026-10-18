// follow-up-engine-route.test.mjs — GET /api/dashboard/followup on the JSON store.
//
//   node --test follow-up-engine-route.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "follow-up-engine-test-"));
delete process.env.DATABASE_URL;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createDashboardRouter } = await import("./routes/dashboard.js");
const { recordEvent } = await import("./contact-record.js");
const { OUTBOUND_KINDS } = await import("./reply-agent.js");
const { FOLLOW_UP_MECHANISMS, EXCLUDED_KINDS } = await import("./shared/follow-up-engine.js");
const { followUpEngineFor, mechanismStatuses, _resetPlanMemo } = await import("./follow-up-engine.js");
const { conversationConfig } = await import("./reply-agent.js");

const LOC = "loc-follow-up-engine";
const app = express();
app.use(express.json());
const router = createDashboardRouter({ resolveLocation: () => ({ locationId: LOC, client: null }) });
app.use("/api/dashboard", router);
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(() => server.close());

const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const ahead = (d) => new Date(Date.now() + d * DAY).toISOString();
const mk = (over) => store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: `a-${crypto.randomUUID().slice(0, 6)}`, statusHistory: [], createdAt: ago(10), ...over });

const SETTINGS = {
  conversationAi: {
    enabled: true,
    parties: { agent: {
      followUp: { enabled: true, ladders: { offer_nudge: { enabled: true, steps: [3, 7, 14], repeatEvery: 7 }, outreach_nudge: { enabled: true, steps: [2, 5] } } },
      autoSend: { enabled: true, intents: ["offer_nudge"] },
    } },
  },
};

let nudged, queuedOffer, replier;

test("an offer out with no answer has its nudge planned, a written one is queued once, and a reply is credited", async () => {
  await store.saveOfferSettings(LOC, SETTINGS);
  const before = JSON.stringify(await store.getOfferSettings(LOC));
  // Our letter went two days ago: the day-3 nudge is coming.
  nudged = await mk({ address: "1 Nudge St, Kent, WA 98031", contactName: "Agent One", status: "sent", statusAt: ago(2), cashAmount: 300000, sends: [{ ts: ago(2), channels: ["sms"] }] });
  // A nudge already written with a send time: queued, not planned as well.
  queuedOffer = await mk({ address: "2 Queued St, Kent, WA 98031", status: "sent", statusAt: ago(4), cashAmount: 250000, sends: [{ ts: ago(4), channels: ["sms"] }] });
  await store.createReplyDraft({ locationId: LOC, contactId: queuedOffer.contactId, contactName: "Agent Two", status: "scheduled", sendAt: ahead(0.1), inbound: "",
    outbound: { kind: "offer_nudge", offerId: queuedOffer.id, address: queuedOffer.address }, intent: "offer_nudge", reply: "Any thoughts on our offer?" });
  // A cold-agent follow-up that went yesterday, and their answer an hour later.
  replier = `a-${crypto.randomUUID().slice(0, 6)}`;
  await store.createReplyDraft({ locationId: LOC, contactId: replier, contactName: "Agent Three", status: "sent", sentAt: ago(1), autoSent: true, inbound: "",
    outbound: { kind: "outreach_nudge" }, intent: "outreach_nudge", reply: "Following up on my text." });
  await recordEvent({ store, locationId: LOC, contactId: replier, party: "agent", type: "text_summary", at: new Date(Date.now() - DAY + 3600000).toISOString(),
    source: "conversation", dedupeKey: `t:${replier}`, data: { inbound: "Got one on Elm, call me" } });

  const r = await (await fetch(`${B}/api/dashboard/followup?period=ytd`)).json();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.items, undefined, "the rows come from /followup/items");
  const live = r.groups.find((g) => g.key === "offer_live").mechanisms.find((m) => m.key === "offer_nudge");
  assert.equal(live.status, "drafts", "the broker's send flag is off in tests: written, held for you");
  assert.equal(live.queued, 1, "the written nudge");
  assert.equal(live.planned, 1, "the other offer's day-3 nudge, and not a second one for the queued offer");
  const cold = r.groups.find((g) => g.key === "agent").mechanisms.find((m) => m.key === "outreach_nudge");
  assert.equal(cold.sent, 1);
  assert.equal(cold.replied, 1);
  assert.equal(cold.status, "drafts", "on its ladder but not on the auto-send list");

  const items = await (await fetch(`${B}/api/dashboard/followup/items?period=ytd&mechanism=offer_nudge`)).json();
  assert.deepEqual(items.items.map((x) => [x.offerId, x.state]).sort(), [[nudged.id, "planned"], [queuedOffer.id, "queued"]].sort());
  assert.equal(items.items.find((x) => x.offerId === nudged.id).name, "Agent One");

  assert.equal(JSON.stringify(await store.getOfferSettings(LOC)), before, "reading the page never writes settings");
});

test("a period the page doesn't know is a 400", async () => {
  const res = await fetch(`${B}/api/dashboard/followup?period=fortnight`);
  assert.equal(res.status, 400);
});

test("with follow-ups off nothing is planned, and every row says Off", async () => {
  _resetPlanMemo();
  const page = await followUpEngineFor({ store, locationId: LOC, saved: {}, period: "ytd" });
  assert.equal(page.kpis.planned, 0);
  const nudge = page.groups.find((g) => g.key === "offer_live").mechanisms.find((m) => m.key === "offer_nudge");
  assert.equal(nudge.status, "off");
  assert.equal(nudge.queued, 1, "a text already queued still shows: it will go");
});

test("with sending off on the broker an auto-send kind is drafts only", () => {
  const s = mechanismStatuses({ config: conversationConfig(SETTINGS), saved: SETTINGS, env: { sends: false } });
  assert.equal(s.offer_nudge.state, "drafts");
  assert.match(s.offer_nudge.why, /CARD_SENDS_ENABLED/);
  assert.equal(mechanismStatuses({ config: conversationConfig(SETTINGS), saved: SETTINGS, env: { sends: true } }).offer_nudge.state, "on");
});

test("every kind the bot can start is on the page or left out on purpose", () => {
  const known = new Set(FOLLOW_UP_MECHANISMS.flatMap((m) => m.kinds));
  for (const k of Object.keys(OUTBOUND_KINDS)) assert.ok(known.has(k) || EXCLUDED_KINDS.has(k), `${k} has no row on Reports → Follow-up`);
});

// What went wrong (2026-10-17, first read on prod): a deal blasted by hand
// twice has two `blasts` entries, both wave 1, and the page counted entries:
// 306 deal texts read as the machine's "next waves" and none as a first wave.
test("a deal blasted by hand twice is still its first wave; only a wave the sweep sent is a next wave", async () => {
  const LOC2 = "loc-follow-up-waves";
  _resetPlanMemo();
  const deal = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC2, contactId: "seller-agent", address: "5 Wave St, Kent, WA 98031", status: "accepted", statusHistory: [], createdAt: ago(10),
    deal: { stage: "under_contract", investors: [], blasts: [
      { at: ago(3), wave: 1, via: "app", count: 2 },
      { at: ago(2), wave: 1, via: "app", count: 2 },
      { at: ago(1), wave: 2, via: "app", count: 2 },
    ] } });
  const sent = async (contactId, at) => recordEvent({ store, locationId: LOC2, contactId, party: "investor", type: "blast_sent", at, offerId: deal.id, address: deal.address,
    source: "blast", dedupeKey: `blast:${deal.id}:${contactId}`, data: { via: "app" } });
  await sent("b1", new Date(Date.parse(ago(3)) + 600000).toISOString());
  await sent("b2", new Date(Date.parse(ago(2)) + 600000).toISOString());
  await sent("b3", new Date(Date.parse(ago(1)) + 600000).toISOString());
  const page = await followUpEngineFor({ store, locationId: LOC2, saved: {}, period: "ytd" });
  const buyers = page.groups.find((g) => g.key === "buyer").mechanisms;
  assert.equal(buyers.find((m) => m.key === "blast_first").sent, 2);
  assert.equal(buyers.find((m) => m.key === "blast_wave").sent, 1);
});
