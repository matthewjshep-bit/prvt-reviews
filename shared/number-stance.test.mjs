// number-stance.test.mjs — price once: a range on a high-stakes house until
// we have their read and eyes on it, and a listed house's seller number first.

import test from "node:test";
import assert from "node:assert/strict";
import { numberStance, hasEyes, listedFit, sellerNumberOn, noFitLine, stanceWaitingFor, EYES_MIN_PHOTOS } from "./number-stance.js";

const ON = { enabled: true, overAmount: 500000 };
const ADDRESS = "18 Fern Way, Kent, WA 98030";
const machine = (extra = {}) => ({ id: "o1", address: ADDRESS, cashAmount: 410000, status: "new",
  autoUnderwrite: { passed: true, photosAnalyzed: 3 }, ...extra });
const theirRead = { have: { arv: { value: 620000 }, rehab: { value: 90000 } } };

test("with the switch off every number is firm, as before", () => {
  const s = numberStance({ offer: machine({ cashAmount: 900000 }), highStakes: { enabled: false, overAmount: 500000 } });
  assert.equal(s.mode, "firm");
  assert.equal(s.highStakes, false);
});

test("an ordinary listed house under the line stays firm", () => {
  assert.equal(numberStance({ offer: machine(), highStakes: ON }).mode, "firm");
});

test("a house over the line floats a range until we have their read and eyes on it", () => {
  const o = machine({ cashAmount: 610000 });
  const s = numberStance({ offer: o, highStakes: ON });
  assert.equal(s.mode, "range");
  assert.equal(s.highStakes, true);
  assert.deepEqual(s.missing, ["their_read", "eyes"]);
  assert.match(s.why, /over 500K/);
  assert.match(stanceWaitingFor(s), /their read on the value and the work and eyes on it/);

  assert.deepEqual(numberStance({ offer: o, dossier: theirRead, highStakes: ON }).missing, ["eyes"], "their read alone isn't enough");
  const seen = numberStance({ offer: { ...o, autoUnderwrite: { passed: true, photosAnalyzed: EYES_MIN_PHOTOS } }, dossier: theirRead, highStakes: ON });
  assert.equal(seen.mode, "firm", "their read and a full photo scan: firm");
  assert.equal(seen.highStakes, true);
});

test("off-market and agent-brought houses are high-stakes at any price", () => {
  const off = numberStance({ offer: machine({ offMarket: { value: true, by: "machine" } }), highStakes: ON });
  assert.equal(off.mode, "range");
  assert.match(off.why, /off-market/);
  const brought = numberStance({ offer: machine({ autoUnderwrite: { passed: true, leadSource: "agent_brought" } }), highStakes: ON });
  assert.equal(brought.mode, "range");
  assert.match(brought.why, /the agent brought us/);
  assert.equal(numberStance({ offer: machine(), leadSource: "agent_brought", highStakes: ON }).mode, "range", "the caller's lead source counts too");
});

test("a walkthrough video or a person's mark counts as eyes", () => {
  const o = machine({ cashAmount: 610000 });
  assert.equal(hasEyes({ offer: o }), false);
  assert.equal(hasEyes({ offer: o, videos: [{ id: "v1", status: "ready" }] }), true);
  assert.equal(hasEyes({ offer: o, videos: [{ id: "v1", status: "uploading" }] }), false, "an upload that never finished isn't a video");
  assert.equal(hasEyes({ offer: o, videos: 2 }), true);
  assert.equal(hasEyes({ offer: { ...o, seen: { at: "2026-10-15T18:00:00Z", by: "you" } } }), true);
  assert.equal(numberStance({ offer: o, dossier: theirRead, highStakes: ON, videos: 1 }).mode, "firm");
});

test("Matt's approval, a hand-made offer, or a published one is firm", () => {
  const o = machine({ cashAmount: 610000 });
  assert.equal(numberStance({ offer: o, highStakes: ON, approved: true }).mode, "firm");
  assert.equal(numberStance({ offer: { ...o, autoUnderwrite: null }, highStakes: ON }).mode, "firm");
  assert.equal(numberStance({ offer: { ...o, autoUnderwrite: { passed: false, publishedAt: "2026-10-15T18:00:00Z" } }, highStakes: ON }).mode, "firm");
});

