# Shep Flips Companion (Chrome extension)

This extension makes the companion window (`app.shepflips.com/contact`) follow whoever you open in GoHighLevel. Open a contact, or that contact's conversation, in GHL, and the companion shows their offer, conversation and record.

It only reads GHL tab **addresses**, never GHL page content. Chrome lets it see GHL and app.shepflips.com and nothing else.

## Install (once)
1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and choose this `companion-extension` folder.
3. Pin **Shep Flips Companion** from the puzzle-piece menu.

## Use
- In the app, click **Companion** in the header (top right). A narrow window opens. Put it beside GHL.
- Open contacts or conversations in GHL. The companion switches to each one.
- The dot at the top of the companion is green when this extension is talking to it.
- The toolbar button brings the companion forward, or reopens it.

Chrome can't keep a window always on top. Use macOS split view, or a window manager, to keep it beside GHL.

## Changing it
`shared/ghl-url.js` is a synced copy. Edit `/shared/ghl-url.js`, run `node scripts/sync-shared.mjs`, then press the reload arrow on this extension in `chrome://extensions`.
