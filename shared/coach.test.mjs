// coach.test.mjs — the nightly coach's pure half.
// Run: node --test coach.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  gatherSignals, validateProposal, screenProposals, applyProposal, revertProposal, coachScorecard,
  scrubForIssue, issueFor, proposalDedupeKey, buildCoachContext, exampleIdFor, CAPS, MAX_PROPOSALS_PER_NIGHT,
} from "./coach.js";
import { normalizeConversationAi, draftStats } from "./conversation-ai.js";

const NOW = Date.parse("2026-09-17T20:00:00-07:00");
const ago = (h) => new Date(NOW - h * 3600000).toISOString();
const draft = (o = {}) => ({ id: "d1", party: "agent", intent: "price_pushback", status: "sent", inbound: "That's way too low.", reply: "I completely understand where you're coming from! Let me explain.", createdAt: ago(5), updatedAt: ago(4), ...o });

/* ---------- gather ---------- */

test("an edit is kept with what the bot wrote, what you sent, and why you said you changed it", () => {
  const s = gatherSignals({ now: NOW, drafts: [
    draft({ edited: true, sentText: "Fair. It's what the numbers gave me.", sentAt: ago(4), feedback: { code: "wrong_tone", note: "too chipper" } }),
    draft({ id: "d2", sentAt: ago(3) }),                                   // sent as written: not a lesson
    draft({ id: "d3", edited: false, autoSent: true, sentAt: ago(2) }),    // sent itself
    draft({ id: "d4", edited: true, sentText: "old", sentAt: ago(40), updatedAt: ago(40) }),  // yesterday's news
  ] });
  assert.equal(s.edits.length, 1);
  assert.equal(s.edits[0].youSent, "Fair. It's what the numbers gave me.");
  assert.equal(s.edits[0].why.label, "Wrong tone");
  assert.deepEqual(s.knownIds, ["d1"]);
  assert.equal(s.empty, false);
});

test("a draft the machine binned — dead deal, unsubscribed, you got there first — is not your verdict on the words", () => {
  const s = gatherSignals({ now: NOW, drafts: [
    draft({ id: "a", status: "dismissed", dismissedBy: "you", dismissedAt: ago(2) }),
    draft({ id: "b", status: "dismissed", dismissedAt: ago(2), flags: ["the deal is fell through — not sent"] }),
    draft({ id: "c", status: "dismissed", dismissedAt: ago(2), answeredBy: "you", flags: ["you answered it yourself — the bot stood aside"] }),
    draft({ id: "d", status: "dismissed", updatedAt: ago(2) }),   // an older row, before dismissedBy existed
  ] });
  assert.deepEqual(s.dismissals.map((d) => d.id).sort(), ["a", "d"]);
  assert.deepEqual(s.yours.map((d) => d.id), ["c"]);
});

