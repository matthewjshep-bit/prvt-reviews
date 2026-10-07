// tier-one.js — the Tier 1 list: GHL's Acquisitions "Tier 1" stage, read into
// the app and screened (Matt, 2026-10-07).
//
// GHL's Tier 1 is the list Matt works by hand and his source of truth. The
// app's own "Tier 1" (shared/tiers.js) counted any open offer of any age and
// never matched it. This reads the cards in that stage, finds the house each
// is about, and runs the machine's first look over it (shared/tier-one.js
// screenTierOne) — sold, turnkey, not single-family, no house, already passed.
// Then he does one of two things per card:
//
//   Pass     — the house's offer → we passed (stops machine texts about it),
//              a tier1_passed event (so a house never priced counts too),
//              card → Passed on Offer, tier-1 tag off. Never tier-2: GHL's
//              "Tier 2+3 nurture" would text them; the app's agent check-in
//              is the nurture and never names the passed house.
//   Offer →  — the work pane; sending the written offer moves the card to
//              Offer Out (routes/offers.js moveCardToOfferOut).
//
// Kick out is Pass for a card that shouldn't have been there (gone, turnkey,
// no house): card → Not a Good Deal. Add puts an agent the app thinks belongs
// on GHL's Tier 1. Nothing moves while the GHL mirror owns the board.
//
// Runners take `store` and `deps` (ghl: the GHL calls; operatorStatus: the
// offers router's applyOperatorStatus). Log lines carry ids and counts only.

import { store as defaultStore } from "./store.js";
import { listPipelines, searchOpportunities, updateOpportunity, createOpportunity, getOpportunity, removeContactTags } from "./ghl.js";
import { acquisitionsPipeline, pipelinesFor } from "./ghl-mirror.js";
import { listAcquisitionOpportunities } from "./tier-check.js";
import { recordEvent } from "./contact-record.js";
import { mapPool } from "./map-pool.js";
import { isTurnkeyReply } from "./reply-agent.js";
import { stageKeys } from "./shared/ghl-stages.js";
import { pickHouse, screenTierOne, cardMove, autoKickPlan, normalizeTierOne } from "./shared/tier-one.js";
import { annotateCurrent } from "./shared/current-offer.js";
import { assetOf, normalizeFocusKinds } from "./shared/asset-type.js";
import { normalizeMirror } from "./shared/ghl-mirror.js";
import { houseGone } from "./shared/held-underwrites.js";
import { effectiveStatus, isHot, OPEN_STATUSES } from "./shared/offer-status.js";

const DAY_MS = 86400000;
const WORDS_DAYS = 14;          // their last text counts for the screen this long
const BELONGS_MAX = 40;
const LATER_STAGES = ["tier1", "offerOut", "negotiations", "contract"];

const defaultGhl = { listPipelines, searchOpportunities, updateOpportunity, createOpportunity, getOpportunity, removeContactTags, listAcquisitionOpportunities };
const apiOf = (deps = {}) => ({ ...defaultGhl, ...(deps.ghl || {}) });

export const mirrorOwnsBoard = (saved = {}) => normalizeMirror(saved?.ghlMirror).enabled;

// Their last words, from the timeline: the newest text summary that carries
// their message, and when they last wrote or called.
function theirWords(events = [], now = Date.now()) {
  const inbound = events.filter((e) => (e?.type === "text_summary" && String(e.data?.inbound || "").trim()) || e?.type === "call_summary")
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  const lastInboundAt = inbound[0]?.at || null;
  const text = inbound.find((e) => e.type === "text_summary" && now - (Date.parse(e.at || "") || 0) <= WORDS_DAYS * DAY_MS);
  return { lastInboundAt, text: text ? String(text.data.inbound).trim() : "", textAt: text?.at || null };
}

