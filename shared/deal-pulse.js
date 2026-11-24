// deal-pulse.js — how a deal's dispo is going, in one line for the Deals list
// (2026-11-23 audit, D4), and the go / re-trade / cancel call before the
// inspection ends (D3).
//
// Read only from what the deal row already carries, plus the one count the
// broker adds on GET /deals (`deal.sends`: buyers this deal actually went to,
// by the app or by hand). Never `deal.blasts[].count`: that is what a blast
// queued, and a blast Matt stopped five seconds in would read "sent 151".
//
// Pure: no I/O, no clock unless `now` is passed.

import { inspectionDecision, ymdLabel } from "./deal-checklist.js";
import { summarizeFeedback } from "./conversation-ai.js";

const DAY = 86400000;
// The feedback page's cached package is rebuilt after 6h when someone opens
// it; past that its numbers are older than what the threads say.
export const FEEDBACK_FRESH_HOURS = 6;
// A live deal with no buyer moving for this long reads as stalled.
export const STALLED_DAYS = 3;

const round = (n) => Math.round(Number(n) || 0);
const status = (s) => (["evaluating", "passed", "soft_commit", "committed"].includes(s) ? s : "evaluating");
const ts = (iso) => { const t = Date.parse(iso || ""); return Number.isFinite(t) ? t : null; };
const ageDays = (iso, now) => { const t = ts(iso); return t == null ? null : Math.max(0, Math.floor((now - t) / DAY)); };
const latest = (...isos) => isos.filter((x) => ts(x) != null).sort((a, b) => ts(b) - ts(a))[0] || null;

/** shortMoney(455000) → "$455K"; shortMoney(1250000) → "$1.25M". */
export function shortMoney(n) {
  const v = round(n);
  if (!v) return "";
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return `$${v}`;
}

/**
 * bestBuyerNumber(deal, { now }) → { amount, from, name, ageDays } | null
 *
 * The best price a buyer has put on this house, most trusted first:
 *   agreed     the committed buyer's agreed price, then the highest any buyer
 *              still in it agreed;
 *   buyerRead  what Matt typed in from the walkthrough or a call;
 *   feedback   the highest number a buyer named, from the feedback page's
 *              cached package, with how old that package is.
 */
export function bestBuyerNumber(deal = {}, { now = Date.now() } = {}) {
  const inv = (deal.investors || []).filter((i) => i && status(i.status) !== "passed");
  const agreed = (i) => round(i?.agreedPrice?.amount);
  const committed = inv.find((i) => status(i.status) === "committed" && agreed(i) > 0);
  if (committed) return { amount: agreed(committed), from: "agreed", name: committed.name || "", ageDays: null };
  const top = inv.filter((i) => agreed(i) > 0).sort((a, b) => agreed(b) - agreed(a))[0];
  if (top) return { amount: agreed(top), from: "agreed", name: top.name || "", ageDays: null };
  const read = round(deal.buyerRead?.price);
  if (read > 0) return { amount: read, from: "buyerRead", name: "", ageDays: ageDays(deal.buyerRead?.at, now) };
  const pkg = deal.feedbackPackage;
  const named = (pkg?.askedFor || []).filter((a) => round(a?.amount) > 0).sort((a, b) => round(b.amount) - round(a.amount))[0];
  if (named) return { amount: round(named.amount), from: "feedback", name: named.name || "", ageDays: ageDays(pkg.generatedAt, now) };
  return null;
}

/**
 * dispoPulse(deal, { now }) → {
 *   sent, sentAt,           buyers it went to (app + hand), null when unknown
 *   onDeal, interested, passed, committed, softCommit,
 *   walking, walked,        walkthrough RSVPs coming / attended
 *   best,                   bestBuyerNumber
 *   lastBuyerAt, lastBuyerDays, stalled,
 *   parts: ["sent 12", "on it 4", …], line: "sent 12 · on it 4 · …"
 * }
 *
 * "On it" is every buyer on the deal: the bot files a buyer who answers about
 * the house, and Matt adds one he talked to. "Interested" is the ones on it
 * who haven't passed.
 */
