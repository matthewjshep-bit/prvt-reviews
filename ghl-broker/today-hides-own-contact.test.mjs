// today-hides-own-contact.test.mjs — the operator's own contact is not work
// on Today.
//
// What went wrong (2026-09-28): Matt's own test contact, texting the line to
// try it, sat at the top of Today with a follow-up drafted to himself and two
// offers on the board. The rule is shared/self-contact.js; this checks the
// route applies it to drafts, offers and last night's rows alike.
//
//   node --test today-hides-own-contact.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "today-hides-own-contact-test-"));
delete process.env.DATABASE_URL;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createDashboardRouter } = await import("./routes/dashboard.js");

const LOC = "loc-today-hides-own-contact";
const app = express();
app.use(express.json());
app.use("/api/dashboard", createDashboardRouter({ resolveLocation: () => ({ locationId: LOC, client: { call: async () => ({}) } }) }));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(() => server.close());

const H = 3600000;
const ago = (h) => new Date(Date.now() - h * H).toISOString();
const finding = (contactId, name, anchorAt) => ({
  kind: "unanswered_inbound", severity: "now", contactId, contactName: name, anchorAt, dueAt: anchorAt, why: "they texted and nothing was drafted", action: null,
  id: `audit:unanswered_inbound:${contactId}:${anchorAt.slice(0, 19)}`,
});

test("your own contact's drafts, offers and last night's rows stay off Today, and everyone else's stay on", async () => {
  await store.saveOfferSettings(LOC, { company: { signer: "Pat Operator" }, conversationAi: { persona: { name: "Pat" } } });
  // You, texting the line: a draft that names you, and an offer that doesn't.
  await store.createReplyDraft({ locationId: LOC, contactId: "me", contactName: "Pat Operator", party: "agent", intent: "small_talk", status: "draft", inbound: "test", reply: "Hey!" });
  await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "me", contactName: "", address: "1 Test St, Kent, WA 98030", cashAmount: 300000, status: "sent", statusHistory: [] });
  // A second test contact that only last night's audit knows, by name.
  // A real agent waiting on a reply, and a real agent's unanswered text.
  await store.createReplyDraft({ locationId: LOC, contactId: "agent", contactName: "Jane Example", party: "agent", intent: "question", status: "draft", inbound: "Still buying?", reply: "We are." });
  await store.setJobCursor(LOC, "conversationAudit", { doc: { last: { finishedAt: ago(14), counts: {}, acted: [], findings: [
    finding("me-too", "Pat Operator", ago(30)),
    finding("other", "Sam Example", ago(30)),
  ] } } });

  const r = await (await fetch(`${B}/api/dashboard/pipeline`)).json();
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.drafts.map((d) => d.contactId), ["agent"], "your draft is not waiting on you");
  const mine = r.actions.filter((a) => a.contactId === "me" || a.contactId === "me-too");
  assert.deepEqual(mine, [], "no row on Today is about you");
  assert.ok(r.actions.some((a) => a.kind === "audit_owed" && a.contactId === "other"), "someone else's unanswered text still asks");
  const yours = r.actions.filter((a) => a.group === "yours");
  assert.equal(r.counts.actions.byGroup.yours, yours.length, "the count matches what's shown");
});
