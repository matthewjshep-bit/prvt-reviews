// passed-checkin.test.mjs — every ten days on an offer they passed on, and
// the "last activity" column that stops saying "never" to agents we talk to.

import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LADDERS, FOLLOW_UP_KINDS, kindsFor, normalizeSteps } from "./shared/follow-up.js";
import { passedCandidates } from "./follow-up-sweep.js";
import { mergeGhlActivity } from "./shared/last-activity.js";
import { OUTBOUND_INTENTS } from "./shared/conversation-ai.js";

const DAY = 86400000;
const NOW = Date.parse("2026-09-12T16:00:00Z");
const ago = (d) => new Date(NOW - d * DAY).toISOString();

test("the passed-offer check-in is an agent ladder: every ten days, off until switched on", () => {
  assert.equal(FOLLOW_UP_KINDS.passed_checkin.party, "agent");
  assert.ok(kindsFor("agent").includes("passed_checkin"));
  assert.equal(DEFAULT_LADDERS.passed_checkin.enabled, false);
  assert.deepEqual(normalizeSteps(DEFAULT_LADDERS.passed_checkin.steps), [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);
  assert.ok(OUTBOUND_INTENTS.agent.includes("passed_checkin"));
});

test("passed offers are candidates, counted from when they passed; deals and moved-on offers aren't", async () => {
  const config = { parties: { agent: { followUp: { enabled: true, ladders: { passed_checkin: { enabled: true, steps: [10, 20] } } } } } };
  const store = {
    async listOffersForFollowUp(_loc, { statuses }) {
      assert.deepEqual(statuses, ["passed"]);
      return [
        { id: "o1", contactId: "c1", address: "12 Elm St", status: "passed", statusAt: ago(12),
          statusHistory: [{ status: "sent", ts: ago(20) }, { status: "passed", ts: ago(12) }],
          followUps: [{ kind: "offer_nudge", step: 3 }, { kind: "passed_checkin", step: 10 }] },
        { id: "o2", contactId: "c2", address: "7 Pine", status: "passed", statusAt: ago(15), deal: { stage: "under_contract" } },
        { id: "o3", contactId: "c3", address: "3 Oak", status: "countered", statusAt: ago(15) },
      ];
    },
  };
  const out = await passedCandidates({ store, locationId: "LOC", config, now: NOW });
  assert.deepEqual(out.map((c) => c.offerId), ["o1"]);
  assert.equal(out[0].startedAt, ago(12));
  assert.deepEqual(out[0].sentSteps, [10], "only its own rungs count");
  assert.equal((await passedCandidates({ store, locationId: "LOC", config: { parties: { agent: { followUp: { enabled: true, ladders: {} } } } }, now: NOW })).length, 0);
});

test("GHL's last message fills in agents the app never recorded, without overriding a fresher app record", () => {
  const map = new Map([
    ["app-newer", { at: ago(1), dir: "out", type: "follow_up_sent", machine: true }],
    ["ghl-newer", { at: ago(9), dir: "out", type: "offer_sent", machine: false }],
  ]);
  const ghl = new Map([
    ["never", { at: ago(3), dir: "in" }],
    ["app-newer", { at: ago(1), dir: "out" }],          // the same bot text, seen by both
    ["ghl-newer", { at: ago(2), dir: "out" }],
  ]);
  mergeGhlActivity(map, ghl, ["never", "app-newer", "ghl-newer", "nobody"]);
  assert.deepEqual(map.get("never"), { at: ago(3), dir: "in", type: "ghl_message", machine: false, source: "ghl" });
  assert.equal(map.get("app-newer").machine, true, "the app knows it was the bot");
  assert.equal(map.get("ghl-newer").type, "ghl_message");
  assert.equal(map.get("ghl-newer").machine, null, "GHL can't say who sent it");
  assert.equal(map.has("nobody"), false);
});
