// machine-trouble.test.jsx — a rejected key or a stopped revenue job shows
// on Offers and Deals (2026-11-23 audit, AH-1 and AH-6). The Apify key was
// rejected for a week and the only warnings were on pages Matt doesn't open.
import { test, expect, vi, afterEach } from "vitest";
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { TroubleLines, troubleLines } from "../MachineTrouble.jsx";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

test("a rejected key is a red line on the page; all well, the line takes no room", () => {
  const lines = troubleLines({ ok: true, trouble: [{ id: "key:apify", text: "Zillow comps key (Apify) rejected since Tue (HTTP 401): auto-underwrite … are stopped." }] });
  const html = renderToStaticMarkup(<TroubleLines lines={lines} />);
  expect(html).toContain('role="alert"');
  expect(html).toContain("rejected since Tue");
  expect(renderToStaticMarkup(<TroubleLines lines={troubleLines({ ok: true, trouble: [] })} />)).toBe("");
  expect(troubleLines(null)).toEqual([]);
});

test("the line reads the one light endpoint, and both pages show it", async () => {
  const urls = [];
  globalThis.fetch = vi.fn(async (url) => { urls.push(String(url)); return { ok: true, json: async () => ({ ok: true, trouble: [] }) }; });
  const { getMachineTrouble } = await import("../api.js");
  await getMachineTrouble();
  expect(urls).toHaveLength(1);
  expect(urls[0]).toMatch(/\/api\/dashboard\/machine\?/);
  for (const file of ["OffersHistory.jsx", "DealsView.jsx"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    expect(src, file).toContain("<MachineTrouble />");
  }
});
