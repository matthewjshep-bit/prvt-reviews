// plain-outreach.test.mjs — the cold texts to listing agents are Matt's own
// plain ones, and only about listings that say they need work (2026-10-17).
//
// Matt: "simplify our initial outreach messaging to agents AND the followup
// asking about properties … keep it short and sweet, personable, and to the
// point … we're getting too creative … We should definitely double-check that
// it has distress signals." On 10/16 the sweep texted 375 agents off
// RentCast's numbers alone, each text written fresh by the model, and the
// answers were "it's move in ready", "it's new construction", "it's pending",
// "did you look at the listing?" — and a reply asking for "a quick 5-minute
// call this week" after "the sale closed yesterday". The threads that became
// deals (Brenda, Rigo) started with his own plain texts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "plain-outreach-test-"));

const { listingDistress } = await import("./shared/listing-distress.js");
const { standardText, COUNTY_OPENERS, streetLine, firstNameOf, fillTemplate, NUDGE_TEXTS, CHECKIN_TEXTS, CHECKIN_COLD_TEXTS, LISTING_PING_TEXTS, LISTING_PING_COLD_TEXTS } = await import("./shared/standard-texts.js");
const { normalizeOpener, DEFAULT_OPENER_EXAMPLES, DEFAULT_FOLLOW_UP_TEXTS, DEFAULT_CHECK_IN_TEXTS, PLAIN_DEFAULT_OPENER_EXAMPLES, DEFAULT_HOME, DEFAULT_HOMES } = await import("./shared/outreach-opener.js");
const { normalizeAgentPulse } = await import("./shared/agent-pulse.js");
const { QUALIFY_PASSES, ourReplyPasses, qualifyStep } = await import("./shared/flip-read.js");
const { carrierFlags } = await import("./shared/carrier-words.js");
const { outboundDescriptor, previewProactive } = await import("./reply-agent.js");
const { normalizeOutreachAutopilot, startOutreachSweep, _resetJobs, SCREEN_CURSOR } = await import("./outreach-sweep.js");
const { streetKey } = await import("./comps-zillow.js");
const { store } = await import("./store.js");

const NOW = Date.parse("2026-10-17T18:00:00Z");

/* ---------- the listing says it needs work ---------- */

test("a listing that says it's move-in ready, remodeled or new isn't texted about — 10/16 agents asked 'did you look at the listing?'", () => {
  for (const description of [
    "Beautifully remodeled 3 bed rambler with new kitchen, quartz counters and new roof. Move-in ready!",
    "Turnkey home on a quiet street. Nothing to do but move in.",
    "Brand new construction by a local builder. Builder's warranty included.",
    "Immaculate home with a fully updated kitchen and baths.",
    "Not a fixer! No work needed, the sellers did it all.",
  ]) {
    const r = listingDistress({ status: "FOR_SALE", description, yearBuilt: 1975 }, { now: NOW });
    assert.equal(r.ok, false, description);
    assert.match(r.why, /reads finished/, description);
  }
});

test("a listing that's pending, sold or off the market isn't texted about — 'it's pending', 'the sale closed yesterday'", () => {
  for (const status of ["PENDING", "SOLD", "OFF_MARKET", "RECENTLY_SOLD", "Under contract"]) {
    const r = listingDistress({ status, description: "Fixer upper, bring your tools", yearBuilt: 1950 }, { now: NOW });
    assert.equal(r.ok, false, status);
    assert.match(r.why, /not for sale on Zillow/);
  }
});

test("a house built in the last ten years is new construction, whatever the remarks say", () => {
  const r = listingDistress({ status: "FOR_SALE", description: "Needs some TLC", yearBuilt: 2020 }, { now: NOW });
  assert.deepEqual([r.ok, r.why], [false, "built in 2020"]);
});

