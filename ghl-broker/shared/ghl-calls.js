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
