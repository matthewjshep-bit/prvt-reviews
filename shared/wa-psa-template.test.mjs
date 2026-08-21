// wa-psa-template.test.mjs — the Washington PSA package's own consistency.
// Run with:  node --test shared/wa-psa-template.test.mjs
//
// The failure this exists to prevent: a typo'd {{token}} in a legal document.
// mergeTokens prints an unknown token as an underscore run, which looks exactly
// like a deliberate fill-in line — so a misspelled {{price_words}} ships a
// purchase agreement with a blank where the price should be, and nothing
// anywhere reports an error. Same class of silence for a section number that
// drifts away from the "§ 6" references written into the prose.

import test from "node:test";
import assert from "node:assert/strict";
import {
  PSA_MODES, PSA_TOKENS, PSA_SECTIONS, ADDENDUM_A, ADDENDUM_B,
  PSA_SUMMARY_INTRO, PSA_BUYER_DISCLOSURE, PSA_CLOSING_DISCLAIMER,
  psaSections, psaAddenda, psaSummaryRows, psaPackageList,
} from "./wa-psa-template.js";
import { mergeTokens } from "./contract-template.js";

const KNOWN = new Set(PSA_TOKENS.map((t) => t.key));
const tokensIn = (text) => [...String(text || "").matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);

// Every string the renderer will hand to mergeTokens, from every mode.
function allMergedText() {
  const out = [];
  for (const mode of PSA_MODES) {
    for (const s of psaSections(mode)) out.push(s.body, s.bodyAfter, s.incorporationSuffix);
    for (const a of psaAddenda(mode)) {
      out.push(a.intro);
      for (const c of a.clauses) out.push(c.body);
    }
    for (const [label, body] of psaSummaryRows(mode, { emdExhibitNo: 1, pofExhibitNo: 2 })) out.push(label, body);
    out.push(...psaPackageList(mode, { emdExhibitNo: 1, pofExhibitNo: 2 }));
  }
  return out.filter(Boolean);
}

test("every {{token}} in the package is one the renderer can fill", () => {
  const unknown = new Set();
  for (const text of allMergedText()) {
    for (const key of tokensIn(text)) if (!KNOWN.has(key)) unknown.add(key);
  }
  assert.deepEqual([...unknown], [], "unknown tokens print as blank lines, not errors");
});

test("the legal description token exists — § 2 renders it separately", () => {
  // psa-pdf.js merges "{{legal_description}}" itself rather than inlining it in
  // the section body, so this token has no other reference to keep it honest.
  assert.ok(KNOWN.has("legal_description"));
});

test("section numbers are 1..22, unique, and stable across modes", () => {
  for (const mode of PSA_MODES) {
    const ns = psaSections(mode).map((s) => s.n);
    assert.deepEqual(ns, [...Array(22)].map((_, i) => i + 1), `${mode} numbering`);
  }
});

test("every § cross-reference in the prose points at a real section", () => {
  const nums = new Set(PSA_SECTIONS.map((s) => s.n));
  for (const text of allMergedText()) {
    // "§ B-4" is an Addendum B clause, not a section — skip those.
    for (const m of String(text).matchAll(/§\s*(\d+)/g)) {
      const n = Number(m[1]);
      // IRC § 1445 (FIRPTA) is a federal citation, not one of ours.
      if (n === 1445) continue;
      assert.ok(nums.has(n), `§ ${n} is referenced but no such section exists`);
    }
  }
});

test("short sale swaps the timeline language rather than renumbering", () => {
  const std = new Map(psaSections("standard").map((s) => [s.id, s.body]));
  const short = new Map(psaSections("short_sale").map((s) => [s.id, s.body]));

  assert.match(std.get("feasibility"), /beginning on the date of Mutual Acceptance/);
  assert.match(short.get("feasibility"), /written lienholder approval under Addendum B/);
  assert.match(std.get("closing"), /on or before \{\{closing_date\}\}/);
  assert.match(short.get("closing"), /approval of this transaction from all lienholders/);
  // The standard mode must never mention an addendum it doesn't ship.
  for (const [id, body] of std) {
    assert.ok(!/Addendum B/.test(body), `standard § ${id} references Addendum B`);
  }
});

test("Addendum B ships only on a short sale", () => {
  assert.deepEqual(psaAddenda("standard").map((a) => a.label), ["ADDENDUM A"]);
  assert.deepEqual(psaAddenda("short_sale").map((a) => a.label), ["ADDENDUM A", "ADDENDUM B"]);
  assert.ok(psaPackageList("short_sale").some((i) => /Addendum B/.test(i)));
  assert.ok(!psaPackageList("standard").some((i) => /Addendum B/.test(i)));
});

test("an unknown mode falls back to the standard package, never to nothing", () => {
  assert.equal(psaSections("nonsense").length, 22);
  assert.deepEqual(psaAddenda("nonsense").map((a) => a.label), ["ADDENDUM A"]);
});

test("a missing exhibit takes its citation with it", () => {
  const rows = (opts) => Object.fromEntries(psaSummaryRows("short_sale", opts).map(([l, b]) => [l, b]));

  const both = rows({ emdExhibitNo: 1, pofExhibitNo: 2 });
  assert.match(both["Earnest Money"], /Exhibit 1/);
  assert.match(both["Proof of Funds"], /Exhibit 2/);

  const neither = rows({});
  assert.ok(!/Exhibit/.test(neither["Earnest Money"]), "no check, no citation");
  assert.ok(!/Exhibit/.test(neither["Proof of Funds"]), "no POF letter, no citation");
  assert.ok(!/\{\{lender_name\}\}/.test(neither["Proof of Funds"]), "and no lender token left dangling");

  // Only the POF uploaded: it becomes Exhibit 1, not Exhibit 2.
  const pofOnly = rows({ pofExhibitNo: 1 });
  assert.match(pofOnly["Proof of Funds"], /Exhibit 1/);
  assert.deepEqual(
    psaPackageList("standard", { pofExhibitNo: 1 }).filter((i) => /Exhibit/.test(i)),
    ["Exhibit 1 — Proof of funds letter"]
  );
});

test("blank values print fill-in lines, never the raw token", () => {
  for (const text of allMergedText()) {
    const merged = mergeTokens(text, {}, PSA_TOKENS);
    assert.ok(!/\{\{/.test(merged), `token survived merging in: ${text.slice(0, 60)}`);
  }
});

test("the honesty boilerplate says what it has to say", () => {
  assert.match(PSA_CLOSING_DISCLAIMER, /not a Northwest Multiple Listing Service form/);
  assert.match(PSA_CLOSING_DISCLAIMER, /Buyer is not an attorney/);
  assert.match(PSA_CLOSING_DISCLAIMER, /independent legal counsel/);
  // The assignment intent is disclosed up front, in writing, before signing —
  // that disclosure is the point of the row.
  assert.match(PSA_BUYER_DISCLOSURE, /before any party signs/);
  assert.match(PSA_SUMMARY_INTRO, /the Agreement and Addenda control/);
});

test("Addendum A and B clause numbers match their labels", () => {
  ADDENDUM_A.clauses.forEach((c, i) => assert.equal(c.num, `A-${i + 1}`));
  ADDENDUM_B.clauses.forEach((c, i) => assert.equal(c.num, `B-${i + 1}`));
});
