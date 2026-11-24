// offers-table.test.jsx — the Offers table as Matt reads it (2026-11-23
// audit): an agent with one house is one row, a folded agent still shows a
// failed send, the occasional actions sit behind ⋯, and the Needs Matt
// reason is on the row.
import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import OffersHistory from "../OffersHistory.jsx";

const hot = { at: "2026-11-22T18:00:00Z", by: "operator" };
const sent = (ok = true) => [{ ts: "2026-11-20T18:00:00Z", channels: ["sms"], docs: ["pdf"], results: { sms: ok ? { ok: true } : { ok: false, error: "carrier" } } }];
const rows = [
  { id: "solo", contactId: "agent-one", contactName: "Agent One", address: "12 Elm St, Kent, WA", cashAmount: 300000, status: "sent", statusAt: "2026-11-20T18:00:00Z",
    sends: sent(), hot, createdAt: "2026-11-19T18:00:00Z", pdfUrl: "https://example.test/one.pdf" },
  { id: "pair-a", contactId: "agent-two", contactName: "Agent Two", address: "4 Oak Ave, Kent, WA", cashAmount: 410000, status: "sent", statusAt: "2026-11-20T18:00:00Z",
    sends: sent(false), hot, createdAt: "2026-11-18T18:00:00Z" },
  { id: "pair-b", contactId: "agent-two", contactName: "Agent Two", address: "9 Pine Rd, Kent, WA", cashAmount: 350000, status: "sent", statusAt: "2026-11-20T18:00:00Z",
    sends: sent(), hot, createdAt: "2026-11-17T18:00:00Z" },
];
const render = (props = {}) => renderToStaticMarkup(<OffersHistory initialOffers={rows} onDeal={() => {}} {...props} />);

test("an agent with one offer is one row with their name on it, not a fold to open", () => {
  const html = render();
  // A header for the agent with two houses, none for the one with one.
  expect(html).toContain('aria-label="Agent Two, 2 offers"');
  expect(html).not.toContain('aria-label="Agent One, 1 offer"');
  expect(html).toContain("Agent One");
  expect(html).toMatch(/data-offer-row="solo"/);
});

test("a folded agent still says a send failed", () => {
  expect(render()).toContain("⚠ a send failed");
});

test("the documents and Delete sit behind ⋯, not in a column of their own", () => {
  const html = render();
  expect(html).not.toContain(">Document<");
  expect(html).not.toContain("one.pdf");
  expect(html).not.toContain('aria-label="Delete the offer');
  expect(html).toContain('aria-label="More for the offer on 12 Elm St, Kent, WA"');
  expect(html).not.toContain("min-w-[80rem]");
});

test("a row on GHL's Needs Matt stage carries the reason", () => {
  const html = render({ needs: [{ contactId: "agent-one", kind: "yes", offerId: "solo", why: "They agreed on 12 Elm St" }] });
  expect(html).toContain("Needs you: approve");
  expect(html).toContain("They agreed on 12 Elm St");
});
