// offer-status.test.mjs — the offer lifecycle.
//
// The failures this guards against, in order of how much they'd cost:
//
//   1. A backfill that never ran. Every offer written before this field existed
//      has no `status` key. If effectiveStatus() didn't infer one, the whole
//      history would render as "Not sent" and the funnel numbers would be zero.
//   2. A clock overwriting a human. If isExpired() didn't check the status
//      first, an offer you personally marked "passed" would flip to "expired"
//      the moment its validity lapsed — losing the outcome you recorded.
//   3. A send walking an offer backwards. Re-texting the docs to an agent who
//      already countered must not reset them to "sent".
//   4. A list row that lost something the table draws. toListOffer() is what
//      lets the history page hold every offer instead of the newest hundred —
//      but only the fields it keeps ever reach the screen, so a key dropped
//      here is a column that silently goes blank.
//
//   node --test offer-status.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  isAiGenerated, aiHoldReasons, needsAiReview,
  DEAD_STATUSES,
  OFFER_STATUS,
  OFFER_STATUS_KEYS,
  OPEN_STATUSES,
  SETTABLE_STATUSES,
  STATUS_RANK,
  effectiveStatus,
  isExpired,
  offerExpiresAt,
  statusAfterSend,
  statusAfterUnpromote,
  toListOffer,
  INVESTOR_STATUSES, WORKING_INVESTOR_STATUSES, investorStatus,
  dealOutreachPaused, dealOutreachStopped, dealSpokenFor, outreachPausedReason, priceAgreed, priceLocked,
  pushesToPaper,
} from "./offer-status.js";

const iso = (d) => d.toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 86400000);

test("legacy rows infer a status without a backfill", () => {
  assert.equal(effectiveStatus({}), "new");
  assert.equal(effectiveStatus({ sends: [] }), "new");
  assert.equal(effectiveStatus({ sends: [{ ts: iso(new Date()) }] }), "sent");
  // A promoted offer is accepted regardless of what else is on the row.
  assert.equal(effectiveStatus({ deal: { stage: "under_contract" } }), "accepted");
  assert.equal(effectiveStatus({ sends: [{}], deal: {} }), "accepted");
  // Drafts and explicit values always win over inference.
  assert.equal(effectiveStatus({ status: "draft" }), "draft");
  assert.equal(effectiveStatus({ status: "passed", sends: [{}], deal: {} }), "passed");
  assert.equal(effectiveStatus(null), "new");
});

test("every status carries display metadata and draft is not settable", () => {
  for (const key of OFFER_STATUS_KEYS) {
    assert.ok(OFFER_STATUS[key].label, `${key} needs a label`);
    assert.ok(OFFER_STATUS[key].cls, `${key} needs pill classes`);
    assert.ok(OFFER_STATUS[key].dot, `${key} needs a dot color`);
  }
  assert.ok(!SETTABLE_STATUSES.includes("draft"));
  assert.equal(SETTABLE_STATUSES.length, OFFER_STATUS_KEYS.length - 1);
  // Open and dead partition everything except draft and accepted.
  for (const key of SETTABLE_STATUSES) {
    if (key === "accepted") continue;
    assert.ok(OPEN_STATUSES.has(key) !== DEAD_STATUSES.has(key), `${key} must be open xor dead`);
  }
  // Tag precedence has to be total, or two offers could both claim the tag.
  const ranks = SETTABLE_STATUSES.map((k) => STATUS_RANK[k]);
  assert.equal(new Set(ranks).size, ranks.length, "ranks must be distinct");
});

test("passed is theirs, we_passed is ours — both dead, neither expires, they rank apart", () => {
  assert.equal(OFFER_STATUS.passed.label, "They passed");
  assert.equal(OFFER_STATUS.we_passed.label, "We passed");
  assert.ok(DEAD_STATUSES.has("we_passed"));
  assert.ok(!OPEN_STATUSES.has("we_passed"));
  assert.ok(SETTABLE_STATUSES.includes("we_passed"));
  // An agent who said no is a stronger signal than an offer we withdrew.
  assert.ok(STATUS_RANK.passed > STATUS_RANK.we_passed);
  assert.ok(STATUS_RANK.no_response > STATUS_RANK.passed);
  assert.equal(effectiveStatus({ status: "we_passed", sends: [{}] }), "we_passed");
  assert.equal(statusAfterSend({ status: "we_passed" }), "we_passed");
});

