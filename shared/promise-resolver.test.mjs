import test from "node:test";
import assert from "node:assert/strict";
import {
  endsWithQuestionToThem, openPromises, resolvePromise, normalizePromiseDismissal, PROMISE_DISMISS_REASONS,
} from "./promise-resolver.js";

const NOW = Date.parse("2026-09-17T20:00:00Z");   // 1pm Pacific
const ago = (h) => new Date(NOW - h * 3600000).toISOString();
const HOUSE = "3004 E Yesler Way, Seattle, WA 98122";
const THIN = "only 1 priced comps — the price proxy needs 6 to have a top tier";
const promise = (over = {}) => ({ contactId: "c1", since: ago(10), address: HOUSE, what: "number", text: "Got them, thanks. I'll work through the numbers and come back to you with a number.", draftId: "d1", owedAt: ago(5), ...over });
const priced = (over = {}) => ({ id: "o1", contactId: "c1", address: HOUSE, status: "new", cashAmount: 410000, createdAt: ago(3), ...over });
const heldDraft = (over = {}) => ({ id: "h1", contactId: "c1", address: HOUSE, status: "draft", cashAmount: null, createdAt: ago(6), autoUnderwrite: { held: [THIN], finishedAt: ago(6) }, ...over });
const resolve = (o = {}) => resolvePromise({ promise: promise(), now: NOW, ...o });

test("a promise whose text ended with a question to them is not owed", () => {
  assert.equal(endsWithQuestionToThem("Fair enough. Is the seller showing any flexibility on price, or holding at list?"), true);
  assert.equal(endsWithQuestionToThem("Is the seller flexible? I'll get back to you with a number today."), false);
  assert.equal(endsWithQuestionToThem("I'll get back to you today, sound good?"), false, "a tag question hands nothing back");
  assert.equal(endsWithQuestionToThem(""), false);
  const v = resolve({ promise: promise({ text: "Fair enough, I'll get back to you. Is the seller showing any flexibility on price at this point?" }) });
  assert.equal(v.move, "not_owed");
});

test("a text we only kept the first 200 characters of is never read as ending in a question", () => {
  const cut = `${"x".repeat(180)} is the seller flexible?`.slice(0, 200);
  assert.equal(cut.length, 200);
  assert.equal(resolve({ promise: promise({ text: cut }) }).move === "not_owed", false);
  assert.equal(resolve({ promise: promise({ text: cut, asksThem: true }) }).move, "not_owed", "unless the send recorded it on the whole text");
});

test("a priced offer nobody floated means send the number", () => {
  const v = resolve({ offers: [priced()] });
  assert.equal(v.move, "send_number");
  assert.equal(v.offerId, "o1");
});

test("a priced offer on a different house does not answer this promise", () => {
  assert.notEqual(resolve({ offers: [priced({ address: "83 Olympic Dr NW, Shoreline, WA 98177" })] }).move, "send_number");
});

test("an underwrite still running means wait", () => {
  assert.equal(resolve({ jobs: [{ id: "j1", contactId: "c1", status: "running", address: HOUSE }] }).move, "wait");
});

test("held on thin comps and never asked means ask for their numbers", () => {
  const v = resolve({ offers: [heldDraft()], heldTriage: { action: "ask", needs: ["value"], reason: "only 1 priced comps — ask what it's worth fixed up" } });
  assert.equal(v.move, "ask_numbers");
  assert.equal(v.offerId, "h1");
  assert.deepEqual(v.needs, ["value"]);
});

test("held and they already gave their numbers means re-run on them", () => {
  assert.equal(resolve({ offers: [heldDraft()], heldTriage: { action: "rerun", needs: ["value"], reason: "run it on their numbers" } }).move, "rerun");
});

test("a hold nobody's numbers can clear is yours, with the reason", () => {
  const v = resolve({ offers: [heldDraft()], heldTriage: { action: "yours", reason: "the photo scan flagged a possible foundation or structural problem" } });
  assert.equal(v.move, "yours");
  assert.match(v.reason, /structural/);
  assert.equal(v.offerId, "h1");
});

