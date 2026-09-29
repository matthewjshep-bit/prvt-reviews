// today-dismiss.js — rows you dismissed on Today stay off it until they change.
//
// Matt, 2026-09-28: a closing row (1415 2nd St, "closes in 2d · buyer found")
// had Mark closed / Open the deal / Fell through and nothing that meant "I've
// seen it, next". Every row is rebuilt from the book on each refresh, so a
// dismissal has to be remembered: by row id, with a fingerprint of what the
// row said. The row returns when it says something new — a different kind,
// severity, title or detail — but not when only a countdown ticks
// ("closes in 2d" → "in 1d"). Digits are dropped from the fingerprint for that.
//
// Pure. The broker keeps the doc on a job cursor; the page never sees it.

export const TODAY_DISMISS_CURSOR = "todayDismissed";
export const TODAY_DISMISS_KEEP_DAYS = 30;
const DAY_MS = 86400000;

// FNV-1a, so the doc holds a number, not the row's words (names, streets).
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

/** rowSignature(row) → a short fingerprint of what the row says, countdowns ignored. */
export function rowSignature(row = {}) {
  const words = [row.kind, row.severity, row.title, row.detail]
    .map((v) => String(v || "").toLowerCase().replace(/\d+/g, "").replace(/\s+/g, " ").trim())
    .join("|");
  return hash(words);
}

const rowsOf = (doc) => (doc && typeof doc.rows === "object" && doc.rows ? doc.rows : {});

function prune(rows, now) {
  const cutoff = now - TODAY_DISMISS_KEEP_DAYS * DAY_MS;
  return Object.fromEntries(Object.entries(rows).filter(([, v]) => Date.parse(v?.at) >= cutoff));
}

/** addDismissal(doc, row, now) → the new doc, with this row as it reads now. */
export function addDismissal(doc, row, now = Date.now()) {
  const id = String(row?.id || "").slice(0, 200);
  if (!id) return { rows: prune(rowsOf(doc), now) };
  const rows = prune(rowsOf(doc), now);
  rows[id] = { at: new Date(now).toISOString(), sig: rowSignature(row), kind: String(row.kind || "").slice(0, 40) };
  return { rows };
}

/** removeDismissal(doc, rowId) → the doc without it (Undo). */
export function removeDismissal(doc, rowId) {
  const rows = { ...rowsOf(doc) };
  delete rows[String(rowId || "")];
  return { rows };
}

/**
 * isDismissed(row, doc, now) → true while the row still says what it said when dismissed.
 *
 * `row.dismissedAs` is the title the row carried before the page learned the
 * contact's name ("An agent: Texts we never answered"), so a row dismissed
 * then stays dismissed once it reads "Sam Lee: Texts we never answered".
 */
export function isDismissed(row, doc, now = Date.now()) {
  const d = rowsOf(doc)[row?.id];
  if (!d) return false;
  if (!(Date.parse(d.at) >= now - TODAY_DISMISS_KEEP_DAYS * DAY_MS)) return false;
  if (d.sig === rowSignature(row)) return true;
  return Boolean(row?.dismissedAs) && d.sig === rowSignature({ ...row, title: row.dismissedAs });
}

/** applyDismissals(actions, doc, now) → { actions, hidden } — the rows still to show, and the ones kept off. */
export function applyDismissals(actions = [], doc = null, now = Date.now()) {
  const shown = [], hidden = [];
  for (const a of actions || []) (isDismissed(a, doc, now) ? hidden : shown).push(a);
  return { actions: shown, hidden };
}
