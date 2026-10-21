// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// held-underwrites.js — what to do with an underwrite that stopped on a gate
// and nobody came back to.
//
// On 2026-09-16 "Underwrites that need a look" held 49 rows. Matt: "this is
// going to be a huge bottleneck and I'm not going to get to all of these."
// Read against the conversations and the GHL stage, most of them were not
// decisions at all:
//
//   10  test rows and dry runs, or no address in the message      → junk
//   ~8  the thread had moved on — pending, turnkey, seller said no → over
//   ~14 two weeks old, the agent never wrote again                 → stale
//   ~12 thin comps or too few photos, and the agent could tell us  → ask
//    3  the agent HAD told us and nothing re-ran                   → re-run
//
// leaving a handful that are actually a person's call (a structural flag, an
// address we couldn't place). This module is the triage: one held draft in,
// one verdict out. Pure — the nightly sweep (ghl-broker/held-underwrites.js)
// does the reading and the doing.
//
// The verdicts, in the order they are tried:
//
//   drop    delete the draft: nothing to review (a dry run, a test address, no
//           address at all), or a newer draft / a priced offer on the same
//           house already exists
//   retire  close it out with a status and a reason: the conversation or the
//           GHL stage says this house is over for us
//   rerun   the agent has since told us what it's worth / what the work runs
//           and the holds are exactly the ones those numbers answer — run it
//           again on their figures (agentNumbersRescue in auto-underwrite.js)
//   ask     the holds are answerable by the agent and we haven't asked — one
//           text asking only for the missing piece(s)
//   wait    asked, not yet a week, they haven't answered — leave it alone
//           (`passAt`: when it passes, telling them, unless a number comes)
//   call    asked, and they wrote back without the number — a phone call
//   yours   a person's call

import { addressKey, sameStreet, parseUsAddress, completeAddress } from "./us-address.js";
import { propertyDossier } from "./contact-record.js";
import { aiHoldReasons, effectiveStatus, DEAD_STATUSES, saidYes, DRAFT_ONLY_HOLD } from "./offer-status.js";
import { KIND_HOLD, MOBILE_HOLD, RURAL_HOLD } from "./asset-type.js";
import { pricedByHand } from "./underwrite-model.js";
import { WA_CITY_COORDS } from "./wa-city-coords.js";
import { ourReplyPasses, threadPassed } from "./flip-read.js";
import { owedOnHouse } from "./promise-owed.js";

const DAY_MS = 86400000;
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

/* ---------- what a hold reason is about ---------- */

// The same two patterns agentNumbersRescue keys on: a hold their VALUE
// answers, and a hold their REPAIRS answer. Kept here so the rescue and the
// triage can never disagree about which holds an agent can clear.
export const VALUE_HOLD = /renovated|priced comps?|price proxy|no ARV|ungraded comps|off the subject's size|sold homes? in the search box|square footage is unknown|nothing sold within/i;
export const WORK_HOLD = /past the heavy band|listing photos? to scan/i;
export const JUNK_HOLD = /^dry run|^no property address|AUTO_UNDERWRITE_ENABLED/i;
export const ADDRESS_HOLD = /address was read with|could only be placed at the centre|couldn't locate|didn't resolve to a property record/i;
export const STRUCTURAL_HOLD = /foundation or structural/i;
export const ERROR_HOLD = /^stopped early/i;

/**
 * heldInPlainWords(reason) → what we tell an agent held our numbers
 *
 * The ask used to say "the comps came back thin" whatever the hold was. Clyde
 * Hill (2026-09-24) held on no square footage and no photos with four comps at
 * match 98, and the agent was told our comps were thin. Say what's missing.
 */
export function heldInPlainWords(reason = "") {
  const s = String(reason || "");
  if (s === DRAFT_ONLY_HOLD.split(" — ")[0] || s === DRAFT_ONLY_HOLD) return "Matt is running the numbers himself";
  if (/square footage is unknown/i.test(s)) return "we couldn't pull the square footage on it";
  if (WORK_HOLD.test(s)) return /photo/i.test(s) ? "there aren't enough listing photos to see what it needs" : "the work looks heavy and you want to pin it down";
  if (VALUE_HOLD.test(s)) return "the comps came back thin";
  return "you're missing a piece you need to finish it";
}

/**
 * passReasonInWords(verdict) → the short honest reason we give an agent when
 * the sweep closes out a house we owed them a number on ("promised").
 * Never the sweep's own reason ("held 15 days and nothing since"): that is
 * ours, not theirs.
 */
export function passReasonInWords(t = {}) {
  if (/^turnkey per the agent/i.test(String(t.reason || ""))) return "it's more finished than the fixers we buy";
  const s = String(t.heldReason || "");
  if (/square footage is unknown/i.test(s)) return "we couldn't pin down the square footage to price it";
  if (WORK_HOLD.test(s)) return /photo/i.test(s) ? "there wasn't enough in the photos to size the work" : "the work looked heavier than we could price with confidence";
  if (VALUE_HOLD.test(s)) return "there weren't enough good sales nearby to price it with confidence";
  return "we couldn't get to a number we'd stand behind";
}

/**
 * classifyHolds(held) → { value, work, junk, address, structural, error, other, rescuable }
 *
 * `rescuable`: every hold is one the agent's numbers answer.
 */
