// dispo-autopilot.js — the selling side, on its own.
//
// Three things that used to be clicks, and one workflow the app could not
// see:
//
//   The blast. Until now "Tag & blast" applied a GHL tag and a workflow
//   template texted the list, so the app learned who was pitched only by
//   scanning conversations afterwards (the Edmonds package counted 12 buyers
//   when 1,337 had been texted). Now a blast is a set of outbound drafts —
//   one per buyer, the deal in one text — staggered over the auto-send hours
//   and sent by the same 30-second scheduler that sends replies. Hold works,
//   quiet hours work, and every send is a blast_sent event.
//
//   Blast on promote: a deal is minted → everyone who buys where it is
//   (buyer-score.js pickDealBuyers: bought in its city, or told us its city,
//   zip or region) gets it, all at once, best fit first. No tiers, no cap,
//   no days between rounds (Matt, 2026-10-21).
//   The catch-up: each morning, while nobody has committed, the buyers who
//   have come to fit since (a new import, a buy box they just told us) and
//   haven't had it.
//   The guarded dataroom invite and the assignment on commit live in the
//   offers router's deps; this file holds the settings and the queue.

import { normalizeTouchBudget } from "./shared/buyer-touch.js";
import { buyerTouchLimit, slotWord } from "./buyer-touch.js";
import { store as defaultStore } from "./store.js";
import { blastMessage, blastNote, dealFacts, blastSubject, presellMessage, normalizeDealTexts } from "./shared/blast-text.js";
import { normalizeBookSync } from "./investor-sync.js";
import { normalizeBuyerPulse } from "./shared/buyer-pulse.js";
import { walkthroughAsk } from "./shared/showing.js";
import { dealNumbers } from "./dataroom.js";
import { dealOutreachPaused } from "./shared/offer-status.js";
import { conversationConfig } from "./reply-agent.js";
import { nextSendTime, spreadAcrossDay, machineHours } from "./conversation-scheduler.js";
import { claimDailyRun, closeDailyRun } from "./daily-gate.js";
import { botEventsByContact } from "./bot-hold.js";
import { botHold, holdLine } from "./shared/bot-hold.js";
import { dealsByOf } from "./shared/contact-email.js";
import { matchTagPatterns } from "./conversation-party.js";

export const CURSOR_NAME = "dispo";
export const MIN_GAP_MS = 20 * 3600 * 1000;
export const DISPO_SWEEP_UTC_HOUR = Number(process.env.DISPO_SWEEP_UTC_HOUR || 17); // ≈ 9–10am Pacific
const DISPO_BLASTS_ENABLED = process.env.DISPO_BLASTS_ENABLED === "true";
const iso = (ms) => new Date(ms).toISOString();

export function normalizeDispoAutopilot(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  const n = (x, d, lo, hi) => { const k = Math.round(Number(x)); return Number.isFinite(k) ? Math.min(hi, Math.max(lo, k)) : d; };
  return {
    sendWith: o.sendWith === "ghl" ? "ghl" : "app",
    spreadSec: n(o.spreadSec, 60, 5, 900),        // seconds between two blast texts
    // Send a deal to everyone who buys where it is the moment it's minted,
    // and catch up each morning on anyone who has come to fit since. The
    // counts, score floors and wave delays that used to sit here are gone
    // (2026-10-21): who gets a deal is where they buy, and they get it now.
    autoBlastOnPromote: o.autoBlastOnPromote === true,
    autoInvite: o.autoInvite === true,
    // Whether a deal text carries the buyer's package link (2026-10-02). A
    // link in a text is what the carriers block most: "on_reply" sends the
    // deal without it ("want the details?") and the link when they answer.
    blastLink: o.blastLink === "on_reply" ? "on_reply" : "always",
    // The deal text in Matt's own words (Autopilot → Investors, 2026-10-20);
    // [] is the built-in wording.
    dealTexts: normalizeDealTexts(o.dealTexts),
    // Build the buyer package (the dataroom) the moment an offer becomes a
    // deal, before any wave, so the blast's link has somewhere to go. Off.
    dataroomOnPromote: o.dataroomOnPromote === true,
    paperworkOnCommit: o.paperworkOnCommit === true,
    // The check-in between deals (buyer-pulse.js). Off, and draft-only when on.
    pulse: normalizeBuyerPulse(o.pulse),
    // The buyer book re-read from GHL once a night (investor-sync.js). Off.
    bookSync: normalizeBookSync(o.bookSync),
    // The buyer walkthrough (shared/showing.js).
    showings: normalizeShowings(o.showings),
    // A buyer with no phone gets the deal by email (2026-10-01: fourteen of
    // the twenty mobile home buyers had only an email).
    email: normalizeBlastEmail(o.email),
    // One buyer, one week (shared/buyer-touch.js, 2026-10-05): the machine
    // starts at most one text a week to a buyer who never wrote back, two to
    // one we're talking to; a deal over that waits and goes together with
    // whatever else is new for them. On — it only ever holds texts back.
    touchBudget: normalizeTouchBudget(o.touchBudget),
  };
}

