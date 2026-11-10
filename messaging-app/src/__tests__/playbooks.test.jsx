import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PartyPlaybooks, BookingCard, BootPassCard, AutoSendCard, readOffDays, CheckInComposerFields } from "../ConversationPlaybooks.jsx";
import { normalizeConversationAi, NEVER_AUTO, INTENT_LABEL } from "@shared/conversation-ai.js";

test("the playbook grid offers every eligible intent as a box and every locked one as a lock", () => {
  const config = normalizeConversationAi({ parties: { agent: { autoSend: { enabled: true, intents: ["question"] } } } });
  const html = renderToStaticMarkup(<PartyPlaybooks config={config} patch={() => {}} workflows={{ list: [], loading: false }} />);
  expect(html).toContain("First text to new agents");
  expect(html).toContain("Send the offer after a clean underwrite");
  expect(html).toContain(INTENT_LABEL.agent.outreach_open);
  for (const intent of NEVER_AUTO.agent) expect(html).toContain(INTENT_LABEL.agent[intent]);
  expect(html).toContain("Never on its own");
});

// Matt, 2026-11-10: the bot never books or promises a call. The card says so
// and has nothing to switch, even on a config saved with booking on.
test("the booking card shows booking as retired with nothing to switch, and the auto-send card renders", () => {
  const config = normalizeConversationAi({ booking: { enabled: true, calendarId: "c1", calendarName: "Afternoons" } });
  expect(config.booking.enabled).toBe(false);
  const booking = renderToStaticMarkup(<BookingCard config={config} patch={() => {}} calendars={{ list: [{ id: "c1", name: "Afternoons" }], loading: false }} />);
  expect(booking).toContain("Booking calls (retired)");
  expect(booking).toContain("Call me whenever, or text here.");
  expect(booking).toContain("Slack ping");
  expect(booking).not.toContain("Let it offer times");
  expect(booking).not.toContain("type=\"checkbox\"");
  expect(booking).not.toContain("Afternoons");
  const auto = renderToStaticMarkup(<AutoSendCard config={config} patch={() => {}} />);
  expect(auto).toContain("Quick replies");
  expect(auto).toContain("Weekends");
});

test("the days-off box saves a list of dates and drops a typo", () => {
  const read = readOffDays("2026-12-25\n 2026-11-26 \n\n11/27/2026\nThanksgivng\n2026-02-30\n2026-11-26");
  expect(read.days).toEqual(["2026-11-26", "2026-11-27", "2026-12-25"]);
  expect(read.dropped).toEqual(["Thanksgivng", "2026-02-30"]);
  // What the box saves is what the settings keep.
  expect(normalizeConversationAi({ autoSend: { offDays: read.days } }).autoSend.offDays).toEqual(read.days);
  const config = normalizeConversationAi({ autoSend: { offDays: ["2026-11-26", "2026-12-25"] } });
  const html = renderToStaticMarkup(<AutoSendCard config={config} patch={() => {}} />);
  expect(html).toContain("Days off (no machine texts; replies still go)");
  expect(html).toContain("2026-11-26\n2026-12-25");
});

test("the realm check's float switches show under it, off until ticked", () => {
  const config = normalizeConversationAi({ parties: { agent: { realmCheck: { enabled: true } } } });
  const html = renderToStaticMarkup(<PartyPlaybooks config={config} patch={() => {}} workflows={{ list: [], loading: false }} />);
  expect(html).toContain("Say how we got there first");
  expect(html).toContain("Float a range topped by our number");
  expect(html).toContain("End with one setup question");
  const on = normalizeConversationAi({ parties: { agent: { realmCheck: { enabled: true, range: { enabled: true, pct: 5 }, setupQuestion: { enabled: true } } } } });
  const html2 = renderToStaticMarkup(<PartyPlaybooks config={on} patch={() => {}} workflows={{ list: [], loading: false }} />);
  expect(html2).toContain("% under our number");
  expect(html2).toContain("anything I won&#x27;t see in the photos");
  const off = normalizeConversationAi({ parties: { agent: { realmCheck: { enabled: false } } } });
  expect(renderToStaticMarkup(<PartyPlaybooks config={off} patch={() => {}} workflows={{ list: [], loading: false }} />)).not.toContain("Float a range topped by our number");
});

// 2026-11-09: check-ins that name one real thing. The composer is new
// automation: it shows Off until Matt sets it, and its samples sit side by side.
test("the check-in composer shows off by default, with its share, wait and personal switches", () => {
  const html = renderToStaticMarkup(<CheckInComposerFields config={normalizeConversationAi({})} patch={() => {}} />);
  expect(html).toContain("Check-ins: one real thing");
  expect(html).toContain("Never a past house, street or address");
  expect(html).toMatch(/<option value="off" selected="">Off<\/option>/);
  expect(html).toContain("Shadow (write beside, send the fixed one)");
  expect(html).toContain("Share written by the model (%)");
  expect(html).toContain("Wait when there&#x27;s nothing to say (days)");
  expect(html).toContain("A detail they shared may be the one thing");
  expect(html).toContain("Read 3 side by side");
  const on = renderToStaticMarkup(<CheckInComposerFields config={normalizeConversationAi({ checkIns: { composer: "shadow", composerShare: 50 } })} patch={() => {}} />);
  expect(on).toMatch(/<option value="shadow" selected="">/);
  expect(on).toContain('value="50"');
});

// The boot pass (2026-11-09) had no switch on the page: turning it on meant
// a GET and a PUT of the whole blob by hand. Off by default; the switch keeps
// the rest of the nightly audit as it was.
test("the boot pass has a switch on the page, off by default, and turning it on keeps the rest of the nightly audit", () => {
  const config = normalizeConversationAi({ nightlyAudit: { hour: 21, loose: false, heldSweep: false } });
  expect(config.nightlyAudit.bootPass).toBe(false);
  const html = renderToStaticMarkup(<BootPassCard config={config} patch={() => {}} />);
  expect(html).toContain("After a restart, answer texts from the last hour that got no reply");
  expect(html).not.toContain("checked=\"\"");
  const patched = [];
  const el = BootPassCard({ config, patch: (p) => patched.push(p) });
  const toggle = [].concat(el.props.children).find((c) => typeof c?.props?.onChange === "function");
  toggle.props.onChange(true);
  expect(patched[0]).toEqual({ nightlyAudit: { ...config.nightlyAudit, bootPass: true } });
  const saved = normalizeConversationAi({ ...config, ...patched[0] });
  expect(saved.nightlyAudit).toEqual({ ...config.nightlyAudit, bootPass: true });
  expect(renderToStaticMarkup(<BootPassCard config={saved} patch={() => {}} />)).toContain("checked=\"\"");
});
