// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// tier-one.js — Tier 1 is agents with a live house that needs work, right now
// (Matt, 2026-10-07). GHL's Acquisitions "Tier 1" stage is the list he works;
// these are the rules that keep the bot from putting the wrong houses on it.
//
// Pure. The broker's reply agent reads `passedOnHouse` before it runs the
// tier-1 rule; the actions it strips are the ones `isTierOneAction` names.

import { addressKey, sameStreetLoose } from "./us-address.js";

// A pass or a kick-out from the Tier 1 list, written as a contact event with
// the house's address — so a house we never priced still counts as passed.
export const TIER_ONE_OUT_EVENTS = ["tier1_passed", "tier1_kicked"];
// Statuses that mean we're done with the house: we said no, or it's gone.
const PASSED_STATUSES = new Set(["we_passed", "unavailable"]);

const when = (x) => Date.parse(x?.updatedAt || x?.statusAt || x?.createdAt || x?.at || "") || 0;

// Did we pass on this house? The newest offer row on it says we_passed or
// unavailable, or it was passed or kicked off the Tier 1 list (and not added
// back since). Returns { why, at } or null.
export function passedOnHouse({ offers = [], events = [], address = "" } = {}) {
  const key = addressKey(address);
  if (!key) return null;
  // The same house with or without its city: "4430 Sunnyside Blvd" in a text
  // is the offer at "4430 Sunnyside Blvd, Marysville, WA 98270".
  const same = (a) => addressKey(a) === key || sameStreetLoose(a, address);
  const rows = offers.filter((o) => o?.address && o.status !== "draft" && same(o.address))
    .sort((a, b) => when(b) - when(a));
  if (rows[0] && PASSED_STATUSES.has(rows[0].status)) {
    return { why: rows[0].status === "unavailable" ? "no longer available" : "we passed on this house", at: when(rows[0]) };
  }
  const mine = events.filter((e) => e?.address && same(e.address));
  const out = mine.filter((e) => TIER_ONE_OUT_EVENTS.includes(e.type)).sort((a, b) => when(b) - when(a))[0];
  if (!out) return null;
  const back = mine.some((e) => e.type === "tier1_added" && when(e) > when(out));
  return back ? null : { why: "we passed on this house", at: when(out) };
}

// The actions the tier-1 rule plans: the tag, the TIER 1 workflow, and the
// lower tiers it leaves. Skipping the rule means skipping all of them, so a
// passed house leaves the agent where they were.
export function isTierOneAction(a = {}) {
  const tags = (a.tags || []).map((t) => String(t).toLowerCase());
  const wf = String(a.workflowName || "");
  if (a.type === "add_tags") return tags.includes("tier-1");
  if (a.type === "remove_tags") return tags.length > 0 && tags.every((t) => t === "tier-2" || t === "tier-3");
  if (a.type === "add_to_workflow") return /tier\s*1\b/i.test(wf);
  if (a.type === "remove_from_workflow") return /tier\s*[23]\b/i.test(wf);
  return false;
}
