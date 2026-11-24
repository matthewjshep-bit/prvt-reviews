// needs-matt-route.test.mjs — GET /api/dashboard/needs-matt, the list the
// Offers and Deals pages read once on load (2026-11-23 audit): who is on the
// GHL "Needs Matt" stage, with the one line saying why and, for a house
// waiting on his price, when the runner passes it. A cursor read only.
//
//   node --test needs-matt-route.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "needs-matt-route-test-"));
delete process.env.DATABASE_URL;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createDashboardRouter } = await import("./routes/dashboard.js");
const { NEEDS_MATT_CURSOR } = await import("./shared/needs-matt.js");

const LOC = "loc-needs-matt-route";
let ghlCalls = 0;
const app = express();
app.use(express.json());
app.use("/api/dashboard", createDashboardRouter({ resolveLocation: () => ({ locationId: LOC, client: { call: async () => { ghlCalls++; return {}; } } }) }));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(() => server.close());

test("the Needs Matt list says why each person is on it and when an unpriced house gets passed, without asking GHL", async () => {
  await store.setJobCursor(LOC, NEEDS_MATT_CURSOR, { doc: { readAt: "2026-11-20T18:00:00Z", needs: {
    "agent-price": { kind: "price", rowKind: "price_it", offerId: "offer-1", why: "Price it on 12 Elm St: the agent has waited 30 hours for our number", at: "2026-11-19T18:00:00Z", landedAt: "2026-11-20T18:00:00Z", placed: true },
    "agent-yes": { kind: "yes", rowKind: "approve_number", offerId: "offer-2", why: "They agreed on 4 Oak Ave at 300K", at: "2026-11-20T18:00:00Z", landedAt: "2026-11-20T18:00:00Z", placed: true },
  } } });
  const r = await (await fetch(`${B}/api/dashboard/needs-matt`)).json();
  assert.equal(r.ok, true, r.error);
  const by = Object.fromEntries(r.needs.map((x) => [x.contactId, x]));
  assert.equal(by["agent-price"].why, "Price it on 12 Elm St: the agent has waited 30 hours for our number");
  assert.equal(by["agent-price"].offerId, "offer-1");
  assert.ok(Date.parse(by["agent-price"].passAt) > Date.parse("2026-11-20T18:00:00Z"), "a price card says when it gets passed");
  // A yes is never passed by the machine.
  assert.equal(by["agent-yes"].passAt, null);
  assert.equal(by["agent-yes"].offerId, "offer-2");
  assert.equal(ghlCalls, 0, "one cursor read, no GHL call");
});
