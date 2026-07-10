// routes/connections.js — location-scoped connection CRUD. Secrets are
// write-only: create encrypts and stores; list/get never return the secret.
//   GET    /api/connections?location_id=
//   POST   /api/connections   { name, provider, type, secret:{headers|token|webhookUrl} }
//   DELETE /api/connections/:id

import express from "express";
import { store } from "../store.js";
import { encrypt, encryptionEnabled } from "../crypto.js";

export default function createConnectionsRouter({ resolveLocation }) {
  const router = express.Router();
  const fail = (res, err) => {
    const code = err.http || err.status || 500;
    if (code >= 500) console.error("connections error:", code, err.message);
    res.status(code).json({ error: err.message });
  };

  router.get("/", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      res.json({ connections: await store.listConnections(locationId) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      if (!encryptionEnabled) return res.status(500).json({ error: "CONNECTIONS_KEY not configured on the server" });
      const { name, provider = "generic-http", type = "header", secret = {} } = req.body || {};
      if (!name) return res.status(400).json({ error: "name required" });
      if (!["header", "bearer", "webhook"].includes(type)) return res.status(400).json({ error: "invalid type" });
      const secretEnc = encrypt(secret);
      const row = await store.createConnection({ locationId, name, provider, type, secretEnc });
      res.status(201).json({ connection: row }); // no secret in response
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete("/:id", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const row = await store.getConnection(req.params.id);
      if (!row || row.locationId !== locationId) return res.status(404).json({ error: "not found" });
      res.json({ ok: await store.deleteConnection(req.params.id) });
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
