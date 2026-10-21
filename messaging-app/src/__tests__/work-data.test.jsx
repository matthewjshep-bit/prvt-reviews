import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load, forget, useLoad } from "../work-data.js";

function Peek({ k, onRead }) {
  onRead(useLoad(k, () => Promise.resolve(null), { maxAgeMs: 1e9 }));
  return null;
}
const read = (k) => { let got = null; renderToStaticMarkup(<Peek k={k} onRead={(r) => { got = r; }} />); return got; };
const fail = (status) => () => Promise.reject(Object.assign(new Error(status === 404 ? "offer not found" : "HTTP 500"), { status }));

// Matt, 2026-10-21: a draft he turned into an offer stayed in the companion,
// and its Status menu answered "offer not found". The re-read 404'd and the
// cache kept showing the row that no longer exists.
test("a draft that was turned into an offer doesn't stay on screen as 'offer not found'", async () => {
  const k = "offer:gone-draft";
  forget(k);
  await load(k, () => Promise.resolve({ id: "gone-draft", status: "draft" }));
  await load(k, fail(404));
  const r = read(k);
  expect(r.data).toBe(null);
  expect(r.missing).toBe(true);
});

test("a blip that isn't a 404 keeps what was already on screen", async () => {
  const k = "offer:still-here";
  forget(k);
  await load(k, () => Promise.resolve({ id: "still-here" }));
  await load(k, fail(500));
  const r = read(k);
  expect(r.data).toEqual({ id: "still-here" });
  expect(r.missing).toBe(false);
  expect(r.error).toBe("HTTP 500");
});
