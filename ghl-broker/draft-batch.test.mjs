import test from "node:test";
import assert from "node:assert/strict";
import { createBatcher } from "./draft-batch.js";

// A Batch API that answers from a script: which requests succeed, and how
// many polls before the batch ends.
function fakeBatches({ fail = new Set(), pollsToEnd = 1, createError = null } = {}) {
  const created = [];
  let polls = 0;
  const api = {
    created,
    canceled: [],
    messages: { batches: {
      async create({ requests }) { if (createError) throw createError; created.push(requests); return { id: `b${created.length}`, processing_status: "in_progress" }; },
      async retrieve() { polls++; return { processing_status: polls >= pollsToEnd ? "ended" : "in_progress" }; },
      async cancel(id) { api.canceled.push(id); },
      async results() {
        const reqs = created.at(-1);
        return (async function* () {
          for (const r of reqs) {
            yield fail.has(r.params.tag)
              ? { custom_id: r.custom_id, result: { type: "errored" } }
              : { custom_id: r.custom_id, result: { type: "succeeded", message: { id: `m-${r.params.tag}`, usage: {} } } };
          }
        })();
      },
    } },
  };
  return api;
}
const quick = { windowMs: 5, pollMs: 1, sleepFn: () => Promise.resolve(), log: () => {} };

test("a sweep's drafts go out as one batch, and each caller gets its own message back", async () => {
  const api = fakeBatches();
  const b = createBatcher({ client: api, ...quick });
  const out = await Promise.all(["a", "b", "c"].map((tag) => b.enqueue({ tag })));
  assert.equal(api.created.length, 1, "one batch");
  assert.equal(api.created[0].length, 3);
  assert.deepEqual(out.map((m) => m.id), ["m-a", "m-b", "m-c"]);
});

test("an errored request rejects only its own caller — the caller drafts directly instead", async () => {
  const api = fakeBatches({ fail: new Set(["b"]) });
  const b = createBatcher({ client: api, ...quick });
  const got = await Promise.allSettled(["a", "b"].map((tag) => b.enqueue({ tag })));
  assert.equal(got[0].status, "fulfilled");
  assert.equal(got[1].status, "rejected");
  assert.equal(got[1].reason.batch, true);
});

test("a batch that won't finish in time is canceled and every caller falls back", async () => {
  const api = fakeBatches({ pollsToEnd: Infinity });
  const b = createBatcher({ client: api, ...quick, maxWaitMs: 0 });
  const got = await Promise.allSettled([b.enqueue({ tag: "a" })]);
  assert.equal(got[0].status, "rejected");
  assert.match(got[0].reason.message, /not done/);
  assert.deepEqual(api.canceled, ["b1"]);
});

test("a batch the API refuses to create falls back at once", async () => {
  const b = createBatcher({ client: fakeBatches({ createError: new Error("429") }), ...quick });
  await assert.rejects(() => b.enqueue({ tag: "a" }), /batch create failed/);
});
