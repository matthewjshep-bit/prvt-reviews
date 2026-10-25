// slack-notify.test.mjs — what the app tells Slack, and where (pure half).

import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSlack, slackOn, streamOn, slackChannelId, slackUserId, routeEvent, threadKeyFor, foldBlasts,
  renderEvent, renderPing, renderMorning, renderEvening, morningCounts, firstName, scrubForSlack, slackLinks, SLACK_EVENT_TYPES,
} from "./slack-notify.js";

const textOf = (msg) => [msg.text, ...(msg.blocks || []).flatMap((b) => [b.text?.text, ...(b.elements || []).map((e) => e.text)])].filter(Boolean).join("\n");

test("Slack ships off: nothing is on until Matt switches it on with a token and a channel", () => {
  const cfg = normalizeSlack(undefined);
  assert.equal(cfg.enabled, false);
  assert.ok(Object.values(cfg.streams).every((v) => v === false));
  assert.ok(Object.values(cfg.channels).every((v) => v === ""));
  assert.equal(slackOn(cfg, "xoxb-1"), false);
  const on = normalizeSlack({ enabled: true, channels: { acquisitions: "C0ACQ1234" }, streams: { acquisitions: true, underwrites: true } });
  assert.equal(slackOn(on, ""), false, "no token, nothing goes");
  assert.equal(slackOn(on, "xoxb-1"), true);
  assert.equal(streamOn(on, "acquisitions"), true);
  assert.equal(streamOn(on, "underwrites"), false, "a stream with no channel stays quiet");
});

test("a pasted channel link or a lower-case id becomes the channel id; junk is dropped", () => {
  assert.equal(slackChannelId("https://app.slack.com/client/T01ABCDEF/C07TIER1AB"), "C07TIER1AB");
  assert.equal(slackChannelId("c07tier1ab"), "C07TIER1AB");
  assert.equal(slackChannelId("#acquisitions"), "");
  assert.equal(slackUserId("<@U012MATT34>"), "U012MATT34");
  assert.equal(slackUserId("matt"), "");
  assert.equal(normalizeSlack({ appUrl: "javascript:alert(1)" }).appUrl, "https://app.shepflips.com");
  assert.equal(normalizeSlack({ appUrl: "https://app.shepflips.com/" }).appUrl, "https://app.shepflips.com");
});

test("a house reaching Tier 1 opens its thread in #acquisitions; the counter, hot and agreed show in the channel too", () => {
  assert.deepEqual(routeEvent({ type: "ghl_stage_moved", data: { to: "Tier 1" } }).map((r) => [r.stream, r.kind]), [["acquisitions", "tier1"]]);
  assert.deepEqual(routeEvent({ type: "ghl_stage_moved", data: { to: "Tier 2" } }), [], "a card going down isn't news");
  assert.equal(routeEvent({ type: "offer_countered" })[0].broadcast, true);
  assert.equal(routeEvent({ type: "offer_accepted" })[0].broadcast, true);
  const hot = routeEvent({ type: "note", data: { phrase: "hot — close to a contract" } });
  assert.deepEqual(hot.map((r) => [r.kind, r.broadcast]), [["hot", true]]);
  assert.deepEqual(routeEvent({ type: "note", data: { phrase: "called, left a message" } }), [], "any other note is quiet");
  assert.deepEqual(routeEvent({ type: "deal_promoted" }).map((r) => r.stream), ["acquisitions", "dispositions"]);
});

test("an underwrite is one message in #underwrites, edited when it lands; its result only replies in a house thread", () => {
  assert.deepEqual(routeEvent({ type: "underwrite_started" }).map((r) => [r.stream, r.update]), [["underwrites", false]]);
  const held = routeEvent({ type: "underwrite_held" });
  assert.deepEqual(held.map((r) => [r.stream, r.update, r.replyOnly]), [["underwrites", true, false], ["acquisitions", false, true]]);
  assert.equal(threadKeyFor(held[0], { data: { jobId: "j1" } }), "run:j1");
});

test("a buyer's own pass or a buyer text never lands in #acquisitions", () => {
  assert.deepEqual(routeEvent({ type: "offer_passed", party: "investor" }), []);
  assert.deepEqual(routeEvent({ type: "investor_passed", party: "investor" }).map((r) => r.stream), ["dispositions"]);
  assert.ok(SLACK_EVENT_TYPES.includes("blast_sent"));
});

test("a house keeps one thread per channel; a card move without an address rides on the live offer's house", () => {
  const route = { stream: "acquisitions", thread: "house" };
  const a = threadKeyFor(route, { address: "1010 Bellevue Way NE, Bellevue, WA 98004", contactId: "ann" });
  const b = threadKeyFor(route, { address: "1010 bellevue way ne, bellevue wa 98004", contactId: "ann" });
  assert.equal(a, b);
  assert.equal(threadKeyFor(route, { contactId: "ann" }, { address: "1010 Bellevue Way NE, Bellevue, WA 98004" }), a);
  assert.equal(threadKeyFor(route, { contactId: "ann" }), "contact:acquisitions:ann");
  assert.equal(threadKeyFor({ stream: "dispositions", thread: "deal" }, { offerId: "o9" }), "deal:o9");
});