// What the row shows of the offer: numbers, never the whole document.
function offerSummary(o) {
  if (!o) return null;
  return {
    id: o.id, status: effectiveStatus(o), cashAmount: o.cashAmount ?? null, arv: o.arv ?? null, repairs: o.repairs ?? null,
    askingPrice: o.askingPrice ?? null, hot: isHot(o), sent: (o.sends || []).some((s) => Object.values(s?.results || {}).some((r) => r?.ok) || !s?.results),
    createdAt: o.createdAt || null, statusAt: o.statusAt || null, deal: o.deal ? { stage: o.deal.stage } : null,
  };
}

/**
 * screenContact({ store, locationId, contactId, offers, focusKinds, cardName, now }) → { house, screen, words, events }
 *
 * One agent's house and the machine's first look at it.
 */
async function screenContact({ store, locationId, contactId, offers = [], focusKinds, cardName = "", now }) {
  const events = (await store.listContactEvents(locationId, contactId, { limit: 300 }).catch(() => [])) || [];
  const house = pickHouse({ offers, events, cardName, now });
  if (house?.offer?.id) {
    // The lean row has no price watch or hold reasons; the screen wants both.
    const full = await store.getOffer(house.offer.id).catch(() => null);
    if (full) house.offer = { ...house.offer, priceWatch: full.priceWatch || null, autoUnderwrite: full.autoUnderwrite || house.offer.autoUnderwrite, asset: full.asset || house.offer.asset, snapshot: full.snapshot };
  }
  const words = theirWords(events, now);
  const screen = screenTierOne({
    house, offers, events, focusKinds,
    assetType: house?.offer ? assetOf(house.offer)?.type || "" : "",
    saysTurnkey: Boolean(words.text) && isTurnkeyReply(words.text),
    saysGone: Boolean(words.text) && houseGone(words.text),
    lastInboundAt: words.lastInboundAt, now,
  });
  if (house?.offer) delete house.offer.snapshot;
  return { house, screen, words, events };
}

/**
 * loadTierOne({ client, locationId, saved, store, roster, deps, now })
 *   → { ok, rows, belongs, counts, mirrorOwnsBoard }
 *
 * rows     GHL's open Tier 1 cards, each with its house, our numbers and flags
 * belongs  agents the app reads as Tier 1 (shared/tiers.js, `roster`), clean on
 *          the screen, with no card at Tier 1 or later — candidates to add
 */