export function dispoPulse(deal = {}, { now = Date.now() } = {}) {
  const inv = (deal.investors || []).filter(Boolean);
  const count = (s) => inv.filter((i) => status(i.status) === s).length;
  const passed = count("passed");
  const committed = count("committed");
  const softCommit = count("soft_commit");
  const interested = inv.length - passed;
  const rsvps = Array.isArray(deal.showing?.rsvps) ? deal.showing.rsvps : [];
  const walking = rsvps.filter((r) => r?.status === "coming" || r?.status === "interested").length;
  const walked = rsvps.filter((r) => r?.status === "attended").length;
  const sends = deal.sends && typeof deal.sends === "object" ? deal.sends : null;
  const sent = sends && Number.isFinite(Number(sends.sent)) ? Math.max(0, Math.round(Number(sends.sent))) : null;
  const best = bestBuyerNumber(deal, { now });
  // A buyer's last move on the deal: added, a status change, an RSVP.
  const lastBuyerAt = latest(...inv.flatMap((i) => [i.updatedAt, i.addedAt]), ...rsvps.map((r) => r?.at));
  const lastBuyerDays = ageDays(lastBuyerAt, now);
  const live = !["closed", "fell_through", "assigned"].includes(deal.stage);
  const stalled = live && !committed && (lastBuyerDays == null ? (ageDays(deal.createdAt, now) ?? 0) >= STALLED_DAYS : lastBuyerDays >= STALLED_DAYS);
  const parts = [];
  if (sent != null) parts.push(`sent ${sent}`);
  parts.push(`on it ${inv.length}`);
  if (inv.length) parts.push(`${interested} interested`);
  if (passed) parts.push(`${passed} passed`);
  if (walking) parts.push(`${walking} walking`);
  if (walked) parts.push(`${walked} walked it`);
  if (best) parts.push(`best ${shortMoney(best.amount)}`);
  return {
    sent, sentAt: sends?.lastAt || null,
    onDeal: inv.length, interested, passed, committed, softCommit, walking, walked,
    best, lastBuyerAt, lastBuyerDays, stalled,
    parts, line: parts.join(" · "),
  };
}

/**
 * bestWords(best) → "best $455K, Oak agreed" | "best $430K, feedback page 2d old" | ""
 * Where the best number came from, said plainly, so an old one is read as old.
 */
export function bestWords(best) {
  if (!best) return "";
  const n = shortMoney(best.amount);
  if (best.from === "agreed") return `best ${n}${best.name ? `, ${best.name} agreed` : ", agreed"}`;
  if (best.from === "buyerRead") return `best ${n}, what you typed${best.ageDays != null ? ` ${best.ageDays}d ago` : ""}`;
  const age = best.ageDays == null ? "" : best.ageDays === 0 ? " today" : ` ${best.ageDays}d old`;
  return `best ${n}, named on the feedback page${age}`;
}

/**
 * moneyLine(deal) → { line, contract, buyerPrice, fee, over, ceiling } | null
 *
 * "Contract → buyer · fee" in one cell: "$400K → $430K · fee $30K". `over`
 * is how far contract + fee sits above the buyer ceiling recorded at promote
 * (deal.ceilingAtPromote.noFee), 0 when at or under it, null when unknown.
 */
export function moneyLine(deal = {}) {
  const contract = round(deal.contractPrice);
  const fee = round(deal.assignmentFee);
  if (!contract && !fee) return null;
  const buyerPrice = contract + fee;
  const c = deal.ceilingAtPromote;
  const ceiling = c?.computable && round(c.noFee) > 0 ? round(c.noFee) : null;
  const over = ceiling == null || !contract ? null : Math.max(0, buyerPrice - ceiling);
  const line = contract
    ? `${shortMoney(contract)} → ${shortMoney(buyerPrice)}${fee ? ` · fee ${shortMoney(fee)}` : ""}`
    : `fee ${shortMoney(fee)}`;
  return { line, contract, buyerPrice, fee, over, ceiling };
}

