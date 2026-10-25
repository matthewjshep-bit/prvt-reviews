// slack-notify.test.mjs — what the app tells Slack, and where (pure half).

import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSlack, slackOn, streamOn, slackChannelId, slackUserId, routeEvent, threadKeyFor, foldBlasts,
  renderEvent, renderTier1, renderPing, fullName, acquisitionStatus, dispositionStatus, withStatus, houseStatus, renderMorning, renderEvening, morningCounts, firstName, scrubForSlack, slackLinks, SLACK_EVENT_TYPES,
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

// Matt, 2026-10-25: "acquisition should just show tier 1s that have been
// flagged, not the whole conversations of all the back-and-forth."
test("only a house reaching Tier 1 posts in #acquisitions; its offer, counter, hot and agreed reply quietly in its thread", () => {
  assert.deepEqual(routeEvent({ type: "ghl_stage_moved", data: { to: "Tier 1" } }).map((r) => [r.stream, r.kind, r.opensOnly]), [["acquisitions", "tier1", true]]);
  assert.deepEqual(routeEvent({ type: "ghl_stage_moved", data: { to: "Tier 2" } }), [], "a card going down isn't news");
  assert.deepEqual(routeEvent({ type: "house_mentioned" }), [], "a house an agent named isn't Tier 1");
  for (const type of ["offer_sent", "offer_countered", "realm_yes", "offer_accepted", "offer_passed"]) {
    const [r] = routeEvent({ type });
    assert.deepEqual([r.stream, r.replyOnly, r.broadcast], ["acquisitions", true, false], type);
  }
  const hot = routeEvent({ type: "note", data: { phrase: "hot — close to a contract" } });
  assert.deepEqual(hot.map((r) => [r.kind, r.replyOnly, r.broadcast]), [["hot", true, false]]);
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
  assert.match(t, /app\.shepflips\.com\/\?view=history&contact=ann&location_id=loc1\|Open in app>/);
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

// Matt, 2026-10-25: "the address flagged, the agent, the full address, and
// then the description, line by line … and then the links underneath."
test("the Tier 1 post is itemized: the house, the agent, the full address, the description, then the links", () => {
  const msg = renderEvent({ kind: "tier1" }, { type: "ghl_stage_moved", contactId: "ann", address: "624 NW Hill St, Seattle, WA 98107", data: { to: "Tier 1", why: "a house they raised" } },
    { firstName: "Ann", fullName: "Ann Marie Lee", summary: "Vacant, needs roof and kitchen; seller wants a quick close — call 206-555-0142", locationId: "loc1" });
  assert.equal(msg.blocks[0].text.text, [
    ":large_green_circle: *Tier 1 flagged: 624 NW Hill St*",
    "*Agent:* Ann Marie Lee",
    "*Address:* 624 NW Hill St, Seattle, WA 98107",
    "*Description:* Vacant, needs roof and kitchen; seller wants a quick close — call [phone]",
  ].join("\n"));
  assert.equal(msg.blocks[1].type, "context");
  assert.match(msg.blocks[1].elements[0].text, /Open in app>.*\|Contact in GHL>/);
  assert.equal(msg.text, "Tier 1 flagged: 624 NW Hill St (Ann)");
});

test("a Tier 1 post with no summary says why it's Tier 1, and a dash for what isn't known", () => {
  const t = renderTier1({ address: "20160 Reed Ln", data: { why: "a house they raised" } }, {}).blocks[0].text.text;
  assert.match(t, /\*Agent:\* —\n/);
  assert.match(t, /\*Description:\* a house they raised$/);
});

test("the GHL app link must be an https link; a full name that isn't one is dropped", () => {
  const link = "https://app.gohighlevel.com/v2/location/LOC1/custom-menu-link/7f7c8c1e";
  assert.equal(normalizeSlack({ appLink: link }).appLink, link);
  assert.equal(normalizeSlack({ appLink: "javascript:alert(1)" }).appLink, "");
  assert.equal(normalizeSlack({}).appLink, "");
  assert.equal(slackLinks({ appLink: link, locationId: "L", path: "/reports" }), `<${link}|Open in app>`, "a post about no one opens the app inside GHL");
  assert.match(slackLinks({ appLink: link, locationId: "L", contactId: "c9" }), /^<https:\/\/app\.shepflips\.com\/\?view=history&contact=c9&location_id=L\|Open in app> · /);
  assert.equal(fullName("  Ann   Marie Lee "), "Ann Marie Lee");
  assert.equal(fullName("206-555-0142"), "");
});

// Matt, 2026-10-25: "we're doing the underwrites by hand" — a skeleton or
// draft-only run made a draft, it didn't hold an underwrite.
test("a draft the app made for Matt to price posts nowhere; a real held underwrite still does", () => {
  assert.deepEqual(routeEvent({ type: "underwrite_held", data: { draftOnly: true, held: ["ready for your comps — the app made a skeleton from the address, nothing looked up"] } }), []);
  assert.deepEqual(routeEvent({ type: "underwrite_held", data: { held: ["ready for your comps — the app made the draft, you price it"] } }), [], "events from before draftOnly was recorded");
  assert.deepEqual(routeEvent({ type: "underwrite_held", data: { held: ["fewer than 8 photos"] } }).map((r) => r.stream), ["underwrites", "acquisitions"]);
});

// Matt, 2026-10-25: "go to the acquisition channel and see what the offer
// status is with the emoji" — one status per house, one per deal.
test("a Tier 1 house's status emoji follows its offer: nothing, sent, countered, hot, agreed or contract, passed", () => {
  const at = (o) => acquisitionStatus(o) && [acquisitionStatus(o).emoji, acquisitionStatus(o).label];
  assert.equal(acquisitionStatus({ status: "draft" }), null, "still waiting on us");
  assert.deepEqual(at({ status: "sent", cashAmount: 386500 }), ["outbox_tray", "Offer sent — $386,500"]);
  assert.deepEqual(at({ status: "countered" }), ["left_right_arrow", "They countered"]);
  assert.deepEqual(at({ status: "sent", hot: { at: "2026-10-25T18:00:00Z", by: "operator" } }), ["fire", "Hot — close to a contract"]);
  assert.deepEqual(at({ status: "accepted" }), ["white_check_mark", "Agreed"]);
  assert.deepEqual(at({ status: "accepted", deal: { stage: "under_contract" } }), ["white_check_mark", "Under contract"]);
  assert.deepEqual(at({ status: "we_passed", passReason: { code: "turnkey" } }), ["x", "We passed — too turnkey"]);
  assert.deepEqual(at({ status: "passed" }), ["x", "They passed"]);
  assert.deepEqual(at({ status: "accepted", deal: { stage: "fell_through" } }), ["x", "The deal fell through"]);
});

test("a deal's status emoji follows its buyers and stage; a pre-sale pitch isn't a buyer looking", () => {
  const ds = (deal) => dispositionStatus({ deal }) && dispositionStatus({ deal }).emoji;
  assert.equal(dispositionStatus({ deal: { stage: "under_contract" } }), null);
  assert.equal(ds({ stage: "under_contract", blasts: [{ wave: 1 }] }), "mega");
  assert.equal(ds({ stage: "under_contract", blasts: [{}], investors: [{ status: "evaluating", source: "presell" }] }), "mega");
  assert.equal(ds({ stage: "under_contract", investors: [{ status: "evaluating" }, { status: "evaluating" }] }), "eyes");
  assert.equal(dispositionStatus({ deal: { stage: "under_contract", investors: [{ status: "evaluating" }, { status: "evaluating" }] } }).label, "2 buyers looking");
  assert.equal(ds({ stage: "under_contract", investors: [{ status: "committed" }] }), "handshake");
  assert.equal(ds({ stage: "buyer_found" }), "handshake");
  assert.equal(ds({ stage: "assigned" }), "memo");
  assert.equal(ds({ stage: "closed" }), "trophy");
  assert.equal(ds({ stage: "fell_through" }), "x");
});

test("the Status line sits under the post's first line, is replaced as it moves, and goes when there's none", () => {
  const blocks = [{ type: "section", text: { type: "mrkdwn", text: "head\n*Agent:* Ann Lee" } }, { type: "context", elements: [{ type: "mrkdwn", text: "links" }] }];
  const one = withStatus(blocks, { emoji: "outbox_tray", label: "Offer sent — $386,500" }, "2026-10-25T18:00:00Z");
  assert.equal(one[0].text.text, "head\n*Status:* :outbox_tray: Offer sent — $386,500 (Oct 25)\n*Agent:* Ann Lee");
  assert.deepEqual(one[1], blocks[1]);
  const two = withStatus(one, { emoji: "x", label: "We passed — too turnkey" }, "2026-10-26T18:00:00Z");
  assert.equal(two[0].text.text, "head\n*Status:* :x: We passed — too turnkey (Oct 26)\n*Agent:* Ann Lee");
  assert.equal(withStatus(two, null)[0].text.text, "head\n*Agent:* Ann Lee");
});

test("hot taken off posts nothing but still moves the house's status", () => {
  assert.deepEqual(routeEvent({ type: "note", data: { phrase: "no longer hot" } }).map((r) => [r.stream, r.statusOnly]), [["acquisitions", true]]);
});

// 3 Horizon Hill Ln, 2026-10-25: one agent's fresh draft and another agent's
// hot counter on the same house. The house is hot.
test("a house's status is the furthest along of every agent's current offer on it", () => {
  const T = "2026-10-20T18:00:00Z";
  const hot = { id: "a", contactId: "a1", status: "countered", hot: { at: T, by: "conversation" }, createdAt: T };
  const draft = { id: "b", contactId: "b1", status: "draft", createdAt: T };
  const passed = { id: "c", contactId: "c1", status: "passed", createdAt: T };
  const sent = { id: "d", contactId: "d1", status: "sent", cashAmount: 300000, createdAt: T };
  assert.equal(houseStatus([draft, hot]).key, "hot");
  assert.equal(houseStatus([draft, hot]).offer.id, "a");
  assert.equal(houseStatus([passed, sent]).key, "sent", "one agent passing doesn't close a house another is live on");
  assert.equal(houseStatus([passed]).key, "passed");
  assert.equal(houseStatus([draft]), null);
});