test("expiry prefers the picker, then validity days, then the printed label", () => {
  // The explicit picker wins, parsed as a LOCAL date — not UTC, which would
  // land on the previous day for anyone west of Greenwich.
  const picked = offerExpiresAt({ calc: { settings: { offerExpires: "2026-09-01", validityDays: 7 } } });
  assert.equal(picked.getFullYear(), 2026);
  assert.equal(picked.getMonth(), 8);
  assert.equal(picked.getDate(), 1);

  const created = daysAgo(10);
  const byDays = offerExpiresAt({ createdAt: iso(created), calc: { settings: { validityDays: 14 } } });
  assert.equal(Math.round((byDays - created) / 86400000), 14);

  // Rows saved before calc settings were snapshotted still have the label.
  const byLabel = offerExpiresAt({ validLabel: "September 1, 2026" });
  assert.equal(byLabel.getFullYear(), 2026);
  assert.equal(byLabel.getMonth(), 8);

  assert.equal(offerExpiresAt({}), null);
  assert.equal(offerExpiresAt({ createdAt: "not a date", calc: { settings: { validityDays: 7 } } }), null);
});

test("expiry never overwrites an outcome a human recorded", () => {
  const lapsed = { createdAt: iso(daysAgo(30)), calc: { settings: { validityDays: 7 } } };

  assert.equal(isExpired({ ...lapsed, status: "sent" }), true);
  assert.equal(isExpired({ ...lapsed, status: "countered" }), true);
  assert.equal(isExpired({ ...lapsed, status: "new" }), true);

  // These already ended — the clock has nothing left to say about them.
  assert.equal(isExpired({ ...lapsed, status: "passed" }), false);
  assert.equal(isExpired({ ...lapsed, status: "we_passed" }), false);
  assert.equal(isExpired({ ...lapsed, status: "no_response" }), false);
  assert.equal(isExpired({ ...lapsed, status: "accepted" }), false);
  assert.equal(isExpired({ ...lapsed, status: "draft" }), false);

  // Still in date, and undeterminable dates never expire.
  const fresh = { createdAt: iso(daysAgo(1)), status: "sent", calc: { settings: { validityDays: 14 } } };
  assert.equal(isExpired(fresh), false);
  assert.equal(isExpired({ status: "sent" }), false);
});

test("a send moves an offer forward only", () => {
  assert.equal(statusAfterSend({}), "sent");
  assert.equal(statusAfterSend({ status: "new" }), "sent");
  assert.equal(statusAfterSend({ status: "draft" }), "sent");
  // Re-sending the documents must not undo what the agent told us.
  assert.equal(statusAfterSend({ status: "countered" }), "countered");
  assert.equal(statusAfterSend({ status: "passed" }), "passed");
  assert.equal(statusAfterSend({ status: "accepted" }), "accepted");
});

test("un-promoting a deal restores the pre-acceptance truth", () => {
  assert.equal(statusAfterUnpromote({ status: "accepted", sends: [{}] }), "sent");
  assert.equal(statusAfterUnpromote({ status: "accepted", sends: [] }), "new");
  // A legacy deal row with no status still un-promotes correctly.
  assert.equal(statusAfterUnpromote({ deal: {}, sends: [{}] }), "sent");
  // Anything not accepted is left exactly as it is.
  assert.equal(statusAfterUnpromote({ status: "countered" }), "countered");
});

