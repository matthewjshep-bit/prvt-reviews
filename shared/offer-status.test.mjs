// offer-status.test.mjs — the offer lifecycle.
//
// The failures this guards against, in order of how much they'd cost:
//
//   1. A backfill that never ran. Every offer written before this field existed
//      has no `status` key. If effectiveStatus() didn't infer one, the whole
//      history would render as "Not sent" and the funnel numbers would be zero.
//   2. A clock overwriting a human. If isExpired() didn't check the status
//      first, an offer you personally marked "passed" would flip to "expired"
//      the moment its validity lapsed — losing the outcome you recorded.
//   3. A send walking an offer backwards. Re-texting the docs to an agent who
//      already countered must not reset them to "sent".
//   4. A list row that lost something the table draws. toListOffer() is what
//      lets the history page hold every offer instead of the newest hundred —
//      but only the fields it keeps ever reach the screen, so a key dropped
//      here is a column that silently goes blank.
//
//   node --test offer-status.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEAD_STATUSES,
  OFFER_STATUS,
  OFFER_STATUS_KEYS,
  OPEN_STATUSES,
  SETTABLE_STATUSES,
  STATUS_RANK,
  effectiveStatus,
  isExpired,
  offerExpiresAt,
  statusAfterSend,
  statusAfterUnpromote,
  toListOffer,
} from "./offer-status.js";

const iso = (d) => d.toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 86400000);

test("legacy rows infer a status without a backfill", () => {
  assert.equal(effectiveStatus({}), "new");
  assert.equal(effectiveStatus({ sends: [] }), "new");
  assert.equal(effectiveStatus({ sends: [{ ts: iso(new Date()) }] }), "sent");
  // A promoted offer is accepted regardless of what else is on the row.
  assert.equal(effectiveStatus({ deal: { stage: "under_contract" } }), "accepted");
  assert.equal(effectiveStatus({ sends: [{}], deal: {} }), "accepted");
  // Drafts and explicit values always win over inference.
  assert.equal(effectiveStatus({ status: "draft" }), "draft");
  assert.equal(effectiveStatus({ status: "passed", sends: [{}], deal: {} }), "passed");
  assert.equal(effectiveStatus(null), "new");
});

test("every status carries display metadata and draft is not settable", () => {
  for (const key of OFFER_STATUS_KEYS) {
    assert.ok(OFFER_STATUS[key].label, `${key} needs a label`);
    assert.ok(OFFER_STATUS[key].cls, `${key} needs pill classes`);
    assert.ok(OFFER_STATUS[key].dot, `${key} needs a dot color`);
  }
  assert.ok(!SETTABLE_STATUSES.includes("draft"));
  assert.equal(SETTABLE_STATUSES.length, OFFER_STATUS_KEYS.length - 1);
  // Open and dead partition everything except draft and accepted.
  for (const key of SETTABLE_STATUSES) {
    if (key === "accepted") continue;
    assert.ok(OPEN_STATUSES.has(key) !== DEAD_STATUSES.has(key), `${key} must be open xor dead`);
  }
  // Tag precedence has to be total, or two offers could both claim the tag.
  const ranks = SETTABLE_STATUSES.map((k) => STATUS_RANK[k]);
  assert.equal(new Set(ranks).size, ranks.length, "ranks must be distinct");
});

test("expiry prefers the picker, then validity days, then the printed label", () => {
  // The explicit picker wins, parsed as a LOCAL date — not UTC, which would
  // land on the previous day for anyone west of Greenwich.
  const picked = offerExpiresAt({ calc: { settings: { offerExpires: "2026-09-01", validityDays: 7 } } });
  assert.equal(picked.getFullYear(), 2026);
  assert.equal(picked.getMonth(), 8);
  assert.equal(picked.getDate(), 1);

  const created = daysAgo(10);
  const byDays = offerExpiresAt({ createdAt: iso(created), calc: { settings: { validityDays: 14 } } });
  assert.equal(Math.round((byDays - created) / 86400000), 14);

  // Rows saved before calc settings were snapshotted still have the label.
  const byLabel = offerExpiresAt({ validLabel: "September 1, 2026" });
  assert.equal(byLabel.getFullYear(), 2026);
  assert.equal(byLabel.getMonth(), 8);

  assert.equal(offerExpiresAt({}), null);
  assert.equal(offerExpiresAt({ createdAt: "not a date", calc: { settings: { validityDays: 7 } } }), null);
});

