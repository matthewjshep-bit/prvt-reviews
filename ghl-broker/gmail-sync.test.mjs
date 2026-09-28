import test from "node:test";
import assert from "node:assert/strict";
import { maybeSyncGmail, runGmailSync, getGmailJob, _reset, MAX_DAILY_RETRIES, CURSOR_NAME } from "./gmail-sync.js";
import { buildAgentContext } from "./conversation-context.js";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");
const mail = (id, from, text, { to = "matt@shepflips.com", labels = ["INBOX"], subject = "Re: 1234 Cedar Ave" } = {}) => ({
  id, threadId: `t-${id}`, internalDate: String(Date.parse("2026-09-27T17:00:00Z")), labelIds: labels,
  payload: { mimeType: "text/plain", headers: [{ name: "From", value: from }, { name: "To", value: to }, { name: "Subject", value: subject }], body: { data: b64(text) } },
});

const fakeStore = () => ({
  events: [], cursors: new Map(),
  async appendContactEvents(l, contactId, rows) {
    let inserted = 0;
    for (const r of rows) {
      if (this.events.some((e) => e.contactId === contactId && e.dedupeKey === r.dedupeKey)) continue;
      this.events.push({ ...r, contactId }); inserted++;
    }
    return { inserted, skipped: rows.length - inserted };
  },
  async getContactProfile() { return null; }, async upsertContactProfile() { return {}; },
  async listOffers(l, { contactId }) { return contactId === "c-jo" ? [{ id: "o1", address: "1234 Cedar Ave, Seattle, WA" }] : []; },
  async getJobCursor(l, name) { return this.cursors.get(name) || null; },
  async setJobCursor(l, name, v) { this.cursors.set(name, v); },
});

const fakeGmail = (messages, { historyId = "500", history = null } = {}) => ({
  calls: [],
  async profile() { return { emailAddress: "matt@shepflips.com", historyId }; },
  async list(q) { this.calls.push(["list", q]); return Object.keys(messages); },
  async history(start) { this.calls.push(["history", start]); if (history instanceof Error) throw history; return { ids: history || [], historyId: "600", complete: true }; },
  async message(id) { return messages[id]; },
});

const contacts = { "jo@kw.com": { id: "c-jo", email: "Jo@KW.com" } };
const searchContacts = async (client, loc, q) => (contacts[q] ? [contacts[q]] : []);
const saved = { conversationAi: { gmail: { enabled: true, backfillDays: 14 } } };

test("an agent's email lands on their record once, on the house it names; a stranger's is not kept", async () => {
  _reset();
  const store = fakeStore();
  const gmail = fakeGmail({
    m1: mail("m1", "Jo <jo@kw.com>", "Disclosures attached for 1234 Cedar"),
    m2: mail("m2", "Aunt May <may@gmail.com>", "Dinner Sunday?"),
    m3: mail("m3", "Zillow <no-reply@zillow.com>", "New listings"),
  });
  const r = await runGmailSync({ locationId: "L", saved, store, deps: { gmail, searchContacts }, doc: {} });
  assert.equal(r.historyId, "500");
  assert.equal(r.counts.mode, "backfill");
  assert.match(gmail.calls[0][1], /^newer_than:14d /);
  assert.equal(r.counts.recorded, 1);
  assert.equal(r.counts.noContact, 1);
  assert.equal(r.counts.bulk, 1);
  assert.equal(store.events.length, 1);
  const ev = store.events[0];
  assert.equal(ev.contactId, "c-jo");
  assert.equal(ev.type, "email_received");
  assert.equal(ev.address, "1234 Cedar Ave, Seattle, WA");
  assert.equal(ev.offerId, "o1");
  assert.equal(ev.data.body, "Disclosures attached for 1234 Cedar");

  const again = await runGmailSync({ locationId: "L", saved, store, deps: { gmail, searchContacts }, doc: {} });
  assert.equal(again.counts.recorded, 0);
  assert.equal(again.counts.duplicate, 1);
  assert.equal(store.events.length, 1);
});

