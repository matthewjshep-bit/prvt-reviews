// pulse-offer-contacts.test.mjs — every contact we made an offer to is in the
// agent check-in's pool, profile or not (2026-10-16 audit: seven offer
// contacts had no agent profile). On the JSON store.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-offer-contacts-test-"));

const { store } = await import("./store.js");
const { loadPulseAgents, planAgentPulse } = await import("./agent-pulse.js");
const { normalizeConversationAi } = await import("./shared/conversation-ai.js");
await store.init();

const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const saved = { aiApiKey: "k", company: { signer: "Matt Shepherd" }, conversationAi: normalizeConversationAi({ enabled: true }),
  outreachAutopilot: { pulse: { enabled: true, dailyCap: 0 } } };

// A listing agent who passed on our number six weeks ago, made by hand from
// the Offers form: no text ever came through the app, so no contact profile.
const passedOffer = (loc, contactId, over = {}) => store.createOffer({
  locationId: loc, contactId, contactName: "Dana Agent", address: `${contactId.length}12 Hemlock Dr, Tacoma, WA 98445`,
  cashAmount: 210000, status: "passed", statusAt: ago(40), createdAt: ago(45),
  sends: [{ ts: ago(44), channels: ["email"], results: { email: { ok: true } } }], ...over,
});

test("an agent we made an offer to with no contact profile is in the check-in pool", async () => {
  const loc = "loc-poc-noprofile";
  await passedOffer(loc, "c-noprof");
  assert.equal(await store.getContactProfile(loc, "c-noprof"), null, "no profile");
  const { agents, offerContacts } = await loadPulseAgents({ locationId: loc, saved, store });
  const a = agents.find((x) => x.contactId === "c-noprof");
  assert.ok(a, "in the pool");
  assert.equal(a.offers.length, 1);
  assert.deepEqual(offerContacts, { total: 1, inPool: 1, buyers: 0, self: 0 });
  const plan = await planAgentPulse({ locationId: loc, saved, store });
  const v = plan.verdicts.find((x) => x.contactId === "c-noprof");
  assert.equal(v.status, "due", v.reason);
});

test("an offer contact whose profile has no party still has their tags and facts read", async () => {
  const loc = "loc-poc-noparty";
  await passedOffer(loc, "c-np");
  // A profile written by an event with no party (a GHL call queued, say).
  await store.upsertContactProfile(loc, "c-np", { party: null, name: "Dana Agent", tags: ["dnc"] });
  const { agents } = await loadPulseAgents({ locationId: loc, saved, store });
  assert.deepEqual(agents.find((x) => x.contactId === "c-np")?.tags, ["dnc"]);
  const plan = await planAgentPulse({ locationId: loc, saved, store });
  assert.equal(plan.verdicts.find((x) => x.contactId === "c-np")?.status, "stopped", "a do-not-contact tag stops it");
});

test("our own contact and a buyer with an offer stay out, and the plan says how many", async () => {
  const loc = "loc-poc-self";
  await passedOffer(loc, "c-self", { contactName: "Matt Shepherd" });
  await passedOffer(loc, "c-buyer", { contactName: "Pat Buyer" });
  await store.upsertContactProfile(loc, "c-buyer", { party: "investor", name: "Pat Buyer" });
  await passedOffer(loc, "c-agent");
  const { agents, offerContacts } = await loadPulseAgents({ locationId: loc, saved, store });
  assert.deepEqual(agents.map((a) => a.contactId).sort(), ["c-agent"]);
  assert.deepEqual(offerContacts, { total: 3, inPool: 1, buyers: 1, self: 1 });
  const plan = await planAgentPulse({ locationId: loc, saved, store });
  assert.deepEqual(plan.counts.offerContacts, offerContacts, "GET /api/outreach/pulse shows it");
});
