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

import { WA_CITY_COORDS } from "./wa-city-coords.js";

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

// Region words people type in a buy box ("South King", "King County",
// "Kitsap") → the region keys they mean. "King" alone spans four.
const REGION_ALIASES = {
  king: ["seattle", "north-king", "eastside", "south-king"], "king-county": ["seattle", "north-king", "eastside", "south-king"],
  "south-king-county": ["south-king"], "south-end": ["south-king"], "south-seattle": ["south-king", "seattle"],
  "north-king-county": ["north-king"], "north-end": ["north-king"], "east-side": ["eastside"], "the-eastside": ["eastside"], "east-king": ["eastside"],
  "pierce-county": ["pierce"], "snohomish-county": ["snohomish"], "snoco": ["snohomish"],
  kitsap: ["kitsap-mason"], "kitsap-county": ["kitsap-mason"], mason: ["kitsap-mason"], "mason-county": ["kitsap-mason"],
  "thurston-county": ["thurston"], olympia: ["thurston"],
};

/**
 * regionsForArea(area) → [region key] — the regions a buy-box area names, or
 * [] when it's a city (or unknown). 2026-09-29: waves used to read buy-box
 * areas as city names only, so "South King" never matched a Kent deal.
 */
export function regionsForArea(area) {
  const s = slug(area);
  if (!s) return [];
  if (REGIONS[s] && s !== "other-wa") return [s];
  return REGION_ALIASES[s] || [];
}

/** regionFor(city, state) → region key | null (out of state) */
export function regionFor(city, state = "WA") {
  if (String(state || "WA").trim().toUpperCase() !== "WA") return null;
  const s = citySlug(city);
  if (!s) return null;
  return CITY_TO_REGION.get(s) || "other-wa";
}

/* ---------- where a buyer said they buy, read the way they wrote it ---------- */

// 2026-11-09: 26 deals since 10/21 went to buyers whose own buy box ruled
// them out. A box saying "West Seattle" got a Green Lake deal (a Seattle
// city tag sent it); "North Seattle", "Seattle area" and "Shoreline/North
// Seattle" never matched a Seattle 98133 deal, because the match compared the
// whole phrase to a city name. `areaVerdict` is the one reader both matchers
// use (shared/buyer-score.js rankForDeal, shared/buybox.js matchBuybox).
//
// A phrase resolves to places: a ZIP, a Seattle neighbourhood (the city plus
// its ZIPs), a region, a city, or a state. One it can't place abstains, and
// so does a loose one ("Tacoma area") that misses: neither ever rules a deal
// out. "not X", "anything but X", "avoid X" rule X out.

