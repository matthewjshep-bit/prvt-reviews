import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DealModal, InvestorSummary, resumedLine } from "../DealsView.jsx";

// 5232 S Yakima (2026-10-01): Matt wanted outreach on one deal stopped, from
// the deal pane, and to see at a glance that it was.
const offer = (deal) => ({ id: "o1", address: "5232 South Yakima Avenue, Tacoma, WA 98408", contactId: "a1", contactName: "James Smith",
  deal: { stage: "under_contract", createdAt: "2026-10-02T00:50:55.610Z", investors: [], stageHistory: [], ...deal } });
const render = (o) => renderToStaticMarkup(<DealModal offer={o} settings={{}} onClose={() => {}} onUpdated={() => {}} onRemoved={() => {}} />);

test("a live deal offers Stop outreach and says nothing is stopped", () => {
  const html = render(offer({}));
  expect(html).toContain("Stop outreach");
  expect(html).not.toContain("Outreach stopped");
});

test("a stopped deal says so on the pane, offers Resume, and the list row says it too", () => {
  const o = offer({ outreachStopped: { at: "2026-10-02T02:00:00.000Z", by: "you" } });
  const html = render(o);
  expect(html).toContain("Resume outreach");
  expect(html).toMatch(/Outreach stopped Oct \d+\./);
  expect(html).toContain("A buyer&#x27;s reply about it waits for you.");
  expect(renderToStaticMarkup(<InvestorSummary deal={o.deal} />)).toContain("outreach stopped");
});

test("a closed deal has nothing to stop", () => {
  expect(render(offer({ stage: "closed" }))).not.toContain("Stop outreach");
});

// 9311 12th Pl SE (2026-10-04): Matt stopped outreach right after making the
// deal, pressed Resume, and nothing went out. Resume now sends what Stop
// pulled back, and the pane says what it put back.
test("a stopped deal says Resume sends what it pulled back", () => {
  expect(render(offer({ outreachStopped: { at: "2026-10-02T02:00:00.000Z", by: "you" } }))).toContain("Resume sends the deal texts it pulled back.");
});

test("after Resume the pane says how many deal texts went back in the queue and who was left out", () => {
  expect(resumedLine(undefined)).toBe("");
  expect(resumedLine({ firstWave: false, queued: 14, drafted: 10, dropped: 1 }))
    .toBe("Outreach is back on: 14 deal texts queued, starting about 10 minutes from now (sending hours only); 10 are waiting for you in the outbox; 1 buyer left out: passed, unsubscribed or no longer a fit. The next wave counts from now.");
  expect(resumedLine({ firstWave: true, queued: 0, drafted: 3, dropped: 0, reason: "sends are off on the broker (CARD_SENDS_ENABLED)" }))
    .toBe("First wave picked: 3 are waiting for you in the outbox (sends are off on the broker (CARD_SENDS_ENABLED)). The next wave counts from now.");
  expect(resumedLine({ firstWave: false, queued: 0, drafted: 0, dropped: 0 })).toMatch(/Nothing was waiting to go back out/);
  expect(resumedLine({ firstWave: false, queued: 0, drafted: 0, dropped: 0, reason: "a buyer committed to 9311 12th Pl SE" }))
    .toBe("Outreach is back on, but nothing went back out: a buyer committed to 9311 12th Pl SE.");
});
