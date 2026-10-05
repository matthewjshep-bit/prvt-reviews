import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBuyerPulse, pickPulseBuyers, pulseSubject } from "./buyer-pulse.js";

const NOW = Date.parse("2026-09-18T18:00:00Z");
const DAY = 86400000;
const ago = (days) => new Date(NOW - days * DAY).toISOString();
const buyer = (id, over = {}) => ({ contactId: id, name: `Buyer ${id}`, status: "active", phone: "+12065550100", tags: ["investor"], score: 10, lastMessageAt: ago(30), ...over });

test("the pulse check ships off, and sending itself is a second switch", () => {
  const s = normalizeBuyerPulse(undefined);
  assert.equal(s.enabled, false);
  assert.equal(s.autoSend, false);
  assert.equal(s.dailyCap, 10);
  assert.equal(normalizeBuyerPulse({ dailyCap: 5000 }).dailyCap, 50, "a typo is not a blast");
  assert.equal(normalizeBuyerPulse({ enabled: "true" }).enabled, false, "only a real true turns it on");
});

test("buyers who never wrote back go first, best score first", () => {
  const { picks } = pickPulseBuyers({ now: NOW, settings: { dailyCap: 2, conversedShare: 0 }, investors: [
    buyer("low", { score: 5 }), buyer("high", { score: 60 }), buyer("mid", { score: 30 }),
  ] });
  assert.deepEqual(picks.map((p) => p.contactId), ["high", "mid"]);
  assert.ok(picks.every((p) => p.group === "quiet"));
});

test("a buyer we have talked to waits behind the quiet ones but is never starved", () => {
  const investors = [
    ...Array.from({ length: 40 }, (_, i) => buyer(`q${i}`, { score: 50 })),
    buyer("talked-long-ago", { lastRepliedAt: ago(200), score: 90 }),
    buyer("talked-lately", { lastRepliedAt: ago(20), score: 90 }),
  ];
  const { picks, counts } = pickPulseBuyers({ now: NOW, settings: { dailyCap: 10 }, investors });
  assert.equal(picks.length, 10);
  assert.equal(picks.filter((p) => p.group === "conversed").length, 2, "20% of ten");
  assert.equal(picks.at(-1).group, "conversed", "after the quiet ones in the day's order");
  assert.equal(picks.filter((p) => p.group === "conversed")[0].contactId, "talked-long-ago", "longest silent first");
  assert.equal(counts.conversed, 2);
  const one = pickPulseBuyers({ now: NOW, settings: { dailyCap: 3 }, investors });
  assert.equal(one.picks.filter((p) => p.group === "conversed").length, 1, "never less than one a day while any wait");
});

test("when nobody quiet is left the whole day goes to buyers we have talked to", () => {
  const investors = [buyer("a", { lastRepliedAt: ago(90) }), buyer("b", { lastRepliedAt: ago(60) }), buyer("c", { lastRepliedAt: ago(40) })];
  const { picks } = pickPulseBuyers({ now: NOW, settings: { dailyCap: 10 }, investors });
  assert.deepEqual(picks.map((p) => p.contactId), ["a", "b", "c"]);
});

test("nobody mid-conversation, just blasted, on a live deal, opted out, or pulsed this quarter gets one", () => {
  const { picks, counts } = pickPulseBuyers({
    now: NOW, settings: { dailyCap: 50 },
    pulsedAt: new Map([["pulsed", ago(30)], ["pulsed-last-year", ago(200)]]),
    openDraftIds: new Set(["has-draft"]),
    investors: [
      buyer("ok"),
      buyer("texting-now", { lastMessageAt: ago(2) }),
      buyer("blasted-yesterday", { lastBlastAt: ago(1) }),
      buyer("on-deal", { onLiveDeal: true }),
      buyer("dnc", { tags: ["investor", "DNC"] }),
      buyer("stop", { tags: ["opted-out"] }),
      buyer("no-phone", { phone: "" }),
      buyer("paused", { status: "paused" }),
      buyer("pulsed"), buyer("pulsed-last-year"), buyer("has-draft"),
    ],
  });
  assert.deepEqual(picks.map((p) => p.contactId).sort(), ["ok", "pulsed-last-year"]);
  assert.deepEqual([counts.recentlyTexted, counts.onDeal, counts.blocked, counts.noPhone, counts.pulsedRecently, counts.openDraft], [2, 1, 2, 1, 1, 1]);
});

test("a market tag that merely contains 'stop' is not an opt-out", () => {
  const { picks } = pickPulseBuyers({ now: NOW, investors: [buyer("x", { tags: ["dispo-city-bus-stop-heights", "disposition-seatac"] })] });
  assert.equal(picks.length, 1);
});

