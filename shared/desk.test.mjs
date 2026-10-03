// desk.test.mjs — Today as the Desk: one row per person, Call · Decide · Machine.
//
// The shapes come from Today on 2026-10-02 (names changed): 28 rows, one
// agent three times over the same house, counters and wants-a-call drafts
// mixed in with held underwrites.

import test from "node:test";
import assert from "node:assert/strict";
import { foldDesk, sectionFor, foldKey, heldVerdicts, deskKpis, pacificStart, nameRows, DESK_SECTIONS, KIND_STRENGTH, isCounterDraft } from "./desk.js";
import { addDismissal, isDismissed } from "./today-dismiss.js";
import { ACTION_KINDS } from "./pipeline.js";

const NOW = Date.parse("2026-10-02T20:00:00Z");   // 1pm Pacific

const promise = (over = {}) => ({ id: "promise_owed:c1:2026-10-02T18:00:00Z", kind: "promise_owed", severity: "now", group: "yours", contactId: "c1", contactName: "Hanna F",
  address: "18612 51st Ave SE, Bothell, WA 98012", offerId: "o1", title: "Hanna F: we owe them a number on 18612 51st Ave SE", detail: "", ops: [{ key: "dismiss_promise", label: "Dismiss" }], ...over });
const held = (over = {}) => ({ id: "underwrite_held:o1", kind: "underwrite_held", severity: "soon", group: "stuck", contactId: "c1", contactName: "Hanna F",
  address: "18612 51st Ave SE, Bothell, WA 98012", offerId: "o1", title: "Underwrite held on 18612 51st Ave SE", detail: "only 1 priced comps", ops: [], ...over });
const stillOwed = (over = {}) => ({ id: "audit:promise_open_overdue:c1:x", kind: "audit_owed", findingKind: "promise_open_overdue", severity: "now", group: "yours",
  contactId: "c1", contactName: "Hanna F", address: "18612 51st Ave SE, Bothell, WA 98012", offerId: null, title: "Hanna F · 18612 51st Ave SE: Still owed a number", ops: [], ...over });
const draftRow = (id, over = {}) => ({ id: `draft_waiting:${id}`, kind: "draft_waiting", severity: "now", group: "yours", draftId: id, contactId: `c-${id}`, contactName: id, offerId: null, title: `${id}: other`, ops: [], ...over });

test("a person with an owed number, a held underwrite and last night's 'still owed' is one row, led by the promise", () => {
  const { rows, counts } = foldDesk([held(), stillOwed(), promise()]);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.kind, "promise_owed");
  assert.equal(r.section, "decide");
  assert.deepEqual(r.also.map((a) => a.kind), ["underwrite_held"], "the held underwrite rides along with its own buttons");
  assert.deepEqual(r.quiet.map((a) => a.findingKind), ["promise_open_overdue"], "'still owed' only repeats the promise");
  assert.equal(r.reasonIds.length, 3);
  assert.equal(counts.decide, 1);
});

test("counters and wants-a-call drafts are calls; a reply the bot couldn't place is a decision", () => {
  const drafts = [
    { id: "k", intent: "counter", exception: { passed: false, theirAmount: 750000, ceiling: 700000 } },
    { id: "w", intent: "wants_call" },
    { id: "v", intent: "wants_walkthrough" },
    { id: "o", intent: "other" },
  ];
  const { rows } = foldDesk([draftRow("o"), draftRow("k"), draftRow("w"), draftRow("v")], { drafts });
  const by = Object.fromEntries(rows.map((r) => [r.draftId, r.section]));
  assert.deepEqual(by, { k: "call", w: "call", v: "call", o: "decide" });
  assert.equal(rows[0].section, "call", "Call comes first");
  assert.equal(rows.at(-1).draftId, "o");
  assert.equal(isCounterDraft(drafts[0]), true);
  assert.equal(isCounterDraft({ intent: "question", exception: { passed: true, theirAmount: 1 } }), false, "a band that passed is not a counter for you");
});

test("last night's rows: a counter nobody moved on and a buyer the bot stays out of are calls; a float nobody answered is the machine's", () => {
  const audit = (findingKind, over = {}) => ({ id: `audit:${findingKind}:${over.contactId || "c"}`, kind: "audit_owed", findingKind, severity: "now", group: "yours", contactId: over.contactId || "c", ops: [], ...over });
  assert.equal(sectionFor(audit("counter_stalled")), "call");
  assert.equal(sectionFor(audit("unanswered_inbound", { detail: "a buyer on your live deal at 7034 South K Street — the bot stays out" })), "call");
  assert.equal(sectionFor(audit("unanswered_inbound", { intent: "wants_call" })), "call");
  assert.equal(sectionFor(audit("unanswered_inbound", { detail: "“Snohomish king and pierce” — the bot stood down" })), "decide");
  assert.equal(sectionFor(audit("float_unanswered")), "machine");
});

