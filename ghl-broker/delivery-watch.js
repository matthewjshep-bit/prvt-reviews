// delivery-watch.js — reads back whether each app text arrived (2026-11-09).
//
// sendSms hands back GHL's message id and reply-agent.js stores it on the
// draft as ghlMessageId, but nothing ever asked GHL what became of it. The
// 11-09 audit: 22 of our answers to someone who had just written failed since
// 10-01, 14 of them with nothing delivered in the day after, and 160 machine
// texts went to 104 numbers that had already come back dead (133 failed again).
//
// Every two hours (on the 15-minute tick, gated like the nightly audit:
// cursor written before the run, a stale run retried, at most 12 tries a day)
// it reads the app sends from 2 to 26 hours ago that have no verdict yet, at
// most 100 a run, ~300 ms apart (GHL's rate limit is shared with the broker):
//
//   - the verdict goes on the draft as delivery { status, code, checkedAt };
//   - a failure is a `send_failed` contact event { code, class, kind, channel,
//     draftId, answer, messageId }, deduped on the message id;
//   - a failed answer to their own text (answersInbound) is one Slack #machine
//     line a contact a day (first name and street only) and, for an agent, a
//     Needs Matt card (needs-matt.js reads the events). Never a resend;
//   - a message GHL has no record of (404) is marked unknown and left;
//   - a dead number (shared/delivery.js numberDead: one 30005/30006, or two
//     30003s) stops machine-started texts to them (reply-agent.js); a buyer's
//     also gets the GHL tag "phone-dead", on their book row too, so no pulse
//     or deal picks them;
//   - with dispoAutopilot.retryBlocked on, a deal text the carrier blocked
//     (30007) is drafted once more without its link, per buyer per deal,
//     scheduled the way the original was.
//
// Off until conversationAi.deliveryWatch.enabled. Reads GHL and the store;
// sends nothing itself. Ids, codes and kinds in the cursor and the logs.

import { store as defaultStore } from "./store.js";
import { getMessage as defaultGetMessage, addContactTags as defaultAddContactTags, removeContactTags as defaultRemoveContactTags } from "./ghl.js";
import { recordEvent } from "./contact-record.js";
import { recordError, scrubMessage } from "./app-errors.js";
import { conversationConfig } from "./reply-agent.js";
import { normalizeDispoAutopilot, blastIntro } from "./dispo-autopilot.js";
import { spreadAcrossDay, nextSendTime, machineHours } from "./conversation-scheduler.js";
import { slackApi } from "./slack-notify.js";
import { normalizeSlack, slackOn, streamOn, firstName } from "./shared/slack-notify.js";
import { answersInbound } from "./shared/follow-up.js";
import { dealIsOver, dealOutreachStopped } from "./shared/offer-status.js";
import {
  DELIVERY_CURSOR, SEND_FAILED, SEND_RETRIED, PHONE_OK, PHONE_EVENT_TYPES, PHONE_DEAD_TAG, RETRY_KINDS, retryKey,
  DELIVERY_MIN_AGE_MS, DELIVERY_MAX_AGE_MS, DELIVERY_MAX_PER_RUN,
  deliveryVerdict, classifyFailure, failureWords, numberDead, stripLinks, deliveryRunGate,
} from "./shared/delivery.js";

export const CURSOR_NAME = DELIVERY_CURSOR;
export const PACE_MS = 300;
const SLACK_CLAIM_KEEP_MS = 2 * 86400000;
const iso = (ms) => new Date(ms).toISOString();
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const street = (a) => String(a || "").split(",")[0].trim();
const pacificDay = (t) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(t));

async function readDoc(store, locationId) {
  return (await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null))?.doc || {};
}
async function patchCursor(store, locationId, patch, now = Date.now()) {
  const doc = await readDoc(store, locationId);
  await store.setJobCursor?.(locationId, CURSOR_NAME, { at: iso(now), doc: { ...doc, ...patch } }).catch(() => {});
}

/** slackLine({ name, address, cls }) → the #machine line for an answer that never arrived. First name and street only. */
export function slackLine({ name = "", address = "", cls = "other" } = {}) {
  const who = firstName(name);
  const on = street(address);
  return `Our answer to ${who || "them"}${on ? ` on ${on}` : ""} never arrived (${failureWords(cls)}). Call or email.`;
}

