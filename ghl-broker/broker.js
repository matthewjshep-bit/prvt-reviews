// broker.js — the app backend that sits between your iframe pages and GHL.
// It holds the GHL token (never the browser) and exposes the 4 endpoints the
// Messaging page calls:
//   GET  /api/config?location_id=...
//   POST /api/config
//   POST /api/send-test
//   POST /api/upload-logo
//
// Single-tenant to start: one Private Integration token for one location, set
// in env. The getTokenFor() seam is where you swap in a per-location OAuth
// token store when you go multi-client.

import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  makeClient,
  getConfig,
  saveConfig,
  findOrCreateContactByPhone,
  sendSms,
} from "./ghl.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 4000;
const GHL_TOKEN = process.env.GHL_TOKEN || "";
const ALLOWED_LOCATION = process.env.GHL_LOCATION_ID || ""; // single-tenant guard
const CARD_SERVICE_URL = process.env.CARD_SERVICE_URL || ""; // e.g. https://cards.prvtmkt.com
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const APP_ORIGIN = process.env.APP_ORIGIN || ""; // iframe app origin, if cross-origin
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// --- single-tenant token resolution. Swap this for a per-location lookup
//     (DB/KV keyed by locationId holding OAuth access+refresh tokens) later. ---
function getTokenFor(_locationId) {
  return GHL_TOKEN;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// CORS — only needed if the page is served from a different origin than this API.
app.use((req, res, next) => {
  if (APP_ORIGIN) {
    res.header("Access-Control-Allow-Origin", APP_ORIGIN);
    res.header("Access-Control-Allow-Headers", "Content-Type");
    res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
  }
  next();
});

// Serve uploaded logos so GHL (and the card service ?bg=) can fetch them.
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "1d" }));

app.get("/", (_req, res) => res.type("text/plain").send("broker ok"));

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

function fail(res, err) {
  const code = err.http || err.status || 500;
  console.error("broker error:", code, err.message, err.data || "");
  res.status(code).json({ error: err.message, detail: err.data });
}

/* ---------- GET config ---------- */
app.get("/api/config", async (req, res) => {
  try {
    const { locationId, client } = resolveLocation(req);
    const config = await getConfig(client, locationId);
    res.json(config);
  } catch (err) {
    fail(res, err);
  }
});

/* ---------- POST config (writes GHL custom values) ---------- */
app.post("/api/config", async (req, res) => {
  try {
    const { locationId, client } = resolveLocation(req);
    const { location_id, ...config } = req.body || {};
    const saved = await saveConfig(client, locationId, config);
    res.json({ ok: true, config: saved });
  } catch (err) {
    fail(res, err);
  }
});

/* ---------- POST send-test ---------- */
app.post("/api/send-test", async (req, res) => {
  try {
    const { locationId, client } = resolveLocation(req);
    const {
      testPhone,
      sampleName = "Jessica",
      businessName = "",
      mode = "smart",
      customTemplate = "",
      logoUrl = "",
      personalizedImage = true,
      reviewLink = "[Review Link]",
    } = req.body || {};

    if (!testPhone) {
      return res.status(400).json({ error: "testPhone is required" });
    }

    // Build the message body the same way the workflow would.
    const smartDefault =
      `Hey ${sampleName}, we hope you enjoyed your experience with ${businessName || "us"}! ` +
      `Would you mind taking a moment to leave a review? Here's the link: ${reviewLink}`;
    let body =
      mode === "custom" && customTemplate
        ? customTemplate
            .replace(/\{\{\s*first_name\s*\}\}/g, sampleName)
            .replace(/\{\{\s*business_name\s*\}\}/g, businessName || "us")
            .replace(/\[Review Link\]/g, reviewLink)
        : smartDefault;

    // Attach the personalized card (MMS) when enabled.
    const attachments = [];
    if (personalizedImage && logoUrl && CARD_SERVICE_URL) {
      attachments.push(
        `${CARD_SERVICE_URL}/card?name=${encodeURIComponent(sampleName)}&bg=${encodeURIComponent(logoUrl)}`
      );
    }

    const contactId = await findOrCreateContactByPhone(client, locationId, testPhone, sampleName);
    const result = await sendSms(client, { contactId, message: body, attachments });
    res.json({ ok: true, contactId, result });
  } catch (err) {
    fail(res, err);
  }
});

/* ---------- POST upload-logo ---------- */
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || ".png").toLowerCase().slice(0, 5);
      cb(null, `logo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

app.post("/api/upload-logo", upload.single("file"), (req, res) => {
  try {
    resolveLocation(req); // validates location_id in the form body
    if (!req.file) return res.status(400).json({ error: "no image file" });
    const url = `${PUBLIC_BASE_URL}/uploads/${req.file.filename}`;
    // NOTE: local disk is fine for a single host. For production durability,
    // store to S3 / Cloudflare R2 and return that URL instead.
    res.json({ url });
  } catch (err) {
    fail(res, err);
  }
});

app.listen(PORT, () => console.log(`broker on :${PORT}`));