/**
 * normalizeBlastEmail(v) → { draft, autoSend }
 *
 * draft: a buyer with no phone and an email is in the wave, as an email
 * draft. A draft waits for you, so on. autoSend: those emails send
 * themselves like the texts do (same broker switches and allowlist). A send
 * nobody pressed, so off until Matt turns it on.
 */
export function normalizeBlastEmail(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  return { draft: o.draft !== false, autoSend: o.autoSend === true };
}

// How we found a buyer, said the first time we write them (Matt, 2026-09-28:
// the Facebook group buyers are told where we found them). Keyed by source tag.
const SOURCE_INTROS = { "dispo-source-fb-warei": "found you through the WA real estate Facebook group" };

// Buyers off the county sale and parcel records (dispo-source-county) never
// heard of us. Matt, 2026-10-08: "hey saw you buy mobile homes in the area
// from xyz, im a local investor" — what we saw, where, and who's writing.
// Not the word "investor", though (2026-10-15): it is one the carriers
// block (shared/carrier-words.js), and the cold deal texts that said it
// were blocked a third of the time.
function countyIntro(tags) {
  const mobile = tags.includes("dispo-type-mobile-home") || tags.includes("dispo-asset-manufactured");
  const city = (tags.find((t) => t.startsWith("dispo-city-")) || "").slice("dispo-city-".length)
    .split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  return `saw in the county records you've bought ${mobile ? "mobile homes" : "houses"} ${city ? `around ${city}` : "in the area"}. I'm Matt, I fix up houses locally`;
}

/** blastIntro({ tags, lastRepliedAt }) → the how-we-found-you line for a buyer who has never written back, or "". */
export function blastIntro(inv = {}) {
  if (inv.lastRepliedAt) return "";
  const tags = (inv.tags || []).map((t) => String(t || "").toLowerCase());
  for (const t of tags) if (SOURCE_INTROS[t]) return SOURCE_INTROS[t];
  if (tags.some((t) => t.startsWith("dispo-source-fb"))) return "found you through a real estate Facebook group";
  return tags.includes("dispo-source-county") ? countyIntro(tags) : "";
}

/**
 * blastChannels(inv, da) → ["sms"] | ["sms", "email"] | ["email"] | []
 *
 * A phone is texted. A buyer who asked for deals by email (shared/
 * contact-email.js dealsByOf: the record's deals_by, else the GHL tag) is
 * texted AND emailed when we have an address (Matt, 2026-10-15: text first,
 * then email too once they ask). No phone and an email is emailed, when
 * email drafting is on. A caller that knows neither (an older shortlist of
 * ids and names) gets a text, as it always has; one that knows there is no
 * way to reach them gets [] and the buyer is skipped. `inv.channel` asks for
 * that one channel only (a buyer asking for one deal by email).
 */
export function blastChannels(inv = {}, da = normalizeDispoAutopilot({})) {
  if (inv.channel === "email") return inv.email ? ["email"] : [];
  if (inv.channel === "sms") return inv.phone || inv.phone === undefined ? ["sms"] : [];
  const askedForEmail = Boolean(inv.email) && dealsByOf(inv) === "email";
  if (inv.phone) return askedForEmail ? ["sms", "email"] : ["sms"];
  if (inv.phone === undefined && inv.email === undefined) return ["sms"];
  if (inv.email && (da.email.draft || askedForEmail)) return ["email"];
  return [];
}

/** blastChannel(inv, da) → the first channel blastChannels picks, or "". */
export function blastChannel(inv = {}, da = normalizeDispoAutopilot({})) {
  return blastChannels(inv, da)[0] || "";
}

