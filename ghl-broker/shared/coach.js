// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// coach.js — the nightly coach: what today's drafts say the bot should learn.
//
// The outbox already records every verdict a person gives a draft: sent as
// written, sent edited (and into what), dismissed, held, answered by hand.
// Until now nothing read them; the bot got better only when Matt noticed a
// bad reply and said so. This module turns a day of those verdicts into
// PROPOSALS — a new voice example, a house rule, a line of standing
// instruction, or a gap only code can close — that wait on Today for a
// person to Apply or Reject.
//
// Three promises, all enforced here rather than asked of the model:
//   - Nothing applies itself. applyProposal is called by a route a person pressed.
//   - Money is out of bounds. A proposal that names an amount, a fee, what we
//     may commit to, auto-send or the counter band is dropped (validateProposal).
//     Those stay hand-edited, behind the gates that already guard them.
//   - Revert removes exactly what Apply added, so an edit a person made in
//     between survives it.
//
// Pure: no I/O, no clock of its own. The runner is ghl-broker/coach.js.

import { PARTIES, INTENTS, OUTBOUND_INTENTS, DRAFT_FEEDBACK_LABEL, draftStats } from "./conversation-ai.js";
import { verdictsIn } from "./graduation.js";
import { PROMISE_DISMISS_LABEL } from "./promise-resolver.js";
import { ROW_FEEDBACK_EVENT, ROW_FEEDBACK_LABEL, LEARNABLE_FEEDBACK, feedbackEvidenceId } from "./row-feedback.js";
import { ACTION_KINDS } from "./pipeline.js";
import { AUDIT_KINDS } from "./conversation-audit.js";

export const COACH_KINDS = ["example", "rule", "instruction", "code_gap"];
export const COACH_KIND_LABEL = {
  example: "Voice example",
  rule: "House rule",
  instruction: "Standing instruction",
  code_gap: "Needs a code change",
};
export const COACH_STATUSES = ["open", "applied", "rejected", "reverted", "filed"];

// The prompt's own caps (normalizeConversationAi). A proposal that would
// push past one is refused rather than silently truncated on save.
export const CAPS = Object.freeze({ examples: 30, rules: 40, ruleChars: 300, exampleChars: 600, instructionChars: 4000 });
export const MAX_PROPOSALS_PER_NIGHT = 6;
export const REJECT_QUIET_DAYS = 30;
const SIGNAL_CAP = 25;          // rows of each kind the model is shown
const TEXT_CAP = 500;           // chars of any one message it is shown
export const WEAK_INTENT = Object.freeze({ minVerdicts: 5, belowPct: 70 });
export const SCORECARD = Object.freeze({ windowDays: 14, minVerdicts: 8, worseBy: 15 });

const clip = (v, n = TEXT_CAP) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);
const ms = (v) => Date.parse(v) || 0;

/* ---------- gather ---------- */

// A draft a gate or the world binned (the deal died, they unsubscribed, Matt
// got there first) is not a person's verdict on the words.
const BINNED_BY_THE_MACHINE = /not sent|stood aside/i;
const personDismissed = (d) => d.status === "dismissed" && !d.answeredBy
  && (d.dismissedBy === "you" || !(d.flags || []).some((f) => BINNED_BY_THE_MACHINE.test(f)));

const when = (d) => d.sentAt || d.dismissedAt || d.heldAt || d.updatedAt || d.createdAt;
// A Today row's kind in the words the page uses ("From last night: Texts we never answered").
const kindLabelOf = (rowKind, auditKind = "") => {
  const k = ACTION_KINDS.find((x) => x.key === rowKind);
  if (k) return k.label;
  if (rowKind === "audit_owed" || auditKind) {
    const a = AUDIT_KINDS.find((x) => x.key === auditKind);
    return a ? `From last night: ${a.label}` : "From last night";
  }
  if (rowKind === "draft" || rowKind === "draft_waiting") return "Drafts waiting on you";
  return String(rowKind || "a row on Today").replace(/_/g, " ");
};
const base = (d) => ({
  id: d.id, party: d.party || "agent", intent: d.intent || "other", kind: d.outbound?.kind || null,
  theySaid: clip(d.inbound), botWrote: clip(d.reply),
  why: d.feedback ? { code: d.feedback.code, label: DRAFT_FEEDBACK_LABEL[d.feedback.code] || d.feedback.code, note: clip(d.feedback.note, 300) } : null,
});

