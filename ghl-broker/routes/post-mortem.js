// routes/post-mortem.js — the post-mortem on a deal that fell through.
// Mounted at /api/offers beside the offers router; every path here is two
// segments or more under /:id, so the offers router's GET /:id never eats one.
//
//   POST /api/offers/:id/deal/postmortem     build it (202 + poll); ?refresh=1 re-reads the buyer threads
//   GET  /api/offers/:id/deal/postmortem     the stored post-mortem + the job, if one is running
//   PUT  /api/offers/:id/deal/postmortem     store a reading written by hand (body { analysis })
//
// The cross-deal lessons live at GET /api/dashboard/lessons.

import express from "express";
import { store } from "../store.js";
import { startPostMortem, getPostMortemJob, publicPostMortemJob } from "../post-mortem.js";

export default function createPostMortemRouter({ resolveLocation, feedbackFor = null, deps = {} }) {
  const router = express.Router();
  const fail = (res, err) => {
    const code = err.http || err.status || 500;
    if (code >= 500) console.error("post-mortem error:", code, err.message);
    res.status(code).json({ error: err.message });
  };
  async function load(req, res) {
    const { locationId, client } = resolveLocation(req);
    const offer = await store.getOffer(req.params.id);
    if (!offer || offer.locationId !== locationId) { res.status(404).json({ error: "no such offer" }); return null; }
    if (!offer.deal) { res.status(409).json({ error: "not a deal yet" }); return null; }
    return { locationId, client, offer };
  }

  router.post("/:id/deal/postmortem", async (req, res) => {
    try {
      const ctx = await load(req, res);
      if (!ctx) return;
      const job = startPostMortem({ ...ctx, store, deps: { feedbackFor, ...deps }, refresh: req.query.refresh === "1" });
      res.status(202).json({ ok: true, job: publicPostMortemJob(job) });
    } catch (err) { fail(res, err); }
  });

  router.get("/:id/deal/postmortem", async (req, res) => {
    try {
      const ctx = await load(req, res);
      if (!ctx) return;
      res.json({ ok: true, postMortem: ctx.offer.deal.postMortem || null, job: publicPostMortemJob(getPostMortemJob(ctx.offer.id)) });
    } catch (err) { fail(res, err); }
  });

  // A reading written by a person (or pasted from a session) replaces the
  // model's. The numbers and the quotes are rebuilt around it, so the page
  // never shows a hand-written cause beside stale arithmetic.
  router.put("/:id/deal/postmortem", async (req, res) => {
    try {
      const ctx = await load(req, res);
      if (!ctx) return;
      const analysis = req.body?.analysis;
      if (!analysis || typeof analysis !== "object") return res.status(400).json({ error: "body.analysis required" });
      const job = startPostMortem({ ...ctx, store, deps: { feedbackFor, ...deps }, refresh: false, analysis: { ...analysis, by: analysis.by || "operator" } });
      res.status(202).json({ ok: true, job: publicPostMortemJob(job) });
    } catch (err) { fail(res, err); }
  });

  return router;
}
