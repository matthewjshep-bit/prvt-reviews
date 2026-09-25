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
//   yours   a person's call

import { addressKey, sameStreet } from "./us-address.js";
import { propertyDossier } from "./contact-record.js";
import { aiHoldReasons, effectiveStatus, DEAD_STATUSES } from "./offer-status.js";

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
  if (/square footage is unknown/i.test(s)) return "we couldn't pull the square footage on it";
  if (WORK_HOLD.test(s)) return /photo/i.test(s) ? "there aren't enough listing photos to see what it needs" : "the work looks heavy and you want to pin it down";
  if (VALUE_HOLD.test(s)) return "the comps came back thin";
  return "you're missing a piece you need to finish it";
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
export const OVER_PLAIN = /\b(it'?s|it is|this (one|property|house|listing)|that (one|property|house|listing)|the (property|house|listing)|she'?s|he'?s|they'?re|seller is)\s+(is |was |went |has gone |are |went )?(already |now |just )?(pending|under contract|sold(?!\s+as[- ]is)|off the market|no longer (available|for sale)|not interested|withdrawn)\b/i;
const TURNKEY_TEXT = /\b(turn-?key|move-?in ready|fully (updated|renovated|remodeled)|completely (renovated|remodeled|updated)|not (really )?a fixer|isn'?t a fixer|no work needed)\b/i;
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
 *   botOffTags     the routing's bot-off tags (lower-case)
 */
export function triageHeldUnderwrite({
  offer, siblings = [], events = [], drafts = [], contact = null, opportunities = [], botOffTags = ["stop bot", "bot-off"], now = Date.now(),
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
  const mine = siblings.filter((s) => s && s.id !== offer.id && onThisHouse(s.address));
  const priced = mine.find((s) => Number(s.cashAmount) > 0 && effectiveStatus(s) !== "draft");
  if (priced) return { ...base, action: "drop", reason: `a priced offer (${effectiveStatus(priced)}) already exists on this house` };
  const newer = mine.find((s) => effectiveStatus(s) === "draft" && (ms(s.createdAt) ?? 0) > (ms(offer.createdAt) ?? 0));
  if (newer) return { ...base, action: "drop", reason: "a newer draft on the same house replaced it" };

  /* --- 2. retire: the house is over for us --- */
  const tags = (contact?.tags || []).map((t) => String(t).toLowerCase());
  if (contact?.dnd) return { ...base, action: "retire", status: "we_passed", reason: "they unsubscribed" };
  if (events.some((e) => e?.type === "unsubscribed")) return { ...base, action: "retire", status: "we_passed", reason: "they unsubscribed" };
  const off = tags.find((t) => botOffTags.includes(t));
  if (off) return { ...base, action: "retire", status: "we_passed", reason: `the bot is off for this contact (tag: ${off})` };
  const opp = opportunities.find((o) => CLOSED_OPP.test(String(o?.status || "")) || COLD_STAGE.test(String(o?.stageName || "")));
  if (opp) return { ...base, action: "retire", status: "we_passed", reason: CLOSED_OPP.test(String(opp.status || "")) ? `GHL opportunity ${String(opp.status).toLowerCase()}` : `GHL stage: ${opp.stageName}` };

  const after = (t) => (ms(t) ?? 0) >= heldAt - 60 * 60000;   // the hold's own inbound counts
  const houseEvents = events.filter((e) => e?.address && onThisHouse(e.address));
  const passedEv = houseEvents.find((e) => e.type === "offer_passed" || e.type === "offer_we_passed");
  if (passedEv) return { ...base, action: "retire", status: passedEv.type === "offer_passed" ? "passed" : "we_passed", reason: passedEv.type === "offer_passed" ? "they passed on this house" : "we passed on this house" };
  const turnkeyEv = houseEvents.find((e) => e.type === "property_details" && TURNKEY_TEXT.test(String(e.data?.condition || "")));
  if (turnkeyEv) return { ...base, action: "retire", status: "we_passed", reason: `turnkey per the agent ("${String(turnkeyEv.data.condition).slice(0, 60)}")` };
  const said = drafts
    .filter((d) => d && String(d.inbound || "").trim() && aboutThisHouse(d.propertyAddress) && after(d.createdAt))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const over = said.find((d) => (d.intent === "rejection" && OVER_TEXT.test(d.inbound)) || OVER_PLAIN.test(d.inbound));
  if (over) return { ...base, action: "retire", status: "passed", reason: `they said "${clip(over.inbound)}"` };
  const turnkey = said.find((d) => TURNKEY_TEXT.test(d.inbound));
  if (turnkey) return { ...base, action: "retire", status: "we_passed", reason: `turnkey per the agent ("${clip(turnkey.inbound)}")` };

  const lastIn = latestInbound(drafts, events);
  const asked = events
    .filter((e) => e?.type === "audit_action" && e.data?.kind === "held_ask" && (e.offerId === offer.id || onThisHouse(e.address)))
    .map((e) => ms(e.at)).filter((t) => t != null).sort((a, b) => b - a)[0] ?? null;
  const silentSince = Math.max(heldAt, lastIn ?? 0, asked ?? 0);
  if (now - silentSince >= STALE_DAYS * DAY_MS) {
    return { ...base, action: "retire", status: "we_passed", reason: `held ${heldDays} days and nothing since` };
  }
  if (asked != null && (lastIn == null || lastIn < asked) && now - asked >= ASK_WAIT_DAYS * DAY_MS) {
    return { ...base, action: "retire", status: "we_passed", reason: "we asked for their read a week ago and heard nothing" };
  }

  /* --- 3. re-run on their numbers --- */
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

    /* --- 4. ask for the missing piece --- */
    const missing = needs.filter((n) => !have[n]);
    if (asked != null && (lastIn == null || lastIn < asked)) return { ...base, action: "wait", needs: missing, reason: `asked ${Math.floor((now - asked) / DAY_MS)}d ago, waiting on them` };
    const alive = (lastIn != null && now - lastIn <= ALIVE_DAYS * DAY_MS) || heldDays <= 3;
    if (!alive) return { ...base, action: "yours", needs: missing, reason: `they haven't written in ${Math.floor((now - (lastIn ?? heldAt)) / DAY_MS)} days (${heldReason})` };
    // The promise sweep already asks this exact question when a promise is
    // owed on a held underwrite (promise_due with heldReason) — one asker.
    const promised = drafts.some((d) => d?.outbound?.kind === "promise_due" && aboutThisHouse(d.propertyAddress) && now - (ms(d.createdAt) ?? 0) <= PROMISE_ASK_DAYS * DAY_MS && d.status !== "dismissed");
    if (promised) return { ...base, action: "wait", needs: missing, reason: "the promise sweep just asked them" };
    return { ...base, action: "ask", needs: missing, reason: `${heldReason} — ask what ${missing.map((n) => (n === "value" ? "it's worth fixed up" : "the work would run")).join(" and ")}` };
  }

  /* --- 5. a person's call --- */
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

export const HELD_ACTIONS = ["drop", "retire", "rerun", "ask", "wait", "yours"];

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
