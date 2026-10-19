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
