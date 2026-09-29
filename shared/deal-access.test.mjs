import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAccess, accessFor, mergeAccess, accessLines, accessSummary } from "./deal-access.js";

test("nothing recorded tells the bot to say it will confirm access, and never that the house is open", () => {
  const lines = accessLines(null).join(" ");
  assert.match(lines, /occupancy: not recorded\. Never say the house is vacant, empty, or open/);
  assert.match(lines, /say you'll confirm access with the agent/);
});

test("a lived-in house means no drive-bys and a set time; the private note never reaches the bot", () => {
  const lines = accessLines({ occupancy: "tenant_occupied", method: "appointment", noticeHours: 24, note: "lockbox 4471, tenant Maria" }).join(" ");
  assert.match(lines, /a tenant lives there/);
  assert.match(lines, /Never suggest they drive by, knock/);
  assert.match(lines, /by appointment only with 24 hours' notice/);
  assert.doesNotMatch(lines, /4471|Maria/);
  assert.match(accessLines({ method: "lockbox" }).join(" "), /never give or promise a code yourself/);
});

test("an older deal's walkthrough access pick carries over, and an edit only changes what it sends", () => {
  assert.equal(accessFor({ showing: { access: { mode: "lockbox" } } }).method, "lockbox");
  assert.equal(accessFor({ access: { method: "agent" }, showing: { access: { mode: "lockbox" } } }).method, "agent");
  const a = mergeAccess({ occupancy: "vacant", method: "lockbox" }, { noticeHours: 2 });
  assert.deepEqual([a.occupancy, a.method, a.noticeHours], ["vacant", "lockbox", 2]);
  assert.equal(normalizeAccess({ occupancy: "haunted", noticeHours: 999 }).occupancy, "");
  assert.equal(normalizeAccess({ noticeHours: 999 }).noticeHours, 168);
  assert.equal(accessSummary({ occupancy: "tenant_occupied", method: "appointment", noticeHours: 24 }), "Tenant-occupied · by appointment only (24h notice)");
});
