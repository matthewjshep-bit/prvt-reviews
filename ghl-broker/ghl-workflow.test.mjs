// ghl-workflow.test.mjs — the one field GHL is picky about on an enroll.
//
// Every workflow enroll from the Conversation AI failed with
//   422 "The event start time must be a date and time with timezone offset"
// because we sent the ISO `Z` form with milliseconds. GHL wants an explicit
// numeric offset and whole seconds. This pins the shape so it can't drift
// back; the failure only ever showed up in a screenshot of the outbox.
//
//   node --test ghl-workflow.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { addContactToWorkflow, ghlEventTime } from "./ghl.js";

test("the enroll body carries an explicit +00:00 offset, whole seconds, no Z", async () => {
  let sent = null;
  const client = { call: async (_p, o) => { sent = o.body; return {}; } };
  await addContactToWorkflow(client, "c1", "w1");
  assert.match(sent.eventStartTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/, sent.eventStartTime);
  assert.doesNotMatch(sent.eventStartTime, /Z$|\.\d{3}/);
  // A caller's own time is normalised the same way rather than passed through.
  await addContactToWorkflow(client, "c1", "w1", { eventStartTime: "2026-09-07T18:00:00.000Z" });
  assert.equal(sent.eventStartTime, "2026-09-07T18:00:00+00:00");
  assert.equal(ghlEventTime(new Date("2021-06-23T03:30:00.000Z")), "2021-06-23T03:30:00+00:00");
});


// 2026-09-16: an outreach import hung on one GHL request and the day was
// lost. No call waits forever now.
test("every GHL call carries a timeout, so a hung request throws instead of holding a sweep open", async () => {
  const { makeClient, GHL_TIMEOUT_MS } = await import("./ghl.js");
  const real = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, opts) => { seen = opts; return { ok: true, text: async () => "{}" }; };
  try {
    await makeClient("t").call("/contacts/x");
    assert.ok(seen.signal instanceof AbortSignal, "an AbortSignal rides on the request");
    assert.equal(GHL_TIMEOUT_MS, 30000);
  } finally { globalThis.fetch = real; }
});
