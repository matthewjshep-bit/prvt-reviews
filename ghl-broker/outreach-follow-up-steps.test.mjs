// outreach-follow-up-steps.test.mjs — each follow-up to an agent who never
// answered our first text is its own text (2026-10-20).
//
// Matt: "a standardized way of following up with people … the first text …
// and then the second text … as a follow-up", charted out like a GHL
// workflow. Until now the ladder ran six rungs (days 2, 5, 9, 14, 21, 30) and
// every rung picked from the same three texts by the contact id alone, so an
// agent got the same follow-up word for word on every rung.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "follow-up-steps-test-"));

const { standardText, fillTemplate, NUDGE_TEXTS } = await import("./shared/standard-texts.js");
const { normalizeOpener, DEFAULT_FOLLOW_UP_TEXTS } = await import("./shared/outreach-opener.js");
const { normalizeConversationAi } = await import("./shared/conversation-ai.js");
const { DEFAULT_LADDERS } = await import("./shared/follow-up.js");
const { outboundDescriptor } = await import("./reply-agent.js");

const nudge = (saved, step, steps = [3, 10]) =>
  outboundDescriptor({ kind: "outreach_nudge", offer: null, saved, subject: { address: "2210 Pine Ave, Seattle, WA", step, steps } });

test("an agent's second follow-up is not the first one word for word", () => {
  for (const contactId of ["c-rigo", "c-brenda", "c-1", "c-2", "c-3"]) {
    const first = standardText({ kind: "outreach_nudge", outbound: nudge({}, 3), name: "Rigo", contactId });
    const second = standardText({ kind: "outreach_nudge", outbound: nudge({}, 10), name: "Rigo", contactId });
    assert.notEqual(second.text, first.text, contactId);
  }
});

test("each follow-up step sends the text written for that step", () => {
  const saved = { outreachAutopilot: { opener: { followUps: ["Hi {first}, step one about {address}?", "Hi {first}, step two, any fixers?"] } } };
  assert.equal(standardText({ kind: "outreach_nudge", outbound: nudge(saved, 3), name: "Rigo", contactId: "c-rigo" }).text, "Hi Rigo, step one about 2210 Pine Ave?");
  assert.equal(standardText({ kind: "outreach_nudge", outbound: nudge(saved, 10), name: "Rigo", contactId: "c-rigo" }).text, "Hi Rigo, step two, any fixers?");
});

test("unset, follow-up 1 and 2 are today's two follow-up texts", () => {
  assert.deepEqual(DEFAULT_FOLLOW_UP_TEXTS, [NUDGE_TEXTS[0], NUDGE_TEXTS[1]]);
  assert.deepEqual(normalizeOpener({}).followUps, DEFAULT_FOLLOW_UP_TEXTS);
  const values = { first: "Rigo", address: "2210 Pine Ave" };
  assert.equal(standardText({ kind: "outreach_nudge", outbound: nudge({}, 3), name: "Rigo", contactId: "c-x" }).text, fillTemplate(NUDGE_TEXTS[0], values));
  assert.equal(standardText({ kind: "outreach_nudge", outbound: nudge({}, 10), name: "Rigo", contactId: "c-x" }).text, fillTemplate(NUDGE_TEXTS[1], values));
});

test("a step with no text of its own falls back to the pool, still not repeating the step before", () => {
  const saved = { outreachAutopilot: { opener: { followUps: ["Hi {first}, just one about {address}?"] } } };
  const second = standardText({ kind: "outreach_nudge", outbound: nudge(saved, 10), name: "Rigo", contactId: "c-rigo" });
  assert.ok(NUDGE_TEXTS.map((t) => fillTemplate(t, { first: "Rigo", address: "2210 Pine Ave" })).includes(second.text), second.text);
  const third = standardText({ kind: "outreach_nudge", outbound: nudge(saved, 20, [3, 10, 20]), name: "Rigo", contactId: "c-rigo" });
  assert.notEqual(third.text, second.text);
});

test("a step's text that needs the address falls back when there's no address", () => {
  const saved = { outreachAutopilot: { opener: { followUps: ["Hi {first}, about {address}?", "Hi {first}, any fixers lately?"] } } };
  const o = outboundDescriptor({ kind: "outreach_nudge", offer: null, saved, subject: { step: 3, steps: [3, 10] } });
  const s = standardText({ kind: "outreach_nudge", outbound: o, name: "Rigo", contactId: "c-rigo" });
  assert.equal(s, null, "nothing fillable about a house we can't name: the model writes it");
});

test("follow-up texts are cleaned like first texts: no stop footer, no sign-off, nothing long", () => {
  const long = `Hi {first}, ${"really ".repeat(40)}long text about {address}?`;
  const o = normalizeOpener({ followUps: ["Hi {first}, any fixers? Thanks, Matt", "Hi {first}, no worries if not can stop", long, "  "] });
  assert.deepEqual(o.followUps, ["Hi {first}, any fixers?"]);
  assert.deepEqual(normalizeOpener({ followUps: "Hi {first}, one?\n\nHi {first}, two?" }).followUps, ["Hi {first}, one?", "Hi {first}, two?"]);
});

test("the follow-up ladder defaults to two steps, day 3 and day 10", () => {
  assert.deepEqual(DEFAULT_LADDERS.outreach_nudge.steps, [3, 10]);
  assert.deepEqual(normalizeConversationAi({}).parties.agent.followUp.ladders.outreach_nudge.steps, [3, 10]);
});

test("a saved copy of the old six-step default reads as day 3 and day 10; steps Matt set himself are kept", () => {
  const old = normalizeConversationAi({ parties: { agent: { followUp: { enabled: true, ladders: { outreach_nudge: { enabled: true, steps: [2, 5, 9, 14, 21, 30] } } } } } });
  assert.deepEqual(old.parties.agent.followUp.ladders.outreach_nudge.steps, [3, 10]);
  assert.equal(old.parties.agent.followUp.ladders.outreach_nudge.enabled, true, "the switch is left as it was");
  const mine = normalizeConversationAi({ parties: { agent: { followUp: { ladders: { outreach_nudge: { steps: [4, 12, 25] } } } } } });
  assert.deepEqual(mine.parties.agent.followUp.ladders.outreach_nudge.steps, [4, 12, 25]);
});
