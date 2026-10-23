// offer-sync.js — every window shows the offer as it was last saved.
//
// The editor saves as you type (2026-10-23), and Matt works an offer with the
// Offers page in one window and the companion beside GHL in another. Each
// window keeps its own cache (work-data.js), so before this one only learned
// about the other's save on a reload.
//
// A save announces { id, contactId, updatedAt } twice: to this window (a
// window event — BroadcastChannel never delivers to its own sender) and to
// every other window on this origin (BroadcastChannel). The console is served
// from two hosts (app.shepflips.com and the Netlify one), and a channel never
// crosses origins, so listeners also re-read when their window comes back
// into focus.

import { forget } from "./work-data.js";

const CHANNEL = "shepflips-offers";
const EVENT = "shepflips:offer-changed";

let channel;   // undefined: not opened yet; null: not available here
function openChannel() {
  if (channel !== undefined) return channel;
  try { channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL) : null; } catch { channel = null; }
  return channel;
}

/** What an announcement carries: enough to know whose rows to re-read, nothing more. */
export function offerChange(offer) {
  if (!offer?.id) return null;
  return { id: offer.id, contactId: offer.contactId || null, updatedAt: offer.updatedAt || new Date().toISOString(), deleted: Boolean(offer.deleted) };
}

/**
 * announceOffer(offer) — after a save, a send, a status, a re-quote. The
 * cached copies of the row and of its agent's list are dropped here, so
 * whatever mounts next reads fresh.
 */
export function announceOffer(offer) {
  const msg = offerChange(offer);
  if (!msg) return;
  forget(`offer:${msg.id}`, msg.contactId ? `offers-of:${msg.contactId}` : null);
  try { window.dispatchEvent(new CustomEvent(EVENT, { detail: { ...msg, local: true } })); } catch { /* no window (tests, SSR) */ }
  try { openChannel()?.postMessage(msg); } catch { /* a closed channel is not worth a save */ }
}

/**
 * onOfferChanged(fn) → unsubscribe
 *   fn({ id, contactId, updatedAt, local }) for an announcement from this
 *   window (local: true) or another, and fn({ focus: true }) when the window
 *   comes back into view — the cross-origin fallback, where nothing says
 *   which offer moved.
 */
export function onOfferChanged(fn) {
  if (typeof window === "undefined") return () => {};
  const onLocal = (e) => fn(e.detail || {});
  const ch = openChannel();
  const onRemote = (e) => {
    const msg = e?.data || {};
    if (!msg.id) return;
    forget(`offer:${msg.id}`, msg.contactId ? `offers-of:${msg.contactId}` : null);
    fn({ ...msg, local: false });
  };
  const onFocus = () => { if (typeof document === "undefined" || !document.hidden) fn({ focus: true }); };
  window.addEventListener(EVENT, onLocal);
  window.addEventListener("focus", onFocus);
  ch?.addEventListener?.("message", onRemote);
  return () => {
    window.removeEventListener(EVENT, onLocal);
    window.removeEventListener("focus", onFocus);
    ch?.removeEventListener?.("message", onRemote);
  };
}

/** Is this announcement about the offer (or the agent) a view is showing? */
export function concerns(msg, { offerIds = [], contactId = null } = {}) {
  if (!msg) return false;
  if (msg.focus) return true;
  return offerIds.filter(Boolean).includes(msg.id) || Boolean(contactId && msg.contactId === contactId);
}
