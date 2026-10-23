// The offer editor saves as you type (2026-10-23). Matt: "whatever we type
// just saves in real time … we can send it and then it'll update the status
// when sent and we can just triage from there." The five save buttons are
// gone; Send and the Status menu are what's left.
import { test, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("leaflet", () => ({ default: { divIcon: () => ({}), icon: () => ({}), Icon: { Default: { mergeOptions: () => {}, prototype: {} } }, latLngBounds: () => ({}) } }));
vi.mock("leaflet/dist/leaflet.css", () => ({}));
vi.mock("react-leaflet", () => { const C = () => null; return { MapContainer: C, TileLayer: C, Marker: C, Popup: C, CircleMarker: C, Circle: C, Tooltip: C, Polyline: C, useMap: () => ({}), useMapEvents: () => ({}) }; });
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createAutosaver, namesAHouse, saveKindFor, DRAFT_DELAY_MS, LIVE_DELAY_MS, RETRY_MS, MAX_RETRIES } from "../offer-autosave.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const saverWith = (run) => {
  const states = [];
  const saver = createAutosaver({ run, onState: (s) => states.push(s.phase), timers: { setTimeout, clearTimeout } });
  return { saver, states };
};

test("a house number and a street make a house; half an address doesn't", () => {
  expect(namesAHouse("4410 N Mullen")).toBe(true);
  expect(namesAHouse("4410 N Mullen St, Tacoma, WA 98407")).toBe(true);
  expect(namesAHouse("4410")).toBe(false);
  expect(namesAHouse("Mullen St")).toBe(false);
  expect(namesAHouse("")).toBe(false);
});

test("what a save is depends on the row: no paper is a draft, paper is live or workspace", () => {
  expect(saveKindFor({ row: null, letterChanged: true })).toBe("draft");
  expect(saveKindFor({ row: { id: "d1", status: "draft" }, letterChanged: true })).toBe("draft");
  // A draft given an outcome by hand still has no paper.
  expect(saveKindFor({ row: { id: "d2", status: "passed" }, letterChanged: true })).toBe("draft");
  expect(saveKindFor({ row: { id: "o1", status: "sent", pdfUrl: "x" }, letterChanged: true })).toBe("live");
  expect(saveKindFor({ row: { id: "o1", status: "sent", pdfUrl: "x" }, letterChanged: false })).toBe("workspace");
});

test("typing saves once, after the typing stops", async () => {
  const run = vi.fn(async () => {});
  const { saver } = saverWith(run);
  saver.schedule("draft");
  vi.advanceTimersByTime(DRAFT_DELAY_MS - 100);
  saver.schedule("draft");
  vi.advanceTimersByTime(DRAFT_DELAY_MS - 100);
  expect(run).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(200);
  expect(run).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledWith("draft", { final: false });
});

test("an offer's letter waits for the typing to settle, and the bigger save absorbs the smaller", async () => {
  const run = vi.fn(async () => {});
  const { saver } = saverWith(run);
  saver.schedule("workspace");
  saver.schedule("live");
  saver.schedule("workspace");
  await vi.advanceTimersByTimeAsync(DRAFT_DELAY_MS + 10);
  expect(run).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(LIVE_DELAY_MS);
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0][0]).toBe("live");
});

test("saves run one at a time, in order — a slow one never races the next", async () => {
  const order = [];
  let release;
  const run = vi.fn((kind) => new Promise((resolve) => {
    order.push(`start:${kind}`);
    if (!release) release = () => { order.push(`end:${kind}`); resolve(); };
    else { order.push(`end:${kind}`); resolve(); }
  }));
  const { saver } = saverWith(run);
  saver.schedule("draft");
  await vi.advanceTimersByTimeAsync(DRAFT_DELAY_MS);
  saver.schedule("draft");
  await vi.advanceTimersByTimeAsync(DRAFT_DELAY_MS);
  expect(order).toEqual(["start:draft"]);
  expect(saver.idle()).toBe(false);
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(order).toEqual(["start:draft", "end:draft", "start:draft", "end:draft"]);
  expect(saver.idle()).toBe(true);
});

