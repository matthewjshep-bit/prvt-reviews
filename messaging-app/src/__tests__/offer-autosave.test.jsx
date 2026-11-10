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
import { createAutosaver, namesAHouse, saveKindFor, DRAFT_DELAY_MS, LIVE_DELAY_MS, RETRY_MS, MAX_RETRIES,
  restoredInputs, pricedSettings, editorSettings, restoredUnderwriteMode, raiseAskFrom, sendWaitsLine } from "../offer-autosave.js";
import { calculateOffers } from "@shared/offer-calc.js";

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

/* ---------- a sent offer's price moves only when a person says so (2026-11-09) ---------- */
// UWM-03: the engine sent 254k (ARV 500k, rehab 66k by age, priced at 70% with a 15k fee and an
// override at its open). The snapshot it saved carries the bare 45k scope with no override, and the
// location now prices at 75% with a 30k fee. Opening it to fix a term re-priced the letter on the
// first keystroke.

const LOCATION = { underwriteMode: "mao", maoPctOfArv: 75, wholesaleFee: 30000, validityDays: 7 };
const ENGINE_ROW = {
  id: "o-eng", status: "sent", contactId: "c1", contactName: "Robin", address: "2290 Hollyhock Ln, Tacoma, WA 98404", pdfUrl: "https://x/doc.pdf",
  cashAmount: 254000, sends: [{ ts: "2026-11-06T18:00:00.000Z", channels: ["sms"], results: { sms: { ok: true } } }],
  autoUnderwrite: { basis: "engine" }, pricing: { live: true, grade: "A", open: 254000, walkAway: 262000 },
  calc: { inputs: { address: "2290 Hollyhock Ln, Tacoma, WA 98404", arv: 500000, repairs: 66000, askingPrice: 389000, priceOverride: 254000 },
    settings: { ...LOCATION, maoPctOfArv: 70, wholesaleFee: 15000, letterTerms: [] } },
  snapshot: { mode: "existing", underwriteMode: "mao", inputs: { address: "2290 Hollyhock Ln, Tacoma, WA 98404", arv: 500000, repairs: 45000, askingPrice: 389000 } },
};

test("opening an engine offer and editing a term keeps its price", async () => {
  const snap = ENGINE_ROW.snapshot;
  const inputs = restoredInputs({ restore: ENGINE_ROW, snap });
  expect(inputs.repairs).toBe("66,000");
  expect(inputs.priceOverride).toBe("254,000");
  const mode = restoredUnderwriteMode({ restore: ENGINE_ROW, snap, settings: LOCATION });
  const base = { settings: LOCATION, priced: pricedSettings(ENGINE_ROW), underwriteMode: mode, feeOverride: "", uwOverrides: {}, offerExpires: "" };
  const opened = calculateOffers(inputs, editorSettings({ ...base, letterTerms: [{ label: "Closing", value: "21 days" }] }));
  expect(opened.offers.cash.amount).toBe(254000);
  // Edit a term: the letter re-renders at the same price.
  const edited = calculateOffers(inputs, editorSettings({ ...base, letterTerms: [{ label: "Closing", value: "30 days or sooner" }] }));
  expect(edited.offers.cash.amount).toBe(254000);
  // Even with the override cleared, it prices at what it was priced at, not today's 75% and 30k fee.
  const bare = calculateOffers({ ...inputs, priceOverride: "" }, editorSettings({ ...base, letterTerms: [] }));
  expect(bare.offers.cash.amount).toBe(Math.round(500000 * 0.70 - 66000 - 15000));
  // The editor opens showing that price.
  const NewOffer = await editor();
  const html = renderToStaticMarkup(<NewOffer settings={LOCATION} restore={ENGINE_ROW} />);
  expect(html).toContain("254,000");
  expect(html).not.toContain("300,000");
});

