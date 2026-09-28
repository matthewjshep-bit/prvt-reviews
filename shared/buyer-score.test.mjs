// buyer-score.test.mjs — standing and per-deal rank, part by part.

import test from "node:test";
import assert from "node:assert/strict";
import { scoreBuyer, rankForDeal, dealTarget, engagementFromEvents, pickWave } from "./buyer-score.js";

const NOW = Date.parse("2026-09-13T12:00:00Z");
const monthsBack = (n) => new Date(NOW - n * 30.44 * 86400000).toISOString();

test("a committed buyer is VIP whatever else is true", () => {
  const r = scoreBuyer({ engagement: { committed: 1 } }, { now: NOW });
  assert.equal(r.tier, "vip");
});

test("an active flipper who replied is Active or better; a ghost is Cold", () => {
  const good = scoreBuyer({
    flips: { lastAt: monthsBack(2), count: 4, largest: 600000 }, phone: "+1", lastRepliedAt: monthsBack(1),
    markets: { cities: ["tacoma"], regions: ["pierce"], types: ["flip"] }, engagement: { viewed: 1 },
  }, { now: NOW });
  assert.ok(good.score >= 65, `score ${good.score}`);
  assert.equal(good.tier, "vip");

  const ghost = scoreBuyer({
    flips: { lastAt: monthsBack(30), count: 1 }, phone: "+1",
    markets: { cities: ["tacoma"], regions: ["pierce"], types: ["flip"] }, engagement: { blasts: 4 },
  }, { now: NOW });
  assert.equal(ghost.ghost, true);
  assert.equal(ghost.tier, "cold");
});

test("rank: same city beats same region beats elsewhere, and price range counts", () => {
  const t = dealTarget({ city: "Kirkland", priceMin: 650000, priceMax: 850000 });
  assert.deepEqual([t.city, t.region, t.price, t.strategy], ["kirkland", "eastside", 750000, "flip"]);
  const base = { flips: { lastAt: monthsBack(3), largest: 700000 }, tier: "active" };
  const city = rankForDeal({ ...base, markets: { cities: ["kirkland"], regions: ["eastside"], types: ["flip"] } }, t, { now: NOW });
  const region = rankForDeal({ ...base, markets: { cities: ["bellevue"], regions: ["eastside"], types: ["flip"] } }, t, { now: NOW });
  const away = rankForDeal({ ...base, markets: { cities: ["tacoma"], regions: ["pierce"], types: ["flip"] } }, t, { now: NOW });
  assert.ok(city.score > region.score && region.score > away.score);
  assert.equal(city.parts.price, 20);
  assert.ok(city.reasons.includes("buys in this city"));
});

test("engagement counts fold per contact", () => {
  const m = engagementFromEvents([
    { contactId: "a", type: "blast_sent", at: "2026-01-01" },
    { contactId: "a", type: "dataroom_viewed", at: "2026-01-02" },
    { contactId: "a", type: "investor_committed", at: "2026-01-05" },
  ]);
  assert.deepEqual(m.get("a"), { blasts: 1, viewed: 1, evaluating: 0, committed: 1, passed: 0, talks: 0, lastEngagedAt: "2026-01-05" });
});

test("a logged call or a fact learned from them counts as a talk, and never moves the deal clock", () => {
  const m = engagementFromEvents([
    { contactId: "a", type: "call_summary", source: "call", at: "2026-02-01" },
    { contactId: "a", type: "fact_learned", source: "conversation", at: "2026-02-02" },
    { contactId: "a", type: "fact_learned", source: "operator", at: "2026-02-03" },
  ]);
  assert.equal(m.get("a").talks, 2);
  assert.equal(m.get("a").lastEngagedAt, "");
});

test("a deal goes only to buyers who buy where it is: a VIP who works Snohomish is not sent a Tacoma house", () => {
  // 7034 S K St, Tacoma, 2026-09-28: wave 1 sorted VIPs first against a floor
  // of 50, and a VIP flipper in the price range scores 65 with no location at
  // all. Fifteen of twenty-five texts went to Snohomish and Eastside buyers;
  // one of them had told us the week before that he only buys in Snohomish.
  const t = dealTarget({ city: "Tacoma", priceMin: 329000, priceMax: 329000 });
  const buyer = (contactId, tier, cities, regions) => {
    const i = { contactId, name: contactId, phone: "+1", tier, markets: { cities, regions, types: ["flip"] }, flips: { largest: 330000, lastAt: new Date().toISOString() } };
    const r = rankForDeal(i, t);
    return { ...i, rank: r.score, rankParts: r.parts };
  };
  const ranked = [
    buyer("snohomish-vip", "vip", ["arlington"], ["snohomish"]),
    buyer("tacoma-active", "active", ["tacoma"], ["pierce"]),
    buyer("pierce-vip", "vip", ["orting"], ["pierce"]),
    buyer("eastside-vip", "vip", ["redmond"], ["eastside"]),
  ];
  assert.ok(ranked[0].rank >= 50, "the Snohomish VIP clears the old floor on tier and price alone");
  const w1 = pickWave(ranked, { wave: 1, floor: 50 }).map((i) => i.contactId);
  assert.deepEqual(w1, ["pierce-vip", "tacoma-active"]);
  const w2 = pickWave(ranked, { wave: 2, floor: 35 }).map((i) => i.contactId);
  assert.ok(!w2.includes("snohomish-vip") && !w2.includes("eastside-vip"));
});
