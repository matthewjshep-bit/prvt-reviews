// owners-answered.test.jsx — the Luxury page lists the homeowners who answered
// a lot text and have no offer from Matt yet (2026-11-24); a name opens their
// record. Names and streets are made up.
import { test, expect, vi, afterEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OwnersAnsweredStrip } from "../OwnersAnswered.jsx";
import { ContactDrawerContext } from "../ContactLink.jsx";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

test("owners who answered show as a strip with a count, each opening their record", () => {
  const owners = [
    { contactId: "c-a", name: "Pat Example", street: "9 Lakeview Ln", at: new Date(Date.now() - 2 * 3600000).toISOString(), replies: 2 },
    { contactId: "c-b", name: "", street: "4 Ridge Rd", at: new Date().toISOString(), replies: 1 },
  ];
  const html = renderToStaticMarkup(
    <ContactDrawerContext.Provider value={{ open: () => {} }}><OwnersAnsweredStrip owners={owners} /></ContactDrawerContext.Provider>);
  expect(html).toContain("Owners who answered · 2");
  expect(html).toContain("Pat Example");
  expect(html).toContain("9 Lakeview Ln");
  expect(html).toContain("2h ago · 2 texts");
  expect(html).toContain("4 Ridge Rd");
  expect(html).toContain('title="Open their record"');
});

test("no one waiting shows nothing", () => {
  expect(renderToStaticMarkup(<OwnersAnsweredStrip owners={[]} />)).toBe("");
});

test("the strip asks for the cheap answered list, nothing heavier", async () => {
  const urls = [];
  globalThis.fetch = vi.fn(async (url) => { urls.push(String(url)); return { ok: true, json: async () => ({ owners: [] }) }; });
  const { getAnsweredLotOwners } = await import("../api.js");
  await getAnsweredLotOwners();
  expect(urls).toHaveLength(1);
  expect(urls[0]).toMatch(/\/api\/lot-finder\/answered\?/);
});
