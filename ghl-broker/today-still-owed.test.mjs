// today-still-owed.test.mjs — Today shows what still needs Matt, not what
// last night found.
//
// What went wrong (2026-09-30): "From last night" rows are the nightly audit's
// findings, read as they were at 7pm. Mark Hulen's "Texts we never answered"
// was answered at 9:04 the next morning and still sat under Your call; a
// counter draft for an agent who had unsubscribed asked for Matt's call too.
//
//   node --test today-still-owed.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "today-still-owed-test-"));
delete process.env.DATABASE_URL;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { recordEvent } = await import("./contact-record.js");
const { default: createDashboardRouter } = await import("./routes/dashboard.js");

const LOC = "loc-today-still-owed";
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

test("a text answered since last night leaves Your call, and nothing for someone who unsubscribed asks for a call", async () => {
  await store.setJobCursor(LOC, "conversationAudit", { doc: { last: { finishedAt: ago(14), counts: {}, acted: [], findings: [
    finding("mark", "Mark H", ago(30)),
    finding("open", "Still Open", ago(30)),
  ] } } });
  // Mark was answered this morning; the other text is still waiting.
  const sent = await store.createReplyDraft({ locationId: LOC, contactId: "mark", contactName: "Mark H", party: "agent", intent: "small_talk", status: "draft", inbound: "No\nSorry", reply: "No worries, appreciate you checking." });
  await store.updateReplyDraft(sent.id, { ...sent, status: "sent", sentAt: ago(9), updatedAt: ago(9) });
  // A counter held for Matt, for an agent who has since unsubscribed.
  await store.createReplyDraft({ locationId: LOC, contactId: "dnd", contactName: "Unsub Agent", party: "agent", intent: "counter", status: "draft", inbound: "350?", reply: "Let me check with the team." });
  await recordEvent({ store, locationId: LOC, contactId: "dnd", party: "agent", type: "unsubscribed", at: ago(20), source: "conversation", dedupeKey: "unsub:dnd", data: {} });

  const r = await (await fetch(`${B}/api/dashboard/pipeline`)).json();
  assert.equal(r.ok, true, r.error);
  const yours = r.actions.filter((a) => a.group === "yours");
  assert.deepEqual(yours.filter((a) => a.kind === "audit_owed").map((a) => a.contactId), ["open"], "Mark's text was answered this morning");
  assert.equal(yours.some((a) => a.contactId === "dnd"), false, "nothing can reach them");
  assert.equal(r.counts.actions.byGroup.yours, yours.length, "the count matches what's shown");
});
