// pipeline-feedback.test.mjs — Today carries what you said about each row.
// Run: node --test pipeline-feedback.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-feedback-test-"));
delete process.env.DATABASE_URL;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createDashboardRouter } = await import("./routes/dashboard.js");

const LOC = "loc-pipeline-feedback";
const resolveLocation = () => ({ locationId: LOC, client: { call: async () => ({}) } });
const app = express();
app.use(express.json({ limit: "5mb" }));
app.use("/api/dashboard", createDashboardRouter({ resolveLocation }));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
const req = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};

test("the pipeline carries what you said about each row, newest first, for drafts and audit rows alike", async () => {
  // An audit row from last night, on the cursor the pipeline reads.
  const anchor = "2026-09-21T19:09:53.000Z";
  await store.setJobCursor(LOC, "conversationAudit", { doc: { last: { finishedAt: "2026-09-22T02:10:00Z", counts: {}, findings: [
    { kind: "unanswered_inbound", severity: "now", contactId: "c1", contactName: "Melissa W", anchorAt: anchor, dueAt: anchor, why: "not drafted: this contact's daily cap reached (12/12)", action: null, id: `audit:unanswered_inbound:c1:${anchor.slice(0, 19)}` },
  ], acted: [] } } });
  // A draft waiting on you.
  const d = await store.createReplyDraft({ locationId: LOC, contactId: "c2", contactName: "Alan R", party: "investor", intent: "buyer_pulse", status: "draft", inbound: "", reply: "Alan, are you buying right now?", outbound: { kind: "buyer_pulse" } });

  const a = await req("POST", "/api/dashboard/feedback", { rowId: `audit:unanswered_inbound:c1:${anchor.slice(0, 19)}`, rowKind: "audit_owed", auditKind: "unanswered_inbound", contactId: "c1", category: "should_have_replied", note: "answer the closing costs question" });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  await req("POST", "/api/dashboard/feedback", { rowId: `draft:${d.id}`, rowKind: "draft_waiting", draftId: d.id, category: "wrong_read", note: "" });
  await req("POST", "/api/dashboard/feedback", { rowId: `draft:${d.id}`, rowKind: "draft_waiting", draftId: d.id, category: "right_to_hand_over", note: "fine" });
  const bad = await req("POST", "/api/dashboard/feedback", { rowId: "x", category: "vibes" });
  assert.equal(bad.status, 400);

  const p = await req("GET", "/api/dashboard/pipeline");
  assert.equal(p.status, 200);
  const fb = p.json.rowFeedback;
  assert.equal(fb[`audit:unanswered_inbound:c1:${anchor.slice(0, 19)}`].label, "Should have replied itself");
  assert.equal(fb[`draft:${d.id}`].category, "right_to_hand_over", "the newer save wins");
  assert.equal(fb[`draft:${d.id}`].note, "fine");
  const row = p.json.actions.find((x) => x.kind === "audit_owed" && x.contactId === "c1");
  assert.ok(row, "the audit row is on the queue");
  assert.equal(row.feedback.category, "should_have_replied");
});

test.after(() => server.close());
