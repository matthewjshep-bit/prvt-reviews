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

/** normalizeSlack(v) → { enabled, channels, streams, mattUserId, appUrl, morningHour, eveningHour } */
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

const DEAD = { offer_passed: "they passed", offer_we_passed: "we passed", offer_unavailable: "no longer available", offer_no_response: "no response", tier1_passed: "passed from Tier 1" };
const LOUD_STAGES = new Set(["closed", "fell_through"]);

/**
 * routeEvent(ev) → [{ stream, kind, thread, broadcast, update, replyOnly }]
 *
 *   thread     "house" (the house's thread in that stream), "deal", "run"
 *              (one message per underwrite run, edited as it goes), or null
 *              (a post of its own)
 *   broadcast  a thread reply that also shows in the channel
 *   update     edit the run's message in place rather than post again
 *   replyOnly  only as a reply in a thread already there: an underwrite's
 *              result or a pass doesn't open a house in #acquisitions
 *
 * Empty for anything Slack doesn't hear about.
 */
export function routeEvent(ev = {}) {
  const t = ev?.type;
  const d = ev?.data || {};
  const out = [];
  const base = { broadcast: false, update: false, replyOnly: false };
  const acq = (kind, o = {}) => out.push({ stream: "acquisitions", kind, thread: "house", ...base, ...o });
  const uw = (kind, o = {}) => out.push({ stream: "underwrites", kind, thread: "run", ...base, ...o });
  const dispo = (kind, o = {}) => out.push({ stream: "dispositions", kind, thread: "deal", ...base, ...o });
  const investor = ev?.party === "investor";

  if (t === "tier1_added") acq("tier1");
  else if (t === "ghl_stage_moved" && d.to === "Tier 1") acq("tier1");
  else if (t === "house_mentioned" && !investor) acq("house_named");
  else if (t === "offer_sent" && !investor) acq("offer_sent");
  else if (t === "offer_revised" && !investor) acq("offer_revised");
  else if (t === "offer_countered") acq("countered", { broadcast: true });
  else if (t === "realm_yes") acq("realm_yes", { broadcast: true });
  else if (isHotNote(ev)) acq("hot", { broadcast: true });
  else if (t === "offer_accepted") acq("agreed", { broadcast: true });
  else if (DEAD[t] && !investor) acq("dead", { replyOnly: true });
  else if (t === "deal_promoted") { acq("contract", { broadcast: true }); dispo("promoted", { thread: "deal" }); }
  else if (t === "deal_stage") dispo("stage", { broadcast: LOUD_STAGES.has(String(d.stage || "")) });
  else if (t === "investor_committed") dispo("committed", { broadcast: true });
  else if (t === "investor_evaluating") dispo("evaluating");
  else if (t === "investor_passed") dispo("buyer_passed");
  else if (t === "dataroom_viewed") dispo("viewed");
  else if (t === "call_booked" && investor) dispo("walkthrough");
  else if (t === "underwrite_started") uw("started");
  else if (t === "underwrite_done") { uw("done", { update: true }); acq("uw_done", { replyOnly: true }); }
  else if (t === "underwrite_held") { uw("held", { update: true }); acq("uw_held", { replyOnly: true }); }
  else if (t === "underwrite_failed") { uw("failed", { update: true }); acq("uw_failed", { replyOnly: true }); }
  else if (t === "underwrite_dropped") uw("dropped", { thread: null });
  return out;
}

/** The event types the sweep reads (blast_sent is folded into one line per deal per run). */
export const SLACK_EVENT_TYPES = Object.freeze([
  "tier1_added", "ghl_stage_moved", "house_mentioned", "offer_sent", "offer_revised", "offer_countered", "realm_yes",
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
  const house = addressKey(ev?.address || ctx.address || "");
  if (house) return `house:${route.stream}:${house}`;
  return ev?.contactId ? `contact:${route.stream}:${ev.contactId}` : null;
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

/** slackLinks(ctx) → "<app|Open in app> · <ghl|GHL>" for the context line: the contact's page, else `path`. */
export function slackLinks({ appUrl = SLACK_DEFAULTS.appUrl, locationId = "", contactId = "", path = "", view = "" } = {}) {
  const out = [];
  const loc = locationId ? { location_id: locationId } : {};
  if (contactId) out.push(`<${appUrl}/contact?${new URLSearchParams({ contact: contactId, ...loc })}|Open in app>`);
  else if (path) out.push(`<${appUrl}${path}?${new URLSearchParams({ ...(view ? { view } : {}), ...loc })}|Open in app>`);
  if (contactId && locationId) out.push(`<https://app.gohighlevel.com/v2/location/${encodeURIComponent(locationId)}/contacts/detail/${encodeURIComponent(contactId)}|GHL>`);
  return out.join(" · ");
}

const ICON = {
  tier1: ":large_green_circle:", house_named: ":house:", offer_sent: ":outbox_tray:", offer_revised: ":pencil2:",
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
    case "house_named": return `${house}: an agent named a house${who}${n(d.sellerAsk) ? ` — asking ${money(d.sellerAsk)}` : ""}${d.needsAddress ? " — no full address yet" : ""}`;
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
 *   ctx  { firstName, address, ours, summary, appUrl, locationId }
 *        — what the runner looked up; none of it is required.
 */
export function renderEvent(route, ev = {}, ctx = {}) {
  const kind = route?.kind || "";
  const d = ev?.data || {};
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
  const link = slackLinks({ appUrl: ctx.appUrl, locationId: ctx.locationId, contactId: ev?.contactId });
  const blocks = [{ type: "section", text: { type: "mrkdwn", text } }];
  if (link) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: link }] });
  return { text: clip(head.replace(/\*/g, ""), 150), blocks };
}
// Where the one-line summary of what they said earns its place.
const SUMMARY_KINDS = new Set(["tier1", "house_named", "countered", "realm_yes", "hot", "agreed", "committed", "evaluating", "buyer_passed", "promoted"]);

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
  const link = slackLinks({ appUrl: ctx.appUrl, locationId: ctx.locationId, contactId: r.contactId });
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
  const link = slackLinks({ appUrl: ctx.appUrl, locationId: ctx.locationId, contactId: v.contactId });
  const blocks = [{ type: "section", text: { type: "mrkdwn", text } }];
  if (link) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: link }] });
  return { text: clip(`Needs you: ${why}`, 150), blocks };
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
  const link = slackLinks({ appUrl: ctx.appUrl, locationId: ctx.locationId, path: "/reports", view: "activity" });
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
  const link = slackLinks({ appUrl: ctx.appUrl, locationId: ctx.locationId, path: "/reports", view: "activity" });
  const blocks = [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }];
  if (link) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: link }] });
  const open = (digest.sections || []).reduce((a, s) => a + (s.items?.length || 0), 0);
  return { text: `Tonight: ${open} loose end${open === 1 ? "" : "s"}`, blocks };
}
