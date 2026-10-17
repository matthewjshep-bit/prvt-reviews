// contacts-by-conversation.test.mjs — the companion window follows a GHL
// conversation page as well as a contact page. That address names the
// conversation, so the broker asks GHL whose it is.
//
//   node --test contacts-by-conversation.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "contacts-by-conversation-test-"));
delete process.env.DATABASE_URL;

const { default: express } = await import("express");
const { makeClient } = await import("./ghl.js");
const { default: createContactsRouter } = await import("./routes/contacts.js");

// GHL's answers, by conversation id. Everything else goes to the real fetch
// (this test's own calls to the router).
const GHL = {
  "convNested000001": { status: 200, body: { conversation: { id: "convNested000001", contactId: "contactAAA000001" } } },
  "convFlat00000002": { status: 200, body: { id: "convFlat00000002", contactId: "contactBBB000002" } },
  "convNoContact003": { status: 200, body: { conversation: { id: "convNoContact003" } } },
  "convGone00000004": { status: 404, body: { message: "Conversation not found" } },
  "convBroken000005": { status: 500, body: { message: "upstream" } },
};
const realFetch = globalThis.fetch;
const asked = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (!u.startsWith("https://services.leadconnectorhq.com/")) return realFetch(url, opts);
  asked.push(u);
  const id = decodeURIComponent(u.split("/conversations/")[1] || "");
  const r = GHL[id] || { status: 404, body: {} };
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
};

const app = express();
app.use(express.json());
app.use("/api/contacts", createContactsRouter({ resolveLocation: () => ({ locationId: "loc-companion", client: makeClient("test-token") }) }));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); globalThis.fetch = realFetch; });

const get = (id) => realFetch(`${B}/api/contacts/by-conversation/${id}`).then(async (r) => ({ status: r.status, body: await r.json() }));

test("a GHL conversation page opens the person whose conversation it is", async () => {
  assert.deepEqual(await get("convNested000001"), { status: 200, body: { ok: true, contactId: "contactAAA000001" } });
  assert.ok(asked.some((u) => u.endsWith("/conversations/convNested000001")), "asked GHL for that conversation");
});

test("GHL's flat answer shape names the person too", async () => {
  assert.equal((await get("convFlat00000002")).body.contactId, "contactBBB000002");
});

test("a conversation GHL doesn't know, or one with no contact, is a 404 and not an error", async () => {
  assert.equal((await get("convGone00000004")).status, 404);
  assert.equal((await get("convNoContact003")).status, 404);
});

test("GHL failing is still a failure, not 'no one'", async () => {
  assert.equal((await get("convBroken000005")).status, 500);
});
