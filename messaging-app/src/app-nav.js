// app-nav.js — one shell for the whole console (2026-11-23 audit, nav-1).
//
// Matt: "Really what I use is just the offers page and deals... I don't really
// use the reports or the autopilot pages." So the header carries three pills,
// Offers · Deals · Luxury, and everything else sits behind one More menu:
// the machine's pages (agent texts, investor texts, gatekeepers, the autopilot
// settings, Settings) and the reports (Flow, Line, Follow-up, Lessons).
//
// A "lane" is which book a page shows:
//   agents  the agent-outreach book at /: luxury lots left out
//   luxury  the teardown lane at /luxury (Matt, 2026-11-23: "keep track of
//           Luxury separately"): its own Offers, Lots and Deals
//   all     /deals, which shows every kind of deal on purpose (OfferApp)
//
// Old links keep landing: /autopilot and /reports are redirected by
// links.js movedTo to the same view here; Autopilot's Overview and Reports'
// Activity were retired (nav-2) and open Agents and Flow; Lots lives only
// under Luxury (nav-7). Pure, so the routing is tested without a browser.

export const PILLS = [
  { key: "offers", label: "Offers", lane: "agents", view: "history" },
  { key: "deals", label: "Deals", lane: "agents", view: "deals" },
  { key: "luxury", label: "Luxury", lane: "luxury", view: "history" },
];

// Inside Luxury, its own three tabs; Offers first (Matt, 2026-11-23).
export const LUXURY_TABS = [
  { view: "history", label: "Offers" },
  { view: "lots", label: "Lots" },
  { view: "deals", label: "Deals" },
];

// The More menu, in two groups. `heading` rows are labels, not choices.
export const MORE = [
  { heading: "Machine" },
  { view: "agents", label: "Agent texts" },
  { view: "investors", label: "Investor texts" },
  { view: "gatekeepers", label: "Gatekeepers" },
  { view: "advanced", label: "Autopilot settings" },
  { view: "settings", label: "Settings" },
  { heading: "Reports" },
  { view: "flow", label: "Flow" },
  { view: "line", label: "Line" },
  { view: "followup", label: "Follow-up" },
  { view: "lessons", label: "Lessons" },
];

export const MORE_VIEWS = new Set(MORE.filter((m) => m.view).map((m) => m.view));
const LANE_VIEWS = {
  agents: new Set(["history", "deals", "new", ...MORE_VIEWS]),
  luxury: new Set([...LUXURY_TABS.map((t) => t.view), "new"]),
  all: new Set(["deals", "new"]),
};

// Views that moved or were retired. Autopilot's old tab names (Controls,
// Conversation AI, Bot) open its settings, as they did before.
const RENAMED = {
  overview: "agents",       // Autopilot → Overview, retired 2026-11-23
  activity: "flow",         // Reports → Activity, retired 2026-11-23
  controls: "advanced",
  conversation: "advanced",
  bot: "advanced",
};

export const laneOfPath = (pathname = "") =>
  /^\/luxury(\/|$)/.test(pathname) ? "luxury" : /^\/deals(\/|$)/.test(pathname) ? "all" : "agents";

export const pathForLane = (lane) => (lane === "luxury" ? "/luxury" : lane === "all" ? "/deals" : "/");

/**
 * resolveView(lane, view) → { lane, view } — a view that exists. Lots is
 * Luxury's; anything the lane doesn't have falls to the lane's first page,
 * and /deals (every kind) only ever shows Deals or the editor.
 */
export function resolveView(lane = "agents", view = "") {
  let v = RENAMED[view] || view || "";
  if (v === "lots") return { lane: "luxury", view: "lots" };
  if (lane === "all") return LANE_VIEWS.all.has(v) ? { lane, view: v } : { lane: "all", view: "deals" };
  const views = LANE_VIEWS[lane] || LANE_VIEWS.agents;
  if (!views.has(v)) v = "history";
  return { lane: LANE_VIEWS[lane] ? lane : "agents", view: v };
}

/** routeOf(pathname, search) → { lane, view } for the page as loaded. */
export function routeOf(pathname = "/", search = "") {
  let view = "";
  try { view = new URLSearchParams(search).get("view") || ""; } catch { /* no view */ }
  return resolveView(laneOfPath(pathname), view);
}

/** urlFor({ lane, view }, search) → the URL for that page, other params kept. */
export function urlFor({ lane, view }, search = "") {
  const p = new URLSearchParams(search);
  p.set("view", view);
  return `${pathForLane(lane)}?${p}`;
}

// The companion window beside GHL (CompanionView.jsx) is its own page at
// /contact. The extension finds its tab by that path, so the shell never
// rewrites it.
export const isCompanionPath = (pathname = "") => /^\/contact(\/|$)/.test(pathname);

// The Offers table's slice in the URL (offers-split.js): ?filter= and ?q=.
// They belong to one lane's table.
export const TABLE_PARAMS = ["filter", "q"];

/**
 * historyUrl(route, { pathname, search }, from) → the URL to put in history
 * for this page, or null to leave history alone (the companion window).
 * Moving to another lane leaves the table's slice off the new URL only; the
 * entry being left keeps it, so Back lands on the same slice.
 */
export function historyUrl(route, { pathname = "/", search = "" } = {}, from = null) {
  if (isCompanionPath(pathname)) return null;
  const p = new URLSearchParams(search);
  if (from && from.lane !== route.lane) for (const k of TABLE_PARAMS) p.delete(k);
  return urlFor(route, `?${p}`);
}

/** Which pill lights for a page; null for a More page. */
export function activePill({ lane, view }) {
  if (lane === "luxury") return "luxury";
  if (view === "deals") return "deals";
  if (view === "history" || view === "new") return "offers";
  return null;
}

/** The More menu's label while one of its pages shows. */
export const moreLabel = (view) => MORE.find((m) => m.view === view)?.label || "";

// What the pages' `only` filter is in each lane (shared/asset-type.js). The
// same function every render, so a page can memo on it.
const negations = new WeakMap();
export function laneFilter(lane, isLuxuryLot) {
  if (lane === "luxury") return isLuxuryLot;
  if (lane !== "agents") return null;
  if (!negations.has(isLuxuryLot)) negations.set(isLuxuryLot, (o) => !isLuxuryLot(o));
  return negations.get(isLuxuryLot);
}