/* ---------- the listed house ---------- */

const listed = (extra = {}) => machine({ askingPrice: 525000, ...extra });

test("a listed house with nothing of ours on it asks the seller's number first", () => {
  const f = listedFit({ offer: listed() });
  assert.equal(f.listed, true);
  assert.equal(f.move, "ask_number");
  assert.equal(f.source, "list");
  assert.equal(f.theirs, 525000);
});

test("once asked, ours is compared with the list price", () => {
  const asked = listed({ proactive: { takeCheckAt: "2026-10-15T17:00:00Z" } });
  assert.equal(listedFit({ offer: asked }).move, "float", "410 of 525 is 78%");
  const low = listedFit({ offer: { ...asked, cashAmount: 350000 } });
  assert.equal(low.move, "no_fit", "350 of 525 is 67%");
  assert.equal(noFitLine(low), "ours is 67% of the list price of 525K");
});

test("the seller's own number decides, whoever said it", () => {
  const said = { have: { sellerAsk: { value: 600000 } } };
  const f = listedFit({ offer: listed(), dossier: said });
  assert.equal(f.source, "seller");
  assert.equal(f.move, "no_fit", "410 of 600 is 68%, and we never need to ask");
  assert.equal(noFitLine(f), "ours is 68% of the seller's 600K");
  const mentioned = [{ type: "house_mentioned", address: "18 Fern Way", at: "2026-10-15T16:00:00Z", data: { sellerAsk: 500000 } }];
  assert.equal(sellerNumberOn({ offer: listed(), events: mentioned }).amount, 500000);
  assert.equal(listedFit({ offer: listed(), events: mentioned }).move, "float", "410 of 500 is 82%");
  assert.equal(sellerNumberOn({ offer: listed({ counter: { amount: 560000 } }) }).source, "seller", "their counter is the seller's number");
});

test("the floor is the switch's percentage", () => {
  const asked = listed({ proactive: { takeCheckAt: "2026-10-15T17:00:00Z" } });
  assert.equal(listedFit({ offer: asked, pct: 80 }).move, "no_fit", "78% is under 80%");
});

test("only before our first quote: a number we already said is the counter rules' business", () => {
  const said = { have: { sellerAsk: { value: 600000 } } };
  assert.equal(listedFit({ offer: listed(), dossier: said, quoted: true }).move, "float");
  assert.equal(listedFit({ offer: listed({ proactive: { realmCheckAt: "2026-10-15T17:00:00Z" } }), dossier: said }).move, "float");
});

test("an off-market house is never listed, and a house with no list price or hook isn't either", () => {
  assert.equal(listedFit({ offer: listed({ offMarket: { value: true } }) }).move, "float");
  assert.equal(listedFit({ offer: machine() }).listed, false);
  assert.equal(listedFit({ offer: machine({ autoUnderwrite: { passed: true, leadSource: "hook" } }) }).move, "ask_number", "the listing we opened with");
});

/* ---------- the seller's number caps ours (Matt, 2026-11-09) ---------- */

