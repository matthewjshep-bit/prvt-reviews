// voice.test.mjs — one voice check for every text and email the machine
// sends (shared/voice.js, 2026-11-09).
//
// Matt: check-ins have to read like him, not like AI. The audit read the
// sent log against his own texts: the fixed templates said "desk" or
// "radar" in 40% of texts (Matt 0.9%), "on or off market" in 31%, "circling
// back" in 16%, and fixed texts preceded 47 of 61 agent opt-outs after a
// check-in. Only two outputs were checked after they were written.
//
// Every name, street and town below is invented.

import test from "node:test";
import assert from "node:assert/strict";

import { voiceFlags, repeatsUs, openerKey, groupsOf, savedTextFlags, ourLastTexts, emailCore, hardVoiceKeys,
  VOICE_RULE, TELLS, AI_COMPLAINT_RX, SENSITIVE_RX } from "./voice.js";
import { standardText, fillTemplate, firstNameOf, CHECKIN_TEXTS, CHECKIN_COLD_TEXTS, LISTING_PING_TEXTS, LISTING_PING_COLD_TEXTS,
  NUDGE_TEXTS, PAST_LISTING_TEXTS, COUNTY_OPENERS, LEGACY_CHECKIN_TEXTS, isShippedText, poolsFor } from "./standard-texts.js";
import { DAY_TWO_TEXTS, DEFAULT_FOLLOW_UP_TEXTS, DEFAULT_OPENER_EXAMPLES } from "./outreach-opener.js";
import { QUALIFY_ASKS, QUALIFY_PASSES, QUALIFY_CLOSED, FIXERS_ASKS, qualifyStep } from "./flip-read.js";
import { introEmailFor, checkInEmailFor, CHECK_IN_EMAIL_BODIES, INTRO_EMAIL_BODIES, EMAIL_OPT_OUT_LINE, LEGACY_INTRO_EMAIL_BODY, normalizeIntroEmail } from "./outreach-email.js";
import { carrierFlags } from "./carrier-words.js";
import { normalizeConversationAi, starterConfig, CONVERSATION_AI_DEFAULTS } from "./conversation-ai.js";
import { validateProposal } from "./coach.js";
import { blastMessage, DEFAULT_DEAL_TEXTS, normalizeDealTexts, LEGACY_DEFAULT_DEAL_TEXT } from "./blast-text.js";

const hard = (opts) => hardVoiceKeys(voiceFlags(opts));
const DAY = 86400000;
const NOW = Date.parse("2026-11-09T18:00:00Z");
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const VALUES = { street: "Alder Way", address: "1820 Alder Way", town: "Kentwood" };

/* ---------- the texts we ship ---------- */

test("every fixed check-in, follow-up, reply and email we ship passes the voice check and the carrier check, with and without a first name", () => {
  const sets = [
    [CHECKIN_TEXTS, "agent_checkin"], [CHECKIN_COLD_TEXTS, "agent_checkin_cold"], [LISTING_PING_TEXTS, "agent_listing"],
    [LISTING_PING_COLD_TEXTS, "agent_listing_cold"], [DAY_TWO_TEXTS, "day_two"], [DEFAULT_FOLLOW_UP_TEXTS, "day_two"],
    [NUDGE_TEXTS.slice(1), "outreach_nudge"], [PAST_LISTING_TEXTS, "outreach_open"], [Object.values(COUNTY_OPENERS).flat(), "outreach_open"],
  ];
  for (const [list, kind] of sets) {
    for (const t of list) {
      for (const first of ["Brenda", ""]) {
        const text = fillTemplate(t, { ...VALUES, first, home: "Seattle", county: "King" });
        assert.ok(text, t);
        assert.deepEqual(voiceFlags({ text, kind }), [], `${kind}: ${text}`);
        assert.deepEqual(carrierFlags(text), [], text);
        assert.doesNotMatch(text, /^(?:hi|hey|hello)\s*,|,\s*\?/i, text);
      }
    }
  }
  for (const t of [...QUALIFY_ASKS, ...QUALIFY_PASSES, ...QUALIFY_CLOSED, ...FIXERS_ASKS, CONVERSATION_AI_DEFAULTS.media.reply]) {
    assert.deepEqual(voiceFlags({ text: t, kind: "reply" }), [], t);
  }
  for (const [i] of INTRO_EMAIL_BODIES.entries()) {
    for (const name of ["Brenda Q", ""]) {
      const e = introEmailFor({ name, address: "1820 Alder Way, Kentwood, WA 98000", contactId: "c-1", shift: i });
      assert.deepEqual(voiceFlags({ text: e.body, channel: "email", kind: "outreach_email" }), [], e.body);
    }
  }
  for (const [i] of CHECK_IN_EMAIL_BODIES.entries()) {
    const e = checkInEmailFor({ name: "Brenda Q", address: "1820 Alder Way, Kentwood, WA 98000", contactId: "c-1", n: 1, shift: i });
    assert.deepEqual(voiceFlags({ text: e.body, channel: "email", kind: "checkin_email" }), [], e.body);
  }
  // A buyer's deal text: no dash in the built-in wording any more.
  for (let variant = 0; variant < 3; variant++) {
    const t = blastMessage({ firstName: "Ravi", address: "41 Alder Way, Kentwood, WA", city: "Kentwood", price: 300000, beds: 3, baths: 2, rehab: "medium", variant, intro: "found you through the county records" });
    assert.doesNotMatch(t, /[—–]/, t);
  }
});

