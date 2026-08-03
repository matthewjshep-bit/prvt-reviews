// broker.js — the offer-generator backend. Sits between the iframe app and
// GoHighLevel: it holds the GHL token (never the browser), calculates offers,
// drives cardgen to render the offer document, and writes the offer back onto
// the contact record. All product endpoints live in routes/offers.js.

import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { makeClient } from "./ghl.js";
import createOffersRouter from "./routes/offers.js";
import createOutreachRouter from "./routes/outreach.js";
import { store } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 4000;
const GHL_TOKEN = process.env.GHL_TOKEN || "";
const ALLOWED_LOCATION = process.env.GHL_LOCATION_ID || ""; // single-tenant guard
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
// Allowed browser origins (comma-separated) — the offers site and the
// standalone Agent Outreach site both talk to this one broker.
const APP_ORIGINS = (process.env.APP_ORIGIN || "")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// --- single-tenant token resolution. Swap this for a per-location lookup
//     (DB/KV keyed by locationId holding OAuth access+refresh tokens) later. ---
function getTokenFor(_locationId) {
  return GHL_TOKEN;
}

const app = express();
// 30mb: the AI rehab scan accepts user-uploaded listing photos as data URLs.
app.use(express.json({ limit: "30mb" }));

// CORS — only needed if the page is served from a different origin than this API.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && APP_ORIGINS.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Headers", "Content-Type");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
  }
  next();
});

// Local-dev fallback for generated documents (production stores them in R2).
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "1d" }));

// Root doubles as a deploy check: Render injects RENDER_GIT_COMMIT, so this
// shows exactly which commit is live.
app.get("/", (_req, res) =>
  res.type("text/plain").send(`offer broker ok @ ${(process.env.RENDER_GIT_COMMIT || "dev").slice(0, 7)}`));

// Resolve + validate the location for an incoming request.
function resolveLocation(req) {
  const loc = req.query.location_id || req.body?.location_id || "";
  if (!loc) {
    const e = new Error("missing location_id");
    e.http = 400;
    throw e;
  }
  if (ALLOWED_LOCATION && loc !== ALLOWED_LOCATION) {
    // The single token only works for one location; reject spoofed IDs.
    const e = new Error("location not permitted");
    e.http = 403;
    throw e;
  }
  const token = getTokenFor(loc);
  if (!token) {
    const e = new Error("no token configured for this location");
    e.http = 500;
    throw e;
  }
  return { locationId: loc, client: makeClient(token) };
}

app.use("/api/offers", createOffersRouter({ resolveLocation, uploadDir: UPLOAD_DIR, publicBaseUrl: PUBLIC_BASE_URL }));
app.use("/api/outreach", createOutreachRouter({ resolveLocation }));

store.init().catch((e) => console.error("store init failed:", e.message));

app.listen(PORT, () => console.log(`offer broker on :${PORT}`));
