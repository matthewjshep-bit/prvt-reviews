import { test, expect } from "vitest";
import { movedTo } from "../links.js";

test("the GHL menu links for Agent Outreach and Dispositions land on their Autopilot tabs, location kept", () => {
  expect(movedTo("/agents", "?location_id=L1&key=k")).toBe("/autopilot?location_id=L1&key=k&view=agents");
  expect(movedTo("/agents/", "?location_id=L1&view=settings")).toBe("/autopilot?location_id=L1&view=agents");
  expect(movedTo("/dispo", "?location_id=L1&view=import")).toBe("/autopilot?location_id=L1&view=investors");
});

test("old Overview links still go where those tabs moved, and Today itself stays put", () => {
  expect(movedTo("/dashboard", "?view=flow")).toBe("/reports?view=flow");
  expect(movedTo("/dashboard", "?view=conversation&location_id=L1")).toBe("/autopilot?view=bot&location_id=L1");
  expect(movedTo("/dashboard", "?view=pipeline")).toBe(null);
  expect(movedTo("/autopilot", "?view=bot")).toBe(null);
  expect(movedTo("/", "")).toBe(null);
});
