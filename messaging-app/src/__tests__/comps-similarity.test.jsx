import { test, expect } from "vitest";
import { similarity, scoreComp } from "@shared/comp-match.js";
import { similarityTitle, COMPS_RULES } from "../comps-copy.js";

const SUBJECT = { beds: 3, baths: 2, sqft: 1800, yearBuilt: 1968 };
const COMP = { beds: 3, baths: 2.5, sqft: 1900, yearBuilt: 1975, distance: 0.4, saleDate: "2026-06-01" };

test("the similarity tooltip shows each factor's contribution and the criteria beneath it", () => {
  const s = similarity(SUBJECT, COMP, { radiusMiles: 0.5, now: Date.parse("2026-09-16T00:00:00Z") });
  const m = scoreComp(SUBJECT, COMP);
  const title = similarityTitle(s, m);
  expect(title).toMatch(/^Similarity \d+\/100/);
  expect(title).toContain("Distance 0.4 mi — ");
  expect(title).toMatch(/Beds 3 vs 3 — 15\/15/);
  expect(title).toMatch(/Baths 2\.5 vs 2 — 7\/10/);
  expect(title).toContain("Not knowable: lot");
  expect(title).toContain("Criteria:");
  expect(title).toContain("✓ Beds");
});

test("a comp nothing is known about says so instead of scoring", () => {
  expect(similarityTitle(similarity({}, {}), null)).toBe("Not enough data on this comp to score it");
  expect(COMPS_RULES).toMatch(/distance first/);
});