/**
 * gatherSignals({ drafts, audit, stats, errors, since, now }) → signals
 *
 * Everything a person or the audit said about the bot's work since `since`.
 * `stats` is draftStats over the graduation window; `audit` is the audit
 * cursor's doc.last; `errors` is store.listAppErrorsSince; `promiseEvents`
 * are `promise_kept` contact events (an "Owed a number" row dismissed on
 * Today carries why, and what the bot had said).
 */
export function gatherSignals({ drafts = [], audit = null, stats = null, errors = [], promiseEvents = [], since, now = Date.now() } = {}) {
  const from = ms(since) || now - 24 * 3600000;
  const recent = drafts.filter((d) => d && ms(when(d)) >= from && ms(when(d)) <= now);
  const newest = (a, b) => ms(when(b)) - ms(when(a));

  const edits = recent.filter((d) => d.status === "sent" && d.edited && !d.autoSent).sort(newest)
    .slice(0, SIGNAL_CAP).map((d) => ({ ...base(d), youSent: clip(d.sentText) }));
  const dismissals = recent.filter(personDismissed).sort(newest)
    .slice(0, SIGNAL_CAP).map((d) => ({ ...base(d), flags: (d.flags || []).slice(0, 6).map((f) => clip(f, 160)) }));
  const yours = recent.filter((d) => d.answeredBy === "you").sort(newest)
    .slice(0, SIGNAL_CAP).map(base);
  const held = recent.filter((d) => d.heldAt && ms(d.heldAt) >= from).sort(newest)
    .slice(0, SIGNAL_CAP).map(base);

  // "Owed a number" rows a person closed by hand, with why. "We didn't owe
  // anything" more than once is a promise the code keeps misreading.
  const promiseDismissals = (promiseEvents || [])
    .filter((e) => e?.type === "promise_kept" && e.data?.by === "dismissed" && e.data?.reason?.code && ms(e.at) >= from && ms(e.at) <= now)
    .sort((a, b) => ms(b.at) - ms(a.at)).slice(0, SIGNAL_CAP)
    .map((e) => ({ id: e.data.draftId || null, code: e.data.reason.code, label: PROMISE_DISMISS_LABEL[e.data.reason.code] || e.data.reason.code, note: clip(e.data.reason.note, 300), botWrote: clip(e.data.ourText) }));

  // "What should the bot have done?" said on a Today row (row-feedback.js):
  // the owner's direct verdict on what the machine did, the strongest signal
  // here. The row is shown by its kind, its detail and the message, never
  // its title (a name and a street). "Right to hand it to me" is shown
  // apart, with no id, so nothing can be built on it.
  const fbAll = (promiseEvents || [])
    .filter((e) => e?.type === ROW_FEEDBACK_EVENT && e.data?.category && ms(e.at) >= from && ms(e.at) <= now)
    .sort((a, b) => ms(b.at) - ms(a.at));
  const fbRow = (e) => ({
    rowKind: e.data.rowKind || "", kindLabel: kindLabelOf(e.data.rowKind, e.data.auditKind), category: e.data.category,
    label: ROW_FEEDBACK_LABEL[e.data.category] || e.data.category, note: clip(e.data.note, 300), detail: clip(e.data.detail, 200),
    party: e.data.party || null, intent: e.data.intent || null,
  });
  const rowFeedback = fbAll.filter((e) => LEARNABLE_FEEDBACK.has(e.data.category)).slice(0, SIGNAL_CAP)
    .map((e) => ({ id: feedbackEvidenceId(e), ...fbRow(e), draftId: e.data.draftId || null, theySaid: clip(e.data.theySaid), botWrote: clip(e.data.botWrote) }));
  const counterEvidence = fbAll.filter((e) => !LEARNABLE_FEEDBACK.has(e.data.category)).slice(0, SIGNAL_CAP).map(fbRow);

  // Why the gates stopped a draft, counted: one flag seen nine times is a
  // pattern; nine flags seen once are a Tuesday.
  const flagCounts = new Map();
  for (const d of recent) {
    if (d.autoSent || d.autoSendable) continue;
    for (const f of d.flags || []) {
      const k = clip(f, 120).replace(/\d[\d,]*/g, "#");
      const cur = flagCounts.get(k) || { flag: k, count: 0, draftIds: [] };
      cur.count++; if (cur.draftIds.length < 5) cur.draftIds.push(d.id);
      flagCounts.set(k, cur);
    }
  }
  const blocked = [...flagCounts.values()].filter((f) => f.count >= 2).sort((a, b) => b.count - a.count).slice(0, 12);

  const needsHuman = recent.filter((d) => d.needsHuman && d.humanReason).sort(newest)
    .slice(0, 12).map((d) => ({ id: d.id, party: d.party || "agent", intent: d.intent || "other", reason: clip(d.humanReason, 200) }));

  // Intents a person keeps rewriting, over the longer window.
  const weakIntents = [];
  for (const party of PARTIES) {
    for (const [intent, cell] of Object.entries(stats?.byParty?.[party]?.byIntent || {})) {
      const verdicts = verdictsIn(cell);
      if (verdicts < WEAK_INTENT.minVerdicts) continue;
      const pct = Math.round(((cell.humanSentUnedited || 0) / verdicts) * 100);
      if (pct < WEAK_INTENT.belowPct) weakIntents.push({ party, intent, verdicts, asWrittenPct: pct, edited: cell.sentEdited || 0, dismissed: cell.dismissed || 0 });
    }
  }
  weakIntents.sort((a, b) => a.asWrittenPct - b.asWrittenPct);

  const auditKinds = {};
  for (const f of audit?.findings || []) auditKinds[f.kind] = (auditKinds[f.kind] || 0) + 1;
  const auditErrors = (audit?.acted || []).filter((r) => r.status === "error").slice(0, 10)
    .map((r) => ({ kind: r.kind, action: r.action, reason: clip(r.reason, 200) }));

  const errs = (errors || []).slice(0, 15).map((e) => ({ fingerprint: e.fingerprint, area: e.area, message: clip(e.message, 300), count: e.count, context: e.context || {} }));

  const counts = { edits: edits.length, dismissals: dismissals.length, yours: yours.length, held: held.length, blocked: blocked.length, needsHuman: needsHuman.length, promiseDismissals: promiseDismissals.length, rowFeedback: rowFeedback.length, counterEvidence: counterEvidence.length, weakIntents: weakIntents.length, auditFindings: (audit?.findings || []).length, errors: errs.length };
  const knownIds = [...new Set([...edits, ...dismissals, ...yours, ...held, ...needsHuman, ...promiseDismissals.filter((r) => r.id), ...rowFeedback].map((r) => r.id)
    .concat(blocked.flatMap((b) => b.draftIds), rowFeedback.map((r) => r.draftId).filter(Boolean)))];
  // Something a person DID, or something that broke. A quiet day with only
  // audit findings is the audit's business, not a lesson.
  const empty = !(edits.length || dismissals.length || yours.length || held.length || promiseDismissals.length || rowFeedback.length || blocked.length || errs.length || auditErrors.length);
  return { since: new Date(from).toISOString(), until: new Date(now).toISOString(), edits, dismissals, yours, held, promiseDismissals, rowFeedback, counterEvidence, blocked, needsHuman, weakIntents, auditKinds, auditErrors, errors: errs, counts, knownIds, empty };
}

