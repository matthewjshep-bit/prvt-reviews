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

import { streetName, openerVariant, DEFAULT_FOLLOW_UP_TEXTS, LEGACY_DEFAULT_FOLLOW_UP_TEXTS, DAY_TWO_TEXTS, DEFAULT_CHECK_IN_TEXTS, DEFAULT_HOME, withHomeBlank } from "./outreach-opener.js";
import { parseUsAddress } from "./us-address.js";

// 2026-11-09 (Matt: check-ins personable, not AI): the pools below are v2,
// from the audit's read of the sent log. The 10-17 texts said "desk" or
// "radar" in 40% of texts against Matt's 0.9%, "on or off market" in 31%,
// "circling back", "hope you're doing well" and "TLC"; three texts a pool
// meant an agent heard the same one twice in two months. Each v2 text is one
// real thing and one question, no "once" phrase shared with the text after
// it, and passes shared/voice.js filled in with a first name and without.
// The 10-17 pools are kept as LEGACY_*: conversationAi.checkIns.pools "v1"
// puts them back in one field.

// The spare follow-up to a first text nobody answered (outreach_nudge): a
// step with no text of its own. The two follow-ups (the second names no
// house, for an agent we have no address for), then one more day-2 text.
export const NUDGE_TEXTS = [
  ...DEFAULT_FOLLOW_UP_TEXTS,
  DAY_TWO_TEXTS[3],
];
export const LEGACY_NUDGE_TEXTS = [
  ...LEGACY_DEFAULT_FOLLOW_UP_TEXTS,
  "Hi {first}, checking back on {address}. Not sure it needs enough work for us, but if you come across any fixers, listed or off market, I'm all ears.",
];

// The plain check-in (agent_pulse, nothing particular to name): an engaged
// agent (pool A).
export const CHECKIN_TEXTS = [
  "Hey {first}, anything new on your plate that needs real work?",
  "Any sellers right now who'd rather not fix it up first, {first}?",
  "{first}, seen anything rough lately, listed or not?",
  "Hi {first}, any estates or tired rentals coming up on your end?",
  "{first}, been a few weeks. Got anything that needs more than paint and carpet?",
  "Hey {first}, anything off-market lately that needs work?",
  "Any listings coming that the seller won't want to fix up, {first}?",
  "Hi {first}, got any older houses on deck that need a full redo?",
  "{first}, anyone you're working with who just wants it sold and done?",
  "Honestly the uglier the better for me. Anything like that coming up, {first}?",
];
// …to an agent who has never written back, with an offer or a Tier card
// (pool B): who it is in two words, and their town when we know it.
export const CHECKIN_COLD_TEXTS = [
  "Hi {first}, it's Matt. Anything around {town} that needs real work?",
  "{first}, any sellers near {town} who'd rather not fix it up first?",
  "Hey {first}, Matt here. Any older houses coming up that need a lot?",
  "Anything off-market around {town} I should see, {first}?",
  "Hi {first}, any estates or long-time rentals coming up near {town}?",
  "{first}, if a listing of yours ever needs too much for retail buyers, can I take a look?",
  "Hey {first}, it's Matt. Got anything that needs more than a coat of paint?",
  "Any fixers around {town} lately, {first}?",
  "Hi {first}, Matt again. Anything on your end that needs real work?",
  "{first}, got a seller who'd rather skip the repairs and the showings?",
];
// …when a fresh listing of theirs came up (pool C): still a check-in, the
// listing named in passing and never judged. The 10-21 "doesn't look like a
// fixer" was said about listings the pull had rated distressed.
export const LISTING_PING_TEXTS = [
  "Hey {first}, saw your new listing on {street}. Anything else coming that needs real work?",
  "{first}, congrats on getting {street} up. Any sellers on deck who'd rather not fix up first?",
  "Saw {street} hit the market, {first}. Got anything behind it that needs a lot?",
  "Hi {first}, saw you listed {street}. Anything off-market on your end that needs work?",
  "{first}, nice to see {street} up. Any older ones coming that need a full redo?",
  "Hey {first}, saw {street} come up. Any estates or tired rentals in the works too?",
  "Saw your listing on {street}, {first}. If the next one needs too much for retail buyers, can I see it first?",
  "Hi {first}, saw {street}. Anything rougher in the pipeline?",
];
// …the same to an agent who has never written back (pool D), under 160.
export const LISTING_PING_COLD_TEXTS = [
  "Hi {first}, it's Matt. Saw your listing on {street}. Anything around {town} that needs real work?",
  "Saw {street} come up, {first}. Any sellers near {town} who'd rather not fix up first?",
  "{first}, Matt here. Got anything rougher than your new one on {street}?",
  "Hey {first}, nice listing on {street}. Any older houses coming that need a lot?",
  "Any fixers coming up behind your {street} listing, {first}?",
  "Hey {first}, Matt here. Saw your listing on {street}. Any estates or tired rentals in the works?",
  "{first}, saw {street}. Anything off-market near {town} that needs work?",
  "Hi {first}, saw your new listing on {street}. Any sellers who want to sell without fixing anything?",
];