/**
 * normalizeShowings(v) → { askInBlast, askAgentOnPromote }
 *
 * askInBlast: a blast ends on the walkthrough question (the window when the
 * deal has one) instead of "want the details?". Copy, not a send, so on.
 * askAgentOnPromote: the moment a deal is minted, text the listing agent for
 * a walkthrough window. A send nobody pressed, so off until Matt turns it on.
 */
export function normalizeShowings(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  return {
    askInBlast: o.askInBlast !== false, askAgentOnPromote: o.askAgentOnPromote === true,
    // The walkthrough texts (showing-sweep.js): a reminder the afternoon
    // before to buyers coming, and a follow-up after to those who came.
    // Drafts for you unless autoSend; all off.
    remindDayBefore: o.remindDayBefore === true,
    followUpAfter: o.followUpAfter === true,
    autoSend: o.autoSend === true,
  };
}

// Why a pre-sell text never goes by itself: nothing is signed yet.
export const PRESELL_WAITS = "a pre-sell waits for your Send — nothing is signed yet";

/** blastAsk(offer, saved, now) → the walkthrough question for this deal's blast, or "". */
export function blastAsk(offer, saved = {}, now = Date.now()) {
  const da = normalizeDispoAutopilot(saved?.dispoAutopilot);
  return da.showings.askInBlast ? walkthroughAsk({ showing: offer?.deal?.showing || null, now }) : "";
}

/**
 * blastFacts({ store, locationId, offer, saved, note }) → what the deal text says
 *
 * The deal's figures at the buyer price, and its one line: the operator's
 * own for this blast, else the dataroom headline. That headline is already
 * written for buyers — it is the one sentence they'd read at the top of the
 * package — so it belongs in the text that offers them the deal.
 * Best-effort: a missing room just means a shorter message.
 */
export async function blastFacts({ store = defaultStore, locationId, offer, saved = {}, note: noteOverride = "" }) {
  const numbers = dealNumbers({ offer, settings: saved });
  let note = blastNote(noteOverride);
  if (!note) try {
    const rooms = await store.listDatarooms(locationId, { offerId: offer.id, limit: 5 });
    const room = rooms.find((r) => r.status === "active" && r.kind !== "portfolio" && r.kind !== "offer");
    note = room?.snapshot?.headline || "";
  } catch { /* the line is a courtesy, never the message */ }
  return dealFacts(offer, { price: numbers.investorPrice, note });
}

/**
 * sampleBlastTexts({ store, locationId, offer, saved, now, name }) → { samples, input }
 *
 * The deal text in each of its phrasings, as a buyer named `name` who has
 * written back before would get it now (Autopilot → Investors,
 * 2026-10-20), and `input`: what blastMessage was handed, so the page can
 * show an edit to the wording as you type it. Nothing is drafted, claimed
 * or sent. With blastLink "always" the real text carries the buyer's own
 * package link, minted at send; the sample says where it goes.
 */
export async function sampleBlastTexts({ store = defaultStore, locationId, offer, saved = {}, now = Date.now(), name = "Alex" }) {
  const da = normalizeDispoAutopilot(saved.dispoAutopilot);
  const facts = await blastFacts({ store, locationId, offer, saved });
  const ask = blastAsk(offer, saved, now);
  const link = da.blastLink === "always" ? "[their package link]" : "";
  const input = { ...facts, firstName: name, ask, link, linkOnReply: !link };
  const count = Math.max(1, Math.min(3, da.dealTexts.length || 3));
  return { samples: Array.from({ length: count }, (_, variant) => blastMessage({ ...input, variant, templates: da.dealTexts })), input };
}

/**
 * queueBlastDrafts({ store, locationId, offer, investors, saved, now, dryRun })
 *   → { queued, drafted, dryRun, rows: [{ contactId, name, status, sendAt, text }] }
 *
 * One outbound draft per buyer. Scheduled (sends itself) only when the
 * broker may send, blasts are enabled, and blast_open is on the investor
 * allowlist; otherwise a plain draft in the outbox — the shakedown. Send
 * times are staggered `spreadSec` apart from the next open minute, so a
 * blast never lands as a burst and never at night.
 *
 * `presell`: a house we haven't signed, put to a few buyers first (shared/
 * pre-contract.js). Its own words (presellMessage: never "under contract",
 * no link), and always a draft that waits for your Send — nothing is
 * scheduled, and nothing the audit or a sweep does can release it.
 */
