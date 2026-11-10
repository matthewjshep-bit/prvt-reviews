import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LeftOffList } from "../MatchInvestorsModal.jsx";

// 2026-11-09: a buyer's own words now take them off a deal (an area that
// isn't this one, "no rehabs", "not buying right now"). Find buyers shows
// who that left off and why, so a box that's out of date gets fixed.
test("Find buyers shows who buys there and won't get the deal text, and why", () => {
  const html = renderToStaticMarkup(<LeftOffList leftOff={[
    { contactId: "c1", name: "Wren", why: "their areas are elsewhere (West Seattle)" },
    { contactId: "c2", name: "Bram", why: "they said no rehabs" },
  ]} />);
  expect(html).toContain("Left off the deal text: 2 buyers who buy there");
  expect(html).toContain("Wren");
  expect(html).toContain("their areas are elsewhere (West Seattle)");
  expect(html).toContain("they said no rehabs");
});

test("nobody left off shows nothing", () => {
  expect(renderToStaticMarkup(<LeftOffList leftOff={[]} />)).toBe("");
  expect(renderToStaticMarkup(<LeftOffList leftOff={null} />)).toBe("");
});
