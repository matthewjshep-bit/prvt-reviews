// follow-up-sweep.test.mjs — the clock, exercised offline.
//
// Almost every test here is about NOT texting somebody: the sweep runs
// unattended against real phones, so the interesting behaviour is the
// standing-aside, not the sending.

import test from "node:test";
import assert from "node:assert/strict";
import {
  startFollowUpSweep, maybeStartFollowUpSweep, agentCandidates, investorCandidates, passedCandidates,
  publicFollowUpJob, cancelFollowUpSweep, _resetJobs, CURSOR_NAME, FOLLOW_UP_UTC_HOUR, isTheOfferToAskAbout, DAILY_WINDOW_HOURS, getFollowUpJob,
} from "./follow-up-sweep.js";
import { normalizeConversationAi } from "./shared/conversation-ai.js";
import { effectiveStatus, OPEN_STATUSES } from "./shared/offer-status.js";
import { followUpDedupeKey } from "./shared/follow-up.js";

const DAY = 86400000;
const T0 = Date.parse("2026-09-01T17:00:00.000Z");
const at = (d) => new Date(T0 + d * DAY).toISOString();
// Until the sweep is done, not a fixed beat. On a cold CI runner the file's
// first sweep took 76ms and a 20ms wait read it mid-run ("running" !==
// "done"), failing main on 2026-10-01 and 10-02 with nothing broken.
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async () => {
  await pause(20);
  const until = Date.now() + 5000;
  while (getFollowUpJob("LOC")?.status === "running" && Date.now() < until) await pause(5);
};

/* ---------- fakes ---------- */

const fakeStore = ({ offers = [], events = [], drafts = [] } = {}) => {
  const evRows = [...events];
  const store = {
    offers: new Map(offers.map((o) => [o.id, o])),
    events: evRows,
    cursors: new Map(),
    async listOffersForFollowUp(_loc, { statuses = [...OPEN_STATUSES], before = null } = {}) {
      const want = new Set(statuses);
      return [...store.offers.values()]
        .filter((o) => want.has(effectiveStatus(o)))
        .filter((o) => !before || (o.statusAt || o.createdAt) <= before);
    },
    async listOffers() { return [...store.offers.values()]; },
    async getOffer(id) { return store.offers.get(id) || null; },
    async updateOffer(id, doc) { store.offers.set(id, doc); return true; },
    async listContactEventsSince(_loc, since, { types = null } = {}) {
      return evRows.filter((e) => e.at >= since && (!types || types.includes(e.type)));
    },
    async listReplyDrafts(_loc, { contactId } = {}) { return drafts.filter((d) => !contactId || d.contactId === contactId); },
    // The real thing: a unique (location, contact, dedupeKey). This is the
    // claim, so the fake has to honour it or the concurrency tests lie.
    async appendContactEvents(_loc, contactId, rows) {
      let inserted = 0, skipped = 0;
      for (const r of rows) {
        const dup = r.dedupeKey && evRows.some((e) => e.contactId === contactId && e.dedupeKey === r.dedupeKey);
        if (dup) { skipped++; continue; }
        evRows.push({ ...r, contactId });
        inserted++;
      }
      return { inserted, skipped };
    },
    async getContactProfile() { return null; },
    async upsertContactProfile() { return {}; },
    async getJobCursor(loc, name) { return store.cursors.get(`${loc}|${name}`) || null; },
    async setJobCursor(loc, name, v) { store.cursors.set(`${loc}|${name}`, v); return v; },
  };
  return store;
};

const configWith = (patch = {}) => normalizeConversationAi({
  enabled: true,
  parties: {
    // repeatEvery 0: these tests pin a ladder that runs out. The repeating
    // default is covered in shared/follow-up.test.mjs.
    agent: { followUp: { enabled: true, ladders: { offer_nudge: { enabled: true, steps: [3, 7, 14], repeatEvery: 0 } } }, ...(patch.agent || {}) },
    investor: { followUp: { enabled: true, ladders: {
      blast_nudge: { enabled: true, steps: [2, 6] },
      dataroom_nudge: { enabled: true, steps: [1, 4] },
    } }, ...(patch.investor || {}) },
  },
});
const SAVED = { aiApiKey: "k", conversationAi: configWith() };

const anOffer = (over = {}) => ({
  id: "o1", locationId: "LOC", contactId: "c1", address: "12 Elm St, Renton, WA",
  cashAmount: 265000, status: "sent", statusAt: at(0), createdAt: at(0),
  sends: [{ ts: at(0), channels: ["sms"] }], ...over,
});

// A sweep that records what it was asked to start, and starts nothing.
const spySweep = (store, over = {}) => {
  const started = [];
  const statuses = [];
  const job = startFollowUpSweep({
    client: {}, locationId: "LOC", saved: SAVED, store, sendsEnabled: true,
    now: over.now ?? T0 + 4 * DAY,
    deps: {
      paceMs: 0,
      startProactive: async (args) => { started.push(args); return { skipped: null, job: { id: "j1" } }; },
      setOfferStatus: async (args) => { statuses.push(args); return { ok: true, address: args.addressHint }; },
      ...(over.deps || {}),
    },
    ...over.opts,
  });
  return { job, started, statuses };
};

/* ---------- the agent ladder ---------- */

test("an offer sent four days ago with no reply produces one nudge", async () => {
  _resetJobs();
  const store = fakeStore({ offers: [anOffer()] });
  const { job, started } = spySweep(store);
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal(started.length, 1);
  assert.equal(started[0].kind, "offer_nudge");
  assert.equal(started[0].subject.step, 3);
  assert.equal(job.started, 1);
});

test("an offer the agent answered yesterday produces no nudge", async () => {
  _resetJobs();
  const store = fakeStore({
    offers: [anOffer()],
    drafts: [{ id: "d1", contactId: "c1", inbound: "what's the address again?", createdAt: at(3) }],
  });
  const { job, started } = spySweep(store);
  await settle();
  assert.equal(started.length, 0);
  assert.equal(job.results[0].reason, "they replied");
});

test("an offer promoted to a deal is never nudged", async () => {
  _resetJobs();
  const store = fakeStore({ offers: [anOffer({ deal: { stage: "under_contract" }, status: "accepted" })] });
  const { started } = spySweep(store);
  await settle();
  assert.equal(started.length, 0);
});

test("an investor blasted on a deal that fell through is never nudged, matched by street", async () => {
  _resetJobs();
  // A GHL-workflow blast: address only, no offer id — the Edmonds case.
  const events = [{ type: "blast_sent", contactId: "i1", at: at(0), address: "22018 76th Avenue West" }];
  const deal = (stage) => [{ id: "d9", address: "22018 76th Ave W, Edmonds, WA 98026", deal: { stage, investors: [] } }];

  const dead = fakeStore({ events });
  dead.listDeals = async () => deal("fell_through");
  const a = spySweep(dead);
  await settle();
  assert.equal(a.started.length, 0);
  assert.ok(a.job.results.some((r) => r.reason === "the deal is fell through"), JSON.stringify(a.job.results));

  _resetJobs();
  const live = fakeStore({ events: [...events] });
  live.listDeals = async () => deal("under_contract");
  const b = spySweep(live);
  await settle();
  assert.equal(b.started.length, 1);
  assert.equal(b.started[0].kind, "blast_nudge");
});