test("a gate reason seen once is a Tuesday; seen twice with the numbers flattened it is a pattern", () => {
  const s = gatherSignals({ now: NOW, drafts: [
    draft({ id: "a", status: "draft", flags: ["mentions 412,000 which is not in the book"] }),
    draft({ id: "b", status: "draft", flags: ["mentions 95,500 which is not in the book", "low confidence"] }),
  ] });
  assert.equal(s.blocked.length, 1);
  assert.equal(s.blocked[0].count, 2);
  assert.match(s.blocked[0].flag, /mentions # which/);
});

test("an intent you keep rewriting is named, and one you've barely judged is not", () => {
  const rows = [
    ...Array.from({ length: 4 }, (_, i) => draft({ id: `e${i}`, edited: true, autoSendable: true })),
    ...Array.from({ length: 2 }, (_, i) => draft({ id: `u${i}`, autoSendable: true })),
    draft({ id: "x", intent: "scheduling", edited: true }),
  ];
  const s = gatherSignals({ now: NOW, drafts: [], stats: draftStats(rows) });
  assert.deepEqual(s.weakIntents.map((w) => [w.intent, w.asWrittenPct]), [["price_pushback", 33]]);
});

test("a quiet day — audit findings but nothing a person did and nothing broken — is empty, so no model call is made", () => {
  const s = gatherSignals({ now: NOW, drafts: [draft({ sentAt: ago(3) })], audit: { findings: [{ kind: "held_aging" }], acted: [] } });
  assert.equal(s.empty, true);
  assert.equal(gatherSignals({ now: NOW, errors: [{ fingerprint: "f", area: "reply", message: "timed out", count: 3 }] }).empty, false);
});

/* ---------- validate ---------- */

const config = normalizeConversationAi({ rules: ["Never say 'I completely understand'."], examples: [{ id: "ex-1", party: "agent", theySaid: "Too low", weSay: "Fair enough." }], parties: { agent: { instructions: "Keep it short." } } });
const ok = { knownIds: ["d1", "d2"], config };

test("money, fees, commitments and auto-send are not the coach's to touch", () => {
  const rule = (text) => validateProposal({ kind: "rule", text, why: "seen twice", evidence: ["d1"] }, ok);
  assert.match(rule("When they push back, offer $5,000 more.").reason, /amount/);
  assert.match(rule("Go up 10% if they hesitate.").reason, /amount/);
  assert.match(rule("Go up 15k if they hesitate.").reason, /amount/);
  assert.match(rule("Tell them our assignment fee is small.").reason, /hand-edited/);
  assert.match(rule("You may commit to a closing date.").reason, /hand-edited/);
  assert.match(rule("Auto-send every acceptance.").reason, /hand-edited/);
  assert.match(validateProposal({ kind: "example", theySaid: "Can you do better?", weSay: "I can do 412,000.", why: "x", evidence: ["d1"] }, ok).reason, /amount/);
  assert.equal(rule("Don't open with an apology.").ok, true);
});

test("guidance with no draft of yours behind it is thrown out, and invented draft ids don't count", () => {
  assert.match(validateProposal({ kind: "rule", text: "Be brief.", why: "x", evidence: [] }, ok).reason, /cites no draft/);
  assert.match(validateProposal({ kind: "rule", text: "Be brief.", why: "x", evidence: ["made-up"] }, ok).reason, /cites no draft/);
  // a code gap can stand on a runtime error alone
  assert.equal(validateProposal({ kind: "code_gap", title: "Reply job times out on long threads", why: "timed out nine times", evidence: [] }, ok).ok, true);
});

test("a proposal carrying a phone number, an email or a street address is dropped", () => {
  const gap = (why) => validateProposal({ kind: "code_gap", title: "Wrong name used", why, evidence: [] }, ok);
  assert.match(gap("Seen on the thread with 206-555-0142").reason, /phone/);
  assert.match(gap("Seen for dana@example.com").reason, /phone/);
  assert.match(gap("Seen on 1322 N Mamer Rd").reason, /phone/);
  assert.equal(gap("Seen on one thread, the agent was called by our own first name").ok, true);
});

test("what the prompt already says is not proposed again, and a full list is not pushed past its cap", () => {
  assert.match(validateProposal({ kind: "rule", text: "never say 'I completely understand'", why: "x", evidence: ["d1"] }, ok).reason, /already/);
  assert.match(validateProposal({ kind: "example", theySaid: "Too low!", weSay: "Fair enough.", why: "x", evidence: ["d1"] }, ok).reason, /already/);
  assert.match(validateProposal({ kind: "instruction", party: "agent", text: "Keep it short.", why: "x", evidence: ["d1"] }, ok).reason, /already/);
  assert.match(validateProposal({ kind: "instruction", party: "any", text: "Ask one question at a time.", why: "x", evidence: ["d1"] }, ok).reason, /one party/);
  const full = { ...config, rules: Array.from({ length: CAPS.rules }, (_, i) => `Rule number ${"x".repeat(i + 1)}.`) };
  assert.match(validateProposal({ kind: "rule", text: "One more.", why: "x", evidence: ["d1"] }, { ...ok, config: full }).reason, /full/);
  // …unless it replaces one
  assert.equal(validateProposal({ kind: "rule", text: "One more.", why: "x", evidence: ["d1"], replaces: full.rules[0] }, { ...ok, config: full }).ok, true);
});

test("the same lesson isn't proposed nightly: open, applied and recently rejected ones are skipped; an old rejection may come back", () => {
  const p = { kind: "rule", text: "Don't open with an apology.", why: "seen twice", evidence: ["d1"] };
  const key = proposalDedupeKey(p);
  const screen = (existing) => screenProposals([p, { ...p, text: "don't open with an apology" }], { ...ok, existing, now: NOW });
  assert.equal(screen([]).kept.length, 1, "and the batch's own duplicate is dropped");
  assert.equal(screen([{ dedupeKey: key, status: "open", createdAt: ago(24) }]).kept.length, 0);
  assert.equal(screen([{ dedupeKey: key, status: "applied", createdAt: ago(24 * 90) }]).kept.length, 0);
  assert.equal(screen([{ dedupeKey: key, status: "rejected", updatedAt: ago(24 * 10) }]).kept.length, 0);
  assert.equal(screen([{ dedupeKey: key, status: "rejected", updatedAt: ago(24 * 45) }]).kept.length, 1);
});

test("a night proposes a handful at most", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ kind: "rule", text: `Avoid habit ${"abcdefghij"[i]}.`, why: "x", evidence: ["d1"] }));
  const out = screenProposals(many, { ...ok, now: NOW });
  assert.equal(out.kept.length, MAX_PROPOSALS_PER_NIGHT);
  assert.ok(out.dropped.every((d) => /cap/.test(d.reason)));
});

