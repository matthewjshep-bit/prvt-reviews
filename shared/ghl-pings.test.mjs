// ghl-pings.test.mjs — the few things only Matt can do, pinged through GHL.

import test from "node:test";
import assert from "node:assert/strict";
import { normalizeGhlPings, ghlPingsOn, pingWhy, pingClaimKey } from "./ghl-pings.js";
import { pingReasons } from "./hand-off.js";
import { normalizeDesk } from "./call-list.js";

test("pings ship off, and need a workflow link to go anywhere", () => {
  const d = normalizeDesk({});
  assert.deepEqual(d.ghlPings, { enabled: false, workflowId: "", from: 8, until: 20 });
  assert.equal(ghlPingsOn(normalizeGhlPings({ enabled: true })), false);
  const on = normalizeGhlPings({ enabled: true, workflowId: "https://app.gohighlevel.com/location/L1/workflow/0a1b2c3d-4e5f" });
  assert.equal(on.workflowId, "0a1b2c3d-4e5f");
  assert.equal(ghlPingsOn(on), true);
  assert.equal(normalizeGhlPings({ from: 20, until: 9 }).until, 20, "a window that ends before it starts keeps the default end");
});

// 2026-10-20, no Today: paperwork to sign and a closing task ping Matt; a
// house to price, a call and a held thanks never do.
test("only what only Matt can do pings him, once per thing, folded rows included", () => {
  const rows = [
    { id: "paper_to_sign:o1", kind: "paper_to_sign", contactId: "c1", title: "Wetmore: paperwork to sign", also: [{ id: "promise_owed:c1:x", kind: "promise_owed", what: "number" }] },
    { id: "closing_task_due:o2", kind: "closing_task_due", contactId: "c2", title: "3831 Bagley: Purchase & sale signed" },
    { id: "price_it:o3", kind: "price_it", contactId: "c3", title: "Price it" },
    { id: "call_brought:c4", kind: "call_brought", contactId: "c4" },
    { id: "pre_contract:o5", kind: "pre_contract", title: "no contact" },
    { id: "promise_owed:c6:y", kind: "promise_owed", contactId: "c6", what: "answer", title: "we owe them an answer" },
  ];
  assert.deepEqual(pingReasons(rows).map((r) => r.id), ["paper_to_sign:o1", "closing_task_due:o2", "promise_owed:c6:y"]);
});

test("the ping says what it is and where to do it, and a new closing task is a new ping", () => {
  assert.equal(pingWhy({ kind: "closing_task_due", title: "3831 Bagley: Purchase & sale signed" }), "3831 Bagley: Purchase & sale signed — in Deals");
  const a = pingClaimKey({ id: "closing_task_due:o2", title: "3831 Bagley: Purchase & sale signed" });
  const b = pingClaimKey({ id: "closing_task_due:o2", title: "3831 Bagley: Inspection done" });
  assert.notEqual(a, b);
  assert.equal(a, pingClaimKey({ id: "closing_task_due:o2", title: "3831 Bagley: Purchase & sale signed" }));
});
