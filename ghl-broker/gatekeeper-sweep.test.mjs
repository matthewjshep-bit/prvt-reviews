// gatekeeper-sweep.test.mjs — the gatekeeper line's day: off until switched
// on, the email first and the text only after it went, every note a draft
// for Matt unless he lets them go, and a reply from a gatekeeper never
// answered by the bot. Names are made up.
//
//   node --test gatekeeper-sweep.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gatekeeper-sweep-test-"));
process.env.DATA_DIR = DIR;
delete process.env.DATABASE_URL;

const { store } = await import("./store.js");
const { recordEvent } = await import("./contact-record.js");
const { runGatekeeperSweep, maybeRunGatekeeperSweep, getGatekeeperJob, _resetJobs, CURSOR_NAME } = await import("./gatekeeper-sweep.js");
const { handsOffReason } = await import("./reply-agent.js");
await store.init();
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const DAY = 86400000;
// Tuesday 2026-11-03, 9:05am Pacific.
const T0 = Date.parse("2026-11-03T17:05:00Z");
const ON = (over = {}) => ({ aiApiKey: "k", conversationAi: { enabled: true }, company: { name: "Shep Flips", signer: "Matt Shepherd", phone: "425-555-0100" },
  outreachAutopilot: { gatekeepers: { enabled: true, dryRun: false, ...over } } });

const contacts = {
  "c-paul": { id: "c-paul", email: "paul@counsel.test", phone: "+12065550142" },
  "c-noemail": { id: "c-noemail", phone: "+14255550101" },
};
const writes = [];
const write = async ({ step, gk, hook }) => {
  writes.push({ step, gkKey: gk.gkKey, hookKey: hook?.hookKey });
  return step === "text"
    ? { body: `${gk.firstName}, Matt Shepherd here. Emailed you about the Elm St house. Quick call this week?`, flags: [] }
    : { subject: "Estate of Harold Example, 1234 Elm St", body: `Hi ${gk.firstName},\n\nMatt Shepherd here…`, flags: [] };
};
const deps = { write, getContact: async (id) => contacts[id] || null };

async function seed(LOC) {
  await store.upsertGatekeepers(LOC, [
    { gkKey: "wsba:40123", kind: "probate_attorney", doc: { name: "Paul Counsel", firstName: "Paul", firm: "Counsel Law PLLC", email: "paul@counsel.test", phone: "2065550142" } },
    { gkKey: "p:4255550101", kind: "title", doc: { name: "Kim Rep", firstName: "Kim", firm: "Example Title", phone: "4255550101" } },
  ]);
  await store.setGatekeeperStatus(LOC, "wsba:40123", { status: "imported", contactId: "c-paul", importedAt: new Date(T0 - DAY).toISOString() });
  await store.setGatekeeperStatus(LOC, "p:4255550101", { status: "imported", contactId: "c-noemail", importedAt: new Date(T0 - DAY).toISOString() });
  await store.upsertGatekeeperHooks(LOC, [{ hookKey: "probate:king:25-4-07311-2-sea", gkKey: "wsba:40123", kind: "estate",
    doc: { decedent: "Harold Example", county: "King", caseNo: "25-4-07311-2 SEA", firstPublished: "2026-10-20", house: { address: "1234 Elm St, Kent, WA 98032" } } }]);
  for (const [contactId, gkKey] of [["c-paul", "wsba:40123"], ["c-noemail", "p:4255550101"]]) {
    await recordEvent({ store, locationId: LOC, contactId, party: "gatekeeper", type: "import", at: new Date(T0 - DAY).toISOString(), source: "gatekeeper-import", ref: `gatekeeper:${gkKey}`, dedupeKey: `import:${contactId}` });
  }
}

test("the sweep is off until switched on, and off on a weekend", async () => {
  _resetJobs();
  assert.equal(await maybeRunGatekeeperSweep({ locationId: "loc-off", saved: {}, store, now: T0 }), false);
  const sat = Date.parse("2026-11-07T17:05:00Z");
  assert.equal(await maybeRunGatekeeperSweep({ locationId: "loc-off", saved: ON(), store, now: sat }), false);
});

