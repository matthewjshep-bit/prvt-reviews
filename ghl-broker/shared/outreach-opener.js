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

import { parseUsAddress, stateAbbr } from "./us-address.js";

// Matt's workflow template with the footer taken off, then three more in the
// same voice. {first}, {street}, {town} and {county} are what the bot fills in.
// 2026-10-05: Matt wanted more personality ("personable, concise, friendly,
// even humorous"), so the last three have a little more of him in them. The
// humour is about us and what we like, never about their listing.
// 2026-10-15 (the funnel review): first texts under about 230 characters got
// 54% replies, longer ones 33–36%, and the "other fixers" line every example
// ended on cost about 12 points and most of the length. So each is one
// question about the listing, about 150 characters filled in, and the ask for
// their other fixers waits for their first answer.
// 2026-10-17 (Matt: "keep it short and sweet, personable, and to the point …
// we're getting too creative"): the texts that started real deals were his
// own plain ones — Brenda ("came across your listing for [the street
// address] … Is this one a bit of a project, or pretty turnkey? And if
// you've got other fixers on your radar, I'm all ears") and Rigo ("looking
// for stuff that needs a little TLC … figured I'd ask? Or any other fixers
// you've seen"). So the first text is one of these, filled in as written
// (mode "template", shared/standard-texts.js), not a fresh one from the
// model: the listing by its address, who we are in a few words, is it a
// project, and their other fixers. {address} is the street address (number
// and street), {street} the street alone. 2026-10-21: {home} is the city we
// say we're in, by the listing's market (homeFor below), not always Seattle.
export const DEFAULT_OPENER_EXAMPLES = [
  "Hi {first}, saw your listing at {address}. I'm local and fix up houses. Is it a bit of a project, or pretty turnkey? If you've got other fixers on your radar, I'm all ears.",
  "Hi {first}, came across your listing at {address}. I'm {home} based and fix up places that need some TLC. Is this one a bit of a project? Or any other fixers you've seen?",
  "Hey {first}, saw your listing at {address}. I'm local here in {home} and fix up houses. Does this one need much work? And if you've got other fixers on your radar, I'm all ears.",
];
// The two defaults as they read until 2026-10-21, with Seattle written in. A
// stored copy is read as today's, so a Bend agent never hears "Seattle based".
const SEATTLE_DEFAULTS = new Map([
  ["Hi {first}, came across your listing at {address}. I'm Seattle based and fix up places that need some TLC. Is this one a bit of a project? Or any other fixers you've seen?", DEFAULT_OPENER_EXAMPLES[1]],
  ["Hey {first}, saw your listing at {address}. I'm local here in Seattle and fix up houses. Does this one need much work? And if you've got other fixers on your radar, I'm all ears.", DEFAULT_OPENER_EXAMPLES[2]],
]);

// Where we say we are, by where the listing is (2026-10-21, Matt: "as we
// expand into different areas … say 'im in bend' or 'im in portland' etc to
// let them know we are there and local"). A county in its state wins, then
// a whole state; anywhere else is `home`. Settings → Agents edits both.
export const DEFAULT_HOME = "Seattle";
export const DEFAULT_HOMES = [
  { county: "Deschutes", state: "OR", home: "Bend" },
  { county: "Crook", state: "OR", home: "Bend" },
  { county: "Jefferson", state: "OR", home: "Bend" },
  { county: "", state: "OR", home: "Portland" },
];
export const HOMES_MAX = 40;

// The defaults from 2026-10-16 to 2026-10-17, written by the model in a
// "plain" voice: the street without its number, one question, no fixers ask.
// Until 2026-10-26 a stored copy was read as "never changed"; now it is kept.
export const PLAIN_DEFAULT_OPENER_EXAMPLES = [
  "Hi {first}, I saw your listing on {street}. I fix up older homes locally. Does it need much work, or is it pretty move-in ready?",
  "Hey {first}, does your listing on {street} need much work? I renovate a few houses a year and I'm looking for my next one.",
  "Hi {first}, I'm local and fix up houses. Is the place you have listed on {street} in decent shape, or does it need some updating?",
  "Hey {first}, saw your listing on {street} in {town}. Has it been updated, or does it still need some work?",
];

