import { test, expect } from "vitest";
import { orderRows, neighborId, nextAfterRemoval, rowTargets, teachRowId, railLabel, keyIntent, allInPct, allInTone } from "../work-queue.js";

const row = (id, kind, group, over = {}) => ({ id, kind, group, severity: "soon", title: id, ops: [], ...over });

test("rows are worked your call first, then stuck, then the machine, kind by kind inside each", () => {
  const rows = [
    row("m1", "draft_scheduled", "machine"),
    row("s1", "underwrite_held", "stuck"),
    row("y2", "draft_waiting", "yours"),
    row("y1", "promise_owed", "yours"),
    row("a1", "audit_owed", "yours"),
    row("old", "closing_soon", undefined),   // an older broker sent no group: it is yours
  ];
  expect(orderRows(rows).map((r) => r.id)).toEqual(["y1", "y2", "old", "a1", "s1", "m1"]);
});

test("next and previous stop at the ends", () => {
  const list = [row("a", "promise_owed", "yours"), row("b", "promise_owed", "yours"), row("c", "gone_quiet", "stuck")];
  expect(neighborId(list, "a", 1)).toBe("b");
  expect(neighborId(list, "c", 1)).toBe(null);
  expect(neighborId(list, "a", -1)).toBe(null);
  expect(neighborId(list, "gone", 1)).toBe("a");
});

test("a resolved row hands over to the one that came after it, or before it at the end", () => {
  const before = ["a", "b", "c", "d"].map((id) => row(id, "promise_owed", "yours"));
  expect(nextAfterRemoval(before, before, "b")).toBe("b");
  expect(nextAfterRemoval(before, before.filter((r) => r.id !== "b"), "b")).toBe("c");
  expect(nextAfterRemoval(before, before.filter((r) => !["b", "c"].includes(r.id)), "b")).toBe("d");
  expect(nextAfterRemoval(before, before.filter((r) => r.id !== "d"), "d")).toBe("c");
  expect(nextAfterRemoval(before, [], "d")).toBe(null);
  expect(nextAfterRemoval([], before, null)).toBe("a");
});

test("the composer is the row's own draft, else the person's newest open one", () => {
  const drafts = [
    { id: "d1", contactId: "c1", status: "sent", party: "agent", createdAt: "2026-09-20T01:00:00Z" },
    { id: "d2", contactId: "c1", status: "draft", party: "agent", createdAt: "2026-09-20T02:00:00Z", outbound: { offerId: "o7" } },
    { id: "d3", contactId: "c1", status: "scheduled", party: "agent", createdAt: "2026-09-20T03:00:00Z" },
  ];
  expect(rowTargets(row("r", "draft_waiting", "yours", { contactId: "c1", draftId: "d2" }), drafts).draftId).toBe("d2");
  expect(rowTargets(row("r", "promise_owed", "yours", { contactId: "c1" }), drafts).draftId).toBe("d3");
  expect(rowTargets(row("r", "draft_waiting", "yours", { contactId: "c1", draftId: "d1" }), drafts).draftId).toBe("d3");   // a sent draft is history
  expect(rowTargets(row("r", "draft_waiting", "yours", { contactId: "c1", draftId: "d2" }), drafts).offerId).toBe("o7");
  expect(rowTargets(row("r", "gone_quiet", "stuck", { contactId: "c9" }), drafts).draftId).toBe(null);
});

test("a price the machine agreed with a buyer opens the investor's thread, not an agent's", () => {
  expect(rowTargets(row("r", "investor_price_agreed", "yours", { contactId: "inv1", offerId: "o1" }), []).party).toBe("investor");
  expect(rowTargets(row("r", "deal_no_buyers", "yours", { contactId: "c1" }), []).party).toBe("investor");
  expect(rowTargets(row("r", "promise_owed", "yours", { contactId: "c1" }), []).party).toBe("agent");
});

test("a draft row is taught under its draft; every other row under its own id", () => {
  expect(teachRowId(row("draft_waiting:o1", "draft_waiting", "yours", { draftId: "d9" }))).toBe("draft:d9");
  expect(teachRowId(row("promise_owed:c1:x", "promise_owed", "yours", { draftId: null }))).toBe("promise_owed:c1:x");
});

test("the rail names a row by its street, else the person", () => {
  expect(railLabel({ address: "12 Elm St, Renton, WA", contactName: "Dana" })).toBe("12 Elm St");
  expect(railLabel({ address: "", contactName: "Dana" })).toBe("Dana");
});

test("keys never fire while typing or with a modifier", () => {
  const div = { tagName: "DIV", closest: () => null };
  expect(keyIntent({ key: "j", target: div })).toBe("next");
  expect(keyIntent({ key: "ArrowUp", target: div })).toBe("prev");
  expect(keyIntent({ key: "j", target: { tagName: "TEXTAREA" } })).toBe(null);
  expect(keyIntent({ key: "j", target: { tagName: "INPUT" } })).toBe(null);
  expect(keyIntent({ key: "j", metaKey: true, target: div })).toBe(null);
  expect(keyIntent({ key: "j", target: { tagName: "BUTTON", closest: () => ({}) } })).toBe(null);   // inside an open menu
});

test("all-in reads against the 70% a buyer pays", () => {
  expect(allInPct({ price: 310000, repairs: 85000, arv: 520000 })).toBe(76);
  expect(allInTone(76)).toBe("over");
  expect(allInTone(72)).toBe("close");
  expect(allInTone(68.5)).toBe("good");
  expect(allInPct({ price: 0, arv: 500000 })).toBe(null);
});