/* ---------- apply / revert ---------- */

const valid = (raw, id) => ({ ...validateProposal(raw, ok).proposal, id });

test("apply then revert leaves the settings exactly as they were — rule, example, instruction, and a replacement", () => {
  const cases = [
    valid({ kind: "rule", text: "Don't open with an apology.", why: "x", evidence: ["d1"] }, "p-rule"),
    valid({ kind: "rule", text: "Never open with sympathy.", why: "x", evidence: ["d1"], replaces: config.rules[0] }, "p-rule2"),
    valid({ kind: "example", party: "agent", theySaid: "That's way too low.", weSay: "Fair. It's what the numbers gave me.", why: "x", evidence: ["d1"] }, "p-ex"),
    valid({ kind: "example", party: "agent", theySaid: "Too low", weSay: "Fair.", why: "x", evidence: ["d1"], replaces: "ex-1" }, "p-ex2"),
    valid({ kind: "instruction", party: "agent", text: "Ask one question at a time.", why: "x", evidence: ["d1"] }, "p-ins"),
  ];
  for (const p of cases) {
    const { config: next, undo } = applyProposal(config, p);
    assert.notDeepEqual(next, config, p.id);
    // what Apply writes survives the normaliser the save goes through
    assert.deepEqual(normalizeConversationAi(next), next, `${p.id} normalises clean`);
    assert.deepEqual(revertProposal(next, undo), config, `${p.id} reverts clean`);
  }
  const { config: withEx } = applyProposal(config, cases[2]);
  assert.equal(withEx.examples.at(-1).id, exampleIdFor("p-ex"));
  assert.equal(applyProposal(config, cases[4]).config.parties.agent.instructions, "Keep it short.\nAsk one question at a time.");
});

test("revert takes back only what the coach added — a rule you wrote in between stays", () => {
  const p = valid({ kind: "rule", text: "Don't open with an apology.", why: "x", evidence: ["d1"] }, "p1");
  const { config: next, undo } = applyProposal(config, p);
  const edited = { ...next, rules: [...next.rules, "Mine, added by hand."] };
  assert.deepEqual(revertProposal(edited, undo).rules, [...config.rules, "Mine, added by hand."]);
});

test("a code gap is filed, never applied", () => {
  assert.throws(() => applyProposal(config, { kind: "code_gap", id: "g", title: "x" }), /filed, not applied/);
});

/* ---------- scorecard ---------- */

test("the scorecard compares as-written before and after, and says too early until both sides have enough", () => {
  const appliedAt = ago(24 * 7);
  const p = { party: "agent", intent: "price_pushback", appliedAt };
  const at = (h, o) => draft({ id: `s${h}`, autoSendable: true, sentAt: ago(h), updatedAt: ago(h), ...o });
  const before = Array.from({ length: 10 }, (_, i) => at(24 * 8 + i, { edited: i < 6 }));       // 40% as written
  const after = Array.from({ length: 10 }, (_, i) => at(24 + i, { edited: i < 2 }));            // 80%
  const card = coachScorecard({ proposal: p, drafts: [...before, ...after, at(30, { intent: "scheduling", edited: true })], now: NOW });
  assert.deepEqual([card.before.pct, card.after.pct, card.delta, card.verdict], [40, 80, 40, "better"]);
  assert.equal(coachScorecard({ proposal: p, drafts: [...after, ...before.map((d) => ({ ...d, edited: false }))].map((d, i) => (i < 10 ? { ...d, edited: true } : d)), now: NOW }).verdict, "worse");
  assert.equal(coachScorecard({ proposal: p, drafts: [...before, ...after.slice(0, 3)], now: NOW }).verdict, "too_early");
  assert.equal(coachScorecard({ proposal: { party: "agent" }, drafts: [] }), null);
});

