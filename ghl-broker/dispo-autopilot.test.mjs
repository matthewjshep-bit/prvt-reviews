import test from "node:test";
import assert from "node:assert/strict";
import { queueBlastDrafts, normalizeDispoAutopilot, secondWaveCandidates, startDispoSweep, _resetJobs } from "./dispo-autopilot.js";

const settle = () => new Promise((r) => setTimeout(r, 15));
const fakeStore = (deals = []) => {
  const rows = new Map(); let n = 0;
  return {
    rows,
    async listReplyDrafts(_l, { contactId, status } = {}) { return [...rows.values()].filter((d) => (!contactId || d.contactId === contactId) && (!status || (Array.isArray(status) ? status.includes(d.status) : d.status === status))); },
    async createReplyDraft(doc) { const r = { ...doc, id: `d${++n}`, createdAt: new Date().toISOString() }; rows.set(r.id, r); return r; },
    async updateReplyDraft(id, doc) { rows.set(id, doc); return true; },
    async listDeals() { return deals; },
    cursors: new Map(),
    async getJobCursor(l, k) { return this.cursors.get(`${l}|${k}`) || null; },
    async setJobCursor(l, k, v) { this.cursors.set(`${l}|${k}`, v); return v; },
  };
};
const offer = { id: "o1", address: "22018 76th Ave W, Edmonds, WA 98026", cashAmount: 465000, arv: 640000, repairs: 60000, deal: { stage: "under_contract", contractPrice: 465000, assignmentFee: 30000, investors: [] } };
const buyers = [{ contactId: "i1", name: "Ravi Patel" }, { contactId: "i2", name: "Mei Chen" }, { contactId: "i3", name: "Sam" }];
const NOW = Date.parse("2026-09-10T18:00:00Z"); // 11am PT, inside the hours

test("settings coerce", () => {
  assert.equal(normalizeDispoAutopilot().sendWith, "app");
  assert.equal(normalizeDispoAutopilot({ spreadSec: 1 }).spreadSec, 5);
  assert.equal(normalizeDispoAutopilot({ autoInvite: "true" }).autoInvite, false);
});

test("with the intent ticked and both gates on, a blast becomes staggered scheduled drafts with the buyer price", async () => {
  const store = fakeStore();
  const saved = { conversationAi: { enabled: true, parties: { investor: { autoSend: { enabled: true, intents: ["blast_open"] } } } }, dispoAutopilot: { spreadSec: 60 } };
  const r = await queueBlastDrafts({ store, locationId: "L", offer, investors: buyers, saved, now: NOW, sendsEnabled: true, blastsEnabled: true });
  assert.equal(r.queued, 3);
  assert.equal(r.drafted, 0);
  assert.equal(r.price, 495000);
  const drafts = [...store.rows.values()];
  assert.ok(drafts.every((d) => d.status === "scheduled" && d.intent === "blast_open" && d.outbound.offerId === "o1"));
  assert.match(drafts[0].reply, /Hey Ravi, got 22018 76th Ave W in Edmonds under contract/);
  assert.match(drafts[0].reply, /495k/);
  const times = drafts.map((d) => Date.parse(d.sendAt));
  assert.ok(times[1] - times[0] >= 60000 && times[2] - times[1] >= 60000, "a minute apart at least");
  assert.notEqual(drafts[0].reply, drafts[1].reply, "the phrasing rotates");
});

test("without the intent on the allowlist it is drafts only, and says why; a dry run writes nothing", async () => {
  const store = fakeStore();
  const saved = { conversationAi: { enabled: true } };
  const r = await queueBlastDrafts({ store, locationId: "L", offer, investors: buyers, saved, now: NOW, sendsEnabled: true, blastsEnabled: true });
  assert.equal(r.drafted, 3);
  assert.equal(r.scheduled, false);
  assert.match(r.reason, /not on the investor auto-send list/);
  assert.ok([...store.rows.values()].every((d) => d.status === "draft" && d.autoSend.reason === r.reason));
  const off = await queueBlastDrafts({ store: fakeStore(), locationId: "L", offer, investors: buyers, saved, now: NOW, sendsEnabled: true, blastsEnabled: false });
  assert.match(off.reason, /DISPO_BLASTS_ENABLED/);
  const dry = await queueBlastDrafts({ store: fakeStore(), locationId: "L", offer, investors: buyers, saved, now: NOW, dryRun: true });
  assert.equal(dry.rows.length, 3);
  assert.equal(dry.rows[0].status, "would queue");
});

test("a second click on the same deal supersedes the buyer's open blast draft", async () => {
  const store = fakeStore();
  const saved = { conversationAi: { enabled: true } };
  await queueBlastDrafts({ store, locationId: "L", offer, investors: [buyers[0]], saved, now: NOW, sendsEnabled: true, blastsEnabled: true });
  await queueBlastDrafts({ store, locationId: "L", offer, investors: [buyers[0]], saved, now: NOW + 1000, sendsEnabled: true, blastsEnabled: true });
  const all = [...store.rows.values()];
  assert.deepEqual(all.map((d) => d.status), ["superseded", "draft"]);
});

test("the second wave finds a deal blasted once with nobody committed, after the delay, and blasts the possible fits", async () => {
  _resetJobs();
  const stale = { ...offer, id: "o2", deal: { ...offer.deal, blasts: [{ at: new Date(NOW - 50 * 3600000).toISOString(), count: 10, via: "app" }] } };
  const fresh = { ...offer, id: "o3", deal: { ...offer.deal, blasts: [{ at: new Date(NOW - 3600000).toISOString() }] } };
  const done = { ...offer, id: "o4", deal: { ...offer.deal, blasts: [{ at: new Date(NOW - 90 * 3600000).toISOString() }], investors: [{ contactId: "x", status: "committed" }] } };
  const twice = { ...offer, id: "o5", deal: { ...offer.deal, blasts: [{ at: "2026-09-01T00:00:00Z" }, { at: "2026-09-03T00:00:00Z" }] } };
  const store = fakeStore([stale, fresh, done, twice]);
  const c = await secondWaveCandidates({ store, locationId: "L", saved: {}, now: NOW });
  assert.deepEqual(c.map((x) => x.offer.id), ["o2"]);
  const seen = [];
  const job = startDispoSweep({ locationId: "L", client: {}, saved: { dispoAutopilot: { autoBlastOnPromote: true, secondWaveCount: 2 } }, store, now: NOW, deps: {
    matchForDeal: async (_l, o, opts) => { seen.push(["match", o.id, opts]); return { results: [{ contactId: "p1" }, { contactId: "p2" }, { contactId: "p3" }] }; },
    blastFromApp: async (args) => { seen.push(["blast", args.offer.id, args.investors.length, args.wave]); return { queued: 0, drafted: 2, scheduled: false, reason: "drafts" }; },
  } });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.deepEqual(seen[0], ["match", "o2", { fits: ["possible"], exclude: "blasted" }]);
  assert.deepEqual(seen[1], ["blast", "o2", 2, 2]);
  assert.equal(job.blasted, 2);
});