test("a passed offer is never nudged", async () => {
  _resetJobs();
  const store = fakeStore({ offers: [anOffer({ status: "passed" })] });
  const { started } = spySweep(store);
  await settle();
  assert.equal(started.length, 0);
});

test("an offer past its expiry date is still followed up — it stands until they answer", async () => {
  _resetJobs();
  const store = fakeStore({ offers: [anOffer({ calc: { settings: { offerExpires: true, validityDays: 2 } } })] });
  const { job, started } = spySweep(store);
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal(started.length, 1);
  assert.equal(started[0].kind, "offer_nudge");
});

test("a nudge is claimed in the contact record before the draft is started", async () => {
  _resetJobs();
  const store = fakeStore({ offers: [anOffer()] });
  const { started } = spySweep(store);
  await settle();
  const claim = store.events.find((e) => e.type === "follow_up_sent");
  assert.ok(claim, "the claim must exist");
  assert.equal(claim.dedupeKey, followUpDedupeKey({ kind: "offer_nudge", subjectId: "o1", step: 3 }));
  assert.equal(claim.data.step, 3);
  assert.equal(started.length, 1);
});

test("a claim that loses the race skips the draft entirely", async () => {
  _resetJobs();
  const store = fakeStore({
    offers: [anOffer()],
    // Another tick got there first.
    events: [{ contactId: "c1", type: "follow_up_sent", at: at(3),
               dedupeKey: followUpDedupeKey({ kind: "offer_nudge", subjectId: "o1", step: 3 }), data: { kind: "offer_nudge", step: 3 } }],
  });
  const { job, started } = spySweep(store);
  await settle();
  assert.equal(started.length, 0, "no second text");
  assert.ok(job.results.some((r) => r.reason === "already claimed" || r.reason?.includes("hasn't come round")));
});

test("a sweep that runs twice in the same hour sends nothing the second time", async () => {
  _resetJobs();
  const store = fakeStore({ offers: [anOffer()] });
  const first = spySweep(store);
  await settle();
  assert.equal(first.started.length, 1);
  _resetJobs();
  const second = spySweep(store);
  await settle();
  assert.equal(second.started.length, 0, "the claim from the first run stands");
});

test("the offer remembers the rung it was nudged on", async () => {
  _resetJobs();
  const store = fakeStore({ offers: [anOffer()] });
  spySweep(store);
  await settle();
  assert.deepEqual(store.offers.get("o1").followUps.map((f) => f.step), [3]);
});

test("exhausting the agent ladder marks the offer no response", async () => {
  _resetJobs();
  const store = fakeStore({ offers: [anOffer({ followUps: [{ kind: "offer_nudge", step: 3 }, { kind: "offer_nudge", step: 7 }, { kind: "offer_nudge", step: 14 }] })] });
  const { job, statuses } = spySweep(store, { now: T0 + 20 * DAY });
  await settle();
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].status, "no_response");
  assert.match(statuses[0].note, /3 follow-ups/);
  assert.equal(job.exhaustedCount, 1);
});

test("exhausting the ladder does not mark no response when no nudge ever actually sent", async () => {
  _resetJobs();
  // A ladder that only ever produced drafts nobody sent proves nothing about
  // the agent, and writing down "no response" would be a lie.
  const store = fakeStore({ offers: [anOffer()] });
  const { statuses } = spySweep(store, { now: T0 + 30 * DAY });
  await settle();
  assert.equal(statuses.length, 0);
});

/* ---------- the investor ladders ---------- */

test("an investor blasted two days ago who never replied gets one nudge", async () => {
  _resetJobs();
  const store = fakeStore({ events: [
    { contactId: "i1", type: "blast_sent", at: at(0), address: "9 Oak Ave", offerId: "d1" },
  ] });
  const { started } = spySweep(store, { now: T0 + 2 * DAY });
  await settle();
  assert.equal(started.length, 1);
  assert.equal(started[0].kind, "blast_nudge");
  assert.equal(started[0].subject.address, "9 Oak Ave");
});

test("a buyer we emailed the deal to, with no phone, is never sent a text nudge", async () => {
  // 1510 Maple Lane (2026-10-01): fourteen of the twenty mobile home buyers
  // have only an email. A nudge is a text, and there is no number to send it to.
  _resetJobs();
  const store = fakeStore({ events: [
    { contactId: "i1", type: "blast_sent", at: at(0), address: "1510 Maple Lane", offerId: "d1", data: { channel: "email" } },
  ] });
  const { started } = spySweep(store, { now: T0 + 2 * DAY });
  await settle();
  assert.equal(started.length, 0);
});

test("a blast on a deal that found its buyer is never nudged to anyone else", async () => {
  _resetJobs();
  const store = fakeStore({
    offers: [{ id: "d1", address: "9 Oak Ave", status: "accepted", deal: { stage: "under_contract", investors: [{ contactId: "i9", status: "committed" }] } }],
    events: [{ contactId: "i1", type: "blast_sent", at: at(0), address: "9 Oak Ave", offerId: "d1" }],
  });
  const { started } = spySweep(store, { now: T0 + 2 * DAY });
  await settle();
  assert.equal(started.length, 0);
});

test("an investor who opened the dataroom gets the dataroom ladder, not the blast ladder", async () => {
  _resetJobs();
  const store = fakeStore({ events: [
    { contactId: "i1", type: "blast_sent", at: at(0), address: "9 Oak Ave", offerId: "d1" },
    { contactId: "i1", type: "dataroom_viewed", at: at(1), address: "9 Oak Ave", offerId: "d1" },
  ] });
  const { started } = spySweep(store, { now: T0 + 3 * DAY });
  await settle();
  assert.equal(started.length, 1);
  assert.equal(started[0].kind, "dataroom_nudge", "somebody who looked is the warmer thing to write to");
});

test("an investor who passed on the deal is dropped from the ladder", async () => {
  _resetJobs();
  const store = fakeStore({ events: [
    { contactId: "i1", type: "blast_sent", at: at(0), address: "9 Oak Ave" },
    { contactId: "i1", type: "investor_passed", at: at(1), address: "9 Oak Ave" },
  ] });
  const { started } = spySweep(store, { now: T0 + 5 * DAY });
  await settle();
  assert.equal(started.length, 0);
});

test("the committed buyer on a live deal is never nudged", async () => {
  _resetJobs();
  const store = fakeStore({ events: [
    { contactId: "i1", type: "blast_sent", at: at(0), address: "9 Oak Ave" },
    { contactId: "i1", type: "investor_committed", at: at(1), address: "9 Oak Ave" },
  ] });
  const { started } = spySweep(store, { now: T0 + 5 * DAY });
  await settle();
  assert.equal(started.length, 0);
});

test("an investor who replied is dropped from the ladder", async () => {
  _resetJobs();
  const store = fakeStore({ events: [
    { contactId: "i1", type: "blast_sent", at: at(0), address: "9 Oak Ave" },
    { contactId: "i1", type: "text_summary", at: at(1), address: "9 Oak Ave" },
  ] });
  const { started } = spySweep(store, { now: T0 + 5 * DAY });
  await settle();
  assert.equal(started.length, 0);
});

