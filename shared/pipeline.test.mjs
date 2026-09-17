// pipeline.test.mjs — where a card lands and what gets flagged. Every case is
// a plain-object fixture and an injected clock.

import test from "node:test";
import assert from "node:assert/strict";
import { buildPipeline, draftOfferId, daysUntilYmd, ACTION_KINDS } from "./pipeline.js";
import { normalizeConversationAi } from "./conversation-ai.js";

const NOW = Date.parse("2026-09-08T18:00:00.000Z");
const D = (n) => new Date(NOW - n * 86400000).toISOString();
const ymd = (n) => new Date(NOW + n * 86400000).toISOString().slice(0, 10);

const CFG = normalizeConversationAi({
  enabled: true,
  parties: { agent: { followUp: { enabled: true, ladders: { offer_nudge: { enabled: true, steps: [3, 7, 14] } } } } },
});
const offer = (over = {}) => ({
  id: "o1", contactId: "a1", contactName: "Sarah", address: "12 Elm St, Renton, WA", cashAmount: 265000,
  status: "sent", statusAt: D(5), createdAt: D(6), sends: [{ ts: D(5), channels: ["sms"] }], ...over,
});
const draft = (over = {}) => ({
  id: "d1", contactId: "a1", contactName: "Sarah", status: "draft", party: "agent", intent: "question",
  propertyAddress: "12 Elm St, Renton, WA", createdAt: D(0), actions: [], ...over,
});
const build = (o = {}) => buildPipeline({ config: CFG, now: NOW, ...o });
const laneOf = (r, id) => r.cards.find((c) => c.id === id)?.lane;
const kinds = (r) => r.actions.map((a) => a.kind);

/* ---------- lanes ---------- */

test("a held underwrite draft lands in needs_review and produces an underwrite_held action carrying the hold reasons", () => {
  const r = build({ offers: [offer({ status: "draft", sends: [], autoUnderwrite: { jobId: "j1", held: ["only two rehabbed comps"], finishedAt: D(1) } })] });
  assert.equal(laneOf(r, "o1"), "needs_review");
  const a = r.actions.find((x) => x.kind === "underwrite_held");
  assert.ok(a);
  assert.equal(a.severity, "soon");
  assert.match(a.detail, /two rehabbed comps/);
  assert.deepEqual(a.ops.map((o) => o.key), ["open_editor", "drop"]);
});

test("a held draft a person published is a priced offer, not a look nobody took", () => {
  const r = build({ offers: [offer({ status: "new", cashAmount: 429000, sends: [], proactive: { realmCheckAt: D(1) },
    autoUnderwrite: { jobId: "j1", held: ["only 1 listing photo to scan"], finishedAt: D(1), publishedAt: D(1) } })] });
  assert.equal(laneOf(r, "o1"), "floated");
  assert.ok(!r.actions.some((x) => x.kind === "underwrite_held"));
});

test("a hand-made draft is neither a card nor an action, only a hidden count", () => {
  const r = build({ offers: [offer({ status: "draft", sends: [] })] });
  assert.equal(r.cards.length, 0);
  assert.equal(r.actions.length, 0);
  assert.equal(r.counts.hidden.drafts, 1);
});

test("a new offer with a take-check stamp is floated, and the chip says which float", () => {
  const r = build({ offers: [offer({ status: "new", sends: [], proactive: { takeCheckAt: D(1) } })] });
  assert.equal(laneOf(r, "o1"), "floated");
  assert.ok(r.cards[0].chips.some((c) => c.label === "floated: take"));
  const r2 = build({ offers: [offer({ status: "new", sends: [], proactive: { takeCheckAt: D(2), realmCheckAt: D(1) } })] });
  assert.ok(r2.cards[0].chips.some((c) => c.label === "floated: realm"));
});

test("a new AI offer with nothing floated is ready and asks to be floated", () => {
  const r = build({ offers: [offer({ status: "new", sends: [], autoUnderwrite: { jobId: "j1", passed: true } })] });
  assert.equal(laneOf(r, "o1"), "ready");
  const a = r.actions.find((x) => x.kind === "offer_ready");
  assert.ok(a);
  assert.ok(a.ops.some((o) => o.key === "float_take"));
});

