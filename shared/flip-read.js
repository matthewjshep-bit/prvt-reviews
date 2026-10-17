// flip-read.js — is the house we opened with actually a flip?
//
// Matt, 2026-10-08: the first text is an icebreaker, not a lead. Agents are
// salespeople, and "it's a project", "cosmetic fixer", "could use some love"
// is them selling. On Oct 6–8, 159 of 505 agent replies started an underwrite,
// most of them on the house from the first text, and 209 of the month's 310
// offers ended passed. So, kept as short as a text thread allows:
//
//   1. Their answer names real trouble (foundation, hoarder, estate, two big
//      repairs, a 50k+ budget) → underwrite now. Specific bad news is not the
//      oversell.
//   2. Anything vaguer → ONE text: big repairs or a refresh, and what's the
//      seller's situation. A plain "it's turnkey" skips straight to 3.
//   3. Their answer to that still doesn't qualify → a polite pass that asks
//      what else they've got, on market or off. That is the real point of
//      the thread.
//
// Houses the agent brings up themselves underwrite right away (Matt's call),
// unless parties.agent.qualifyFirst.brought is on (2026-10-16): then
// broughtStep below reads them the same way, a little more kindly.
//
// Pure. The reply agent (ghl-broker/reply-agent.js) applies it when
// parties.agent.qualifyFirst is on.

import { sameStreet } from "./us-address.js";
import { OUR_BOX_WORDS } from "./asset-type.js";

// Trouble that makes a house a flip on its own.
const STRONG = [
  ["foundation", /\bfoundation\b|\bstructural\b|\bsettl(?:ed|ing)\b|\bsinking\b|\bpost[\s-]and[\s-]block\b|\buneven\s+floors?\b|\bdip\s+in\s+the\s+floor/i],
  ["water or mold", /\bmold\b|\bmildew\b|\bwater\s+damage\b|\bflood(?:ed|ing)?\b|\b(?:roof\s+)?leak(?:s|ing|y)?\b|\brot(?:ted|ten|ting)?\b/i],
  ["fire", /\bfire[\s-]damage(?:d)?\b|\b(?:had|house|kitchen)\s+(?:a\s+)?fire\b/i],
  ["hoarder", /\bhoard(?:er|ers|ing)\b/i],
  ["estate or probate", /\bestate\s+sale\b|\bprobate\b|\bpassed\s+away\b|\bdeceased\b|\binherit(?:ed|ance)\b|\bheirs?\b/i],
  ["financial distress", /\bforeclos(?:ure|ing|ed)\b|\bshort\s+sale\b|\bbank[\s-]owned\b|\breo\b|\bbehind\s+on\s+(?:payments|the\s+mortgage)\b|\btax\s+lien\b|\bdivorce\b/i],
  ["unlivable", /\bcondemned\b|\bred[\s-]tagged?\b|\buninhabitable\b|\bunlivable\b|\bnot\s+livable\b|\btear[\s-]?down\b|\bgutted\b|\bgut\s+(?:job|rehab|remodel)\b|\bneeds?\s+(?:a\s+)?gut\b|\bneeds\s+(?:everything|it\s+all)\b|\bfull\s+(?:gut|rehab|remodel|renovation)\b|\bmajor\s+(?:repairs?|work|rehab|renovation)\b/i],
  ["unfinished", /\bunfinished\b|\bnever\s+(?:been\s+)?(?:finished|completed)\b|\bnot\s+(?:been\s+)?(?:finished|completed)\b|\bhalf[\s-](?:done|finished)\b/i],
  ["can't finance", /\bcash\s+only\b|\bwon'?t\s+(?:finance|qualify|appraise)\b|\bnot\s+financeable\b|\bcan'?t\s+(?:be\s+)?financed?\b/i],
  ["vacant and neglected", /\bvacant\s+(?:for\s+)?(?:years|a\s+long\s+time)\b|\babandoned\b|\bsquatters?\b|\bneglected\b/i],
  // The sellers behind every deal with a committed buyer (2026-10-09): a
  // brother holding POA for a sister in assisted living, an executor son
  // after his mother died, a frail owner the family is moving out. They want
  // certainty and timing, not top dollar.
  ["life event", /\bexecut(?:or|rix)\b|\bpower\s+of\s+attorney\b|\bPOA\b|\bconservator(?:ship)?\b|\bguardianship\b|\b(?:wife|husband|mother|mom|father|dad|sister|brother|owner|spouse)\s+(?:just\s+)?(?:died|passed)\b|\bassisted\s+living\b|\bmemory\s+care\b|\bnursing\s+home\b/i],
];

