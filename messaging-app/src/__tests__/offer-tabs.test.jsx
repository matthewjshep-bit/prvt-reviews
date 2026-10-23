import { test, expect } from "vitest";
import { TABS, SUBS, OTHER, ALL_VIEWS, defaultTab, tabOf, notSentAge, waitingSince } from "../offer-tabs.js";

const NOW = Date.parse("2026-10-07T18:00:00Z");
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const row = (extra = {}) => ({ id: Math.random().toString(36).slice(2), address: "1 Main St", cashAmount: 300000, createdAt: ago(3), ...extra });

const ROWS = [
  row({ id: "hot-floated", status: "new", floatSentAt: ago(2), hot: { at: ago(1), by: "operator" } }),
  row({ id: "hot-sent", status: "sent", sends: [{ ts: ago(2) }], realm: { answer: "yes", ts: ago(1) } }),
  row({ id: "unsent", status: "new" }),
  row({ id: "floated", status: "new", floatedAt: ago(5) }),
  row({ id: "sent", status: "sent", sends: [{ ts: ago(2) }] }),
  row({ id: "countered", status: "countered", sends: [{ ts: ago(2) }] }),
  row({ id: "we-passed", status: "we_passed" }),
  row({ id: "no-reply", status: "no_response", sends: [{ ts: ago(20) }] }),
  row({ id: "draft", status: "draft" }),
  row({ id: "deal", status: "accepted", deal: { stage: "under_contract" } }),
  row({ id: "old", status: "new", supersededBy: { id: "unsent", cashAmount: 290000 } }),
];
const ids = (key) => ROWS.filter(ALL_VIEWS.find((t) => t.key === key).test).map((o) => o.id);

// Matt, 2026-10-23: a number the bot texted showed under Sent with a "Not
// sent" pill. Sent is the written offer going out, nothing less.
test("Draft holds held drafts, priced offers, and numbers we only texted — the letter hasn't gone", () => {
  expect(ids("draft")).toEqual(["unsent", "floated", "draft"]);
});

test("Sent holds only the offers whose written letter went out", () => {
  expect(ids("sent")).toEqual(["sent"]);
});

test("Responded holds every answer, one chip each, and no reply after the follow-ups counts as passed", () => {
  expect(ids("responded")).toEqual(["hot-floated", "hot-sent", "countered", "we-passed", "no-reply", "deal"]);
  expect(ids("hot")).toEqual(["hot-floated", "hot-sent"]);
  expect(ids("countered")).toEqual(["countered"]);
  expect(ids("accepted")).toEqual(["deal"]);
  expect(ids("passed")).toEqual(["we-passed", "no-reply"]);
});

test("every current row is in exactly one stage, and a replaced row in none", () => {
  for (const o of ROWS) {
    const n = TABS.filter((t) => t.test(o)).length;
    expect(n, o.id).toBe(o.id === "old" ? 0 : 1);
  }
  const subs = SUBS.flatMap((t) => ROWS.filter(t.test).map((o) => o.id));
  expect(new Set(subs).size).toBe(subs.length);
});

test("a Responded chip lights the Responded tab", () => {
  for (const s of SUBS) expect(tabOf(s.key)).toBe("responded");
  expect(tabOf("draft")).toBe("draft");
  expect(tabOf("all")).toBe("all");
});

test("the tabs read Draft · Sent · Responded; the rest are under Other", () => {
  expect(TABS.map((t) => t.label)).toEqual(["Draft", "Sent", "Responded"]);
  expect(OTHER.map((v) => v.key)).toEqual(["all", "offmarket", "nofollow", "ai"]);
});

test("a number we texted says how long ago it floated; a priced one, how long since we priced it", () => {
  expect(notSentAge(ROWS.find((o) => o.id === "floated"), NOW)).toBe("Floated 5d ago");
  expect(notSentAge(row({ floatSentAt: ago(2) }), NOW)).toBe("Floated 2d ago");
  expect(notSentAge(ROWS.find((o) => o.id === "unsent"), NOW)).toBe("Priced 3d ago");
  expect(notSentAge(row({ createdAt: new Date(NOW - 3600000).toISOString() }), NOW)).toBe("Priced today");
});

test("waiting sorts oldest first by how long it has waited", () => {
  const rows = [row({ id: "a", createdAt: ago(1) }), row({ id: "b", floatedAt: ago(6), createdAt: ago(7) }), row({ id: "c", createdAt: ago(4) })];
  expect([...rows].sort((x, y) => waitingSince(x) - waitingSince(y)).map((o) => o.id)).toEqual(["b", "c", "a"]);
});

test("it opens on Hot, or Draft when nothing is hot", () => {
  expect(defaultTab(ROWS)).toBe("hot");
  expect(defaultTab(ROWS.filter((o) => !o.id.startsWith("hot")))).toBe("draft");
});
