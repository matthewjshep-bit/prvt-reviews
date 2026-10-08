// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// tier-one.js — Tier 1 is agents with a live house that needs work, right now
// (Matt, 2026-10-07). GHL's Acquisitions "Tier 1" stage is the list he works;
// these are the rules that keep the bot from putting the wrong houses on it.
//
// Pure. The broker's reply agent reads `passedOnHouse` before it runs the
// tier-1 rule; the actions it strips are the ones `isTierOneAction` names.
// The Tier 1 list (ghl-broker/tier-one.js) reads GHL's Tier 1 cards and
// screens each with `screenTierOne`; Pass, Kick out and Add move the card
// by `cardMove`.

import { addressKey, sameStreetLoose, parseUsAddress } from "./us-address.js";
import { RURAL_HOLD, isRuralLot, acresText } from "./asset-type.js";

// A pass or a kick-out from the Tier 1 list, written as a contact event with
// the house's address — so a house we never priced still counts as passed.
export const TIER_ONE_OUT_EVENTS = ["tier1_passed", "tier1_kicked"];
// Statuses that mean we're done with the house: we said no, or it's gone.
const PASSED_STATUSES = new Set(["we_passed", "unavailable"]);

const when = (x) => Date.parse(x?.updatedAt || x?.statusAt || x?.createdAt || x?.at || "") || 0;

// Did we pass on this house? The newest offer row on it says we_passed or
// unavailable, or it was passed or kicked off the Tier 1 list (and not added
// back since). Returns { why, at } or null.
export function passedOnHouse({ offers = [], events = [], address = "" } = {}) {
  const key = addressKey(address);
  if (!key) return null;
  // The same house with or without its city: "4430 Sunnyside Blvd" in a text
  // is the offer at "4430 Sunnyside Blvd, Marysville, WA 98270".
  const same = (a) => addressKey(a) === key || sameStreetLoose(a, address);
  const rows = offers.filter((o) => o?.address && o.status !== "draft" && same(o.address))
    .sort((a, b) => when(b) - when(a));
  if (rows[0] && PASSED_STATUSES.has(rows[0].status)) {
    return { why: rows[0].status === "unavailable" ? "no longer available" : "we passed on this house", at: when(rows[0]) };
  }
  const mine = events.filter((e) => e?.address && same(e.address));
  const out = mine.filter((e) => TIER_ONE_OUT_EVENTS.includes(e.type)).sort((a, b) => when(b) - when(a))[0];
  if (!out) return null;
  const back = mine.some((e) => e.type === "tier1_added" && when(e) > when(out));
  return back ? null : { why: "we passed on this house", at: when(out) };
}

// The actions the tier-1 rule plans: the tag, the TIER 1 workflow, and the
// lower tiers it leaves. Skipping the rule means skipping all of them, so a
// passed house leaves the agent where they were.
export function isTierOneAction(a = {}) {
  const tags = (a.tags || []).map((t) => String(t).toLowerCase());
  const wf = String(a.workflowName || "");
  if (a.type === "add_tags") return tags.includes("tier-1");
  if (a.type === "remove_tags") return tags.length > 0 && tags.every((t) => t === "tier-2" || t === "tier-3");
  if (a.type === "add_to_workflow") return /tier\s*1\b/i.test(wf);
  if (a.type === "remove_from_workflow") return /tier\s*[23]\b/i.test(wf);
  return false;
}

/* ---------- the Tier 1 list: GHL's stage, screened ---------- */

// Switches. Both ship off: the list and its buttons need neither.
//   autoKick            the 7am tier check moves sure misses out of Tier 1
//   autoKickMax         at most this many a morning
//   followMachineSends  a written offer the machine sends moves the card to
//                       Offer Out (one you send by hand always does)
export const TIER_ONE_DEFAULTS = Object.freeze({ autoKick: false, autoKickMax: 10, followMachineSends: false });

export function normalizeTierOne(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  const n = Math.round(Number(o.autoKickMax));
  return {
    autoKick: o.autoKick === true,
    autoKickMax: Number.isFinite(n) && o.autoKickMax != null && o.autoKickMax !== "" ? Math.min(50, Math.max(1, n)) : TIER_ONE_DEFAULTS.autoKickMax,
    followMachineSends: o.followMachineSends === true,
  };
}

