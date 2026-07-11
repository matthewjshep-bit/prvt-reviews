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
  getContact,
  listTags,
  searchContacts,
  searchContactsByTag,
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
import createTemplatesRouter from "./routes/templates.js";
import createStudioRouter from "./routes/studio.js";
import createRenderRouter from "./routes/render.js";
import createConnectionsRouter from "./routes/connections.js";
import { resolveConnectionsFor } from "./connections.js";
import { store } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 4000;
const GHL_TOKEN = process.env.GHL_TOKEN || "";
const ALLOWED_LOCATION = process.env.GHL_LOCATION_ID || ""; // single-tenant guard
const CARD_SERVICE_URL = process.env.CARD_SERVICE_URL || ""; // e.g. https://prvt-reviews.onrender.com
// Safety gate: real (non-dry-run) card sends only fire when this is "true".
// Leave unset while testing so every send is forced to a dry run.
const CARD_SENDS_ENABLED = process.env.CARD_SENDS_ENABLED === "true";
const CAMPAIGN_CAP = parseInt(process.env.CAMPAIGN_CAP || "200", 10); // max recipients per run
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const APP_ORIGIN = (process.env.APP_ORIGIN || "").replace(/\/$/, ""); // iframe app origin, if cross-origin
const APP_ORIGIN_PIPELINE = (process.env.APP_ORIGIN_PIPELINE || "").replace(/\/$/, ""); // pipeline iframe origin
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

/* ---------- Mount Card Studio template CRUD ---------- */
app.use("/api/templates", createTemplatesRouter({ resolveLocation }));

/* ---------- Mount Card Studio editor-support endpoints ---------- */
app.use("/api", createStudioRouter({ resolveLocation, uploadDir: UPLOAD_DIR, publicBaseUrl: PUBLIC_BASE_URL }));

/* ---------- Mount Card Studio render/generate/test-send ---------- */
const renderRouter = createRenderRouter({ resolveLocation, resolveConnectionsFor });
app.use("/api/render", renderRouter);

/* ---------- Mount connections (encrypted credentials) ---------- */
app.use("/api/connections", createConnectionsRouter({ resolveLocation }));

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
      cardFit = "",
      cardBgColor = "",
      cardHeadline = "",
      cardAccent = "",
      cardNameX = "",
      cardNameY = "",
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
      const p = new URLSearchParams({ name: sampleName, bg: logoUrl });
      if (cardFit) p.set("fit", cardFit);
      if (cardBgColor) p.set("bgColor", cardBgColor);
      if (cardHeadline) p.set("headline", cardHeadline);
      if (cardAccent) p.set("accent", cardAccent);
      if (cardNameX !== "") p.set("nameX", cardNameX);
      if (cardNameY !== "") p.set("nameY", cardNameY);
      attachments.push(`${CARD_SERVICE_URL}/card?${p.toString()}`);
    }

    const contactId = await findOrCreateContactByPhone(client, locationId, testPhone, sampleName);
    const result = await sendSms(client, { contactId, message: body, attachments });
    res.json({ ok: true, contactId, result });
  } catch (err) {
    fail(res, err);
  }
});

/* ---------- personalized-card send engine (Phase 1) ---------- */

// Build a personalized card URL from the saved image settings + a name.
function buildCardUrl(name, card = {}) {
  const p = new URLSearchParams({ name: name || "there" });
  if (card.logoUrl) p.set("bg", card.logoUrl);
  if (card.cardFit) p.set("fit", card.cardFit);
  if (card.cardBgColor) p.set("bgColor", card.cardBgColor);
  if (card.cardHeadline) p.set("headline", card.cardHeadline);
  if (card.cardAccent) p.set("accent", card.cardAccent);
  if (card.cardNameX != null && card.cardNameX !== "") p.set("nameX", card.cardNameX);
  if (card.cardNameY != null && card.cardNameY !== "") p.set("nameY", card.cardNameY);
  return `${CARD_SERVICE_URL}/card?${p.toString()}`;
}

const firstNameOf = (c) => c?.firstName || c?.contact?.firstName || "";
const isDnd = (c) => Boolean(c?.dnd || c?.contact?.dnd);
const idOf = (c) => c?.id || c?.contact?.id;