test("a list row keeps what the table draws and drops the weight", () => {
  const offer = {
    id: "o1", contactId: "c1", contactName: "Jeffrey Menday",
    address: "741 North 128th Street, Seattle, Washington 98133",
    cashAmount: 412000, status: "passed", createdAt: "2026-08-11T18:20:55.973Z",
    sends: [{ channels: ["text"] }], ghl: { fields: true, note: true, tag: true },
    pdfUrl: "https://x/o1.pdf", contractPdfUrl: "https://x/o1-contract.pdf",
    // the four keys that are ~90% of a stored offer
    snapshot: { comps: new Array(50).fill({ address: "a" }) },
    calc: { inputs: { arv: 500000 }, settings: { validityDays: 7 } },
    draft: { inputs: {} },
    scope: [{ item: "roof" }],
  };
  const row = toListOffer(offer);

  for (const k of ["id", "contactId", "contactName", "address", "cashAmount",
                   "status", "createdAt", "sends", "ghl", "pdfUrl", "contractPdfUrl"]) {
    assert.deepEqual(row[k], offer[k], `the table renders ${k}`);
  }
  for (const k of ["snapshot", "calc", "draft", "scope"]) {
    assert.equal(row[k], undefined, `${k} must not ride along`);
  }
  assert.equal(row.listOnly, true, "rows announce that they are not documents");
  // Modest fixture; against production docs the row is ~1KB against ~9KB.
  assert.ok(JSON.stringify(row).length * 3 < JSON.stringify(offer).length);

  // The ⏱ marker reads calc.settings, which is exactly what was dropped — so
  // the date rides along precomputed and must land on the same instant.
  assert.equal(offerExpiresAt(row).getTime(), offerExpiresAt(offer).getTime());
  assert.equal(isExpired(row), isExpired(offer));
  // Status inference must still work off a row alone.
  assert.equal(effectiveStatus(row), "passed");
  assert.equal(effectiveStatus(toListOffer({ sends: [{}] })), "sent");
  // Re-trimming a row changes nothing (patching the list runs it again).
  assert.deepEqual(toListOffer(row), row);
});


/* ---------------- AI provenance ---------------- */

const ai = (over = {}) => ({ autoUnderwrite: { jobId: "uw-1", passed: true }, ...over });

test("provenance is the autoUnderwrite stamp, nothing else", () => {
  assert.equal(isAiGenerated(ai()), true);
  assert.equal(isAiGenerated({ status: "sent" }), false);
  assert.equal(isAiGenerated(null), false);
  assert.equal(isAiGenerated(undefined), false);
});

test("provenance survives the whole lifecycle — it is not a status", () => {
  // The reason this isn't an OFFER_STATUSES entry: an AI offer that gets sent
  // must not stop being an AI offer.
  for (const status of ["draft", "new", "sent", "countered", "passed", "accepted"]) {
    assert.equal(isAiGenerated(ai({ status })), true, status);
  }
});

test("the review queue holds AI drafts and AI offers that haven't gone out", () => {
  assert.equal(needsAiReview(ai({ status: "draft" })), true);
  assert.equal(needsAiReview(ai({ status: "new" })), true);
  assert.equal(needsAiReview(ai({})), true);            // no status → "new"
});

test("the queue drains through the normal flow — no reviewed flag to set", () => {
  assert.equal(needsAiReview(ai({ status: "sent" })), false);
  assert.equal(needsAiReview(ai({ status: "countered" })), false);
  assert.equal(needsAiReview(ai({ status: "passed" })), false);
  assert.equal(needsAiReview(ai({ status: "no_response" })), false);
  assert.equal(needsAiReview(ai({ status: "accepted" })), false);
});

test("an AI offer promoted to a deal has plainly been reviewed", () => {
  assert.equal(needsAiReview(ai({ status: "new", deal: { stage: "under_contract" } })), false);
});

test("a hand-built offer is never in the AI queue, whatever its status", () => {
  for (const status of ["draft", "new", "sent"]) {
    assert.equal(needsAiReview({ status }), false, status);
  }
});

test("an AI offer with a send but no status still counts as sent, not as pending review", () => {
  // effectiveStatus infers "sent" from a send record on rows that predate the
  // status field; the queue has to respect that inference or it never empties.
  assert.equal(needsAiReview(ai({ sends: [{ ts: "2026-08-26" }] })), false);
});

