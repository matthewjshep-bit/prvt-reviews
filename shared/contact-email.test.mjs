import test from "node:test";
import assert from "node:assert/strict";
import { validEmail, emailsIn, emailOwner, emailSaveFor, wantsDealsByEmail, dealsByOf, DEALS_BY_EMAIL_TAG } from "./contact-email.js";

test("an address is cleaned of its trailing punctuation and lower-cased", () => {
  assert.equal(validEmail("Sam@Example.com."), "sam@example.com");
  assert.equal(validEmail("not an email"), "");
  assert.equal(validEmail("a@b"), "");
});

test("whatever follows cc is copied, not theirs", () => {
  assert.deepEqual(emailsIn("my email is sam@example.com, cc my assistant sue@example.com"),
    { to: ["sam@example.com"], cc: ["sue@example.com"] });
});

test("an address the buyer texts when GHL has none is saved", () => {
  const r = emailSaveFor({ message: "send it to sam@example.com", current: "" });
  assert.equal(r.action, "set");
  assert.equal(r.email, "sam@example.com");
});

test("a bare address in answer to 'what's your email' is theirs", () => {
  assert.equal(emailOwner("sam@example.com thanks", "sam@example.com"), "theirs");
  assert.equal(emailSaveFor({ message: "sam@example.com", current: "old@example.com" }).action, "replace");
});

test("'my email is' replaces a different address on file", () => {
  const r = emailSaveFor({ message: "My email is new@example.com", current: "old@example.com" });
  assert.equal(r.action, "replace");
});

test("an agent's transaction coordinator's address never becomes the agent's", () => {
  for (const message of ["Please send it to my TC at jane@example.com", "her email is jane@example.com", "send to my assistant jane@example.com"]) {
    const r = emailSaveFor({ message, current: "" });
    assert.equal(r.action, "none", message);
    assert.equal(r.owner, "other", message);
  }
});

test("a different address with no word on whose it is goes to Matt", () => {
  const r = emailSaveFor({ message: "send it to jane@example.com", current: "old@example.com" });
  assert.equal(r.action, "ask");
});

test("the address already on file is nothing to do, whatever its case", () => {
  assert.equal(emailSaveFor({ message: "email me at Sam@Example.com", current: "sam@example.com" }).action, "none");
});

test("an address heard on a call is never saved", () => {
  assert.equal(emailSaveFor({ message: "THEM: it's sam@example.com", current: "", isCall: true }).action, "none");
});

test("two addresses and nothing saying which is theirs goes to Matt", () => {
  assert.equal(emailSaveFor({ message: "a@example.com or b@example.com", current: "" }).action, "ask");
});

test("a buyer asking for deals by email is heard", () => {
  for (const m of ["Can you email me the details?", "send it to my email please", "I prefer email for deals",
    "email is better for me", "by email please", "Email me deals, sam@example.com", "please send deals via email instead of text"]) {
    assert.equal(wantsDealsByEmail(m), true, m);
  }
});

test("a no to email, or a question about one, is not a request for email", () => {
  for (const m of ["don't email me", "text is better", "did you get my email?", "I'll check my email tonight", "no emails please"]) {
    assert.equal(wantsDealsByEmail(m), false, m);
  }
});

test("the record's answer beats the GHL tag", () => {
  assert.equal(dealsByOf({ record: { deals_by: "text" }, tags: [DEALS_BY_EMAIL_TAG] }), "text");
  assert.equal(dealsByOf({ tags: [DEALS_BY_EMAIL_TAG.toUpperCase()] }), "email");
  assert.equal(dealsByOf({ dealsBy: "email" }), "email");
  assert.equal(dealsByOf({}), "");
});
