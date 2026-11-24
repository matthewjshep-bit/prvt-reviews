// routes/lane-breaker.js — the lane breaker's strip on the Offers page
// (ghl-broker/lane-breaker.js, rules in shared/lane-breaker.js).
//
//   GET  /api/lane-breaker          { enabled, trips: [{ kind, label, at, rule, why, held, counts }], last, history }
//   POST /api/lane-breaker/clear    { kind } → { cleared, kind, released }
//
// Clearing lets that kind of text go by itself again and judges it afresh
// from now. The drafts it held lose the breaker's flag and stay drafts:
// nothing here schedules or sends a text. The switch itself is
// conversationAi.laneBreaker.enabled, saved through the settings.

import express from "express";
import { store as defaultStore } from "../store.js";
import { clearLane, laneBreakerStatus } from "../lane-breaker.js";
import { LANE_KINDS } from "../shared/lane-breaker.js";

const fail = (res, err) => res.status(err?.http || 500).json({ error: err?.message || String(err) });

export default function createLaneBreakerRouter({ resolveLocation, store = defaultStore, getSettings = (loc) => store.getOfferSettings(loc) } = {}) {
  const router = express.Router();

  router.get("/", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const saved = (await getSettings(locationId)) || {};
      res.json(await laneBreakerStatus({ store, locationId, saved }));
    } catch (err) { fail(res, err); }
  });

  router.post("/clear", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const kind = String(req.body?.kind || "").trim();
      if (!LANE_KINDS.includes(kind)) return res.status(400).json({ error: "which lane? kind must be one the breaker watches" });
      const r = await clearLane({ store, locationId, kind });
      console.log(`lane breaker ${locationId}: ${kind} cleared by hand (${r.released} held draft(s) unflagged, none sent)`);
      res.json({ ok: true, ...r });
    } catch (err) { fail(res, err); }
  });

  return router;
}
