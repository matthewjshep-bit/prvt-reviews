// companion.js — the companion window's side of the Chrome extension
// (companion-extension/). The extension reads which person the GHL tab is
// on (shared/ghl-url.js) and its content script posts it into this page.
// Pure, so what the page accepts is pinned.

export const COMPANION_MESSAGE = "shepflips:ghl-contact";
export const COMPANION_HELLO = "shepflips:companion-hello";
// The window the app's Companion button opens, and reuses.
export const COMPANION_WINDOW = "shepflips-companion";

const ID = /^[A-Za-z0-9]{12,40}$/;

/**
 * readCompanionMessage(event, { win, contactId, locationId }) →
 *   { hello: true } | { contactId } | { conversationId } | null
 * Only this page's own window (the content script posts on it), only our
 * message shape, only well-formed ids, only this location, and nothing for
 * the person already showing.
 */
export function readCompanionMessage(event, { win, contactId = null, locationId = "" } = {}) {
  if (!event || event.source !== win) return null;
  const d = event.data;
  if (!d || typeof d !== "object") return null;
  if (d.type === COMPANION_HELLO) return { hello: true };
  if (d.type !== COMPANION_MESSAGE) return null;
  // A GHL tab on another sub-account is someone this page can't read.
  if (locationId && d.locationId && d.locationId !== locationId) return null;
  if (typeof d.contactId === "string" && ID.test(d.contactId)) return d.contactId === contactId ? null : { contactId: d.contactId };
  if (typeof d.conversationId === "string" && ID.test(d.conversationId)) return { conversationId: d.conversationId };
  return null;
}

/** The stand-in row the pane's parts read (PaneParts.jsx), for one person. */
export function companionPaneItem(contactId) {
  return {
    id: `companion:${contactId}`, kind: "companion", severity: "fyi", group: "yours",
    contactId, contactName: "", offerId: null, address: "", title: "", detail: "", ops: [],
  };
}
