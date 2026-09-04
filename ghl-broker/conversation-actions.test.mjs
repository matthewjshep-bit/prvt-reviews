import test from "node:test";
import assert from "node:assert/strict";
import { planActions, runActions } from "./conversation-actions.js";

const PLAYBOOK = {
  intentRules: {
    interested: { mode: "auto", actions: [{ type: "add_tags", tags: ["hot-investor"] }, { type: "suggest_dataroom_invite" }] },
    passing: { mode: "ask", actions: [{ type: "remove_tags", tags: ["hot-investor"] }] },
  },
};

test("auto rules fire only on high confidence; ask rules and dataroom invites are always suggested", () => {
  const hi = planActions({ party: "investor", intent: "interested", confidence: "high", playbook: PLAYBOOK });
  assert.deepEqual(hi.auto.map((a) => a.type), ["add_tags"]);
  assert.deepEqual(hi.suggested.map((a) => a.type), ["suggest_dataroom_invite"]);
  assert.equal(hi.suggested[0].mode, "ask");
  const med = planActions({ party: "investor", intent: "interested", confidence: "medium", playbook: PLAYBOOK });
  assert.deepEqual(med.auto, []);
  assert.equal(med.suggested.length, 2);
  const ask = planActions({ party: "investor", intent: "passing", confidence: "high", playbook: PLAYBOOK });
  assert.deepEqual(ask.auto, []);
  assert.equal(ask.suggested[0].type, "remove_tags");
  assert.deepEqual(planActions({ party: "investor", intent: "question", confidence: "high", playbook: PLAYBOOK }), { auto: [], suggested: [] });
  assert.ok(hi.auto[0].id && hi.auto[0].status === "pending");
});

function recordingClient() {
  const calls = [];
  return {
    calls,
    client: {
      call: async (path, opts = {}) => {
        calls.push([opts.method || "GET", path, opts.body]);
        if (path.endsWith("/customFields") && !opts.method) return { customFields: [{ id: "f1", name: "last_intent", fieldKey: "contact.last_intent" }] };
        if (path.startsWith("/contacts/c1") && opts.method === "PUT") return { contact: {} };
        return {};
      },
    },
  };
}

test("each executor makes the GHL call its name says, and records what it did", async () => {
  const { client, calls } = recordingClient();
  const draft = { intent: "interested", propertyAddress: "12 Elm St", summary: "wants photos", now: Date.parse("2026-09-04T00:00:00Z") };
  const out = await runActions({
    client, locationId: "LOC", contactId: "c1", draft,
    actions: [
      { id: "a1", type: "add_tags", tags: ["hot-investor"] },
      { id: "a2", type: "remove_tags", tags: ["cold"] },
      { id: "a3", type: "set_field", key: "last_intent", value: "{{intent}} on {{propertyAddress}} {{date}}" },
      { id: "a4", type: "add_to_workflow", workflowId: "wf1", workflowName: "Investor follow-up" },
    ],
  });
  assert.deepEqual(out.map((a) => a.status), ["done", "done", "done", "done"]);
  assert.deepEqual(calls[0], ["POST", "/contacts/c1/tags", { tags: ["hot-investor"] }]);
  assert.deepEqual(calls[1], ["DELETE", "/contacts/c1/tags", { tags: ["cold"] }]);
  const put = calls.find(([m, p]) => m === "PUT" && p === "/contacts/c1");
  assert.deepEqual(put[2], { customFields: [{ id: "f1", value: "interested on 12 Elm St 2026-09-04" }] });
  const wf = calls.find(([, p]) => p === "/contacts/c1/workflow/wf1");
  assert.equal(wf[0], "POST");
  assert.ok(wf[2].eventStartTime);
  assert.equal(out[3].detail, "added to Investor follow-up");
});

test("internal actions go through the injected deps, and a failure records rather than throws", async () => {
  const seen = [];
  const out = await runActions({
    client: { call: async () => { throw new Error("GHL down"); } }, locationId: "LOC", contactId: "c1",
    draft: { propertyAddress: "12 Elm St", inbound: "send me 12 Elm" },
    actions: [
      { id: "a1", type: "link_deal_evaluating" },
      { id: "a2", type: "start_underwrite" },
      { id: "a3", type: "add_tags", tags: ["x"] },
      { id: "a4", type: "suggest_dataroom_invite" },
      { id: "a5", type: "teleport" },
    ],
    deps: {
      linkDealInterest: async (args) => { seen.push(["link", args]); return { linked: true, address: "12 Elm St", status: "evaluating" }; },
      startUnderwrite: async (args) => { seen.push(["uw", args]); return { job: { dryRun: true } }; },
      issueDataroomInvite: async () => { throw new Error("no dataroom for that deal — build one first"); },
    },
  });
  assert.equal(out[0].status, "done");
  assert.equal(out[0].detail, "evaluating 12 Elm St");
  assert.deepEqual(seen[0][1], { contactId: "c1", addressHint: "12 Elm St" });
  assert.equal(out[1].status, "done");
  assert.match(out[1].detail, /dry run/);
  assert.deepEqual(seen[1][1], { contactId: "c1", message: "send me 12 Elm", address: "12 Elm St" });
  assert.equal(out[2].status, "failed");
  assert.match(out[2].error, /GHL down/);
  assert.equal(out[3].status, "failed");
  assert.match(out[3].error, /build one first/);
  assert.equal(out[4].status, "failed");
  assert.match(out[4].error, /unknown action/);
});

test("a field template whose tokens came up empty writes nothing rather than blanking the field", async () => {
  const calls = [];
  const client = { call: async (path, opts = {}) => { calls.push([opts.method || "GET", path]); return { customFields: [] }; } };
  const out = await runActions({
    client, locationId: "LOC", contactId: "c1", draft: { propertyAddress: "" },
    actions: [{ id: "a1", type: "set_field", key: "subject_property", value: "{{propertyAddress}}" }],
  });
  assert.equal(out[0].status, "done");
  assert.match(out[0].detail, /nothing to write/);
  assert.equal(calls.some(([m]) => m === "PUT"), false);
});

test("leaving a workflow they weren't in is not a failure, and the status actions go through the deps", async () => {
  const client = { call: async (path, opts = {}) => {
    if (opts.method === "DELETE" && path.includes("/workflow/")) { const e = new Error("not enrolled"); e.status = 404; throw e; }
    return {};
  } };
  const out = await runActions({
    client, locationId: "LOC", contactId: "c1", draft: { propertyAddress: "12 Elm St", counterAmount: 425000, summary: "s" },
    actions: [
      { id: "a1", type: "remove_from_workflow", workflowId: "w3", workflowName: "TIER 3" },
      { id: "a2", type: "mark_offer_countered" },
      { id: "a3", type: "mark_offer_passed" },
      { id: "a4", type: "mark_investor_committed" },
    ],
    deps: {
      setOfferStatus: async ({ status }) => (status === "passed" ? { ok: false, reason: "no open offer to mark" } : { ok: true, address: "12 Elm St", status }),
      setInvestorStatus: async () => ({ ok: false, reason: "which deal? — no property named" }),
    },
  });
  assert.deepEqual(out.map((a) => [a.status, a.detail || a.error]), [
    ["done", "not in TIER 3"],
    ["done", "offer on 12 Elm St marked countered"],
    ["done", "no open offer to mark"],
    ["failed", "which deal? — no property named"],
  ]);
});