test("after the first run it reads only what Gmail says was added, and an expired history falls back to the last two days", async () => {
  _reset();
  const store = fakeStore();
  const msgs = { m9: mail("m9", "matt@shepflips.com", "Here's the LOI", { to: "jo@kw.com", labels: ["SENT"] }) };
  const r = await runGmailSync({ locationId: "L", saved, store, deps: { gmail: fakeGmail(msgs, { history: ["m9"] }), searchContacts }, doc: { historyId: "450" } });
  assert.equal(r.historyId, "600");
  assert.equal(store.events[0].type, "email_sent");

  const expired = fakeGmail(msgs, { history: Object.assign(new Error("gone"), { status: 404 }) });
  const r2 = await runGmailSync({ locationId: "L", saved, store, deps: { gmail: expired, searchContacts }, doc: { historyId: "1" } });
  assert.equal(r2.counts.mode, "history-expired");
  assert.match(expired.calls[1][1], /^newer_than:2d /);
  assert.equal(r2.historyId, "500");
});

test("the sync is off by default and without the Gmail env", async () => {
  _reset();
  const store = fakeStore();
  assert.equal(await maybeSyncGmail({ locationId: "L", saved: {}, store, env: {} }), false);
  assert.equal(await maybeSyncGmail({ locationId: "L", saved, store, env: {} }), false);
});

test("the cursor is written before the run, moves on success, and a failed run keeps its place and stops retrying for the day", async () => {
  _reset();
  const store = fakeStore();
  const now = Date.parse("2026-09-28T18:00:00Z");
  const gmail = fakeGmail({ m1: mail("m1", "jo@kw.com", "hi") });
  assert.equal(await maybeSyncGmail({ locationId: "L", saved, store, deps: { gmail, searchContacts }, now }), true);
  await getGmailJob("L").done;
  const doc = store.cursors.get(CURSOR_NAME).doc;
  assert.equal(doc.historyId, "500");
  assert.equal(doc.run, undefined);
  assert.equal(doc.last.recorded, 1);
  assert.ok(!JSON.stringify(doc).includes("jo@kw.com"), "no addresses on the cursor");

  // A run another broker left going is left alone until it is stale.
  store.cursors.set(CURSOR_NAME, { doc: { ...doc, run: { startedAt: new Date(now - 60000).toISOString() } } });
  assert.equal(await maybeSyncGmail({ locationId: "L", saved, store, deps: { gmail, searchContacts }, now }), false);

  const broken = { ...gmail, async profile() { throw Object.assign(new Error("nope jo@kw.com"), { status: 401 }); } };
  store.cursors.set(CURSOR_NAME, { doc });
  const logs = [];
  for (let i = 0; i < MAX_DAILY_RETRIES + 2; i++) {
    const started = await maybeSyncGmail({ locationId: "L", saved, store, deps: { gmail: broken, searchContacts }, now: now + i * 900000, log: (l) => logs.push(l) });
    if (started) await getGmailJob("L").done;
  }
  const after = store.cursors.get(CURSOR_NAME).doc;
  assert.equal(after.historyId, "500", "a failure never moves the cursor");
  assert.equal(after.failed, true);
  assert.equal(after.retries, MAX_DAILY_RETRIES);
  assert.equal(after.last.error, "HTTP 401");
  assert.ok(logs.every((l) => !l.includes("jo@kw.com")), "no addresses in the log");
});

test("the reply agent sees what already went by email", () => {
  const ctx = buildAgentContext({ offers: [], events: [
    { type: "email_received", at: "2026-09-27T17:00:00Z", source: "gmail", data: { subject: "Disclosures", body: "Form 17 attached", attachments: ["Form17.pdf"] } },
  ] });
  assert.match(ctx.text, /EMAIL WITH THEM/);
  assert.match(ctx.text, /THEM: "Disclosures" \[attached: Form17\.pdf\] — Form 17 attached/);
});