const DAY_MS = 86400000;
export const NAMED_DAYS = 21;
export const STALE_DAYS = 21;
const OPEN = new Set(["new", "sent", "countered"]);
const GONE_STATUS = /pending|sold|contingent|off[\s_-]?market|withdrawn|recently[\s_-]?sold/i;
const streetOf = (a) => String(a || "").split(",")[0].trim();

// What each flag says on the row, and whether it is sure enough for the
// machine to act on alone (autoKick). A soft one only colours the row.
export const TIER_ONE_FLAGS = Object.freeze({
  gone: "Sold or off the market",
  turnkey: "Not a flip",
  not_sfr: "Not single-family",
  rural: "Rural (2+ acres)",
  no_house: "No house named",
  passed: "Already passed",
  stale: "Quiet 3+ weeks",
});

/**
 * pickHouse({ offers, events, cardName, now }) → { address, offer, source } | null
 *
 * The house this Tier 1 card is about: their current open offer (newest
 * priced), else the newest house they named in the last three weeks, else the
 * card's own name when it reads like a street address. `offers` are the
 * contact's rows, annotated (isCurrent / supersededBy).
 */
export function pickHouse({ offers = [], events = [], cardName = "", now = Date.now() } = {}) {
  const at = (o) => Date.parse(o?.statusAt || o?.updatedAt || o?.createdAt || "") || 0;
  const live = offers.filter((o) => o && !o.supersededBy && o.status !== "draft" && o.address)
    .sort((a, b) => Number(OPEN.has(b.status) || Boolean(b.deal)) - Number(OPEN.has(a.status) || Boolean(a.deal)) || at(b) - at(a));
  const named = events.filter((e) => e?.type === "subject_property_set" && e.address && now - (Date.parse(e.at || "") || 0) <= NAMED_DAYS * DAY_MS)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
  const offer = live[0] || null;
  // A house named after the newest offer is the one in play now.
  if (named && (!offer || (Date.parse(named.at) || 0) > at(offer)) && !(offer && addressKey(offer.address) === addressKey(named.address))) {
    const sameAsOffer = live.find((o) => addressKey(o.address) === addressKey(named.address) || sameStreetLoose(o.address, named.address));
    return { address: named.address, offer: sameAsOffer || null, source: sameAsOffer ? "offer" : "named", namedEvent: named };
  }
  if (offer) return { address: offer.address, offer, source: "offer" };
  const drafted = offers.filter((o) => o?.status === "draft" && o.address).sort((a, b) => at(b) - at(a))[0];
  if (drafted) return { address: drafted.address, offer: drafted, source: "held" };
  if (/^\s*\d+\s+\S+/.test(String(cardName || ""))) return { address: String(cardName).trim(), offer: null, source: "card" };
  return null;
}

/**
 * screenTierOne({ house, events, focusKinds, assetType, saysTurnkey, saysGone, lastInboundAt, now })
 *   → { ok, flags: [{ key, label, why, sure }] }
 *
 * The machine's first look at a Tier 1 card, so Matt only reads the ones
 * worth reading. Agents oversell; the flags say why a card probably isn't a
 * live flip. `ok` ignores the soft ones.
 *
 *   house         pickHouse's answer (its offer may carry priceWatch / autoUnderwrite)
 *   assetType     the house's kind ("sfr", "multi_family", "manufactured") when known
 *   saysTurnkey   their latest words say it isn't a flip (the broker's isTurnkeyReply)
 *   saysGone      their latest words say it sold / is pending (the broker's houseGone)
 */