// How the first text is written: "template" fills one of the examples in as
// written (2026-10-17, the default); "ai" has the model write a fresh one in
// their voice, as from 2026-10-04 to 2026-10-16.
export const OPENER_MODES = ["template", "ai"];

// The defaults from 2026-10-15 to 2026-10-16: shorter than the first ones,
// still with a remark and a county in them. A stored copy is read as
// "never changed", like the older ones below.
export const PREVIOUS_DEFAULT_OPENER_EXAMPLES = [
  "Hi {first}, came across your listing at {street}. I'm local and fix up houses around {county} County. Is this one a bit of a project, or pretty turnkey?",
  "Hey {first}, saw {street} come up. I flip a few houses a year and have a soft spot for the ones that need a little love. Is this one a project?",
  "Hi {first}, your {town} listing on {street} looks like it has some character. Fixer, or already pretty turnkey? I'm after my next flip in {county} County.",
  "Hey {first}, I'm someone who gets way too excited about original kitchens. Does {street} need some work, or has it already been done?",
];

// The defaults until 2026-10-15, each ending on the other-fixers line. Settings
// saved them verbatim, so a stored list of these is read as "never changed"
// and gets today's defaults; one mixed in with Matt's own is dropped.
export const LEGACY_DEFAULT_OPENER_EXAMPLES = [
  "Hi {first}, came across your listing at {street}. I'm local in Seattle and buy places to fix up around {county} County. Is this one a bit of a project, or pretty turnkey? And if you've got other fixers on your radar, I'm all ears.",
  "Hey {first}, {street} caught my eye. I flip houses around Seattle and have a soft spot for ones that need a little love. Is this one a project? Either way, if you've got other fixers on your radar in {county} County, I'm all ears.",
  "Hi {first}, saw your {town} listing on {street}, looks like it has some character. Fixer, or already pretty turnkey? I'm after my next flip in {county} County, so if you know of anything else that needs work, I'd love to hear.",
  "Hey {first}, I'm someone who gets way too excited about original kitchens. Does {street} need some work? Looking for my next flip in {county} County, so if you've got other fixers on your radar, I'm all ears.",
];
// The plain set is not among them since 2026-10-26: it had the fewest STOPs
// of the fixed first texts (1.6%, against 3.4% for "I'm in Seattle and
// looking for my next flip project around …"), and is saved on purpose.
const LEGACY = new Set([...LEGACY_DEFAULT_OPENER_EXAMPLES, ...PREVIOUS_DEFAULT_OPENER_EXAMPLES]);

