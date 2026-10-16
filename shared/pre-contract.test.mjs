// pre-contract.test.mjs — what to look at before we sign (2026-10-15).
//
// The funnel review: 7 of 8 listed-house contracts fell through. The dead
// ones had rehab low or ARV high, two were mobile homes signed and backed out
// of, and one was signed with no buyer lined up.

import test from "node:test";
import assert from "node:assert/strict";
import {
  preContractChecks, needsPreContract, tickPreContract, normalizePreContract, openChecks, preContractRecord,
  PRE_CONTRACT_KEYS, PRESELL_MIN_BUYERS,
} from "./pre-contract.js";
import { buyerCeiling } from "./post-mortem.js";

const T = "2026-10-10T18:00:00.000Z";
const NOW = Date.parse("2026-10-11T18:00:00.000Z");
// A listed house the agent said yes on: realm yes at our number.
const hot = (over = {}) => ({
  id: "o1", contactId: "a1", address: "41 Alder Way, Kent, WA 98030", cashAmount: 300000, status: "sent",
  sends: [{ ts: "2026-10-08T18:00:00.000Z" }], createdAt: "2026-10-07T18:00:00.000Z",
  realm: { answer: "yes", ts: T }, ...over,
});
const byKey = (checks) => Object.fromEntries(checks.map((c) => [c.key, c]));

test("an offer about to be signed with nothing looked at has every item open", () => {
  const o = hot();
  assert.equal(needsPreContract(o, { now: NOW }), true);
  const checks = preContractChecks({ offer: o });
  assert.deepEqual(checks.map((c) => c.key), PRE_CONTRACT_KEYS);
  assert.equal(openChecks(checks).length, checks.length);
  const k = byKey(checks);
  assert.equal(k.remarks.state, "unknown");
  assert.equal(k.eyes.state, "unknown");
  assert.equal(k.presell.state, "warn", "a listed house nobody has pre-sold");
  assert.match(k.presell.detail, /pre-sell to 3/);
});

test("a deal, a dead offer or one nobody agreed to needs no check", () => {
  assert.equal(needsPreContract(hot({ deal: { stage: "under_contract" } }), { now: NOW }), false);
  assert.equal(needsPreContract(hot({ status: "we_passed" }), { now: NOW }), false);
  assert.equal(needsPreContract(hot({ realm: null }), { now: NOW }), false);
  // The agent says they're writing it up.
  assert.equal(needsPreContract(hot({ realm: null, hot: { at: T, by: "conversation", signal: "writing_up" } }), { now: NOW }), true);
});

test("an old yes or an old write-up is history: no check row after two weeks", () => {
  const later = Date.parse("2026-10-25T18:00:01.000Z");
  assert.equal(needsPreContract(hot(), { now: later }), false, "a realm yes 15 days old");
  assert.equal(needsPreContract(hot({ realm: null, hot: { at: T, by: "conversation", signal: "writing_up" } }), { now: later }), false);
  assert.equal(needsPreContract(hot({ realm: null, hot: { at: T, by: "you" } }), { now: NOW }), true, "a house you flagged hot this week");
  assert.equal(needsPreContract(hot({ realm: null, hot: { at: T, by: "you" } }), { now: later }), false);
});

