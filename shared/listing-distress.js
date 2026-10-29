// listing-distress.js — does the listing itself say the house needs work?
//
// Matt, 2026-10-17: "we're simply reaching out on a listing that has distress
// signals. We should definitely double-check that it has distress signals."
// The 10/16 sweep texted 375 agents off RentCast's numbers alone (a price cut
// or built before 1980), and the answers were "it's move in ready", "it's new
// construction", "it's pending", "did you look at the listing?". RentCast has
// no remarks; Zillow's page for the listing does, and says whether it's still
// for sale. This reads that page's status and description before anyone is
// texted about it.
//
// A short sale or a bank-owned listing is out of the buy box (Matt,
// 2026-10-29), however much work it needs: no agent is texted about it.
//
// Pure. The sweep (ghl-broker/outreach-sweep.js) applies it when
// outreachAutopilot.distressCheck is on.

import { bankSaleIn } from "./flip-read.js";

// Words a listing uses when the house needs work. Any one of these is enough,
// even beside a "remodeled" ("kitchen remodeled in 1998, now needs TLC").
const STRONG = [
  ["fixer", /\bfixer(?:[\s-]?upper)?s?\b/i],
  ["TLC", /\btlc\b|\btender\s+loving\s+care\b/i],
  ["as-is", /\bas[\s-]is\b/i],
  ["handyman or contractor special", /\bhandy(?:man|person)\b|\bcontractors?'?s?\s+special\b|\bdiy\b/i],
  ["investor special", /\binvestors?\s+(?:special|alert|dream|opportunity)\b|\bflip(?:pers?|ping)?\b|\brehab(?:ber)?s?\b|\bbuild\s+(?:some\s+)?equity\b/i],
  ["sweat equity", /\bsweat[\s-]equity\b/i],
  ["bring your vision", /\bbring\s+your\s+(?:own\s+)?(?:vision|ideas|imagination|tools|contractor|paint\s*brush|hammer|creativity|design)\b/i],
  ["needs work", /\bneeds?\s+(?:some\s+|a\s+lot\s+of\s+|lots\s+of\s+|significant\s+|major\s+|extensive\s+|substantial\s+|a\s+little\s+|work\s+and\s+)?(?:work|repairs?|updating|updates|renovation|remodel(?:ing)?|rehab|love|attention|everything)\b|\bin\s+need\s+of\b/i],
  ["cash buyers", /\bcash\s+(?:only|buyers?|offers?)\b|\bnot\s+(?:fha|va|conventional\s+)?(?:financeable|eligible\s+for\s+financing)\b|\bwon'?t\s+(?:qualify|appraise)\b/i],
  ["estate or probate", /\bestate\s+sale\b|\bprobate\b|\btrust\s+sale\b|\bpersonal\s+representative\b|\bexecut(?:or|rix)\b/i],
  ["deferred maintenance", /\bdeferred\s+maintenance\b|\bneglected\b|\bvacant\s+for\s+years\b/i],
  ["structural or water", /\bfoundation\s+(?:issues?|problems?|repairs?|work)\b|\bmold\b|\bwater\s+damage\b|\bfire\s+damage\b|\bstructural\b/i],
  ["teardown", /\btear[\s-]?down\b|\bland\s+value\b|\bvalue\s+(?:is\s+)?in\s+the\s+land\b|\bbuilders?\s+(?:opportunity|special|alert)\b/i],
  ["unfinished", /\bunfinished\s+(?:project|remodel|renovation)\b|\bproject\s+(?:home|house|property)\b/i],
];

// Softer words: a dated house, or an agent hinting. Enough on its own only
// when nothing says the house is finished.
const SOFT = [
  ["dated", /\bdated\b|\boriginal\s+(?:condition|kitchen|baths?|bathrooms?|cabinets|carpet)\b|\btime\s+capsule\b/i],
  ["make it your own", /\bmake\s+it\s+your\s+own\b|\bput\s+your\s+(?:own\s+)?(?:touch|stamp|finishing\s+touches)\b|\bupdate\s+(?:it\s+)?to\s+your\s+(?:taste|liking)\b|\bcustomi[sz]e\s+to\s+your\b/i],
  ["investors", /\binvestors?\b/i],
  ["potential", /\b(?:lots\s+of|tons\s+of|great|huge|endless|so\s+much)\s+potential\b/i],
  ["opportunity", /\b(?:investment|rare|great)\s+opportunity\b|\bopportunity\s+(?:knocks|awaits)\b/i],
  ["priced for condition", /\bpriced\s+(?:accordingly|to\s+reflect|for\s+(?:condition|repairs))\b|\bsold\s+in\s+(?:its\s+)?(?:present|current)\s+condition\b/i],
];

// The house is done. Wins over a soft word, never over a strong one.
const FINISHED = [
  ["remodeled", /\b(?:fully|completely|beautifully|newly|tastefully|recently|totally|extensively|thoughtfully|lovingly|meticulously|top[\s-]to[\s-]bottom)\s+(?:remodel(?:l)?ed|renovated|updated|restored|rebuilt|redone)\b|\bremodel(?:l)?ed\s+(?:from\s+)?top\s+to\s+bottom\b/i],
  ["move-in ready", /\bmove[\s-]in[\s-]ready\b|\bready\s+to\s+move\s+(?:right\s+)?in\b|\bnothing\s+to\s+do\s+but\s+(?:move\s+in|unpack)\b|\bjust\s+(?:move\s+in|unpack)\b/i],
  ["turnkey", /\bturn[\s-]?key\b/i],
  ["new construction", /\bnew(?:ly)?[\s-](?:construction|build|built)\b|\bbrand[\s-]new\s+(?:home|house|construction)\b|\bbuilder'?s?\s+warranty\b/i],
  ["like new", /\blike[\s-]new\b|\bshowroom\b|\bimmaculate\b|\bpristine\b/i],
];

// "Not a fixer", "no TLC needed", "no work needed": a strong word said the
// other way round.
const NEGATED_SRC = /\b(?:not|no|isn'?t|never)\s+(?:a\s+)?(?:fixer|tlc|flip|handyman|project)\b|\bno\s+(?:work|repairs?|updates?)\s+(?:needed|required|to\s+do)\b|\bno\s+tlc\b|\bdone\s+for\s+you\b/.source;
const NEGATED_RX = new RegExp(NEGATED_SRC, "i");
const NEGATED_ALL_RX = new RegExp(NEGATED_SRC, "gi");

const hits = (list, text) => list.filter(([, rx]) => rx.test(text)).map(([why]) => why);

// Zillow's status words for a house that's still for sale. Anything else
// (PENDING, SOLD, OFF_MARKET, "Under contract") isn't a listing to ask about.
const FOR_SALE_RX = /^(?:for[\s_-]?sale|active|coming[\s_-]?soon|for_sale_by_owner|fsba|fsbo)$/i;

// Newer than this many years is new construction, whatever it says.
export const NEW_BUILD_YEARS = 10;

/**
 * listingDistress({ status, description, yearBuilt }, { now }) → { ok, why, signals, finished }
 *
 *   ok        the listing is for sale and its remarks say it needs work
 *   why       for a listing that isn't: what stopped it, in a few words
 *   signals   the distress words it uses ("fixer", "TLC", "dated" …)
 *   finished  the finished words it uses ("remodeled", "move-in ready" …)
 *
 * No remarks is not ok: nothing was checked.
 */
export function listingDistress(l = {}, { now = Date.now() } = {}) {
  const status = String(l.status || "").trim();
  const text = String(l.description || "").replace(/\s+/g, " ").trim();
  const year = Math.round(Number(l.yearBuilt) || 0);
  const out = (ok, why, signals = [], finished = []) => ({ ok, why, signals, finished });
  if (status && !FOR_SALE_RX.test(status)) return out(false, `not for sale on Zillow (${status.toLowerCase().replace(/_/g, " ")})`);
  if (year > 1800 && year >= new Date(now).getUTCFullYear() - NEW_BUILD_YEARS) return out(false, `built in ${year}`);
  if (!text) return out(false, "no listing remarks to check");
  const bank = bankSaleIn(text);
  if (bank) return out(false, `${bank} — we don't buy those`);
  const plain = text.replace(NEGATED_ALL_RX, " ");
  const strong = hits(STRONG, plain);
  const soft = hits(SOFT, plain);
  const finished = [...new Set([...hits(FINISHED, text), ...(NEGATED_RX.test(text) ? ["says no work needed"] : [])])];
  if (strong.length) return out(true, "", [...strong, ...soft], finished);
  if (soft.length && !finished.length) return out(true, "", soft, finished);
  if (finished.length) return out(false, `reads finished (${finished[0]})`, soft, finished);
  return out(false, "nothing in the remarks says it needs work", soft, finished);
}
