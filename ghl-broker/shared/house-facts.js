// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// house-facts.js — what the listing itself says about the house, read the way
// a buyer reads it. Pure, no I/O.
//
// Buyers found these before we priced them (2026-10-02 read of every buyer
// thread): Ravenna's remarks said "low ceilings" in the basement and three
// buyers passed on the basement; Edmonds' photos showed the roof, the water
// damage and the siding while the pitch said "not a gut job"; 7034 S K St had
// an ADU with no permit and a driveway easement title flagged at closing. The
// words were in the listing. This turns them into signals the rehab and ARV
// checks can act on and the package can disclose.
//
// Each detector is a phrase list, not a model call: cheap, testable, and
// wrong in ways a person can read. A miss costs a signal; a false hit costs a
// visible, removable line — so the lists lean specific.

const has = (re, t) => re.test(t);
const words = (t) => String(t || "").replace(/\s+/g, " ").toLowerCase();

// Distress: the listing is selling a project. Turnkey wins over any of these
// ("fully remodeled… bring your own furniture" isn't a fixer).
const DISTRESS_RE = /\bas[- ]is\b|\btlc\b|fixer|contractor special|investor special|handyman|needs (some |a lot of |lots of )?(work|updating|updates|love|repairs?)|bring your (tools|contractor|vision|ideas)|sweat equity|cash (buyers? )?only|cash or rehab loan|won'?t qualify for (conventional|fha|va)|rehab loan|estate sale|probate|being sold in (its )?current condition|tear ?down|value is in the land/;
const TURNKEY_RE = /turn[- ]?key|fully (remodeled|renovated|updated)|completely (remodeled|renovated|updated)|move[- ]in ready|newly (remodeled|renovated)|down to the studs.*(new|remodel)|new everything/;

// Specific defects named in the remarks, each with the scope line that prices it.
const DEFECTS = [
  { key: "water_damage", re: /water damage|water intrusion|leak(s|ed|ing)? (in|into|through|from)|moisture (issues?|damage)|flood(ed|ing)? (basement|damage)/, label: "water damage" },
  { key: "mold", re: /\bmold\b|mildew/, label: "mold" },
  { key: "fire", re: /fire damage|smoke damage|(prior|previous|past) fire|fire[- ]damaged/, label: "fire damage" },
  { key: "foundation", re: /foundation (issues?|problems?|repair|work|damage|crack)|settl(ing|ement)|structural (issues?|repairs?|damage)/, label: "foundation / structure" },
  { key: "roof", re: /roof (is |needs? |at |near |past |the ){0,3}(end of (its )?life|replac|leak|issues?|repair)|needs? (a )?new roof|old roof/, label: "the roof" },
  { key: "sewer", re: /side sewer|sewer (line|scope)( needs?| issues?| repair)?|failed sewer/, label: "the sewer line" },
];

// Layout and size facts a resale buyer prices.
const LAYOUT = [
  { key: "low_ceiling", re: /low (basement )?ceilings?|ceiling height|short basement|basement (is )?(low|short)|head ?room/, label: "low ceilings" },
  { key: "converted_rooms", re: /converted (into|to) (multiple |extra )?(rooms|bedrooms|units)|rooming house|room(s)? rented (separately|individually)|student (housing|rental)|rent[- ]by[- ](the[- ])?room/, label: "carved into rooms" },
  { key: "tuck_under", re: /tuck[- ]?under (garage|parking)/, label: "tuck-under garage" },
  { key: "no_garage", re: /\bno garage\b|without (a )?garage/, label: "no garage" },
];

