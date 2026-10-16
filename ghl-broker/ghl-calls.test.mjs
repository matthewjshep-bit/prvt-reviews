// ghl-calls.test.mjs — Today's calls into GHL's Manual Actions (ghl-calls.js).
//
// Matt, 2026-10-15: he dials from GHL's Manual Actions queue on his computer,
// so the day's calls go there at 8:30 and the urgent ones as they turn up.
// The app fills two contact fields and puts the contact in his one-step
// workflow; it never texts anyone.
//
//   node --test ghl-calls.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ghl-calls-test-"));
process.env.DATA_DIR = DIR;
delete process.env.DATABASE_URL;

const { store } = await import("./store.js");
const { runGhlCalls, CURSOR_NAME, maybeRunGhlCalls, ghlCallsSettled } = await import("./ghl-calls.js");
const { foldDesk, urgentReasons } = await import("./shared/desk.js");
const { liveGhlQueues, GHL_CALL_EVENT_TYPES } = await import("./shared/ghl-calls.js");
await store.init();
// After the store's last write (it waits 50ms), so nothing writes into a removed folder.
test.after(async () => { await new Promise((r) => setTimeout(r, 120)); fs.rmSync(DIR, { recursive: true, force: true }); });

// Thursday 2026-10-15, 9:00am Pacific.
const NOW = Date.parse("2026-10-15T16:00:00Z");
const H = 3600000;
const ago = (h) => new Date(NOW - h * H).toISOString();
const WF = "7f1c2a9e-0b3d-4e5f-8a6b-1c2d3e4f5a6b";
const ON = { desk: { ghlCalls: { enabled: true, workflowId: `https://app.gohighlevel.com/location/loc/workflow/${WF}` } } };

const brief = (why, opener) => ({ why, goal: "Land a number.", opener, houses: [], tries: 0, since: ago(5) });
// Today's reasons, as the pipeline and the call list make them.
const REASONS = {
  jo: { id: "call_owed:jo", kind: "call_owed", section: "call", score: 110, contactId: "jo", contactName: "Jo Agent", address: "4 Oak Ave, Kent, WA", title: "Owed: a call to Jo on 4 Oak Ave", call: brief("we said we'd call them", "Hi Jo, it's Matt — calling like I said I would.") },
  dana: { id: "call_hot:o1", kind: "call_hot", section: "call", score: 100, contactId: "dana", contactName: "Dana Agent", offerId: "o1", address: "12 Elm St, Kent, WA", title: "Dana Agent: 12 Elm St is hot", call: brief("12 Elm St is hot at 300K — get it on paper", "Hi Dana, it's Matt — on 12 Elm St, are we close at 300K?") },
  eli: { id: "call_first_reply:eli", kind: "call_first_reply", section: "call", score: 70, contactId: "eli", contactName: "Eli Agent", title: "Eli Agent: first reply", call: brief("first reply — reads as a flip", "Hi Eli, it's Matt — thanks for getting back to me.") },
  fay: { id: "call_partner:fay", kind: "call_partner", section: "call", score: 30, contactId: "fay", contactName: "Fay Agent", title: "Fay Agent: you've done business", call: brief("you've done business; 40 days since you last spoke", "Hi Fay, it's Matt — been a few weeks.") },
  gus: { id: "call_counter:o2", kind: "call_counter", section: "call", score: 90, contactId: "gus", contactName: "Gus Agent", offerId: "o2", address: "9 Pine Rd, Auburn, WA", title: "Gus Agent: countered", call: brief("countered 315K on 9 Pine Rd against our 300K — 5% apart, a call lands it", "Hi Gus, it's Matt — got your 315K on 9 Pine Rd.") },
  hal: { id: "draft_waiting:d1", kind: "draft_waiting", contactId: "hal", contactName: "Hal Agent", draftId: "d1", address: "77 Birch Ln, Renton, WA", title: "Hal Agent: wants call", severity: "now", group: "yours" },
  ivy: { id: "promise_owed:ivy", kind: "promise_owed", contactId: "ivy", contactName: "Ivy Agent", title: "Owed: an answer to Ivy", severity: "now", group: "yours" },
  kim: { id: "call_missed:o3", kind: "call_missed", section: "call", score: 105, contactId: "kim", contactName: "Kim Agent", offerId: "o3", address: "1 Ash Ct, Kent, WA", title: "Kim Agent: they called you", call: brief("they called you and it wasn't picked up", "Hi Kim, it's Matt, sorry I missed your call.") },
};
const DRAFTS = [{ id: "d1", contactId: "hal", contactName: "Hal Agent", intent: "wants_call", status: "draft", party: "agent", propertyAddress: "77 Birch Ln, Renton, WA" }];
const PHONES = { jo: "+12065550101", dana: "+12065550102", eli: "+12065550103", fay: "+12065550104", gus: "+12065550105", hal: "+12065550106", ivy: "+12065550107" };