// The 10-17 pools (pools "v1"). Matt, 2026-10-21, on the listing ping: "Hey I
// saw your listing at whatever address but it doesn't look like a fixer.
// Just wanted to check in and see if you have any other distressed
// properties on the plate."
export const LEGACY_CHECKIN_TEXTS = [
  "Hi {first}, circling back. Any fixers or distressed properties come across your desk lately?",
  "Hey {first}, hope you're doing well. Anything come across your desk lately that needs work, on or off market?",
  "Hi {first}, any fixers on your radar lately, listed or off market? Always happy to take a look.",
];
export const LEGACY_CHECKIN_COLD_TEXTS = [
  "Hi {first}, it's Matt, I fix up houses locally. Any fixers or distressed properties come across your desk lately?",
  "Hey {first}, Matt here, local guy who fixes up houses. Anything come across your desk lately that needs work, on or off market?",
  "Hi {first}, it's Matt. I'm always after houses that need some TLC. Any fixers on your radar lately, listed or off market?",
];
export const LEGACY_LISTING_PING_TEXTS = [
  "Hey {first}, saw your listing on {street}, doesn't look like a fixer. Just wanted to check in, any other distressed properties on your plate?",
  "Hi {first}, saw your listing on {street}. Not sure it needs enough work for us, but wanted to check in. Anything distressed on your plate, listed or off market?",
  "Hey {first}, noticed your listing on {street}, doesn't look like it needs much work. Just checking in, any other fixers on your plate lately?",
];
export const LEGACY_LISTING_PING_COLD_TEXTS = [
  "Hi {first}, it's Matt, I fix up houses locally. Saw your listing on {street}, doesn't look like a fixer, but any other distressed properties on your plate?",
  "Hey {first}, Matt here, I fix up houses locally. Saw your listing on {street}, probably not one for us, but anything on your plate that needs work?",
  "Hi {first}, it's Matt. Saw your listing on {street}, doesn't look like a fixer, but any other distressed properties on your plate, listed or off market?",
];

export const POOL_VERSIONS = ["v1", "v2"];
const POOLS = {
  v2: { nudge: NUDGE_TEXTS, checkin: CHECKIN_TEXTS, checkinCold: CHECKIN_COLD_TEXTS, listing: LISTING_PING_TEXTS, listingCold: LISTING_PING_COLD_TEXTS, followUps: DEFAULT_FOLLOW_UP_TEXTS },
  v1: { nudge: LEGACY_NUDGE_TEXTS, checkin: LEGACY_CHECKIN_TEXTS, checkinCold: LEGACY_CHECKIN_COLD_TEXTS, listing: LEGACY_LISTING_PING_TEXTS, listingCold: LEGACY_LISTING_PING_COLD_TEXTS, followUps: LEGACY_DEFAULT_FOLLOW_UP_TEXTS },
};
/** poolsFor("v1") → the fixed check-in texts of that version (v2 unless it says v1). */
export const poolsFor = (version = "v2") => POOLS[version === "v1" ? "v1" : "v2"];

// Pierce County's first text (2026-10-26, Matt: "switch the wording slightly
// only for pierce"). The same plain shape as the saved ones, without "I'm in
// Seattle" or the "a bit of a project, or pretty turnkey?" either-or the
// 10/26 STOP analysis flagged (3.4% opt-outs), and it names where we buy. It
// goes in place of the saved first texts for a Pierce listing — a new agent's
// first text and a focus county's ping alike; every other county keeps
// what's saved in Autopilot → Agents.
export const COUNTY_OPENERS = {
  pierce: [
    "Hi {first}, saw your listing on {street} in {town}. I fix up older houses around Pierce County. Does it need much work?",
    "Hey {first}, I buy and fix up houses around {town}. Does your listing on {street} need some work?",
    "Hi {first}, it's Matt. I renovate a few houses a year in Pierce County. Is your listing on {street} a bit of a project?",
  ],
};

/** countyOpener("Pierce") → Pierce's first texts, or null for a county that has none. */
export function countyOpener(county = "") {
  const k = String(county || "").split(",")[0].trim().replace(/\s+county$/i, "").toLowerCase();
  return COUNTY_OPENERS[k] || null;
}