// The follow-ups to a first text nobody answered (outreach_nudge), one per
// step of the ladder: follow-up 1 is the first text written here, follow-up
// 2 the second (2026-10-20, Matt: "the first text … and then the second text
// … as a follow-up", charted out like a GHL workflow). Until then every step
// picked from one pool, so an agent got the same follow-up on every step.
// Follow-up 1 is Matt's day-2 text (2026-10-20: "Hey Brenda, following up on
// my earlier message. Not sure if that listing was distressed, needed work …
// the uglier the better, anything like that on your end?"). Since
// 2026-10-26 follow-up 1 names the house: "Not sure if that listing needs
// work" read as if we never looked, and drew a STOP for every 4 replies,
// where "circling back on {address}" drew 34% replies and none. The second
// names none, so it is also the spare when there's no address. A step with
// no text of its own uses shared/standard-texts.js NUDGE_TEXTS.
export const DEFAULT_FOLLOW_UP_TEXTS = [
  "Hey {first}, circling back on {address}. If it's not a fit, no worries. Any fixers or houses that need some TLC on your radar, on or off market?",
  "Hey {first}, I'm after houses that need real work, the uglier the better. Anything like that on your end, listed or off market?",
];
// The two follow-ups from 2026-10-20 to 2026-10-26, read as never changed.
export const DAY_TWO_DEFAULT_FOLLOW_UP_TEXTS = [
  "Hey {first}, following up on my earlier message. Not sure if that listing needs work, but I'm after distressed or value-add properties, the uglier the better. Anything like that on your end?",
  "Hey {first}, circling back on {address}. If it's not a fit, no worries. Any fixers or houses that need some TLC on your radar, on or off market?",
];
// The two follow-ups until 2026-10-20 (day 3 and day 10). The chart saves
// both texts with any edit, so a stored pair of exactly these is read as
// never changed and gets today's.
export const PREVIOUS_DEFAULT_FOLLOW_UP_TEXTS = [
  "Hi {first}, following up on your listing at {address}. We're usually after houses that need real work, the uglier the better. Anything like that on your end?",
  "Hey {first}, circling back on {address}. If it's not a fit, no worries. Any fixers or houses that need some TLC on your radar, on or off market?",
];

// The check-ins after the follow-ups, every `repeatEvery` days until they
// answer (2026-10-20, Matt: "check in every 14 days after that"). Until
// then a repeat rung sent follow-up 1 again, word for word. One per rung, in
// turn, so no two in a row are the same.
export const DEFAULT_CHECK_IN_TEXTS = [
  "Hi {first}, circling back. Any fixers or distressed properties come across your desk lately, listed or off market?",
  "Hey {first}, checking in. Anything on your radar that needs work? The uglier the better.",
  "Hi {first}, any distressed or value-add properties come up lately, on or off market? Always happy to take a look.",
];

export const OPENER_MAX_EXAMPLES = 8;
export const OPENER_EXAMPLE_MAX_CHARS = 400;
// A saved example longer than this teaches the bot a long first text, so the
// model isn't shown it (2026-10-15). Matt's own text still goes as written:
// until 2026-10-20 one this long was dropped on save without a word, and
// the page came back with the defaults ("it won't let me save").
export const OPENER_EXAMPLE_KEEP_CHARS = 220;
// The first text the bot writes stays under this. 2026-10-15: under about 230
// characters got 54% replies, longer 33–36%. GHL adds two lines to the first
// text a contact gets (Settings → Phone System → Messaging Compliance), "Thanks,
// Matt" and "No worries if not can stop", about 45 characters; 200 leaves the
// whole thing inside two SMS segments (306) with room to spare.
// 2026-10-16: 160. The plain first text (street, who we are, one question)
// is about 120; anything longer has picked up a remark about the house.
export const OPENER_MAX_CHARS = 160;

// The footer GHL adds. An example carrying it would teach the bot to write
// it, and the agent would get it twice.
const FOOTER_RX = /\bcan stop\b|\bstop to end\b|\breply stop\b/i;

/**
 * normalizeOpener(v) → { examples: string[], followUps: string[], checkIns: string[], mode: "template" | "ai", home: string, homes: [{ county, state, home }] }
 *
 * Unset (or emptied) → Matt's defaults. Each example trimmed and capped at
 * OPENER_EXAMPLE_MAX_CHARS, GHL's {{…}} blanks made the app's; one that
 * carries the stop footer is dropped, and a sign-off on the end is cut. One
 * of the pre-2026-10-15 defaults is dropped too; a list left empty is
 * today's defaults. `homes` unset is DEFAULT_HOMES; saved empty stays empty.
 */