// The engine branch puts draft.engine on the held draft's form copy (null-safe: absent, nothing changes).
const ENGINE_DRAFT = {
  id: "d-eng", status: "draft", contactId: "c1", contactName: "Robin", address: "515 Bramblewood Dr, Tacoma, WA 98404", autoUnderwrite: { held: ["grade B"] },
  draft: { mode: "existing", inputs: { address: "515 Bramblewood Dr, Tacoma, WA 98404", arv: 480000, repairs: 41000, askingPrice: 365000 },
    engine: { grade: "B", arv: 470000, rehab: 62000, rehabWhy: "1950s house: age floor", open: 238000, walkAway: 249000, triage: "workable", reasons: ["comps thin"] } },
};

test("an engine draft opens on the engine's rehab, not the bare scope", async () => {
  const inputs = restoredInputs({ restore: ENGINE_DRAFT, snap: ENGINE_DRAFT.draft });
  expect(inputs.repairs).toBe("62,000");
  expect(inputs.arv).toBe("470,000");
  expect(inputs.priceOverride).toBe("", "the price is still yours to set");
  // Once you've saved the draft, what you typed is what it opens on.
  const yours = { ...ENGINE_DRAFT, draft: { ...ENGINE_DRAFT.draft, engineApplied: true, inputs: { ...ENGINE_DRAFT.draft.inputs, repairs: "75,000" } } };
  expect(restoredInputs({ restore: yours, snap: yours.draft }).repairs).toBe("75,000");
  // The editor shows the engine's numbers beside yours.
  const NewOffer = await editor();
  const html = renderToStaticMarkup(<NewOffer settings={LOCATION} restore={ENGINE_DRAFT} />);
  expect(html).toContain("Engine: grade B");
  expect(html).toContain("walk-away 249k");
  expect(html).toContain("rehab 62k (1950s house: age floor)");
});

// Before 11-09 any row with paper and no saved workspace opened on its calc.inputs. An income or
// land row is still priced from its deal, but it keeps its address and figures off calc.inputs.
test("an income row with no saved workspace still opens on its address", () => {
  const income = { id: "o-inc", status: "sent", calc: { model: "income", inputs: { address: "77 Cobblestone Row, Tacoma, WA 98402", askingPrice: 1450000, arv: 0, repairs: 0, priceOverride: 0 }, settings: { maoPctOfArv: 60 } } };
  const inputs = restoredInputs({ restore: income, snap: null });
  expect(inputs.address).toBe("77 Cobblestone Row, Tacoma, WA 98402");
  expect(inputs.askingPrice).toBe("1,450,000");
  expect(pricedSettings(income)).toBe(null);
});

test("a draft still opens on its own form, and a new offer on today's settings", () => {
  const draft = { id: "d1", status: "draft", calc: { inputs: { arv: 1 }, settings: { maoPctOfArv: 60 } }, draft: { inputs: { address: "1 Pine St", arv: "410,000" } } };
  expect(restoredInputs({ restore: draft, snap: draft.draft }).arv).toBe("410,000");
  expect(pricedSettings(draft)).toBe(null);
  expect(pricedSettings(null)).toBe(null);
  expect(editorSettings({ settings: LOCATION, priced: null, underwriteMode: "mao", letterTerms: [] }).maoPctOfArv).toBe(75);
});

test("a save the server says raises a sent offer stops and asks, keeping what you typed", async () => {
  const ask = Object.assign(new Error("This raises a sent offer from 254k to 300k: confirm?"), { status: 409, needsConfirm: "raise", from: 254000, to: 300000 });
  expect(raiseAskFrom(ask)).toEqual({ from: 254000, to: 300000, line: "This raises a sent offer from 254k to 300k: confirm?" });
  expect(raiseAskFrom(new Error("offline"))).toBe(null);

  let confirmed = false;
  const run = vi.fn(async (kind, opts) => { if (!opts.confirmRaise) throw ask; confirmed = true; });
  const states = [];
  const saver = createAutosaver({ run, onState: (s) => states.push(s), timers: { setTimeout, clearTimeout } });
  saver.schedule("live");
  await vi.advanceTimersByTimeAsync(LIVE_DELAY_MS);
  expect(states.at(-1).phase).toBe("confirm");
  expect(states.at(-1).ask).toEqual({ from: 254000, to: 300000, line: "This raises a sent offer from 254k to 300k: confirm?" });
  // No retries: it waits for you.
  await vi.advanceTimersByTimeAsync(RETRY_MS * (MAX_RETRIES + 2));
  expect(run).toHaveBeenCalledTimes(1);
  expect(saver.idle()).toBe(false);
  // Leaving without confirming doesn't push the raise through.
  await saver.flush({ final: true });
  expect(confirmed).toBe(false);
  // Confirm sends the same save, marked confirmed.
  await saver.confirm();
  expect(confirmed).toBe(true);
  expect(run).toHaveBeenLastCalledWith("live", { final: false, confirmRaise: true });
  expect(states.at(-1).phase).toBe("saved");
});

