import test from "node:test";
import assert from "node:assert/strict";
import { parseAddressList, isPersonMail, summarizeMessage, emailEvent, addressInEmail, emailContextText, stripQuoted } from "./gmail.js";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");
const mail = ({ id = "m1", from, to = "matt@shepflips.com", cc = "", subject = "Re: 1234 Cedar Ave", text = "", html = "", labels = ["INBOX"], extra = [], files = [] } = {}) => ({
  id, threadId: `t-${id}`, internalDate: String(Date.parse("2026-09-27T17:00:00Z")), labelIds: labels, snippet: "snip",
  payload: {
    mimeType: "multipart/mixed",
    headers: [{ name: "From", value: from }, { name: "To", value: to }, ...(cc ? [{ name: "Cc", value: cc }] : []), { name: "Subject", value: subject }, ...extra],
    parts: [
      { mimeType: "multipart/alternative", parts: [
        ...(text ? [{ mimeType: "text/plain", body: { data: b64(text) } }] : []),
        ...(html ? [{ mimeType: "text/html", body: { data: b64(html) } }] : []),
      ] },
      ...files.map((f) => ({ mimeType: "application/pdf", filename: f, body: { attachmentId: "a" } })),
    ],
  },
});

test("an address list keeps the commas inside a quoted name", () => {
  assert.deepEqual(parseAddressList('"Smith, Jo" <Jo@Example.com>, b@y.com, not-an-address'), [
    { name: "Smith, Jo", email: "jo@example.com" }, { name: "", email: "b@y.com" },
  ]);
});

test("newsletters, notifications and promotions are not a person writing", () => {
  assert.equal(isPersonMail(mail({ from: "Jo <jo@kw.com>" })), true);
  assert.equal(isPersonMail(mail({ from: "Zillow <no-reply@zillow.com>" })), false);
  assert.equal(isPersonMail(mail({ from: "jo@kw.com", extra: [{ name: "List-Unsubscribe", value: "<mailto:x>" }] })), false);
  assert.equal(isPersonMail(mail({ from: "jo@kw.com", labels: ["CATEGORY_PROMOTIONS"] })), false);
  assert.equal(isPersonMail(mail({ from: "jo@kw.com", labels: ["CATEGORY_UPDATES"] })), true);
});

test("an email from an agent is received, names everyone but us, and keeps only the new words", () => {
  const s = summarizeMessage(mail({ from: "Jo <jo@kw.com>", cc: "tc@kw.com, Matt <MATT@shepflips.com>", text: "Form 21 attached, seller signed.\n\nOn Fri, Sep 26, 2026 at 3:00 PM Matt wrote:\n> what about 1234 Cedar", files: ["Form21.pdf"] }),
    { self: ["matt@shepflips.com"] });
  assert.equal(s.direction, "received");
  assert.deepEqual(s.others, ["jo@kw.com", "tc@kw.com"]);
  assert.equal(s.body, "Form 21 attached, seller signed.");
  assert.deepEqual(s.attachments, ["Form21.pdf"]);
  assert.equal(s.at, "2026-09-27T17:00:00.000Z");
  assert.match(s.link, /authuser=matt%40shepflips\.com#all\/t-m1$/);
});

test("an email we wrote is sent, and its people are the recipients", () => {
  const s = summarizeMessage(mail({ from: "matt@shepflips.com", to: "Jo <jo@kw.com>", html: "<p>Sending the <b>LOI</b></p>", labels: ["SENT"] }), { self: ["matt@shepflips.com"] });
  assert.equal(s.direction, "sent");
  assert.deepEqual(s.others, ["jo@kw.com"]);
  assert.equal(s.body, "Sending the LOI");
  const ev = emailEvent(s, { contactId: "c1" });
  assert.equal(ev.type, "email_sent");
  assert.equal(ev.dedupeKey, "gmail:m1");
  assert.equal(ev.source, "gmail");
});

test("Outlook's quoted history is cut too", () => {
  assert.equal(stripQuoted("Sounds good\n\nFrom: Matt\nSent: Friday\nold words"), "Sounds good");
});

test("the house an email is about is the offer whose street line it names", () => {
  const s = { subject: "Re: 1234 cedar ave n", body: "" };
  assert.equal(addressInEmail(s, ["99 Pine St, Seattle", "1234 Cedar Ave N, Seattle, WA"]), "1234 Cedar Ave N, Seattle, WA");
  assert.equal(addressInEmail({ subject: "hello", body: "" }, ["1234 Cedar Ave N"]), "");
});

test("the prompt block is the newest emails, oldest first, and says their numbers are not ours", () => {
  const events = [
    { type: "email_received", at: "2026-09-20T10:00:00Z", data: { subject: "old", body: "a" } },
    { type: "note", at: "2026-09-21T10:00:00Z", data: {} },
    { type: "email_sent", at: "2026-09-22T10:00:00Z", data: { subject: "LOI", body: "attached", attachments: ["LOI.pdf"] } },
  ];
  const t = emailContextText(events);
  assert.match(t, /^EMAIL WITH THEM/);
  assert.ok(t.indexOf("old") < t.indexOf("LOI"));
  assert.match(t, /US: "LOI" \[attached: LOI\.pdf\] — attached/);
  assert.match(t, /not numbers you may quote/);
  assert.equal(emailContextText([{ type: "note" }]), "");
});
