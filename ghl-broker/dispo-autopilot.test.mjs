import test from "node:test";
import assert from "node:assert/strict";
import { queueBlastDrafts, normalizeDispoAutopilot, catchUpDue, catchUpCandidates, startDispoSweep, _resetJobs, resumePulledBack } from "./dispo-autopilot.js";

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

// Matt, 2026-10-20: "Let's make the change where we can edit the text."
test("a wave goes out in the deal text Matt wrote on Autopilot → Investors, rotated per buyer, at the deal's price", async () => {
  const store = fakeStore();
  const saved = { conversationAi: { enabled: true, parties: { investor: { autoSend: { enabled: true, intents: ["blast_open"] } } } },
    dispoAutopilot: { dealTexts: ["Hi {first}, {place} is ours. {numbers}. {close}", "{first}, fresh one: {street}, {price}. {close}"] } };
  await queueBlastDrafts({ store, locationId: "L", offer, investors: buyers, saved, now: NOW, sendsEnabled: true, blastsEnabled: true });
  const drafts = [...store.rows.values()];
  assert.match(drafts[0].reply, /^Hi Ravi, 22018 76th Ave W in Edmonds is ours\. Buyer price 495k, ARV around 640k, rehab about 60k\./);
  assert.match(drafts[1].reply, /^Mei, fresh one: 22018 76th Ave W, 495k\./);
  assert.match(drafts[2].reply, /^Hi Sam, /, "two versions, three buyers: back to the first");
  assert.deepEqual(normalizeDispoAutopilot({}).dealTexts, [], "none saved: the built-in wording");
});

