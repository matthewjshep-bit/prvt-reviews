// ghl-email-stubs.test.mjs — an agent who answers by email is heard in their
// own words.
//
// GHL lists an email thread as one stub: its body is the FIRST email in it
// (ours, when they answered our outreach email), marked inbound at the time
// of their reply, with no attachments and the real emails' ids in
// meta.email.messageIds. The bot's transcript read that body, so an agent's
// emailed answer showed as our own pitch on a THEM line and their words never
// reached the model (2026-10-22, rebuilt on main 2026-11-09). The names,
// streets and words below are made up.
//
//   node --test ghl-email-stubs.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { listConversationMessages, withEmails, _resetEmailCache } from "./ghl.js";
import { buildTranscript } from "./enrich.js";
import { cutQuotedHtml } from "./shared/gmail.js";

const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();
const PITCH = "<p>Hi Wren, any fixers on your desk this month?</p>";
const REPLY = `<div dir="ltr"><div>Hi Matt,</div><div>The one on Larkspur needs a new roof and the kitchen is original. Report attached.</div></div>`
  + `<div class="gmail_quote"><div>On Mon, Matt wrote:</div><blockquote>Hi Wren, any fixers on your desk this month?</blockquote></div>`;
const EMAILS = {
  out1: { id: "out1", direction: "outbound", dateAdded: ago(72), subject: "Fixers this month?", body: PITCH, attachments: [] },
  in1: { id: "in1", direction: "inbound", dateAdded: ago(10), subject: "Re: Fixers this month?", body: REPLY, attachments: ["https://files.invalid/report.pdf"] },
};
// As GHL sends it: the first email's words, marked inbound, at the time of the reply.
const stub = (id, ids, over = {}) => ({ id, messageType: "TYPE_EMAIL", direction: "inbound", body: PITCH, dateAdded: ago(9.9),
  meta: { email: { messageIds: ids, direction: "inbound" } }, ...over });
function emailClient(messages = [stub("stub1", ["out1", "in1"]), { id: "sms1", messageType: "TYPE_SMS", direction: "outbound", body: "Sent you an email", dateAdded: ago(73) }], emails = EMAILS) {
  const calls = { email: [] };
  return {
    calls,
    call: async (p) => {
      if (p.includes("/conversations/search")) return { conversations: [{ id: "cv1" }] };
      const m = /messages\/email\/(\w+)/.exec(p);
      if (m) {
        calls.email.push(m[1]);
        if (!emails[m[1]]) throw Object.assign(new Error("404"), { status: 404 });
        return { emailMessage: emails[m[1]] };
      }
      return { messages: { messages } };
    },
  };
}

test("an agent who answers our email by email is read in their own words in the bot's transcript", async () => {
  _resetEmailCache();
  const t = await buildTranscript(emailClient(), "LOC", "c1", { maxCallTranscripts: 0 });
  const lines = t.text.split("\n");
  const theirs = lines.filter((l) => / THEM email: /.test(l));
  assert.equal(theirs.length, 1, t.text);
  assert.match(theirs[0], /needs a new roof and the kitchen is original/);
  assert.doesNotMatch(theirs[0], /any fixers on your desk/, "our email isn't quoted under theirs, or read as theirs");
  // Ours is its own US line, at its own time, before theirs.
  const ours = lines.filter((l) => / US email: /.test(l));
  assert.equal(ours.length, 1, t.text);
  assert.match(ours[0], /US email: Hi Wren, any fixers on your desk this month\?$/);
  assert.ok(lines.indexOf(ours[0]) < lines.indexOf(theirs[0]), "ours went first");
});

test("an email thread with no reply of theirs adds no THEM line", async () => {
  _resetEmailCache();
  const t = await buildTranscript(emailClient([stub("stub1", ["out1"])]), "LOC", "c1", { maxCallTranscripts: 0 });
  assert.doesNotMatch(t.text, / THEM /, t.text);
  assert.match(t.text, / US email: /);
  // An email of theirs that is only the quoted thread adds nothing either.
  _resetEmailCache();
  const empty = { ...EMAILS, in1: { ...EMAILS.in1, body: `<div class="gmail_quote"><blockquote>${PITCH}</blockquote></div>` } };
  const t2 = await buildTranscript(emailClient(undefined, empty), "LOC", "c1", { maxCallTranscripts: 0 });
  assert.doesNotMatch(t2.text, / THEM /, t2.text);
  // GHL won't hand the emails over: a stub over two emails can't say whose
  // words its body is, so it adds no line rather than our words as theirs.
  _resetEmailCache();
  const t3 = await buildTranscript(emailClient(undefined, {}), "LOC", "c1", { maxCallTranscripts: 0 });
  assert.doesNotMatch(t3.text, / THEM /, t3.text);
});

