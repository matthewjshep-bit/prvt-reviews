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
//   Blast on promote: a deal is minted → the top-ranked VIP/Active buyers for
//   it (buyer-score.js rankForDeal: where they buy, price, recency, tier,
//   strategy) are blasted, VIPs first.
//   Second wave: no committed buyer after N hours → the next-ranked buyers
//   who haven't been sent it.
//   The guarded dataroom invite and the assignment on commit live in the
//   offers router's deps; this file holds the settings and the queue.

import { store as defaultStore } from "./store.js";
import { blastMessage, blastNote, dealFacts, blastSubject } from "./shared/blast-text.js";
import { normalizeBookSync } from "./investor-sync.js";
import { normalizeBuyerPulse } from "./shared/buyer-pulse.js";
import { walkthroughAsk } from "./shared/showing.js";
import { dealNumbers } from "./dataroom.js";
import { dealOutreachPaused } from "./shared/offer-status.js";
import { conversationConfig } from "./reply-agent.js";
import { nextSendTime, spreadAcrossDay } from "./conversation-scheduler.js";
import { claimDailyRun, closeDailyRun } from "./daily-gate.js";
import { botEventsByContact } from "./bot-hold.js";
import { botHold, holdLine } from "./shared/bot-hold.js";

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
    autoBlastOnPromote: o.autoBlastOnPromote === true,
    autoBlastCount: n(o.autoBlastCount, 25, 1, 200),
    secondWaveHours: n(o.secondWaveHours, 48, 6, 720),
    secondWaveCount: n(o.secondWaveCount, 25, 1, 200),
    // Match score (rankForDeal, 0–100) a buyer needs to make each wave.
    minMatchScore: n(o.minMatchScore, 50, 0, 100),
    secondWaveMinScore: n(o.secondWaveMinScore, 35, 0, 100),
    // How many app waves a deal gets in all. 2 = the first plus one more,
    // which is how it has always run; 3 adds a third to the next ranked
    // buyers `secondWaveHours` after the second.
    maxWaves: n(o.maxWaves, 2, 1, 4),
    autoInvite: o.autoInvite === true,
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

/** blastIntro({ tags, lastRepliedAt }) → the how-we-found-you line for a buyer who has never written back, or "". */
export function blastIntro(inv = {}) {
  if (inv.lastRepliedAt) return "";
  const tags = (inv.tags || []).map((t) => String(t || "").toLowerCase());
  for (const t of tags) if (SOURCE_INTROS[t]) return SOURCE_INTROS[t];
  return tags.some((t) => t.startsWith("dispo-source-fb")) ? "found you through a real estate Facebook group" : "";
}

/**
 * blastChannel(inv, da) → "sms" | "email" | ""
 *
 * A phone is texted. No phone and an email is emailed, when email drafting
 * is on. A caller that knows neither (an older shortlist of ids and names)
 * gets a text, as it always has; one that knows there is no way to reach
 * them gets "" and the buyer is skipped.
 */
