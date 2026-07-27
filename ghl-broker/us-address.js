// us-address.js — normalize a free-text US address to USPS-style abbreviations.
// RealEstateAPI's parser is unreliable with fully spelled-out forms ("166th
// Avenue Northeast, Redmond, Washington") — the same property resolves fine as
// "166th Ave NE, Redmond, WA". GHL contact fields and the address autocomplete
// both produce the spelled-out form, so the broker normalizes before querying.
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

export function normalizeUsAddress(raw) {
  const parts = String(raw || "").split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return String(raw || "").trim();

  parts[0] = parts[0].replace(/[A-Za-z]+/g, (w) => {
    const k = w.toLowerCase();
    return DIRECTIONALS[k] || SUFFIXES[k] || w;
  });

  for (let i = 1; i < parts.length; i++) {
    const m = parts[i].match(STATE_SEGMENT);
    if (m) parts[i] = STATES[m[1].toLowerCase()] + (m[2] || "");
  }

  return parts.join(", ");
}