// Send flushes the save first, so the agent gets the number on screen. A raise waiting on your
// confirm never saved: the letter is still the old one, so Send waits too.
test("a raise waiting on your confirm keeps Send from going out on the old letter", async () => {
  const ask = Object.assign(new Error("This raises a sent offer from 254k to 300k: confirm?"), { status: 409, needsConfirm: "raise", from: 254000, to: 300000 });
  let raise = true;
  const run = vi.fn(async (kind, opts) => { if (raise && !opts.confirmRaise) throw ask; });
  const saver = createAutosaver({ run, onState: () => {}, timers: { setTimeout, clearTimeout } });
  expect(saver.asking()).toBe(null);
  saver.schedule("live");
  await saver.flush();
  expect(saver.asking()).toEqual({ from: 254000, to: 300000, line: "This raises a sent offer from 254k to 300k: confirm?" });
  expect(sendWaitsLine(saver.asking())).toBe("Not sent: this raises a sent offer from 254k to 300k. Confirm the raise above, or bring the number back down, then send.");
  // Bring it back down: the save goes through and Send is free again.
  raise = false;
  saver.schedule("live");
  await saver.flush();
  expect(saver.asking()).toBe(null);
  expect(sendWaitsLine(null)).toBe("");
});

// The server keeps a deal's letter at the contract price whatever is typed; the editor says so
// when what's on screen comes out at something else, so the preview isn't mistaken for the letter.
test("typing on a deal's offer says the letter stays at the contract price", async () => {
  const DEAL_ROW = { ...ENGINE_ROW, id: "o-deal", status: "accepted", deal: { stage: "under_contract", contractPrice: 249500 },
    calc: { ...ENGINE_ROW.calc, inputs: { ...ENGINE_ROW.calc.inputs, priceOverride: 0 } } };
  const NewOffer = await editor();
  const html = renderToStaticMarkup(<NewOffer settings={LOCATION} restore={DEAL_ROW} />);
  expect(html).toContain("Under contract: the letter stays at the contract price, $249,500.");
  const atContract = { ...DEAL_ROW, calc: { ...DEAL_ROW.calc, inputs: { ...DEAL_ROW.calc.inputs, priceOverride: 249500 } } };
  expect(renderToStaticMarkup(<NewOffer settings={LOCATION} restore={atContract} />)).not.toContain("Under contract:");
});

// The engine branch marks a walk-away far over the seller's number "over_theirs": its ARV is likely
// high. That draft opens on the lower of the engine's ARV and our own comps ARV, never the high one.
test("an engine draft whose ARV is likely high never opens above our own comps ARV", () => {
  const high = { ...ENGINE_DRAFT, draft: { ...ENGINE_DRAFT.draft, engine: { ...ENGINE_DRAFT.draft.engine, arv: 910000, triage: "over_theirs" } } };
  const inputs = restoredInputs({ restore: high, snap: high.draft });
  expect(inputs.arv).toBe("480,000");
  expect(inputs.repairs).toBe("62,000");
  const lower = { ...ENGINE_DRAFT, draft: { ...ENGINE_DRAFT.draft, engine: { ...ENGINE_DRAFT.draft.engine, arv: 455000, triage: "over_theirs" } } };
  expect(restoredInputs({ restore: lower, snap: lower.draft }).arv).toBe("455,000");
});
