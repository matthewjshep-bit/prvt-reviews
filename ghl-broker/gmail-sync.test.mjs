import test from "node:test";
import assert from "node:assert/strict";
import { syncContactGmail, gmailBeforeDraft, contactEmails, gmailQuery, _reset, RECHECK_MS } from "./gmail-sync.js";
import { buildAgentContext } from "./conversation-context.js";
import { assembleConversation } from "./reply-agent.js";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");
const mail = (id, from, text, { to = "matt@shepflips.com", labels = ["INBOX"], subject = "Re: 1234 Cedar Ave", extra = [] } = {}) => ({
  id, threadId: `t-${id}`, internalDate: String(Date.parse("2026-09-27T17:00:00Z")), labelIds: labels,
  payload: { mimeType: "text/plain", headers: [{ name: "From", value: from }, { name: "To", value: to }, { name: "Subject", value: subject }, ...extra], body: { data: b64(text) } },
});

const fakeStore = () => ({
  events: [],
  async appendContactEvents(l, contactId, rows) {
    let inserted = 0;
    for (const r of rows) {
      if (this.events.some((e) => e.contactId === contactId && e.dedupeKey === r.dedupeKey)) continue;
      this.events.push({ ...r, contactId }); inserted++;
    }
    return { inserted, skipped: rows.length - inserted };
  },
  async listContactEvents(l, contactId) { return this.events.filter((e) => e.contactId === contactId); },
  async getContactProfile() { return null; }, async upsertContactProfile() { return {}; },
  async listOffers(l, { contactId }) { return contactId === "c-jo" ? [{ id: "o1", contactId, address: "1234 Cedar Ave, Seattle, WA" }] : []; },
});

const fakeGmail = (messages) => ({
  queries: [], fetched: [],
  async profile() { return { emailAddress: "matt@shepflips.com", historyId: "500" }; },
  async list(q) { this.queries.push(q); return Object.keys(messages); },
  async message(id) { this.fetched.push(id); return messages[id]; },
});
const saved = { conversationAi: { gmail: { enabled: true, lookbackDays: 60 } } };

test("only the contact's own email is searched, by every address they have", () => {
  const emails = contactEmails({ email: "Jo@KW.com", additionalEmails: [{ email: "jo@gmail.com" }, "jo@kw.com"] });
  assert.deepEqual(emails, ["jo@kw.com", "jo@gmail.com"]);
  assert.equal(gmailQuery(emails, 60), "{from:jo@kw.com to:jo@kw.com cc:jo@kw.com from:jo@gmail.com to:jo@gmail.com cc:jo@gmail.com} newer_than:60d -in:chats");
});

test("the agent's email lands on their record once, on the house it names; their newsletter does not", async () => {
  _reset();
  const store = fakeStore();
  const gmail = fakeGmail({
    m1: mail("m1", "Jo <jo@kw.com>", "Disclosures attached for 1234 Cedar"),
    m2: mail("m2", "matt@shepflips.com", "Here's the LOI", { to: "jo@kw.com", labels: ["SENT"] }),
    m3: mail("m3", "Jo <jo@kw.com>", "Just listed!", { extra: [{ name: "List-Unsubscribe", value: "<mailto:x>" }] }),
  });
  const r = await syncContactGmail({ locationId: "L", contactId: "c-jo", emails: ["jo@kw.com"], saved, store, deps: { gmail } });
  assert.deepEqual(r, { found: 3, recorded: 2, already: 0, bulk: 1 });
  assert.match(gmail.queries[0], /newer_than:60d/);
  const got = store.events.find((e) => e.ref === "m1");
  assert.equal(got.type, "email_received");
  assert.equal(got.address, "1234 Cedar Ave, Seattle, WA");
  assert.equal(got.offerId, "o1");
  assert.equal(store.events.find((e) => e.ref === "m2").type, "email_sent");

  // A second look fetches nothing it already has.
  gmail.fetched.length = 0;
  const again = await syncContactGmail({ locationId: "L", contactId: "c-jo", emails: ["jo@kw.com"], saved, store, deps: { gmail }, force: true });
  assert.equal(again.recorded, 0);
  assert.deepEqual(gmail.fetched, ["m3"]);
});

