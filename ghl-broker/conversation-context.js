// conversation-context.js — what we know about the person texting us, in the
// terms the model needs and nothing else.
//
// Two record books, one per party. An agent's is the offer book: what we
// offered, on which house, at what price, and what happened. An investor's is
// the deal book: their buy box, the deals they're already on, the live deals
// that fit them, and whether they've opened the dataroom links we sent. Each
// builder returns the text block for the prompt PLUS two lists of numbers —
// the ones the reply may quote, and the ones it must never say. The money
// guard in reply-agent.js is only as good as those lists.
//
// The loaders do I/O; the builders are pure and tested.

import { fmtMoney } from "./shared/offer-calc.js";
import { effectiveStatus } from "./shared/offer-status.js";
import { normalizeBuybox, buildBuyboxProfile, matchBuybox } from "./shared/buybox.js";
import { dealToQuery } from "./dispo.js";
import { dealNumbers } from "./dataroom.js";
import { enrichFieldDefs } from "./enrich.js";
import { customFieldIdKeyMapForDefs, contactCustomRecord } from "./ghl.js";

export const RA_OFFERS_IN_CONTEXT = 8;    // the agent's most recent offers, newest first
export const MATCHING_DEALS_MAX = 5;
export const INVESTOR_DEAL_STAGES = new Set(["under_contract", "buyer_found"]);

const daysAgo = (iso, now) => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 86400000)) : null;
};
const agoWord = (d) => (d == null ? "" : d === 0 ? "today" : `${d} day${d === 1 ? "" : "s"} ago`);
const dateWord = (iso) => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "";
};

/* ---------- the contact's own fields ---------- */

// The enrichment fields both parties share, plus each party's own. Read by
// OUR key names through customFieldIdKeyMapForDefs — GHL derives its own key
// from the display name and they drift.
const AGENT_FIELD_KEYS = ["subject_property", "agent_market_area", "personal_details", "last_convo_summary", "suggested_next_action"];
const INVESTOR_FIELD_KEYS = ["personal_details", "last_convo_summary", "suggested_next_action"];

export async function loadContactContext({ client, locationId, contact }) {
  let custom = {};
  try {
    const defs = [...enrichFieldDefs("agent"), ...enrichFieldDefs("investor")];
    const idKeyMap = await customFieldIdKeyMapForDefs(client, locationId, defs);
    custom = contactCustomRecord(contact, idKeyMap);
  } catch { /* no custom-field scope, or an offline test client — the thread still carries the conversation */ }
  return custom;
}

const FIELD_LABEL = {
  subject_property: "the property they're currently discussing with us",
  agent_market_area: "areas they work",
  personal_details: "personal details they've shared",
  last_convo_summary: "our last conversation, summarised",
  suggested_next_action: "the next step we had planned",
};

export function fieldLines(custom = {}, keys = []) {
  const out = [];
  for (const k of keys) {
    const v = String(custom?.[k] ?? "").trim();
    if (v) out.push(`- ${FIELD_LABEL[k] || k}: ${v.slice(0, 400)}`);
  }
  return out;
}

/* ---------- the agent's book ---------- */

const statusWord = (s) => ({
  draft: "draft (not sent)", new: "not sent yet", sent: "sent, waiting on the agent",
  countered: "agent countered", no_response: "no response", passed: "agent passed", accepted: "accepted",
}[s] || s || "unknown");

// The offer book, newest first, capped, and every number here is a number the
// reply is ALLOWED to say. Unchanged from the first version except that the
// asking price now actually arrives (see toListOffer in shared/offer-status.js).
export function summarizeOffers(offers = [], { now = Date.now() } = {}) {
  const rows = [...offers]
    .filter((o) => o && o.address)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, RA_OFFERS_IN_CONTEXT);
  const lines = [];
  const amounts = new Set();
  for (const o of rows) {
    const status = effectiveStatus(o);
    const amount = Number(o.cashAmount) || 0;
    if (amount) amounts.add(amount);
    const asking = Number(o.askingPrice ?? o.inputs?.askingPrice ?? o.calc?.inputs?.askingPrice) || 0;
    if (asking) amounts.add(asking);
    const lastSend = (o.sends || []).filter((s) => s && s.ts).sort((a, b) => String(b.ts).localeCompare(String(a.ts)))[0];
    const age = daysAgo(lastSend?.ts || o.createdAt, now);
    const parts = [
      `${o.address}:`,
      amount ? `our cash offer ${fmtMoney(amount)}` : status === "draft" ? "still being underwritten (no number yet)" : "no amount recorded",
      asking ? `(asking ${fmtMoney(asking)})` : "",
      `— status: ${statusWord(status)}`,
      lastSend ? `sent ${agoWord(age)} by ${(lastSend.channels || []).join("+") || "message"}` : status === "draft" ? "" : "not sent yet",
      o.validLabel ? `valid ${o.validLabel}` : "",
      o.statusNote ? `note: ${String(o.statusNote).slice(0, 120)}` : "",
    ].filter(Boolean);
    lines.push(`- ${parts.join(" ")}`);
  }
  return { text: lines.join("\n"), amounts: [...amounts], count: rows.length };
}

