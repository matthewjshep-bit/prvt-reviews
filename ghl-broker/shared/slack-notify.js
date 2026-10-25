// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// slack-notify.js — what the app tells Slack, and where.
//
// Matt, 2026-10-24: one place he (and later a VA on acquisitions or
// dispositions) can watch the app work in real time — a house an agent
// raised, an underwrite running, a counter, a deal's buyers. The app is the
// source, not GHL: GHL's stages are a projection of the offers, so only the
// app can say why (the held reasons, their number against ours, which house).
//
// What a message carries, Matt's call the same day: the house, our number and
// theirs, the stage, the person's first name, a one-line summary, and links to
// the app and GHL. Never a phone, an email, a full name, or the words of a text.
//
// Pure: the setting (saved.slack, normalised here), which event goes to which
// channel, and the words. The runner is ghl-broker/slack-notify.js.

import { addressKey } from "./us-address.js";
import { pingWhy } from "./ghl-pings.js";
import { DRAFT_ONLY_RX, wePassReasonOf } from "./offer-status.js";
import { offerStage } from "./offer-stage.js";
import { houseKey, resolveHouse } from "./current-offer.js";

export const SLACK_STREAMS = Object.freeze(["needsMatt", "acquisitions", "underwrites", "dispositions", "machine", "daily"]);
export const SLACK_STREAM_LABEL = Object.freeze({
  needsMatt: "Needs Matt", acquisitions: "Acquisitions", underwrites: "Underwrites",
  dispositions: "Dispositions", machine: "Machine", daily: "Daily",
});
// The channel each stream is meant for, for the setup screen.
export const SLACK_CHANNEL_HINT = Object.freeze({
  needsMatt: "#needs-matt", acquisitions: "#acquisitions", underwrites: "#underwrites",
  dispositions: "#dispositions", machine: "#machine", daily: "#daily",
});

const blankStreams = (v) => Object.fromEntries(SLACK_STREAMS.map((s) => [s, v]));

// Off until Matt has made the Slack app, pasted its token and a channel, and
// switched the stream on. The token itself is saved.slackBotToken, a secret.
export const SLACK_DEFAULTS = Object.freeze({
  enabled: false,
  channels: Object.freeze(blankStreams("")),
  streams: Object.freeze(blankStreams(false)),
  mattUserId: "",
  appUrl: "https://app.shepflips.com",
  // The app inside GHL (a custom menu link), for the posts about no one
  // person (the morning and evening reads). GHL can't hand a contact through
  // to the page it frames, so a post about a person opens the app itself on
  // that person instead (Matt, 2026-10-25: "launches to that specific item").
  appLink: "",
  morningHour: 7,
  eveningHour: 19,
});

