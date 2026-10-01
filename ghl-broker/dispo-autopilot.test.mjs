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

test("the blast on promote waits before its first text, so the fee can be set; each draft keeps its phrasing", async () => {
  const saved = { conversationAi: { enabled: true, parties: { investor: { autoSend: { enabled: true, intents: ["blast_open"] } } } }, dispoAutopilot: { spreadSec: 60 } };
  const now0 = await queueBlastDrafts({ store: fakeStore(), locationId: "L", offer, investors: buyers, saved, now: NOW, sendsEnabled: true, blastsEnabled: true });
  const store = fakeStore();
  const later = await queueBlastDrafts({ store, locationId: "L", offer, investors: buyers, saved, now: NOW, sendsEnabled: true, blastsEnabled: true, startAfterMs: 10 * 60000 });
  assert.ok(Date.parse(later.rows[0].sendAt) - Date.parse(now0.rows[0].sendAt) >= 10 * 60000 - 1000, "ten minutes later");
  assert.deepEqual([...store.rows.values()].map((d) => d.outbound.variant), [0, 1, 2]);
});

test("the operator's one line for a blast rides in the text and on the draft, so the send-time rewrite keeps it", async () => {
  const saved = { conversationAi: { enabled: true, parties: { investor: { autoSend: { enabled: true, intents: ["blast_open"] } } } } };
  const store = fakeStore();
  await queueBlastDrafts({ store, locationId: "L", offer, investors: buyers.slice(0, 1), saved, now: NOW, sendsEnabled: true, blastsEnabled: true, note: "3bd 1952 rambler on a quarter acre with an 840 sqft garage, ADU upside" });
  const d = [...store.rows.values()][0];
  assert.match(d.reply, /3bd 1952 rambler on a quarter acre with an 840 sqft garage, ADU upside\. /);
  assert.equal(d.outbound.note, "3bd 1952 rambler on a quarter acre with an 840 sqft garage, ADU upside");
});

test("a buyer with no phone is emailed the deal as a draft that waits for you; a phone is still texted", async () => {
  // 1510 Maple Lane (2026-10-01): fourteen of the twenty mobile home buyers
  // have only an email, and a blast could only text.
  const store = fakeStore();
  const saved = { conversationAi: { enabled: true, parties: { investor: { autoSend: { enabled: true, intents: ["blast_open"] } } } } };
  const maple = { id: "o2", address: "1510 Maple Lane, Kent, Washington 98030", cashAmount: 71075, arv: 165000, repairs: 40000,
    asset: { type: "manufactured", land: "park", by: "you" },
    snapshot: { subjectInfo: { beds: 3, baths: 2, sqft: 1440, homeType: "MANUFACTURED" } },
    deal: { stage: "under_contract", contractPrice: 71075, assignmentFee: 5000, investors: [] } };
  const r = await queueBlastDrafts({ store, locationId: "L", offer: maple, now: NOW, sendsEnabled: true, blastsEnabled: true, saved, investors: [
    { contactId: "t1", name: "Moises G", phone: "+12065550100", email: "", tags: ["dispo-type-mobile-home"] },
    { contactId: "e1", name: "Gizelle P", phone: "", email: "g@example.com", tags: ["dispo-type-mobile-home", "dispo-source-fb-warei"], lastRepliedAt: "" },
    { contactId: "x1", name: "Nobody", phone: "", email: "" },
  ] });
  const [text, mail] = [...store.rows.values()];
  assert.equal(text.channel, "sms");
  assert.equal(text.status, "scheduled");
  assert.match(text.reply, /mobile home in a park/);
  assert.equal(mail.channel, "email");
  assert.equal(mail.status, "draft", "an emailed deal waits for you");
  assert.match(mail.autoSend.reason, /emailed deals wait for you/);
  assert.equal(mail.outbound.subject, "Mobile home in a park, Kent — under contract, 76k");
  assert.match(mail.reply, /^Hey Gizelle — found you through the WA real estate Facebook group\. /);
  assert.equal(mail.outbound.intro, "found you through the WA real estate Facebook group");
  assert.equal(r.rows.find((x) => x.contactId === "x1").status, "skipped");
  assert.equal(r.queued, 1);
  assert.equal(r.drafted, 1);

  // With emailed deals allowed to send themselves, it is scheduled like a text.
  const store2 = fakeStore();
  await queueBlastDrafts({ store: store2, locationId: "L", offer: maple, now: NOW, sendsEnabled: true, blastsEnabled: true,
    saved: { ...saved, dispoAutopilot: { email: { autoSend: true } } }, investors: [{ contactId: "e1", name: "G", phone: "", email: "g@example.com" }] });
  assert.equal([...store2.rows.values()][0].status, "scheduled");

  // And with email drafting off, a buyer with no phone is left out.
  const off = await queueBlastDrafts({ store: fakeStore(), locationId: "L", offer: maple, now: NOW, saved: { ...saved, dispoAutopilot: { email: { draft: false } } },
    investors: [{ contactId: "e1", name: "G", phone: "", email: "g@example.com" }], dryRun: true });
  assert.equal(off.rows[0].status, "skipped");
});

