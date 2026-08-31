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

// "Washington" / "wa" / "WA." → "WA"; anything that isn't a state → "".
// Deliberately strict: this decides whether a geocoder's answer is allowed to
// count, and a loose match there sends a comp search to the wrong state.
export function stateAbbr(raw) {
  const s = String(raw || "").trim().replace(/\.$/, "");
  if (!s) return "";
  const byName = STATES[s.toLowerCase()] || (/^district of columbia$/i.test(s) ? "DC" : "");
  if (byName) return byName;
  const up = s.toUpperCase();
  return ABBREVIATIONS.has(up) ? up : "";
}

const ABBREVIATIONS = new Set([...Object.values(STATES), "DC"]);

// A secondary unit is a fact about the mailbox, not about the parcel, and most
// geocoders either ignore it or choke on it. Split it off so callers can try
// the address without it.
const UNIT_TAIL = /[\s,]+(?:#\s*[\w-]+|(?:apt|apartment|unit|ste|suite|bldg|building|lot|trlr|fl|floor|rm|room)\.?\s*#?\s*[\w-]+)$/i;

export function splitUnit(streetLine) {
  const s = String(streetLine || "").trim();
  const m = s.match(UNIT_TAIL);
  return m ? { street: s.slice(0, m.index).trim(), unit: m[0].trim().replace(/^[,\s]+/, "") } : { street: s, unit: "" };
}

/**
 * Pull apart a free-form US address into the pieces a picky geocoder's answer
 * can be CHECKED against: { houseNo, street, unit, city, state, zip }.
 *
 * Conservative on purpose — every field is optional, and a field we're not sure
 * about is better left empty than guessed. An empty field costs a validation
 * signal; a wrong one rejects the correct answer. The sharpest edge here is
 * "NE": Nebraska and a street directional share a spelling, so a state is only
 * read off a segment that cannot be the street line.
 */
export function parseUsAddress(raw) {
  const out = { houseNo: "", street: "", unit: "", city: "", state: "", zip: "" };
  const cleaned = String(raw || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[,\s]+(?:usa|u\.s\.a\.|u\.s\.|united states(?: of america)?)\.?$/i, "")
    .trim();
  const segs = cleaned.split(",").map((p) => p.trim()).filter(Boolean);
  if (!segs.length) return out;

  // ZIP, from the END only. A house number is five digits often enough
  // ("14808 Larch Way") that a free-floating \d{5} would eat it.
  const zip = segs[segs.length - 1].match(/(?:^|[\s,])(\d{5})(?:-\d{4})?$/);
  if (zip && segs.length > 1) {
    out.zip = zip[1];
    segs[segs.length - 1] = segs[segs.length - 1].slice(0, zip.index).trim();
    if (!segs[segs.length - 1]) segs.pop();
  }

  // State: its own segment ("…, WA"), or glued to the city ("…, Lynnwood WA").
  // Never off segment 0 — that is the street line, where "NE" is a direction.
  if (segs.length > 1) {
    const tail = segs[segs.length - 1];
    const whole = stateAbbr(tail);
    if (whole) {
      out.state = whole;
      segs.pop();
    } else {
      const words = tail.split(" ");
      for (const take of [2, 1]) {          // "New York" before "York"
        if (words.length <= take) continue;
        const abbr = stateAbbr(words.slice(-take).join(" "));
        if (abbr) {
          out.state = abbr;
          segs[segs.length - 1] = words.slice(0, -take).join(" ");
          break;
        }
      }
    }
  }

  if (segs.length > 1) out.city = segs[segs.length - 1];

  const { street, unit } = splitUnit(segs[0] || "");
  out.unit = unit;
  const house = street.match(/^(\d+[A-Za-z]?(?:-\d+)?)\s+(.+)$/);
  if (house) {
    out.houseNo = house[1];
    out.street = house[2];
  } else {
    out.street = street;
  }
  return out;
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
