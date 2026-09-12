// outreach-followup.test.mjs — who goes into the follow-up workflow, and who
// is left alone. Real file store (events + dedupe), fake LeadConnector.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-followup-test-"));

const { store } = await import("./store.js");
const { recordEvent } = await import("./contact-record.js");
const {
  followUpCandidates, startOutreachFollowUp, maybeStartOutreachFollowUp, _resetJobs, CURSOR_NAME,
} = await import("./outreach-followup.js");

await store.init();

const DAY = 86400000;
const NOW = Date.parse("2026-09-11T17:05:00Z"); // a Friday — the tick is weekdays-only by default
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const ev = (contactId, type, at, data = {}) => ({ contactId, type, at, data });
const settle = () => new Promise((r) => setTimeout(r, 30));

test("due after the days, not before; a reply, an offer, or an earlier follow-up ends it", () => {
  const events = [
    ev("due", "outreach_enrolled", ago(15), { kind: "first" }),
    ev("early", "outreach_enrolled", ago(13), { kind: "first" }),
    ev("replied", "outreach_enrolled", ago(20), { kind: "first" }),
    ev("replied", "text_summary", ago(18)),
    ev("offered", "outreach_enrolled", ago(20), { kind: "first" }),
    ev("offered", "offer_sent", ago(5)),
    ev("done", "outreach_enrolled", ago(30), { kind: "first" }),
    ev("done", "outreach_enrolled", ago(16), { kind: "followup" }),
    ev("older", "outreach_enrolled", ago(40), { kind: "first" }),
    ev("oldTalk", "text_summary", ago(50)),                       // before any enrollment: irrelevant
    ev("oldTalk", "outreach_enrolled", ago(20), { kind: "first" }),
  ];
  assert.deepEqual(followUpCandidates(events, { days: 14, now: NOW }).map((c) => c.contactId), ["older", "oldTalk", "due"]);
});

function fakeGhl(directions = {}) {
  const calls = [];
  return {
    calls,
    client: {
      async call(p, opts = {}) {
        calls.push({ method: opts.method || "GET", path: p });
        const m = p.match(/conversations\/search\?.*contactId=([^&]+)/);
        if (m) {
          const d = directions[decodeURIComponent(m[1])];
          if (d === 403) throw Object.assign(new Error("forbidden"), { status: 403 });
          return { conversations: d ? [{ lastMessageDate: NOW - DAY, lastMessageDirection: d }] : [] };
        }
        return {};
      },
    },
  };
}
const enrolls = (ghl) => ghl.calls.filter((c) => c.method === "POST" && /\/workflow\//.test(c.path)).map((c) => c.path);
const saved = { outreachAutopilot: { enabled: true, followUpEnabled: true, followUpWorkflowId: "wf-follow-1", followUpDays: 14 } };

test("enrolls the silent, skips who wrote back in GHL, and never twice", async () => {
  const LOC = "loc-fu-1";
  for (const id of ["silent", "wroteBack"]) {
    await recordEvent({ store, locationId: LOC, contactId: id, party: "agent", type: "outreach_enrolled", at: ago(20),
      source: "import", dedupeKey: `outreach_enrolled:first:${id}`, data: { kind: "first", workflowId: "wf-first" } });
  }
  _resetJobs();
  const ghl = fakeGhl({ silent: "outbound", wroteBack: "inbound" });

  const dry = startOutreachFollowUp({ locationId: LOC, client: ghl.client, saved, store, dryRun: true, now: NOW, paceMs: 0 });
  await settle();
  assert.equal(dry.status, "done", dry.error);
  assert.equal(enrolls(ghl).length, 0, "a dry run writes nothing");
  assert.equal(dry.results.find((r) => r.contactId === "silent").action, "would enroll");

  const live = startOutreachFollowUp({ locationId: LOC, client: ghl.client, saved, store, now: NOW, paceMs: 0 });
  await settle();
  assert.equal(live.status, "done", live.error);
  assert.deepEqual(enrolls(ghl), ["/contacts/silent/workflow/wf-follow-1"]);
  assert.equal(live.results.find((r) => r.contactId === "wroteBack").skipped, "they wrote back");

  const again = startOutreachFollowUp({ locationId: LOC, client: ghl.client, saved, store, now: NOW, paceMs: 0 });
  await settle();
  assert.equal(again.candidates, 1, "only wroteBack is still a candidate");
  assert.equal(enrolls(ghl).length, 1, "silent is not enrolled a second time");
});

test("without the conversations scope nobody is enrolled", async () => {
  const LOC = "loc-fu-2";
  await recordEvent({ store, locationId: LOC, contactId: "a", party: "agent", type: "outreach_enrolled", at: ago(20),
    source: "import", dedupeKey: "outreach_enrolled:first:a", data: { kind: "first" } });
  _resetJobs();
  const ghl = fakeGhl({ a: 403 });
  const job = startOutreachFollowUp({ locationId: LOC, client: ghl.client, saved, store, now: NOW, paceMs: 0 });
  await settle();
  assert.equal(enrolls(ghl).length, 0);
  assert.match(job.warnings[0], /conversations\.readonly/);
});

test("the tick: its hour, both switches, a workflow, once a day", async () => {
  _resetJobs();
  const LOC = "loc-fu-3";
  const base = { locationId: LOC, client: fakeGhl().client, store, hour: 10, now: NOW, paceMs: 0 }; // NOW is 10:05am Pacific
  assert.equal(await maybeStartOutreachFollowUp({ ...base, saved, now: NOW - 3600000 }), false, "wrong hour");
  assert.equal(await maybeStartOutreachFollowUp({ ...base, saved: { outreachAutopilot: { ...saved.outreachAutopilot, enabled: false } } }), false, "autopilot off");
  assert.equal(await maybeStartOutreachFollowUp({ ...base, saved: { outreachAutopilot: { ...saved.outreachAutopilot, followUpWorkflowId: "" } } }), false, "no workflow");
  assert.equal(await maybeStartOutreachFollowUp({ ...base, saved, now: NOW + DAY }), false, "Saturday");
  assert.equal(await maybeStartOutreachFollowUp({ ...base, saved }), true);
  await settle();
  assert.ok((await store.getJobCursor(LOC, CURSOR_NAME)).at);
  assert.equal(await maybeStartOutreachFollowUp({ ...base, saved, now: NOW + 600000 }), false, "already ran today");
});
