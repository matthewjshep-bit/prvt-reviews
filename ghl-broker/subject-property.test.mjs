import test from "node:test";
import assert from "node:assert/strict";
import {
  SUBJECT_PROPERTY_FIELD, AGENT_ENRICH_FIELDS, enrichFieldDefs, seedSubjectProperty,
} from "./enrich.js";
import { APP_FIELD_REGISTRY, registryByKey } from "./field-registry.js";

/* ---------- the field is defined once and reachable from everywhere ---------- */

test("Subject Property is defined exactly once across the whole registry", () => {
  // Two subsystems write it — the outreach import seeds it, the AI keeps it
  // current — and a second definition is how the key and the display name
  // drift apart. GHL derives its fieldKey from the display NAME, so a drift
  // there silently creates a second field in the account.
  const rows = APP_FIELD_REGISTRY.filter((f) => f.key === "subject_property");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Subject Property");
  assert.equal(rows[0].dataType, "TEXT");
  assert.equal(registryByKey.get("subject_property").name, "Subject Property");
});

test("no key in the registry is defined twice", () => {
  const keys = APP_FIELD_REGISTRY.map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("the AI is asked to maintain it on agents, and not on investors", () => {
  assert.ok(AGENT_ENRICH_FIELDS.some((f) => f.key === "subject_property"));
  assert.ok(enrichFieldDefs("agent").some((f) => f.key === "subject_property"));
  assert.equal(enrichFieldDefs("investor").some((f) => f.key === "subject_property"), false);
});

test("its hint tells the model to hold the value rather than blank it", () => {
  // The failure that matters: an agent sends "sounds good" and the model
  // helpfully returns "" because no property was named in the newest message.
  // That would silently un-aim the auto-underwrite.
  const hint = SUBJECT_PROPERTY_FIELD.hint;
  assert.match(hint, /Keep the existing value/);
  assert.match(hint, /Never invent/);
});

/* ---------- seeding, without clobbering ---------- */
// The shipped function, not a restatement of it. The route's behaviour end to
// end is covered separately in outreach-import.test.mjs.

const FID = "fld-subject";
const seed = (value, hookAddress) =>
  seedSubjectProperty({
    contact: value === null ? null : { customFields: [{ id: FID, value }] },
    fieldId: FID,
    hookAddress,
  });

test("a contact being CREATED always seeds — there is nothing to preserve", () => {
  // The common case: outreach creates the contact, so `contact` is null.
  assert.equal(seed(null, "1911 9th Ave W, Seattle, WA"), "1911 9th Ave W, Seattle, WA");
});

test("an existing contact with an empty field is seeded with the hook address", () => {
  assert.equal(seed("", "1911 9th Ave W"), "1911 9th Ave W");
  assert.equal(seed(undefined, "1911 9th Ave W"), "1911 9th Ave W");
});

test("a re-import never overwrites a subject the conversation has moved on", () => {
  // The whole reason it isn't in OUTREACH_FIELDS, which the import rewrites
  // wholesale. Putting the hook address back would silently re-aim the
  // auto-underwrite at a house the agent stopped talking about.
  assert.equal(seed("7130 Bentley Rd E", "1911 9th Ave W"), null);
  assert.equal(seed("  7130 Bentley Rd E  ", "1911 9th Ave W"), null);
});

test("whitespace is not a value", () => {
  assert.equal(seed("   ", "1911 9th Ave W"), "1911 9th Ave W");
});

test("no hook address means nothing is written", () => {
  assert.equal(seed("", ""), null);
  assert.equal(seed(null, "   "), null);
});

test("a field id that matches nothing on the contact reads as empty, not as a crash", () => {
  assert.equal(
    seedSubjectProperty({ contact: { customFields: [{ id: "other", value: "x" }] }, fieldId: FID, hookAddress: "1 Elm" }),
    "1 Elm"
  );
  assert.equal(seedSubjectProperty({ contact: {}, fieldId: FID, hookAddress: "1 Elm" }), "1 Elm");
});

/* ---------- which address a run uses ---------- */
// Priority: the workflow body, then the field, then the conversation. Mirrors
// the chain in runUnderwrite; pinned here because the ORDER is the contract.

const pick = ({ supplied, field }) =>
  supplied ? { address: supplied, source: "workflow", confidence: "high" }
  : field ? { address: field, source: "subject_property", confidence: "high" }
  : { address: null, source: "conversation", confidence: "unknown" };

test("a workflow address outranks the field", () => {
  const r = pick({ supplied: "1 Elm St", field: "2 Oak Ave" });
  assert.equal(r.address, "1 Elm St");
  assert.equal(r.source, "workflow");
});

test("the field is used when the workflow sends none, and counts as high confidence", () => {
  // It is a stored answer a human or the AI already committed to, not a guess
  // made this second — so it does not face the confidence gate.
  const r = pick({ supplied: "", field: "2 Oak Ave" });
  assert.equal(r.address, "2 Oak Ave");
  assert.equal(r.source, "subject_property");
  assert.equal(r.confidence, "high");
});

test("with neither, it falls through to reading the conversation", () => {
  assert.equal(pick({ supplied: "", field: "" }).source, "conversation");
});

/* ---------- writing back ---------- */

const shouldWriteBack = (source, address, fieldAddress) =>
  source !== "subject_property" && (address || "").toLowerCase() !== (fieldAddress || "").toLowerCase();

test("a run writes back only when it learned something the field didn't say", () => {
  assert.equal(shouldWriteBack("conversation", "7130 Bentley Rd E", ""), true);
  assert.equal(shouldWriteBack("workflow", "7130 Bentley Rd E", "1911 9th Ave W"), true);
});

test("a run that read the field does not write the field back to itself", () => {
  assert.equal(shouldWriteBack("subject_property", "2 Oak Ave", "2 Oak Ave"), false);
});

test("an unchanged address doesn't churn the contact's audit trail", () => {
  assert.equal(shouldWriteBack("workflow", "2 Oak Ave", "2 Oak Ave"), false);
});
