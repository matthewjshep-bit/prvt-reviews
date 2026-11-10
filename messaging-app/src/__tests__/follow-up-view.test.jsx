import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildFollowUpEngine } from "@shared/follow-up-engine.js";
import { FollowUpBody } from "../FollowUpView.jsx";

// Saturday 2026-10-17, noon Pacific.
const NOW = Date.parse("2026-10-17T19:00:00Z");
const DAY = 86400000;
const at = (d) => new Date(NOW + d * DAY).toISOString();

const page = (over = {}) => buildFollowUpEngine({
  period: "week", now: NOW,
  sent: [
    { mech: "offer_nudge", src: "draft", contactId: "c1", name: "Dana Agent", offerId: "o1", address: "12 Elm St, Renton, WA", at: at(-2) },
    { mech: "outreach_open", src: "event", contactId: "c9", at: at(-1) },
  ],
  inbound: [{ contactId: "c1", at: at(-1.9) }],
  queued: [{ mech: "agent_pulse", contactId: "c2", name: "Lee Agent", at: at(0.1) }],
  planned: [{ mech: "offer_nudge", contactId: "c3", offerId: "o3", address: "9 Oak St, Kent, WA", at: at(1) }],
  held: [{ mech: "counter_nudge", contactId: "c4", at: at(-1) }],
  cohort: { firstTexted: 20, replied: 5 },
  status: { offer_nudge: { state: "on" }, agent_pulse: { state: "drafts", why: "check-ins are drafted for you (auto-send is off)" } },
  settings: { fu: { minHoursBetween: 72, ladders: { offer_nudge: { steps: [3, 7, 14], repeatEvery: 7 } } } },
  nothingScheduled: { count: 1, rows: [{ offerId: "o7", address: "7 Pine St, Auburn, WA", status: "sent", reason: "the nudges ran out" }] },
  ...over,
});

test("the follow-up engine shows the sketch's blocks, the KPIs, and what each mechanism did and has coming", () => {
  const html = renderToStaticMarkup(<FollowUpBody data={page()} now={NOW} />);
  for (const label of ["Agent outreach", "Agent follow-up", "Offer follow-up · sent", "Offer follow-up · passed", "Buyers"]) expect(html).toContain(label);
  expect(html).toContain("Agents reached out to");
  expect(html).toContain("5 · 25%");
  expect(html).toContain("1 · 100% replied");
  expect(html).toContain("Offer nudge");
  expect(html).toContain("days 3, 7 and 14, then every 7 days");
  expect(html).toContain("Drafts only");
  expect(html).toContain("check-ins are drafted for you");
  expect(html).toContain("1 waiting on you");
  expect(html).toContain("a plan, not a guarantee");
  expect(html).toContain("7 Pine St");
  // An event-driven row says what sets it off instead of a made-up zero.
  expect(html).toContain("fires when the price watch sees a house we offered on drop");
});

test("the year to date says where the outbox's 180 days begin", () => {
  const html = renderToStaticMarkup(<FollowUpBody data={page({ period: "ytd" })} now={NOW} />);
  expect(html).toContain("the outbox keeps sent texts 180 days");
  expect(html).toContain("counted from Apr 20");
});

test("a clicked mechanism lists who and what, with the replied ones marked", () => {
  const data = page();
  const items = data.items.filter((x) => x.mech === "offer_nudge");
  const html = renderToStaticMarkup(<FollowUpBody data={data} now={NOW} pick={{ kind: "mechanism", key: "offer_nudge", items, total: items.length }} />);
  expect(html).toContain("Dana Agent");
  expect(html).toContain("replied");
  expect(html).toContain("9 Oak St");
  expect(html).toContain("Tomorrow");
});

test("a follow-up answered by STOP shows as stopped beside the replies, never as replied", () => {
  const data = page({
    sent: [
      { mech: "offer_nudge", src: "draft", contactId: "c1", name: "Dana Agent", offerId: "o1", address: "12 Elm St, Renton, WA", at: at(-2) },
      { mech: "offer_nudge", src: "draft", contactId: "c5", name: "Rory Agent", offerId: "o5", address: "5 Ash St, Kent, WA", at: at(-2) },
    ],
    inbound: [{ contactId: "c1", at: at(-1.9) }, { contactId: "c5", at: at(-1.9), stop: true }],
  });
  const html = renderToStaticMarkup(<FollowUpBody data={{ ...data, countingChanged: "2026-11-09" }} now={NOW} />);
  expect(html).toContain("2 · 50% replied · 1 stopped (50%)");
  expect(html).toContain("1 stopped (50%)");
  expect(html).toContain("Counting changed on 2026-11-09");
  const items = data.items.filter((x) => x.mech === "offer_nudge");
  const list = renderToStaticMarkup(<FollowUpBody data={data} now={NOW} pick={{ kind: "mechanism", key: "offer_nudge", items, total: items.length }} />);
  expect(list).toContain("stopped");
});