/* ---------- what the model is asked ---------- */

export const COACH_SYSTEM = `You are the coach for a text-message bot used by a small real-estate investment company. The bot drafts replies to listing agents and to investor buyers; the owner reviews them, and either sends them as written, edits them, dismisses them, or answers by hand. You are shown one day of those verdicts. Your job is to say what, if anything, the bot should learn from them.

You may propose four kinds of change:
- "example": one exchange that teaches the bot's voice. theySaid is the message that came in; weSay is what the OWNER actually sent (their edit), never the bot's draft and never words you wrote. Only propose one when the owner's edit shows a repeatable preference — shorter, plainer, a phrase they always cut — not a one-off fact.
- "rule": one short house rule the bot must never break, in the imperative, under 200 characters. Only when the same mistake appears more than once.
- "instruction": one or two sentences of standing guidance for one party (agent or investor), for judgement calls a rule is too blunt for.
- "code_gap": something no wording can fix — a bug, a gate that fires wrongly, a missing capability, a repeated runtime error. Give a title, the suspected area, and a one-sentence test that would fail today.

The data may include "promiseDismissals": times the app told the owner "we owe them a number" or "an answer" and the owner closed it by hand. botWrote is the text that was read as a promise. When the reason is "We didn't owe anything" more than once, the app is misreading what the bot says as a promise: that is a code_gap, citing those ids.

The data may include "rowFeedback": the owner saying directly, on a row of the app's to-do page, what the bot should have done. This is the strongest signal you have; one of these can be enough. Each carries an id starting "fb:" (cite it as evidence), the row's kind, the owner's note, and where there is one, the message (theySaid) and the bot's draft (botWrote). Read the category:
- "Should have replied itself": the bot held or stayed out when it could have answered. Propose an instruction or a rule for that situation. If it was held by a gate, an auto-send switch or a "person's call" rule, that is a code_gap — never a rule that tells the bot to skip a gate.
- "Should have taken an action": the bot should have sent the offer, run the numbers, marked a status, tagged, or booked. Propose a code_gap that names the action and the situation.
- "Wrong read of the message": it misread the intent, the party, the address or the number. Propose an example (when the owner's note says what the right reading was) or a rule.
"counterEvidence" lists rows the owner marked "Right to hand it to me": nothing to learn, and never build a lesson on them. If a rowFeedback note contradicts the current guidance, say so in "why" and propose the change.

Hard limits. Break one and the proposal is thrown away:
- Never mention a dollar amount, a percentage, a fee, earnest money, what the company may or may not commit to, auto-send, or the counter band. Those are set by hand.
- Never quote a phone number, an email address or a street address. Refer to people by first name at most.
- Every proposal must cite evidence: the ids of the drafts it came from, taken from the data you were given.
- Do not propose what the current rules, examples or instructions already say.

Be sparing. Most days deserve zero to two proposals. One edit is an anecdote; say nothing. If the owner's edits contradict each other, say nothing. An empty list is a good answer.`;