test("hold reasons come back verbatim, and empty for a clean run", () => {
  assert.deepEqual(aiHoldReasons(ai({ autoUnderwrite: { held: ["only 2 renovated comps"] } })), ["only 2 renovated comps"]);
  assert.deepEqual(aiHoldReasons(ai()), []);
  assert.deepEqual(aiHoldReasons({}), []);
  assert.deepEqual(aiHoldReasons(null), []);
});

test("the audit stamp survives the lean row — the table can see provenance", () => {
  const row = toListOffer(ai({ id: "o1", status: "new", address: "1 Elm", snapshot: { huge: true } }));
  assert.equal(isAiGenerated(row), true);
  assert.equal(needsAiReview(row), true);
  assert.equal(row.snapshot, undefined);
});

test("a buyer's standing on a deal has four states, and the retired fifth still reads", () => {
  assert.deepEqual(INVESTOR_STATUSES, ["evaluating", "soft_commit", "committed", "passed"]);
  // Deals written before "sent" was retired carry it. A buyer we'd sent a deal
  // to was being worked, which is what evaluating means — so no migration.
  assert.equal(investorStatus("sent"), "evaluating");
  assert.equal(investorStatus("committed"), "committed");
  assert.equal(investorStatus("PASSED"), "passed");
  // Anything unreadable lands on the state that holds the bot back rather than
  // the one that lets it loose.
  assert.equal(investorStatus(""), "evaluating");
  assert.equal(investorStatus(undefined), "evaluating");
  assert.equal(investorStatus("nonsense"), "evaluating");
  // Only the signer stands the bot down. Evaluating is a pipeline, often a
  // dozen buyers deep, and working them is the job.
  assert.deepEqual([...WORKING_INVESTOR_STATUSES], ["committed"]);
  assert.equal(WORKING_INVESTOR_STATUSES.has("evaluating"), false);
  // A maybe is exactly the buyer to keep talking to.
  assert.equal(WORKING_INVESTOR_STATUSES.has("soft_commit"), false);
  assert.equal(investorStatus("soft_commit"), "soft_commit");
});

test("a soft commit pauses outreach without making the deal spoken for", () => {
  const deal = (investors, stage = "under_contract") => ({ stage, investors });
  assert.equal(dealOutreachPaused(deal([{ contactId: "b1", name: "Dmitriy", status: "evaluating" }])), null);

  const soft = dealOutreachPaused(deal([{ contactId: "b1", name: "Dmitriy", status: "soft_commit" }]));
  assert.deepEqual(soft, { status: "soft_commit", name: "Dmitriy", contactId: "b1" });
  assert.match(outreachPausedReason(soft, "23706 138th Dr SE"), /soft-committed to Dmitriy/);

  // The line that keeps the two apart: the deal is NOT taken. Other buyers
  // still see it and its numbers; the bot still works everyone on it.
  assert.equal(dealSpokenFor(deal([{ contactId: "b1", status: "soft_commit" }])), false);

  // Committed pauses it too — and that one IS spoken for.
  const hard = dealOutreachPaused(deal([{ contactId: "b1", name: "Dmitriy", status: "committed" }]));
  assert.equal(hard.status, "committed");
  assert.equal(dealSpokenFor(deal([{ contactId: "b1", status: "committed" }])), true);
  assert.ok(dealOutreachPaused(deal([], "buyer_found")), "the stage alone says it too");

  // Nothing is stored: putting them back to evaluating starts outreach again.
  assert.equal(dealOutreachPaused(deal([{ contactId: "b1", status: "evaluating" }])), null);
  assert.equal(dealOutreachPaused(deal([{ contactId: "b1", status: "passed" }])), null);
  assert.equal(dealOutreachPaused(null), null);
});

