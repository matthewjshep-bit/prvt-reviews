import { test, expect } from "vitest";
import { movedTo } from "../links.js";

// 2026-11-23: one shell. The Agent Outreach and Dispositions links land on
// their pages under More, location kept.
test("the GHL menu links for Agent Outreach and Dispositions land on their pages under More, location kept", () => {
  expect(movedTo("/agents", "?location_id=L1&key=k")).toBe("/?location_id=L1&key=k&view=agents");
  expect(movedTo("/agents/", "?location_id=L1&view=settings")).toBe("/?location_id=L1&view=agents");
  expect(movedTo("/dispo", "?location_id=L1&view=import")).toBe("/?location_id=L1&view=investors");
});

// 2026-10-20: Today is gone. Its GHL menu link and bookmarks open Offers.
test("old Overview links still go where those tabs moved, and Today opens Offers", () => {
  expect(movedTo("/dashboard", "?view=flow")).toBe("/?view=flow");
  expect(movedTo("/dashboard", "?view=conversation&location_id=L1")).toBe("/?view=advanced&location_id=L1");
  expect(movedTo("/dashboard", "?view=pipeline&location_id=L1")).toBe("/?view=history&location_id=L1");
  expect(movedTo("/dashboard", "?location_id=L1")).toBe("/?location_id=L1&view=history");
  expect(movedTo("/dashboard", "?view=tier1")).toBe("/?view=history");
  expect(movedTo("/", "")).toBe(null);
});

test("the Autopilot and Reports menu links still land, on the same page under More", () => {
  expect(movedTo("/autopilot", "?location_id=L1&view=investors")).toBe("/?location_id=L1&view=investors");
  expect(movedTo("/autopilot", "?location_id=L1")).toBe("/?location_id=L1&view=agents");
  expect(movedTo("/reports", "?location_id=L1&view=line")).toBe("/?location_id=L1&view=line");
  expect(movedTo("/reports", "?location_id=L1")).toBe("/?location_id=L1&view=flow");
  // Lots lives under Luxury only.
  expect(movedTo("/autopilot", "?location_id=L1&view=lots")).toBe("/luxury?location_id=L1&view=lots");
  // Luxury and the every-kind Deals page stay where they are.
  expect(movedTo("/luxury", "?location_id=L1&view=lots")).toBe(null);
  expect(movedTo("/deals", "?location_id=L1")).toBe(null);
});
