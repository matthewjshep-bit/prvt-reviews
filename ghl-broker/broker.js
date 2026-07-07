// broker.js — the app backend that sits between your iframe pages and GHL.
// It holds the GHL token (never the browser) and exposes the 4 endpoints the
// Messaging page calls:
//   GET  /api/config?location_id=...
//   POST /api/config
//   POST /api/send-test
//   POST /api/upload-logo
//
// Google Business Profile OAuth tokens are persisted in Supabase so they
// survive Render redeploys and restarts.

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
  getDashboard,
} from "./ghl.js";
import {
  saveGoogleConnection,
  getValidGoogleAccessToken,
  getGoogleConnection,
  setGoogleLocation,
  deleteGoogleConnection,
} from "./supabase.js";
import {
  getGoogleAccounts,
  getGoogleLocations,
  getGoogleReviews,
} from "./google.js";
import createPipelineRouter from "./routes/pipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 4000;
const GHL_TOKEN = process.env.GHL_TOKEN || "";
const ALLOWED_LOCATION = process.env.GHL_LOCATION_ID || ""; // single-tenant guard
const CARD_SERVICE_URL = process.env.CARD_SERVICE_URL || ""; // e.g. https://cards.prvtmkt.com
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const APP_ORIGIN = process.env.APP_ORIGIN || ""; // iframe app origin, if cross-origin
const APP_ORIGIN_PIPELINE = process.env.APP_ORIGIN_PIPELINE || ""; // pipeline iframe origin
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");

