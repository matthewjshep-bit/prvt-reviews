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
  // Two ways an offer dies by a decision. "passed" is THEIRS — the agent or
  // seller said no — and keeps its original key so every row already marked
  // stays what it was. "we_passed" is OURS — we withdrew, re-underwrote away
  // from it, or let it go on purpose. The funnel and the contact's history
  // treat them differently: a "they passed" is a reply and a tier-3 signal; a
  // "we passed" says nothing about the agent at all.
  { key: "passed", label: "They passed", cls: "bg-rose-100 text-rose-700", dot: "bg-rose-400" },
  { key: "we_passed", label: "We passed", cls: "bg-stone-200 text-stone-700", dot: "bg-stone-500" },
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
export const DEAD_STATUSES = new Set(["no_response", "passed", "we_passed"]);
// Dead on THEIR side, and the passed-offer check-in exists to bring these
// back. An agent who answers it with a number is negotiating that offer
// again — Pink Skulls Realtor, 2414 E Longfellow (2026-09-22): "they passed"
// on 9/10, the check-in asked if the seller had moved, she came back at 144k
// inside the ceiling, and the counter band said "no open offer". Our own
// pass is never revived by the machine (Matt, 2026-09-22).
export const REVIVABLE_STATUSES = new Set(["passed", "no_response"]);
// The offers a counter can land on: open, or revivable. Never a deal.
export const isNegotiable = (o) => Boolean(o) && !o.deal
  && (OPEN_STATUSES.has(effectiveStatus(o)) || REVIVABLE_STATUSES.has(effectiveStatus(o)));
// A deal somebody is still working. The same three stages are named locally
// in routes/offers.js, contact-record.js and conversation-context.js; this
// is the one the pipeline board classifies by.
export const LIVE_DEAL_STAGES = new Set(["under_contract", "buyer_found", "assigned"]);

/* ---------- provenance: which offers a robot made ---------- */

// An offer or draft built by the auto-underwrite pipeline carries an
// `autoUnderwrite` stamp (see ghl-broker/auto-underwrite.js).
//
// Provenance is ORTHOGONAL to status, deliberately. It is tempting to make
// "AI generated" another status value, but an auto-made offer travels the same
// road as any other — not sent → sent → countered → passed — and folding the
// two axes together would mean an AI offer that got sent had to stop being an
// AI offer. So this is a second, independent question you can ask a row.
export const isAiGenerated = (offer) => Boolean(offer?.autoUnderwrite);

// Why a run stopped short of publishing, in the gate's own words. Empty for a
// run that cleared everything.
export const aiHoldReasons = (offer) => offer?.autoUnderwrite?.held || [];

// Waiting on a pair of human eyes. Two shapes, one queue:
//
//   a HELD draft   — the run couldn't clear its quality gates and stopped
//                    rather than publish a number nobody chose
//   an UNSENT offer — the run cleared them and built the offer, but sending is
//                    deliberately manual, so nothing has left the building
//
// The queue drains by itself, which is why there is no "reviewed" flag to
// remember to set: fixing a draft turns it into an offer, and sending an offer
// moves it to `sent`. Either way it falls out of here.
export function needsAiReview(offer) {
  if (!isAiGenerated(offer) || offer?.deal) return false;
  const status = effectiveStatus(offer);
  return status === "draft" || status === "new";
}

