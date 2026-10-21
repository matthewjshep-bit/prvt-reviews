// opener-home-city.test.mjs — a Bend agent's first text says we're in Bend,
// not Seattle (2026-10-21).
//
// Matt: "as we expand into different areas widen our aperture and say 'im in
// bend' or 'im in portland' etc to let them know we are there and local. so
// depending who we are sending that to can we sub it out?" His first text
// said "I'm in Seattle" to every agent, Camano Island or Bend. {home} is now
// the city for the listing's market: a county in its state, then the state,
// then the default.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opener-home-city-test-"));
process.env.DATA_DIR = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { normalizeOpener, homeFor, homesFrom, homesText, firstTextHook, DEFAULT_OPENER_EXAMPLES, DEFAULT_HOMES } = await import("./shared/outreach-opener.js");
const { standardText } = await import("./shared/standard-texts.js");
const { outboundDescriptor } = await import("./reply-agent.js");

const MATT = "Hi {first}, came across your listing at {address}. I'm in {home} and looking for my next flip project around the greater {home} area. Is this one a bit of a project, or pretty turnkey?";
const saved = (opener = {}) => ({ outreachAutopilot: { opener: { examples: [MATT], ...opener } } });
const firstText = ({ address, county, state }, s = saved()) => {
  const outbound = outboundDescriptor({ kind: "outreach_open", offer: null, saved: s,
    subject: { address, county, house: { address, county, ...(state ? { state } : {}) }, variant: 0 } });
  return { outbound, text: standardText({ kind: "outreach_open", outbound, name: "Brenda", contactId: "c-1" })?.text };
};

test("a Bend agent reads that we're in Bend", () => {
  const { text } = firstText({ address: "14820 SE 172nd St, Bend, OR 97702", county: "Deschutes", state: "OR" });
  assert.equal(text, "Hi Brenda, came across your listing at 14820 SE 172nd St. I'm in Bend and looking for my next flip project around the greater Bend area. Is this one a bit of a project, or pretty turnkey?");
});

