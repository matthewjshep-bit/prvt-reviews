import test from "node:test";
import assert from "node:assert/strict";
import { sweepHeldUnderwrites } from "./held-underwrites.js";
import { runConversationAudit } from "./conversation-audit.js";

const NOW = Date.parse("2026-09-17T02:00:00Z");
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const SAVED = { aiApiKey: "k", conversationAi: { version: 2, enabled: true, parties: { agent: { followUp: { enabled: true } } } } };
const THIN = "only 1 priced comps — the price proxy needs 6 to have a top tier";
const PHOTOS = "only 5 listing photos to scan — 8 required for a scope of work";
const held = (over = {}) => ({ id: "h1", locationId: "L", contactId: "c1", contactName: "Helen Hendricks", address: "2500 Alder St, Milton, WA 98354", status: "draft",
  cashAmount: null, createdAt: ago(2), updatedAt: ago(2), autoUnderwrite: { jobId: "j1", held: [THIN], finishedAt: ago(2) }, ...over });

const fakeStore = ({ offers = [], events = [], drafts = [] } = {}) => {
  const rows = [...events]; const book = new Map(offers.map((o) => [o.id, o])); const deleted = []; const updated = [];
  return {
    events: rows, deleted, updated, book,
    async listOffers() { return [...book.values()]; },
    async getOffer(id) { return book.get(id) || null; },
    async updateOffer(id, doc) { book.set(id, doc); updated.push(doc); return doc; },
    async deleteOffer(id) { book.delete(id); deleted.push(id); },
    async listContactEvents(_l, contactId) { return rows.filter((e) => e.contactId === contactId); },
    async listContactEventsSince(_l, since, { types = null } = {}) { return rows.filter((e) => e.at >= since && (!types || types.includes(e.type))); },
    async listReplyDrafts(_l, { contactId = null, status = null } = {}) { return drafts.filter((d) => (!contactId || d.contactId === contactId) && (!status || (Array.isArray(status) ? status.includes(d.status) : d.status === status))); },
    async appendContactEvents(_l, contactId, add) {
      let inserted = 0;
      for (const r of add) { if (r.dedupeKey && rows.some((e) => e.contactId === contactId && e.dedupeKey === r.dedupeKey)) continue; rows.push({ ...r, contactId }); inserted++; }
      return { inserted, skipped: add.length - inserted };
    },
    async getContactProfile() { return null; }, async upsertContactProfile() { return {}; },
    async getJobCursor() { return null; }, async setJobCursor(l, k, v) { return v; },
    async getOfferSettings() { return SAVED; },
  };
};
// A GHL client: tags/opps per contact, pipelines, and a log of notes and tag removals.
const fakeClient = ({ tags = {}, opps = {} } = {}) => {
  const log = [];
  return {
    log,
    async call(path, opts = {}) {
      log.push([opts.method || "GET", path, opts.body]);
      if (path.startsWith("/opportunities/pipelines")) return { pipelines: [{ id: "p1", name: "Acquisitions", stages: [{ id: "s1", name: "Tier 1 - Hot", position: 0 }, { id: "s3", name: "Tier 3- Cold/Keep Warm", position: 2 }] }] };
      if (path.startsWith("/opportunities/search")) { const c = new URL(`http://x${path}`).searchParams.get("contact_id"); return { opportunities: opps[c] || [] }; }
      if (path.startsWith("/contacts/") && path.endsWith("/notes")) return { note: {} };
      if (path.startsWith("/contacts/") && path.includes("/tags")) return {};
      if (path.startsWith("/contacts/")) { const id = path.split("/")[2]; return { contact: { id, tags: tags[id] || [] } }; }
      return {};
    },
  };
};
const deps = (over = {}) => {
  const calls = [];
  return { calls,
    startUnderwrite: async (a) => { calls.push(["underwrite", a.contactId, a.address, a.replaceOfferId, a.askingPrice]); return { job: { id: "u1" } }; },
    startProactive: async (a) => { calls.push(["proactive", a.contactId, a.kind, a.subject?.needs]); return { job: { id: "p1" } }; },
    ...over };
};
const run = (store, client, d, over = {}) => sweepHeldUnderwrites({ client, locationId: "L", saved: SAVED, store, sendsEnabled: true, deps: d, now: NOW, pace: 0, ...over });

