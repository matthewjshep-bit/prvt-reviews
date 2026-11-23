// routes/lot-finder.js — Autopilot → Lots: the luxury teardown lane's front
// end (ghl-broker/lot-finder.js, rules in shared/lot-finder.js).
//
//   GET  /api/lot-finder                 settings, counts per pocket, switches, last run
//   GET  /api/lot-finder/owners          { pocketId?, status?, limit? } → owner rows
//   POST /api/lot-finder/owners/:key/status   { status: skipped | do_not_contact | new }
//   POST /api/lot-finder/suggest         { address, radiusMiles? } → the pocket's numbers off Zillow
//   POST /api/lot-finder/run             { dryRun, wait } → run the day now
//
// Settings are saved through PATCH /api/offers/settings { lotFinder }. Nothing
// here sends a text: the run writes drafts, and they schedule themselves only
// when autoSend, CARD_SENDS_ENABLED and OWNER_SMS_ENABLED are all on.

import express from "express";
import { store } from "../store.js";
import { geocodeAddress } from "../geocode.js";
import { soldSearchUrl, searchRows, normalizeRow, mergeFacts } from "../comps-zillow.js";
import { fetchZillowFacts } from "../rehab-scan.js";
import { normalizeLotFinder, normalizePocket, suggestPocket, OWNER_STATUSES } from "../shared/lot-finder.js";
import { startLotFinder, getLotFinderJob, CURSOR_NAME, OWNER_SMS_ENABLED, traceKeyOf, propertyKeyOf } from "../lot-finder.js";

const fail = (res, err) => res.status(err?.http || 500).json({ error: err?.message || String(err) });
const OUTREACH_IMPORTS_ENABLED = () => process.env.OUTREACH_IMPORTS_ENABLED === "true";
const NEW_BUILD_YEARS = 3;
const SEARCH_LIMIT = 80;

/**
 * discoverPocket({ address, radiusMiles, apifyToken, now }) → { center, suggest, newBuilds, teardowns }
 *
 * The method's §1A–1C off Zillow: the new builds that sold nearby (the
 * builders' exits, with their lots), and the older houses that sold in the
 * same box (what builders paid for the lot). Two sold searches plus one
 * detail batch for year built and lot size; the comps cache makes a second
 * look at the same box free for a day.
 */
export async function discoverPocket({ address, radiusMiles = 1, apifyToken, now = Date.now(), deps = {} }) {
  const geo = await (deps.geocode || geocodeAddress)(address, { minPrecision: "street" });
  if (!geo) throw Object.assign(new Error("couldn't place that address on the map"), { http: 400 });
  const year = new Date(now).getFullYear();
  const search = deps.searchRows || searchRows;
  const facts = deps.fetchZillowFacts || fetchZillowFacts;
  const rowsOf = async (url, what) => (await search(url, SEARCH_LIMIT, apifyToken, what)).map(normalizeRow).filter((r) => r.price > 0);
  const [nb, old] = await Promise.all([
    rowsOf(soldSearchUrl({ lat: geo.lat, lng: geo.lng, radiusMiles, monthsBack: 36, builtMin: year - NEW_BUILD_YEARS, priceMin: 1000000 }), "Zillow new-build lookup"),
    rowsOf(soldSearchUrl({ lat: geo.lat, lng: geo.lng, radiusMiles, monthsBack: 24, builtMax: year - 20 }), "Zillow teardown lookup"),
  ]);
  const detail = await facts([...nb, ...old].map((r) => r.address), apifyToken).catch(() => new Map());
  const withFacts = (rows) => mergeFacts(rows, detail);
  // Re-applied in code: Zillow ignores filter keys it doesn't know.
  const newBuilds = withFacts(nb).filter((r) => (r.yearBuilt || 0) >= year - NEW_BUILD_YEARS && r.price >= 1000000)
    .map((r) => ({ address: r.address, price: r.price, saleDate: r.saleDate, lotSqft: r.lotSqft || 0, sqft: r.sqft || 0, yearBuilt: r.yearBuilt || 0 }));
  const teardowns = withFacts(old).filter((r) => r.yearBuilt > 0 && r.yearBuilt <= year - 20)
    .map((r) => ({ address: r.address, price: r.price, saleDate: r.saleDate, lotSqft: r.lotSqft || 0, sqft: r.sqft || 0, yearBuilt: r.yearBuilt }));
  const suggest = suggestPocket({ newBuilds, teardowns });
  return { center: { lat: geo.lat, lng: geo.lng }, suggest, newBuilds: newBuilds.slice(0, 40), teardowns: teardowns.filter((t) => !suggest.lotSqftMin || t.lotSqft >= suggest.lotSqftMin).slice(0, 40) };
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
        job: job ? { status: job.status, trigger: job.trigger, startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error } : null,
      });
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
      const job = startLotFinder({ client, locationId, saved, store, sendsEnabled: process.env.CARD_SENDS_ENABLED === "true", deps, dryRun, trigger: "manual" });
      if (req.body?.wait) await job.done;
      res.json({ ok: true, job: { status: job.status, startedAt: job.startedAt, error: job.error,
        ...(job.result ? { dryRun: job.result.dryRun, pockets: job.result.pockets, traced: job.result.traced, imported: job.result.imported, texts: job.result.texts, rows: job.result.rows.slice(0, 100) } : {}) } });
    } catch (err) { fail(res, err); }
  });

  return router;
}
