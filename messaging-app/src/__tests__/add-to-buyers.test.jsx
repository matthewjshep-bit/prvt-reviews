import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ContactPane, { AddToBuyersForm } from "../ContactPane.jsx";
import { usePane } from "../PaneParts.jsx";
import { companionPaneItem } from "../companion.js";
import { rowTargets } from "../work-queue.js";

// 2026-11-09: 70 agents told us they buy and none reached the buyer book;
// one who asked for our deals was told there was nothing. Matt's call is a
// press, never automatic: the pane offers it when their held reply said they
// buy, and ⋯ has it for any agent.
const offer = { id: "o1", contactId: "c1", contactName: "Tamsin", address: "31 Fernhollow Ct, Fife, WA", cashAmount: 380000, status: "sent", createdAt: "2026-10-12T00:00:00Z" };

function Pane({ partnerTerms = null, party = "agent" }) {
  const draft = { id: "d1", contactId: "c1", status: "draft", party, createdAt: "2026-11-09T18:00:00Z", ...(partnerTerms ? { partnerTerms } : {}) };
  const item = { ...companionPaneItem("c1"), contactName: "Tamsin", draftId: "d1" };
  const targets = rowTargets(item, [draft]);
  const bodies = { offer, siblings: [offer], thread: { messages: [], more: false }, coach: { proposals: [], taught: [] }, timeline: null, drafts: [draft], sendsEnabled: false };
  const pane = usePane({ item, targets, bodies });
  const convo = { item, targets, sendsEnabled: false, serverOffsetMs: 0, onDone: () => {}, fb: pane.fb, taught: [], bot: null };
  return <ContactPane pane={pane} item={item} targets={targets} convo={convo} bodies={bodies} defaultTab="offer" />;
}

test("an agent whose held reply asked for our deals gets an Add to buyers button", () => {
  const html = renderToStaticMarkup(<Pane partnerTerms={{ kind: "investor_buyer", phrase: "Any other deals you're looking to assign?", addToBuyers: true }} />);
  expect(html).toContain("Add to buyers");
  expect(html).toContain("Their thread stays an agent");
});

test("an agent who didn't say they buy has no button, and a buyer never does", () => {
  expect(renderToStaticMarkup(<Pane />)).not.toMatch(/<button[^>]*title="They said they buy/);
  expect(renderToStaticMarkup(<Pane party="investor" partnerTerms={{ kind: "investor_buyer", addToBuyers: true }} />)).not.toContain("Add to buyers");
});

test("the form asks for the areas they buy, and nothing else", () => {
  const html = renderToStaticMarkup(<AddToBuyersForm contactId="c1" onClose={() => {}} />);
  expect(html).toContain("Areas they buy");
  expect(html).toContain("optional, e.g. Tacoma, Puyallup");
  expect(html).toContain("Add to buyers");
});