export function buildAgentContext({ offers, custom = {}, now = Date.now() }) {
  const book = summarizeOffers(offers, { now });
  const fields = fieldLines(custom, AGENT_FIELD_KEYS);
  const text = [
    book.count
      ? `OUR OFFERS TO THIS AGENT (newest first — the only numbers you may quote):\n${book.text}`
      : "OUR OFFERS TO THIS AGENT: none on record.",
    fields.length ? `WHAT WE KNOW ABOUT THEM:\n${fields.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  return { text, amounts: book.amounts, forbiddenAmounts: [], offers: book, summary: { offers: book.count, fields: fields.length } };
}

export async function loadAgentContext({ store, locationId, contactId, custom = {}, now = Date.now() }) {
  const rows = await store.listOffers(locationId, { contactId, limit: 25, lean: true }).catch(() => []);
  return buildAgentContext({ offers: rows, custom, now });
}

/* ---------- the investor's book ---------- */

// The price an investor may be quoted on a deal, and the two figures behind
// it that they must never hear. A dataroom's own headline wins when one
// exists — that is the number the investor has already seen — otherwise the
// deal's arithmetic. Both come from the same place the dataroom prints from.
export function investorFacingPrice({ offer, room = null, settings = {} }) {
  const base = dealNumbers({ offer, settings });
  const snap = room?.snapshot?.numbers || null;
  const price = Number(snap?.investorPrice) > 0 ? Number(snap.investorPrice) : base.investorPrice;
  const arv = Number(snap?.arv) > 0 ? Number(snap.arv) : base.arv;
  const repairs = Number(snap?.repairs) > 0 ? Number(snap.repairs) : base.repairs;
  const forbidden = [base.contractPrice, base.assignmentFee, Number(snap?.contractPrice) || 0, Number(snap?.assignmentFee) || 0, Number(offer?.cashAmount) || 0]
    .map((n) => Math.round(n)).filter((n) => n > 0);
  return { price: Math.round(price) || 0, arv: Math.round(arv) || 0, repairs: Math.round(repairs) || 0, forbidden };
}

const dealLine = (d) => {
  const money = [
    d.price ? `buyer price ${fmtMoney(d.price)}` : "price not set yet",
    d.arv ? `ARV ${fmtMoney(d.arv)}` : "",
    d.repairs ? `est. repairs ${fmtMoney(d.repairs)}` : "",
  ].filter(Boolean).join(", ");
  const status = d.linkStatus ? ` — they are ${d.linkStatus === "sent" ? "sent it, no answer yet" : d.linkStatus}` : "";
  const stage = d.stage === "buyer_found" ? " — a buyer is already lined up" : "";
  const invite = d.invite
    ? ` — dataroom link sent ${dateWord(d.invite.sentAt || d.invite.createdAt)}${d.invite.viewCount ? `, opened ${d.invite.viewCount}× (last ${dateWord(d.invite.lastViewedAt)})` : ", not opened yet"}`
    : "";
  return `- ${d.address}: ${money}${status}${stage}${invite}`;
};

/**
 * buildInvestorContext({ investor, deals, invites, custom, now })
 *
 * `deals` — [{ offer, room }] for every live deal; `invites` — the investor's
 * dataroom invites. Pure. Returns { text, amounts, forbiddenAmounts, summary }.
 */
export function buildInvestorContext({ investor = {}, deals = [], invites = [], custom = {}, contactId = "", now = Date.now() }) {
  const buybox = investor.buybox || normalizeBuybox(custom);
  const profile = buildBuyboxProfile({ ...investor, buybox }, { maxChars: 900 });
  const inviteByRoom = new Map();
  for (const i of invites) if (i?.dataroomId) inviteByRoom.set(i.dataroomId, i);

  const amounts = new Set();
  const forbidden = new Set();
  if (buybox.priceMin) amounts.add(Math.round(buybox.priceMin));
  if (buybox.priceMax) amounts.add(Math.round(buybox.priceMax));

  const linked = [];
  const candidates = [];
  for (const { offer, room = null, settings = {} } of deals) {
    if (!offer?.deal || !INVESTOR_DEAL_STAGES.has(offer.deal.stage)) continue;
    const link = (offer.deal.investors || []).find((i) => i.contactId === contactId) || null;
    const n = investorFacingPrice({ offer, room, settings });
    const row = {
      address: offer.address || "a property", stage: offer.deal.stage, linkStatus: link?.status || null,
      price: n.price, arv: n.arv, repairs: n.repairs, invite: room ? inviteByRoom.get(room.id) || null : null,
      offerId: offer.id,
    };
    if (link) linked.push(row);
    else if (link?.status !== "passed") {
      const m = matchBuybox(buybox, dealToQuery(offer).query);
      if (m.pass) candidates.push({ ...row, score: m.score, matched: m.matched.length });
    }
    for (const x of [n.price, n.arv, n.repairs]) if (x) amounts.add(x);
    for (const f of n.forbidden) forbidden.add(f);
  }
  candidates.sort((a, b) => b.score - a.score || b.matched - a.matched || String(a.address).localeCompare(String(b.address)));
  const matching = candidates.slice(0, MATCHING_DEALS_MAX);

  // A figure that is both allowed and forbidden (a deal with no fee, where the
  // contract price IS the buyer price) is allowed — the guard must not flag
  // the one number we told the model to quote.
  const allowed = [...amounts];
  const forbiddenAmounts = [...forbidden].filter((n) => !amounts.has(n));

  const fields = fieldLines(custom, INVESTOR_FIELD_KEYS);
  const text = [
    `INVESTOR PROFILE (their buy box, as we understand it):\n${profile}`,
    linked.length ? `DEALS THEY ARE ALREADY ON:\n${linked.map(dealLine).join("\n")}` : "DEALS THEY ARE ALREADY ON: none.",
    matching.length
      ? `LIVE DEALS THAT FIT THEIR BUY BOX (you may bring these up; quote ONLY the buyer price):\n${matching.map(dealLine).join("\n")}`
      : "LIVE DEALS THAT FIT THEIR BUY BOX: none right now — say we'll reach out when something fits, and ask what they're after.",
    fields.length ? `WHAT WE KNOW ABOUT THEM:\n${fields.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");

  return {
    text, amounts: allowed, forbiddenAmounts,
    summary: { linkedDeals: linked.length, matchingDeals: matching.length, invites: invites.length, fields: fields.length, buyboxEmpty: !profile.includes("\n") },
    deals: { linked, matching },
  };
}

export async function loadInvestorContext({ store, locationId, contactId, contactName = "", custom = {}, settings = {}, now = Date.now() }) {
  let investor = { name: contactName, tags: [], buybox: null };
  try {
    const row = await store.getInvestor(locationId, contactId);
    if (row) {
      investor = {
        name: row.name || row.doc?.name || contactName,
        tags: row.doc?.tags || [],
        buybox: normalizeBuybox(row.doc?.custom || {}),
        lastConvoSummary: row.doc?.lastConvoSummary || custom.last_convo_summary || "",
        lastConvoDate: row.doc?.lastConvoDate || "",
        dealHistory: row.doc?.dealHistory || custom.investor_deal_history || "",
      };
    }
  } catch { /* no investors table yet, or a test store — the live fields below still describe them */ }
  if (!investor.buybox) {
    investor.buybox = normalizeBuybox(custom);
    investor.lastConvoSummary = investor.lastConvoSummary || custom.last_convo_summary || "";
    investor.dealHistory = investor.dealHistory || custom.investor_deal_history || "";
  }

  const offers = await (store.listDeals ? store.listDeals(locationId, { limit: 100 }) : Promise.resolve([])).catch(() => []);
  const deals = [];
  for (const offer of offers) {
    if (!INVESTOR_DEAL_STAGES.has(offer?.deal?.stage)) continue;
    let room = null;
    try {
      const rooms = await store.listDatarooms(locationId, { offerId: offer.id, limit: 5 });
      room = rooms.find((r) => r.status === "active" && r.kind !== "portfolio" && r.kind !== "offer") || null;
    } catch { /* rooms are decoration on the price; dealNumbers still answers */ }
    deals.push({ offer, room, settings });
  }
  let invites = [];
  try {
    if (store.listDataroomInvitesByContact) invites = await store.listDataroomInvitesByContact(locationId, contactId);
  } catch { /* the invite line is decoration */ }

  return buildInvestorContext({ investor, deals, invites, custom, contactId, now });
}
