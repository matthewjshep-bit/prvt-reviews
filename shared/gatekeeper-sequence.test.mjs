// gatekeeper-sequence.test.mjs — what goes to a gatekeeper and when, and
// what would give a draft away as a machine's. Names are made up.

import test from "node:test";
import assert from "node:assert/strict";
import { nextStep, callDue, gatekeeperPrompt, draftFlags, factsFor } from "./gatekeeper-sequence.js";
import { normalizeGatekeepers } from "./gatekeeper.js";

const g = normalizeGatekeepers({});
const DAY = 86400000;
const T0 = Date.parse("2026-11-02T17:00:00Z");
const ev = (type, daysAfter, data = {}) => ({ type, at: new Date(T0 + daysAfter * DAY).toISOString(), data });
const ESTATE = { hookKey: "probate:king:1", kind: "estate", decedent: "Harold Example", county: "King", firstPublished: "2026-10-20", firstSeen: "2026-10-21T00:00:00Z", house: { address: "1234 Elm St, Kent, WA 98032" } };
const GK = { kind: "probate_attorney", name: "Paul Counsel", firstName: "Paul", firm: "Counsel Law PLLC" };

test("the email goes first, about the estate with a house", () => {
  const r = nextStep({ events: [ev("import", 0)], hooks: [ESTATE], settings: g, now: T0 });
  assert.equal(r.step, "email");
  assert.equal(r.hook.hookKey, "probate:king:1");
});

test("the text only goes after the email has actually gone, a day later", () => {
  const queued = [ev("import", 0), ev("gatekeeper_queued", 0, { step: "email" })];
  assert.equal(nextStep({ events: queued, hooks: [ESTATE], settings: g, now: T0 + 3 * DAY }).step, null, "the email is still sitting in the outbox");
  const sent = [...queued, ev("gatekeeper_sent", 1, { step: "email" })];
  assert.equal(nextStep({ events: sent, hooks: [ESTATE], settings: g, now: T0 + 1.5 * DAY }).step, null);
  assert.equal(nextStep({ events: sent, hooks: [ESTATE], settings: g, now: T0 + 2 * DAY }).step, "text");
  assert.equal(nextStep({ events: sent, hooks: [ESTATE], settings: g, now: T0 + 2 * DAY, hasPhone: false }).step, null, "no phone, no text");
});

test("no email on file: the text goes alone", () => {
  assert.equal(nextStep({ events: [ev("import", 0)], hooks: [ESTATE], settings: g, now: T0, hasEmail: false }).step, "text");
  assert.equal(nextStep({ events: [ev("import", 0)], hooks: [ESTATE], settings: g, now: T0, hasEmail: false, hasPhone: false }).step, null);
});

test("once they answer, call, or Matt texts them himself, the machine is done", () => {
  const base = [ev("import", 0), ev("gatekeeper_queued", 0, { step: "email" }), ev("gatekeeper_sent", 0, { step: "email" })];
  for (const t of ["gatekeeper_replied", "email_received", "call_summary", "hand_reply"]) {
    const r = nextStep({ events: [...base, ev(t, 0.5)], hooks: [ESTATE], settings: g, now: T0 + 5 * DAY });
    assert.match(r.stop, /talking to us/, t);
  }
  assert.equal(nextStep({ events: [...base, ev("unsubscribed", 0.5)], hooks: [ESTATE], settings: g, now: T0 + 5 * DAY }).stop, "they opted out");
  assert.equal(callDue({ events: [...base, ev("gatekeeper_replied", 0.5)], settings: g, now: T0 + 5 * DAY }), false);
});

test("Matt's call is due two days after the email if nothing came back", () => {
  const base = [ev("import", 0), ev("gatekeeper_queued", 0, { step: "email" }), ev("gatekeeper_sent", 0, { step: "email" })];
  assert.equal(callDue({ events: base, settings: g, now: T0 + 1 * DAY }), false);
  assert.equal(callDue({ events: base, settings: g, now: T0 + 2 * DAY }), true);
});

