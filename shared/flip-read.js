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
//      seller's situation.
//   3. Their answer to that still doesn't qualify → a polite pass that asks
//      what else they've got, on market or off. That is the real point of
//      the thread.
//
// Houses the agent brings up themselves are not read here: those underwrite
// right away (Matt's call), as before.
//
// Pure. The reply agent (ghl-broker/reply-agent.js) applies it when
// parties.agent.qualifyFirst is on.

import { sameStreet } from "./us-address.js";

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
  ["moving on", /\brelocat(?:e|ing|ed)\b|\bout\s+of\s+state\b|\bmoving\s+(?:out|away|to)\b|\bassisted\s+living\b|\bnursing\s+home\b|\belderly\b|\btired\s+landlord\b/i],
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
export const QUALIFY_PASSES = [
  "Thanks for the honest read. Sounds a bit too nice for us, we're after the ones that really need work. Anything rough crossing your desk, on market or off-market?",
  "Appreciate it. That one sounds lighter than what we go after, we like them ugly. Got anything else that needs real work, listed or off-market?",
  "Good to know, thanks. Probably more finished than our sweet spot. If anything distressed comes across your desk, on the MLS or off-market, I'd love a first look.",
];

const pick = (list, variant) => list[Math.abs(Math.round(Number(variant) || 0)) % list.length];

/**
 * qualifyStep({ words, asked, passed, agentRehab, variant }) → { move, read, reply }
 *
 *   move "underwrite"  their words qualify: run it as before
 *   move "ask"         first vague answer: our one question
 *   move "pass"        a vague answer to our question: pass, ask for others
 *   move "closed"      we already passed and it still doesn't qualify
 *
 * `words` is everything they've said about it since the first text; `asked`
 * and `passed` are whether our question / our pass already went.
 */
export function qualifyStep({ words = "", asked = false, passed = false, agentRehab = 0, variant = 0 } = {}) {
  const read = flipRead(words, { agentRehab });
  if (read.qualifies) return { move: "underwrite", read, reply: "" };
  if (passed) return { move: "closed", read, reply: "Appreciate it. Keep me in mind if anything rougher comes up." };
  if (asked) return { move: "pass", read, reply: pick(QUALIFY_PASSES, variant) };
  return { move: "ask", read, reply: pick(QUALIFY_ASKS, variant) };
}

/**
 * stillQualifying({ address, contactId, events, drafts }) → boolean
 *
 * The house is the one our first text opened with, and no reply has found
 * it a flip yet. A number "promised" on it (the bot's own "let me run it by
 * underwriting") is not a reason to underwrite it: the question decides
 * that (shared/promise-resolver.js).
 */
export function stillQualifying({ address = "", contactId = "", events = [], drafts = [] } = {}) {
  if (!String(address || "").trim()) return false;
  const ice = (events || [])
    .filter((e) => e && (!contactId || !e.contactId || e.contactId === contactId)
      && (e.type === "outreach_sent" || (e.type === "outreach_enrolled" && e.data?.kind !== "followup")) && e.address)
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))[0];
  if (!ice || !sameStreet(ice.address, address)) return false;
  return !(drafts || []).some((d) => d && (!contactId || d.contactId === contactId)
    && d.qualify?.stage === "qualified" && sameStreet(d.qualify.address || "", address));
}