/* ---------- GitHub ---------- */

test("an issue carries first names only, and no phone, email or street address", () => {
  const text = "Nate Holloway (206-555-0142, nate@kw.com) got 'Thanks, Matt.' on 1322 N Mamer Rd";
  assert.equal(scrubForIssue(text, { names: ["Nate Holloway"] }), "Nate (<phone>, <email>) got 'Thanks, Matt.' on <address>");
  const issue = issueFor({ kind: "code_gap", title: "Agent called by our own first name", why: "Nate Holloway was called Matt", suspectedArea: "callsThemOurName", suggestedTest: "a reply that signs the contact's name as ours is blocked", evidence: ["d1"] }, { names: ["Nate Holloway"] });
  assert.doesNotMatch(issue.body, /Holloway/);
  assert.match(issue.body, /`d1`/);
  assert.deepEqual(issue.labels, ["coach"]);
});

/* ---------- the prompt ---------- */

test("the model is shown the current guidance and the day's verdicts, not the bookkeeping", () => {
  const signals = gatherSignals({ now: NOW, drafts: [draft({ edited: true, sentText: "Fair.", sentAt: ago(2) })] });
  const ctx = buildCoachContext({ signals, config });
  assert.match(ctx, /I completely understand/);
  assert.match(ctx, /"youSent": "Fair\."/);
  assert.doesNotMatch(ctx, /knownIds/);
});

test("the coach is shown why a promise row was dismissed", () => {
  const kept = (over = {}, data = {}) => ({ type: "promise_kept", contactId: "c1", at: new Date(NOW - 3600000).toISOString(),
    data: { by: "dismissed", reason: { code: "not_a_promise", note: "we asked them" }, ourText: "Is the seller flexible on price?", draftId: "d7", ...data }, ...over });
  const s = gatherSignals({ now: NOW, drafts: [], promiseEvents: [
    kept(),
    kept({ contactId: "c2" }, { by: "offer_sent", reason: undefined }),          // kept by numbers: nothing to learn
    kept({ contactId: "c3", at: new Date(NOW - 5 * 86400000).toISOString() }),   // before the window
  ] });
  assert.equal(s.promiseDismissals.length, 1);
  assert.deepEqual(s.promiseDismissals[0], { id: "d7", code: "not_a_promise", label: "We didn't owe anything", note: "we asked them", botWrote: "Is the seller flexible on price?" });
  assert.equal(s.counts.promiseDismissals, 1);
  assert.equal(s.empty, false, "a dismissed promise is something a person did");
  assert.ok(s.knownIds.includes("d7"), "so a proposal may cite the draft that made the promise");
});

/* ---------- "what should the bot have done?" from Today (2026-09-22) ---------- */

const fb = (id, category, over = {}) => ({ id, type: "row_feedback", contactId: "c1", at: new Date(NOW - 2 * 3600000).toISOString(),
  data: { rowId: `audit:unanswered_inbound:c1:${id}`, rowKind: "audit_owed", auditKind: "unanswered_inbound", category, note: "it had the answer in the thread",
    detail: "scheduling — yours to answer", draftId: "d5", party: "agent", intent: "scheduling", theySaid: "Can you do Tuesday?", botWrote: "Let me check with my partner.", ...over } });