// Big-ticket work. Two of these is a real scope; one with a reason to sell is too.
const MAJOR = [
  ["roof", /\broof\b/i],
  ["kitchen", /\bkitchen\b/i],
  ["bathrooms", /\bbath(?:room)?s?\b/i],
  ["heating", /\bhvac\b|\bfurnace\b|\bheat(?:ing)?\b|\bboiler\b|\boil\s+tank\b/i],
  ["electrical", /\belectric(?:al)?\b|\bknob[\s-]and[\s-]tube\b|\bpanel\b|\bwiring\b/i],
  ["plumbing", /\bplumbing\b|\bsewer\b|\bseptic\b|\bpipes?\b/i],
  ["windows or siding", /\bwindows\b|\bsiding\b/i],
];

// Why the seller has to sell. Alone it is not a flip; with real work it is.
const MOTIVATION = [
  ["in a hurry", /\basap\b|\bquick(?:ly)?\s+(?:sale|close)\b|\bneeds?\s+to\s+(?:sell|close)\b|\bmotivated\b|\burgent\b/i],
  ["moving on", /\brelocat(?:e|ing|ed)\b|\bout\s+of\s+state\b|\bmoving\s+(?:out|away|to)\b|\belderly\b|\bfrail\b|\btired\s+landlord\b|\b(?:seller|owner|she|he)\s+is\s+(?:[89]\d|1\d\d)\b/i],
  ["sitting", /\bsat\s+on\b|\bbeen\s+sitting\b|\bsitting\s+(?:on|for)\b|\bprice\s+(?:cut|drop|reduc)|\breduced\b|\bno\s+offers\b|\bfell\s+through\b|\bwalked\s+away\b/i],
];

// "No foundation issues", "the roof isn't bad", "not a hoarder": a negation
// in the few words before a hit, inside the same sentence, cancels it.
const NEGATED = /\b(?:no|not|without|never|zero|isn'?t|aren'?t|wasn'?t|doesn'?t\s+have|nothing\s+wrong\s+with(?:\s+the)?)\s+(?:\w+\s+){0,2}$/i;
// "New roof", "updated kitchen", "roof is 2 years old": the item is done, not work.
const DONE_BEFORE = /\b(?:new|newer|newly|updated|remodeled|remodelled|renovated|redone|replaced|recent|good|solid|sound|great|nice)\s+(?:\w+\s+){0,1}$/i;
const DONE_AFTER = /^\s*(?:is|was|has\s+been|were|are)?\s*(?:\w+\s+){0,1}(?:new|newer|updated|remodeled|renovated|redone|replaced|good|fine|great|nice|solid)\b/i;

function hits(list, text, { doneCounts = true } = {}) {
  const out = [];
  for (const [label, rx] of list) {
    const g = new RegExp(rx.source, "gi");
    let m;
    while ((m = g.exec(text))) {
      const before = text.slice(Math.max(0, m.index - 40), m.index).split(/[.!?\n;]/).pop();
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 30).split(/[.!?\n;,]/)[0];
      if (NEGATED.test(before)) continue;
      if (!doneCounts && (DONE_BEFORE.test(before) || DONE_AFTER.test(after))) continue;
      out.push(label);
      break;
    }
  }
  return out;
}

// A budget of their own this size is a real scope, whatever words came with it.
export const REAL_SCOPE_REHAB = 50000;

/**
 * flipRead(text, { agentRehab }) → { strong, major, motivation, qualifies, why }
 *
 * What the agent's own words say about the house. `qualifies` is the line
 * between "underwrite it" and "ask once" / "pass".
 */
