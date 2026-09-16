import test from "node:test";
import assert from "node:assert/strict";
import { restartVanishedUnderwrites, countyFromTags, VANISHED_MIN_AGE_MS } from "./auto-underwrite.js";

const NOW = Date.parse("2026-09-16T21:00:00Z");
const ago = (m) => new Date(NOW - m * 60000).toISOString();
const started = (over = {}) => ({ id: "d1", contactId: "c1", contactName: "Boots Swan", party: "agent", status: "sent", inbound: "This definitely has room for improvement",
  propertyAddress: "3925 Sw 317th St, Federal Way, WA 98023", createdAt: ago(60), actions: [{ type: "start_underwrite", status: "done", detail: "underwrite started" }], ...over });
const fakeStore = ({ drafts = [], offers = [], events = [] } = {}) => {
  const rows = [...events];
  return {
    events: rows,
    async listReplyDrafts(_l, { since }) { return drafts.filter((d) => d.createdAt >= since); },
    async listOffers() { return offers; },
    async appendContactEvents(_l, contactId, add) {
      let inserted = 0;
      for (const r of add) { if (rows.some((e) => e.contactId === contactId && e.dedupeKey === r.dedupeKey)) continue; rows.push({ ...r, contactId }); inserted++; }
      return { inserted, skipped: add.length - inserted };
    },
    async getContactProfile() { return null; }, async upsertContactProfile() { return {}; },
  };
};

test("a run that started and left nothing behind is started again from the draft, once", async () => {
  const store = fakeStore({ drafts: [started()] });
  const calls = [];
  const r = await restartVanishedUnderwrites({ store, locationId: "L", now: NOW, start: async (a) => { calls.push(a); return { job: { id: "u1" } }; } });
  assert.equal(r.restarted, 1);
  assert.deepEqual(calls, [{ contactId: "c1", message: "This definitely has room for improvement", address: "3925 Sw 317th St, Federal Way, WA 98023" }]);
  assert.ok(store.events.some((e) => e.type === "uw_restart" && e.dedupeKey === "uw_restart:d1"));
  const again = await restartVanishedUnderwrites({ store, locationId: "L", now: NOW + 900000, start: async () => { throw new Error("should not start"); } });
  assert.equal(again.restarted, 0);
});

test("a run that left a row — an offer, a held draft, a failed draft — is not started again; nor is a fresh one", async () => {
  const drafts = [started()];
  const start = async () => { throw new Error("should not start"); };
  const r1 = await restartVanishedUnderwrites({ store: fakeStore({ drafts, offers: [{ id: "o", contactId: "c1", address: "3925 SW 317th Street, Federal Way, WA", status: "draft", autoUnderwrite: { held: ["x"] } }] }), locationId: "L", now: NOW, start });
  assert.equal(r1.checked, 1); assert.equal(r1.restarted, 0);
  const r2 = await restartVanishedUnderwrites({ store: fakeStore({ drafts: [started({ createdAt: ago(5) })] }), locationId: "L", now: NOW, start });
  assert.equal(r2.checked, 0, "under twenty minutes it may still be running");
  const r3 = await restartVanishedUnderwrites({ store: fakeStore({ drafts: [started({ actions: [{ type: "start_underwrite", status: "skipped" }] })] }), locationId: "L", now: NOW, start });
  assert.equal(r3.checked, 0, "a skipped start never ran");
});

test("the outreach batch tag names the county", () => {
  assert.equal(countyFromTags(["tier-1", "agent-outreach-autopilot-king-wa"]), "King");
  assert.equal(countyFromTags(["agent-outreach-pierce-county-wa-aug-18"]), "Pierce");
  assert.equal(countyFromTags(["agent-list-1"]), "");
  assert.ok(VANISHED_MIN_AGE_MS > 0);
});
