// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// outreach-opener.js — the first text a new listing agent gets from us.
//
// Matt, 2026-10-04: the app takes the first text over from the GHL workflow
// (agent-smsblast), which sent every agent the same template. Each one is
// written fresh by the bot, in Matt's voice — these examples are the voice —
// and names only the county the listing is in, not "greater Seatac".
//
// GHL puts the stop-to-end line ("No worries if not can stop lmk") on the
// end of the text itself, so neither the examples nor the bot ever write a
// sign-off or an opt-out line.
//
// Pure. Stored at settings.outreachAutopilot.opener; the reply agent reads it
// when it drafts outreach_open.

// Matt's workflow template with the footer taken off, then three more in the
// same voice. {first}, {street} and {county} are what the bot fills in.
export const DEFAULT_OPENER_EXAMPLES = [
  "Hi {first}, came across your listing at {street}. I'm in Seattle and looking for my next flip project anywhere in {county} County. Is this one a bit of a project, or pretty turnkey? And if you've got other fixers on your radar in {county}, I'm all ears.",
  "Hey {first}, saw your listing on {street}. I'm based in Seattle and looking for my next flip somewhere in {county} County. Is it more of a project or already in decent shape? Happy to hear about any other fixers you've got in {county} too.",
  "Hi {first}, came across {street} and had a question for you. I'm looking for my next flip in {county} County. Does it need some work, or is it pretty turnkey?",
  "Hey {first}, {street} caught my eye. I'm looking for a flip anywhere in {county} County right now. Is that one a bit of a project? And if you know of anything else in {county} that needs work, I'm all ears.",
];

export const OPENER_MAX_EXAMPLES = 8;
export const OPENER_EXAMPLE_MAX_CHARS = 400;
// Two SMS segments with GHL's footer on the end.
export const OPENER_MAX_CHARS = 280;

// The footer GHL adds. An example carrying it would teach the bot to write
// it, and the agent would get it twice.
const FOOTER_RX = /\bcan stop\b|\bstop to end\b|\breply stop\b/i;

/**
 * normalizeOpener(v) → { examples: string[] }
 *
 * Unset (or emptied) → Matt's defaults. Each example trimmed and capped; one
 * that carries the stop footer is dropped.
 */
export function normalizeOpener(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  const raw = Array.isArray(o.examples) ? o.examples : typeof o.examples === "string" ? o.examples.split(/\n\s*\n/) : null;
  const examples = (raw || [])
    .map((x) => String(x || "").replace(/\s+/g, " ").trim().slice(0, OPENER_EXAMPLE_MAX_CHARS))
    .filter((x) => x && !FOOTER_RX.test(x))
    .slice(0, OPENER_MAX_EXAMPLES);
  return { examples: examples.length ? examples : [...DEFAULT_OPENER_EXAMPLES] };
}

/**
 * countyName(...candidates) → "King" | ""
 *
 * The first usable county among what we have: RentCast's listing.county
 * ("King" or "King County"), or the sweep's county key ("King, WA").
 */
export function countyName(...candidates) {
  for (const c of candidates) {
    const s = String(c || "").split(",")[0].replace(/\s+county\s*$/i, "").trim();
    if (s && s !== "?") return s;
  }
  return "";
}

/**
 * openerVariant(contactId, n) → 0..n-1
 *
 * Which example the bot leads with for this agent: the same agent always
 * gets the same one, and a day's hundred don't all start alike.
 */
export function openerVariant(contactId, n) {
  if (!(n > 0)) return 0;
  let h = 0;
  for (const ch of String(contactId || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % n;
}