test("a hand-made unsent offer is ready but is not nagged to be floated", () => {
  const r = build({ offers: [offer({ status: "new", sends: [] })] });
  assert.equal(laneOf(r, "o1"), "ready");
  assert.equal(kinds(r).includes("offer_ready"), false);
});

test("a sent offer with two rungs fired shows step 2 of 3", () => {
  const r = build({ offers: [offer({ followUps: [{ kind: "offer_nudge", step: 3, at: D(2) }, { kind: "offer_nudge", step: 7, at: D(0) }], statusAt: D(8), sends: [{ ts: D(8) }] })] });
  assert.equal(laneOf(r, "o1"), "sent");
  assert.ok(r.cards[0].chips.some((c) => c.label === "step 2 of 3"), JSON.stringify(r.cards[0].chips));
});

test("a sent offer whose non-repeating ladder ran out with no reply is a ladder_exhausted action", () => {
  const plain = normalizeConversationAi({ enabled: true, parties: { agent: { followUp: { enabled: true, ladders: { offer_nudge: { enabled: true, steps: [3, 7, 14], repeatEvery: 0 } } } } } });
  const r = buildPipeline({ config: plain, now: NOW, offers: [offer({ sends: [{ ts: D(20) }], statusAt: D(20),
    followUps: [3, 7, 14].map((s) => ({ kind: "offer_nudge", step: s, at: D(20 - s) })) })] });
  assert.ok(r.cards[0].chips.some((c) => c.label === "ladder done"));
  const a = r.actions.find((x) => x.kind === "ladder_exhausted");
  assert.ok(a);
  assert.match(a.title, /3 follow-ups, no reply/);
  assert.ok(a.ops.some((o) => o.key === "mark_no_response"));
});

test("a reply from the agent after the ladder ran out cancels the nag and shows they replied", () => {
  const r = build({
    offers: [offer({ sends: [{ ts: D(20) }], statusAt: D(20), followUps: [3, 7, 14].map((s) => ({ kind: "offer_nudge", step: s, at: D(20 - s) })) })],
    events: [{ type: "text_summary", contactId: "a1", at: D(1) }],
  });
  assert.equal(kinds(r).includes("ladder_exhausted"), false);
  assert.ok(r.cards[0].chips.some((c) => c.key === "replied"));
});

test("with the ladder off, a sent offer silent for two weeks is only an fyi", () => {
  const r = buildPipeline({ config: normalizeConversationAi({ enabled: true }), now: NOW,
    offers: [offer({ sends: [{ ts: D(16) }], statusAt: D(16) })] });
  const a = r.actions.find((x) => x.kind === "gone_quiet");
  assert.ok(a);
  assert.equal(a.severity, "fyi");
});

test("an offer past its expiry date stays in its lane with no expiry chip or queue item", () => {
  const r = build({ offers: [offer({ expiresAt: D(2) })] });
  assert.equal(laneOf(r, "o1"), "sent");
  assert.equal(r.cards[0].deadReason, null);
  assert.equal(r.counts.hidden.dead, 0);
  assert.equal(r.counts.lanes.sent, 1);
  assert.ok(!r.cards[0].chips.some((c) => c.key === "expired" || c.key === "expiring"));
  assert.ok(!r.actions.some((a) => /expir/.test(a.kind)));
  assert.ok(!ACTION_KINDS.some((k) => /expir/.test(k.key)), "the queue has no expiry groups");
});

test("the date on an offer never stops a finished, non-repeating ladder from asking for a human", () => {
  const cfg = normalizeConversationAi({ enabled: true, parties: { agent: { followUp: { enabled: true, ladders: { offer_nudge: { enabled: true, steps: [3, 7, 14], repeatEvery: 0 } } } } } });
  const r = buildPipeline({ config: cfg, now: NOW, offers: [offer({ expiresAt: D(2), sends: [{ ts: D(20) }], statusAt: D(20),
    followUps: [{ kind: "offer_nudge", step: 3 }, { kind: "offer_nudge", step: 7 }, { kind: "offer_nudge", step: 14 }] })] });
  assert.deepEqual(kinds(r), ["ladder_exhausted"]);
});