export async function loadTierOne({ client, locationId, saved = {}, store = defaultStore, roster = null, read = null, deps = {}, now = Date.now() }) {
  const api = apiOf(deps);
  // `read`: the morning tier check's own read of the board, so it isn't read twice.
  const acq = acquisitionsPipeline(read?.pipelines || await pipelinesFor(client, locationId, { ghl: api, now }));
  if (!acq) return { ok: false, error: "no Acquisitions pipeline with Tier 1/2/3 stages in GHL", rows: [], belongs: [], counts: {} };
  const keys = stageKeys(acq);
  const opps = read?.opportunities || await api.listAcquisitionOpportunities(client, locationId, acq.id);
  const open = (opps || []).filter((o) => o?.contactId && String(o.status || "open") === "open");
  const tier1 = open.filter((o) => o.pipelineStageId === keys.tier1);
  const atOrPast = new Set(open.filter((o) => LATER_STAGES.some((k) => keys[k] && o.pipelineStageId === keys[k])).map((o) => o.contactId));
  const openCount = new Map();
  for (const o of open) openCount.set(o.contactId, (openCount.get(o.contactId) || 0) + 1);

  const book = annotateCurrent((await store.listOffers(locationId, { limit: 5000, lean: true }).catch(() => [])) || []);
  const offersBy = new Map();
  for (const o of book) { if (!o?.contactId) continue; if (!offersBy.has(o.contactId)) offersBy.set(o.contactId, []); offersBy.get(o.contactId).push(o); }
  const focusKinds = normalizeFocusKinds(saved?.focusKinds);

  const rowFor = async ({ contactId, name, card = null }) => {
    const offers = offersBy.get(contactId) || [];
    const { house, screen, words, events } = await screenContact({ store, locationId, contactId, offers, focusKinds, cardName: card?.name || "", now });
    // Put on Tier 1 by hand lately, and an address we're still waiting on:
    // the morning clear-out leaves both alone (shared/tier-one.js autoKickPlan).
    const addedAt = events.filter((e) => e?.type === "tier1_added").map((e) => e.at).sort().at(-1) || null;
    const pending = events.filter((e) => e?.type === "address_pending").map((e) => e.at).sort().at(-1);
    const chasing = Boolean(pending) && !events.some((e) => e?.type === "address_pending_closed" && String(e.at) >= String(pending));
    return {
      contactId,
      name: name || offers.find((o) => o.contactName)?.contactName || "",
      opportunityId: card?.id || null,
      inStageSince: card ? card.lastStageChangeAt || card.updatedAt || card.createdAt || null : null,
      openCards: openCount.get(contactId) || 0,
      house: house ? { address: house.address, source: house.source } : null,
      offer: offerSummary(house?.offer),
      ok: screen.ok,
      flags: screen.flags,
      lastInboundAt: words.lastInboundAt,
      lastWord: words.text ? { at: words.textAt, text: words.text.slice(0, 240) } : null,
      addedAt, chasing,
    };
  };

  const rows = await mapPool(tier1, 6, (card) => rowFor({ contactId: card.contactId, name: card.contact?.name || card.name || "", card }));
  // Flagged cards first (they're the ones to clear), then the longest in Tier 1.
  rows.sort((a, b) => Number(a.ok) - Number(b.ok) || String(a.inStageSince || "").localeCompare(String(b.inStageSince || "")));

  if (deps.skipBelongs) return { ok: true, rows, belongs: [], counts: { tier1: rows.length, flagged: rows.filter((r) => !r.ok).length }, mirrorOwnsBoard: mirrorOwnsBoard(saved) };
  const candidates = (roster?.rows || []).filter((r) => r.tier === "t1" && r.contactId && !atOrPast.has(r.contactId)).slice(0, BELONGS_MAX * 2);
  const screened = await mapPool(candidates, 6, (r) => rowFor({ contactId: r.contactId, name: r.name }));
  const belongs = screened.filter((r) => r.ok && !r.flags.some((f) => f.key === "stale") && r.house?.address).slice(0, BELONGS_MAX);

  const counts = { tier1: rows.length, flagged: rows.filter((r) => !r.ok).length, clean: rows.filter((r) => r.ok).length, belongs: belongs.length };
  console.log(`tier-one: loc=${locationId} tier1=${counts.tier1} flagged=${counts.flagged} belongs=${counts.belongs}`);
  return { ok: true, rows, belongs, counts, mirrorOwnsBoard: mirrorOwnsBoard(saved) };
}

/**
 * moveCard({ client, locationId, contactId, to, name, deps, now }) → { opportunityId, from, to, verified } | { skip } | { created }
 *
 * One Acquisitions card to a stage, read back by id (search lags).
 */
export async function moveCard({ client, locationId, contactId, to, name = "", deps = {}, now = Date.now() }) {
  const api = apiOf(deps);
  const acq = acquisitionsPipeline(await pipelinesFor(client, locationId, { ghl: api, now }));
  if (!acq) return { skip: "no Acquisitions pipeline with Tier 1/2/3 stages" };
  const cards = (await api.searchOpportunities(client, locationId, { contactId, pipelineId: acq.id }))
    .map((c) => ({ ...c, pipelineStageId: c.stageId }));
  const move = cardMove({ cards, acq, keys: stageKeys(acq), to });
  if (move.skip) return move;
  if (move.create) {
    const made = await api.createOpportunity(client, { locationId, pipelineId: acq.id, contactId, name: name || "Agent", stageId: move.stageId });
    return { created: true, opportunityId: made.id, to: move.to, verified: Boolean(made.id) };
  }
  await api.updateOpportunity(client, move.opportunityId, { stageId: move.stageId, ...(move.status ? { status: move.status } : {}) });
  const back = await api.getOpportunity(client, move.opportunityId).catch(() => null);
  return { opportunityId: move.opportunityId, from: move.from, to: move.to, verified: back?.stageId === move.stageId };
}

