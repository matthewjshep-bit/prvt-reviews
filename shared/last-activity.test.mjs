import test from "node:test";
import assert from "node:assert/strict";
import {
  lastActivityFromEvents, mergeDraftActivity, LAST_ACTIVITY_TYPES, INBOUND_EVENT_TYPES,
} from "./last-activity.js";

const NOW = Date.parse("2026-09-12T20:00:00Z");
const at = (h) => new Date(NOW - h * 3600000).toISOString();

test("theirs is 'in', ours is 'out', and the machine is named", () => {
  const m = lastActivityFromEvents([
    { contactId: "a1", type: "outreach_sent", at: at(50), source: "conversation", data: { auto: true } },
    { contactId: "a1", type: "text_summary", at: at(10), source: "conversation", data: { summary: "still thinking" } },
    { contactId: "a2", type: "offer_sent", at: at(20), source: "offer", data: {} },
    { contactId: "a3", type: "follow_up_sent", at: at(30), source: "conversation", data: {} },
  ]);
  assert.deepEqual(m.get("a1"), { at: at(10), dir: "in", type: "text_summary", machine: false });
  assert.equal(m.get("a2").dir, "out");
  assert.equal(m.get("a2").machine, false, "a send from the button is a person");
  assert.equal(m.get("a3").machine, true, "the follow-up clock is the machine");
});

test("a tag, a fact or an import is not a communication", () => {
  const m = lastActivityFromEvents([
    { contactId: "a1", type: "text_summary", at: at(40), source: "conversation", data: {} },
    { contactId: "a1", type: "tag_added", at: at(1), source: "conversation", data: { tag: "tier-1" } },
    { contactId: "a2", type: "import", at: at(2), source: "import", data: {} },
    { contactId: "a3", type: "fact_learned", at: at(3), source: "conversation", data: {} },
  ]);
  assert.equal(m.get("a1").at, at(40), "the tag did not move it");
  assert.equal(m.has("a2"), false, "an import is not someone talking");
  assert.equal(m.has("a3"), false);
  for (const t of ["tag_added", "import", "fact_learned", "enrich_run", "note"]) {
    assert.ok(!LAST_ACTIVITY_TYPES.includes(t), `${t} must stay out of the query`);
  }
});

test("newest wins whichever order the rows arrive in", () => {
  const rows = [
    { contactId: "a1", type: "text_summary", at: at(5), source: "conversation", data: {} },
    { contactId: "a1", type: "offer_sent", at: at(9), source: "offer", data: {} },
  ];
  assert.equal(lastActivityFromEvents(rows).get("a1").dir, "in");
  assert.equal(lastActivityFromEvents([...rows].reverse()).get("a1").dir, "in");
});

test("a contact we never spoke to is simply absent — that is the true 'never'", () => {
  const m = lastActivityFromEvents([]);
  assert.equal(m.size, 0);
  assert.equal(m.get("a1"), undefined);
});

// The summariser is a model call and it can fail; the draft row never does.
test("a draft fills in an inbound the timeline missed, and loses when it is older", () => {
  const m = lastActivityFromEvents([{ contactId: "a1", type: "outreach_sent", at: at(30), source: "conversation", data: { auto: true } }]);
  mergeDraftActivity(m, [{ contactId: "a1", inbound: "still interested?", createdAt: at(4), status: "draft" }]);
  assert.deepEqual(m.get("a1"), { at: at(4), dir: "in", type: "text_summary", machine: false });

  const fresh = lastActivityFromEvents([{ contactId: "a2", type: "text_summary", at: at(2), source: "conversation", data: {} }]);
  mergeDraftActivity(fresh, [{ contactId: "a2", inbound: "old one", createdAt: at(40), status: "draft" }]);
  assert.equal(fresh.get("a2").at, at(2), "a stale draft never overwrites a newer event");
});

test("a sent draft is outbound, and says whether it sent itself", () => {
  const m = mergeDraftActivity(new Map(), [
    { contactId: "a1", inbound: "hi", createdAt: at(9), status: "sent", sentAt: at(8), autoSent: true },
    { contactId: "a2", inbound: "hi", createdAt: at(9), status: "sent", sentAt: at(7), autoSent: false },
  ]);
  assert.deepEqual(m.get("a1"), { at: at(8), dir: "out", type: "text_summary", machine: true });
  assert.equal(m.get("a2").machine, false, "you pressed send");
});

test("the inbound vocabulary is the two that are actually their words", () => {
  assert.deepEqual(INBOUND_EVENT_TYPES, ["text_summary", "call_summary"]);
});
