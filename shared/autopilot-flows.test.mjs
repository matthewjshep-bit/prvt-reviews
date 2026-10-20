// autopilot-flows.test.mjs — the Autopilot charts show what actually goes
// out, in order, and whether each text sends itself (2026-10-20).

import test from "node:test";
import assert from "node:assert/strict";

import { agentFlow, investorFlow, FLOW_STATUS_LABEL } from "./autopilot-flows.js";
import { normalizeConversationAi } from "./conversation-ai.js";
import { autopilotSummary } from "./graduation.js";
import { DEFAULT_OPENER_EXAMPLES, DEFAULT_FOLLOW_UP_TEXTS } from "./outreach-opener.js";

const flow = ({ settings = {}, raw = {}, sends = true, blasts = true, samples } = {}) => {
  const config = normalizeConversationAi(raw);
  const { switches } = autopilotSummary({ config, sendsEnabled: sends, outreach: settings.outreachAutopilot || null, importsEnabled: true, dispo: settings.dispoAutopilot || null, blastsEnabled: blasts });
  return { agents: agentFlow({ settings, config, switches }), investors: investorFlow({ settings, config, switches, samples }) };
};
const LIVE = {
  enabled: true,
  parties: {
    agent: { outreach: { enabled: true }, autoSend: { enabled: true, intents: ["outreach_open", "outreach_nudge"], channels: ["sms"] },
      followUp: { enabled: true, ladders: { outreach_nudge: { enabled: true } } } },
    investor: { autoSend: { enabled: true, intents: ["blast_open"], channels: ["sms"] } },
  },
};

test("the agent chart runs found → first text → wait → follow-up 1 → wait → follow-up 2 → they reply → check-in", () => {
  const { agents } = flow({ settings: { outreachAutopilot: { enabled: true } }, raw: LIVE });
  assert.deepEqual(agents.map((s) => s.id), ["found", "first", "wait-0", "follow-0", "wait-1", "follow-1", "reply", "checkin"]);
  assert.deepEqual(agents.map((s) => s.title).slice(2, 6), ["Wait until day 3", "Follow-up 1", "Wait until day 10", "Follow-up 2"]);
  assert.deepEqual(agents[1].texts, DEFAULT_OPENER_EXAMPLES);
  assert.deepEqual([agents[3].texts[0], agents[5].texts[0]], DEFAULT_FOLLOW_UP_TEXTS);
});

test("a follow-up's own text is what the chart shows, and a step without one says it uses a spare", () => {
  const settings = { outreachAutopilot: { opener: { followUps: ["Hi {first}, my one?"] } } };
  const raw = { ...LIVE, parties: { ...LIVE.parties, agent: { ...LIVE.parties.agent, followUp: { enabled: true, ladders: { outreach_nudge: { enabled: true, steps: [3, 10] } } } } } };
  const { agents } = flow({ settings, raw });
  assert.deepEqual(agents.find((s) => s.id === "follow-0").texts, ["Hi {first}, my one?"]);
  assert.equal(agents.find((s) => s.id === "follow-0").detail, "");
  assert.match(agents.find((s) => s.id === "follow-1").detail, /spare/);
});

test("each text says whether it sends itself, waits as a draft, or is off", () => {
  const live = flow({ raw: LIVE }).agents;
  assert.equal(live.find((s) => s.id === "first").status, "on");
  assert.equal(live.find((s) => s.id === "follow-0").status, "on");
  const noSends = flow({ raw: LIVE, sends: false }).agents;
  assert.equal(noSends.find((s) => s.id === "first").status, "drafting", "nothing leaves without CARD_SENDS_ENABLED");
  const off = flow({ raw: {} }).agents;
  assert.equal(off.find((s) => s.id === "first").status, "off");
  assert.equal(off.find((s) => s.id === "follow-0").status, "off");
  assert.equal(off.find((s) => s.id === "checkin").status, "off");
  assert.equal(FLOW_STATUS_LABEL.drafting, "Drafts for you");
});

test("a first text GHL sends says so, and shows no wording of ours", () => {
  const { agents } = flow({ settings: { outreachAutopilot: { firstTouch: "workflow" } }, raw: LIVE });
  const first = agents.find((s) => s.id === "first");
  assert.equal(first.status, "ghl");
  assert.equal(first.texts, undefined);
  assert.match(first.detail, /GHL/);
});

test("the agent check-in sends itself only with its own auto-send and the broker's sends on", () => {
  const pulse = (p, sends = true) => flow({ settings: { outreachAutopilot: { pulse: p } }, raw: LIVE, sends }).agents.find((s) => s.id === "checkin").status;
  assert.equal(pulse({ enabled: true }), "drafting");
  assert.equal(pulse({ enabled: true, autoSend: true }), "on");
  assert.equal(pulse({ enabled: true, autoSend: true }, false), "drafting");
});

test("the deal chart: promoted → wave 1 → reply → the one follow-up → wave 2 → walkthrough, and the check-in between deals", () => {
  const { investors } = flow({ settings: { dispoAutopilot: { autoBlastOnPromote: true } }, raw: LIVE, samples: ["Hey Alex, got 1 Elm St under contract."] });
  assert.deepEqual(investors.deal.map((s) => s.id), ["promoted", "wait-promote", "wave-1", "reply", "wait-follow", "follow", "wait-wave-2", "wave-2", "walkthrough"]);
  assert.equal(investors.deal.find((s) => s.id === "wave-1").status, "on");
  assert.deepEqual(investors.deal.find((s) => s.id === "wave-1").texts, ["Hey Alex, got 1 Elm St under contract."]);
  assert.match(investors.deal.find((s) => s.id === "wave-1").detail, /Up to 25 VIP and Active buyers.*match 50\+/);
  assert.equal(investors.deal.find((s) => s.id === "wave-2").texts, undefined, "wave 2 says it's the same text, not all three again");
  assert.equal(investors.deal[0].status, "auto", "a trigger runs itself; it doesn't send");
  assert.deepEqual(investors.between.map((s) => s.id), ["pulse"]);
  assert.match(investors.note, /At most 1 text a week/);
});

test("with blast-on-promote off, later waves read off and nothing waits ten minutes", () => {
  const { investors } = flow({ raw: LIVE });
  assert.ok(!investors.deal.some((s) => s.id === "wait-promote"));
  assert.equal(investors.deal.find((s) => s.id === "wave-2").status, "off");
  assert.match(investors.deal[0].detail, /you pick the buyers/);
});

test("three waves draw a third; deals blasted by GHL say so", () => {
  const three = flow({ settings: { dispoAutopilot: { autoBlastOnPromote: true, maxWaves: 3 } }, raw: LIVE }).investors.deal;
  assert.ok(three.some((s) => s.id === "wave-3"));
  const ghl = flow({ settings: { dispoAutopilot: { sendWith: "ghl" } }, raw: LIVE }).investors.deal;
  assert.equal(ghl.find((s) => s.id === "wave-1").status, "ghl");
});
