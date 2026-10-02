import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import OfferRail from "../OfferRail.jsx";
import OfferPane from "../OfferPane.jsx";
import { offerPaneItem, railStep, splitKey } from "../offers-split.js";
import { rowTargets } from "../work-queue.js";

const offer = (over = {}) => ({
  id: "o1", contactId: "c1", contactName: "Dana Reyes", address: "12 Elm St, Renton, WA 98055", cashAmount: 385000,
  status: "sent", statusAt: "2026-09-12T18:00:00Z", createdAt: "2026-09-12T17:00:00Z", sends: [{ ts: "2026-09-12T18:00:00Z" }],
  nextFollowUp: { at: "2026-10-05T16:00:00Z", kind: "offer_nudge", label: "Nudge · day 7", who: "machine", reason: "" },
  ...over,
});

test("opening an offer shrinks the list to a rail with street, agent, our number, status and next follow-up", () => {
  const rows = [offer(), offer({ id: "o2", contactId: "c2", contactName: "Sam Lee", address: "9 Oak Ave, Kent, WA", cashAmount: 410000, status: "countered" })];
  const html = renderToStaticMarkup(<OfferRail rows={rows} selectedId="o2" label="Awaiting reply" />);
  expect(html).toContain("Awaiting reply · 2");
  for (const s of ["12 Elm St", "Dana Reyes", "$385,000", "9 Oak Ave", "Sam Lee", "$410,000"]) expect(html).toContain(s);
  expect(html).toContain(">12 Elm St</span>");              // the street shows; the whole address is the tooltip
  expect(html.match(/aria-current="true"/g)?.length).toBe(1);
  expect(html.indexOf("12 Elm St")).toBeLessThan(html.indexOf("9 Oak Ave"), "the table's order");
});

test("the rail walks the rows the table showed, in its order, and starts at the top when the open one left it", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  expect(railStep(rows, "b", 1)).toBe("c");
  expect(railStep(rows, "b", -1)).toBe("a");
  expect(railStep(rows, "c", 1)).toBe(null);
  expect(railStep(rows, "a", -1)).toBe(null);
  expect(railStep(rows, "gone", 1)).toBe("a");
  expect(railStep([], "a", 1)).toBe(null);
});

test("keys don't move the rail while a window or menu is open, and Esc there doesn't close the split", () => {
  const ev = (key, target = { tagName: "BODY" }) => ({ key, target });
  const none = { querySelector: () => null };
  const modal = { querySelector: () => ({}) };
  expect(splitKey(ev("j"), { doc: none })).toBe("next");
  expect(splitKey(ev("k"), { doc: none })).toBe("prev");
  expect(splitKey(ev("Escape"), { doc: none })).toBe("close");
  expect(splitKey(ev("r"), { doc: none })).toBe("reply");
  expect(splitKey(ev("d"), { doc: none })).toBe(null, "no dismiss on Offers");
  expect(splitKey(ev("j"), { doc: modal })).toBe(null);
  expect(splitKey(ev("Escape"), { doc: modal })).toBe(null);
  expect(splitKey(ev("j"), { doc: none, blocked: true })).toBe(null, "the Send window is open");
  expect(splitKey(ev("Escape", { tagName: "TEXTAREA" }), { doc: none })).toBe(null, "typing a reply");
  expect(splitKey(ev("j", { tagName: "TEXTAREA" }), { doc: none })).toBe(null);
});

test("an offer opened from the list gets the same reply box a Today row would: their newest open draft", () => {
  const drafts = [
    { id: "d1", contactId: "c1", status: "sent", createdAt: "2026-09-20T00:00:00Z" },
    { id: "d2", contactId: "c1", status: "draft", createdAt: "2026-09-21T00:00:00Z", party: "agent" },
    { id: "d3", contactId: "c9", status: "draft", createdAt: "2026-09-22T00:00:00Z" },
  ];
  const t = rowTargets(offerPaneItem(offer()), drafts);
  expect(t.contactId).toBe("c1");
  expect(t.offerId).toBe("o1");
  expect(t.draft?.id).toBe("d2");
  expect(t.party).toBe("agent");
});

test("the offer pane has the person, the house, Details, Send, the Bot menu and the way back to the table", () => {
  const o = offer();
  const bodies = {
    offer: { ...o, arv: 560000, repairs: 60000 }, siblings: [o], thread: { messages: [], more: false }, coach: { proposals: [], taught: [] },
    timeline: { moments: [{ at: "2026-09-12T18:00:00Z", kind: "sent", label: "offer sent", who: "us" }], total: 1, next: o.nextFollowUp, bot: { held: false, pace: "normal", conversationEnabled: true } },
    drafts: [], sendsEnabled: false,
  };
  const html = renderToStaticMarkup(<OfferPane offer={o} index={2} total={14} onPrev={() => {}} onNext={() => {}} onClose={() => {}} bodies={bodies} />);
  for (const s of ["Dana Reyes", "· 12 Elm St", "3 of 14", "Details", "> Send</button>", 'aria-label="Bot: Bot on"', 'aria-label="Back to the table"', "offer sent", "Edit offer", "Change status"]) {
    expect(html).toContain(s);
  }
  expect(html).toContain("The bot has nothing drafted");   // the reply box, as on Today
});
