// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// us-address.js — US address normalization shared by the broker (RealEstateAPI
// + MLS queries) and the frontend (Zillow deep links).
//
// RealEstateAPI's address matcher is inconsistent about spelled-out vs USPS
// forms — the SAME property has resolved as "166th Ave NE, Redmond, WA" one
// day and only as "166th Avenue NE, Redmond, WA" the next, while the GHL
// fields/autocomplete always produce the fully spelled-out form ("166th Avenue
// Northeast, Redmond, Washington"). So instead of betting on one canonical
// form, addressQueryVariants() yields an ordered ladder of formats for callers
// to try until one resolves. Zillow's /homes/<slug>_rb/ URLs likewise resolve
// reliably only with USPS abbreviations — spelled-out slugs fall back to a
// metro-area search page.
//
// Conservative by design: directionals and street suffixes are abbreviated in
// the STREET segment only (never city names like "North Bend"), and the state
// is abbreviated only when a comma segment is exactly a state name + optional
// ZIP.

const DIRECTIONALS = {
  northeast: "NE", northwest: "NW", southeast: "SE", southwest: "SW",
  north: "N", south: "S", east: "E", west: "W",
};

const SUFFIXES = {
  avenue: "Ave", boulevard: "Blvd", circle: "Cir", court: "Ct", drive: "Dr",
  expressway: "Expy", highway: "Hwy", lane: "Ln", parkway: "Pkwy", place: "Pl",
  road: "Rd", square: "Sq", street: "St", terrace: "Ter", trail: "Trl",
};

const STATES = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY",
};

const STATE_SEGMENT = new RegExp(
  `^(${Object.keys(STATES).join("|")})(\\s+\\d{5}(-\\d{4})?)?$`, "i"
);

// words: which word classes to abbreviate in the street segment.
function transform(raw, { suffixes }) {
  const parts = String(raw || "").split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return String(raw || "").trim();

  parts[0] = parts[0].replace(/[A-Za-z]+/g, (w) => {
    const k = w.toLowerCase();
    return DIRECTIONALS[k] || (suffixes ? SUFFIXES[k] : null) || w;
  });

  for (let i = 1; i < parts.length; i++) {
    const m = parts[i].match(STATE_SEGMENT);
    if (m) parts[i] = STATES[m[1].toLowerCase()] + (m[2] || "");
  }

  return parts.join(", ");
}

// Full USPS normalization: directionals + street suffixes + state.
export function normalizeUsAddress(raw) {
  return transform(raw, { suffixes: true });
}

// Comparison key for "is this the same property?" — USPS-normalized, then
// stripped of case, punctuation and spacing. Used to bind comps captured from
// Zillow to the offer they were captured for, where the two addresses come
// from different sources ("741 N 128th St, Seattle, WA 98133" typed into the
// offer vs "741 North 128th Street, Seattle, WA 98133" off a listing).
export function addressKey(raw) {
  return normalizeUsAddress(raw).toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Ordered, de-duplicated ladder of address formats to try against picky
// address matchers. Callers query each until one returns data.
export function addressQueryVariants(raw) {
  const trimmed = String(raw || "").trim();
  const variants = [
    transform(trimmed, { suffixes: true }),  // "7525 166th Ave NE, Redmond, WA 98052"
    transform(trimmed, { suffixes: false }), // "7525 166th Avenue NE, Redmond, WA 98052"
    trimmed,                                 // exactly as typed
  ];
  return [...new Set(variants.filter(Boolean))];
}

// Zillow deep link from a street address — /homes/<slug>_rb/ redirects to the
// property page when the address resolves. USPS-abbreviated slugs resolve;
// spelled-out ones often dump to a metro search page instead.
export function zillowUrl(address) {
  const slug = normalizeUsAddress(address).replace(/[,#.]/g, "").replace(/\s+/g, "-");
  return slug ? `https://www.zillow.com/homes/${encodeURIComponent(slug)}_rb/` : "";
}
