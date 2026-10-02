// drive-routes.test.mjs — Stop, Pause and Resume on a person, through the
// real routes and the JSON store.
// Run: node --test drive-routes.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "drive-routes-test-"));
delete process.env.DATABASE_URL;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createDashboardRouter } = await import("./routes/dashboard.js");

const LOC = "loc-drive-routes";
const ghlCalls = [];
const resolveLocation = () => ({ locationId: LOC, client: { call: async (p, o = {}) => { ghlCalls.push([o.method || "GET", p]); return {}; } } });
const app = express();
app.use(express.json({ limit: "5mb" }));
app.use("/api/dashboard", createDashboardRouter({ resolveLocation }));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
const req = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const soon = () => new Date(Date.now() + 5 * 60000).toISOString();
test.after(() => server.close());

test("Stop pulls back the nudges waiting to go and holds a reply that was about to send", async () => {
  const nudge = await store.createReplyDraft({ locationId: LOC, contactId: "c1", party: "agent", intent: "offer_nudge", status: "scheduled", sendAt: soon(),
    inbound: "", reply: "Any word from the seller on 12 Elm?", outbound: { kind: "offer_nudge", offerId: "o1" }, flags: [] });
  const reply = await store.createReplyDraft({ locationId: LOC, contactId: "c1", party: "agent", intent: "question", status: "scheduled", sendAt: soon(),
    inbound: "still on for Thursday?", reply: "Yes, still on.", autoSend: { decided: true, reason: "" }, flags: [] });
  const r = await req("POST", "/api/dashboard/drive/stop", { contactId: "c1", party: "agent" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.pulled, [nudge.id]);
  assert.deepEqual(r.json.held, [reply.id]);
  assert.equal(r.json.hold.held, true);
  assert.equal(r.json.hold.kind, "stopped");
  assert.equal((await store.getReplyDraft(nudge.id)).status, "dismissed");
  const held = await store.getReplyDraft(reply.id);
  assert.equal(held.status, "draft");
  assert.equal(held.sendAt, null);
});

test("Resume sends nothing that was held", async () => {
  const r = await req("POST", "/api/dashboard/drive/resume", { contactId: "c1" });
  assert.equal(r.status, 200);
  assert.equal(r.json.hold.held, false);
  const open = await store.listReplyDrafts(LOC, { contactId: "c1", status: "scheduled" });
  assert.equal(open.length, 0, "the held reply waits for Send");
  assert.equal(ghlCalls.some(([, p]) => p.startsWith("/conversations/messages")), false, "nothing was texted");
});

test("a stop on a buyer leaves them a buyer", async () => {
  await store.upsertContactProfile(LOC, "b1", { party: "investor", name: "Buyer One" });
  const r = await req("POST", "/api/dashboard/drive/stop", { contactId: "b1" });
  assert.equal(r.status, 200);
  assert.equal((await store.getContactProfile(LOC, "b1")).party, "investor");
  await req("POST", "/api/dashboard/drive/resume", { contactId: "b1" });
  assert.equal((await store.getContactProfile(LOC, "b1")).party, "investor");
});

test("a pause needs a date in the next five weeks, and reads back as a pause", async () => {
  const bad = await req("POST", "/api/dashboard/drive/stop", { contactId: "c3", preset: "6w" });
  assert.equal(bad.status, 400);
  const far = await req("POST", "/api/dashboard/drive/stop", { contactId: "c3", until: new Date(Date.now() + 40 * 86400000).toISOString() });
  assert.equal(far.status, 400);
  assert.match(far.json.error, /next five weeks/);
  const ok = await req("POST", "/api/dashboard/drive/stop", { contactId: "c3", preset: "2w" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.hold.kind, "paused");
  const days = (Date.parse(ok.json.hold.until) - Date.now()) / 86400000;
  assert.ok(days > 13.9 && days < 14.1, String(days));
});

test("pace is saved and read back newest first; normal resets it; nonsense is refused", async () => {
  const less = await req("POST", "/api/dashboard/drive/pace", { contactId: "c4", pace: "less" });
  assert.equal(less.status, 200, JSON.stringify(less.json));
  assert.equal(less.json.pace.pace, "less");
  assert.equal(less.json.pace.factor, 2);
  await new Promise((r) => setTimeout(r, 5));
  const more = await req("POST", "/api/dashboard/drive/pace", { contactId: "c4", pace: "more" });
  assert.equal(more.json.pace.pace, "more");
  await new Promise((r) => setTimeout(r, 5));
  const normal = await req("POST", "/api/dashboard/drive/pace", { contactId: "c4", pace: "normal" });
  assert.equal(normal.json.pace.pace, "normal");
  assert.equal(normal.json.pace.since, null);
  assert.equal((await req("POST", "/api/dashboard/drive/pace", { contactId: "c4", pace: "ludicrous" })).status, 400);
});
