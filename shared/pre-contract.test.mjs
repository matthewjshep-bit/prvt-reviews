// pre-contract.test.mjs — what to look at before we sign (2026-10-15).
//
// The funnel review: 7 of 8 listed-house contracts fell through. The dead
// ones had rehab low or ARV high, two were mobile homes signed and backed out
// of, and one was signed with no buyer lined up.

import test from "node:test";
import assert from "node:assert/strict";
import {
  preContractChecks, needsPreContract, tickPreContract, normalizePreContract, openChecks, preContractRecord, houseWordsUpdate, preContractVerdict,
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
  // Land's own check is for land only.
  assert.deepEqual(checks.map((c) => c.key), PRE_CONTRACT_KEYS.filter((k) => k !== "land_value"));
  // The one thing the record answers by itself: the yes came two days after our number.
  assert.deepEqual(checks.filter((c) => !openChecks(checks).includes(c)).map((c) => c.key), ["fast_yes"]);
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

/* ---------- what the agent said: off-market mark and the paper ---------- */

test("an agent's backup offer takes off the machine's off-market mark, never yours", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  const machine = { id: "o1", status: "sent", offMarket: { value: true, by: "machine", why: "an agent brought it and Zillow doesn't show it for sale" } };
  const r = houseWordsUpdate(machine, { onMarket: "back up at" }, now);
  assert.equal(r.offMarket.value, false);
  assert.match(r.offMarket.why, /back up at/);
  assert.equal(houseWordsUpdate({ ...machine, offMarket: { value: true, by: "you" } }, { onMarket: "back up at" }, now), null);
  assert.equal(houseWordsUpdate({ id: "o2", status: "sent" }, { onMarket: "back up at" }, now), null, "nothing to take off");
  assert.equal(houseWordsUpdate({ ...machine, deal: { stage: "under_contract" } }, { onMarket: "back up at" }, now), null, "a deal is its own record");
});

test("paper to sign on a held draft the app never priced is the signing moment", () => {
  const now = Date.parse("2026-10-19T23:45:00Z");
  const draft = { id: "d1", status: "draft", address: "1538 NW 61st St, Seattle, WA 98107" };
  assert.equal(needsPreContract(draft, { now }), false);
  const patch = houseWordsUpdate(draft, { paper: "sent_to_sign", draftId: "r1" }, now);
  assert.equal(patch.paperAt.kind, "sent_to_sign");
  const marked = { ...draft, ...patch };
  assert.equal(needsPreContract(marked, { now: now + 3600000 }), true);
  // A stronger word moves the kind up and keeps the first moment; a weaker one changes nothing.
  const signed = houseWordsUpdate(marked, { paper: "signed" }, now + 7200000);
  assert.equal(signed.paperAt.kind, "signed");
  assert.equal(signed.paperAt.at, patch.paperAt.at);
  assert.equal(houseWordsUpdate({ ...marked, ...signed }, { paper: "writing_up" }, now + 9000000), null);
  // Two weeks on it's history.
  assert.equal(needsPreContract(marked, { now: now + 15 * 86400000 }), false);
});

/* ---------- the agent's own texts (2026-10-21) ---------- */

const line = (at, dir, body) => `[${at}] ${dir} sms: ${body}`;
const state = (checks, key) => checks.find((c) => c.key === key)?.state;

// 1538 NW 61st St: a teardown lot, the agent's number, signed the same night.
const BALLARD_THREAD = [
  line("2026-10-19 19:24", "US", "Hi, saw your listing at 1538 NW 61st St. Is it a bit of a project, or pretty turnkey?"),
  line("2026-10-19 19:50", "THEM", "It's a teardown."),
  line("2026-10-19 19:54", "THEM", "It's listed for $925K."),
  line("2026-10-19 20:07", "THEM", "In that neighborhood that dirt lot is worth about $900,000."),
  line("2026-10-19 22:55", "US", "$900K offer"),
  line("2026-10-19 22:56", "US", "$890K"),
  line("2026-10-19 23:43", "THEM", "Just sent you the offer for your signature."),
].join("\n");
const ballardDraft = {
  id: "d1", status: "draft", address: "1538 NW 61st St, Seattle, WA 98107", contactId: "agent",
  asset: { type: "land", by: "you" }, createdAt: "2026-10-19T20:08:00Z",
  paperAt: { at: "2026-10-19T23:43:00Z", kind: "sent_to_sign" },
  draft: { inputs: { arv: 0, repairs: 0 }, subjectInfo: { sqft: 2090, lotSqft: 4748 } },
};