test("a repeating offer ladder never runs out, so it never asks for a human", () => {
  const cfg = normalizeConversationAi({ enabled: true, parties: { agent: { followUp: { enabled: true, ladders: { offer_nudge: { enabled: true, steps: [3, 7, 14] } } } } } });
  const r = buildPipeline({ config: cfg, now: NOW, offers: [offer({ sends: [{ ts: D(40) }], statusAt: D(40),
    followUps: [{ kind: "offer_nudge", step: 3 }, { kind: "offer_nudge", step: 7 }, { kind: "offer_nudge", step: 14 }] })] });
  assert.ok(!kinds(r).includes("ladder_exhausted"));
});

test("an expired unsent offer stays in Not sent, like the offers tab", () => {
  const r = build({ offers: [offer({ status: "new", sends: [], expiresAt: D(2) })] });
  assert.equal(laneOf(r, "o1"), "ready");
  assert.equal(r.counts.hidden.dead, 0);
});

test("an offer expiring in five days is just an offer out", () => {
  const r = build({ offers: [offer({ expiresAt: new Date(NOW + 5.5 * 86400000).toISOString() })] });
  assert.equal(laneOf(r, "o1"), "sent");
  assert.ok(!r.cards[0].chips.some((c) => /expire/.test(c.label)));
  assert.ok(!r.actions.some((a) => /expir/.test(a.kind)));
});

test("an offer in no_response is hidden from lanes but counted", () => {
  const r = build({ offers: [offer({ status: "no_response" })] });
  assert.equal(laneOf(r, "o1"), "dead");
  assert.equal(r.counts.hidden.dead, 1);
  assert.equal(r.actions.length, 0);
});

/* ---------- deals ---------- */

const deal = (over = {}, dealOver = {}) => offer({
  status: "accepted", deal: { stage: "under_contract", createdAt: D(4), stageHistory: [{ stage: "under_contract", ts: D(4) }],
    contractPrice: 265000, assignmentFee: 30000, investors: [], feedback: [], ...dealOver }, ...over,
});

test("a deal closing in 5 days is soon; a deal that was due three days ago is now", () => {
  const soon = build({ offers: [deal({}, { closingDate: ymd(5) })] });
  assert.equal(soon.actions.find((a) => a.kind === "closing_soon")?.severity, "soon");
  assert.ok(soon.cards[0].chips.some((c) => c.label === "closes in 5d"));
  const late = build({ offers: [deal({}, { closingDate: ymd(-3) })] });
  const a = late.actions.find((x) => x.kind === "closing_soon");
  assert.equal(a.severity, "now");
  assert.match(a.title, /3d ago/);
});

test("an investor with a blast and a later dataroom view shows as opened, matched by street line", () => {
  const r = build({
    offers: [deal()],
    events: [
      { type: "blast_sent", contactId: "b1", address: "12 Elm St", at: D(3) },            // no offerId, street-line label
      { type: "dataroom_viewed", contactId: "b1", offerId: "o1", at: D(1), data: { viewCount: 2 } },
      { type: "blast_sent", contactId: "b2", address: "12 Elm St", at: D(3) },
    ],
  });
  const inv = r.cards[0].deal.investors;
  assert.deepEqual(inv.map((i) => [i.contactId, i.state]), [["b1", "opened"], ["b2", "blasted"]]);
  assert.equal(inv[0].viewCount, 2);
});

test("a committed investor shows committed and flags a stage lag while the deal is still under contract", () => {
  const lag = build({ offers: [deal({}, { investors: [{ contactId: "b1", name: "Ray", status: "committed", addedAt: D(1) }] })] });
  assert.equal(lag.cards[0].deal.investors[0].state, "committed");
  assert.equal(lag.actions.find((a) => a.kind === "stage_lag")?.ops[0].key, "advance");
  const ok = build({ offers: [deal({}, { stage: "buyer_found", investors: [{ contactId: "b1", name: "Ray", status: "committed" }] })] });
  assert.equal(laneOf(ok, "o1"), "buyer_found");
  assert.equal(kinds(ok).includes("stage_lag"), false);
});

