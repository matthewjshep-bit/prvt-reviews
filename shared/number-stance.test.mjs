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