/* ---------- the rails ---------- */

test("a ladder switched off produces no candidates at all", async () => {
  const off = normalizeConversationAi({ enabled: true });
  assert.deepEqual(await agentCandidates({ store: fakeStore({ offers: [anOffer()] }), locationId: "LOC", config: off, now: T0 + 9 * DAY }), []);
  assert.deepEqual(await investorCandidates({ store: fakeStore({ events: [{ contactId: "i1", type: "blast_sent", at: at(0) }] }), locationId: "LOC", config: off, now: T0 + 9 * DAY }), []);
});

test("one contact's error does not stop the sweep", async () => {
  _resetJobs();
  const store = fakeStore({ offers: [anOffer(), anOffer({ id: "o2", contactId: "c2", address: "3 Fir Ln" })] });
  let n = 0;
  const { job } = spySweep(store, { deps: { startProactive: async () => { if (n++ === 0) throw new Error("GHL said no"); return { skipped: null, job: { id: "j2" } }; } } });
  await settle();
  assert.equal(job.errors, 1);
  assert.equal(job.started, 1, "the second contact still got its nudge");
  assert.equal(job.status, "done");
});

test("a credential failure aborts the sweep instead of failing every contact", async () => {
  _resetJobs();
  const store = fakeStore({ offers: [anOffer(), anOffer({ id: "o2", contactId: "c2", address: "3 Fir Ln" })] });
  const { job } = spySweep(store, { deps: { startProactive: async () => { throw Object.assign(new Error("no API key"), { fatal: true }); } } });
  await settle();
  assert.equal(job.status, "error");
  assert.match(job.error, /no API key/);
});

test("a dry run reports what would go out and claims nothing", async () => {
  _resetJobs();
  const store = fakeStore({ offers: [anOffer()] });
  const { job, started } = spySweep(store, { opts: { dryRun: true } });
  await settle();
  assert.equal(started.length, 0);
  assert.equal(store.events.filter((e) => e.type === "follow_up_sent").length, 0, "a preview must write nothing");
  assert.deepEqual(job.results.map((r) => r.status), ["would send"]);
});

test("a proactive message that stands itself aside is recorded, not counted as sent", async () => {
  _resetJobs();
  const store = fakeStore({ offers: [anOffer()] });
  const { job } = spySweep(store, { deps: { startProactive: async () => ({ skipped: "a person is in this thread", job: null }) } });
  await settle();
  assert.equal(job.started, 0);
  assert.equal(job.skipped, 1);
  assert.match(job.results[0].reason, /a person is in this thread/);
});

test("a second sweep cannot start while one is running", () => {
  _resetJobs();
  const store = fakeStore({ offers: [anOffer()] });
  spySweep(store);
  assert.throws(() => spySweep(store), /already running/);
});

test("the public job hides the cancel flag and says whether it is stopping", async () => {
  _resetJobs();
  const store = fakeStore({ offers: [anOffer()] });
  const { job } = spySweep(store);
  cancelFollowUpSweep("LOC");
  const pub = publicFollowUpJob(job);
  assert.equal(pub.cancelRequested, undefined);
  assert.equal(pub.stopping, true);
  await settle();
});

/* ---------- the daily gate ---------- */

const hourNow = (h) => Date.parse(`2026-09-08T${String(h).padStart(2, "0")}:05:00.000Z`);

// A day may start anywhere in the morning's window (2026-09-29): a deploy
// across the start hour used to skip the day's follow-ups.
test("the daily sweep runs in its morning window and not outside it", async () => {
  _resetJobs();
  const args = { client: {}, locationId: "LOC", saved: SAVED, deps: { startProactive: async () => ({ skipped: null, job: {} }) } };
  assert.equal(await maybeStartFollowUpSweep({ ...args, store: fakeStore({ offers: [anOffer()] }), now: hourNow(FOLLOW_UP_UTC_HOUR - 1) }), false, "not before its hour");
  assert.equal(await maybeStartFollowUpSweep({ ...args, store: fakeStore({ offers: [anOffer()] }), now: hourNow(FOLLOW_UP_UTC_HOUR + DAILY_WINDOW_HOURS) }), false, "not after its window");
  _resetJobs();
  assert.equal(await maybeStartFollowUpSweep({ ...args, store: fakeStore({ offers: [anOffer()] }), now: hourNow(FOLLOW_UP_UTC_HOUR + 1) }), true, "a boot that missed the first hour still gets the day");
  await settle();
});

test("the morning follow-ups come back after a redeploy kills the sweep mid-run", async () => {
  _resetJobs();
  const store = fakeStore({ offers: [anOffer()] });
  const args = { client: {}, locationId: "LOC", saved: SAVED, store, deps: { paceMs: 0, startProactive: async () => ({ skipped: null, job: {} }) } };
  // The claim a killed run leaves behind: the day stamped, a run "going", nothing in memory.
  await store.setJobCursor("LOC", CURSOR_NAME, { at: new Date(hourNow(FOLLOW_UP_UTC_HOUR)).toISOString(),
    doc: { tries: 1, lastDaily: new Date(hourNow(FOLLOW_UP_UTC_HOUR)).toISOString(), run: { startedAt: new Date(hourNow(FOLLOW_UP_UTC_HOUR)).toISOString() } } });
  assert.equal(await maybeStartFollowUpSweep({ ...args, now: hourNow(FOLLOW_UP_UTC_HOUR) + 20 * 60000 }), false, "not while it might still be going");
  assert.equal(await maybeStartFollowUpSweep({ ...args, now: hourNow(FOLLOW_UP_UTC_HOUR) + 50 * 60000 }), true, "stale: it runs again this morning, not tomorrow");
  await settle();
  const doc = (await store.getJobCursor("LOC", CURSOR_NAME)).doc;
  assert.equal(doc.tries, 2);
  assert.equal(doc.run, undefined, "the finished run takes itself off the cursor");
  assert.equal(doc.last.status, "done");
});

test("the cursor is written before the sweep runs so a redeploy cannot re-run it", async () => {
  _resetJobs();
  const store = fakeStore({ offers: [anOffer()] });
  const args = { client: {}, locationId: "LOC", saved: SAVED, store, now: hourNow(FOLLOW_UP_UTC_HOUR),
                 deps: { startProactive: async () => ({ skipped: null, job: {} }) } };
  assert.equal(await maybeStartFollowUpSweep(args), true);
  assert.ok(store.cursors.get(`LOC|${CURSOR_NAME}`), "the cursor is durable, unlike the job registry");
  await settle();
  _resetJobs();   // exactly what a redeploy does to the in-memory registry
  assert.equal(await maybeStartFollowUpSweep(args), false, "the cursor still holds");
});