// 5232 S Yakima, 2026-10-01: Matt wanted the deal off the market for good,
// and nothing short of a committed buyer paused it.
test("a deal you stopped outreach on is paused for every buyer, the committed one too, until you resume it", () => {
  const at = "2026-10-02T02:00:00.000Z";
  const stopped = { stage: "under_contract", outreachStopped: { at, by: "you" }, investors: [{ contactId: "b1", name: "Dmitriy", status: "committed" }] };
  assert.deepEqual(dealOutreachStopped(stopped), { at, by: "you" });
  const p = dealOutreachPaused(stopped);
  assert.deepEqual(p, { status: "stopped", name: "", contactId: "", at }, "no contactId, so no buyer is let through");
  assert.equal(outreachPausedReason(p, "5232 South Yakima Avenue"), "you stopped outreach on 5232 South Yakima Avenue");
  // Stopping is about outreach, not whether the deal is taken.
  assert.equal(dealSpokenFor({ stage: "under_contract", outreachStopped: { at }, investors: [] }), false);

  assert.equal(dealOutreachStopped({ stage: "under_contract" }), null);
  assert.equal(dealOutreachStopped({ outreachStopped: {} }), null, "a stop with no time on it is not a stop");
  assert.equal(dealOutreachPaused({ stage: "under_contract", investors: [] }), null, "resumed, it's live again");
});

test("a list row keeps the follow-up rungs and the float stamps", () => {
  // The pipeline board reads these off lean rows, and so does the follow-up
  // sweep's sentSteps — on Postgres the SQL trim drops anything not listed.
  const row = toListOffer({
    id: "o1", cashAmount: 1,
    proactive: { takeCheckAt: "2026-09-01T00:00:00Z", realmCheckAt: null },
    followUps: [{ kind: "offer_nudge", step: 3, at: "2026-09-04T00:00:00Z" }],
    counterBand: { acceptedAt: "2026-09-05T00:00:00Z", amount: 300000 },
    requotes: [{ ts: "2026-09-05T00:00:00Z", from: 1, to: 2 }],
    calc: { settings: {} }, snapshot: { big: true },
  });
  assert.equal(row.proactive.takeCheckAt, "2026-09-01T00:00:00Z");
  assert.deepEqual(row.followUps.map((f) => f.step), [3]);
  assert.equal(row.counterBand.amount, 300000);
  assert.equal(row.requotes.length, 1);
  assert.equal(row.snapshot, undefined, "the heavy keys still go");
});

// Woodcrest, 2026-10-02: Matt took back a price the counter band "agreed"
// (DELETE /:id/agreed writes offer.agreedCleared). The full document said
// not agreed, but every list row — the board, the Hot filter, the Today
// rows — still read the band's acceptance and kept it hot at that number,
// because the trim dropped the one field that cancels it.
test("an agreed price you took back stays taken back on a list row", async () => {
  const { isHot } = await import("./offer-status.js");
  const offer = {
    id: "o1", status: "countered", cashAmount: 390000,
    counterBand: { acceptedAt: "2026-10-02T18:05:00Z", amount: 402500 },
    agreedCleared: { at: "2026-10-02T23:00:00Z", by: "operator" },
    calc: { settings: {} },
  };
  assert.equal(priceAgreed(offer), null, "the document reads as taken back");
  const row = toListOffer(offer);
  assert.equal(priceAgreed(row), null, "and so does its list row");
  assert.equal(isHot(row), false);
});

// Heather Vandyken, 36721 6th Ave SW, 2026-09-16: an agreed number was
// re-underwritten, re-quoted, and re-sent lower. Once agreed, the price is
// locked — until the offer is dead, when it's a fresh negotiation.
test("an agreed price is locked while the offer lives, and free once it's dead", () => {
  assert.equal(priceAgreed({ status: "sent", cashAmount: 795500 }), null, "sent is not agreed");
  const realm = { status: "sent", cashAmount: 795500, realm: { answer: "yes", ts: "2026-09-16T02:25:00Z" } };
  assert.deepEqual(priceAgreed(realm), { amount: 795500, at: "2026-09-16T02:25:00Z", via: "realm_yes" });
  assert.equal(priceLocked(realm), true);
  const band = { status: "countered", cashAmount: 800000, counterBand: { acceptedAt: "2026-09-16T15:06:00Z", amount: 800000 } };
  assert.equal(priceAgreed(band).via, "counter_band");
  assert.equal(priceLocked(band), true);
  assert.deepEqual(priceAgreed({ status: "sent", cashAmount: 1, agreed: { amount: 800000, at: "x", via: "counter_band" } }), { amount: 800000, at: "x", via: "counter_band" }, "the explicit field wins");
  assert.equal(priceLocked({ ...band, status: "passed" }), false, "she walked; the next number is a new conversation");
  assert.equal(priceAgreed({ status: "sent", cashAmount: 1, realm: { answer: "no", ts: "x" } }), null);
});