test("a held underwrite the triage is asking about or re-running is the machine's; one it left to you is yours", () => {
  const verdicts = heldVerdicts({ findings: [{ kind: "held_ask", offerId: "o1" }, { kind: "held_yours", offerId: "o2" }, { kind: "unanswered_inbound", offerId: "o3" }] });
  assert.equal(verdicts.get("o1"), "held_ask");
  assert.equal(verdicts.has("o3"), false);
  assert.equal(sectionFor(held(), { heldByOffer: verdicts }), "machine");
  assert.equal(sectionFor(held({ offerId: "o2" }), { heldByOffer: verdicts }), "decide");
  assert.equal(sectionFor(held({ offerId: "o9" }), { heldByOffer: verdicts }), "decide", "not triaged yet: yours");
});

test("rows about a deal fold by deal, not under the listing agent's other business", () => {
  const agentRow = draftRow("a1", { contactId: "agent", offerId: "o5" });
  const dealRow = { id: "deal_no_dataroom:o5", kind: "deal_no_dataroom", severity: "soon", group: "yours", contactId: "agent", offerId: "o5", ops: [] };
  assert.equal(foldKey(dealRow), "deal:o5");
  assert.equal(foldKey(agentRow), "person:agent");
  assert.equal(foldDesk([agentRow, dealRow]).rows.length, 2);
});

test("a person whose only reasons are the machine's sits with the machine, folded", () => {
  const timer = { id: "offer_ready:o7", kind: "offer_ready", severity: "soon", group: "machine", contactId: "c7", offerId: "o7", next: { what: "floats our read" }, ops: [] };
  const sched = { id: "draft_scheduled:d7", kind: "draft_scheduled", severity: "fyi", group: "machine", contactId: "c7", draftId: "d7", ops: [] };
  const { rows, counts } = foldDesk([sched, timer]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].section, "machine");
  assert.equal(counts.machine, 1);
  assert.equal(DESK_SECTIONS.find((s) => s.key === "machine").folds, true);
});

test("every row kind has a section", () => {
  for (const k of ACTION_KINDS) {
    const s = sectionFor({ kind: k.key, group: "yours", severity: "soon" });
    assert.ok(["call", "decide", "machine"].includes(s), `${k.key} → ${s}`);
    assert.ok(KIND_STRENGTH.includes(k.key), `${k.key} has a strength`);
  }
  assert.ok(KIND_STRENGTH.includes("audit_owed"));
});

test("the strip counts today's calls, offers and floats in Pacific time, and this month's contracts", () => {
  const day = pacificStart(NOW);
  assert.equal(new Date(day).toISOString(), "2026-10-02T07:00:00.000Z", "midnight Pacific (PDT)");
  assert.equal(new Date(pacificStart(NOW, { month: true })).toISOString(), "2026-10-01T07:00:00.000Z");
  const at = (h) => new Date(day + h * 3600000).toISOString();
  const events = [
    { type: "call_summary", at: at(9), data: { transcribed: true, durationSec: 300 } },
    { type: "call_attempt", at: at(10), data: { outcome: "no_answer" } },
    { type: "call_summary", at: at(11), data: { transcribed: false, durationSec: 6 } },   // rang out, old-style row
    { type: "call_summary", at: new Date(day - 3600000).toISOString(), data: { transcribed: true } },   // yesterday
  ];
  const offers = [
    { id: "a", sends: [{ ts: at(8) }] },
    { id: "f", sends: [{ ts: at(8), results: { sms: { ok: false } } }] },   // a send that failed
    { id: "b", sends: [{ ts: new Date(day - 1000).toISOString() }], proactive: { realmCheckAt: at(9) } },
    { id: "c", deal: { stage: "under_contract", stageHistory: [{ stage: "under_contract", ts: at(1) }] } },
    { id: "d", deal: { stage: "closed", stageHistory: [{ stage: "under_contract", ts: "2026-09-12T00:00:00Z" }] } },
  ];
  const k = deskKpis({ offers, events, cards: [{ lane: "hot" }, { lane: "hot" }, { lane: "sent" }], targets: { offersPerDay: 10, dealsPerMonth: 2 }, now: NOW });
  assert.deepEqual(k.calls, { talked: 1, tried: 3 });
  assert.deepEqual(k.offers, { sent: 1, floated: 1, target: 10 });
  assert.equal(k.hot, 2);
  assert.deepEqual(k.contracts, { count: 1, target: 2 });
});

test("a dismissal made when the row said 'An agent' still holds once it has a name", () => {
  const row = promise({ contactName: "", title: "An agent: we owe them an answer on 13536 SW 171st ST" });
  const doc = addDismissal(null, row, NOW);
  const [named] = nameRows([row], { c1: "Mallory D" });
  assert.equal(named.contactName, "Mallory D");
  assert.equal(named.title, "Mallory D: we owe them an answer on 13536 SW 171st ST");
  assert.equal(isDismissed(named, doc, NOW), true);
  const [kept] = nameRows([promise()], { c1: "Someone Else" });
  assert.equal(kept.contactName, "Hanna F", "a name the row already has is kept");
});
