// routes/lot-finder.js — Autopilot → Lots: the luxury teardown lane's front
// end (ghl-broker/lot-finder.js, rules in shared/lot-finder.js).
//
//   GET  /api/lot-finder                 settings, counts per pocket, switches, last run
//   GET  /api/lot-finder/owners          { pocketId?, status?, limit? } → owner rows
//   GET  /api/lot-finder/answered        → owners who answered with no lot offer yet (the Luxury page)
//   POST /api/lot-finder/owners/:key/status   { status: skipped | do_not_contact | new }
//   POST /api/lot-finder/suggest         { address, radiusMiles? } → the pocket's numbers off Zillow
//   GET  /api/lot-finder/job             → { job, last }: the light read the tab polls during a run
//   POST /api/lot-finder/run             { dryRun, wait } → run the day now (the tab sends
//                                        wait:false and polls GET /job until last.id is this job's)
//
// Settings are saved through PATCH /api/offers/settings { lotFinder }. Nothing
// here sends a text: the run writes drafts, and they schedule themselves only
// when autoSend, CARD_SENDS_ENABLED and OWNER_SMS_ENABLED are all on.

import express from "express";
import { store } from "../store.js";
import { geocodeAddress } from "../geocode.js";
import { normalizeLotFinder, normalizePocket, OWNER_STATUSES } from "../shared/lot-finder.js";
import { startLotFinder, getLotFinderJob, scanPocketZillow, CURSOR_NAME, OWNER_SMS_ENABLED, traceKeyOf, propertyKeyOf, ownersWhoAnswered } from "../lot-finder.js";

const fail = (res, err) => res.status(err?.http || 500).json({ error: err?.message || String(err) });
const OUTREACH_IMPORTS_ENABLED = () => process.env.OUTREACH_IMPORTS_ENABLED === "true";
/**
 * discoverPocket({ address, radiusMiles, apifyToken, now }) → { center, suggest, newBuilds, teardowns }
 * The method's §1A–1C off Zillow for the Suggest button (lot-finder.js scanPocketZillow).
 */
export async function discoverPocket({ address, radiusMiles = 1, apifyToken, now = Date.now(), deps = {} }) {
  const geo = await (deps.geocode || geocodeAddress)(address, { minPrecision: "street" });
  if (!geo) throw Object.assign(new Error("couldn't place that address on the map"), { http: 400 });
  const scan = await scanPocketZillow({ lat: geo.lat, lng: geo.lng, radiusMiles, apifyToken, now, deps });
  return { center: { lat: geo.lat, lng: geo.lng }, suggest: scan.suggest, debug: scan.debug,
    newBuilds: scan.newBuilds.slice(0, 40).map(({ facts, ...b }) => ({ ...b, builder: facts?.description ? (facts.description.match(/built by ([^.,]{3,60})/i) || [])[1] || "" : "" })),
    teardowns: scan.teardowns.slice(0, 40) };
}

export default function createLotFinderRouter({ resolveLocation, getSettings = (loc) => store.getOfferSettings(loc), deps = {} } = {}) {
  const router = express.Router();

  router.get("/", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const saved = (await getSettings(locationId)) || {};
      const settings = normalizeLotFinder(saved.lotFinder);
      const rows = await store.listLotOwners(locationId, { limit: 20000 });
      const counts = {};
      for (const r of rows) {
        const c = counts[r.pocketId] || (counts[r.pocketId] = { total: 0 });
        c.total++;
        c[r.status] = (c[r.status] || 0) + 1;
      }
      const cursor = await store.getJobCursor(locationId, CURSOR_NAME).catch(() => null);
      const job = getLotFinderJob(locationId);
      res.json({
        settings, counts,
        switches: { ownerSms: OWNER_SMS_ENABLED(), imports: OUTREACH_IMPORTS_ENABLED(), sends: process.env.CARD_SENDS_ENABLED === "true",
          traceKey: Boolean(traceKeyOf(saved)), propertyKey: Boolean(propertyKeyOf(saved)), apifyToken: Boolean(String(saved.apifyToken || "").trim()) },
        last: cursor?.doc?.last || null, lastDaily: cursor?.doc?.lastDaily || null, failed: Boolean(cursor?.doc?.failed), error: cursor?.doc?.error || null,
        job: job ? { id: job.id, status: job.status, trigger: job.trigger, startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error } : null,
      });
    } catch (err) { fail(res, err); }
  });

  // The run's state and last result only, for the tab to poll while a run
  // goes: GET / reads every owner row, too heavy to ask for every few seconds.
  router.get("/job", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const cursor = await store.getJobCursor(locationId, CURSOR_NAME).catch(() => null);
      const job = getLotFinderJob(locationId);
      res.json({ last: cursor?.doc?.last || null,
        job: job ? { id: job.id, status: job.status, trigger: job.trigger, startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error } : null });
    } catch (err) { fail(res, err); }
  });

  router.get("/owners", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const pocketId = String(req.query.pocketId || "") || null;
      const status = OWNER_STATUSES.includes(String(req.query.status || "")) ? String(req.query.status) : null;
      const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 500));
      res.json({ owners: await store.listLotOwners(locationId, { pocketId, status, limit }) });
    } catch (err) { fail(res, err); }
  });

  // Cheap: one event read for the window, then an offer and a profile read per owner shown.
  router.get("/answered", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      res.json({ owners: await ownersWhoAnswered({ store, locationId }) });
    } catch (err) { fail(res, err); }
  });

  router.get("/builders", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const pocketId = String(req.query.pocketId || "") || null;
      const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 500));
      res.json({ builders: await store.listLotBuilders(locationId, { pocketId, limit }) });
    } catch (err) { fail(res, err); }
  });

  router.post("/owners/:key/status", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const status = String(req.body?.status || "");
      if (!["skipped", "do_not_contact", "new"].includes(status)) return res.status(400).json({ error: "status must be skipped, do_not_contact or new" });
      const ok = await store.setLotOwner(locationId, req.params.key, { status });
      if (!ok) return res.status(404).json({ error: "unknown owner" });
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });

  router.post("/suggest", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const saved = (await getSettings(locationId)) || {};
      const apifyToken = String(saved.apifyToken || "").trim();
      if (!apifyToken) return res.status(400).json({ error: "no Apify token in Settings: the pocket's numbers come off Zillow" });
      const address = String(req.body?.address || "").trim();
      if (!address) return res.status(400).json({ error: "address required" });
      const radiusMiles = normalizePocket({ radiusMiles: req.body?.radiusMiles }).radiusMiles;
      res.json(await discoverPocket({ address, radiusMiles, apifyToken, deps }));
    } catch (err) { fail(res, err); }
  });

  router.post("/run", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      if (getLotFinderJob(locationId)?.status === "running") throw Object.assign(new Error("a run is already going"), { http: 409 });
      const saved = (await getSettings(locationId)) || {};
      const dryRun = req.body?.dryRun === false ? null : true;
      const job = startLotFinder({ client, locationId, saved, store, sendsEnabled: process.env.CARD_SENDS_ENABLED === "true", deps, dryRun, trigger: "manual", rescan: req.body?.rescan === true });
      if (req.body?.wait) await job.done;
      res.json({ ok: true, job: { id: job.id, status: job.status, startedAt: job.startedAt, error: job.error,
        ...(job.result ? { dryRun: job.result.dryRun, pockets: job.result.pockets, traced: job.result.traced, imported: job.result.imported, texts: job.result.texts, rows: job.result.rows.slice(0, 100) } : {}) } });
    } catch (err) { fail(res, err); }
  });

  return router;
}
