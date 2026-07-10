// server.js — cardgen HTTP surface.
//   GET  /card        legacy single-card renderer (unchanged, still used by the
//                     current workflow until templates fully take over)
//   POST /render      template render — preview (returns bytes) or generate
//                     (store=true → R2 → { url, cached })
//   GET  /providers   provider catalog for the editor
//   POST /providers/:id/test   run one provider against sample inputs
//
// IMPORTANT: ./fonts.js is imported FIRST so fontconfig env is set before
// libvips (via ./render.js / sharp) initialises its font subsystem.
import "./fonts.js";

import express from "express";
import { renderCard } from "./render.js";
import { runRender } from "./service.js";
import { listProviders, zodToFormSpec } from "./providers/index.js";
import { testProvider } from "./providers/run.js";
import { LOCAL_FILES_DIR, r2Enabled } from "./storage.js";

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: "4mb" }));

// Serve locally-stored renders when R2 isn't configured (dev fallback).
if (!r2Enabled) app.use("/files", express.static(LOCAL_FILES_DIR, { maxAge: "1y", immutable: true }));

/* ---------- legacy in-memory cache for /card ---------- */
const cache = new Map();
const CACHE_MAX = 300;
function cacheGet(k) {
  const v = cache.get(k);
  if (v) {
    cache.delete(k);
    cache.set(k, v);
  }
  return v;
}
function cacheSet(k, v) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(k, v);
}

app.get("/", (_req, res) => res.type("text/plain").send("ok"));

/* ---------- POST /render ---------- */
app.post("/render", async (req, res) => {
  try {
    const {
      template, context = {}, connections = {}, resolveProviders = false,
      store = false, format = "auto", force = false,
    } = req.body || {};
    if (!template || typeof template !== "object") return res.status(400).json({ error: "template required" });

    const out = await runRender({ template, context, connections, resolveProviders, store, format, force });

    if (store) return res.json(out);
    // preview → return the image bytes with resolution metadata in headers
    res.set("Content-Type", out.contentType);
    res.set("Cache-Control", "no-store");
    res.set("X-Missing-Bindings", JSON.stringify(out.missingBindings || []));
    res.set("X-Warnings", JSON.stringify(out.warnings || []));
    res.send(out.buffer);
  } catch (err) {
    console.error("render error:", err?.message || err);
    res.status(400).json({ error: err?.message || "render_failed" });
  }
});

/* ---------- GET /providers ---------- */
app.get("/providers", (_req, res) => {
  const catalog = listProviders().map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    description: p.description,
    auth: p.auth,
    inputs: p.inputs || [],
    options: zodToFormSpec(p.optionsSchema),
  }));
  res.json({ providers: catalog });
});

/* ---------- POST /providers/:id/test ---------- */
app.post("/providers/:id/test", async (req, res) => {
  try {
    const { inputs = {}, options = {}, connection, locationId = "", targetPx, context = {} } = req.body || {};
    const out = await testProvider(req.params.id, { inputs, options, connection, locationId, targetPx, context });
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: err?.message || "test_failed" });
  }
});

/* ---------- GET /card (legacy, unchanged behaviour) ---------- */
app.get("/card", async (req, res) => {
  const { name, bg, brand, w, h, format, excite, demo, fit, bgColor, headline, accent, nameX, nameY } = req.query;
  const demoOn = demo === "1" || demo === "true";
  const key = JSON.stringify({ name, bg, brand, w, h, format, excite, demo: demoOn, fit, bgColor, headline, accent, nameX, nameY });
  try {
    let hit = cacheGet(key);
    if (!hit) {
      hit = await renderCard({
        name, bg, brand, w, h, format,
        excite: excite !== "0" && excite !== "false",
        demo: demoOn, fit, bgColor, headline, accent, nameX, nameY,
      });
      cacheSet(key, hit);
    }
    res.set("Content-Type", hit.contentType);
    res.set("Cache-Control", "public, max-age=86400");
    res.send(hit.buffer);
  } catch (err) {
    console.error("card error:", err?.message || err);
    try {
      const fallback = await renderCard({ name, brand, w, h, format });
      res.set("Content-Type", fallback.contentType);
      res.set("Cache-Control", "no-store");
      res.send(fallback.buffer);
    } catch {
      res.status(400).type("text/plain").send("could not render card");
    }
  }
});

app.listen(PORT, () => console.log(`card service on :${PORT} (R2 ${r2Enabled ? "on" : "off — local /files"})`));
