import { test, expect } from "vitest";
import { draftOnlyJob } from "../UnderwriteStrip.jsx";
import { DRAFT_ONLY_HOLD, SKELETON_HOLD } from "@shared/offer-status.js";

// Matt, 2026-10-25: the app makes the draft and he prices by hand. A draft
// isn't a held underwrite: its row read as a warning, and its Retry bought a
// full machine underwrite.
test("a skeleton or draft-only run is a draft, not a held underwrite on the strip", () => {
  expect(draftOnlyJob({ status: "held", held: [SKELETON_HOLD] })).toBe(true);
  expect(draftOnlyJob({ status: "held", held: [DRAFT_ONLY_HOLD] })).toBe(true);
  expect(draftOnlyJob({ status: "held", held: ["fewer than 8 photos"] })).toBe(false);
  expect(draftOnlyJob({ status: "running", held: [] })).toBe(false);
  expect(draftOnlyJob({ status: "error", error: "timed out" })).toBe(false);
});
