// outreach-scorecard.test.mjs — which text wins: first texts, follow-ups and
// check-ins scored by what came back.
//
// What would go wrong without these:
//   - two first texts would share one reply rate, and a text running three
//     times the opt-outs of the other would stay live unseen (the recent
//     listers, 2026-10-26 to 11-09)
//   - an agent texted two days ago would drag the 7-day reply rate down
//   - "STOP" would count as a reply
//   - a personal check-in and a generic one would be scored as one
//
//   node --test shared/outreach-scorecard.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOutreachScorecard, sendsFrom, outcomesFrom, templateHash, lengthBucket, stopReply, checkInDetail, SCORE_MIN_N,
} from "./outreach-scorecard.js";
import { standardText } from "./standard-texts.js";

const NOW = Date.parse("2026-11-09T20:00:00Z");
const DAY = 86400000;
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const later = (iso, hours) => new Date(Date.parse(iso) + hours * 3600000).toISOString();

const first = (contactId, at, std, data = {}) => ({ id: `o-${contactId}`, type: "outreach_sent", contactId, at, source: "conversation",
  data: { auto: true, chars: 110, county: "King", ...(std ? { standard: std, style: "standard" } : {}), ...data } });
const said = (contactId, at, inbound, intent = "has_property") => ({ id: `t-${contactId}-${at}`, type: "text_summary", contactId, at, source: "conversation", party: "agent", data: { inbound, intent } });
const rowsOf = (card, kind, dim) => Object.fromEntries((card.kinds[kind].dims[dim] || []).map((r) => [r.key, r]));

test("a rotation of three first texts gives each agent the same one on a retry", () => {
  const outbound = { mode: "template", address: "48 Quill Ave, Renton, WA", city: "Renton", county: "King",
    templates: ["Hi {first}, saw your listing on {street}. Does it need much work?", "Hey {first}, is your listing on {street} a bit of a project?", "Hi {first}, it's Matt. Any work needed on {street}?"] };
  const seen = new Set();
  for (const variant of [0, 1, 2]) {
    const a = standardText({ kind: "outreach_open", outbound: { ...outbound, variant }, name: "Corinne" });
    const again = standardText({ kind: "outreach_open", outbound: { ...outbound, variant }, name: "Corinne" });
    assert.deepEqual([again.set, again.index, again.template], [a.set, a.index, a.template], "the same text on a retry");
    assert.equal(a.template, outbound.templates[variant], "the unfilled text it was written from");
    seen.add(templateHash(a.template));
  }
  assert.equal(seen.size, 3, "three texts, three fingerprints");
  assert.equal(templateHash("  Hi {first},  any fixers? "), templateHash("Hi {first}, any fixers?"), "spacing doesn't make a new text");
  assert.equal(templateHash(""), "");
});

test("two first texts with different reply and STOP rates show their own numbers", () => {
  const A = { set: "opener", index: 0, templateHash: "aaa" };
  const B = { set: "past_listing", index: 1, templateHash: "bbb" };
  const events = [];
  for (let i = 0; i < 10; i++) {
    const at = ago(20);
    events.push(first(`a${i}`, at, A), first(`b${i}`, at, B));
    if (i < 4) events.push(said(`a${i}`, later(at, 5), "I might have one in Kent"));
    if (i < 1) events.push(said(`b${i}`, later(at, 5), "maybe next month"));
    if (i < 3) events.push(said(`b${i + 5}`, later(at, 2), "STOP", "opt_out"));
  }
  const card = buildOutreachScorecard({ sends: sendsFrom({ events }), ...outcomesFrom({ events }), now: NOW, labels: { templates: { aaa: "Hi {first}, saw your listing" } } });
  const t = rowsOf(card, "first_text", "template");
  assert.deepEqual([t["h:aaa"].n, t["h:aaa"].replied7, t["h:aaa"].stopped, t["h:aaa"].rates.replied7, t["h:aaa"].rates.stopped], [10, 4, 0, 40, 0]);
  assert.deepEqual([t["h:bbb"].n, t["h:bbb"].replied7, t["h:bbb"].stopped, t["h:bbb"].rates.stopped], [10, 1, 3, 30]);
  assert.equal(t["h:aaa"].label, "Hi {first}, saw your listing", "a known text reads as itself");
  assert.equal(t["h:bbb"].small, true, `under ${SCORE_MIN_N} sends is greyed`);
  assert.equal(card.kinds.first_text.totals.n, 20);
});

test("an agent texted two days ago is left out of the 7-day reply rate", () => {
  const std = { set: "opener", index: 0, templateHash: "aaa" };
  const events = [first("old", ago(10), std), first("new", ago(2), std), said("old", later(ago(10), 30), "send me what you've got")];
  const card = buildOutreachScorecard({ sends: sendsFrom({ events }), ...outcomesFrom({ events }), now: NOW });
  assert.equal(card.kinds.first_text.n, 1);
  assert.equal(card.kinds.first_text.young, 1, "counted as too new, not as unanswered");
  assert.equal(card.kinds.first_text.totals.rates.replied7, 100);
  assert.equal(card.kinds.first_text.totals.replied3, 1, "an answer the next day is inside three days too");
});

