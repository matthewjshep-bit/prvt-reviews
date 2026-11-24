// app-nav.test.jsx — one shell (2026-11-23 audit, nav-1/2/7): Offers, Deals
// and Luxury up top, everything else under More, and no old link dead-ends.
import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MORE, PILLS, activePill, historyUrl, isCompanionPath, laneFilter, moreLabel, resolveView, routeOf, urlFor } from "../app-nav.js";
import { NeedsChip } from "../ui.jsx";

test("the header has three pages, and every other page is one More menu away", () => {
  expect(PILLS.map((p) => p.label)).toEqual(["Offers", "Deals", "Luxury"]);
  const more = MORE.filter((m) => m.view).map((m) => m.view);
  for (const v of ["agents", "investors", "gatekeepers", "advanced", "settings", "flow", "line", "followup", "lessons"]) expect(more).toContain(v);
  expect(MORE.filter((m) => m.heading).map((m) => m.heading)).toEqual(["Machine", "Reports"]);
});

test("every page reachable before the shell still opens from its URL", () => {
  for (const v of ["history", "deals", "agents", "investors", "gatekeepers", "advanced", "settings", "flow", "line", "followup", "lessons", "new"]) {
    expect(routeOf("/", `?view=${v}`)).toEqual({ lane: "agents", view: v });
  }
  for (const v of ["history", "lots", "deals", "new"]) expect(routeOf("/luxury", `?view=${v}`)).toEqual({ lane: "luxury", view: v });
  expect(routeOf("/deals", "")).toEqual({ lane: "all", view: "deals" });
  expect(routeOf("/", "")).toEqual({ lane: "agents", view: "history" });
});

test("a retired tab opens the page that took its place, and Lots only opens under Luxury", () => {
  expect(routeOf("/", "?view=overview")).toEqual({ lane: "agents", view: "agents" });
  expect(routeOf("/", "?view=activity")).toEqual({ lane: "agents", view: "flow" });
  expect(routeOf("/", "?view=conversation")).toEqual({ lane: "agents", view: "advanced" });
  expect(routeOf("/", "?view=lots")).toEqual({ lane: "luxury", view: "lots" });
  // Luxury has no machine pages; an unknown view falls to its Offers.
  expect(routeOf("/luxury", "?view=flow")).toEqual({ lane: "luxury", view: "history" });
  // The every-kind Deals page only shows deals (or the editor).
  expect(resolveView("all", "history")).toEqual({ lane: "all", view: "deals" });
});

test("the URL keeps the location and says which page shows", () => {
  expect(urlFor({ lane: "luxury", view: "lots" }, "?location_id=L1&view=history")).toBe("/luxury?location_id=L1&view=lots");
  expect(urlFor({ lane: "agents", view: "flow" }, "?location_id=L1")).toBe("/?location_id=L1&view=flow");
  expect(urlFor({ lane: "all", view: "deals" }, "?location_id=L1")).toBe("/deals?location_id=L1&view=deals");
});

test("the right pill lights, and a More page names itself on the menu", () => {
  expect(activePill({ lane: "agents", view: "history" })).toBe("offers");
  expect(activePill({ lane: "agents", view: "deals" })).toBe("deals");
  expect(activePill({ lane: "all", view: "deals" })).toBe("deals");
  expect(activePill({ lane: "luxury", view: "lots" })).toBe("luxury");
  expect(activePill({ lane: "agents", view: "flow" })).toBe(null);
  expect(moreLabel("advanced")).toBe("Autopilot settings");
});

test("Offers leaves luxury lots out, Luxury shows only them, and /deals shows every kind", () => {
  const isLux = (o) => o.lux;
  expect(laneFilter("agents", isLux)({ lux: true })).toBe(false);
  expect(laneFilter("luxury", isLux)({ lux: true })).toBe(true);
  expect(laneFilter("all", isLux)).toBe(null);
});

test("the Needs you chip shows a count and nothing when nobody is waiting", () => {
  expect(renderToStaticMarkup(<NeedsChip count={0} page="Offers" />)).toBe("");
  const html = renderToStaticMarkup(<NeedsChip count={3} page="Offers" />);
  expect(html).toContain("Needs you · ");
  expect(html).toContain("3");
});

// Review 2026-11-23: the shell rewrote the companion window's /contact URL
// to /?view=history on its first render, so the extension stopped finding
// the companion tab and a reload opened the whole console.
test("the companion window keeps its own address", () => {
  const loc = { pathname: "/contact", search: "?location_id=L1&key=K1" };
  expect(isCompanionPath("/contact")).toBe(true);
  expect(isCompanionPath("/contact/")).toBe(true);
  expect(isCompanionPath("/contacts")).toBe(false);
  expect(historyUrl(routeOf(loc.pathname, loc.search), loc)).toBe(null);
  expect(historyUrl({ lane: "agents", view: "history" }, loc, { lane: "luxury", view: "history" })).toBe(null);
  expect(historyUrl({ lane: "agents", view: "flow" }, { pathname: "/", search: "?location_id=L1" })).toBe("/?location_id=L1&view=flow");
});

// Review 2026-11-23: switching lanes wiped the Offers tab and search off the
// page being left, so Back from Luxury came back to a blank table.
test("going to another lane leaves the table's slice behind, and Back still has it", () => {
  const offers = { pathname: "/", search: "?location_id=L1&view=history&filter=sent&q=elm" };
  const from = { lane: "agents", view: "history" };
  expect(historyUrl({ lane: "luxury", view: "history" }, offers, from)).toBe("/luxury?location_id=L1&view=history");
  // Within a lane (Offers → a More page and back) the slice rides along.
  expect(historyUrl({ lane: "agents", view: "flow" }, offers, from)).toBe("/?location_id=L1&view=flow&filter=sent&q=elm");
  // The entry being left is never rewritten: only the new URL drops them.
  expect(offers.search).toContain("filter=sent");
});