// Title, permits and utilities — disclosed, never priced.
const LEGAL = [
  { key: "easement", re: /easement/, label: "an easement" },
  { key: "right_of_way", re: /right[- ]of[- ]way/, label: "a right-of-way" },
  { key: "unpermitted", re: /unpermitted|un-permitted|not permitted|without (a )?permits?|no permits?|permits? (were|was) never|non[- ]?conforming/, label: "unpermitted work" },
  { key: "septic", re: /septic|drain ?field/, label: "septic" },
  { key: "hoa", re: /\bhoa\b|homeowners'? association/, label: "an HOA" },
  { key: "land_lease", re: /land lease|leased land|lot rent|space rent|park rules|55\s?\+|55 and (over|older)/, label: "leased land / park rules" },
  { key: "zoning", re: /zoned? (for |as )?(commercial|multi|mixed)|nr-?[23]\b|lr-?[123]\b|rezon/, label: "zoning" },
];

// Work the listing says is already done — a buyer won't budget it again.
const UPDATED = {
  electrical: /new (electrical|panel|wiring)|updated (electrical|panel|wiring)|rewired|re-wired|200 ?amp|electrical (was |has been )?(updated|upgraded|replaced)/,
  plumbing: /new plumbing|updated plumbing|re-?piped|repipe|pex (plumbing|throughout)|plumbing (was |has been )?(updated|upgraded|replaced)/,
  roof: /new roof|roof (is )?(new|newer|\d{1,2} (years? old|yrs?))|roof (was |has been )?replaced( in \d{4})?|(20[12]\d) roof/,
};

// Contents left behind — the cleanout buyers price (3511 NE 153rd: "a
// hoarder house"; 7034 S K St: "I hate to just demolish and throw away all
// of their family stuff").
const CONTENTS_RE = /hoard|full of (stuff|belongings|items)|contents (included|remain|to be left|conveyed)|personal property (remains|left|conveys)|clean[- ]?out|junk removal|left as is with (all )?(contents|belongings)|estate contents/;

/**
 * remarkSignals(text) → {
 *   distressed, turnkey, contents,
 *   defects: [{ key, label }], layout: [{ key, label }], legal: [{ key, label }],
 *   updated: { electrical, plumbing, roof },
 * }
 */
export function remarkSignals(text = "") {
  const t = words(text);
  const pick = (list) => list.filter((d) => has(d.re, t)).map(({ key, label }) => ({ key, label }));
  const turnkey = has(TURNKEY_RE, t);
  return {
    distressed: !turnkey && has(DISTRESS_RE, t),
    turnkey,
    contents: has(CONTENTS_RE, t),
    defects: pick(DEFECTS),
    layout: pick(LAYOUT),
    legal: pick(LEGAL),
    updated: Object.fromEntries(Object.entries(UPDATED).map(([k, re]) => [k, has(re, t)])),
  };
}

/**
 * normalizeHouse(h) → the house facts a check reads, every key present.
 *
 * `h` is whatever the broker's Zillow detail parse produced (houseFacts in
 * rehab-scan.js) — tolerant of a missing object and of strings for numbers.
 * Unknown is null, never a guess: "no garage" must mean the record said so.
 */
export function normalizeHouse(h = {}) {
  const n = (v) => { const x = Number(String(v ?? "").replace(/[^\d.-]/g, "")); return Number.isFinite(x) && x > 0 ? x : null; };
  const b = (v) => (v === true || v === false ? v : null);
  const s = h && typeof h === "object" ? h : {};
  return {
    aboveGradeSqft: n(s.aboveGradeSqft),
    belowGradeSqft: n(s.belowGradeSqft),
    basement: s.basement ? String(s.basement) : null,
    garageSpaces: s.garageSpaces === 0 ? 0 : n(s.garageSpaces),
    hasGarage: b(s.hasGarage),
    sewer: s.sewer === "public" || s.sewer === "septic" ? s.sewer : null,
    water: s.water ? String(s.water) : null,
    hoa: b(s.hoa),
    daysOnMarket: s.daysOnMarket === 0 ? 0 : n(s.daysOnMarket),
    priceCuts: Number.isInteger(s.priceCuts) ? s.priceCuts : null,
    listedAt: n(s.listedAt),
    status: s.status ? String(s.status) : null,
  };
}

// Garage, from the facts: true / false when the record says, null when it
// doesn't. A garage count of zero is a "no".
export function garageOf(house = {}) {
  const h = normalizeHouse(house);
  if (h.hasGarage != null) return h.hasGarage;
  if (h.garageSpaces != null) return h.garageSpaces > 0;
  return null;
}
