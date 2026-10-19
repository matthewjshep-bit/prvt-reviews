import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ContactDrawer from "../ContactDrawer.jsx";
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

// Matt, 2026-10-18: one pane everywhere, and the record behind the name in
// the companion too, not a second copy of the name under the pane.
test("the record opens as the same slide-over everywhere, with a close button", () => {
  const drawer = renderToStaticMarkup(<ContactDrawer contactId={CONTACT} onClose={() => {}} />);
  expect(drawer).toContain('role="dialog"');
  expect(drawer).toContain('aria-label="Close"');
  expect(drawer).toContain("sticky top-0");
  expect(drawer).toContain("Loading their record");
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

test("the stage menu by their name lists GHL's four stages in the board's order, ticks theirs, and says what a pick will do with their card", async () => {
  const { GhlStageMenu, stageMenuItems, cardNote } = await import("../PaneParts.jsx");
  expect(stageMenuItems(null).map((i) => i.label)).toEqual(["Tier 2", "Tier 1", "Offer Out", "Contract"]);
  const open = { stage: "Offer Out", key: "offerOut", status: "open", open: 1, name: "Offer Out" };
  expect(stageMenuItems(open).filter((i) => i.selected).map((i) => i.key)).toEqual(["offerOut"]);
  expect(stageMenuItems({ ...open, status: "lost" }).some((i) => i.selected)).toBe(false);
  const picked = [];
  stageMenuItems(open, { onPick: (k) => picked.push(k) })[1].onSelect();
  expect(picked).toEqual(["tier1"]);
  const pill = renderToStaticMarkup(<GhlStageMenu contactId={CONTACT} party="agent" card={open} />);
  expect(pill).toContain("GHL: Offer Out");
  expect(pill).toContain('aria-haspopup="menu"');
  expect(renderToStaticMarkup(<GhlStageMenu contactId={CONTACT} party="investor" card={open} />)).toBe("", "a buyer has no Acquisitions card");
  expect(cardNote({ stage: null })).toMatch(/No card in Acquisitions yet/);
  expect(cardNote({ stage: "Tier 2", key: "tier2", status: "lost", open: 0 })).toMatch(/lost \(was Tier 2\)\. Picking a stage reopens it\.$/);
  expect(cardNote({ stage: "Contract", key: "contract", status: "won", open: 0 })).toBe("Their card is won. Picking a stage makes a new one.");
  expect(cardNote({ stage: "Offer Out", key: "offerOut", status: "open", open: 2 })).toMatch(/two open cards/);
  expect(cardNote({ stage: "Negotiations", name: "Negotiations", key: null, status: "open", open: 1 })).toMatch(/an old stage/);
  expect(cardNote({ stage: "Tier 1", key: "tier1", status: "open", open: 1 })).toBe("");
});

// Matt, 2026-10-19: "it would also be nice to see active deals associated with
// the person on the companion" — every deal they're on, closed included.
test("the companion lists the deals a person is on with how they're on it, its stage and a link to the deal", async () => {
  const { default: CompanionDeals } = await import("../CompanionDeals.jsx");
  const own = { id: "dealA", contactId: CONTACT, address: "5232 S Yakima Ave, Tacoma, WA", deal: { stage: "under_contract", createdAt: "2026-10-01T00:00:00Z" } };
  const theirs = { id: "dealB", contactId: "someAgent", address: "9 Closed Ct, Kent, WA", deal: { stage: "closed", createdAt: "2026-09-01T00:00:00Z" } };
  const html = renderToStaticMarkup(<CompanionDeals rec={{
    offers: [own, { id: "plain", contactId: CONTACT, address: "1 No Deal St" }],
    deals: [{ offer: theirs, roles: ["buyer"], standing: { status: "committed" }, feedback: [] }],
  }} />);
  expect(html).toContain("5232 S Yakima Ave");
  expect(html).toContain("Listing agent");
  expect(html).toContain("9 Closed Ct");
  expect(html).toContain("Buyer");
  expect(html).toContain("committed");
  expect(html).toContain("deal_id=dealA");
  expect(html).toContain("deal_id=dealB");
  expect(html).not.toContain("1 No Deal St");
  expect(html.indexOf("5232 S Yakima")).toBeLessThan(html.indexOf("9 Closed Ct"));
});

test("someone on no deal shows no deals in the companion", async () => {
  const { default: CompanionDeals } = await import("../CompanionDeals.jsx");
  expect(renderToStaticMarkup(<CompanionDeals rec={{ offers: [{ id: "plain", address: "1 No Deal St" }], deals: [] }} />)).toBe("");
  expect(renderToStaticMarkup(<CompanionDeals rec={null} />)).toBe("");
});
