import { test, expect } from "vitest";
import { blastResultLine, pickFits } from "../MatchInvestorsModal.jsx";

// 2026-11-23 audit (D8): after a Find buyers send from the app the modal read
// 'Tagged undefined investors with ""', and a paused deal's reason was lost.

test("an app send says how many were queued, not undefined", () => {
  const line = blastResultLine({ ok: true, sendWith: "app", blastTag: "dispo-12-alder", queued: 4, drafted: 2, waiting: 1, dryRun: false });
  expect(line.text).not.toMatch(/undefined/);
  expect(line.text).toBe("4 deal texts queued, going out over the sending hours; 2 waiting for you in the outbox; 1 of them held for a buyer's weekly limit.");
  expect(line.tone).toBe("ok");
});

test("a paused deal says why nothing went out", () => {
  const line = blastResultLine({ ok: true, sendWith: "app", blastTag: "", queued: 0, drafted: 0, dryRun: false, paused: { status: "soft_commit" }, reason: "a buyer is a soft commit on 12 Alder Ln" });
  expect(line.text).toBe("Nothing went out: a buyer is a soft commit on 12 Alder Ln.");
  expect(line.tone).toBe("warn");
});

test("the tag path still says how many were tagged, and a dry run says nothing was sent", () => {
  expect(blastResultLine({ ok: true, blasted: 3, blastTag: "dispo-x" }).text).toBe('Tagged 3 investors with "dispo-x".');
  expect(blastResultLine({ ok: true, sendWith: "app", dryRun: true, queued: 0, drafted: 0 }).tone).toBe("warn");
  expect(blastResultLine({ error: "boom" })).toEqual({ text: "boom", tone: "error" });
});

test("select strong fits picks only the strong ones not already on the deal", () => {
  const results = [
    { contactId: "a", fit: "strong" }, { contactId: "b", fit: "possible" }, { contactId: "c", fit: "strong" }, { contactId: "d", fit: "weak" },
  ];
  expect([...pickFits(results, { fit: "strong", existingIds: new Set(["c"]) })]).toEqual(["a"]);
  expect([...pickFits(results, { existingIds: new Set() })]).toEqual(["a", "b", "c", "d"]);
});
