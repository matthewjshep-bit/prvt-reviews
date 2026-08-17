// offer-snapshot.test.mjs — the snapshot size gate.
// Run with:  npm run test:snapshot
//
// The failure this exists to prevent: a create that succeeds, reports no error,
// and quietly returns an offer with no comps, no rehab scope and no comps PDF,
// because the snapshot was one byte over a cap and got replaced with null.
//
// So the guarantees under test are (1) something always survives if comps are
// present, (2) Zillow captures are the last thing to go — they're unrecoverable
// once claimed, and (3) a trim is never silent.

import test from "node:test";
import assert from "node:assert/strict";
import { fitSnapshot, SNAPSHOT_LIMIT } from "./offer-snapshot.js";

// Filler that survives JSON round-tripping at a predictable size.
const bulk = (n) => "x".repeat(n);

const capture = (i) => ({ id: `z-${i}`, source: "zillow", price: 400000 + i, label: `${i} Zillow St` });
const providerComp = (i, pad = 0) => ({ id: `p-${i}`, price: 390000 + i, label: `${i} Provider Ave`, blob: bulk(pad) });

test("a snapshot under the cap is passed through untouched", () => {
  const snap = { comps: { captured: [capture(1)], selected: ["z-1"] }, rehab: { aiResult: { summary: "ok" } } };
  const r = fitSnapshot(snap);
  assert.equal(r.snapshot, snap, "same object, not a copy");
  assert.deepEqual(r.warnings, []);
});

test("the AI condition report goes first — it can be re-run", () => {
  const snap = {
    comps: { captured: [capture(1)], selected: ["z-1"] },
    rehab: { aiResult: { raw: bulk(SNAPSHOT_LIMIT) }, custom: [{ label: "Roof", cost: 12000 }] },
  };
  const r = fitSnapshot(snap);
  assert.equal(r.snapshot.rehab.aiResult, null);
  assert.deepEqual(r.snapshot.rehab.custom, [{ label: "Roof", cost: 12000 }], "the scope itself survives");
  assert.deepEqual(r.snapshot.comps.captured, [capture(1)]);
  assert.match(r.warnings[0], /AI condition report/);
});

test("unticked provider comps go before ticked ones", () => {
  const snap = {
    comps: {
      selected: ["p-1", "z-9"],
      captured: [capture(9)],
      result: { comps: [providerComp(1), ...Array.from({ length: 40 }, (_, i) => providerComp(100 + i, 12_000))] },
    },
  };
  const r = fitSnapshot(snap);
  const ids = r.snapshot.comps.result.comps.map((c) => c.id);
  assert.deepEqual(ids, ["p-1"], "only the ticked provider comp is kept");
  assert.deepEqual(r.snapshot.comps.captured, [capture(9)], "captures untouched");
  assert.match(r.warnings[0], /hadn't ticked/);
});

test("Zillow captures survive when everything else has to go", () => {
  const captured = Array.from({ length: 12 }, (_, i) => capture(i));
  const snap = {
    inputs: { address: "1 Main St", blob: bulk(SNAPSHOT_LIMIT) },
    letterTerms: { blob: bulk(SNAPSHOT_LIMIT) },
    comps: { captured, selected: captured.map((c) => c.id) },
  };
  const r = fitSnapshot(snap);
  assert.deepEqual(r.snapshot.comps.captured, captured, "every capture kept");
  assert.equal(r.snapshot.inputs, undefined, "the bulky rest was shed");
  assert.match(r.warnings[0], /kept only the comps/);
});

test("shedding stops as soon as it fits — it doesn't strip everything it can", () => {
  const snap = {
    inputs: { address: "1 Main St" },
    rehab: { aiResult: { raw: bulk(SNAPSHOT_LIMIT) } },
    comps: { captured: [capture(1)], selected: ["z-1"], result: { comps: [providerComp(2)] } },
  };
  const r = fitSnapshot(snap);
  assert.equal(r.snapshot.rehab.aiResult, null, "step 1 ran");
  assert.ok(r.snapshot.comps.result, "step 3 did NOT run — it already fit");
  assert.deepEqual(r.snapshot.inputs, { address: "1 Main St" }, "the form survived");
  assert.equal(r.warnings.length, 1, "one warning, not one per available step");
});

test("a trim is never silent", () => {
  const snap = { comps: { captured: [capture(1)] }, rehab: { aiResult: { raw: bulk(SNAPSHOT_LIMIT) } } };
  const r = fitSnapshot(snap);
  assert.ok(r.warnings.length, "something was dropped, so something must be said");
  assert.match(r.warnings[0], /^snapshot:/);
});

test("hopeless and unserializable payloads report rather than throw", () => {
  const huge = fitSnapshot({ comps: { captured: [{ id: "z-1", blob: bulk(SNAPSHOT_LIMIT * 2) }] } });
  assert.equal(huge.snapshot, null);
  assert.match(huge.warnings[0], /even after trimming/);

  const cyclic = { comps: {} };
  cyclic.self = cyclic;
  const r = fitSnapshot(cyclic);
  assert.equal(r.snapshot, null);
  assert.match(r.warnings[0], /unserializable/);

  assert.deepEqual(fitSnapshot(null), { snapshot: null, warnings: [] });
  assert.deepEqual(fitSnapshot("nope"), { snapshot: null, warnings: [] });
});

test("the caller's object is never mutated", () => {
  const snap = {
    rehab: { aiResult: { raw: bulk(SNAPSHOT_LIMIT) } },
    comps: { captured: [capture(1)], selected: ["z-1"] },
  };
  const before = JSON.stringify(snap);
  fitSnapshot(snap);
  assert.equal(JSON.stringify(snap), before);
});