// --- Google OAuth config ---
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = `${PUBLIC_BASE_URL}/auth/google/callback`;
const GOOGLE_SCOPES = "https://www.googleapis.com/auth/business.manage";

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
  const origin = req.headers.origin;
  if (origin && (origin === APP_ORIGIN || origin === APP_ORIGIN_PIPELINE)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Headers", "Content-Type");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
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

/* ========================================================================
   Google Business Profile OAuth
   ======================================================================== */

/* ---------- GET /auth/google — redirect to Google consent screen ---------- */
app.get("/auth/google", (req, res) => {
  const locationId = req.query.location_id || "";
  if (!locationId) return res.status(400).send("missing location_id");
  if (ALLOWED_LOCATION && locationId !== ALLOWED_LOCATION) {
    return res.status(403).send("location not permitted");
  }
  if (!GOOGLE_CLIENT_ID) return res.status(500).send("GOOGLE_CLIENT_ID not configured");

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: GOOGLE_SCOPES,
    access_type: "offline",    // ensures a refresh_token is returned
    prompt: "consent",         // force consent to always get a refresh_token
    state: locationId,         // pass location_id through the OAuth round-trip
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

/* ---------- GET /auth/google/callback — exchange code for tokens ---------- */
app.get("/auth/google/callback", async (req, res) => {
  const { code, state: locationId, error: oauthError } = req.query;

  if (oauthError) {
    console.error("Google OAuth error:", oauthError);
    return res.status(400).send(`Google OAuth error: ${oauthError}`);
  }
  if (!code || !locationId) {
    return res.status(400).send("missing code or state (location_id)");
  }
  if (ALLOWED_LOCATION && locationId !== ALLOWED_LOCATION) {
    return res.status(403).send("location not permitted");
  }

  try {
    // Exchange authorization code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok) {
      console.error("Google token exchange failed:", tokenData.error, tokenData.error_description);
      return res.status(502).send(`Token exchange failed: ${tokenData.error_description || tokenData.error}`);
    }

    if (!tokenData.refresh_token) {
      console.warn("Google did not return a refresh_token — the user may have previously authorized without revoking. Using prompt=consent should prevent this.");
    }

    const expiry = Date.now() + (tokenData.expires_in || 3600) * 1000;

    await saveGoogleConnection(locationId, {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || "",
      expiry,
      googleAccountId: null,   // populated later when user selects an account
      googleLocationId: null,  // populated later when user selects a location
    });

    console.log(`Google connected for location ${locationId} (token persisted to Supabase)`);

    // Redirect back to the dashboard
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Connected</title></head>
      <body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="text-align:center">
          <h2 style="color:#16a34a">✓ Google Connected</h2>
          <p>You can close this window and refresh the dashboard.</p>
        </div>
      </body></html>
    `);
  } catch (err) {
    console.error("Google OAuth callback error:", err.message);
    res.status(500).send("Internal error during Google OAuth");
  }
});

/* ========================================================================
   Existing API endpoints (unchanged)
   ======================================================================== */

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

/* ---------- Mount Pipeline Router ---------- */
// Pass the getTokenFor dependency so the router can authenticate GHL calls
app.use("/api/pipeline", createPipelineRouter(getTokenFor));

/* ---------- GET dashboard ---------- */
app.get("/api/dashboard", async (req, res) => {
  try {
    const { locationId, client } = resolveLocation(req);
    const dashboard = await getDashboard(client, locationId);

    // --- Google connection status ---
    try {
      const googleAccessToken = await getValidGoogleAccessToken(locationId);
      if (googleAccessToken) {
        dashboard.googleConnected = true;
        const conn = await getGoogleConnection(locationId);
        
        if (conn && conn.google_account_id && conn.google_location_id) {
          dashboard.googleLocationId = conn.google_location_id;
          
          // Fetch live Google Reviews!
          try {
            const googleData = await getGoogleReviews(
              googleAccessToken,
              conn.google_account_id,
              conn.google_location_id
            );
            
            // Map Google reviews to the dashboard format
            dashboard.averageRating = googleData.averageRating || 0;
            dashboard.totalReviews = googleData.totalReviewCount || 0;
            dashboard.recentReviews = googleData.reviews.slice(0, 5).map((r) => ({
              id: r.reviewId,
              author: r.reviewer?.displayName || "Google User",
              rating: r.starRating === "FIVE" ? 5 : r.starRating === "FOUR" ? 4 : r.starRating === "THREE" ? 3 : r.starRating === "TWO" ? 2 : 1,
              content: r.comment || "",
              createdAt: r.createTime,
              reply: r.reviewReply?.comment || null,
            }));
          } catch (e) {
            console.error("Failed to fetch live Google reviews:", e);
            // Fall back to empty if we fail
            dashboard.recentReviews = [];
          }
        }
      } else {
        dashboard.googleConnected = false;
        dashboard.googleConnectUrl = `${PUBLIC_BASE_URL}/auth/google?location_id=${encodeURIComponent(locationId)}`;
      }
    } catch (err) {
      console.error("Google connection check failed:", err.message);
      dashboard.googleConnected = false;
      dashboard.googleConnectUrl = `${PUBLIC_BASE_URL}/auth/google?location_id=${encodeURIComponent(locationId)}`;
    }

    res.json(dashboard);
  } catch (err) {
    fail(res, err);
  }
});

/* ---------- GET /api/google/locations ---------- */
app.get("/api/google/locations", async (req, res) => {
  try {
    const { locationId } = resolveLocation(req);
    const accessToken = await getValidGoogleAccessToken(locationId);
    if (!accessToken) return res.status(401).json({ error: "Google not connected" });

    // Fetch accounts, then for each account fetch locations
    const accounts = await getGoogleAccounts(accessToken);
    const allLocations = [];

    for (const acc of accounts) {
      // acc.name is like "accounts/12345"
      const locs = await getGoogleLocations(accessToken, acc.name);
      for (const loc of locs) {
        allLocations.push({
          accountId: acc.name.split("/")[1],
          locationId: loc.name.split("/")[3],
          title: loc.title,
        });
      }
    }

    res.json(allLocations);
  } catch (err) {
    fail(res, err);
  }
});

/* ---------- POST /api/google/location ---------- */
app.post("/api/google/location", async (req, res) => {
  try {
    const { locationId } = resolveLocation(req);
    const { accountId, googleLocationId } = req.body || {};
    if (!accountId || !googleLocationId) {
      return res.status(400).json({ error: "Missing accountId or googleLocationId" });
    }

    await setGoogleLocation(locationId, accountId, googleLocationId);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

/* ---------- DELETE /api/google/connection ---------- */
app.delete("/api/google/connection", async (req, res) => {
  try {
    const { locationId } = resolveLocation(req);
    await deleteGoogleConnection(locationId);
    res.json({ ok: true });
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