test("a send answered by STOP counts as stopped, not replied", () => {
  const std = { set: "opener", index: 0, templateHash: "aaa" };
  const events = [
    first("s1", ago(10), std), said("s1", later(ago(10), 1), "Stop", "question"),
    first("s2", ago(10), std), said("s2", later(ago(10), 2), "please take me off your list", "question"),
    first("s3", ago(10), std), { id: "u3", type: "unsubscribed", contactId: "s3", at: later(ago(10), 3), data: { via: "dnd" } },
    // "Stop by the open house" is not a STOP.
    first("s4", ago(10), std), said("s4", later(ago(10), 4), "Stop by the open house Saturday, it needs a roof"),
  ];
  const t = buildOutreachScorecard({ sends: sendsFrom({ events }), ...outcomesFrom({ events }), now: NOW }).kinds.first_text.totals;
  assert.deepEqual([t.n, t.stopped, t.replied7], [4, 3, 1]);
  assert.equal(stopReply("STOP"), true);
  assert.equal(stopReply("Stop by the open house Saturday"), false);
});

test("a personal check-in and a generic one are scored apart", () => {
  const pulse = (c, at, data) => ({ id: `p-${c}`, type: "agent_pulse_texted", contactId: c, at, source: "conversation", data: { auto: true, segment: "engaged", ...data } });
  const events = [
    pulse("g1", ago(15), { standard: { set: "checkin", index: 0, templateHash: "ccc" } }),
    pulse("g2", ago(15), { standard: { set: "checkin", index: 1, templateHash: "ddd" } }),
    pulse("p1", ago(15), { detailKind: "street", hook: "mentioned" }),
    pulse("p2", ago(15), { detailKind: "last words" }),
    said("p1", later(ago(15), 6), "yes the one on Birch is coming up"),
    said("p2", later(ago(15), 20), "funny you ask, I have one"),
    said("g1", later(ago(15), 40), "not right now"),
  ];
  const card = buildOutreachScorecard({ sends: sendsFrom({ events }), ...outcomesFrom({ events }), now: NOW });
  const d = rowsOf(card, "check_in", "detail");
  assert.deepEqual([d.none.n, d.none.replied7], [2, 1], "the fixed generic texts");
  assert.deepEqual([d.street.n, d.street.replied7], [1, 1]);
  assert.deepEqual([d["last words"].n, d["last words"].replied7], [1, 1]);
  assert.equal(checkInDetail({ hook: "closed_nearby" }), "town");
  assert.equal(checkInDetail({ reason: "fresh_listing" }), "listing");
});

test("a reply goes to the last text before it, and a house named, a call and an offer are credited the same way", () => {
  const std = { set: "opener", index: 0, templateHash: "aaa" };
  const events = [
    first("c1", ago(30), std),
    { id: "n1", type: "outreach_nudge_sent", contactId: "c1", at: ago(28), data: { step: 2, set: "follow_up", index: 0, templateHash: "fff", auto: true } },
    said("c1", later(ago(28), 3), "I have a fixer on Larch"),
    { id: "h1", type: "house_mentioned", contactId: "c1", at: later(ago(28), 4), party: "agent", data: {} },
    { id: "k1", type: "call_summary", contactId: "c1", at: later(ago(28), 30), party: "agent", data: { durationSec: 300, summary: "walked through the house" } },
  ];
  const offers = [{ id: "o1", contactId: "c1", createdAt: ago(25), leadSource: { source: "agent_brought" }, deal: { stage: "under_contract" } }];
  const card = buildOutreachScorecard({ sends: sendsFrom({ events }), ...outcomesFrom({ events, offers }), now: NOW });
  const ft = card.kinds.first_text.totals, fu = card.kinds.follow_up.totals;
  assert.deepEqual([ft.n, ft.replied7, ft.house, ft.offer], [1, 0, 0, 0], "the follow-up got it, not the first text");
  assert.deepEqual([fu.n, fu.replied3, fu.house, fu.talked, fu.offer, fu.deal], [1, 1, 1, 1, 1, 1]);
  assert.equal(card.kinds.follow_up.dims.step, undefined, "a split with one group isn't shown");
});

test("follow-ups from before the send-time stamp come from the outbox, never twice", () => {
  const ledger = [
    { id: "d1", status: "sent", contactId: "c1", sentAt: ago(20), autoSent: true, outbound: { kind: "outreach_nudge", step: 2, standard: { set: "nudge", index: 1 } } },
    { id: "d2", status: "sent", contactId: "c2", sentAt: ago(20), autoSent: false, outbound: { kind: "outreach_nudge", step: 9 } },
    { id: "d3", status: "dismissed", contactId: "c3", sentAt: null, outbound: { kind: "outreach_nudge", step: 2 } },
  ];
  const events = [{ id: "n2", type: "outreach_nudge_sent", contactId: "c2", at: ago(20), data: { draftId: "d2", step: 9, auto: false } }];
  const sends = sendsFrom({ events, ledger }).filter((s) => s.kind === "follow_up");
  assert.equal(sends.length, 2);
  assert.deepEqual(sends.map((s) => s.template).sort(), ["model", "s:nudge#1"]);
});

test("a first text's length is bucketed the way the funnel review read it", () => {
  assert.deepEqual([90, 130, 170, 230, 0].map(lengthBucket), ["under 120", "120–159", "160–199", "200 and over", "unknown"]);
});
