import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BuyerMoney } from "../DealsView.jsx";
import { assignmentDefaults } from "../AssignmentModal.jsx";

// 2026-11-09: how a buyer pays was unknown in 283 of 307 buyer threads, and
// a buyer who took a contract was still lining up money three days later
// with nothing on the deal saying so.
test("a buyer who says they use hard money has it on the deal row", () => {
  const html = renderToStaticMarkup(<BuyerMoney fact={{ value: "hard_money", at: "2026-10-30T19:00:00Z" }} />);
  expect(html).toContain("pays: hard money (said 10/30)");
  expect(renderToStaticMarkup(<BuyerMoney fact={null} />)).toContain("pays: unknown");
});

test("the buyer who committed shows no proof of funds until the checklist has it", () => {
  expect(renderToStaticMarkup(<BuyerMoney fact={{ value: "cash" }} committed />)).toContain("pays: cash · no proof of funds on file");
  expect(renderToStaticMarkup(<BuyerMoney fact={{ value: "cash" }} committed proofOnFile />)).not.toContain("proof of funds");
});

// The assignment used to open at contract price plus fee even when the
// buyer had agreed a different number in the thread.
const offer = (over = {}) => ({
  id: "o1", address: "77 Larkspur Way, Fife, WA", cashAmount: 300000,
  deal: { contractPrice: 300000, assignmentFee: 20000, investors: [
    { contactId: "b1", name: "Corin", status: "evaluating" },
    { contactId: "b2", name: "Dale", status: "committed", agreedPrice: { amount: 331500, at: "2026-11-02T18:00:00Z", via: "investor_band" } },
  ] },
  ...over,
});

test("the assignment opens at the price the buyer agreed", () => {
  const f = assignmentDefaults(offer(), {});
  expect(f.assigneeName).toBe("Dale");
  expect(f.totalPrice).toBe(331500);
  // The assignee named on the deal is the buyer whose price it opens at.
  const named = offer();
  named.deal.parties = { assignee: { contactId: "b2", name: "Dale Holdings LLC" } };
  expect(assignmentDefaults(named, {}).totalPrice).toBe(331500);
  // No agreed price: contract price plus the fee, as before.
  const plain = offer();
  delete plain.deal.investors[1].agreedPrice;
  expect(assignmentDefaults(plain, {}).totalPrice).toBe(320000);
  // What was typed into the last assignment is kept.
  expect(assignmentDefaults({ ...offer(), assignment: { fields: { totalPrice: "325000" } } }, {}).totalPrice).toBe("325000");
});
