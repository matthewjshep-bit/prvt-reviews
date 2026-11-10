// scheduler-claim.test.mjs — one due text, two senders, one send.
//
// During a deploy Render runs the old broker and the new one side by side
// for a minute, and both run the 30-second send loop. Until 2026-11-09 the
// claim was a plain write: both could read "scheduled", both write
// "sending", both send. The claim is now a conditional update in both store
// backends, and the loop sends only a row it got back.
//
//   node --test scheduler-claim.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-claim-test-"));
delete process.env.DATABASE_URL;

const { store, claimReplyDraftQuery } = await import("./store.js");
// Two copies of the scheduler module: two brokers, each with its own
// in-memory "in flight" set, sharing one store.
const oldBroker = await import("./conversation-scheduler.js?broker=old");
const newBroker = await import("./conversation-scheduler.js?broker=new");
await store.init();

const LOC = "loc-scheduler-claim";
const NOW = Date.parse("2026-11-09T19:00:00.000Z");
const iso = (t) => new Date(t).toISOString();

test("two schedulers on one due draft send it once", async () => {
  const d = await store.createReplyDraft({ locationId: LOC, contactId: "c-two-senders", status: "scheduled", sendAt: iso(NOW - 60000),
    intent: "question", inbound: "is it still there?", reply: "It is, want the address?", flags: [] });
  const sent = [];
  const send = async ({ draftId }) => {
    sent.push(draftId);
    // GHL takes a moment; the other broker is in its loop meanwhile.
    await new Promise((r) => setTimeout(r, 5));
    const cur = await store.getReplyDraft(draftId);
    await store.updateReplyDraft(draftId, { ...cur, status: "sent", sentAt: iso(NOW) });
    return {};
  };
  const run = (mod) => mod.sendDueDrafts({ store, locations: [{ locationId: LOC, client: {} }], live: true, now: NOW, send, paceMs: 0 });
  const [a, b] = await Promise.all([run(oldBroker), run(newBroker)]);
  assert.deepEqual(sent, [d.id], "one send, not two");
  assert.equal(a.sent + b.sent, 1);
  assert.equal((await store.getReplyDraft(d.id)).status, "sent");
});

test("a draft put off since the loop listed it is not claimed", async () => {
  const d = await store.createReplyDraft({ locationId: LOC, contactId: "c-put-off", status: "scheduled", sendAt: iso(NOW + 3600000), flags: [] });
  assert.equal(await store.claimReplyDraft(d.id, "scheduled", { at: iso(NOW), dueBy: iso(NOW) }), null);
  const claimed = await store.claimReplyDraft(d.id, "scheduled", { at: iso(NOW + 3700000), dueBy: iso(NOW + 3700000) });
  assert.equal(claimed.status, "sending");
  assert.equal(claimed.sendingAt, iso(NOW + 3700000));
  assert.equal(await store.claimReplyDraft(d.id, "scheduled", { at: iso(NOW + 3700000) }), null, "the second claimer gets nothing");
});

test("a deploy that is draining finishes the send under way and claims nothing new", async () => {
  const loc = "loc-draining";
  const a = await store.createReplyDraft({ locationId: loc, contactId: "c-first", status: "scheduled", sendAt: iso(NOW - 120000), flags: [] });
  const b = await store.createReplyDraft({ locationId: loc, contactId: "c-second", status: "scheduled", sendAt: iso(NOW - 60000), flags: [] });
  let draining = false;
  const sent = [];
  const send = async ({ draftId }) => {
    sent.push(draftId);
    draining = true;   // SIGTERM lands while the first text is going
    const cur = await store.getReplyDraft(draftId);
    await store.updateReplyDraft(draftId, { ...cur, status: "sent" });
    return {};
  };
  const r = await oldBroker.sendDueDrafts({ store, locations: [{ locationId: loc, client: {} }], live: true, now: NOW, send, paceMs: 0, stopping: () => draining });
  assert.deepEqual(sent, [a.id]);
  assert.equal(r.leftForNext, 1);
  assert.equal((await store.getReplyDraft(b.id)).status, "scheduled", "left for the broker that replaces this one");
});

test("the Postgres claim is one conditional update that hands the row back", () => {
  const q = claimReplyDraftQuery({ id: "d1", from: "scheduled", at: "2026-11-09T19:00:00.000Z", dueBy: "2026-11-09T19:00:00.000Z" });
  assert.match(q.text, /^update reply_drafts/);
  assert.match(q.text, /where id = \$1 and status = \$2 and \(doc->>'sendAt'\) <= \$5/);
  assert.match(q.text, /returning doc/);
  assert.match(q.text, /'status', 'sending'/);
  assert.deepEqual(q.params, ["d1", "scheduled", "2026-11-09T19:00:00.000Z", "2026-11-09T19:00:00.000Z", "2026-11-09T19:00:00.000Z"]);
  const plain = claimReplyDraftQuery({ id: "d1", at: "x" });
  assert.equal(plain.params.length, 4);
  assert.doesNotMatch(plain.text, /sendAt/);
});
