import { test, expect } from "vitest";
import { TABS, OTHER, ALL_VIEWS, defaultTab, notSentAge, waitingSince } from "../offer-tabs.js";

const NOW = Date.parse("2026-10-07T18:00:00Z");
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const row = (extra = {}) => ({ id: Math.random().toString(36).slice(2), address: "1 Main St", cashAmount: 300000, createdAt: ago(3), ...extra });

const ROWS = [
  row({ id: "hot-unsent", status: "new", hot: { at: ago(1), by: "operator" } }),
  row({ id: "hot-sent", status: "sent", sends: [{ ts: ago(2) }], realm: { answer: "yes", ts: ago(1) } }),
  row({ id: "unsent", status: "new" }),
  row({ id: "floated", status: "new", floatedAt: ago(5) }),
  row({ id: "sent", status: "sent", sends: [{ ts: ago(2) }] }),
  row({ id: "countered", status: "countered", sends: [{ ts: ago(2) }] }),
  row({ id: "passed", status: "we_passed" }),
  row({ id: "draft", status: "draft" }),
  row({ id: "deal", status: "accepted", deal: { stage: "under_contract" } }),
  row({ id: "old", status: "new", supersededBy: { id: "unsent", cashAmount: 290000 } }),
];
const inTab = (key) => ROWS.filter(TABS.find((t) => t.key === key).test).map((o) => o.id);

test("a hot offer never sent is in Hot, not Not sent", () => {
  expect(inTab("hot")).toEqual(["hot-unsent", "hot-sent"]);
  expect(inTab("unsent")).not.toContain("hot-unsent");
});

test("the three tabs never share a row", () => {
  const seen = TABS.flatMap((t) => ROWS.filter(t.test).map((o) => o.id));
  expect(new Set(seen).size).toBe(seen.length);
});

test("Not sent holds floated and never-floated offers, and says which and how long ago", () => {
  expect(inTab("unsent")).toEqual(["unsent", "floated"]);
  expect(notSentAge(ROWS.find((o) => o.id === "floated"), NOW)).toBe("Floated 5d ago");
  expect(notSentAge(ROWS.find((o) => o.id === "unsent"), NOW)).toBe("Priced 3d ago");
  expect(notSentAge(row({ createdAt: new Date(NOW - 3600000).toISOString() }), NOW)).toBe("Priced today");
});

test("Not sent sorts oldest first by how long it has waited", () => {
  const rows = [row({ id: "a", createdAt: ago(1) }), row({ id: "b", floatedAt: ago(6), createdAt: ago(7) }), row({ id: "c", createdAt: ago(4) })];
  expect([...rows].sort((x, y) => waitingSince(x) - waitingSince(y)).map((o) => o.id)).toEqual(["b", "c", "a"]);
});

test("Sent holds countered too, and nothing passed, drafted, superseded or under contract is in a tab", () => {
  expect(inTab("sent")).toEqual(["sent", "countered"]);
  for (const id of ["passed", "draft", "deal", "old"]) {
    expect(TABS.some((t) => t.test(ROWS.find((o) => o.id === id)))).toBe(false);
  }
});

test("there's no Single family chip; the rest are under Closed / other", () => {
  expect(ALL_VIEWS.map((v) => v.label).join(" ")).not.toMatch(/single family/i);
  expect(ALL_VIEWS.some((v) => v.key === "sfr")).toBe(false);
  expect(OTHER.map((v) => v.key)).toEqual(["all", "deals", "dead", "drafts", "offmarket", "nofollow", "ai"]);
});

test("it opens on Hot, or Not sent when nothing is hot", () => {
  expect(defaultTab(ROWS)).toBe("hot");
  expect(defaultTab(ROWS.filter((o) => !o.id.startsWith("hot")))).toBe("unsent");
});