export function screenTierOne({ house = null, offers = [], events = [], focusKinds = ["sfr"], assetType = "", saysTurnkey = false, saysGone = false, lastInboundAt = null, now = Date.now() } = {}) {
  const flags = [];
  const add = (key, why, sure) => flags.push({ key, label: TIER_ONE_FLAGS[key], why, sure });
  const address = house?.address || "";
  const offer = house?.offer || null;
  if (!address || !parseUsAddress(address).houseNo) {
    add("no_house", address ? `"${streetOf(address)}" has no house number` : "no house in the app for this card", true);
    return { ok: false, flags };
  }
  const street = streetOf(address);
  const mine = events.filter((e) => e?.address && (addressKey(e.address) === addressKey(address) || sameStreetLoose(e.address, address)));

  // Gone: we marked it so, the price watch saw it leave, or they said so.
  const pw = offer?.priceWatch || {};
  const off = mine.filter((e) => e.type === "listing_off_market").sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
  const back = off && mine.some((e) => e.type === "listing_back_on_market" && String(e.at) > String(off.at));
  if (offer?.status === "unavailable") add("gone", `${street} is marked no longer available`, true);
  else if (pw.offMarketAt && !(pw.backOnMarketAt && pw.backOnMarketAt > pw.offMarketAt)) add("gone", `${street} left the market ${String(pw.offMarketAt).slice(5, 10)}`, true);
  else if (off && !back) add("gone", `${street} left the market ${String(off.at).slice(5, 10)}`, true);
  else if (GONE_STATUS.test(String(pw.status || ""))) add("gone", `Zillow says ${String(pw.status).toLowerCase().replace(/_/g, " ")}`, true);
  else if (saysGone) add("gone", "their last text says it's pending or sold", false);

  // Not a flip: they told us so.
  const turnkeyNamed = mine.some((e) => e.type === "subject_property_set" && e.data?.notOurKind);
  if (turnkeyNamed) add("turnkey", "they said it's move-in ready, not a flip", true);
  else if (saysTurnkey) add("turnkey", "their last text says it's finished or turnkey", false);

  // The kind of house: we buy single-family (settings.focusKinds).
  const kindHeld = (offer?.autoUnderwrite?.held || []).some((h) => /^not our kind of house\b/i.test(String(h)));
  if (kindHeld || (assetType && !focusKinds.includes(assetType))) add("not_sfr", kindHeld ? "the underwrite held it: not our kind of house" : `it's ${assetType.replace(/_/g, "-")}`, true);

  // Rural: two acres or more (Matt, 2026-10-08) — the underwrite held it, or
  // the lot on the offer says so.
  const ruralHeld = (offer?.autoUnderwrite?.held || []).find((h) => RURAL_HOLD.test(String(h)));
  const lot = offer?.snapshot?.subjectInfo?.lotSqft ?? offer?.draft?.subjectInfo?.lotSqft ?? null;
  if (ruralHeld || isRuralLot(lot)) add("rural", ruralHeld ? `the underwrite held it: ${String(ruralHeld).split(" (")[0].replace(/^rural — /, "")}` : `it sits on ${acresText(lot)} acres`, true);

  const passed = passedOnHouse({ offers, events, address });
  if (passed) add("passed", passed.why, true);
  else if (offer?.status === "passed") add("passed", "they passed on our offer", false);

  // Quiet: nothing from them and nothing priced in three weeks.
  const spoke = Date.parse(lastInboundAt || "") || 0;
  const priced = Math.max(...[offer?.statusAt, offer?.updatedAt, offer?.createdAt, house?.namedEvent?.at].map((t) => Date.parse(t || "") || 0));
  if (now - spoke > STALE_DAYS * DAY_MS && now - priced > STALE_DAYS * DAY_MS) add("stale", spoke ? `nothing from them since ${new Date(spoke).toISOString().slice(5, 10)}` : "they've never written back", false);

  return { ok: !flags.some((f) => f.key !== "stale"), flags };
}

/* ---------- moving the card ---------- */

// GHL stage names (shared/ghl-stages.js stageKeys) a move may start from.
const FROM = {
  passed: new Set(["newLead", "contacted", "tier1", "tier2", "tier3", "offerOut", "negotiations"]),
  notGood: new Set(["newLead", "contacted", "tier1", "tier2", "tier3", "offerOut", "negotiations"]),
  offerOut: new Set(["newLead", "contacted", "tier1", "tier2", "tier3"]),
  tier1: new Set(["newLead", "contacted", "tier2", "tier3", "passed", "notGood"]),
};