test("junk is deleted, a closed conversation is retired with a status and a note, and the review tag comes off", async () => {
  const store = fakeStore({ offers: [
    held({ id: "junk", contactId: "", address: "", autoUnderwrite: { held: ["no property address in the message"] } }),
    held({ id: "h1" }),
  ], drafts: [{ id: "d1", contactId: "c1", status: "sent", inbound: "That property is already pending now.", intent: "rejection", propertyAddress: "2500 Alder St, Milton, WA", createdAt: ago(1) }] });
  const client = fakeClient();
  const d = deps();
  const r = await run(store, client, d);
  assert.deepEqual(store.deleted, ["junk"]);
  const row = store.book.get("h1");
  assert.equal(row.status, "passed");
  assert.match(row.statusNote, /closed out by the nightly sweep — they said "That property is already pending/);
  assert.equal(row.retired.by, "held-sweep");
  assert.ok(store.events.some((e) => e.type === "offer_passed" && e.dedupeKey === "held_retired:h1"));
  assert.ok(client.log.some(([m, p]) => m === "POST" && p === "/contacts/c1/notes"), "a GHL note says why");
  assert.ok(client.log.some(([m, p]) => m === "DELETE" && p.includes("/contacts/c1/tags")), "uw-needs-review comes off");
  assert.deepEqual(r.counts, { held: 2, dropped: 1, retired: 1, reran: 0, asked: 0, waiting: 0, yours: 0 });
  assert.deepEqual(r.findings.map((f) => f.kind), ["held_junk", "held_over"]);
  assert.equal(d.calls.length, 0);
});

test("a cold GHL stage or a bot-off tag retires it as ours; the run is claimed and never repeats", async () => {
  const store = fakeStore({ offers: [held({ id: "h1" }), held({ id: "h2", contactId: "c2", address: "9 Cold Rd, Kent, WA" })] });
  const client = fakeClient({ tags: { c1: ["tier-2", "stop bot"] }, opps: { c2: [{ id: "o", pipelineStageId: "s3", status: "open" }] } });
  const r = await run(store, client, deps());
  assert.equal(store.book.get("h1").status, "we_passed");
  assert.match(store.book.get("h1").statusNote, /stop bot/);
  assert.match(store.book.get("h2").statusNote, /GHL stage: Tier 3/);
  assert.equal(r.counts.retired, 2);
});

test("their numbers after the hold re-run it through startUnderwrite with replaceOfferId, once; the ask goes out as take_ask, once", async () => {
  const store = fakeStore({
    offers: [held({ id: "h1", askingPrice: 150000 }), held({ id: "h2", contactId: "c2", contactName: "Nicole", address: "13025 Ambaum Blvd SW, Burien, WA", autoUnderwrite: { held: [THIN, PHOTOS], finishedAt: ago(1) }, createdAt: ago(1) })],
    events: [{ contactId: "c1", type: "agent_estimate", address: "2500 Alder St, Unit 15, Milton, WA 98354", at: ago(1), data: { arv: 165000, rehab: 0 } }],
    drafts: [{ id: "d2", contactId: "c2", status: "sent", inbound: "It has a lot of potential", intent: "small_talk", propertyAddress: "13025 Ambaum Blvd SW, Burien, WA", createdAt: ago(0.5) }],
  });
  const client = fakeClient();
  const d = deps();
  const r = await run(store, client, d);
  assert.deepEqual(d.calls, [["underwrite", "c1", "2500 Alder St, Milton, WA 98354", "h1", 150000], ["proactive", "c2", "take_ask", ["value", "work"]]]);
  assert.equal(r.counts.reran, 1); assert.equal(r.counts.asked, 1);
  assert.ok(store.events.filter((e) => e.type === "audit_action").length === 2, "both claimed");
  // Tomorrow: the estimate is the same, the ask was made — nothing starts twice.
  const again = await run(store, client, d, { now: NOW + 86400000 });
  assert.equal(d.calls.length, 2);
  assert.ok(again.acted.every((a) => a.status === "claimed"), JSON.stringify(again.acted));
  assert.equal(again.counts.waiting, 1, "the ask on the timeline is what makes the next night wait on them");
});

test("a dry run reads and reports but deletes, writes and starts nothing; a structural hold is yours", async () => {
  const store = fakeStore({ offers: [held({ id: "h1", autoUnderwrite: { held: ["the photo scan flagged a possible foundation or structural problem"], finishedAt: ago(1) } }), held({ id: "j", contactId: "", address: "" })] });
  const d = deps();
  const r = await run(store, fakeClient(), d, { dryRun: true });
  assert.equal(store.deleted.length, 0); assert.equal(store.events.length, 0); assert.equal(d.calls.length, 0);
  assert.deepEqual(r.findings.map((f) => f.kind).sort(), ["held_junk", "held_yours"]);
  assert.equal(r.counts.yours, 1);
  assert.equal(r.reason, "dry run");
});

test("the nightly audit carries the held pass: its findings, counts and rows ride on the same result", async () => {
  const store = fakeStore({ offers: [held({ id: "j", contactId: "", address: "" })] });
  const d = deps({ ghlLastMessages: async () => new Map(), latestInbound: async () => null, startReply: async () => ({ job: { id: "x" } }), startFollowUpSweep: () => ({ id: "f" }) });
  const { result, acted } = await runConversationAudit({ client: fakeClient(), locationId: "L", saved: SAVED, store, sendsEnabled: true, deps: d, now: NOW, pace: 0 });
  assert.equal(result.counts.held.dropped, 1);
  assert.equal(result.counts.byKind.held_junk, 1);
  assert.equal(acted[0].action, "drop_draft");
  assert.deepEqual(store.deleted, ["j"]);
});
