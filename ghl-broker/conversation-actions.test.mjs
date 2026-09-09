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

test("a buyer's no carries its reason to the deal, and a gripe with no reason files nothing", async () => {
  const seen = [];
  const out = await runActions({
    client: { call: async () => ({}) }, locationId: "LOC", contactId: "c9",
    draft: { propertyAddress: "22018 76th Ave W", passReason: { code: "price", note: "no meat on the bone at 498" } },
    actions: [{ id: "a1", type: "mark_investor_passed" }, { id: "a2", type: "record_deal_feedback" }],
    deps: {
      setInvestorStatus: async (args) => { seen.push(["status", args]); return { ok: true, address: "22018 76th Ave W", status: "passed", reasonLabel: "Price too high" }; },
      recordDealFeedback: async (args) => { seen.push(["feedback", args]); return { ok: true, address: "22018 76th Ave W", reasonLabel: "Price too high" }; },
    },
  });
  assert.deepEqual(out.map((a) => [a.status, a.detail]), [
    ["done", "passed on 22018 76th Ave W — Price too high"],
    ["done", "filed on 22018 76th Ave W — Price too high"],
  ]);
  assert.deepEqual(seen[0][1].reason, { code: "price", note: "no meat on the bone at 498" });
  assert.deepEqual(seen[1][1].reason, { code: "price", note: "no meat on the bone at 498" });

  // Nothing they said reads as a reason — no write, and not an error either.
  const quiet = await runActions({
    client: { call: async () => ({}) }, locationId: "LOC", contactId: "c9", draft: { passReason: null },
    actions: [{ id: "b1", type: "record_deal_feedback" }],
    deps: { recordDealFeedback: async () => { throw new Error("should not be called"); } },
  });
  assert.deepEqual(quiet.map((a) => [a.status, a.detail]), [["done", "nothing they said reads as a reason"]]);
});

test("tags and fields an intent rule sets are on the record, with the draft as their source", async () => {
  const profiles = new Map(); const events = [];
  const store = {
    getContactProfile: async () => profiles.get("c1") || null,
    upsertContactProfile: async (_l, id, patch) => { const row = { ...(profiles.get(id) || { facts: {} }), ...patch }; profiles.set(id, row); return row; },
    appendContactEvents: async (_l, _id, evs) => { events.push(...evs); return { inserted: evs.length, skipped: 0 }; },
  };
  const client = { call: async () => ({ customFields: [], customField: { id: "f1" } }) };
  const out = await runActions({
    client, locationId: "LOC", contactId: "c1", store,
    draft: { id: "d3", party: "investor", propertyAddress: "12 Elm St" },
    actions: [
      { id: "a1", type: "add_tags", tags: ["investor-hot", "tier-1"] },
      { id: "a2", type: "remove_tags", tags: ["investor-stale"] },
      { id: "a3", type: "set_field", key: "buybox_areas", value: "{{propertyAddress}}" },
      { id: "a4", type: "set_field", key: "some_other_field", value: "x" },
    ],
  });
  assert.ok(out.every((a) => a.status === "done"), JSON.stringify(out));
  assert.deepEqual(events.filter((e) => e.type === "tag_added").map((e) => e.data.tag), ["investor-hot", "tier-1"]);
  assert.deepEqual(events.filter((e) => e.type === "tag_removed").map((e) => e.data.tag), ["investor-stale"]);
  assert.ok(events.every((e) => e.ref === "d3" && e.source === "conversation"));
  assert.deepEqual(profiles.get("c1").facts.buybox_areas.map((e) => e.value), ["12 Elm St"], "a set_field on a fact key is a fact");
  assert.equal(profiles.get("c1").facts.some_other_field, undefined, "an arbitrary field is not");
  // No store at all: the actions still run and nothing throws.
  const quiet = await runActions({ client, locationId: "LOC", contactId: "c1", draft: { id: "d4" }, actions: [{ id: "b1", type: "add_tags", tags: ["x"] }] });
  assert.equal(quiet[0].status, "done");
});

test("auto actions clear at the same confidence the page lets a reply send at", () => {
  const strict = planActions({ party: "investor", intent: "interested", confidence: "medium", playbook: PLAYBOOK, minConfidence: "high" });
  assert.equal(strict.auto.length, 0, "high bar: a medium read only suggests");
  const liberal = planActions({ party: "investor", intent: "interested", confidence: "medium", playbook: PLAYBOOK, minConfidence: "medium" });
  assert.deepEqual(liberal.auto.map((a) => a.type), ["add_tags"], "medium bar: the tag goes; the dataroom invite is ask-only regardless");
  assert.equal(planActions({ party: "investor", intent: "interested", confidence: "low", playbook: PLAYBOOK, minConfidence: "medium" }).auto.length, 0, "low never clears");
});