export const COACH_SCHEMA = {
  type: "object", additionalProperties: false, required: ["proposals", "summary"],
  properties: {
    summary: { type: "string", description: "One or two plain sentences: what today's verdicts showed. Shown to the owner." },
    proposals: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["kind", "why", "evidence"],
        properties: {
          kind: { type: "string", enum: COACH_KINDS },
          party: { type: "string", enum: [...PARTIES, "any"] },
          intent: { type: "string", description: "The intent this is mostly about, when there is one." },
          why: { type: "string", description: "One sentence the owner will read: what you saw that led to this." },
          evidence: { type: "array", items: { type: "string" }, description: "Draft ids, or fb: feedback ids, from the data." },
          theySaid: { type: "string" }, weSay: { type: "string" },
          text: { type: "string", description: "The rule or the instruction." },
          replaces: { type: "string", description: "The exact existing rule text, or example id, this supersedes. Omit if none." },
          title: { type: "string" }, suspectedArea: { type: "string" }, suggestedTest: { type: "string" },
        },
      },
    },
  },
};

/** buildCoachContext({ signals, config }) → the user block. The current guidance goes in so it isn't proposed again. */
export function buildCoachContext({ signals, config = {} } = {}) {
  const current = {
    rules: config.rules || [],
    examples: (config.examples || []).map((e) => ({ id: e.id, party: e.party, theySaid: clip(e.theySaid, 200), weSay: clip(e.weSay, 200) })),
    instructions: Object.fromEntries(PARTIES.map((p) => [p, clip(config.parties?.[p]?.instructions, 2000)])),
    // Answered by the owner from Today (the answer box). The coach never
    // writes these; it is shown them so it doesn't propose them again.
    answers: (config.answers || []).map((a) => ({ party: a.party, question: clip(a.question, 200), answer: clip(a.answer, 200) })),
  };
  const { knownIds: _k, empty: _e, ...shown } = signals || {};
  return `CURRENT GUIDANCE (do not repeat it):\n${JSON.stringify(current, null, 1)}\n\nTODAY'S VERDICTS:\n${JSON.stringify(shown, null, 1)}`;
}

/* ---------- validate ---------- */

const MONEY = /\$|\b\d{1,3}(,\d{3})+\b|\b\d{4,}\b|\b\d+(\.\d+)?\s?(k|m|mm|percent|pct)\b|%/i;
// …and nothing that would talk the bot around its own gates. A "Should have
// replied itself" note on a held reply must become a code_gap, not a rule
// that says "skip the review".
const HANDS_OFF = /\b(fees?|assign(ment|ing)?|wholesal\w*|earnest|emd|auto-?send\w*|counter[- ]?band|ceiling|may ?(not )?commit|commit to|margin|spread|never[_ -]?auto|guarded[_ -]?auto|gates?|bypass|without (a |the )?(review|approval))\b/i;
const PHONE = /\+?\d[\d\s().-]{8,}\d/;
const EMAIL = /[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}/i;
const STREET = /\b\d{1,6}\s+(?:[NSEW]{1,2}\.?\s+)?[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,3}\s+(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|way|blvd|boulevard|ct|court|pl|place|pkwy|parkway|hwy|highway|ter|terrace|cir|circle|loop|trl|trail)\b\.?/i;