test("the message leans on the city they last bought in, never the street, the price or the lender", () => {
  const s = pulseSubject(buyer("x", {
    flips: { count: 3, lastAt: "2025-09-16T00:00:00.000Z", largest: 494700, lastAddress: "285 EARLINGTON AVE SW, RENTON, WA", lenders: ["Some Fund LLC"] },
    markets: { cities: ["renton", "kent"], regions: ["south-king"], types: ["flip"] },
    engagement: { blasts: 4, viewed: 1, evaluating: 0, committed: 0, passed: 1 },
  }), { now: NOW });
  assert.equal(s.lastBuyCity, "Renton");
  assert.equal(s.lastBuyYear, 2025);
  assert.equal(s.dealsSent, 4);
  assert.equal(s.lookedAtDeals, true);
  assert.deepEqual(s.cities, ["Renton", "Kent"]);
  assert.doesNotMatch(JSON.stringify(s), /EARLINGTON|494700|Fund/i);
});

test("a purchase from years ago is not a context clue", () => {
  const s = pulseSubject(buyer("x", { flips: { count: 1, lastAt: "2021-01-01T00:00:00.000Z", lastAddress: "1 A ST, KENT, WA" } }), { now: NOW });
  assert.equal(s.lastBuyCity, "");
});

test("a buy box on file is there to confirm, not to ask for again", () => {
  const s = pulseSubject(buyer("x", { buybox: { areas: ["Tacoma", "Lakewood"], priceMax: 450000, propertyTypes: ["SFR"], rehabAppetite: "heavy" }, lastRepliedAt: ago(50) }), { now: NOW });
  assert.equal(s.buyBox, "areas Tacoma, Lakewood; up to 450K; SFR; heavy rehab");
  assert.equal(s.conversed, true);
});

test("a buyer who passed on a deal has talked with us, whatever the reply stamp says", () => {
  const { picks } = pickPulseBuyers({ now: NOW, settings: { dailyCap: 5 }, investors: [
    buyer("passed", { engagement: { blasts: 2, passed: 1, lastEngagedAt: ago(40) } }),
    buyer("only-opened", { engagement: { blasts: 2, viewed: 3 } }),
  ] });
  assert.deepEqual(picks.map((p) => [p.contactId, p.group]), [["only-opened", "quiet"], ["passed", "conversed"]]);
  assert.equal(picks[1].subject.conversed, true);
});

test("a market slug reads as a place name", () => {
  assert.deepEqual(pulseSubject(buyer("x", { markets: { cities: ["federal-way"] } }), { now: NOW }).cities, ["Federal Way"]);
});

/* ---------- friends first, and each line its own cadence (2026-09-29) ---------- */

test("a buyer who bought from us is checked in with first", () => {
  const { picks, counts } = pickPulseBuyers({ now: NOW, settings: { dailyCap: 2 }, investors: [
    buyer("quiet1", { score: 90 }), buyer("quiet2", { score: 80 }),
    buyer("friend", { engagement: { committed: 1 }, lastRepliedAt: ago(40) }),
  ] });
  assert.equal(picks[0].contactId, "friend");
  assert.equal(picks[0].group, "friend");
  assert.equal(counts.friends, 1);
});

test("buyers we never talked to can wait out a longer cadence than the ones we did", () => {
  const pulsedAt = new Map([["quiet", ago(45)], ["talked", ago(45)]]);
  const investors = [buyer("quiet"), buyer("talked", { lastRepliedAt: ago(100) })];
  const same = pickPulseBuyers({ now: NOW, investors, pulsedAt, settings: { dailyCap: 5, everyDays: 30 } });
  assert.equal(same.picks.length, 2, "unset, one cadence for both — nothing changes");
  const split = pickPulseBuyers({ now: NOW, investors, pulsedAt, settings: { dailyCap: 5, everyDays: 30, quietEveryDays: 90 } });
  assert.deepEqual(split.picks.map((p) => p.contactId), ["talked"]);
});

test("the plan says how long one pass through the book takes at this cap", () => {
  const investors = Array.from({ length: 95 }, (_, i) => buyer(`b${i}`));
  assert.equal(pickPulseBuyers({ now: NOW, investors, settings: { dailyCap: 30 } }).counts.passWorkdays, 4);
});

test("a buyer you stopped the bot on is never picked for a check-in", () => {
  const { picks, counts } = pickPulseBuyers({ now: NOW, settings: { dailyCap: 10 }, investors: [buyer("b1"), buyer("b2")], stopped: new Set(["b2"]) });
  assert.deepEqual(picks.map((p) => p.contactId), ["b1"]);
  assert.equal(counts.stopped, 1);
});

test("checking in less with a buyer doubles their cadence; more halves it", () => {
  const pulsed = new Map([["b1", ago(100)], ["b2", ago(50)]]);
  const base = { now: NOW, settings: { dailyCap: 10, everyDays: 90, quietEveryDays: 90 }, investors: [buyer("b1"), buyer("b2")], pulsedAt: pulsed };
  assert.deepEqual(pickPulseBuyers(base).picks.map((p) => p.contactId), ["b1"], "normal: 90 days");
  assert.deepEqual(pickPulseBuyers({ ...base, paceBy: new Map([["b1", 2]]) }).picks.map((p) => p.contactId), [], "less: b1 waits for 180");
  assert.deepEqual(pickPulseBuyers({ ...base, paceBy: new Map([["b2", 0.5]]) }).picks.map((p) => p.contactId).sort(), ["b1", "b2"], "more: b2 at 45");
});

