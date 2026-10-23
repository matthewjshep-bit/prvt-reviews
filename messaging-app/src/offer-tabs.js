// offer-tabs.js — the Offers page's tabs: the three stages of an offer as Matt
// drew them (2026-10-13), shared/offer-stage.js:
//
//   Draft      the written offer hasn't gone out yet — priced, held, or a
//              number we only texted. Oldest first: send these.
//   Sent       the written offer went out (2026-10-23: a texted number alone
//              no longer counts here; the GHL card still treats it as Offer Out)
//   Responded  Passed · Countered · 🔥 Hot · Accepted, one chip each
//
// Every current row is in exactly one stage. A row a newer one on the same
// house replaced (supersededBy) is in none; "All offers" still shows it.
// Off-market, no follow-up and AI review stay under one "Other" menu — they
// cut across the stages rather than being one.
//
// Pure, so the tabs can be tested without the page.

import { offerStage, floatedAt, OFFER_STAGES, RESPONDED_SUBS } from "@shared/offer-stage.js";
import { needsAiReview } from "@shared/offer-status.js";
import { isOffMarket } from "@shared/off-market.js";
import { pricedAt } from "@shared/current-offer.js";
import { needsFollowUp } from "./NextFollowUp.jsx";

const current = (o) => !o.supersededBy;

export const TABS = OFFER_STAGES.map((s) => ({
  key: s.key, label: s.label, title: s.title,
  test: (o) => current(o) && offerStage(o, { texted: false }).stage === s.key,
}));

// Under Responded, one chip per answer.
export const SUBS = RESPONDED_SUBS.map((s) => ({
  key: s.key, label: s.label, title: s.title, parent: "responded",
  test: (o) => current(o) && offerStage(o, { texted: false }).sub === s.key,
}));

export const OTHER = [
  { key: "all", label: "All offers", test: () => true },
  { key: "offmarket", label: "Off-market", title: "Houses an agent brought us off the market",
    test: (o) => current(o) && o.status !== "draft" && isOffMarket(o) },
  { key: "nofollow", label: "No follow-up", title: "Live offers with nothing scheduled, or a follow-up that's overdue",
    test: (o) => needsFollowUp(o) },
  { key: "ai", label: "AI review", title: "Auto-underwritten offers nobody has acted on yet", test: needsAiReview, onlyWhenUsed: true },
];

export const ALL_VIEWS = [...TABS, ...SUBS, ...OTHER];
export const viewFor = (key) => ALL_VIEWS.find((v) => v.key === key) || TABS[0];
/** The stage tab a view sits under: a Responded chip lights Responded. */
export const tabOf = (key) => SUBS.find((s) => s.key === key)?.parent || key;

// Open on Hot; when nothing is hot, on Draft — the ones to get out.
export function defaultTab(rows = []) {
  return rows.some(SUBS.find((s) => s.key === "hot").test) ? "hot" : "draft";
}

const ms = (t) => (t == null ? null : typeof t === "number" ? t : Date.parse(t) || null);

// How long an offer has waited for paper: since the float went out, or since
// we priced it when it was never floated.
export function waitingSince(o) {
  return ms(floatedAt(o)) ?? (pricedAt(o) || null);
}

export function notSentAge(o, now = Date.now()) {
  const at = waitingSince(o);
  if (at == null) return "";
  const days = Math.max(0, Math.floor((now - at) / 86400000));
  const when = days === 0 ? "today" : `${days}d ago`;
  return `${floatedAt(o) ? "Floated" : "Priced"} ${when}`;
}