test("a failed save says so and tries again, a few times", async () => {
  const run = vi.fn(async () => { throw new Error("offline"); });
  const { saver, states } = saverWith(run);
  saver.schedule("draft");
  await vi.advanceTimersByTimeAsync(DRAFT_DELAY_MS);
  expect(states.at(-1)).toBe("error");
  await vi.advanceTimersByTimeAsync(RETRY_MS * (MAX_RETRIES + 2));
  expect(run).toHaveBeenCalledTimes(MAX_RETRIES);
});

test("leaving the form sends what's pending, marked final", async () => {
  const run = vi.fn(async () => {});
  const { saver } = saverWith(run);
  saver.schedule("live");
  await saver.flush({ final: true });
  expect(run).toHaveBeenCalledWith("live", { final: true });
  // Nothing pending still tells a live offer you've left (the history line).
  await saver.flush({ final: true });
  expect(run).toHaveBeenLastCalledWith(null, { final: true });
});

test("moving to the house's own row drops what this form had pending", async () => {
  const run = vi.fn(async () => {});
  const { saver } = saverWith(run);
  saver.schedule("draft");
  saver.cancel();
  await vi.advanceTimersByTimeAsync(DRAFT_DELAY_MS * 2);
  await saver.flush({ final: true });
  expect(run).not.toHaveBeenCalled();
});

/* ---------- the editor's buttons ---------- */

const editor = async () => {
  globalThis.window = globalThis.window || { location: { search: "" }, addEventListener() {}, removeEventListener() {} };
  return (await import("../NewOffer.jsx")).default;
};
const OLD_BUTTONS = ["Save draft", "Update draft", "Create offer", "Save changes", "Save as new offer", "Clear form"];

test("a new offer has Send and nothing to save by hand", async () => {
  const NewOffer = await editor();
  const html = renderToStaticMarkup(<NewOffer settings={{}} />);
  for (const b of OLD_BUTTONS) expect(html).not.toContain(b);
  expect(html).toContain("Send");
  expect(html).toContain("Saves as you type");
});

test("an offer that went out says it's live and keeps Send and the Status menu", async () => {
  const NewOffer = await editor();
  const sent = { id: "o1", status: "sent", contactId: "c1", contactName: "Dana", address: "4410 N Mullen St, Tacoma, WA 98407", pdfUrl: "https://x/doc.pdf",
    sends: [{ ts: "2026-10-22T18:00:00.000Z", channel: "sms" }],
    calc: { inputs: { address: "4410 N Mullen St, Tacoma, WA 98407", arv: 520000, repairs: 60000 } },
    snapshot: { inputs: { address: "4410 N Mullen St, Tacoma, WA 98407", arv: "520,000", repairs: "60,000" } } };
  const html = renderToStaticMarkup(<NewOffer settings={{}} restore={sent} />);
  for (const b of OLD_BUTTONS) expect(html).not.toContain(b);
  expect(html).toContain("Editing offer");
  expect(html).toContain("Live: the agent");
  expect(html).not.toContain("Let the bot take it");
});

test("a held auto-underwrite draft offers to hand it to the bot; a plain draft doesn't", async () => {
  const NewOffer = await editor();
  const draft = (extra) => ({ id: "d1", status: "draft", contactId: "c1", contactName: "Dana", address: "1702 S 56th St, Tacoma, WA 98408",
    draft: { inputs: { address: "1702 S 56th St, Tacoma, WA 98408", arv: "400,000", repairs: "50,000" }, contact: { id: "c1", name: "Dana" } }, ...extra });
  const held = renderToStaticMarkup(<NewOffer settings={{}} restore={draft({ autoUnderwrite: { held: ["comps thin"] } })} />);
  expect(held).toContain("Let the bot take it");
  expect(held).toContain("Editing draft");
  const plain = renderToStaticMarkup(<NewOffer settings={{}} restore={draft({})} />);
  expect(plain).not.toContain("Let the bot take it");
});