export function normalizeOpener(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  // The old defaults (each ends asking for other fixers) are left out of the
  // first texts (2026-10-15).
  const examples = cleanTexts(o.examples, LEGACY).map((x) => SEATTLE_DEFAULTS.get(x) || x);
  let followUps = cleanTexts(o.followUps);
  if ([PREVIOUS_DEFAULT_FOLLOW_UP_TEXTS, DAY_TWO_DEFAULT_FOLLOW_UP_TEXTS].some((old) => followUps.join("\n") === old.join("\n"))) followUps = [];
  const checkIns = cleanTexts(o.checkIns);
  return {
    examples: examples.length ? examples : [...DEFAULT_OPENER_EXAMPLES],
    followUps: followUps.length ? followUps : [...DEFAULT_FOLLOW_UP_TEXTS],
    checkIns: checkIns.length ? checkIns : [...DEFAULT_CHECK_IN_TEXTS],
    mode: o.mode === "ai" ? "ai" : "template",
    home: cleanPlace(o.home) || DEFAULT_HOME,
    homes: o.homes == null ? DEFAULT_HOMES.map((h) => ({ ...h })) : homesFrom(o.homes),
  };
}

// "bend" → "Bend": a place name as it reads in a text, nothing else in it.
function cleanPlace(v) {
  const s = String(v || "").replace(/[{}<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
  return s && s === s.toLowerCase() ? s.replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s;
}

/**
 * homesFrom(v) → [{ county, state, home }]
 *
 * The places we say we're in, from an array or the Settings box's lines:
 * "Deschutes, OR = Bend" (a county in its state) or "OR = Portland" (the
 * rest of a state). A county with no state is a Washington one, where the
 * business is. A line that isn't one of these is dropped.
 */
export function homesFrom(v) {
  const raw = Array.isArray(v) ? v : String(v || "").split(/[\n;]+/);
  const out = [];
  for (const x of raw) {
    let county, state, home;
    if (x && typeof x === "object") ({ county = "", state = "", home = "" } = x);
    else {
      const m = String(x || "").match(/^\s*([^=:]+?)\s*[=:]\s*(.+?)\s*$/);
      if (!m) continue;
      const where = m[1].split(",").map((p) => p.trim());
      home = m[2];
      // Two letters that aren't a state are a typo, not a county.
      if (where.length === 1 && /^[a-z]{2}$/i.test(where[0]) && !stateAbbr(where[0])) continue;
      if (where.length === 1 && stateAbbr(where[0]) && !/\s/.test(where[0])) [county, state] = ["", where[0]];
      else [county, state] = [where[0], where[1] || "WA"];
    }
    const c = String(county || "").replace(/\s+county$/i, "").trim();
    const st = stateAbbr(state);
    const h = cleanPlace(home);
    if (st && h) out.push({ county: c, state: st, home: h });
  }
  return out.slice(0, HOMES_MAX);
}

/** homesText(homes) → the Settings box's lines, one place per line. */
export function homesText(homes = []) {
  return (homes || []).map((h) => `${h.county ? `${h.county}, ` : ""}${h.state} = ${h.home}`).join("\n");
}

/**
 * homeFor({ county, state, address }, opener) → "Bend"
 *
 * The city the text says we're in, for a listing in this county and state
 * (the state off the address when it isn't given; Washington when neither
 * says). The opener's own county line, then its state line, then `home`.
 */
export function homeFor({ county = "", state = "", address = "" } = {}, opener = {}) {
  const homes = Array.isArray(opener.homes) ? opener.homes : DEFAULT_HOMES;
  const parsed = parseUsAddress(address);
  const c = countyName(county).toLowerCase();
  // No state anywhere (a GHL follow-up carries RentCast's bare "Deschutes"
  // and maybe a street-only address): a county line of ours that names it.
  const st = stateAbbr(state) || parsed.state || stateFromCounty(county)
    || (c && homes.find((h) => h.county && h.county.toLowerCase() === c && h.state !== "WA")?.state) || "WA";
  const byCounty = c && homes.find((h) => h.county && h.county.toLowerCase() === c && h.state === st);
  // No county: a house in the town we say we're in is there (a Bend address
  // is Bend, not "the rest of Oregon").
  const town = String(parsed.city || "").toLowerCase();
  const byTown = !c && town && homes.find((h) => h.state === st && h.home.toLowerCase() === town);
  const byState = homes.find((h) => !h.county && h.state === st);
  return (byCounty || byTown || byState)?.home || cleanPlace(opener.home) || DEFAULT_HOME;
}

// A "Seattle" Matt typed into his own text means where we are (2026-10-21):
// his saved first text said "I'm in Seattle", so a Bend agent would have read
// it. As {home}, a Seattle agent still reads Seattle and a Bend one Bend.
const HOME_WORD_RX = new RegExp(`\\b${DEFAULT_HOME}\\b`, "g");
export const withHomeBlank = (text) => String(text || "").replace(HOME_WORD_RX, "{home}");

// The sweep's county key carries its state ("Deschutes, OR").
function stateFromCounty(county) {
  return stateAbbr(String(county || "").split(",")[1] || "");
}

// A list of texts as Settings or the Autopilot chart saves them (an array,
// or one string with a blank line between texts): GHL's merge fields made
// the app's blanks, trimmed, without GHL's stop footer or a sign-off.
function cleanTexts(v, drop = new Set()) {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/\n\s*\n/) : [];
  return raw
    .map((x) => fromMergeFields(String(x || "")).replace(/\s+/g, " ").trim().slice(0, OPENER_EXAMPLE_MAX_CHARS))
    .filter((x) => x && !FOOTER_RX.test(x))
    // "…I'm all ears. Thanks, Matt" would teach the bot to sign off.
    .map((x) => stripSignOff(x))
    .filter((x) => x && !drop.has(x))
    .slice(0, OPENER_MAX_EXAMPLES);
}

/**
 * fromMergeFields(text) → the text with GHL's {{…}} blanks written the app's way
 *
 * Matt writes them as GHL does ({{contact.first_name}}, or a note to himself:
 * "{{insert county}}"), and the app fills {first}, {address}, {street},
 * {town} and {county}. Read by what the field names; one the app has no
 * blank for is left as written.
 */
export function fromMergeFields(text = "") {
  return String(text || "").replace(/\{\{\s*([^{}]*?)\s*\}\}(\s+county\b)?/gi, (all, field, county) => {
    const f = field.toLowerCase();
    if (/first/.test(f)) return `{first}${county || ""}`;
    if (/county/.test(f)) return "{county} County";
    if (/address/.test(f)) return `{address}${county || ""}`;
    if (/street/.test(f)) return `{street}${county || ""}`;
    if (/city|town/.test(f)) return `{town}${county || ""}`;
    return all;
  });
}

/**
 * openerVoice(opener) → the examples the model writes a first text from
 *
 * Matt's fixed texts name the house number and ask for other fixers, which
 * the model's own first text doesn't do (the turnkey and off-market seats, or
 * mode "ai"). With his defaults in place, the model is shown the 2026-10-16
 * plain ones it was written for; examples he saved himself are his voice.
 */
export function openerVoice(opener = {}) {
  const ex = Array.isArray(opener.examples) ? opener.examples : [];
  const mine = ex.length && !(ex.length === DEFAULT_OPENER_EXAMPLES.length && ex.every((x, i) => x === DEFAULT_OPENER_EXAMPLES[i]));
  // Only his short ones teach the model; a long one would teach a long text.
  const short = mine ? ex.filter((x) => x.length <= OPENER_EXAMPLE_KEEP_CHARS) : [];
  return short.length ? short : [...PLAIN_DEFAULT_OPENER_EXAMPLES];
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
  // 2026-10-16: the remarks that made the day's batch read like a template.
  ["good bones", /\bgood bones\b/i],
  ["soft spot", /\bsoft spot\b/i],
];

/**
 * overusedPhrases(text, { allow }) → the overused phrases a first text uses.
 * `allow` names any this agent's opening may use ("caught my eye" when the
 * opening is the street catching your eye).
 */
export function overusedPhrases(text = "", { allow = [] } = {}) {
  return OVERUSED.filter(([word, rx]) => !allow.includes(word) && rx.test(String(text || ""))).map(([word]) => word);
}

// "SW", "NE" and the rest as people write them; listing feeds send "Sw".
const DIRECTIONS_RX = /\b(?:ne|nw|se|sw)\b/gi;

/**
 * streetName(address) → "Wren Ct"
 *
 * The street a listing is on, without the house number or unit, the way a
 * person names it in a text ("your listing on Wren Ct"). A full street
 * address is what a mailing reads like (2026-10-16). "" for nothing usable.
 */
export function streetName(address = "") {
  const line = String(address || "").split(",")[0].replace(/\s+/g, " ").trim();
  const street = line
    .replace(/\s+(?:#|apt\.?|unit|ste\.?|suite)\s*[\w-]+$/i, "")
    .replace(/^\d+[a-z]?(?:-\d*[a-z]?)?\s+(?=\S)/i, "")
    .replace(DIRECTIONS_RX, (d) => d.toUpperCase())
    .trim();
  return /[a-z]/i.test(street) ? street : "";
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
 * firstTextHook(doc, { county, base }) → the hook the first text is drafted from
 *
 * Out of the agent's outreach row (`doc`): the house (year, size, lot, cut),
 * the county the text names, and whether the listing looks finished (the
 * turnkey seats). The import and both retries build it here, so none of
 * them drops a flag the others carry: the 2026-10-15 funnel review found 79
 * of 80 agents picked for a turnkey seat asked "is this one a project?",
 * because the import wrote the hook out field by field and left `turnkey`
 * behind. `base` is
 * what was written down before (the import event's or the skip's hook); the
 * row wins where it knows the house. `county` is the sweep's county, for a
 * row older than the listing's own.
 */
export function firstTextHook(doc = {}, { county = "", base = {} } = {}) {
  const d = doc && typeof doc === "object" ? doc : {};
  const h = d.hook && typeof d.hook === "object" ? d.hook : {};
  const b = base && typeof base === "object" ? base : {};
  const own = Boolean(h.address);
  const cut = Boolean(h.priceCut || (Array.isArray(h.components) && h.components.some((c) => c?.key === "cuts" && Number(c.points) > 0)));
  const turnkey = h.turnkey === true || d.turnkey === true || b.turnkey === true;
  // A listing that came off the market lately (the off-market seats, 2026-10-15).
  const offMarket = h.offMarket === true || b.offMarket === true;
  // Their listing came down lately, sold or not (the recent listers, 2026-10-26).
  const pastListing = h.pastListing === true || b.pastListing === true;
  const removedDate = h.removedDate || b.removedDate || null;
  return {
    ...b,
    address: (own ? h.address : b.address) || "",
    price: (own ? h.price : b.price) || null,
    dom: (own ? h.dom : b.dom) || null,
    county: countyName(h.county, b.county, county),
    // Which state the county is in, for the city we say we're in (homeFor).
    state: stateAbbr(h.state) || stateAbbr(b.state) || parseUsAddress((own ? h.address : b.address) || "").state || stateFromCounty(county),
    city: h.city || b.city || "",
    brokerage: d.brokerage || b.brokerage || "",
    yearBuilt: h.yearBuilt || b.yearBuilt || null, beds: h.beds || b.beds || null,
    sqft: h.sqft || b.sqft || null, lotSize: h.lotSize || b.lotSize || null,
    priceCut: cut || Boolean(b.priceCut),
    listingCount: Number(d.listingCount) || Number(b.listingCount) || 0,
    ...(turnkey ? { turnkey: true } : {}),
    ...(offMarket ? { offMarket: true, ...(removedDate ? { removedDate } : {}) } : {}),
    ...(pastListing ? { pastListing: true, ...(removedDate ? { removedDate } : {}) } : {}),
  };
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