// Seattle by the words buyers use, and the ZIPs each covers.
const NORTH_SEATTLE = ["98103", "98105", "98107", "98115", "98117", "98125", "98133", "98177"];
const WEST_SEATTLE = ["98106", "98116", "98126", "98136", "98146"];
const SOUTH_SEATTLE = ["98108", "98118", "98144", "98178", "98134"];
const SEATTLE_HOODS = {
  "north-seattle": NORTH_SEATTLE, "n-seattle": NORTH_SEATTLE, "north-of-the-ship-canal": NORTH_SEATTLE,
  "northwest-seattle": ["98107", "98117", "98177"], "nw-seattle": ["98107", "98117", "98177"],
  "northeast-seattle": ["98105", "98115", "98125"], "ne-seattle": ["98105", "98115", "98125"],
  "west-seattle": WEST_SEATTLE, "w-seattle": WEST_SEATTLE,
  "south-seattle": SOUTH_SEATTLE, "s-seattle": SOUTH_SEATTLE, "southeast-seattle": SOUTH_SEATTLE, "se-seattle": SOUTH_SEATTLE,
  "central-seattle": ["98102", "98112", "98122", "98144"], "central-district": ["98122", "98144"],
  "downtown-seattle": ["98101", "98104", "98121"], belltown: ["98121"],
  "capitol-hill": ["98102", "98112", "98122"], "cap-hill": ["98102", "98112", "98122"], eastlake: ["98102"],
  "queen-anne": ["98109", "98119"], interbay: ["98119"], magnolia: ["98199"],
  ballard: ["98107", "98117"], "crown-hill": ["98117"], "loyal-heights": ["98117"], broadview: ["98177"],
  fremont: ["98103"], wallingford: ["98103"], "green-lake": ["98103", "98115"], greenlake: ["98103", "98115"],
  greenwood: ["98103", "98117"], phinney: ["98103"], "phinney-ridge": ["98103"],
  "university-district": ["98105"], "u-district": ["98105"], laurelhurst: ["98105"],
  ravenna: ["98115"], wedgwood: ["98115"], wedgewood: ["98115"], "maple-leaf": ["98115"], "view-ridge": ["98115"],
  "lake-city": ["98125"], northgate: ["98125"], "bitter-lake": ["98133"], "haller-lake": ["98133"],
  "beacon-hill": ["98108", "98144"], "columbia-city": ["98118"], "rainier-valley": ["98118"], "seward-park": ["98118"],
  "rainier-beach": ["98178"], georgetown: ["98108"], "south-park": ["98108"], "mount-baker": ["98144"], "mt-baker": ["98144"],
  delridge: ["98106", "98126"], "highland-park": ["98106"], alki: ["98116"], admiral: ["98116"], fauntleroy: ["98136"],
  "madison-park": ["98112"], montlake: ["98112"], madrona: ["98122"], leschi: ["98122", "98144"],
};
// "South Seattle" has always also meant the south end of the county (the
// region alias it had before): a Kent deal still fits it.
const HOOD_ALSO_REGIONS = { "south-seattle": ["south-king"], "s-seattle": ["south-king"] };

// Words that say nothing about where: "Seattle area", "Greater Tacoma",
// "Pierce County", "West Seattle only".
const STRIP_RX = /\b(?:the|greater|metro(?:politan)?|areas?|count(?:y|ies)|proper|only|city\s+limits|city\s+of|limits|mostly|mainly|primarily|ideally|preferably|prefer(?:red)?|neighbou?rhoods?|and\s+surrounding|surrounding|region)\b/g;
// Words that make a city loose: "Tacoma area" fits a Tacoma deal, and says
// nothing either way about Puyallup.
const LOOSE_RX = /\b(?:greater|metro(?:politan)?|areas?|surrounding)\b/;
const DIRECTION_RX = /^(?:north|south|east|west|n|s|e|w|ne|nw|se|sw|northeast|northwest|southeast|southwest|central|upper|lower|downtown)\s+(.+)$/;
const NEGATION_RX = /^(?:not\s+(?:a\s+)?fan\s+of|not\s+interested\s+in|no\s+interest\s+in|anything\s+but|anywhere\s+but|everywhere\s+but|except(?:\s+for)?|excluding|exclude|avoid(?:ing)?|stay(?:ing)?\s+(?:out\s+of|away\s+from)|nothing\s+in|not\s+in|won'?t\s+(?:do|buy)|don'?t\s+(?:do|buy|want)|do\s+not\s+(?:do|buy|want)|never|not|no)\s+(?:a\s+|an\s+|the\s+)?(.+)$/i;
// Full state names, so "Bend Oregon" and "Central Oregon" are places.
const STATE_NAMES = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY",
  louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
  "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA",
  "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};
const STATE_ABBRS = new Set(Object.values(STATE_NAMES));
const KNOWN_WA_CITIES = new Set([...CITY_TO_REGION.keys(), ...Object.keys(WA_CITY_COORDS)]);

// The state a phrase ends in: a full name in any case, or two capitals
// ("Bend OR"); never a lower-case "or" or "in".
function stateTail(original) {
  const words = String(original || "").trim().split(/\s+/).filter(Boolean);
  for (const take of [2, 1]) {
    if (words.length < take) continue;
    const tail = words.slice(-take).join(" ").replace(/[.,]+$/, "");
    const byName = STATE_NAMES[tail.toLowerCase()];
    if (byName) return { state: byName, rest: words.slice(0, -take).join(" ") };
    if (take === 1 && /^[A-Z]{2}$/.test(tail) && STATE_ABBRS.has(tail)) return { state: tail, rest: words.slice(0, -1).join(" ") };
  }
  return null;
}

