// app-first-text.test.mjs — the app writes the first text to a new listing
// agent, not the GHL workflow (Matt, 2026-10-04).
//
// The workflow sent every agent the same template: "I'm in Seattle and
// looking for my next flip project anywhere in greater Seatac" — to Pierce
// and Snohomish agents too. The bot writes each one in Matt's voice and
// names only the county the listing is in. GHL puts "No worries if not can
// stop lmk" on the end itself, so the bot never writes a sign-off.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "app-first-text-test-"));
process.env.OUTREACH_IMPORTS_ENABLED = "true";

const { outboundOpening } = await import("./conversation-prompt.js");
const { outboundDescriptor, humanHasThread } = await import("./reply-agent.js");
const { normalizeOpener, countyName, openerVariant, DEFAULT_OPENER_EXAMPLES } = await import("./shared/outreach-opener.js");
const { normalizeOutreachAutopilot, startOutreachSweep, _resetJobs } = await import("./outreach-sweep.js");
const { store } = await import("./store.js");
const { default: createOutreachRouter } = await import("./routes/outreach.js");

// What the bot is told to write, without the carrier rule's list of words.
const ask = (o) => outboundOpening({ kind: "outreach_open", address: "1911 9th Ave W, Seattle, WA 98119", ...o });

/* ---------- the prompt ---------- */

test("the first text names the county the listing is in and nowhere else — the workflow said 'greater Seatac' to every agent", () => {
  const t = ask({ county: "Pierce", examples: DEFAULT_OPENER_EXAMPLES });
  assert.match(t, /anywhere in Pierce County/);
  assert.match(t, /Pierce County is the only place you name/);
  assert.match(t, /on 1911 9th Ave W/, "the listing by street");
  assert.doesNotMatch(t.replace(/no region \([^)]*\)/, ""), /Seatac|King County|Snohomish/i);
});

test("the first text never writes its own sign-off, because GHL adds 'No worries if not can stop lmk'", () => {
  const t = ask({ county: "King", examples: DEFAULT_OPENER_EXAMPLES });
  assert.match(t, /NO sign-off/);
  assert.match(t, /no opt-out line/);
  assert.match(t, /adds "No worries if not can stop lmk" on the end by itself/);
  assert.match(t, /under 280 characters/);
});

test("the first text is written in Matt's voice: his examples are in the prompt, and another agent leads with another one", () => {
  const examples = ["one {county}", "two {county}", "three {county}"];
  const a = ask({ county: "King", examples, variant: 0 });
  const b = ask({ county: "King", examples, variant: 1 });
  assert.match(a, /HOW MATT WRITES THESE[^:]*: "one \{county\}" \/ "two \{county\}" \/ "three \{county\}"/);
  assert.match(b, /HOW MATT WRITES THESE[^:]*: "two \{county\}"/);
  assert.match(a, /never copy one word for word/);
});

test("a hundred agents a day don't all get Matt's template word for word — the first five live samples were the same text", () => {
  const t = ask({ county: "King", examples: ["Yo {first}, {street} in {county}?"], variant: 0 });
  const rules = t.split("HOW MATT WRITES")[0];
  assert.doesNotMatch(rules, /came across|pretty turnkey|all ears/i, "the instructions don't dictate one example's wording");
  assert.match(t, /OPEN THE WAY THE FIRST ONE OPENS/);
  assert.match(t, /no two should read the same/);
});

test("the first text doesn't read like AI: no dashes, no exclamation marks, no 'reaching out'", () => {
  const t = ask({ county: "King", examples: DEFAULT_OPENER_EXAMPLES });
  assert.match(t, /no dashes/);
  assert.match(t, /no exclamation marks/);
  assert.match(t, /"I'm reaching out"/);
});

test("with no county on the listing, the first text names no place at all", () => {
  const t = ask({ examples: DEFAULT_OPENER_EXAMPLES });
  assert.match(t, /anywhere in the area/);
  assert.match(t, /Name no county or region/);
});

