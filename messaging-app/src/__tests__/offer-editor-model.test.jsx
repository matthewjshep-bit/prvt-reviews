// The offer editor switches its analyzer by property type (2026-10-18): a
// house is priced by comps exactly as before; multi-family and commercial by
// income; land by the acre. The map library needs a browser, so it's stubbed.
import { test, expect, vi } from "vitest";
vi.mock("leaflet", () => ({ default: { divIcon: () => ({}), icon: () => ({}), Icon: { Default: { mergeOptions: () => {}, prototype: {} } }, latLngBounds: () => ({}) } }));
vi.mock("leaflet/dist/leaflet.css", () => ({}));
vi.mock("react-leaflet", () => { const C = () => null; return { MapContainer: C, TileLayer: C, Marker: C, Popup: C, CircleMarker: C, Circle: C, Tooltip: C, Polyline: C, useMap: () => ({}), useMapEvents: () => ({}) }; });
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sampleIncomeDeal } from "@shared/income-underwrite.js";

const editor = async () => {
  globalThis.window = globalThis.window || { location: { search: "" }, addEventListener() {}, removeEventListener() {} };
  return (await import("../NewOffer.jsx")).default;
};

test("a new offer opens on comps, as it always has", async () => {
  const NewOffer = await editor();
  const html = renderToStaticMarkup(<NewOffer settings={{}} />);
  expect(html).toContain("After-repair value");
  expect(html).toContain("Priced by comps");
  expect(html).not.toContain("Income offer");
});

test("a saved income draft reopens in the income analyzer with its number", async () => {
  const NewOffer = await editor();
  const draft = { id: "d1", status: "draft", draft: { inputs: { address: "1 Main St", askingPrice: "1,295,000" }, assetPick: { type: "multi_family", land: "" }, model: "income", underwrite: { model: "income", deal: sampleIncomeDeal("multi_family") } } };
  const html = renderToStaticMarkup(<NewOffer settings={{}} restore={draft} />);
  expect(html).toContain("Income offer");
  expect(html).toContain("$978,507");
  expect(html).not.toContain("After-repair value");
});

test("an older multi-family offer priced by comps stays on comps until it's switched", async () => {
  const NewOffer = await editor();
  const old = { id: "o1", status: "new", contactId: "c1", asset: { type: "multi_family", by: "you" },
    calc: { inputs: { address: "2 Oak St", arv: 600000, repairs: 50000 } },
    snapshot: { inputs: { address: "2 Oak St", arv: "600,000", repairs: "50,000" }, assetPick: { type: "multi_family", land: "" } } };
  const html = renderToStaticMarkup(<NewOffer settings={{}} restore={old} />);
  expect(html).toContain("After-repair value");
  expect(html).toContain("Underwrite by income");
  expect(html).not.toContain("Income offer");
});

test("a new offer on the Luxury page starts as a luxury lot, priced by the lot", async () => {
  const NewOffer = await editor();
  const html = renderToStaticMarkup(<NewOffer settings={{}} startLane="luxury" />);
  expect(html).toContain("Priced by lot value");
  expect(html).toContain("Sold teardowns nearby");
  expect(html).not.toContain("After-repair value");
});

// 2026-11-24 audit: auto-underwrite holds a house in a pocket (or from a lot
// owner) and stamps asset.lane "luxury" on the draft row, but its snapshot
// carries no model or asset pick, so the draft reopened in the flip
// calculator: ARV, repairs and the "about 70% fixed up" letter for a lot.
test("a luxury lot the machine held opens in the lot analyzer", async () => {
  const NewOffer = await editor();
  const held = { id: "d9", status: "draft", contactId: "c1", address: "9 Lakeview Ln, Hillcrest, WA 98004",
    asset: { type: "sfr", land: "", lane: "luxury", by: "underwrite" },
    draft: { mode: "existing", inputs: { address: "9 Lakeview Ln, Hillcrest, WA 98004", arv: 0, repairs: 0, askingPrice: 0 },
      subjectInfo: { lotSqft: 34000, yearBuilt: 1962, sqft: 2300 }, subjectSqft: 2300 } };
  const html = renderToStaticMarkup(<NewOffer settings={{}} restore={held} />);
  expect(html).toContain("Priced by lot value");
  expect(html).not.toContain("After-repair value");
  // A draft the bug autosaved on comps, with no lane picked, still opens as a lot.
  const stale = { ...held, draft: { ...held.draft, model: "comps", assetPick: null } };
  expect(renderToStaticMarkup(<NewOffer settings={{}} restore={stale} />)).toContain("Priced by lot value");
  // Matt turned the lane off on it: it stays a house, priced by comps.
  const off = { ...held, draft: { ...held.draft, model: "comps", assetPick: { type: "sfr", land: "" } } };
  expect(renderToStaticMarkup(<NewOffer settings={{}} restore={off} />)).toContain("After-repair value");
});
