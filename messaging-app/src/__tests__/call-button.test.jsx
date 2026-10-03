import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CallPanel, telHref } from "../CallButton.jsx";

test("calling from Today offers this device and GHL, and a box to log the call", () => {
  const html = renderToStaticMarkup(<CallPanel contactId="c1" name="Donna" phone="+12065550123" />);
  expect(html).toContain('href="tel:+12065550123"');
  expect(html).toContain("Call from this device");
  expect(html).toContain("Call in GHL");
  expect(html).toContain("Log the call");
});

test("no phone on their record says so and still offers GHL", () => {
  const html = renderToStaticMarkup(<CallPanel contactId="c1" name="Donna" phone="" />);
  expect(html).toContain("No phone on their record");
  expect(html).not.toContain("tel:");
  expect(html).toContain("Call in GHL");
});

test("a phone number becomes a dialable link however it was typed", () => {
  expect(telHref("(206) 555-0123")).toBe("tel:+12065550123");
  expect(telHref("+1 206 555 0123")).toBe("tel:+12065550123");
  expect(telHref("")).toBe(null);
});

/* ---------- the Desk's calls (2026-10-02) ---------- */

test("a call that didn't connect has chips: No answer, Left voicemail, Call back", () => {
  const html = renderToStaticMarkup(<CallPanel contactId="c1" name="Donna" phone="+12065550123" />);
  expect(html).toContain("No answer");
  expect(html).toContain("Left voicemail");
  expect(html).toContain("Call back");
});

test("No answer writes a call attempt, not a call", async () => {
  const { vi } = await import("vitest");
  const seen = [];
  vi.stubGlobal("fetch", async (url, init) => { seen.push({ url: String(url), body: JSON.parse(init?.body || "{}") }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; });
  try {
    const { logCallAttempt } = await import("../api.js");
    await logCallAttempt("c1", { outcome: "no_answer", party: "agent", offerId: "o1" });
    expect(seen[0].url).toContain("/api/contacts/c1/events");
    expect(seen[0].body.type).toBe("call_attempt");
    expect(seen[0].body.outcome).toBe("no_answer");
    expect(seen[0].body.text).toBeUndefined();
  } finally { vi.unstubAllGlobals(); }
});

test("a Call row's card: the goal, ours against theirs, what to say, and Call in GHL", async () => {
  const { default: CallCard } = await import("../CallCard.jsx");
  const item = { id: "call_counter:o2", kind: "call_counter", contactId: "c2", contactName: "Kel B", offerId: "o2", address: "23908 SE 168th St, Issaquah, WA",
    counter: { ours: 690000, theirs: 715000, gap: 25000, ceiling: 700000, overCeiling: 15000 },
    call: { reason: "call_counter", goal: "Land a number.", opener: "Hi Kel, it's Matt — got your 715K on 23908 SE 168th St.", tries: 1, lastTryAt: "2026-10-02T18:00:00Z",
      houses: [{ offerId: "o2", address: "23908 SE 168th St, Issaquah, WA", ours: 690000, theirs: 715000 }] } };
  const html = renderToStaticMarkup(<CallCard item={item} targets={{ contactId: "c2", party: "agent" }} phone="+14255550101" />);
  expect(html).toContain("Land a number.");
  expect(html).toContain("ours <b class=\"tabular-nums\">690K</b>");
  expect(html).toContain("theirs <b class=\"tabular-nums\">715K</b>");
  expect(html).toContain("Buyer ceiling 700K: their number is 15K over it");
  expect(html).toContain("Hi Kel, it");
  expect(html).toContain("Call in GHL");
  expect(html).toContain('href="tel:+14255550101"');
  expect(html).toContain("Tried 1×");
  expect(renderToStaticMarkup(<CallCard item={{ id: "x", kind: "promise_owed" }} />)).toBe("");
});
