// dispo-regions.js — where an investor buys and what kind of buying it is.
//
// Borrower lists (hard-money recordings) say which city every loan landed in
// and who lent it. That is enough to tag a buyer by market — so a Kirkland
// deal can go to Kirkland flippers — and by strategy, without anyone filling
// in a buy box.
//
// Tags carry `city-` / `region-` / `type-` inside the name on purpose. The
// feedback package treats any `dispo-<city>` tag as a BLAST tag for a deal in
// that city (routes/offers.js blastTagsFor); a bare `dispo-kirkland` would
// claim every Kirkland buyer was pitched the Kirkland deal.
//
// Pure. Shared by the retag script, the buyer import and the Dispositions page.

const slug = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export const REGIONS = {
  seattle: { label: "Seattle", cities: ["Seattle"] },
  "north-king": { label: "North King", cities: ["Shoreline", "Lake Forest Park", "Kenmore"] },
  eastside: {
    label: "Eastside",
    cities: ["Bellevue", "Kirkland", "Redmond", "Bothell", "Woodinville", "Mercer Island", "Sammamish", "Issaquah",
      "Newcastle", "Medina", "Clyde Hill", "Yarrow Point", "Hunts Point", "Duvall", "Carnation", "Fall City",
      "North Bend", "Snoqualmie", "Preston"],
  },
  "south-king": {
    label: "South King",
    cities: ["Renton", "Kent", "Federal Way", "Auburn", "Burien", "Des Moines", "Tukwila", "SeaTac", "Covington",
      "Maple Valley", "Normandy Park", "Enumclaw", "Black Diamond", "Algona", "Pacific", "Milton", "Vashon", "Ravensdale"],
  },
  snohomish: {
    label: "Snohomish",
    cities: ["Everett", "Lynnwood", "Edmonds", "Snohomish", "Marysville", "Lake Stevens", "Mountlake Terrace", "Mukilteo",
      "Mill Creek", "Brier", "Monroe", "Arlington", "Stanwood", "Granite Falls", "Sultan", "Gold Bar", "Darrington",
      "Tulalip", "Camano Island", "Woodway", "Index"],
  },
  pierce: {
    label: "Pierce",
    cities: ["Tacoma", "Puyallup", "Lakewood", "Spanaway", "Gig Harbor", "University Place", "Bonney Lake", "Graham",
      "Roy", "Edgewood", "Orting", "Buckley", "Lake Tapps", "Fife", "Fircrest", "Sumner", "Steilacoom", "DuPont",
      "Eatonville", "Ruston", "Lakebay", "Fox Island", "Longbranch", "Anderson Island", "Ashford", "Wilkeson", "Elbe", "Carbonado"],
  },
  "kitsap-mason": {
    label: "Kitsap & Mason",
    cities: ["Port Orchard", "Bremerton", "Kingston", "Poulsbo", "Silverdale", "Bainbridge Island", "Allyn", "Belfair", "Shelton"],
  },
  thurston: { label: "Thurston", cities: ["Olympia", "Lacey", "Tumwater", "Rochester", "Yelm", "Tenino"] },
  "other-wa": { label: "Other WA", cities: [] },
};

export const REGION_KEYS = Object.keys(REGIONS);

const CITY_TO_REGION = new Map();
for (const [key, r] of Object.entries(REGIONS)) for (const c of r.cities) CITY_TO_REGION.set(slug(c), key);

// "SEATAC" and "SEA TAC" both mean SeaTac.
const CITY_ALIASES = { seatac: "seatac", "sea-tac": "seatac", dupont: "dupont" };

export const citySlug = (city) => { const s = slug(city); return CITY_ALIASES[s] || s; };

/** regionFor(city, state) → region key | null (out of state) */
export function regionFor(city, state = "WA") {
  if (String(state || "WA").trim().toUpperCase() !== "WA") return null;
  const s = citySlug(city);
  if (!s) return null;
  return CITY_TO_REGION.get(s) || "other-wa";
}

export const STRATEGIES = {
  flip: "Flip",
  "new-construction": "New construction",
  rental: "Rental",
};

// Construction / development lenders. A loan from one of these is a build,
// not a cosmetic flip, whatever its size.
const CONSTRUCTION_LENDERS = /blueprint capital|ascent (developer|capital)|sound capital|builders capital|cre 8 capital|crescent debt|constructive capital|builder finance|builder circle/i;

const yearsBetween = (a, b) => {
  const ta = Date.parse(a || ""), tb = Date.parse(b || "");
  return Number.isFinite(ta) && Number.isFinite(tb) ? (tb - ta) / (365.25 * 86400000) : null;
};

/**
 * strategyFor({ lender, amount, maturity, recordedAt }) → "flip" | "new-construction" | "rental"
 *
 * A 30-year maturity is a DSCR / rental loan. A construction lender or a very
 * large loan is a build. Everything else on a hard-money list is a flip.
 */
export function strategyFor({ lender = "", amount = 0, maturity = "", recordedAt = "" } = {}) {
  const term = yearsBetween(recordedAt, maturity);
  if (term != null && term >= 10) return "rental";
  if (CONSTRUCTION_LENDERS.test(lender) || Number(amount) >= 2500000) return "new-construction";
  return "flip";
}

export const cityTag = (city) => `dispo-city-${citySlug(city)}`.slice(0, 60);
export const regionTag = (region) => `dispo-region-${region}`;
export const oosTag = (state) => `dispo-oos-${slug(state)}`;
export const typeTag = (strategy) => `dispo-type-${strategy}`;

/**
 * tagsForPurchases([{ city, state, lender, amount, maturity, recordedAt }]) → { tags, cities, regions, types, states }
 *
 * Every city an investor bought in, not just the latest — someone who flipped
 * in Kirkland and Tacoma belongs in both blasts.
 */
export function tagsForPurchases(purchases = []) {
  const cities = new Set(), regions = new Set(), types = new Set(), states = new Set();
  for (const p of purchases) {
    const state = String(p.state || "").trim().toUpperCase();
    if (p.city && (!state || state === "WA")) {
      cities.add(citySlug(p.city));
      regions.add(regionFor(p.city, "WA"));
    } else if (state && state !== "WA") {
      states.add(state);
    }
    if (p.city || p.address) types.add(strategyFor(p));
  }
  const tags = [
    ...[...cities].map((c) => `dispo-city-${c}`),
    ...[...regions].map(regionTag),
    ...[...states].map(oosTag),
    ...[...types].map(typeTag),
  ];
  return { tags, cities: [...cities], regions: [...regions], types: [...types], states: [...states] };
}

/** marketsFromTags(tags) → { cities, regions, types, states } — read back off a synced contact. */
export function marketsFromTags(tags = []) {
  const out = { cities: [], regions: [], types: [], states: [] };
  for (const raw of tags || []) {
    const t = String(raw || "").toLowerCase();
    let m;
    if ((m = t.match(/^dispo-city-(.+)$/))) out.cities.push(m[1]);
    else if ((m = t.match(/^dispo-region-(.+)$/)) && REGIONS[m[1]]) out.regions.push(m[1]);
    else if ((m = t.match(/^dispo-type-(.+)$/)) && STRATEGIES[m[1]]) out.types.push(m[1]);
    else if ((m = t.match(/^dispo-oos-(.+)$/))) out.states.push(m[1].toUpperCase());
  }
  return out;
}

/** "lake-forest-park" → "Lake Forest Park" */
export const cityLabel = (s) => String(s || "").split("-").map((w) => w === "seatac" ? "SeaTac" : w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
