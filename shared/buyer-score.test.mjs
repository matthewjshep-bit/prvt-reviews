// buyer-score.test.mjs — standing and per-deal rank, part by part.

import test from "node:test";
import assert from "node:assert/strict";
import { scoreBuyer, rankForDeal, dealTarget, engagementFromEvents, pickDealBuyers, blastedTo, buyerDealbreakers } from "./buyer-score.js";

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
  assert.ok(city.reasons.includes("bought in this city"));
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
  // Only the Tacoma buyer: a Pierce region tag off an Orting loan is not
  // buying in Tacoma (Matt, 2026-10-21).
  assert.deepEqual(pickDealBuyers(ranked).map((i) => i.contactId), ["tacoma-active"]);
});

/* ---------- ranking by the buy box, not only the city (2026-09-29) ---------- */

const kent = dealTarget({ city: "Kent", zip: "98031", priceMin: 300000, priceMax: 340000, propertyTypes: ["single_family"], rehabAppetite: "medium" });
const bare = (over = {}) => ({ markets: { cities: [], regions: [], types: [] }, buybox: {}, tier: "active", phone: "+1", ...over });

test("a 'South King' buy box buys in Kent", () => {
  const r = rankForDeal(bare({ buybox: { areas: ["South King"] } }), kent, { now: NOW });
  assert.equal(r.parts.location, 22);
  assert.ok(r.reasons.includes("buys in this region"));
  assert.equal(rankForDeal(bare({ buybox: { areas: ["King County"] } }), kent, { now: NOW }).parts.location, 22, "King alone spans the county's regions");
});

test("a zip buy box matches the deal's zip", () => {
  const r = rankForDeal(bare({ buybox: { areas: ["98031", "98032"] } }), kent, { now: NOW });
  assert.equal(r.parts.location, 35);
  assert.ok(r.reasons.includes("buys in this zip"));
});

test("a buy box that rules the deal out ranks it down; one that fits ranks it up", () => {
  const condoOnly = rankForDeal(bare({ buybox: { areas: ["Kent"], propertyTypes: ["condo"] } }), kent, { now: NOW });
  assert.equal(condoOnly.parts.box, -20);
  const fits = rankForDeal(bare({ buybox: { areas: ["Kent"], propertyTypes: ["single_family"], rehabAppetite: "heavy" } }), kent, { now: NOW });
  assert.equal(fits.parts.box, 10);
  assert.ok(fits.score > condoOnly.score);
});

test("a buyer we're talking to ranks above a stranger with the same fit", () => {
  const stranger = rankForDeal(bare({ buybox: { areas: ["Kent"] } }), kent, { now: NOW });
  const talking = rankForDeal(bare({ buybox: { areas: ["Kent"] }, relationship: "talking" }), kent, { now: NOW });
  assert.equal(talking.score - stranger.score, 8);
});

test("a buyer weighing another deal still gets this deal; one committed elsewhere does not; a DND buyer never does", () => {
  const row = (id, over) => ({ contactId: id, phone: "+1", tier: "vip", rank: 80, rankParts: { location: 35, areaFit: "bought_city" }, ...over });
  const picked = pickDealBuyers([
    row("weighing", { onLiveDeal: true, spokenFor: false }),
    row("committed", { onLiveDeal: true, spokenFor: true }),
    row("dnd", { dnd: true }),
    row("stop-tag", { tags: ["STOP"] }),
  ]);
  assert.deepEqual(picked.map((i) => i.contactId), ["weighing"]);
  // A row from before carries only onLiveDeal: read the old way.
  assert.deepEqual(pickDealBuyers([row("old", { onLiveDeal: true })]), []);
});

