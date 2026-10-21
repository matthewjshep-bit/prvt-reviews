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
