import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LaneBreakerStrip, { tripLine } from "../LaneBreakerStrip.jsx";
import { LaneBreakerCard } from "../ConversationPlaybooks.jsx";

// 2026-11-23 audit (AH-4): a lane whose texts get carrier-blocked or STOPped
// stops itself; the Offers page says which and Matt lets it go again.
test("a stopped lane reads as which lane, why in counts, and how many texts went back to drafts", () => {
  expect(tripLine({ label: "lot owner first texts", why: "4 of the first 8 lot owner first texts today were blocked by the carrier (30007)", held: 212 }))
    .toBe("lot owner first texts stopped: 4 of the first 8 lot owner first texts today were blocked by the carrier (30007). 212 queued texts went back to drafts.");
  expect(tripLine({ label: "agent nudges", why: "", held: 1 })).toBe("agent nudges stopped. 1 queued text went back to drafts.");
  expect(tripLine({ label: "agent nudges", held: 0 })).toBe("agent nudges stopped.");
});

test("the strip shows nothing until the broker says a lane is stopped", () => {
  expect(renderToStaticMarkup(<LaneBreakerStrip />)).toBe("");
});

test("the settings card says the breaker is on and only ever stops sends", () => {
  const html = renderToStaticMarkup(<LaneBreakerCard config={{ laneBreaker: { enabled: true } }} patch={() => {}} />);
  expect(html).toContain("Lane breaker");
  expect(html).toContain("never sends");
  expect(html).toMatch(/checked=""/);
});