test("the catch-up never re-texts a buyer whose first deal text hasn't sent", () => {
  const deal = { id: "o1", address: "123 Main St, Kent, WA 98031",
    deal: { blastTags: ["dispo-123-main-st"], blasts: [{ at: "2026-09-20T18:00:00Z", via: "app", contactIds: ["onWave1"] }] } };
  const sent = blastedTo(deal, {
    events: [
      { type: "blast_sent", contactId: "appSent", offerId: "o1" },
      { type: "blast_sent", contactId: "ghlTag", offerId: null, address: "", data: { tag: "dispo-123-main-st" } },
      { type: "blast_sent", contactId: "ghlStreet", offerId: null, address: "123 Main Street" },
      { type: "blast_sent", contactId: "otherDeal", offerId: "o2", address: "123 Main St" },
      { type: "blast_sent", contactId: "otherStreet", offerId: null, address: "9 Elm St", data: { tag: "dispo-9-elm-st" } },
      { type: "dataroom_viewed", contactId: "viewer", offerId: "o1" },
    ],
    drafts: [
      { contactId: "waiting", status: "draft", outbound: { kind: "blast_open", offerId: "o1" } },
      { contactId: "queued", status: "scheduled", outbound: { kind: "blast_open", offerId: "o1" } },
      { contactId: "midSend", status: "sending", outbound: { kind: "blast_open", offerId: "o1" } },
      { contactId: "otherDraft", status: "draft", outbound: { kind: "blast_open", offerId: "o2" } },
      { contactId: "aReply", status: "draft", outbound: null },
    ],
  });
  assert.deepEqual([...sent].sort(), ["appSent", "ghlStreet", "ghlTag", "midSend", "onWave1", "queued", "waiting"]);
});

/* ---------- the kind of house (2026-10-01) ---------- */

// 1510 Maple Lane, Kent: a mobile home in a park. The blast on promote went to
// twenty-five Kent flippers and none of the twenty buyers tagged mobile-home,
// because the deal had no kind and the waves needed a city match and a phone.
const maple = dealTarget({ city: "Kent", zip: "98030", priceMin: 64000, priceMax: 88000,
  asset: { type: "manufactured", land: "park" }, propertyTypes: ["manufactured"] });
const rankRow = (id, over, t = maple) => {
  const i = { contactId: id, name: id, phone: "+1", tier: "cold", markets: { cities: [], regions: [], types: [] }, buybox: {}, ...over };
  const r = rankForDeal(i, t, { now: NOW });
  return { ...i, rank: r.score, rankParts: r.parts, rankReasons: r.reasons };
};

test("a mobile home goes to buyers who buy mobile homes, not to flippers in the same city", () => {
  const ranked = [
    rankRow("kent-flipper-vip", { tier: "vip", markets: { cities: ["kent"], regions: ["south-king"], types: ["flip"] }, flips: { largest: 80000, lastAt: monthsBack(1) } }),
    rankRow("mobile-home-buyer", { markets: { cities: [], regions: [], types: ["mobile-home"] } }),
  ];
  const picked = pickDealBuyers(ranked, { manufactured: true }).map((i) => i.contactId);
  assert.deepEqual(picked, ["mobile-home-buyer"]);
  assert.ok(ranked[1].rankReasons.includes("buys mobile homes"));
});

test("a mobile home buyer with no area on file still gets it, cold or not", () => {
  const ranked = [rankRow("cold-no-area", { tier: "cold", markets: { cities: [], regions: [], types: ["mobile-home"] } })];
  assert.equal(ranked[0].rankParts.location, 0);
  assert.deepEqual(pickDealBuyers(ranked, { manufactured: true }).map((i) => i.contactId), ["cold-no-area"]);
});

test("a mobile home buyer whose areas are all elsewhere is left off", () => {
  const ranked = [
    rankRow("north", { markets: { cities: ["arlington"], regions: ["snohomish"], types: ["mobile-home"] } }),
    rankRow("south-king", { markets: { cities: ["auburn"], regions: ["south-king"], types: ["mobile-home"] } }),
  ];
  assert.deepEqual(pickDealBuyers(ranked, { manufactured: true }).map((i) => i.contactId), ["south-king"]);
});

test("a buyer who said no park homes never gets a park deal, even tagged mobile-home", () => {
  const ranked = [rankRow("mark", { markets: { cities: [], regions: [], types: ["mobile-home"] },
    buybox: { propertyTypes: ["sfr", "multi_family"], exclusions: "no manufactured homes in parks" } })];
  assert.equal(ranked[0].rankParts.typeRefused, true);
  assert.deepEqual(pickDealBuyers(ranked, { manufactured: true }), []);
});

test("a buyer with only an email gets it when email is allowed, and not otherwise", () => {
  const ranked = [rankRow("email-only", { phone: "", email: "buyer@example.com", markets: { cities: [], regions: [], types: ["mobile-home"] } })];
  assert.deepEqual(pickDealBuyers(ranked, { manufactured: true }), []);
  assert.deepEqual(pickDealBuyers(ranked, { manufactured: true, email: true }).map((i) => i.contactId), ["email-only"]);
});