test("the daily sweep needs the bot on, a key, and at least one live ladder", async () => {
  const base = { client: {}, locationId: "LOC", store: fakeStore(), now: hourNow(FOLLOW_UP_UTC_HOUR) };
  _resetJobs();
  assert.equal(await maybeStartFollowUpSweep({ ...base, saved: { conversationAi: configWith() } }), false, "no API key");
  _resetJobs();
  assert.equal(await maybeStartFollowUpSweep({ ...base, saved: { aiApiKey: "k", conversationAi: normalizeConversationAi({ enabled: false }) } }), false, "bot off");
  _resetJobs();
  assert.equal(await maybeStartFollowUpSweep({ ...base, saved: { aiApiKey: "k", conversationAi: normalizeConversationAi({ enabled: true }) } }), false, "every ladder off");
});


/* ---------- one nudge per property ---------- */

const sentOffer = (id, over = {}) => ({
  id, locationId: "LOC", contactId: "c1", contactName: "Agent", address: "123 Main St, Kent, WA 98031",
  status: "sent", statusAt: at(0), createdAt: at(0), cashAmount: 300000, sends: [{ ts: at(0), channels: ["sms"] }], ...over,
});
const candidatesFor = (offers, now = T0 + 20 * DAY) =>
  agentCandidates({ store: fakeStore({ offers }), locationId: "LOC", config: configWith(), now });

test("two offers on the same house for one agent get one nudge — the newer one", async () => {
  const c = await candidatesFor([
    sentOffer("old", { sends: [{ ts: at(0) }], statusAt: at(0) }),
    sentOffer("new", { address: "123 Main Street, Kent, WA 98031", sends: [{ ts: at(4) }], statusAt: at(4) }),
  ]);
  assert.deepEqual(c.map((x) => x.offerId), ["new"]);
});

test("an older offer is not nudged when a newer one on that house went out too recently to be due", async () => {
  const c = await candidatesFor([
    sentOffer("old", { sends: [{ ts: at(0) }], statusAt: at(0) }),
    sentOffer("fresh", { contactId: "c2", sends: [{ ts: at(19) }], statusAt: at(19) }),
  ]);
  assert.deepEqual(c.map((x) => x.offerId), []);
});

test("a house that became a deal on any offer is never followed up", async () => {
  const c = await candidatesFor([
    sentOffer("ours"),
    sentOffer("deal", { contactId: "c2", status: "accepted", deal: { stage: "under_contract" } }),
  ]);
  assert.deepEqual(c, []);
});

test("a newer draft still being underwritten counts as in flight", () => {
  assert.equal(isTheOfferToAskAbout(sentOffer("old"), [sentOffer("old"), sentOffer("d", { status: "draft", sends: [], statusAt: at(5), createdAt: at(5) })]), false);
});

test("a dead or passed copy of the same house does not block the live offer", () => {
  const live = sentOffer("live", { sends: [{ ts: at(1) }] });
  assert.equal(isTheOfferToAskAbout(live, [live, sentOffer("gone", { status: "passed", sends: [{ ts: at(6) }], statusAt: at(6) })]), true);
});

test("a different house for the same agent is its own follow-up", async () => {
  const c = await candidatesFor([sentOffer("a"), sentOffer("b", { address: "9 Oak Ave, Kent, WA 98031" })]);
  assert.deepEqual(c.map((x) => x.offerId).sort(), ["a", "b"]);
});

/* ---------- the hot push: a price is agreed, push it to paper (2026-09-17) ---------- */

const { hotCandidates } = await import("./follow-up-sweep.js");
const HOT_SAVED = { aiApiKey: "k", conversationAi: configWith({ agent: { followUp: { enabled: true, ladders: {
  offer_nudge: { enabled: true, steps: [3, 7, 14], repeatEvery: 0 }, hot_push: { enabled: true } } } } }) };
const hotOffer = (over = {}) => anOffer({ status: "countered", statusAt: at(0), realm: { answer: "yes", ts: at(0) }, hot: { at: at(0), by: "conversation", signal: "writing_up" }, ...over });
const hotSweep = (store, now) => spySweep(store, { now, opts: { saved: HOT_SAVED } });
const theirReply = (day, text = "seller is good with it, let me get it written") => ({ id: `in${day}`, contactId: "c1", status: "sent", intent: "acceptance", inbound: text, reply: "great", createdAt: at(day), updatedAt: at(day) });

test("a price agreed yesterday gets the write-it-up ask today", async () => {
  _resetJobs();
  const store = fakeStore({ offers: [hotOffer()] });
  const { job, started } = hotSweep(store, T0 + 1.2 * DAY);
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.deepEqual(started.map((s) => [s.kind, s.subject.step]), [["hot_push", 1]]);
  assert.equal(started[0].offer.id, "o1", "the offer rides along: the agreed number is in its book");
});

test("a hot offer is not also nudged by the offer ladder", async () => {
  _resetJobs();
  const store = fakeStore({ offers: [hotOffer()] });
  const { started } = hotSweep(store, T0 + 4 * DAY);
  await settle();
  assert.equal(started.filter((s) => s.kind === "offer_nudge").length, 0);
  assert.equal(started.filter((s) => s.kind === "hot_push").length, 1);
  const cands = await agentCandidates({ store, locationId: "LOC", config: HOT_SAVED.conversationAi, now: T0 + 4 * DAY });
  assert.deepEqual(cands, []);
  const off = await agentCandidates({ store, locationId: "LOC", config: SAVED.conversationAi, now: T0 + 4 * DAY });
  assert.equal(off.length, 1, "with the hot ladder off, the offer ladder still has it");
});

test("they answered, so the ladder starts again from their answer and does not re-send rung one's claim", async () => {
  _resetJobs();
  const pushed = hotOffer({ followUps: [{ kind: "hot_push", step: 1, at: at(1) }] });
  const store = fakeStore({ offers: [pushed], drafts: [theirReply(2)],
    events: [{ contactId: "c1", type: "follow_up_sent", at: at(1), dedupeKey: followUpDedupeKey({ kind: "hot_push", subjectId: `o1@${at(0).slice(0, 10)}`, step: 1 }), data: { kind: "hot_push", step: 1 } }] });
  const [c] = await hotCandidates({ store, locationId: "LOC", config: HOT_SAVED.conversationAi, now: T0 + 3.2 * DAY });
  assert.equal(c.startedAt, at(2), "anchored on their reply");
  assert.deepEqual(c.sentSteps, [], "the rung sent before they answered belongs to the old anchor");
  assert.equal(c.subjectId, `o1@${at(2).slice(0, 10)}`);
  const { started } = hotSweep(store, T0 + 3.2 * DAY);
  await settle();
  assert.deepEqual(started.map((s) => [s.kind, s.subject.step]), [["hot_push", 1]], "day one after their answer, with a fresh claim");
});

test("two pushes with nothing back stops: the next move is a phone call", async () => {
  _resetJobs();
  const twice = hotOffer({ followUps: [{ kind: "hot_push", step: 1, at: at(1) }, { kind: "hot_push", step: 3, at: at(3) }] });
  const sent = (day, step) => ({ id: `p${step}`, contactId: "c1", status: "sent", intent: "hot_push", outbound: { kind: "hot_push" }, inbound: "", reply: "checking in", createdAt: at(day), sentAt: at(day), updatedAt: at(day) });
  const store = fakeStore({ offers: [twice], drafts: [sent(1, 1), sent(3, 3)] });
  const { job, started } = hotSweep(store, T0 + 6.2 * DAY);
  await settle();
  assert.equal(started.length, 0);
  assert.match(job.results.find((r) => r.kind === "hot_push").reason, /two_unanswered/);
});

