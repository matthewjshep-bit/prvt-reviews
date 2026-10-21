// blast-text.js — the deal, in one text, the way a wholesaler actually
// sends it to a list.
//
// Deliberately NOT a model call: a blast is one message to many people, and
// the honest version of that is a short template with the deal's numbers in
// it — the same text a person would paste. Three phrasings rotate so a buyer
// on several lists doesn't see the identical line three times. No dollar
// signs. One link only: the buyer's own tracked package link, issued at send
// time (blast-refresh.js), in place of "want the details?" (Matt, 2026-09-28).
//
// WHAT AN INVESTOR MAY SEE: the buyer price, the ARV and the rehab estimate —
// the three figures the dataroom already shows them. What we paid, the
// contract price and the assignment fee are not in here and must never be:
// dealFacts reads the offer's own ARV/repairs and the price it is handed, and
// touches deal.contractPrice and deal.assignmentFee at no point.

import { buyerFacts } from "./underwrite-checks.js";
import { assetOf, assetPhrase } from "./asset-type.js";
import { carrierFlags } from "./carrier-words.js";

const kText = (n) => {
  const v = Math.round(Number(n) || 0);
  if (!v) return "";
  return v >= 1000000 ? `${(v / 1000000).toFixed(v % 1000000 === 0 ? 0 : 2).replace(/\.?0+$/, "")}M` : `${Math.round(v / 1000)}k`;
};

// The only words a blast has for the work are the level Matt picked on the
// deal (the Rehab pane's Light / Medium / Heavy, snapshot.rehab.bucket). Not
// one worked out from repairs ÷ ARV: 3511 NE 153rd St went to buyers as
// "heavy rehab" on 2026-09-29 and nobody had called it that. With no level
// picked the text says nothing about the work — "rehab about 200k" does.
export const REHAB_WORDS = { light: "light", medium: "medium", heavy: "heavy", gut: "full gut" };

// A lot, for land: "4,748 sqft lot, zoned LR1". What a builder asks first
// (1538 NW 61st St, 2026-10-20: "How much land is it? I didn't see that in
// your initial blurb. I think a land buyer would want to see that off the
// bat").
const lotPhrase = (lotSqft = 0, zoning = "") => [
  Number(lotSqft) > 0 ? `${Math.round(lotSqft).toLocaleString("en-US")} sqft lot` : "",
  String(zoning || "").trim() ? `zoned ${String(zoning).trim()}` : "",
].filter(Boolean).join(", ");

// The level the operator picked, or "".
export function pickedRehabLevel(offer = {}) {
  const b = String(offer?.snapshot?.rehab?.bucket || "").toLowerCase();
  return REHAB_WORDS[b] ? b : "";
}

// The operator's own line, from the dataroom headline. Their copy, so it is
// trimmed rather than rewritten — but a dollar sign or a URL in a bulk text is
// the carrier's business, not theirs, and neither survives. A line that says
// what the carriers block ("cash only, sold as-is") is left out whole rather
// than cut into something nobody wrote (2026-10-15).
export function blastNote(text = "", max = 90) {
  const clean = String(text || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean || clean.length > max || carrierFlags(clean).length) return "";
  return clean.replace(/[.!?]+$/, "");
}

/**
 * blastMessage({ firstName, address, city, price, beds, baths, sqft, yearBuilt,
 *                rehab, arv, repairs, note, variant, link, kind, intro }) → string
 *
 * `rehab` is the level the operator picked (a REHAB_WORDS key) or "" — never a
 * word worked out from the numbers. `link` is the buyer's own package
 * link; with it the text ends on the link rather than offering to send the
 * details. `ask` is the walkthrough question; with it the text ends on that
 * question (then the link). `variant` picks the phrasing (0-2);
 * the caller rotates it per recipient. Every fact is optional — a deal with
 * nothing filled in still sends the street, the work and the price, which is
 * what this used to be.
 *
 * `kind` is the kind of house in words ("mobile home in a park",
 * shared/asset-type.js assetPhrase); a single family house has none, so its
 * text reads as it always has. `intro` is how we found them, for a buyer
 * hearing from us for the first time ("found you through the WA real estate
 * Facebook group") — it goes first.
 */
