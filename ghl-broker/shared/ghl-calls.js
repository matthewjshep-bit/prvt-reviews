// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// ghl-calls.js — Today's calls, dialed from GHL's Manual Actions.
//
// Matt, 2026-10-15: he dials from his computer in GHL's Manual Actions queue,
// not from Today. GHL's API can't create a Manual Action — only a workflow
// step can — so he builds one workflow ("App: call today") with a single
// Manual Action → Phone Call step whose instructions read two contact fields,
// {{contact.app_call_why}} and {{contact.app_call_say}}. The app fills those
// two fields and puts the contact in that workflow (ghl-broker/ghl-calls.js);
// GHL records the call, call-intake reads it, and the call row clears itself.
//
// Pure: the setting (saved.desk.ghlCalls, normalised through normalizeDesk in
// shared/call-list.js) and the words that go in the two fields. Which rows go
// to GHL, and which leave Today, is shared/desk.js.

/** workflowIdFrom(v) → a GHL workflow id from the id or a pasted workflow builder link, or "". */
export function workflowIdFrom(v) {
  const s = String(v || "").trim();
  const id = s.match(/workflow\/([A-Za-z0-9-]+)/)?.[1] || s;
  return /^[A-Za-z0-9-]{6,64}$/.test(id) ? id : "";
}

// Off until Matt has built the workflow and pasted its link. 8:30am Pacific
// the day's list goes in; until 5pm the urgent ones go in as they appear.
export const GHL_CALLS_DEFAULTS = Object.freeze({
  enabled: false,
  workflowId: "",
  hour: 8,
  minute: 30,
  until: "17:00",
  weekdaysOnly: true,
});

/** normalizeGhlCalls(v) → { enabled, workflowId, hour, minute, until, weekdaysOnly } */
export function normalizeGhlCalls(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  const d = GHL_CALLS_DEFAULTS;
  const n = (x, def, lo, hi) => { const k = Math.round(Number(x)); return x == null || x === "" || !Number.isFinite(k) ? def : Math.min(hi, Math.max(lo, k)); };
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(o.until ?? "").trim());
  const until = m && Number(m[1]) <= 23 && Number(m[2]) <= 59 ? `${m[1].padStart(2, "0")}:${m[2]}` : d.until;
  return {
    enabled: o.enabled === true,
    workflowId: workflowIdFrom(o.workflowId),
    hour: n(o.hour, d.hour, 0, 23),
    minute: n(o.minute, d.minute, 0, 59),
    until,
    weekdaysOnly: o.weekdaysOnly !== false,
  };
}

/** ghlCallsOn(cfg) → whether calls go to GHL: switched on, with a workflow to put them in. */
export const ghlCallsOn = (cfg) => Boolean(cfg?.enabled && cfg?.workflowId);

/**
 * ghlCallWindow(cfg) → { start, end } in Pacific hours (8.5 = 8:30am): the
 * morning list goes in at `start`, the urgent ones until `end`. An `until`
 * at or before the start leaves the morning three hours to happen in.
 */
export function ghlCallWindow(cfg = {}) {
  const c = normalizeGhlCalls(cfg);
  const start = c.hour + c.minute / 60;
  const [h, m] = c.until.split(":").map(Number);
  const end = h + m / 60;
  return { start, end: end > start ? end : Math.min(24, start + 3) };
}

/* ---------- the two fields ---------- */

// The contact fields the Manual Action's instructions read. GHL derives a
// field's key from its name, so these names give exactly these keys.
export const GHL_CALL_FIELDS = Object.freeze([
  { key: "app_call_why", name: "App call why", role: "why" },
  { key: "app_call_say", name: "App call say", role: "say" },
]);
export const CALL_FIELD_MAX = 300;

const clip = (s, n = CALL_FIELD_MAX) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const sentence = (s) => { const t = String(s || "").trim(); return t && !/[.!?…]$/.test(t) ? `${t}.` : t; };
const street = (a) => String(a || "").split(",")[0].trim();
const first = (name) => String(name || "").trim().split(/\s+/)[0] || "";

