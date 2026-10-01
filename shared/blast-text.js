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

import { assetOf, assetPhrase } from "./asset-type.js";

const kText = (n) => {
  const v = Math.round(Number(n) || 0);
  if (!v) return "";
  return v >= 1000000 ? `${(v / 1000000).toFixed(v % 1000000 === 0 ? 0 : 2).replace(/\.?0+$/, "")}M` : `${Math.round(v / 1000)}k`;
};

export const REHAB_WORDS = { cosmetic_only: "cosmetic", moderate: "moderate", heavy: "heavy", full_gut: "full-gut" };

// The operator's own line, from the dataroom headline. Their copy, so it is
// trimmed rather than rewritten — but a dollar sign or a URL in a bulk text is
// the carrier's business, not theirs, and neither survives.
export function blastNote(text = "", max = 90) {
  const clean = String(text || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean || clean.length > max) return "";
  return clean.replace(/[.!?]+$/, "");
}

/**
 * blastMessage({ firstName, address, city, price, beds, baths, sqft, yearBuilt,
 *                rehab, arv, repairs, note, variant, link, kind, intro }) → string
 *
 * `rehab` is a REHAB_APPETITES key or "". `link` is the buyer's own package
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
} = {}) {
  const first = String(firstName || "").trim().split(/\s+/)[0] || "";
  const how = String(intro || "").replace(/[.!?\s]+$/, "").trim();
  const text = blastBody({ first, address, city, price, beds, baths, sqft, yearBuilt, rehab, arv, repairs, note, variant, link, ask, kind });
  if (!how) return text;
  const hi = first ? `Hey ${first}, ` : "Hey, ";
  const rest = text.slice(hi.length);
  return `${first ? `Hey ${first}` : "Hey"} — ${how}. ${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
}

function blastBody({ first, address, city, price, beds, baths, sqft, yearBuilt, rehab, arv, repairs, note, variant, link, ask, kind }) {
  const hi = first ? `Hey ${first}, ` : "Hey, ";
  const street = String(address || "").split(",")[0].trim() || "a house";
  const where = city ? ` in ${city}` : "";
  // What it is: the kind, size, then age. "mobile home in a park, 3bd 2ba
  // 1,440 sqft, built 1978".
  const size = [beds ? `${beds}bd` : "", baths ? `${baths}ba` : "", sqft ? `${Math.round(sqft).toLocaleString("en-US")} sqft` : ""].filter(Boolean).join(" ");
  const built = Number(yearBuilt) > 1500 ? `built ${Math.round(yearBuilt)}` : "";
  const spec = [String(kind || "").trim(), size, built].filter(Boolean).join(", ");
  const work = REHAB_WORDS[rehab] ? `${REHAB_WORDS[rehab]} rehab` : "needs work";
  // What it costs and what it's worth — the ask first, because that is the
  // number they decide on, then the two that say whether it's a deal.
  const priceText = kText(price);
  const money = [
    priceText ? `Buyer price ${priceText}` : "",
    kText(arv) ? `ARV around ${kText(arv)}` : "",
    kText(repairs) ? `rehab about ${kText(repairs)}` : "",
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
      ? `${hi}got ${street}${where} under contract${spec ? ` — ${spec}` : ""}, ${work}. `
      : v === 1
        ? `${hi}new one${where}: ${street}${spec ? `, ${spec}` : ""}, ${work}. `
        : `${hi}${street}${where} just went under contract${spec ? ` (${spec})` : ""}. ${work[0].toUpperCase()}${work.slice(1)}. `;
    return `${opener}${money ? `${money}. ` : ""}${tail}${q}${url ? ` ${lead}: ${url}` : ""}`;
  }
  if (v === 0) {
    return `${hi}got ${street}${where} under contract${spec ? ` — ${spec}` : ""}, ${work}. ${money ? `${money}. ` : ""}${tail}${url ? `Photos and numbers: ${url}` : "Want the details?"}`;
  }
  if (v === 1) {
    return `${hi}new one${where}: ${street}${spec ? `, ${spec}` : ""}, ${work}. ${money ? `${money}. ` : ""}${tail}${url ? `Interested? Full package: ${url}` : "Interested?"}`;
  }
  return `${hi}${street}${where} just went under contract${spec ? ` (${spec})` : ""}. ${work[0].toUpperCase()}${work.slice(1)}. ${money ? `${money}. ` : ""}${tail}${url ? `Everything's here: ${url}` : "Say the word and I'll send the package."}`;
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
  const pct = arv && repairs ? repairs / arv : 0;
  const rehab = !pct ? "" : pct < 0.05 ? "cosmetic_only" : pct < 0.12 ? "moderate" : pct < 0.25 ? "heavy" : "full_gut";
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
  };
}

/**
 * blastSubject(facts) → the subject line when the deal goes by email:
 * "Mobile home in a park, Kent — under contract, 76k". A house without a
 * kind is named by its street.
 */
export function blastSubject({ address = "", city = "", price = 0, kind = "" } = {}) {
  const street = String(address || "").split(",")[0].trim();
  const what = String(kind || "").trim();
  const head = what ? `${what.charAt(0).toUpperCase()}${what.slice(1)}` : street || "A new deal";
  const priceText = kText(price);
  return `${head}${city ? `, ${city}` : ""} — under contract${priceText ? `, ${priceText}` : ""}`;
}