/* ---------- re-quoting on their numbers ---------- */
// The action that makes "that's way too low" self-driving without conceding a
// dollar: it sends no text and moves no price of its own — it re-runs our
// arithmetic on their ARV and rehab and lets the revised number speak.

const requoteAction = [{ id: "r1", type: "requote_from_agent_numbers" }];
const aCounter = { id: "d9", propertyAddress: "12 Elm St", counterAmount: 310000 };

test("re-quoting reports the move it made in the operator's terms", async () => {
  const out = await runActions({
    client: {}, locationId: "LOC", contactId: "c1", draft: aCounter, actions: requoteAction,
    deps: { requoteFromAgentNumbers: async () => ({ ok: true, address: "12 Elm St", from: 259000, to: 272000, clamped: false, floated: true }) },
  });
  assert.equal(out[0].status, "done");
  assert.match(out[0].detail, /12 Elm St/);
  assert.match(out[0].detail, /\$259,000 → \$272,000/);
  assert.match(out[0].detail, /floating it now/);
});

test("a re-quote that had to clamp their numbers says so on the row", async () => {
  // The operator has to be able to see that we did NOT swallow the agent's
  // ARV whole — the reply is told to say "with your numbers, adjusted".
  const out = await runActions({
    client: {}, locationId: "LOC", contactId: "c1", draft: aCounter, actions: requoteAction,
    deps: { requoteFromAgentNumbers: async () => ({ ok: true, address: "12 Elm St", from: 259000, to: 266000, clamped: true, basis: "their ARV was capped against ours", floated: false }) },
  });
  assert.match(out[0].detail, /their ARV was capped against ours/);
});

test("re-quoting with nothing new from them reports it rather than failing", async () => {
  // Not an error: the action is wired to a counter, and plenty of counters
  // arrive with no new ARV attached. A red row would train the operator to
  // ignore red rows.
  const out = await runActions({
    client: {}, locationId: "LOC", contactId: "c1", draft: aCounter, actions: requoteAction,
    deps: { requoteFromAgentNumbers: async () => ({ ok: false, reason: "nothing new from them to re-quote on" }) },
  });
  assert.equal(out[0].status, "done");
  assert.equal(out[0].detail, "nothing new from them to re-quote on");
});

test("re-quoting is not wired on a broker without the dependency and says so", async () => {
  const out = await runActions({
    client: {}, locationId: "LOC", contactId: "c1", draft: aCounter, actions: requoteAction, deps: {},
  });
  assert.equal(out[0].status, "failed");
  assert.match(out[0].error, /not wired/);
});

test("a counter still parks for a person even when the re-quote is wired to it", async () => {
  // The action runs; the REPLY does not send. counter is in NEVER_AUTO and
  // nothing in this phase touches that — which is the whole reason the
  // re-quote is safe to automate.
  const { NEVER_AUTO } = await import("./shared/conversation-ai.js");
  assert.ok(NEVER_AUTO.agent.includes("counter"));
});

test("re-quoting is an agent move and is never offered on the investor playbook", async () => {
  const { actionAllowedFor } = await import("./shared/conversation-ai.js");
  assert.equal(actionAllowedFor("agent", "requote_from_agent_numbers"), true);
  assert.equal(actionAllowedFor("investor", "requote_from_agent_numbers"), false);
});

test("re-quoting may be set to run on its own — it is not ask-only", async () => {
  // Unlike a dataroom invite or a committed buyer, this commits us to nothing,
  // so an operator is allowed to let it fire unattended.
  const { ASK_ONLY_ACTIONS } = await import("./shared/conversation-ai.js");
  assert.equal(ASK_ONLY_ACTIONS.has("requote_from_agent_numbers"), false);
  const { auto } = planActions({
    party: "agent", intent: "counter", confidence: "high",
    playbook: { intentRules: { counter: { mode: "auto", actions: [{ type: "requote_from_agent_numbers" }] } } },
  });
  assert.equal(auto.length, 1);
});

