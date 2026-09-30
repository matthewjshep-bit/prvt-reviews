// contact-events-window.test.mjs — reading a window of the timeline.
//
// Until 2026-09-29 a capped read kept the OLDEST rows, so the clocks that
// asked about this week lost this week first on a busy location.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "contact-events-window-test-"));

const { store, eventsSinceQuery, eventsPageQuery, keepNewest } = await import("./store.js");
const { allEventsSince } = await import("./contact-events.js");
await store.init();

const DAY = 86400000;
const NOW = Date.parse("2026-09-29T19:00:00Z");
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const since = ago(60);

const LOC = "loc-window";
for (let c = 0; c < 6; c++) {
  await store.appendContactEvents(LOC, `c${c}`, Array.from({ length: 50 }, (_, i) => ({
    id: `e-${c}-${String(i).padStart(3, "0")}`, type: "text_summary", at: ago(50 - i), source: "conversation", dedupeKey: `k:${c}:${i}`, data: {},
  })));
}

test("a busy window keeps this week's events and says it was cut", async () => {
  const rows = await store.listContactEventsSince(LOC, since, { types: ["text_summary"], limit: 100 });
  assert.equal(rows.length, 100);
  assert.equal(rows.truncated, true);
  assert.ok(rows.every((e, i) => i === 0 || String(rows[i - 1].at) <= String(e.at)), "still oldest first");
  assert.equal(rows.at(-1).at, ago(1), "the newest day is there");
  assert.ok(rows[0].at >= ago(17), `the oldest rows went, not the newest (first kept ${rows[0].at})`);
  assert.equal(JSON.stringify(rows).includes("truncated"), false, "the flag never leaks into JSON");
});

test("a quiet window comes back whole and oldest first", async () => {
  const rows = await store.listContactEventsSince(LOC, ago(3), { types: ["text_summary"], limit: 5000 });
  assert.equal(rows.length, 18);
  assert.equal(rows.truncated, false);
  assert.equal(rows[0].at, ago(3));
});

test("paging walks the whole window in order and stops at the ceiling with a flag", async () => {
  const all = await allEventsSince(store, LOC, since, { types: ["text_summary"] }, { pageSize: 40 });
  assert.equal(all.events.length, 300);
  assert.equal(all.truncated, false);
  assert.equal(new Set(all.events.map((e) => e.id)).size, 300, "no row twice across page edges");
  assert.ok(all.events.every((e, i) => i === 0 || String(all.events[i - 1].at) <= String(e.at)));
  const capped = await allEventsSince(store, LOC, since, { types: ["text_summary"] }, { pageSize: 40, ceiling: 120 });
  assert.equal(capped.events.length, 120);
  assert.equal(capped.truncated, true);
  const exact = await allEventsSince(store, LOC, since, { types: ["text_summary"] }, { pageSize: 40, ceiling: 300 });
  assert.equal(exact.truncated, false, "exactly the ceiling is not a cut");
});

test("the Postgres read keeps the newest rows and asks for one more to know", () => {
  const q = eventsSinceQuery({ locationId: "L", sinceIso: since, types: ["a", "b"], notParty: "agent", limit: 5000 });
  assert.match(q.text, /order by at desc, id desc limit \$5/);
  assert.equal(q.params.at(-1), 5001);
  const p = eventsPageQuery({ locationId: "L", sinceIso: since, after: { at: ago(3), id: "00000000-0000-0000-0000-000000000000" }, limit: 200 });
  assert.match(p.text, /\(at, id\) > \(\$3::timestamptz, \$4::uuid\)/);
  assert.match(p.text, /order by at asc, id asc limit \$5/);
  const kept = keepNewest([{ at: "3" }, { at: "2" }, { at: "1" }], 2);
  assert.deepEqual(kept.map((r) => r.at), ["2", "3"]);
  assert.equal(kept.truncated, true);
});

/* ---------- the whole buyer book (2026-09-29) ---------- */

// The book read stopped at 2,000 rows sorted by name. At ~1,980 buyers, the
// next import would have dropped the end of the alphabet from every pulse,
// wave and search without a word.
test("late-alphabet buyers past two thousand are still in the book the pulse and the waves read", async () => {
  const LOCB = "loc-book";
  const rows = Array.from({ length: 2050 }, (_, i) => ({ contactId: `b${i}`, name: `Buyer ${String(i).padStart(4, "0")}`, doc: {} }));
  rows.push({ contactId: "zz", name: "Zed Zimmer", doc: {} });
  await store.upsertInvestors(LOCB, rows);
  const book = await store.listInvestors(LOCB);
  assert.equal(book.length, 2051);
  assert.ok(book.some((i) => i.contactId === "zz"), "the last name alphabetically is read");
});