test("a deal with nobody on it for two days asks for buyers", () => {
  const r = build({ offers: [deal()] });
  assert.ok(r.actions.some((a) => a.kind === "deal_no_buyers" && a.ops[0].key === "match_investors"));
});

test("a deal blasted three days ago with no opens is flagged; one open clears it", () => {
  const cold = build({ offers: [deal()], events: [{ type: "blast_sent", contactId: "b1", address: "12 Elm St", at: D(3) }] });
  assert.ok(kinds(cold).includes("blast_no_opens"));
  assert.equal(kinds(cold).includes("deal_no_buyers"), false, "a blast counts as somebody being on it");
  const warm = build({ offers: [deal()], events: [
    { type: "blast_sent", contactId: "b1", address: "12 Elm St", at: D(3) },
    { type: "dataroom_viewed", contactId: "b1", offerId: "o1", at: D(1) },
  ] });
  assert.equal(kinds(warm).includes("blast_no_opens"), false);
});

test("closed and fell-through deals leave the board but are counted", () => {
  const r = build({ offers: [deal({ id: "c" }, { stage: "closed" }), deal({ id: "f" }, { stage: "fell_through" })] });
  assert.equal(laneOf(r, "c"), "closed");
  assert.equal(laneOf(r, "f"), "dead");
  assert.equal(r.counts.hidden.closed, 1);
  assert.equal(r.counts.hidden.dead, 1);
});

/* ---------- drafts and hand-offs ---------- */

test("a counter draft with a failed band exception is a now action carrying the ceiling and the overshoot", () => {
  const r = build({ offers: [offer({ status: "countered", counter: { amount: 320000 } })],
    drafts: [draft({ intent: "counter", counterAmount: 320000, exception: { passed: false, theirAmount: 320000, ceiling: 292000, basis: "the 70% rule at a $10k assignment" } })] });
  const a = r.actions.find((x) => x.kind === "draft_waiting");
  assert.equal(a.severity, "now");
  assert.equal(a.title, "Counter $320,000 is $28,000 over the $292,000 ceiling");
  assert.ok(r.cards[0].chips.some((c) => c.label === "over by $28,000"));
  assert.deepEqual(r.cards[0].draftIds, ["d1"]);
});

test("a counter draft inside the band still waits on a person but is not urgent", () => {
  const r = build({ offers: [offer({ status: "countered" })],
    drafts: [draft({ intent: "question", exception: { passed: true, theirAmount: 280000, ceiling: 292000 } })] });
  assert.equal(r.actions.find((x) => x.kind === "draft_waiting").severity, "soon");
  assert.ok(r.cards[0].chips.some((c) => c.label === "in band"));
});

test("a never-auto intent parked as a draft is now even without a band verdict", () => {
  const r = build({ offers: [offer()], drafts: [draft({ intent: "wants_call" })] });
  assert.equal(r.actions[0].severity, "now");
});

test("a pending ask-only action on an open draft is a now hand-off", () => {
  const r = build({ offers: [offer({ status: "countered" })],
    drafts: [draft({ actions: [{ id: "x1", type: "revise_offer_to_counter", mode: "ask", status: "pending" }, { id: "x2", type: "add_tags", mode: "ask", status: "pending" }] })] });
  const h = r.actions.filter((a) => a.kind === "handoff");
  assert.equal(h.length, 1, "only ask-only types are hand-offs");
  assert.equal(h[0].actionId, "x1");
  assert.equal(h[0].severity, "now");
  assert.equal(h[0].title, "Re-issue the offer at their number");
});

test("a scheduled draft is only an fyi", () => {
  const r = build({ offers: [offer()], drafts: [draft({ status: "scheduled", sendAt: D(0) })] });
  assert.equal(r.actions[0].kind, "draft_scheduled");
  assert.equal(r.actions[0].severity, "fyi");
});