test("a deal is past hot, a dead offer is cold, and the ladder off means nobody is pushed", async () => {
  const now = T0 + 2 * DAY;
  const cfg = HOT_SAVED.conversationAi;
  assert.deepEqual(await hotCandidates({ store: fakeStore({ offers: [hotOffer({ status: "accepted", deal: { stage: "under_contract" } })] }), locationId: "LOC", config: cfg, now }), []);
  assert.deepEqual(await hotCandidates({ store: fakeStore({ offers: [hotOffer({ status: "passed" })] }), locationId: "LOC", config: cfg, now }), []);
  assert.deepEqual(await hotCandidates({ store: fakeStore({ offers: [hotOffer()] }), locationId: "LOC", config: SAVED.conversationAi, now }), []);
  assert.deepEqual(await hotCandidates({ store: fakeStore({ offers: [anOffer()] }), locationId: "LOC", config: cfg, now }), [], "an offer nobody agreed to is not hot");
});

test("the hot push ignores the weekly cap, but never goes twice inside twenty hours", async () => {
  _resetJobs();
  const others = [anOffer({ id: "o2", address: "9 Oak St, Kent, WA" }), anOffer({ id: "o3", address: "44 Pine St, Kent, WA" })];
  const store = fakeStore({ offers: [...others, hotOffer({ statusAt: at(3), hot: { at: at(3), by: "conversation", signal: "writing_up" }, realm: { answer: "yes", ts: at(3) } })] });
  const { started } = hotSweep(store, T0 + 4.2 * DAY);
  await settle();
  // The push goes first (2026-09-29: a run's quota must never hold up an
  // agreed price). The same agent's other houses wait for another morning
  // (2026-10-02, one text a morning): they never hold the push up.
  assert.deepEqual(started.map((x) => x.kind), ["hot_push"], "the agreed price goes, and is the only text that morning");
  _resetJobs();
  const busy = { id: "b", contactId: "c1", status: "sent", intent: "offer_nudge", outbound: { kind: "offer_nudge", offerId: "o2" }, inbound: "", reply: "hi", createdAt: at(2.9), updatedAt: at(2.9), sentAt: at(2.9) };
  const spaced = hotSweep(fakeStore({ offers: [hotOffer({ statusAt: at(3), hot: { at: at(3), by: "conversation", signal: "writing_up" }, realm: { answer: "yes", ts: at(3) } })], drafts: [busy] }), T0 + 4.2 * DAY);
  await settle();
  assert.deepEqual(spaced.started.map((x) => x.kind), ["hot_push"], "a text 31 hours ago holds a nudge three days, never an agreed price");
  _resetJobs();
  const touched = { id: "t", contactId: "c1", status: "sent", intent: "checkin_due", outbound: { kind: "checkin_due" }, inbound: "", reply: "hi", createdAt: at(1.0), updatedAt: at(1.0) };
  const again = hotSweep(fakeStore({ offers: [hotOffer()], drafts: [touched] }), T0 + 1.2 * DAY);
  await settle();
  assert.equal(again.started.length, 0, "we texted them five hours ago");
});

// 13041 SE 208th St (2026-09-25): the July row was flagged hot ("writing it
// up") while the house's number had long since moved to a later row.
test("a hot flag on a superseded row doesn't push a write-up at its number", async () => {
  const now = T0 + 2 * DAY;
  const july = hotOffer({ id: "july", createdAt: at(-60), sends: [{ ts: at(-60) }] });
  const later = anOffer({ id: "aug", status: "passed", statusAt: at(-10), createdAt: at(-50), sends: [{ ts: at(-50) }] });
  const store = fakeStore({ offers: [july, later] });
  assert.deepEqual(await hotCandidates({ store, locationId: "LOC", config: HOT_SAVED.conversationAi, now }), []);
  assert.equal((await hotCandidates({ store: fakeStore({ offers: [july] }), locationId: "LOC", config: HOT_SAVED.conversationAi, now })).length, 1, "alone on the house it is the current row");
});

/* ---------- no live offer without a clock (2026-09-29) ---------- */

// The offer ladder used to end at the agent's first reply. A countered or
// sent offer where they answered, we answered them, and then nothing, sat
// with no follow-up at all.
test("an open offer the agent answered and then went quiet is still asked about", async () => {
  _resetJobs();
  const theirs = { id: "in1", contactId: "c1", status: "sent", intent: "status_check", inbound: "let me run it by the seller", reply: "sounds good", createdAt: at(1), sentAt: at(1.05), updatedAt: at(1.05) };
  const store = fakeStore({ offers: [anOffer()], drafts: [theirs] });
  const { job, started } = spySweep(store, { now: T0 + 4.2 * DAY });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.deepEqual(started.map((s) => [s.kind, s.subject.step]), [["offer_nudge", 3]], "day three after our last word");
  const claim = store.events.find((e) => e.type === "follow_up_sent");
  assert.equal(claim.dedupeKey, followUpDedupeKey({ kind: "offer_nudge", subjectId: `o1@${at(1.05).slice(0, 10)}`, step: 3 }), "a fresh claim per anchor");

  _resetJobs();
  const early = spySweep(fakeStore({ offers: [anOffer()], drafts: [theirs] }), { now: T0 + 3.2 * DAY });
  await settle();
  assert.equal(early.started.length, 0, "day three counts from our answer, not from the offer");

  _resetJobs();
  const annoyed = { ...theirs, inbound: "stop texting me about this", createdAt: at(1), sentAt: at(1.05) };
  const braked = spySweep(fakeStore({ offers: [anOffer()], drafts: [annoyed] }), { now: T0 + 4.2 * DAY });
  await settle();
  assert.equal(braked.started.length, 0, "a re-anchored nudge asks the brake first");

  _resetJobs();
  const thanks = { id: "in2", contactId: "c1", status: "dismissed", intent: "small_talk", inbound: "ok thanks!", reply: "", createdAt: at(1), updatedAt: at(1) };
  const closer = spySweep(fakeStore({ offers: [anOffer()], drafts: [thanks] }), { now: T0 + 4.2 * DAY });
  await settle();
  assert.deepEqual(closer.started.map((s) => s.kind), ["offer_nudge"], "an 'ok thanks' left unanswered is not a reply we owe");
});

const CHECKIN_SAVED = { aiApiKey: "k", conversationAi: configWith({ agent: { followUp: { enabled: true, ladders: {
  offer_nudge: { enabled: true, steps: [3, 7, 14], repeatEvery: 0 }, passed_checkin: { enabled: true, steps: [10, 20, 30] } } } } }) };

test("an offer that went quiet gets a check-in like a passed one", async () => {
  _resetJobs();
  const quiet = anOffer({ status: "no_response", statusAt: at(0), sends: [{ ts: at(-14) }], statusHistory: [{ status: "sent", ts: at(-14) }, { status: "no_response", ts: at(0) }] });
  const store = fakeStore({ offers: [quiet] });
  const { job, started } = spySweep(store, { now: T0 + 10.2 * DAY, opts: { saved: CHECKIN_SAVED } });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.deepEqual(started.map((s) => [s.kind, s.subject.step]), [["passed_checkin", 10]]);
  assert.equal(started[0].offer.status, "no_response", "the draft knows we never heard back, not that they said no");
});

