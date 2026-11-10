// needs-matt-busy-outbox.test.mjs — a held yes fell out of Needs Matt when a
// deal blast filled the outbox (FUP-02, 2026-11-09 audit).
//
// Today's read took the open drafts as one list, newest 500. A deal blast is
// hundreds of scheduled texts that wait days for each buyer's week, so the
// oldest held reply (an agent's yes) dropped out of the read: Needs Matt took
// the card out ("done"), its 72-hour clock restarted when it came back, and
// the GHL call queue took back the call. Held drafts are read on their own
// now, and a row missing from a read that hit its cap is unknown, not done.
//
// Real file store, the dashboard router's own read; GHL and the card sync
// are stubs.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "needs-matt-busy-outbox-test-"));
process.env.DATA_DIR = DIR;
delete process.env.DATABASE_URL;

const { store } = await import("./store.js");
const { default: createDashboardRouter } = await import("./routes/dashboard.js");
const { runNeedsMatt } = await import("./needs-matt.js");
await store.init();
test.after(async () => { await new Promise((r) => setTimeout(r, 120)); fs.rmSync(DIR, { recursive: true, force: true }); });

const LOC = "loc-busy-outbox";
const STAGES = [{ id: "s-nm", name: "Needs Matt" }, { id: "s-t1", name: "Tier 1 - Hot" }, { id: "s-t2", name: "Tier 2 - Warm" }, { id: "s-out", name: "Offer Out" }];
const ghl = {
  listPipelines: async () => [{ id: "acq", name: "Acquisitions", stages: STAGES }],
  call: async (p, { method = "GET" } = {}) => (method === "GET" && /\/customFields$/.test(p) ? { customFields: [] } : { succeeded: true }),
};
const router = createDashboardRouter({ resolveLocation: () => ({ locationId: LOC, client: ghl }) });
const sleep = (n) => new Promise((r) => setTimeout(r, n));

test("a held yes stays in Needs Matt while 520 deal texts are queued", async () => {
  await store.saveOfferSettings(LOC, { ghlStages: { mode: "on" } });
  const yes = await store.createReplyDraft({ locationId: LOC, contactId: "ana", contactName: "Ana Quill", party: "agent", status: "draft", intent: "acceptance",
    inbound: "The seller will take it", reply: "Great, I'll get the paperwork going.", propertyAddress: "5 Fern Ct, Kent, WA 98031" });
  await sleep(5);
  const soon = new Date(Date.now() + 3 * 86400000).toISOString();
  for (let i = 0; i < 520; i++) {
    await store.createReplyDraft({ locationId: LOC, contactId: `buyer-${i}`, contactName: `Buyer ${i}`, party: "investor", status: "scheduled", sendAt: soon,
      reply: "A fixer on Moss Rd, under contract.", outbound: { kind: "blast_open", offerId: "deal-1", address: "9 Moss Rd, Auburn, WA 98002" } });
  }
  const read = await router.pipelineFor({ locationId: LOC, client: ghl });
  assert.ok(read.drafts.some((d) => d.id === yes.id), "the held yes is in Today's read");
  assert.equal(read.capped?.held, false, "the held read didn't fill");
  const seen = [];
  const r = await runNeedsMatt({ store, locationId: LOC, client: ghl, ghl, saved: { ghlStages: { mode: "on" } },
    deps: { pipelineFor: router.pipelineFor, syncAgentCard: async (a) => { seen.push([a.contactId, a.needsMatt?.kind || null]); return { applied: { to: "Needs Matt" } }; } } });
  assert.equal(r.byKind.yes, 1);
  assert.deepEqual(seen, [["ana", "yes"]]);
});

test("a card isn't taken out of Needs Matt off a held-draft read that hit its cap", async () => {
  const loc = "loc-capped-read";
  const ANN = { id: "draft_waiting:d-ann", kind: "draft_waiting", contactId: "ann", draftId: "d-ann", address: "7 Sedge Ln, Kent, WA" };
  const DRAFT = { id: "d-ann", contactId: "ann", party: "agent", status: "draft", intent: "acceptance", createdAt: new Date().toISOString() };
  const seen = [];
  const sync = async (a) => { seen.push([a.contactId, a.needsMatt?.kind || null]); return { applied: {} }; };
  await runNeedsMatt({ store, locationId: loc, client: ghl, ghl, saved: { ghlStages: { mode: "on" } },
    deps: { pipelineFor: async () => ({ shownActions: [ANN], shownCalls: [], drafts: [DRAFT], capped: { held: false } }), syncAgentCard: sync } });
  assert.deepEqual(seen, [["ann", "yes"]]);
  // The next read came back full: Ann's draft isn't in it, and that proves nothing.
  const r = await runNeedsMatt({ store, locationId: loc, client: ghl, ghl, saved: { ghlStages: { mode: "on" } },
    deps: { pipelineFor: async () => ({ shownActions: [], shownCalls: [], drafts: [], capped: { held: true } }), syncAgentCard: sync } });
  assert.deepEqual(r.left, [], "unknown, not done");
  assert.deepEqual(seen, [["ann", "yes"]], "no card moved");
  assert.ok((await store.getJobCursor(loc, "needsMatt")).doc.needs.ann, "still on the list, with its clock");
  // A whole read without her: she leaves.
  const whole = await runNeedsMatt({ store, locationId: loc, client: ghl, ghl, saved: { ghlStages: { mode: "on" } },
    deps: { pipelineFor: async () => ({ shownActions: [], shownCalls: [], drafts: [], capped: { held: false } }), syncAgentCard: sync } });
  assert.deepEqual(whole.left, [{ contactId: "ann" }]);
});