export async function queueBlastDrafts({ store = defaultStore, locationId, offer, investors = [], saved = {}, now = Date.now(), dryRun = false, sendsEnabled = false, blastsEnabled = DISPO_BLASTS_ENABLED, label = "", startAfterMs = 0, note: noteOverride = "", presell = false }) {
  const da = normalizeDispoAutopilot(saved.dispoAutopilot);
  const config = conversationConfig(saved);
  const pb = config.parties.investor;
  const allowed = Boolean(pb.autoSend?.enabled && (pb.autoSend.intents || []).includes("blast_open"));
  const live = !dryRun && sendsEnabled && blastsEnabled;
  const willSchedule = live && config.enabled && allowed && !presell;
  const reason = !live ? (dryRun ? "dry run" : !sendsEnabled ? "sends are off on the broker (CARD_SENDS_ENABLED)" : "blasts are off on the broker (DISPO_BLASTS_ENABLED)")
    : !config.enabled ? "Conversation AI is switched off" : !allowed ? "'sent them a deal' is not on the investor auto-send list" : "";

  // A line the operator wrote for this blast rides on each draft, so the
  // text rewritten at send keeps it.
  const ownLine = blastNote(noteOverride);
  const facts = await blastFacts({ store, locationId, offer, saved, note: noteOverride });
  const ask = presell ? "" : blastAsk(offer, saved, now);
  // Buyers you stopped the bot on (shared/bot-hold.js): their deal text is
  // drafted and waits for you. One read for the whole list; a read that
  // fails holds every text rather than guess.
  const stops = dryRun ? new Map() : await botEventsByContact({ store, locationId }).catch(() => null);
  // A bot-off tag in GHL ("stop bot", Conversation AI → routing) holds the
  // deal text the same way (2026-10-21): it held only the bot's replies, and
  // tagged buyers in the area were sent the deal by themselves.
  const botOffTags = config.routing?.botOffTags || [];
  const holdOf = (inv) => {
    const tag = matchTagPatterns(inv.tags || inv.doc?.tags || [], botOffTags)[0];
    if (tag) return { held: true, kind: "bot_off", tag };
    return stops ? botHold({ events: stops.get(inv.contactId) || [], now }) : { held: true, kind: "unread" };
  };
  const holdText = (hold) => (hold.kind === "bot_off" ? `bot is off for this contact (tag: ${hold.tag})` : holdLine(hold));
  const rows = [];
  let queued = 0, drafted = 0, waiting = 0, i = 0;
  // Cumulative: each text lands at least `spreadSec` after the one before,
  // plus a little jitter so the gaps aren't a metronome. nextSendTime rolls
  // anything past the close into the next open window.
  // The first text lands at the next open minute — on a weekday, unless the
  // page allows weekends — and the rest follow it.
  let cursor = Date.parse(spreadAcrossDay({ now: now + Math.max(0, Number(startAfterMs) || 0), quietHours: machineHours(config.autoSend), hours: 0, weekends: config.autoSend.weekends || "all" }));
  for (const inv of investors) {
    const contactId = inv.contactId;
    if (!contactId) continue;
    const name = inv.name || inv.doc?.name || "";
    const channels = blastChannels(inv, da);
    if (!channels.length) { rows.push({ contactId, name, status: "skipped", reason: "no phone, and email drafting is off", text: "" }); continue; }
    const hold = holdOf(inv);
    const intro = blastIntro(inv);
    const variant = i;
    const text = presell ? presellMessage({ ...facts, firstName: name, variant, intro }) : blastMessage({ ...facts, firstName: name, variant, ask, intro, templates: da.dealTexts });
    if (i > 0) cursor += da.spreadSec * 1000 + Math.round(Math.random() * 15000);
    let sendAt = nextSendTime({ now: cursor, delayMs: 0, quietHours: machineHours(config.autoSend) });
    cursor = Date.parse(sendAt);
    i++;
    // Their week is spent (shared/buyer-touch.js): the deal keeps its seat
    // on the wave and goes when their week opens, with anything else new for
    // them in the same text (reply-agent.js sendReplyDraft). The email that
    // goes with it, when they asked for one, goes then too.
    let waits = "";
    // A deal text waits only when Matt asks it to (holdDealTexts, off since
    // 2026-10-21: everyone who fits gets the deal the day it's signed).
    if (channels.includes("sms") && !hold.held && willSchedule && da.touchBudget.enabled && da.touchBudget.holdDealTexts) {
      const limit = await buyerTouchLimit({ store, locationId, contactId, budget: da.touchBudget, now });
      if (!limit.open) {
        const opens = spreadAcrossDay({ now: limit.at, quietHours: machineHours(config.autoSend), hours: 0, weekends: config.autoSend.weekends || "all" });
        if (Date.parse(opens) > Date.parse(sendAt)) {
          sendAt = opens;
          waits = `waits for this buyer's weekly limit — goes ${slotWord(Date.parse(opens))}, with anything else new for them`;
          waiting++;
        }
      }
    }
    // One open blast per buyer per deal and channel: a second click
    // supersedes the first.
    const open = dryRun ? [] : await store.listReplyDrafts(locationId, { contactId, status: ["draft", "scheduled"], limit: 5 }).catch(() => []);
    const replaced = open.filter((d) => d.outbound?.kind === "blast_open" && d.outbound?.offerId === offer.id && channels.includes(d.channel === "email" ? "email" : "sms"));
    for (const old of replaced) {
      await store.updateReplyDraft(old.id, { ...old, status: "superseded", sendAt: null, updatedAt: iso(now) }).catch(() => {});
    }
    for (const channel of channels) {
      // An email waits for you unless emailed deals may send themselves.
      const schedule = !hold.held && willSchedule && (channel === "sms" || da.email.autoSend);
      const subject = channel === "email" ? blastSubject(facts, { presell }) : "";
      // Said on the row, so the outbox and the wave preview show why this
      // buyer gets an email as well as the text.
      const flags = [channel === "sms" ? waits : "", channel === "email" && inv.phone && !inv.channel ? "they asked for deals by email too — the text goes as well" : ""].filter(Boolean);
      if (dryRun) { rows.push({ contactId, name, channel, status: "would queue", sendAt: schedule ? sendAt : null, text, ...(channel === "sms" && waits ? { waits } : {}), ...(subject ? { subject } : {}) }); continue; }
      const ts = iso(now);
      const record = await store.createReplyDraft({
        locationId, contactId, contactName: name, status: schedule ? "scheduled" : "draft", channel, jobId: null,
        inbound: "", outbound: { kind: "blast_open", offerId: offer.id, address: offer.address, label: label || "", variant, ...(ownLine ? { note: ownLine } : {}),
          ...(intro ? { intro } : {}), ...(subject ? { subject } : {}), ...(presell ? { presell: true } : {}), ...(inv.asked ? { asked: true } : {}) },
        reply: text, intent: "blast_open", confidence: "high", needsHuman: Boolean(presell), humanReason: presell ? PRESELL_WAITS : "",
        summary: presell
          ? `Pre-sells ${offer.address} to ${name || "a buyer"} at about ${facts.price ? `$${facts.price.toLocaleString("en-US")}` : "the buyer price"}, before we sign.`
          : `Puts ${offer.address} in front of ${name || "a buyer"} at ${facts.price ? `$${facts.price.toLocaleString("en-US")}` : "the buyer price"}.`,
        propertyAddress: offer.address || "", counterAmount: null, autoSendable: !presell, flags, party: "investor", partySource: "deal",
        matchedTags: { agent: [], investor: [] }, contextSummary: { deal: offer.id }, offersInContext: 0,
        autoSend: { decided: schedule, reason: schedule ? "" : presell ? `needs a person: ${PRESELL_WAITS}` : hold.held ? `${holdText(hold)} — it waits for you` : (willSchedule ? "emailed deals wait for you (Settings → Dispositions)" : reason) }, humanActive: null, actions: [],
        supersededIds: replaced.filter((o) => (o.channel === "email" ? "email" : "sms") === channel).map((o) => o.id), warnings: [], noteOnAutoSend: config.notes?.onAutoSend !== false, promptVersion: 3,
        ...(schedule ? { sendAt, scheduledAt: ts } : {}), updatedAt: ts,
      });
      if (schedule) queued++; else drafted++;
      rows.push({ contactId, name, channel, status: schedule ? "scheduled" : "draft", draftId: record.id, sendAt: schedule ? sendAt : null, text, ...(channel === "sms" && waits ? { waits } : {}), ...(subject ? { subject } : {}) });
    }
  }
  return { queued, drafted, waiting, dryRun: Boolean(dryRun), scheduled: willSchedule, reason, rows, price: facts.price };
}