test("an action may ask inside an auto rule, and send_offer goes through the send dep", async () => {
  const pb = { intentRules: { realm_yes: { mode: "auto", actions: [{ type: "add_tags", tags: ["realm-yes"] }, { type: "send_offer", mode: "ask", channels: ["sms"], docs: ["image", "pdf"] }] } } };
  const plan = planActions({ party: "agent", intent: "realm_yes", confidence: "high", playbook: pb });
  assert.deepEqual(plan.auto.map((a) => a.type), ["add_tags"]);
  assert.deepEqual(plan.suggested.map((a) => a.type), ["send_offer"]);
  // and an auto one inside an auto rule runs
  const pb2 = { intentRules: { realm_yes: { mode: "auto", actions: [{ type: "send_offer", mode: "auto" }] } } };
  assert.equal(planActions({ party: "agent", intent: "realm_yes", confidence: "high", playbook: pb2 }).auto.length, 1);
  // but never inside an ask rule
  const pb3 = { intentRules: { realm_yes: { mode: "ask", actions: [{ type: "send_offer", mode: "auto" }] } } };
  assert.equal(planActions({ party: "agent", intent: "realm_yes", confidence: "high", playbook: pb3 }).auto.length, 0);

  const seen = [];
  const deps = { sendOfferDocs: async (args) => { seen.push(args); return { ok: true, address: "12 Elm St", channels: ["sms"] }; } };
  const [done] = await runActions({ client: {}, locationId: "LOC", contactId: "c1", draft: { id: "d1", propertyAddress: "12 Elm St" },
    actions: [{ id: "a1", type: "send_offer", channels: ["sms"], docs: ["image"] }], deps });
  assert.equal(done.status, "done");
  assert.match(done.detail, /sent the offer on 12 Elm St by sms/);
  assert.deepEqual(seen[0], { contactId: "c1", addressHint: "12 Elm St", channels: ["sms"], docs: ["image"], draftId: "d1" });
  const [dry] = await runActions({ client: {}, locationId: "LOC", contactId: "c1", draft: {}, actions: [{ id: "a2", type: "send_offer" }],
    deps: { sendOfferDocs: async () => ({ ok: true, dryRun: true, address: "12 Elm St", channels: ["sms"] }) } });
  assert.match(dry.detail, /would send .* sends are off/);
  const [again] = await runActions({ client: {}, locationId: "LOC", contactId: "c1", draft: {}, actions: [{ id: "a3", type: "send_offer" }],
    deps: { sendOfferDocs: async () => ({ ok: true, unchanged: true, address: "12 Elm St", sentAt: "2026-09-01T10:00:00Z" }) } });
  assert.match(again.detail, /already went out on 2026-09-01/);
  const [none] = await runActions({ client: {}, locationId: "LOC", contactId: "c1", draft: {}, actions: [{ id: "a4", type: "send_offer" }], deps: {} });
  assert.equal(none.status, "failed");
});

test("book_call goes through the booking dep with the time from the action or the draft, and a refusal is a failure", async () => {
  const seen = [];
  const deps = { bookAppointment: async (a) => { seen.push(a); return { ok: true, label: a.label, calendarName: "Matt" }; } };
  const [done] = await runActions({ client: {}, locationId: "LOC", contactId: "c1", draft: { id: "d1", party: "agent" },
    actions: [{ id: "a1", type: "book_call", startTime: "2026-09-11T17:00:00Z", label: "Fri Sep 11 at 10:00am" }], deps });
  assert.equal(done.status, "done");
  assert.equal(done.detail, "booked Fri Sep 11 at 10:00am on Matt");
  assert.equal(seen[0].startTime, "2026-09-11T17:00:00Z");
  const [fromDraft] = await runActions({ client: {}, locationId: "LOC", contactId: "c1", draft: { id: "d2", booking: { chosen: { iso: "2026-09-12T17:00:00Z", label: "Sat" } } },
    actions: [{ id: "a2", type: "book_call" }], deps });
  assert.equal(seen[1].startTime, "2026-09-12T17:00:00Z");
  assert.equal(fromDraft.status, "done");
  const [refused] = await runActions({ client: {}, locationId: "LOC", contactId: "c1", draft: {}, actions: [{ id: "a3", type: "book_call", startTime: "2026-09-12T17:00:00Z" }],
    deps: { bookAppointment: async () => ({ ok: false, reason: "slot taken" }) } });
  assert.equal(refused.status, "failed");
  assert.match(refused.error, /slot taken/);
});
