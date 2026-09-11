// follow-up-sweep.test.mjs — the clock, exercised offline.
//
// Almost every test here is about NOT texting somebody: the sweep runs
// unattended against real phones, so the interesting behaviour is the
// standing-aside, not the sending.

import test from "node:test";
import assert from "node:assert/strict";
import {
  startFollowUpSweep, maybeStartFollowUpSweep, agentCandidates, investorCandidates,
  publicFollowUpJob, cancelFollowUpSweep, _resetJobs, CURSOR_NAME, FOLLOW_UP_UTC_HOUR,
} from "./follow-up-sweep.js";
import { normalizeConversationAi } from "./shared/conversation-ai.js";
import { effectiveStatus, OPEN_STATUSES } from "./shared/offer-status.js";
import { followUpDedupeKey } from "./shared/follow-up.js";

const DAY = 86400000;
const T0 = Date.parse("2026-09-01T17:00:00.000Z");
const at = (d) => new Date(T0 + d * DAY).toISOString();
const settle = () => new Promise((r) => setTimeout(r, 20));

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
    agent: { followUp: { enabled: true, ladders: { offer_nudge: { enabled: true, steps: [3, 7, 14] } } }, ...(patch.agent || {}) },
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

test("a passed offer is never nudged", async () => {
  _resetJobs();
  const store = fakeStore({ offers: [anOffer({ status: "passed" })] });
  const { started } = spySweep(store);
  await settle();
  assert.equal(started.length, 0);
});

test("an expired offer is left for a person", async () => {
  _resetJobs();
  // Following up on an expired offer means re-offering, which is a decision.
  const store = fakeStore({ offers: [anOffer({ calc: { settings: { offerExpires: true, validityDays: 2 } } })] });
  const { job, started } = spySweep(store);
  await settle();
  // The sweep must FINISH with nothing sent — not crash. This assertion used to
  // be satisfied by a TypeError inside the candidate scan.
  assert.equal(job.status, "done", job.error);
  assert.equal(started.length, 0);
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

test("the daily sweep runs in its hour and not in any other", async () => {
  _resetJobs();
  const store = fakeStore({ offers: [anOffer()] });
  const args = { client: {}, locationId: "LOC", saved: SAVED, store, deps: { startProactive: async () => ({ skipped: null, job: {} }) } };
  assert.equal(await maybeStartFollowUpSweep({ ...args, now: hourNow(FOLLOW_UP_UTC_HOUR + 1) }), false);
  _resetJobs();
  assert.equal(await maybeStartFollowUpSweep({ ...args, now: hourNow(FOLLOW_UP_UTC_HOUR) }), true);
  await settle();
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