test("the coach is shown what you said the bot should have done on a Today row, with the message and the bot's draft", () => {
  const s = gatherSignals({ now: NOW, drafts: [], promiseEvents: [fb("e1", "should_have_replied")] });
  assert.equal(s.rowFeedback.length, 1);
  assert.deepEqual(s.rowFeedback[0], { id: "fb:e1", rowKind: "audit_owed", kindLabel: "From last night: Texts we never answered", category: "should_have_replied", label: "Should have replied itself",
    note: "it had the answer in the thread", detail: "scheduling — yours to answer", party: "agent", intent: "scheduling", draftId: "d5", theySaid: "Can you do Tuesday?", botWrote: "Let me check with my partner." });
  assert.equal(s.counts.rowFeedback, 1);
  assert.equal(s.empty, false, "a night with only your feedback is not a quiet night");
  const ctx = buildCoachContext({ signals: s, config: {} });
  assert.match(ctx, /"rowFeedback"/);
  assert.match(ctx, /Should have replied itself/);
  assert.doesNotMatch(ctx, /"title"/, "the row's title (a name and a street) is not shown");
});

test("a lesson may cite your feedback, and the draft behind it", () => {
  const s = gatherSignals({ now: NOW, drafts: [], promiseEvents: [fb("e1", "wrong_read")] });
  assert.ok(s.knownIds.includes("fb:e1") && s.knownIds.includes("d5"));
  const v = validateProposal({ kind: "rule", text: "A named weekday is a scheduling ask; answer the time question first.", why: "you said it misread the day", evidence: ["fb:e1"] }, { config: {}, knownIds: s.knownIds });
  assert.equal(v.ok, true, v.reason);
  assert.deepEqual(v.proposal.evidence, ["fb:e1"]);
});

test("'right to hand it to me' is shown as counter-evidence and no lesson may be built on it alone", () => {
  const s = gatherSignals({ now: NOW, drafts: [], promiseEvents: [fb("e2", "right_to_hand_over")] });
  assert.equal(s.rowFeedback.length, 0);
  assert.equal(s.counterEvidence.length, 1);
  assert.equal(s.counterEvidence[0].label, "Right to hand it to me");
  assert.ok(!("id" in s.counterEvidence[0]), "no id to cite");
  assert.ok(!s.knownIds.includes("fb:e2"));
  assert.equal(s.empty, true, "nothing to learn from on its own");
  const v = validateProposal({ kind: "rule", text: "Answer scheduling questions yourself.", why: "x", evidence: ["fb:e2"] }, { config: {}, knownIds: s.knownIds });
  assert.equal(v.ok, false);
  assert.match(v.reason, /cites no draft/);
});

test("a rule that names the gates or never-auto is dropped — that is a code gap, not a lesson", () => {
  for (const text of ["Skip the gates when the agent asks for a time.", "Treat scheduling as auto, not NEVER_AUTO.", "Send it without the review.", "Bypass the counter check on small numbers."]) {
    const v = validateProposal({ kind: "rule", text, why: "x", evidence: ["d1"] }, { config: {}, knownIds: ["d1"] });
    assert.equal(v.ok, false, text);
    assert.match(v.reason, /fees, commitments or auto-send/);
  }
  const ok = validateProposal({ kind: "rule", text: "When they name a weekday, answer the day before anything else.", why: "x", evidence: ["d1"] }, { config: {}, knownIds: ["d1"] });
  assert.equal(ok.ok, true, ok.reason);
});

/* ---------- one contact's lessons (Today's work pane) ---------- */

test("a proposal shows on the contact whose drafts it cites", async () => {
  const { proposalsForContact } = await import("./coach.js");
  const proposals = [
    { id: "p1", status: "open", evidence: ["d1", "d9"] },          // cites one of theirs
    { id: "p2", status: "open", evidence: ["fb:e7"] },              // cites feedback given on their row
    { id: "p3", status: "applied", evidence: ["d5"] },              // someone else's thread
    { id: "p4", status: "rejected", evidence: ["d1"] },             // settled: not shown
    { id: "p5", status: "open" },                                   // cites nothing it can be tied to
  ];
  const mine = proposalsForContact(proposals, { draftIds: ["d1", "d2"], feedbackIds: ["e7"] });
  assert.deepEqual(mine.map((p) => p.id), ["p1", "p2"]);
  assert.deepEqual(proposalsForContact(proposals, { draftIds: ["d5"] }).map((p) => p.id), ["p3"], "an applied lesson stays visible with its scorecard");
  assert.deepEqual(proposalsForContact(proposals, {}), []);
});
