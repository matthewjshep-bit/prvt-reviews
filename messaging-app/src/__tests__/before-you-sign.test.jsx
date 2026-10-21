import { test, expect } from "vitest";
import { readFileSync } from "node:fs";

// Matt doesn't work from a before-you-sign checklist (2026-10-21): not on the
// offer pane, and no "Mark it under contract anyway?" ask when promoting.
test("no before-you-sign checklist on the pane and no ask when marking it under contract", () => {
  for (const f of ["PaneParts.jsx", "OffersHistory.jsx", "NewOffer.jsx"]) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    expect(src, f).not.toContain("BeforeYouSign");
    expect(src, f).not.toContain("confirmSigned");
  }
});
