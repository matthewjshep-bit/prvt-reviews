import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OfferPanelBody } from "../OfferPanel.jsx";

// 13041 SE 208th St, Kent (2026-09-25): five rows on one house. The pane says
// which is current, what the older ones are, and offers the re-quote when the
// paper was held.
const A = "13041 SE 208th St, Kent, WA 98031";
const aug = { id: "aug", contactId: "c1", address: A, cashAmount: 421556, status: "passed", createdAt: "2026-08-05T16:31:00Z", sends: [{ ts: "2026-08-05T16:31:42Z" }],
  paperHeld: { at: "2026-09-25T02:07:34Z", reason: "we texted 400K on 2026-08-07 after this offer's $421,556", amount: 400000 } };
const july = { id: "july", contactId: "c1", address: A, cashAmount: 416500, status: "countered", createdAt: "2026-07-27T22:35:00Z", sends: [{ ts: "2026-07-27T22:44:00Z" }] };

test("the pane marks the current offer, calls the older one superseded, and offers the re-quote", () => {
  const html = renderToStaticMarkup(<OfferPanelBody offer={aug} siblings={[aug, july]} item={{ offerId: "aug" }} onRequote={() => {}} />);
  expect(html).toContain("current");
  expect(html).toContain("superseded");
  expect(html).toContain("Paper held.");
  expect(html).toContain("Re-quote at 400K");
});

test("a row that pointed at the older offer says it is showing the current one", () => {
  const html = renderToStaticMarkup(<OfferPanelBody offer={aug} siblings={[aug, july]} item={{ offerId: "july" }} replaced={july} />);
  expect(html).toContain("pointed at an older offer");
  expect(html).toContain("$416,500");
});
