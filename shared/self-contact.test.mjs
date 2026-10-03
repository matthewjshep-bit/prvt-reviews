import test from "node:test";
import assert from "node:assert/strict";
import { selfNames, isSelfName, selfContactIds, withoutSelf } from "./self-contact.js";

const names = selfNames({ company: { signer: "Matthew Shepherd" }, persona: { name: "Matt" } });

// 2026-09-28: Matt's own test contact topped Today with a follow-up to himself.
test("Matt's own contact is not a row on Today", () => {
  const rows = [
    { id: "draft_waiting:d1", contactId: "c-matt", contactName: "Matt Shepherd" },
    { id: "gone_quiet:o2", contactId: "c-matt", contactName: "" },
    { id: "draft_waiting:d3", contactId: "c-agent", contactName: "Jane Example" },
  ];
  const ids = selfContactIds(rows, names);
  assert.deepEqual([...ids], ["c-matt"]);
  assert.deepEqual(withoutSelf(rows, ids).map((r) => r.id), ["draft_waiting:d3"], "every row for that contact goes, named or not");
});

test("another Matt, or another Shepherd, is still work", () => {
  assert.equal(isSelfName("Matt Smith", names), false);
  assert.equal(isSelfName("Sarah Shepherd", names), false);
  assert.equal(isSelfName("Matt", names), false, "a first name alone is not us");
  assert.equal(isSelfName("Matthew Shepherd", names), true);
  assert.equal(isSelfName("matt  shepherd", names), true);
});

test("with no name in settings nothing is hidden", () => {
  const rows = [{ contactId: "c1", contactName: "Matt Shepherd" }];
  assert.deepEqual(selfNames({ company: { signer: "" }, persona: { name: "Matt" } }), []);
  assert.equal(withoutSelf(rows, selfContactIds(rows, [])).length, 1);
});