test("expiry never overwrites an outcome a human recorded", () => {
  const lapsed = { createdAt: iso(daysAgo(30)), calc: { settings: { validityDays: 7 } } };

  assert.equal(isExpired({ ...lapsed, status: "sent" }), true);
  assert.equal(isExpired({ ...lapsed, status: "countered" }), true);
  assert.equal(isExpired({ ...lapsed, status: "new" }), true);

  // These already ended — the clock has nothing left to say about them.
  assert.equal(isExpired({ ...lapsed, status: "passed" }), false);
  assert.equal(isExpired({ ...lapsed, status: "no_response" }), false);
  assert.equal(isExpired({ ...lapsed, status: "accepted" }), false);
  assert.equal(isExpired({ ...lapsed, status: "draft" }), false);

  // Still in date, and undeterminable dates never expire.
  const fresh = { createdAt: iso(daysAgo(1)), status: "sent", calc: { settings: { validityDays: 14 } } };
  assert.equal(isExpired(fresh), false);
  assert.equal(isExpired({ status: "sent" }), false);
});

test("a send moves an offer forward only", () => {
  assert.equal(statusAfterSend({}), "sent");
  assert.equal(statusAfterSend({ status: "new" }), "sent");
  assert.equal(statusAfterSend({ status: "draft" }), "sent");
  // Re-sending the documents must not undo what the agent told us.
  assert.equal(statusAfterSend({ status: "countered" }), "countered");
  assert.equal(statusAfterSend({ status: "passed" }), "passed");
  assert.equal(statusAfterSend({ status: "accepted" }), "accepted");
});

test("un-promoting a deal restores the pre-acceptance truth", () => {
  assert.equal(statusAfterUnpromote({ status: "accepted", sends: [{}] }), "sent");
  assert.equal(statusAfterUnpromote({ status: "accepted", sends: [] }), "new");
  // A legacy deal row with no status still un-promotes correctly.
  assert.equal(statusAfterUnpromote({ deal: {}, sends: [{}] }), "sent");
  // Anything not accepted is left exactly as it is.
  assert.equal(statusAfterUnpromote({ status: "countered" }), "countered");
});

test("a list row keeps what the table draws and drops the weight", () => {
  const offer = {
    id: "o1", contactId: "c1", contactName: "Jeffrey Menday",
    address: "741 North 128th Street, Seattle, Washington 98133",
    cashAmount: 412000, status: "passed", createdAt: "2026-08-11T18:20:55.973Z",
    sends: [{ channels: ["text"] }], ghl: { fields: true, note: true, tag: true },
    pdfUrl: "https://x/o1.pdf", contractPdfUrl: "https://x/o1-contract.pdf",
    // the four keys that are ~90% of a stored offer
    snapshot: { comps: new Array(50).fill({ address: "a" }) },
    calc: { inputs: { arv: 500000 }, settings: { validityDays: 7 } },
    draft: { inputs: {} },
    scope: [{ item: "roof" }],
  };
  const row = toListOffer(offer);

  for (const k of ["id", "contactId", "contactName", "address", "cashAmount",
                   "status", "createdAt", "sends", "ghl", "pdfUrl", "contractPdfUrl"]) {
    assert.deepEqual(row[k], offer[k], `the table renders ${k}`);
  }
  for (const k of ["snapshot", "calc", "draft", "scope"]) {
    assert.equal(row[k], undefined, `${k} must not ride along`);
  }
  assert.equal(row.listOnly, true, "rows announce that they are not documents");
  // Modest fixture; against production docs the row is ~1KB against ~9KB.
  assert.ok(JSON.stringify(row).length * 3 < JSON.stringify(offer).length);

  // The ⏱ marker reads calc.settings, which is exactly what was dropped — so
  // the date rides along precomputed and must land on the same instant.
  assert.equal(offerExpiresAt(row).getTime(), offerExpiresAt(offer).getTime());
  assert.equal(isExpired(row), isExpired(offer));
  // Status inference must still work off a row alone.
  assert.equal(effectiveStatus(row), "passed");
  assert.equal(effectiveStatus(toListOffer({ sends: [{}] })), "sent");
  // Re-trimming a row changes nothing (patching the list runs it again).
  assert.deepEqual(toListOffer(row), row);
});