// Personalize a message template per contact (same tokens as send-test).
function personalizeMessage(tmpl, name, businessName, reviewLink) {
  return (tmpl || "")
    .replace(/\{\{\s*first_name\s*\}\}/g, name || "there")
    .replace(/\{\{\s*business_name\s*\}\}/g, businessName || "us")
    .replace(/\[Review Link\]/g, reviewLink || "");
}

// GET /api/tags — audience picker options.
app.get("/api/tags", async (req, res) => {
  try {
    const { locationId, client } = resolveLocation(req);
    const tags = await listTags(client, locationId);
    res.json({ tags });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/send-card — send the personalized card to ONE contact.
// dryRun (default true) resolves the contact and returns the card URL without
// sending. A real send also requires CARD_SENDS_ENABLED=true on the server.
app.post("/api/send-card", async (req, res) => {
  try {
    const { locationId, client } = resolveLocation(req);
    const {
      contactId, phone, message = "", businessName = "", reviewLink = "", card = {}, dryRun = true,
    } = req.body || {};

    let contact;
    if (contactId) contact = await getContact(client, contactId);
    else if (phone) {
      const cid = await findOrCreateContactByPhone(client, locationId, phone, card.name || "");
      contact = await getContact(client, cid);
    } else {
      return res.status(400).json({ error: "contactId or phone required" });
    }

    const cid = idOf(contact) || contactId;
    const name = firstNameOf(contact) || card.name || "there";
    const url = buildCardUrl(name, card);
    const text = personalizeMessage(message, name, businessName, reviewLink);

    if (isDnd(contact)) return res.json({ ok: true, skipped: "dnd", contactId: cid });

    const live = dryRun === false && CARD_SENDS_ENABLED;
    if (!live) {
      return res.json({
        ok: true,
        dryRun: true,
        sendsEnabled: CARD_SENDS_ENABLED,
        wouldSendTo: { id: cid, firstName: name },
        message: text,
        cardUrl: url,
      });
    }

    const result = await sendSms(client, { contactId: cid, message: text, attachments: [url] });
    res.json({ ok: true, sent: true, contactId: cid, result });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/campaigns — send to everyone carrying a tag. Throttled + capped.
// dryRun (default true) returns the audience breakdown without sending.
app.post("/api/campaigns", async (req, res) => {
  try {
    const { locationId, client } = resolveLocation(req);
    const {
      tag, message = "", businessName = "", reviewLink = "", card = {}, dryRun = true,
    } = req.body || {};
    if (!tag) return res.status(400).json({ error: "tag required" });

    const { contacts, total } = await searchContactsByTag(client, locationId, tag);
    const eligible = contacts.filter((c) => !isDnd(c) && idOf(c));
    const skippedDnd = contacts.length - eligible.length;
    const capped = eligible.slice(0, CAMPAIGN_CAP);

    const live = dryRun === false && CARD_SENDS_ENABLED;
    if (!live) {
      return res.json({
        ok: true,
        dryRun: true,
        sendsEnabled: CARD_SENDS_ENABLED,
        total,
        matched: contacts.length,
        eligible: eligible.length,
        skippedDnd,
        willSend: capped.length,
        cap: CAMPAIGN_CAP,
        sample: capped.slice(0, 5).map((c) => ({ id: idOf(c), firstName: firstNameOf(c) })),
      });
    }

    let sent = 0;
    let failed = 0;
    for (const c of capped) {
      const name = firstNameOf(c) || "there";
      const url = buildCardUrl(name, card);
      const text = personalizeMessage(message, name, businessName, reviewLink);
      try {
        await sendSms(client, { contactId: idOf(c), message: text, attachments: [url] });
        sent++;
      } catch {
        failed++;
      }
      await new Promise((r) => setTimeout(r, 150)); // ~6-7/sec, under GHL's 100/10s
    }
    res.json({ ok: true, sent, failed, skippedDnd, willSend: capped.length, cap: CAMPAIGN_CAP });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/contacts?query= — typeahead search for the recipient picker.
app.get("/api/contacts", async (req, res) => {
  try {
    const { locationId, client } = resolveLocation(req);
    const q = (req.query.query || "").toString().trim();
    if (!q) return res.json({ contacts: [] });
    const results = await searchContacts(client, locationId, q);
    const contacts = (results || []).slice(0, 20).map((c) => ({
      id: c.id,
      firstName: c.firstName || c.contactName || "",
      lastName: c.lastName || "",
      phone: c.phone || "",
      email: c.email || "",
      dnd: Boolean(c.dnd),
    }));
    res.json({ contacts });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/send-batch — send the card to any mix of selected contacts,
// manual phone numbers, and (optionally) everyone with a tag. Deduped,
// DND-skipped, throttled, capped. dryRun (default true) returns a breakdown.
app.post("/api/send-batch", async (req, res) => {
  try {
    const { locationId, client } = resolveLocation(req);
    const {
      contacts = [],
      phones = [],
      tag = "",
      message = "",
      businessName = "",
      reviewLink = "",
      card = {},
      templateId = "",
      dryRun = true,
    } = req.body || {};

    // Collect target contacts (dedupe by id): tag audience + explicit picks.
    const byId = new Map();
    if (tag) {
      const { contacts: tagContacts } = await searchContactsByTag(client, locationId, tag);
      for (const c of tagContacts) if (idOf(c)) byId.set(idOf(c), c);
    }
    for (const c of contacts) if (c?.id) byId.set(c.id, { id: c.id, firstName: c.firstName, dnd: c.dnd });

    const withId = [...byId.values()];
    const eligible = withId.filter((c) => !isDnd(c));
    const skippedDnd = withId.length - eligible.length;
    const cleanPhones = [...new Set((phones || []).map((p) => String(p).trim()).filter(Boolean))];

    const matched = eligible.length + cleanPhones.length;
    const willSend = Math.min(matched, CAMPAIGN_CAP);

    const live = dryRun === false && CARD_SENDS_ENABLED;
    if (!live) {
      return res.json({
        ok: true,
        dryRun: true,
        sendsEnabled: CARD_SENDS_ENABLED,
        contacts: eligible.length,
        phones: cleanPhones.length,
        skippedDnd,
        matched,
        willSend,
        cap: CAMPAIGN_CAP,
        sample: eligible.slice(0, 5).map((c) => firstNameOf(c) || "—"),
      });
    }

    let sent = 0;
    let failed = 0;
    let remaining = CAMPAIGN_CAP;
    const errors = []; // per-recipient failure reasons (surfaced + logged)
    // When a templateId is given, render each contact's card through the Card
    // Studio pipeline (per-contact bindings); otherwise use the legacy card URL.
    const sendOne = async (contactId, name) => {
      let url;
      if (templateId) {
        const g = await renderRouter.generate({ client, locationId, templateId, contactId, force: false });
        url = g.url;
      } else {
        url = buildCardUrl(name || "there", card);
      }
      const text = personalizeMessage(message, name, businessName, reviewLink);
      await sendSms(client, { contactId, message: text, attachments: [url] });
    };
    const noteError = (who, e) => {
      const msg = e?.data ? `${e.message} :: ${JSON.stringify(e.data).slice(0, 200)}` : e?.message || "error";
      console.error("send-batch fail:", who, msg);
      if (errors.length < 5) errors.push({ who, error: msg });
      failed++;
    };

    for (const c of eligible) {
      if (remaining <= 0) break;
      try {
        await sendOne(idOf(c), firstNameOf(c));
        sent++;
      } catch (e) {
        noteError(firstNameOf(c) || idOf(c), e);
      }
      remaining--;
      await new Promise((r) => setTimeout(r, 150));
    }
    for (const phone of cleanPhones) {
      if (remaining <= 0) break;
      try {
        const cid = await findOrCreateContactByPhone(client, locationId, phone, "");
        const contact = await getContact(client, cid);
        if (isDnd(contact)) {
          remaining--;
          continue;
        }
        await sendOne(cid, firstNameOf(contact));
        sent++;
      } catch (e) {
        noteError(phone, e);
      }
      remaining--;
      await new Promise((r) => setTimeout(r, 150));
    }
    res.json({ ok: true, sent, failed, skippedDnd, willSend, cap: CAMPAIGN_CAP, errors });
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

store.init().catch((e) => console.error("store init failed:", e.message));

app.listen(PORT, () => console.log(`broker on :${PORT}`));
