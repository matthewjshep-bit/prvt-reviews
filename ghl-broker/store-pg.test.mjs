// store-pg.test.mjs — the database prod actually runs.
//
// Every other suite runs the JSON-file store. Prod runs Postgres, and the
// RUNBOOK's hardening notes record a prod-only bug of exactly this class:
// every lean offer row lost its ARV on Postgres while the tests stayed green.
// CI (.github/workflows/test.yml) gives this file a postgres:16 and a
// DATABASE_URL; without one, only the checks that need no database run.
//
//   DATABASE_URL=postgres://… node --test store-pg.test.mjs

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PG = Boolean(process.env.DATABASE_URL);
const skip = PG ? false : "needs DATABASE_URL (CI runs it on a postgres:16)";

// Statements, without the comments, one per semicolon.
const schema = fs.readFileSync(path.join(DIR, "schema.pg.sql"), "utf8");
const statements = schema.replace(/--[^\n]*/g, "").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);

test("the schema still applies twice: every statement is a no-op the second time", () => {
  for (const s of statements) {
    if (/^create (unique )?(table|index)\b/i.test(s)) assert.match(s, /^create (unique )?(table|index) if not exists /i, s.slice(0, 80));
    if (/\badd column\b/i.test(s)) assert.match(s, /\badd column if not exists\b/i, s.slice(0, 80));
    if (/\bdrop (table|column|index|constraint)\b/i.test(s)) assert.match(s, /\bdrop (table|column|index|constraint) if exists\b/i, s.slice(0, 80));
  }
  assert.ok(statements.some((s) => /^create index if not exists contact_events_loc_type_at_idx on contact_events \(location_id, type, at desc\)$/i.test(s)),
    "typed event reads have their index");
});

test("the schema still applies twice on a fresh Postgres", { skip }, async () => {
  const { migrate, query } = await import("./db.js");
  // migrate() answers { ok, error } since the boot started recording a failed
  // schema under db:migrate (fix/a-restart-or-deploy-drops-nothing-and-is-announced).
  const first = await migrate();
  assert.equal(first.ok, true, `first apply: ${first.error}`);
  const second = await migrate();
  assert.equal(second.ok, true, `second apply: ${second.error}`);
  const { rows } = await query(`select indexname from pg_indexes where tablename = 'contact_events' and indexname = 'contact_events_loc_type_at_idx'`);
  assert.equal(rows.length, 1);
});

// The rest runs only against Postgres.
const LOC = `loc-pg-${crypto.randomUUID().slice(0, 8)}`;
let store = null;
async function pg() {
  if (!store) {
    ({ store } = await import("./store.js"));
    await store.init();
  }
  return store;
}

test("a lean offer row keeps its ARV on Postgres", { skip }, async () => {
  const s = await pg();
  const id = crypto.randomUUID();
  await s.createOffer({
    id, locationId: LOC, contactId: "agent-lean", address: "77 Juniper Ct, Auburn, WA 98002", cashAmount: 310000,
    calc: { inputs: { arv: 525000, repairs: 60000, askingPrice: 499000 }, settings: { holdMonths: 5, aiApiKey: "never-on-a-row" }, offers: { cash: { amount: 310000, mode: "flip", wholesaleFee: 15000 } } },
    snapshot: { subjectInfo: { homeType: "SINGLE_FAMILY", lotSqft: 6100 } },
  });
  const row = (await s.listOffers(LOC, { limit: 50, lean: true })).find((o) => o.id === id);
  assert.ok(row, "the lean read finds it");
  assert.equal(row.arv, 525000);
  assert.equal(row.repairs, 60000);
  assert.doesNotMatch(JSON.stringify(row), /never-on-a-row|wholesaleFee/, "the trim is an allowlist");
});

test("the pending-send read finds what's waiting, on Postgres, and nothing else", { skip }, async () => {
  const s = await pg();
  const now = Date.now();
  const iso = (d) => new Date(now - d * 86400000).toISOString();
  const mk = (over) => s.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: `agent-${crypto.randomUUID().slice(0, 6)}`, address: "5 Sorrel Way, Kent, WA 98031", cashAmount: 200000, ...over });
  const held = await mk({ autoSendPending: { reason: "after hours", at: iso(1), by: "underwrite" } });
  const floated = await mk({ proactive: { realmCheckAt: iso(2) } });
  await mk({ proactive: { realmCheckAt: iso(2) }, paperAfterFloat: { status: "sent" } });
  await mk({ proactive: { realmCheckAt: iso(40) } });
  await mk({ autoSendPending: { reason: "after hours", at: iso(1) }, deal: { stage: "under_contract" } });
  await mk({});
  const held1 = await s.listPendingOfferSends(LOC);
  assert.deepEqual(held1.map((o) => o.id), [held.id]);
  assert.equal(held1[0].autoSendPending.reason, "after hours", "the whole document comes back");
  const both = await s.listPendingOfferSends(LOC, { floatedSince: iso(15) });
  assert.deepEqual(new Set(both.map((o) => o.id)), new Set([held.id, floated.id]));
});

test("a few names come back by id on Postgres, the investor book first", { skip }, async () => {
  const s = await pg();
  await s.upsertInvestors(LOC, [{ contactId: "buyer-pg", name: "Rowan Buyer", doc: { name: "Rowan Buyer" } }]);
  await s.upsertContactProfile(LOC, "buyer-pg", { name: "R. Buyer" });
  await s.upsertContactProfile(LOC, "agent-pg", { name: "Ellis Agent" });
  assert.deepEqual(await s.contactNamesByIds(LOC, ["buyer-pg", "agent-pg", "nobody"]), { "buyer-pg": "Rowan Buyer", "agent-pg": "Ellis Agent" });
});

test("a typed event read on Postgres keeps the newest and only the types asked for", { skip }, async () => {
  const s = await pg();
  const at = (m) => new Date(Date.now() - m * 60000).toISOString();
  await s.appendContactEvents(LOC, "agent-ev", [
    { type: "drive_stopped", at: at(30), source: "operator" },
    { type: "text_summary", at: at(20), source: "conversation" },
    { type: "drive_resumed", at: at(10), source: "operator" },
  ]);
  const rows = await s.listContactEventsSince(LOC, "1970-01-01T00:00:00.000Z", { types: ["drive_stopped", "drive_resumed"], limit: 1 });
  assert.deepEqual(rows.map((e) => e.type), ["drive_resumed"]);
  assert.equal(rows.truncated, true);
});

test.after(async () => {
  if (!PG) return;
  const { pool } = await import("./db.js");
  await pool?.end().catch(() => {});
});