test("a seller's number under our engine number is answered with theirs or a hold, never by floating ours", async () => {
  const { sellerOwnNumber } = await import("./number-stance.js");
  const ours = listed({ cashAmount: 655000, askingPrice: 725000, createdAt: "2026-11-06T23:15:00Z" });
  const said = { have: { sellerAsk: { value: 609900, at: "2026-11-06T23:58:00Z" } } };
  // Before our first quote: re-quoted down to theirs, floored to 250.
  const f = listedFit({ offer: ours, dossier: said });
  assert.equal(f.move, "requote_down");
  assert.equal(f.cap, 609900);
  assert.equal(f.to, 609750);
  assert.equal(f.reason, "capped at the seller's number");
  // The engine already flagged it far over theirs: a hold, not a re-quote.
  assert.equal(listedFit({ offer: { ...ours, pricing: { live: true, triage: "over_theirs" } }, dossier: said }).move, "hold");
  // After a number of ours went out: a hold. We never cut a number we gave.
  assert.equal(listedFit({ offer: ours, dossier: said, quoted: true }).move, "hold");
  assert.equal(listedFit({ offer: { ...ours, proactive: { realmCheckAt: "2026-11-07T00:00:00Z" } }, dossier: said }).move, "hold");
  assert.equal(listedFit({ offer: { ...ours, floatSentAt: "2026-11-07T00:00:00Z" }, dossier: said }).move, "hold");
  // Off-market too: the cap is the seller's, not the listing's.
  assert.equal(listedFit({ offer: { ...ours, offMarket: { value: true } }, dossier: said }).move, "requote_down");
  // Never the list price: a list price under ours is the no-fit and ask rules' business.
  assert.equal(listedFit({ offer: listed({ cashAmount: 540000, askingPrice: 525000 }) }).move, "ask_number");
  // The newest of their words wins: a counter after an older ask.
  const counter = { amount: 630000, at: "2026-11-08T00:00:00Z" };
  assert.equal(sellerOwnNumber({ offer: { ...ours, counter }, dossier: said }).amount, 630000);
  assert.equal(sellerOwnNumber({ offer: ours, dossier: said }).amount, 609900);
  assert.equal(sellerOwnNumber({ offer: listed() }), null, "the list price is not the seller's own number");
});

test("an agent's repair figure that lands after we priced, above our rehab, holds the float", () => {
  const priced = listed({ repairs: 60000, createdAt: "2026-11-06T23:15:00Z", proactive: { takeCheckAt: "2026-11-06T23:20:00Z" } });
  const later = { have: { rehab: { value: 400000, at: "2026-11-06T23:16:00Z" } } };
  const f = listedFit({ offer: priced, dossier: later });
  assert.equal(f.move, "hold");
  assert.match(f.line, /put the work at 400K after we priced it on 60K/);
  assert.equal(listedFit({ offer: priced, dossier: { have: { rehab: { value: 400000, at: "2026-11-06T22:00:00Z" } } } }).move, "float", "before we priced it: already in our number");
  assert.equal(listedFit({ offer: priced, dossier: { have: { rehab: { value: 55000, at: "2026-11-06T23:16:00Z" } } } }).move, "float", "under ours");
});

test("the repair figure check stands on its own for the float's other doors", async () => {
  const { workAfterPricing } = await import("./number-stance.js");
  const engine = { address: "61 Teal Ct, Olympia, WA 98501", cashAmount: 300000, createdAt: "2026-11-06T18:00:00Z", pricing: { live: true, rehab: 45000 } };
  const later = { have: { rehab: { value: 90000, at: "2026-11-06T19:00:00Z" } } };
  const w = workAfterPricing({ offer: engine, dossier: later });
  assert.equal(w.theirs, 90000);
  assert.equal(w.ours, 45000, "the engine's rehab, not the row's");
  assert.match(w.line, /^61 Teal Ct: the agent put the work at 90K after we priced it on 45K/);
  assert.equal(workAfterPricing({ offer: engine, dossier: { have: {} } }), null);
  assert.equal(workAfterPricing({ offer: { ...engine, pricing: undefined }, dossier: later }), null, "no rehab of ours to measure against");
});

// Review, 2026-11-09: a counter filed without its thousands (450) read as the
// seller's number and stood every float down at "0K".
test("a seller's figure under 10K is a misread, not a cap", async () => {
  const { sellerOwnNumber } = await import("./number-stance.js");
  const ours = listed({ cashAmount: 400000 });
  assert.equal(sellerOwnNumber({ offer: { ...ours, counter: { amount: 450, at: "2026-11-08T00:00:00Z" } } }), null);
  assert.equal(sellerOwnNumber({ offer: ours, dossier: { have: { sellerAsk: { value: 380, at: "2026-11-08T00:00:00Z" } } } }), null);
  assert.ok(!["requote_down", "hold"].includes(listedFit({ offer: { ...ours, counter: { amount: 450, at: "2026-11-08T00:00:00Z" } } }).move), "no cap, no hold");
  assert.equal(sellerOwnNumber({ offer: { ...ours, counter: { amount: 450000, at: "2026-11-08T00:00:00Z" } } }).amount, 450000);
});
