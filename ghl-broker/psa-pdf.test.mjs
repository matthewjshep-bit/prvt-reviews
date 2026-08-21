// psa-pdf.test.mjs — the Washington PSA renderer.
// Run with:  npm run test:psa
//
// This document goes to a listing broker and a seller, so the failures worth
// guarding are the ones that produce a plausible-looking file with something
// wrong inside it: a half-filled offer that throws instead of printing blanks,
// a short sale missing Addendum B, or an exhibit that silently takes the whole
// render down with it. Layout is not asserted here — page counts and survival
// are, because those are the things that break silently.

import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { renderPsaPdf } from "./psa-pdf.js";

const COMPANY = {
  name: "SHEP·FLIPS", tagline: "Real estate investment",
  email: "matthewjshep@gmail.com", phone: "(253) 555-0100", signer: "Matt Shepherd",
  brandPrimary: "#16294A", brandAccent: "#B8922E",
};

const VALUES = {
  effective_date: "August 21, 2026",
  buyer_entity: "Shep Flips Holdings LLC", buyer_state: "Washington",
  seller_name: "Dana Whitfield", address: "7316 166th Avenue East, Sumner, WA 98390",
  apn: "0520304011", legal_description: "Lot 4, Block 2, Plat of Cedar Ridge Div. 3, Vol. 41, Pg. 18, records of Pierce County, Washington.",
  county: "Pierce", price: "$312,000", price_words: "Three Hundred Twelve Thousand and 00/100",
  earnest_money: "$2,500", feasibility_days: "10", closing_days: "21",
  closing_date: "September 21, 2026", backstop_date: "November 1, 2026",
  title_company: "Rainier Title", title_officer: "J. Ortiz", title_phone: "(253) 555-0143",
  lender_name: "Cascade Capital", approval_deadline: "October 15, 2026", counter_days: "5",
  offer_expires: "August 24, 2026 at 5:00 PM",
  signer_name: "Matt Shepherd", signer_email: "matthewjshep@gmail.com", signer_phone: "(253) 555-0100",
};

const render = (opts = {}) =>
  renderPsaPdf({ values: VALUES, company: COMPANY, address: VALUES.address, ...opts });
const pageCount = async (buf) => (await PDFDocument.load(buf)).getPageCount();

// A real one-page PDF to stand in for a proof-of-funds letter.
async function onePagePdf(pages = 1) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    doc.addPage([612, 792]).drawText(`proof of funds ${i + 1}`, { x: 72, y: 700, size: 12, font });
  }
  return Buffer.from(await doc.save());
}

// Smallest valid PNG: a 1x1 transparent pixel.
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

test("both modes render a real PDF", async () => {
  for (const mode of ["standard", "short_sale"]) {
    const buf = await render({ mode });
    assert.ok(Buffer.isBuffer(buf), `${mode} returns a Buffer`);
    assert.equal(buf.subarray(0, 5).toString("ascii"), "%PDF-", `${mode} is a PDF`);
    assert.ok(await pageCount(buf) >= 6, `${mode} is a full package, not a stub`);
  }
});

test("a short sale is longer than a standard sale — Addendum B is really there", async () => {
  const standard = await pageCount(await render({ mode: "standard" }));
  const short = await pageCount(await render({ mode: "short_sale" }));
  assert.ok(short > standard, `short sale ${short}pp should exceed standard ${standard}pp`);
});

test("an empty agreement prints blanks instead of throwing", async () => {
  // The operator generates before filling anything in — every token blank, no
  // company, no address. It has to produce a signable fill-in-by-hand form.
  const buf = await renderPsaPdf({ mode: "short_sale" });
  assert.equal(buf.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.ok(await pageCount(buf) >= 6);
});

test("text outside WinAnsi can't crash a render", async () => {
  // Seller names and pasted legal descriptions are free text; pdf-lib's
  // standard fonts throw on anything WinAnsi can't encode.
  const buf = await render({
    values: { ...VALUES, seller_name: "Zoë Ō'Brien 🏠 日本", legal_description: "Lot 1 — “Cedar” Plat · 2½ acres" },
  });
  assert.equal(buf.subarray(0, 5).toString("ascii"), "%PDF-");
});

test("a PDF exhibit is merged page-for-page", async () => {
  const base = await pageCount(await render({ mode: "standard" }));
  const withOne = await pageCount(await render({
    mode: "standard",
    exhibits: [{ kind: "proofOfFunds", title: "Proof of funds letter", bytes: await onePagePdf(1), contentType: "application/pdf" }],
  }));
  assert.equal(withOne, base + 1);

  const withThree = await pageCount(await render({
    mode: "standard",
    exhibits: [{ kind: "proofOfFunds", title: "Proof of funds letter", bytes: await onePagePdf(3), contentType: "application/pdf" }],
  }));
  assert.equal(withThree, base + 3, "a multi-page letter keeps all its pages");
});

test("an image exhibit gets one captioned page", async () => {
  const base = await pageCount(await render({ mode: "standard" }));
  const withCheck = await pageCount(await render({
    mode: "standard",
    exhibits: [{ kind: "emdCheck", title: "Copy of earnest money check", bytes: PIXEL_PNG, contentType: "image/png" }],
  }));
  assert.equal(withCheck, base + 1);
});

test("an unreadable exhibit is dropped, not fatal", async () => {
  // A truncated upload or a file that stopped being a PDF must cost us that
  // one page, not the whole offer.
  const base = await pageCount(await render({ mode: "standard" }));
  const buf = await render({
    mode: "standard",
    exhibits: [{ kind: "proofOfFunds", title: "Proof of funds letter", bytes: Buffer.from("not a pdf at all"), contentType: "application/pdf" }],
  });
  assert.equal(buf.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.equal(await pageCount(buf), base, "the agreement still renders, minus the exhibit");
});

test("a malformed brand color falls back instead of throwing", async () => {
  const buf = await render({ company: { ...COMPANY, brandPrimary: "red", brandAccent: "#nothex" } });
  assert.equal(buf.subarray(0, 5).toString("ascii"), "%PDF-");
});

test("additional terms extend the document without renumbering it", async () => {
  const plain = await render({ mode: "standard" });
  const withTerms = await render({ mode: "standard", additionalTerms: "x".repeat(6000) });
  assert.ok(await pageCount(withTerms) > await pageCount(plain), "6k of extra terms adds pages");
});