/* ---------- resume after a stop ---------- */

// The flag Stop leaves on a deal text it pulled back (reply-agent.js
// stopDealOutreach, and the same guard at send time).
const STOP_PULLED = /^you stopped outreach on .+ — not sent$/;

/**
 * pulledBackBlasts(drafts, offer) → [{ contactId, name, channel, label }]
 *
 * The buyers whose deal text for this offer Stop pulled back and nothing has
 * replaced: their newest blast for it is one Stop dismissed, and none was
 * ever sent. A text you dismissed yourself, or one queued again since, is
 * not theirs to get back. Pure.
 */
export function pulledBackBlasts(drafts = [], offer = {}) {
  const byContact = new Map();
  for (const d of drafts) {
    if (d?.party !== "investor" || d.outbound?.kind !== "blast_open" || d.outbound.offerId !== offer.id || !d.contactId) continue;
    if (!byContact.has(d.contactId)) byContact.set(d.contactId, []);
    byContact.get(d.contactId).push(d);
  }
  const out = [];
  for (const [contactId, list] of byContact) {
    if (list.some((d) => d.status === "sent" || d.status === "sending")) continue;
    const newest = list.reduce((a, b) => (String(b.createdAt || "") >= String(a.createdAt || "") ? b : a));
    if (newest.status !== "dismissed" || !(newest.flags || []).some((f) => STOP_PULLED.test(String(f)))) continue;
    out.push({ contactId, name: newest.contactName || "", channel: newest.channel || "sms", label: newest.outbound.label || "" });
  }
  return out;
}