/** slackChannelId(v) → a channel id ("C0123ABCD") from an id or a pasted channel link, or "". */
export function slackChannelId(v) {
  const s = String(v || "").trim();
  const m = /(?:^|[/=])([CGD][A-Z0-9]{6,})(?:[/?#&]|$)/i.exec(s);
  return m ? m[1].toUpperCase() : "";
}

/** slackUserId(v) → a member id ("U0123ABCD"), or "". */
export function slackUserId(v) {
  const s = String(v || "").trim().replace(/^<@|>$/g, "");
  return /^[UW][A-Z0-9]{6,}$/i.test(s) ? s.toUpperCase() : "";
}

/** normalizeSlack(v) → { enabled, channels, streams, mattUserId, appUrl, appLink, morningHour, eveningHour } */
export function normalizeSlack(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  const d = SLACK_DEFAULTS;
  const hour = (x, def) => { const k = Math.round(Number(x)); return x == null || x === "" || !Number.isFinite(k) ? def : Math.min(23, Math.max(0, k)); };
  const ch = o.channels && typeof o.channels === "object" ? o.channels : {};
  const st = o.streams && typeof o.streams === "object" ? o.streams : {};
  const url = String(o.appUrl || "").trim().replace(/\/+$/, "");
  return {
    enabled: o.enabled === true,
    channels: Object.fromEntries(SLACK_STREAMS.map((s) => [s, slackChannelId(ch[s])])),
    streams: Object.fromEntries(SLACK_STREAMS.map((s) => [s, st[s] === true])),
    mattUserId: slackUserId(o.mattUserId),
    appUrl: /^https:\/\/[^\s/]+/.test(url) ? url : d.appUrl,
    appLink: /^https:\/\/[^\s<>|]+$/.test(String(o.appLink || "").trim()) ? String(o.appLink).trim() : "",
    morningHour: hour(o.morningHour, d.morningHour),
    eveningHour: hour(o.eveningHour, d.eveningHour),
  };
}

/** slackOn(cfg, token) → whether anything goes to Slack at all. */
export const slackOn = (cfg, token) => Boolean(cfg?.enabled && String(token || "").trim());

/** streamOn(cfg, stream) → that stream is switched on and has a channel. */
export const streamOn = (cfg, stream) => Boolean(cfg?.enabled && cfg?.streams?.[stream] && cfg?.channels?.[stream]);

/* ---------- which event goes where ---------- */

const n = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : null; };
const amountOf = (d = {}) => n(d.amount) ?? n(d.counterAmount) ?? n(d.cashAmount) ?? n(String(d.amountText || "").replace(/[^\d.]/g, ""));
const phraseOf = (ev) => String(ev?.data?.phrase || "").toLowerCase();
// A hot flag reaches the record as a deal-history note (routes/offers.js
// PATCH /:id/hot and raiseOfferHeat): "hot — close to a contract".
const isHotNote = (ev) => ev?.type === "note" && /^(flagged )?hot\b/.test(phraseOf(ev));

// Both draft holds start "ready for your comps" (shared/offer-status.js
// DRAFT_ONLY_HOLD / SKELETON_HOLD); events before data.draftOnly carry only that.
const isDraftOnlyHold = (d = {}) => d.draftOnly === true || (Array.isArray(d.held) && DRAFT_ONLY_RX.test(String(d.held[0] || "")));

const DEAD = { offer_passed: "they passed", offer_we_passed: "we passed", offer_unavailable: "no longer available", offer_no_response: "no response", tier1_passed: "passed from Tier 1" };
const LOUD_STAGES = new Set(["closed", "fell_through"]);

/**
 * routeEvent(ev) → [{ stream, kind, thread, broadcast, update, replyOnly, opensOnly }]
 *
 * #acquisitions is the Tier 1 list (Matt, 2026-10-25: "acquisition should
 * just show tier 1s that have been flagged, not the whole conversations"):
 * a house reaching Tier 1 is the only post in the channel. What follows —
 * the offer, a counter, hot, agreed, contract, the underwrite, a pass —
 * replies quietly in that house's thread, and only once there is one.
 * A house an agent merely named isn't Tier 1 and isn't posted.
 *
 *   thread     "house" (the house's thread in that stream), "deal", "run"
 *              (one message per underwrite run, edited as it goes), or null
 *              (a post of its own)
 *   broadcast  a thread reply that also shows in the channel
 *   update     edit the run's message in place rather than post again
 *   replyOnly  only as a reply in a thread already there: nothing but
 *              Tier 1 opens a house in #acquisitions
 *   opensOnly  only when there's no thread yet: a house moved back into
 *              Tier 1 isn't posted twice
 *   statusOnly posts nothing; only the thread's status emoji is looked at again
 *
 * Empty for anything Slack doesn't hear about.
 */
export function routeEvent(ev = {}) {
  const t = ev?.type;
  const d = ev?.data || {};
  const out = [];
  const base = { broadcast: false, update: false, replyOnly: false, opensOnly: false };
  const acq = (kind, o = {}) => out.push({ stream: "acquisitions", kind, thread: "house", ...base, ...o });
  const uw = (kind, o = {}) => out.push({ stream: "underwrites", kind, thread: "run", ...base, ...o });
  const dispo = (kind, o = {}) => out.push({ stream: "dispositions", kind, thread: "deal", ...base, ...o });
  const investor = ev?.party === "investor";

  const reply = { replyOnly: true };
  if (t === "tier1_added") acq("tier1", { opensOnly: true });
  else if (t === "ghl_stage_moved" && d.to === "Tier 1") acq("tier1", { opensOnly: true });
  else if (t === "offer_sent" && !investor) acq("offer_sent", reply);
  else if (t === "offer_revised" && !investor) acq("offer_revised", reply);
  else if (t === "offer_countered") acq("countered", reply);
  else if (t === "realm_yes") acq("realm_yes", reply);
  else if (isHotNote(ev)) acq("hot", reply);
  // Hot taken off posts nothing; the house's status emoji still follows it.
  else if (t === "note" && /^no longer hot\b/.test(phraseOf(ev))) acq("not_hot", { statusOnly: true });
  else if (t === "offer_accepted") acq("agreed", reply);
  else if (DEAD[t] && !investor) acq("dead", reply);
  else if (t === "deal_promoted") { acq("contract", reply); dispo("promoted", { thread: "deal" }); }
  else if (t === "deal_stage") dispo("stage", { broadcast: LOUD_STAGES.has(String(d.stage || "")) });
  else if (t === "investor_committed") dispo("committed", { broadcast: true });
  else if (t === "investor_evaluating") dispo("evaluating");
  else if (t === "investor_passed") dispo("buyer_passed");
  else if (t === "dataroom_viewed") dispo("viewed");
  else if (t === "call_booked" && investor) dispo("walkthrough");
  else if (t === "underwrite_started") uw("started");
  else if (t === "underwrite_done") { uw("done", { update: true }); acq("uw_done", { replyOnly: true }); }
  // A skeleton or draft-only run only made Matt a draft (Matt, 2026-10-25:
  // "we're doing the underwrites by hand"); it isn't a held underwrite.
  else if (t === "underwrite_held" && isDraftOnlyHold(d)) return out;
  else if (t === "underwrite_held") { uw("held", { update: true }); acq("uw_held", { replyOnly: true }); }
  else if (t === "underwrite_failed") { uw("failed", { update: true }); acq("uw_failed", { replyOnly: true }); }
  else if (t === "underwrite_dropped") uw("dropped", { thread: null });
  return out;
}

/** The event types the sweep reads (blast_sent is folded into one line per deal per run). */
export const SLACK_EVENT_TYPES = Object.freeze([
  "tier1_added", "ghl_stage_moved", "offer_sent", "offer_revised", "offer_countered", "realm_yes",
  "note", "offer_accepted", ...Object.keys(DEAD), "deal_promoted", "deal_stage", "investor_committed", "investor_evaluating",
  "investor_passed", "dataroom_viewed", "call_booked", "underwrite_started", "underwrite_done", "underwrite_held",
  "underwrite_failed", "underwrite_dropped", "blast_sent",
]);

/**
 * threadKeyFor(route, ev, ctx) → the key a thread is remembered by, or null.
 * A house's thread is per stream; a card move with no address rides on the
 * contact's live offer (ctx.address), else on the contact.
 */
export function threadKeyFor(route, ev = {}, ctx = {}) {
  if (!route?.thread) return null;
  if (route.thread === "run") return ev?.data?.jobId ? `run:${ev.data.jobId}` : null;
  if (route.thread === "deal") {
    const id = ev?.dealId || ev?.offerId || ctx.offerId;
    return id ? `deal:${id}` : null;
  }
  // House number + street (shared/current-offer.js houseKey): one house is
  // one thread whichever agent raises it. The runner also finds a thread by
  // a looser spelling ("3 Horizon Hill" / "3 Horizon Hill Ln").
  const house = houseKey(ev?.address || ctx.address || "");
  if (house) return `house:${route.stream}:${house}`;
  return ev?.contactId ? `contact:${route.stream}:${ev.contactId}` : null;
}

/** legacyThreadKey(route, ev, ctx) → the key a house's thread had before 2026-10-25 (the whole address). */
export function legacyThreadKey(route, ev = {}, ctx = {}) {
  const house = route?.thread === "house" ? addressKey(ev?.address || ctx.address || "") : "";
  return house ? `house:${route.stream}:${house}` : null;
}

/**
 * foldBlasts(events) → [{ offerId, address, count, at, contactIds }]
 * blast_sent is one row per buyer; Slack hears one line per deal.
 */
export function foldBlasts(events = []) {
  const by = new Map();
  for (const e of events || []) {
    if (e?.type !== "blast_sent") continue;
    const key = e.offerId || addressKey(e.address || "") || "unknown";
    const g = by.get(key) || { offerId: e.offerId || null, address: e.address || "", count: 0, at: e.at, ids: [] };
    g.count++;
    if (String(e.at) > String(g.at)) g.at = e.at;
    if (e.id) g.ids.push(e.id);
    by.set(key, g);
  }
  return [...by.values()];
}

/* ---------- the words ---------- */

const PHONE = /\+?\(?\d[\d\s().-]{8,}\d/g;
const EMAIL = /[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}/gi;
const clip = (s, max) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

/** scrubForSlack(s) → the text with any phone or email taken out, on one line. */
export const scrubForSlack = (s) => String(s || "").replace(EMAIL, "[email]").replace(PHONE, "[phone]").replace(/\s+/g, " ").trim();

// Slack's mrkdwn: &, < and > are control characters.
const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** fullName(name) → a person's whole name on one line, or "" when it doesn't read as a name. */
export function fullName(name) {
  const t = String(name || "").replace(/\s+/g, " ").trim();
  if (!t || /[\d@]/.test(t)) return "";
  return clip(t, 60);
}

/** firstName(name) → the first word of a person's name, or "" when it doesn't read as a name. */
export function firstName(name) {
  const w = String(name || "").trim().split(/\s+/)[0] || "";
  if (!w || /[\d@]/.test(w) || w.length > 20) return "";
  return w;
}

/** money(v) → "$386,500", or "" without a number. */
export const money = (v) => { const x = n(v); return x == null ? "" : `$${Math.round(x).toLocaleString("en-US")}`; };

/** summaryLine(s) → a one-line summary fit for Slack: scrubbed, about 140 characters. */
export const summaryLine = (s) => clip(scrubForSlack(s), 140);

const street = (a) => String(a || "").split(",")[0].trim();

/**
 * slackLinks(ctx) → "<app|Open in app> · <ghl|Contact in GHL>" for the
 * context line. About a person, "Open in app" opens Offers with that
 * person's record open (OfferApp's ?contact= drawer). About no one, it's
 * `appLink` (the app inside GHL) when set, else `path` on the app itself.
 */
export function slackLinks({ appUrl = SLACK_DEFAULTS.appUrl, appLink = "", locationId = "", contactId = "", path = "", view = "" } = {}) {
  const out = [];
  const loc = locationId ? { location_id: locationId } : {};
  if (contactId) out.push(`<${appUrl}/?${new URLSearchParams({ view: "history", contact: contactId, ...loc })}|Open in app>`);
  else if (appLink && path) out.push(`<${appLink}|Open in app>`);
  else if (path) out.push(`<${appUrl}${path}?${new URLSearchParams({ ...(view ? { view } : {}), ...loc })}|Open in app>`);
  if (contactId && locationId) out.push(`<https://app.gohighlevel.com/v2/location/${encodeURIComponent(locationId)}/contacts/detail/${encodeURIComponent(contactId)}|Contact in GHL>`);
  return out.join(" · ");
}

const ICON = {
  tier1: ":large_green_circle:", offer_sent: ":outbox_tray:", offer_revised: ":pencil2:",
  countered: ":left_right_arrow:", realm_yes: ":ok_hand:", hot: ":fire:", agreed: ":handshake:", dead: ":white_circle:",
  contract: ":memo:", promoted: ":memo:", stage: ":arrow_forward:", committed: ":moneybag:", evaluating: ":eyes:",
  buyer_passed: ":white_circle:", viewed: ":open_file_folder:", walkthrough: ":calendar:", waves: ":mega:",
  started: ":hourglass_flowing_sand:", done: ":white_check_mark:", held: ":warning:", failed: ":x:", dropped: ":double_vertical_bar:",
  uw_done: ":white_check_mark:", uw_held: ":warning:", uw_failed: ":x:",
};

const STAGE_SAY = { under_contract: "under contract", buyer_found: "buyer found", assigned: "assigned", closed: "closed", fell_through: "fell through" };

// The headline for one event: what happened, in a few words.
function headline(kind, ev, ctx) {
  const d = ev?.data || {};
  const who = ctx.firstName ? ` (${esc(ctx.firstName)})` : "";
  const house = `*${esc(street(ev?.address || ctx.address) || "a house")}*`;
  const ours = money(ctx.ours ?? d.cashAmount);
  const amount = money(amountOf(d));
  switch (kind) {
    case "tier1": return `${house} is Tier 1${who}`;
    case "tier1_also": return `${house}: also flagged by ${esc(ctx.fullName || ctx.firstName || "another agent")}`;
    case "offer_sent": return `Offer sent on ${house}${amount ? `: ${amount}` : ours ? `: ${ours}` : ""}`;
    case "offer_revised": return `Offer revised on ${house}${amount ? ` to ${amount}` : ""}`;
    case "countered": return `Counter on ${house}${amount ? `: ${amount}` : ""}${ours ? ` (ours ${ours})` : ""}${who}`;
    case "realm_yes": return `${house}: our number is in the realm${ours ? ` (${ours})` : ""}${who}`;
    case "hot": return `${house} is hot — close to a contract${ours ? ` at ${ours}` : ""}${who}`;
    case "agreed": return `Agreed on ${house}${amount ? ` at ${amount}` : ours ? ` at ${ours}` : ""}${who}`;
    case "dead": return `${house}: ${DEAD[ev?.type] || "closed out"}`;
    case "contract": return `${house} is under contract${n(d.contractPrice) ? ` at ${money(d.contractPrice)}` : ours ? ` at ${ours}` : ""}`;
    case "promoted": return `New deal: ${house}${n(d.contractPrice) ? ` — contract ${money(d.contractPrice)}` : ""}${n(d.assignmentFee) ? `, fee ${money(d.assignmentFee)}` : ""}${d.closingDate ? `, closing ${esc(String(d.closingDate).slice(0, 10))}` : ""}`;
    case "stage": return `${house}: ${esc(STAGE_SAY[d.stage] || String(d.stage || "stage changed").replace(/_/g, " "))}${d.reason ? ` — ${esc(clip(scrubForSlack(d.reason), 100))}` : ""}`;
    case "committed": return `Buyer committed on ${house}${who}`;
    case "evaluating": return `Buyer looking at ${house}${who}`;
    case "buyer_passed": return `Buyer passed on ${house}${who}`;
    case "viewed": return `Buyer opened the package for ${house}${who}`;
    case "walkthrough": return `Walkthrough booked on ${house}${who}`;
    case "started": return `Underwriting ${house}${who}…`;
    case "done": case "uw_done": return `Underwrite done on ${house}: ${money(d.cashAmount) || "no number"}${n(d.arv) ? ` · ARV ${money(d.arv)}` : ""}${n(d.repairs) ? ` · rehab ${money(d.repairs)}` : ""}`;
    case "held": case "uw_held": return `Underwrite held on ${house}${who}`;
    case "failed": case "uw_failed": return `Underwrite failed on ${house}${who}`;
    case "dropped": return `${house} left the underwrite queue without running`;
    default: return house;
  }
}

/**
 * renderEvent(route, ev, ctx) → { text, blocks }
 *
 *   ctx  { firstName, fullName, address, ours, summary, appUrl, appLink, locationId }
 *        — what the runner looked up; none of it is required.
 */
export function renderEvent(route, ev = {}, ctx = {}) {
  const kind = route?.kind || "";
  const d = ev?.data || {};
  if (kind === "tier1") return renderTier1(ev, ctx);
  const head = `${ICON[kind] || ":small_blue_diamond:"} ${headline(kind, ev, ctx)}`;
  const lines = [head];
  if (kind === "held" || kind === "uw_held") {
    const why = (Array.isArray(d.held) ? d.held : []).map((h) => clip(scrubForSlack(h), 120)).filter(Boolean).slice(0, 4);
    if (why.length) lines.push(why.map((w) => `• ${esc(w)}`).join("\n"));
  }
  if ((kind === "failed" || kind === "uw_failed") && d.error) lines.push(`_${esc(clip(scrubForSlack(d.error), 140))}_`);
  if (kind === "dead" && d.note) lines.push(`_${esc(clip(scrubForSlack(d.note), 140))}_`);
  const summary = ctx.summary && SUMMARY_KINDS.has(kind) ? summaryLine(ctx.summary) : "";
  if (summary) lines.push(`> ${esc(summary)}`);
  const text = lines.join("\n");
  const link = slackLinks({ appUrl: ctx.appUrl, appLink: ctx.appLink, locationId: ctx.locationId, contactId: ev?.contactId });
  const blocks = [{ type: "section", text: { type: "mrkdwn", text } }];
  if (link) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: link }] });
  return { text: clip(head.replace(/\*/g, ""), 150), blocks };
}
/**
 * renderTier1(ev, ctx) → the post that opens a house in #acquisitions, one
 * thing a line (Matt, 2026-10-25: "itemized out … and then the links
 * underneath"): the house, the agent's full name (Matt, the same day: "the
 * agent's full name not just Ann"), the full address, the description.
 * The description is the summary of what they said, else why the house is
 * Tier 1; scrubbed like every summary.
 */