test("adjacent check-ins in a pool share no phrase that's spent on repeat, so walking a pool never repeats one", () => {
  for (const list of [CHECKIN_TEXTS, CHECKIN_COLD_TEXTS, LISTING_PING_TEXTS, LISTING_PING_COLD_TEXTS, DAY_TWO_TEXTS]) {
    list.forEach((t, i) => {
      const next = list[(i + 1) % list.length];
      assert.deepEqual(groupsOf(t).filter((g) => groupsOf(next).includes(g)), [], `${t} / ${next}`);
    });
  }
});

test("hope you're doing well, anything come across your desk is a machine tell", () => {
  const text = fillTemplate(LEGACY_CHECKIN_TEXTS[1], { first: "Brenda" });
  assert.ok(hard({ text, kind: "agent_checkin" }).includes("hope you're doing well"), text);
  // "come across your desk" is Matt's own phrase once; on repeat it is spent.
  const again = hard({ text: "Brenda, anything come across your desk lately?", kind: "agent_checkin", prior: [{ text: "Hi Brenda, anything cross your desk this month?", at: ago(14) }], now: NOW });
  assert.ok(again.some((k) => /desk\/radar\/plate/.test(k)), again.join(" · "));
  for (const t of ["Just checking in, Brenda.", "Circling back on this one.", "Touching base on Alder.", "Wanted to reach out about Alder.", "I'd love a look.", "Feel free to send it my way."]) {
    assert.ok(hard({ text: t, kind: "agent_checkin" }).length, t);
  }
});

test("a dash, an exclamation mark or a sign-off in a machine check-in is flagged hard, and soft when Matt wrote it", () => {
  for (const [text, key] of [["Hey Brenda — anything rough lately?", "a dash"], ["Anything rough lately, Brenda!", "an exclamation mark"],
    ["Anything rough lately, Brenda? Thanks, Matt", "a sign-off"], ["Anything rough lately? -Matt", "a sign-off"]]) {
    assert.ok(hard({ text, kind: "agent_checkin" }).includes(key), `${text}: ${key}`);
    assert.deepEqual(hard({ text, kind: "agent_checkin", machine: false }), [], "his own: shown, never blocking");
    assert.ok(voiceFlags({ text, kind: "agent_checkin", machine: false }).some((f) => f.key === key && f.level === "soft"));
  }
  assert.deepEqual(hard({ text: "Hi Brenda, it's Matt. Anything around Kentwood that needs real work?", kind: "agent_checkin_cold" }), [], "it's Matt is no sign-off");
});

test("two questions in one machine text is flagged, except the qualify ask", () => {
  assert.ok(hard({ text: "Anything rough lately? Or anything off-market?", kind: "agent_checkin" }).includes("two questions"));
  assert.deepEqual(hard({ text: QUALIFY_ASKS[0], kind: "agent_checkin" }), [], "our two-part gut check is one ask");
  assert.deepEqual(hard({ text: "Is it the roof? Or the kitchen?", kind: "reply" }), [], "an answer to them is not held to it");
});

