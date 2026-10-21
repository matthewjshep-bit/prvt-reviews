// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// ghl-pings.js — the few things only Matt can do, told to him through GHL.
//
// Matt, 2026-10-20: no Today. Paperwork to sign, an agreed number to approve,
// a closing task, a buyer's agreed price, a partner's question only he can
// answer: each lives on its own page (Offers → Hot, Deals) and pings him
// once. GHL's API can't send Matt a notification, but a workflow step can
// ("Internal notification"), so he keeps one workflow ("App: needs Matt")
// and the app adds the contact to it, with the why in contact.app_ping_why
// and on a contact note.
//
// Pure: the setting (saved.desk.ghlPings, normalised through normalizeDesk in
// shared/call-list.js), the words, and the claim key. Which rows ping is
// shared/hand-off.js pingReasons; the runner is ghl-broker/ghl-pings.js.

import { workflowIdFrom } from "./ghl-calls.js";

// Off until Matt has built the workflow and pasted its link. Pings go out
// from `from` to `until`, Pacific, any day: a closing doesn't wait for Monday.
export const GHL_PINGS_DEFAULTS = Object.freeze({
  enabled: false,
  workflowId: "",
  from: 8,
  until: 20,
});

/** normalizeGhlPings(v) → { enabled, workflowId, from, until } */
export function normalizeGhlPings(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  const d = GHL_PINGS_DEFAULTS;
  const n = (x, def, lo, hi) => { const k = Math.round(Number(x)); return x == null || x === "" || !Number.isFinite(k) ? def : Math.min(hi, Math.max(lo, k)); };
  const from = n(o.from, d.from, 0, 23);
  const until = n(o.until, d.until, 1, 24);
  return { enabled: o.enabled === true, workflowId: workflowIdFrom(o.workflowId), from, until: until > from ? until : d.until };
}

/** ghlPingsOn(cfg) → whether pings go to GHL: switched on, with a workflow to put them in. */
export const ghlPingsOn = (cfg) => Boolean(cfg?.enabled && cfg?.workflowId);

export const GHL_PING_FIELD = Object.freeze({ key: "app_ping_why", name: "App ping why" });
export const GHL_PING_EVENT_TYPES = ["ghl_ping_sent", "ghl_ping_failed"];

// Where each one lives now that Today is gone.
const WHERE = {
  paper_to_sign: "Offers → Hot", approve_number: "Offers → Hot", handoff: "the contact's offer",
  investor_price_agreed: "Deals", pre_contract: "Deals", closing_soon: "Deals", closing_task_due: "Deals",
  showing_no_window: "Deals", deal_no_dataroom: "Deals", referral: "their contact record", email_check: "their contact record",
  promise_owed: "their thread in GHL",
};

const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** pingWhy(reason) → one line for the field and the note: what it is, and where to do it. */
export function pingWhy(r = {}) {
  const where = WHERE[r.kind] || "the app";
  return clip(`${r.title || String(r.kind || "").replace(/_/g, " ")} — in ${where}`, 300);
}

/**
 * pingClaimKey(reason) → one ping per thing. A reason id is stable per thing
 * (a deal's closing task row keeps its id as the task changes), so the title
 * rides on the key: the next task is a new ping, the same one never twice.
 */
export function pingClaimKey(r = {}) {
  const t = String(r.title || "");
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
  return `ghl_ping:${r.id || r.kind}:${h.toString(36)}`;
}

/** ghlPingNote(why) → the contact note beside the notification. */
export const ghlPingNote = (why = "") => ["App: needs you", String(why).trim()].filter(Boolean).join("\n");
