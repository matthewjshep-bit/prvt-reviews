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
// same voice. {first}, {street}, {town} and {county} are what the bot fills in.
// 2026-10-05: Matt wanted more personality ("personable, concise, friendly,
// even humorous"), so the last three have a little more of him in them. The
// humour is about us and what we like, never about their listing.
// 2026-10-09: every one ends asking for their other fixers. The deals with
// committed buyers (Issaquah, Snohomish 23706, 7034 S K) were each the
// agent's next house, offered within minutes of that line or a check-in.
export const DEFAULT_OPENER_EXAMPLES = [
  "Hi {first}, came across your listing at {street}. I'm local in Seattle and buy places to fix up around {county} County. Is this one a bit of a project, or pretty turnkey? And if you've got other fixers on your radar, I'm all ears.",
  "Hey {first}, {street} caught my eye. I flip houses around Seattle and have a soft spot for ones that need a little love. Is this one a project? Either way, if you've got other fixers on your radar in {county} County, I'm all ears.",
  "Hi {first}, saw your {town} listing on {street}, looks like it has some character. Fixer, or already pretty turnkey? I'm after my next flip in {county} County, so if you know of anything else that needs work, I'd love to hear.",
  "Hey {first}, I'm someone who gets way too excited about original kitchens. Does {street} need some work? Looking for my next flip in {county} County, so if you've got other fixers on your radar, I'm all ears.",
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

// Half an acre and up reads as "a big lot" to anyone.
const BIG_LOT_SQFT = 21780;

/**
 * houseDetails(hook) → string[]
 *
 * What we know about the listing, as the few plain words a person would
 * notice from the listing page, for the first text to pick ONE from so the
 * agent can tell somebody actually looked. No prices, no days-on-market
 * count: those read as a pitch (and money is what the carriers block).
 */
export function houseDetails(h = {}) {
  const out = [];
  const town = String(h.city || "").trim();
  if (town) out.push(`it's in ${town}`);
  const year = Math.round(Number(h.yearBuilt) || 0);
  if (year >= 1850 && year <= 2030) out.push(year < 1940 ? `an older house, built before the war (${year})` : `built in the ${Math.floor(year / 10) * 10}s`);
  const beds = Math.round(Number(h.beds) || 0);
  const sqft = Math.round(Number(h.sqft) || 0);
  if (beds > 0 && beds <= 8) out.push(`${beds} bedroom${beds === 1 ? "" : "s"}${sqft > 0 && sqft < 1100 ? ", on the small side" : sqft >= 2600 ? ", a big house" : ""}`);
  if (Number(h.lotSize) >= BIG_LOT_SQFT) out.push("it sits on a big lot");
  if (Number(h.dom) >= 60) out.push("it has been on the market a while");
  if (h.priceCut) out.push("the price has come down since it listed");
  if (Number(h.listingCount) >= 3) out.push("this agent has a few other listings out right now");
  return out;
}

// Phrases the bot kept reaching for whatever it was told: on 2026-10-05, 30 of
// 45 first texts said "hunting", and "Seattle flipper" and "caught my eye" ran
// through most of the rest. Fine once; a day's batch of them is a template.
const OVERUSED = [
  ["hunting", /\bhunt(?:ing)?\b/i],
  ["Seattle flipper", /\bseattle flipper\b/i],
  ["caught my eye", /\bcaught my eye\b/i],
];

/**
 * overusedPhrases(text, { allow }) → the overused phrases a first text uses.
 * `allow` names any this agent's opening may use ("caught my eye" when the
 * opening is the street catching your eye).
 */
export function overusedPhrases(text = "", { allow = [] } = {}) {
  return OVERUSED.filter(([word, rx]) => !allow.includes(word) && rx.test(String(text || ""))).map(([word]) => word);
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
