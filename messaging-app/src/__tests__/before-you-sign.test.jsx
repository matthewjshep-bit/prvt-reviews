import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import BeforeYouSign, { confirmSigned, openFirst } from "../BeforeYouSign.jsx";

// 1538 NW 61st St (2026-10-19): the agent sent the paper to sign on a house
// the app only had as a held draft.
const paperOut = { id: "d1", status: "draft", address: "1538 NW 61st St, Seattle, WA 98107", paperAt: { at: new Date().toISOString(), kind: "sent_to_sign" } };
const checks = [
  { key: "remarks", label: "Listing remarks read", state: "unknown", detail: "no listing remarks on file" },
  { key: "agent_words", label: "What the agent said about it", state: "warn", detail: 'the agent said "teardown" — is it in the price?' },
  { key: "eyes", label: "Eyes on the house", state: "ok", detail: "17 listing photos scanned" },
  { key: "our_number", label: "At or under our number and the buyer ceiling", state: "warn", detail: "we never priced this house" },
];

test("an offer with the paper out shows what nobody checked, warnings first", () => {
  const html = renderToStaticMarkup(<BeforeYouSign offer={paperOut} checks={checks} />);
  expect(html).toContain("Before you sign");
  expect(html).toContain("2 warnings");
  expect(html.indexOf("What the agent said about it")).toBeLessThan(html.indexOf("Listing remarks read"));
  expect(html).not.toContain("Eyes on the house");
  expect(html).toContain("earnest money due after it");
  expect(openFirst(checks).map((c) => c.key)).toEqual(["agent_words", "our_number", "remarks"]);
});

test("an offer nowhere near paper shows nothing", () => {
  expect(renderToStaticMarkup(<BeforeYouSign offer={{ id: "o1", status: "sent", address: "12 Elm St" }} checks={checks} />)).toBe("");
});

test("marking it under contract asks once when something is a warning, and never when nothing is", async () => {
  let asked = "";
  const yes = await confirmSigned("d1", { read: async () => ({ checks }), ask: (m) => { asked = m; return false; } });
  expect(yes).toBe(false);
  expect(asked).toContain("2 warnings");
  expect(asked).toContain("teardown");
  let askedAgain = false;
  expect(await confirmSigned("d1", { read: async () => ({ checks: checks.filter((c) => c.state !== "warn") }), ask: () => { askedAgain = true; return false; } })).toBe(true);
  expect(askedAgain).toBe(false);
  expect(await confirmSigned("d1", { read: async () => { throw new Error("offline"); }, ask: () => false })).toBe(true);
});
