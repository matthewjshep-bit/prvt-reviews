// our-no.test.mjs — a person's "we can't get there" on a counter is our pass.
//
// 2026-10-04: three houses sat on the Desk as counters to call about after
// Matt had texted each agent "We cant get there unfortunately". Matt: "we
// should mark as we passed and move on".
//
//   node --test our-no.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "our-no-test-"));
delete process.env.DATABASE_URL;
delete process.env.CARD_SENDS_ENABLED;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");
const { weDecline } = await import("./shared/offer-status.js");

const LOC = "loc-our-no";
// The thread for the look back: their counter, then Matt's no typed in GHL.
const client = { call: async (p) => {
  if (String(p).startsWith("/conversations/search")) return { conversations: [{ id: "cv1", contactId: "gabe" }] };
  if (String(p).includes("/conversations/cv1/messages")) return { messages: { messages: [
    { id: "m2", direction: "outbound", messageType: "TYPE_SMS", source: "app", userId: "u1", body: "We cant get there unfortunately let me know if it falls through", dateAdded: "2026-10-02T16:32:00Z" },
    { id: "m1", direction: "inbound", messageType: "TYPE_SMS", body: "I have a new offer at 750k, can you do better?", dateAdded: "2026-10-02T14:52:00Z" },
  ], nextPage: false } };
  return {};
} };
const app = express();
app.use(express.json());
const router = createOffersRouter({ resolveLocation: () => ({ locationId: LOC, client }), uploadDir: process.env.DATA_DIR });
app.use("/api/offers", router);
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(() => server.close());

const counteredOffer = (over = {}) => store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "gabe", contactName: "Gabe S", address: "100 Bagley Ave N, Seattle, WA 98103",
  status: "countered", cashAmount: 732429, statusHistory: [], createdAt: "2026-08-30T00:00:00Z", sends: [{ ts: "2026-08-30T22:15:00Z" }],
  counter: { amount: 750000, at: "2026-10-02T14:53:00Z" }, ...over });

test("when you text 'we can't get there' on a counter, the house is ours to pass", async () => {
  const o = await counteredOffer();
  const r = await router.passOnOurNo({ locationId: LOC, client, contactId: "gabe", text: "We cant get there unfrotunatly let me know if it falls through", at: "2026-10-02T16:32:00Z", via: "typed in GHL" });
  assert.equal(r?.offerId, o.id);
  const after = await store.getOffer(o.id);
  assert.equal(after.status, "we_passed");
  assert.match(after.statusNote || after.statusHistory.at(-1)?.note || "", /you texted "cant get there"/);
  // A hold is not a pass, and a showing time is not a price.
  const o2 = await counteredOffer({ contactId: "bee", address: "8 186th St Ct E, Puyallup, WA 98375" });
  assert.equal(await router.passOnOurNo({ locationId: LOC, client, contactId: "bee", text: "Best we can do is 259.6k, if they get there we're ready" }), null);
  assert.equal(await router.passOnOurNo({ locationId: LOC, client, contactId: "bee", text: "I can't get there till 5, can we push the walkthrough?" }), null);
  assert.equal((await store.getOffer(o2.id)).status, "countered");
  // No counter on the table: nothing to pass.
  const o3 = await counteredOffer({ contactId: "kel", status: "sent", counter: null, address: "1 Sent St, Kent, WA 98030" });
  assert.equal(await router.passOnOurNo({ locationId: LOC, client, contactId: "kel", text: "we can't get there" }), null);
  assert.equal((await store.getOffer(o3.id)).status, "sent");
});

test("the look back finds a no already texted on a live counter, and a dry run changes nothing", async () => {
  const o = await counteredOffer();
  const dry = await (await fetch(`${B}/api/offers/passes/our-no`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  assert.equal(dry.ok, true, dry.error);
  assert.equal(dry.dryRun, true);
  const hit = dry.found.find((f) => f.offerId === o.id);
  assert.equal(hit?.phrase, "cant get there");
  assert.equal(hit?.via, "typed in GHL");
  assert.equal((await store.getOffer(o.id)).status, "countered");
  const live = await (await fetch(`${B}/api/offers/passes/our-no`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dryRun: false }) })).json();
  assert.ok(live.found.some((f) => f.offerId === o.id));
  assert.equal((await store.getOffer(o.id)).status, "we_passed");
});

test("a 'no' about another house, an old counter, an email, or a hot offer passes nothing", async () => {
  const fresh = (over) => counteredOffer({ contactId: `x${Math.random().toString(36).slice(2, 7)}`, counter: { amount: 750000, at: new Date(Date.now() - 86400000).toISOString() }, ...over });
  // Names a different house than the one countered.
  const a = await fresh({ address: "3831 Bagley Ave N, Seattle, WA 98103" });
  assert.equal(await router.passOnOurNo({ locationId: LOC, client, contactId: a.contactId, text: "We can't get there on 1210 Pine unfortunately" }), null);
  // Names it: passes.
  assert.ok(await router.passOnOurNo({ locationId: LOC, client, contactId: a.contactId, text: "On 3831 Bagley we can't get there unfortunately" }));
  // A counter from two months ago.
  const b = await fresh({ counter: { amount: 750000, at: new Date(Date.now() - 60 * 86400000).toISOString() } });
  assert.equal(await router.passOnOurNo({ locationId: LOC, client, contactId: b.contactId, text: "we can't get there" }), null);
  // By email (quoted history rides under it).
  const c = await fresh({});
  assert.equal(await router.passOnOurNo({ locationId: LOC, client, contactId: c.contactId, text: "we can't get there", channel: "email" }), null);
  // Flagged hot by you.
  const d = await fresh({ hot: { at: new Date().toISOString(), by: "operator" } });
  assert.equal(await router.passOnOurNo({ locationId: LOC, client, contactId: d.contactId, text: "we can't get there" }), null);
});

test("we decline in a person's words, not in a hold or a showing time", () => {
  for (const no of ["We'll pass it on to my partner and get back to you", "We will pass that along to our contractor", "we will pass by the house later",
    "can't get there by Friday", "Can't get there this weekend", "not going to work for us to close in 10 days", "We'll pass on the info to the seller"]) {
    assert.equal(weDecline(no), null, no);
  }
  assert.equal(weDecline("We cant get there unfrotunatly let me know if it falls through"), "cant get there");
  assert.equal(weDecline("Understood. We cant get there unfortunately. Lets keep in touch"), "cant get there");
  assert.equal(weDecline("we're too far apart on this one"), "too far apart");
  assert.equal(weDecline("We'll pass on the Port Orchard home"), "we'll pass");
  assert.equal(weDecline("Best we can do is 450"), null);
  assert.equal(weDecline("Can't get there today, tomorrow at noon?"), null);
});