/** A phone number, an email or a street address: never kept in standing guidance. */
export const hasContactDetails = (text) => { const t = String(text || ""); return PHONE.test(t) || EMAIL.test(t) || STREET.test(t); };

const norm = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The text a proposal would put in front of the bot (not the why, which only a person reads). */
export const proposalText = (p) => (p.kind === "example" ? `${p.theySaid || ""}\n${p.weSay || ""}` : p.kind === "code_gap" ? `${p.title || ""}\n${p.suggestedTest || ""}` : p.text || "");

export function proposalDedupeKey(p) {
  return `${p.kind}:${p.kind === "example" ? norm(p.weSay) : p.kind === "code_gap" ? norm(p.title) : norm(p.text)}`.slice(0, 200);
}

/**
 * validateProposal(raw, { config, knownIds }) → { ok, reason, proposal }
 *
 * The model is asked to stay inside the lines; this is what holds it there.
 */
export function validateProposal(raw, { config = {}, knownIds = [] } = {}) {
  const no = (reason) => ({ ok: false, reason, proposal: null });
  if (!raw || typeof raw !== "object" || !COACH_KINDS.includes(raw.kind)) return no("not a kind the coach may propose");
  const known = new Set(knownIds);
  const evidence = [...new Set((Array.isArray(raw.evidence) ? raw.evidence : []).map(String))].filter((id) => known.has(id)).slice(0, 12);
  const why = clip(raw.why, 300);
  if (!why) return no("no reason given");
  const party = [...PARTIES, "any"].includes(raw.party) ? raw.party : "any";
  const intents = new Set(PARTIES.flatMap((pp) => [...(INTENTS[pp] || []), ...(OUTBOUND_INTENTS[pp] || [])]));
  const p = { kind: raw.kind, party, intent: intents.has(raw.intent) ? raw.intent : null, why, evidence, replaces: clip(raw.replaces, CAPS.ruleChars) || null };

  if (raw.kind === "code_gap") {
    p.title = clip(raw.title, 120); p.suspectedArea = clip(raw.suspectedArea, 200); p.suggestedTest = clip(raw.suggestedTest, 300);
    if (!p.title) return no("a code gap needs a title");
    p.replaces = null;
  } else {
    // Guidance with no draft behind it is the model's opinion, not the owner's.
    if (!evidence.length) return no("cites no draft from today");
    if (raw.kind === "example") {
      p.theySaid = clip(raw.theySaid, CAPS.exampleChars); p.weSay = clip(raw.weSay, CAPS.exampleChars);
      if (!p.theySaid || !p.weSay) return no("an example needs both sides");
    } else {
      p.text = clip(raw.text, raw.kind === "rule" ? CAPS.ruleChars : 600);
      if (!p.text) return no("no text");
      if (raw.kind === "instruction" && !PARTIES.includes(party)) return no("an instruction is for one party");
    }
    const text = proposalText(p);
    if (MONEY.test(text)) return no("names an amount — money stays hand-edited");
    if (HANDS_OFF.test(text)) return no("touches fees, commitments or auto-send — those stay hand-edited");
  }
  const all = `${proposalText(p)}\n${p.why}\n${p.suspectedArea || ""}`;
  if (PHONE.test(all) || EMAIL.test(all) || STREET.test(all)) return no("carries a phone number, an email or a street address");

  // Already there, or no room.
  const rules = config.rules || [], examples = config.examples || [];
  if (p.kind === "rule") {
    if (rules.some((r) => norm(r) === norm(p.text))) return no("already a house rule");
    if (p.replaces && !rules.includes(p.replaces)) p.replaces = null;
    if (rules.length - (p.replaces ? 1 : 0) >= CAPS.rules) return no("the house rules are full");
  }
  if (p.kind === "example") {
    if (examples.some((e) => norm(e.weSay) === norm(p.weSay))) return no("already an example");
    if (p.replaces && !examples.some((e) => e.id === p.replaces)) p.replaces = null;
    if (examples.length - (p.replaces ? 1 : 0) >= CAPS.examples) return no("the examples are full");
  }
  if (p.kind === "instruction") {
    const cur = String(config.parties?.[party]?.instructions || "");
    if (norm(cur).includes(norm(p.text))) return no("already in the standing instructions");
    if (cur.length + p.text.length + 1 > CAPS.instructionChars) return no("the standing instructions are full");
    p.replaces = null;
  }
  p.dedupeKey = proposalDedupeKey(p);
  return { ok: true, reason: "", proposal: p };
}

