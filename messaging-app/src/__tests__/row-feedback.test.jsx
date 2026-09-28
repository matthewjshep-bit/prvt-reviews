import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import RowFeedback, { PaneFeedback } from "../RowFeedback.jsx";
import { draftReason } from "../Composer.jsx";

test("a row with feedback says noted and which category; one without offers Teach it", () => {
  const noted = renderToStaticMarkup(<RowFeedback rowId="r1" rowKind="audit_owed" item={{ contactId: "c1" }} feedback={{ category: "should_have_replied", label: "Should have replied itself", note: "it knew the answer", at: "2026-09-22T18:00:00Z" }} />);
  expect(noted).toContain("noted · Should have replied itself");
  expect(noted).toContain("it knew the answer");
  expect(noted).toContain(">edit<");
  const fresh = renderToStaticMarkup(<RowFeedback rowId="r2" rowKind="promise_owed" item={{ contactId: "c1" }} />);
  expect(fresh).toContain("Teach it");
  expect(fresh).not.toContain("noted");
});

const fbOf = (over = {}) => ({ rowId: "draft:d1", saved: null, category: "", setCategory() {}, note: "", setNote() {}, busy: false, error: "", dirty: false, save() {}, commit() {}, ...over });

test("one Feedback list: the words are asked about only when there's a draft", () => {
  const withDraft = renderToStaticMarkup(<PaneFeedback fb={fbOf()} withWords defaultOpen />);
  expect(withDraft).toContain("Wrong number");
  expect(withDraft).toContain("Should have replied itself");
  expect(withDraft).toContain("Shouldn&#x27;t have replied");
  expect(withDraft).not.toContain(">Other<");
  const noDraft = renderToStaticMarkup(<PaneFeedback fb={fbOf()} defaultOpen />);
  expect(noDraft).not.toContain("Wrong number");
  expect(noDraft).toContain("Should have taken an action");
});

test("what was said before on this person's rows shows inside the open control", () => {
  const html = renderToStaticMarkup(<PaneFeedback fb={fbOf()} defaultOpen taught={[{ eventId: "e1", label: "Wrong read of the message", note: "they meant the other house", at: "2026-09-18T00:00:00Z" }]} />);
  expect(html).toContain("they meant the other house");
});

test("a chip about the words goes with the draft when you send or dismiss it; one about the row doesn't", () => {
  expect(draftReason(fbOf({ category: "wrong_number", note: " too high " }))).toEqual({ code: "wrong_number", note: "too high" });
  expect(draftReason(fbOf({ category: "should_not_reply" }))).toEqual({ code: "should_not_reply", note: "" });
  expect(draftReason(fbOf({ category: "should_have_acted" }))).toBe(null);
  expect(draftReason(fbOf())).toBe(null);
});
