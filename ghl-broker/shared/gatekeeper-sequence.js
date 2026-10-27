// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// gatekeeper-sequence.js — what goes to a gatekeeper, and when (Matt,
// 2026-10-26): an email first, a short text a day later that points at it,
// a call for Matt a day after that, and a check-in every month — but only
// with a new reason. Every word is about this person: their estate and its
// house, or the closing we did together. Matt: "make it as specific as
// possible and make it not sound like a bot at all."
//
// Once they answer — a text, an email, a call — the machine is done with
// them. A gatekeeper is a relationship Matt runs himself; the reply agent
// holds every reply from one (reply-agent.js), and the clock here stops.
//
// Pure: the step that's due, the words the model is asked for, and what
// would give a draft away as a machine's.

import { carrierFlags } from "./carrier-words.js";
import { hookLine } from "./gatekeeper.js";

export const GATEKEEPER_OUT_KINDS = ["gatekeeper_email", "gatekeeper_text", "gatekeeper_checkin"];
export const GATEKEEPER_EVENTS = { queued: "gatekeeper_queued", sent: "gatekeeper_sent", replied: "gatekeeper_replied" };
// Anything that means they're talking to us, or Matt's talking to them, or
// they don't want to hear from us: the machine stops.
export const STOP_TYPES = ["gatekeeper_replied", "email_received", "call_summary", "call_booked", "hand_reply", "unsubscribed", "drive_stopped"];
export const SEQUENCE_EVENT_TYPES = ["import", GATEKEEPER_EVENTS.queued, GATEKEEPER_EVENTS.sent, ...STOP_TYPES];
// A text sent before this many hours after the email was claimed would land
// before the email is read: the floor on textAfterDays: 0.
const MIN_TEXT_GAP_MS = 4 * 3600000;
const DAY_MS = 86400000;
export const TEXT_MAX = 160;
export const EMAIL_MAX_WORDS = 130;

const at = (e) => Date.parse(e?.at || "") || 0;
const street = (a) => String(a || "").split(",")[0].trim();

/**
 * nextStep({ events, gk, hooks, settings, hasEmail, hasPhone, now }) →
 *   { step: "email" | "text" | "checkin", hook, why } | { step: null, why } | { stop: why }
 *
 * `events` are the contact's timeline (any order). `hooks` are theirs from
 * gatekeeper_hooks, flattened ({ hookKey, kind, firstSeen, … }). The call
 * isn't a step here: it's a row for Matt (callDue).
 */
export function nextStep({ events = [], hooks = [], settings, hasEmail = true, hasPhone = true, now = Date.now() }) {
  const g = settings;
  const evs = [...events].sort((a, b) => at(a) - at(b));
  const imported = evs.find((e) => e.type === "import");
  if (!imported) return { step: null, why: "not imported yet" };
  const stop = evs.find((e) => STOP_TYPES.includes(e.type) && at(e) >= at(imported));
  if (stop) return { stop: stop.type === "unsubscribed" ? "they opted out" : stop.type === "drive_stopped" ? "you stopped the bot on them" : "they're talking to us — yours from here" };

  const queued = (step) => evs.filter((e) => e.type === GATEKEEPER_EVENTS.queued && e.data?.step === step);
  const sent = (step) => evs.filter((e) => e.type === GATEKEEPER_EVENTS.sent && e.data?.step === step);
  const best = newestHook(hooks);

  if (!queued("email").length) {
    if (!hasEmail) return hasPhone && !queued("text").length ? { step: "text", hook: best, why: "no email on file — the text goes alone" } : { step: null, why: "no email or phone" };
    return { step: "email", hook: best, why: "first touch" };
  }
  const emailSent = sent("email")[0];
  if (!queued("text").length && hasPhone) {
    if (!emailSent) return { step: null, why: "the email hasn't gone yet" };
    const due = at(emailSent) + Math.max(g.textAfterDays * DAY_MS, MIN_TEXT_GAP_MS);
    if (now < due) return { step: null, why: `the text follows the email on ${new Date(due).toISOString().slice(0, 10)}` };
    return { step: "text", hook: best, why: "follows the email" };
  }

  // The check-in: a month since the last thing that went, and something new
  // to say — an estate or a closing we hadn't written about.
  const lastSent = evs.filter((e) => e.type === GATEKEEPER_EVENTS.sent).pop();
  if (!lastSent) return { step: null, why: "waiting on the first touch to go" };
  const dueAt = at(lastSent) + g.checkInEveryDays * DAY_MS;
  if (now < dueAt) return { step: null, why: `next check-in no sooner than ${new Date(dueAt).toISOString().slice(0, 10)}` };
  const told = new Set(evs.filter((e) => e.type === GATEKEEPER_EVENTS.queued).map((e) => e.data?.hookKey).filter(Boolean));
  const fresh = newestHook(hooks.filter((h) => !told.has(h.hookKey) && (Date.parse(h.firstSeen || "") || 0) > at(lastSent)));
  if (!fresh) return { step: null, why: "nothing new to say — no check-in without a reason" };
  if (!hasEmail) return { step: null, why: "no email for a check-in" };
  return { step: "checkin", hook: fresh, why: "a new reason to write" };
}