export function classifyHolds(held = []) {
  const c = { value: false, work: false, junk: false, address: false, structural: false, error: false, other: false };
  for (const h of held) {
    const s = String(h || "");
    if (JUNK_HOLD.test(s)) c.junk = true;
    else if (STRUCTURAL_HOLD.test(s)) c.structural = true;
    else if (ERROR_HOLD.test(s)) c.error = true;
    else if (ADDRESS_HOLD.test(s)) c.address = true;
    else if (VALUE_HOLD.test(s)) c.value = true;
    else if (WORK_HOLD.test(s)) c.work = true;
    else c.other = true;
  }
  c.rescuable = held.length > 0 && (c.value || c.work) && !c.junk && !c.structural && !c.error && !c.address && !c.other;
  return c;
}

/* ---------- the dials ---------- */

export const STALE_DAYS = 14;          // held this long with no word from them → retire
export const KIND_PASS_HOURS = 24;     // a house that isn't single-family passes after this, unless you underwrite it anyway
export const ASK_WAIT_DAYS = 7;        // asked this long ago, no answer → retire
export const ALIVE_DAYS = 21;          // they wrote within this → the thread is live enough to ask
export const PROMISE_ASK_DAYS = 3;     // a promise_due text this recent already asked

const TEST_ADDRESS = /\btest\b|\bprobe\b/i;
// Read only on a REJECTION, or when the words are unmistakably about this
// house. "A few went pending in the area" (Tim Tilbury) and "it is being sold
// as is" (Slavic Sloboda) both say "pending"/"sold" about a house that is
// still very much for sale — the first dry run (2026-09-16) would have
// retired both.
export const OVER_TEXT = /\b(pending|sold(?!\s+as[- ]is)|under contract|off the market|no longer (available|for sale|on the market)|already (has|have|got|accepted) (an|another|multiple)? ?offers?|accepted (an|another) offer|not interested|won'?t sell|isn'?t selling|not (going to|gonna) sell|withdrawn|cancell?ed)\b/i;
export const OVER_PLAIN = /\b(it'?s|it is|this (one|property|house|listing)|that (one|property|house|listing)|the (property|house|listing)|she'?s|he'?s|they'?re|seller is)\s+(is |was |went |has gone |are |went )?(already |now |just |currently |still )?(pending|under contract|sold(?!\s+as[- ]is)|off the market|no longer (available|for sale)|not interested|withdrawn)\b/i;
// Of those, the ones that say the house itself is gone. 2617 Cottage Rd E
// (2026-09-15): "already pending" was filed as their pass, and a passed house
// gets a check-in every ten days. Gone is nobody's pass — the house is no
// longer available, and nothing chases it. A seller's no, or "they have
// other offers", is still a house for sale. The reply agent reads the same
// words on a live offer (houseGone).
export const GONE_TEXT = /\b(pending|sold(?!\s+as[- ]is)|under contract|off the market|no longer (available|for sale|on the market)|accepted (an|another) offer|withdrawn)\b/i;
// An offer already in short-sale (bank) approval is a house that's taken,
// the same as pending. 1638 119th St S (2026-10-13): an agent saying the
// seller already had an offer working through short-sale approval was read
// as a first no and the offer stayed sent. A short sale still taking offers
// ("any offer will need short sale approval") is not gone: the offer has to
// be one they already have.
export const TAKEN_TEXT = /\b(?:have|has|got|there'?s|there is|is)\s+(?:already\s+|now\s+)?(?:an|one|a)\s+(?:accepted\s+)?offer\b[^.!?\n]{0,60}?\b(?:short[- ]?sale|bank|lender)\b[^.!?\n]{0,15}?\b(?:approval|process)\b|\bapproval\s+(?:on|for)\s+(?:the|their|our)\s+(?:current|existing|accepted)\s+offer\b|\b(?:have|has|got)\s+(?:already\s+)?an\s+accepted\s+offer\b/i;
// In escrow with someone else, and we'd be the backup: taken, the same as
// pending. 19021 46th Ave S (2026-10-05): "a full price offer is in escrow,
// the other one is the backup" left our offer
// open, and the house sat in Tier 1. Read on any intent, but only when the
// escrow is someone else's ("another offer", "the full price offer", "in
// escrow with another buyer", "you'd be backup"): "we're in escrow!" on a
// deal of ours is good news, and a deal is never marked by this anyway
// (pickOfferForStatus skips deals).
export const ESCROW_TEXT = /\b(?:another|other|their|a\s+different|(?:the|a|an)\s+(?:full[- ]price|cash|higher|better))\s+(?:buyer'?s?\s+)?offers?\s+(?:is\s+|went\s+|are\s+)?(?:now\s+|already\s+)?(?:in|into)\s+escrow\b|\bin\s+escrow\s+with\s+(?:another|a\s+different|other|someone)\b|\b(?:taking|accepting)\s+back[- ]?up\s+offers?\b|\b(?:considered|you'?re|you\s+are|you'?d\s+be|you\s+would\s+be|yours\s+(?:is|would\s+be))\s+(?:the\s+|a\s+|in\s+)?back[- ]?up\b/i;
// Strict on its own (OVER_PLAIN names the house); loose on a rejection.
export const houseGone = (text = "", intent = "") => {
  const t = String(text || "");
  return (GONE_TEXT.test(t) && (intent === "rejection" || OVER_PLAIN.test(t)))
    || (TAKEN_TEXT.test(t) && intent === "rejection")
    || ESCROW_TEXT.test(t);
};
/**
 * saysTurnkey(text) → boolean
 *
 * The agent told us the house needs nothing: turnkey, renovated, remodeled,
 * move-in ready, "not a project". Deliberately NOT true when the same words
 * say it needs work ("renovated kitchen but it's a project", "could use some
 * fix ups"), or put the turnkey word behind a negation or a "has to be".
 * The reply agent reads the same words (isTurnkeyReply).
 */
// "certainly not a fix n flip", "not a fixer", "it's not a flip", "not a
// project": the agent telling us, in our own words, it isn't what we buy
// (Ryan Bowen, 13814 214th St E, 2026-10-05; 2026-10-09 "It is not a
// project. Its a great home" got priced, floated and papered).
const NOT_A_FLIP = /\b(?:not|isn'?t|is\s+not|wouldn'?t\s+be)\s+(?:really\s+|certainly\s+|exactly\s+|quite\s+)?(?:a\s+|an\s+)?(?:fixer(?:[\s-]?upper)?|fix[\s-]*(?:n|and|&|'n'?|n')[\s-]*flip|flip(?:per)?|project)\b/gi;
export function saysTurnkey(text = "") {
  const t = String(text || "");
  NOT_A_FLIP.lastIndex = 0;
  const notFlip = NOT_A_FLIP.test(t);
  // Read "needs work" with those phrases taken out: "not a fixer" says fixer.
  const rest = notFlip ? t.replace(NOT_A_FLIP, " ") : t;
  const done = /\b(turn[\s-]?key|move[\s-]?in[\s-]?ready|(?:fully|completely|recently|totally|newly|just)\s+(?:renovated|remodell?ed|updated|redone|flipped)|(?:was|been|is|it's|its)\s+(?:renovated|remodell?ed|flipped)|no\s+work\s+(?:needed|to\s+do|required)|doesn'?t\s+need\s+(?:any(?:thing)?\s+)?work|nothing\s+to\s+(?:do|fix))\b/i;
  const needsWork = /\b(needs?\s+(?:some\s+|a\s+lot\s+of\s+|lots\s+of\s+)?(?:work|tlc|love|repairs?|updating)|fix[\s-]?ups?|fixer|project|tlc|dated|as[\s-]?is|handyman|rough|distressed|cosmetics?|(?:never|not|poorly)\s+maintained|deferred\s+maintenance)\b/i;
  if (needsWork.test(rest)) return false;
  if (notFlip) return true;
  if (!done.test(t)) return false;
  // "No, it's not turnkey, but it's all cosmetic" (Paul Redal, 2026-09-21)
  // answers our own "project or turnkey?" with a no. A turnkey word with a
  // negation just ahead of it is the opposite of turnkey — and so is "it has
  // to be turn key" (1425 33rd St SE, 2026-10-10): the finished house has to
  // be, to sell, so this one needs the work.
  const negated = new RegExp(`\\b(?:not|isn'?t|is\\s+not|wasn'?t|never|hardly|far\\s+from|no\\s+longer|nothing(?:\\s+has|\\s+was)?(?:\\s+been)?|hasn'?t\\s+been|needs?\\s+to\\s+be|has\\s+to\\s+be|have\\s+to\\s+be|must\\s+be|got\\s+to\\s+be|gotta\\s+be)\\s+(?:\\w+\\s+){0,2}?(?:${done.source})`, "i");
  return !negated.test(t);
}

/**
 * agentRuledOut(events, address) → { why } | null
 *
 * The agent told us THIS house is not a project — turnkey, move-in ready,
 * "not a project", no work needed — and it's on the record as the house's
 * own details (property_details: condition or workNeeded). Nothing the
 * machine does by itself puts a number on it: no underwrite from the
 * workflow, no float, no paper. A person can still (Underwrite anyway, a
 * hand-made offer, a send they press).
 */
export function agentRuledOut(events = [], address = "") {
  if (!String(address || "").trim()) return null;
  // Their latest word on the house: "turnkey" then "actually it needs a
  // roof" is a house with work — and so is "turnkey" then a rehab number.
  const latest = (events || [])
    .filter((e) => e?.address && sameStreet(e.address, address) && (
      (e.type === "property_details" && (e.data?.workNeeded || e.data?.condition))
      || (e.type === "agent_estimate" && Number(e.data?.rehab) > 0)))
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))[0];
  if (!latest || latest.type === "agent_estimate") return null;
  const said = [latest.data.workNeeded, latest.data.condition].map((x) => String(x || "")).filter(Boolean).join(" — ");
  return saysTurnkey(said) || /^\s*none\b/i.test(String(latest.data.workNeeded || ""))
    ? { why: `the agent said it isn't a project ("${said.slice(0, 60)}")`, said: String(latest.data.condition || latest.data.workNeeded) } : null;
}

// What the nightly sweep passes on when a held house was never priced and
// went quiet, or was misread as turnkey: nothing about the house itself.
const QUIET_PASS = /^(turnkey per the agent|held \d+ days and nothing since|we asked for their read a week ago|our ask for their numbers (never went out|didn't go out))/i;

/**
 * reopensOnTheirNumbers(offer) → boolean
 *
 * Matt, 2026-10-11 (1425 33rd St SE): "even though we passed,
 * if the numbers work out we should proceed." A house the nightly sweep
 * passed on before any number of ours went out — quiet, or read as turnkey —
 * isn't closed to the agent's own numbers: they run it again. A pass on the
 * kind of house (a condo, rural, out of the area), a pass a person made, and
 * a house we already put a number on stay what they are.
 */
export function reopensOnTheirNumbers(offer = null) {
  if (!offer || effectiveStatus(offer) !== "we_passed") return false;
  if (offer.retired?.by !== "held-sweep" || !QUIET_PASS.test(String(offer.retired.reason || ""))) return false;
  if (Number(offer.cashAmount) > 0) return false;
  return !(offer.sends || []).some((s) => Object.values(s?.results || {}).some((r) => r?.ok));
}
const COLD_STAGE = /^tier\s*3\b|passed on offer|^lost\b|not a good deal/i;
const CLOSED_OPP = /^(lost|abandoned|abandon)$/i;

/**
 * triageHeldUnderwrite({ offer, siblings, events, drafts, contact, opportunities, botOffTags, now })
 *   → { action, reason, status?, needs?, anchorAt, heldReason }
 *
 *   offer          the held draft (lean row is enough: address, contactId,
 *                  createdAt/updatedAt, askingPrice, autoUnderwrite.held)
 *   siblings       this contact's other offers (lean)
 *   events         this contact's timeline (any types)
 *   drafts         this contact's reply drafts, any status
 *   contact        { tags: [], dnd: bool } from GHL, or null when unread
 *   opportunities  [{ stageName, status }] from GHL, or []
 *   brought        the agent brought us this house (shared/lead-source.js):
 *                  their card's cold stage is not a reason to close it
 *   botOffTags     the routing's bot-off tags (lower-case)
 *   knownCities    Set of city slugs we buy in (knownCitiesFrom), or null to
 *                  skip the area check
 *   knownAddresses full addresses we hold for this agent (auto-underwrite.js
 *                  knownAddressesFor): a street the map missed is finished
 *                  from these before the agent is asked
 */
export function triageHeldUnderwrite(args = {}) {
  const t = triageCore(args);
  // 2026-10-14: houses we'd told the agent we'd price were closed out here
  // quietly, and the agent who was waiting on us never heard. A close the
  // sweep makes by itself (stale, no answer, turnkey), on a house we owe a
  // number on or whose last word from them we never answered, tells them:
  // we're out, why, send the next one. Behind heldTriage.passOnRetire it
  // sends itself; otherwise it waits for you (ghl-broker/held-underwrites.js).
  if (t.action !== "retire" || t.status !== "we_passed" || t.passNote || !QUIET_PASS.test(t.reason)) return t;
  const owed = owedOnHouse({ events: args.events, drafts: args.drafts, offers: args.siblings, address: args.offer?.address, now: args.now ?? Date.now() });
  return owed ? { ...t, passNote: "promised", promised: owed } : t;
}

function triageCore({
  offer, siblings = [], events = [], drafts = [], contact = null, opportunities = [], botOffTags = ["stop bot", "bot-off"], now = Date.now(),
  knownCities = null, brought = false, knownAddresses = [],
} = {}) {
  const held = aiHoldReasons(offer);
  const cls = classifyHolds(held);
  const heldReason = String(held[0] || "").split(" — ")[0];
  const address = String(offer?.address || "").trim();
  const heldAt = ms(offer?.autoUnderwrite?.finishedAt) ?? ms(offer?.updatedAt) ?? ms(offer?.createdAt) ?? now;
  const heldDays = Math.floor((now - heldAt) / DAY_MS);
  const base = { anchorAt: new Date(heldAt).toISOString(), heldReason, held };
  const onThisHouse = (a) => Boolean(address) && Boolean(a) && sameStreet(a, address);
  const aboutThisHouse = (a) => !a || onThisHouse(a);   // no address named = the one house we're on

  /* --- 1. drop: nothing to review --- */
  if (!address || cls.junk || TEST_ADDRESS.test(address)) {
    return { ...base, action: "drop", reason: !address ? "no address on the draft" : cls.junk ? heldReason : "a test address" };
  }
  // "Potter, Pasco", "Wetmore Property" (2026-10-02): no number anywhere is
  // no house — nothing to place on a map, nothing for Matt to fix. Any digit
  // keeps it: "Lot 27, 1510 Maple Ln" and "N 1234 Division St" are houses.
  if (!/\d/.test(address)) return { ...base, action: "drop", reason: "no street number — nothing to place on a map" };
  const mine = siblings.filter((s) => s && s.id !== offer.id && onThisHouse(s.address));
  const priced = mine.find((s) => Number(s.cashAmount) > 0 && effectiveStatus(s) !== "draft");
  if (priced) return { ...base, action: "drop", reason: `a priced offer (${effectiveStatus(priced)}) already exists on this house` };
  const newer = mine.find((s) => effectiveStatus(s) === "draft" && (ms(s.createdAt) ?? 0) > (ms(offer.createdAt) ?? 0));
  if (newer) return { ...base, action: "drop", reason: "a newer draft on the same house replaced it" };

  // A held draft Matt reopened and is pricing by income or by the acre
  // (shared/underwrite-model.js) is his: the sweep never retires it or texts
  // the agent "single-family only" about it.
  if (pricedByHand(offer)) return { ...base, action: "yours", reason: "you're pricing it by income or land value — the sweep leaves it to you" };

  /* --- 2. retire: the house is over for us --- */
  const tags = (contact?.tags || []).map((t) => String(t).toLowerCase());
  if (contact?.dnd) return { ...base, action: "retire", status: "we_passed", reason: "they unsubscribed" };
  if (events.some((e) => e?.type === "unsubscribed")) return { ...base, action: "retire", status: "we_passed", reason: "they unsubscribed" };
  const off = tags.find((t) => botOffTags.includes(t));
  if (off) return { ...base, action: "retire", status: "we_passed", reason: `the bot is off for this contact (tag: ${off})` };
  // They said yes to our number on this house (2026-10-15: a yes on a house
  // we'd walked from was answered "we've moved on"). Nothing the sweep does
  // by itself closes it: it's Matt's.
  const yes = saidYes({ offers: siblings, drafts, events, address, now });
  if (yes) return { ...base, action: "yours", reason: `they said yes to our number on this house (${yes.at.slice(0, 10)}) — the sweep never closes it` };
  // The agent's card in a cold stage is about the agent, not this house: a
  // house they BROUGHT us (shared/lead-source.js) is never retired for it.
  // 2026-10-09: 20 brought houses were closed this way, never priced — the
  // agents had said "it's turnkey" about our opener (TIER 3) and then sent
  // their next house, the way every off-market deal with a buyer came.
  const opp = opportunities.find((o) => CLOSED_OPP.test(String(o?.status || "")) || (!brought && COLD_STAGE.test(String(o?.stageName || ""))));
  if (opp) return { ...base, action: "retire", status: "we_passed", reason: CLOSED_OPP.test(String(opp.status || "")) ? `GHL opportunity ${String(opp.status).toLowerCase()}` : `GHL stage: ${opp.stageName}` };

  const after = (t) => (ms(t) ?? 0) >= heldAt - 60 * 60000;   // the hold's own inbound counts
  const houseEvents = events.filter((e) => e?.address && onThisHouse(e.address));
  // A pass the sweep made on an earlier, never-priced row is not this re-run's
  // pass: the agent's numbers reopened it (reopensOnTheirNumbers).
  const passedEv = houseEvents.find((e) => (e.type === "offer_passed" || e.type === "offer_we_passed")
    && !(e.data?.by === "held-sweep" && (ms(e.at) ?? 0) < heldAt));
  if (passedEv) return { ...base, action: "retire", status: passedEv.type === "offer_passed" ? "passed" : "we_passed", reason: passedEv.type === "offer_passed" ? "they passed on this house" : "we passed on this house" };
  // We already told them we're passing on it (Matt, 2026-10-14). Dana F.'s
  // Welfare Ave: "probably not enough meat for us", then an
  // underwrite held on the map, then "can you confirm the full address?" at
  // the 7pm check — on a house we'd turned down that afternoon.
  const ourWord = drafts
    .filter((d) => d && d.status === "sent" && d.propertyAddress && onThisHouse(d.propertyAddress))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0];
  const qualified = threadPassed({ address, drafts });
  if ((qualified && qualified.stage !== "ask") || (ourWord && ourReplyPasses(ourWord.sentText || ourWord.reply))) {
    return { ...base, action: "retire", status: "we_passed", reason: "we told them we're passing on this house" };
  }
  const ruledOut = agentRuledOut(houseEvents, address);
  if (ruledOut) return { ...base, action: "retire", status: "we_passed", reason: `turnkey per the agent ("${ruledOut.said.slice(0, 60)}")` };
  const said = drafts
    .filter((d) => d && String(d.inbound || "").trim() && aboutThisHouse(d.propertyAddress) && after(d.createdAt))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const over = said.find((d) => (d.intent === "rejection" && OVER_TEXT.test(d.inbound)) || OVER_PLAIN.test(d.inbound));
  if (over) {
    return GONE_TEXT.test(over.inbound)
      ? { ...base, action: "retire", status: "unavailable", reason: `it's no longer available (they said "${clip(over.inbound)}")` }
      : { ...base, action: "retire", status: "passed", reason: `they said "${clip(over.inbound)}"` };
  }
  // On a house they brought, "turnkey" retires it only when they said it
  // about THIS house: on 2026-10-02 an agent called her other listing
  // turnkey and the fixer she had just sent us was closed out. Their
  // unaddressed "it's turnkey" is about the listing we opened with.
  const turnkey = said.find((d) => saysTurnkey(d.inbound) && (brought ? onThisHouse(d.propertyAddress) : true));
  if (turnkey) return { ...base, action: "retire", status: "we_passed", reason: `turnkey per the agent ("${clip(turnkey.inbound)}")` };

  const lastIn = latestInbound(drafts, events);
  const asked = events
    .filter((e) => e?.type === "audit_action" && e.data?.kind === "held_ask" && (e.offerId === offer.id || onThisHouse(e.address)))
    .map((e) => ms(e.at)).filter((t) => t != null).sort((a, b) => b - a)[0] ?? null;
  const silentSince = Math.max(heldAt, lastIn ?? 0, asked ?? 0);
  if (now - silentSince >= STALE_DAYS * DAY_MS) {
    return { ...base, action: "retire", status: "we_passed", reason: `held ${heldDays} days and nothing since` };
  }
  // Draft only (2026-10-16): the house is Matt's to price, so it waits for
  // him, not for them. Asked once for their read (step 3c), then his.
  const draftOnly = held.includes(DRAFT_ONLY_HOLD);
  // A hold their numbers could clear has its own week, with a note (step 5).
  if (!cls.rescuable && !draftOnly && asked != null && (lastIn == null || lastIn < asked) && now - asked >= ASK_WAIT_DAYS * DAY_MS) {
    return { ...base, action: "retire", status: "we_passed", reason: "we asked for their read a week ago and heard nothing" };
  }

  /* --- 3. rural: two acres or more (Matt, 2026-10-08) --- */
  // Harder to comp, and our buyers don't want it. No day to wait, unlike a
  // house that isn't single-family: passed at the next check, and the agent
  // hears we can't do rural. "Underwrite anyway" before then still prices it.
  const rural = held.find((h) => RURAL_HOLD.test(String(h || "")));
  if (rural) return { ...base, action: "retire", status: "we_passed", passNote: "rural", reason: String(rural) };

  /* --- 3, also: a mobile home (Matt, 2026-10-13: not as a rule) --- */
  // Same as rural: passed at the next check, and the agent hears we don't
  // buy mobile or manufactured homes. "Underwrite anyway" before then still prices it.
  const mobile = held.find((h) => MOBILE_HOLD.test(String(h || "")));
  if (mobile) return { ...base, action: "retire", status: "we_passed", passNote: "manufactured", reason: String(mobile) };

  /* --- 3a. not our kind of house (2026-10-01: single-family only) --- */
  // Whether to price a mobile home or a duplex anyway is a person's call —
  // for a day (Matt, 2026-10-04: the app should do everything else). Then
  // the house is passed, and the agent hears we're single-family only.
  const kind = held.find((h) => KIND_HOLD.test(String(h || "")));
  if (kind) {
    const passAt = heldAt + KIND_PASS_HOURS * 3600000;
    if (now >= passAt) return { ...base, action: "retire", status: "we_passed", passNote: "kind", reason: String(kind) };
    return { ...base, action: "wait", passAt: new Date(passAt).toISOString(), reason: `${kind} — passes after a day unless you underwrite it anyway` };
  }

  /* --- 3b. an address the map couldn't place ("818 Popular, Edmonds") --- */
  // First, the address we already hold: a listing of theirs from RentCast,
  // our outreach text, a house in the book (`knownAddresses`). The same
  // number on the same street with a city on it is this house — re-run on
  // that, and nobody is asked (Matt, 2026-10-14: "we should have that
  // information from RentCast"). Only a street we can't place is asked about.
  const miss = held.find((h) => MAP_MISS.test(String(h || "")));
  const placed = miss
    ? completeAddress(address, { candidates: knownAddresses }).find((a) => a !== address && parseUsAddress(a).city)
    : null;
  if (placed) return { ...base, action: "rerun", address: placed, needs: [], reason: `${clip(miss)} — re-run as ${placed.split(",").slice(0, 2).join(",")}` };
  // Ask them to confirm the street; their answer re-runs it.
  if (miss) {
    const lastText = latestInbound(drafts, events);
    if (asked != null && (lastText == null || lastText < asked)) return { ...base, action: "wait", needs: ["address"], reason: "asked them to confirm the address, waiting" };
    const alive = (lastText != null && now - lastText <= ALIVE_DAYS * DAY_MS) || heldDays <= 3;
    if (alive) return { ...base, action: "ask", needs: ["address"], reason: `${clip(miss)} — ask them to confirm the street address` };
  }

  /* --- 3c. draft only: ask their read once, then it's Matt's (2026-10-20) --- */
  // No Today: until he prices it, nothing texted the agent at all. Their read
  // (what it's worth done, what it needs, what the seller would take) is for
  // him to price with; the machine never prices from it.
  if (draftOnly) {
    if (asked != null) return { ...base, action: "yours", needs: [], reason: "asked for their read — waiting on your number" };
    const live = (lastIn != null && now - lastIn <= ALIVE_DAYS * DAY_MS) || heldDays <= 3;
    if (!live) return { ...base, action: "yours", needs: [], reason: `they haven't written in ${Math.floor((now - (lastIn ?? heldAt)) / DAY_MS)} days — waiting on your number` };
    const promised = drafts.some((d) => d?.outbound?.kind === "promise_due" && aboutThisHouse(d.propertyAddress) && now - (ms(d.createdAt) ?? 0) <= PROMISE_ASK_DAYS * DAY_MS && d.status !== "dismissed");
    if (promised) return { ...base, action: "wait", needs: [], reason: "the promise sweep just told them" };
    return { ...base, action: "ask", needs: ["value", "work", "take"], reason: "ready for your comps — ask the agent's read so you have it" };
  }

  /* --- 4. re-run on their numbers --- */
  if (cls.rescuable) {
    // The dossier keys on the exact address; the agent's take often carries a
    // unit the draft doesn't ("2500 Alder St, Unit 15" — Helen Hendricks,
    // 2026-09-15). Same street line is the same house here.
    const d = propertyDossier(houseEvents.map((e) => ({ ...e, address })), address);
    const needs = [cls.value ? "value" : "", cls.work ? "work" : ""].filter(Boolean);
    const have = { value: Number(d?.have?.arv?.value) > 0, work: Number(d?.have?.rehab?.value) > 0 };
    const haveAll = needs.every((n) => have[n]);
    if (haveAll) {
      const newest = Math.max(...needs.map((n) => ms(n === "value" ? d.have.arv.at : d.have.rehab.at) ?? 0));
      // Priced against already: the run that held saw these numbers (or a
      // re-run on them held again). Nothing new to run on — it is a person's.
      if (newest > heldAt) {
        const askingPrice = Number(offer?.askingPrice) || Number(d?.have?.sellerAsk?.value) || 0;
        if (cls.value && !(askingPrice > 0)) {
          return { ...base, action: "yours", needs, reason: `they gave a value but there's no list price to bound it against (${heldReason})` };
        }
        return { ...base, action: "rerun", needs, askingPrice, anchorAt: new Date(newest).toISOString(),
          reason: `they told us ${needs.map((n) => (n === "value" ? `it's worth ${k(d.have.arv.value)}` : `the work runs ${k(d.have.rehab.value)}`)).join(" and ")} — run it on their numbers` };
      }
      return { ...base, action: "yours", needs, reason: `their numbers didn't clear it either (${heldReason})` };
    }

    /* --- 5. ask for the missing piece, once --- */
    const missing = needs.filter((n) => !have[n]);
    // The sweep claims an ask on the hold and never asks it again
    // (carryOutHeldVerdict). 3228 S 164th St (2026-10-05) was asked, wrote
    // back without a number, and then read "ask" every night against a claim
    // that would never let it go: on the Desk as the machine's with nothing
    // coming. After the ask, an answer without the number is a conversation
    // for a person; silence, or an ask that never went out (13536 SW 171st
    // St, dismissed), passes a week on and tells them so.
    if (asked != null) {
      const sentAt = askSentAt(drafts, aboutThisHouse);
      if (sentAt != null && lastIn != null && lastIn > sentAt) {
        return { ...base, action: "call", needs: missing, reason: `we asked what ${askFor(missing)} and they wrote back without a number — worth a call (${heldReason})` };
      }
      const since = sentAt ?? asked;
      const passAt = since + ASK_WAIT_DAYS * DAY_MS;
      if (now >= passAt) {
        return { ...base, action: "retire", status: "we_passed", passNote: "numbers",
          reason: sentAt != null ? "we asked for their read a week ago and got no number" : "our ask for their numbers never went out, and a week has passed" };
      }
      return { ...base, action: "wait", needs: missing, passAt: new Date(passAt).toISOString(),
        reason: sentAt != null ? `asked ${Math.floor((now - sentAt) / DAY_MS)}d ago, waiting on their number` : "our ask for their numbers didn't go out" };
    }
    const alive = (lastIn != null && now - lastIn <= ALIVE_DAYS * DAY_MS) || heldDays <= 3;
    if (!alive) return { ...base, action: "yours", needs: missing, reason: `they haven't written in ${Math.floor((now - (lastIn ?? heldAt)) / DAY_MS)} days (${heldReason})` };
    // The promise sweep already asks this exact question when a promise is
    // owed on a held underwrite (promise_due with heldReason) — one asker.
    const promised = drafts.some((d) => d?.outbound?.kind === "promise_due" && aboutThisHouse(d.propertyAddress) && now - (ms(d.createdAt) ?? 0) <= PROMISE_ASK_DAYS * DAY_MS && d.status !== "dismissed");
    if (promised) return { ...base, action: "wait", needs: missing, reason: "the promise sweep just asked them" };
    return { ...base, action: "ask", needs: missing, reason: `${heldReason} — ask what ${askFor(missing)}` };
  }

  /* --- 5b. outside the area we buy in (2026-10-04) --- */
  // A town we've never priced a house in and that isn't on our map: 102 W
  // Pearl St, Oakesdale (Whitman County) sat on the Desk for a week. Only
  // here, after anything their numbers could clear: a thin-comps hold in a
  // town we just haven't priced yet is asked about, never passed.
  if (knownCities && outsideArea(address, knownCities)) {
    return { ...base, action: "retire", status: "we_passed", passNote: "area", reason: `outside the area we buy in (${cityName(cityOf(address)) || parseUsAddress(address).state})` };
  }

  /* --- 6. a person's call --- */
  return { ...base, action: "yours", reason: heldReason };
}

// The newest word from them, from drafts (a row per inbound) and summaries.
export function latestInbound(drafts = [], events = []) {
  const ts = [
    ...drafts.filter((d) => d && String(d.inbound || "").trim()).map((d) => ms(d.createdAt)),
    ...events.filter((e) => e?.type === "text_summary" || e?.type === "call_summary").map((e) => ms(e.at)),
  ].filter((t) => t != null);
  return ts.length ? Math.max(...ts) : null;
}

// When our ask for their numbers on this house went out, if it did. A
// claimed ask can still have been held and dismissed without going.
function askSentAt(drafts = [], about = () => true) {
  return drafts
    .filter((d) => d?.outbound?.kind === "take_ask" && d.status === "sent" && about(d.propertyAddress || d.outbound?.address))
    .map((d) => ms(d.sentAt || d.updatedAt)).filter((t) => t != null).sort((a, b) => b - a)[0] ?? null;
}
const askFor = (needs = []) => needs.map((n) => (n === "value" ? "it's worth fixed up" : "the work would run")).join(" and ");

// "couldn't locate 818 Popular, Edmonds on the map"
const MAP_MISS = /couldn't locate .+ on the map/i;

/**
 * cityOf("102 W Pearl St, Oakesdale, WA") → "oakesdale"
 *
 * The city as the address parser reads it (a unit, a missing comma, "Mt"
 * for "Mount" all handled), slugged like wa-city-coords.js. "" when the
 * parser can't find one — and then nothing is judged on it.
 */
export function cityOf(address = "") {
  const city = String(parseUsAddress(address).city || "").toLowerCase()
    .replace(/^mt\.?\s+/, "mount ").replace(/^st\.?\s+/, "saint ")
    .replace(/[^a-z\s-]/g, "").trim().replace(/\s+/g, "-");
  return city;
}

/** outsideArea(address, knownCities) → true only when the parser is sure: another state, or a WA town we don't know. */
export function outsideArea(address = "", knownCities = null) {
  if (!knownCities) return false;
  const p = parseUsAddress(address);
  const state = String(p.state || "").toUpperCase();
  if (state && state !== "WA") return true;
  const city = cityOf(address);
  return Boolean(city) && !knownCities.has(city);
}
const cityName = (slug) => slug.split("-").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");

/**
 * knownCitiesFrom(offers) → Set of city slugs we buy in
 *
 * Every town on our map (wa-city-coords.js), and every town we've put a
 * number on — a priced, non-draft offer anywhere in the book.
 */
export function knownCitiesFrom(offers = []) {
  const out = new Set(Object.keys(WA_CITY_COORDS));
  for (const o of offers || []) {
    if (!o || !(Number(o.cashAmount) > 0) || effectiveStatus(o) === "draft") continue;
    const c = cityOf(o.address);
    if (c) out.add(c);
  }
  return out;
}

/**
 * heldOnTheMachine(offer, { knownCities, now }) → { what, at } | null
 *
 * For the Desk: a held underwrite whose verdict is plain from the row alone
 * — nothing to place, outside our area, not our kind of house, an address
 * to confirm — is the machine's tonight, not a decision. Anything that
 * needs the thread to judge is null (last night's verdict stands).
 */
export function heldOnTheMachine(offer, { knownCities = null, now = Date.now() } = {}) {
  const held = aiHoldReasons(offer);
  if (!held.length) return null;
  const cls = classifyHolds(held);
  const address = String(offer?.address || "").trim();
  if (!address || cls.junk || TEST_ADDRESS.test(address) || !/\d/.test(address)) return { what: "dropped at the 7pm check — nothing to place" };
  const rural = held.find((h) => RURAL_HOLD.test(String(h || "")));
  if (rural) return { what: `passed at the 7pm check — ${String(rural).split(" (")[0].replace(/^rural — /, "rural: ")}; we buy under 2 acres` };
  if (held.some((h) => MOBILE_HOLD.test(String(h || "")))) return { what: "passed at the 7pm check — a mobile home; we don't buy mobile or manufactured homes" };
  if (held.some((h) => KIND_HOLD.test(String(h || "")))) {
    const heldAt = ms(offer?.autoUnderwrite?.finishedAt) ?? ms(offer?.updatedAt) ?? ms(offer?.createdAt) ?? now;
    return { what: "passed unless you underwrite it anyway — we buy single-family only", at: new Date(heldAt + KIND_PASS_HOURS * 3600000).toISOString() };
  }
  if (held.some((h) => MAP_MISS.test(String(h || "")))) return { what: "finds it from their listing, or asks them to confirm the street, at the 7pm check" };
  // Outside our area, when nothing their numbers could clear is in the way.
  if (!cls.rescuable && outsideArea(address, knownCities)) return { what: `passed at the 7pm check — outside the area we buy in (${cityName(cityOf(address))})` };
  return null;
}

export const HELD_ACTIONS = ["drop", "retire", "rerun", "ask", "wait", "call", "yours"];

// The line the sweep writes on the timeline and in the GHL note.
export function retireNote(offer, t) {
  return `Held underwrite on ${String(offer?.address || "").split(",")[0]} closed out by the nightly sweep — ${t.reason}.`;
}

const clip = (s, n = 70) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const k = (n) => `${Math.round(Number(n) / 1000)}k`;

// For a same-street check that tolerates a unit suffix the agent added later
// ("2500 Alder St" vs "2500 Alder St, Unit 15").
export const houseKey = (a) => addressKey(String(a || "").split(",")[0]);
export { DEAD_STATUSES };
