import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import RowFeedback from "../RowFeedback.jsx";

test("a row with feedback says noted and which category; one without offers Teach it", () => {
  const noted = renderToStaticMarkup(<RowFeedback rowId="r1" rowKind="audit_owed" item={{ contactId: "c1" }} feedback={{ category: "should_have_replied", label: "Should have replied itself", note: "it knew the answer", at: "2026-09-22T18:00:00Z" }} />);
  expect(noted).toContain("noted · Should have replied itself");
  expect(noted).toContain("it knew the answer");
  expect(noted).toContain(">edit<");
  const fresh = renderToStaticMarkup(<RowFeedback rowId="r2" rowKind="promise_owed" item={{ contactId: "c1" }} />);
  expect(fresh).toContain("Teach it");
  expect(fresh).not.toContain("noted");
});