test("a listing that says fixer, TLC, as-is or estate sale is the one we text about", () => {
  for (const description of [
    "Fixer upper with great bones. Sold as-is.",
    "Needs some TLC. Bring your vision and your contractor.",
    "Estate sale. Original kitchen, deferred maintenance.",
    "Investor special! Cash or rehab loan only.",
    "Contractor's special in a great neighborhood.",
    // A strong word wins beside a finished one.
    "Kitchen remodeled in 1998; the rest of the house needs work.",
  ]) {
    const r = listingDistress({ status: "FOR_SALE", description, yearBuilt: 1962 }, { now: NOW });
    assert.equal(r.ok, true, description);
    assert.ok(r.signals.length, description);
  }
});

test("a softer word ('dated', 'make it your own') counts only when nothing says the house is finished", () => {
  assert.equal(listingDistress({ status: "FOR_SALE", description: "Dated but solid. Make it your own!" }, { now: NOW }).ok, true);
  assert.equal(listingDistress({ status: "FOR_SALE", description: "Make it your own in this move-in ready home." }, { now: NOW }).ok, false);
  assert.equal(listingDistress({ status: "FOR_SALE", description: "Great for investors or first-time buyers. Updated throughout and move-in ready." }, { now: NOW }).ok, false,
    "'investors' alone doesn't make it a fixer");
});

test("a listing with no remarks, or remarks that say nothing about work, isn't texted about — nothing was checked", () => {
  assert.equal(listingDistress({ status: "FOR_SALE", description: "" }, { now: NOW }).why, "no listing remarks to check");
  assert.match(listingDistress({ status: "FOR_SALE", description: "3 bed 2 bath close to schools and shopping." }, { now: NOW }).why, /nothing in the remarks/);
});

/* ---------- the sweep reads each listing before its agent is texted ---------- */

function sweepFake(rows) {
  return {
    cursors: new Map(),
    async listOutreachAgents() { return rows; },
    async listOutreachPulls() { return []; },
    async getJobCursor(l, n) { return this.cursors.get(`${l}|${n}`) || null; },
    async setJobCursor(l, n, v) { this.cursors.set(`${l}|${n}`, v); return v; },
  };
}
const rows = Array.from({ length: 6 }, (_, i) => ({
  agentKey: `k${i}`, status: "new", contactId: null,
  doc: { name: `k${i}`, phone: `206555070${i}`, distressedCount: 6 - i, distressRule: "cut-or-old", listingCount: 1, hook: { priceCut: true, address: `${100 + i} Main St, Tacoma, WA`, score: 50, price: 400000 }, ghl: {} },
}));
// k0 and k3 read as fixers; k1 is finished, k2 pending, k4 Zillow doesn't have, k5 new.
const zillow = (addresses) => {
  const say = {
    "100 Main St": { status: "FOR_SALE", description: "Fixer upper, sold as-is." },
    "101 Main St": { status: "FOR_SALE", description: "Fully remodeled and move-in ready." },
    "102 Main St": { status: "PENDING", description: "Needs TLC." },
    "103 Main St": { status: "FOR_SALE", description: "Estate sale, needs work throughout." },
    "105 Main St": { status: "FOR_SALE", description: "Needs paint.", yearBuilt: 2022 },
  };
  return new Map(addresses.map((a) => [streetKey(a), say[a.split(",")[0]]]).filter(([, v]) => v));
};
const wait = async (job) => { for (let i = 0; i < 100 && job.status === "running"; i++) await new Promise((r) => setTimeout(r, 5)); };

