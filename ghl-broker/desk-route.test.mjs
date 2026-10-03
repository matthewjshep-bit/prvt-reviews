// desk-route.test.mjs — GET /api/dashboard/pipeline carries the Desk: one row
// per person in Call · Decide · Machine, and today's strip.
//
// What went wrong (2026-10-02): Today listed one agent three times for one
// house — the number we owed, the underwrite it waited on, and last night's
// "still owed a number" — beside two rows called "An agent", while a counter
// and a wants-a-call text sat in the same list as everything else.
//
//   node --test desk-route.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "desk-route-test-"));
delete process.env.DATABASE_URL;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { recordEvent } = await import("./contact-record.js");
const { default: createDashboardRouter } = await import("./routes/dashboard.js");

const LOC = "loc-desk-route";
const app = express();
app.use(express.json());
// GHL knows the agent the book doesn't.
const client = { call: async (p) => (String(p).includes("/contacts/nameless") ? { contact: { firstName: "Mallory", lastName: "D" } } : {}) };
app.use("/api/dashboard", createDashboardRouter({ resolveLocation: () => ({ locationId: LOC, client }) }));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(() => server.close());

const H = 3600000;
const ago = (h) => new Date(Date.now() - h * H).toISOString();
const HOUSE = "18612 51st Ave SE, Bothell, WA 98012";

test("one person's owed number, held underwrite and last night's 'still owed' are one Desk row; a counter is a call", async () => {
  await store.saveOfferSettings(LOC, { lineTargets: { offersPerDay: 10, dealsPerMonth: 2 } });
  // The held underwrite on Hanna's house.
  const heldOffer = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "hanna", contactName: "Hanna F", address: HOUSE, status: "draft",
    statusHistory: [], createdAt: ago(5), autoUnderwrite: { jobId: "j1", held: ["only 1 priced comps — the price proxy needs 6"], finishedAt: ago(5) } });
  // The number we owe her.
  await recordEvent({ store, locationId: LOC, contactId: "hanna", party: "agent", type: "promise_owed", at: ago(4), address: HOUSE, source: "conversation", dedupeKey: "p1",
    data: { what: "number", text: "I'll run those numbers and get back to you", owedAt: ago(4) } });
  // Last night's audit: the same promise, and one about an agent with no name anywhere in the book.
  await store.setJobCursor(LOC, "conversationAudit", { doc: { last: { finishedAt: ago(14), counts: {}, acted: [], findings: [
    { id: "audit:promise_open_overdue:hanna:x", kind: "promise_open_overdue", severity: "now", contactId: "hanna", contactName: "Hanna F", address: HOUSE, why: "we said we'd come back with a number", action: null, anchorAt: ago(20) },
    { id: "audit:unanswered_inbound:nameless:x", kind: "unanswered_inbound", severity: "now", contactId: "nameless", contactName: "", why: "they texted and nothing was drafted", action: null, anchorAt: ago(20) },
  ] } } });
  // A counter the band refused, held for Matt.
  const counterOffer = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "kel", contactName: "Kel B", address: "23908 SE 168th St, Issaquah, WA 98027",
    status: "countered", cashAmount: 690000, statusHistory: [], createdAt: ago(100), sends: [{ ts: ago(90) }] });
  await store.createReplyDraft({ locationId: LOC, contactId: "kel", contactName: "Kel B", party: "agent", intent: "counter", status: "draft", inbound: "Seller would do 715",
    reply: "Let me run it by the team.", offerId: counterOffer.id, outbound: { offerId: counterOffer.id }, exception: { passed: false, theirAmount: 715000, ceiling: 700000, basis: "70% ARV − rehab at a $10k assignment" } });
  // A call today.
  await recordEvent({ store, locationId: LOC, contactId: "kel", party: "agent", type: "call_summary", at: new Date().toISOString(), source: "call", ref: "m1", dedupeKey: "call:m1",
    data: { summary: "Talked numbers.", transcribed: true, durationSec: 300 } });

  const r = await (await fetch(`${B}/api/dashboard/pipeline`)).json();
  assert.equal(r.ok, true, r.error);
  assert.ok(r.desk, "the Desk rides on the same response");
  assert.deepEqual(r.desk.sections.map((s) => s.key), ["call", "decide", "machine"]);
  const hanna = r.desk.rows.filter((x) => x.contactId === "hanna");
  assert.equal(hanna.length, 1, "Hanna is one row");
  assert.ok(hanna[0].reasonIds.length >= 3, `promise, held underwrite and still-owed all fold in (${hanna[0].reasonIds.join(", ")})`);
  assert.ok(hanna[0].reasonIds.includes(`underwrite_held:${heldOffer.id}`));
  const kel = r.desk.rows.find((x) => x.contactId === "kel");
  assert.equal(kel.section, "call", "a counter above our number is a call");
  assert.equal(r.desk.rows[0].section, "call", "Call comes first");
  const nameless = r.desk.rows.find((x) => x.contactId === "nameless");
  assert.equal(nameless.contactName, "Mallory D", "named off GHL, not 'An agent'");
  assert.equal(r.desk.kpis.calls.talked, 1);
  assert.equal(r.desk.kpis.offers.target, 10);
  assert.equal(r.desk.kpis.contracts.target, 2);
  // The board still gets every row as it was.
  assert.ok(r.actions.length >= r.desk.rows.length);
});

test("a hot offer is a call with a brief, a no-answer is remembered, and a connected call clears it", async () => {
  const hot = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "mary", contactName: "Maryanne A", address: "9311 12th Pl SE, Lake Stevens, WA 98258",
    status: "sent", cashAmount: 197500, statusHistory: [], createdAt: ago(200), sends: [{ ts: ago(150) }], realm: { answer: "yes", ts: ago(20) } });
  const get = async () => (await (await fetch(`${B}/api/dashboard/pipeline`)).json()).desk.rows;
  let row = (await get()).find((x) => x.contactId === "mary");
  assert.equal(row.kind, "call_hot");
  assert.equal(row.section, "call");
  assert.match(row.call.goal, /NWMLS/);
  assert.equal(row.call.houses[0].offerId, hot.id);
  // Every Call row has a brief, whoever built it.
  for (const r of (await get()).filter((x) => x.section === "call")) assert.ok(r.call?.opener, `${r.kind} has an opener`);

  await recordEvent({ store, locationId: LOC, contactId: "mary", party: "agent", type: "call_attempt", at: new Date().toISOString(), source: "operator", dedupeKey: "ca1", data: { outcome: "no_answer" } });
  row = (await get()).find((x) => x.contactId === "mary");
  assert.equal(row.call.tries, 1);

  await recordEvent({ store, locationId: LOC, contactId: "mary", party: "agent", type: "call_summary", at: new Date(Date.now() + 1000).toISOString(), source: "call", ref: "m2", dedupeKey: "call:m2",
    data: { summary: "She'll write it up tonight.", transcribed: true, durationSec: 410 } });
  assert.equal((await get()).some((x) => x.kind === "call_hot" && x.contactId === "mary"), false, "talked: off the list");
});