test("a passed house that sold stops getting check-ins", async () => {
  _resetJobs();
  const passed = anOffer({ status: "passed", statusAt: at(0), statusHistory: [{ status: "passed", ts: at(0) }] });
  const store = fakeStore({ offers: [passed], events: [{ contactId: "c1", type: "listing_off_market", at: at(5), offerId: "o1", data: { status: "PENDING" } }] });
  const { job, started } = spySweep(store, { now: T0 + 10.2 * DAY, opts: { saved: CHECKIN_SAVED } });
  await settle();
  assert.equal(started.length, 0);
  assert.match(job.results.find((r) => r.kind === "passed_checkin").reason, /off the market/);
});

// 2026-09-29: four offers went hot the day the agent said they'd take our
// number to the seller, and the push-to-paper ladder was about to ask each of
// them to write it up — before the seller had said anything.
test("an agent taking our number to the seller is nudged, not asked to write it up", async () => {
  const now = T0 + 2 * DAY;
  const presenting = anOffer({ hot: { at: at(0), by: "conversation", signal: "presenting", note: "taking it to the seller" } });
  const cfg = HOT_SAVED.conversationAi;
  assert.deepEqual(await hotCandidates({ store: fakeStore({ offers: [presenting] }), locationId: "LOC", config: cfg, now }), []);
  const nudges = await agentCandidates({ store: fakeStore({ offers: [presenting] }), locationId: "LOC", config: cfg, now: T0 + 4 * DAY });
  assert.deepEqual(nudges.map((c) => c.kind), ["offer_nudge"], "it stays on the offer ladder until there's a yes");
  const yes = anOffer({ hot: presenting.hot, realm: { answer: "yes", ts: at(1) } });
  assert.equal((await hotCandidates({ store: fakeStore({ offers: [yes] }), locationId: "LOC", config: cfg, now })).length, 1, "a yes starts the push");
  const writing = anOffer({ hot: { at: at(0), by: "conversation", signal: "writing_up" } });
  assert.equal((await hotCandidates({ store: fakeStore({ offers: [writing] }), locationId: "LOC", config: cfg, now })).length, 1, "writing it up is a yes");
  const yours = anOffer({ hot: { at: at(0), by: "operator", note: "close" } });
  assert.equal((await hotCandidates({ store: fakeStore({ offers: [yours] }), locationId: "LOC", config: cfg, now })).length, 1, "your flag is your call");
});

/* ---------- one voice: a waiting reply holds the machine (2026-09-29) ---------- */

// Until this, the next machine text superseded whatever was waiting in the
// outbox: a question held for a person left Today, and a canned check-in went
// out in its place.
const heldText = (over = {}) => ({ id: "h1", contactId: "c1", status: "draft", intent: "question",
  inbound: "what would you do on the other one we talked about?", reply: "Let me look into it.", createdAt: at(5), updatedAt: at(5), ...over });

test("a check-in waits while their text is held for you, and its rung isn't spent", async () => {
  _resetJobs();
  const passed = anOffer({ status: "passed", statusAt: at(0), statusHistory: [{ status: "passed", ts: at(0) }] });
  const held = heldText();
  const store = fakeStore({ offers: [passed], drafts: [held] });
  const { job, started } = spySweep(store, { now: T0 + 10.2 * DAY, opts: { saved: CHECKIN_SAVED } });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal(started.length, 0, "nothing is drafted over their text");
  assert.match(job.results.find((r) => r.kind === "passed_checkin").reason, /their text is waiting on you/);
  assert.equal(store.events.filter((e) => e.type === "follow_up_sent").length, 0, "the rung is not claimed");

  // Dealt with: the same rung goes on the next run.
  held.status = "sent";
  _resetJobs();
  const again = spySweep(store, { now: T0 + 10.4 * DAY, opts: { saved: CHECKIN_SAVED } });
  await settle();
  assert.deepEqual(again.started.map((s) => [s.kind, s.subject.step]), [["passed_checkin", 10]]);
});

test("a check-in doesn't replace your own check-in waiting in the outbox", async () => {
  _resetJobs();
  const passed = anOffer({ status: "passed", statusAt: at(0), statusHistory: [{ status: "passed", ts: at(0) }] });
  const mine = heldText({ id: "m1", inbound: "", intent: "check_in", outbound: { kind: "check_in", offerId: "o1", address: passed.address }, reply: "Any movement on 12 Elm?", createdAt: at(9), updatedAt: at(9) });
  const store = fakeStore({ offers: [passed], drafts: [mine] });
  const { job, started } = spySweep(store, { now: T0 + 10.2 * DAY, opts: { saved: CHECKIN_SAVED } });
  await settle();
  assert.equal(started.length, 0);
  assert.match(job.results.find((r) => r.kind === "passed_checkin").reason, /your check-in to them is waiting in the outbox/);
});

test("an older machine nudge nobody sent doesn't hold the next one", async () => {
  _resetJobs();
  const passed = anOffer({ status: "passed", statusAt: at(0), statusHistory: [{ status: "passed", ts: at(0) }] });
  const stale = heldText({ id: "n1", inbound: "", intent: "offer_nudge", outbound: { kind: "offer_nudge", offerId: "o1", address: passed.address }, reply: "Any update?", createdAt: at(-2), updatedAt: at(-2) });
  const store = fakeStore({ offers: [passed], drafts: [stale] });
  const { started } = spySweep(store, { now: T0 + 10.2 * DAY, opts: { saved: CHECKIN_SAVED } });
  await settle();
  assert.deepEqual(started.map((s) => [s.kind, s.subject.step]), [["passed_checkin", 10]]);
});

/* ---------- say only what's true about the offer (2026-09-29) ---------- */

test("an offer nothing went out on is not nudged; a number floated by text is, from when it was floated", async () => {
  const unsent = anOffer({ id: "u1", status: "new", sends: [], statusAt: at(0), createdAt: at(0) });
  const floated = anOffer({ id: "f1", contactId: "c2", address: "40 Oak Ave, Kent, WA", status: "new", sends: [], statusAt: at(0), createdAt: at(0), proactive: { realmCheckAt: at(1) } });
  const cfg = configWith();
  const list = await agentCandidates({ store: fakeStore({ offers: [unsent, floated] }), locationId: "LOC", config: cfg, now: T0 + 6 * DAY });
  assert.deepEqual(list.map((c) => c.offerId), ["f1"], "the unsent one is the float timer's");
  assert.equal(list[0].startedAt, at(1), "counted from the float, not from when it was priced");
});

/* ---------- the whole book, a page at a time (2026-09-29) ---------- */

