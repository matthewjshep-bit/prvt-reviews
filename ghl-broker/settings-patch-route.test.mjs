// settings-patch-route.test.mjs — the Autopilot chart saves one part of a
// section without carrying an old copy of everything else (2026-10-20).
//
// PUT /settings writes the whole blob. The chart on Autopilot → Agents saves
// only the follow-up texts; a Setup form loaded before it and saved after
// would otherwise put the old texts back, and the chart would put back
// whatever the form changed.
//
//   node --test settings-patch-route.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "settings-patch-route-test-"));
delete process.env.DATABASE_URL;
delete process.env.CARD_SENDS_ENABLED;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");

const LOC = "loc-settings-patch";
const app = express();
app.use(express.json());
app.use("/api/offers", createOffersRouter({ resolveLocation: () => ({ locationId: LOC, client: { call: async () => ({}) } }), uploadDir: process.env.DATA_DIR }));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(() => server.close());

const patch = (body) => fetch(`${B}/api/offers/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("saving the follow-up texts changes only them: the first texts, the sweep and the Conversation AI blob stay as they were", async () => {
  await store.saveOfferSettings(LOC, {
    rentcastApiKey: "rc-secret",
    outreachAutopilot: { enabled: true, dailyCap: 40, opener: { examples: ["Hi {first}, my own first text about {address}?"] } },
    dispoAutopilot: { autoBlastCount: 12 },
    conversationAi: { enabled: true, persona: { name: "Matt" } },
  });
  const r = await patch({ outreachAutopilot: { opener: { followUps: ["Hi {first}, step one?", "Hi {first}, step two?"] } } });
  assert.equal(r.status, 200);
  const saved = await store.getOfferSettings(LOC);
  assert.deepEqual(saved.outreachAutopilot.opener.followUps, ["Hi {first}, step one?", "Hi {first}, step two?"]);
  assert.deepEqual(saved.outreachAutopilot.opener.examples, ["Hi {first}, my own first text about {address}?"]);
  assert.equal(saved.outreachAutopilot.enabled, true);
  assert.equal(saved.outreachAutopilot.dailyCap, 40);
  assert.equal(saved.dispoAutopilot.autoBlastCount, 12);
  assert.equal(saved.rentcastApiKey, "rc-secret");
  assert.equal(saved.conversationAi.enabled, true);
  assert.equal(saved.conversationAi.persona.name, "Matt");
  const body = await r.json();
  assert.notEqual(body.rentcastApiKey, "rc-secret", "the reply masks secrets like GET does");
});

test("the app's own request shape — the section under settings, the location beside it — is accepted", async () => {
  const r = await patch({ location_id: LOC, location_key: "k", settings: { outreachAutopilot: { opener: { followUps: ["Hi {first}, wrapped?"] } } } });
  assert.equal(r.status, 200);
  assert.deepEqual((await store.getOfferSettings(LOC)).outreachAutopilot.opener.followUps, ["Hi {first}, wrapped?"]);
});

test("a list is replaced, not merged: deleting a follow-up deletes it", async () => {
  await patch({ outreachAutopilot: { opener: { followUps: ["Hi {first}, one?", "Hi {first}, two?", "Hi {first}, three?"] } } });
  await patch({ outreachAutopilot: { opener: { followUps: ["Hi {first}, one?"] } } });
  assert.deepEqual((await store.getOfferSettings(LOC)).outreachAutopilot.opener.followUps, ["Hi {first}, one?"]);
});

test("a buyer-pulse setting saves on its own, beside the waves", async () => {
  await patch({ dispoAutopilot: { pulse: { voice: "short and friendly" } } });
  const saved = await store.getOfferSettings(LOC);
  assert.equal(saved.dispoAutopilot.pulse.voice, "short and friendly");
  assert.equal(saved.dispoAutopilot.autoBlastCount, 12);
});

test("anything outside the two Autopilot sections is refused, the Conversation AI blob above all", async () => {
  const r = await patch({ conversationAi: { enabled: false } });
  assert.equal(r.status, 400);
  assert.equal((await store.getOfferSettings(LOC)).conversationAi.enabled, true);
  assert.equal((await patch({ rentcastApiKey: "" })).status, 400);
  assert.equal((await store.getOfferSettings(LOC)).rentcastApiKey, "rc-secret");
});
