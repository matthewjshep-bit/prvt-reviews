// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// standard-texts.js — the cold texts to listing agents, as Matt writes them.
//
// Matt, 2026-10-17: "simplify our initial outreach messaging to agents AND the
// followup asking about properties … keep it short and sweet, personable, and
// to the point … I think we're getting too creative." The 10/16 batch was 375
// first texts, each written fresh by the model, and the thread replies that
// followed asked for a "quick 5-minute call this week, what time works?" even
// after "the sale closed yesterday". The threads that turned into deals
// started with his own plain texts:
//
//   Brenda         "Hi Brenda, came across your listing for [the street
//                   address]. I'm local here in Seattle and buy places to fix up …
//                   Is this one a bit of a project, or pretty turnkey? And if
//                   you've got other fixers on your radar, I'm all ears."
//   Rigo           "saw your listing for [the address], I'm seattle based and
//                   do flips looking for stuff that needs a little TLC …
//                   figured I'd ask? Or any other fixers youve seen"
//   … two weeks on "We're usually looking for properties needing real rehab
//                   work, the uglier the better. Anything like that on your end?"
//   … check-in     "Hi Rigo, circling back, any fixers or distressed
//                   properties come across your desk lately?"
//
// So the first text, its follow-up and the plain check-in are one of a few
// fixed texts in that voice, filled in: never a remark about the house, never
// a joke, never a call ask. Which one an agent gets follows the contact id,
// so a day's batch doesn't all read alike and an agent's own texts don't
// repeat. The model still writes the replies to what they say, and the
// check-ins that have something real to name (a house they mentioned, a deal
// we closed together, Matt's 15).
//
// Pure. ghl-broker/reply-agent.js uses standardText() in place of the model
// for these kinds when the mode is "template".

import { streetName, openerVariant, DEFAULT_FOLLOW_UP_TEXTS, DEFAULT_CHECK_IN_TEXTS, DEFAULT_HOME } from "./outreach-opener.js";

// The follow-up to a first text nobody answered (outreach_nudge): Rigo's
// two-week text, without the dollar figure (carriers read money in a cold
// text as an ad). Each step of the ladder has its own text
// (outreachAutopilot.opener.followUps, 2026-10-20); this pool is for a step
// with none of its own.
export const NUDGE_TEXTS = [
  ...DEFAULT_FOLLOW_UP_TEXTS,
  "Hi {first}, checking back on {address}. Not sure it needs enough work for us, but if you come across any fixers, listed or off market, I'm all ears.",
];

// The plain check-in (agent_pulse, nothing particular to name).
export const CHECKIN_TEXTS = [
  "Hi {first}, circling back. Any fixers or distressed properties come across your desk lately?",
  "Hey {first}, hope you're doing well. Anything come across your desk lately that needs work, on or off market?",
  "Hi {first}, any fixers on your radar lately, listed or off market? Always happy to take a look.",
];
// …to an agent who has never written back: one clause on who we are.
export const CHECKIN_COLD_TEXTS = [
  "Hi {first}, it's Matt, I fix up houses locally. Any fixers or distressed properties come across your desk lately?",
  "Hey {first}, Matt here, local guy who fixes up houses. Anything come across your desk lately that needs work, on or off market?",
  "Hi {first}, it's Matt. I'm always after houses that need some TLC. Any fixers on your radar lately, listed or off market?",
];
// …when a fresh listing of theirs came up: still a check-in, naming the
// listing in passing. Matt, 2026-10-21, after an agent we'd checked in with a
// week before got "saw your listing on … Is it a bit of a project?" and opted
// out: "switch to a general check-in and maybe we can reference it: 'Hey I
// saw your listing at whatever address but it doesn't look like a fixer. Just
// wanted to check in and see if you have any other distressed properties on
// the plate.'"
export const LISTING_PING_TEXTS = [
  "Hey {first}, saw your listing on {street}, doesn't look like a fixer. Just wanted to check in, any other distressed properties on your plate?",
  "Hi {first}, saw your listing on {street}. Not sure it needs enough work for us, but wanted to check in. Anything distressed on your plate, listed or off market?",
  "Hey {first}, noticed your listing on {street}, doesn't look like it needs much work. Just checking in, any other fixers on your plate lately?",
];
// …the same to an agent who has never written back: one clause on who we are.
export const LISTING_PING_COLD_TEXTS = [
  "Hi {first}, it's Matt, I fix up houses locally. Saw your listing on {street}, doesn't look like a fixer, but any other distressed properties on your plate?",
  "Hey {first}, Matt here, I fix up houses locally. Saw your listing on {street}, probably not one for us, but anything on your plate that needs work?",
  "Hi {first}, it's Matt. Saw your listing on {street}, doesn't look like a fixer, but any other distressed properties on your plate, listed or off market?",
];

// "SE", "NW" as people write them; listing feeds send "Se".
const DIRECTIONS_RX = /\b(?:ne|nw|se|sw)\b/gi;

/**
 * streetLine(address) → "14820 SE 172nd St"
 *
 * The street address the way Matt wrote it to Brenda: number and street, no
 * city, ZIP or unit. "" for nothing usable.
 */
