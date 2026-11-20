// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// porchcard-listing.js — what a deal looks like as a listing on Matt's
// Porchcard profile (porchcard.com), and what to change to get it there.
//
// Pure. The broker's porchcard-sync.js reads the deals, their data rooms and
// photos, asks this module what each one's listing should be, and makes the
// calls.
//
// What gets published follows the deal room's own public switches, the same
// ones the public deal page and deals.json obey (dataroom.js teaserSections):
//   - photos only when the room shows photos publicly; a room that keeps them
//     private isn't put on Porchcard at all, because Porchcard hides a listing
//     with no photo anyway;
//   - ARV and rehab only when the room shows the equity numbers;
//   - the room's description only when it shows the summary.
// A closed deal shows the contract price (the recorded sale) and nothing that
// says what we made on it: no ARV, no rehab, no pitch. Same rule as soldCard.

import { parseUsAddress, stateAbbr, addressKey } from "./us-address.js";

export const PORCHCARD_MAX_PHOTOS = 15;
export const PORCHCARD_MAX_DESCRIPTION = 2000;

const LIVE = new Set(["under_contract", "buyer_found"]);
const DONE = new Set(["assigned", "closed"]);

/** porchcardStage(deal) → "active" | "closed" | "gone" | null */
export function porchcardStage(deal) {
  const s = deal?.stage;
  if (LIVE.has(s)) return "active";
  if (DONE.has(s)) return "closed";
  if (s === "fell_through") return "gone";
  return null;
}

/** splitDealAddress("741 North 128th Street, Seattle, Washington 98133") → { address, city, state, zip } */
export function splitDealAddress(raw) {
  const p = parseUsAddress(raw);
  const street = [p.houseNo, p.street].filter(Boolean).join(" ").trim();
  return { address: street, city: p.city || "", state: stateAbbr(p.state) || "", zip: p.zip || "" };
}

