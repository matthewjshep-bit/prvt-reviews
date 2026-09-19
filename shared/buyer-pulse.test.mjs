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