test("two drafts minutes apart search once; the drawer button always searches", async () => {
  _reset();
  const store = fakeStore();
  const gmail = fakeGmail({});
  const now = Date.parse("2026-09-28T18:00:00Z");
  const args = { locationId: "L", contactId: "c-jo", emails: ["jo@kw.com"], saved, store, deps: { gmail } };
  await syncContactGmail({ ...args, now });
  assert.equal((await syncContactGmail({ ...args, now: now + 60000 })).skipped, "checked a few minutes ago");
  await syncContactGmail({ ...args, now: now + 60000, force: true });
  await syncContactGmail({ ...args, now: now + 60000 + RECHECK_MS + 1 });   // the forced look restarted the wait
  assert.equal(gmail.queries.length, 3);
});

test("off, without credentials, or without an address, nothing is searched", async () => {
  _reset();
  const store = fakeStore();
  assert.match((await syncContactGmail({ locationId: "L", contactId: "c", emails: ["a@b.co"], saved: {}, store, env: {} })).skipped, /switched off/);
  assert.match((await syncContactGmail({ locationId: "L", contactId: "c", emails: ["a@b.co"], saved, store, env: {} })).skipped, /no Gmail credentials/);
  assert.match((await syncContactGmail({ locationId: "L", contactId: "c", emails: [], saved, store, deps: { gmail: fakeGmail({}) } })).skipped, /no email address/);
});

test("a slow or broken Gmail never holds up a draft, and the warning names no address", async () => {
  _reset();
  const warnings = [];
  const slow = { ...fakeGmail({}), profile: () => new Promise(() => {}) };
  const r = await gmailBeforeDraft({ locationId: "L", contactId: "c1", emails: ["jo@kw.com"], saved, store: fakeStore(), deps: { gmail: slow }, warnings, timeoutMs: 30 });
  assert.equal(r.skipped, "timeout");
  const broken = { ...fakeGmail({}), async profile() { throw Object.assign(new Error("bad jo@kw.com"), { status: 401 }); } };
  await gmailBeforeDraft({ locationId: "L", contactId: "c2", emails: ["jo@kw.com"], saved, store: fakeStore(), deps: { gmail: broken }, warnings });
  assert.deepEqual(warnings, ["gmail: took too long, drafted without it", "gmail: HTTP 401"]);
});

test("the reply agent reads Gmail for the contact before it reads their record, only when switched on", async () => {
  const calls = [];
  const client = { call: async (path) => {
    if (path.startsWith("/contacts/")) return { contact: { id: "c-jo", firstName: "Jo", email: "jo@kw.com", tags: ["agent"] } };
    throw Object.assign(new Error("not stubbed"), { status: 404 });
  } };
  const store = { ...fakeStore(), async listReplyDrafts() { return []; }, async listDeals() { return []; } };
  const gmailSync = async (a) => { calls.push(a.emails); };
  await assembleConversation({ client, locationId: "L", saved, store, contactId: "c-jo", message: "hi", explicitParty: "agent", gmailSync });
  assert.deepEqual(calls, [["jo@kw.com"]]);
  await assembleConversation({ client, locationId: "L", saved: {}, store, contactId: "c-jo", message: "hi", explicitParty: "agent", gmailSync });
  assert.equal(calls.length, 1);
});

test("the reply agent sees what already went by email", () => {
  const ctx = buildAgentContext({ offers: [], events: [
    { type: "email_received", at: "2026-09-27T17:00:00Z", source: "gmail", data: { subject: "Disclosures", body: "Form 17 attached", attachments: ["Form17.pdf"] } },
  ] });
  assert.match(ctx.text, /EMAIL WITH THEM/);
  assert.match(ctx.text, /THEM: "Disclosures" \[attached: Form17\.pdf\] — Form 17 attached/);
});