/** callDue({ events, settings, now }) → the email went callAfterDays ago, nothing back. */
export function callDue({ events = [], settings, now = Date.now() }) {
  const r = nextStep({ events, settings, now, hooks: [] });
  if (r.stop) return false;
  const emailSent = events.filter((e) => e.type === GATEKEEPER_EVENTS.sent && e.data?.step === "email").sort((a, b) => at(a) - at(b))[0];
  return Boolean(emailSent) && now >= at(emailSent) + settings.callAfterDays * DAY_MS;
}

function newestHook(hooks = []) {
  const day = (h) => h?.firstPublished || h?.closedAt || String(h?.firstSeen || "").slice(0, 10);
  const sorted = [...hooks].sort((a, b) => String(day(b)).localeCompare(String(day(a))));
  return sorted.find((h) => h.house?.address || h.address) || sorted[0] || null;
}

/** The facts the model may use — and the only ones. */
export function factsFor({ gk = {}, hook = null, step, priorHook = null }) {
  const facts = [];
  const first = gk.firstName || String(gk.name || "").split(" ")[0] || "";
  facts.push(`Their name: ${gk.name || "unknown"}${first ? ` (call them ${first})` : ""}`);
  if (gk.firm) facts.push(`Their firm: ${gk.firm}`);
  facts.push(`What they are: ${gk.kind === "probate_attorney" ? "the attorney for an estate's personal representative" : gk.kind === "escrow" ? "an escrow officer" : "a title officer / title rep"}`);
  if (hook?.kind === "estate") {
    facts.push(`The estate: the Estate of ${hook.decedent || "(name unknown)"}${hook.county ? `, ${hook.county} County` : ""}`);
    if (hook.house?.address) facts.push(`The estate's house: ${street(hook.house.address)}${hook.house.address.split(",")[1] ? ` in ${hook.house.address.split(",")[1].trim()}` : ""}`);
    else facts.push("We don't know which house the estate owns — don't name one; ask whether there's a house to sell.");
  } else if (hook?.kind === "closing") {
    facts.push(`We closed ${street(hook.address) || "a deal"} together${hook.closedAt ? ` (closed ${hook.closedAt})` : ""}.`);
  } else if (gk.kind !== "probate_attorney") {
    facts.push("We haven't closed anything together yet.");
  }
  if (step === "checkin" && priorHook) facts.push(`What we wrote about before: ${hookLine(priorHook)}`);
  return facts;
}

const VOICE_RULES = [
  "Write as Matt himself: a local guy who buys and fixes up houses, writing one person he'd like to know. Plain, warm, short sentences. Contractions.",
  "Use only the facts below. Never guess the house's condition, value, or the family's situation. Never say how you found the estate.",
  "No filler: never \"I hope this finds you well\", \"I wanted to reach out\", \"I came across\", \"touch base\", \"circle back\", \"rest assured\", \"don't hesitate\", \"I'd love to\", \"at your earliest convenience\". No em dashes. No exclamation marks. No bullet points.",
  "Never mention a referral fee, a finder's fee, or paying them for anything — they can't take it and asking insults them.",
  "Never say cash, as-is, investor, wholesale, \"we buy houses\", \"quick close\" or \"any condition\".",
];

const STEP_RULES = {
  probate_attorney: {
    email: [
      "An email to the attorney about this one estate. Subject: the estate's name and the street if we have it, nothing else (e.g. \"Estate of Jane Doe, 123 Elm St\").",
      "Say in one line who Matt is. Then the one useful thing: if the personal representative is deciding what to do with the house, Matt can put a written number in front of them this week, the house exactly how it sits, no clean-out, closing whenever the estate is ready. Make it clear they can list it too and keep his number as their floor.",
      "End with one easy question about this estate (e.g. whether the house is being sold, or whether a number would help the PR). Then a short sign-off: Matt, his full name and company on the next line, phone on the next.",
      `Under ${EMAIL_MAX_WORDS} words in the body.`,
    ],
    text: [
      `A text, under ${TEXT_MAX} characters: who it is, that you emailed them about this estate (the street if we have it), and one short question asking for a quick call. No sign-off, no link.`,
    ],
    checkin: [
      "A short email a month or more after the last one, about the new estate in the facts — that is the reason for writing. Mention the earlier note in a few words at most. Same offer, said differently and shorter. One question.",
      `Under ${Math.round(EMAIL_MAX_WORDS * 0.7)} words in the body. Short sign-off as before.`,
    ],
  },
  title: {
    email: [
      "An email to a title/escrow person. If we closed a deal together, open with that one closing by its street. Otherwise say plainly who Matt is and that he closes a few houses a month around here.",
      "Two asks, said simply: he'd like to run more of his closings through them; and when a sale falls out of escrow and the seller still has to move, he can close on the house as it sits in a few weeks, so he's a good name to have.",
      "End with one easy question. Short sign-off: Matt, full name and company on the next line, phone on the next.",
      `Under ${EMAIL_MAX_WORDS} words in the body. Subject: short and specific (the street of our closing if there is one).`,
    ],
    text: [
      `A text, under ${TEXT_MAX} characters: who it is, that you just emailed them, and one short question asking for a quick call. No sign-off, no link.`,
    ],
    checkin: [
      "A short email a month or more later, about the new closing in the facts. Thank them for it in a few words, and say you'll keep sending them work. One question.",
      `Under ${Math.round(EMAIL_MAX_WORDS * 0.7)} words. Short sign-off.`,
    ],
  },
};

