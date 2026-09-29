import test from "node:test";
import assert from "node:assert/strict";
import {
  CHECKLIST_TEMPLATE, normalizeChecklist, resolveChecklist, applyChecklistEdit, addChecklistItem, tickByDoc, openItemsForGate, dueWords,
} from "./deal-checklist.js";

// 3511 NE 153rd St: under contract 2026-09-29 8:42am PT, inspection ends 10/13, closes 10/30.
const DEAL = {
  stage: "under_contract", createdAt: "2026-09-29T15:42:29.736Z", inspectionDate: "2026-10-13", closingDate: "2026-10-30",
  stageHistory: [{ stage: "under_contract", ts: "2026-09-29T15:42:29.736Z" }], investors: [],
};
const at = (ymd, hh = "18") => Date.parse(`${ymd}T${hh}:00:00Z`);
const item = (r, id) => r.items.find((i) => i.id === id);

test("a deal with no checklist reads the standard one, with dates off the contract, inspection and closing", () => {
  const r = resolveChecklist(DEAL, { now: at("2026-09-29") });
  assert.equal(r.items.length, CHECKLIST_TEMPLATE.length);
  assert.equal(item(r, "earnest_money").dueYmd, "2026-10-02");
  assert.equal(item(r, "inspection").dueYmd, "2026-10-13");
  assert.equal(item(r, "recorded").dueYmd, "2026-10-30");
  assert.equal(item(r, "seller_signs").dueYmd, "2026-10-28");
  assert.equal(r.currentGate, "under_contract");
  assert.deepEqual(r.gates.under_contract, { done: 0, total: 6 });
  // A later gate's work isn't chased before the deal gets there.
  assert.equal(item(r, "recorded").state, "later");
  assert.equal(item(r, "assignment_signed").dueYmd, "", "dated from when the deal reaches Buyer found");
});

test("the most overdue thing in the current gate is what to chase next", () => {
  const r = resolveChecklist(DEAL, { now: at("2026-10-04") });
  assert.equal(r.next.id, "psa_signed");
  assert.equal(r.next.state, "overdue");
  assert.equal(dueWords(r.next), "5d overdue");
  const signed = resolveChecklist({ ...DEAL, checklist: applyChecklistEdit(null, { id: "psa_signed", done: true }) }, { now: at("2026-10-04") });
  assert.equal(signed.next.id, "open_escrow");
});

test("a Purchase & sale on the deal ticks its item, and so does the upload hook", () => {
  const r = resolveChecklist(DEAL, { docs: [{ kind: "Purchase & sale" }], now: at("2026-09-30") });
  assert.equal(item(r, "psa_signed").done, true);
  const ticked = tickByDoc(null, "Assignment", at("2026-09-30"));
  assert.equal(ticked.items.find((i) => i.id === "assignment_signed").done, true);
});

test("a date typed on the item beats the rule, and clearing it goes back to the rule", () => {
  let c = applyChecklistEdit(null, { id: "earnest_money", due: "2026-10-06" });
  assert.equal(item(resolveChecklist({ ...DEAL, checklist: c }, { now: at("2026-09-29") }), "earnest_money").dueYmd, "2026-10-06");
  c = applyChecklistEdit(c, { id: "earnest_money", due: "" });
  assert.equal(item(resolveChecklist({ ...DEAL, checklist: c }, { now: at("2026-09-29") }), "earnest_money").dueYmd, "2026-10-02");
});

test("a removed item stays removed, and an added one lands at the end of its gate", () => {
  let c = applyChecklistEdit(null, { id: "lender_clear", remove: true });
  assert.equal(c.items.some((i) => i.id === "lender_clear"), false);
  c = addChecklistItem(c, { gate: "under_contract", label: "HOA docs from seller", owner: "sellerAgent", due: "2026-10-05" });
  const ids = normalizeChecklist(c).items.map((i) => i.id);
  const added = c.items.find((i) => i.custom);
  assert.equal(ids.indexOf(added.id), ids.indexOf("walkthrough") + 1);
  assert.equal(added.owner, "sellerAgent");
  assert.equal(normalizeChecklist(c).items.some((i) => i.id === "lender_clear"), false);
});

test("the gate follows the stage, and Buyer found items date from when it got there", () => {
  const found = { ...DEAL, stage: "buyer_found", stageHistory: [...DEAL.stageHistory, { stage: "buyer_found", ts: "2026-10-05T17:00:00Z" }] };
  const r = resolveChecklist(found, { now: at("2026-10-06") });
  assert.equal(r.currentGate, "buyer_found");
  assert.equal(item(r, "assignment_signed").dueYmd, "2026-10-07");
  // Leftovers from the gate before are still chased.
  assert.equal(r.open.some((i) => i.id === "earnest_money"), true);
  assert.equal(openItemsForGate(found, "under_contract", { now: at("2026-10-06") }).length, 6);
  assert.equal(resolveChecklist({ ...DEAL, stage: "closed" }).currentGate, null);
});

test("the walkthrough is due on the first window and done once somebody walked it", () => {
  const withWindow = { ...DEAL, showing: { windows: [{ start: "2026-10-03T17:00:00Z", end: "2026-10-03T19:00:00Z" }], rsvps: [] } };
  assert.equal(item(resolveChecklist(withWindow, { now: at("2026-09-30") }), "walkthrough").dueYmd, "2026-10-03");
  const walked = { ...withWindow, showing: { ...withWindow.showing, rsvps: [{ contactId: "b1", status: "attended" }] } };
  assert.equal(item(resolveChecklist(walked, { now: at("2026-10-04") }), "walkthrough").done, true);
});