/**
 * screenProposals(raws, { config, knownIds, existing, now }) → { kept, dropped: [{ reason, kind }] }
 *
 * Validate, drop what was already proposed (open, applied, filed) or turned
 * down inside the quiet period, dedupe within the batch, cap the night.
 */
export function screenProposals(raws = [], { config = {}, knownIds = [], existing = [], now = Date.now() } = {}) {
  const kept = [], dropped = [];
  const quietFrom = now - REJECT_QUIET_DAYS * 86400000;
  const seen = new Set();
  for (const e of existing) {
    if (!e?.dedupeKey) continue;
    const settledNo = e.status === "rejected" || e.status === "reverted";
    if (!settledNo || ms(e.updatedAt || e.createdAt) >= quietFrom) seen.add(e.dedupeKey);
  }
  for (const raw of Array.isArray(raws) ? raws : []) {
    const v = validateProposal(raw, { config, knownIds });
    if (!v.ok) { dropped.push({ kind: raw?.kind || "?", reason: v.reason }); continue; }
    if (seen.has(v.proposal.dedupeKey)) { dropped.push({ kind: v.proposal.kind, reason: "already proposed, or turned down this month" }); continue; }
    if (kept.length >= MAX_PROPOSALS_PER_NIGHT) { dropped.push({ kind: v.proposal.kind, reason: "over the nightly cap" }); continue; }
    seen.add(v.proposal.dedupeKey);
    kept.push(v.proposal);
  }
  return { kept, dropped };
}

/* ---------- apply / revert (on the conversationAi blob) ---------- */

export const exampleIdFor = (proposalId) => `coach-${String(proposalId).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`;

/**
 * applyProposal(config, proposal) → { config, undo }
 *
 * `undo` is what revertProposal needs: what was added, and what (if anything)
 * it pushed out and from where. The caller saves it on the proposal.
 */
export function applyProposal(config = {}, p) {
  const next = { ...config, rules: [...(config.rules || [])], examples: [...(config.examples || [])], parties: { ...(config.parties || {}) } };
  const undo = { kind: p.kind, removed: null };
  if (p.kind === "rule") {
    if (p.replaces) {
      const i = next.rules.indexOf(p.replaces);
      if (i >= 0) { undo.removed = { index: i, value: next.rules[i] }; next.rules.splice(i, 1); }
    }
    next.rules.push(p.text);
    undo.added = p.text;
  } else if (p.kind === "example") {
    if (p.replaces) {
      const i = next.examples.findIndex((e) => e.id === p.replaces);
      if (i >= 0) { undo.removed = { index: i, value: next.examples[i] }; next.examples.splice(i, 1); }
    }
    const id = exampleIdFor(p.id);
    next.examples.push({ id, party: p.party || "any", theySaid: p.theySaid, weSay: p.weSay });
    undo.added = id;
  } else if (p.kind === "instruction") {
    const cur = String(next.parties[p.party]?.instructions || "");
    next.parties[p.party] = { ...(next.parties[p.party] || {}), instructions: cur ? `${cur}\n${p.text}` : p.text };
    undo.added = p.text; undo.party = p.party;
  } else {
    throw Object.assign(new Error("a code gap is filed, not applied"), { http: 400 });
  }
  return { config: next, undo };
}

