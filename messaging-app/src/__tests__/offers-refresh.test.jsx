// offers-refresh.test.jsx — the Offers table re-reads its rows while it's
// open (2026-11-23 audit): what the bot changed shows without a reload, and
// nothing the first load worked out is thrown away.
import { test, expect } from "vitest";
import { applyLean, mergeLean } from "../offers-refresh.js";
import { pollDue } from "../light-poll.js";

const row = (over = {}) => ({ id: "o1", contactId: "c1", status: "sent", statusAt: "2026-11-20T18:00:00Z", sends: [{ ts: "2026-11-20T18:00:00Z" }], ...over });
const loaded = (over = {}) => row({ lastActivity: { at: "2026-11-21T18:00:00Z", dir: "in" }, floatedAt: null,
  nextFollowUp: { at: "2026-11-25T17:00:00Z", label: "Nudge · day 7" }, ...over });

test("a status the bot set shows without a reload, and that agent's What's next is re-read", () => {
  const { rows, contacts } = mergeLean([loaded()], [row({ status: "countered", statusAt: "2026-11-22T18:00:00Z", counter: { amount: 410000 } })]);
  expect(rows[0].status).toBe("countered");
  expect(rows[0].lastActivity.dir).toBe("in");
  expect(rows[0].nextFollowUp).toEqual({ stale: true });
  expect(contacts).toEqual(["c1"]);
});

test("a row nobody touched keeps everything the first load worked out", () => {
  const first = loaded();
  const { rows, contacts } = mergeLean([first], [row()]);
  expect(rows[0]).toBe(first);
  expect(contacts).toEqual([]);
});

test("a new auto-underwritten offer joins the table, and a deleted one leaves", () => {
  const { rows, contacts } = mergeLean([loaded(), loaded({ id: "gone", contactId: "c2" })], [row(), row({ id: "new", contactId: "c3", status: "draft" })]);
  expect(rows.map((o) => o.id)).toEqual(["o1", "new"]);
  expect(contacts.sort()).toEqual(["c2", "c3"]);
});

test("the re-read never runs while the tab is hidden, twice at once, or sooner than asked", () => {
  const now = 1_000_000;
  expect(pollDue({ hidden: true, lastAt: 0, now })).toBe(false);
  expect(pollDue({ busy: true, lastAt: 0, now })).toBe(false);
  expect(pollDue({ lastAt: now - 30_000, now, minGapMs: 60_000 })).toBe(false);
  expect(pollDue({ lastAt: now - 90_000, now, minGapMs: 60_000 })).toBe(true);
});

// Review 2026-11-23: a re-read that left before Matt marked a row and came
// back after put the old status back on it until the next re-read.
test("a re-read that was out while Matt changed a row doesn't put the old status back", () => {
  const base = [loaded()];
  const fresh = [row()];   // read before his change reached the server
  const afterHisChange = [loaded({ status: "dead", statusAt: "2026-11-23T18:00:00Z" })];
  expect(applyLean(base, afterHisChange, fresh)).toBe(null);
  // Nothing changed on the page while it was out: it applies as usual.
  const { rows } = applyLean(base, base, [row({ status: "countered" })]);
  expect(rows[0].status).toBe("countered");
});