/* ---------- the inspection call (D3) ---------- */

const dueWords = (d) => (d > 1 ? `in ${d} days` : d === 1 ? "tomorrow" : d === 0 ? "today" : `${-d} day${d === -1 ? "" : "s"} ago`);

/**
 * inspectionCall(deal, { now }) → null | {
 *   dueYmd, dueDays, tone: "urgent" | "soon" | "lapsed",
 *   headline: "Inspection ends Nov 28, in 2 days: go, re-trade or cancel",
 *   lines: ["No committed buyer.", "6 buyers passed: Price too high ×4, …", "Buyers named $380K to $410K (feedback page, 1d old)."],
 * }
 *
 * The go / re-trade / cancel decision, with what buyers have said so far.
 * Display only. The window is inspectionDecision's (shared/deal-checklist.js),
 * the same one the pipeline's "Extend, re-trade or cancel" row and Slack use:
 * null once the inspection item is ticked, or outside the window.
 */
export function inspectionCall(deal = {}, { now = Date.now() } = {}) {
  const it = inspectionDecision(deal, { now });
  if (!it) return null;
  const p = dispoPulse(deal, { now });
  const lines = [];
  const committed = (deal.investors || []).find((i) => status(i?.status) === "committed");
  const soft = (deal.investors || []).find((i) => status(i?.status) === "soft_commit");
  if (committed) lines.push(`${committed.name || "A buyer"} is committed${committed.agreedPrice?.amount ? ` at ${shortMoney(committed.agreedPrice.amount)}` : ""}.`);
  else if (soft) lines.push(`No committed buyer. ${soft.name || "A buyer"} is a soft commit.`);
  else lines.push("No committed buyer.");
  const reach = [p.sent != null ? `Sent to ${p.sent}` : "", `${p.onDeal} on it`, p.interested ? `${p.interested} still interested` : "", p.walked ? `${p.walked} walked it` : p.walking ? `${p.walking} walking it` : ""].filter(Boolean);
  lines.push(`${reach.join(", ")}.`);
  // One reason per buyer per code: a pass is filed on the investor and in
  // the deal's feedback both, and counting it twice makes one buyer two.
  const filed = new Set((deal.feedback || []).map((r) => `${r?.contactId}|${r?.code}`));
  const reasons = [
    ...(deal.feedback || []),
    ...(deal.investors || []).filter((i) => status(i?.status) === "passed" && i.reason?.code && !filed.has(`${i.contactId}|${i.reason.code}`)).map((i) => i.reason),
  ];
  if (p.passed || reasons.length) {
    const { byCode } = summarizeFeedback(reasons);
    const top = byCode.slice(0, 3).map((c) => `${c.label}${c.count > 1 ? ` ×${c.count}` : ""}`).join(", ");
    lines.push(`${p.passed} passed${top ? `: ${top}` : ""}.`);
  }
  const pkg = deal.feedbackPackage;
  const named = (pkg?.askedFor || []).map((a) => round(a?.amount)).filter((n) => n > 0);
  if (named.length) {
    const lo = Math.min(...named), hi = Math.max(...named);
    const age = ageDays(pkg.generatedAt, now);
    lines.push(`Buyers named ${lo === hi ? shortMoney(lo) : `${shortMoney(lo)} to ${shortMoney(hi)}`} (feedback page${age == null ? "" : age === 0 ? ", today" : `, ${age}d old`}).`);
  } else if (p.best && p.best.from !== "feedback") {
    lines.push(`${bestWords(p.best).replace(/^best/, "Best number")}.`);
  }
  const tone = it.dueDays < 0 ? "lapsed" : it.dueDays <= 2 ? "urgent" : "soon";
  const verb = it.dueDays < 0 ? "ended" : "ends";
  return {
    dueYmd: it.dueYmd, dueDays: it.dueDays, tone,
    headline: `Inspection ${verb} ${ymdLabel(it.dueYmd)}, ${dueWords(it.dueDays)}: go, re-trade or cancel`,
    lines,
  };
}