test("dismissed, sent and superseded drafts produce nothing", () => {
  const r = build({ offers: [offer()], drafts: ["dismissed", "sent", "superseded", "handled"].map((status, i) => draft({ id: `d${i}`, status, intent: "counter" })) });
  assert.equal(r.actions.length, 0);
  assert.deepEqual(r.cards[0].draftIds, []);
});

test("a draft attaches by contact and address, and stays unattached when the agent has two open offers elsewhere", () => {
  const byContact = new Map([["a1", [offer({ id: "x", address: "1 Oak St, Kent, WA" }), offer({ id: "y", address: "2 Fir Ln, Kent, WA" })]]]);
  assert.equal(draftOfferId(draft({ propertyAddress: "2 Fir Ln" }), byContact), "y");
  assert.equal(draftOfferId(draft({ propertyAddress: "" }), byContact), null);
  assert.equal(draftOfferId(draft({ outbound: { offerId: "z" } }), byContact), "z");
  const one = new Map([["a1", [offer({ id: "x" })]]]);
  assert.equal(draftOfferId(draft({ propertyAddress: "" }), one), "x");
});

test("an unattached draft is still in the queue", () => {
  const r = build({ offers: [], drafts: [draft({ intent: "counter" })] });
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].offerId, null);
});

/* ---------- jobs ---------- */

test("a running underwrite job with no offer row is an underwriting card; a done job is not", () => {
  const r = build({ jobs: [
    { id: "j1", status: "running", phase: "comps", contactId: "a9", contactName: "Lee", address: "9 Oak Ave", startedAt: D(0) },
    { id: "j2", status: "done", offerId: "o1", contactId: "a1", startedAt: D(0) },
  ] });
  assert.equal(r.cards.length, 1);
  assert.equal(r.cards[0].lane, "underwriting");
  assert.equal(r.cards[0].address, "9 Oak Ave");
  assert.equal(r.counts.lanes.underwriting, 1);
});

test("an underwrite that failed in the last hour is an fyi; an older one is forgotten", () => {
  const r = build({ jobs: [
    { id: "j1", status: "error", error: "Apify quota", address: "9 Oak Ave", finishedAt: new Date(NOW - 600000).toISOString() },
    { id: "j2", status: "error", error: "old", address: "1 Fir", finishedAt: D(2) },
  ] });
  assert.equal(r.actions.length, 1);
  assert.match(r.actions[0].detail, /Apify/);
});

/* ---------- shape ---------- */

test("events at the read limit set eventsTruncated", () => {
  const events = Array.from({ length: 5 }, (_, i) => ({ type: "text_summary", contactId: `c${i}`, at: D(1) }));
  assert.equal(build({ events, eventsLimit: 5 }).counts.eventsTruncated, true);
  assert.equal(build({ events, eventsLimit: 50 }).counts.eventsTruncated, false);
});

test("buildPipeline with empty inputs returns every lane with zero and no actions", () => {
  const r = buildPipeline({});
  assert.ok(r.lanes.length >= 10);
  assert.ok(r.lanes.every((l) => l.count === 0 && l.cardIds.length === 0));
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.counts.actions, { now: 0, soon: 0, fyi: 0 });
});

test("actions come now first, and lanes carry their card ids", () => {
  const r = build({
    offers: [deal({ id: "dl" }, { closingDate: ymd(-1) }), offer({ id: "ex", expiresAt: D(1) })],
  });
  assert.equal(r.actions[0].severity, "now");
  assert.deepEqual(r.lanes.find((l) => l.key === "under_contract").cardIds, ["dl"]);
});

test("days until a date counts today as zero", () => {
  assert.equal(daysUntilYmd(ymd(0), NOW), 0);
  assert.equal(daysUntilYmd(ymd(5), NOW), 5);
  assert.equal(daysUntilYmd(ymd(-3), NOW), -3);
  assert.equal(daysUntilYmd("", NOW), null);
});

/* ---------- cold agents ---------- */

