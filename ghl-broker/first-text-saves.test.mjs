// first-text-saves.test.mjs — the first text Matt saves on Autopilot →
// Agents is the one that goes (2026-10-20).
//
// Matt: "I'm trying to save or update the Agent Outreach text … and it won't
// let me save. It just continues to store these three drafted texts." His
// text was 237 characters with the app's blanks, and a saved text over 220
// was dropped without a word, so the page came back with the defaults. He
// wrote the blanks the way GHL does ({{contact.first_name}}), which the app
// never filled.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "first-text-saves-test-"));

const { normalizeOpener, openerVoice, PLAIN_DEFAULT_OPENER_EXAMPLES } = await import("./shared/outreach-opener.js");
const { standardText } = await import("./shared/standard-texts.js");
const { outboundDescriptor, previewProactive } = await import("./reply-agent.js");
const { store } = await import("./store.js");

const MATTS = "Hi {first}, came across your listing at {address}. I'm in Seattle and looking for my next flip project around {county} County. Is this one a bit of a project, or pretty turnkey? And if you've got other fixers on your radar, I'm all ears.";
const AS_PASTED = "Hi {{contact.first_name}}, came across your listing at {{contact.short_hand_property_address ie 123 Main St}}. I'm in Seattle and looking for my next flip project around {{insert county}}. Is this one a bit of a project, or pretty turnkey? And if you've got other fixers on your radar, I'm all ears.";

test("a long first text Matt saves is kept, not swapped back for the defaults", () => {
  assert.ok(MATTS.length > 220);
  assert.deepEqual(normalizeOpener({ examples: [MATTS] }).examples, [MATTS]);
  assert.deepEqual(normalizeOpener({ followUps: [MATTS] }).followUps, [MATTS]);
});

test("GHL's way of writing the blanks becomes the app's, so they get filled in", () => {
  assert.deepEqual(normalizeOpener({ examples: [AS_PASTED] }).examples, [
    "Hi {first}, came across your listing at {address}. I'm in Seattle and looking for my next flip project around {county} County. Is this one a bit of a project, or pretty turnkey? And if you've got other fixers on your radar, I'm all ears.",
  ]);
  assert.deepEqual(normalizeOpener({ examples: ["Hey {{contact.firstName}}, {{ property.street }} in {{contact.city}}?"] }).examples, ["Hey {first}, {street} in {town}?"]);
});

test("his one text goes to every new agent, filled in", async () => {
  const saved = { aiApiKey: "k", conversationAi: { enabled: true }, outreachAutopilot: { opener: { examples: [AS_PASTED] } } };
  let modelCalls = 0;
  const r = await previewProactive({ client: { call: async () => ({}) }, locationId: "loc-first-text", saved, store, contactId: "", kind: "outreach_open", name: "Brenda",
    subject: { address: "14820 Se 172nd St, Renton, WA 98058", county: "King", city: "Renton", variant: 2 },
    deps: { draft: async () => { modelCalls++; return { reply: "x", summary: "s", confidence: "high" }; } } });
  assert.equal(modelCalls, 0);
  assert.equal(r.reply, "Hi Brenda, came across your listing at 14820 SE 172nd St. I'm in Seattle and looking for my next flip project around King County. Is this one a bit of a project, or pretty turnkey? And if you've got other fixers on your radar, I'm all ears.");
  assert.equal(r.held, false, r.flags?.join(" · "));
});

test("the model still learns only short first texts: a long saved one isn't its example", () => {
  assert.deepEqual(openerVoice(normalizeOpener({ examples: [MATTS] })), PLAIN_DEFAULT_OPENER_EXAMPLES);
  const short = "Hi {first}, is {street} a project?";
  assert.deepEqual(openerVoice(normalizeOpener({ examples: [MATTS, short] })), [short]);
  const o = outboundDescriptor({ kind: "outreach_open", offer: null, saved: { outreachAutopilot: { opener: { examples: [MATTS] } } }, subject: { address: "1 Elm St, Kent, WA" } });
  assert.deepEqual(o.templates, [MATTS]);
  assert.equal(standardText({ kind: "outreach_open", outbound: { ...o, county: "" }, name: "Dana" }), null, "no county to name: the model writes that one");
});

test("around the city, not the county: {{contact.city}} or {town} is the listing's town", async () => {
  const withCity = "Hi {{contact.first_name}}, came across your listing at {{contact.short_hand_property_address ie 123 Main St}}. I'm in Seattle and looking for my next flip project around {{contact.city}}. Is this one a bit of a project, or pretty turnkey? And if you've got other fixers on your radar, I'm all ears.";
  assert.match(normalizeOpener({ examples: [withCity] }).examples[0], /project around \{town\}\. Is this/);
  const saved = { aiApiKey: "k", conversationAi: { enabled: true }, outreachAutopilot: { opener: { examples: [withCity] } } };
  const r = await previewProactive({ client: { call: async () => ({}) }, locationId: "loc-first-text-city", saved, store, contactId: "", kind: "outreach_open", name: "Brenda",
    subject: { address: "14820 Se 172nd St, Renton, WA 98058", county: "King", city: "Renton", variant: 0 },
    deps: { draft: async () => ({ reply: "x", summary: "s", confidence: "high" }) } });
  assert.equal(r.reply, "Hi Brenda, came across your listing at 14820 SE 172nd St. I'm in Seattle and looking for my next flip project around Renton. Is this one a bit of a project, or pretty turnkey? And if you've got other fixers on your radar, I'm all ears.");
});