test("a phrase used on them in our last three texts is spent, and the same phrase a month earlier is fine", () => {
  const text = "Hey Brenda, any estates or tired rentals coming up on your end?";
  const recent = [{ text: "Hi Brenda, any estates in the works near Kentwood?", at: ago(14) }];
  assert.ok(hard({ text, kind: "agent_checkin", prior: recent, now: NOW }).some((k) => /estates\/rentals/.test(k)));
  const older = [{ text: "Hi Brenda, any estates in the works near Kentwood?", at: ago(45) }];
  assert.deepEqual(hard({ text, kind: "agent_checkin", prior: older, now: NOW }), [], "a month on, it's fresh again");
  const fourBack = [{ text: "Anything new?", at: ago(3) }, { text: "Any update on Alder?", at: ago(6) }, { text: "Saw your listing.", at: ago(9) },
    { text: "Hi Brenda, any estates in the works near Kentwood?", at: ago(12) }];
  assert.deepEqual(hard({ text, kind: "agent_checkin", prior: fourBack, now: NOW }), [], "only our last three count");
  // A text about an offer may say "rough number" as often as it needs.
  assert.deepEqual(hard({ text: "That's a rough number on Alder. Any word from the seller?", kind: "offer_nudge", prior: [{ text: "Anything rough lately?", at: ago(2) }], now: NOW }), []);
});

test("a text that repeats one of ours is caught: the same text, the same sentence, or the same opening twice running", () => {
  const prior = [{ text: "Hey Brenda, anything new on your plate that needs real work?", at: ago(10) }];
  assert.match(repeatsUs("Hey Brenda, anything new on your plate that needs real work?", prior), /same text/);
  assert.match(repeatsUs("Brenda, anything new on your plate that needs some real work?", prior), /sentence we already sent/);
  assert.match(repeatsUs("Hi Brenda, anything new on your end?", [{ text: "Hey Brenda, anything new on Alder?", at: ago(3) }]), /opens like our last text/);
  assert.equal(openerKey("Hey Brenda, any older houses coming up?"), "any older houses");
  assert.equal(repeatsUs("Any older houses coming up that need a lot?", prior), "");
});

test("a reminder about a time already set may say the same words as the last one", () => {
  const prior = [{ text: "Quick reminder, the walkthrough on Alder Way is tomorrow at 10.", at: ago(7) }];
  assert.deepEqual(hard({ text: "Quick reminder, the walkthrough on Alder Way is tomorrow at 10.", kind: "showing_reminder", prior, now: NOW }).filter((k) => /repeats us/.test(k)), []);
});

test("an answer may open Hey, but a check-in with no name to put after Hi is a tell", () => {
  assert.deepEqual(hard({ text: "Hey, yeah, we don't like to touch those. We're going to pass on it.", kind: "reply" }), []);
  assert.ok(hard({ text: "Hi, anything new that needs work?", kind: "agent_checkin" }).includes("a greeting with no name"));
  assert.ok(hard({ text: "Got it, thanks. Anything else?", kind: "reply" }).some((k) => /stock opener/.test(k)), "HUMAN bans the stock opener in replies too");
  assert.ok(hard({ text: "Hey {first}, anything new?", kind: "agent_checkin" }).includes("a blank nobody filled"));
});

test("our side of the thread is read newest first, texts and emails, not calls", () => {
  const t = [
    "[2026-11-01 17:00] US sms: Hi Brenda, saw your listing on Alder Way.",
    "[2026-11-02 17:00] THEM sms: thanks",
    "[2026-11-03 17:00] US call",
    "[2026-11-04 17:00] US SMS: Anything rough lately?",
  ].join("\n");
  assert.deepEqual(ourLastTexts(t).map((x) => x.text), ["Anything rough lately?", "Hi Brenda, saw your listing on Alder Way."]);
  assert.equal(ourLastTexts(t)[0].at, "2026-11-04T17:00:00Z");
});