export function renderTier1(ev = {}, ctx = {}) {
  const full = String(ev?.address || ctx.address || "").replace(/\s+/g, " ").trim();
  const desc = clip(scrubForSlack(ctx.summary || ev?.data?.why || ""), 300);
  const head = `${ICON.tier1} *Tier 1 flagged: ${esc(street(full) || "a house")}*`;
  const lines = [
    head,
    `*Agent:* ${esc(ctx.fullName || ctx.firstName) || "—"}`,
    `*Address:* ${esc(full) || "—"}`,
    `*Description:* ${esc(desc) || "—"}`,
  ];
  const link = slackLinks({ appUrl: ctx.appUrl, appLink: ctx.appLink, locationId: ctx.locationId, contactId: ev?.contactId });
  const blocks = [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }];
  if (link) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: link }] });
  const who = ctx.firstName ? ` (${ctx.firstName})` : "";
  return { text: clip(`Tier 1 flagged: ${street(full) || "a house"}${who}`, 150), blocks };
}

// Where the one-line summary of what they said earns its place.
const SUMMARY_KINDS = new Set(["tier1", "countered", "realm_yes", "hot", "agreed", "committed", "evaluating", "buyer_passed", "promoted"]);

/** renderBlasts(group, ctx) → one line for a wave of buyer texts on one deal. */
export function renderBlasts(g = {}, ctx = {}) {
  const head = `${ICON.waves} Deal sent to ${g.count} buyer${g.count === 1 ? "" : "s"}: *${esc(street(g.address) || "a deal")}*`;
  return { text: clip(head.replace(/\*/g, ""), 150), blocks: [{ type: "section", text: { type: "mrkdwn", text: head } }] };
}