/** Is a listing on Porchcard the same house as a deal? Street line and ZIP. */
export function sameListing(listing, dealAddress) {
  const d = splitDealAddress(dealAddress);
  if (!d.address || !listing?.address) return false;
  if (d.zip && listing.zip && d.zip !== listing.zip) return false;
  return addressKey(listing.address) === addressKey(d.address);
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const pos = (v) => { const n = num(v); return n != null && n > 0 ? Math.round(n) : null; };
const grouped = (n) => Math.round(n).toLocaleString("en-US");

function closedDescription({ beds, baths, sqft, year, kind, city }) {
  const size = [
    beds ? `${beds} bed` : "",
    baths ? `${baths} bath` : "",
  ].filter(Boolean).join(" / ");
  const what = /land/i.test(kind || "") ? "land" : "home";
  const bits = [year ? `A ${year}` : "A", size, sqft ? `${grouped(sqft)} sq ft` : "", what].filter(Boolean);
  const lead = bits.length > 2 ? `${bits[0]} ${bits.slice(1, -1).join(", ")} ${bits.at(-1)}` : `${bits.join(" ")}`;
  return `Closed. ${lead}${city ? ` in ${city}` : ""}. Found off-market and assigned to an investor buyer.`;
}

/**
 * porchcardListing({ offer, room, sections }) → { ok: true, stage, fields, photos } | { ok: false, reason }
 *
 * `sections` is the room's public view (dataroom.js teaserSections(room)).
 * `fields` is the body for POST /listings; `photos` says whether the room's
 * photos may go up. A deal Porchcard can't take says why instead.
 */
export function porchcardListing({ offer, room, sections = {} } = {}) {
  const stage = porchcardStage(offer?.deal);
  if (!stage) return { ok: false, reason: "not a deal" };
  if (stage === "gone") return { ok: false, stage, reason: "fell through" };
  if (!room) return { ok: false, stage, reason: "no deal room yet" };
  if (!sections.photos) return { ok: false, stage, reason: "the deal room keeps its photos private" };

  const where = splitDealAddress(room?.snapshot?.property?.address || offer?.address || room?.address);
  if (!where.address || !where.city || !where.zip || where.state.length !== 2) {
    return { ok: false, stage, reason: "couldn't read the street, city, state and ZIP" };
  }
  const p = room?.snapshot?.property || {};
  const n = room?.snapshot?.numbers || {};
  const isLand = /land/i.test(p.kind || "");
  const beds = isLand ? 0 : num(p.beds);
  const baths = isLand ? 0 : num(p.baths);
  const sqft = pos(p.sqft);
  if (beds == null || baths == null || !sqft) return { ok: false, stage, reason: "the deal room has no beds, baths and square feet" };

  const fields = { ...where, beds, baths, sqft, status: stage };
  const year = pos(p.yearBuilt);
  if (year) fields.year_built = year;
  if (isLand) fields.show_price_per_sqft = false;

  if (stage === "closed") {
    const price = pos(offer?.deal?.contractPrice);
    if (!price) return { ok: false, stage, reason: "no contract price" };
    fields.price = price;
    fields.description = closedDescription({ beds, baths, sqft, year, kind: p.kind, city: where.city });
  } else {
    const price = pos(n.investorPrice);
    if (!price) return { ok: false, stage, reason: "the deal room has no buyer price" };
    fields.price = price;
    if (sections.equity) {
      if (pos(n.arv)) fields.arv = pos(n.arv);
      if (pos(n.repairs)) fields.rehab = pos(n.repairs);
    }
    const notes = sections.summary ? String(room?.snapshot?.notes || "").trim() : "";
    if (notes) fields.description = notes.slice(0, PORCHCARD_MAX_DESCRIPTION);
  }
  return { ok: true, stage, fields, photos: true };
}

/**
 * porchcardStep({ want, link, listing, roomPhotoIds }) → { do, ... }
 *
 * The one next thing to do for a deal, given what it should be (`want`, from
 * porchcardListing), what we last did (`link`, this deal's entry on the job
 * cursor: { key, photoIds, photosDone }) and the listing as Porchcard has it
 * now (`listing`: ours by key, or one with the same address, or null):
 *   adopt    — a listing for this house is already there (put up by hand):
 *              take it as this deal's, and leave its photos alone if it has any
 *   create   — no listing yet
 *   close    — the deal closed since it went up: closed price and words, no ARV/rehab
 *   hide     — the deal fell through: off the profile, kept on Porchcard
 *   photos   — the room's photos that haven't gone up yet
 *   none
 * Never puts a hidden listing back on the profile: Matt may have hidden it.
 */
export function porchcardStep({ want, link = null, listing = null, roomPhotoIds = [] } = {}) {
  const have = listing || null;
  if (have && !link?.key) {
    return { do: "adopt", key: have.key, photosDone: (have.photos || []).length > 0 };
  }
  // We put it up and it's gone: deleted on Porchcard. Not put back.
  if (!have && link?.key) return { do: "none", reason: "deleted on Porchcard" };
  if (want?.stage === "gone") {
    return have && have.shown !== false ? { do: "hide", key: have.key } : { do: "none" };
  }
  if (!want?.ok) return { do: "none", reason: want?.reason || "" };
  if (!have) return { do: "create", fields: want.fields };
  if (want.stage === "closed" && have.status !== "closed") {
    const { price, description, status } = want.fields;
    return { do: "close", key: have.key, patch: { status, price, description, arv: null, rehab: null } };
  }
  if (want.photos && !link?.photosDone) {
    const sent = new Set(link?.photoIds || []);
    const left = Math.max(0, PORCHCARD_MAX_PHOTOS - (have.photos || []).length);
    const next = roomPhotoIds.filter((id) => !sent.has(id)).slice(0, left);
    if (next.length) return { do: "photos", key: have.key, photoIds: next };
  }
  return { do: "none" };
}