test("the check-in branches' words are here: the rule, the tells, an AI complaint, a sensitive topic", () => {
  assert.match(VOICE_RULE, /one question/i);
  assert.ok(TELLS.length > 20);
  assert.match("lol are you a bot", AI_COMPLAINT_RX);
  assert.match("is this automated?", AI_COMPLAINT_RX);
  assert.doesNotMatch("Thanks, A.I. Brenda Realty", AI_COMPLAINT_RX, "never bare AI: initials");
  assert.match("my dad passed away last month", SENSITIVE_RX);
});

/* ---------- names ---------- */

test("a text to an agent with no first name doesn't open Hey, or end with a comma before the question mark", () => {
  for (const list of [CHECKIN_TEXTS, CHECKIN_COLD_TEXTS, LISTING_PING_TEXTS, LISTING_PING_COLD_TEXTS, DAY_TWO_TEXTS]) {
    for (const t of list) {
      const text = fillTemplate(t, { ...VALUES, first: "" });
      assert.doesNotMatch(text, /^(?:hi|hey|hello)\b\s*[,.]?\s/i, text);
      assert.doesNotMatch(text, /,\s*[?.]/, text);
      assert.match(text, /^[A-Z0-9]/, text);
    }
  }
  assert.equal(fillTemplate("Any fixers around {town} lately, {first}?", { first: "", town: "Kentwood" }), "Any fixers around Kentwood lately?");
  assert.equal(fillTemplate("{first}, seen anything rough lately?", { first: "" }), "Seen anything rough lately?");
  assert.equal(fillTemplate("anything near {town}?", { first: "", town: "Kentwood" }), "anything near Kentwood?", "a lowercase subject stays lowercase");
});

test("a first text never greets Agent", () => {
  for (const name of ["Agent", "agent smith", "REALTOR", "Broker Team", "Office", "The Kentwood Group"]) assert.equal(firstNameOf(name), "", name);
  assert.equal(firstNameOf("BRENDA QUILL"), "Brenda", "an ALL CAPS name reads as a name");
  assert.equal(firstNameOf("brenda"), "Brenda");
  const s = standardText({ kind: "agent_pulse", outbound: { mode: "template", reason: "general", segment: "engaged", variant: 0 }, name: "Agent" });
  assert.doesNotMatch(s.text, /\bAgent\b/);
  assert.match(s.text, /^[A-Z]/);
});

test("a cold agent's check-in names their town when we know it, and gives way to one that doesn't when we don't", () => {
  const cold = (address) => standardText({ kind: "agent_pulse", outbound: { mode: "template", reason: "general", segment: "cold", variant: 0, address }, name: "Dana" }).text;
  assert.equal(cold("1820 Alder Way, Kentwood, WA 98000"), "Hi Dana, it's Matt. Anything around Kentwood that needs real work?");
  assert.equal(cold(""), "Hey Dana, Matt here. Any older houses coming up that need a lot?");
});

test("the recent-lister first text passes our own carrier check", () => {
  for (const t of PAST_LISTING_TEXTS) {
    for (const first of ["Brenda", ""]) {
      const text = fillTemplate(t, { ...VALUES, first });
      assert.deepEqual(carrierFlags(text), [], text);
      assert.doesNotMatch(text, /buy houses|TLC/i, text);
    }
  }
});

/* ---------- which texts are ours, and the rollback ---------- */

test("the app's own fixed texts are checked as the machine's; Matt's own and the v1 rollback are only flagged", () => {
  for (const t of [...CHECKIN_TEXTS, ...DAY_TWO_TEXTS, ...PAST_LISTING_TEXTS]) assert.equal(isShippedText(t), true, t);
  for (const t of [...LEGACY_CHECKIN_TEXTS, ...DEFAULT_OPENER_EXAMPLES, "Hi {first}, my own text?"]) assert.equal(isShippedText(t), false, t);
  assert.equal(poolsFor("v1").checkin, LEGACY_CHECKIN_TEXTS);
  assert.equal(poolsFor("v2").checkin, CHECKIN_TEXTS);
  assert.equal(poolsFor("anything").checkin, CHECKIN_TEXTS);
  const v1 = standardText({ kind: "agent_pulse", outbound: { mode: "template", reason: "general", segment: "engaged", variant: 0 }, name: "Brenda", pools: "v1" });
  assert.equal(v1.text, fillTemplate(LEGACY_CHECKIN_TEXTS[0], { first: "Brenda" }));
});