test("the listing remarks say what to look at — a defect, a park lot with lot rent, a mobile home", () => {
  const o = hot({
    asset: { type: "manufactured", land: "park", by: "you" },
    snapshot: { rehab: { listing: { remarks: "55+ community, lot rent $900. Water damage in the bathroom, sold as-is." } } },
  });
  const k = byKey(preContractChecks({ offer: o }));
  assert.equal(k.remarks.state, "warn");
  assert.match(k.remarks.detail, /water damage/);
  assert.equal(k.title.state, "warn");
  assert.match(k.title.detail, /mobile home in a park — we don't buy mobile or manufactured homes/);
  const plain = byKey(preContractChecks({ offer: hot({ snapshot: { rehab: { listing: { remarks: "Easement for the shared driveway. Bring your contractor." } } } }) }));
  assert.equal(plain.title.state, "warn");
  assert.match(plain.title.detail, /an easement/);
  const clean = byKey(preContractChecks({ offer: hot({ snapshot: { rehab: { listing: { remarks: "Needs updating throughout. Big yard." } } } }) }));
  assert.equal(clean.remarks.state, "ok");
  assert.equal(clean.title.state, "ok");
});

test("rehab under the light floor for its size is flagged; at or over it isn't", () => {
  const at = (repairs) => byKey(preContractChecks({ offer: hot({ calc: { inputs: { arv: 500000, repairs } }, snapshot: { subjectSqft: 1200 } }) })).rehab_floor;
  assert.equal(at(25000).state, "warn");
  assert.match(at(25000).detail, /under the light floor \(40k\) for 1,200 sqft/);
  assert.equal(at(45000).state, "ok");
  assert.equal(byKey(preContractChecks({ offer: hot({ calc: { inputs: { arv: 500000, repairs: 45000 } } }) })).rehab_floor.state, "unknown", "no size on file");
});

test("an ARV above what similar houses list for today is flagged", () => {
  const with_ = (arv, checks) => byKey(preContractChecks({ offer: hot({ calc: { inputs: { arv, repairs: 60000 } }, snapshot: { checks } }) })).arv_actives;
  const cap = { v: 1, cap: { status: "ok", amount: 500000, n: 4 } };
  assert.equal(with_(560000, cap).state, "warn");
  assert.match(with_(560000, cap).detail, /above what 4 similar houses list for \(500k\)/);
  assert.equal(with_(480000, cap).state, "ok");
  assert.equal(with_(480000, { v: 1, arv: { capped: { to: 480000 } } }).state, "ok");
  assert.equal(with_(480000, { v: 1, cap: { status: "thin", label: "2 similar listings within 1 mi, need 3" } }).state, "unknown");
  assert.equal(with_(480000, undefined).state, "unknown");
});

test("signing above our number, or over what a buyer will pay, is flagged", () => {
  const o = hot({ calc: { inputs: { arv: 500000, repairs: 60000 } } });
  const ceiling = buyerCeiling({ offer: o, settings: { wholesaleFee: 30000 } });
  assert.ok(ceiling.computable);
  const above = byKey(preContractChecks({ offer: o, settings: { wholesaleFee: 30000 }, price: 320000 })).our_number;
  assert.equal(above.state, "warn");
  assert.match(above.detail, /320k is above our number \(300k\)/);
  const under = byKey(preContractChecks({ offer: { ...o, cashAmount: ceiling.withFee }, settings: { wholesaleFee: 30000 }, price: ceiling.withFee })).our_number;
  assert.equal(under.state, "ok", under.detail);
  const over = byKey(preContractChecks({ offer: { ...o, cashAmount: ceiling.withFee + 20000 }, settings: { wholesaleFee: 30000 } })).our_number;
  assert.equal(over.state, "warn");
  assert.match(over.detail, /over the buyer ceiling/);
});

test("eight listing photos or a video is a look inside; three photos isn't", () => {
  const eyes = (o, videos) => byKey(preContractChecks({ offer: hot(o), videos })).eyes;
  assert.equal(eyes({ autoUnderwrite: { photosAnalyzed: 24 } }).state, "ok");
  assert.equal(eyes({ autoUnderwrite: { photosAnalyzed: 3 } }).state, "warn");
  assert.equal(eyes({}, [{ id: "v1", status: "ready" }]).state, "ok");
  assert.equal(eyes({}, [{ id: "v1", status: "uploading" }]).state, "unknown");
});

test("an off-market house needs no pre-sell; a listed one wants three buyers", () => {
  assert.equal(byKey(preContractChecks({ offer: hot({ offMarket: { value: true, by: "you" } }) })).presell, undefined);
  const two = byKey(preContractChecks({ offer: hot({ presell: { at: T, contactIds: ["b1", "b2"] } }) })).presell;
  assert.equal(two.state, "warn");
  assert.match(two.detail, /only 2 buyers/);
  const three = byKey(preContractChecks({ offer: hot({ presell: { at: T, contactIds: ["b1", "b2", "b3"] } }) })).presell;
  assert.equal(three.state, "ok");
  assert.equal(PRESELL_MIN_BUYERS, 3);
});

test("a hand tick closes an item and says you checked it; taking it back reopens it", () => {
  const pc = tickPreContract(null, { key: "extension", note: "asked for a week" }, Date.parse(T));
  assert.deepEqual(normalizePreContract(pc), { ticks: { extension: { at: T, note: "asked for a week" } } });
  const k = byKey(preContractChecks({ offer: hot({ preContract: pc }) }));
  assert.equal(k.extension.state, "ok");
  assert.match(k.extension.detail, /you checked it: asked for a week/);
  assert.equal(byKey(preContractChecks({ offer: hot({ preContract: tickPreContract(pc, { key: "extension", done: false }) }) })).extension.state, "unknown");
  assert.deepEqual(tickPreContract(pc, { key: "nonsense" }), normalizePreContract(pc), "an unknown key changes nothing");
});

test("what a deal keeps at promote: the open keys and each item's state", () => {
  const checks = preContractChecks({ offer: hot({ autoUnderwrite: { photosAnalyzed: 20 } }) });
  const rec = preContractRecord(checks, Date.parse(T));
  assert.equal(rec.at, T);
  assert.ok(!rec.open.includes("eyes"));
  assert.ok(rec.open.includes("presell"));
  assert.equal(rec.checks.length, checks.length);
});
