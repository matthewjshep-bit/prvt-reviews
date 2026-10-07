// offer-out-send.test.mjs — pressing Send on an offer moves the agent's GHL
// Acquisitions card to Offer Out (Matt, 2026-10-07: GHL's board is the list he
// works; the app keeps it true). A dry run moves nothing.
//
// JSON file backend in a throwaway temp directory; GHL stubbed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "offer-out-send-test-"));
process.env.CARD_SENDS_ENABLED = "true";
delete process.env.DATABASE_URL;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");
const { _resetPipelineCache } = await import("./ghl-mirror.js");

const LOC = "loc-offer-out-send";
const STAGES = [["s-t1", "Tier 1 - Hot/Actionable"], ["s-t2", "Tier 2 - Warm"], ["s-t3", "Tier 3- Cold"], ["s-out", "Offer Out"], ["s-neg", "Negotiations"]]
  .map(([id, name], position) => ({ id, name, position }));
const card = { id: "op1", contactId: "c1", pipelineId: "acq", pipelineStageId: "s-t1", status: "open" };
const puts = [];
const client = {
  call: async (p, o = {}) => {
    const method = o.method || "GET";
    if (method === "GET" && /^\/contacts\/[^/?]+$/.test(p)) return { contact: { id: "c1", firstName: "Dana", phone: "+12065550100", tags: ["agent"] } };
    if (method === "POST" && p.startsWith("/conversations/messages")) return { messageId: "m1" };
    if (p.startsWith("/opportunities/pipelines")) return { pipelines: [{ id: "acq", name: "Acquisitions", stages: STAGES }] };
    if (p.startsWith("/opportunities/search")) return { opportunities: [{ ...card }] };
    if (method === "PUT" && p.startsWith("/opportunities/")) { puts.push([p, o.body]); card.pipelineStageId = o.body.pipelineStageId; return {}; }
    return {};
  },
};
const app = express();
app.use(express.json());
app.use("/api/offers", createOffersRouter({ resolveLocation: () => ({ locationId: LOC, client }), uploadDir: process.env.DATA_DIR, publicBaseUrl: "http://127.0.0.1:4997" }));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(() => server.close());

const send = async (id, body) => {
  const r = await fetch(`${B}/api/offers/${id}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};

test("pressing Send moves the card to Offer Out; a dry run doesn't", async () => {
  _resetPipelineCache();
  const offer = await store.createOffer({ locationId: LOC, contactId: "c1", contactName: "Dana", address: "1 Main St, Kent, WA 98031", cashAmount: 300000,
    status: "new", imageUrl: "https://example.com/offer.jpg" });
  const dry = await send(offer.id, { channels: ["sms"], docs: ["image"] });
  assert.equal(dry.status, 200, JSON.stringify(dry.json));
  assert.equal(dry.json.dryRun, true);
  assert.deepEqual(puts, [], "a dry run moves nothing");

  const live = await send(offer.id, { channels: ["sms"], docs: ["image"], dryRun: false });
  assert.equal(live.status, 200, JSON.stringify(live.json));
  assert.equal(live.json.sent, true);
  assert.equal(card.pipelineStageId, "s-out");
  const events = await store.listContactEvents(LOC, "c1", { limit: 50 });
  assert.ok(events.some((e) => e.type === "ghl_stage_moved" && e.data?.to === "Offer Out"));
});