test("Matt's own saved first text with a tell is flagged on the page but still sends", () => {
  const mine = "Hi {first}, saw your listing at {address}. I'm local and fix up houses. If you've got other fixers on your radar, I'm all ears.";
  const text = fillTemplate(mine, { ...VALUES, first: "Brenda" });
  const flags = voiceFlags({ text, kind: "outreach_open", machine: false });
  assert.ok(flags.some((f) => f.key === "I'm all ears"), "the page shows it");
  assert.ok(flags.every((f) => f.level === "soft"), "nothing of his is held");
  // standardText still fills it as written.
  const s = standardText({ kind: "outreach_open", outbound: { mode: "template", address: "1820 Alder Way, Kentwood, WA", templates: [mine], variant: 0 }, name: "Brenda" });
  assert.equal(s.text, text);
  assert.equal(isShippedText(s.template), false);
});

test("with check-ins unset, the settings normalise to lint on and the v2 pools", () => {
  assert.deepEqual(normalizeConversationAi({}).checkIns, { lint: true, pools: "v2" });
  assert.deepEqual(normalizeConversationAi({ checkIns: { lint: false, pools: "v1" } }).checkIns, { lint: false, pools: "v1" });
  assert.deepEqual(normalizeConversationAi({ checkIns: { pools: "v9" } }).checkIns, { lint: true, pools: "v2" });
  assert.deepEqual(normalizeConversationAi(normalizeConversationAi({ checkIns: { pools: "v1" } })).checkIns, { lint: true, pools: "v1" }, "survives a save");
});

/* ---------- the emails ---------- */

