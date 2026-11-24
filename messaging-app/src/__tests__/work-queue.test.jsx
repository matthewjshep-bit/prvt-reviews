import { test, expect } from "vitest";
import { rowTargets, teachRowId, keyIntent, allInPct, allInTone } from "../work-queue.js";

const row = (id, kind, group, over = {}) => ({ id, kind, group, severity: "soon", title: id, ops: [], ...over });

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

// 13041 SE 208th St (2026-09-25): a draft whose paper was held opens on the
// offer it would have sent, so the re-quote is one tap away.
test("a held-paper draft opens on the offer it would have sent", () => {
  const drafts = [{ id: "h1", contactId: "c1", status: "draft", paperHold: { offerId: "aug", amount: 400000 } }];
  expect(rowTargets({ id: "r", kind: "draft_waiting", group: "yours", contactId: "c1", draftId: "h1" }, drafts).offerId).toBe("aug");
});

test("D reads as dismiss, never while typing", () => {
  expect(keyIntent({ key: "d", target: { tagName: "DIV" } })).toBe("dismiss");
  expect(keyIntent({ key: "d", target: { tagName: "TEXTAREA" } })).toBe(null);
});

/* ---------- a row with no offer on it still shows theirs (2026-09-29) ---------- */
// Jeffrey Valcik's held reply ("go through my business partner") named no
// house, so the row carried no offerId and the pane said "No offer yet" beside
// a thread about 2002 1st Ave N.

import { defaultOfferFor } from "../work-queue.js";
import { OfferPanelBody } from "../OfferPanel.jsx";
import { renderToStaticMarkup as markup } from "react-dom/server";
import React from "react";

const offerRow = (id, address, status, statusAt, over = {}) => ({ id, contactId: "c1", address, status, statusAt, createdAt: statusAt, cashAmount: 300000, ...over });

test("a row with no offer shows the one on the house it names, else their liveliest", () => {
  const book = [
    offerRow("old", "2002 1st Ave N, Seattle, WA", "we_passed", "2026-09-28T17:00:00Z"),
    offerRow("live", "9 Oak St, Kent, WA", "sent", "2026-09-20T17:00:00Z"),
    offerRow("draft", "1 Elm St, Kent, WA", "draft", "2026-09-29T17:00:00Z"),
  ];
  expect(defaultOfferFor(book, "2002 1st Ave N").id).toBe("old");
  expect(defaultOfferFor(book, "").id).toBe("live");
  expect(defaultOfferFor([book[0]], "").id).toBe("old");
  expect(defaultOfferFor([], "")).toBe(null);
});

// Matt, 2026-10-19: "ALSO show Offer DRAFTS in the companion". The draft-only
// underwriter leaves a draft for him to price; the pane said "No offer yet".
test("someone whose only offer is a draft opens on the draft, not 'No offer yet'", () => {
  const draft = offerRow("draft", "1317 California Ave SW, Seattle, WA", "draft", "2026-10-19T16:00:00Z");
  const olderDraft = offerRow("draft0", "2 Pine St, Kent, WA", "draft", "2026-10-01T16:00:00Z");
  const sent = offerRow("sent", "9 Oak St, Kent, WA", "sent", "2026-09-20T17:00:00Z");
  expect(defaultOfferFor([olderDraft, draft], "").id).toBe("draft");
  expect(defaultOfferFor([sent, draft], "").id).toBe("sent", "a real offer still comes first");
  expect(defaultOfferFor([sent, draft], "1317 California Ave SW").id).toBe("draft", "the house the row names, even as a draft");
});

test("while their offers load, the pane doesn't say there are none", () => {
  const html = markup(<OfferPanelBody offer={null} item={{ contactId: "c1" }} loading />);
  expect(html).not.toContain("No offer yet");
});

