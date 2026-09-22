// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// row-feedback.js — "what should the bot have done?" on any row of Today.
//
// Every row on Today is a place the bot stopped and a person had to act.
// Matt (2026-09-22) asked to say, on each one, what the bot should have done
// instead — a category and his own words — and to have that feed the nightly
// coach, which proposes lessons he applies with one tap. This is the shared
// vocabulary; the event lives in contact_events as `row_feedback`.
//
// It is separate from the draft chips ("What was wrong with it?",
// DRAFT_FEEDBACK in conversation-ai.js): those judge the words of one draft;
// this judges what the machine did with the row.

export const ROW_FEEDBACK = ["should_have_replied", "should_have_acted", "wrong_read", "right_to_hand_over"];
export const ROW_FEEDBACK_LABEL = {
  should_have_replied: "Should have replied itself",
  should_have_acted: "Should have taken an action",
  wrong_read: "Wrong read of the message",
  right_to_hand_over: "Right to hand it to me",
};
// One line under each chip, so the four read as distinct choices.
export const ROW_FEEDBACK_HINT = {
  should_have_replied: "It held or stayed out when it could have answered.",
  should_have_acted: "Send the offer, run the numbers, mark it, tag it, book it.",
  wrong_read: "It misread the message, the party, the address or the number.",
  right_to_hand_over: "Nothing to learn — this one needed a person.",
};
// The categories a lesson can be built on. "Right to hand it to me" is
// counter-evidence: the coach is shown it and may never cite it.
export const LEARNABLE_FEEDBACK = new Set(["should_have_replied", "should_have_acted", "wrong_read"]);

export const ROW_FEEDBACK_EVENT = "row_feedback";
// Rows with no contact (a blast row) are filed under this contact id so no
// profile is made up for them. Never a real GHL id.
export const ROW_FEEDBACK_SENTINEL_CONTACT = "_today";
// How far back Today looks for a row's feedback.
export const ROW_FEEDBACK_DAYS = 14;
export const ROW_FEEDBACK_NOTE_MAX = 300;

/** normalizeRowFeedback(v) → { category, note } | null. The category is required; a note alone is not feedback. */
export function normalizeRowFeedback(v) {
  if (!v || typeof v !== "object") return null;
  const raw = String(v.category || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!ROW_FEEDBACK.includes(raw)) return null;
  const note = String(v.note == null ? "" : v.note).replace(/\s+/g, " ").trim().slice(0, ROW_FEEDBACK_NOTE_MAX);
  return { category: raw, note };
}

/** The id a coach proposal cites for a piece of feedback: the event, not the row (a row can be taught twice). */
export const feedbackEvidenceId = (e) => `fb:${e?.id || ""}`;
export const rowFeedbackDedupeKey = (rowId, at) => `${ROW_FEEDBACK_EVENT}:${rowId}:${at}`;

/**
 * latestRowFeedback(events, { since, now }) → Map<rowId, event>
 *
 * Append-only: a second save on the same row is a newer event, and the
 * newest one is what every reader shows.
 */
export function latestRowFeedback(events = [], { since = null, now = Date.now() } = {}) {
  const from = since ? Date.parse(since) || 0 : 0;
  const out = new Map();
  for (const e of events || []) {
    if (e?.type !== ROW_FEEDBACK_EVENT || !e.data?.rowId) continue;
    const t = Date.parse(e.at) || 0;
    if (t < from || t > now) continue;
    const prev = out.get(e.data.rowId);
    if (!prev || (Date.parse(prev.at) || 0) < t) out.set(e.data.rowId, e);
  }
  return out;
}

/** What Today shows beside a row: the newest verdict, in the words the chips use. */
export const publicRowFeedback = (e) => (e ? {
  rowId: e.data.rowId, category: e.data.category, label: ROW_FEEDBACK_LABEL[e.data.category] || e.data.category,
  note: e.data.note || "", at: e.at, eventId: e.id,
} : null);
