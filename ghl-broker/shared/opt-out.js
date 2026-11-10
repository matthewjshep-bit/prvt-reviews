// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// opt-out.js — who the machine never texts or emails again.
//
// Matt, 2026-11-09: "anyone who opts out by text or email never gets another
// machine text or email, and I can still text them by hand." Until then each
// channel heard only itself: an agent who texted STOP still got the day-2
// intro email and the check-in emails (48 emails to 35 opted-out agents in
// three weeks), and a buyer who unsubscribed from email still got deal texts.
//
// One read, every machine send asks it: a STOP in GHL (SMS DND), an email
// unsubscribe (Email DND), a do-not-text tag, an `unsubscribed` event on the
// timeline, or an opt-out the reply agent handled. It decides only what the
// machine starts and what goes by itself. A person pressing Send is never
// stopped by it, and nothing here sets DND in GHL: that would block Matt's
// own texts too. Pure.

export const OPT_OUT_EVENT = "unsubscribed";
export const OPT_OUT_INTENT = "opt_out";
// The button on a held row: Matt's own word that it was an opt-out
// (ghl-broker/conversation-actions.js writes the event).
export const OPT_OUT_ACTION = "mark_opted_out";

const DND_STATUSES = new Set(["active", "permanent"]);

/**
 * dndOn(contact, channel) → true when GHL won't send on that channel
 *
 * A STOP keyword lands as `dndSettings.SMS.status: "permanent"` ("active" for
 * a manual DND) while the top-level `dnd` stays false (2026-09-16). The
 * top-level flag, when set, is every channel.
 */
export function dndOn(contact, channel = "sms") {
  if (!contact) return false;
  if (contact.dnd === true) return true;
  const key = channel === "email" ? "Email" : "SMS";
  return DND_STATUSES.has(String(contact.dndSettings?.[key]?.status || "").toLowerCase());
}

// Tags that mean "do not text", however they were spelled. A dead number
// (phone-dead) is out of every machine text too.
export const BLOCK_TAG_RX = /^(?:dnc|dnd|do[-\s]?not[-\s]?(?:contact|text|call)|opt(?:ed)?[-\s]?out|unsubscribed?|stop|wrong[-\s]?number|phone[-\s]?dead)$/i;

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A tag pattern as the routing page writes them: exact, or with a `*`.
const tagMatches = (pattern, tag) => {
  const p = String(pattern || "").trim().toLowerCase();
  const t = String(tag || "").trim().toLowerCase();
  if (!p || !t) return false;
  return p.includes("*") ? new RegExp(`^${p.split("*").map(escapeRx).join(".*")}$`).test(t) : p === t;
};

/**
 * optOutTagsOf(conversationConfig) → the page's opt-out tags that mean an opt-out
 *
 * The opt-out writes its tags (`stop bot`, `dnc` on the starter), but a
 * bot-off tag is also yours to put on and take off by hand: it holds the
 * bot (and a queued deal text waits for your Send), it isn't a permanent
 * opt-out. Those stay with the bot-off rule.
 */
export function optOutTagsOf(config) {
  const off = config?.routing?.botOffTags || [];
  return (config?.optOut?.tags || []).map((t) => String(t || "").trim().toLowerCase())
    .filter((t) => t && !off.some((p) => tagMatches(p, t)));
}

/** The first tag that says do not text them: BLOCK_TAG_RX or one of `optOutTags`. */
export function optOutTag(tags = [], optOutTags = []) {
  for (const raw of tags || []) {
    const t = String(raw || "").trim();
    if (!t) continue;
    if (BLOCK_TAG_RX.test(t) || (optOutTags || []).some((p) => tagMatches(p, t))) return t;
  }
  return null;
}

const OPEN = new Set(["draft", "scheduled"]);
const stamp = (v) => (v ? String(v) : null);

/**
 * optedOut({ contact, tags, events, drafts, optOutTags }) → { via, at, tag? } | null
 *
 *   via  "sms_dnd" | "email_dnd" | "tag" | "event" | "draft" | "maybe"
 *
 * `contact` is the GHL contact (its dndSettings and tags), `tags` overrides
 * its tags, `events` the contact's timeline (any types; only `unsubscribed`
 * is read), `drafts` their reply drafts (any statuses). "draft" is an opt-out
 * the reply agent handled; "maybe" is a reply held for Matt because it may be
 * one ("Stop, not interested") — nothing the machine makes goes while it
 * waits, and it stops counting once he sends or dismisses it.
 */
export function optedOut({ contact = null, tags = null, events = [], drafts = [], optOutTags = [] } = {}) {
  if (dndOn(contact, "sms")) return { via: "sms_dnd", at: null };
  if (dndOn(contact, "email")) return { via: "email_dnd", at: null };
  const tag = optOutTag(tags ?? contact?.tags ?? [], optOutTags);
  if (tag) return { via: "tag", at: null, tag };
  const ev = (events || []).filter((e) => e?.type === OPT_OUT_EVENT)
    .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")))[0];
  if (ev) return { via: "event", at: stamp(ev.at) };
  const handled = (drafts || []).find((d) => d?.intent === OPT_OUT_INTENT && d.status === "handled");
  if (handled) return { via: "draft", at: stamp(handled.createdAt || handled.updatedAt) };
  const maybe = (drafts || []).find((d) => d?.optOutMaybe === true && OPEN.has(d.status));
  if (maybe) return { via: "maybe", at: stamp(maybe.createdAt || maybe.updatedAt) };
  return null;
}

const VIA_WORDS = {
  sms_dnd: "texted STOP",
  email_dnd: "unsubscribed from email",
  event: "asked to be left alone",
  draft: "asked to be left alone",
};

/** How they opted out, in a few words: "texted STOP", "tagged dnc". */
export function optOutVia(o) {
  if (!o) return "";
  if (o.via === "tag") return `tagged ${o.tag || "do not text"}`;
  return VIA_WORDS[o.via] || "opted out";
}

/**
 * optedOutLine(o) → the reason a machine text or email stood down
 *
 * "they opted out (texted STOP): the machine starts nothing; your own texts still go"
 */
export function optedOutLine(o) {
  if (o?.via === "maybe") return "they may have opted out (a reply waits for you): the machine starts nothing; your own texts still go";
  return `they opted out (${optOutVia(o)}): the machine starts nothing; your own texts still go`;
}

// Our own reply that promised to leave them alone ("I won't text you
// again", "I'll take you off"): once it has gone, that is their opt-out.
// "until it's back on", "about this one" and the like are not.
const PROMISE_TO_STOP_RX = new RegExp([
  String.raw`\b(?:won'?t|will not|wont)\s+(?:text|message|contact|bother|email|reach out to)\s+you\s+(?:again|anymore|any more)\b(?![^.!?\n]{0,12}\b(?:until|unless|till|til|about|on|re|regarding|if|before|after)\b)`,
  String.raw`\bI'?ll\s+(?:take|remove)\s+you\s+off\b`,
  String.raw`\bI'?ll\s+remove\s+you\b`,
  String.raw`\b(?:took|taken|removed)\s+you\s+off\b`,
].join("|"), "i");
export function promisesToStop(text = "") {
  return PROMISE_TO_STOP_RX.test(String(text || "").replace(/[‘’]/g, "'"));
}