// A held reply about one of these is a call (shared/desk.js CALL_INTENTS).
const INTENT_WHY = {
  wants_call: (where) => `They asked for a call${where ? ` about ${where}` : ""}`,
  scheduling: (where) => `They want to set a time to talk${where ? ` about ${where}` : ""}`,
  wants_walkthrough: (where) => `They want to walk ${where || "the house"}`,
};

/**
 * callFields(row, { draft }) → { why, say }, each at most 300 characters
 *
 *   why  what the call is about and what it's for: the call brief's why and
 *        goal ("Countered 315K on 12 Elm St against our 300K — 5% apart, a
 *        call lands it. Land a number. …"), or the row's own title
 *   say  the opener (shared/call-list.js — a template, never the model)
 *
 * `draft` is the held reply behind a wants-a-call row, which carries no call
 * brief of its own.
 */
export function callFields(row = {}, { draft = null } = {}) {
  const call = row?.call || null;
  const where = street(row?.address || draft?.propertyAddress);
  const name = first(row?.contactName || draft?.contactName);
  if (row?.kind === "draft_waiting" && draft && INTENT_WHY[draft.intent]) {
    const why = `${INTENT_WHY[draft.intent](where)}. Their text is waiting in the app's outbox; call, then send or dismiss the reply.`;
    const say = `Hi${name ? ` ${name}` : ""}, it's Matt — you wanted to talk${where ? ` about ${where}` : ""}. Is now a good time?`;
    return { why: clip(why), say: clip(say) };
  }
  const lead = call?.why ? sentence(cap(String(call.why))) : sentence(String(row?.title || "").trim());
  const goal = call?.goal ? sentence(String(call.goal)) : "";
  const why = [lead, goal].filter(Boolean).join(" ");
  const say = call?.opener || `Hi${name ? ` ${name}` : ""}, it's Matt${where ? ` — calling about ${where}` : ""}.`;
  return { why: clip(why), say: clip(say) };
}

/* ---------- the ledger: who is in GHL's queue ---------- */

// On the contact's timeline. `ghl_call_queued` is the day's claim, written
// before anything goes to GHL (one per person per Pacific day); a GHL write
// that failed is `ghl_call_failed` and a call taken back out of the workflow
// is `ghl_call_withdrawn`, each keyed to the claim it ends. The timeline is
// append-only, as everywhere else (agent_pulse_voided is the same shape).
export const GHL_CALL_EVENT_TYPES = ["ghl_call_queued", "ghl_call_failed", "ghl_call_withdrawn"];
export const ghlCallClaimKey = (contactId, day) => `ghl_call:${contactId}:${day}`;

/**
 * liveGhlQueues(events) → Map contactId → { at, claimKey, kind, workflowId }
 *
 * Each person's newest claim, while it stands: not failed, not withdrawn. An
 * older claim the newer one replaced is gone (the runner takes the old one
 * out of the workflow before it puts the new one in).
 */
export function liveGhlQueues(events = []) {
  const ended = new Set((events || []).filter((e) => (e?.type === "ghl_call_failed" || e?.type === "ghl_call_withdrawn") && e.data?.claimKey).map((e) => e.data.claimKey));
  const newest = new Map();
  for (const e of events || []) {
    if (e?.type !== "ghl_call_queued" || !e.contactId) continue;
    const prev = newest.get(e.contactId);
    if (!prev || String(e.at || "") > String(prev.at || "")) newest.set(e.contactId, e);
  }
  const out = new Map();
  for (const [contactId, e] of newest) {
    const claimKey = e.dedupeKey || e.data?.claimKey || "";
    if (ended.has(claimKey)) continue;
    out.set(contactId, { at: e.at, claimKey, kind: String(e.data?.kind || ""), workflowId: String(e.data?.workflowId || "") });
  }
  return out;
}