/**
 * runDeliveryWatch({ client, locationId, saved, store, now, sendsEnabled, blastsEnabled, deps, pace })
 *   → { checked, delivered, pending, failed, byClass, answers, dead, tagged, retried, posted, errors, finishedAt }
 *
 *   deps.getMessage, deps.addContactTags, deps.slackApi — stubs in tests
 */
export async function runDeliveryWatch({
  client, locationId, saved = {}, store = defaultStore, now = Date.now(), sendsEnabled = false,
  blastsEnabled = process.env.DISPO_BLASTS_ENABLED === "true", deps = {}, pace = PACE_MS,
} = {}) {
  const read = deps.getMessage || defaultGetMessage;
  const tag = deps.addContactTags || defaultAddContactTags;
  const da = normalizeDispoAutopilot(saved?.dispoAutopilot);
  const out = { checked: 0, delivered: 0, pending: 0, failed: 0, unknown: 0, byClass: {}, answers: 0, dead: 0, tagged: 0, revived: 0, retried: 0, posted: 0, errors: 0, finishedAt: null };
  const drafts = await store.listSentDraftsBetween(locationId, iso(now - DELIVERY_MAX_AGE_MS), iso(now - DELIVERY_MIN_AGE_MS), { limit: DELIVERY_MAX_PER_RUN });
  const unarrived = [];
  for (const [i, d] of drafts.entries()) {
    if (i > 0 && pace > 0) await sleep(pace);
    let msg;
    try { msg = await read(client, d.ghlMessageId); }
    catch (e) {
      out.errors++;
      if (out.errors === 1) await recordError(store, { locationId, area: "delivery-watch", err: e, context: { draftId: d.id } });
      // A message GHL doesn't have (404) is marked unknown and not read again
      // every run; anything else (a blip, a 429) is looked at next run.
      if (Number(e?.status) === 404) {
        const fresh = await store.getReplyDraft(d.id).catch(() => null);
        if (fresh && !fresh.delivery) await store.updateReplyDraft(d.id, { ...fresh, delivery: { status: "unknown", code: null, checkedAt: iso(now) } });
        out.unknown++;
      }
      continue;
    }
    out.checked++;
    const v = deliveryVerdict(msg);
    if (v.pending) { out.pending++; continue; }
    // Written on a fresh read (the draft may have moved since the list), and
    // without touching updatedAt: the verdict is not an edit.
    const fresh = await store.getReplyDraft(d.id).catch(() => null);
    if (!fresh || fresh.delivery) continue;
    await store.updateReplyDraft(d.id, { ...fresh, delivery: { status: v.status, code: v.code, checkedAt: iso(now) } });
    const channel = d.channel === "email" ? "email" : "sms";
    const party = d.party === "investor" ? "investor" : d.party || "agent";
    if (!v.failed) {
      out.delivered++;
      // A text to a number we had as dead arrived after all (an answer, or a
      // person's send: machine texts to it are binned): it's alive again.
      if (channel === "sms" && (answersInbound(d) || !d.autoSent) && await phoneRevived({ store, locationId, draft: d, client, untag: deps.removeContactTags || defaultRemoveContactTags, party })) out.revived++;
      continue;
    }

    out.failed++;
    const cls = classifyFailure(v.code, channel);
    out.byClass[cls] = (out.byClass[cls] || 0) + 1;
    const answer = answersInbound(d);
    const kind = d.outbound?.kind || "";
    const address = d.outbound?.address || d.propertyAddress || "";
    const offerId = d.outbound?.offerId || null;
    const rec = await recordEvent({
      store, locationId, contactId: d.contactId, party, type: SEND_FAILED, at: d.sentAt || iso(now), address, offerId,
      source: "ghl", ref: d.id, dedupeKey: `send_failed:${d.ghlMessageId}`,
      data: { code: v.code, class: cls, kind, channel, draftId: d.id, answer, messageId: d.ghlMessageId, auto: Boolean(d.autoSent) },
    });
    if (!rec.inserted) continue;

    if (answer) {
      out.answers++;
      unarrived.push({ contactId: d.contactId, name: d.contactName || "", address, cls });
    }
    if (channel === "sms" && (cls === "dead_number" || cls === "unreachable")) {
      const events = await store.listContactEvents(locationId, d.contactId, { types: [...PHONE_EVENT_TYPES], limit: 50 }).catch(() => []);
      if (numberDead(events)) {
        out.dead++;
        if (party === "investor") {
          await tag(client, d.contactId, [PHONE_DEAD_TAG]).then(() => { out.tagged++; })
            .catch((e) => recordError(store, { locationId, area: "delivery-watch", err: e, context: { contactId: d.contactId, stage: "tag" } }));
          await tagBuyerRow({ store, locationId, contactId: d.contactId, dead: true });
        }
      }
    }
    if (da.retryBlocked && channel === "sms" && cls === "carrier_block" && RETRY_KINDS.has(kind)) {
      const r = await queueRetry({ store, locationId, saved, da, draft: d, now, sendsEnabled, blastsEnabled }).catch((e) => ({ skipped: scrubMessage(e) }));
      if (r?.queued) out.retried++;
    }
  }
  out.posted = await postUnarrived({ store, locationId, saved, lines: unarrived, now, deps });
  out.finishedAt = iso(Date.now());
  return out;
}