test("the agent calling it a teardown warns before we sign, and so does their number on a lot nobody valued", () => {
  const now = Date.parse("2026-10-19T23:45:00Z");
  const checks = preContractChecks({ offer: ballardDraft, price: 890000, thread: BALLARD_THREAD, now });
  assert.equal(state(checks, "agent_words"), "warn");
  assert.match(checks.find((c) => c.key === "agent_words").detail, /teardown/);
  assert.equal(state(checks, "our_number"), "warn", "never priced");
  assert.equal(state(checks, "their_number"), "warn");
  assert.equal(state(checks, "land_value"), "warn");
  assert.equal(checks.some((c) => c.key === "arv_actives" || c.key === "rehab_floor"), false, "land has no ARV or rehab check");
  const v = preContractVerdict(checks, { address: ballardDraft.address, price: 890000 });
  assert.ok(v.length <= 300, v);
  assert.match(v, /^1538 NW 61st St at 890k: /);
  assert.match(v, /never priced/);
  assert.match(v, /don't sign\.$/);
});

// 3831 Bagley Ave N: "perhaps a tear down", "one other offer", "more like 740k",
// signed at 740 over our 697.5 within a day.
const BAGLEY_THREAD = [
  line("2026-08-30 20:11", "THEM", "3831 Bagley Ave N. This is a small lot. Built in 1924. It could use a lot of work. Perhaps a tear down."),
  line("2026-10-13 21:54", "THEM", "Try to get in today -- because I have to respond to that one other offer"),
  line("2026-10-13 22:46", "US", "sending our written offer on 3831 Bagley Ave N — $697,500"),
  line("2026-10-14 03:40", "THEM", "Our current offer is 730k. So in my mind you might need to be more like 740k"),
  line("2026-10-14 17:22", "US", "Ok lets do it do you mind writing it up for me at $740K?"),
].join("\n");
const bagleyOffer = {
  id: "o1", status: "sent", address: "3831 Bagley Ave N, Seattle, WA 98103", contactId: "agent", cashAmount: 697500,
  arv: 1161000, repairs: 102000, statusHistory: [{ status: "sent", ts: "2026-10-13T22:46:00Z" }],
  agreed: { amount: 740000, at: "2026-10-14T18:22:00Z", via: "operator" },
  snapshot: { subjectSqft: 1780 },
};

test("someone else bidding, a price over ours that the agent named, and a gut house priced at $57/sqft all warn", () => {
  const checks = preContractChecks({ offer: bagleyOffer, settings: { maoPctOfArv: 75 }, price: 740000, thread: BAGLEY_THREAD, now: Date.parse("2026-10-14T18:30:00Z") });
  assert.equal(state(checks, "competing"), "warn");
  assert.equal(state(checks, "their_number"), "warn");
  assert.equal(state(checks, "our_number"), "warn");
  assert.match(checks.find((c) => c.key === "our_number").detail, /above our number/);
  assert.equal(state(checks, "rehab_floor"), "warn");
  assert.match(checks.find((c) => c.key === "rehab_floor").detail, /gut tier/);
  assert.equal(state(checks, "fast_yes"), "warn");
});

// 7034 S K St (closed): our number, eleven days of back and forth, nothing said.
test("a house we priced, negotiated for a week and nobody called a teardown passes the thread checks", () => {
  const thread = [
    line("2026-09-17 18:00", "US", "We'd be around 319k"),
    line("2026-09-20 18:00", "THEM", "Seller wants more, can you do better?"),
    line("2026-09-28 18:00", "THEM", "Ok they'll take 318k"),
  ].join("\n");
  const offer = { id: "o2", status: "sent", address: "7034 S K St, Tacoma, WA 98408", cashAmount: 319000, arv: 499000, repairs: 45000,
    statusHistory: [{ status: "sent", ts: "2026-09-17T18:00:00Z" }], agreed: { amount: 318000, at: "2026-09-28T18:00:00Z" }, snapshot: { subjectSqft: 1100 } };
  const checks = preContractChecks({ offer, price: 318000, thread, now: Date.parse("2026-09-28T19:00:00Z") });
  for (const key of ["agent_words", "competing", "their_number", "fast_yes"]) assert.equal(state(checks, key), "ok", key);
});

test("without the thread the agent checks say they weren't read", () => {
  const checks = preContractChecks({ offer: bagleyOffer, price: 740000 });
  for (const key of ["agent_words", "competing", "their_number"]) assert.equal(state(checks, key), "unknown", key);
});

