// needs-view.test.jsx — GHL's Needs Matt list on the Offers and Deals rows
// (2026-11-23 audit, nav-3 narrowed): the reason goes on the row it is about,
// and the pills count who has a row on each page.
import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { attachNeeds, needsCounts, needTitle, passWhen } from "../needs-view.js";
import { NeedsPill } from "../ui.jsx";

const NOW = Date.parse("2026-11-23T18:00:00Z"); // a Monday, 10am Pacific
const rows = [
  { id: "a1", contactId: "agent-a", status: "sent", address: "12 Elm St" },
  { id: "a2", contactId: "agent-a", status: "sent", address: "4 Oak Ave" },
  { id: "b-old", contactId: "agent-b", status: "sent", address: "9 Pine Rd", supersededBy: { id: "b-new" } },
  { id: "b-new", contactId: "agent-b", status: "sent", address: "9 Pine Rd" },
  { id: "c-draft", contactId: "agent-c", status: "draft", address: "1 Birch Ln" },
  { id: "d-deal", contactId: "agent-d", status: "accepted", address: "7 Cedar Ct", deal: { stage: "under_contract" } },
  { id: "e", contactId: "agent-e", status: "sent", address: "3 Fir St" },
];
const needs = [
  { contactId: "agent-a", kind: "yes", offerId: "a2", why: "They agreed on 4 Oak Ave at 300K" },
  { contactId: "agent-b", kind: "paper", offerId: "b-old", why: "They asked for proof of funds on 9 Pine Rd" },
  { contactId: "agent-c", kind: "price", offerId: "c-draft", why: "Price it on 1 Birch Ln", passAt: "2026-11-24T17:00:00Z" },
  { contactId: "agent-d", kind: "paper", offerId: null, why: "Paperwork to sign" },
];
const on = (list) => list.filter((o) => o.needsMatt).map((o) => o.id);

test("the reason goes on the row the list names, and on its house's current row when a newer offer replaced it", () => {
  const out = attachNeeds(rows, needs);
  expect(on(out)).toEqual(["a2", "b-new", "c-draft", "d-deal"]);
  expect(out.find((o) => o.id === "b-new").needsMatt.why).toContain("proof of funds");
});

test("an agent who isn't on the list carries nothing, and an empty list changes nothing", () => {
  expect(attachNeeds(rows, needs).find((o) => o.id === "e").needsMatt).toBeUndefined();
  expect(attachNeeds(rows, [])).toBe(rows);
});

test("the pills count agents with a row on each page: offers that aren't deals, and live deals", () => {
  expect(needsCounts(attachNeeds(rows, needs))).toEqual({ offers: 3, deals: 1 });
  const closed = rows.map((o) => (o.id === "d-deal" ? { ...o, deal: { stage: "closed" } } : o));
  expect(needsCounts(attachNeeds(closed, needs)).deals).toBe(0);
});

test("a house waiting on his price says when the bot passes it", () => {
  expect(passWhen("2026-11-24T17:00:00Z", NOW)).toBe("Tue 9am");
  expect(passWhen("2026-11-23T23:30:00Z", NOW)).toBe("today 3:30pm");
  expect(needTitle(needs[2], NOW)).toBe("Price it on 1 Birch Ln · the bot passes it Tue 9am unless you price it");
  const html = renderToStaticMarkup(<NeedsPill need={needs[2]} now={NOW} />);
  expect(html).toContain("Needs you: price it · passes Tue 9am");
  expect(renderToStaticMarkup(<NeedsPill need={needs[0]} now={NOW} />)).toContain("Needs you: approve");
  expect(renderToStaticMarkup(<NeedsPill need={null} />)).toBe("");
});
