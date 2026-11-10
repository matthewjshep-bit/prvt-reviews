// report-counting-route.test.mjs — GET /api/dashboard/funnel and
// /api/dashboard/outreach-scorecard on the JSON store (2026-11-09).
//
// What would go wrong without these:
//   - the Funnel tab would read floats as never sent again (76% countered,
//     483% dead of sent on 11-09)
//   - the follow-up table would count the sweep's claim, not the text that went
//   - the text scoreboard would be worked out on open, the heavy read that
//     knocked the broker over on 11-09
//
//   node --test report-counting-route.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "report-counting-route-test-"));
delete process.env.DATABASE_URL;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createDashboardRouter } = await import("./routes/dashboard.js");
const { CURSOR_NAME } = await import("./outreach-scorecard.js");

const LOC = "loc-report-counting";
const app = express();
app.use(express.json());
app.use("/api/dashboard", createDashboardRouter({ resolveLocation: () => ({ locationId: LOC, client: { call: async () => ({}) } }) }));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(() => server.close());

const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const mk = (over) => store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: `a-${crypto.randomUUID().slice(0, 6)}`, statusHistory: [], createdAt: ago(10), ...over });

test("the Funnel tab counts a float that went as sent, leaves a house we passed on unpriced out of dead, and reads follow-ups from the outbox", async () => {
  await mk({ address: "11 Teal St, Kent, WA", status: "countered", cashAmount: 300000, floatSentAt: ago(9), statusHistory: [{ status: "new", ts: ago(10) }, { status: "countered", ts: ago(8) }] });
  await mk({ address: "12 Teal St, Kent, WA", status: "we_passed", cashAmount: 280000, statusHistory: [{ status: "new", ts: ago(10) }, { status: "we_passed", ts: ago(7) }] });
  await mk({ address: "13 Teal St, Kent, WA", status: "sent", cashAmount: 310000, sends: [{ ts: ago(9), channels: ["sms"], results: { sms: { ok: true } } }], statusHistory: [{ status: "sent", ts: ago(9) }] });
  // A nudge that went, and a claim with no text behind it.
  await store.createReplyDraft({ locationId: LOC, contactId: "c-n1", status: "sent", sentAt: ago(6), channel: "sms", inbound: "", reply: "Checking on Teal",
    outbound: { kind: "offer_nudge", step: 3, address: "13 Teal St" }, updatedAt: ago(6) });
  await store.appendContactEvents(LOC, "c-n2", [{ type: "follow_up_sent", at: ago(6), source: "conversation", dedupeKey: "fu:c-n2", data: { kind: "offer_nudge", step: 3 } }]);

  const r = await (await fetch(`${B}/api/dashboard/funnel?days=30`)).json();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.funnel.sent, 2);
  assert.equal(r.funnel.countered, 1);
  assert.equal(r.funnel.rates.counteredOfSent, 50);
  assert.equal(r.funnel.wePassed, 0);
  assert.equal(r.funnel.passedUnsent, 1);
  assert.deepEqual(r.followUps.map((x) => [x.kind, x.step, x.sent]), [["offer_nudge", 3, 1]]);
  assert.equal(r.eventsTruncated, false);
  assert.match(r.countingChanged, /^\d{4}-\d{2}-\d{2}$/);
});

test("the text scoreboard is read from the night's card, never worked out on open", async () => {
  const empty = await (await fetch(`${B}/api/dashboard/outreach-scorecard`)).json();
  assert.equal(empty.ok, true);
  assert.equal(empty.card, null);
  const card = { generatedAt: ago(0.2), kinds: { first_text: { n: 40, young: 3, totals: { n: 40 }, dims: {} } } };
  await store.setJobCursor(LOC, CURSOR_NAME, { at: ago(0.2), doc: { last: { at: ago(0.2), finishedAt: ago(0.2), status: "done", card } } });
  const r = await (await fetch(`${B}/api/dashboard/outreach-scorecard`)).json();
  assert.equal(r.card.kinds.first_text.n, 40);
  assert.equal(r.status, "done");
});