/** renderPing(reason, ctx) → a needs-Matt post: what it is, where to do it, @Matt. */
export function renderPing(r = {}, ctx = {}) {
  const at = ctx.mattUserId ? `<@${ctx.mattUserId}> ` : "";
  const why = esc(clip(scrubForSlack(pingWhy(r)), 280));
  const house = r.address ? ` — *${esc(street(r.address))}*` : "";
  const text = `:rotating_light: ${at}${why}${house}`;
  const link = slackLinks({ appUrl: ctx.appUrl, appLink: ctx.appLink, locationId: ctx.locationId, contactId: r.contactId });
  const blocks = [{ type: "section", text: { type: "mrkdwn", text } }];
  if (link) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: link }] });
  return { text: clip(`Needs you: ${pingWhy(r)}`, 150), blocks };
}

const NEED_ICON = { yes: ":handshake:", paper: ":memo:", price: ":moneybag:" };

/**
 * renderNeed(need, ctx) → a needs-Matt post for one thing on GHL's Needs Matt
 * list (ghl-broker/needs-matt.js's cursor): its why, already in the app's
 * words ("They agreed on 1010 Bellevue Way at 410k: approve the number…").
 */
export function renderNeed(v = {}, ctx = {}) {
  const at = ctx.mattUserId ? `<@${ctx.mattUserId}> ` : "";
  const why = clip(scrubForSlack(v.why || "Something only you can do"), 280);
  const text = `${NEED_ICON[v.kind] || ":rotating_light:"} ${at}${esc(why)}`;
  const link = slackLinks({ appUrl: ctx.appUrl, appLink: ctx.appLink, locationId: ctx.locationId, contactId: v.contactId });
  const blocks = [{ type: "section", text: { type: "mrkdwn", text } }];
  if (link) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: link }] });
  return { text: clip(`Needs you: ${why}`, 150), blocks };
}

