// underwrite-checks.test.jsx — what a person sees of the buyer-view checks:
// the auto chips in the Comps pane, the allowance lines in the Rehab pane,
// and the summary on an offer.
import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import BuyerViewPanel from "../BuyerViewPanel.jsx";
import AllowanceChips from "../AllowanceChips.jsx";
import { ChecksLine } from "../ui.jsx";
import { buyerView, checksFor, summarizeChecks } from "@shared/underwrite-checks.js";
import { blankRehabState } from "@shared/rehab-scope.js";
import { rehabChecks } from "@shared/rehab-checks.js";

const checks = checksFor({ underwriteChecks: { enabled: true } });
const COMPS = [410000, 415000, 420000, 418000].map((price, i) => ({ id: `c${i}`, price, sqft: 1300, beds: 3, baths: 1, condition: "renovated", similarity: 80 }));
const SITE = { status: "ok", subject: { flags: { busy_road: { how: "fronts", label: "fronts S Yakima Ave (arterial)" } }, nearest: null }, comps: { c0: [], c1: [], c2: [], c3: [] } };
const ACTIVES = [389000, 385000, 300000, 305000].map((price, i) => ({ id: `a${i}`, address: `${i} A St`, price, sqft: 1300, beds: 3, baths: 1, distance: 0.3 + i / 10 }));
const yakima = (over = {}) => buyerView({
  checks, address: "5232 South Yakima Avenue, Tacoma, WA 98408", subject: { sqft: 1300, beds: 3, baths: 1, yearBuilt: 1952 },
  comps: COMPS, sqft: 1300, site: SITE, actives: ACTIVES, ...over,
});

test("the Comps pane shows the street cut as a removable auto chip and the listings cap with a remove", () => {
  const html = renderToStaticMarkup(<BuyerViewPanel view={yakima()} />);
  expect(html).toMatch(/Buyer view/);
  expect(html).toMatch(/Busy road — fronts S Yakima Ave \(arterial\) −5%/);
  expect(html).toMatch(/auto/);
  expect(html).toMatch(/aria-label="Remove Busy road/);
  expect(html).toMatch(/Held to today&#x27;s listings: \$/);
});

test("a removed line is offered back, and the checks being off shows nothing", () => {
  const view = yakima({ declined: { arv: ["busy_road"], cap: true } });
  const html = renderToStaticMarkup(<BuyerViewPanel view={view} declined={{ arv: ["busy_road"], cap: true }} />);
  expect(html).toMatch(/busy road \(put back\)/);
  expect(html).toMatch(/Listings cap removed/);
  expect(renderToStaticMarkup(<BuyerViewPanel view={null} />)).toBe("");
});

test("the street not checked says so plainly", () => {
  const html = renderToStaticMarkup(<BuyerViewPanel view={yakima({ site: { status: "unavailable", subject: { flags: {} }, comps: {} } })} />);
  expect(html).toMatch(/Street not checked/);
});

test("the Rehab pane shows each buyer allowance with its cost, and the floor on a distressed listing", () => {
  const state = blankRehabState(); state.rows["paint-int"].on = true;
  const result = rehabChecks({ state, sqft: 960, yearBuilt: 1941, arv: 700000, remarks: { distressed: true, turnkey: false, updated: {}, defects: [], layout: [], legal: [], contents: false }, t: checks.rehab });
  const html = renderToStaticMarkup(<AllowanceChips result={result} />);
  expect(html).toMatch(/What a buyer will price/);
  expect(html).toMatch(/rewire \(built 1941\) · \$6,600/);
  expect(html).toMatch(/aria-label="Remove Buyer allowance — rewire/);
  expect(html).toMatch(/Distressed listing/);
});

test("a quick estimate under what a buyer will price is called out", () => {
  const result = rehabChecks({ state: blankRehabState(), sqft: 960, yearBuilt: 1941, arv: 700000, t: checks.rehab });
  const html = renderToStaticMarkup(<AllowanceChips result={result} bucketAmount={5000} />);
  expect(html).toMatch(/quick estimate \(\$5,000\) is under what a buyer will price/);
});

test("an offer's summary reads as one line, with the full lines on the detail", () => {
  const view = yakima({ rehabState: blankRehabState() });
  const s = summarizeChecks({ checks: view.summary });
  const pill = renderToStaticMarkup(<ChecksLine checks={s} />);
  expect(pill).toMatch(/buyer view: ARV −5% · held to listings · \+\$[\d,]+ scope/);
  const full = renderToStaticMarkup(<ChecksLine checks={s} full />);
  expect(full).toMatch(/ARV: Busy road — fronts S Yakima Ave/);
  expect(renderToStaticMarkup(<ChecksLine checks={null} />)).toBe("");
});