test("a cold agent who never answered is counted for Reports and is not on Today; a reply or an offer clears it", () => {
  const DAY = 86400000, now = Date.parse("2026-09-20T17:00:00Z"), ago = (d) => new Date(now - d * DAY).toISOString();
  const config = normalizeConversationAi({ enabled: true, parties: { agent: { followUp: { enabled: true, ladders: { outreach_nudge: { enabled: true, steps: [2, 5] } } } } } });
  const opened = (c) => ({ contactId: c, type: "outreach_sent", at: ago(12), address: "9 Cold Creek Rd", data: { contactName: "Sam" } });
  const rung = (c, step, d) => ({ contactId: c, type: "follow_up_sent", at: ago(d), data: { kind: "outreach_nudge", step } });
  const r = buildPipeline({ offers: [], drafts: [], now, config, events: [
    opened("cold"), rung("cold", 2, 10), rung("cold", 5, 7),
    opened("replied"), rung("replied", 2, 10), { contactId: "replied", type: "text_summary", at: ago(6) },
    opened("pending"),                                            // no rungs sent yet: day 5 is still DUE, so the ladder is not over
  ], contactNames: { cold: "Sam Okafor" } });
  assert.equal(r.counts.coldNoReply, 1, "only the one whose ladder ran out with nothing back");
  assert.equal(r.actions.length, 0, "there is nothing for a person to do about a cold agent");
  assert.equal(ACTION_KINDS.some((k) => k.key === "outreach_no_reply"), false);
  assert.equal(r.cards.length, 0, "no card for a contact with no property");
  // an offer on anything of theirs moves them off the cold list
  const withOffer = buildPipeline({ offers: [{ id: "o1", contactId: "cold", address: "1 Any St", status: "sent", createdAt: ago(1) }], drafts: [], now, config, events: [opened("cold"), rung("cold", 2, 10), rung("cold", 5, 7)] });
  assert.equal(withOffer.counts.coldNoReply, 0);
  // ladder off: nothing to say
  const off = buildPipeline({ offers: [], drafts: [], now, config: normalizeConversationAi({}), events: [opened("cold"), rung("cold", 2, 10), rung("cold", 5, 7)] });
  assert.equal(off.counts.coldNoReply, 0);
});

test("a pending send_offer on a realm-yes reply is one click from a person", () => {
  const o = offer({ id: "o1", contactId: "c1", status: "sent" });
  const d = draft({ id: "d1", contactId: "c1", status: "draft", intent: "realm_yes",
    actions: [{ id: "a1", type: "add_tags", status: "done" }, { id: "a2", type: "send_offer", mode: "ask", status: "pending" }] });
  const r = build({ offers: [o], drafts: [d] });
  const h = r.actions.find((a) => a.kind === "handoff");
  assert.ok(h, "a handoff row exists");
  assert.equal(h.actionId, "a2");
  assert.equal(h.title, "Send the formal offer (the documents)");
  // in auto mode it is the machine's, not the queue's
  const auto = build({ offers: [o], drafts: [{ ...d, actions: [{ id: "a2", type: "send_offer", mode: "auto", status: "pending" }] }] });
  assert.equal(auto.actions.filter((a) => a.kind === "handoff").length, 0);
});

test("a hot offer sits in the Hot lane on the board; the mirror's laneFor still answers with its status lane", async () => {
  const { buildPipeline, laneFor } = await import("./pipeline.js");
  const ts = new Date(Date.now() - 86400000).toISOString();
  const o = { id: "h1", locationId: "L", contactId: "c1", address: "1 Hot St, Tacoma, WA", cashAmount: 400000, status: "countered", statusAt: ts, createdAt: ts, hot: { at: ts, by: "operator", note: "presenting tonight" } };
  const out = buildPipeline({ offers: [o], drafts: [], events: [], jobs: [], config: {}, contactNames: {}, now: Date.now() });
  const card = out.cards.find((c) => c.id === "h1");
  assert.equal(card.lane, "hot");
  assert.equal(card.under, "countered");
  assert.equal(out.counts.lanes.hot, 1);
  assert.equal(laneFor(o).lane, "countered");
});