// A delivered text to a contact numberDead has as dead: `phone_ok` on their
// timeline (the strikes before it stop counting) and, for a buyer, the
// phone-dead tag comes off. True when it was dead.
async function phoneRevived({ store, locationId, draft: d, client, untag, party }) {
  const events = await store.listContactEvents(locationId, d.contactId, { types: [...PHONE_EVENT_TYPES], limit: 50 }).catch(() => []);
  if (!numberDead(events)) return false;
  const rec = await recordEvent({ store, locationId, contactId: d.contactId, party, type: PHONE_OK, at: d.sentAt, source: "ghl", ref: d.id,
    dedupeKey: `phone_ok:${d.ghlMessageId}`, data: { draftId: d.id, messageId: d.ghlMessageId } });
  if (rec.inserted && party === "investor") {
    await untag(client, d.contactId, [PHONE_DEAD_TAG]).catch((e) => recordError(store, { locationId, area: "delivery-watch", err: e, context: { contactId: d.contactId, stage: "untag" } }));
    await tagBuyerRow({ store, locationId, contactId: d.contactId, dead: false });
  }
  return rec.inserted;
}

// The buyer book's own row (investors.doc.tags) wears the tag at once, so the
// next deal pick and buyer check-in skip them (BLOCK_TAG_RX) without waiting
// for the book sync to read it back from GHL. "last synced" is left alone.
// Best effort: a buyer not in the book, or a failed write, waits for the sync.
async function tagBuyerRow({ store, locationId, contactId, dead }) {
  if (typeof store?.getInvestor !== "function" || typeof store?.updateInvestorDoc !== "function") return false;
  try {
    const row = await store.getInvestor(locationId, contactId);
    if (!row?.doc) return false;
    const rest = (Array.isArray(row.doc.tags) ? row.doc.tags : []).filter((t) => String(t).trim().toLowerCase() !== PHONE_DEAD_TAG);
    return await store.updateInvestorDoc(locationId, contactId, { ...row.doc, tags: dead ? [...rest, PHONE_DEAD_TAG] : rest }, row.buyboxText || null, { synced: false });
  } catch (e) {
    await recordError(store, { locationId, area: "delivery-watch", err: e, context: { contactId, stage: "book" } });
    return false;
  }
}

// One Slack #machine line a contact a day, claimed on the cursor.
async function postUnarrived({ store, locationId, saved, lines, now, deps }) {
  if (!lines.length) return 0;
  const cfg = normalizeSlack(saved?.slack);
  const token = String(saved?.slackBotToken || "").trim();
  if (!slackOn(cfg, token) || !streamOn(cfg, "machine")) return 0;
  const post = deps.slackApi || slackApi;
  const doc = await readDoc(store, locationId);
  const claims = Object.fromEntries(Object.entries(doc.slack || {}).filter(([, at]) => now - (Date.parse(at) || 0) < SLACK_CLAIM_KEEP_MS));
  const day = pacificDay(now);
  let posted = 0;
  for (const l of lines) {
    const key = `${l.contactId}:${day}`;
    if (claims[key]) continue;
    claims[key] = iso(now);
    try {
      await post(token, "chat.postMessage", { channel: cfg.channels.machine, text: slackLine(l), unfurl_links: false, unfurl_media: false });
      posted++;
    } catch (e) {
      await recordError(store, { locationId, area: "delivery-watch", err: e, context: { contactId: l.contactId, stage: "slack" } });
    }
  }
  await patchCursor(store, locationId, { slack: claims }, now);
  return posted;
}

