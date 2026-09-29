// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// deal-access.js — what the house is like to get into.
//
// Rajesh Kasturi, 2026-09-29, 3511 NE 153rd St: the bot texted a buyer "it's
// open right now". It meant the deal was available; he read that the house
// was open. Nobody had said so, and we can never say it (Matt). So a deal
// records whether anyone lives there and how buyers get in, and the investor
// bot is told exactly that and nothing more. The reply gates hold a text that
// claims more (reply-agent.js claimsAccess).
//
// Stored at `offer.deal.access`. Deals from before this read the walkthrough's
// old access pick (`deal.showing.access.mode`) as the method.

export const OCCUPANCY = ["", "vacant", "owner_occupied", "tenant_occupied"];
export const OCCUPANCY_LABEL = { "": "Not recorded", vacant: "Vacant", owner_occupied: "Seller lives there", tenant_occupied: "Tenant-occupied" };

export const ACCESS_METHODS = ["", "lockbox", "agent", "appointment", "matt", "none"];
export const ACCESS_METHOD_LABEL = {
  "": "Not recorded",
  lockbox: "Lockbox",
  agent: "Listing agent lets them in",
  appointment: "By appointment only",
  matt: "Matt meets them there",
  none: "No interior access before closing",
};

const str = (v, max) => String(v ?? "").trim().slice(0, max);

/** normalizeAccess(raw) → { occupancy, method, noticeHours, note }. */
export function normalizeAccess(raw) {
  const a = raw && typeof raw === "object" ? raw : {};
  const hours = Math.round(Number(a.noticeHours) || 0);
  return {
    occupancy: OCCUPANCY.includes(a.occupancy) ? a.occupancy : "",
    method: ACCESS_METHODS.includes(a.method) ? a.method : "",
    noticeHours: Math.max(0, Math.min(168, hours)),
    // Yours: a lockbox code, a tenant's name, the agent's showing service.
    // Never put in front of the bot.
    note: str(a.note, 300),
  };
}

/** accessFor(deal) → the deal's access, falling back to the walkthrough's old pick. */
export function accessFor(deal = {}) {
  const own = normalizeAccess(deal?.access);
  if (!own.method) {
    const old = deal?.showing?.access?.mode;
    if (old === "lockbox" || old === "agent" || old === "matt") own.method = old;
  }
  return own;
}

/** mergeAccess(current, edit) → access. Only the fields sent change. */
export function mergeAccess(current, edit = {}) {
  const cur = normalizeAccess(current);
  const e = edit && typeof edit === "object" ? edit : {};
  return normalizeAccess({ ...cur, ...Object.fromEntries(["occupancy", "method", "noticeHours", "note"].filter((k) => k in e).map((k) => [k, e[k]])) });
}

/**
 * accessLines(access) → what the investor prompt is told about getting in.
 *
 * Written as instructions the bot follows, not facts it recites. Never the
 * note — that's where a lockbox code or a tenant's name would be.
 */
export function accessLines(access) {
  const a = normalizeAccess(access);
  const out = [];
  if (a.occupancy === "vacant") out.push("occupancy: vacant");
  else if (a.occupancy === "owner_occupied") out.push("occupancy: the seller lives there. Never suggest they drive by, knock, or look in the windows; they see it only at a set walkthrough time");
  else if (a.occupancy === "tenant_occupied") out.push("occupancy: a tenant lives there. Never suggest they drive by, knock, or disturb the tenant; they see it only at a set walkthrough time");
  else out.push("occupancy: not recorded. Never say the house is vacant, empty, or open");
  const notice = a.noticeHours ? ` with ${a.noticeHours} hours' notice` : "";
  if (a.method === "lockbox") out.push(`access: lockbox${notice}. Matt sends access details once their time is confirmed; never give or promise a code yourself`);
  else if (a.method === "agent") out.push(`access: the listing agent lets buyers in at a set time${notice}`);
  else if (a.method === "appointment") out.push(`access: by appointment only${notice}; say you'll set a time with the agent`);
  else if (a.method === "matt") out.push(`access: Matt meets buyers at the house at a set time${notice}`);
  else if (a.method === "none") out.push("access: no interior access before closing; offer the photos, the numbers and a drive-by of the outside only if the house is vacant");
  else out.push("access: not recorded. If they ask how to see it, say you'll confirm access with the agent and get back to them");
  return out;
}

/** accessSummary(access) → "Tenant-occupied · by appointment (24h)" for chips and Today. */
export function accessSummary(access) {
  const a = normalizeAccess(access);
  if (!a.occupancy && !a.method) return "";
  const m = a.method ? ACCESS_METHOD_LABEL[a.method].toLowerCase() : "access not set";
  return `${a.occupancy ? OCCUPANCY_LABEL[a.occupancy] : "Occupancy not set"} · ${m}${a.noticeHours ? ` (${a.noticeHours}h notice)` : ""}`;
}
