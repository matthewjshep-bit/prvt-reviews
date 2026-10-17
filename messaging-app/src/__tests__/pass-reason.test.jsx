import { test, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusPill, statusItems } from "../ui.jsx";
import { setOfferStatus } from "../api.js";

// Matt, 2026-10-17: when we pass, say why in a few buckets, so the bot can tell the agent.
test("the status menu offers 'We passed' once per reason, and ticks the one the offer has", () => {
  const picked = [];
  const items = statusItems({ id: "o1", status: "we_passed", passReason: { code: "rural" } }, (k) => picked.push(k));
  const passes = items.filter((i) => String(i.key).startsWith("we_passed"));
  expect(passes.map((i) => i.label)).toEqual([
    "We passed: too turnkey (not enough value to add)",
    "We passed: neighborhood (too hard to comp)",
    "We passed: rural (out in the boonies)",
    "We passed: not enough comps",
    "We passed: property type (a log cabin, say)",
  ]);
  expect(passes.filter((i) => i.selected).map((i) => i.key)).toEqual(["we_passed:rural"]);
  expect(items.some((i) => i.key === "we_passed"), "no reasonless pass in the menu").toBe(false);
  expect(items.find((i) => i.key === "passed").label).toBe("They passed");
  passes[0].onSelect();
  expect(picked).toEqual(["we_passed:turnkey"]);
});

test("the pill says why we passed", () => {
  expect(renderToStaticMarkup(<StatusPill offer={{ status: "we_passed", passReason: { code: "comps" } }} small />)).toContain("We passed · Few comps");
  expect(renderToStaticMarkup(<StatusPill offer={{ status: "we_passed" }} small />)).toContain(">We passed<");
});

test("a reason picked in the menu goes to the server as we_passed with its reason", async () => {
  const sent = [];
  const fetchMock = vi.fn(async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ ok: true }) }; });
  const real = globalThis.fetch;
  globalThis.fetch = fetchMock;
  try {
    await setOfferStatus("o1", "we_passed:property_type");
    await setOfferStatus("o2", "passed");
  } finally { globalThis.fetch = real; }
  expect(sent[0].url).toContain("/api/offers/o1/status");
  expect(sent[0].body).toMatchObject({ status: "we_passed", reason: "property_type" });
  expect(sent[1].body.status).toBe("passed");
  expect("reason" in sent[1].body).toBe(false);
});