const isStateOnly = (clause) => {
  const t = stateTail(clause);
  return Boolean(t && !t.rest.trim());
};

// One place word ("North Seattle", "Bend OR", "98133") → a place, or null.
function placeOf(raw) {
  const original = String(raw || "").trim();
  if (!original) return null;
  const zips = original.match(/\b\d{5}\b/g);
  if (zips) return zips.map((zip) => ({ kind: "zip", zip }));
  const st = stateTail(original);
  const lower = (st ? st.rest : original).toLowerCase().replace(/[^a-z0-9\s'-]+/g, " ").replace(/\s+/g, " ").trim();
  const loose = LOOSE_RX.test(lower);
  const core = lower.replace(STRIP_RX, " ").replace(/\s+/g, " ").trim();
  // Out of state: we don't keep their cities, so any word before the state
  // is their city there ("Bend OR"), and a direction or "anywhere in" is the
  // whole state. Neither ever holds a Washington deal.
  if (st && st.state !== "WA") {
    if (!core || /^(?:north|south|east|west|central|eastern|western|northern|southern|anywhere|all|everywhere|in|around)\b/.test(core)) return [{ kind: "state", state: st.state }];
    return [{ kind: "city", city: citySlug(core), state: st.state }];
  }
  if (!core) return null;
  const s = citySlug(core);
  if (SEATTLE_HOODS[s]) {
    return [{ kind: "neighborhood", city: "seattle", zips: SEATTLE_HOODS[s] }, ...(HOOD_ALSO_REGIONS[s] ? [{ kind: "region", regions: HOOD_ALSO_REGIONS[s] }] : [])];
  }
  const byWord = (w) => {
    const ws = citySlug(w);
    if (!ws) return null;
    // A one-city region (Seattle) is that city.
    if (REGIONS[ws] && ws !== "other-wa" && !(REGIONS[ws].cities.length === 1 && citySlug(REGIONS[ws].cities[0]) === ws)) return [{ kind: "region", regions: [ws] }];
    if (REGION_ALIASES[ws]) return [{ kind: "region", regions: REGION_ALIASES[ws] }];
    // Only a Washington city we know: "Western WA" or "anywhere in WA" is not one.
    if (KNOWN_WA_CITIES.has(ws)) return [{ kind: "city", city: ws, state: "WA", ...(loose ? { loose: true } : {}) }];
    return null;
  };
  // The phrase as typed first ("king-county" is an alias), then without the
  // filler, then without a direction ("North Tacoma" is Tacoma).
  const hit = REGION_ALIASES[citySlug(lower)] ? [{ kind: "region", regions: REGION_ALIASES[citySlug(lower)] }] : byWord(core);
  if (hit) return hit;
  const dir = DIRECTION_RX.exec(core);
  const byDir = dir ? byWord(dir[1]) : null;
  if (byDir) return byDir;
  // A town we don't keep is still its own name: it fits a deal there, as it
  // always did, and says nothing about anywhere else.
  return [{ kind: "city", city: s, guess: true }];
}

/**
 * readArea(phrase) → { neg, places, unresolved, label } | null
 *
 * One clause of a buy box's areas. Several places ("Shoreline/North
 * Seattle", "Eastside & South King", "Tacoma and Puyallup") are one clause;
 * `unresolved` counts the parts it couldn't place.
 */
export function readArea(phrase) {
  const label = String(phrase || "").replace(/\s+/g, " ").trim();
  if (!label) return null;
  const n = NEGATION_RX.exec(label);
  const body = (n ? n[1] : label).replace(/\s+fan$/i, "").trim();
  const parts = body.split(/\s*[/&+]\s*|\s+and\s+|\s+or\s+/).map((p) => p.trim()).filter(Boolean);
  const places = [];
  let unresolved = 0;
  for (const p of parts) {
    const got = placeOf(p);
    if (got) places.push(...got);
    else unresolved++;
  }
  return { neg: Boolean(n), places, unresolved, label };
}

// Does one place hold the deal? true | false | null (can't tell).
function placeFits(p, deal) {
  const city = deal?.city || "";
  if (!city && !deal?.zip) return null;
  const state = String(deal?.state || "WA").toUpperCase();
  const wa = state === "WA";
  let fit;
  switch (p.kind) {
    case "zip": fit = deal.zip ? deal.zip === p.zip : null; break;
    case "neighborhood": fit = !city ? null : city !== "seattle" || !wa ? false : deal.zip ? p.zips.includes(deal.zip) : null; break;
    case "region": fit = !city ? null : !wa ? false : p.regions.includes(deal.region || regionFor(city, state)); break;
    case "city": fit = !city ? null : city === p.city && (!deal.state || !p.state || p.state === state); break;
    case "state": fit = p.state === state; break;
    default: fit = null;
  }
  return fit === false && (p.loose || p.guess) ? null : fit;
}

// The kind of fit that says the most: a ZIP over a neighbourhood over a city.
const FIT_ORDER = ["zip", "neighborhood", "city", "region", "state"];

/** areaMatches(area, deal) → true | false | null — one phrase against a deal ({ city slug, zip, region, state }). */
export function areaMatches(area, deal = {}) {
  const r = readArea(area);
  if (!r || !r.places.length) return null;
  const fits = r.places.map((p) => placeFits(p, deal));
  const v = fits.includes(true) ? true : !r.unresolved && fits.every((f) => f === false) ? false : null;
  if (r.neg) return v === true ? false : null;
  return v;
}

// A buy box's areas as clauses: commas, semicolons, new lines and
// brackets separate; "Seattle but not West Seattle" is two; a bare state
// after a comma belongs to the place before it ("Bend, OR").
export function areaClauses(areas) {
  const text = Array.isArray(areas) ? areas.map((a) => String(a ?? "")).join(", ") : String(areas ?? "");
  const out = [];
  for (const raw of text.split(/[,;\n|()]+|\s+but\s+(?=(?:not|no)\b)/i)) {
    const c = raw.trim();
    if (!c) continue;
    if (out.length && isStateOnly(c)) out[out.length - 1] = `${out[out.length - 1]} ${c}`;
    else out.push(c);
  }
  return out;
}

/**
 * areaVerdict(areas, deal) → { fit, refused, elsewhere, stated, elsewhereLabels }
 *
 *   fit        { kind, label } — a place they named holds the deal
 *   refused    the phrase that rules it out ("not Seattle"), or null
 *   elsewhere  every place they named resolved, and none holds the deal
 *   stated     how many places they named (refusals not counted)
 *
 * `areas` is the buy box's raw areas text or its list.
 */
export function areaVerdict(areas, deal = {}) {
  let fit = null, refused = null, stated = 0, unsure = 0;
  const elsewhereLabels = [];
  for (const clause of areaClauses(areas)) {
    const r = readArea(clause);
    if (!r) continue;
    const fits = r.places.map((p) => placeFits(p, deal));
    if (r.neg) { if (!refused && fits.includes(true)) refused = r.label; continue; }
    stated++;
    if (fits.includes(true)) {
      const kind = FIT_ORDER.find((k) => r.places.some((p, i) => p.kind === k && fits[i] === true));
      if (!fit || FIT_ORDER.indexOf(kind) < FIT_ORDER.indexOf(fit.kind)) fit = { kind, label: r.label };
    } else if (!r.places.length || r.unresolved || fits.some((f) => f === null)) unsure++;
    else elsewhereLabels.push(r.label);
  }
  return { fit, refused, elsewhere: !fit && stated > 0 && unsure === 0, stated, elsewhereLabels };
}

export const STRATEGIES = {
  flip: "Flip",
  "new-construction": "New construction",
  rental: "Rental",
  // Never inferred from a loan — set by hand or on import (mobile and
  // manufactured home buyers found in investor groups).
  "mobile-home": "Mobile / manufactured",
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
    // Builders found off permits (1538 NW 61st St, 2026-10-20) carry these,
    // not a type tag: they build.
    else if (t === "builder" || t === "dispo-source-permits") out.types.push("new-construction");
  }
  out.types = [...new Set(out.types)];
  return out;
}

/** "lake-forest-park" → "Lake Forest Park" */
export const cityLabel = (s) => String(s || "").split("-").map((w) => w === "seatac" ? "SeaTac" : w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