/* ---------- promises: the row says what the machine would do ---------- */

const H = (n) => new Date(NOW - n * 3600000).toISOString();
const owed = (over = {}, data = {}) => ({
  type: "promise_owed", contactId: "a1", at: H(5), address: "12 Elm St, Renton, WA",
  data: { what: "number", text: "I'll run it by underwriting and get back to you with a number.", draftId: "d0", ...data }, ...over,
});
const promiseRow = (r) => r.actions.find((a) => a.kind === "promise_owed");

test("an owed-a-number row offers Send the number when the offer is priced", () => {
  const r = build({ offers: [offer({ status: "new", sends: [] })], events: [owed()] });
  const row = promiseRow(r);
  assert.equal(row.move, "send_number");
  assert.equal(row.offerId, "o1");
  assert.deepEqual(row.ops.map((o) => o.key), ["float_take", "float_realm", "dismiss_promise"]);
});

test("a promise we ended with a question to them is not on Today", () => {
  const r = build({ events: [owed({}, { text: "Fair enough. Is the seller showing any flexibility on price at this point?" })] });
  assert.equal(promiseRow(r), undefined);
  assert.equal(r.counts.actions.now, 0);
});

test("a held underwrite their numbers would clear offers Re-run, and one nobody can clear offers Open and fix", () => {
  const heldOffer = offer({ id: "h1", status: "draft", cashAmount: null, sends: [], autoUnderwrite: { held: ["only 1 priced comps — the price proxy needs 6"] } });
  const rerun = promiseRow(build({ offers: [heldOffer], events: [owed()], heldTriageByOffer: { h1: { action: "rerun", needs: ["value"], reason: "run it on their numbers" } } }));
  assert.deepEqual(rerun.ops.map((o) => o.key), ["rerun_held", "open_editor", "dismiss_promise"]);
  const yours = promiseRow(build({ offers: [heldOffer], events: [owed()] }));
  assert.equal(yours.move, "yours");
  assert.deepEqual(yours.ops.map((o) => o.key), ["open_editor", "dismiss_promise"]);
  assert.match(yours.detail, /only 1 priced comps/);
});

test("an owed answer we have since given is not on Today", () => {
  const sent = draft({ id: "d9", status: "sent", inbound: "what about referrals?", reply: "We pay a referral at closing.", createdAt: H(2), sentAt: H(2) });
  const r = build({ events: [owed({}, { what: "answer", text: "Let me check with my partner and get back to you." })], sentDrafts: [sent] });
  assert.equal(promiseRow(r), undefined);
});

/* ---------- rows that say why, and offer the fix ---------- */

test("a priced offer that couldn't float says why", () => {
  const o = offer({ status: "new", sends: [], autoUnderwrite: { jobId: "j1", held: [] }, proactive: { skipped: { kind: "realm_check", reason: "our offer there has already gone out", at: D(0) } } });
  const row = build({ offers: [o] }).actions.find((a) => a.kind === "offer_ready");
  assert.ok(row, "still a row");
  assert.match(row.detail, /didn't float: our offer there has already gone out/);
});

test("a failed underwrite can be retried from Today", () => {
  const job = { id: "j9", contactId: "a1", status: "error", address: "12 Elm St, Renton, WA", error: "stopped early — the comps provider timed out", finishedAt: new Date(NOW - 600000).toISOString() };
  const row = build({ jobs: [job] }).actions.find((a) => a.kind === "underwrite_failed");
  assert.deepEqual(row.ops.map((o) => o.key), ["retry_underwrite"]);
  const withDraft = build({ jobs: [{ ...job, offerId: "o7" }] }).actions.find((a) => a.kind === "underwrite_failed");
  assert.deepEqual(withDraft.ops.map((o) => o.key), ["retry_underwrite", "open_editor"]);
  const nowhere = build({ jobs: [{ ...job, address: "", contactId: null }] }).actions.find((a) => a.kind === "underwrite_failed");
  assert.deepEqual(nowhere.ops, [], "nothing to retry without a contact");
});
