import test from "node:test";
import assert from "node:assert/strict";
import {
  CHECKLIST_TEMPLATE, normalizeChecklist, resolveChecklist, applyChecklistEdit, addChecklistItem, tickByDoc, openItemsForGate, dueWords,
  promoteDates, checklistForTerms, pacificYmd, addDays,
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

/* ---------- dates from the paper, in Pacific days (2026-11-09) ---------- */

// An inspection period lapsed with no notice and an earnest date had to be
// found by phone: promote guessed the dates from the server's own (UTC) day
// and never read the purchase & sale we wrote.
const SIX_PM_PACIFIC = Date.parse("2026-10-21T01:00:00Z"); // 6pm on Oct 20 in Seattle, Oct 21 in UTC
const WRITE_UP = { earnestMoney: 1000, earnestDue: "after inspection", inspectionDays: 14, closeDays: 21, fromWriteUp: true };

test("the Pacific day and day arithmetic are the ones the checklist counts in", () => {
  assert.equal(pacificYmd(SIX_PM_PACIFIC), "2026-10-20");
  assert.equal(addDays("2026-10-20", 10), "2026-10-30");
  assert.equal(addDays("2026-03-07", 2), "2026-03-09", "a daylight-saving weekend is still two days");
});

test("deal dates come from the PSA first, then the contract, then the letter, then our standard terms", () => {
  const psa = { mode: "standard", feasibilityDays: 7, closingDate: "2026-11-20", earnestMoney: 1500, earnestDue: "acceptance" };
  const contract = { inspectionDays: 12, closingDate: "2026-11-30", earnestMoney: 2000 };
  let d = promoteDates({ offer: { psa: { fields: psa }, contract: { fields: contract } }, terms: WRITE_UP, now: SIX_PM_PACIFIC });
  assert.deepEqual([d.inspectionDate, d.closingDate, d.earnestMoney, d.earnestDue], ["2026-10-27", "2026-11-20", 1500, "acceptance"]);
  assert.deepEqual(d.from, { inspection: "psa", closing: "psa", earnest: "psa" });

  d = promoteDates({ offer: { contract: { fields: contract } }, terms: WRITE_UP, now: SIX_PM_PACIFIC });
  assert.deepEqual([d.inspectionDate, d.closingDate, d.earnestMoney], ["2026-11-01", "2026-11-30", 2000]);
  assert.deepEqual(d.from, { inspection: "contract", closing: "contract", earnest: "contract" });

  // The letter said ten days; our standard terms set the close.
  d = promoteDates({ offer: { terms: { inspectionDays: 10, earnestMoney: 1000 } }, terms: WRITE_UP, now: SIX_PM_PACIFIC });
  assert.deepEqual([d.inspectionDate, d.closingDate, d.earnestMoney, d.earnestDue], ["2026-10-30", "2026-11-10", 1000, "feasibility"]);
  assert.deepEqual(d.from, { inspection: "letter", closing: "terms", earnest: "letter" });

  // A letter that named its closing days closes on those, not on today's settings.
  d = promoteDates({ offer: { terms: { inspectionDays: 10, closingDays: 30 } }, terms: WRITE_UP, now: SIX_PM_PACIFIC });
  assert.deepEqual([d.closingDate, d.from.closing], ["2026-11-19", "letter"]);

  d = promoteDates({ offer: {}, terms: WRITE_UP, now: SIX_PM_PACIFIC });
  assert.deepEqual([d.inspectionDate, d.from.inspection], ["2026-11-03", "terms"]);

  // Nothing saved anywhere: ten days, no closing date, earnest on acceptance.
  d = promoteDates({ offer: {}, terms: { earnestMoney: 2500, earnestDue: "", inspectionDays: 0, closeDays: 0, fromWriteUp: false }, now: SIX_PM_PACIFIC });
  assert.deepEqual([d.inspectionDate, d.closingDate, d.earnestDue], ["2026-10-30", "", "acceptance"]);
  assert.deepEqual(d.from, { inspection: "default", closing: "", earnest: "terms" });

  // What you typed at promote beats all of it.
  d = promoteDates({ offer: { psa: { fields: psa } }, body: { inspectionDate: "2026-11-03", closingDate: "2026-12-01" }, terms: WRITE_UP, now: SIX_PM_PACIFIC });
  assert.deepEqual([d.inspectionDate, d.closingDate, d.from.inspection, d.from.closing], ["2026-11-03", "2026-12-01", "you", "you"]);
});

// The letter and the write-up terms name a window ("10 to 14 day inspection").
// Ending a guessed period on its last day would put the warning after a
// 10-day period on the signed paper had already run out.
test("a guessed inspection window ends on its shortest day, so the warning never comes after the real deadline", () => {
  let d = promoteDates({ offer: { terms: { inspectionDays: 14, inspectionDaysMin: 10 } }, terms: WRITE_UP, now: SIX_PM_PACIFIC });
  assert.deepEqual([d.inspectionDate, d.from.inspection], ["2026-10-30", "letter"]);
  d = promoteDates({ offer: {}, terms: { ...WRITE_UP, inspectionDaysMin: 10 }, now: SIX_PM_PACIFIC });
  assert.deepEqual([d.inspectionDate, d.from.inspection], ["2026-10-30", "terms"]);
  // A PSA states one number, and that is the one.
  d = promoteDates({ offer: { psa: { fields: { mode: "standard", feasibilityDays: 14 } }, terms: { inspectionDays: 14, inspectionDaysMin: 10 } }, terms: { ...WRITE_UP, inspectionDaysMin: 10 }, now: SIX_PM_PACIFIC });
  assert.deepEqual([d.inspectionDate, d.from.inspection], ["2026-11-03", "psa"]);
});

test("a short sale's inspection waits on the lienholder, so promote leaves its date for you", () => {
  const d = promoteDates({ offer: { psa: { fields: { mode: "short_sale", feasibilityDays: 10, closingDays: 30 } } }, terms: WRITE_UP, now: SIX_PM_PACIFIC });
  assert.equal(d.inspectionDate, "");
  assert.equal(d.from.inspection, "psa_short_sale");
  assert.equal(d.closingDate, "");
});

test("earnest due after the inspection is chased three days after it ends, not three days after the contract", () => {
  const deal = { ...DEAL, checklist: checklistForTerms(null, { earnestDue: "feasibility" }) };
  const r = resolveChecklist(deal, { now: at("2026-10-04") });
  assert.equal(item(r, "earnest_money").dueYmd, "2026-10-16");
  assert.equal(item(r, "earnest_money").state, "open", "not overdue on day five");
  assert.match(item(r, "earnest_money").label, /after the inspection/);
  // Due on acceptance: the template stands.
  assert.equal(item(resolveChecklist({ ...DEAL, checklist: checklistForTerms(null, { earnestDue: "acceptance" }) }, { now: at("2026-09-29") }), "earnest_money").dueYmd, "2026-10-02");
});

// A committed buyer backs out and a second one commits: their assignment is
// chased from the day they committed, not from the first buyer's.
test("a second buyer's paperwork is dated from the day they committed", () => {
  const twice = { ...DEAL, stage: "buyer_found", stageHistory: [
    ...DEAL.stageHistory,
    { stage: "buyer_found", ts: "2026-10-05T17:00:00Z" },
    { stage: "under_contract", ts: "2026-10-08T17:00:00Z", reason: "buyer_backed_out" },
    { stage: "buyer_found", ts: "2026-10-10T17:00:00Z" },
  ] };
  const r = resolveChecklist(twice, { now: at("2026-10-10") });
  assert.equal(item(r, "assignment_signed").dueYmd, "2026-10-12");
});
