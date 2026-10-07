import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TierOneTable, TierTwoTable, FlagChips, passEffects, kickEffects } from "../Tier1View.jsx";

const NOW = Date.parse("2026-10-07T18:00:00Z");
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const html = (el) => renderToStaticMarkup(el);

const clean = {
  contactId: "c1", name: "Sam Lee", opportunityId: "op1", inStageSince: ago(4), openCards: 1, ok: true, flags: [],
  house: { address: "13814 214th St E, Graham, WA 98338", source: "offer" },
  offer: { id: "o1", status: "sent", cashAmount: 300000, arv: 520000, repairs: 90000, askingPrice: 450000, hot: false },
  lastInboundAt: ago(1), lastWord: { at: ago(1), text: "needs a full kitchen and a roof" },
};
const gone = {
  ...clean, contactId: "c2", name: "Pat Doe", ok: false, house: { address: "88 Elm St, Tacoma, WA 98405", source: "offer" },
  flags: [{ key: "gone", label: "Sold or off the market", why: "Zillow says pending", sure: true }],
};
const named = { ...clean, contactId: "c3", name: "Ana Bee", offer: null, house: { address: "4430 Sunnyside Blvd, Marysville, WA 98270", source: "named" } };

test("each card shows the agent, the house, our numbers and how long it has sat in Tier 1", () => {
  const out = html(<TierOneTable rows={[clean]} now={NOW} />);
  expect(out).toContain("Sam Lee");
  expect(out).toContain("13814 214th St E");
  expect(out).toContain("300K");
  expect(out).toContain("ARV 520K");
  expect(out).toContain("repairs 90K");
  expect(out).toContain("4d in Tier 1");
  expect(out).toContain("Looks live");
  expect(out).toContain("needs a full kitchen");
  expect(out).toContain("Offer →");
  expect(out).toContain("Pass");
});

test("a flagged card says why, and Kick out stands out", () => {
  const out = html(<TierOneTable rows={[gone]} now={NOW} />);
  expect(out).toContain("Sold or off the market");
  expect(out).toContain("Zillow says pending");   // the why, on hover
  expect(out).toMatch(/border-red-300[^"]*"[^>]*>Kick out/);
  expect(html(<FlagChips flags={[{ key: "stale", label: "Quiet 3+ weeks", sure: false }]} />)).toContain("bg-slate-100");
});

test("a named house we haven't priced offers Underwrite, not Offer", () => {
  const out = html(<TierOneTable rows={[named]} now={NOW} />);
  expect(out).toContain("Named, not priced yet");
  expect(out).toContain("Underwrite");
  expect(out).not.toContain("Offer →");
});

test("belongs rows have Add to GHL Tier 1 and no Pass", () => {
  const out = html(<TierOneTable rows={[clean]} kind="belongs" now={NOW} />);
  expect(out).toContain("Add to GHL Tier 1");
  expect(out).not.toContain(">Pass<");
});

test("Pass says what it does before it does it: we passed, the card, the tag, and the check-in", () => {
  const lines = passEffects(clean).join(" ");
  expect(lines).toMatch(/We passed/);
  expect(lines).toMatch(/Passed on Offer/);
  expect(lines).toMatch(/no tier-2/);
  expect(lines).toMatch(/never brings this one up/);
  expect(kickEffects(gone).join(" ")).toMatch(/No longer available.*Not a Good Deal/s);
});

test("Tier 2 lists who wrote back with nothing in hand and what keeps them warm, and says so when nothing does", () => {
  const rows = [{ contactId: "t", name: "Tara W", tier: "t2", why: "nothing in hand (passed on 5 Oak St)", lastInboundAt: ago(30), segment: "partner", care: { kind: "waiting", text: "check-in later — talked within 21 days" } }];
  const out = html(<TierTwoTable rows={rows} pulseOn />);
  expect(out).toContain("Tara W");
  expect(out).toContain("done business");
  expect(out).toContain("check-in later");
  expect(out).not.toContain("check-in is off");
  expect(html(<TierTwoTable rows={rows} pulseOn={false} />)).toContain("The agent check-in is off");
});
