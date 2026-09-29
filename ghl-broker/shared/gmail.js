// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// gmail.js — Matt's Gmail, read into the contact record. Pure.
//
// Agents email the Workspace inbox directly — a Form 21, the disclosures,
// "sent you the counter" — and the texting bot never saw any of it, so it
// asked again for things already in the inbox. The broker's runner
// (ghl-broker/gmail-sync.js) reads new mail with a read-only token; this is
// the part that decides what a message is: who it is with, whether it is a
// person writing at all, and the one timeline event it becomes. Mail with
// nobody we know is never stored. Matt, 2026-09-28.

export const BODY_CHARS = 1500;          // the transcript's per-message cap
export const SUBJECT_CHARS = 200;
export const EMAILS_IN_CONTEXT = 6;
export const EMAIL_EVENT_TYPES = ["email_received", "email_sent"];

const lower = (s) => String(s || "").trim().toLowerCase();

/** parseAddressList('"Jo Smith" <jo@x.com>, b@y.com') → [{ name, email }] */
export function parseAddressList(header = "") {
  const out = [];
  // Commas inside a quoted display name ("Smith, Jo") are not separators.
  const parts = String(header || "").match(/(?:"[^"]*"|[^,])+/g) || [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const angle = part.match(/<([^>]+)>/);
    const email = lower(angle ? angle[1] : part.replace(/^mailto:/i, ""));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    const name = angle ? part.slice(0, angle.index).replace(/^["'\s]+|["'\s]+$/g, "") : "";
    out.push({ name, email });
  }
  return out;
}

export const headerOf = (msg, name) => {
  const h = (msg?.payload?.headers || []).find((x) => lower(x?.name) === lower(name));
  return h ? String(h.value || "") : "";
};

// Gmail's base64url, in Node and the browser alike.
export function decodeBase64Url(data = "") {
  const b64 = String(data || "").replace(/-/g, "+").replace(/_/g, "/");
  if (!b64) return "";
  if (typeof Buffer !== "undefined") return Buffer.from(b64, "base64").toString("utf8");
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function stripHtml(html = "") {
  return String(html || "")
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

// The words this message added: the quoted history below "On … wrote:" and
// the "> " lines are the thread's earlier messages, already their own events.
export function stripQuoted(text = "") {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (/^\s*On .{4,200}wrote:\s*$/i.test(line)) break;
    if (/^\s*-{2,}\s*(Original Message|Forwarded message)\s*-{2,}/i.test(line)) break;
    if (/^\s*From:\s.+/i.test(line) && out.length) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function walkParts(part, visit) {
  if (!part) return;
  visit(part);
  for (const p of part.parts || []) walkParts(p, visit);
}

/** bodyText(payload) → plain text: text/plain when there is one, else the HTML stripped. */
export function bodyText(payload) {
  let plain = "";
  let html = "";
  walkParts(payload, (p) => {
    const type = lower(p.mimeType);
    if (p.filename) return;
    if (!plain && type === "text/plain" && p.body?.data) plain = decodeBase64Url(p.body.data);
    if (!html && type === "text/html" && p.body?.data) html = decodeBase64Url(p.body.data);
  });
  return plain || stripHtml(html);
}

export function attachmentNames(payload) {
  const names = [];
  walkParts(payload, (p) => { if (p.filename) names.push(String(p.filename).slice(0, 120)); });
  return names.slice(0, 12);
}

const NOREPLY_RX = /^(no-?reply|do-?not-?reply|notifications?|mailer-daemon|postmaster|bounce[s]?|alerts?|updates?|news(letter)?|marketing|info|support)([+._-].*)?@/i;
// Not CATEGORY_UPDATES: Gmail files a transaction thread there now and then,
// and whether the sender is a contact is the real filter anyway.
const BULK_LABELS = new Set(["SPAM", "TRASH", "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL"]);

/**
 * isPersonMail(msg) → boolean
 * A person writing, not a newsletter, a notification or a receipt. Only mail
 * that passes is even looked up against the contacts.
 */
export function isPersonMail(msg) {
  const labels = msg?.labelIds || [];
  if (labels.some((l) => BULK_LABELS.has(l))) return false;
  if (labels.includes("DRAFT")) return false;
  if (headerOf(msg, "List-Unsubscribe") || headerOf(msg, "List-Id")) return false;
  if (/^(bulk|list|junk)$/i.test(headerOf(msg, "Precedence").trim())) return false;
  if (/^auto-(generated|replied)/i.test(headerOf(msg, "Auto-Submitted").trim())) return false;
  const from = parseAddressList(headerOf(msg, "From"))[0];
  if (!from || NOREPLY_RX.test(from.email)) return false;
  return true;
}

export const gmailLink = (threadId, account = "") =>
  `https://mail.google.com/mail/${account ? `?authuser=${encodeURIComponent(account)}` : "u/0/"}#all/${encodeURIComponent(threadId || "")}`;

/**
 * summarizeMessage(msg, { self }) → { id, threadId, at, direction, from, others[], subject, body, attachments[], link }
 *
 * `self`: the inbox's own addresses (lowercase). `others` is everyone on the
 * message who is not us — the addresses to look up as contacts. `direction`
 * is "sent" when we wrote it.
 */
export function summarizeMessage(msg, { self = [] } = {}) {
  const mine = new Set(self.map(lower));
  const from = parseAddressList(headerOf(msg, "From"))[0] || { name: "", email: "" };
  const to = parseAddressList(headerOf(msg, "To"));
  const cc = parseAddressList(headerOf(msg, "Cc"));
  const sent = mine.has(from.email) || (msg?.labelIds || []).includes("SENT");
  const seen = new Set();
  const others = [];
  for (const a of sent ? [...to, ...cc] : [from, ...to, ...cc]) {
    if (!a.email || mine.has(a.email) || seen.has(a.email)) continue;
    seen.add(a.email);
    others.push(a.email);
  }
  const at = Number(msg?.internalDate) ? new Date(Number(msg.internalDate)).toISOString() : (Date.parse(headerOf(msg, "Date")) ? new Date(Date.parse(headerOf(msg, "Date"))).toISOString() : null);
  const body = stripQuoted(bodyText(msg?.payload)).slice(0, BODY_CHARS);
  return {
    id: msg?.id || "", threadId: msg?.threadId || "", at,
    direction: sent ? "sent" : "received",
    from: from.email, others,
    subject: headerOf(msg, "Subject").replace(/\s+/g, " ").trim().slice(0, SUBJECT_CHARS),
    body: body || String(msg?.snippet || "").slice(0, BODY_CHARS),
    attachments: attachmentNames(msg?.payload),
    link: gmailLink(msg?.threadId || msg?.id, self[0] || ""),
  };
}

export const emailDedupeKey = (messageId) => `gmail:${messageId}`;

/**
 * emailEvent(summary, { contactId, address, offerId }) → recordEvent args (minus store/locationId)
 */
export function emailEvent(summary, { contactId, address = "", offerId = null } = {}) {
  return {
    contactId,
    type: summary.direction === "sent" ? "email_sent" : "email_received",
    at: summary.at,
    address, offerId,
    source: "gmail",
    ref: summary.id,
    dedupeKey: emailDedupeKey(summary.id),
    data: { subject: summary.subject, body: summary.body, attachments: summary.attachments, link: summary.link, threadId: summary.threadId },
  };
}

/**
 * addressInEmail(summary, addresses) → the first address whose street line
 * ("1234 Cedar") appears in the subject or body, else "".
 */
export function addressInEmail(summary, addresses = []) {
  const hay = lower(`${summary?.subject || ""}\n${summary?.body || ""}`).replace(/\s+/g, " ");
  for (const a of addresses) {
    const street = lower(String(a || "").split(",")[0]).replace(/\s+/g, " ");
    const m = street.match(/^(\d+)\s+(\S+)/);
    if (m && hay.includes(`${m[1]} ${m[2]}`)) return a;
  }
  return "";
}

/**
 * emailContextText(events) → the prompt block: the newest emails with them,
 * oldest first. Numbers in an email are theirs or on paper, never a number
 * the reply may quote (they are not added to the money guard's allowance).
 */
export function emailContextText(events = [], { limit = EMAILS_IN_CONTEXT, bodyChars = 400 } = {}) {
  const mail = (events || []).filter((e) => EMAIL_EVENT_TYPES.includes(e?.type))
    .sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit).reverse();
  if (!mail.length) return "";
  const lines = mail.map((e) => {
    const d = e.data || {};
    const day = String(e.at || "").slice(0, 10);
    const who = e.type === "email_sent" ? "US" : "THEM";
    const att = d.attachments?.length ? ` [attached: ${d.attachments.slice(0, 4).join(", ")}]` : "";
    const body = String(d.body || "").replace(/\s+/g, " ").trim().slice(0, bodyChars);
    return `- [${day}] ${who}: "${d.subject || "(no subject)"}"${att}${body ? ` — ${body}` : ""}`;
  });
  return "EMAIL WITH THEM (from our Gmail, oldest first — what was already sent or received by email; don't ask again for " +
    "something they already emailed, and don't claim to have emailed anything not listed here. Dollar figures in these emails are " +
    "not numbers you may quote):\n" + lines.join("\n");
}
