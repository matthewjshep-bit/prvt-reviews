// background.js — notices which person the GoHighLevel tab is on and tells
// the companion window (app.shepflips.com/contact, CompanionView.jsx).
//
// It reads the GHL tab's address only (shared/ghl-url.js, a synced copy of
// /shared); host permissions limit it to GHL and our own app, so other
// tabs' addresses never reach it. Nothing is logged about anyone.

import { parseGhlUrl } from "./shared/ghl-url.js";

const COMPANION_URLS = ["https://app.shepflips.com/contact*", "http://localhost:5173/contact*"];

// The person last opened in GHL, for a companion that opens after it.
async function remember(target) {
  await chrome.storage.session.set({ lastTarget: target });
}

async function tell(target) {
  if (!target) return;
  await remember(target);
  const tabs = await chrome.tabs.query({ url: COMPANION_URLS });
  for (const tab of tabs) {
    // A companion tab still loading has no content script yet; it asks for
    // lastTarget itself when it's ready.
    chrome.tabs.sendMessage(tab.id, { type: "ghl-contact", ...target }).catch(() => {});
  }
}

// GHL is a single-page app: a click on a contact changes the address without
// a page load, and Chrome still reports it here.
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.url) tell(parseGhlUrl(info.url));
});

// Going back to a GHL tab that was already on someone shows them again.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try { tell(parseGhlUrl((await chrome.tabs.get(tabId)).url)); } catch { /* tab gone */ }
});
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab?.url) tell(parseGhlUrl(tab.url));
  } catch { /* window gone */ }
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type !== "companion-ready") return false;
  (async () => {
    // The companion's own address carries the location and its key; keep
    // it so the toolbar button can reopen the window.
    if (sender.tab?.url) {
      const u = new URL(sender.tab.url);
      u.searchParams.delete("contact");
      await chrome.storage.local.set({ companionUrl: u.toString() });
    }
    const { lastTarget = null } = await chrome.storage.session.get("lastTarget");
    reply({ target: lastTarget });
  })();
  return true;
});

// The toolbar button: bring the companion forward, or open it again.
chrome.action.onClicked.addListener(async () => {
  const [tab] = await chrome.tabs.query({ url: COMPANION_URLS });
  if (tab) {
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
    return;
  }
  const { companionUrl = "" } = await chrome.storage.local.get("companionUrl");
  if (!companionUrl) {
    // It has never seen one: the app's Companion button opens the first.
    await chrome.tabs.create({ url: "https://app.shepflips.com/" });
    return;
  }
  await chrome.windows.create({ url: companionUrl, type: "popup", width: 560, height: 900 });
});