export function blastMessage({
  firstName = "", address = "", city = "", price = 0, beds = 0, baths = 0, sqft = 0,
  yearBuilt = 0, rehab = "", arv = 0, repairs = 0, note = "", variant = 0, link = "", ask = "", kind = "", intro = "",
  linkOnReply = false, septic = false, systems = false, templates = [], lotSqft = 0, zoning = "",
} = {}) {
  const first = String(firstName || "").trim().split(/\s+/)[0] || "";
  const how = String(intro || "").replace(/[.!?\s]+$/, "").trim();
  const own = normalizeDealTexts(templates);
  if (own.length) {
    const values = dealTextValues({ first, address, city, price, beds, baths, sqft, yearBuilt, rehab, arv, repairs, note, link, ask, kind, linkOnReply, septic, systems, lotSqft, zoning });
    const text = fillDealText(own[Math.abs(Math.round(Number(variant) || 0)) % own.length], values);
    if (!how) return text;
    // How we found them goes right after the greeting, as it does below.
    const m = /^((?:hey|hi|hello)\b[^,]{0,30}),\s*/i.exec(text);
    const rest = m ? text.slice(m[0].length) : text;
    return `${m ? m[1] : first ? `Hey ${first}` : "Hey"} — ${how}. ${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
  }
  const text = blastBody({ first, address, city, price, beds, baths, sqft, yearBuilt, rehab, arv, repairs, note, variant, link, ask, kind, linkOnReply, septic, systems, lotSqft, zoning });
  if (!how) return text;
  const hi = first ? `Hey ${first}, ` : "Hey, ";
  const rest = text.slice(hi.length);
  return `${first ? `Hey ${first}` : "Hey"} — ${how}. ${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
}

/* ---------- the deal text in Matt's own words (2026-10-20) ---------- */

// Matt: "Let's make the change where we can edit the text" — the deal text,
// on Autopilot → Investors. Up to three versions, rotated per buyer like the
// built-in three, each with blanks the deal fills in as it sends, so the
// price is still the deal's price at the minute it leaves. None saved: the
// built-in wording above, unchanged.
export const DEAL_TEXT_MAX = 3;
export const DEAL_TEXT_MAX_CHARS = 400;
export const DEAL_TEXT_BLANKS = {
  first: "their first name",
  place: "the street and town: 5232 S Yakima Ave in Tacoma",
  street: "the street: 5232 S Yakima Ave",
  city: "the town: Tacoma",
  house: "what it is: 3bd 2ba 1,440 sqft, built 1978",
  work: "the rehab level you picked: medium rehab",
  numbers: "Buyer price 261k, ARV around 380k, rehab about 60k",
  price: "the buyer price: 261k",
  arv: "the ARV: 380k",
  repairs: "the rehab estimate: 60k",
  note: "your one line from the package headline",
  close: "the ending: the walkthrough question and the package link (added at the end when left out)",
};
// The built-in three, written with the blanks: where an edit starts.
export const DEFAULT_DEAL_TEXTS = [
  "Hey {first}, got {place} under contract — {house}, {work}. {numbers}. {note}. {close}",
  "Hey {first}, new one: {place}, {house}, {work}. {numbers}. {note}. {close}",
  "Hey {first}, {place} just went under contract ({house}). {work}. {numbers}. {note}. {close}",
];

/** normalizeDealTexts(v) → up to three trimmed texts; [] means the built-in wording. */
export function normalizeDealTexts(v) {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/\n\s*\n/) : [];
  return raw.map((x) => String(x || "").replace(/\s+/g, " ").trim().slice(0, DEAL_TEXT_MAX_CHARS)).filter(Boolean).slice(0, DEAL_TEXT_MAX);
}

/** The blanks for one buyer, worked out the way the built-in text works them out. */
export function dealTextValues({ first = "", address = "", city = "", price = 0, beds = 0, baths = 0, sqft = 0, yearBuilt = 0, rehab = "", arv = 0, repairs = 0, note = "", link = "", ask = "", kind = "", linkOnReply = false, septic = false, systems = false, lotSqft = 0, zoning = "" } = {}) {
  const street = String(address || "").split(",")[0].trim() || "a house";
  const size = [beds ? `${beds}bd` : "", baths ? `${baths}ba` : "", sqft ? `${Math.round(sqft).toLocaleString("en-US")} sqft` : ""].filter(Boolean).join(" ");
  const built = Number(yearBuilt) > 1500 ? `built ${Math.round(yearBuilt)}` : "";
  const house = [String(kind || "").trim(), size, built, lotPhrase(lotSqft, zoning), septic ? "septic" : ""].filter(Boolean).join(", ");
  const numbers = [
    kText(price) ? `Buyer price ${kText(price)}` : "",
    kText(arv) ? `ARV around ${kText(arv)}` : "",
    kText(repairs) ? `rehab about ${kText(repairs)}${systems ? " incl. systems" : ""}` : "",
  ].filter(Boolean).join(", ");
  const url = String(link || "").trim();
  const q = String(ask || "").replace(/\$/g, "").replace(/\s+/g, " ").trim();
  const close = q
    ? `${q}${url ? ` Photos and numbers: ${url}` : linkOnReply ? " Happy to send photos and numbers." : ""}`
    : url ? `Photos and numbers: ${url}` : "Want the details?";
  return {
    first, street, city: String(city || ""), place: city ? `${street} in ${city}` : street,
    house, work: REHAB_WORDS[rehab] ? `${REHAB_WORDS[rehab]} rehab` : "", numbers,
    price: kText(price), arv: kText(arv), repairs: kText(repairs), note: blastNote(note), close,
  };
}

/**
 * fillDealText(template, values) → the text
 *
 * Each blank filled; one with nothing to say leaves no stray comma, dash or
 * empty brackets behind ("— , medium rehab" reads "— medium rehab"). A text
 * without {close} gets it on the end: the link and the walkthrough question
 * are how a buyer moves, so no version may drop them. No dollar signs.
 */
export function fillDealText(template = "", values = {}) {
  let t = String(template || "");
  if (!/\{close\}/.test(t)) t = `${t.replace(/\s+$/, "")} {close}`;
  const out = t
    .replace(/\{(\w+)\}/g, (_, k) => String(values[k] ?? "").trim())
    .replace(/\$/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/—\s*,\s*/g, "— ")
    .replace(/,\s*(?=[,.:;?!)]|—|$)/g, "")
    .replace(/\s*—\s*(?=[.,:;?!]|$)/g, "")
    .replace(/:\s*(?=[.,;?!]|$)/g, "")
    .replace(/\s+([,.:;?!])/g, "$1")
    .replace(/([.?!])(?:\s*\.)+/g, "$1")
    .replace(/^[\s.,;:]+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return out.replace(/([.?!]\s+)([a-z])/g, (_, p, c) => p + c.toUpperCase());
}

function blastBody({ first, address, city, price, beds, baths, sqft, yearBuilt, rehab, arv, repairs, note, variant, link, ask, kind, linkOnReply = false, septic = false, systems = false, lotSqft = 0, zoning = "" }) {
  const hi = first ? `Hey ${first}, ` : "Hey, ";
  const street = String(address || "").split(",")[0].trim() || "a house";
  const where = city ? ` in ${city}` : "";
  // What it is: the kind, size, then age. "mobile home in a park, 3bd 2ba
  // 1,440 sqft, built 1978".
  const size = [beds ? `${beds}bd` : "", baths ? `${baths}ba` : "", sqft ? `${Math.round(sqft).toLocaleString("en-US")} sqft` : ""].filter(Boolean).join(" ");
  const built = Number(yearBuilt) > 1500 ? `built ${Math.round(yearBuilt)}` : "";
  // Septic is the question buyers asked most before deciding (nine times in
  // the 2026-10-02 read of every thread) — answered up front when the record
  // says so.
  const spec = [String(kind || "").trim(), size, built, lotPhrase(lotSqft, zoning), septic ? "septic" : ""].filter(Boolean).join(", ");
  const work = REHAB_WORDS[rehab] ? `${REHAB_WORDS[rehab]} rehab` : "";
  const workAfter = work ? `, ${work}` : "";
  const workLine = work ? `${work[0].toUpperCase()}${work.slice(1)}. ` : "";
  // What it costs and what it's worth — the ask first, because that is the
  // number they decide on, then the two that say whether it's a deal.
  const priceText = kText(price);
  const money = [
    priceText ? `Buyer price ${priceText}` : "",
    kText(arv) ? `ARV around ${kText(arv)}` : "",
    kText(repairs) ? `rehab about ${kText(repairs)}${systems ? " incl. systems" : ""}` : "",
  ].filter(Boolean).join(", ");
  const line = blastNote(note);
  const tail = line ? `${line}. ` : "";
  const v = Math.abs(Math.round(Number(variant) || 0)) % 3;
  const url = String(link || "").trim();
  // The walkthrough question (shared/showing.js walkthroughAsk). A buyer who
  // walks it buys it, so when the caller has one the text ends on it, with
  // the package link after, in place of the offer to send the details.
  const q = String(ask || "").replace(/\$/g, "").replace(/\s+/g, " ").trim();
  if (q) {
    const lead = ["Photos and numbers", "Full package", "Everything's here"][v];
    const opener = v === 0
      ? `${hi}got ${street}${where} under contract${spec ? ` — ${spec}` : ""}${workAfter}. `
      : v === 1
        ? `${hi}new one${where}: ${street}${spec ? `, ${spec}` : ""}${workAfter}. `
        : `${hi}${street}${where} just went under contract${spec ? ` (${spec})` : ""}. ${workLine}`;
    // The link waits for their answer (dispoAutopilot.blastLink "on_reply"):
    // say it's there for the asking.
    return `${opener}${money ? `${money}. ` : ""}${tail}${q}${url ? ` ${lead}: ${url}` : linkOnReply ? " Happy to send photos and numbers." : ""}`;
  }
  if (v === 0) {
    return `${hi}got ${street}${where} under contract${spec ? ` — ${spec}` : ""}${workAfter}. ${money ? `${money}. ` : ""}${tail}${url ? `Photos and numbers: ${url}` : "Want the details?"}`;
  }
  if (v === 1) {
    return `${hi}new one${where}: ${street}${spec ? `, ${spec}` : ""}${workAfter}. ${money ? `${money}. ` : ""}${tail}${url ? `Interested? Full package: ${url}` : "Interested?"}`;
  }
  return `${hi}${street}${where} just went under contract${spec ? ` (${spec})` : ""}. ${workLine}${money ? `${money}. ` : ""}${tail}${url ? `Everything's here: ${url}` : "Say the word and I'll send the package."}`;
}

/**
 * presellMessage({ firstName, address, city, price, …, variant, intro }) → string
 *
 * A listed house we're about to sign, put to a few buyers first (shared/
 * pre-contract.js, 2026-10-15: of eight listed-house contracts seven fell
 * through, one signed with no buyer at all). Nothing is signed, so it never
 * says "under contract", and it carries no link — the package waits for
 * their answer. The same facts and figures a deal text has.
 */
export function presellMessage({
  firstName = "", address = "", city = "", price = 0, beds = 0, baths = 0, sqft = 0,
  yearBuilt = 0, rehab = "", arv = 0, repairs = 0, variant = 0, kind = "", intro = "", septic = false, systems = false,
} = {}) {
  const first = String(firstName || "").trim().split(/\s+/)[0] || "";
  const street = String(address || "").split(",")[0].trim() || "a house";
  const where = city ? ` in ${city}` : "";
  const size = [beds ? `${beds}bd` : "", baths ? `${baths}ba` : "", sqft ? `${Math.round(sqft).toLocaleString("en-US")} sqft` : ""].filter(Boolean).join(" ");
  const built = Number(yearBuilt) > 1500 ? `built ${Math.round(yearBuilt)}` : "";
  const spec = [String(kind || "").trim(), size, built, septic ? "septic" : "", REHAB_WORDS[rehab] ? `${REHAB_WORDS[rehab]} rehab` : ""].filter(Boolean).join(", ");
  const money = [
    kText(price) ? `Buyer price around ${kText(price)}` : "",
    kText(arv) ? `ARV around ${kText(arv)}` : "",
    kText(repairs) ? `rehab about ${kText(repairs)}${systems ? " incl. systems" : ""}` : "",
  ].filter(Boolean).join(", ");
  const how = String(intro || "").replace(/[.!?\s]+$/, "").trim();
  const hi = first ? `Hey ${first}` : "Hey";
  const lead = how ? `${hi} — ${how}. ` : `${hi}, `;
  const cap = (s) => (how ? `${s.charAt(0).toUpperCase()}${s.slice(1)}` : s);
  const v = Math.abs(Math.round(Number(variant) || 0)) % 3;
  const body = v === 0
    ? `${cap("lining one up")}${where}: ${street}${spec ? `, ${spec}` : ""}. ${money ? `${money}. ` : ""}Would it fit what you're buying?`
    : v === 1
      ? `${cap("might have one coming")}${where}: ${street}${spec ? `, ${spec}` : ""}. ${money ? `${money}. ` : ""}If I lock it up, want first look?`
      : `${cap("working on")} ${street}${where}${spec ? ` (${spec})` : ""}. ${money ? `${money}. ` : ""}Would you want it at that number?`;
  return `${lead}${body}`;
}

/**
 * bundleMessage(factsList, { firstName, linkOnReply, intro, variant }) → string
 *
 * Two or three deals for one buyer, in one text (Matt, 2026-10-05: a buyer
 * who'd hear about two houses in three days hears about both at once). Each
 * deal is its street, the kind and size, the level Matt picked if any, and
 * the three figures a buyer may see — nothing the deal doesn't say. No link
 * and no walkthrough question: whichever they answer about brings those. More
 * than three are left for the next text. One deal is just its own blast.
 */
export const BUNDLE_MAX = 3;
export function bundleMessage(factsList = [], { firstName = "", linkOnReply = false, intro = "", variant = 0 } = {}) {
  const deals = (factsList || []).filter(Boolean).slice(0, BUNDLE_MAX);
  if (deals.length <= 1) return blastMessage({ ...(deals[0] || {}), firstName, variant, intro, linkOnReply });
  const first = String(firstName || "").trim().split(/\s+/)[0] || "";
  const line = (f) => {
    const street = String(f.address || "").split(",")[0].trim() || "a house";
    const where = f.city ? ` in ${f.city}` : "";
    const size = [f.beds ? `${f.beds}bd` : "", f.baths ? `${f.baths}ba` : ""].filter(Boolean).join(" ");
    const work = REHAB_WORDS[f.rehab] ? `${REHAB_WORDS[f.rehab]} rehab` : "";
    const what = [String(f.kind || "").trim(), size, work].filter(Boolean).join(", ");
    const money = [
      kText(f.price) ? `buyer price ${kText(f.price)}` : "",
      kText(f.arv) ? `ARV around ${kText(f.arv)}` : "",
      kText(f.repairs) ? `rehab about ${kText(f.repairs)}${f.systems ? " incl. systems" : ""}` : "",
    ].filter(Boolean).join(", ");
    return `${street}${where}${what ? `, ${what}` : ""}${money ? `: ${money}` : ""}`;
  };
  const count = deals.length === 2 ? "two" : "three";
  const how = String(intro || "").replace(/[.!?\s]+$/, "").trim();
  const hi = `${first ? `Hey ${first}` : "Hey"}${how ? ` — ${how}. Got` : ", got"} ${count} under contract right now.`;
  const body = deals.map((f, i) => `${i ? "And " : ""}${line(f)}.`).join(" ");
  const ask = deals.length === 2 ? "Either one fit what you're buying?" : "Any of these fit what you're buying?";
  return `${hi} ${body} ${ask}${linkOnReply ? " Happy to send photos and numbers." : ""}`;
}

/**
 * dealFacts(offer, { price, note }) → the fields blastMessage wants, from an
 * offer doc.
 *
 * The property facts come from the underwrite's own subject record — the SAME
 * place the dataroom and the agent offer page read (`snapshot.comps.result.info`,
 * else `snapshot.subjectInfo`). They used to be looked for at `offer.subject`,
 * where nothing writes them, so every blast went out as a street and a price:
 * Dmitriy Kozlov's, 2026-09-16, read "got 23706 138th Dr SE in Snohomish under
 * contract, moderate rehab. Buyer price 532k" on a deal whose beds, baths,
 * sqft, year, ARV and rehab estimate were all on file.
 */
export function dealFacts(offer = {}, { price = 0, note = "" } = {}) {
  const snap = offer.snapshot || null;
  const subject = snap?.comps?.result?.info || snap?.subjectInfo
    || offer.subject || offer.calc?.inputs?.subject || offer.property || {};
  const parts = String(offer.address || "").split(",").map((s) => s.trim());
  const city = parts.length >= 2 ? parts[1].replace(/\s+[A-Z]{2}\s*\d{5}.*$/, "").trim() : "";
  const arv = Number(offer.arv || offer.calc?.inputs?.arv) || 0;
  const named = Number(offer.repairs || offer.calc?.inputs?.repairs) || 0;
  // The scope adds up to the same figure the dataroom shows when the offer
  // names none — one rehab number across every surface a buyer sees.
  const scoped = (offer.scope || []).reduce((t, s) => t + (Number(s?.cost) || 0), 0);
  const repairs = named || Math.round(scoped);
  // The level Matt picked, never one read off repairs ÷ ARV (see REHAB_WORDS).
  const rehab = pickedRehabLevel(offer);
  // Land is sold as a lot: no ARV, no rehab, no house (1538 NW 61st St,
  // 2026-10-20, went out as "Buyer price 911k, ARV around 925k" — the ARV was
  // the asking price, and two builders read it back as a joke).
  if (assetOf(offer)?.type === "land") {
    return {
      address: offer.address || "", city,
      price: Math.round(Number(price) || 0),
      beds: 0, baths: 0, sqft: 0, yearBuilt: 0, arv: 0, repairs: 0, rehab: "",
      note: String(note || ""),
      kind: assetPhrase(assetOf(offer)),
      lotSqft: Number(subject.lotSqft || subject.lotSize || snap?.subjectInfo?.lotSqft) || 0,
      zoning: String(subject.zoning || snap?.subjectInfo?.zoning || offer.zoning || "").trim().slice(0, 24),
      septic: false, systems: false,
    };
  }
  return {
    address: offer.address || "", city,
    price: Math.round(Number(price) || 0),
    beds: Number(subject.beds || subject.bedrooms) || 0,
    baths: Number(subject.baths || subject.bathrooms) || 0,
    sqft: Number(subject.sqft || subject.livingArea) || Number(snap?.subjectSqft) || 0,
    yearBuilt: Number(subject.yearBuilt || subject.year) || 0,
    arv, repairs, rehab,
    note: String(note || ""),
    // The kind of house in words — "" for a single family house.
    kind: assetPhrase(assetOf(offer)),
    // What buyers ask before they decide (shared/underwrite-checks.js
    // buyerFacts): septic, and whether an old house's systems are priced in.
    septic: buyerFacts(offer).septic,
    systems: buyerFacts(offer).systems,
  };
}

/**
 * blastSubject(facts) → the subject line when the deal goes by email:
 * "Mobile home in a park, Kent — under contract, 76k". A house without a
 * kind is named by its street. A pre-sell (`presell`) is "coming up": nothing
 * is signed yet.
 */
export function blastSubject({ address = "", city = "", price = 0, kind = "" } = {}, { presell = false } = {}) {
  const street = String(address || "").split(",")[0].trim();
  const what = String(kind || "").trim();
  const head = what ? `${what.charAt(0).toUpperCase()}${what.slice(1)}` : street || "A new deal";
  const priceText = kText(price);
  return `${head}${city ? `, ${city}` : ""} — ${presell ? "coming up" : "under contract"}${priceText ? `, ${priceText}` : ""}`;
}