test("a transcript reads at most five emails, the newest first", async () => {
  _resetEmailCache();
  const many = {};
  const stubs = [];
  for (let i = 0; i < 8; i++) {
    many[`e${i}`] = { id: `e${i}`, direction: "inbound", dateAdded: ago(10 + i), subject: `Re: house ${i}`, body: `<p>Reply number ${i} about Larkspur</p>`, attachments: [] };
    stubs.push(stub(`s${i}`, [`e${i}`], { dateAdded: ago(10 + i) }));
  }
  const client = emailClient(stubs, many);
  const t = await buildTranscript(client, "LOC", "c1", { maxCallTranscripts: 0 });
  assert.deepEqual(client.calls.email, ["e0", "e1", "e2", "e3", "e4"]);
  for (let i = 0; i < 5; i++) assert.match(t.text, new RegExp(`Reply number ${i} about`));
  // Read once per process: the next transcript reads the older ones.
  const again = emailClient(stubs, many);
  await buildTranscript(again, "LOC", "c1", { maxCallTranscripts: 0 });
  assert.deepEqual(again.calls.email, ["e5", "e6", "e7"]);
  // A bulk scan asks for none: no reads, and the stubs read as they always did.
  _resetEmailCache();
  const scan = emailClient();
  const s = await buildTranscript(scan, "LOC", "c1", { maxCallTranscripts: 0, maxEmailReads: 0 });
  assert.equal(scan.calls.email.length, 0);
  assert.match(s.text, /THEM email: Hi Wren, any fixers on your desk this month\?/);
});

test("an email stub becomes one message per email, newest first, with its attachments, when a reader asks for it", async () => {
  _resetEmailCache();
  const client = emailClient();
  const { messages } = await listConversationMessages(client, "cv1", { emails: true });
  assert.deepEqual(messages.map((m) => [m.direction, m.emailMessageId || m.id]), [["inbound", "in1"], ["outbound", "out1"], ["outbound", "sms1"]]);
  assert.deepEqual(messages[0].attachments, ["https://files.invalid/report.pdf"]);
  assert.equal(messages[0].body.includes("gmail_quote"), false, "the quoted history is cut");
  await listConversationMessages(client, "cv1", { emails: true });
  assert.equal(client.calls.email.length, 2, "each email is read once");
  // A reader that only counts keeps GHL's stubs and spends no reads.
  _resetEmailCache();
  const counter = emailClient();
  const plain = await listConversationMessages(counter, "cv1");
  assert.equal(plain.messages[0].id, "stub1");
  assert.equal(counter.calls.email.length, 0);
});

test("a text, or an email GHL won't hand over, is left as it was", async () => {
  _resetEmailCache();
  const kept = { id: "m1", body: "hello", messageType: "TYPE_SMS" };
  const broken = { id: "m2", meta: { email: { messageIds: ["gone"] } } };
  const client = { call: async () => { throw Object.assign(new Error("403"), { status: 403 }); } };
  assert.deepEqual(await withEmails(client, [kept, broken]), [kept, broken]);
});

test("the quoted history is cut from Gmail, Outlook and Apple replies", () => {
  assert.equal(cutQuotedHtml(REPLY).includes("desk this month"), false);
  assert.equal(cutQuotedHtml(`<p>Yes</p><div id="divRplyFwdMsg">From: Matt</div>`), "<p>Yes</p>");
  assert.equal(cutQuotedHtml(`<p>Yes</p><blockquote type="cite">old</blockquote>`), "<p>Yes</p>");
  assert.equal(cutQuotedHtml("<p>No quote here</p>"), "<p>No quote here</p>");
});
