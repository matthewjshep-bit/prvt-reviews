// dispo-waves.test.mjs — a deal's buyer waves: who has it, who's next.
//
// What went wrong (2026-09-29): "already blasted" read only the blast_sent
// events, which are written when a text actually leaves. With the investor
// allowlist off, wave 1 sits in the outbox as drafts, so wave 2 picked the
// same buyers again and superseded their first draft with a second.
//
//   node --test dispo-waves.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dispo-waves-test-"));
delete process.env.DATABASE_URL;

const { store } = await import("./store.js");
const { recordEvent } = await import("./contact-record.js");
const { default: createDispoRouter } = await import("./routes/dispo.js");

const LOC = "LOC-waves";
const app = express();
app.use(express.json());
app.use("/api/dispo", createDispoRouter({ resolveLocation: () => ({ locationId: LOC, client: null }) }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/dispo`;
test.after(() => server.close());

const HOUR = 3600000;
const buyer = (contactId) => ({
  contactId, name: `Buyer ${contactId}`,
  doc: { name: `Buyer ${contactId}`, phone: "+12065550199", tags: ["investor"], custom: { buybox_areas: "Kent" } },
  buyboxText: "",
});

test("the wave preview shows the next wave, and never offers a buyer whose wave-1 text is still waiting", async () => {
  await store.saveOfferSettings(LOC, { dispoAutopilot: { autoBlastOnPromote: true, secondWaveMinScore: 0, minMatchScore: 0 } });
  await store.upsertInvestors(LOC, ["b-waiting", "b-sent", "b-new"].map(buyer));
  const offer = await store.createOffer({
    id: crypto.randomUUID(), locationId: LOC, contactId: "agent-1", address: "123 Main St, Kent, WA 98031", cashAmount: 300000, status: "accepted",
    statusHistory: [],
    deal: { stage: "under_contract", investors: [], stageHistory: [], createdAt: new Date(Date.now() - 80 * HOUR).toISOString(),
      // A wave from before contactIds were kept: only the drafts and the sends say who had it.
      blasts: [{ at: new Date(Date.now() - 50 * HOUR).toISOString(), count: 2, via: "app", wave: 1 }] },
  });
  await store.createReplyDraft({ locationId: LOC, contactId: "b-waiting", status: "draft", party: "investor",
    outbound: { kind: "blast_open", offerId: offer.id, address: offer.address }, reply: "", createdAt: new Date().toISOString() });
  await recordEvent({ store, locationId: LOC, contactId: "b-sent", party: "investor", type: "blast_sent", at: new Date(Date.now() - 49 * HOUR).toISOString(),
    offerId: offer.id, address: offer.address, source: "blast", dedupeKey: `blast:${offer.id}:b-sent`, data: {} });

  const r = await (await fetch(`${base}/waves/preview?offerId=${offer.id}`)).json();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.next.wave, 2);
  assert.equal(r.next.due, true);
  assert.deepEqual(r.waves.map((w) => [w.wave, w.count]), [[1, 2]]);
  assert.deepEqual(r.wouldGet.map((i) => i.contactId), ["b-new"], JSON.stringify(r.wouldGet));
  assert.equal(r.alreadySent, 2);

  const missing = await fetch(`${base}/waves/preview?offerId=nope`);
  assert.equal(missing.status, 404);
});

test("a mobile home's wave goes to the buyers who buy them, by email when there's no phone, and skips anyone it already went to", async () => {
  // 1510 Maple Lane, Kent (2026-10-01): promoted, and the wave went to Kent
  // flippers; the mobile home buyers — mostly email only, mostly no area on
  // file, eighteen already emailed by a script that left only the deal's tag —
  // were never in it.
  const loc = "LOC-mobile";
  const app2 = express();
  app2.use(express.json());
  app2.use("/api/dispo", createDispoRouter({ resolveLocation: () => ({ locationId: loc, client: null }) }));
  const srv = app2.listen(0);
  const base2 = `http://127.0.0.1:${srv.address().port}/api/dispo`;
  try {
    await store.saveOfferSettings(loc, { dispoAutopilot: { autoBlastOnPromote: true, secondWaveMinScore: 35, minMatchScore: 50 } });
    const row = (contactId, doc) => ({ contactId, name: contactId, doc: { name: contactId, tags: ["investor"], custom: {}, ...doc }, buyboxText: "" });
    await store.upsertInvestors(loc, [
      row("kent-flipper", { phone: "+12065550101", tags: ["investor", "dispo-city-kent", "dispo-region-south-king", "dispo-type-flip"] }),
      row("mh-texter", { phone: "+12065550102", tags: ["investor", "dispo-type-mobile-home"] }),
      row("mh-emailer", { email: "mh@example.com", tags: ["investor", "dispo-type-mobile-home", "dispo-source-fb-warei"] }),
      row("mh-emailed-already", { email: "done@example.com", tags: ["investor", "dispo-type-mobile-home", "dispo-1510-maple-lane"] }),
      row("mh-no-parks", { phone: "+12065550103", tags: ["investor", "dispo-type-mobile-home"], custom: { buybox_exclusions: "no manufactured homes in parks" } }),
    ]);
    const offer = await store.createOffer({
      id: crypto.randomUUID(), locationId: loc, contactId: "agent-2", address: "1510 Maple Lane, Kent, Washington 98030", cashAmount: 71075, status: "accepted",
      statusHistory: [],
      asset: { type: "manufactured", land: "park", by: "you" },
      snapshot: { subjectInfo: { homeType: "MANUFACTURED", beds: 3, baths: 2, sqft: 1440 } },
      deal: { stage: "under_contract", investors: [], stageHistory: [], contractPrice: 71075, assignmentFee: 5000,
        createdAt: new Date(Date.now() - 80 * HOUR).toISOString(), blastTags: ["dispo-1510-maple-lane"],
        blasts: [{ at: new Date(Date.now() - 50 * HOUR).toISOString(), count: 0, via: "app", wave: 1, contactIds: [] }] },
    });
    const r = await (await fetch(`${base2}/waves/preview?offerId=${offer.id}`)).json();
    assert.equal(r.ok, true, r.error);
    assert.equal(r.asset.type, "manufactured");
    assert.deepEqual(r.wouldGet.map((i) => [i.contactId, i.channel]).sort(), [["mh-emailer", "email"], ["mh-texter", "sms"]], JSON.stringify(r.wouldGet));
    assert.equal(r.alreadySent, 1, "the buyer carrying the deal's tag already has it");
  } finally { srv.close(); }
});