test("a mobile-homes-only buyer is never sent a house", () => {
  const house = dealTarget({ city: "Kent", zip: "98031", priceMin: 300000, priceMax: 340000, asset: { type: "sfr" } });
  const ranked = [rankRow("mh-only", { tier: "vip", markets: { cities: ["kent"], regions: ["south-king"], types: ["mobile-home"] },
    buybox: { exclusions: "manufactured homes only, no site-built homes" } }, house)];
  assert.equal(ranked[0].rankParts.typeRefused, true);
  assert.deepEqual(pickDealBuyers(ranked), []);
});

test("a deal with no kind ranks exactly as before", () => {
  const t = dealTarget({ city: "Kent", priceMin: 300000, priceMax: 340000 });
  const r = rankForDeal({ tier: "vip", markets: { cities: ["kent"], regions: ["south-king"], types: ["flip"] }, buybox: {} }, t, { now: NOW });
  assert.equal(r.parts.type, 0);
  assert.equal(r.parts.typeRefused, false);
  assert.equal(r.score, 35 + 20 + 10, "location + tier + strategy, nothing else");
});

// 2026-10-02: eight buyers had saved a street rule, eleven "no islands / no
// Vashon", one "off-market only" — and were still sent the house that broke it.
test("a buyer's saved dealbreakers are read off their own words", () => {
  assert.deepEqual(buyerDealbreakers("busy streets"), { site: ["busy_road"], island: false, offMarketOnly: false });
  assert.deepEqual(buyerDealbreakers("no busy streets, no proximity to commercial district, not interested in Vashon").site.sort(), ["backs_commercial", "busy_road"]);
  assert.equal(buyerDealbreakers("Vashon Island (too far)").island, true);
  assert.equal(buyerDealbreakers("Seattle city limits only, no on-market listings, off-market only").offMarketOnly, true);
  assert.deepEqual(buyerDealbreakers(""), { site: [], island: false, offMarketOnly: false });
});

const tacoma = (over = {}) => ({ contactId: "x", phone: "+12065550100", tier: "vip", markets: { cities: ["tacoma"], regions: [], types: ["flip"] }, buybox: {}, ...over });
const rankAll = (buyers, target) => buyers.map((i) => { const r = rankForDeal(i, target, { now: NOW }); return { ...i, rank: r.score, rankParts: r.parts, rankReasons: r.reasons }; });

