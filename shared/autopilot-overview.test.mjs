// autopilot-overview.test.mjs — Autopilot's front page: what the machines
// sent agents and buyers, and what's coming, in a few numbers (2026-10-20).

import test from "node:test";
import assert from "node:assert/strict";

import { autopilotOverview, OVERVIEW_MAX_LINES } from "./autopilot-overview.js";

const mech = (key, label, n = {}) => ({ key, label, sent: 0, replied: 0, queued: 0, planned: 0, held: 0, status: "on", next: null, ...n });
const PAGE = {
  period: "week",
  groups: [
    { key: "outreach", mechanisms: [mech("outreach_open", "First text", { sent: 40, replied: 9, queued: 12 })] },
    { key: "agent", mechanisms: [
      mech("outreach_nudge", "Cold-agent follow-up", { sent: 22, replied: 3, planned: 18, next: { at: "2026-10-21T16:00:00Z", state: "planned", count: 18 } }),
      mech("agent_pulse", "Agent check-in", { sent: 5, held: 2 }),
      mech("promise_due", "Promise we made"),
    ] },
    { key: "offer_live", mechanisms: [mech("offer_nudge", "Offer nudge", { queued: 1, next: { at: "2026-10-20T22:00:00Z", state: "queued", count: 1 } })] },
    { key: "offer_passed", mechanisms: [] },
    { key: "buyer", mechanisms: [
      mech("blast_first", "Deal blast · first wave", { sent: 25, replied: 4 }),
      mech("buyer_pulse", "Buyer check-in", { planned: 10 }),
      mech("deal_followup", "Deal follow-up"),
    ] },
  ],
};

test("agents and investors each get what went, what's coming and what's waiting on you, first texts and deal texts counted", () => {
  const { sides } = autopilotOverview(PAGE);
  const [agents, investors] = sides;
  assert.deepEqual([agents.label, agents.sent, agents.replied, agents.coming, agents.waiting], ["Agents", 67, 12, 31, 2]);
  assert.deepEqual([investors.label, investors.sent, investors.replied, investors.coming, investors.waiting], ["Investors", 25, 4, 10, 0]);
});

test("only the lines with something on them show, busiest first, and the soonest text coming is named", () => {
  const { sides } = autopilotOverview(PAGE);
  assert.deepEqual(sides[0].lines.map((l) => l.label), ["First text", "Follow-ups", "Check-ins", "Offer nudge"]);
  assert.deepEqual([sides[0].next.at, sides[0].next.label], ["2026-10-20T22:00:00Z", "Offer nudge"]);
  assert.deepEqual(sides[1].lines.map((l) => [l.label, l.sent, l.coming]), [["Deal text · wave 1", 25, 0], ["Check-ins", 0, 10]]);
});

test("past five lines, the rest fold into one", () => {
  const many = { groups: [{ key: "agent", mechanisms: Array.from({ length: 8 }, (_, i) => mech(`m${i}`, `Kind ${i}`, { sent: 10 - i })) }] };
  const lines = autopilotOverview(many).sides[0].lines;
  assert.equal(lines.length, OVERVIEW_MAX_LINES + 1);
  assert.deepEqual(lines.at(-1), { key: "other", label: "Everything else", sent: 5 + 4 + 3, coming: 0, waiting: 0, status: "", next: null });
});

test("nothing loaded yet is zeros, not an error", () => {
  const { sides } = autopilotOverview();
  assert.deepEqual(sides.map((s) => [s.sent, s.coming, s.lines.length]), [[0, 0, 0], [0, 0, 0]]);
});