test("switched on, it runs once a weekday morning and writes the cursor before it runs", async () => {
  _resetJobs();
  const LOC = "loc-gate";
  assert.equal(await maybeRunGatekeeperSweep({ locationId: LOC, saved: ON({ dryRun: true }), store, deps, now: T0 - 3600000 }), false, "8am: not yet");
  assert.equal(await maybeRunGatekeeperSweep({ locationId: LOC, saved: ON({ dryRun: true }), store, deps, now: T0 }), true);
  const cur = await store.getJobCursor(LOC, CURSOR_NAME);
  assert.ok(cur.doc.lastDaily);
  await getGatekeeperJob(LOC).done;
  assert.equal(await maybeRunGatekeeperSweep({ locationId: LOC, saved: ON({ dryRun: true }), store, deps, now: T0 + 3600000 }), false, "once a day");
});

test("a dry run says what it would write and writes nothing", async () => {
  const LOC = "loc-dry";
  await seed(LOC);
  writes.length = 0;
  const r = await runGatekeeperSweep({ locationId: LOC, saved: ON({ dryRun: true }), store, deps, now: T0 });
  assert.equal(r.dryRun, true);
  assert.equal(r.steps.would, 2);
  assert.deepEqual(r.rows.map((x) => x.would).sort(), ["email", "text"], "no email on file: the text goes alone");
  assert.equal(writes.length, 0);
  assert.equal((await store.listReplyDrafts(LOC, {})).length, 0);
});