// Which tag a contact carries, most-advanced-wins. Used to collapse an agent's
// many offers into the single tag GHL can hold per contact — see the ordering
// note in syncAgentOfferTag. Higher rank beats lower.
// "we_passed" ranks below "passed": an agent who said no told us something
// about themselves; an offer we walked away from did not.
export const STATUS_RANK = {
  accepted: 6, countered: 5, sent: 4, new: 3, no_response: 2, passed: 1, we_passed: 0,
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
  we_passed: "we passed on the property",
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
/* ---------- where a buyer stands on a deal ---------- */

// Three states, in the order a buyer moves through them. There used to be a
// fourth, "sent", meaning we'd shown them the deal and heard nothing — but
// putting someone on a deal IS the act of shopping it to them, and the
// no-answer case was already covered by the blast tag and the dataroom
// invite trail. It bought a status and paid for it in ambiguity: nothing
// could tell "not answered yet" from "we never asked".
//
// "soft_commit" is the one in the middle: "I think I have a buyer for this
// one." Nothing is signed and it is not a promise, so it changes nothing
// about what the deal IS — it is still live, still priced, still every
// buyer's to look at, and the bot keeps working everyone who already has it.
// What it changes is what we START: while it is on, the deal is not put in
// front of anybody new (dealOutreachPaused). Clear it and outreach resumes on
// its own, because nothing about the pause is stored — it is read off the
// buyers each time.
export const INVESTOR_STATUSES = ["evaluating", "soft_commit", "committed", "passed"];
export const INVESTOR_STATUS_LABEL = {
  evaluating: "Evaluating", soft_commit: "Soft commit", committed: "Committed", passed: "Passed",
};
// The one status that stands the Conversation AI down. "committed" is a
// single person — the buyer who signs the assignment — and everything after
// that point is paperwork a bot has no business in.
//
// "evaluating" deliberately does NOT: that is every buyer actively weighing
// the deal, often a dozen at once, and working them toward a walkthrough is
// exactly the job. "passed" doesn't either — they're free for the next deal.
// Nor does "soft_commit": a maybe is exactly the buyer to keep talking to.
export const WORKING_INVESTOR_STATUSES = new Set(["committed"]);

// A deal with a buyer: the stage says so, or somebody on it is committed.
// From here on it is not pitched to anyone else — not its address, not its
// numbers — by the bot or a nudge. Only the committed buyer still hears about it.
// A deal that's finished — closed, fell through, or assigned. Nobody gets a
// follow-up about it; there is nothing left to pitch.
export const OVER_DEAL_STAGES = new Set(["assigned", "closed", "fell_through"]);
export const dealIsOver = (deal) => Boolean(deal) && OVER_DEAL_STAGES.has(deal.stage);

export const dealSpokenFor = (deal) =>
  Boolean(deal) && (deal.stage === "buyer_found" || (deal.investors || []).some((i) => i?.status === "committed"));

/**
 * priceAgreed(offer) → { amount, at, via } | null
 *
 * The number both sides have said yes to: the agent said ours is in the realm
 * (realm_yes), the counter band accepted theirs, a person marked it accepted,
 * or it became a deal. Written explicitly as `offer.agreed` by those writes;
 * derived here for rows from before that field existed.
 *
 * Heather Vandyken, 36721 6th Ave SW (2026-09-16): the seller accepted our
 * 825 in August; a re-underwrite quietly dropped our number, so her "they
 * agreed to accept 825" read as a counter; a second run floated 795 "after
 * the latest look"; she got the seller to 795, then 800, which the band
 * accepted; then a call transcript re-quoted us to 731.5 and SENT it with a
 * PSA at 800 promised. She's gone. Once a number is agreed, the price is
 * locked — no re-underwrite, no re-quote, no revision by the machine.
 */
export function priceAgreed(offer) {
  if (!offer) return null;
  if (offer.agreed?.amount > 0) return offer.agreed;
  if (offer.deal || effectiveStatus(offer) === "accepted") {
    const h = (offer.statusHistory || []).find((x) => x.status === "accepted");
    return { amount: Number(offer.deal?.contractPrice) || Number(offer.cashAmount) || 0, at: h?.ts || offer.deal?.createdAt || offer.statusAt || null, via: "accepted" };
  }
  if (offer.counterBand?.acceptedAt) return { amount: Number(offer.counterBand.amount) || Number(offer.cashAmount) || 0, at: offer.counterBand.acceptedAt, via: "counter_band" };
  if (offer.realm?.answer === "yes") return { amount: Number(offer.cashAmount) || 0, at: offer.realm.ts || null, via: "realm_yes" };
  return null;
}

// The machine may not touch the price on an agreed offer that is still live.
// A dead one (passed, no response, we passed) is a fresh negotiation.
export const priceLocked = (offer) =>
  Boolean(priceAgreed(offer)) && !DEAD_STATUSES.has(effectiveStatus(offer));

/* ---------- heat: which offers are close to a contract ---------- */

// "Hot" is a second axis, like provenance above, and for the same reason: a
// hot offer is still sent or countered, and the counter band, the follow-up
// ladder and the audit all read that status. Folding heat into status would
// mean an offer that got hot stopped being countered.
//
//   offer.hot = { at, by: "operator", note }        you flagged it
//   offer.hot = { at, by: "conversation", signal }  the agent said it might work / they'll
//                                                   present it / write it up (reply-agent 4c‴)
//   offer.hot = { off: true, at }                   you cooled it; beats the signals below
//
// With neither, heat is derived: the price is agreed (they said our number
// works, the counter band took theirs) and the offer is still alive. A deal
// is past hot — it's on the dispo side of the board — and a dead offer is cold.
const HOT_VIA = {
  realm_yes: "they said our number works",
  counter_band: "we took their counter",
  accepted: "accepted",
};
export function offerHeat(offer) {
  if (!offer || offer.deal) return null;
  const status = effectiveStatus(offer);
  if (DEAD_STATUSES.has(status) || status === "accepted") return null;
  if (offer.hot?.off) return null;
  if (offer.hot?.at) {
    return offer.hot.by === "conversation"
      ? { at: offer.hot.at, by: "auto", reason: offer.hot.note || "the agent is warming to it", signal: offer.hot.signal || "" }
      : { at: offer.hot.at, by: "you", reason: offer.hot.note || "you flagged it" };
  }
  if (status === "draft") return null;
  const agreed = priceAgreed(offer);
  if (agreed) return { at: agreed.at || null, by: "auto", reason: HOT_VIA[agreed.via] || String(agreed.via || "price agreed").replace(/_/g, " "), amount: agreed.amount || 0 };
  return null;
}
export const isHot = (offer) => Boolean(offerHeat(offer));

/**
 * dealOutreachPaused(deal) → { status, name, contactId } | null
 *
 * Somebody is probably taking this one, so stop shopping it. Blasts, the
 * second wave, nudges to other buyers and the automatic dataroom invite all
 * ask this first; nothing that is already in flight is withdrawn and nobody
 * is told the deal is gone, because a soft commit is a maybe.
 *
 * Deliberately NOT dealSpokenFor. That one means the deal is taken — other
 * buyers hear "spoken for" and see no numbers, and the bot stands down. This
 * only stops new outreach, and it is derived, so putting the buyer back to
 * evaluating (or their passing) starts it again with no second switch to
 * remember.
 */
export const OUTREACH_PAUSING_STATUSES = new Set(["soft_commit", "committed"]);
export function dealOutreachPaused(deal) {
  if (!deal) return null;
  const hit = (deal.investors || []).find((i) => OUTREACH_PAUSING_STATUSES.has(investorStatus(i?.status)));
  if (hit) return { status: investorStatus(hit.status), name: hit.name || "", contactId: hit.contactId || "" };
  if (deal.stage === "buyer_found") return { status: "committed", name: "", contactId: "" };
  return null;
}

// The line an operator reads when something refused to go out because of it.
export const outreachPausedReason = (p, address = "") =>
  !p ? "" : p.status === "committed"
    ? `${address || "this deal"} has a committed buyer${p.name ? ` (${p.name})` : ""}`
    : `${address || "this deal"} is soft-committed${p.name ? ` to ${p.name}` : ""} — outreach is paused until that clears`;

/**
 * investorStatus(s) → one of INVESTOR_STATUSES
 *
 * Reads the legacy "sent" as "evaluating". Deals written before the status
 * was retired still carry it, and there is no migration: a buyer we'd sent
 * a deal to was being worked, which is what evaluating means.
 */
export function investorStatus(s) {
  const v = String(s || "").trim().toLowerCase();
  if (v === "sent") return "evaluating";
  return INVESTOR_STATUSES.includes(v) ? v : "evaluating";
}

export const OFFER_LIST_FIELDS = [
  "id", "locationId", "contactId", "contactName", "address", "cashAmount",
  "status", "statusAt", "statusNote", "deal", "sends", "ghl", "warnings",
  // Small on purpose (scalars only — see auditTrail in auto-underwrite.js).
  // It rides on the lean row so the auto-underwrite daily cap and the 24h
  // dedupe can be answered without reading every offer document in full.
  "autoUnderwrite",
  // The outcome ledger ({status, ts, note} rows) — a counter with its number
  // is the one thing the Conversation AI needs from it, and it's small.
  "statusHistory", "realm",
  // Heat (offerHeat): the hand-set flag and the agreed price it is derived from.
  "hot", "agreed", "pin", "paperHeld",
  // What the GHL Opportunities mirror last wrote ({ acquisitions, dispositions }),
  // so the reconcile can tell "unchanged" from a lean row.
  "mirror",
  // The newest counter with its number ({amount, at, source}), hoisted off
  // statusHistory so the auto-accept band can read it from a lean row.
  "counter",
  // Where the conversation stands, for the pipeline board. Each is a handful
  // of scalars or a short array, well inside "a row must stay a row":
  //   proactive   {takeCheckAt, realmCheckAt} — which float has gone out
  //   followUps   ≤6 {kind, step, at, jobId} — which nudge rungs fired. The
  //               follow-up sweep reads sentSteps off THIS row, so without it
  //               here every exhausted rung was re-claimed daily on Postgres
  //               (the dedupe key made that harmless, but never "step 2 of 3").
  //   counterBand {acceptedAt, amount, draftId} — the band's one exception used
  //   requotes    a few {ts, from, to, ...} — re-runs on the agent's numbers
  //   revisions   ≤20 {ts, from, to} — hand re-prices; with sends/requotes
  //               they say which row on a house is current (current-offer.js)
  //   pin         {at, by, note} — a person chose this row as current
  "proactive", "followUps", "counterBand", "requotes", "revisions",
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
  // askingPrice  the list price lives at calc.inputs.askingPrice, inside the
  //              calc blob this trim drops. The reply agent quotes it to an
  //              agent who just named it, and its money guard flags any number
  //              it can't see — so without this every "your $525k asking"
  //              read as an invented figure.
  const asking = Number(offer?.askingPrice ?? offer?.calc?.inputs?.askingPrice ?? offer?.inputs?.askingPrice) || 0;
  if (asking > 0) row.askingPrice = asking;
  // arv / repairs / terms  what the Conversation AI needs to explain an offer
  //              (behind its own switch) and to confirm the terms on the
  //              letter — a few numbers instead of the whole calc blob.
  const arv = Number(offer?.arv ?? offer?.calc?.inputs?.arv) || 0;
  if (arv > 0) row.arv = arv;
  const repairs = Number(offer?.repairs ?? offer?.calc?.inputs?.repairs) || 0;
  if (repairs > 0) row.repairs = repairs;
  const st = offer?.calc?.settings || null;
  if (offer?.terms) row.terms = offer.terms;
  else if (st) {
    // Only the terms the letter actually names — a row must stay a row.
    const terms = {};
    if (Number(st.psa?.closingDays) > 0) terms.closingDays = Number(st.psa.closingDays);
    if (Number(st.earnestMoney) > 0) terms.earnestMoney = Number(st.earnestMoney);
    for (const [k, v] of [["financing", st.termFinancing], ["condition", st.termCondition], ["possession", st.termPossession]]) {
      if (String(v || "").trim()) terms[k] = String(v).trim();
    }
    if (Object.keys(terms).length) row.terms = terms;
  }
  row.listOnly = true;
  return row;
}