// Today's read the way routes/dashboard.js pipelineFor hands it over.
// Today's calls are the best four (dailyCalls); the Desk shows four calls before "N more" (callCap).
function pipelineFor({ who = Object.keys(REASONS), events = [{ type: "text_summary", contactId: "zed", at: ago(30) }], dailyCalls = 4, callCap = 4 } = {}) {
  const reasons = who.map((k) => REASONS[k]);
  const shownCalls = reasons.filter((r) => String(r.kind).startsWith("call_") && r.kind !== "call_owed");
  const shownActions = reasons.filter((r) => !shownCalls.includes(r));
  const desk = foldDesk(urgentReasons([...shownActions, ...shownCalls], { drafts: DRAFTS, dailyCalls }), { drafts: DRAFTS, callCap });
  return async () => ({ desk, deskAll: desk, drafts: DRAFTS, shownActions, shownCalls, events });
}

// GHL, recorded: contact reads, custom fields, contact updates, workflows.
function ghl({ phones = PHONES, failAdd = new Set() } = {}) {
  const calls = [];
  const defs = [];
  return {
    calls,
    of: (method, rx) => calls.filter((c) => c.method === method && rx.test(c.path)),
    call: async (p, { method = "GET", body } = {}) => {
      calls.push({ method, path: p, body });
      if (method === "GET" && /^\/contacts\/[^/]+$/.test(p)) { const id = p.split("/")[2]; return { contact: { id, phone: phones[id] || "" } }; }
      if (/\/customFields$/.test(p)) {
        if (method === "GET") return { customFields: defs };
        const f = { id: `cf-${defs.length + 1}`, name: body.name, fieldKey: `contact.${body.name.toLowerCase().replace(/\s+/g, "_")}`, dataType: body.dataType };
        defs.push(f);
        return { customField: f };
      }
      if (/\/workflow\//.test(p)) {
        const id = p.split("/")[2];
        if (method === "POST" && failAdd.has(id)) throw Object.assign(new Error(`GHL POST ${p} -> 500 {"message":"workflow unavailable"}`), { status: 500 });
        return { succeeded: true };
      }
      if (method === "PUT") return { contact: {} };
      return {};
    },
  };
}
const ledger = (loc) => store.listContactEventsSince(loc, ago(48), { types: GHL_CALL_EVENT_TYPES, limit: 500 });
const enrolled = (client) => client.of("POST", /\/workflow\//).map((c) => c.path.split("/")[2]).sort();

test("the morning sends the day's calls and the urgent ones to GHL, and never a call waiting behind the list", async () => {
  const LOC = "loc-morning";
  const client = ghl();
  const r = await runGhlCalls({ store, locationId: LOC, client, saved: ON, deps: { pipelineFor: pipelineFor() }, mode: "morning", now: NOW, trigger: "daily" });
  assert.equal(r.error, null);
  // Today's calls (the call we owe leads, so the fourth of the day's best waits behind "N more"), the counter, the agent asking to talk.
  assert.deepEqual(enrolled(client), ["dana", "eli", "gus", "hal", "jo"]);
  assert.ok(!enrolled(client).includes("fay"), "a call past the day's cap isn't one of today's");
  assert.ok(!enrolled(client).includes("ivy"), "a promise of an answer isn't a call");
  assert.ok(r.skipped.some((s) => s.contactId === "kim" && /no phone/.test(s.why)), "no phone in GHL: it stays on Today");
  // Every enroll is into the pasted workflow, by id.
  assert.ok(client.of("POST", /\/workflow\//).every((c) => c.path.endsWith(`/workflow/${WF}`)));
  // The two fields were made once, named so GHL keys them contact.app_call_why / contact.app_call_say.
  const made = client.of("POST", /\/customFields$/).map((c) => c.body);
  assert.deepEqual(made.map((b) => [b.name, b.dataType, b.model]), [["App call why", "TEXT", "contact"], ["App call say", "TEXT", "contact"]]);
  // Dana's fields: what the call is about, and what to say.
  const put = client.of("PUT", /^\/contacts\/dana$/)[0];
  assert.deepEqual(put.body.customFields.map((f) => f.id), ["cf-1", "cf-2"]);
  assert.match(put.body.customFields[0].value, /12 Elm St is hot at 300K — get it on paper\. Land a number\./);
  assert.equal(put.body.customFields[1].value, "Hi Dana, it's Matt — on 12 Elm St, are we close at 300K?");
  assert.ok(put.body.customFields.every((f) => f.value.length <= 300));
  // The held reply asking for a call has no brief: its fields say so plainly.
  const hal = client.of("PUT", /^\/contacts\/hal$/)[0];
  assert.match(hal.body.customFields[0].value, /^They asked for a call about 77 Birch Ln/);
  // Each person is claimed on their timeline, once for the day; Kim was never claimed.
  const ev = await ledger(LOC);
  assert.deepEqual(ev.filter((e) => e.type === "ghl_call_queued").map((e) => e.contactId).sort(), ["dana", "eli", "gus", "hal", "jo"]);
  const dana = ev.find((e) => e.contactId === "dana");
  assert.equal(dana.dedupeKey, "ghl_call:dana:2026-10-15");
  assert.equal(dana.data.kind, "call_hot");
  assert.equal(dana.data.workflowId, WF);
  // Nothing was texted.
  assert.equal(client.calls.filter((c) => /conversations\/messages/.test(c.path)).length, 0);
  // The field ids are kept on the job cursor.
  const cur = await store.getJobCursor(LOC, CURSOR_NAME);
  assert.deepEqual(cur.doc.fields, { why: "cf-1", say: "cf-2" });
});

test("a second run the same day sends nobody twice, and doesn't look the fields up again", async () => {
  const LOC = "loc-twice";
  const first = ghl();
  await runGhlCalls({ store, locationId: LOC, client: first, saved: ON, deps: { pipelineFor: pipelineFor() }, mode: "morning", now: NOW });
  const again = ghl();
  const r = await runGhlCalls({ store, locationId: LOC, client: again, saved: ON, deps: { pipelineFor: pipelineFor() }, mode: "morning", now: NOW + H });
  assert.equal(r.queued.length, 0);
  assert.equal(enrolled(again).length, 0);
  assert.equal(again.of("GET", /^\/contacts\//).length, 0, "already claimed: GHL isn't even asked");
  assert.ok(r.skipped.filter((s) => s.why === "already in GHL today").length >= 5);
});

test("by day only the urgent ones go: a call we owe, a counter, someone asking to talk", async () => {
  const LOC = "loc-urgent";
  const client = ghl();
  const r = await runGhlCalls({ store, locationId: LOC, client, saved: ON, deps: { pipelineFor: pipelineFor() }, mode: "urgent", now: NOW });
  assert.deepEqual(enrolled(client), ["gus", "hal", "jo"]);
  assert.ok(r.queued.every((q) => q.urgent));
});

test("a contact GHL has no phone for is never claimed and stays on Today", async () => {
  const LOC = "loc-nophone";
  const client = ghl({ phones: { ...PHONES, gus: "" } });
  const r = await runGhlCalls({ store, locationId: LOC, client, saved: ON, deps: { pipelineFor: pipelineFor({ who: ["gus"] }) }, mode: "urgent", now: NOW });
  assert.equal(r.queued.length, 0);
  assert.equal(enrolled(client).length, 0);
  assert.equal(client.of("PUT", /^\/contacts\//).length, 0);
  assert.equal((await ledger(LOC)).length, 0, "no claim, so the Desk keeps the row");
});

test("a GHL failure is a durable error, and the call stays on Today", async () => {
  const LOC = "loc-fail";
  const client = ghl({ failAdd: new Set(["dana"]) });
  const r = await runGhlCalls({ store, locationId: LOC, client, saved: ON, deps: { pipelineFor: pipelineFor({ who: ["dana", "eli"] }) }, mode: "morning", now: NOW });
  assert.deepEqual(r.failed.map((f) => f.contactId), ["dana"]);
  assert.deepEqual(r.queued.map((q) => q.contactId), ["eli"], "one failure doesn't stop the rest");
  const ev = await ledger(LOC);
  const failed = ev.find((e) => e.type === "ghl_call_failed");
  assert.equal(failed.contactId, "dana");
  assert.equal(failed.data.claimKey, "ghl_call:dana:2026-10-15");
  assert.equal(failed.data.failed, true);
  assert.match(failed.data.error, /500/);
  assert.deepEqual([...liveGhlQueues(ev).keys()], ["eli"], "Dana's call isn't in GHL, so Today keeps it");
  const errors = await store.listAppErrorsSince(LOC, ago(48));
  assert.ok(errors.some((e) => e.area === "ghl-calls"), "recorded where the morning's errors are read");
  assert.ok(errors.every((e) => !/\+1206555/.test(e.message)), "no phone number in the error");
});

test("a call whose row is gone, with nobody calling, is taken back out of GHL", async () => {
  const LOC = "loc-withdraw";
  await runGhlCalls({ store, locationId: LOC, client: ghl(), saved: ON, deps: { pipelineFor: pipelineFor({ who: ["dana", "eli"] }) }, mode: "morning", now: NOW });
  // Two hours on, neither row is on the Desk. Eli was called (no answer); Dana's reason went by itself.
  const rang = { type: "call_attempt", contactId: "eli", at: new Date(NOW + H).toISOString(), data: { outcome: "no_answer", direction: "outbound" } };
  const later = ghl();
  const r = await runGhlCalls({ store, locationId: LOC, client: later, saved: ON, deps: { pipelineFor: pipelineFor({ who: [], events: [rang] }) }, mode: "urgent", now: NOW + 2 * H });
  assert.deepEqual(r.withdrawn.map((w) => w.contactId), ["dana"]);
  assert.deepEqual(later.of("DELETE", /\/workflow\//).map((c) => c.path), [`/contacts/dana/workflow/${WF}`]);
  const ev = await ledger(LOC);
  assert.ok(ev.some((e) => e.type === "ghl_call_withdrawn" && e.contactId === "dana" && e.data.claimKey === "ghl_call:dana:2026-10-15"));
  assert.deepEqual([...liveGhlQueues(ev).keys()], ["eli"], "Eli's call was worked; it stays as it is");
  // Run again: nothing more to take back.
  const third = ghl();
  const r3 = await runGhlCalls({ store, locationId: LOC, client: third, saved: ON, deps: { pipelineFor: pipelineFor({ who: [], events: [rang] }) }, mode: "urgent", now: NOW + 3 * H });
  assert.equal(r3.withdrawn.length, 0);
  assert.equal(third.of("DELETE", /\/workflow\//).length, 0);
});

test("a call still standing, only pushed down the list, stays in GHL", async () => {
  const LOC = "loc-outranked";
  await runGhlCalls({ store, locationId: LOC, client: ghl(), saved: ON, deps: { pipelineFor: pipelineFor({ who: ["eli"] }) }, mode: "morning", now: NOW });
  // Three better calls arrive; Eli's row is past the day's three but his reason stands.
  const later = ghl();
  const r = await runGhlCalls({ store, locationId: LOC, client: later, saved: ON, deps: { pipelineFor: pipelineFor({ who: ["dana", "gus", "jo", "kim", "eli"], dailyCalls: 2 }) }, mode: "urgent", now: NOW + H });
  assert.equal(r.withdrawn.length, 0);
  assert.equal(later.of("DELETE", /\/workflow\//).length, 0);
});

test("a read that came back empty takes nothing back", async () => {
  const LOC = "loc-shortread";
  await runGhlCalls({ store, locationId: LOC, client: ghl(), saved: ON, deps: { pipelineFor: pipelineFor({ who: ["dana"] }) }, mode: "morning", now: NOW });
  const later = ghl();
  const r = await runGhlCalls({ store, locationId: LOC, client: later, saved: ON, deps: { pipelineFor: pipelineFor({ who: [], events: [] }) }, mode: "urgent", now: NOW + H });
  assert.equal(r.withdrawn.length, 0);
  assert.equal(later.of("DELETE", /\/workflow\//).length, 0);
});

test("the next workday a call still due goes back in once, with that day's words", async () => {
  const LOC = "loc-nextday";
  await runGhlCalls({ store, locationId: LOC, client: ghl(), saved: ON, deps: { pipelineFor: pipelineFor({ who: ["dana"] }) }, mode: "morning", now: NOW });
  const friday = ghl();
  await runGhlCalls({ store, locationId: LOC, client: friday, saved: ON, deps: { pipelineFor: pipelineFor({ who: ["dana"] }) }, mode: "morning", now: NOW + 24 * H });
  // Out of yesterday's Manual Action first, so GHL holds one for her.
  assert.deepEqual(friday.calls.filter((c) => /\/workflow\//.test(c.path)).map((c) => c.method), ["DELETE", "POST"]);
  const ev = await ledger(LOC);
  assert.deepEqual(ev.filter((e) => e.type === "ghl_call_queued").map((e) => e.dedupeKey).sort(), ["ghl_call:dana:2026-10-15", "ghl_call:dana:2026-10-16"]);
});

test("switched off, nothing goes; a dry run lists who would and writes nothing", async () => {
  const LOC = "loc-off";
  const off = ghl();
  const r = await runGhlCalls({ store, locationId: LOC, client: off, saved: {}, deps: { pipelineFor: pipelineFor() }, mode: "morning", now: NOW });
  assert.match(r.error, /off/);
  assert.equal(off.calls.length, 0);
  const dry = ghl();
  const d = await runGhlCalls({ store, locationId: LOC, client: dry, saved: {}, deps: { pipelineFor: pipelineFor() }, mode: "morning", now: NOW, dryRun: true });
  assert.deepEqual(d.queued.map((q) => q.contactId).sort(), ["dana", "eli", "gus", "hal", "jo"]);
  assert.ok(d.queued.every((q) => q.status === "would go to GHL" && q.why && q.say));
  assert.equal(dry.calls.filter((c) => c.method !== "GET").length, 0, "reads only");
  assert.equal((await ledger(LOC)).length, 0);
});

/* ---------- the tick ---------- */

const at = (isoZ) => Date.parse(isoZ);
const tick = async (LOC, now, { saved = ON, client = ghl(), who } = {}) => {
  const r = await maybeRunGhlCalls({ client, locationId: LOC, saved, store, deps: { pipelineFor: pipelineFor(who ? { who } : {}) }, now });
  await ghlCallsSettled(LOC);
  return { r, client, cursor: (await store.getJobCursor(LOC, CURSOR_NAME))?.doc || {} };
};

test("the tick sends the day's list from 8:30 Pacific on a workday, then only the urgent ones until 5pm", async () => {
  const LOC = "loc-tick";
  assert.equal((await tick(LOC, at("2026-10-15T15:15:00Z"))).r, null, "8:15am: not yet");
  const morning = await tick(LOC, at("2026-10-15T15:30:00Z"));
  assert.deepEqual(morning.r, { mode: "morning" });
  assert.equal(enrolled(morning.client).length, 5);
  assert.equal(morning.cursor.day, "2026-10-15");
  assert.equal(morning.cursor.tries, 1);
  assert.equal(morning.cursor.run, null, "the run comes off the cursor when it's done");
  assert.equal(morning.cursor.last.mode, "morning");
  assert.equal(morning.cursor.last.queued.length, 5);
  assert.ok(morning.cursor.last.queued.every((q) => !("why" in q) && !("say" in q)), "the cursor keeps who, not the words");
  const later = await tick(LOC, at("2026-10-15T17:45:00Z"));
  assert.deepEqual(later.r, { mode: "urgent" });
  assert.equal(later.cursor.tries, 1, "the morning isn't run twice");
  assert.equal(later.cursor.urgent.last.mode, "urgent");
  assert.equal((await tick(LOC, at("2026-10-16T00:15:00Z"))).r, null, "5:15pm: done for the day");
  assert.equal((await tick(LOC, at("2026-10-17T16:00:00Z"))).r, null, "Saturday: nothing");
  assert.deepEqual((await tick(LOC, at("2026-10-17T16:00:00Z"), { saved: { desk: { ghlCalls: { ...ON.desk.ghlCalls, weekdaysOnly: false } } } })).r, { mode: "morning" }, "unless weekends are on");
});

test("the tick does nothing while it's off or has no workflow", async () => {
  assert.equal((await tick("loc-tick-off", at("2026-10-15T16:00:00Z"), { saved: {} })).r, null);
  assert.equal((await tick("loc-tick-off", at("2026-10-15T16:00:00Z"), { saved: { desk: { ghlCalls: { enabled: true } } } })).r, null);
  assert.equal(await store.getJobCursor("loc-tick-off", CURSOR_NAME), null);
});

test("a morning a deploy killed is run again once it's stale, and the day's tries are capped", async () => {
  const LOC = "loc-tick-stale";
  await store.setJobCursor(LOC, CURSOR_NAME, { at: "2026-10-15T16:00:00Z", doc: { day: "2026-10-15", tries: 1, lastDaily: "2026-10-15T16:00:00Z", run: { startedAt: "2026-10-15T16:00:00Z" } } });
  assert.equal((await tick(LOC, at("2026-10-15T16:15:00Z"))).r, null, "fifteen minutes in, it may still be going");
  const retry = await tick(LOC, at("2026-10-15T16:45:00Z"));
  assert.deepEqual(retry.r, { mode: "morning" });
  assert.equal(retry.cursor.tries, 2);
  assert.equal(retry.cursor.staleRun.startedAt, "2026-10-15T16:00:00Z");
  const LOC2 = "loc-tick-capped";
  await store.setJobCursor(LOC2, CURSOR_NAME, { at: "2026-10-15T17:00:00Z", doc: { day: "2026-10-15", tries: 4, failed: true, lastDaily: "2026-10-15T17:00:00Z" } });
  const capped = await tick(LOC2, at("2026-10-15T18:00:00Z"));
  assert.deepEqual(capped.r, { mode: "urgent" }, "four tries: the urgent ones still go");
  assert.equal(capped.cursor.tries, 4);
});

