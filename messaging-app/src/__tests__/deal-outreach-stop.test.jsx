import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DealModal, InvestorSummary } from "../DealsView.jsx";

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
