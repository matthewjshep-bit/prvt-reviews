// investor-read.test.mjs — "In their words" on Dispositions: what each
// investor told us about how they buy, read from their thread and kept.
//
// What went wrong (2026-11-02): 619 of the 2,786 buyers in the book had
// written back or talked on the phone, and 155 had a buy box on file. What
// the rest had said was only in the threads. These cover the runner (who is
// read, when, and what a read costs), the routes the page and the backfill
// use, and that a read never changes the buy box deals go out on by itself.
//
//   node --test investor-read.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "investor-read-test-"));
delete process.env.DATABASE_URL;

const { store } = await import("./store.js");
const { readInvestor, planReads, startInvestorReads, getReadJob, maybeRunInvestorReads, normalizeInvestorReads, _resetJobs, CURSOR_NAME } = await import("./investor-read.js");
const { normalizeDispoAutopilot } = await import("./dispo-autopilot.js");
const { default: createDispoRouter } = await import("./routes/dispo.js");

const LOC = "LOC-READS";
const app = express();
app.use(express.json({ limit: "5mb" }));
app.use("/api/dispo", createDispoRouter({ resolveLocation: () => ({ locationId: LOC, client: null }) }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/dispo`;
test.after(() => server.close());
const get = async (p) => (await fetch(`${base}${p}`)).json();
const post = async (p, body) => (await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

async function investor(contactId, doc = {}) {
  await store.upsertInvestors(LOC, [{ contactId, name: `Buyer ${contactId}`, doc: { name: `Buyer ${contactId}`, tags: ["investor"], custom: {}, ...doc }, buyboxText: "" }]);
}
const thread = (contactId, body, at = "2026-08-01T17:05:00.000Z") => ({
  contactId,
  messages: [
    { id: `${contactId}-1`, at: "2026-08-01T17:00:00.000Z", dir: "us", channel: "sms", body: "What do you buy?" },
    ...(body ? [{ id: `${contactId}-2`, at, dir: "them", channel: "sms", body }] : []),
  ],
});
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 10)); } return false; };

test("a read keeps their words and the columns, and leaves the buy box deals go out on alone", async () => {
  await investor("r1", { talk: { replies: 2, calls: 0 }, lastMessageAt: "2026-08-01T17:05:00.000Z" });
  const r = await readInvestor({
    locationId: LOC, contactId: "r1", store,
    deps: {
      readThread: async () => thread("r1", "Only Tacoma, cash up to 400k."),
      read: async () => ({ summary: "Tacoma cash buyer", fields: { areas: ["Tacoma"], price_max: 400000, funding: ["cash"] }, quotes: [{ ref: "m2", text: "Only Tacoma, cash up to 400k.", about: ["areas"] }, { ref: "m2", text: "invented", about: [] }] }),
    },
  });
  assert.equal(r.status, "read");
  const stored = await store.getInvestorRead(LOC, "r1");
  assert.equal(stored.doc.quotes.length, 1);
  assert.equal(stored.doc.fields.price_max, 400000);
  assert.equal(stored.throughAt, "2026-08-01T17:05:00.000Z");
  // Nothing filed on the contact record: the buy box is a person's press.
  assert.equal((await store.getContactProfile?.(LOC, "r1").catch(() => null))?.facts?.buybox_areas, undefined);
});

test("a thread with nothing in their words is stored as read without a model call", async () => {
  await investor("r2", { talk: { replies: 1, calls: 0 } });
  let asked = 0;
  const r = await readInvestor({ locationId: LOC, contactId: "r2", store, deps: { readThread: async () => thread("r2", ""), read: async () => { asked++; return {}; } } });
  assert.equal(r.status, "empty");
  assert.equal(asked, 0);
  assert.ok(await store.getInvestorRead(LOC, "r2"));
});

test("without an AI key nothing is read", async () => {
  await assert.rejects(readInvestor({ locationId: LOC, contactId: "r1", store, saved: {}, deps: { readThread: async () => thread("r1", "Only Tacoma") } }), /no AI key/);
});

test("who is due: never read, or their thread moved past the read; never someone who never wrote back", async () => {
  await investor("p-new", { talk: { replies: 1, calls: 0 }, lastMessageAt: "2026-09-02T00:00:00.000Z" });
  await investor("p-moved", { talk: { replies: 3, calls: 1 }, lastMessageAt: "2026-10-01T00:00:00.000Z" });
  await investor("p-same", { talk: { replies: 3, calls: 0 }, lastMessageAt: "2026-08-01T17:05:00.000Z" });
  await investor("p-silent", { talk: { replies: 0, calls: 0 }, lastMessageAt: "2026-10-01T00:00:00.000Z" });
  await store.upsertInvestorRead(LOC, "p-moved", { through: "2026-08-01T00:00:00.000Z", readAt: "2026-08-02T00:00:00.000Z", quotes: [], fields: {} });
  await store.upsertInvestorRead(LOC, "p-same", { through: "2026-08-01T17:05:00.000Z", readAt: "2026-08-02T00:00:00.000Z", quotes: [], fields: {} });
  const plan = await planReads({ store, locationId: LOC });
  const why = Object.fromEntries(plan.map((p) => [p.contactId, p.why]));
  assert.equal(why["p-new"], "never_read");
  assert.equal(why["p-moved"], "moved");
  assert.equal(why["p-same"], undefined);
  assert.equal(why["p-silent"], undefined);
  // Most recently active first, and a limit takes the head of that.
  assert.equal(plan[0].contactId, "p-moved");
  assert.equal((await planReads({ store, locationId: LOC, limit: 1 })).length, 1);
  // Asked for by name: read again whatever its state.
  assert.deepEqual((await planReads({ store, locationId: LOC, contactIds: ["p-same"] })).map((p) => p.why), ["asked"]);
});

test("a run reads the due threads, and one thread failing doesn't stop the rest", async () => {
  _resetJobs();
  await investor("j-ok", { talk: { replies: 1, calls: 0 }, lastMessageAt: "2026-10-05T00:00:00.000Z" });
  await investor("j-bad", { talk: { replies: 1, calls: 0 }, lastMessageAt: "2026-10-06T00:00:00.000Z" });
  const job = startInvestorReads({
    locationId: LOC, store, contactIds: ["j-ok", "j-bad"], pace: 0,
    deps: {
      readThread: async (_c, _l, id) => { if (id === "j-bad") throw Object.assign(new Error("GHL 502"), { status: 502 }); return thread(id, "Flips in Everett"); },
      read: async () => ({ summary: "Everett flipper", fields: { areas: ["Everett"] }, quotes: [{ ref: "m2", text: "Flips in Everett", about: ["areas"] }] }),
    },
  });
  assert.ok(await until(() => getReadJob(LOC)?.status === "done"));
  assert.equal(job.read, 1);
  assert.equal(job.failed, 1);
  assert.deepEqual(job.failures, [{ contactId: "j-bad", status: 502 }]);
});

test("the nightly re-read ships off, and runs once in its hour when on", async () => {
  _resetJobs();
  assert.deepEqual(normalizeInvestorReads(), { enabled: false, hour: 5, maxPerRun: 150 });
  // A saved settings round trip keeps it (the normaliser drops keys it doesn't know).
  assert.deepEqual(normalizeDispoAutopilot({ reads: { enabled: true, hour: 6, maxPerRun: 40 } }).reads, { enabled: true, hour: 6, maxPerRun: 40 });
  const five = Date.parse("2026-11-03T13:10:00.000Z"); // 5:10am Pacific
  const deps = { readThread: async (_c, _l, id) => thread(id, ""), read: async () => ({}) };
  assert.equal(await maybeRunInvestorReads({ locationId: LOC, saved: {}, store, deps, now: five }), false);
  const on = { dispoAutopilot: { reads: { enabled: true } } };
  assert.equal(await maybeRunInvestorReads({ locationId: LOC, saved: on, store, deps, now: Date.parse("2026-11-03T20:00:00.000Z") }), false); // noon
  assert.equal(await maybeRunInvestorReads({ locationId: LOC, saved: on, store, deps, now: five }), true);
  assert.ok((await store.getJobCursor(LOC, CURSOR_NAME)).doc.lastDaily);
  assert.ok(await until(() => getReadJob(LOC)?.status === "done"));
  assert.equal(await maybeRunInvestorReads({ locationId: LOC, saved: on, store, deps, now: five + 30 * 60000 }), false); // already ran today
  // No key and no stub: the night does nothing rather than fail every thread.
  assert.equal(await maybeRunInvestorReads({ locationId: LOC, saved: on, store, now: five + 86400000 }), false);
});

test("the backfill loads through import: a dry run counts, only contacts in the book are taken", async () => {
  await investor("imp1", { talk: { replies: 4, calls: 1 } });
  const reads = [
    { contactId: "imp1", read: { summary: "Builder in Ballard", fields: { strategies: ["new_construction"], areas: ["Ballard"] }, quotes: [{ text: "We build in Ballard, lots over 5000", at: "2026-09-10T18:00:00.000Z", channel: "call", about: ["areas", "lot_min"] }], through: "2026-09-10T18:00:00.000Z", readAt: "2026-11-02T12:00:00.000Z" } },
    { contactId: "not-in-book", read: { summary: "x", fields: {}, quotes: [] } },
  ];
  const dry = await post("/reads/import", { reads, by: "backfill:2026-11-02" });
  assert.deepEqual([dry.dryRun, dry.saved, dry.notInBook, dry.withWords], [true, 1, 1, 1]);
  assert.equal(await store.getInvestorRead(LOC, "imp1"), null);
  const live = await post("/reads/import", { reads, by: "backfill:2026-11-02", dryRun: false });
  assert.equal(live.saved, 1);
  const stored = await store.getInvestorRead(LOC, "imp1");
  assert.equal(stored.doc.by, "backfill:2026-11-02");
  assert.equal(stored.doc.quotes[0].channel, "call");
});

test("the Investors list carries the columns and a search blob; the investor carries every quote", async () => {
  const { investors, counts } = await get("/investors");
  const row = investors.find((i) => i.contactId === "imp1");
  assert.equal(row.read.summary, "Builder in Ballard");
  assert.equal(row.read.quotes, 1);
  assert.equal(row.read.empty, false);
  assert.match(row.readText, /we build in ballard/);
  assert.ok(counts.withWords >= 1);
  const silent = investors.find((i) => i.contactId === "r2");
  assert.equal(silent.read.empty, true);
  assert.equal(silent.readText, undefined);
  const one = await get("/investors/imp1");
  assert.equal(one.read.quotes[0].text, "We build in Ballard, lots over 5000");
});

test("the CSV export lists everyone who told us something, with their words", async () => {
  const res = await fetch(`${base}/reads/export.csv`);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.match(res.headers.get("content-disposition"), /investors-in-their-words-\d{4}-\d{2}-\d{2}\.csv/);
  const csv = await res.text();
  assert.ok(csv.includes("Buyer imp1"));
  assert.ok(csv.includes('2026-09-10 (call): ""We build in Ballard, lots over 5000""'));
  assert.ok(!csv.includes("Buyer r2")); // nothing from them yet
  assert.ok((await (await fetch(`${base}/reads/export.csv?all=1`)).text()).includes("Buyer r2"));
});

test("reading from the page needs the AI key, and a dry run only plans", async () => {
  _resetJobs();
  const refused = await fetch(`${base}/reads/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contactIds: ["imp1"], dryRun: false }) });
  assert.equal(refused.status, 400);
  const dry = await post("/reads/run", { contactIds: ["imp1"] });
  assert.equal(dry.job.dryRun, true);
  assert.ok(await until(() => getReadJob(LOC)?.status === "done"));
  const status = await get("/reads/status");
  assert.equal(status.settings.enabled, false);
  assert.ok(status.reads >= 1);
});