test("the follow-up to a first text that got no answer names the same county", () => {
  const t = outboundOpening({ kind: "outreach_nudge", address: "12 Elm St, Tacoma, WA", county: "Pierce" });
  assert.match(t, /it's Pierce County and nowhere else/);
  assert.match(t, /No sign-off and no opt-out line/);
  assert.doesNotMatch(outboundOpening({ kind: "outreach_nudge", address: "12 Elm St, Tacoma, WA" }), /County and nowhere else/);
});

test("the reply agent hands the prompt the listing's county and Matt's saved examples", () => {
  const saved = { outreachAutopilot: { opener: { examples: ["Hi {first}, {street} in {county}?"] } } };
  const o = outboundDescriptor({ kind: "outreach_open", offer: null, saved,
    subject: { address: "12 Elm St, Tacoma, WA", hookDom: 80, county: "Pierce County", city: "Tacoma", variant: 7 } });
  assert.equal(o.county, "Pierce");
  assert.deepEqual(o.examples, ["Hi {first}, {street} in {county}?"]);
  assert.equal(o.variant, 7);
  assert.deepEqual(outboundDescriptor({ kind: "outreach_open", offer: null, saved: {}, subject: { address: "x" } }).examples, DEFAULT_OPENER_EXAMPLES);
  const nudge = outboundDescriptor({ kind: "outreach_nudge", offer: null, saved: {}, subject: { address: "x", county: "King" } });
  assert.equal(nudge.county, "King");
});

/* ---------- the examples ---------- */

test("an opener example carrying the stop line is dropped, so the agent never gets it twice", () => {
  const o = normalizeOpener({ examples: ["Hi {first}, saw {street}. No worries if not can stop lmk", "Hey {first}, {street} a project?"] });
  assert.deepEqual(o.examples, ["Hey {first}, {street} a project?"]);
  assert.deepEqual(normalizeOpener({}).examples, DEFAULT_OPENER_EXAMPLES, "unset is Matt's defaults");
  assert.deepEqual(normalizeOpener({ examples: "one\n\ntwo" }).examples, ["one", "two"], "the Settings box splits on blank lines");
  assert.ok(DEFAULT_OPENER_EXAMPLES.every((x) => !/can stop/i.test(x) && /\{county\} County/.test(x)));
  assert.deepEqual(normalizeOutreachAutopilot({}).opener.examples, DEFAULT_OPENER_EXAMPLES, "kept on the outreach settings");
});

test("the county reads the same from RentCast or from the sweep's county key", () => {
  assert.equal(countyName("King"), "King");
  assert.equal(countyName("Snohomish County"), "Snohomish");
  assert.equal(countyName("", "Pierce, WA"), "Pierce");
  assert.equal(countyName("", null), "");
  assert.equal(openerVariant("c-1", 4), openerVariant("c-1", 4), "the same agent, the same lead example");
});

/* ---------- a reply to it ---------- */

test("an agent who answers the app's first text within minutes gets an answer, even with GHL's stop line on what we sent", async () => {
  const stamp = new Date(Date.now() - 4 * 60000).toISOString().slice(0, 16).replace("T", " ");
  const ours = "Hey Dana, 1911 9th Ave W caught my eye. I'm looking for a flip anywhere in King County right now. Is that one a bit of a project?";
  const sent = { listReplyDrafts: async () => [{ id: "d1", contactId: "c1", status: "sent", sentText: ours }] };
  for (const footer of ["No worries if not can stop lmk", "Reply STOP to end"]) {
    const transcript = `[${stamp}] US sms: ${ours} ${footer}\n[${stamp}] THEM sms: Yes it needs a full remodel`;
    assert.equal(await humanHasThread({ store: sent, locationId: "LOC", contactId: "c1", transcript, minutes: 30 }), null, footer);
  }
});

/* ---------- the import ---------- */

await store.init();
const LOC = "loc-first-text";

let made = 0;
function ghlClient() {
  return {
    async call(pathname, opts = {}) {
      const method = opts.method || "GET";
      if (/\/customFields$/.test(pathname)) return method === "POST" ? { customField: { id: `f-${opts.body?.name}`, fieldKey: `contact.${opts.body?.name}` } } : { customFields: [] };
      if (/\/contacts\/search\/duplicate/.test(pathname)) return { contact: null };
      if (method === "POST" && pathname === "/contacts/") return { contact: { id: `c-new-${++made}` } };
      return {};
    },
  };
}

async function batchWith(name, agents) {
  const batch = await store.createOutreachBatch(LOC, { name, autoNamed: false });
  await store.upsertOutreachAgents(LOC, batch.id, agents.map((a, i) => ({
    agentKey: a.key, doc: { name: a.key, firstName: a.key, phone: `20655531${String(i).padStart(2, "0")}`, brokerage: "Test Realty", hook: a.hook, ghl: {} },
  })));
  return batch;
}

test("the first text knows the county the listing is in, or the county the sweep was reading", async () => {
  const seen = [];
  const router = createOutreachRouter({ resolveLocation: () => ({ locationId: LOC, client: ghlClient() }),
    firstTouch: async (a) => { seen.push(a.hook); return { job: { id: `j${seen.length}` } }; } });
  const batch = await batchWith("Autopilot · Pierce, WA", [
    { key: "own", hook: { address: "12 Elm St, Tacoma, WA", price: 400000, dom: 90, county: "Pierce", city: "Tacoma" } },
    { key: "old", hook: { address: "14 Elm St, Tacoma, WA", price: 410000, dom: 70 } },
  ]);
  const r = await router.importAgents({ locationId: LOC, client: ghlClient(), agentKeys: ["own", "old"], batchId: batch.id,
    dryRun: false, applyTag: false, openWith: "app", county: "Pierce, WA" });
  assert.equal(r.opened, 2);
  assert.deepEqual(seen.map((h) => h.county), ["Pierce", "Pierce"]);
  assert.equal(seen[0].city, "Tacoma");
  assert.equal(seen[0].brokerage, "Test Realty");
});

test("an agent created in GHL whose first text didn't go is texted on the next run, not lost", async () => {
  let refuse = true;
  const asked = [];
  const router = createOutreachRouter({ resolveLocation: () => ({ locationId: LOC, client: ghlClient() }),
    firstTouch: async (a) => { asked.push(a); return refuse ? { skipped: "the rest of today's drafts are kept for people who text us" } : { job: { id: "j-ok" } }; } });
  const batch = await batchWith("Autopilot · King, WA", [{ key: "capped", hook: { address: "9 Cold Creek Rd, Kent, WA", price: 500000, dom: 60, county: "King" } }]);
  const r = await router.importAgents({ locationId: LOC, client: ghlClient(), agentKeys: ["capped"], batchId: batch.id, dryRun: false, applyTag: false, openWith: "app" });
  const contactId = r.results[0].contactId;
  assert.match(r.results[0].opened.skipped, /kept for people/);
  const skips = await store.listContactEvents(LOC, contactId, { types: ["outreach_open_skipped"] });
  assert.equal(skips.length, 1);
  assert.equal(skips[0].data.hook.county, "King");

  refuse = false;
  const again = await router.retryFirstTexts({ locationId: LOC, client: ghlClient() });
  assert.equal(again.opened, 1);
  assert.equal(asked.at(-1).contactId, contactId);
  assert.equal(asked.at(-1).hook.address, "9 Cold Creek Rd, Kent, WA");
});

test("a first text is tried three times in all, and never again once it went", async () => {
  const asked = [];
  const router = createOutreachRouter({ resolveLocation: () => ({ locationId: LOC, client: ghlClient() }),
    firstTouch: async (a) => { asked.push(a.contactId); return { skipped: "no" }; } });
  const batch = await batchWith("Autopilot · Snohomish, WA", [{ key: "stuck", hook: { address: "3 Oak Ave, Everett, WA", county: "Snohomish" } }]);
  const r = await router.importAgents({ locationId: LOC, client: ghlClient(), agentKeys: ["stuck"], batchId: batch.id, dryRun: false, applyTag: false, openWith: "app" });
  const contactId = r.results[0].contactId;
  await router.retryFirstTexts({ locationId: LOC, client: ghlClient() });
  await router.retryFirstTexts({ locationId: LOC, client: ghlClient() });
  await router.retryFirstTexts({ locationId: LOC, client: ghlClient() });
  assert.equal(asked.filter((c) => c === contactId).length, 3, "the import, then two retries");

  // Someone else's skip, then the text going, ends theirs.
  const batch2 = await batchWith("Autopilot · Kitsap, WA", [{ key: "went", hook: { address: "5 Bay St, Bremerton, WA", county: "Kitsap" } }]);
  const r2 = await router.importAgents({ locationId: LOC, client: ghlClient(), agentKeys: ["went"], batchId: batch2.id, dryRun: false, applyTag: false, openWith: "app" });
  await store.appendContactEvents(LOC, r2.results[0].contactId, [{ type: "outreach_sent", party: "agent", at: new Date().toISOString(), data: {}, dedupeKey: "sent-went" }]);
  const before = asked.length;
  await router.retryFirstTexts({ locationId: LOC, client: ghlClient() });
  assert.equal(asked.slice(before).includes(r2.results[0].contactId), false);
});

test("a first text whose draft failed on its lane is written down to try again", async () => {
  let settle;
  const router = createOutreachRouter({ resolveLocation: () => ({ locationId: LOC, client: ghlClient() }),
    firstTouch: async (a) => { settle = a.onSettled; return { job: { id: "j-lane" } }; } });
  const batch = await batchWith("Autopilot · Thurston, WA", [{ key: "lane", hook: { address: "8 Pine St, Olympia, WA", county: "Thurston" } }]);
  const r = await router.importAgents({ locationId: LOC, client: ghlClient(), agentKeys: ["lane"], batchId: batch.id, dryRun: false, applyTag: false, openWith: "app" });
  settle({ status: "error", error: "model overloaded" });
  await new Promise((res) => setTimeout(res, 20));
  const skips = await store.listContactEvents(LOC, r.results[0].contactId, { types: ["outreach_open_skipped"] });
  assert.equal(skips.length, 1);
  assert.equal(skips[0].data.reason, "model overloaded");
  // A held draft that exists is in the outbox for a person — not lost.
  settle({ status: "held", draftId: "d9", heldReason: "a person's call" });
  await new Promise((res) => setTimeout(res, 20));
  assert.equal((await store.listContactEvents(LOC, r.results[0].contactId, { types: ["outreach_open_skipped"] })).length, 1);
});

/* ---------- the sweep ---------- */

function sweepFake(rows) {
  return {
    cursors: new Map(),
    async listOutreachAgents() { return rows; },
    async listOutreachPulls() { return []; },
    async getJobCursor(l, n) { return this.cursors.get(`${l}|${n}`) || null; },
    async setJobCursor(l, n, v) { this.cursors.set(`${l}|${n}`, v); return v; },
  };
}
const ranked = Array.from({ length: 12 }, (_, i) => ({
  agentKey: `k${i}`, status: "new", contactId: null,
  doc: { name: `k${i}`, phone: `206555040${String(i).padStart(2, "0")}`, distressedCount: 12 - i, distressRule: "cut-or-cheap", listingCount: 1, hook: { address: `${i} St`, score: 50, price: 400000 }, ghl: {} },
}));

test("with room for 5 more machine texts today, the sweep creates 5 agents, not 100 it can't text", async () => {
  _resetJobs();
  let seen = null;
  let retriedWith = null;
  const deps = {
    runPull: async () => ({ batchId: "b1", warnings: [] }),
    importAgents: async (a) => { seen = a; return { results: [], imported: 0 }; },
    firstTextRoom: async () => 7,
    retryFirstTexts: async ({ limit }) => { retriedWith = limit; return { retried: 2, opened: 2 }; },
  };
  const job = startOutreachSweep({ locationId: "loc-room", client: {}, store: sweepFake(ranked), deps,
    saved: { outreachAutopilot: { enabled: true, dailyCap: 100, firstTouch: "app" } } });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(job.status, "done", job.error);
  assert.equal(retriedWith, 7, "yesterday's first texts that didn't go are tried first");
  assert.equal(job.retried, 2);
  assert.equal(seen.createLimit, 5, "the day's number comes down to the room that's left");
  assert.equal(seen.openWith, "app");
  assert.equal(seen.enrollWorkflowId, null, "nobody goes into a GHL workflow");
  assert.ok(job.warnings.some((w) => /room for 5 first texts today/.test(w)), job.warnings.join(" · "));
});

test("with no room left today, the sweep doesn't pull or create anyone", async () => {
  _resetJobs();
  let pulled = false;
  const deps = {
    runPull: async () => { pulled = true; return { batchId: "b1", warnings: [] }; },
    importAgents: async () => { throw new Error("should not import"); },
    firstTextRoom: async () => 0,
    retryFirstTexts: async () => { throw new Error("no room to retry either"); },
  };
  const job = startOutreachSweep({ locationId: "loc-full", client: {}, store: sweepFake(ranked), deps,
    saved: { outreachAutopilot: { enabled: true, dailyCap: 100, firstTouch: "app" } } });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(job.status, "done", job.error);
  assert.equal(pulled, false, "no RentCast request spent on a day with no room");
});

test("a dry run reads the room but texts nobody", async () => {
  _resetJobs();
  let retried = false;
  let seen = null;
  const deps = {
    runPull: async () => ({ batchId: "b1", warnings: [] }),
    importAgents: async (a) => { seen = a; return { results: [], dryRun: true }; },
    firstTextRoom: async () => 3,
    retryFirstTexts: async () => { retried = true; return { retried: 0 }; },
  };
  startOutreachSweep({ locationId: "loc-dry", client: {}, store: sweepFake(ranked), deps, dryRun: true,
    saved: { outreachAutopilot: { enabled: true, dailyCap: 100, firstTouch: "app" } } });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(retried, false);
  assert.equal(seen.createLimit, 3);
});
