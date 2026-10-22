// ghl-email-stubs.test.mjs — an agent who answers by email is heard.
//
// 2026-10-22: a listing agent answered our outreach email with the house, its
// condition and an inspection report attached. GHL lists an email as a stub
// (no body, no attachments, ids in meta.email.messageIds), and every reader
// skips a message with no words, so the reply never reached the bot's
// transcript or the thread on the contact.
//
//   node --test ghl-email-stubs.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { listConversationMessages, withEmails, _resetEmailCache } from "./ghl.js";
import { buildTranscript } from "./enrich.js";
import { cutQuotedHtml } from "./shared/gmail.js";

const REPLY = `<div dir="ltr"><div>Hi Matt,</div><div>It's a 1915 craftsman I listed a month ago, the basement needs a complete remodel. Inspection report attached.</div></div>`
  + `<div class="gmail_quote"><div>On Mon, Oct 19 Matt wrote:</div><blockquote>Hi Tim, any fixers on your radar?</blockquote></div>`;
const EMAILS = {
  out1: { id: "out1", direction: "outbound", dateAdded: "2026-10-19T22:41:36Z", subject: "Any fixers on your radar?", body: "<p>Hi Tim, any fixers on your radar?</p>", attachments: [] },
  in1: { id: "in1", direction: "inbound", dateAdded: "2026-10-22T02:23:24Z", subject: "Re: Any fixers on your radar?", body: REPLY, attachments: ["https://x.site/inspection.pdf"] },
};
function emailClient() {
  const calls = { email: 0 };
  return {
    calls,
    call: async (p) => {
      if (p.includes("/conversations/search")) return { conversations: [{ id: "cv1" }] };
      const m = /messages\/email\/(\w+)/.exec(p);
      if (m) { calls.email++; return { emailMessage: EMAILS[m[1]] }; }
      return { messages: { messages: [
        // As GHL really sends it: the FIRST email's words, marked inbound, at the time of the reply.
        { id: "stub1", messageType: "TYPE_EMAIL", direction: "inbound", body: "<p>Hi Tim, any fixers on your radar?</p>", dateAdded: "2026-10-22T02:23:25Z",
          meta: { email: { messageIds: ["out1", "in1"], direction: "inbound" } } },
        { id: "sms1", messageType: "TYPE_SMS", direction: "outbound", body: "Sent you an email", dateAdded: "2026-10-19T22:40:00Z" },
      ] } };
    },
  };
}

test("an agent's emailed reply reaches the bot's transcript, in their words, without our email quoted under it", async () => {
  _resetEmailCache();
  const t = await buildTranscript(emailClient(), "LOC", "c1", { maxCallTranscripts: 0 });
  assert.match(t.text, /THEM email: .*1915 craftsman/);
  assert.match(t.text, /US email: .*any fixers on your radar/);
  assert.equal((t.text.match(/any fixers on your radar/g) || []).length, 1, "our email once, as ours, not again inside theirs");
});

test("an email stub becomes one message per email, newest first, with its attachments, and each email is read once", async () => {
  _resetEmailCache();
  const client = emailClient();
  const { messages } = await listConversationMessages(client, "cv1");
  assert.deepEqual(messages.map((m) => [m.direction, m.emailMessageId || m.id]), [["inbound", "in1"], ["outbound", "out1"], ["outbound", "sms1"]]);
  assert.deepEqual(messages[0].attachments, ["https://x.site/inspection.pdf"]);
  await listConversationMessages(client, "cv1");
  assert.equal(client.calls.email, 2);
});

test("a text, or an email GHL won't hand over, is left as it was", async () => {
  _resetEmailCache();
  const kept = { id: "m1", body: "hello", messageType: "TYPE_SMS" };
  const broken = { id: "m2", meta: { email: { messageIds: ["gone"] } } };
  const client = { call: async () => { throw Object.assign(new Error("403"), { status: 403 }); } };
  assert.deepEqual(await withEmails(client, [kept, broken]), [kept, broken]);
});

test("the quoted history is cut from Gmail, Outlook and Apple replies", () => {
  assert.equal(cutQuotedHtml(REPLY).includes("radar"), false);
  assert.equal(cutQuotedHtml(`<p>Yes</p><div id="divRplyFwdMsg">From: Matt</div>`), "<p>Yes</p>");
  assert.equal(cutQuotedHtml(`<p>Yes</p><blockquote type="cite">old</blockquote>`), "<p>Yes</p>");
  assert.equal(cutQuotedHtml("<p>No quote here</p>"), "<p>No quote here</p>");
});
