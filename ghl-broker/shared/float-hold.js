// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// float-hold.js — when the machine doesn't text a price on a house.
//
// The 2026-11-23 audit (neg-5): in two of its packets every machine float was
// passed or rejected (9 of 9, 13 of 13), with replies like "not even close"
// and "stop wasting my time". Two patterns made most of them:
//
//   turnkey     the agent had told us the house is turnkey, remodeled, "not
//               a flip" or in excellent condition, and the number went
//               anyway. Matt's 10-16 review: 63% of bot-first numbers were on
//               cosmetic or turnkey houses, and 87% of those died.
//   same burst  we asked about its condition and the number followed within
//               minutes ("I'll run it by underwriting today", then the price),
//               before they could answer.
//
// The rule: no machine price text within CONDITION_WAIT_HOURS of our own
// condition question unless they answered it, and none on a house they
// called done. Nothing goes instead (the Needs Matt screen passes a turnkey
// house with its pass note). A person pressing Float has decided.
//
// Pure. reply-agent.js startProactive asks it before a price float, and
// routes/offers.js before an offer sends itself.

import { sameStreet } from "./us-address.js";
import { saysItsDone } from "./lane-holds.js";
import { flipRead, workBudgetIn, QUALIFY_ASK_RX } from "./flip-read.js";

export const CONDITION_WAIT_HOURS = 12;
const HOUR_MS = 3600000;
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

// Our question about the house's condition, in any of the words we use.
const CONDITION_Q_RX = /\b(?:condition|shape|what\s+(?:kind\s+of\s+)?work|work\s+(?:does\s+it|it(?:'d|\s+would)?)\s+need|what(?:'s|\s+does)\s+it\s+(?:actually\s+)?need|project\s+or\s+(?:turn[\s-]?key|move[\s-]?in)|turn[\s-]?key\s+or|needs?\s+(?:much\s+|any\s+|a\s+lot\s+of\s+)?work|repairs?|updat(?:ed|es|ing)|big[\s-]ticket|roof|foundation|cosmetic)\b[^?]{0,120}\?/i;
/** asksCondition(text) → true when a text of ours asks what shape the house is in. */
export const asksCondition = (text = "") => QUALIFY_ASK_RX.test(String(text || "")) || CONDITION_Q_RX.test(String(text || ""));

const said = (d) => String(d?.sentText || d?.reply || d?.body || "");
const sentAt = (d) => ms(d?.sentAt) ?? ms(d?.updatedAt) ?? ms(d?.createdAt);
const onHouse = (d, address) => !d?.propertyAddress || sameStreet(d.propertyAddress, address);
// Real work in their words: a budget, big-ticket items, trouble.
const namesWork = (t) => { const r = flipRead(t, { agentRehab: workBudgetIn(t) }); return r.qualifies || r.strong.length > 0 || r.major.length > 0 || workBudgetIn(t) > 0; };

/**
 * floatHold({ drafts, address, now }) → { kind: "turnkey" | "asked_condition", why } | null
 *
 * `drafts`: this contact's reply drafts, any status (their texts are the
 * `inbound`, ours the sent ones). `address`: the house the price is on.
 */
export function floatHold({ drafts = [], address = "", now = Date.now() } = {}) {
  if (!String(address || "").trim()) return null;
  const street = String(address).split(",")[0].trim();
  // Their texts about this house, oldest first.
  const theirs = (drafts || []).filter((d) => d && String(d.inbound || "").trim() && onHouse(d, address) && d.party !== "investor")
    .sort((a, b) => (ms(a.createdAt) ?? 0) - (ms(b.createdAt) ?? 0));
  // Their latest word on its condition: "turnkey", then "actually the roof's
  // shot", is a house with work.
  let done = null;
  for (const d of theirs) {
    const t = String(d.inbound);
    if (saysItsDone(t)) done = d;
    else if (done && namesWork(t)) done = null;
  }
  if (done) return { kind: "turnkey", why: `${street}: the agent called it done (turnkey, remodeled or not a flip) — no number goes out on it by itself` };
  // Our condition question in the last CONDITION_WAIT_HOURS, with nothing from them since.
  const asked = (drafts || []).filter((d) => d?.status === "sent" && onHouse(d, address) && asksCondition(said(d)))
    .map(sentAt).filter((t) => t != null && t <= now && now - t < CONDITION_WAIT_HOURS * HOUR_MS);
  if (!asked.length) return null;
  const last = Math.max(...asked);
  const answered = (drafts || []).some((d) => d && String(d.inbound || "").trim() && (ms(d.createdAt) ?? 0) > last);
  if (answered) return null;
  const hrs = Math.max(0, Math.round((now - last) / HOUR_MS));
  return { kind: "asked_condition", why: `${street}: we asked about its condition ${hrs === 0 ? "within the hour" : `${hrs}h ago`} and they haven't answered — no number until they do, or ${CONDITION_WAIT_HOURS} hours pass` };
}
