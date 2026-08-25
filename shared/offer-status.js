// offer-status.js — the lifecycle of a single offer, from saved draft to
// accepted or dead. Shared by the broker (validation + auto-transitions) and
// the frontend (pills, filters, KPI math). Pure functions, no I/O, no deps.
//
// Why this exists: for most of this app's life an offer had no outcome. The
// only value `doc.status` ever held was "draft"; a real offer had no status key
// at all, and every check in the codebase was `=== "draft"` or `!== "draft"`.
// That made an offer sent yesterday indistinguishable from one an agent passed
// on three weeks ago — which is the exact signal a 120-offers-to-1-contract
// funnel runs on. So `status` is widened rather than replaced: every new value
// is still `!== "draft"`, so the dashboard's offer count and the enrichment
// skip both keep working untouched, and no backfill is needed.
//
// Two deliberate omissions:
//
//   "expired" is DERIVED, never stored. An offer whose validity date lapses is
//   still whatever you last recorded — letting a clock overwrite "passed" would
//   destroy the outcome you typed in. isExpired() is a display modifier only,
//   and only for statuses that are still waiting on someone.
//
//   "accepted" is not something you set by hand in the usual sense. It is the
//   promote-to-deal action wearing a status name, so there is exactly one way
//   to record an acceptance instead of two that can disagree.

// Display order is also funnel order: earliest state first, terminal last.
export const OFFER_STATUSES = [
  { key: "draft", label: "Draft", cls: "bg-blue-100 text-blue-800", dot: "bg-blue-500" },
  { key: "new", label: "Not sent", cls: "bg-slate-100 text-slate-600", dot: "bg-slate-400" },
  { key: "sent", label: "Sent", cls: "bg-sky-100 text-sky-800", dot: "bg-sky-500" },
  { key: "countered", label: "Countered", cls: "bg-violet-100 text-violet-800", dot: "bg-violet-500" },
  { key: "no_response", label: "No response", cls: "bg-amber-100 text-amber-800", dot: "bg-amber-500" },
  { key: "passed", label: "Passed", cls: "bg-rose-100 text-rose-700", dot: "bg-rose-400" },
  { key: "accepted", label: "Accepted", cls: "bg-emerald-100 text-emerald-800", dot: "bg-emerald-500" },
];

export const OFFER_STATUS = Object.fromEntries(OFFER_STATUSES.map((s) => [s.key, s]));
export const OFFER_STATUS_KEYS = OFFER_STATUSES.map((s) => s.key);

// What a human can pick. "draft" is a property of how the record was created,
// not an outcome — you leave draft by generating the offer, never by choosing.
export const SETTABLE_STATUSES = OFFER_STATUS_KEYS.filter((k) => k !== "draft");

// Still waiting on the agent: these are the offers that are actually working.
export const OPEN_STATUSES = new Set(["new", "sent", "countered"]);
// Nothing more will happen here without a new offer.
export const DEAD_STATUSES = new Set(["no_response", "passed"]);

// Which tag a contact carries, most-advanced-wins. Used to collapse an agent's
// many offers into the single tag GHL can hold per contact — see the ordering
// note in syncAgentOfferTag. Higher rank beats lower.
export const STATUS_RANK = {
  accepted: 5, countered: 4, sent: 3, new: 2, no_response: 1, passed: 0,
};

// The status of an offer that predates this field, without touching the row.
// Order matters: a promoted offer is accepted no matter what else is on it, and
// a send is only evidence of "sent" when nothing better is known.
export function effectiveStatus(offer) {
  if (!offer) return "new";
  if (offer.status) return offer.status;
  if (offer.deal) return "accepted";
  return (offer.sends || []).length ? "sent" : "new";
}

// yyyy-mm-dd parsed as a LOCAL date (the convention used by the contract PDFs
// and the deal countdowns) so an expiry never drifts a day across timezones.
function parseYmd(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || "").trim());
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

