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
// GHL adds two lines to the first text a contact gets (Settings → Phone
// System → Messaging Compliance): the sender, "Thanks, Matt", and the opt-out,
// "No worries if not can stop". With those ~45 characters and their line
// breaks, 250 keeps the whole text inside two SMS segments (306).
export const OPENER_MAX_CHARS = 250;

// The footer GHL adds. An example carrying it would teach the bot to write
// it, and the agent would get it twice.
const FOOTER_RX = /\bcan stop\b|\bstop to end\b|\breply stop\b/i;

/**
 * normalizeOpener(v) → { examples: string[] }
 *
 * Unset (or emptied) → Matt's defaults. Each example trimmed and capped; one
 * that carries the stop footer is dropped, and a sign-off on the end is cut.
 */
export function normalizeOpener(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  const raw = Array.isArray(o.examples) ? o.examples : typeof o.examples === "string" ? o.examples.split(/\n\s*\n/) : null;
  const examples = (raw || [])
    .map((x) => String(x || "").replace(/\s+/g, " ").trim().slice(0, OPENER_EXAMPLE_MAX_CHARS))
    .filter((x) => x && !FOOTER_RX.test(x))
    // "…I'm all ears. Thanks, Matt" would teach the bot to sign off.
    .map((x) => stripSignOff(x))
    .filter(Boolean)
    .slice(0, OPENER_MAX_EXAMPLES);
  return { examples: examples.length ? examples : [...DEFAULT_OPENER_EXAMPLES] };
}

// A sign-off at the very end: "Thanks, Matt", "- Matt", "Best, Matthew",
// "Thanks!", or the opt-out line itself.
const OPT_OUT_TAIL_RX = /\s*no worries if not,?\s*(?:i |we )?can stop\b[\s\S]*$/i;
const THANKS = "(?:thanks|thank you|thx|cheers|best|regards|talk soon)";

/**
 * stripSignOff(text, { names }) → text
 *
 * The first text with any sign-off or opt-out line taken off the end. GHL
 * adds "Thanks, Matt" and "No worries if not can stop" to the first SMS a
 * contact gets, so one the bot wrote would reach the agent twice. `names`
 * are the sender's own names (the persona's, "Matt"); "Matthew" and the
 * company count too.
 */
export function stripSignOff(text = "", { names = [] } = {}) {
  let t = String(text || "").replace(OPT_OUT_TAIL_RX, "").trim();
  const who = [...new Set([...names, "Matt", "Matthew", "Matthew Shepherd", "Shep Flips", "ShepFlips"]
    .map((n) => String(n || "").trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const signed = new RegExp(`(?:^|[.?!]|\\n)\\s*(?:[-–—~]\\s*)?(?:${THANKS}[,!.]*\\s*)?(?:[-–—~]\\s*)?(?:${who})\\s*[.!]?\\s*$`, "i");
  const thanks = new RegExp(`(?:^|(?<=[.?!])|\\n)\\s*${THANKS}[!.]*\\s*$`, "i");
  for (let i = 0; i < 2; i++) {
    const m = signed.exec(t) || thanks.exec(t);
    if (!m) break;
    // Keep the sentence's own end mark ("…all ears." stays a full stop).
    const keep = /^[.?!]/.test(m[0]) ? m[0][0] : "";
    t = (t.slice(0, m.index) + keep).trim();
  }
  return t;
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