// The reads stopped at the oldest 200 open offers (400 for check-ins): as the
// book grew, the newest offers were the ones never asked about.
const pagedStore = (offers) => {
  const s = fakeStore({ offers });
  s.listOffersForFollowUp = async (_loc, { statuses = [...OPEN_STATUSES], before = null, limit = 200, offset = 0 } = {}) => {
    const want = new Set(statuses);
    return [...s.offers.values()]
      .filter((o) => want.has(effectiveStatus(o)) && (!before || (o.statusAt || o.createdAt) <= before))
      .sort((a, b) => String(a.statusAt || a.createdAt).localeCompare(String(b.statusAt || b.createdAt)) || a.id.localeCompare(b.id))
      .slice(offset, offset + limit);
  };
  return s;
};
const olderBook = (n) => Array.from({ length: n }, (_, i) => anOffer({ id: `old${String(i).padStart(3, "0")}`, contactId: `a${i}`,
  address: `${i + 100} Old Rd, Kent, WA`, statusAt: at(-30), createdAt: at(-30), sends: [{ ts: at(-30) }] }));

test("the newest open offer is still nudged when two hundred older ones are ahead of it", async () => {
  const store = pagedStore([...olderBook(250), anOffer({ id: "newest", contactId: "cN", address: "1 New St, Kent, WA" })]);
  const list = await agentCandidates({ store, locationId: "LOC", config: configWith(), now: T0 + 4 * DAY });
  assert.ok(list.some((c) => c.offerId === "newest"), `the newest offer is a candidate (${list.length} read)`);
});

test("a fresh yes gets its push to paper however many open offers are older", async () => {
  const store = pagedStore([...olderBook(250), hotOffer({ id: "yes", contactId: "cY", address: "2 Yes St, Kent, WA" })]);
  const list = await hotCandidates({ store, locationId: "LOC", config: HOT_SAVED.conversationAi, now: T0 + 1.2 * DAY });
  assert.deepEqual(list.map((c) => c.offerId), ["yes"]);
});

