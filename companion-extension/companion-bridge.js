// companion-bridge.js — runs in the companion window (app.shepflips.com/
// contact) and passes the background's "this person is open in GHL" into
// the page, which reads it with readCompanionMessage (messaging-app/src/
// companion.js). Says hello so the page's dot turns green.

(() => {
  const ORIGIN = window.location.origin;
  const post = (data) => window.postMessage(data, ORIGIN);
  const pass = (t) => {
    if (!t) return;
    post({ type: "shepflips:ghl-contact", locationId: t.locationId || null, contactId: t.contactId || null, conversationId: t.conversationId || null });
  };
  const hello = () => post({ type: "shepflips:companion-hello" });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "ghl-contact") pass(msg);
  });
  // The page asks when it starts listening after this script said hello.
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data?.type === "shepflips:companion-ping") hello();
  });
  hello();
  // Whoever was opened in GHL before this window was.
  chrome.runtime.sendMessage({ type: "companion-ready" }).then((r) => pass(r?.target)).catch(() => {});
})();
