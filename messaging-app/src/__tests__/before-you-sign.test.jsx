import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { confirmSigned } from "../BeforeYouSign.jsx";

const checks = [
  { key: "remarks", label: "Listing remarks read", state: "unknown", detail: "no listing remarks on file" },
  { key: "agent_words", label: "What the agent said about it", state: "warn", detail: 'the agent said "teardown" — is it in the price?' },
  { key: "eyes", label: "Eyes on the house", state: "ok", detail: "17 listing photos scanned" },
  { key: "our_number", label: "At or under our number and the buyer ceiling", state: "warn", detail: "we never priced this house" },
];

test("the offer pane has no before-you-sign checklist", () => {
  expect(readFileSync(new URL("../PaneParts.jsx", import.meta.url), "utf8")).not.toContain("BeforeYouSign");
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
