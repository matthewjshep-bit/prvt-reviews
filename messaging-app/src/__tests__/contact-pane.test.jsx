import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import OfferPane from "../OfferPane.jsx";
import ContactPane from "../ContactPane.jsx";
import { usePane } from "../PaneParts.jsx";
import { companionPaneItem } from "../companion.js";
import { rowTargets } from "../work-queue.js";

// Matt, 2026-10-18: "every single place you jump has a slightly different
// sort of interface. We should standardize all of them."

const offer = { id: "o1", contactId: "c1", contactName: "Dana Reyes", address: "12 Elm St, Renton, WA", cashAmount: 410000, status: "sent", createdAt: "2026-09-12T00:00:00Z", sends: [{ ts: "2026-09-12T18:00:00Z" }] };
const bodies = { offer, siblings: [offer], thread: { messages: [], more: false }, coach: { proposals: [], taught: [] }, timeline: null, drafts: [], sendsEnabled: false };

function Companion() {
  const item = { ...companionPaneItem("c1"), contactName: "Dana Reyes" };
  const targets = rowTargets(item, []);
  const pane = usePane({ item, targets, bodies });
  const convo = { item, targets, sendsEnabled: false, serverOffsetMs: 0, onDone: () => {}, fb: pane.fb, taught: [], bot: null };
  return <ContactPane pane={pane} item={item} targets={targets} convo={convo} bodies={bodies} defaultTab="offer" />;
}

// 2026-10-20: the Desk is gone (no Today); the Offers split and the companion remain.
test("the Offers split and the companion show one pane: the same name line, the same buttons, the same two sides", () => {
  const panes = {
    offers: renderToStaticMarkup(<OfferPane offer={offer} index={0} total={3} onPrev={null} onNext={() => {}} onClose={() => {}} bodies={bodies} />),
    companion: renderToStaticMarkup(<Companion />),
  };
  for (const [where, html] of Object.entries(panes)) {
    expect(html, where).toMatch(/<h2[^>]*>.*Dana Reyes.*<span> · 12 Elm St<\/span>/s);
    for (const s of ["Change status (currently Sent)", "Edit offer", "> Call</button>", 'aria-label="More"', ">Conversation<", ">Offer<", "$410,000"]) expect(html, `${where}: ${s}`).toContain(s);
    // Gone everywhere.
    for (const s of ['aria-label="Bot:', ">History<", "What happened", "Checked", 'aria-label="GHL pipeline stage"']) expect(html, `${where}: ${s}`).not.toContain(s);
  }
  // What's each page's own: the Offers split walks a list; the companion follows GHL.
  expect(panes.offers).toContain('aria-label="Next offer"');
  expect(panes.offers).toContain('aria-label="Back to the table"');
  expect(panes.companion).not.toContain('aria-label="Next');
});
