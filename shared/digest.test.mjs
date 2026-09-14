import test from "node:test";
import assert from "node:assert/strict";
import { buildDigest, DIGEST_SECTIONS } from "./digest.js";

const NOW = Date.parse("2026-09-15T03:00:00Z");   // 8pm Pacific
const ago = (h) => new Date(NOW - h * 3600000).toISOString();
const section = (d, key) => d.sections.find((s) => s.key === key).items;

test("every section is present, in order, even on a quiet day", () => {
  const d = buildDigest({ now: NOW });
  assert.deepEqual(d.sections.map((s) => s.key), DIGEST_SECTIONS.map((s) => s.key));
  assert.ok(d.sections.every((s) => s.items.length === 0));
});

test("a day like 2026-09-14 reads as its loose ends", () => {
  const drafts = [
    { id: "h1", contactId: "heather", contactName: "Heather Vandyken", intent: "acceptance", status: "dismissed", createdAt: ago(7),
      inbound: "They agreed to accept 825,000 offer", propertyAddress: "36721 6th Ave SW, Federal Way, WA" },
    { id: "k1", contactId: "karen", contactName: "Karen Hake", intent: "counter", status: "draft", createdAt: ago(4),
      inbound: "(call, 3 min) best and final is coming", propertyAddress: "1210 N 33rd Pl, Renton, WA" },
    // answered later by a sent reply: not unanswered
    { id: "a1", contactId: "angie", contactName: "Angie Bomar", intent: "other", status: "draft", createdAt: ago(6), inbound: "Park manager 253-833-4661" },
    { id: "a2", contactId: "angie", contactName: "Angie Bomar", intent: "question", status: "sent", createdAt: ago(5), sentAt: ago(5), inbound: "", reply: "Got it" },
    // a thumbs up is not a loose end
    { id: "m1", contactId: "maureen", contactName: "Maureen Nolan", intent: "small_talk", status: "handled", createdAt: ago(3), inbound: "👍" },
    { id: "v1", contactId: "velia", contactName: "Velia Sierra", intent: "realm_check", status: "sent", createdAt: ago(5), sentAt: ago(5),
      outbound: { kind: "realm_check", amount: 600500, address: "4207 S Bateman St, Seattle, WA" }, propertyAddress: "4207 S Bateman St, Seattle, WA" },
    { id: "old", contactId: "x", intent: "acceptance", status: "draft", createdAt: ago(40), inbound: "yes" },
  ];
  const offers = [
    { id: "o1", contactId: "erin", contactName: "Erin Twedt", address: "521 Avenue C, Snohomish, WA", cashAmount: 571061, status: "countered",
      statusHistory: [{ status: "countered", ts: ago(8), amount: 615000 }] },
    { id: "o2", contactId: "lisa", contactName: "Lisa Dreyer", address: "10511 Moller Dr, Gig Harbor, WA", cashAmount: 571621, status: "countered",
      statusHistory: [{ status: "countered", ts: ago(9), amount: 675000 }] },
    { id: "o3", contactId: "shawn", contactName: "Shawn Filer", address: "83 Olympic Dr NW, Shoreline, WA", status: "draft",
      autoUnderwrite: { passed: false, finishedAt: ago(6), held: ["only 0 priced comps — the price proxy needs 6"] } },
  ];
  const events = [
    { type: "promise_owed", contactId: "emily", at: ago(2), address: "2903 E Union St, Seattle, WA", data: { what: "answer" } },
    { type: "promise_owed", contactId: "foster", at: ago(3), address: "44207 Pine Rd, Gold Bar, WA", data: { what: "number" } },
    { type: "promise_kept", contactId: "foster", at: ago(1) },
  ];
  const d = buildDigest({ drafts, events, offers, now: NOW });

  assert.deepEqual(section(d, "accepted").map((i) => i.contactName), ["Heather Vandyken"], "the 40-hour-old one is outside the window");
  assert.deepEqual(section(d, "close_counters").map((i) => i.contactName), ["Erin Twedt"], "Lisa's 675 is 18% over — not close");
  assert.match(section(d, "close_counters")[0].detail, /their 615k vs our 571k \(8% apart\)/);
  assert.deepEqual(section(d, "owed").map((i) => i.contactId), ["emily"], "Foster's was kept");
  assert.deepEqual(section(d, "unanswered").map((i) => i.contactName).sort(), ["Heather Vandyken", "Karen Hake"],
    "Angie got a reply after; Maureen's thumbs up isn't a loose end");
  assert.deepEqual(section(d, "held").map((i) => i.contactName), ["Shawn Filer"]);
  assert.match(section(d, "held")[0].detail, /only 0 priced comps/);
  assert.deepEqual(section(d, "floated").map((i) => i.detail), ["realm check · 601k"]);
  assert.equal(d.counts.accepted, 1);
});