/* ---------- status: one emoji per house and per deal ---------- */

// Matt, 2026-10-25: "Slack to be a living record of what's been done" — glance
// at #acquisitions and see what happened to each house. The app keeps one
// status emoji (a reaction) and a Status line on the post that opened the
// thread, and moves them when the offer moves. Reactions people add are
// theirs and are never touched.

const cap1 = (s) => String(s || "").replace(/^./, (c) => c.toUpperCase());

/**
 * acquisitionStatus(offer) → { key, emoji, label } | null — a Tier 1 house's
 * status; null while it's still waiting on us (a draft).
 */
export function acquisitionStatus(o) {
  if (!o) return null;
  const s = offerStage(o);
  if (s.sub === "accepted") return { key: "good", emoji: "white_check_mark", label: o.deal ? (o.deal.stage === "closed" ? "Closed" : "Under contract") : "Agreed" };
  if (s.sub === "passed") {
    const why = wePassReasonOf(o);
    return { key: "passed", emoji: "x", label: `${cap1(s.why)}${why ? ` — ${why.label.toLowerCase()}` : ""}` };
  }
  if (s.sub === "hot") return { key: "hot", emoji: "fire", label: "Hot — close to a contract" };
  if (s.sub === "countered") return { key: "countered", emoji: "left_right_arrow", label: "They countered" };
  if (s.stage === "sent") return { key: "sent", emoji: "outbox_tray", label: `Offer sent${money(o.cashAmount) ? ` — ${money(o.cashAmount)}` : ""}` };
  return null;
}