const refused = (status, error) => Object.assign(new Error(error), { http: status });

// The offer a pass is about: the one named, else the house the card is about.
async function offerToClose({ store, locationId, contactId, offerId, now }) {
  const offers = annotateCurrent((await store.listOffers(locationId, { contactId, limit: 100, lean: true }).catch(() => [])) || []);
  const events = (await store.listContactEvents(locationId, contactId, { limit: 300 }).catch(() => [])) || [];
  const lean = offerId ? offers.find((o) => o.id === offerId) : pickHouse({ offers, events, now })?.offer;
  const house = offerId ? (lean ? { address: lean.address } : null) : pickHouse({ offers, events, now });
  const full = lean?.id ? await store.getOffer(lean.id).catch(() => null) : null;
  return { offer: full && full.locationId === locationId ? full : null, address: house?.address || "", events };
}

async function closeHouse({ client, locationId, saved, store, contactId, offerId, address, status, eventType, to, why, by, flags, deps, now }) {
  if (mirrorOwnsBoard(saved)) throw refused(409, "the GHL mirror owns the board — turn it off to move cards from here");
  const api = apiOf(deps);
  const found = await offerToClose({ store, locationId, contactId, offerId, now });
  if (found.offer?.deal) throw refused(409, "that house is a deal — its stage lives on the deal");
  const house = address || found.address || found.offer?.address || "";
  let offerStatus = null;
  const live = found.offer && (OPEN_STATUSES.has(effectiveStatus(found.offer)) || found.offer.status === "draft");
  if (live && typeof deps.operatorStatus === "function") {
    await deps.operatorStatus({ locationId, client, offer: found.offer, status, note: why });
    offerStatus = status;
  }
  await recordEvent({ store, locationId, contactId, party: "agent", type: eventType, address: house, offerId: found.offer?.id || null,
    source: "tier_one", data: { by, why, flags: (flags || []).map((f) => (typeof f === "string" ? f : f?.key)).filter(Boolean) } });
  // An address we were still chasing is settled by the pass.
  const pending = found.events.filter((e) => e?.type === "address_pending").sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
  if (pending && !found.events.some((e) => e?.type === "address_pending_closed" && String(e.at) >= String(pending.at))) {
    await recordEvent({ store, locationId, contactId, party: "agent", type: "address_pending_closed", source: "tier_one", data: { why } });
  }
  const card = await moveCard({ client, locationId, contactId, to, deps, now }).catch((e) => ({ error: String(e?.message || e).slice(0, 160) }));
  if (card.opportunityId) {
    await recordEvent({ store, locationId, contactId, party: "agent", type: "ghl_stage_moved", address: house, source: "tier_one", data: { from: card.from, to: card.to, why } });
  }
  // Off GHL's Tier 1 by tag too. Never tier-2: GHL starts its nurture on it.
  let tagRemoved = false;
  try {
    await api.removeContactTags(client, contactId, ["tier-1"]);
    tagRemoved = true;
    await recordEvent({ store, locationId, contactId, party: "agent", type: "tag_removed", source: "tier_one", data: { tag: "tier-1" } });
  } catch { /* the card move stands */ }
  console.log(`tier-one: ${eventType} loc=${locationId} contact=${contactId} offer=${found.offer?.id || "-"} card=${card.opportunityId ? (card.verified ? "moved" : "unverified") : card.skip ? "skipped" : card.error ? "error" : "-"}`);
  return { ok: true, address: house, offerId: found.offer?.id || null, offerStatus, card, tagRemoved };
}

/** passTierOne — we looked and it isn't ours: we passed, card → Passed on Offer. */
export function passTierOne({ client, locationId, saved = {}, store = defaultStore, contactId, offerId = null, address = "", by = "you", flags = [], deps = {}, now = Date.now() }) {
  return closeHouse({ client, locationId, saved, store, contactId, offerId, address, status: "we_passed", eventType: "tier1_passed", to: "passed",
    why: "passed from Tier 1", by, flags, deps, now });
}

