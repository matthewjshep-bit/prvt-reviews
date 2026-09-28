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
