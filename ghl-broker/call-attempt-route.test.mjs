// call-attempt-route.test.mjs — the Desk's "No answer / Left voicemail /
// Call back" chips. A call that didn't connect is filed as a call_attempt
// with an outcome and maybe a date — never words — so the call list can
// lower the row, hide it until the date, or hand it back to the machine.
//
//   node --test call-attempt-route.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "call-attempt-route-test-"));
delete process.env.DATABASE_URL;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createContactsRouter } = await import("./routes/contacts.js");

const LOC = "loc-call-attempt";
const app = express();
app.use(express.json());
app.use("/api/contacts", createContactsRouter({ resolveLocation: () => ({ locationId: LOC, client: { call: async () => ({}) } }) }));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(() => server.close());

const post = (id, body) => fetch(`${B}/api/contacts/${id}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

test("a call that didn't connect is an attempt with an outcome and no words", async () => {
  const r = await post("agent1", { type: "call_attempt", outcome: "no_answer", party: "agent", offerId: "o1" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const back = new Date(Date.now() + 2 * 86400000).toISOString();
  assert.equal((await post("agent1", { type: "call_attempt", outcome: "call_back", callBackAt: back, at: new Date(Date.now() + 1000).toISOString() })).status, 200);
  const evs = await store.listContactEvents(LOC, "agent1", { types: ["call_attempt"] });
  assert.deepEqual(evs.map((e) => e.data.outcome).sort(), ["call_back", "no_answer"]);
  assert.equal(evs.find((e) => e.data.outcome === "call_back").data.callBackAt, back);
  assert.ok(evs.every((e) => !("text" in e.data) && !("summary" in e.data)));
});

test("an attempt needs a known outcome, and a call back needs a date inside two months", async () => {
  assert.equal((await post("agent2", { type: "call_attempt", outcome: "busy-ish" })).status, 400);
  assert.equal((await post("agent2", { type: "call_attempt", outcome: "call_back" })).status, 400);
  assert.equal((await post("agent2", { type: "call_attempt", outcome: "call_back", callBackAt: new Date(Date.now() + 90 * 86400000).toISOString() })).status, 400);
  // Logging a real call still wants what was said.
  assert.equal((await post("agent2", { type: "call_summary" })).status, 400);
});
