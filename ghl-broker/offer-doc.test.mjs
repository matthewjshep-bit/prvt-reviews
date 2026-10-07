// offer-doc.test.mjs — the letter of intent's "How we priced it" box.
//
// Matt, 2026-10-07: the agent should see what our number is based on. The box
// sits beside the closing paragraph and signature, so the two things that can
// go wrong are the page (something runs into the fine print) and the money
// (a column that doesn't add up, or our fee on a page that goes to a seller).
//
//   node --test offer-doc.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { buildOfferDocument } from "./offer-doc.js";
import { calculateOffers } from "./shared/offer-calc.js";
import { offerMath } from "./shared/offer-breakdown.js";

const COMPANY = { name: "Shep Flips", signer: "Matt Shepherd", phone: "425-620-2863", email: "matt@shepflips.com", tagline: "Fair offers, fast closings" };
const MAO = { underwriteMode: "mao", maoPctOfArv: 75, wholesaleFee: 30000 };
const META = { contactName: "Sam Rivera", dateLabel: "October 7, 2026", validLabel: "October 14, 2026" };
const letter = (inputs, settings = MAO) => {
  const calc = calculateOffers({ address: "12 Elm St, Renton, WA 98056", ...inputs }, { ...settings, company: COMPANY });
  return { calc, doc: buildOfferDocument({ calc, meta: META, locationId: "loc" }) };
};
const texts = (doc) => doc.layers.filter((l) => l.type === "text").map((l) => l.content);
const FINE_PRINT_RULE = 95.4;

test("the letter shows how we priced it, adding up to the price printed on it", () => {
  const { calc, doc } = letter({ arv: 500000, repairs: 50000 });
  const t = texts(doc);
  for (const s of ["After-repair value", "Closing costs, buying and reselling", "Holding, 5 months", "Renovation budget", "Profit & risk", "Purchase price"]) {
    assert.ok(t.includes(s), s);
  }
  const m = offerMath({ calc }, { exact: true });
  for (const r of m.rows) assert.ok(t.some((x) => x.endsWith(`$${r.amount.toLocaleString("en-US")}`)), `${r.label} ${r.amount}`);
  assert.ok(t.includes("$295,000"));
  assert.equal(m.total, calc.offers.cash.amount);
});

test("a letter never names our fee, and nothing runs into the fine print", () => {
  for (const [inputs, settings] of [
    [{ arv: 500000, repairs: 50000 }, MAO],
    [{ arv: 200000, repairs: 40000 }, MAO],
    [{ arv: 1250000, repairs: 90000 }, MAO],
    [{ arv: 428500, repairs: 22000 }, { underwriteMode: "lowball", precisionJitter: true, wholesaleFee: 30000 }],
    [{ arv: 420000, repairs: 28500 }, { ...MAO, letterTerms: Array.from({ length: 7 }, (_, i) => ({ label: `Term ${i}`, value: "Something agreed" })) }],
  ]) {
    const { doc } = letter(inputs, settings);
    for (const s of texts(doc)) assert.doesNotMatch(s, /\bfee\b|assignment|wholesale/i, s);
    for (const l of doc.layers) {
      const finePrint = (l.type === "text" && /^This letter of intent is a non-binding/.test(l.content)) || (l.type === "shape" && l.y === FINE_PRINT_RULE);
      if (!finePrint) assert.ok(l.y + l.height <= FINE_PRINT_RULE, `${l.content || l.id} ends at ${l.y + l.height}`);
    }
  }
});

test("the lowball model's cents tie out on the letter", () => {
  const { calc, doc } = letter({ arv: 428500, repairs: 22000 }, { underwriteMode: "lowball", precisionJitter: true, wholesaleFee: 30000 });
  const m = offerMath({ calc }, { exact: true });
  const sum = m.rows.reduce((t, r) => t + (r.sign === "+" ? r.amount : -r.amount), 0);
  assert.equal(Math.round(sum * 100), Math.round(calc.offers.cash.amount * 100));
  assert.ok(texts(doc).some((s) => /\.\d\d$/.test(s) && s.includes("$")), "cents are printed where the model has them");
});

test("a price set above what the costs leave room for shows as a premium, not a negative line", () => {
  const { doc } = letter({ arv: 420000, repairs: 28500, priceOverride: 360000 });
  const t = texts(doc);
  assert.ok(t.includes("Premium over our numbers"));
  assert.ok(!t.includes("Profit & risk"));
  assert.ok(t.some((s) => /^\+\$/.test(s)));
});

test("with the setting off, the letter is the letter it always was", () => {
  const { doc } = letter({ arv: 500000, repairs: 50000 }, { ...MAO, showPricingMath: false });
  const t = texts(doc);
  assert.ok(!t.includes("Profit & risk"));
  assert.ok(!doc.layers.some((l) => l.type === "shape" && l.x === 51));
  const validity = doc.layers.find((l) => l.type === "text" && /^This offer is valid through/.test(l.content));
  assert.equal(validity.width, 84, "full width again");
});
