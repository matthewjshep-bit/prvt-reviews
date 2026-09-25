// draft-batch.js — texts the machine starts, drafted through the Batch API.
//
// The Batch API bills every token at half price, and a nudge, a check-in or a
// sweep's first text has nobody waiting on it. The sweeps start their drafts
// together, so a short collection window turns a sweep's worth into one
// batch; each caller gets its own message back as if it had called the API
// directly.
//
// A batch is best-effort, never a hold-up. Anything but a clean result — the
// create call failing, the request errored, expired or canceled, or the batch
// not finished inside `maxWaitMs` — rejects that caller, and the caller makes
// the ordinary direct call instead. A reply to a person never comes through
// here (reply-agent.js: BATCHABLE_KINDS).
//
// In memory: a redeploy while a batch is out loses the waiting callers the
// way it loses any in-flight job. The window is minutes, not seconds, which
// is why maxWaitMs is short and the direct call is always the fallback.

import Anthropic from "@anthropic-ai/sdk";

export const BATCH_WINDOW_MS = 20_000;       // collect a sweep's drafts before sending
export const BATCH_POLL_MS = 20_000;
export const BATCH_MAX_WAIT_MS = 15 * 60_000; // then give up and draft directly
export const BATCH_MAX_SIZE = 50;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * createBatcher({ client, windowMs, pollMs, maxWaitMs, maxSize, sleepFn, log })
 *   → { enqueue(params) → Promise<Message>, pending() }
 */
export function createBatcher({
  client, windowMs = BATCH_WINDOW_MS, pollMs = BATCH_POLL_MS, maxWaitMs = BATCH_MAX_WAIT_MS,
  maxSize = BATCH_MAX_SIZE, sleepFn = sleep, log = (m) => console.log(m),
} = {}) {
  let queue = [];
  let timer = null;
  let seq = 0;

  async function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    const take = queue;
    queue = [];
    if (!take.length) return;
    const fail = (list, why) => { for (const r of list) r.reject(Object.assign(new Error(why), { batch: true })); };
    let batch;
    try {
      batch = await client.messages.batches.create({ requests: take.map((r) => ({ custom_id: r.id, params: r.params })) });
    } catch (e) {
      fail(take, `batch create failed: ${String(e?.message || e).slice(0, 120)}`);
      return;
    }
    log(`draft batch ${batch.id}: ${take.length} request${take.length === 1 ? "" : "s"}`);
    const deadline = Date.now() + maxWaitMs;
    let status = batch.processing_status;
    while (status !== "ended") {
      if (Date.now() >= deadline) {
        await client.messages.batches.cancel(batch.id).catch(() => {});
        fail(take, `batch ${batch.id} not done in ${Math.round(maxWaitMs / 60000)} min`);
        return;
      }
      await sleepFn(pollMs);
      try { status = (await client.messages.batches.retrieve(batch.id)).processing_status; } catch { /* poll again */ }
    }
    const byId = new Map(take.map((r) => [r.id, r]));
    try {
      for await (const res of await client.messages.batches.results(batch.id)) {
        const r = byId.get(res.custom_id);
        if (!r) continue;
        byId.delete(res.custom_id);
        if (res.result?.type === "succeeded") r.resolve(res.result.message);
        else r.reject(Object.assign(new Error(`batch request ${res.result?.type || "failed"}`), { batch: true }));
      }
    } catch (e) {
      fail([...byId.values()], `batch results unreadable: ${String(e?.message || e).slice(0, 120)}`);
      return;
    }
    fail([...byId.values()], "missing from the batch results");
  }

  return {
    enqueue(params) {
      return new Promise((resolve, reject) => {
        queue.push({ id: `d${Date.now().toString(36)}-${(seq++).toString(36)}`, params, resolve, reject });
        if (queue.length >= maxSize) flush();
        else if (!timer) timer = setTimeout(flush, windowMs);
      });
    },
    pending: () => queue.length,
  };
}

// One batcher per API key: locations can carry their own.
const batchers = new Map();
export function batcherFor(aiApiKey) {
  const key = String(aiApiKey || "");
  if (!key) return null;
  if (!batchers.has(key)) batchers.set(key, createBatcher({ client: new Anthropic({ apiKey: key, timeout: 120_000 }) }));
  return batchers.get(key);
}
export function _resetBatchers() { batchers.clear(); }
