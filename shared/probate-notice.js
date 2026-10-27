// probate-notice.js — read a Washington probate Notice to Creditors.
//
// Every personal representative publishes one (RCW 11.40.020) once a week
// for three weeks in the county's legal newspaper, in the statutory form:
// the cause number, the court, "In the Matter of the Estate of …", the
// personal representative, the attorney for the personal representative,
// the address for mailing or service, the date of first publication. The
// attorney is who we want: a gatekeeper who sees estates with a house
// before anyone lists them, the way a listing agent does (Matt, 2026-10-26).
//
// Newspapers flatten the form differently (one line, one label per line,
// labels in capitals), so this reads by the labels, not by line position.
// Pure: text in, fields out. Nothing here is logged; the names it returns are
// a decedent's and a family member's and stay on the record they belong to.

// 25-4-01234-1 SEA (King), 25-4-01234-31 (Snohomish), 25-4-01234-6 (Pierce).
// The 4 is the probate case type.
const CASE_RX = /\b(\d{2})-4-(\d{5})-(\d{1,2})(?:\s*(SEA|KNT))?\b/i;

const COUNTIES = ["Adams", "Asotin", "Benton", "Chelan", "Clallam", "Clark", "Columbia", "Cowlitz", "Douglas", "Ferry", "Franklin",
  "Garfield", "Grant", "Grays Harbor", "Island", "Jefferson", "King", "Kitsap", "Kittitas", "Klickitat", "Lewis", "Lincoln", "Mason",
  "Okanogan", "Pacific", "Pend Oreille", "Pierce", "San Juan", "Skagit", "Skamania", "Snohomish", "Spokane", "Stevens", "Thurston",
  "Wahkiakum", "Walla Walla", "Whatcom", "Whitman", "Yakima"];
const COUNTY_ALT = COUNTIES.map((c) => c.replace(/ /g, "\\s+")).join("|");

