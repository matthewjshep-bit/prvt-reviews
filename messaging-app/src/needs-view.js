// needs-view.js — the GHL "Needs Matt" list on the rows Matt already works
// (2026-11-23 audit, nav-3 and offers-your-move-tab, narrowed by the review):
// not a new queue and not a default tab (Matt retired Today on 10-20 because
// it kept refilling), just the reason on the row it is about, and a count on
// the Offers and Deals pills that filters to those rows.
//
// The list is GET /api/dashboard/needs-matt, one cursor read per load:
// [{ contactId, kind: "yes"|"paper"|"price", offerId, why, passAt }]. It is
// per agent; when it names an offer, the reason goes on that row (or the
// current row on its house), else on each of the agent's current rows.
//
// Pure, so the matching and the counts are tested without the page.

const LIVE = (o) => o?.deal && !["closed", "fell_through"].includes(o.deal.stage);

/** attachNeeds(rows, needs) → rows, a matched row carrying `needsMatt`. */
export function attachNeeds(rows = [], needs = []) {
  const byContact = new Map();
  for (const n of needs || []) if (n?.contactId && n.kind) byContact.set(n.contactId, n);
  if (!byContact.size) return rows;
  const byId = new Map(rows.map((o) => [o.id, o]));
  // The row a need names, moved on to its house's current row when a newer
  // offer replaced it.
  const named = (n) => {
    const o = n.offerId ? byId.get(n.offerId) : null;
    if (!o) return null;
    return o.supersededBy?.id && byId.has(o.supersededBy.id) ? o.supersededBy.id : o.id;
  };
  const target = new Map([...byContact.values()].map((n) => [n.contactId, named(n)]));
  return rows.map((o) => {
    const n = o.contactId ? byContact.get(o.contactId) : null;
    if (!n || o.supersededBy || o.status === "draft" && n.kind !== "price") return o;
    const t = target.get(o.contactId);
    if (t && t !== o.id) return o;
    return { ...o, needsMatt: n };
  });
}

/**
 * needsCounts(rows) → { offers, deals } — how many agents on the list have a
 * row on each page: a current offer that isn't a deal, a live deal.
 */
export function needsCounts(rows = []) {
  const offers = new Set();
  const deals = new Set();
  for (const o of rows) {
    if (!o?.needsMatt) continue;
    if (LIVE(o)) deals.add(o.contactId);
    else if (!o.deal) offers.add(o.contactId);
  }
  return { offers: offers.size, deals: deals.size };
}

const KIND_LABEL = { yes: "Approve", paper: "Paper", price: "Price it" };
export const needLabel = (n) => KIND_LABEL[n?.kind] || "Needs you";

/** "Tue 9am" — when the runner passes an unpriced house (Pacific, his clock). */
export function passWhen(at, now = Date.now()) {
  const t = Date.parse(at || "");
  if (!Number.isFinite(t)) return "";
  if (t <= now) return "now";
  const d = new Date(t);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: d.getUTCMinutes() ? "2-digit" : undefined, timeZone: "America/Los_Angeles" }).replace(" ", "").toLowerCase();
  const day = (x) => new Date(x).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" });
  if (day(t) === day(now)) return `today ${time}`;
  if (t - now < 6 * 86400000) return `${d.toLocaleDateString("en-US", { weekday: "short", timeZone: "America/Los_Angeles" })} ${time}`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
}

/** The pill's hover line: the why, and when the bot passes it if it will. */
export function needTitle(n, now = Date.now()) {
  if (!n) return "";
  const pass = n.passAt ? ` · the bot passes it ${passWhen(n.passAt, now)} unless you price it` : "";
  return `${n.why || "On the GHL Needs Matt stage"}${pass}`;
}
