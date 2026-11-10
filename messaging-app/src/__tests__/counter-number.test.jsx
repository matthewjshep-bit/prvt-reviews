import { test, expect, vi } from "vitest";
import { statusItems } from "../ui.jsx";
import { setOfferStatus } from "../api.js";

// 2026-11-09: a counter Matt marked by hand from the status menu had no
// number, so it made no call row, started no hold clock and left the
// seller's number blank. "Countered" now asks for their number.
const withWindow = async (answers, fn) => {
  const real = globalThis.window;
  const said = [];
  globalThis.window = { prompt: vi.fn(() => answers.shift()), alert: vi.fn((m) => said.push(m)) };
  try { await fn(said); } finally { globalThis.window = real; }
};
const countered = (picked) => statusItems({ id: "o1", status: "sent" }, (k) => picked.push(k)).find((i) => i.key === "countered");

test("a counter marked by hand with their number records it", async () => {
  await withWindow(["430k", "", null, "a lot"], (said) => {
    const picked = [];
    const item = countered(picked);
    item.onSelect();   // "430k"
    item.onSelect();   // left empty: countered with no number
    item.onSelect();   // cancelled: the status is left alone
    item.onSelect();   // can't be read: said so, nothing picked
    expect(picked).toEqual(["countered:430000", "countered"]);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/430k/);
  });

  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ ok: true }) }; });
  try {
    await setOfferStatus("o1", "countered:430000");
    await setOfferStatus("o2", "countered");
  } finally { globalThis.fetch = real; }
  expect(sent[0].url).toContain("/api/offers/o1/status");
  expect(sent[0].body).toMatchObject({ status: "countered", amount: 430000 });
  expect(sent[1].body.status).toBe("countered");
  expect(sent[1].body.amount).toBeUndefined();
});