// The form's labels, longest first so "Attorney for the Personal
// Representative:" is never read as "Personal Representative:".
const LABELS = [
  ["filed", /Date\s+of\s+Filing(?:\s+(?:a\s+)?Copy)?(?:\s+of)?\s+(?:the\s+)?Notice\s+to\s+Creditors(?:\s+with\s+(?:the\s+)?Clerk(?:\s+of\s+(?:the\s+)?Court)?)?\s*:/gi],
  ["published", /Date\s+of\s+(?:First\s+)?Publication\s*:/gi],
  ["attorney", /(?:Attorneys?\s+for\s+(?:the\s+)?(?:Personal\s+Representatives?|Co-Personal\s+Representatives?|Petitioners?|Notice\s+Agent|Estate)|Personal\s+Representatives?['’]s?\s+Attorneys?)\s*:/gi],
  ["address", /Address(?:es)?\s+for\s+Mailing\s+(?:or|and|\/)\s+Service\s*:/gi],
  ["court", /Court\s+of\s+(?:Probate\s+)?Proceedings?(?:\s+and\s+Cause\s+(?:No\.?|Number))?\s*:/gi],
  ["agent", /Notice\s+Agent\s*:/gi],
  ["pr", /(?:Co-)?Personal\s+Representatives?\s*:/gi],
];

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const trimPunct = (s) => clean(s).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, "");

/** Each label's value: the text after it up to the next label. */
function labelled(text) {
  const hits = [];
  for (const [key, rx] of LABELS) {
    rx.lastIndex = 0;
    for (let m; (m = rx.exec(text));) {
      const start = m.index;
      const end = start + m[0].length;
      // A longer label already covers this span ("Attorney for the Personal
      // Representative:" holds a "Personal Representative:").
      if (hits.some((h) => start < h.end && end > h.start)) continue;
      hits.push({ key, start, end });
    }
  }
  hits.sort((a, b) => a.start - b.start);
  const out = {};
  hits.forEach((h, i) => {
    const value = text.slice(h.end, i + 1 < hits.length ? hits[i + 1].start : text.length);
    if (!(h.key in out)) out[h.key] = value;
  });
  return out;
}

export function probateCaseNo(text) {
  const m = String(text || "").match(CASE_RX);
  if (!m) return "";
  return `${m[1]}-4-${m[2]}-${m[3]}${m[4] ? ` ${m[4].toUpperCase()}` : ""}`;
}

/** "King" from "Superior Court of Washington for King County", the court line or a SEA/KNT suffix. */
export function noticeCounty(text) {
  const t = clean(text);
  const rx = [
    new RegExp(`(?:Superior\\s+Court\\s+of\\s+(?:the\\s+State\\s+of\\s+)?Washington,?\\s+(?:in\\s+and\\s+)?for\\s+(?:the\\s+County\\s+of\\s+)?)(${COUNTY_ALT})\\b`, "i"),
    new RegExp(`\\b(${COUNTY_ALT})\\s+County\\s+Superior\\s+Court\\b`, "i"),
    new RegExp(`\\bSuperior\\s+Court[^.]{0,40}?\\b(${COUNTY_ALT})\\s+County\\b`, "i"),
  ];
  for (const r of rx) {
    const m = t.match(r);
    if (m) return COUNTIES.find((c) => c.toLowerCase() === m[1].replace(/\s+/g, " ").toLowerCase()) || "";
  }
  if (/\b\d{2}-4-\d{5}-\d{1,2}\s*(SEA|KNT)\b/i.test(t)) return "King";
  return "";
}

const PHONE_RX = /\(?\b(\d{3})\)?[\s.\-]*(\d{3})[\s.\-]+(\d{4})\b/;
const EMAIL_RX = /[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i;
const BAR_RX = /\bWSBA\s*(?:No\.?|Number|#)?\s*#?\s*(\d{3,6})\b/i;
const FIRM_RX = /\b(?:Law|PLLC|P\.L\.L\.C\.|LLP|L\.L\.P\.|LLC|P\.S\.|PS|Inc\.?|Group|Office|Offices|Attorneys|Associates|Legal|Firm|Counsel|Chartered)\b|&/i;
// A person's name never carries an entity ending ("Counsel" and "Law" are surnames too).
const ENTITY_RX = /\b(?:PLLC|P\.L\.L\.C|LLP|LLC|P\.S|Inc|Law\s+(?:Office|Offices|Group|Firm)|Attorneys)\b|&/i;
// A street line, then "City, WA 98101". The city is the words before ", WA".
const ADDRESS_RX = /\b(\d{1,6}\s+[A-Z0-9][A-Za-z0-9.'\- ]*?(?:,?\s+(?:Suite|Ste\.?|#|Unit|Floor|Fl\.?)\s*[A-Za-z0-9\-]+)?),?\s+([A-Za-z.' ]+?),?\s+(?:WA|Washington|OR|Oregon|ID|Idaho|CA|California)\.?\s+(\d{5})(?:-\d{4})?\b/;
// P.O. boxes are mailing addresses too.
const PO_RX = /\b(P\.?\s*O\.?\s*Box\s+\d+),?\s+([A-Za-z.' ]+?),?\s+(?:WA|Washington)\.?\s+(\d{5})(?:-\d{4})?\b/i;

function phoneOf(s) {
  const m = String(s || "").match(PHONE_RX);
  return m ? `${m[1]}${m[2]}${m[3]}` : "";
}

function addressOf(s) {
  const t = clean(s);
  const m = t.match(ADDRESS_RX) || t.match(PO_RX);
  if (!m) return null;
  const street = clean(m[1]).replace(/,$/, "");
  const city = clean(m[2]).replace(/^.*\b(?:PLLC|LLP|LLC|P\.S\.|Inc\.?)\s+/i, "");
  return { street, city, state: "WA", zip: m[3], line: `${street}, ${city}, WA ${m[3]}`, index: t.indexOf(m[0]) };
}

/** A person's name from the start of a labelled value ("Jane Q. Doe, WSBA #123 …"). */
function nameAtStart(value) {
  let v = clean(value).replace(BAR_RX, "").replace(/\bc\/o\b.*$/i, "");
  // Stop at the first thing that isn't part of a name.
  v = v.split(/\s*(?:,|;|\(|\d|\bAddress\b|\bAttorneys?\b|\bc\/o\b|\bat\b)\s*/i)[0];
  v = trimPunct(v);
  if (!v || v.split(" ").length > 6 || ENTITY_RX.test(v)) return "";
  return v;
}

function titleCase(name) {
  if (!name || name !== name.toUpperCase()) return name;
  return name.toLowerCase().replace(/\b([a-z])([a-z']*)/g, (_, a, b) => a.toUpperCase() + b)
    .replace(/\bMc([a-z])/g, (_, c) => `Mc${c.toUpperCase()}`)
    .replace(/\b(Ii|Iii|Iv|Jr|Sr)\b/g, (s) => (/^I/.test(s) ? s.toUpperCase() : s));
}

function decedentOf(text) {
  const t = clean(text);
  const m = t.match(/\bEstate\s+of\s*:?\s+(.{2,80}?),?\s+(?:Deceased|Decedent)\b/i);
  return m ? titleCase(trimPunct(m[1]).replace(/^the\s+/i, "")) : "";
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** "October 15, 2025" / "Oct. 15, 2025" / "10/15/2025" → "2025-10-15". */
export function noticeDate(value) {
  const v = clean(value);
  let m = v.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (m) {
    const mi = MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().slice(0, 3)));
    if (mi >= 0) return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
  }
  m = v.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
  }
  return "";
}

/**
 * parseProbateNotice(text) → {
 *   caseNo, county, decedent, pr, nonprobate, proSe, firstPublished, filed,
 *   attorney: { name, barNo, firm, address: {street, city, state, zip, line}, phone, email } | null,
 * } | null (when the text isn't a notice to creditors)
 *
 * `proSe` is a personal representative with no attorney: there's no
 * gatekeeper on that estate, so the gatekeeper line leaves it alone.
 */
export function parseProbateNotice(text) {
  const raw = String(text || "");
  const t = clean(raw);
  if (!/notice\s+to\s+creditors/i.test(t)) return null;
  const caseNo = probateCaseNo(t);
  const nonprobate = /\bnon-?probate\s+notice\s+to\s+creditors\b/i.test(t);
  const fields = labelled(t);

  const prName = nameAtStart(fields.pr || fields.agent || "");
  const attorneyValue = fields.attorney || "";
  const attorneyName = nameAtStart(attorneyValue);
  // The firm, the address and the phone: the attorney's own value, then the
  // "address for mailing or service" block. The firm is what sits between
  // the attorney's name (and bar number) and the street.
  const block = clean(`${attorneyValue} ${fields.address || ""}`);
  const rest = clean(block.replace(attorneyName, " ").replace(BAR_RX, " "));
  const addr = addressOf(rest);
  let firm = trimPunct((addr ? rest.slice(0, addr.index) : rest).replace(/\bc\/o\b/gi, " "));
  if (!(FIRM_RX.test(firm) && firm.split(" ").length <= 8)) firm = "";
  const barNo = (attorneyValue.match(BAR_RX) || block.match(BAR_RX) || [])[1] || "";
  const phone = phoneOf(block);
  const email = (block.match(EMAIL_RX) || [""])[0].toLowerCase();

  const attorney = attorneyName || barNo || firm
    ? { name: titleCase(attorneyName), barNo, firm: trimPunct(firm), address: addr ? { street: addr.street, city: addr.city, state: addr.state, zip: addr.zip, line: addr.line } : null, phone, email }
    : null;

  return {
    caseNo,
    county: noticeCounty(fields.court || "") || noticeCounty(t),
    decedent: decedentOf(t),
    pr: titleCase(prName),
    nonprobate,
    proSe: !attorney,
    firstPublished: noticeDate(fields.published || ""),
    filed: noticeDate(fields.filed || ""),
    attorney,
  };
}

/**
 * splitNotices(text) → [string]
 *
 * A paste, a CSV cell or a daily alert email holds many notices. Each one
 * opens with its title ("PROBATE NOTICE TO CREDITORS", "NOTICE TO
 * CREDITORS", "NONPROBATE NOTICE TO CREDITORS") followed soon by a cause
 * number or an estate. The form's own "Date of Filing Copy of Notice to
 * Creditors" is not a title, and a title that repeats inside one notice's
 * first 300 characters (a header and a caption) stays with it.
 */
export function splitNotices(text) {
  const t = String(text || "");
  const rx = /(?:\b(?:NON-?PROBATE|PROBATE)\s+)?NOTICE\s+TO\s+CREDITORS\b/gi;
  const starts = [];
  for (let m; (m = rx.exec(t));) {
    if (/\b(?:of|the|this|a|said)\s+$/i.test(t.slice(Math.max(0, m.index - 12), m.index))) continue;
    if (!/\d{2}-4-\d{5}-\d|\bEstate\s+of\b/i.test(t.slice(m.index, m.index + 700))) continue;
    if (starts.length && m.index - starts[starts.length - 1] < 300) continue;
    starts.push(m.index);
  }
  if (!starts.length) return [];
  return starts.map((s, i) => t.slice(s, i + 1 < starts.length ? starts[i + 1] : t.length).trim()).filter(Boolean);
}

/** Every notice in a blob, parsed, one per cause number (the three weekly runs are one estate). */
export function parseNotices(text) {
  const out = [];
  const seen = new Set();
  for (const chunk of splitNotices(text)) {
    const n = parseProbateNotice(chunk);
    if (!n) continue;
    const key = n.caseNo ? `${n.county}|${n.caseNo}` : `${n.county}|${n.decedent}|${n.pr}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}