/**
 * queueRetry({ store, locationId, saved, da, draft, now, sendsEnabled, blastsEnabled }) → { queued, draftId } | { skipped }
 *
 * The one retry of a deal text the carrier blocked: claimed per buyer per
 * deal first (a retry that is blocked again is never retried), the same
 * text without its link, or the cold deal text for a buyer who never wrote
 * back when that setting exists. Scheduled the way the original went: by
 * itself only if the original went by itself and the same switches still let
 * it; otherwise a draft waiting for your Send. Every send-time check (a bot
 * stop, a dead number, the deal ending, the carrier words) still applies.
 */
export async function queueRetry({ store = defaultStore, locationId, saved = {}, da = normalizeDispoAutopilot(saved?.dispoAutopilot), draft, now = Date.now(), sendsEnabled = false, blastsEnabled = false }) {
  const d = draft;
  const kind = d?.outbound?.kind || "";
  const offerId = d?.outbound?.offerId || null;
  if (!RETRY_KINDS.has(kind) || !d.contactId) return { skipped: "not a deal text" };
  if (!offerId) return { skipped: "no deal on it" };
  const offer = await store.getOffer?.(offerId).catch(() => null);
  if (!offer?.deal || offer.locationId !== locationId) return { skipped: "the deal is gone" };
  if (dealIsOver(offer.deal)) return { skipped: `the deal is ${String(offer.deal.stage || "").replace(/_/g, " ")}` };
  if (dealOutreachStopped(offer.deal)) return { skipped: "you stopped outreach on the deal" };
  const claim = await recordEvent({
    store, locationId, contactId: d.contactId, party: "investor", type: SEND_RETRIED, at: iso(now), address: offer.address || d.outbound.address || "",
    offerId, source: "ghl", ref: d.id, dedupeKey: retryKey(offerId, d.contactId), data: { draftId: d.id, kind, code: "30007" },
  });
  if (!claim.inserted) return { skipped: "already retried once" };

  const config = conversationConfig(saved);
  const inv = await store.getInvestor?.(locationId, d.contactId).catch(() => null);
  const buyer = inv ? { tags: inv.doc?.tags || inv.tags || [], lastRepliedAt: inv.doc?.lastRepliedAt || inv.lastRepliedAt || null } : null;
  // The cold deal text (dispoAutopilot.coldDealText) when the setting exists
  // and the buyer never wrote back; the send-time rewrite uses it.
  const cold = kind === "blast_open" && typeof da.coldDealText === "string" && da.coldDealText.trim() && buyer && !buyer.lastRepliedAt ? da.coldDealText.trim() : "";
  const outbound = {
    ...d.outbound, retryOf: d.id, noLink: true,
    ...(kind === "blast_open" && buyer ? { intro: blastIntro(buyer) } : {}),
    ...(cold ? { template: cold } : {}),
  };
  const pb = config.parties?.investor || {};
  const allowed = Boolean(pb.autoSend?.enabled && (pb.autoSend.intents || []).includes(kind));
  // A follow-up deal text went by itself through decideAutoSend, which also
  // asks that texts are an auto-send channel; its retry asks the same.
  const textsAuto = kind !== "blast_nudge" || (config.autoSend?.channels || []).includes("sms");
  const schedule = Boolean(d.autoSent) && config.enabled && sendsEnabled && allowed && textsAuto && (kind !== "blast_open" || blastsEnabled);
  const why = !d.autoSent ? "the first one waited for your Send, so this one does too"
    : !sendsEnabled ? "sends are off on the broker (CARD_SENDS_ENABLED)"
      : kind === "blast_open" && !blastsEnabled ? "blasts are off on the broker (DISPO_BLASTS_ENABLED)"
        : !config.enabled ? "Conversation AI is switched off" : !allowed ? `'${kind}' is not on the investor auto-send list`
          : !textsAuto ? "texts are not an auto-send channel (Conversation AI → auto-send)" : "";
  const quiet = machineHours(config.autoSend);
  const sendAt = schedule ? nextSendTime({ now: Date.parse(spreadAcrossDay({ now, quietHours: quiet, hours: 0, weekends: config.autoSend.weekends || "all" })), delayMs: 0, quietHours: quiet }) : null;
  const ts = iso(now);
  const on = street(offer.address || d.outbound.address);
  const record = await store.createReplyDraft({
    locationId, contactId: d.contactId, contactName: d.contactName || "", status: schedule ? "scheduled" : "draft", channel: "sms", jobId: null,
    inbound: "", outbound, reply: stripLinks(d.sentText || d.reply || ""), intent: kind, confidence: "high", needsHuman: false, humanReason: "",
    summary: `Sends ${on || "the deal"} again without the link: the carrier blocked the first text.`,
    propertyAddress: offer.address || d.propertyAddress || "", counterAmount: null, autoSendable: true,
    flags: ["the carrier blocked the first text: one retry without the link, never another"],
    party: "investor", partySource: "deal", matchedTags: { agent: [], investor: [] }, contextSummary: { deal: offerId }, offersInContext: 0,
    autoSend: { decided: schedule, reason: schedule ? "" : why }, humanActive: null, actions: [], supersededIds: [], warnings: [],
    noteOnAutoSend: config.notes?.onAutoSend !== false, promptVersion: 3,
    ...(schedule ? { sendAt, scheduledAt: ts } : {}), updatedAt: ts,
  });
  return { queued: true, draftId: record.id, scheduled: schedule, reason: why };
}