/* ---------- relationship first (2026-10-05) ---------- */

// Matt: "we are currently reaching out to investors who haven't responded to
// see what fits their bill — let's do more of this and make it more
// personalized." A buyer who never answered a deal isn't nudged about that
// house any more (shared/follow-up.js); they're asked what fits them, with
// that house as the way in.
test("a buyer who never answered a deal gets a pulse about fit, not a nudge about the deal", () => {
  const history = new Map([
    ["after", { lastDeal: { address: "3511 NE 153rd St, Lake Forest Park, WA 98155", at: ago(12), answered: false } }],
    ["fresh", { lastDeal: { address: "3511 NE 153rd St, Lake Forest Park, WA 98155", at: ago(12), answered: true } }],
  ]);
  const { picks } = pickPulseBuyers({ now: NOW, history, settings: { dailyCap: 2, conversedShare: 0 }, investors: [
    buyer("top", { score: 90 }), buyer("after", { score: 5, lastBlastAt: ago(12), lastMessageAt: ago(12) }), buyer("fresh", { score: 4, lastBlastAt: ago(12) }),
  ] });
  assert.deepEqual(picks.map((p) => [p.contactId, p.group]), [["after", "after_deal"], ["top", "quiet"]], "ahead of the quiet line");
  const s = picks[0].subject;
  assert.equal(s.lastHouse.street, "3511 NE 153rd St");
  assert.equal(s.lastHouse.city, "Lake Forest Park");
  assert.equal(s.lastHouse.how, "no answer");
  // Too soon after the deal, or too long ago: the quiet line as before.
  const soon = pickPulseBuyers({ now: NOW, history: new Map([["b", { lastDeal: { address: "1 A St, Kent, WA", at: ago(4), answered: false } }]]), settings: { dailyCap: 5 }, investors: [buyer("b")] });
  assert.equal(soon.picks[0]?.group, "quiet");
  assert.equal(normalizeBuyerPulse({}).afterDeal, true);
  assert.equal(pickPulseBuyers({ now: NOW, history, settings: { dailyCap: 2, conversedShare: 0, afterDeal: false }, investors: [buyer("after", { lastBlastAt: ago(12) })] }).picks[0].group, "quiet");
});

test("a buyer who ignored two pulses is asked again in 90 days, not 30", () => {
  const pulsedAt = new Map([["shy", ago(40)], ["new", ago(40)]]);
  const history = new Map([["shy", { unansweredPulses: 2 }], ["new", { unansweredPulses: 1 }]]);
  const { picks, counts } = pickPulseBuyers({ now: NOW, pulsedAt, history, settings: { dailyCap: 5, everyDays: 30 }, investors: [buyer("shy"), buyer("new")] });
  assert.deepEqual(picks.map((p) => p.contactId), ["new"]);
  assert.equal(counts.pulsedRecently, 1);
  assert.equal(pickPulseBuyers({ now: NOW, pulsedAt, history, settings: { dailyCap: 5, everyDays: 30, ignoredSlowdown: 0 }, investors: [buyer("shy")] }).picks.length, 1, "0 turns the slowdown off");
});

test("the pulse asks only for the piece of the buy box we don't have", () => {
  const s = pulseSubject(buyer("x", { buybox: { areas: ["Shoreline", "Edmonds"], propertyTypes: ["sfr"] } }), { now: NOW });
  assert.deepEqual(s.missing, ["price range", "how much work they take on"]);
  assert.match(s.buyBox, /areas Shoreline, Edmonds/);
  assert.deepEqual(pulseSubject(buyer("y"), { now: NOW }).missing, ["where they buy", "what kind of house", "price range", "how much work they take on"]);
});

test("the pulse picks up from what they told us, and says how we found someone new", () => {
  const inv = buyer("x", {
    lastRepliedAt: ago(60),
    record: { personal_details: "Building two spec homes in Shoreline this year", last_convo_summary: "Passed on Tacoma — too far south; wants north King", suggested_next_action: "Send north end deals" },
  });
  const history = new Map([["x", { lastDeal: { address: "7034 South K Street, Tacoma, WA", at: ago(60), answered: true, outcome: "passed", reason: "too far south" },
    passes: [{ address: "7034 South K Street, Tacoma, WA", reason: "too far south" }] }]]);
  const s = pulseSubject(inv, { now: NOW, history: history.get("x") });
  assert.match(s.aboutThem, /spec homes in Shoreline/);
  assert.match(s.lastSummary, /too far south/);
  assert.equal(s.nextAction, "Send north end deals");
  assert.deepEqual(s.passReasons, ["7034 South K Street: too far south"]);
  assert.equal(s.lastHouse.how, "passed — too far south");
  assert.equal(s.source, "");
  const fb = pulseSubject(buyer("f", { tags: ["investor", "dispo-source-fb-warei"] }), { now: NOW });
  assert.equal(fb.source, "found you through the WA real estate Facebook group");
});