/**
 * gatekeeperPrompt({ step, gk, hook, priorHook, signer, company, phone, examples }) → { system, user, channel }
 */
export function gatekeeperPrompt({ step, gk = {}, hook = null, priorHook = null, signer = "Matt Shepherd", company = "", phone = "", examples = [] }) {
  const rules = (STEP_RULES[gk.kind === "probate_attorney" ? "probate_attorney" : "title"] || STEP_RULES.title)[step] || [];
  const channel = step === "text" ? "sms" : "email";
  const voice = examples.filter(Boolean).slice(0, 5);
  const system = [
    "You write one message from Matt to one person. It must read like Matt typed it himself for this person alone.",
    ...VOICE_RULES,
    ...rules,
    ...(voice.length ? ["How Matt writes (match the voice, never copy the words):", ...voice.map((v, i) => `Example ${i + 1}:\n${v}`)] : []),
    channel === "sms"
      ? "Reply with JSON: {\"body\": the text}."
      : "Reply with JSON: {\"subject\": the subject line, \"body\": the email body with blank lines between paragraphs}.",
  ].join("\n\n");
  const user = [
    "FACTS (use only these):",
    ...factsFor({ gk, hook, step, priorHook }).map((f) => `- ${f}`),
    `- Matt's sign-off: ${[signer, company].filter(Boolean).join(", ")}${phone ? `, ${phone}` : ""}`,
  ].join("\n");
  return { system, user, channel };
}

export const DRAFT_SCHEMA = {
  type: "object",
  properties: { subject: { type: "string" }, body: { type: "string" } },
  required: ["body"],
  additionalProperties: false,
};

const MACHINE_TELLS = [
  ["hope this finds you", /\bhope (?:this|you)\b.{0,20}\bwell\b/i],
  ["reach out", /\b(?:wanted|want) to reach out\b|\breaching out\b/i],
  ["came across", /\bcame across\b/i],
  ["touch base", /\btouch base\b/i],
  ["circle back", /\bcircle back\b/i],
  ["don't hesitate", /\bdon'?t hesitate\b/i],
  ["rest assured", /\brest assured\b/i],
  ["earliest convenience", /\bearliest convenience\b/i],
  ["em dash", /—/],
  ["exclamation", /!/],
  ["referral fee", /\b(?:referral|finder'?s)\s+fee\b|\bcompensate you\b|\bpay you\b/i],
  ["a placeholder", /\[[A-Z][^\]]*\]|\{[a-z_]+\}/],
  ["public records", /\bpublic records?\b|\bnotice to creditors\b|\bcourt filings?\b/i],
];

/**
 * draftFlags({ step, subject, body, gk, hook }) → [what gives it away]
 *
 * A draft with any of these is written again once with them named; one
 * that still has them waits for Matt with the flags on it.
 */
export function draftFlags({ step, subject = "", body = "", gk = {}, hook = null }) {
  const text = `${subject}\n${body}`;
  const flags = MACHINE_TELLS.filter(([, rx]) => rx.test(text)).map(([w]) => w);
  for (const w of carrierFlags(body)) flags.push(w);
  if (step === "text") {
    if (body.length > TEXT_MAX) flags.push(`over ${TEXT_MAX} characters`);
  } else {
    const words = body.trim().split(/\s+/).filter(Boolean).length;
    if (words > EMAIL_MAX_WORDS + 20) flags.push(`${words} words — too long`);
    if (!subject.trim()) flags.push("no subject");
  }
  // Specific or it doesn't go: the estate, the street or the closing must be in it.
  const anchors = [hook?.decedent ? hook.decedent.split(" ").pop() : "", street(hook?.house?.address), street(hook?.address)].filter(Boolean);
  if (anchors.length && !anchors.some((a) => text.toLowerCase().includes(a.toLowerCase()))) flags.push("doesn't name their estate or our closing");
  const first = gk.firstName || "";
  if (first && step !== "text" && !new RegExp(`\\b${first.replace(/[^A-Za-z'-]/g, "")}\\b`, "i").test(body)) flags.push("doesn't use their name");
  return [...new Set(flags)];
}
