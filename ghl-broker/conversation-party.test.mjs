import test from "node:test";
import assert from "node:assert/strict";
import { matchTagPatterns, resolveParty } from "./conversation-party.js";

const ROUTING = { agentTags: ["agent", "agent-*"], investorTags: ["investor", "investor-*", "on-deal"], priority: "agent" };

test("an explicit party from the workflow wins over the tags", () => {
  const r = resolveParty({ explicit: "Investor", tags: ["agent"], routing: ROUTING });
  assert.equal(r.party, "investor");
  assert.equal(r.source, "explicit");
  assert.equal(resolveParty({ explicit: "martian", tags: ["agent"], routing: ROUTING }).party, "agent");
});

test("exact tags and star patterns both match, case-insensitively", () => {
  assert.deepEqual(matchTagPatterns(["Agent", "agent-hot", "dispo-2010-ne-54th"], ["agent", "agent-*"]), ["agent", "agent-hot"]);
  assert.deepEqual(matchTagPatterns(["investor-active"], ["investor"]), [], "no star, no prefix match");
  assert.deepEqual(matchTagPatterns(["dispo-vashon"], ["dispo-*"]), ["dispo-vashon"]);
  assert.deepEqual(matchTagPatterns(["a.b"], ["a.b"]), ["a.b"], "a dot is a dot");
});

test("agent, investor, both, neither", () => {
  assert.equal(resolveParty({ tags: ["agent-warm"], routing: ROUTING }).party, "agent");
  assert.equal(resolveParty({ tags: ["on-deal"], routing: ROUTING }).party, "investor");
  const both = resolveParty({ tags: ["agent", "investor-active"], routing: ROUTING });
  assert.equal(both.party, "agent");
  assert.equal(both.source, "tags");
  assert.deepEqual(both.matched, { agent: ["agent"], investor: ["investor-active"] });
  assert.equal(resolveParty({ tags: ["agent", "investor"], routing: { ...ROUTING, priority: "investor" } }).party, "investor");
  const none = resolveParty({ tags: ["dispo-2010-ne-54th", "lead"], routing: ROUTING });
  assert.equal(none.party, "unknown");
  assert.equal(none.source, "none");
});

test("a blast tag on an agent does not make them an investor — the collision the old resolver had", () => {
  assert.equal(resolveParty({ tags: ["agent", "dispo-2010-ne-54th"], routing: ROUTING }).party, "agent");
});