export function blastChannel(inv = {}, da = normalizeDispoAutopilot({})) {
  if (inv.phone) return "sms";
  if (inv.phone === undefined && inv.email === undefined) return "sms";
  if (inv.email && da.email.draft) return "email";
  return "";
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

/** blastAsk(offer, saved, now) → the walkthrough question for this deal's blast, or "". */
export function blastAsk(offer, saved = {}, now = Date.now()) {
  const da = normalizeDispoAutopilot(saved?.dispoAutopilot);
  return da.showings.askInBlast ? walkthroughAsk({ showing: offer?.deal?.showing || null, now }) : "";
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
 */
export async function queueBlastDrafts({ store = defaultStore, locationId, offer, investors = [], saved = {}, now = Date.now(), dryRun = false, sendsEnabled = false, blastsEnabled = DISPO_BLASTS_ENABLED, label = "", startAfterMs = 0, note: noteOverride = "" }) {
  const da = normalizeDispoAutopilot(saved.dispoAutopilot);
  const config = conversationConfig(saved);
  const pb = config.parties.investor;
  const allowed = Boolean(pb.autoSend?.enabled && (pb.autoSend.intents || []).includes("blast_open"));
  const live = !dryRun && sendsEnabled && blastsEnabled;
  const willSchedule = live && config.enabled && allowed;
  const reason = !live ? (dryRun ? "dry run" : !sendsEnabled ? "sends are off on the broker (CARD_SENDS_ENABLED)" : "blasts are off on the broker (DISPO_BLASTS_ENABLED)")
    : !config.enabled ? "Conversation AI is switched off" : !allowed ? "'sent them a deal' is not on the investor auto-send list" : "";

  const numbers = dealNumbers({ offer, settings: saved });
  // The operator's own line about the deal, off its dataroom headline. That
  // headline is already written for buyers — it is the one sentence they'd
  // read at the top of the package — so it belongs in the text that offers
  // them the deal. Best-effort: a missing room just means a shorter message.
  // A line the operator wrote for this blast wins over the headline.
  const ownLine = blastNote(noteOverride);
  let note = ownLine;
  if (!note) try {
    const rooms = await store.listDatarooms(locationId, { offerId: offer.id, limit: 5 });
    const room = rooms.find((r) => r.status === "active" && r.kind !== "portfolio" && r.kind !== "offer");
    note = room?.snapshot?.headline || "";
  } catch { /* the line is a courtesy, never the message */ }
  const facts = dealFacts(offer, { price: numbers.investorPrice, note });
  const ask = blastAsk(offer, saved, now);
  // Buyers you stopped the bot on (shared/bot-hold.js): their deal text is
  // drafted and waits for you. One read for the whole list; a read that
  // fails holds every text rather than guess.
  const stops = dryRun ? new Map() : await botEventsByContact({ store, locationId }).catch(() => null);
  const holdOf = (cid) => (stops ? botHold({ events: stops.get(cid) || [], now }) : { held: true, kind: "unread" });
  const rows = [];
  let queued = 0, drafted = 0, i = 0;
  // Cumulative: each text lands at least `spreadSec` after the one before,
  // plus a little jitter so the gaps aren't a metronome. nextSendTime rolls
  // anything past the close into the next open window.
  // The first text lands at the next open minute — on a weekday, unless the
  // page allows weekends — and the rest follow it.
  let cursor = Date.parse(spreadAcrossDay({ now: now + Math.max(0, Number(startAfterMs) || 0), quietHours: config.autoSend.quietHours, hours: 0, weekends: config.autoSend.weekends || "all" }));
  for (const inv of investors) {
    const contactId = inv.contactId;
    if (!contactId) continue;
    const name = inv.name || inv.doc?.name || "";
    const channel = blastChannel(inv, da);
    if (!channel) { rows.push({ contactId, name, status: "skipped", reason: "no phone, and email drafting is off", text: "" }); continue; }
    // An email waits for you unless emailed deals may send themselves.
    const hold = holdOf(contactId);
    const schedule = !hold.held && willSchedule && (channel === "sms" || da.email.autoSend);
    const intro = blastIntro(inv);
    const variant = i;
    const text = blastMessage({ ...facts, firstName: name, variant, ask, intro });
    const subject = channel === "email" ? blastSubject(facts) : "";
    if (i > 0) cursor += da.spreadSec * 1000 + Math.round(Math.random() * 15000);
    const sendAt = nextSendTime({ now: cursor, delayMs: 0, quietHours: config.autoSend.quietHours });
    cursor = Date.parse(sendAt);
    i++;
    if (dryRun) { rows.push({ contactId, name, channel, status: "would queue", sendAt: schedule ? sendAt : null, text, ...(subject ? { subject } : {}) }); continue; }
    // One open blast per buyer per deal: a second click supersedes the first.
    const open = await store.listReplyDrafts(locationId, { contactId, status: ["draft", "scheduled"], limit: 5 }).catch(() => []);
    for (const old of open.filter((d) => d.outbound?.kind === "blast_open" && d.outbound?.offerId === offer.id)) {
      await store.updateReplyDraft(old.id, { ...old, status: "superseded", sendAt: null, updatedAt: iso(now) }).catch(() => {});
    }
    const ts = iso(now);
    const record = await store.createReplyDraft({
      locationId, contactId, contactName: name, status: schedule ? "scheduled" : "draft", channel, jobId: null,
      inbound: "", outbound: { kind: "blast_open", offerId: offer.id, address: offer.address, label: label || "", variant, ...(ownLine ? { note: ownLine } : {}),
        ...(intro ? { intro } : {}), ...(subject ? { subject } : {}) },
      reply: text, intent: "blast_open", confidence: "high", needsHuman: false, humanReason: "",
      summary: `Puts ${offer.address} in front of ${name || "a buyer"} at ${facts.price ? `$${facts.price.toLocaleString("en-US")}` : "the buyer price"}.`,
      propertyAddress: offer.address || "", counterAmount: null, autoSendable: true, flags: [], party: "investor", partySource: "deal",
      matchedTags: { agent: [], investor: [] }, contextSummary: { deal: offer.id }, offersInContext: 0,
      autoSend: { decided: schedule, reason: schedule ? "" : hold.held ? `${holdLine(hold)} — it waits for you` : (willSchedule ? "emailed deals wait for you (Settings → Dispositions)" : reason) }, humanActive: null, actions: [],
      supersededIds: open.map((o) => o.id), warnings: [], noteOnAutoSend: config.notes?.onAutoSend !== false, promptVersion: 3,
      ...(schedule ? { sendAt, scheduledAt: ts } : {}), updatedAt: ts,
    });
    if (schedule) queued++; else drafted++;
    rows.push({ contactId, name, channel, status: schedule ? "scheduled" : "draft", draftId: record.id, sendAt: schedule ? sendAt : null, text, ...(subject ? { subject } : {}) });
  }
  return { queued, drafted, dryRun: Boolean(dryRun), scheduled: willSchedule, reason, rows, price: facts.price };
}

/* ---------- the second wave ---------- */

const jobs = new Map();
export const getDispoJob = (locationId) => jobs.get(locationId) || null;
export function _resetJobs() { jobs.clear(); }

/**
 * nextWave(deal, da, now) → { wave, dueAt, due, why }
 *
 * The deal's next automatic wave: its number, when it's due (the wave delay
 * after the last one), and, when there is none, why. Pure.
 */
export function nextWave(d = {}, da = normalizeDispoAutopilot({}), now = Date.now()) {
  const none = (why) => ({ wave: null, dueAt: null, due: false, why });
  if (d.stage !== "under_contract") return none(`the deal is ${String(d.stage || "not live").replace(/_/g, " ")}`);
  // Waves sent from the app. A deal only ever blasted through a GHL
  // workflow is left alone: an automatic wave on an old deal would surprise.
  const blasts = Array.isArray(d.blasts) ? d.blasts : [];
  if (!blasts.length) return none("no wave from the app yet");
  if (blasts.length >= da.maxWaves) return none(`all ${da.maxWaves} wave${da.maxWaves === 1 ? "" : "s"} sent`);
  // Committed, or somebody probably taking it: the wave is new outreach.
  const paused = dealOutreachPaused(d);
  if (paused) return none(paused.status === "committed" ? "a buyer committed" : "a buyer is probably taking it");
  const at = Date.parse(blasts[blasts.length - 1].at || "");
  if (!Number.isFinite(at)) return none("the last wave has no time on it");
  const dueMs = at + da.secondWaveHours * 3600000;
  return { wave: blasts.length + 1, dueAt: new Date(dueMs).toISOString(), due: dueMs <= now, why: "" };
}

/**
 * secondWaveCandidates({ store, locationId, saved, now }) → [{ offer, blastedAt, wave }]
 *
 * Live deals with an app wave behind them and waves left (maxWaves), with
 * nobody committed, whose last wave is older than the wave delay. Pure read.
 */
export async function secondWaveCandidates({ store = defaultStore, locationId, saved = {}, now = Date.now() }) {
  const da = normalizeDispoAutopilot(saved.dispoAutopilot);
  const deals = await store.listDeals(locationId).catch(() => []);
  const out = [];
  for (const o of deals) {
    const n = nextWave(o.deal || {}, da, now);
    if (!n.due) continue;
    out.push({ offer: o, blastedAt: o.deal.blasts.at(-1).at, wave: n.wave });
  }
  return out;
}
// Every wave after the first is the "next" wave: the same rules, one more.
export const waveCandidates = secondWaveCandidates;

/**
 * startDispoSweep({ locationId, client, saved, store, deps, now }) → job
 *
 * `deps.matchForDeal(locationId, offer, { fit })` and `deps.blastFromApp(...)`
 * are the dispo router's own functions.
 */
export function startDispoSweep({ locationId, client, saved = {}, store = defaultStore, deps = {}, trigger = "manual", now = Date.now(), onDone = null }) {
  const existing = jobs.get(locationId);
  if (existing?.status === "running") throw Object.assign(new Error("a dispo sweep is already running"), { http: 409 });
  const job = { id: `ds-${Date.now().toString(36)}`, locationId, trigger, status: "running", startedAt: iso(now), finishedAt: null, deals: 0, blasted: 0, results: [], error: null };
  jobs.set(locationId, job);
  (async () => {
    const da = normalizeDispoAutopilot(saved.dispoAutopilot);
    const cands = await secondWaveCandidates({ store, locationId, saved, now });
    job.deals = cands.length;
    for (const { offer, wave = 2 } of cands) {
      try {
        const m = await deps.matchForDeal(locationId, offer, { wave: 2, exclude: "blasted" });
        const picked = (m.results || []).slice(0, da.secondWaveCount);
        if (!picked.length) { job.results.push({ offerId: offer.id, address: offer.address, wave, blasted: 0, reason: "no ranked buyers left to send it to" }); continue; }
        const r = await deps.blastFromApp({ locationId, client, offer, investors: picked, saved, now, wave });
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
