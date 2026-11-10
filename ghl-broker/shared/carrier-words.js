// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// carrier-words.js — what gets a text blocked by the phone carriers.
//
// 2026-10-02, Matt's screenshot: Error 30007, "Message blocked due to carrier
// policies", on "…I'm a local investor buying houses as-is, no repairs
// needed. Would the seller consider a cash offer?" Fourteen days of our own
// outbound texts said why: the check-ins and openers that pitched like a
// we-buy-houses ad were blocked 53% of the time to agents who'd never
// answered (26% to ones who had), deal texts carrying a link 32% cold, and
// everything else the app sent 0.6%. The workflow's own opener, a plain
// question about the listing, 0.1%.
//
// Pure. The check-in prompts carry CARRIER_RULE; the reply agent writes a
// flagged machine text again once without these words, and holds it if the
// rewrite still has them.

const RULES = [
  ["cash", /\bcash\b/i],
  ["as-is", /\bas-is\b/i],
  ["investor", /\binvestors?\b/i],
  ["buy houses", /\b(?:buy|buys|buying)\s+(?:houses|homes|properties)\b/i],
  ["no repairs", /\bno repairs?\b|\bany condition\b/i],
  ["quick close", /\b(?:quick|fast)\s+(?:close|closing|sale)\b|\bclose\s+(?:fast|quick(?:ly)?)\b/i],
  ["wholesale", /\bwholesal\w*/i],
  ["a link", /https?:\/\/|\bwww\./i],
];

/** carrierFlags(text) → the blocked-ad words a text uses, in a fixed order. */
export function carrierFlags(text = "") {
  const t = String(text || "");
  return RULES.filter(([, rx]) => rx.test(t)).map(([word]) => word);
}

// The line the check-in and opener prompts carry. One sentence: the words are
// listed after "never write" so a reader (and the tests) can tell the rule
// from the instruction around it.
export const CARRIER_RULE = "Phone carriers block texts that read like a we-buy-houses ad, so in this text never write cash, cash offer, as-is, investor, buy houses, no repairs, quick close, close fast, wholesale or a link. " +
  "Talk about the house or their business in plain words instead (\"is it a bit of a project?\", \"anything that needs work?\").";

// Only for a buyer who has never written back (2026-10-16 and 10-20): a deal
// text that opened by naming the recipient's own buying ("saw in the county
// records you've bought...", "saw your flip on...", "I saw you purchased...")
// was blocked on almost every number, and the same text without the opener
// went through. A buyer who knows us can hear it, so it is not in RULES: the
// send-time check on a cold buyer's deal text (reply-agent.js) reads this.
const COLD_BUYER_RULES = [
  ["county records", /\bcounty\s+records?\b/i],
  ["saw you bought", /\bsaw\s+(?:that\s+)?you(?:'ve|\s+have)?\s+(?:recently\s+|just\s+)?(?:bought|purchased|built|flipped|picked\s+up)\b|\bsaw\s+your\s+(?:recent\s+|new\s+|last\s+)?(?:build|flip)s?\b/i],
];

/** coldBuyerFlags(text) → the openers about their own buying a text to a buyer who never wrote back uses. */
export function coldBuyerFlags(text = "") {
  const t = String(text || "");
  return COLD_BUYER_RULES.filter(([, rx]) => rx.test(t)).map(([word]) => word);
}