test("with the listing check on, only agents whose listing says it needs work are texted", async () => {
  _resetJobs();
  let seen = null;
  const asked = [];
  const deps = {
    runPull: async () => ({ batchId: "b1", warnings: [] }),
    importAgents: async (a) => { seen = a; return { results: [], imported: 0 }; },
    screenListings: async ({ addresses }) => { asked.push(...addresses); return zillow(addresses); },
  };
  const fake = sweepFake(rows);
  const job = startOutreachSweep({ locationId: "loc-screen", client: {}, store: fake, deps, now: NOW,
    saved: { outreachAutopilot: { enabled: true, dailyCap: 10, firstTouch: "ghl", distressCheck: { enabled: true } } } });
  await wait(job);
  assert.equal(job.status, "done", job.error);
  assert.deepEqual(seen.agentKeys, ["k0", "k3"]);
  assert.equal(asked.length, 6, "each listing read once");
  assert.equal(job.screen.kept, 2);
  assert.deepEqual(job.screen.dropped, { "reads finished": 1, "pending or sold": 1, "not on Zillow": 1, "new build": 1 });
  assert.ok(job.warnings.some((w) => /listing check: 2 of 6 listings read as needing work/.test(w)), job.warnings.join(" · "));
  const memory = fake.cursors.get(`loc-screen|${SCREEN_CURSOR}`)?.doc?.seen || {};
  assert.equal(Object.keys(memory).length, 6, "what Zillow said is remembered");

  // The next run doesn't pay for the same listings again.
  _resetJobs();
  asked.length = 0;
  const again = startOutreachSweep({ locationId: "loc-screen", client: {}, store: fake, deps, now: NOW + 86400000,
    saved: { outreachAutopilot: { enabled: true, dailyCap: 10, firstTouch: "ghl", distressCheck: { enabled: true } } } });
  await wait(again);
  assert.equal(asked.length, 0);
  assert.deepEqual(seen.agentKeys, ["k0", "k3"]);
  assert.equal(again.screen.remembered, 6);
});

test("when Zillow can't be read, nobody it would have checked is texted that day", async () => {
  _resetJobs();
  let imported = false;
  const deps = {
    runPull: async () => ({ batchId: "b1", warnings: [] }),
    importAgents: async () => { imported = true; return { results: [], imported: 0 }; },
    screenListings: async () => { throw new Error("Zillow listing lookup failed (Apify 502)"); },
  };
  const job = startOutreachSweep({ locationId: "loc-screen-down", client: {}, store: sweepFake(rows), deps, now: NOW,
    saved: { outreachAutopilot: { enabled: true, dailyCap: 10, firstTouch: "ghl", distressCheck: { enabled: true } } } });
  await wait(job);
  assert.equal(job.status, "done", job.error);
  assert.equal(imported, false);
  assert.ok(job.warnings.some((w) => /Apify 502.*wait for the next run/.test(w)), job.warnings.join(" · "));
  assert.ok(job.warnings.includes("no picked listing read as needing work today"));
});

// 2026-10-26 dry run: the listing check left Pierce with 3 of 29 picks and
// some counties with none, and the import was handed an empty list for them —
// "agentKeys required" — so the run errored before anyone was imported.
test("a county whose every pick the listing check drops doesn't stop the day's import", async () => {
  _resetJobs();
  const byCounty = {
    King: [rows[1]],                                     // finished: dropped
    Pierce: [{ ...rows[0], agentKey: "p0", doc: { ...rows[0].doc, phone: "2535550700" } }],   // a fixer: kept
  };
  const calls = [];
  const deps = {
    runPull: async (_l, _c, b) => ({ batchId: `b-${b.county}`, warnings: [], nextOffset: 0 }),
    // As the real import does: an empty list is a bad request.
    importAgents: async (a) => { if (!a.agentKeys.length) throw new Error("agentKeys required"); calls.push(a); return { results: [], imported: a.agentKeys.length }; },
    screenListings: async ({ addresses }) => zillow(addresses),
  };
  const fake = { ...sweepFake([]), async listOutreachAgents(_l, { batchId }) { return byCounty[String(batchId).slice(2)] || []; } };
  const job = startOutreachSweep({ locationId: "loc-screen-empty", client: {}, store: fake, deps, now: NOW,
    saved: { outreachAutopilot: { enabled: true, dailyCap: 0, firstTouch: "ghl", counties: ["King, WA", "Pierce, WA"], distressCheck: { enabled: true } } } });
  await wait(job);
  assert.equal(job.status, "done", job.error);
  assert.deepEqual(calls.map((c) => [c.batchId, c.agentKeys]), [["b-Pierce", ["p0"]]]);
});

