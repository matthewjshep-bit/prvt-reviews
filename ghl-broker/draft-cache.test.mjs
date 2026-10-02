// draft-cache.test.mjs — one output format per party for machine texts.
//
// The output format is part of the cached prompt. A machine text used to
// carry a one-value intent list naming its own kind, so every kind (realm
// check, check-in, pulse, nudge…) had its own cache entry and re-wrote it at
// 2x on most sends: 46 writes in 158 machine texts, 2026-10-01/02. The kind
// is already named in the text's instructions ("Set intent to realm_check")
// and is stamped on the draft after, so nothing the model writes changes.
//
//   node --test draft-cache.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { schemaFor } from "./conversation-prompt.js";
import { parseDraft } from "./reply-agent.js";
import { INTENTS, normalizeConversationAi } from "./shared/conversation-ai.js";

test("every machine text to an agent sends the same output format, so the prompt cache isn't rewritten per kind", () => {
  for (const party of ["agent", "investor"]) {
    const kinds = party === "agent" ? ["realm_check", "checkin_due", "agent_pulse", "price_drop"] : ["buyer_pulse", "blast_nudge", "dataroom_nudge"];
    const formats = new Set(kinds.map((kind) => JSON.stringify(schemaFor(party, { outbound: { kind, address: "7 Elm St" } }))));
    assert.equal(formats.size, 1, `${party}: one format for every kind`);
  }
});

test("a reply to a person still picks from the reply intents", () => {
  assert.deepEqual(schemaFor("agent").properties.intent.enum, INTENTS.agent);
  assert.deepEqual(schemaFor("investor").properties.intent.enum, INTENTS.investor);
});

test("a machine text's draft still carries its kind as its intent", () => {
  const cfg = normalizeConversationAi(null);
  const response = (intent) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ intent, confidence: "high", reply: "Any movement on 7 Elm?" }) }] });
  const outbound = { kind: "passed_checkin", address: "7 Elm St" };
  assert.equal(parseDraft(response("passed_checkin"), [outbound.kind], cfg, outbound).intent, "passed_checkin");
  assert.equal(parseDraft(response("follow_up"), [outbound.kind], cfg, outbound).intent, "passed_checkin", "whatever the model wrote in the field");
  assert.equal(parseDraft(response("made_up"), INTENTS.agent, cfg).intent, "other", "a reply's unknown intent is still other");
});