test("a backlog the paging uncovers goes out over days, hot pushes first", async () => {
  _resetJobs();
  const store = pagedStore([...olderBook(170), hotOffer({ id: "yes", contactId: "cY", address: "2 Yes St, Kent, WA", statusAt: at(3), realm: { answer: "yes", ts: at(3) }, hot: { at: at(3), by: "conversation", signal: "writing_up" } })]);
  const { job, started } = spySweep(store, { now: T0 + 4.2 * DAY, opts: { saved: HOT_SAVED } });
  // 150 starts: wait for the run to finish rather than a fixed 200ms.
  for (let i = 0; i < 150 && job.status === "running"; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(job.status, "done", job.error);
  assert.equal(started.length, 150);
  assert.equal(started[0].kind, "hot_push", "the agreed price is first in line");
  assert.ok(job.results.some((r) => /this one goes on the next run/.test(r.reason || "")));
});

/* ---------- a relisted house (2026-09-29) ---------- */

test("a house back on the market starts its check-ins over from the relist, when switched on", async () => {
  const passed = anOffer({ status: "passed", statusAt: at(0), statusHistory: [{ status: "passed", ts: at(0) }], followUps: [{ kind: "passed_checkin", step: 10, at: at(10) }] });
  const events = [
    { contactId: "c1", type: "listing_off_market", at: at(12), offerId: "o1", data: { status: "PENDING" } },
    { contactId: "c1", type: "listing_back_on_market", at: at(30), offerId: "o1", data: {} },
  ];
  const plain = configWith({ agent: { followUp: { enabled: true, ladders: { passed_checkin: { enabled: true, steps: [10, 20, 30] } } } } });
  const [c] = await passedCandidates({ store: fakeStore({ offers: [passed], events }), locationId: "LOC", config: plain, now: T0 + 31 * DAY });
  assert.equal(c.offMarketAt, null, "off the market is no longer forever");
  assert.equal(c.relisted, false, "switch off: the old ladder simply resumes");
  const relist = configWith({ agent: { followUp: { enabled: true, relist: true, ladders: { passed_checkin: { enabled: true, steps: [10, 20, 30] } } } } });
  const [r] = await passedCandidates({ store: fakeStore({ offers: [passed], events }), locationId: "LOC", config: relist, now: T0 + 41 * DAY });
  assert.equal(r.relisted, true);
  assert.equal(r.startedAt, at(30));
  assert.match(r.subjectId, /^o1@relist-/);
  assert.deepEqual(r.sentSteps, [], "rungs from before the relist belong to the old ladder");
});

/* ---------- you stopped the bot on them (shared/bot-hold.js, 2026-10-01) ---------- */

test("a stopped person's rung is not claimed, so it goes after Resume", async () => {
  _resetJobs();
  const stop = { type: "drive_stopped", contactId: "c1", at: at(1), data: { reason: "" } };
  const store = fakeStore({ offers: [anOffer()], events: [stop] });
  const { job, started } = spySweep(store);
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal(started.length, 0);
  assert.equal(job.results[0].reason, "you stopped the bot on them");
  assert.equal(store.events.filter((e) => e.type === "follow_up_sent").length, 0, "no rung claimed");
  store.events.push({ type: "drive_resumed", contactId: "c1", at: at(3.5), data: {} });
  _resetJobs();
  const again = spySweep(store);
  await settle();
  assert.equal(again.started.length, 1, "the same rung goes after Resume");
  assert.equal(again.started[0].subject.step, 3);
});

test("a paused offer isn't marked no response while the pause holds", async () => {
  _resetJobs();
  const pause = { type: "drive_stopped", contactId: "c1", at: at(15), data: { until: at(25) } };
  const store = fakeStore({ offers: [anOffer({ followUps: [{ kind: "offer_nudge", step: 3 }, { kind: "offer_nudge", step: 7 }, { kind: "offer_nudge", step: 14 }] })], events: [pause] });
  const { job, statuses } = spySweep(store, { now: T0 + 20 * DAY });
  await settle();
  assert.equal(statuses.length, 0);
  assert.match(job.results[0].reason, /paused until/);
});

test("a stop older than their newest 300 events still holds", async () => {
  _resetJobs();
  const busy = Array.from({ length: 400 }, (_, i) => ({ type: "text_summary", contactId: "c1", at: at(2 + i / 1000), data: {} }));
  const store = fakeStore({ offers: [anOffer()], events: [{ type: "drive_stopped", contactId: "c1", at: at(1), data: {} }, ...busy] });
  const { started } = spySweep(store);
  await settle();
  assert.equal(started.length, 0);
});

/* ---------- one agent, one house at a time (2026-10-02) ---------- */

// The Auburn listing agent, 9/19–9/30: six machine texts in eleven days about three
// houses. On 9/21 a check-in on a house they'd passed on in August went out
// INSTEAD of the nudge on their live offer; on 9/23 the lead was a house that
// had sold. Matt: the live offer is what we text about; a house they passed on
// gets one line on its nudge, once a month; never a house we passed on.
const FOCUS_SAVED = CHECKIN_SAVED;
const passedOn = (over = {}) => anOffer({
  id: "mil", address: "28422 Military Rd S, Federal Way, WA 98003", cashAmount: 165150, status: "passed",
  statusAt: at(-27), createdAt: at(-40), sends: [{ ts: at(-40) }], statusHistory: [{ status: "passed", ts: at(-27) }], ...over,
});
// The house that sold: its August row was "passed", the September re-offer "we passed".
const soldOld = anOffer({ id: "sh-old", address: "4621 S Sheridan Ave, Tacoma, WA 98408", cashAmount: 126270, status: "passed",
  statusAt: at(-27), createdAt: at(-45), sends: [{ ts: at(-45) }], statusHistory: [{ status: "passed", ts: at(-27) }] });
const soldNew = anOffer({ id: "sh-new", address: "4621 S Sheridan Ave, Tacoma, WA 98408", cashAmount: 237499, status: "we_passed",
  statusAt: at(-5), createdAt: at(-6), sends: [{ ts: at(-6) }] });
const machineText = (id, day, kind = "passed_checkin", offerId = "elsewhere") => ({ id, contactId: "c1", status: "sent", intent: kind,
  outbound: { kind, offerId }, inbound: "", reply: "…", createdAt: at(day - 0.05), updatedAt: at(day), sentAt: at(day) });

test("an agent with a live offer gets the nudge on it, not a check-in on a house they passed on", async () => {
  _resetJobs();
  const store = fakeStore({ offers: [anOffer(), passedOn(), soldOld, soldNew] });
  const { job, started } = spySweep(store, { now: T0 + 3.2 * DAY, opts: { saved: FOCUS_SAVED } });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.deepEqual(started.map((s) => [s.kind, s.offer.id, s.subject.step]), [["offer_nudge", "o1", 3]], "one text, about the live offer");
  assert.deepEqual(started[0].subject.aside, { address: "28422 Military Rd S, Federal Way, WA 98003", quiet: false }, "the passed house rides on it as one line");
  const fold = store.events.find((e) => e.type === "follow_up_sent" && e.data.kind === "passed_checkin");
  assert.equal(fold.dedupeKey, followUpDedupeKey({ kind: "passed_checkin", subjectId: "mil", step: 30 }), "its rung is spent, so its ladder moves on");
  assert.equal(fold.data.aside, true);
  assert.deepEqual(store.offers.get("mil").followUps.map((f) => [f.kind, f.step, f.aside]), [["passed_checkin", 30, true]]);
  assert.equal(store.events.filter((e) => e.type === "follow_up_sent" && /sh-/.test(e.dedupeKey)).length, 0, "the house we passed on never comes up");
});

test("a house they passed on comes up on the live offer's nudge at most once a month", async () => {
  _resetJobs();
  const touched = passedOn({ followUps: [{ kind: "passed_checkin", step: 20, at: at(-10), aside: true }] });
  const store = fakeStore({ offers: [anOffer(), touched] });
  const { job, started } = spySweep(store, { now: T0 + 3.2 * DAY, opts: { saved: FOCUS_SAVED } });
  await settle();
  assert.deepEqual(started.map((s) => s.kind), ["offer_nudge"]);
  assert.equal(started[0].subject.aside, undefined, "mentioned thirteen days ago");
  assert.equal(store.events.filter((e) => e.type === "follow_up_sent" && e.data.kind === "passed_checkin").length, 0, "its rung isn't spent");
  assert.match(job.results.find((r) => r.kind === "passed_checkin").reason, /one house at a time/);
});

test("a check-in on a passed house waits while a live offer is out, even on a morning with no nudge due", async () => {
  _resetJobs();
  const store = fakeStore({ offers: [anOffer(), passedOn({ statusAt: at(-29), statusHistory: [{ status: "passed", ts: at(-29) }] })] });
  const { job, started } = spySweep(store, { now: T0 + 1.2 * DAY, opts: { saved: FOCUS_SAVED } });
  await settle();
  assert.equal(started.length, 0);
  assert.equal(store.events.filter((e) => e.type === "follow_up_sent").length, 0, "nothing claimed: it goes on a later nudge");
  assert.match(job.results.find((r) => r.kind === "passed_checkin").reason, /the live offer on 12 Elm St/);
});

test("once nothing is live, the passed house gets its check-in on its own again", async () => {
  _resetJobs();
  const settled = anOffer({ status: "passed", statusAt: at(0), statusHistory: [{ status: "passed", ts: at(0) }] });
  const store = fakeStore({ offers: [settled, passedOn()] });
  const { started } = spySweep(store, { now: T0 + 3.2 * DAY, opts: { saved: FOCUS_SAVED } });
  await settle();
  assert.deepEqual(started.map((s) => [s.kind, s.offer.id, s.subject.step]), [["passed_checkin", "mil", 30]]);
});

test("one text a morning per agent: the house they're on goes, the other waits", async () => {
  _resetJobs();
  const older = anOffer({ id: "o2", address: "9 Oak Ave, Kent, WA 98031", createdAt: at(-0.5), statusAt: at(-0.5), sends: [{ ts: at(-0.5) }] });
  const store = fakeStore({ offers: [older, anOffer()] });
  const { job, started } = spySweep(store, { now: T0 + 3.7 * DAY, opts: { saved: FOCUS_SAVED } });
  await settle();
  assert.deepEqual(started.map((s) => s.offer.id), ["o1"], "the newer offer is the one they're on");
  assert.match(job.results.find((r) => r.address.startsWith("9 Oak")).reason, /one text a morning — the nudge on their live offer went to them first/);
});

test("the weekly cap counts the texts already sent this week, not just this morning's", async () => {
  _resetJobs();
  const store = fakeStore({ offers: [anOffer()], drafts: [machineText("m1", -3.0), machineText("m2", 0.15)] });
  const { job, started } = spySweep(store, { now: T0 + 3.2 * DAY, opts: { saved: FOCUS_SAVED } });
  await settle();
  assert.equal(started.length, 0);
  assert.match(job.results[0].reason, /they've had 2 texts from us this week/);
});

test("unprompted texts to one agent are three days apart", async () => {
  _resetJobs();
  const store = fakeStore({ offers: [anOffer()], drafts: [machineText("m1", 1.4)] });
  const { started } = spySweep(store, { now: T0 + 3.2 * DAY, opts: { saved: FOCUS_SAVED } });
  await settle();
  assert.equal(started.length, 0, "a check-in went out 43 hours ago");
  _resetJobs();
  const later = spySweep(store, { now: T0 + 4.5 * DAY, opts: { saved: FOCUS_SAVED } });
  await settle();
  assert.deepEqual(later.started.map((s) => [s.kind, s.subject.step]), [["offer_nudge", 3]]);
});

test("a nudge the nightly audit already sent on the offer counts as that day's rung", async () => {
  _resetJobs();
  const audit = machineText("a1", 3.6, "offer_nudge", "o1");
  const store = fakeStore({ offers: [anOffer()], drafts: [audit] });
  const { job, started } = spySweep(store, { now: T0 + 6.7 * DAY, opts: { saved: FOCUS_SAVED } });
  await settle();
  assert.equal(started.length, 0, "day three was the audit's");
  assert.match(job.results[0].reason, /day 7 hasn't come round yet/);
  _resetJobs();
  const next = spySweep(store, { now: T0 + 7.2 * DAY, opts: { saved: FOCUS_SAVED } });
  await settle();
  assert.deepEqual(next.started.map((s) => [s.kind, s.subject.step]), [["offer_nudge", 7]]);
});