/**
 * resumePulledBack({ store, locationId, offer, saved, now, sendsEnabled, blastsEnabled, startAfterMs, deps })
 *   → { pulledBack, dropped, queued, drafted, scheduled, reason, rows }
 *
 * Resume after Stop (Matt, 2026-10-04, 9311 12th Pl SE: stopped right after
 * the deal was made, resumed, and nobody heard about it). The deal texts Stop
 * pulled back are queued again, for the buyers who still fit the deal
 * right now (`deps.eligible()`: the dispo router's own match, nobody left out
 * for having been sent it). A buyer who has since passed, unsubscribed or
 * committed to another deal stays out. Queued the way a wave is: staggered,
 * priced as each sends, and held for anyone you stopped the bot on.
 */
export async function resumePulledBack({ store = defaultStore, locationId, offer, saved = {}, now = Date.now(), sendsEnabled = false, blastsEnabled = DISPO_BLASTS_ENABLED, startAfterMs = 0, deps = {} }) {
  const drafts = await store.listReplyDrafts(locationId, {
    status: ["dismissed", "sent", "sending", "scheduled", "draft", "superseded"], since: offer?.deal?.createdAt || null, limit: 5000,
  });
  const pulled = pulledBackBlasts(drafts, offer);
  if (!pulled.length) return { pulledBack: 0, dropped: 0, queued: 0, drafted: 0, rows: [] };
  const fit = new Map(((await deps.eligible?.()) || []).map((i) => [i.contactId, i]));
  const investors = pulled.filter((p) => fit.has(p.contactId)).map((p) => fit.get(p.contactId));
  const label = pulled.find((p) => p.label)?.label || "";
  const r = investors.length
    ? await queueBlastDrafts({ store, locationId, offer, investors, saved, now, sendsEnabled, blastsEnabled, label, startAfterMs })
    : { queued: 0, drafted: 0, rows: [] };
  return { ...r, pulledBack: pulled.length, dropped: pulled.length - investors.length };
}

/* ---------- the morning catch-up ---------- */

const jobs = new Map();
export const getDispoJob = (locationId) => jobs.get(locationId) || null;
export function _resetJobs() { jobs.clear(); }

/**
 * catchUpDue(deal) → { due, why, sends }
 *
 * Whether the morning catch-up looks at this deal: under contract, sent from
 * the app at least once, and nobody committed or probably taking it. No
 * count and no delay — a buyer who fits and hasn't had it is owed it now.
 * `sends` is how many times the app has sent it. Pure.
 */
