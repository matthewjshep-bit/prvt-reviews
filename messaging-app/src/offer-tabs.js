// offer-tabs.js — the Offers page's three tabs (Matt, 2026-10-07: "need to
// simplify this somehow"). Twelve chips became three questions:
//
//   🔥 Hot      — close to a contract: flagged, or a price agreed
//   Not sent    — priced, and the agent doesn't have it on paper yet (floated
//                 or not). Oldest first: the ones waiting longest go out first.
//   Sent        — the written offer is out: awaiting a reply, or countered
//
// Each row is in at most one tab; Hot wins. Everything else — all, deals,
// passed or gone, drafts, off-market, no follow-up, AI review — sits under
// one "Closed / other" menu. Single family is gone: it's the kind of house,
// shown as a pill on any row that isn't one, not a stage of an offer.
//
// Pure, so the tabs can be tested without the page.

import { DEAD_STATUSES, effectiveStatus, isHot, needsAiReview } from "@shared/offer-status.js";
import { isOffMarket } from "@shared/off-market.js";
import { pricedAt } from "@shared/current-offer.js";
import { needsFollowUp } from "./NextFollowUp.jsx";

const live = (o) => !o.deal && !o.supersededBy && o.status !== "draft";

export const TABS = [
  { key: "hot", label: "🔥 Hot", title: "Close to a contract — the price is agreed, or you flagged it",
    test: (o) => !o.supersededBy && o.status !== "draft" && isHot(o) },
  { key: "unsent", label: "Not sent", title: "Priced, not on paper yet — floated by text or not. Oldest first: send these.",
    test: (o) => live(o) && effectiveStatus(o) === "new" && !isHot(o) },
  { key: "sent", label: "Sent", title: "The written offer is out — waiting on them, or they countered",
    test: (o) => live(o) && ["sent", "countered"].includes(effectiveStatus(o)) && !isHot(o) },
];

export const OTHER = [
  { key: "all", label: "All offers", test: () => true },
  { key: "deals", label: "Deals", test: (o) => Boolean(o.deal) },
  { key: "dead", label: "Passed / gone", title: "They passed, we passed, no reply, or the house is no longer available",
    test: (o) => !o.deal && DEAD_STATUSES.has(effectiveStatus(o)) },
  { key: "drafts", label: "Drafts", test: (o) => o.status === "draft" },
  { key: "offmarket", label: "Off-market", title: "Houses an agent brought us off the market",
    test: (o) => !o.supersededBy && o.status !== "draft" && isOffMarket(o) },
  { key: "nofollow", label: "No follow-up", title: "Live offers with nothing scheduled, or a follow-up that's overdue",
    test: (o) => needsFollowUp(o) },
  { key: "ai", label: "AI review", title: "Auto-underwritten offers nobody has acted on yet", test: needsAiReview, onlyWhenUsed: true },
];

export const ALL_VIEWS = [...TABS, ...OTHER];
export const viewFor = (key) => ALL_VIEWS.find((v) => v.key === key) || TABS[0];

// Open on Hot; when nothing is hot, on the list that needs sending.
export function defaultTab(rows = []) {
  return rows.some(TABS[0].test) ? "hot" : "unsent";
}

const ms = (t) => (t == null ? null : typeof t === "number" ? t : Date.parse(t) || null);

// How long a Not-sent offer has waited for paper: since the float went out,
// or since we priced it when it was never floated.
export function waitingSince(o) {
  return ms(o?.floatedAt) ?? (pricedAt(o) || null);
}

export function notSentAge(o, now = Date.now()) {
  const at = waitingSince(o);
  if (at == null) return "";
  const days = Math.max(0, Math.floor((now - at) / 86400000));
  const when = days === 0 ? "today" : `${days}d ago`;
  return `${o?.floatedAt ? "Floated" : "Priced"} ${when}`;
}
