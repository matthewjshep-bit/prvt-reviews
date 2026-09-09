// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// blast-text.js — the deal, in one text, the way a wholesaler actually
// sends it to a list.
//
// Deliberately NOT a model call: a blast is one message to many people, and
// the honest version of that is a short template with the deal's numbers in
// it — the same text a person would paste. Three phrasings rotate so a buyer
// on several lists doesn't see the identical line three times. No dollar
// signs, no links (carrier rules), and the only figure is the buyer price,
// which is the one number an investor may hear (shared/conversation-ai.js).

const kText = (n) => {
  const v = Math.round(Number(n) || 0);
  if (!v) return "";
  return v >= 1000000 ? `${(v / 1000000).toFixed(v % 1000000 === 0 ? 0 : 2).replace(/\.?0+$/, "")}M` : `${Math.round(v / 1000)}k`;
};

export const REHAB_WORDS = { cosmetic_only: "cosmetic", moderate: "moderate", heavy: "heavy", full_gut: "full-gut" };

/**
 * blastMessage({ firstName, address, city, price, beds, baths, sqft, rehab, variant })
 *   → string
 *
 * `rehab` is a REHAB_APPETITES key or "". `variant` picks the phrasing (0-2);
 * the caller rotates it per recipient.
 */
export function blastMessage({ firstName = "", address = "", city = "", price = 0, beds = 0, baths = 0, sqft = 0, rehab = "", variant = 0 } = {}) {
  const first = String(firstName || "").trim().split(/\s+/)[0] || "";
  const hi = first ? `Hey ${first}, ` : "Hey, ";
  const street = String(address || "").split(",")[0].trim() || "a house";
  const where = city ? ` in ${city}` : "";
  const size = [beds ? `${beds}bd` : "", baths ? `${baths}ba` : "", sqft ? `${Math.round(sqft).toLocaleString("en-US")} sqft` : ""].filter(Boolean).join(" ");
  const work = REHAB_WORDS[rehab] ? `${REHAB_WORDS[rehab]} rehab` : "needs work";
  const ask = kText(price);
  const v = Math.abs(Math.round(Number(variant) || 0)) % 3;
  if (v === 0) {
    return `${hi}got ${street}${where} under contract${size ? ` — ${size}` : ""}, ${work}. ${ask ? `Buyer price ${ask}. ` : ""}Want the details?`;
  }
  if (v === 1) {
    return `${hi}new one${where}: ${street}${size ? `, ${size}` : ""}, ${work}.${ask ? ` ${ask} to you.` : ""} Interested?`;
  }
  return `${hi}${street}${where} just went under contract${size ? ` (${size})` : ""}. ${work[0].toUpperCase()}${work.slice(1)}${ask ? `, ${ask}` : ""}. Say the word and I'll send the package.`;
}

/**
 * dealFacts(offer, { price }) → the fields blastMessage wants, from an offer
 * doc. Beds/baths/sqft come from the subject facts an underwrite saved, when
 * it did; otherwise they are simply left out of the text.
 */
export function dealFacts(offer = {}, { price = 0 } = {}) {
  const subject = offer.subject || offer.calc?.inputs?.subject || offer.property || {};
  const parts = String(offer.address || "").split(",").map((s) => s.trim());
  const city = parts.length >= 2 ? parts[1].replace(/\s+[A-Z]{2}\s*\d{5}.*$/, "").trim() : "";
  const arv = Number(offer.arv || offer.calc?.inputs?.arv) || 0;
  const repairs = Number(offer.repairs || offer.calc?.inputs?.repairs) || 0;
  const pct = arv && repairs ? repairs / arv : 0;
  const rehab = !pct ? "" : pct < 0.05 ? "cosmetic_only" : pct < 0.12 ? "moderate" : pct < 0.25 ? "heavy" : "full_gut";
  return {
    address: offer.address || "", city,
    price: Math.round(Number(price) || 0),
    beds: Number(subject.beds || subject.bedrooms) || 0,
    baths: Number(subject.baths || subject.bathrooms) || 0,
    sqft: Number(subject.sqft || subject.livingArea) || 0,
    rehab,
  };
}