/** kickTierOne — it never belonged (gone, turnkey, no house): card → Not a Good Deal. */
export function kickTierOne({ client, locationId, saved = {}, store = defaultStore, contactId, offerId = null, address = "", reason = "", by = "you", flags = [], deps = {}, now = Date.now() }) {
  const gone = reason === "gone";
  return closeHouse({ client, locationId, saved, store, contactId, offerId, address, status: gone ? "unavailable" : "we_passed", eventType: "tier1_kicked", to: "notGood",
    why: gone ? "off Tier 1: sold or off the market" : `off Tier 1${reason ? `: ${reason.replace(/_/g, " ")}` : ""}`, by, flags, deps, now });
}

/** addTierOne — the app reads them as Tier 1 and GHL doesn't: card → Tier 1. */
export async function addTierOne({ client, locationId, saved = {}, store = defaultStore, contactId, address = "", name = "", by = "you", deps = {}, now = Date.now() }) {
  if (mirrorOwnsBoard(saved)) throw refused(409, "the GHL mirror owns the board — turn it off to move cards from here");
  const card = await moveCard({ client, locationId, contactId, to: "tier1", name, deps, now });
  if (card.skip) throw refused(409, `GHL card not moved: ${card.skip}`);
  await recordEvent({ store, locationId, contactId, party: "agent", type: "tier1_added", address, source: "tier_one", data: { by } });
  if (card.opportunityId) {
    await recordEvent({ store, locationId, contactId, party: "agent", type: "ghl_stage_moved", address, source: "tier_one", data: { from: card.from || "", to: card.to, why: "added to Tier 1" } });
  }
  console.log(`tier-one: tier1_added loc=${locationId} contact=${contactId} card=${card.created ? "created" : card.verified ? "moved" : "unverified"}`);
  return { ok: true, card };
}

/**
 * runTierOneScreen({ client, locationId, saved, store, read, deps, now }) → { on, planned, applied, kicks, errors }
 *
 * The 7am tier check's last step. Always plans which Tier 1 cards are sure
 * misses (shared/tier-one.js autoKickPlan) and keeps the plan as a report —
 * ids and reasons, never a name. Kicks them only with tierOne.autoKick on
 * (ships off), at most autoKickMax a morning, marked as the machine's.
 */
export async function runTierOneScreen({ client, locationId, saved = {}, store = defaultStore, read = null, deps = {}, now = Date.now() }) {
  const cfg = normalizeTierOne(saved?.tierOne);
  const out = { on: cfg.autoKick, planned: 0, applied: 0, kicks: [], errors: [] };
  if (mirrorOwnsBoard(saved)) { out.errors.push("the GHL mirror owns the board"); return out; }
  const list = await loadTierOne({ client, locationId, saved, store, read, deps: { ...deps, skipBelongs: true }, now });
  if (!list.ok) { out.errors.push(list.error || "couldn't read Tier 1"); return out; }
  const plan = autoKickPlan({ rows: list.rows, now });
  out.planned = plan.length;
  let left = cfg.autoKick ? cfg.autoKickMax : 0;
  for (const k of plan) {
    const row = { contactId: k.contactId, opportunityId: k.opportunityId, offerId: k.offerId, reason: k.reason };
    if (left > 0) {
      try {
        const r = await kickTierOne({ client, locationId, saved, store, contactId: k.contactId, offerId: k.offerId, address: k.address, reason: k.reason, by: "machine", flags: k.flags, deps, now });
        row.applied = Boolean(r.card?.opportunityId);
        if (row.applied) out.applied++;
        left--;
      } catch (e) { out.errors.push(`${k.contactId}: ${String(e?.message || e).slice(0, 160)}`); }
    }
    if (out.kicks.length < 60) out.kicks.push(row);
  }
  console.log(`tier-one: morning screen loc=${locationId} on=${cfg.autoKick} planned=${out.planned} applied=${out.applied}`);
  return out;
}
