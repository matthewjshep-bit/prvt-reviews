// routes/contacts.js — the contact record's own door.
//
//   GET  /api/contacts/:id/record         everything the app knows about one person
//   POST /api/contacts/:id/facts          an operator adds or removes facts; GHL is re-projected
//   POST /api/contacts/:id/events         an operator adds a note or a call summary
//   POST /api/contacts/backfill           fill the record from existing offers, deals, drafts, invites and GHL fields
//   GET  /api/contacts/backfill/status    the running or last job, plus the record's counts
//
// Same location gate as every other router. The record itself is written by
// ghl-broker/contact-record.js; this is the thin HTTP layer over it.

import express from "express";
import { store } from "../store.js";
import { getContactRecord, learnFacts, forgetFact, recordEvent, projectToGhl, reconcileFromGhl } from "../contact-record.js";
import { startContactBackfill, getBackfillJob, publicBackfillJob, cancelBackfill } from "../contact-backfill.js";
import { FACT_KEYS } from "../shared/contact-record.js";

const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);

export default function createContactsRouter({ resolveLocation }) {
  const router = express.Router();
  const fail = (res, err) => {
    const code = err.http || err.status || 500;
    if (code >= 500) console.error("contacts error:", code, err.message, err.detail || "");
    res.status(code).json({ error: err.message, detail: err.detail });
  };

  router.get("/:id/record", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const contactId = str(req.params.id, 64);
      const party = ["agent", "investor"].includes(req.query.party) ? req.query.party : null;
      // A pull reads the contact from GHL and lets it fill any gaps — on an
      // explicit ask, or the first time anyone opens a record that is empty.
      let pulled = null;
      const before = await store.getContactProfile(locationId, contactId).catch(() => null);
      if (req.query.pull === "1" || !before) {
        pulled = await reconcileFromGhl({ store, locationId, contactId, party, client });
      }
      const record = await getContactRecord({ store, locationId, contactId, party });
      res.json({ ok: true, ...record, pulled });
    } catch (err) { fail(res, err); }
  });

  router.post("/:id/facts", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const contactId = str(req.params.id, 64);
      const party = ["agent", "investor"].includes(req.body?.party) ? req.body.party : null;
      const add = (Array.isArray(req.body?.add) ? req.body.add : []).filter((f) => f && FACT_KEYS[f.key]).slice(0, 50)
        .map((f) => ({ key: f.key, value: str(f.value, 300), source: "operator", ref: "drawer" }));
      const remove = (Array.isArray(req.body?.remove) ? req.body.remove : []).filter((f) => f && FACT_KEYS[f.key]).slice(0, 50);
      if (!add.length && !remove.length) return res.status(400).json({ error: "nothing to change" });
      const touched = new Set();
      for (const f of remove) { await forgetFact({ store, locationId, contactId, party, key: f.key, value: str(f.value, 300), ref: "drawer" }); touched.add(f.key); }
      const learned = add.length ? await learnFacts({ store, locationId, contactId, party, facts: add }) : { added: [] };
      for (const a of learned.added) touched.add(a.key);
      // A removal must be able to blank the field it emptied — that is the
      // one case the digest is allowed to shrink.
      const projected = await projectToGhl({ client, store, locationId, contactId, party, keys: [...touched], blankIfEmpty: remove.length > 0 });
      const record = await getContactRecord({ store, locationId, contactId, party });
      res.json({ ok: true, added: learned.added, removed: remove.length, projected, ...record });
    } catch (err) { fail(res, err); }
  });

  router.post("/:id/events", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const contactId = str(req.params.id, 64);
      const type = ["note", "call_summary", "text_summary"].includes(req.body?.type) ? req.body.type : "note";
      const text = str(req.body?.text, 2000);
      if (!text) return res.status(400).json({ error: "text required" });
      const at = req.body?.at && Number.isFinite(Date.parse(req.body.at)) ? new Date(req.body.at).toISOString() : new Date().toISOString();
      const r = await recordEvent({
        store, locationId, contactId, party: ["agent", "investor"].includes(req.body?.party) ? req.body.party : null,
        type, at, address: str(req.body?.address, 200), offerId: str(req.body?.offerId, 64) || null,
        source: type === "call_summary" ? "call" : "operator", ref: null, dedupeKey: null,
        data: type === "note" ? { text } : { summary: text },
      });
      res.json({ ok: true, event: r.event });
    } catch (err) { fail(res, err); }
  });

  router.post("/backfill", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const sources = Array.isArray(req.body?.sources) ? req.body.sources.filter((s) => ["app", "ghl"].includes(s)) : ["app", "ghl"];
      const maxContacts = Math.min(20000, Math.max(1, Number(req.body?.maxContacts) || 5000));
      const job = startContactBackfill({ client, locationId, store, sources: sources.length ? sources : ["app", "ghl"], maxContacts });
      res.status(202).json({ ok: true, job: publicBackfillJob(job) });
    } catch (err) { fail(res, err); }
  });
  router.post("/backfill/cancel", async (req, res) => {
    try { const { locationId } = resolveLocation(req); res.json({ ok: true, stopping: cancelBackfill(locationId) }); }
    catch (err) { fail(res, err); }
  });
  router.get("/backfill/status", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const stats = await store.contactRecordStats(locationId).catch(() => null);
      res.json({ ok: true, job: publicBackfillJob(getBackfillJob(locationId)), stats });
    } catch (err) { fail(res, err); }
  });

  return router;
}
