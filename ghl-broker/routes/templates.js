// routes/templates.js — Card Studio template CRUD.
//   GET    /api/templates?location_id=      list (summaries + full docs)
//   POST   /api/templates                   create (zod-validated)
//   GET    /api/templates/:id               fetch one
//   PUT    /api/templates/:id               save → version++
//   DELETE /api/templates/:id               delete
//
// Location scoping: every template carries a locationId; a request may only
// touch templates belonging to the location it authenticated as. Combined with
// the broker's single-tenant ALLOWED_LOCATION guard this prevents cross-tenant
// access even before per-location tokens land.

import express from "express";
import { store } from "../store.js";
import { getConfig } from "../ghl.js";
import { TemplateInputSchema } from "../../shared/template-schema.js";
import { reviewRequestStarter } from "../../shared/starters.js";

export default function createTemplatesRouter({ resolveLocation }) {
  const router = express.Router();

  const fail = (res, err) => {
    const code = err.http || err.status || 500;
    if (code >= 500) console.error("templates error:", code, err.message);
    res.status(code).json({ error: err.message, detail: err.detail });
  };

  // Validate a template body and force its locationId to the authenticated one.
  // Strip transport-only / server-managed keys the strict schema won't accept.
  function validateBody(req, locationId) {
    const { location_id, id, version, createdAt, updatedAt, ...body } = req.body || {};
    const parsed = TemplateInputSchema.safeParse({ ...body, locationId });
    if (!parsed.success) {
      const e = new Error("invalid template");
      e.http = 400;
      e.detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      throw e;
    }
    return parsed.data;
  }

  // Ensure the row exists AND belongs to this location.
  async function ownedOr404(id, locationId) {
    const doc = await store.getTemplate(id);
    if (!doc || doc.locationId !== locationId) {
      throw Object.assign(new Error("template not found"), { http: 404 });
    }
    return doc;
  }

  router.get("/", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      let templates = await store.listTemplates(locationId);
      // First open for this location: auto-migrate the legacy saved image
      // settings into a Review Request template so nothing regresses.
      if (templates.length === 0) {
        const seeded = await seedFromLegacy(client, locationId);
        if (seeded) templates = [seeded];
      }
      res.json({ templates });
    } catch (err) {
      fail(res, err);
    }
  });

  async function seedFromLegacy(client, locationId) {
    let legacy = {};
    try {
      legacy = await getConfig(client, locationId); // GHL custom values
    } catch {
      /* dev / no GHL — seed a plain starter */
    }
    const doc = reviewRequestStarter({
      locationId,
      logoUrl: legacy.logoUrl || "",
      cardFit: legacy.cardFit || "cover",
      cardBgColor: legacy.cardBgColor || "#0b0b0c",
      cardHeadline: legacy.cardHeadline || "",
      cardAccent: legacy.cardAccent || "#ffffff",
      cardNameX: legacy.cardNameX != null && legacy.cardNameX !== "" ? parseFloat(legacy.cardNameX) : 0.5,
      cardNameY: legacy.cardNameY != null && legacy.cardNameY !== "" ? parseFloat(legacy.cardNameY) : 0.7,
    });
    const parsed = TemplateInputSchema.safeParse(doc);
    if (!parsed.success) return null;
    return store.createTemplate(parsed.data);
  }

  router.post("/", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const doc = validateBody(req, locationId);
      res.status(201).json({ template: await store.createTemplate(doc) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get("/:id", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      res.json({ template: await ownedOr404(req.params.id, locationId) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.put("/:id", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      await ownedOr404(req.params.id, locationId);
      const doc = validateBody(req, locationId);
      res.json({ template: await store.updateTemplate(req.params.id, doc) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete("/:id", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      await ownedOr404(req.params.id, locationId);
      res.json({ ok: await store.deleteTemplate(req.params.id) });
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
