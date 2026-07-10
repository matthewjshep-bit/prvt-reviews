// routes/studio.js — Card Studio endpoints the editor needs beyond template
// CRUD: live custom fields, render preview (proxied to cardgen), asset upload,
// and the provider catalog/test proxy. Grows across phases 3/5/6/8.

import express from "express";
import multer from "multer";
import sharp from "sharp";
import path from "node:path";
import { listCustomFields, getContact } from "../ghl.js";
import { store } from "../store.js";
import { uploadAsset } from "../r2.js";
import { resolveConnectionsFor, resolveConnectionById } from "../connections.js";
import { flatToContext, resolveBindings } from "../../shared/bindings.js";

const CARD_SERVICE_URL = (process.env.CARD_SERVICE_URL || "").replace(/\/$/, "");

// 5-minute cache for custom-field definitions.
const cfCache = new Map();
const CF_TTL = 5 * 60 * 1000;

export default function createStudioRouter({ resolveLocation, uploadDir, publicBaseUrl }) {
  const router = express.Router();
  const fail = (res, err) => {
    const code = err.http || err.status || 500;
    if (code >= 500) console.error("studio error:", code, err.message);
    res.status(code).json({ error: err.message, detail: err.detail || err.data });
  };
  const needCardgen = () => {
    if (!CARD_SERVICE_URL) throw Object.assign(new Error("CARD_SERVICE_URL not configured"), { http: 500 });
  };

  /* ---------- GET /api/locations/:id/custom-fields ---------- */
  router.get("/locations/:id/custom-fields", async (req, res) => {
    try {
      // Path :id must match the authenticated location.
      req.query.location_id = req.params.id;
      const { locationId, client } = resolveLocation(req);
      const cached = cfCache.get(locationId);
      if (cached && Date.now() - cached.ts < CF_TTL) return res.json({ customFields: cached.data });
      const fields = await listCustomFields(client, locationId);
      cfCache.set(locationId, { ts: Date.now(), data: fields });
      res.json({ customFields: fields });
    } catch (err) {
      fail(res, err);
    }
  });

  /* ---------- POST /api/render/preview ---------- */
  // body: { template, sampleData }  → live Sharp render (no store), returns PNG.
  router.post("/render/preview", async (req, res) => {
    try {
      needCardgen();
      const { locationId } = resolveLocation(req);
      const { template, sampleData = {} } = req.body || {};
      if (!template) return res.status(400).json({ error: "template required" });
      template.locationId = locationId;

      const context = flatToContext(sampleData);
      const resolveProviders = Array.isArray(template.dataSources) && template.dataSources.length > 0;
      const connections = await resolveConnectionsFor(template, locationId); // {} until phase 6

      const r = await fetch(`${CARD_SERVICE_URL}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template, context, resolveProviders, connections, store: false, format: "png" }),
      });
      if (!r.ok) {
        const t = await r.text();
        return res.status(502).json({ error: "cardgen_preview_failed", detail: t.slice(0, 300) });
      }
      res.set("Content-Type", r.headers.get("content-type") || "image/png");
      res.set("Cache-Control", "no-store");
      res.set("X-Missing-Bindings", r.headers.get("x-missing-bindings") || "[]");
      res.set("X-Warnings", r.headers.get("x-warnings") || "[]");
      const buf = Buffer.from(await r.arrayBuffer());
      res.send(buf);
    } catch (err) {
      fail(res, err);
    }
  });

  /* ---------- GET /api/providers (catalog proxy) ---------- */
  router.get("/providers", async (_req, res) => {
    try {
      needCardgen();
      const r = await fetch(`${CARD_SERVICE_URL}/providers`);
      res.status(r.status).json(await r.json());
    } catch (err) {
      fail(res, err);
    }
  });

  /* ---------- POST /api/providers/:id/test ---------- */
  // body: { inputs (binding exprs), options, sampleData, connectionId? }
  router.post("/providers/:id/test", async (req, res) => {
    try {
      needCardgen();
      const { locationId } = resolveLocation(req);
      const { inputs = {}, options = {}, sampleData = {}, connectionId, targetPx } = req.body || {};
      const context = flatToContext(sampleData);
      const resolvedInputs = {};
      for (const [k, expr] of Object.entries(inputs)) resolvedInputs[k] = resolveBindings(expr, context).value;
      const connection = connectionId ? await resolveConnectionById(connectionId, locationId) : undefined;

      const r = await fetch(`${CARD_SERVICE_URL}/providers/${encodeURIComponent(req.params.id)}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: resolvedInputs, options, connection, locationId, targetPx, context }),
      });
      const out = await r.json();
      // Persist last test result so the editor is useful on reload.
      if (out.ok) {
        await store.saveDataSourceTest({
          locationId, templateId: req.body.templateId || null, sourceId: req.body.sourceId || req.params.id,
          discoveredKeys: out.keys || [], data: out.data || {}, thumbnailUrl: out.imageUrl || null,
        });
      }
      res.status(r.status).json(out);
    } catch (err) {
      fail(res, err);
    }
  });

  /* ---------- POST /api/assets/upload ---------- */
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
  router.post("/assets/upload", upload.single("file"), async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      if (!req.file) return res.status(400).json({ error: "no image file" });
      if (!/^image\/(png|jpe?g|webp)$/i.test(req.file.mimetype))
        return res.status(400).json({ error: "only PNG/JPG/WebP allowed" });

      // Normalise + strip EXIF (sharp drops metadata unless asked to keep it).
      const isPng = /png/i.test(req.file.mimetype);
      const pipe = sharp(req.file.buffer).rotate(); // auto-orient, then metadata is dropped
      const out = isPng ? await pipe.png().toBuffer() : await pipe.jpeg({ quality: 90 }).toBuffer();
      const ext = isPng ? "png" : "jpg";
      const key = `assets/${locationId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

      const url = await uploadAsset(key, out, isPng ? "image/png" : "image/jpeg", {
        localDir: uploadDir,
        localBaseUrl: `${publicBaseUrl}/uploads`,
      });
      await store.createAsset({ locationId, r2Key: key, url, contentType: isPng ? "image/png" : "image/jpeg", bytes: out.length });
      res.json({ url });
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
