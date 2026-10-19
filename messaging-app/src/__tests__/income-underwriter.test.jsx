import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import IncomeUnderwriter from "../IncomeUnderwriter.jsx";
import LandUnderwriter from "../LandUnderwriter.jsx";
import { sampleIncomeDeal, underwriteIncome, blankIncomeDeal } from "@shared/income-underwrite.js";
import { sampleLandDeal, underwriteLand } from "@shared/land-underwrite.js";

const noop = () => {};
const fmt = (v) => v;
const render = (el) => renderToStaticMarkup(el);

test("the sample 8-plex shows the max offer, the test that set it, and every test on one scale", () => {
  const deal = sampleIncomeDeal("multi_family");
  const run = underwriteIncome(deal);
  const html = render(<IncomeUnderwriter kind="multi_family" deal={deal} setDeal={noop} run={run} asking={1295000} priceOverride="" setPriceOverride={noop} fmtTyped={fmt} />);
  expect(html).toContain("Max offer");
  expect(html).toContain(`$${run.result.maxOffer.toLocaleString("en-US")}`);
  expect(html).toContain("Overpriced for your targets");
  expect(html).toContain("Cash-on-cash sets the offer.");
  expect(html).toContain("What each test lets you pay");
  expect(html).toContain("Loan sizing");
  expect(html).toContain("Sets offer");
  expect(html).toContain("example figures");
});

test("an empty rent roll asks for units and offers the sample instead of showing broken numbers", () => {
  const deal = blankIncomeDeal("multi_family");
  const html = render(<IncomeUnderwriter kind="multi_family" deal={deal} setDeal={noop} run={underwriteIncome(deal)} asking={0} priceOverride="" setPriceOverride={noop} fmtTyped={fmt} />);
  expect(html).toContain("Load sample deal");
  expect(html).toContain("Add at least one unit to the rent roll.");
  expect(html).not.toContain("NaN");
});

test("a commercial deal shows the tenant roll with leases and NNN", () => {
  const deal = sampleIncomeDeal("commercial");
  const html = render(<IncomeUnderwriter kind="commercial" deal={deal} setDeal={noop} run={underwriteIncome(deal)} asking={1450000} priceOverride="" setPriceOverride={noop} fmtTyped={fmt} />);
  expect(html).toContain("tenants &amp; leases");
  expect(html).toContain("NNN paid /yr");
  expect(html).toContain("per sf");
  expect(html).not.toContain("NaN");
});

test("land shows the value from sold comps and the offer after site work", () => {
  const deal = sampleLandDeal();
  const run = underwriteLand(deal);
  const html = render(<LandUnderwriter deal={deal} setDeal={noop} run={run} asking={325000} priceOverride="" setPriceOverride={noop} fmtTyped={fmt} />);
  expect(html).toContain("Sold land nearby");
  expect(html).toContain("Land offer");
  expect(html).toContain(`$${run.result.maxOffer.toLocaleString("en-US")}`);
  expect(html).not.toContain("NaN");
});