/**
 * dispositionStatus(offer) → { key, emoji, label } | null — a deal's status
 * with its buyers. A buyer counts as looking once they showed interest (a
 * pre-sale pitch alone doesn't).
 */
export function dispositionStatus(o) {
  const d = o?.deal;
  if (!d) return null;
  if (d.stage === "closed") return { key: "closed", emoji: "trophy", label: "Closed" };
  if (d.stage === "fell_through") return { key: "fell", emoji: "x", label: "Fell through" };
  if (d.stage === "assigned") return { key: "assigned", emoji: "memo", label: "Assigned" };
  const inv = (d.investors || []).filter(Boolean);
  if (d.stage === "buyer_found" || inv.some((i) => i.status === "committed")) return { key: "committed", emoji: "handshake", label: "Buyer committed" };
  const looking = inv.filter((i) => i.status === "evaluating" && i.source !== "presell").length;
  if (looking) return { key: "looking", emoji: "eyes", label: `${looking} buyer${looking === 1 ? "" : "s"} looking` };
  if ((d.blasts || []).length) return { key: "marketing", emoji: "mega", label: "Sent to buyers" };
  return null;
}

const STATUS_RANK = { good: 6, hot: 5, countered: 4, sent: 3, passed: 2 };

/**
 * houseStatus(offers) → { key, emoji, label, offer } | null — a house's
 * status across every agent who has an offer on it: each agent's current
 * offer (shared/current-offer.js resolveHouse), the furthest along wins. One
 * agent passing doesn't close a house another agent is hot on.
 */