/* ---------- the tick ---------- */

const running = new Set();
export function _resetDeliveryWatch() { running.clear(); }

// What a run did, for the cursor: counts, never who or what was said.
export const summarizeDeliveryWatch = (r) => ({
  finishedAt: r?.finishedAt || null, checked: r?.checked ?? 0, delivered: r?.delivered ?? 0, pending: r?.pending ?? 0,
  failed: r?.failed ?? 0, unknown: r?.unknown ?? 0, byClass: r?.byClass || {}, answers: r?.answers ?? 0, dead: r?.dead ?? 0, tagged: r?.tagged ?? 0, revived: r?.revived ?? 0,
  retried: r?.retried ?? 0, posted: r?.posted ?? 0, errors: r?.errors ?? 0,
});

/**
 * maybeRunDeliveryWatch({ client, locationId, saved, store, now, sendsEnabled, blastsEnabled, deps })
 *   → null | { started: true, tries, done }
 *
 * Off unless conversationAi.deliveryWatch.enabled: nothing is read. The run
 * goes on in the background (`done` settles when it's over), so the tick's
 * other jobs don't wait 30 seconds on GHL.
 */
export async function maybeRunDeliveryWatch({ client, locationId, saved = {}, store = defaultStore, now = Date.now(), sendsEnabled = false, blastsEnabled, deps = {}, pace = PACE_MS }) {
  if (!conversationConfig(saved).deliveryWatch?.enabled) return null;
  if (running.has(locationId)) return null;
  const doc = await readDoc(store, locationId);
  const gate = deliveryRunGate(doc, now);
  if (!gate.go) return null;
  // The cursor first, so a deploy mid-run leaves a run to retry, not a gap.
  await store.setJobCursor?.(locationId, CURSOR_NAME, {
    at: iso(now), doc: { ...doc, day: gate.day, tries: gate.tries, lastRun: iso(now), run: { startedAt: iso(now) }, failed: false, error: "", ...(gate.stale ? { staleRun: doc.run } : {}) },
  }).catch(() => {});
  running.add(locationId);
  const done = runDeliveryWatch({ client, locationId, saved, store, now, sendsEnabled, ...(blastsEnabled === undefined ? {} : { blastsEnabled }), deps, pace })
    .then(async (r) => { await patchCursor(store, locationId, { run: null, failed: false, last: summarizeDeliveryWatch(r) }); return r; })
    .catch(async (e) => {
      const error = scrubMessage(e).slice(0, 200);
      await recordError(store, { locationId, area: "delivery-watch", err: e, context: { stage: "run" } });
      await patchCursor(store, locationId, { run: null, failed: true, error, last: { status: "error", error, finishedAt: iso(Date.now()) } });
      return null;
    })
    .finally(() => running.delete(locationId));
  return { started: true, tries: gate.tries, done };
}