test("the listing check stops reading once the day has its agents, and leaves the rest for the next run", async () => {
  _resetJobs();
  const many = Array.from({ length: 90 }, (_, i) => ({ ...rows[0], agentKey: `m${i}`,
    doc: { ...rows[0].doc, name: `m${i}`, phone: `20655590${String(i).padStart(2, "0")}`, distressedCount: 90 - i, hook: { ...rows[0].doc.hook, address: `${1000 + i} Elm St, Tacoma, WA` } } }));
  let looked = 0;
  const deps = {
    runPull: async () => ({ batchId: "b1", warnings: [] }),
    importAgents: async () => ({ results: [], imported: 0 }),
    screenListings: async ({ addresses }) => { looked += addresses.length; return new Map(addresses.map((a) => [streetKey(a), { status: "FOR_SALE", description: "Fixer, needs work." }])); },
  };
  const job = startOutreachSweep({ locationId: "loc-screen-enough", client: {}, store: sweepFake(many), deps, now: NOW,
    saved: { outreachAutopilot: { enabled: true, dailyCap: 10, firstTouch: "ghl", distressCheck: { enabled: true } } } });
  await wait(job);
  assert.equal(looked, 40, "one actor run's worth covers 10 a day with room over");
  assert.equal(job.screen.waiting, 50);
});

test("the listing check is off unless it's switched on, and its lookups a run are capped", () => {
  assert.equal(normalizeOutreachAutopilot({}).distressCheck.enabled, false);
  assert.equal(normalizeOutreachAutopilot({ distressCheck: { enabled: true } }).distressCheck.perRun, 200);
  assert.equal(normalizeOutreachAutopilot({ distressCheck: { enabled: true, perRun: 5000 } }).distressCheck.perRun, 600);
});

/* ---------- the first text is Matt's own ---------- */

test("the first text is one of Matt's own, filled in: the listing's street address, is it a project, and their other fixers", async () => {
  let modelCalls = 0;
  const saved = { aiApiKey: "test-key", conversationAi: { enabled: true, persona: { name: "Matt" } } };
  const r = await previewProactive({ client: { call: async () => ({}) }, locationId: "loc-plain-open", saved, store, contactId: "", kind: "outreach_open", name: "Brenda",
    subject: { address: "14820 Se 172nd St, Renton, WA 98058", county: "King", city: "Renton", variant: 0 },
    deps: { draft: async () => { modelCalls++; return { reply: "something creative", summary: "s", confidence: "high" }; } } });
  assert.equal(modelCalls, 0, "no model call");
  assert.equal(r.reply, "Hi Brenda, saw your listing at 14820 SE 172nd St. I'm local and fix up houses. Is it a bit of a project, or pretty turnkey? If you've got other fixers on your radar, I'm all ears.");
  assert.equal(r.held, false, r.flags?.join(" · "));
});

test("every first text, follow-up and check-in is short, plain, and has none of the words the carriers block", () => {
  const values = { first: "Christopher", address: "14820 SE 172nd St", street: "SE 172nd St", town: "Renton", county: "King" };
  for (const t of [...DEFAULT_OPENER_EXAMPLES, ...NUDGE_TEXTS, ...DEFAULT_CHECK_IN_TEXTS, ...CHECKIN_TEXTS, ...CHECKIN_COLD_TEXTS, ...LISTING_PING_TEXTS, ...LISTING_PING_COLD_TEXTS]) {
    const text = fillTemplate(t, values);
    assert.ok(text.length <= 200, `${text.length}: ${text}`);
    assert.deepEqual(carrierFlags(text), [], text);
    assert.doesNotMatch(text, /[—–!$]|5-minute|what time works|\bcall\b/i, text);
  }
  for (const t of DEFAULT_OPENER_EXAMPLES) assert.match(t, /\{address\}/, "names the listing like Brenda's text did");
  for (const t of DEFAULT_OPENER_EXAMPLES) assert.match(t, /other fixers/, "asks for their other fixers");
});