test("a wave of buyer texts is one line per deal, not one per buyer", () => {
  const g = foldBlasts([
    { id: "e1", type: "blast_sent", offerId: "o1", address: "5232 S Yakima Ave", at: "2026-10-24T16:00:00Z" },
    { id: "e2", type: "blast_sent", offerId: "o1", address: "5232 S Yakima Ave", at: "2026-10-24T16:01:00Z" },
    { id: "e3", type: "blast_sent", offerId: "o2", address: "9311 12th Pl SE", at: "2026-10-24T16:02:00Z" },
  ]);
  assert.deepEqual(g.map((x) => [x.offerId, x.count]), [["o1", 2], ["o2", 1]]);
  assert.deepEqual(g[0].ids, ["e1", "e2"]);
});

test("a Slack message names the house, the numbers and a first name, never a phone, an email or a full name", () => {
  const route = routeEvent({ type: "offer_countered" })[0];
  const msg = renderEvent(route, { type: "offer_countered", contactId: "ann", address: "1010 Bellevue Way NE, Bellevue, WA", data: { amount: 410000 } },
    { firstName: firstName("Ann Marie Lee"), ours: 386500, locationId: "loc1", summary: "Ann says seller takes 410 if we close in 3 weeks — call 206-555-0142 or ann.lee@example.com" });
  const t = textOf(msg);
  assert.match(t, /1010 Bellevue Way NE/);
  assert.match(t, /\$410,000/);
  assert.match(t, /ours \$386,500/);
  assert.match(t, /\(Ann\)/);
  assert.doesNotMatch(t, /Marie|Lee\b/);
  assert.doesNotMatch(t, /206-555-0142|example\.com/);
  assert.match(t, /\[phone\]/);
  assert.match(t, /app\.gohighlevel\.com\/v2\/location\/loc1\/contacts\/detail\/ann/);
  assert.match(t, /app\.shepflips\.com\/contact\?contact=ann&location_id=loc1/);
});

test("a held underwrite says why, in the app's own words", () => {
  const route = routeEvent({ type: "underwrite_held" })[0];
  const t = textOf(renderEvent(route, { type: "underwrite_held", address: "609 168th Ave NE, Bellevue, WA", data: { jobId: "j", held: ["fewer than 8 photos", "too few comps"] } }));
  assert.match(t, /Underwrite held on \*609 168th Ave NE\*/);
  assert.match(t, /• fewer than 8 photos/);
  assert.match(t, /• too few comps/);
});

test("Slack's control characters in an address are escaped, not read as a link", () => {
  const t = textOf(renderEvent({ kind: "tier1" }, { type: "tier1_added", address: "12 <b>&</b> St" }));
  assert.match(t, /12 &lt;b&gt;&amp;&lt;\/b&gt; St/);
});

test("the needs-Matt post @-mentions him and says where to act", () => {
  const t = textOf(renderPing({ kind: "paper_to_sign", contactId: "ann", title: "1010 Bellevue Way: paperwork to sign", address: "1010 Bellevue Way NE, Bellevue" }, { mattUserId: "U012MATT34", locationId: "loc1" }));
  assert.match(t, /<@U012MATT34>/);
  assert.match(t, /paperwork to sign — in Offers → Hot/);
});

test("the morning numbers count houses and offers, Tier 1 once per contact", () => {
  const c = morningCounts([
    { type: "ghl_stage_moved", contactId: "a", data: { to: "Tier 1" }, at: "2026-10-24T01:00:00Z" },
    { type: "tier1_added", contactId: "a", at: "2026-10-24T02:00:00Z" },
    { type: "offer_sent", party: "agent", at: "2026-10-24T03:00:00Z" },
    { type: "offer_countered", at: "2026-10-24T03:30:00Z" },
    { type: "underwrite_held", at: "2026-10-24T04:00:00Z" },
    { type: "text_summary", data: { inbound: "hi" }, at: "2026-10-24T05:00:00Z" },
    { type: "offer_sent", party: "agent", at: "2026-10-22T03:00:00Z" },
  ], { since: "2026-10-23T14:00:00Z", until: "2026-10-24T14:00:00Z" });
  assert.equal(c.tier1, 1);
  assert.equal(c.offersSent, 1);
  assert.equal(c.counters, 1);
  assert.equal(c.underwritesHeld, 1);
  assert.equal(c.replies, 1);
  assert.match(textOf(renderMorning(c)), /Offers sent: \*1\*/);
});

test("the evening post lists the loose ends by street, never by name, and the machine's failures", () => {
  const t = textOf(renderEvening(
    { sections: [{ key: "accepted", label: "Seller said yes", items: [{ contactName: "Ann Lee", address: "1010 Bellevue Way NE, Bellevue", detail: "yes let's do it" }] }, { key: "held", label: "Underwrites that held", items: [] }] },
    { jobs: [{ label: "Nightly audit", failed: true }], errors: [{ area: "underwrite", count: 3 }] }));
  assert.match(t, /Seller said yes: \*1\* — 1010 Bellevue Way NE/);
  assert.doesNotMatch(t, /Ann|let's do it/);
  assert.doesNotMatch(t, /Underwrites that held/, "an empty section is left out");
  assert.match(t, /1 job failed \(Nightly audit\)/);
  assert.match(t, /underwrite ×3/);
});

test("scrubForSlack takes out phones and emails; firstName drops what isn't a name", () => {
  assert.equal(scrubForSlack("text me at (425) 555-0199 or a@b.co"), "text me at [phone] or [email]");
  assert.equal(firstName("LLC123 Holdings"), "");
  assert.equal(firstName(""), "");
  assert.equal(slackLinks({ locationId: "loc1", path: "/reports", view: "activity" }), "<https://app.shepflips.com/reports?view=activity&location_id=loc1|Open in app>");
});
