// buyer-score.test.mjs — standing and per-deal rank, part by part.

import test from "node:test";
import assert from "node:assert/strict";
import { scoreBuyer, rankForDeal, dealTarget, engagementFromEvents } from "./buyer-score.js";

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
  assert.deepEqual(m.get("a"), { blasts: 1, viewed: 1, evaluating: 0, committed: 1, passed: 0, lastEngagedAt: "2026-01-05" });
});