// Since 2026-10-26 a saved copy of the 10/16 examples is kept: they had the
// fewest STOPs of the fixed first texts (fewer-stops.test.mjs).
test("Settings' saved copy of the 10/16 model examples is kept as Matt's texts, and 'ai' still has the model write them", () => {
  assert.deepEqual(normalizeOpener({ examples: PLAIN_DEFAULT_OPENER_EXAMPLES }), { examples: PLAIN_DEFAULT_OPENER_EXAMPLES, followUps: DEFAULT_FOLLOW_UP_TEXTS, checkIns: DEFAULT_CHECK_IN_TEXTS, mode: "template", home: DEFAULT_HOME, homes: DEFAULT_HOMES });
  assert.equal(normalizeOpener({ mode: "ai" }).mode, "ai");
  const o = outboundDescriptor({ kind: "outreach_open", offer: null, saved: { outreachAutopilot: { opener: { mode: "ai" } } }, subject: { address: "1 Elm St, Kent, WA" } });
  assert.equal(standardText({ kind: "outreach_open", outbound: o, name: "Dana" }), null);
  assert.deepEqual(o.examples, PLAIN_DEFAULT_OPENER_EXAMPLES, "the model writes in the 10/16 voice its rules were written for");
  const mine = ["Hi {first}, my own text about {street}?"];
  assert.deepEqual(outboundDescriptor({ kind: "outreach_open", offer: null, saved: { outreachAutopilot: { opener: { mode: "ai", examples: mine } } }, subject: { address: "1 Elm St" } }).examples, mine);
});

test("a first text with no first name still reads like a person wrote it", () => {
  const s = standardText({ kind: "outreach_open", outbound: { mode: "template", address: "12 Elm St, Kent, WA", templates: DEFAULT_OPENER_EXAMPLES, variant: 1 }, name: "" });
  assert.match(s.text, /^Hi, came across your listing at 12 Elm St\./);
  assert.equal(firstNameOf("brenda smith"), "Brenda");
  assert.equal(streetLine("8221 S 121st St Unit 4, Seattle, WA"), "8221 S 121st St");
});

test("a turnkey seat is still written by the model, since Matt's texts ask whether it's a project", () => {
  assert.equal(standardText({ kind: "outreach_open", outbound: { mode: "template", address: "1 Elm St", templates: DEFAULT_OPENER_EXAMPLES, turnkey: true }, name: "Dana" }), null);
});

/* ---------- the follow-up and the check-in ---------- */

test("the 14-day follow-up is Rigo's two-week text, about the same listing", () => {
  const o = outboundDescriptor({ kind: "outreach_nudge", offer: null, saved: {}, subject: { address: "2210 Pine Ave, Seattle, WA" } });
  assert.equal(o.mode, "template");
  const s = standardText({ kind: "outreach_nudge", outbound: o, name: "Rigo Smith", contactId: "c-rigo" });
  assert.ok(NUDGE_TEXTS.map((t) => fillTemplate(t, { first: "Rigo", address: "2210 Pine Ave" })).includes(s.text), s.text);
  assert.equal(standardText({ kind: "outreach_nudge", outbound: o, name: "Rigo", contactId: "c-rigo" }).text, s.text, "the same agent always gets the same one");
});