test("heat is its own axis: an agreed price or your flag makes an offer hot; dead, dealt and cooled offers are not", async () => {
  const { offerHeat, isHot } = await import("./offer-status.js");
  const ts = "2026-09-17T18:00:00.000Z";
  assert.equal(isHot({ id: "a", status: "sent" }), false);
  assert.equal(offerHeat({ id: "a", status: "sent", cashAmount: 410000, realm: { answer: "yes", ts } }).by, "auto");
  assert.match(offerHeat({ id: "a", status: "countered", counterBand: { acceptedAt: ts, amount: 800000 } }).reason, /counter/);
  assert.equal(offerHeat({ id: "a", status: "countered", hot: { at: ts, by: "operator", note: "she's presenting it tonight" } }).reason, "she's presenting it tonight");
  assert.equal(isHot({ id: "a", status: "draft", hot: { at: ts } }), true, "a draft you flagged is hot");
  assert.equal(isHot({ id: "a", status: "sent", realm: { answer: "yes", ts }, hot: { off: true, at: ts } }), false, "cooled by hand beats the signal");
  assert.equal(isHot({ id: "a", status: "passed", hot: { at: ts } }), false);
  assert.equal(isHot({ id: "a", status: "sent", hot: { at: ts }, deal: { stage: "under_contract" } }), false, "a deal is past hot");
});

test("on a deal means committed, or evaluating while nobody has committed yet — not pitched, passed or a backup", async () => {
  const { buyersInPlay } = await import("./offer-status.js");
  const open = [
    { contactId: "a", status: "evaluating" },
    { contactId: "b", status: "sent" },
    { contactId: "c", status: "passed" },
  ];
  assert.deepEqual([...buyersInPlay(open)], ["a"]);
  assert.deepEqual([...buyersInPlay([...open, { contactId: "d", status: "soft_commit" }])], ["d"], "a soft commit holds the deal too");
  const taken = [
    { contactId: "a", status: "evaluating" },
    { contactId: "e", status: "committed" },
  ];
  assert.deepEqual([...buyersInPlay(taken)], ["e"], "once a buyer commits, the others aren't evaluating any more");
});

test("only a yes pushes to paper: presenting is hot but waits", () => {
  const at = "2026-09-29T17:00:00.000Z";
  const base = { id: "o", status: "sent", cashAmount: 300000 };
  assert.equal(pushesToPaper({ ...base, hot: { at, by: "conversation", signal: "presenting" } }), false);
  assert.equal(pushesToPaper({ ...base, hot: { at, by: "conversation", signal: "warm" } }), false);
  assert.equal(pushesToPaper({ ...base, hot: { at, by: "conversation", signal: "writing_up" } }), true);
  assert.equal(pushesToPaper({ ...base, hot: { at, by: "operator" } }), true);
  assert.equal(pushesToPaper({ ...base, realm: { answer: "yes", ts: at } }), true);
  assert.equal(pushesToPaper({ ...base, status: "passed", hot: { at, by: "operator" } }), false, "a dead offer is cold");
});

// Matt, 2026-10-02: "we passed is like we intentionally said no." A house
// the agent says sold or came off the market is its own outcome.
test("no longer available is its own dead end: nobody's pass, never revived, never chased, no tag", async () => {
  const m = await import("./offer-status.js");
  assert.equal(m.OFFER_STATUS.unavailable.label, "No longer available");
  assert.ok(m.SETTABLE_STATUSES.includes("unavailable"), "a person can pick it");
  assert.ok(m.DEAD_STATUSES.has("unavailable"));
  assert.equal(m.OPEN_STATUSES.has("unavailable"), false);
  assert.equal(m.REVIVABLE_STATUSES.has("unavailable"), false, "a counter doesn't bring a sold house back by itself");
  assert.ok(m.STATUS_RANK.unavailable < m.STATUS_RANK.we_passed, "it says least about the agent");
  assert.match(m.STATUS_HISTORY_PHRASE.unavailable, /no longer available/);
});