/** revertProposal(config, undo) → config. Takes back what Apply added; leaves every other edit alone. */
export function revertProposal(config = {}, undo = {}) {
  const next = { ...config, rules: [...(config.rules || [])], examples: [...(config.examples || [])], parties: { ...(config.parties || {}) } };
  if (undo.kind === "rule") {
    const i = next.rules.lastIndexOf(undo.added);
    if (i >= 0) next.rules.splice(i, 1);
    if (undo.removed && !next.rules.includes(undo.removed.value)) next.rules.splice(Math.min(undo.removed.index, next.rules.length), 0, undo.removed.value);
  } else if (undo.kind === "example") {
    next.examples = next.examples.filter((e) => e.id !== undo.added);
    if (undo.removed && !next.examples.some((e) => e.id === undo.removed.value.id)) next.examples.splice(Math.min(undo.removed.index, next.examples.length), 0, undo.removed.value);
  } else if (undo.kind === "instruction") {
    const cur = String(next.parties[undo.party]?.instructions || "");
    const lines = cur.split("\n");
    const i = lines.lastIndexOf(undo.added);
    if (i >= 0) lines.splice(i, 1);
    next.parties[undo.party] = { ...(next.parties[undo.party] || {}), instructions: lines.join("\n") };
  }
  return next;
}

/* ---------- did it help ---------- */

/**
 * coachScorecard({ proposal, drafts, now }) → { before, after, delta, verdict }
 *
 * The as-written rate for the proposal's party (and intent, when it has one)
 * over the two weeks before Apply and the time since, capped at two weeks.
 * It reports; it never reverts. "worse" is a reason to look, not a finding —
 * two weeks of one intent is a small sample and the deals changed too.
 */
export function coachScorecard({ proposal, drafts = [], now = Date.now(), rule = SCORECARD } = {}) {
  const at = ms(proposal?.appliedAt);
  if (!at) return null;
  const span = rule.windowDays * 86400000;
  const mine = (d) => (proposal.party === "any" || !proposal.party || d.party === proposal.party) && (!proposal.intent || d.intent === proposal.intent);
  const rate = (rows) => {
    const cell = draftStats(rows).totals;
    const verdicts = verdictsIn(cell);
    return { verdicts, asWritten: cell.humanSentUnedited || 0, pct: verdicts ? Math.round(((cell.humanSentUnedited || 0) / verdicts) * 100) : null };
  };
  const stamp = (d) => ms(d.sentAt || d.dismissedAt || d.updatedAt || d.createdAt);
  const before = rate(drafts.filter((d) => mine(d) && stamp(d) >= at - span && stamp(d) < at));
  const after = rate(drafts.filter((d) => mine(d) && stamp(d) >= at && stamp(d) <= Math.min(now, at + span)));
  const enough = before.verdicts >= rule.minVerdicts && after.verdicts >= rule.minVerdicts;
  const delta = enough ? after.pct - before.pct : null;
  const verdict = !enough ? "too_early" : delta <= -rule.worseBy ? "worse" : delta >= rule.worseBy ? "better" : "same";
  return { before, after, delta, verdict, scope: proposal.intent ? `${proposal.party} · ${proposal.intent}` : proposal.party || "any" };
}

/* ---------- handing a code gap to GitHub ---------- */

/**
 * scrubForIssue(text, { names }) → text
 *
 * An issue leaves the app. Phones, emails and street addresses are knocked
 * out; any full name we know is cut to its first name.
 */
export function scrubForIssue(text, { names = [] } = {}) {
  let out = String(text == null ? "" : text);
  out = out.replace(new RegExp(EMAIL.source, "gi"), "<email>").replace(new RegExp(PHONE.source, "g"), "<phone>").replace(new RegExp(STREET.source, "gi"), "<address>");
  for (const full of names) {
    const parts = String(full || "").trim().split(/\s+/);
    if (parts.length < 2 || parts[0].length < 2) continue;
    const rest = parts.slice(1).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    out = out.replace(new RegExp(`\\b(${parts[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\s+${rest}\\b`, "gi"), "$1");
  }
  return out;
}

/** issueFor(proposal, { names }) → { title, body, labels } for POST /repos/:owner/:repo/issues. */
export function issueFor(p, { names = [] } = {}) {
  const s = (v) => scrubForIssue(v, { names });
  const body = [
    `**What the coach saw:** ${s(p.why)}`,
    p.suspectedArea ? `**Suspected area:** ${s(p.suspectedArea)}` : "",
    p.suggestedTest ? `**A test that should fail today:** ${s(p.suggestedTest)}` : "",
    p.evidence?.length ? `**Evidence:** draft / feedback ids ${p.evidence.map((id) => `\`${id}\``).join(", ")} (read them in the app; thread text and notes are not copied here)` : "",
    "",
    "_Filed from the nightly coach. Rules for the fix are in CLAUDE.md and .claude/coach-agent.md._",
  ].filter((l) => l !== "").join("\n\n");
  return { title: s(p.title).slice(0, 120), body, labels: ["coach"] };
}