export function flipRead(text = "", { agentRehab = 0 } = {}) {
  const t = String(text || "");
  const strong = hits(STRONG, t, { doneCounts: false });
  const major = hits(MAJOR, t, { doneCounts: false });
  const motivation = hits(MOTIVATION, t);
  const rehab = Math.round(Number(agentRehab) || 0);
  let why = "";
  if (strong.length) why = strong.join(", ");
  else if (rehab >= REAL_SCOPE_REHAB) why = `their own rehab budget, ${Math.round(rehab / 1000)}k`;
  else if (major.length >= 2) why = major.join(", ");
  else if (major.length && motivation.length) why = `${major[0]}, and the seller is ${motivation[0]}`;
  return { strong, major, motivation, qualifies: Boolean(why), why };
}

// "It's turnkey", "move-in ready", "they fixed it up": the agent telling us
// plainly it isn't a flip. Two of the agents behind deals with committed
// buyers said so in their first reply and offered their next house a minute
// later, once we left the door open — a second question about the same
// listing only stands in the way.
const TURNKEY = [
  ["turnkey", /\bturn[\s-]?key\b|\bmove[\s-]?in[\s-]?ready\b|\bnot\s+(?:really\s+)?a\s+project\b|\bisn'?t\s+a\s+project\b|\bfixed\s+(?:it\s+)?up\b|\b(?:it|this(?:\s+one)?|the\s+(?:house|home|property|place)|everything|\d+\w*)\s*(?:is|was|'s|has\s+been)\s+(?:been\s+)?(?:fully\s+|completely\s+|totally\s+|nicely\s+|all\s+)?(?:updated|remodeled|remodelled|renovated|redone)\b|\b(?:fully|completely|totally)\s+(?:updated|remodeled|remodelled|renovated)\b/i],
];
// "…but it needs a roof", "a light fixer": any talk of work left means it's
// not the plain "it's done" this reads for.
const WORK_LEFT_RX = /\bneed(?:s|ing|ed)?\b|\bfixer\b|(?<!\bnot\s(?:really\s)?a\s|\bisn'?t\sa\s)\bproject\b|\brepairs?\b|\bTLC\b|\bwork\s+(?:to\s+do|left)\b/i;

/** saysTurnkey(text) → true when their words say plainly the house is done. */
export function saysTurnkey(text = "") {
  const t = String(text || "");
  return hits(TURNKEY, t).length > 0 && !WORK_LEFT_RX.test(t);
}

// "Cosmetic", "paint and carpet", "just needs updating", "a facelift": the
// agent telling us it's light work. Read only when nothing in flipRead makes
// it a flip — "cosmetic, but the foundation's settling" is a flip.
const COSMETIC = [
  ["cosmetic", /\bcosmetic(?:s|ally)?\b|\blipstick\b|\bface[\s-]?lift\b|\brefresh\b|\bspruce\b|\bfreshen(?:\s+up|ing)?\b|\bupdat(?:e|es|ing)\b|\bdated\b|\bpaint\b|\bcarpet\b|\bflooring\b|\blight\s+(?:fixer|rehab|work|lift)\b|\bgood\s+(?:shape|condition|bones)\b|\blivable\b|\bTLC\b/i],
];
// "More than cosmetic", "not just paint": the opposite of light. "Needs some
// work", "a project": not light either, just unclear — that gets the question.
const MORE_THAN_LIGHT_RX = /\bmore\s+than\s+(?:just\s+|a\s+)?(?:cosmetic|a\s+refresh|refresh|paint|lipstick|updat)|\bnot\s+just\s+(?:cosmetic|paint|a\s+refresh|updat)|\bneeds?\s+(?:some\s+|a\s+lot\s+of\s+|lots\s+of\s+|real\s+)?work\b|(?<!\bnot\s(?:really\s)?a\s|\bisn'?t\sa\s)\bproject\b/i;

/**
 * saysCosmeticOnly(text, { agentRehab }) → true when their words call it light work and nothing more.
 * Any big-ticket item named at all ("needs a roof … and cosmetic work",
 * "probably a new roof, carpet, paint") is not cosmetic only: the question
 * sorts it out. 385 Glengarry and 20531 S Danvers read that way and were flips.
 */
export function saysCosmeticOnly(text = "", { agentRehab = 0 } = {}) {
  const t = String(text || "");
  if (!t.trim() || MORE_THAN_LIGHT_RX.test(t)) return false;
  if (flipRead(t, { agentRehab }).qualifies) return false;
  if (hits(MAJOR, t).length) return false;
  return hits(COSMETIC, t).length > 0;
}

// Their own framing of a candidate: "needs a lot of work", "a bit of a
// project", "a fixer", "flip potential". Not a list of rooms: "kitchen and
// baths original" is a scope for the question, not their word that it's a flip.
const CANDIDATE_RX = /\bneeds?\s+(?:a\s+(?:lot|bunch|ton|fair\s+amount)\s+of\s+|lots\s+of\s+|some\s+|real\s+|major\s+|significant\s+)?(?:work|rehab|repairs|TLC|love)\b|\bproject\b|\bfixer(?:[\s-]upper)?\b|\bflip\s+(?:potential|opportunity|candidate)\b|\bgood\s+flip\b/i;
// "Not a fixer", "new construction", "full remodel done in 2002": the opposite.
const NOT_A_CANDIDATE_RX = /\b(?:not|isn'?t|never|no)\s+(?:really\s+)?(?:a\s+|an\s+)?(?:fixer|project|flip)\b|\bnew(?:er)?\s+(?:construction|build|home)\b|\b(?:remodel|renovation|rehab|update)s?\s+(?:was\s+|were\s+)?(?:done|completed|finished)\b/i;

/**
 * saysRealWork(text, { agentRehab }) → true when the agent's own words make
 * the house a candidate: their framing (CANDIDATE_RX), real trouble
 * (flipRead's strong list), or a rehab budget of their own of 50K or more,
 * and nothing in them calls it done, new or light.
 *
 * Not flipRead's `qualifies`, which decides whether we underwrite at once and
 * counts big-ticket rooms. This decides whether they raised a candidate
 * (Matt, 2026-10-16: "it needs a lot of work" on the house we texted about is
 * a Tier 1, even while the bot asks its one question).
 */
export function saysRealWork(text = "", { agentRehab = 0 } = {}) {
  const t = String(text || "");
  if (!t.trim() || NOT_A_CANDIDATE_RX.test(t) || saysTurnkey(t) || saysCosmeticOnly(t, { agentRehab })) return false;
  if ((Number(agentRehab) || 0) >= REAL_SCOPE_REHAB) return true;
  // An unfinished basement is a room to finish, not an unfinished house.
  const said = t.replace(/\bunfinished\s+basement\b|\bbasement\s+(?:is\s+)?(?:still\s+)?unfinished\b/gi, "basement");
  return flipRead(said, { agentRehab }).strong.length > 0 || CANDIDATE_RX.test(said);
}

// Our one question. A few wordings, so a day of them doesn't read as a form.
export const QUALIFY_ASKS = [
  "Good to know. Is it big-ticket stuff like roof, foundation or systems, or more paint and flooring? And what's got the seller selling?",
  "Appreciate it. Honest read, real repairs like roof, foundation or systems, or more of a refresh? And what's the seller's situation?",
  "Helpful, thanks. What's it actually need, the big stuff like roof or foundation, or mostly cosmetic? And what's the story with the seller?",
];
// Our question in a thread, whichever wording went (or a hand-edited one
// that kept its shape).
export const QUALIFY_ASK_RX = /\b(?:big[\s-]ticket\s+stuff|real\s+repairs\s+like|the\s+big\s+stuff\s+like)\b[\s\S]*\bseller/i;

// The pass. The house was the icebreaker; the ask is the point.
// Each says what we buy (OUR_BOX_WORDS) and names ONE kind of seller that
// becomes a deal — the sellers behind the deals with committed buyers: an
// estate, a parent moving into care, someone who has to move by a date
// (2026-10-09).
export const QUALIFY_PASSES = [
  `Thanks, sounds too nice for us. We buy ${OUR_BOX_WORDS}. Anything like that, on or off-market? An unlisted estate is perfect.`,
  `Appreciate it. Lighter than we go for: ${OUR_BOX_WORDS}. Anything like that, listed or off-market? Even a parent moving into care.`,
  `Good to know. We buy ${OUR_BOX_WORDS}. If a seller who has to move by a date crosses your desk, on or off-market, I'd love a look.`,
];

// The call ask (2026-10-15). The funnel review: all 8 contracts from outreach
// agents came after a phone call, agents who talked brought us houses 54% of
// the time against 8%, and only 15% of the agents who answered ever talked.
// So their first answer gets one closing question that asks for both: other
// fixers, and a quick call. No times — no calendar is connected, so we ask
// what works for them. parties.agent.callAsk, off by default.
export const FIXERS_CALL_ASKS = [
  "If you've got other fixers on your radar, I'd love a quick 5-minute call this week, what time works?",
  "If anything else rough is on your radar, I'd love a quick 5-minute call this week, what time works for you?",
  "If you've got other fixers coming up, a quick 5-minute call this week would be great, what time works?",
];
// The same first-answer ask without the call, for when the call ask is off:
// the first text no longer carries the other-fixers line (2026-10-15), so
// their first answer is where we ask for the next house either way.
export const FIXERS_ASKS = [
  "If you've got other fixers on your radar, on or off-market, I'm all ears.",
  "Anything else rough on your radar, listed or not? I'd love a first look.",
  "If you've got other fixers coming up, on or off-market, send them my way.",
];
// The question and the pass, with the call ask in them: still one question
// about the house (QUALIFY_ASK_RX reads it), and the pass still asks for
// others, on or off-market.
export const QUALIFY_ASKS_CALL = [
  "Good to know. Big-ticket stuff like roof or foundation, or more of a refresh? I'd love the seller's story, and any other fixers you've got, on a quick 5-minute call this week, what time works?",
  "Appreciate it. Real repairs like roof, foundation or systems, or more of a refresh? Easier to hear the seller's situation and anything else you've got on a quick 5-minute call this week, what time works?",
  "Helpful, thanks. Is it the big stuff like roof or foundation, or mostly cosmetic? I'd love the seller's story, and any other fixers, on a quick 5-minute call this week, what time works?",
];
export const QUALIFY_PASSES_CALL = [
  `Thanks, sounds too nice for us. We buy ${OUR_BOX_WORDS}. If you've got other fixers on your radar, on or off-market, I'd love a quick 5-minute call this week, what time works?`,
  `Appreciate it. Lighter than we go for: ${OUR_BOX_WORDS}. If anything like that is on your radar, listed or off-market, I'd love a quick 5-minute call this week, what time works?`,
  `Good to know. We buy ${OUR_BOX_WORDS}. If you've got other fixers coming up, on or off-market, a quick 5-minute call this week would be great, what time works?`,
];
// Our text asked for a call, in any words. What the send records
// (call_asked), and what tells the backstop the model already asked.
export const CALL_ASK_RX = /\b(?:quick|short|(?:5|five|10|ten|15|fifteen)[\s-]?min(?:ute)?s?)\s+(?:phone\s+)?(?:call|chat)\b|\b(?:hop|jump)\s+on\s+(?:a|the)\s+(?:quick\s+)?(?:phone|call)\b|\bgive\s+you\s+a\s+(?:quick\s+)?(?:call|ring)\s+(?:this|next)\s+week\b/i;
// …and asked for other houses (fixers_asked).
export const FIXERS_ASK_RX = /\b(?:other|more)\s+(?:fixers?|fixer[\s-]uppers?|projects|flips)\b|\banything\s+else\s+(?:rough|distressed|sitting|that\s+needs\s+work|like\s+that)\b|\bon\s+your\s+radar\b/i;

const pick = (list, variant) => list[Math.abs(Math.round(Number(variant) || 0)) % list.length];

/**
 * withCallAsk(reply, variant) → the reply, ending on our one call ask
 *
 * The backstop for a first answer the model didn't close with the call ask.
 * A reply that already asks for a call is left alone; one that ends on a
 * question about other houses or staying in touch has that question taken
 * over by the call ask, so the text still asks one thing.
 */
export function withCallAsk(reply = "", variant = 0) {
  const said = String(reply || "").trim();
  if (CALL_ASK_RX.test(said)) return said;
  const ask = pick(FIXERS_CALL_ASKS, variant);
  if (!said) return ask;
  const parts = said.split(/(?<=[.!?])\s+/);
  const last = parts.at(-1) || "";
  const replaceable = /\?\s*$/.test(last) && (FIXERS_ASK_RX.test(last) || /\bstay\s+in\s+touch\b|\bkeep\s+(?:me|us)\s+in\s+mind\b|\bneeds?\s+(?:real\s+)?work\b|\boff[\s-]?market\b/i.test(last));
  return [...(replaceable ? parts.slice(0, -1) : parts), ask].join(" ").trim();
}

/**
 * withFixersAsk(reply, variant) → the reply, ending on our ask for their other fixers
 *
 * withCallAsk's twin for when the call ask is off. A reply that already asks
 * for other houses is left alone; one ending on a stay-in-touch question has
 * it taken over, so the text still asks one thing.
 */
export function withFixersAsk(reply = "", variant = 0) {
  const said = String(reply || "").trim();
  if (FIXERS_ASK_RX.test(said)) return said;
  const ask = pick(FIXERS_ASKS, variant);
  if (!said) return ask;
  const parts = said.split(/(?<=[.!?])\s+/);
  const last = parts.at(-1) || "";
  const replaceable = /\?\s*$/.test(last) && /\bstay\s+in\s+touch\b|\bkeep\s+(?:me|us)\s+in\s+mind\b|\bneeds?\s+(?:real\s+)?work\b|\boff[\s-]?market\b/i.test(last);
  return [...(replaceable ? parts.slice(0, -1) : parts), ask].join(" ").trim();
}

/**
 * qualifyStep({ words, asked, passed, agentRehab, variant }) → { move, read, reply }
 *
 *   move "underwrite"  their words qualify: run it as before
 *   move "ask"         first vague answer: our one question
 *   move "pass"        a vague answer to our question: pass, ask for others
 *   move "closed"      we already passed and it still doesn't qualify
 *
 * `words` is everything they've said about it since the first text; `asked`
 * and `passed` are whether our question / our pass already went; `callAsk`
 * puts the call ask in the question or the pass.
 */
export function qualifyStep({ words = "", asked = false, passed = false, agentRehab = 0, variant = 0, callAsk = false } = {}) {
  const read = flipRead(words, { agentRehab });
  if (read.qualifies) return { move: "underwrite", read, reply: "" };
  if (passed) return { move: "closed", read, reply: "Appreciate it. Keep me in mind if anything rougher comes up." };
  // `callAsk`: the ask and the pass carry the call ask (FIXERS_CALL_ASKS).
  if (asked || saysTurnkey(words)) return { move: "pass", read, reply: pick(callAsk ? QUALIFY_PASSES_CALL : QUALIFY_PASSES, variant) };
  return { move: "ask", read, reply: pick(callAsk ? QUALIFY_ASKS_CALL : QUALIFY_ASKS, variant) };
}

// "It had 56k in work done before it was listed" (217 N French Ave,
// 2026-10-16), "they put 40k into repairs": money already spent on the house
// is not a rehab budget. A figure for work is a budget only when the words
// around it don't say it's done.
const PAST_WORK_AFTER_RX = /^\s*(?:already\s+)?(?:done|completed|finished|put\s+in(?:to)?|invested|spent|sunk)\b/i;
const PAST_WORK_BEFORE_RX = /\b(?:put|spent|invested|sunk|poured|did|they(?:'ve|\s+have)\s+(?:done|put|spent))\s+(?:\w+\s+){0,3}$/i;
/** isPastWork(text, index, length) → true when the figure at text[index…] is work already done. */
export function isPastWork(text = "", index = 0, length = 0) {
  const t = String(text || "");
  const before = t.slice(Math.max(0, index - 40), index).split(/[.!?\n;]/).pop();
  const after = t.slice(index + length, index + length + 40).split(/[.!?\n;]/)[0];
  return PAST_WORK_AFTER_RX.test(after) || PAST_WORK_BEFORE_RX.test(before);
}

// "Probably 50-75K in updates", "about 60k of work", "rehab around 80,000":
// a work budget in their words, the low end of a range (29308 158th Ave E,
// 2026-10-07, was a flip the cosmetic word "updates" would have passed).
const WORK_BUDGET_RX = /\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k\b)?(?:\s*(?:-|–|to)\s*\$?\s*\d+(?:\.\d+)?\s*(k\b)?)?\s+(?:in|of|for)\s+(?:updates|updating|work|repairs|rehab|renovations?|remodel(?:ing)?|improvements)\b|\b(?:rehab|repairs|work|updates)\s+(?:of|around|about|at|is|runs?|would\s+be)\s+(?:about\s+|around\s+)?\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k\b)?/i;
/** workBudgetIn(text) → dollars of work they named, or 0. */
export function workBudgetIn(text = "") {
  const t = String(text || "");
  const m = t.match(WORK_BUDGET_RX);
  if (!m || isPastWork(t, m.index, m[0].length)) return 0;
  // "50-75K": the K on the top of a range is the K on its bottom too.
  const [num, k] = m[1] ? [m[1], m[2] || m[3]] : [m[4], m[5]];
  const n = Number(String(num).replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return 0;
  const dollars = k ? n * 1000 : n;
  return dollars >= 1000 && dollars < 5000000 ? Math.round(dollars) : 0;
}

/**
 * broughtStep({ words, asked, passed, offMarket, sellerAsk, agentRehab, variant, callAsk }) → { move, read, reply }
 *
 * The same screen for a house the agent brings up themselves
 * (parties.agent.qualifyFirst.brought, Matt 2026-10-16). Read against 132 of
 * them: 47 were real flips and both live contracts were among them, but 51
 * were houses the agent had already called cosmetic or turnkey, and the
 * machine's number on those died.
 *
 *   "underwrite"  real trouble in their words; or off-market with the
 *                 seller's number (7034 S K St: an off-market cosmetic fixer
 *                 at $250K became a contract); or still unclear after our
 *                 question — their own house is worth Matt's look
 *   "pass"        cosmetic or turnkey in their words
 *   "ask"         unclear, and we haven't asked: our one question
 *   "closed"      we already passed and it still doesn't qualify
 */
export function broughtStep({ words = "", asked = false, passed = false, offMarket = false, sellerAsk = 0, agentRehab: given = 0, variant = 0, callAsk = false } = {}) {
  const agentRehab = Math.max(Math.round(Number(given) || 0), workBudgetIn(words));
  const read = flipRead(words, { agentRehab });
  if (read.qualifies) return { move: "underwrite", read, reply: "" };
  if (offMarket && Number(sellerAsk) > 0) return { move: "underwrite", read: { ...read, why: "off-market, with the seller's number" }, reply: "" };
  if (passed) return { move: "closed", read, reply: "Appreciate it. Keep me in mind if anything rougher comes up." };
  if (saysTurnkey(words) || saysCosmeticOnly(words, { agentRehab })) {
    return { move: "pass", read, reply: pick(callAsk ? QUALIFY_PASSES_CALL : QUALIFY_PASSES, variant) };
  }
  if (asked) return { move: "underwrite", read: { ...read, why: "their own house, still unclear after our question" }, reply: "" };
  return { move: "ask", read, reply: pick(callAsk ? QUALIFY_ASKS_CALL : QUALIFY_ASKS, variant) };
}

/**
 * stillQualifying({ address, contactId, events, drafts }) → boolean
 *
 * The house is the one our first text (or a check-in about a fresh listing
 * of theirs) opened with, and no reply has found
 * it a flip yet. A number "promised" on it (the bot's own "let me run it by
 * underwriting") is not a reason to underwrite it: the question decides
 * that (shared/promise-resolver.js).
 */
export function stillQualifying({ address = "", contactId = "", events = [], drafts = [] } = {}) {
  if (!String(address || "").trim()) return false;
  const ice = (events || [])
    .filter((e) => e && (!contactId || !e.contactId || e.contactId === contactId)
      && (e.type === "outreach_sent" || (e.type === "outreach_enrolled" && e.data?.kind !== "followup")
        || (e.type === "agent_pulse_texted" && (e.data?.listingKey || e.data?.reason === "fresh_listing"))) && e.address)
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))[0];
  if (!ice || !sameStreet(ice.address, address)) return false;
  return !(drafts || []).some((d) => d && (!contactId || d.contactId === contactId)
    && d.qualify?.stage === "qualified" && sameStreet(d.qualify.address || "", address));
}

// Our own reply passing on the house (Matt, 2026-10-14). The model tags "it
// needs a refresh" as deal_available, writes "probably not enough meat for us
// on that one" — and the intent alone ran Tier 1 and an underwrite: Dana F.'s
// Welfare Ave, Korey P.'s turnkey Puyallup, Loren K., Lan N., Rachel B.
// Read our words, not the intent.
const OUR_PASS_RX = [
  /\bnot\s+(?:quite\s+)?enough\s+meat\b/i,
  /\bnot\s+(?:quite\s+|really\s+)?(?:the|a)\s+heavy\s+lift\b/i,
  /\bnot\s+(?:quite\s+)?(?:distressed|rough)\s+enough\b/i,
  /\b(?:pretty|too|a\s+bit)\s+light\s+for\s+us\b/i,
  /\ba\s+light\s+one\s+for\s+us\b/i,
  /\blighter\s+than\s+(?:we|what\s+we)\s+(?:go|buy|usually)/i,
  /\b(?:is|are)n'?t\s+(?:really\s+|quite\s+)?(?:our\s+lane|a\s+fit\s+for\s+us|for\s+us|what\s+we(?:'re|\s+are)\s+after)\b/i,
  /\bnot\s+(?:really\s+|quite\s+)?(?:our\s+lane|a\s+fit\s+for\s+us|one\s+for\s+us|what\s+we(?:'re|\s+are)\s+(?:after|looking\s+for))\b/i,
  /\b(?:too|more)\s+(?:turnkey|finished|nice)\s+(?:for\s+us|than\s+what\s+we)\b/i,
  /\b(?:mostly|usually|really)\s+after\s+(?:places|houses|homes|stuff|properties)\s+(?:that\s+)?need(?:ing|s)?\s+(?:real\s+|more\s+)?work\b/i,
  /\boutside\s+the\s+box\s+for\s+us\b/i,
  // "We've actually moved on from this one" (2026-10-15) said it too.
  /\b(?:we(?:'d|'ve|\s+have|\s+had)?|i(?:'ve)?)\s+(?:(?:already|actually|just|kind\s+of|since)\s+)?moved\s+on\s+from\s+(?:that|this)\s+one\b/i,
  /\b(?:we'?ll|we\s+will|going\s+to|gonna)\s+pass\s+on\s+(?:that|this|it)\b/i,
];
// The same reply still chasing a house — ours or another one ("pass on 184th,
// keep me posted on that Mount Vernon one though"). Then it isn't a pass.
const STILL_CHASING_RX = /\bworth\s+(?:once\s+it'?s\s+)?fixed\s+up\b|\bwhat'?s\s+the\s+(?:full\s+|street\s+|unit\s+)?address\b|\bunderwriting\b|\brun\s+(?:the\s+|those\s+)?numbers\b|\bgood\s+fit\s+for\s+us\b|\bmore\s+our\s+speed\b|\bsounds\s+like\s+our\s+lane\b|\bARV\b|\bas-is,?\s+(?:cash|quick)/i;

/** ourReplyPasses(reply) → true when our reply turns the house down and isn't still chasing one. */
export function ourReplyPasses(reply = "") {
  const t = String(reply || "");
  if (!t.trim()) return false;
  return OUR_PASS_RX.some((rx) => rx.test(t)) && !STILL_CHASING_RX.test(t);
}

// A reply that is the bot's word to the agent: going out, gone, or waiting on
// a person. A draft someone dismissed or a newer reply replaced is not.
const QUALIFY_LIVE_STATUSES = new Set(["draft", "scheduled", "sent"]);

/**
 * threadPassed({ address, drafts }) → { stage } | null
 *
 * The bot's newest read of this house in the thread, when it says not to
 * price it: still asking its one question ("ask"), passed ("pass"), or
 * closed after a pass ("closed"). A later reply that found it a flip
 * ("qualified") lets it run. The underwriter checks this before it buys the
 * comps and again before it makes the offer: 31 N Colony Surf Dr
 * (2026-10-13) was passed at 12:07 while an underwrite started at 12:06
 * landed its offer at 12:08, and that offer floated and went out on paper
 * the next morning.
 */
export function threadPassed({ address = "", drafts = [] } = {}) {
  if (!String(address || "").trim()) return null;
  const latest = (drafts || [])
    .filter((d) => d?.qualify?.stage && QUALIFY_LIVE_STATUSES.has(d.status) && sameStreet(d.qualify.address || "", address))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0];
  return latest && ["ask", "pass", "closed"].includes(latest.qualify.stage) ? { stage: latest.qualify.stage } : null;
}