test("a Portland-area agent reads Portland, and a Camano Island one still reads Seattle", () => {
  assert.match(firstText({ address: "1 Main St, Gresham, OR 97030", county: "Multnomah", state: "OR" }).text, /I'm in Portland /);
  assert.match(firstText({ address: "1701 Hemlock Dr, Camano Island, WA 98282", county: "Island", state: "WA" }).text, /I'm in Seattle /);
});

test("the state comes off the address when the listing row didn't carry one", () => {
  assert.equal(homeFor({ county: "Deschutes", address: "61 NW Wall St, Bend, OR 97703" }, normalizeOpener()), "Bend");
  // Jefferson County is in both states: the Washington one is Port Townsend.
  assert.equal(homeFor({ county: "Jefferson", address: "1 Water St, Port Townsend, WA 98368" }, normalizeOpener()), "Seattle");
  assert.equal(homeFor({ county: "Jefferson", address: "1 Main St, Madras, OR 97741" }, normalizeOpener()), "Bend");
  // The sweep's county key carries its state.
  assert.equal(homeFor({ county: "Deschutes, OR" }, normalizeOpener()), "Bend");
  assert.equal(firstTextHook({ hook: { address: "61 NW Wall St, Bend, OR 97703", county: "Deschutes" } }).state, "OR");
});

test("Settings' lines set the markets, and the default covers everywhere else", () => {
  const homes = homesFrom("Deschutes, OR = Bend\nOR = Portland\nWhatcom = Bellingham\nnonsense line\nZZ = Nowhere");
  assert.deepEqual(homes, [
    { county: "Deschutes", state: "OR", home: "Bend" },
    { county: "", state: "OR", home: "Portland" },
    { county: "Whatcom", state: "WA", home: "Bellingham" },
  ]);
  assert.equal(homesText(homes), "Deschutes, OR = Bend\nOR = Portland\nWhatcom, WA = Bellingham");
  const o = normalizeOpener({ home: "tacoma", homes });
  assert.equal(homeFor({ county: "Whatcom", state: "WA" }, o), "Bellingham");
  assert.equal(homeFor({ county: "Pierce", state: "WA" }, o), "Tacoma");
  // Saved empty stays empty: every agent reads the default.
  assert.equal(homeFor({ county: "Deschutes", state: "OR" }, normalizeOpener({ homes: [] })), "Seattle");
  assert.deepEqual(normalizeOpener({}).homes, DEFAULT_HOMES);
});

test("the old defaults with Seattle written in read as today's {home} ones", () => {
  const old = "Hey {first}, saw your listing at {address}. I'm local here in Seattle and fix up houses. Does this one need much work? And if you've got other fixers on your radar, I'm all ears.";
  assert.deepEqual(normalizeOpener({ examples: [old, MATT] }).examples, [DEFAULT_OPENER_EXAMPLES[2], MATT]);
});

test("a follow-up that says {home} fills it from the first text's market", () => {
  const outbound = outboundDescriptor({ kind: "outreach_nudge", offer: null,
    saved: saved({ followUps: ["Hey {first}, following up. I'm based in {home}, anything that needs work?"] }),
    subject: { address: "14820 SE 172nd St, Bend, OR 97702", county: "Deschutes", step: 2, steps: [2] } });
  assert.equal(standardText({ kind: "outreach_nudge", outbound, name: "Brenda", contactId: "c-1" })?.text,
    "Hey Brenda, following up. I'm based in Bend, anything that needs work?");
});

test("the model writing a first text is shown Matt's examples with the city filled in", () => {
  const { outbound } = firstText({ address: "14820 SE 172nd St, Bend, OR 97702", county: "Deschutes", state: "OR" },
    saved({ mode: "ai" }));
  assert.equal(outbound.home, "Bend");
  assert.ok(outbound.examples.every((x) => !x.includes("{home}")));
  assert.match(outbound.examples[0], /I'm in Bend/);
});

/* ---------- Matt's own texts with Seattle typed in, and the follow-ups (2026-10-21, Matt: "make sure the followup is also intelligent to the agents area") ---------- */

// His live first text as saved in Settings: Seattle written in, not {home}.
const LIVE = "Hi {first}, came across your listing at {address}. I'm in Seattle and looking for my next flip project around {town}. Is this one a bit of a project, or pretty turnkey? And if you've got other fixers on your radar, I'm all ears.";

test("a Bend agent never reads Seattle from a first text Matt typed Seattle into", () => {
  const outbound = outboundDescriptor({ kind: "outreach_open", offer: null, saved: saved({ examples: [LIVE] }),
    subject: { address: "61 NW Wall St, Bend, OR 97703", county: "Deschutes", city: "Bend", house: { address: "61 NW Wall St, Bend, OR 97703", county: "Deschutes", state: "OR" }, variant: 0 } });
  const text = standardText({ kind: "outreach_open", outbound, name: "Brenda", contactId: "c-1" })?.text;
  assert.match(text, /I'm in Bend and looking for my next flip project around Bend\./);
  assert.doesNotMatch(text, /Seattle/);
});

test("a King County agent still reads Seattle from the same text", () => {
  const outbound = outboundDescriptor({ kind: "outreach_open", offer: null, saved: saved({ examples: [LIVE] }),
    subject: { address: "741 N 128th St, Seattle, WA 98133", county: "King", city: "Seattle", house: { address: "741 N 128th St, Seattle, WA 98133", county: "King", state: "WA" }, variant: 0 } });
  assert.match(standardText({ kind: "outreach_open", outbound, name: "Brenda", contactId: "c-1" })?.text, /I'm in Seattle and/);
});

test("a follow-up or check-in Matt typed Seattle into says Bend to a Bend agent", () => {
  const s = saved({ followUps: ["Hey {first}, Seattle guy here following up, anything that needs work?"], checkIns: ["Hi {first}, still buying around Seattle. Any fixers lately?"] });
  const nudge = outboundDescriptor({ kind: "outreach_nudge", offer: null, saved: s,
    subject: { address: "61 NW Wall St, Bend, OR 97703", county: "Deschutes", step: 1, steps: [1] } });
  assert.equal(standardText({ kind: "outreach_nudge", outbound: nudge, name: "Brenda", contactId: "c-1" })?.text,
    "Hey Brenda, Bend guy here following up, anything that needs work?");
  const checkIn = outboundDescriptor({ kind: "outreach_nudge", offer: null, saved: s,
    subject: { address: "61 NW Wall St, Bend, OR 97703", county: "Deschutes", repeats: true, stepIndex: 0, repeatN: 1 } });
  assert.equal(checkIn.home, "Bend");
});

test("the follow-up knows Bend from the county alone, or from the town alone", () => {
  // A GHL-cohort follow-up carries RentCast's county with no state and maybe a street-only address.
  assert.equal(homeFor({ county: "Deschutes", address: "61 NW Wall St" }, normalizeOpener()), "Bend");
  // A Bend address with no county: the town is one of ours, not "the rest of Oregon".
  assert.equal(homeFor({ address: "61 NW Wall St, Bend, OR 97703" }, normalizeOpener()), "Bend");
  assert.equal(homeFor({ address: "1 Main St, Gresham, OR 97030" }, normalizeOpener()), "Portland");
  assert.equal(homeFor({ county: "King", address: "741 N 128th St" }, normalizeOpener()), "Seattle");
});

test("the model writing a follow-up is told where we're based", async () => {
  const { outboundOpening } = await import("./conversation-prompt.js");
  for (const extra of [{}, { repeats: true, stepIndex: 0 }]) {
    const prompt = outboundOpening({ kind: "outreach_nudge", address: "61 NW Wall St, Bend, OR 97703", county: "Deschutes", home: "Bend", ...extra });
    assert.match(prompt, /based, it's Bend, nowhere else/);
  }
});

/* ---------- an Oregon agent writes the offer on Oregon's forms ---------- */

test("a Bend agent is asked to write it up on OREF forms, never NWMLS", async () => {
  const { offerForms } = await import("./shared/us-address.js");
  const { outboundOpening } = await import("./conversation-prompt.js");
  const { AGENT_PAPER_RULE } = await import("./shared/conversation-ai.js");
  assert.equal(offerForms("61 NW Wall St, Bend, OR 97703"), "OREF");
  assert.equal(offerForms("741 N 128th St, Seattle, WA 98133"), "NWMLS");
  assert.equal(offerForms("741 N 128th St"), "NWMLS");
  const push = outboundOpening({ kind: "hot_push", address: "61 NW Wall St, Bend, OR 97703", stepIndex: 1 });
  assert.match(push, /OREF forms/);
  assert.doesNotMatch(push, /NWMLS/);
  assert.match(AGENT_PAPER_RULE, /Oregon house's are OREF/);
});