test("the plain check-in asks for their fixers in a line, and one who never wrote back hears who we are", () => {
  const pulse = (subject) => outboundDescriptor({ kind: "agent_pulse", offer: null, saved: {}, subject: { reason: "general", variant: 0, ...subject } });
  assert.equal(normalizeAgentPulse({}).mode, "template");
  assert.equal(standardText({ kind: "agent_pulse", outbound: pulse({ segment: "engaged" }), name: "Rigo" }).text,
    "Hi Rigo, circling back. Any fixers or distressed properties come across your desk lately?");
  assert.match(standardText({ kind: "agent_pulse", outbound: pulse({ segment: "cold" }), name: "Rigo" }).text, /^Hi Rigo, it's Matt, I fix up houses locally\./);
});

// 2026-10-21: "saw your listing on <number> <street>. Is it a bit of a
// project?" went to an agent we'd checked in with a week before, who said
// Stop. Matt: a general check-in that names the listing in passing.
test("a check-in when their listing comes up asks about their other distressed properties, not that house, and drops the house number", () => {
  const pulse = (subject) => outboundDescriptor({ kind: "agent_pulse", offer: null, saved: {}, subject: { reason: "fresh_listing", listing: { street: "4521 18th Ave Ct NW" }, ...subject } });
  for (let variant = 0; variant < LISTING_PING_TEXTS.length; variant++) {
    for (const segment of ["engaged", "cold"]) {
      const t = standardText({ kind: "agent_pulse", outbound: pulse({ segment, variant }), name: "Pete" }).text;
      assert.match(t, /^(Hi|Hey) Pete, /, t);
      assert.match(t, /listing on 18th Ave Ct NW/, t);
      assert.doesNotMatch(t, /4521/, t);
      assert.match(t, /(doesn't look like|not sure it needs enough work|probably not one for us)/i, t);
      assert.match(t, /(other distressed|anything distressed|other fixers|anything on your plate that needs work)/i, t);
      assert.doesNotMatch(t, /bit of a project|turnkey|does it need much work/i, t);
    }
  }
  assert.match(standardText({ kind: "agent_pulse", outbound: pulse({ segment: "cold", variant: 0 }), name: "Pete" }).text, /it's Matt, I fix up houses locally/, "one who never wrote back hears who we are");
  assert.equal(standardText({ kind: "agent_pulse", outbound: pulse({ segment: "engaged", variant: 0 }), name: "Pete" }).text,
    "Hey Pete, saw your listing on 18th Ave Ct NW, doesn't look like a fixer. Just wanted to check in, any other distressed properties on your plate?");
});

// 2026-10-26 (Pierce): a cold agent's distressed listing that has been up a
// while, read on Zillow as needing work, is the first text they've had from
// us about it — "doesn't look like a fixer" would read as if we never looked.
test("a focus ping on a cold Pierce agent's listing reads like Pierce's first text, not 'doesn't look like a fixer'", () => {
  const subject = { reason: "fresh_listing", segment: "cold", address: "4521 18th Ave Ct NW, Tacoma, WA 98406",
    listing: { street: "4521 18th Ave Ct NW", city: "Tacoma", county: "Pierce", state: "WA", focus: true } };
  for (let variant = 0; variant < COUNTY_OPENERS.pierce.length; variant++) {
    const r = standardText({ kind: "agent_pulse", outbound: outboundDescriptor({ kind: "agent_pulse", offer: null, saved: {}, subject: { ...subject, variant } }), name: "Pete" });
    assert.equal(r.set, "county_opener");
    assert.match(r.text, /^(Hi|Hey) Pete, /, r.text);
    assert.match(r.text, /listing on 18th Ave Ct NW/, r.text);
    assert.doesNotMatch(r.text, /doesn't look like|probably not one for us|not sure it needs enough work/i, r.text);
  }
  // A focus county with no texts of its own uses Matt's saved first text.
  const saved = { outreachAutopilot: { opener: { examples: ["Hi {first}, it's Matt. Saw {address} in {town}, is it a project?"] } } };
  const kitsap = { ...subject, address: "12 Elm St, Bremerton, WA 98310", listing: { street: "12 Elm St", city: "Bremerton", county: "Kitsap", state: "WA", focus: true } };
  const mine = standardText({ kind: "agent_pulse", outbound: outboundDescriptor({ kind: "agent_pulse", offer: null, saved, subject: { ...kitsap, variant: 0 } }), name: "Pete" });
  assert.equal(mine.text, "Hi Pete, it's Matt. Saw 12 Elm St in Bremerton, is it a project?");
  // Without the focus flag a listing ping is the plain one, as before.
  const plain = standardText({ kind: "agent_pulse", outbound: outboundDescriptor({ kind: "agent_pulse", offer: null, saved: {}, subject: { ...subject, variant: 0, listing: { ...subject.listing, focus: undefined } } }), name: "Pete" });
  assert.equal(plain.set, "listing_cold");
});

// 2026-10-26, Matt: "switch the wording slightly only for pierce". The saved
// first text says "I'm in Seattle" and asks "a bit of a project, or pretty
// turnkey?" — the 3.4% STOP text. Pierce listings get their own; King keeps it.
test("a new Pierce agent's first text is Pierce's own, and a King agent's is still the saved one", () => {
  const saved = { outreachAutopilot: { opener: { examples: ["Hi {first}, came across your listing at {address}. I'm in Seattle and looking for my next flip project around {town}. Is this one a bit of a project, or pretty turnkey?"] } } };
  const open = (county, city, address) => standardText({ kind: "outreach_open", name: "Robin Agent",
    outbound: { ...outboundDescriptor({ kind: "outreach_open", offer: null, saved, subject: { address, county, city, house: { address, county, city } } }), variant: 0 } });
  const pierce = open("Pierce", "Tacoma", "5232 S Yakima Ave, Tacoma, WA 98408");
  assert.equal(pierce.set, "county_opener");
  assert.equal(pierce.text, "Hi Robin, saw your listing on S Yakima Ave in Tacoma. I fix up older houses around Pierce County. Does it need much work?");
  assert.doesNotMatch(pierce.text, /Seattle|turnkey/);
  const king = open("King", "Kent", "9 Oak St, Kent, WA 98031");
  assert.equal(king.set, "opener");
  assert.match(king.text, /I'm in Seattle/);
  for (const t of COUNTY_OPENERS.pierce) {
    assert.ok(t.length <= 140, t);
    assert.deepEqual(carrierFlags(t), [], t);
    assert.equal((t.match(/\?/g) || []).length, 1, `one question: ${t}`);
  }
});

test("a check-in with something real to say — a house they mentioned, a deal we closed, Matt's 15 — is still written for them", () => {
  const pulse = (subject) => outboundDescriptor({ kind: "agent_pulse", offer: null, saved: {}, subject: { reason: "general", ...subject } });
  for (const subject of [{ hook: { kind: "mentioned", street: "Birch St" } }, { reason: "deal_thanks" }, { forMatt: true }, { reason: "off_market_listing", listing: { street: "Elm" } }]) {
    assert.equal(standardText({ kind: "agent_pulse", outbound: pulse(subject), name: "Dana" }), null, JSON.stringify(subject));
  }
  assert.equal(standardText({ kind: "agent_pulse", outbound: outboundDescriptor({ kind: "agent_pulse", offer: null, saved: { outreachAutopilot: { pulse: { mode: "ai" } } }, subject: {} }), name: "Dana" }), null);
});

/* ---------- the answer to their first answer ---------- */

test("when the house is too nice, the pass is a thanks and their other fixers — no list of what we buy, no 'parent moving into care'", () => {
  for (const p of QUALIFY_PASSES) {
    assert.ok(p.length <= 160, p);
    assert.equal(ourReplyPasses(p), true, p);
    assert.match(p, /off-market/, p);
    assert.doesNotMatch(p, /single-family|estate|into care|move by a date|call/i, p);
  }
  assert.ok(QUALIFY_PASSES.includes(qualifyStep({ words: "It's move in ready" }).reply));
});