export function houseStatus(offers = []) {
  const byContact = new Map();
  for (const o of offers || []) {
    if (!o) continue;
    const k = o.contactId || "";
    if (!byContact.has(k)) byContact.set(k, []);
    byContact.get(k).push(o);
  }
  let best = null;
  for (const rows of byContact.values()) {
    const current = resolveHouse(rows).current;
    const st = acquisitionStatus(current);
    if (st && (!best || STATUS_RANK[st.key] > STATUS_RANK[best.key])) best = { ...st, offer: current };
  }
  return best;
}

const STATUS_RX = /^\*Status:\*/;

/**
 * withStatus(blocks, status, at) → the opening post's blocks with its Status
 * line (second line of the first section) set, replaced, or taken out.
 */
export function withStatus(blocks = [], status = null, at = null) {
  const day = at ? new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" }) : "";
  const line = status ? `*Status:* :${status.emoji}: ${esc(status.label)}${day ? ` (${day})` : ""}` : null;
  let done = false;
  return (blocks || []).map((b) => {
    if (done || b?.type !== "section" || typeof b.text?.text !== "string") return b;
    done = true;
    const lines = b.text.text.split("\n").filter((l) => !STATUS_RX.test(l));
    if (line) lines.splice(1, 0, line);
    return { ...b, text: { ...b.text, text: lines.join("\n") } };
  });
}

/** slackClaimKey(kind, id) → the cursor's key for one thing told once. */
export const slackClaimKey = (kind, id) => `${kind}:${id}`;

/* ---------- the machine and the day ---------- */