// When this offer stops being good. Mirrors the broker's offerExpiryDate():
// the per-offer "Offer expires" picker wins, else creation + validityDays.
// validLabel is the last resort — it is the human string printed on the
// document ("September 1, 2026"), kept for rows saved before calc settings
// were snapshotted. Returns null when nothing can be determined.
export function offerExpiresAt(offer) {
  // A list row (see toListOffer) carries the answer instead of the calc
  // settings it was derived from — same date, a fraction of the bytes.
  if (offer?.expiresAt) {
    const pre = new Date(offer.expiresAt);
    if (!Number.isNaN(pre.getTime())) return pre;
  }
  const s = offer?.calc?.settings || {};
  const picked = parseYmd(s.offerExpires);
  if (picked) return picked;
  const days = Number(s.validityDays);
  const created = offer?.createdAt ? new Date(offer.createdAt) : null;
  if (created && !Number.isNaN(created.getTime()) && days > 0) {
    return new Date(created.getTime() + days * 86400000);
  }
  const labeled = offer?.validLabel ? new Date(offer.validLabel) : null;
  return labeled && !Number.isNaN(labeled.getTime()) ? labeled : null;
}

// Expired = the clock ran out on an offer nobody has answered. A passed or
// accepted offer is never "expired" — its story already ended.
export function isExpired(offer, now = new Date()) {
  if (!OPEN_STATUSES.has(effectiveStatus(offer))) return false;
  const at = offerExpiresAt(offer);
  return Boolean(at) && at.getTime() < now.getTime();
}

// Where a send lands you. A send never walks an offer backwards: texting the
// documents again to an agent who already countered doesn't un-counter them.
export function statusAfterSend(offer) {
  const current = effectiveStatus(offer);
  return current === "draft" || current === "new" ? "sent" : current;
}

// Where un-promoting a deal lands you — back to the pre-acceptance truth.
export function statusAfterUnpromote(offer) {
  if (effectiveStatus(offer) !== "accepted") return effectiveStatus(offer);
  return (offer?.sends || []).length ? "sent" : "new";
}

// Human phrase for the agent_deal_history line written onto the contact.
export const STATUS_HISTORY_PHRASE = {
  sent: "offer sent",
  countered: "agent countered",
  no_response: "no response",
  passed: "passed on our offer",
  accepted: "accepted our offer",
};

/* ---------- the list projection ---------- */

// What the offers table actually renders. A stored offer averages ~9KB, and
// four keys — snapshot, calc, draft, scope — are ~90% of that; none of them
// reach the screen until you open a row. GET /api/offers?lean=1 returns only
// the fields below, which is what lets the page hold every offer for the
// location instead of the newest hundred. Anything that needs the whole
// document (the popout, the editor, the PSA/contract/net-sheet generators)
// re-fetches it by id.
export const OFFER_LIST_FIELDS = [
  "id", "locationId", "contactId", "contactName", "address", "cashAmount",
  "status", "statusAt", "statusNote", "deal", "sends", "ghl", "warnings",
  "createdAt", "updatedAt", "dateLabel", "validLabel",
  "pdfUrl", "imageUrl", "scopePdfUrl", "compsPdfUrl",
  "psaPdfUrl", "contractPdfUrl", "assignmentPdfUrl", "netSheetPdfUrl",
];

// Trim an offer to a table row. Two derived keys ride along:
//
//   expiresAt  the ⏱ marker needs calc.settings.{offerExpires,validityDays},
//              which is exactly the weight being dropped — so carry the
//              computed date (25 bytes) instead of its inputs (~1.4KB).
//   listOnly   the flag that says "this is a row, not a document". Callers
//              hydrate on it; nothing should read a fat field without it.
//
// Idempotent: re-trimming a row you already trimmed changes nothing.
export function toListOffer(offer) {
  if (!offer) return offer;
  const row = {};
  for (const k of OFFER_LIST_FIELDS) if (offer[k] !== undefined) row[k] = offer[k];
  const at = offerExpiresAt(offer);
  if (at) row.expiresAt = at.toISOString();
  row.listOnly = true;
  return row;
}
