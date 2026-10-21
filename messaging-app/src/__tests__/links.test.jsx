import { test, expect } from "vitest";
import { movedTo } from "../links.js";

test("the GHL menu links for Agent Outreach and Dispositions land on their Autopilot tabs, location kept", () => {
  expect(movedTo("/agents", "?location_id=L1&key=k")).toBe("/autopilot?location_id=L1&key=k&view=agents");
  expect(movedTo("/agents/", "?location_id=L1&view=settings")).toBe("/autopilot?location_id=L1&view=agents");
  expect(movedTo("/dispo", "?location_id=L1&view=import")).toBe("/autopilot?location_id=L1&view=investors");
});

// 2026-10-20: Today is gone. Its GHL menu link and bookmarks open Offers.
test("old Overview links still go where those tabs moved, and Today opens Offers", () => {
  expect(movedTo("/dashboard", "?view=flow")).toBe("/reports?view=flow");
  expect(movedTo("/dashboard", "?view=conversation&location_id=L1")).toBe("/autopilot?view=advanced&location_id=L1");
  expect(movedTo("/dashboard", "?view=pipeline&location_id=L1")).toBe("/?view=history&location_id=L1");
  expect(movedTo("/dashboard", "?location_id=L1")).toBe("/?location_id=L1&view=history");
  expect(movedTo("/dashboard", "?view=tier1")).toBe("/?view=history");
  expect(movedTo("/autopilot", "?view=overview")).toBe(null);
  expect(movedTo("/", "")).toBe(null);
});