test("the first note is an email about their estate, left as a draft for Matt; the text waits until the email has gone", async () => {
  const LOC = "loc-seq";
  await seed(LOC);
  writes.length = 0;
  const r = await runGatekeeperSweep({ locationId: LOC, saved: ON(), store, deps, now: T0 });
  assert.equal(r.steps.drafted, 2);
  assert.equal(r.steps.scheduled, 0, "autoSend is off");
  const drafts = await store.listReplyDrafts(LOC, {});
  const email = drafts.find((d) => d.contactId === "c-paul");
  assert.equal(email.status, "draft");
  assert.equal(email.channel, "email");
  assert.equal(email.outbound.kind, "gatekeeper_email");
  assert.equal(email.outbound.subject, "Estate of Harold Example, 1234 Elm St");
  assert.equal(email.outbound.hookKey, "probate:king:25-4-07311-2-sea");
  assert.equal(email.party, "gatekeeper");
  assert.match(email.autoSend.reason, /wait for you/);
  const kim = drafts.find((d) => d.contactId === "c-noemail");
  assert.equal(kim.channel, "sms");
  assert.equal(kim.outbound.kind, "gatekeeper_text");

  // Next morning: the email still sits unsent — no text, and no second email.
  const again = await runGatekeeperSweep({ locationId: LOC, saved: ON(), store, deps, now: T0 + DAY });
  assert.equal(again.steps.drafted, 0);
  assert.match(again.rows.find((x) => x.gkKey === "wsba:40123").waiting, /hasn't gone yet/);

  // Matt sends it; a day later the text follows.
  await recordEvent({ store, locationId: LOC, contactId: "c-paul", party: "gatekeeper", type: "gatekeeper_sent", at: new Date(T0 + DAY).toISOString(), source: "conversation", ref: email.id, dedupeKey: `gatekeeper_sent:${email.id}`, data: { step: "email" } });
  const text = await runGatekeeperSweep({ locationId: LOC, saved: ON(), store, deps, now: T0 + 2 * DAY });
  assert.equal(text.steps.drafted, 1);
  const t = (await store.listReplyDrafts(LOC, {})).find((d) => d.outbound?.kind === "gatekeeper_text" && d.contactId === "c-paul");
  assert.ok(t);
  assert.ok(t.reply.length <= 160);
});

test("once a gatekeeper answers, nothing more is written to them", async () => {
  const LOC = "loc-replied";
  await seed(LOC);
  await recordEvent({ store, locationId: LOC, contactId: "c-paul", party: "gatekeeper", type: "gatekeeper_replied", at: new Date(T0 - 3600000).toISOString(), source: "conversation", ref: "j1", dedupeKey: "gr:j1" });
  const r = await runGatekeeperSweep({ locationId: LOC, saved: ON(), store, deps, now: T0 });
  assert.match(r.rows.find((x) => x.gkKey === "wsba:40123").waiting, /talking to us/);
  assert.equal((await store.listReplyDrafts(LOC, {})).filter((d) => d.contactId === "c-paul").length, 0);
});

test("with autoSend on and sends live a clean note schedules itself; one that reads like a machine waits for Matt", async () => {
  const LOC = "loc-auto";
  await seed(LOC);
  const flaggedWrite = async (a) => (a.gk.gkKey === "wsba:40123" ? { subject: "Hi", body: "I hope this finds you well!", flags: ["hope this finds you", "exclamation"] } : write(a));
  const r = await runGatekeeperSweep({ locationId: LOC, saved: ON({ autoSend: true }), store, sendsEnabled: true, deps: { ...deps, write: flaggedWrite }, now: T0 });
  assert.equal(r.steps.scheduled, 1);
  assert.equal(r.steps.drafted, 1);
  const drafts = await store.listReplyDrafts(LOC, {});
  const flagged = drafts.find((d) => d.contactId === "c-paul");
  assert.equal(flagged.status, "draft");
  assert.equal(flagged.needsHuman, true);
  assert.ok(flagged.flags.some((f) => /reads like a machine/.test(f)));
  assert.equal(drafts.find((d) => d.contactId === "c-noemail").status, "scheduled");
});

test("the day's new gatekeepers are imported best first, only those we can reach, and dry while the sweep is dry", async () => {
  const LOC = "loc-import";
  await store.upsertGatekeepers(LOC, [
    { gkKey: "wsba:1", kind: "probate_attorney", doc: { name: "A One", email: "a@x.test" } },
    { gkKey: "wsba:2", kind: "probate_attorney", doc: { name: "B Two", phone: "2065550000" } },
    { gkKey: "wsba:3", kind: "probate_attorney", doc: { name: "C Three" } },
    { gkKey: "e:esc@x.test", kind: "escrow", doc: { name: "E Scrow", email: "esc@x.test" } },
  ]);
  await store.upsertGatekeeperHooks(LOC, [{ hookKey: "probate:king:b", gkKey: "wsba:2", kind: "estate", doc: { firstPublished: new Date(T0 - 5 * DAY).toISOString().slice(0, 10), house: { address: "1 B St" } } }]);
  const calls = [];
  const importGatekeepers = async (a) => { calls.push(a); return { dryRun: a.dryRun, created: 0, updated: 0, results: a.gkKeys.map((gkKey) => ({ gkKey, ok: true })) }; };
  await runGatekeeperSweep({ locationId: LOC, saved: ON({ dryRun: true, dailyNew: 2, kinds: { escrow: false } }), store, deps: { ...deps, importGatekeepers }, now: T0 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].gkKeys, ["wsba:2", "wsba:1"], "the one with an estate and a house first; no reach, no import; escrow is off");
  assert.equal(calls[0].dryRun, true);
});

test("the bot never answers a gatekeeper and never starts an agent's text to one", () => {
  assert.match(handsOffReason({ gatekeeper: true }), /gatekeeper/);
  assert.equal(handsOffReason({}), "");
});

test("when Matt sends the email, the sequence's clock starts from that send", async () => {
  const { sendReplyDraft } = await import("./reply-agent.js");
  const LOC = "loc-send";
  await seed(LOC);
  await runGatekeeperSweep({ locationId: LOC, saved: ON(), store, deps, now: T0 });
  const email = (await store.listReplyDrafts(LOC, {})).find((d) => d.contactId === "c-paul");
  const sentCalls = [];
  const client = { call: async (p, opts = {}) => { if (p === "/conversations/messages") { sentCalls.push(opts.body); return { messageId: "m-gk" }; } return {}; } };
  await sendReplyDraft({ client, store, locationId: LOC, draftId: email.id, text: email.reply, live: true });
  assert.equal(sentCalls[0].type, "Email");
  assert.equal(sentCalls[0].subject, "Estate of Harold Example, 1234 Elm St", "the subject the draft carries");
  const [sent] = await store.listContactEvents(LOC, "c-paul", { types: ["gatekeeper_sent"] });
  assert.equal(sent.data.step, "email");
  assert.equal(sent.data.channel, "email");
  assert.equal(sent.data.hookKey, "probate:king:25-4-07311-2-sea");
  const next = await runGatekeeperSweep({ locationId: LOC, saved: ON(), store, deps, now: Date.parse(sent.at) + DAY + 60000 });
  assert.equal(next.rows.find((x) => x.gkKey === "wsba:40123").step, "text");
});