test("email settings default to drafting on, sending off", () => {
  assert.deepEqual(normalizeDispoAutopilot().email, { draft: true, autoSend: false });
  assert.deepEqual(normalizeDispoAutopilot({ email: { draft: false, autoSend: "yes" } }).email, { draft: false, autoSend: false });
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

test("match score floors default to 50 (first wave) and 35 (second) and clamp to 0–100", () => {
  const d = normalizeDispoAutopilot({});
  assert.equal(d.minMatchScore, 50);
  assert.equal(d.secondWaveMinScore, 35);
  assert.equal(normalizeDispoAutopilot({ minMatchScore: 140 }).minMatchScore, 100);
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
  assert.deepEqual(seen[0], ["match", "o2", { wave: 2, exclude: "blasted" }]);
  assert.deepEqual(seen[1], ["blast", "o2", 2, 2]);
  assert.equal(job.blasted, 2);
});

test("a third wave runs only when the setting allows three, to the next-ranked buyers, as wave 3", async () => {
  _resetJobs();
  const at = (h) => new Date(NOW - h * 3600000).toISOString();
  const two = { ...offer, id: "o6", deal: { ...offer.deal, blasts: [{ at: at(120), via: "app", wave: 1 }, { at: at(50), via: "app", wave: 2 }] } };
  const ghlOnly = { ...offer, id: "o7", deal: { ...offer.deal, blastTags: ["dispo-22018-76th-ave-w"], blasts: [] } };
  const store = fakeStore([two, ghlOnly]);
  assert.deepEqual(await secondWaveCandidates({ store, locationId: "L", saved: {}, now: NOW }), [], "two waves is the default, and all it does");
  const three = await secondWaveCandidates({ store, locationId: "L", saved: { dispoAutopilot: { maxWaves: 3 } }, now: NOW });
  assert.deepEqual(three.map((c) => [c.offer.id, c.wave]), [["o6", 3]], "a deal blasted only through a GHL workflow gets no automatic wave");
  const early = await secondWaveCandidates({ store: fakeStore([{ ...two, deal: { ...two.deal, blasts: [two.deal.blasts[0], { at: at(10), via: "app", wave: 2 }] } }]), locationId: "L", saved: { dispoAutopilot: { maxWaves: 3 } }, now: NOW });
  assert.deepEqual(early, [], "the delay runs from the last wave, not the first");

  const seen = [];
  const job = startDispoSweep({ locationId: "L", client: {}, saved: { dispoAutopilot: { autoBlastOnPromote: true, maxWaves: 3, secondWaveCount: 5 } }, store, now: NOW, deps: {
    matchForDeal: async (_l, o, opts) => { seen.push(["match", o.id, opts]); return { results: [{ contactId: "p9" }] }; },
    blastFromApp: async (args) => { seen.push(["blast", args.offer.id, args.wave]); return { queued: 0, drafted: 1 }; },
  } });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.deepEqual(seen, [["match", "o6", { wave: 2, exclude: "blasted" }], ["blast", "o6", 3]]);
});

test("waves-in-all defaults to two and clamps to one through four", () => {
  assert.equal(normalizeDispoAutopilot({}).maxWaves, 2);
  assert.equal(normalizeDispoAutopilot({ maxWaves: 9 }).maxWaves, 4);
  assert.equal(normalizeDispoAutopilot({ maxWaves: 0 }).maxWaves, 1);
});

/* ---------- the soft commit ---------- */

// "I think I have a buyer for this one." Nothing is signed, so the deal stays
// live and priced — but we stop putting it in front of anyone new.
test("a soft-committed deal is not picked up by the second wave, and clearing it lets the wave run", async () => {
  const blastedAt = new Date(NOW - 50 * 3600000).toISOString();
  const withStatus = (status) => ({
    ...offer, id: "o9",
    deal: { ...offer.deal, blasts: [{ at: blastedAt, count: 10, via: "app" }], investors: [{ contactId: "i1", name: "Dmitriy", status }] },
  });

  const soft = await secondWaveCandidates({ store: fakeStore([withStatus("soft_commit")]), locationId: "L", saved: {}, now: NOW });
  assert.deepEqual(soft, [], "the wave is new outreach — it waits");

  const back = await secondWaveCandidates({ store: fakeStore([withStatus("evaluating")]), locationId: "L", saved: {}, now: NOW });
  assert.deepEqual(back.map((x) => x.offer.id), ["o9"], "nothing was stored, so putting them back resumes it");

  const gone = await secondWaveCandidates({ store: fakeStore([withStatus("passed")]), locationId: "L", saved: {}, now: NOW });
  assert.deepEqual(gone.map((x) => x.offer.id), ["o9"], "and so does their passing");
});

test("the buyer price, the ARV and the rehab go out with the blast; what we paid never does", async () => {
  const store = fakeStore();
  const saved = { conversationAi: { enabled: true, parties: { investor: { autoSend: { enabled: true, intents: ["blast_open"] } } } } };
  const underwritten = {
    ...offer, id: "o10",
    snapshot: { subjectInfo: { beds: 3, baths: 2, sqft: 1480, yearBuilt: 1962 } },
  };
  const r = await queueBlastDrafts({ store, locationId: "L", offer: underwritten, investors: [buyers[0]], saved, now: NOW, sendsEnabled: true, blastsEnabled: true });
  assert.equal(r.queued, 1);
  const text = [...store.rows.values()][0].reply;
  assert.match(text, /3bd 2ba 1,480 sqft, built 1962/);
  assert.match(text, /Buyer price 495k, ARV around 640k, rehab about 60k/);
  assert.doesNotMatch(text, /465|30k/, "the contract price and the assignment fee stay ours");
});

// Matt, 2026-09-29: a blast is there to get buyers out to the house. It ends
// on the deal's walkthrough window, or on when they could come when there is
// none — and the switch puts the old closing line back.
test("a blast ends on the walkthrough: the deal's window when it has one, when they could come when it doesn't", async () => {
  const withWindow = { ...offer, deal: { ...offer.deal, showing: { windows: [{ start: "2026-09-12T17:00:00Z", end: "2026-09-12T19:00:00Z" }] } } };
  const store = fakeStore();
  await queueBlastDrafts({ store, locationId: "L", offer: withWindow, investors: buyers.slice(0, 1), saved: {}, now: NOW });
  assert.match([...store.rows.values()][0].reply, /Walkthrough is Sat Sep 12, 10am-12pm\. Can you make it\?$/);
  const bare = fakeStore();
  await queueBlastDrafts({ store: bare, locationId: "L", offer, investors: buyers.slice(0, 1), saved: {}, now: NOW });
  assert.match([...bare.rows.values()][0].reply, /When could you get out to walk it\?$/);
  const off = fakeStore();
  await queueBlastDrafts({ store: off, locationId: "L", offer: withWindow, investors: buyers.slice(0, 1), saved: { dispoAutopilot: { showings: { askInBlast: false } } }, now: NOW });
  assert.match([...off.rows.values()][0].reply, /Want the details\?$/);
  assert.equal(normalizeDispoAutopilot().showings.askAgentOnPromote, false, "texting the agent on its own ships off");
});