// Matt, 2026-10-01: a stop means nothing goes to them by itself — a deal
// text to a buyer included.
test("a blast to a buyer you stopped the bot on waits as a draft; the rest still go", async () => {
  const store = fakeStore();
  store.listContactEventsSince = async () => [{ type: "drive_stopped", contactId: "i2", at: new Date(NOW - 86400000).toISOString(), data: { reason: "" } }];
  const saved = { conversationAi: { enabled: true, parties: { investor: { autoSend: { enabled: true, intents: ["blast_open"] } } } }, dispoAutopilot: { spreadSec: 60 } };
  const r = await queueBlastDrafts({ store, locationId: "L", offer, investors: buyers, saved, now: NOW, sendsEnabled: true, blastsEnabled: true });
  assert.equal(r.queued, 2);
  assert.equal(r.drafted, 1);
  const mei = [...store.rows.values()].find((d) => d.contactId === "i2");
  assert.equal(mei.status, "draft");
  assert.equal(mei.autoSend.reason, "you stopped the bot on them — it waits for you");
  // A read that fails holds every text rather than guess.
  const broken = fakeStore();
  broken.listContactEventsSince = async () => { throw new Error("db down"); };
  const b = await queueBlastDrafts({ store: broken, locationId: "L", offer, investors: buyers, saved, now: NOW, sendsEnabled: true, blastsEnabled: true });
  assert.equal(b.queued, 0);
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

test("a buyer we found in county records is told where we found them and who we are", async () => {
  // 9311 12th Pl SE (2026-10-08): fifty-one manufactured home owners off the
  // Snohomish parcel roll got "Hey Colby, got 9311 … under contract" from a
  // stranger. Matt: lead with where we found them, and who's writing — without
  // "investor", which the carriers block (2026-10-15).
  const store = fakeStore();
  const saved = { conversationAi: { enabled: true, parties: { investor: { autoSend: { enabled: true, intents: ["blast_open"] } } } } };
  const lake = { id: "o3", address: "9311 12th Pl SE, Lake Stevens, WA 98258", cashAmount: 200000, arv: 370000, repairs: 50000,
    asset: { type: "manufactured", land: "own_lot", by: "you" },
    deal: { stage: "under_contract", contractPrice: 200000, assignmentFee: 18000, investors: [] } };
  await queueBlastDrafts({ store, locationId: "L", offer: lake, now: NOW, sendsEnabled: true, blastsEnabled: true, saved, investors: [
    { contactId: "c1", name: "Colby H", phone: "+12065550101", tags: ["investor", "dispo-source-county", "dispo-type-mobile-home", "dispo-city-arlington", "dispo-region-snohomish"] },
    { contactId: "c2", name: "Kim T", phone: "+12065550102", tags: ["investor", "dispo-source-county", "dispo-asset-sfr", "dispo-city-mill-creek"] },
    { contactId: "c3", name: "Pat R", phone: "+12065550103", tags: ["investor", "dispo-source-county", "dispo-type-mobile-home", "dispo-city-arlington"], lastRepliedAt: "2026-10-01T00:00:00Z" },
  ] });
  const [mh, sfr, talked] = [...store.rows.values()];
  assert.match(mh.reply, /^Hey Colby — saw in the county records you've bought mobile homes around Arlington\. I'm Matt, I fix up houses locally\. Got 9311 12th Pl SE/);
  assert.match(sfr.reply, /^Hey Kim — saw in the county records you've bought houses around Mill Creek\. I'm Matt, I fix up houses locally\. /);
  assert.doesNotMatch(mh.reply + sfr.reply, /investor/i);
  assert.doesNotMatch(talked.reply, /county records/, "a buyer who has written back already knows us");
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

// Several buyers (2026-10-15) asked for deals by email, and a
// buyer with a phone could only ever be texted one.
test("a buyer who asked for deals by email is texted first and emailed too; the email waits for you", async () => {
  const store = fakeStore();
  const saved = { conversationAi: { enabled: true, parties: { investor: { autoSend: { enabled: true, intents: ["blast_open"] } } } } };
  const r = await queueBlastDrafts({ store, locationId: "L", offer, now: NOW, sendsEnabled: true, blastsEnabled: true, saved, investors: [
    { contactId: "k1", name: "Sam B", phone: "+12065550111", email: "sam@example.com", record: { deals_by: "email" } },
    { contactId: "k2", name: "Tag Only", phone: "+12065550112", email: "tag@example.com", tags: ["dispo-deals-by-email"] },
    { contactId: "k3", name: "Back To Text", phone: "+12065550113", email: "t@example.com", tags: ["dispo-deals-by-email"], record: { deals_by: "text" } },
    { contactId: "k4", name: "No Address", phone: "+12065550114", email: "", record: { deals_by: "email" } },
    { contactId: "k5", name: "Never Asked", phone: "+12065550115", email: "n@example.com" },
  ] });
  const drafts = [...store.rows.values()];
  const of = (cid) => drafts.filter((d) => d.contactId === cid).map((d) => d.channel).sort();
  assert.deepEqual(of("k1"), ["email", "sms"], "the text still goes, and the email with it");
  assert.deepEqual(of("k2"), ["email", "sms"], "the GHL tag counts when the record has no answer");
  assert.deepEqual(of("k3"), ["sms"], "the record's 'text' beats the tag");
  assert.deepEqual(of("k4"), ["sms"], "no address to email: the text alone");
  assert.deepEqual(of("k5"), ["sms"], "text is the default");
  const [text, mail] = ["sms", "email"].map((c) => drafts.find((d) => d.contactId === "k1" && d.channel === c));
  assert.equal(text.status, "scheduled");
  assert.equal(mail.status, "draft", "emailed deals still wait for you unless they may send themselves");
  assert.ok(mail.outbound.subject, "an emailed deal has a subject line");
  assert.ok(mail.flags.includes("they asked for deals by email too — the text goes as well"));
  assert.equal(r.rows.filter((x) => x.contactId === "k1").length, 2);

  // Queued again (a second click): each channel replaces its own, nothing doubles.
  await queueBlastDrafts({ store, locationId: "L", offer, now: NOW, sendsEnabled: true, blastsEnabled: true, saved,
    investors: [{ contactId: "k1", name: "Sam B", phone: "+12065550111", email: "sam@example.com", record: { deals_by: "email" } }] });
  const live = [...store.rows.values()].filter((d) => d.contactId === "k1" && d.status !== "superseded").map((d) => d.channel).sort();
  assert.deepEqual(live, ["email", "sms"]);

  // One deal by email for a buyer who asked: the email alone, and a text of it
  // still queued stays queued.
  const one = await queueBlastDrafts({ store, locationId: "L", offer, now: NOW, sendsEnabled: true, blastsEnabled: true, saved,
    investors: [{ contactId: "k5", name: "Never Asked", phone: "+12065550115", email: "n@example.com", channel: "email" }] });
  assert.deepEqual(one.rows.map((x) => x.channel), ["email"]);
  assert.deepEqual([...store.rows.values()].filter((d) => d.contactId === "k5" && d.status !== "superseded").map((d) => d.channel).sort(), ["email", "sms"]);
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

// Matt, 2026-10-21: no waves. The counts, floors and delays are gone; an old
// saved value is dropped on the next save.
test("the wave settings are gone: no count, no score floor, no delay, no waves in all", () => {
  const d = normalizeDispoAutopilot({ autoBlastCount: 25, minMatchScore: 50, secondWaveHours: 48, secondWaveCount: 25, secondWaveMinScore: 35, maxWaves: 3, autoBlastOnPromote: true });
  for (const k of ["autoBlastCount", "minMatchScore", "secondWaveHours", "secondWaveCount", "secondWaveMinScore", "maxWaves"]) assert.equal(k in d, false, k);
  assert.equal(d.autoBlastOnPromote, true);
  assert.equal(normalizeDispoAutopilot({}).autoBlastOnPromote, false, "sending on promote still ships off");
});

test("the morning catch-up sends only to buyers who fit since the first send, and nothing when nobody new does", async () => {
  _resetJobs();
  const at = (h) => new Date(NOW - h * 3600000).toISOString();
  const yesterday = { ...offer, id: "o2", deal: { ...offer.deal, blasts: [{ at: at(20), count: 40, via: "app", wave: 1 }] } };
  const quiet = { ...offer, id: "o3", deal: { ...offer.deal, blasts: [{ at: at(1), via: "app", wave: 1 }] } };
  const done = { ...offer, id: "o4", deal: { ...offer.deal, blasts: [{ at: at(90) }], investors: [{ contactId: "x", status: "committed" }] } };
  const ghlOnly = { ...offer, id: "o7", deal: { ...offer.deal, blastTags: ["dispo-22018-76th-ave-w"], blasts: [] } };
  const closed = { ...offer, id: "o8", deal: { ...offer.deal, stage: "closed", blasts: [{ at: at(200) }] } };
  const store = fakeStore([yesterday, quiet, done, ghlOnly, closed]);
  const c = await catchUpCandidates({ store, locationId: "L" });
  assert.deepEqual(c.map((x) => [x.offer.id, x.send]), [["o2", 2], ["o3", 2]], "no delay: any live deal sent from the app, nobody committed");
  const seen = [];
  const job = startDispoSweep({ locationId: "L", client: {}, saved: { dispoAutopilot: { autoBlastOnPromote: true } }, store, now: NOW, deps: {
    matchForDeal: async (_l, o, opts) => { seen.push(["match", o.id, opts]); return { results: o.id === "o2" ? Array.from({ length: 30 }, (_, k) => ({ contactId: `new${k}` })) : [] }; },
    blastFromApp: async (args) => { seen.push(["blast", args.offer.id, args.investors.length, args.wave]); return { queued: args.investors.length, drafted: 0, scheduled: true }; },
  } });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.deepEqual(seen, [["match", "o2", { exclude: "blasted" }], ["blast", "o2", 30, 2], ["match", "o3", { exclude: "blasted" }]], "all thirty new fits, no cap; nothing for the deal nobody new fits");
  assert.equal(job.blasted, 30);
  assert.equal(job.results.find((r) => r.offerId === "o3").reason, "nobody new fits it");
});

/* ---------- the soft commit ---------- */

// "I think I have a buyer for this one." Nothing is signed, so the deal stays
// live and priced — but we stop putting it in front of anyone new.
test("a soft-committed deal is not picked up by the catch-up, and clearing it lets it run", async () => {
  const blastedAt = new Date(NOW - 50 * 3600000).toISOString();
  const withStatus = (status) => ({
    ...offer, id: "o9",
    deal: { ...offer.deal, blasts: [{ at: blastedAt, count: 10, via: "app" }], investors: [{ contactId: "i1", name: "Dmitriy", status }] },
  });

  const soft = await catchUpCandidates({ store: fakeStore([withStatus("soft_commit")]), locationId: "L", saved: {}, now: NOW });
  assert.deepEqual(soft, [], "the catch-up is new outreach — it waits");

  const back = await catchUpCandidates({ store: fakeStore([withStatus("evaluating")]), locationId: "L", saved: {}, now: NOW });
  assert.deepEqual(back.map((x) => x.offer.id), ["o9"], "nothing was stored, so putting them back resumes it");

  const gone = await catchUpCandidates({ store: fakeStore([withStatus("passed")]), locationId: "L", saved: {}, now: NOW });
  assert.deepEqual(gone.map((x) => x.offer.id), ["o9"], "and so does their passing");
});

// 5232 S Yakima, 2026-10-01: the second wave was due two days after the first
// and nothing but a committed buyer would have held it.
test("a deal you stopped outreach on gets no catch-up, and says why", async () => {
  const blastedAt = new Date(NOW - 50 * 3600000).toISOString();
  const stopped = { ...offer, id: "o11", deal: { ...offer.deal, blasts: [{ at: blastedAt, count: 25, via: "app" }], investors: [], outreachStopped: { at: new Date(NOW - 3600000).toISOString(), by: "you" } } };
  assert.deepEqual(await catchUpCandidates({ store: fakeStore([stopped]), locationId: "L", saved: {}, now: NOW }), []);
  assert.equal(catchUpDue(stopped.deal).why, "you stopped outreach");
  const resumed = { ...stopped, deal: { ...stopped.deal, outreachStopped: undefined } };
  assert.deepEqual((await catchUpCandidates({ store: fakeStore([resumed]), locationId: "L", saved: {}, now: NOW })).map((x) => x.offer.id), ["o11"], "resumed, the catch-up picks it up again");
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

// 9311 12th Pl SE, 2026-10-04: Matt stopped outreach right after the deal was
// made, pressed Resume, and none of the 25 buyers the first wave picked ever
// heard about it. Stop had pulled their texts back, and the next wave still
// counted them as sent.
test("resuming a deal you stopped sends the deal texts Stop pulled back", async () => {
  const store = fakeStore();
  const saved = { conversationAi: { enabled: true, parties: { investor: { autoSend: { enabled: true, intents: ["blast_open"] } } } }, dispoAutopilot: { spreadSec: 60 } };
  const why = "you stopped outreach on 22018 76th Ave W — not sent";
  const blast = (contactId, over = {}) => store.createReplyDraft({ locationId: "L", contactId, contactName: contactId, channel: "sms", party: "investor", status: "dismissed",
    intent: "blast_open", inbound: "", reply: "…", outbound: { kind: "blast_open", offerId: "o1", address: offer.address, label: "dispo-22018-76th-ave-w" }, flags: [why], ...over });
  await blast("i1");
  await blast("i2", { channel: "email" });
  await blast("i3");                                                   // passed since: the wave rules no longer pick them
  await blast("i4", { flags: ["you dismissed it"] });                  // you dismissed it yourself
  await blast("i5", { status: "sent", flags: [] });                    // had it already
  await blast("i5");
  await blast("i6", { outbound: { kind: "blast_open", offerId: "o2", address: "1 Other St" } }); // another deal
  await blast("i7", { status: "superseded", flags: [] });              // re-queued since, and waiting
  await blast("i7", { status: "scheduled", flags: [], sendAt: new Date(NOW + 60000).toISOString() });
  const before = new Set(store.rows.keys());
  const stillFit = [
    { contactId: "i1", name: "Ravi Patel", phone: "+12065550101" },
    { contactId: "i2", name: "Mei Chen", email: "mei@example.com" },
    { contactId: "i4", name: "Sam", phone: "+12065550104" },
    { contactId: "i5", name: "Lee", phone: "+12065550105" },
    { contactId: "i7", name: "Ana", phone: "+12065550107" },
  ];
  const r = await resumePulledBack({ store, locationId: "L", offer, saved, now: NOW, sendsEnabled: true, blastsEnabled: true, startAfterMs: 10 * 60000,
    deps: { eligible: async () => stillFit } });

  assert.equal(r.pulledBack, 3, "i1, i2 and i3 were pulled back by the stop");
  assert.equal(r.dropped, 1, "i3 no longer fits");
  assert.equal(r.queued, 1);
  assert.equal(r.drafted, 1);
  const fresh = [...store.rows.values()].filter((d) => !before.has(d.id));
  assert.deepEqual(fresh.map((d) => d.contactId).sort(), ["i1", "i2"]);
  const ravi = fresh.find((d) => d.contactId === "i1");
  assert.equal(ravi.status, "scheduled", "the text goes again by itself");
  assert.equal(ravi.outbound.label, "dispo-22018-76th-ave-w", "under the wave's own tag");
  assert.ok(Date.parse(ravi.sendAt) >= NOW + 10 * 60000 - 1000, "after the same head start as a new deal");
  const mei = fresh.find((d) => d.contactId === "i2");
  assert.equal(mei.channel, "email");
  assert.equal(mei.status, "draft", "an email waits for you, as it did the first time");
});

// Matt, 2026-10-21: send it all, right away. A deal text no longer waits for
// the buyer's week (2026-10-05) unless holdDealTexts is ticked; it still
// counts as their text, so a check-in after it waits.
test("a deal text isn't held for the weekly limit unless holdDealTexts is on", async () => {
  const twoDaysAgo = new Date(NOW - 2 * 86400000).toISOString();
  const old = { id: "old", contactId: "i1", status: "sent", party: "investor", intent: "blast_open", outbound: { kind: "blast_open", offerId: "o0" }, sentAt: twoDaysAgo, createdAt: twoDaysAgo };
  const saved = { conversationAi: { enabled: true, parties: { investor: { autoSend: { enabled: true, intents: ["blast_open"] } } } }, dispoAutopilot: { spreadSec: 60 } };

  const store = fakeStore();
  store.rows.set("old", old);
  const r = await queueBlastDrafts({ store, locationId: "L", offer, investors: buyers, saved, now: NOW, sendsEnabled: true, blastsEnabled: true });
  assert.equal(r.queued, 3);
  assert.equal(r.waiting, 0, "nobody waits");
  const ravi = [...store.rows.values()].find((d) => d.contactId === "i1" && d.status === "scheduled");
  assert.ok(Date.parse(ravi.sendAt) - NOW < 3600000, "goes today, blasted two days ago or not");
  assert.equal(normalizeDispoAutopilot({}).touchBudget.holdDealTexts, false);

  // Ticked, the deal waits for their week and goes with the next.
  const held = fakeStore();
  held.rows.set("old", old);
  const r2 = await queueBlastDrafts({ store: held, locationId: "L", offer, investors: buyers, saved: { ...saved, dispoAutopilot: { spreadSec: 60, touchBudget: { holdDealTexts: true } } }, now: NOW, sendsEnabled: true, blastsEnabled: true });
  assert.equal(r2.queued, 3, "they keep their seat");
  assert.equal(r2.waiting, 1);
  const waiting = [...held.rows.values()].find((d) => d.contactId === "i1" && d.status === "scheduled");
  assert.ok(Date.parse(waiting.sendAt) >= Date.parse(twoDaysAgo) + 7 * 86400000, waiting.sendAt);
  assert.match(waiting.flags.join(" "), /waits for this buyer's weekly limit/);
});
