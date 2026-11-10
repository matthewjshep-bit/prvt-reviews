import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DealKind, { repickLine } from "../DealKind.jsx";

// 1510 Maple Lane (2026-10-01): a mobile home in a park with no kind on the
// deal, so the blast went to Kent flippers.
test("a mobile home in a park shows as picked, with the land question answered", () => {
  const html = renderToStaticMarkup(<DealKind offer={{ id: "o1", asset: { type: "manufactured", land: "park", by: "you" } }} onUpdated={() => {}} />);
  expect(html).toContain("Manufactured / mobile");
  expect(html).toMatch(/aria-checked="true"[^>]*>Manufactured \/ mobile/);
  expect(html).toMatch(/aria-checked="true"[^>]*>In a park \(lot rent\)/);
  expect(html).toContain("Goes only to buyers who said they buy mobile homes.");
});

test("Zillow's word says so, and a house has no land question", () => {
  const html = renderToStaticMarkup(<DealKind offer={{ id: "o1", asset: { type: "sfr", by: "underwrite" } }} onUpdated={() => {}} />);
  expect(html).toContain("From Zillow. Pick one to make it yours.");
  expect(html).not.toContain("In a park");
});

test("no kind at all asks for one", () => {
  const html = renderToStaticMarkup(<DealKind offer={{ id: "o1" }} onUpdated={() => {}} />);
  expect(html).toContain("Not set, and Zillow didn&#x27;t say.");
});

// 2026-11-09: a deal set to land after promote still went to the flippers it
// was first picked for. The change re-picks, and says what it did.
test("a change of kind says how many queued texts it pulled back and who it added", () => {
  expect(repickLine({ dismissed: 2, queued: 1, drafted: 0 })).toBe("Picked again for the new kind: 2 queued texts pulled back from buyers who don't buy it, 1 new buyer queued on the same schedule.");
  expect(repickLine({ dismissed: 0, queued: 0, drafted: 0 })).toBe("");
  expect(repickLine(undefined)).toBe("");
});
