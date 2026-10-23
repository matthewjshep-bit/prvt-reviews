// Every window shows the offer as it was last saved (offer-sync.js): the
// editor in one window, the companion beside GHL in another.
import { test, expect, vi, beforeEach } from "vitest";

class FakeChannel {
  static all = [];
  constructor(name) { this.name = name; this.listeners = new Set(); FakeChannel.all.push(this); }
  postMessage(data) { for (const c of FakeChannel.all) if (c !== this && c.name === this.name) for (const l of c.listeners) l({ data }); }
  addEventListener(_t, fn) { this.listeners.add(fn); }
  removeEventListener(_t, fn) { this.listeners.delete(fn); }
}

beforeEach(() => {
  vi.resetModules();
  FakeChannel.all = [];
  globalThis.BroadcastChannel = FakeChannel;
  const target = new EventTarget();
  globalThis.window = { addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target), dispatchEvent: target.dispatchEvent.bind(target) };
  globalThis.document = { hidden: false };
});

test("a save in this window reaches this window's views, marked local", async () => {
  const sync = await import("../offer-sync.js");
  const seen = [];
  const off = sync.onOfferChanged((m) => seen.push(m));
  sync.announceOffer({ id: "o1", contactId: "c1", updatedAt: "2026-10-23T20:00:00.000Z" });
  expect(seen).toEqual([{ id: "o1", contactId: "c1", updatedAt: "2026-10-23T20:00:00.000Z", deleted: false, local: true }]);
  off();
  sync.announceOffer({ id: "o1", contactId: "c1" });
  expect(seen).toHaveLength(1);
});

test("a save in another window arrives over the channel, not marked local", async () => {
  const mine = await import("../offer-sync.js");
  const seen = [];
  mine.onOfferChanged((m) => seen.push(m));
  // The other window: its own module, its own channel.
  vi.resetModules();
  const other = await import("../offer-sync.js");
  other.announceOffer({ id: "o2", contactId: "c9", updatedAt: "2026-10-23T20:01:00.000Z" });
  expect(seen.some((m) => m.id === "o2" && m.local === false)).toBe(true);
});

test("coming back to the window re-reads, for the window on the other host", async () => {
  const sync = await import("../offer-sync.js");
  const seen = [];
  sync.onOfferChanged((m) => seen.push(m));
  globalThis.window.dispatchEvent(new Event("focus"));
  expect(seen).toEqual([{ focus: true }]);
});

test("a view cares about its own offer and its agent's other rows", async () => {
  const { concerns } = await import("../offer-sync.js");
  expect(concerns({ id: "o1", contactId: "c1" }, { offerIds: ["o1"], contactId: null })).toBe(true);
  expect(concerns({ id: "o5", contactId: "c1" }, { offerIds: ["o1"], contactId: "c1" })).toBe(true);
  expect(concerns({ id: "o5", contactId: "c2" }, { offerIds: ["o1"], contactId: "c1" })).toBe(false);
  expect(concerns({ focus: true }, { offerIds: [] })).toBe(true);
});