// The first text to an agent whose listing came down lately, sold or not (the
// recent listers, 2026-10-26, Matt: agents "who have active listings in the
// last 60-90 days"). The house is gone, so it is named as theirs, in the
// past, as proof we know their patch — never "came off the market" (Matt,
// 2026-10-20) and never a question about that house. The ask is the next one.
// 2026-11-09: the second said "I buy houses", which our own carrier gate
// holds, so a third of these waited on the Desk; the third said "TLC".
export const PAST_LISTING_TEXTS = [
  "Hi {first}, it's Matt, I fix up houses around {town}. Saw you had {address} recently. Anything else like it come across your desk, listed or off market?",
  "Hey {first}, Matt here. I fix up houses around {town} and saw you had {address}. Anything else coming that needs real work?",
  "Hi {first}, it's Matt. I fix up houses locally and noticed you had {address} recently. Got anything else that needs work, listed or off market?",
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

/**
 * firstNameOf("Brenda") → "Brenda"; a company, a role or an empty name → "".
 * "BRENDA" (an ALL CAPS name in GHL) → "Brenda". 2026-11-09: 234 check-ins in
 * 60 days opened "Hi," with no name, and a GHL name that was the role
 * ("Agent") would have been greeted as one.
 */
export function firstNameOf(name = "") {
  const first = String(name || "").trim().split(/\s+/)[0] || "";
  if (!/^[a-z][a-z'’-]*$/i.test(first) || first.length < 2) return "";
  if (/^(?:llc|team|inc|the|agents?|group|realtors?|realty|brokers?|homes?|office|properties|listing)$/i.test(first)) return "";
  const word = first === first.toUpperCase() ? first.toLowerCase() : first;
  return word[0].toUpperCase() + word.slice(1);
}

// No first name: "Hi {first}, saw…" reads "Saw…", "{first}, seen…" reads
// "Seen…", and "…lately, {first}?" reads "…lately?". Until 2026-11-09 they
// read "Hi, saw…" and "…lately, ?". A text that never had the name in front
// (a lowercase email subject) keeps its first letter as written.
function withoutFirst(t) {
  const s = String(t || "");
  const front = s.replace(/^\s*(?:hi|hey|hello)\s+\{first\}\s*[,.!]?\s*/i, "").replace(/^\s*\{first\}\s*[,.!]?\s*/, "");
  const out = front
    .replace(/,\s*\{first\}(?=\s*[?.!,])/g, "")
    .replace(/\s*\{first\}/g, "");
  return front !== s ? out.replace(/^\s*([a-z])/, (_, c) => c.toUpperCase()) : out;
}

/**
 * fillTemplate(template, values) → the text, or "" when it uses a blank we
 * have nothing for. No first name: the greeting and the name come out, so a
 * text never opens "Hi," or ends ", ?".
 */
export function fillTemplate(template = "", values = {}) {
  // With a city to say we're in, a "Seattle" typed into the text is that city.
  const base = values.home ? withHomeBlank(template) : String(template || "");
  const t = values.first ? base.replace(/\s*\{first\}/g, ` ${values.first}`) : withoutFirst(base);
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
    if (text) return { text, index, template: list[index] };
  }
  return null;
}

// The fixed texts this app ships and stands behind: a voice flag on one of
// these holds it like any machine text. Anything else (Matt's own saved
// texts, the v1 pools a rollback restores, the cold ladder's own check-ins)
// is advisory: flagged on the page, never blocked (shared/voice.js).
export const SHIPPED_TEXTS = new Set([
  ...NUDGE_TEXTS, ...CHECKIN_TEXTS, ...CHECKIN_COLD_TEXTS, ...LISTING_PING_TEXTS, ...LISTING_PING_COLD_TEXTS,
  ...DEFAULT_FOLLOW_UP_TEXTS, ...DAY_TWO_TEXTS, ...PAST_LISTING_TEXTS, ...Object.values(COUNTY_OPENERS).flat(),
]);
/** isShippedText(template) → true for one of the app's own v2 texts, as written. */
export const isShippedText = (template = "") => SHIPPED_TEXTS.has(String(template || ""));

/**
 * standardText({ kind, outbound, name, contactId, pools, shift }) → { text, set, index, template } | null
 *
 * The fixed text for a cold text to a listing agent, or null when the model
 * should write it: the mode is "ai", or it's a kind of text with something
 * real to say (a turnkey seat, a house they mentioned, a deal
 * we closed together, Matt's 15).
 *
 *   outreach_open   outbound.mode "template"; one of outbound.templates
 *   outreach_nudge  outbound.mode "template"; outbound.followUps[step], or
 *                   with the follow-ups never changed, a day-2 text picked
 *                   by the contact (2026-11-09), else NUDGE_TEXTS from the
 *                   contact's variant plus the step; a repeat rung past the
 *                   last step, outbound.checkIns in turn
 *   agent_pulse     outbound.mode "template"; CHECKIN_TEXTS, CHECKIN_COLD_TEXTS,
 *                   or LISTING_PING_TEXTS / LISTING_PING_COLD_TEXTS when a
 *                   fresh listing of theirs came up; a focus listing
 *                   (outbound.listing.focus) one of outbound.templates
 *
 * `pools` is conversationAi.checkIns.pools ("v1": the 10-17 texts). `shift`
 * walks to the next variant along, the gate's answer to a fixed text that
 * would repeat one of ours (ghl-broker/reply-agent.js runProactive).
 */
export function standardText({ kind, outbound = {}, name = "", contactId = "", pools = "v2", shift = 0 } = {}) {
  const o = outbound || {};
  // The recent listers' first text and its first follow-up are these fixed
  // texts in either mode: the model has no words for a house that's gone.
  if (o.mode !== "template" && !(o.pastListing && (kind === "outreach_open" || kind === "outreach_nudge"))) return null;
  const P = poolsFor(pools);
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
  // A follow-up or a check-in names the town on the address we texted them
  // about when the listing gave none (2026-11-09: the v2 texts name it when
  // we know it). The first text keeps to the listing's own.
  if (kind !== "outreach_open" && !values.town) values.town = parseUsAddress(String(o.address || "")).city.trim();
  // The first text carries its variant; the others follow the contact id.
  const v = (o.variant != null ? Number(o.variant) || 0 : openerVariant(contactId, 997)) + Math.max(0, Math.round(Number(shift) || 0));
  const done = (set, r) => (r ? { text: r.text, set, index: r.index, template: r.template } : null);
  // No town on record: pickFilled moves on to the line that doesn't name one.
  if (kind === "outreach_open" && o.pastListing) return done("past_listing", pickFilled(PAST_LISTING_TEXTS, v, values));
  if (kind === "outreach_open") {
    if (o.turnkey) return null;
    // A county with first texts of its own (Pierce).
    const own = countyOpener(o.county);
    const mine = own ? pickFilled(own, v, values) : null;
    if (mine) return done("county_opener", mine);
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
    // A recent lister's house is gone: "not sure if that listing needs
    // work" would ask about it. Their follow-ups are the plain check-ins.
    if (o.pastListing) {
      const list = Array.isArray(o.checkIns) && o.checkIns.length ? o.checkIns : DEFAULT_CHECK_IN_TEXTS;
      return done("check_in", pickFilled(list, v + rung, values));
    }
    // Follow-up 1 never changed (2026-11-09): day 2 is one of eight, picked
    // by the contact, so a day's batch doesn't read alike. Pools "v1" reads
    // the 10-26 texts for the slots never changed, one per step, as before.
    const list = Array.isArray(o.followUps) && o.followUps.length ? o.followUps : DEFAULT_FOLLOW_UP_TEXTS;
    if (rung === 0 && list[0] === DEFAULT_FOLLOW_UP_TEXTS[0] && pools !== "v1") {
      const day2 = pickFilled(DAY_TWO_TEXTS, v, values);
      if (day2) return done("day_two", day2);
    }
    const text = pools === "v1" && list[rung] != null && list[rung] === DEFAULT_FOLLOW_UP_TEXTS[rung] ? P.followUps[rung] : list[rung];
    const own = fillTemplate(text, values);
    if (own) return { text: own, set: "follow_up", index: rung, template: text };
    return done("nudge", pickFilled(P.nudge, v + rung, values));
  }
  if (kind === "agent_pulse") {
    if (o.forMatt || o.reason === "deal_thanks" || o.reason === "off_market_listing" || o.hook?.kind === "mentioned") return null;
    const cold = o.segment === "cold" || /gone quiet/.test(String(o.segment || ""));
    if (o.reason === "fresh_listing" && o.listing?.focus) {
      // A focus county's listing that has been up a while and that Zillow
      // says needs work (2026-10-26, Pierce): the first text they've had
      // from us about it, so it reads as a new agent's first text does — not
      // "doesn't look like a fixer". Nothing to fill it with: the plain
      // check-in, which names no house.
      const own = countyOpener(o.county);
      const ex = Array.isArray(o.templates) ? o.templates : [];
      return (own ? done("county_opener", pickFilled(own, v, values)) : null)
        || done("opener", pickFilled(ex, v, values)) || done("checkin_cold", pickFilled(P.checkinCold, v, values));
    }
    if (o.reason === "fresh_listing") {
      // The street name, never the house number, like the first text.
      const street = streetName(o.listing?.street || "") || values.street;
      const town = String(o.listing?.city || "").trim() || values.town;
      return done(cold ? "listing_cold" : "listing", pickFilled(cold ? P.listingCold : P.listing, v, { ...values, street, town }));
    }
    return done(cold ? "checkin_cold" : "checkin", pickFilled(cold ? P.checkinCold : P.checkin, v, values));
  }
  return null;
}