export function catchUpDue(d = {}) {
  const blasts = Array.isArray(d.blasts) ? d.blasts : [];
  const none = (why) => ({ due: false, why, sends: blasts.length });
  if (d.stage !== "under_contract") return none(`the deal is ${String(d.stage || "not live").replace(/_/g, " ")}`);
  // A deal only ever blasted through a GHL workflow is left alone: an
  // automatic send on an old deal would surprise.
  if (!blasts.length) return none("not sent from the app yet");
  // Committed, or somebody probably taking it: the catch-up is new outreach.
  const paused = dealOutreachPaused(d);
  if (paused) return none(paused.status === "stopped" ? "you stopped outreach" : paused.status === "committed" ? "a buyer committed" : "a buyer is probably taking it");
  return { due: true, why: "", sends: blasts.length };
}

/**
 * catchUpCandidates({ store, locationId }) → [{ offer, send }]
 *
 * Live deals the catch-up looks at, and the number its next send would be.
 * Pure read.
 */
export async function catchUpCandidates({ store = defaultStore, locationId }) {
  const deals = await store.listDeals(locationId).catch(() => []);
  const out = [];
  for (const o of deals) {
    const c = catchUpDue(o.deal || {});
    if (c.due) out.push({ offer: o, send: c.sends + 1 });
  }
  return out;
}

/**
 * startDispoSweep({ locationId, client, saved, store, deps, now }) → job
 *
 * `deps.matchForDeal(locationId, offer, { exclude })` and `deps.blastFromApp(...)`
 * are the dispo router's own functions. Everyone new who fits, no cap; a
 * deal nobody new fits sends nothing.
 */
export function startDispoSweep({ locationId, client, saved = {}, store = defaultStore, deps = {}, trigger = "manual", now = Date.now(), onDone = null }) {
  const existing = jobs.get(locationId);
  if (existing?.status === "running") throw Object.assign(new Error("a dispo sweep is already running"), { http: 409 });
  const job = { id: `ds-${Date.now().toString(36)}`, locationId, trigger, status: "running", startedAt: iso(now), finishedAt: null, deals: 0, blasted: 0, results: [], error: null };
  jobs.set(locationId, job);
  (async () => {
    const cands = await catchUpCandidates({ store, locationId });
    job.deals = cands.length;
    for (const { offer, send } of cands) {
      try {
        const m = await deps.matchForDeal(locationId, offer, { exclude: "blasted" });
        const picked = m.results || [];
        if (!picked.length) { job.results.push({ offerId: offer.id, address: offer.address, blasted: 0, reason: "nobody new fits it" }); continue; }
        const r = await deps.blastFromApp({ locationId, client, offer, investors: picked, saved, now, wave: send });
        job.blasted += r.queued + r.drafted;
        job.results.push({ offerId: offer.id, address: offer.address, blasted: r.queued + r.drafted, scheduled: r.scheduled, reason: r.reason });
      } catch (e) {
        job.results.push({ offerId: offer.id, address: offer.address, blasted: 0, reason: String(e?.message || e).slice(0, 160) });
      }
    }
    job.status = "done"; job.finishedAt = new Date().toISOString();
  })().catch((e) => { job.status = "error"; job.error = String(e?.message || e).slice(0, 300); job.finishedAt = new Date().toISOString(); })
    .finally(() => onDone?.(job));
  return job;
}

export async function maybeStartDispoSweep({ locationId, client, saved = {}, store = defaultStore, deps = {}, utcHour = DISPO_SWEEP_UTC_HOUR, now = Date.now() }) {
  const h = new Date(now).getUTCHours();
  if (h < utcHour || h >= utcHour + DISPO_WINDOW_HOURS) return false;
  const da = normalizeDispoAutopilot(saved.dispoAutopilot);
  if (!da.autoBlastOnPromote) return false;
  // Once a day, and back the same morning if a deploy killed it (daily-gate.js).
  const gate = await claimDailyRun({ store, locationId, cursorName: CURSOR_NAME, now, hourNow: h, startHour: utcHour,
    windowHours: DISPO_WINDOW_HOURS, running: jobs.get(locationId)?.status === "running" });
  if (!gate.go) return false;
  startDispoSweep({ locationId, client, saved, store, deps, trigger: "daily", now,
    onDone: (job) => closeDailyRun({ store, locationId, cursorName: CURSOR_NAME, failed: job.status === "error", error: job.error,
      last: { id: job.id, status: job.status, deals: job.deals, blasted: job.blasted, finishedAt: job.finishedAt } }) });
  return true;
}
export const DISPO_WINDOW_HOURS = 4;
