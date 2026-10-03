// agents-tiers-route.test.mjs — GET /api/dashboard/agents/tiers: every agent's
// Tier 1 / Tier 2 from the app's own record (shared/tiers.js), and what keeps
// a Tier 2 agent warm. Matt, 2026-10-02: track the tiers in the app, not in
// GHL's pipeline stages.
//
//   node --test agents-tiers-route.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agents-tiers-route-test-"));
delete process.env.DATABASE_URL;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { recordEvent } = await import("./contact-record.js");
const { default: createDashboardRouter } = await import("./routes/dashboard.js");

const LOC = "loc-agents-tiers";
const app = express();
app.use(express.json());
app.use("/api/dashboard", createDashboardRouter({ resolveLocation: () => ({ locationId: LOC, client: { call: async () => ({}) } }) }));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(() => server.close());

const H = 3600000;
const ago = (h) => new Date(Date.now() - h * H).toISOString();
const ev = (contactId, type, over = {}) => recordEvent({ store, locationId: LOC, contactId, party: "agent", type, at: ago(2), source: "conversation", ...over });

test("agents sort into Tier 1 (a house in hand), Tier 2 (written back, nothing in hand) and cold, with what keeps Tier 2 warm", async () => {
  // An offer out.
  await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "offer-agent", contactName: "Olive O", address: "12 Elm St, Kent, WA", status: "sent", cashAmount: 300000,
    statusHistory: [], createdAt: ago(48), sends: [{ ts: ago(47) }] });
  // Named a house this week, not priced yet.
  await ev("named-agent", "subject_property_set", { address: "210 4th Ave N, Kent, WA 98032", dedupeKey: "spn", data: {} });
  await ev("named-agent", "text_summary", { ref: "t-n", data: { inbound: "I have one on 4th", summary: "has a house" } });
  // Wrote back a month ago, nothing in hand.
  await ev("talker", "text_summary", { at: ago(24 * 30), ref: "t-t", data: { inbound: "Nothing right now but keep me posted", summary: "nothing now" } });
  // Never wrote back.
  await ev("cold-agent", "outreach_sent", { source: "outreach", dedupeKey: "o-c", data: {} });

  const r = await (await fetch(`${B}/api/dashboard/agents/tiers`)).json();
  assert.equal(r.ok, true, r.error);
  const by = Object.fromEntries(r.rows.map((x) => [x.contactId, x]));
  assert.equal(by["offer-agent"].tier, "t1");
  assert.match(by["offer-agent"].why, /offer out on 12 Elm St/);
  assert.equal(by["named-agent"].tier, "t1");
  assert.match(by["named-agent"].why, /210 4th Ave N/);
  assert.equal(by.talker.tier, "t2");
  assert.ok(by.talker.care?.text, "says what keeps them warm");
  assert.match(by.talker.care.text, /check-in is off/, "the check-in ships off: nothing keeps them warm, and the row says so");
  assert.equal(by["cold-agent"], undefined, "cold agents are counted, not listed");
  assert.ok(r.counts.cold >= 1);
  assert.equal(r.rows[0].tier, "t1", "Tier 1 first");
});
