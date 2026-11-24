// counter-answers.test.jsx — Hold, Meet and Walk under their counter
// (2026-11-23 audit, counter-quick-answers). The Desk had them; since it was
// retired a counter showed their number with no way to answer it. Each one
// reuses what exists (the hold words, the re-quote, the we-passed reasons)
// and none of them sends anything or changes our number by itself.
import { test, expect, vi, afterEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OfferPanelBody, meetSeed, meetValue, parseAmount } from "../OfferPanel.jsx";
import { composeInReplyBox, takeCompose, COMPOSE_EVENT } from "../work-queue.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const offer = (over = {}) => ({ id: "o1", contactId: "c1", address: "12 Elm St, Kent, WA", status: "countered", cashAmount: 300000,
  counter: { amount: 340000, at: "2026-11-22T18:00:00Z" }, sends: [{ ts: "2026-11-20T18:00:00Z" }], createdAt: "2026-11-19T18:00:00Z", ...over });

test("a counter has Hold, Meet and Walk under their number", () => {
  const html = renderToStaticMarkup(<OfferPanelBody offer={offer()} item={{ offerId: "o1" }} onRequote={() => ({})} />);
  expect(html).toContain("Hold ours");
  expect(html).toContain("Meet…");
  expect(html).toContain("Walk");
  expect(html).toContain("Nothing sends");
});

test("no answers on a deal, or with no counter on the house", () => {
  expect(renderToStaticMarkup(<OfferPanelBody offer={offer({ counter: null })} item={{ offerId: "o1" }} onRequote={() => ({})} />)).not.toContain("Hold ours");
  expect(renderToStaticMarkup(<OfferPanelBody offer={offer({ deal: { stage: "under_contract" } })} item={{ offerId: "o1" }} onRequote={() => ({})} />)).not.toContain("Hold ours");
});

test("Meet only pre-fills, never above their counter or the walk-away on the house, never below ours", () => {
  // Halfway, rounded down to the thousand.
  expect(meetSeed(offer())).toEqual({ amount: 320000, cap: 340000 });
  // The engine's walk-away is the most we'd pay: Meet stops there.
  expect(meetSeed(offer({ pricing: { walkAway: 310000 } }))).toEqual({ amount: 310000, cap: 310000 });
  // A counter at or under our number has nothing to meet.
  expect(meetSeed(offer({ counter: { amount: 290000 } }))).toBe(null);
  // A walk-away at or under ours leaves nothing to meet either.
  expect(meetSeed(offer({ pricing: { walkAway: 300000 } }))).toBe(null);
});

test("rendering the answers reads nothing and sends nothing", () => {
  globalThis.fetch = vi.fn();
  renderToStaticMarkup(<OfferPanelBody offer={offer()} item={{ offerId: "o1" }} onRequote={() => ({})} />);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

// Review 2026-11-23: with their counter under a thousand above ours, the box
// was filled with "300k", our own number, so Meet did nothing.
test("Meet's box never shows our own number when their counter is only a few hundred above", () => {
  const close = meetSeed(offer({ counter: { amount: 300500 } }));
  expect(close).toEqual({ amount: 300500, cap: 300500 });
  expect(parseAmount(meetValue(close.amount))).toBe(300500);
  expect(parseAmount(meetValue(320000))).toBe(320000);
  expect(meetValue(320000)).toBe("320k");
  // Every seed reads back as itself, above ours and never above the cap.
  for (const amount of [300100, 300999, 301000, 301500, 339999]) {
    const s = meetSeed(offer({ counter: { amount } }));
    expect(parseAmount(meetValue(s.amount))).toBe(s.amount);
    expect(s.amount).toBeGreaterThan(300000);
    expect(s.amount).toBeLessThanOrEqual(amount);
  }
});

// Review 2026-11-23: Hold said "In the reply box" even when no reply box was
// on screen to take the words.
test("Hold knows whether a reply box took the words", () => {
  const nobody = new EventTarget();
  expect(composeInReplyBox("We're holding at our number.", nobody)).toBe(false);
  const box = new EventTarget();
  let got = null;
  box.addEventListener(COMPOSE_EVENT, (e) => { got = takeCompose(e); });
  expect(composeInReplyBox("We're holding at our number.", box)).toBe(true);
  expect(got).toBe("We're holding at our number.");
  expect(composeInReplyBox("", box)).toBe(false);
});
