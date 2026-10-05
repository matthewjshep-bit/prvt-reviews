// desk-machine-rows.test.mjs — "The machine is on it" lists only what the
// machine will actually do, with when.
//
// What went wrong (2026-10-05): fourteen held 9311 12th Pl SE emails read
// "goes out at the 7pm check" though the check never sends a text the
// machine started and Settings held every one for a person; and two held
// underwrites sat there with nothing coming, because their one ask had
// been made and the sweep would never make it again.
//
//   node --test desk-machine-rows.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "desk-machine-rows-test-"));
delete process.env.DATABASE_URL;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createDashboardRouter } = await import("./routes/dashboard.js");

const LOC = "loc-desk-machine-rows";
const app = express();
app.use(express.json());
app.use("/api/dashboard", createDashboardRouter({ resolveLocation: () => ({ locationId: LOC, client: { call: async () => ({}) } }) }));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(() => server.close());

const H = 3600000;
const ago = (h) => new Date(Date.now() - h * H).toISOString();
const desk = async () => {
  const r = await (await fetch(`${B}/api/dashboard/pipeline`)).json();
  assert.equal(r.ok, true, r.error);
  return r.desk.rows;
};

test("an emailed deal held for you is not 'goes out at the 7pm check'; a held reply to their text still is", async () => {
  await store.saveOfferSettings(LOC, {});
  // The machine's own email to a buyer, held by Settings.
  const email = await store.createReplyDraft({ locationId: LOC, contactId: "buyer", contactName: "Chase N", party: "investor", channel: "email", status: "draft",
    inbound: "", intent: "blast_open", outbound: { kind: "blast_open", address: "9311 12th Pl SE, Lake Stevens, WA 98258" }, reply: "Got 9311 12th Pl SE under contract…",
    autoSendable: true, gateClean: true, flags: [], needsHuman: false, autoSend: { decided: false, reason: "emailed deals wait for you (Settings → Dispositions)" } });
  // A holding reply to something an agent said, held only for its intent.
  const reply = await store.createReplyDraft({ locationId: LOC, contactId: "agent", contactName: "Linda H", party: "agent", channel: "sms", status: "draft",
    inbound: "This is no longer Affordable Living.", intent: "other", reply: "Sorry about that, I'll take you off the list.",
    autoSendable: false, gateClean: true, flags: [], needsHuman: false, autoSend: { decided: false, reason: "a reply the bot couldn't place is a person's call" } });

  const rows = await desk();
  const emailRow = rows.find((r) => r.draftId === email.id);
  const replyRow = rows.find((r) => r.draftId === reply.id);
  assert.ok(emailRow && replyRow, "both are on the Desk");
  assert.equal(emailRow.section, "decide", "Settings holds it for you: it's yours");
  assert.notEqual(emailRow.next?.what, "goes out at the 7pm check");
  assert.equal(replyRow.section, "machine");
  assert.equal(replyRow.next?.what, "goes out at the 7pm check");
});

test("a held underwrite after its one ask says when it passes, or is a call when they answered without a number", async () => {
  const PHOTOS = "only 1 listing photo to scan — 4 required for a scope of work";
  const held = (contactId, address) => store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId, contactName: contactId, address, status: "draft",
    statusHistory: [], createdAt: ago(100), autoUnderwrite: { jobId: "j", held: [PHOTOS], finishedAt: ago(100) } });
  const waiting = await held("mallory", "13536 SW 171st St, Vashon, WA 98070");
  const calling = await held("chelsea", "3228 S 164th St, SeaTac, WA 98188");
  const passAt = new Date(Date.now() + 3 * 24 * H).toISOString();
  await store.setJobCursor(LOC, "conversationAudit", { doc: { last: { finishedAt: ago(14), counts: {}, acted: [], findings: [
    { id: "audit:held_waiting:mallory:x", kind: "held_waiting", severity: "fyi", contactId: "mallory", offerId: waiting.id, address: waiting.address,
      why: "asked 4d ago, waiting on their number", passAt, action: null, anchorAt: ago(100) },
    { id: "audit:held_call:chelsea:x", kind: "held_call", severity: "soon", contactId: "chelsea", offerId: calling.id, address: calling.address,
      why: "we asked what the work would run and they wrote back without a number — worth a call", action: null, anchorAt: ago(100) },
  ] } } });

  const rows = await desk();
  const w = rows.find((r) => r.offerId === waiting.id);
  const c = rows.find((r) => r.offerId === calling.id);
  assert.equal(w.section, "machine");
  assert.equal(w.next?.at, passAt, "it says when it passes");
  assert.match(w.next?.what || "", /passes unless they send a number/);
  assert.equal(c.section, "call");
  assert.match(c.detail, /without a number — worth a call/);
});
