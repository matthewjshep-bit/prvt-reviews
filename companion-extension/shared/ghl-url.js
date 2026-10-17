// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// ghl-url.js — which person a GoHighLevel page is about, read from its
// address alone. The companion window (Matt, 2026-10-16: "anytime I open up a
// record in GoHighLevel, the pinned window brings all that person's
// information") follows whoever is open in GHL; the Chrome extension
// (companion-extension/) reads the GHL tab's address with this and tells the
// companion. Nothing reads the GHL page itself.
//
//   /v2/location/{loc}/contacts/detail/{contactId}                the contact
//   /v2/location/{loc}/conversations/conversations/{conversationId} their thread;
//                                                                   the broker turns it into a contact
//
// Anything else (the lists, settings, our own menu-link pages) is no one.

// GHL's own app and its white-label host.
const GHL_HOST = /(^|\.)(gohighlevel\.com|leadconnectorhq\.com)$/i;
// GHL ids are 20-ish letters and digits; a word like "all" or
// "manual_actions" in the same slot is a list, not a person.
const ID = "([A-Za-z0-9]{12,40})";
const CONTACT = new RegExp(`^/v2/location/${ID}/contacts/detail/${ID}/?$`);
const CONVERSATION = new RegExp(`^/v2/location/${ID}/conversations/conversations/${ID}/?$`);

/**
 * parseGhlUrl(href) → { locationId, contactId, conversationId } | null
 * One of contactId / conversationId is set, the other null.
 */
export function parseGhlUrl(href) {
  let url;
  try { url = new URL(String(href || "")); } catch { return null; }
  if (url.protocol !== "https:" || !GHL_HOST.test(url.hostname)) return null;
  const path = url.pathname;
  let m = CONTACT.exec(path);
  if (m) return { locationId: m[1], contactId: m[2], conversationId: null };
  m = CONVERSATION.exec(path);
  if (m) return { locationId: m[1], contactId: null, conversationId: m[2] };
  return null;
}