test("a buyer who said no busy streets is left off a busy-road deal and still gets a quiet-street deal", () => {
  const vlad = tacoma({ contactId: "vlad", buybox: { exclusions: "no busy streets or short basements" } });
  const other = tacoma({ contactId: "other" });
  const busy = dealTarget({ city: "Tacoma", site: ["busy_road"] });
  const ranked = rankAll([vlad, other], busy);
  assert.deepEqual(pickDealBuyers(ranked).map((i) => i.contactId), ["other"]);
  assert.match(ranked[0].rankReasons.join(" | "), /won't take it \(they said no busy streets\)/);
  const quiet = dealTarget({ city: "Tacoma", site: [] });
  assert.deepEqual(pickDealBuyers(rankAll([vlad, other], quiet)).map((i) => i.contactId).sort(), ["other", "vlad"], "a dealbreaker only ever narrows");
});

test("no islands keeps a buyer off Vashon; off-market only keeps one off a house on the MLS", () => {
  const vashon = (over) => tacoma({ markets: { cities: ["vashon"], regions: [], types: ["flip"] }, ...over });
  const island = dealTarget({ city: "Vashon", island: true });
  assert.deepEqual(pickDealBuyers(rankAll([vashon({ contactId: "a", buybox: { exclusions: "no islands" } }), vashon({ contactId: "b" })], island)).map((i) => i.contactId), ["b"]);
  const listed = dealTarget({ city: "Tacoma", onMarket: true });
  assert.deepEqual(pickDealBuyers(rankAll([tacoma({ contactId: "c", buybox: { exclusions: "off-market only" } }), tacoma({ contactId: "d" })], listed)).map((i) => i.contactId), ["d"]);
});

/* ---------- land goes to the buyers who build (2026-10-21) ---------- */

// 1538 NW 61st St, Seattle: a teardown lot. Wave 1 went to twenty-five
// flippers ("I'm not a land guy"); the builders on the same block were found
// by hand the next day.
const ballard = dealTarget({ city: "Seattle", zip: "98107", priceMin: 860000, priceMax: 960000, asset: { type: "land" } });

test("a land deal goes to buyers who build, not to flippers in the same city", () => {
  assert.equal(ballard.strategy, "new-construction");
  const ranked = [
    rankRow("seattle-flipper-vip", { tier: "vip", markets: { cities: ["seattle"], regions: ["seattle"], types: ["flip"] }, flips: { largest: 900000, lastAt: monthsBack(1) } }, ballard),
    rankRow("ballard-builder", { tier: "cold", markets: { cities: ["seattle"], regions: ["seattle"], types: ["new-construction"] } }, ballard),
    rankRow("tacoma-builder", { tier: "cold", markets: { cities: ["tacoma"], regions: ["pierce"], types: ["new-construction"] } }, ballard),
  ];
  assert.deepEqual(pickDealBuyers(ranked, { land: true }).map((i) => i.contactId), ["ballard-builder"]);
  assert.ok(ranked[1].rankReasons.includes("builds"));
});


/* ---------- everyone who buys there, at once (2026-10-21) ---------- */

// Matt, 2026-10-21: a deal under contract went to twenty-five VIP and Active
// buyers first, VIPs ahead, and the rest two days later. VIPs got bad deals
// and the buyers who buy on that street waited or never heard. Now: everyone
// who bought there or told us they buy there, all at once, whatever their tier.

test("a deal goes to every buyer who buys in its city, not twenty-five VIPs first", () => {
  const tiers = ["cold", "active", "vip"];
  const buyers = Array.from({ length: 40 }, (_, n) => bare({ contactId: `b${n}`, tier: tiers[n % 3],
    ...(n % 2 ? { markets: { cities: ["kent"], regions: ["south-king"], types: ["flip"] } } : { buybox: { areas: ["Kent"] } }) }));
  const picked = pickDealBuyers(rankAll(buyers, kent));
  assert.equal(picked.length, 40);
  for (let k = 1; k < picked.length; k++) assert.ok(picked[k - 1].rank >= picked[k].rank, "best fit first, not VIPs first");
});

test("a borrower-list region tag alone doesn't get a Kent deal, but saying South King does", () => {
  const ranked = rankAll([
    bare({ contactId: "auburn-loan", markets: { cities: ["auburn"], regions: ["south-king"], types: ["flip"] } }),
    bare({ contactId: "said-south-king", buybox: { areas: ["South King"] } }),
    bare({ contactId: "said-zip", buybox: { areas: ["98031"] } }),
  ], kent);
  assert.equal(ranked[0].rankParts.areaFit, null);
  assert.deepEqual(ranked.slice(1).map((i) => i.rankParts.areaFit), ["said_region", "said_zip"]);
  assert.deepEqual(pickDealBuyers(ranked).map((i) => i.contactId).sort(), ["said-south-king", "said-zip"]);
});

test("a buyer who bought in Kent through a financed purchase gets the Kent deal with no tag", () => {
  const ranked = rankAll([bare({ contactId: "kent-loan", flips: { cities: ["kent"], lastAt: monthsBack(4), largest: 320000 } })], kent);
  assert.equal(ranked[0].rankParts.areaFit, "bought_city");
  assert.ok(ranked[0].rankReasons.includes("bought in this city"));
  assert.deepEqual(pickDealBuyers(ranked).map((i) => i.contactId), ["kent-loan"]);
});

test("a VIP whose saved buy box tops out under the price isn't sent it", () => {
  const ranked = rankAll([
    bare({ contactId: "under-200k", tier: "vip", buybox: { areas: ["Kent"], priceMax: 200000 } }),
    bare({ contactId: "condo-only", tier: "vip", buybox: { areas: ["Kent"], propertyTypes: ["condo"] } }),
    bare({ contactId: "fits", tier: "cold", buybox: { areas: ["Kent"], priceMax: 350000 } }),
  ], kent);
  assert.equal(ranked[0].rankParts.priceOut, true);
  assert.deepEqual(pickDealBuyers(ranked).map((i) => i.contactId), ["fits"]);
});