export function streetLine(address = "") {
  const line = String(address || "").split(",")[0].replace(/\s+/g, " ").trim()
    .replace(/\s+(?:#|apt\.?|unit|ste\.?|suite)\s*[\w-]+$/i, "")
    .replace(DIRECTIONS_RX, (d) => d.toUpperCase());
  return /[a-z]/i.test(line) ? line : "";
}

/** firstNameOf("Brenda") → "Brenda"; a company or an empty name → "". */
export function firstNameOf(name = "") {
  const first = String(name || "").trim().split(/\s+/)[0] || "";
  if (!/^[a-z][a-z'’-]*$/i.test(first) || first.length < 2) return "";
  if (/^(?:the|team|group|realty|homes?|properties|llc|inc)$/i.test(first)) return "";
  return first[0].toUpperCase() + first.slice(1);
}

/**
 * fillTemplate(template, values) → the text, or "" when it uses a blank we
 * have nothing for. No first name: "Hi {first}," reads "Hi,".
 */
export function fillTemplate(template = "", values = {}) {
  const t = String(template || "").replace(/\s*\{first\}/g, values.first ? ` ${values.first}` : "");
  let missing = false;
  const out = t.replace(/\{(\w+)\}/g, (_, k) => {
    const v = String(values[k] ?? "").trim();
    if (!v) missing = true;
    return v;
  });
  return missing ? "" : out.replace(/\s+([,.?])/g, "$1").replace(/\s{2,}/g, " ").trim();
}

// Which text an agent gets: the contact's variant, then the next one along
// when that one uses a blank we can't fill.
function pickFilled(list, variant, values) {
  const n = list.length;
  const start = Math.abs(Math.round(Number(variant) || 0)) % Math.max(1, n);
  for (let i = 0; i < n; i++) {
    const index = (start + i) % n;
    const text = fillTemplate(list[index], values);
    if (text) return { text, index };
  }
  return null;
}

/**
 * standardText({ kind, outbound, name, contactId }) → { text, set, index } | null
 *
 * The fixed text for a cold text to a listing agent, or null when the model
 * should write it: the mode is "ai", or it's a kind of text with something
 * real to say (a turnkey seat, a house they mentioned, a deal
 * we closed together, Matt's 15).
 *
 *   outreach_open   outbound.mode "template"; one of outbound.templates
 *   outreach_nudge  outbound.mode "template"; outbound.followUps[step], else
 *                   NUDGE_TEXTS from the contact's variant plus the step; a
 *                   repeat rung past the last step, outbound.checkIns in turn
 *   agent_pulse     outbound.mode "template"; CHECKIN_TEXTS, CHECKIN_COLD_TEXTS,
 *                   or LISTING_PING_TEXTS / LISTING_PING_COLD_TEXTS when a
 *                   fresh listing of theirs came up
 */
export function standardText({ kind, outbound = {}, name = "", contactId = "" } = {}) {
  const o = outbound || {};
  if (o.mode !== "template") return null;
  const values = {
    first: firstNameOf(name),
    // "the property" is the descriptor's stand-in when there's no address.
    address: /^the property$/i.test(String(o.address || "")) ? "" : streetLine(o.address),
    street: /^the property$/i.test(String(o.address || "")) ? "" : streetName(o.address),
    town: String(o.city || "").trim(),
    county: String(o.county || "").trim(),
    // The city we say we're in, by the listing's market (outreach-opener.js homeFor).
    home: String(o.home || "").trim() || DEFAULT_HOME,
  };
  // The first text carries its variant; the others follow the contact id.
  const v = o.variant != null ? Number(o.variant) || 0 : openerVariant(contactId, 997);
  const done = (set, r) => (r ? { text: r.text, set, index: r.index } : null);
  if (kind === "outreach_open") {
    if (o.turnkey) return null;
    const ex = Array.isArray(o.templates) ? o.templates : [];
    return done("opener", pickFilled(ex, v, values));
  }
  if (kind === "outreach_nudge") {
    // A repeat rung (every 14 days after the last step) is a check-in, the
    // next one along each time. Until 2026-10-20 its step read as step 1, so
    // it sent follow-up 1 again.
    if (o.repeats && !Number(o.stepIndex)) {
      const list = Array.isArray(o.checkIns) && o.checkIns.length ? o.checkIns : DEFAULT_CHECK_IN_TEXTS;
      return done("check_in", pickFilled(list, v + Math.max(0, (Number(o.repeatN) || 1) - 1), values));
    }
    // Follow-up N is the text written for step N; one with none of its own
    // (or one we can't fill) takes the pool, a step along per step, so no
    // agent gets the same follow-up twice running (2026-10-20).
    const rung = Math.max(0, (Number(o.stepIndex) || 1) - 1);
    const own = Array.isArray(o.followUps) ? fillTemplate(o.followUps[rung], values) : "";
    if (own) return { text: own, set: "follow_up", index: rung };
    return done("nudge", pickFilled(NUDGE_TEXTS, v + rung, values));
  }
  if (kind === "agent_pulse") {
    if (o.forMatt || o.reason === "deal_thanks" || o.reason === "off_market_listing" || o.hook?.kind === "mentioned") return null;
    const cold = o.segment === "cold" || /gone quiet/.test(String(o.segment || ""));
    if (o.reason === "fresh_listing") {
      // The street name, never the house number, like the first text.
      const street = streetName(o.listing?.street || "") || values.street;
      return done(cold ? "listing_cold" : "listing", pickFilled(cold ? LISTING_PING_COLD_TEXTS : LISTING_PING_TEXTS, v, { ...values, street }));
    }
    return done(cold ? "checkin_cold" : "checkin", pickFilled(cold ? CHECKIN_COLD_TEXTS : CHECKIN_TEXTS, v, values));
  }
  return null;
}