test("a held draft with no triage handed in is yours, not a guess", () => {
  assert.equal(resolve({ offers: [heldDraft()] }).move, "yours");
});

test("no offer and no underwrite, but we know the house: start an underwrite", () => {
  assert.equal(resolve({}).move, "start_underwrite");
});

test("no address and no underwrite is yours", () => {
  assert.equal(resolve({ promise: promise({ address: "" }) }).move, "yours");
  assert.equal(resolve({ promise: promise({ address: "Yesler" }) }).move, "yours", "half an address starts nothing");
});

test("they wrote back and we answered: an owed answer is over even though no number went", () => {
  const p = promise({ what: "answer", text: "Good question. Let me check with my partner and get back to you." });
  const drafts = [{ id: "d2", contactId: "c1", status: "sent", intent: "question", inbound: "any update on referrals?", reply: "We pay a referral at closing, happy to put it in writing.", createdAt: ago(2), sentAt: ago(2) }];
  assert.equal(resolvePromise({ promise: p, drafts, now: NOW }).move, "not_owed");
});

test("a thumbs-up and a 'sounds good' back does not close a promised number", () => {
  const drafts = [{ id: "d2", contactId: "c1", status: "sent", intent: "small_talk", inbound: "ok thanks", reply: "Sounds good.", createdAt: ago(2), sentAt: ago(2) }];
  assert.notEqual(resolve({ drafts }).move, "not_owed");
  const p = promise({ what: "answer" });
  assert.notEqual(resolvePromise({ promise: p, drafts, now: NOW }).move, "not_owed", "small talk answers nothing");
});

test("a second 'I'll get back to you' is not an answer", () => {
  const p = promise({ what: "answer" });
  const drafts = [{ id: "d2", contactId: "c1", status: "sent", intent: "question", inbound: "any update?", reply: "Still checking, I'll get back to you tomorrow.", createdAt: ago(2), sentAt: ago(2) }];
  assert.notEqual(resolvePromise({ promise: p, drafts, now: NOW }).move, "not_owed");
});

test("an owed answer with nothing else to go on is yours", () => {
  const v = resolvePromise({ promise: promise({ what: "answer", address: "" }), now: NOW });
  assert.equal(v.move, "yours");
  assert.equal(v.kind, "partner_answer");
});

test("open promises: one per contact, closed by a later promise_kept, gone after the window", () => {
  const events = [
    { type: "promise_made", contactId: "c1", at: ago(10), address: HOUSE, data: { what: "number", text: "back to you with a number", draftId: "d1" } },
    { type: "promise_owed", contactId: "c1", at: ago(5), address: HOUSE, data: { what: "number", text: "back to you with a number", draftId: "d1" } },
    { type: "promise_made", contactId: "c2", at: ago(9), address: "", data: { what: "answer", text: "get back to you" } },
    { type: "promise_kept", contactId: "c2", at: ago(1), data: { by: "dismissed" } },
    { type: "promise_made", contactId: "c3", at: ago(100), address: "", data: { what: "answer", text: "get back to you" } },
  ];
  const open = openPromises(events, { now: NOW });
  assert.deepEqual(open.map((p) => p.contactId), ["c1"]);
  assert.equal(open[0].since, ago(10));
  assert.equal(open[0].owedAt, ago(5));
  assert.equal(open[0].what, "number");
});

test("a dismissal reason is one of ours, with a short note", () => {
  assert.deepEqual(normalizePromiseDismissal({ code: "not_a_promise", note: "  we asked them  " }), { code: "not_a_promise", note: "we asked them" });
  assert.deepEqual(normalizePromiseDismissal({ code: "made up" }), { code: "other", note: "" });
  assert.equal(normalizePromiseDismissal(null), null);
  assert.equal(normalizePromiseDismissal("handled_by_call").code, "handled_by_call");
  assert.ok(PROMISE_DISMISS_REASONS.includes("deal_dead"));
});
