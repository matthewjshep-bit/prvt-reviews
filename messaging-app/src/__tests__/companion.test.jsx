import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ContactDrawer, { ContactRecordBody } from "../ContactDrawer.jsx";
import CompanionView from "../CompanionView.jsx";
import { COMPANION_HELLO, COMPANION_MESSAGE, companionPaneItem, readCompanionMessage } from "../companion.js";
import { rowTargets } from "../work-queue.js";

const win = {};
const CONTACT = "Zx9Yw8Vu7Ts6Rq5Po4Nm";
const CONVO = "Qw1Er2Ty3Ui4Op5As6Df";
const msg = (data, source = win) => ({ source, data });

test("opening a contact in GHL shows them in the companion; the same contact again does nothing", () => {
  expect(readCompanionMessage(msg({ type: COMPANION_MESSAGE, contactId: CONTACT }), { win })).toEqual({ contactId: CONTACT });
  expect(readCompanionMessage(msg({ type: COMPANION_MESSAGE, contactId: CONTACT }), { win, contactId: CONTACT })).toBe(null);
});

test("opening a GHL conversation asks who it belongs to", () => {
  expect(readCompanionMessage(msg({ type: COMPANION_MESSAGE, conversationId: CONVO }), { win })).toEqual({ conversationId: CONVO });
});

test("the extension saying hello lights the companion's dot", () => {
  expect(readCompanionMessage(msg({ type: COMPANION_HELLO }), { win })).toEqual({ hello: true });
});

test("a message from another window, another shape, a bad id or another sub-account is ignored", () => {
  expect(readCompanionMessage(msg({ type: COMPANION_MESSAGE, contactId: CONTACT }, {}), { win })).toBe(null);
  expect(readCompanionMessage(msg({ type: "something-else", contactId: CONTACT }), { win })).toBe(null);
  expect(readCompanionMessage(msg("shepflips:ghl-contact"), { win })).toBe(null);
  expect(readCompanionMessage(msg({ type: COMPANION_MESSAGE, contactId: "../../etc" }), { win })).toBe(null);
  expect(readCompanionMessage(msg({ type: COMPANION_MESSAGE, contactId: "short" }), { win })).toBe(null);
  expect(readCompanionMessage(msg({ type: COMPANION_MESSAGE, contactId: CONTACT, locationId: "OtherLoc1234567890" }), { win, locationId: "ThisLoc1234567890" })).toBe(null);
  expect(readCompanionMessage(msg({ type: COMPANION_MESSAGE, contactId: CONTACT, locationId: "ThisLoc1234567890" }), { win, locationId: "ThisLoc1234567890" })).toEqual({ contactId: CONTACT });
  expect(readCompanionMessage(null, { win })).toBe(null);
});

test("the companion's pane is that person's, with no offer picked yet so their own is chosen", () => {
  const t = rowTargets(companionPaneItem(CONTACT), []);
  expect(t.contactId).toBe(CONTACT);
  expect(t.offerId).toBe(null);
});

test("with no one open yet the companion says to open a contact in GHL", () => {
  const html = renderToStaticMarkup(<CompanionView />);
  expect(html).toContain("Open a contact in GoHighLevel");
  expect(html).toContain("Not following GHL yet");
});

test("the drawer is still a slide-over with a close button; the companion's record has neither", () => {
  const drawer = renderToStaticMarkup(<ContactDrawer contactId={CONTACT} onClose={() => {}} />);
  expect(drawer).toContain('role="dialog"');
  expect(drawer).toContain('aria-label="Close"');
  expect(drawer).toContain("sticky top-0");
  const inline = renderToStaticMarkup(<ContactRecordBody contactId={CONTACT} inline />);
  expect(inline).not.toContain('role="dialog"');
  expect(inline).not.toContain('aria-label="Close"');
  expect(inline).not.toContain("sticky top-0");
  expect(inline).toContain("Loading their record");
});

test("the companion's pane opens on the Offer tab; the Desk's still opens on Conversation", async () => {
  const { PaneBody } = await import("../PaneParts.jsx");
  const item = { ...companionPaneItem(CONTACT), contactName: "Dana Reyes" };
  const targets = rowTargets(item, []);
  const pane = { side: { offer: null, siblings: [], replaced: null, loading: false, error: "", reload: () => {} }, theirs: { loading: false },
    offerId: null, editing: null, requote: () => {}, requoting: false, setOfferId: () => {}, edit: () => {}, setEditing: () => {} };
  const convo = { item, targets, sendsEnabled: false, serverOffsetMs: 0, onDone: () => {}, fb: null, taught: [], bot: null };
  const bodies = { thread: { messages: [] } };
  const selected = (html) => html.match(/aria-selected="true"[^>]*>([^<]+)</)?.[1];
  expect(selected(renderToStaticMarkup(<PaneBody pane={pane} item={item} targets={targets} convo={convo} bodies={bodies} defaultTab="offer" />))).toBe("Offer");
  expect(selected(renderToStaticMarkup(<PaneBody pane={pane} item={item} targets={targets} convo={convo} bodies={bodies} />))).toBe("Conversation");
});

test("the stage picker shows GHL's four stages in the board's order, and says what a pick will do with their card", async () => {
  const { default: GhlStagePicker, cardNote } = await import("../GhlStagePicker.jsx");
  const html = renderToStaticMarkup(<GhlStagePicker contactId={CONTACT} party="agent" />);
  const labels = [...html.matchAll(/role="radio"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]+)</g)].map((m) => m[1]);
  expect(labels).toEqual(["Tier 2", "Tier 1", "Offer Out", "Contract"]);
  expect(renderToStaticMarkup(<GhlStagePicker contactId={CONTACT} party="investor" />)).toBe("", "a buyer has no Acquisitions card");
  expect(cardNote({ stage: null })).toMatch(/No card in Acquisitions yet/);
  expect(cardNote({ stage: "Tier 2", key: "tier2", status: "lost", open: 0 })).toMatch(/lost \(was Tier 2\)\. Picking a stage reopens it\.$/);
  expect(cardNote({ stage: "Contract", key: "contract", status: "won", open: 0 })).toBe("Their card is won. Picking a stage makes a new one.");
  expect(cardNote({ stage: "Offer Out", key: "offerOut", status: "open", open: 2 })).toMatch(/two open cards/);
  expect(cardNote({ stage: "Negotiations", name: "Negotiations", key: null, status: "open", open: 1 })).toMatch(/an old stage/);
  expect(cardNote({ stage: "Tier 1", key: "tier1", status: "open", open: 1 })).toBe("");
});