/** renderError(e) → a new kind of app error, once a day. */
export function renderError(e = {}) {
  const head = `:red_circle: New error in *${esc(e.area || "the app")}*${Number(e.count) > 1 ? ` (×${e.count})` : ""}`;
  const text = `${head}\n_${esc(clip(scrubForSlack(e.message), 200))}_`;
  return { text: clip(head.replace(/\*/g, ""), 150), blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}

/** renderJobFailed(job) → a scheduled job whose last run failed (shared/line.js lineJobs row). */
export function renderJobFailed(j = {}) {
  const head = `:warning: *${esc(j.label || j.name)}* failed its last run${Number(j.tries) > 1 ? ` (try ${j.tries})` : ""}`;
  const text = j.error ? `${head}\n_${esc(clip(scrubForSlack(j.error), 200))}_` : head;
  return { text: clip(head.replace(/\*/g, ""), 150), blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}

/**
 * morningCounts(events, { since, until }) → yesterday in numbers, from the
 * contact_events window. Counts only — the people are in the threads.
 */
export function morningCounts(events = [], { since = null, until = null } = {}) {
  const c = { tier1: 0, housesNamed: 0, offersSent: 0, counters: 0, agreed: 0, hot: 0, underwritesDone: 0, underwritesHeld: 0, underwritesFailed: 0, deals: 0, buyerTexts: 0, buyersCommitted: 0, replies: 0 };
  const inWin = (at) => (!since || String(at) >= since) && (!until || String(at) < until);
  const tier1 = new Set();
  for (const e of events || []) {
    if (!e || !inWin(e.at)) continue;
    const t = e.type;
    if (t === "tier1_added" || (t === "ghl_stage_moved" && e.data?.to === "Tier 1")) tier1.add(e.contactId);
    else if (t === "house_mentioned" && e.party !== "investor") c.housesNamed++;
    else if (t === "offer_sent" && e.party !== "investor") c.offersSent++;
    else if (t === "offer_countered") c.counters++;
    else if (t === "offer_accepted") c.agreed++;
    else if (isHotNote(e)) c.hot++;
    else if (t === "underwrite_done") c.underwritesDone++;
    else if (t === "underwrite_held") c.underwritesHeld++;
    else if (t === "underwrite_failed") c.underwritesFailed++;
    else if (t === "deal_promoted") c.deals++;
    else if (t === "blast_sent") c.buyerTexts++;
    else if (t === "investor_committed") c.buyersCommitted++;
    else if (t === "text_summary" && e.data?.inbound) c.replies++;
  }
  c.tier1 = tier1.size;
  return c;
}
export const MORNING_EVENT_TYPES = Object.freeze([
  "tier1_added", "ghl_stage_moved", "house_mentioned", "offer_sent", "offer_countered", "offer_accepted", "note",
  "underwrite_done", "underwrite_held", "underwrite_failed", "deal_promoted", "blast_sent", "investor_committed", "text_summary",
]);

/** renderMorning(counts, ctx) → yesterday in numbers, for #daily. */
export function renderMorning(c = {}, ctx = {}) {
  const row = (label, v) => `${label}: *${Number(v) || 0}*`;
  const lines = [
    `:sunrise: *Yesterday${ctx.dayLabel ? `, ${esc(ctx.dayLabel)}` : ""}*`,
    [row("Replies", c.replies), row("Houses named", c.housesNamed), row("New Tier 1", c.tier1)].join(" · "),
    [row("Underwrites", c.underwritesDone), row("held", c.underwritesHeld), row("failed", c.underwritesFailed)].join(" · "),
    [row("Offers sent", c.offersSent), row("Counters", c.counters), row("Hot", c.hot), row("Agreed", c.agreed)].join(" · "),
    [row("New deals", c.deals), row("Buyer texts", c.buyerTexts), row("Buyers committed", c.buyersCommitted)].join(" · "),
  ];
  const link = slackLinks({ appUrl: ctx.appUrl, appLink: ctx.appLink, locationId: ctx.locationId, path: "/reports", view: "activity" });
  const blocks = [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }];
  if (link) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: link }] });
  return { text: `Yesterday: ${c.offersSent || 0} offers sent, ${c.tier1 || 0} new Tier 1, ${c.deals || 0} new deals`, blocks };
}

/**
 * renderEvening(digest, { jobs, errors }, ctx) → tonight's loose ends for #daily.
 *   digest  shared/digest.js buildDigest
 *   jobs    shared/line.js lineJobs rows (failed ones are listed)
 *   errors  shared/line.js errorsByArea rows
 */
export function renderEvening(digest = {}, { jobs = [], errors = [] } = {}, ctx = {}) {
  const lines = [":crescent_moon: *Tonight's loose ends*"];
  for (const s of digest.sections || []) {
    const items = s.items || [];
    if (!items.length) continue;
    const houses = items.slice(0, 5).map((i) => esc(street(i.address || i.propertyAddress || "") || "a house")).join(", ");
    lines.push(`• ${esc(s.label)}: *${items.length}*${houses ? ` — ${houses}${items.length > 5 ? ", …" : ""}` : ""}`);
  }
  if (lines.length === 1) lines.push("Nothing open.");
  const failed = (jobs || []).filter((j) => j?.failed);
  const errs = (errors || []).slice(0, 3);
  if (failed.length || errs.length) {
    lines.push(`:gear: Machine: ${[
      failed.length ? `${failed.length} job${failed.length === 1 ? "" : "s"} failed (${failed.map((j) => esc(j.label)).join(", ")})` : "",
      errs.length ? `errors in ${errs.map((e) => `${esc(e.area)} ×${e.count}`).join(", ")}` : "",
    ].filter(Boolean).join("; ")}`);
  }
  const link = slackLinks({ appUrl: ctx.appUrl, appLink: ctx.appLink, locationId: ctx.locationId, path: "/reports", view: "activity" });
  const blocks = [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }];
  if (link) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: link }] });
  const open = (digest.sections || []).reduce((a, s) => a + (s.items?.length || 0), 0);
  return { text: `Tonight: ${open} loose end${open === 1 ? "" : "s"}`, blocks };
}