test("no check-in without a new reason: a month later with nothing new is silence; a new estate is a check-in about it", () => {
  const base = [ev("import", 0), ev("gatekeeper_queued", 0, { step: "email", hookKey: ESTATE.hookKey }), ev("gatekeeper_sent", 0, { step: "email" }),
    ev("gatekeeper_queued", 1, { step: "text", hookKey: ESTATE.hookKey }), ev("gatekeeper_sent", 1, { step: "text" })];
  assert.match(nextStep({ events: base, hooks: [ESTATE], settings: g, now: T0 + 40 * DAY }).why, /nothing new to say/);
  const NEW = { hookKey: "probate:king:2", kind: "estate", decedent: "Ruth Newer", firstPublished: "2026-11-20", firstSeen: new Date(T0 + 20 * DAY).toISOString() };
  assert.match(nextStep({ events: base, hooks: [ESTATE, NEW], settings: g, now: T0 + 25 * DAY }).why, /no sooner than/, "not before the month is up");
  const r = nextStep({ events: base, hooks: [ESTATE, NEW], settings: g, now: T0 + 40 * DAY });
  assert.equal(r.step, "checkin");
  assert.equal(r.hook.hookKey, "probate:king:2");
});

test("the prompt carries only the facts we have, and never names a house we don't know", () => {
  const p = gatekeeperPrompt({ step: "email", gk: GK, hook: ESTATE, company: "Shep Flips", phone: "425-555-0100" });
  assert.equal(p.channel, "email");
  assert.match(p.user, /Estate of Harold Example, King County/);
  assert.match(p.user, /1234 Elm St in Kent/);
  assert.match(p.user, /call them Paul/);
  assert.match(p.system, /floor/);
  assert.match(p.system, /Never mention a referral fee/);
  const noHouse = factsFor({ gk: GK, hook: { ...ESTATE, house: null }, step: "email" });
  assert.ok(noHouse.some((f) => /don't name one/.test(f)));
  const t = gatekeeperPrompt({ step: "text", gk: GK, hook: ESTATE });
  assert.equal(t.channel, "sms");
  assert.match(t.system, /under 160 characters/);
  const title = gatekeeperPrompt({ step: "email", gk: { kind: "title", name: "Kim Rep", firstName: "Kim" }, hook: { kind: "closing", address: "12 Elm St, Kent, WA", closedAt: "2026-10-20" } });
  assert.match(title.user, /We closed 12 Elm St together/);
  assert.match(title.system, /falls out of escrow/);
});

test("Matt's own examples steer the voice", () => {
  const p = gatekeeperPrompt({ step: "email", gk: GK, hook: ESTATE, examples: ["Hey Paul, Matt here. Quick one on the Smith estate."] });
  assert.match(p.system, /How Matt writes/);
  assert.match(p.system, /Quick one on the Smith estate/);
});

test("a draft that reads like a machine, or isn't about them, is flagged", () => {
  const good = { subject: "Estate of Harold Example, 1234 Elm St", body: "Hi Paul,\n\nMatt Shepherd here, I fix up houses around Kent.\n\nIf the PR is weighing what to do with the Elm St house, I can put a written number in front of them this week. They can list it too and keep mine as a floor.\n\nIs the house going to be sold?\n\nMatt\nMatt Shepherd, Shep Flips\n425-555-0100" };
  assert.deepEqual(draftFlags({ step: "email", ...good, gk: GK, hook: ESTATE }), []);
  const bad = draftFlags({ step: "email", subject: "Quick question", body: "Hi there! I hope this finds you well — I wanted to reach out about a cash offer. Happy to pay you a referral fee.", gk: GK, hook: ESTATE });
  for (const f of ["hope this finds you", "reach out", "em dash", "exclamation", "referral fee", "cash", "doesn't name their estate or our closing", "doesn't use their name"]) assert.ok(bad.includes(f), f);
  const longText = draftFlags({ step: "text", body: `Paul, Matt Shepherd here. ${"x".repeat(160)} Elm St`, gk: GK, hook: ESTATE });
  assert.ok(longText.includes("over 160 characters"));
  assert.ok(draftFlags({ step: "email", subject: "Estate of Harold Example", body: "Hi Paul, per the notice to creditors…", gk: GK, hook: ESTATE }).includes("public records"));
});