test("the intro email never says a couple of days ago and ends with the opt-out line", () => {
  for (let shift = 0; shift < INTRO_EMAIL_BODIES.length; shift++) {
    const e = introEmailFor({ name: "Brenda Q", address: "1820 Alder Way, Kentwood, WA 98000", contactId: "c-9", shift });
    assert.doesNotMatch(e.body, /couple of days ago|value-add|I'd love/i, e.body);
    assert.ok(e.body.endsWith(EMAIL_OPT_OUT_LINE), e.body);
    const postal = introEmailFor({ name: "Brenda Q", address: "1820 Alder Way, Kentwood, WA 98000", contactId: "c-9", shift, postalAddress: "PO Box 100, Kentwood, WA 98000" });
    assert.ok(postal.body.endsWith(`${EMAIL_OPT_OUT_LINE}\nPO Box 100, Kentwood, WA 98000`), "the postal address on its own line");
  }
  // A stored copy of the 10-20 email reads as never changed.
  assert.equal(normalizeIntroEmail({ body: LEGACY_INTRO_EMAIL_BODY }).body, normalizeIntroEmail({}).body);
  // Matt's own body is his, with the opt-out line put on the end.
  const mine = introEmailFor({ introEmail: { body: "Hi {first},\n\nMy own words about {street}." }, name: "Brenda Q", address: "1820 Alder Way, Kentwood, WA 98000" });
  assert.equal(mine.body, `Hi Brenda,\n\nMy own words about Alder Way.\n\n${EMAIL_OPT_OUT_LINE}`);
  // "v1" sends the 10-20 email back.
  assert.match(introEmailFor({ name: "Brenda Q", address: "1820 Alder Way, Kentwood, WA 98000", pools: "v1" }).body, /couple of days ago/);
});

test("an email's body is judged without its greeting, signature or opt-out line", () => {
  assert.equal(emailCore(`Hi Brenda,\n\nAnything near Kentwood?\n\nMatt\nShep Flips\n\n${EMAIL_OPT_OUT_LINE}`), "Anything near Kentwood?");
  const long = `Hi Brenda,\n\n${"Anything near Kentwood that needs real work, ".repeat(3)}?\n\nMatt\nShep Flips`;
  assert.ok(hard({ text: long, channel: "email", kind: "checkin_email" }).some((k) => /over 120/.test(k)));
});

/* ---------- the starter and the coach ---------- */

test("every starter example and instruction passes the voice check", () => {
  const c = starterConfig({ signer: "Matt" });
  for (const e of c.examples) assert.deepEqual(voiceFlags({ text: e.weSay, kind: "reply" }), [], e.weSay);
  const said = [c.persona.role, c.persona.voice, c.persona.ifAskedIfBot, ...c.rules, c.media.reply,
    ...Object.values(c.parties).flatMap((p) => [p.instructions, p.mayCommit, p.mayNotCommit])];
  for (const t of said) assert.deepEqual(savedTextFlags(t || ""), [], t);
  const all = said.join("\n");
  assert.doesNotMatch(all, /Got it, 480|Understood, thanks for your time|acquisitions assistant|My partner will send the contract|VALUE: cash/);
  assert.deepEqual(normalizeConversationAi(c), c, "no rule is cut at the 300-character cap");
});

test("a saved instruction that teaches a tell, says cash, or makes the bot an assistant is flagged", () => {
  assert.ok(savedTextFlags("When they pass, say 'Understood, thanks for your time!' and stop.").some((f) => /exclamation|stock opener/.test(f)));
  assert.ok(savedTextFlags("ROLE: acquisitions assistant for an investment group.").some((f) => /assistant/.test(f)));
  assert.ok(savedTextFlags("We write cash offers on listings that have sat.").some((f) => /hard money/.test(f)));
  assert.deepEqual(savedTextFlags("Never say cash; we fund with a hard money loan."), [], "a never is the rule itself");
  assert.deepEqual(savedTextFlags("Never ask what it's worth fixed up, what the work would run or what work it needs."), [], "an apostrophe is no quote");
});

test("a coach proposal whose example carries a machine tell is rejected", () => {
  const base = { kind: "example", party: "agent", why: "two agents went quiet after the long version", evidence: ["d1"], theySaid: "Seller wants out fast" };
  const bad = validateProposal({ ...base, weSay: "Got it — I'd love to take a look!" }, { config: { examples: [] }, knownIds: ["d1"] });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /reads like a machine/);
  const good = validateProposal({ ...base, weSay: "Makes sense. What would they take for it as it sits?" }, { config: { examples: [] }, knownIds: ["d1"] });
  assert.equal(good.ok, true, good.reason);
  const rule = validateProposal({ kind: "rule", party: "agent", why: "w", evidence: ["d1"], text: "End a pass on 'Keep me in mind!'" }, { config: { rules: [] }, knownIds: ["d1"] });
  assert.equal(rule.ok, false);
});

test("a saved copy of the old first deal text, with its dash, reads as today's", () => {
  assert.deepEqual(normalizeDealTexts([LEGACY_DEFAULT_DEAL_TEXT, "Hey {first}, my own one: {place}. {close}"]), [DEFAULT_DEAL_TEXTS[0], "Hey {first}, my own one: {place}. {close}"]);
  for (const t of DEFAULT_DEAL_TEXTS) assert.doesNotMatch(t, /[—–]/);
});

test("our passes in Matt's voice still read as our pass, so a held number on that house closes", async () => {
  const { ourReplyPasses } = await import("./flip-read.js");
  const { saysWePass } = await import("./promise-owed.js");
  for (const t of ["Sounds too finished for me, I go after houses that need real work. Got anything like that coming up?",
    "We're too far apart on this one, so I'll pass. Thanks for working it with me. Got anything else that needs work or would be a good flip?",
    QUALIFY_CLOSED[0], QUALIFY_CLOSED[2], ...QUALIFY_PASSES]) assert.equal(saysWePass(t), true, t);
  assert.equal(ourReplyPasses("Sounds too finished for me, I go after houses that need real work. Got anything like that coming up?"), true);
  assert.equal(ourReplyPasses("It's more finished than I expected. What's the seller hoping to get?"), false);
});

test("the closed line after our pass goes in turn, never the same one twice running", () => {
  const seen = [0, 1, 2].map((n) => qualifyStep({ words: "it's all redone, turnkey", asked: true, passed: true, variant: 0, closedN: n }).reply);
  assert.equal(new Set(seen).size, 3);
  for (const r of seen) { assert.match(r, /\?$/); assert.doesNotMatch(r, /keep me in mind/i); }
});