/**
 * cardMove({ cards, acq, keys, to }) → { opportunityId, stageId, from, to, status? } | { create: true, stageId, to } | { skip }
 *
 * Pure. `cards` are the contact's opportunities in the Acquisitions pipeline
 * (raw GHL rows: id, pipelineStageId, status); `keys` is stageKeys(acq).
 * Never a contract stage, never a contact with two open cards. A closed (lost
 * or abandoned) card is reopened only to go back to Tier 1.
 */
export function cardMove({ cards = [], acq = null, keys = {}, to } = {}) {
  const stageId = keys[to];
  if (!acq?.id || !stageId) return { skip: `no ${to} stage in the Acquisitions pipeline` };
  const keyOf = new Map(Object.entries(keys).map(([k, id]) => [id, k]));
  const nameOf = new Map((acq.stages || []).map((s) => [s.id, String(s.name || "").trim()]));
  const mine = (cards || []).filter((c) => c && (!c.pipelineId || c.pipelineId === acq.id));
  const open = mine.filter((c) => String(c.status || "open") === "open");
  if (open.length > 1) return { skip: "two open cards — a person's call" };
  const card = open[0] || (to === "tier1" ? mine.sort((a, b) => String(b.updatedAt || b.lastStageChangeAt || "").localeCompare(String(a.updatedAt || a.lastStageChangeAt || "")))[0] : null);
  if (!card) return to === "tier1" ? { create: true, stageId, to: nameOf.get(stageId) || to } : { skip: "no open card in Acquisitions" };
  const closed = String(card.status || "open") !== "open";
  const at = keyOf.get(card.pipelineStageId);
  const from = nameOf.get(card.pipelineStageId) || at || card.pipelineStageId;
  if (at === "contract") return { skip: `left at ${from} — a contract stage` };
  if (!closed && card.pipelineStageId === stageId) return { skip: `already in ${from}` };
  if (!closed && !FROM[to]?.has(at)) return { skip: `left at ${from}` };
  return { opportunityId: card.id, stageId, from, to: nameOf.get(stageId) || to, ...(closed ? { status: "open" } : {}) };
}

/* ---------- the morning clear-out (tierOne.autoKick, ships off) ---------- */

// The flags sure enough for the machine to take a card off Tier 1 alone. A
// missing house waits a week (they may still send the address); anything
// soft — their words only, or just quiet — stays for Matt.
const AUTO_KICK_KEYS = ["gone", "turnkey", "not_sfr", "rural", "passed"];
export const NO_HOUSE_WAIT_DAYS = 7;
export const ADDED_GRACE_DAYS = 7;

/**
 * autoKickPlan({ rows, now }) → [{ contactId, opportunityId, offerId, address, reason, flags }]
 *
 * Pure. `rows` are the Tier 1 list's rows (ghl-broker/tier-one.js loadTierOne),
 * each with `addedAt` (last put on Tier 1 by hand) and `chasing` (an address
 * we're still waiting on). Never a card added by hand in the last week.
 */
export function autoKickPlan({ rows = [], now = Date.now() } = {}) {
  const days = (t) => { const ms = Date.parse(t || ""); return Number.isFinite(ms) ? (now - ms) / DAY_MS : Infinity; };
  const out = [];
  for (const r of rows || []) {
    if (!r?.contactId || r.ok) continue;
    if (days(r.addedAt) < ADDED_GRACE_DAYS) continue;
    const sure = (r.flags || []).filter((f) => f.sure);
    let reason = sure.find((f) => AUTO_KICK_KEYS.includes(f.key))?.key || "";
    if (!reason && sure.some((f) => f.key === "no_house") && !r.chasing && days(r.inStageSince) >= NO_HOUSE_WAIT_DAYS) reason = "no_house";
    if (!reason) continue;
    out.push({ contactId: r.contactId, opportunityId: r.opportunityId || null, offerId: r.offer?.id || null, address: r.house?.address || "", reason, flags: (r.flags || []).map((f) => f.key) });
  }
  return out;
}