test("a price you take back is no longer agreed — Woodcrest: the band's 402.5k and an old realm yes both stop locking it", () => {
  const offer = {
    cashAmount: 402500, status: "countered", statusHistory: [{ status: "countered", ts: "2026-10-02T23:26:50Z" }],
    realm: { answer: "yes", ts: "2026-09-17T17:24:39Z" },
    agreed: { amount: 402500, at: "2026-10-02T18:05:31Z", via: "counter_band" },
    counterBand: { at: "2026-10-02T18:05:31Z", acceptedAt: "2026-10-02T18:05:31Z", amount: 402500 },
  };
  assert.equal(priceAgreed(offer)?.amount, 402500);
  const cleared = { ...offer, agreedCleared: { at: "2026-10-03T03:00:00Z", by: "you", amount: 402500, via: "counter_band" } };
  assert.equal(priceAgreed(cleared), null, "every marker from before you cleared it is ignored");
  assert.equal(priceLocked(cleared), false, "so you can re-quote it");
  const again = { ...cleared, realm: { answer: "yes", ts: "2026-10-04T00:00:00Z" } };
  assert.equal(priceAgreed(again)?.via, "realm_yes", "a new yes after that locks it again");
});

test("taking back an agreed price never touches a contract", () => {
  const deal = { cashAmount: 300000, deal: { contractPrice: 300000, createdAt: "2026-10-01T00:00:00Z" },
    agreedCleared: { at: "2026-10-03T00:00:00Z", by: "you" } };
  assert.equal(priceAgreed(deal)?.amount, 300000);
});

// 3418 Wetmore Ave (2026-10-03): the agent's yes was to ~290k (realm_yes at
// 289,750); Matt came down to 226k by hand; the push to paper then asked her
// to "write it up at the 226k" — a number nobody agreed to. A yes above where
// the book is now is not a yes to the book's number.
test("a yes to a higher number is not a reason to push our lower one to paper", async () => {
  const { agreedAboveOurNumber } = await import("./offer-status.js");
  const at = "2026-10-02T01:52:28.418Z";
  const wetmore = { id: "o", status: "sent", cashAmount: 226000, agreed: { at, via: "realm_yes", amount: 289750 },
    realm: { answer: "yes", ts: at }, hot: { at, by: "conversation", signal: "presenting" } };
  assert.equal(pushesToPaper(wetmore), false);
  assert.deepEqual(agreedAboveOurNumber(wetmore), { amount: 289750, at, via: "realm_yes", book: 226000 });
  // The yes on the number we're at still pushes.
  assert.equal(pushesToPaper({ ...wetmore, cashAmount: 289750 }), true);
  assert.equal(agreedAboveOurNumber({ ...wetmore, cashAmount: 289750 }), null);
});

// 3418 Wetmore: a realm yes at 289,750, then Matt revised the offer to
// 226,000 by hand. The agreement stays on record — it is what keeps the
// machine from pushing paper at 226k or re-quoting above it
// (agreedAboveOurNumber, priceLocked). The Desk reads the revision itself
// (shared/call-list.js), not this (review, 2026-10-04).
test("a yes followed by our own move down still guards the price: no paper at the lower number, nothing re-quoted", () => {
  const repriced = { id: "w", status: "sent", cashAmount: 226000, realm: { answer: "yes", ts: "2026-10-02T01:52:28Z" },
    agreed: { at: "2026-10-02T01:52:28Z", via: "realm_yes", amount: 289750 },
    revisions: [{ ts: "2026-10-02T16:08:31Z", from: 289750, to: 244750 }, { ts: "2026-10-02T16:09:00Z", from: 244750, to: 226000 }] };
  assert.equal(priceAgreed(repriced)?.amount, 289750);
  assert.equal(priceLocked(repriced), true);
});
