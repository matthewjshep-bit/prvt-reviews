// broker.js — the offer-generator backend. Sits between the iframe app and
// GoHighLevel: it holds the GHL token (never the browser), calculates offers,
// drives cardgen to render the offer document, and writes the offer back onto
// the contact record. All product endpoints live in routes/offers.js.

import express from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { makeClient } from "./ghl.js";
import createPostMortemRouter from "./routes/post-mortem.js";
import { maybeStartNightlySweep } from "./enrich-sweep.js";
import createOffersRouter from "./routes/offers.js";
import createOutreachRouter from "./routes/outreach.js";
import createDashboardRouter from "./routes/dashboard.js";
import createDispoRouter from "./routes/dispo.js";
import createContactsRouter from "./routes/contacts.js";
import { createDataroomRouter, createDataroomPublicRouter } from "./routes/dataroom.js";
import { createOfferPageRouter, createOfferPagePublicRouter } from "./routes/offer-page.js";
import { store } from "./store.js";
import { checkObjectStore } from "./r2.js";
import { sendDueDrafts } from "./conversation-scheduler.js";
import { maybeStartFollowUpSweep, FOLLOW_UP_UTC_HOUR } from "./follow-up-sweep.js";
import { sendReplyDraft, conversationConfig, startProactive } from "./reply-agent.js";
import { maybeStartOutreachSweep, OUTREACH_SWEEP_UTC_HOUR } from "./outreach-sweep.js";
import { maybeStartOutreachFollowUp } from "./outreach-followup.js";
import { maybeStartDispoSweep, DISPO_SWEEP_UTC_HOUR } from "./dispo-autopilot.js";
import { maybeMirror } from "./ghl-mirror.js";
import { maybeSweepCalls } from "./call-intake.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 4000;
const GHL_TOKEN = process.env.GHL_TOKEN || "";
const ALLOWED_LOCATION = process.env.GHL_LOCATION_ID || ""; // single-tenant guard
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
// Investor-facing links live on their own hostname (deals.shepflips.com) so a deal
// package never shows the offers host. Both hostnames point at this same service —
// the split only decides which name gets printed into a link. Falls back to
// PUBLIC_BASE_URL for dev and for anyone running a single domain.
const DATAROOM_BASE_URL = (process.env.DATAROOM_BASE_URL || PUBLIC_BASE_URL).replace(/\/$/, "");
// Allowed browser origins (comma-separated) — the offers site and the
// standalone Agent Outreach site both talk to this one broker.
const APP_ORIGINS = (process.env.APP_ORIGIN || "")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// --- per-location token resolution. GHL_TOKENS is a JSON map of
//     locationId -> Private Integration token, one entry per tenant:
//       GHL_TOKENS={"PvdeT4y...":"pit-...","AbCdEf...":"pit-..."}
//     The legacy GHL_TOKEN/GHL_LOCATION_ID pair still works as a fallback. ---
function parseEnvJson(name) {
  try {
    return JSON.parse(process.env[name] || "{}");
  } catch (e) {
    console.error(`ignoring malformed ${name}: ${e.message}`);
    return {};
  }
}
const GHL_TOKENS = parseEnvJson("GHL_TOKENS");
// Optional per-location access keys: locationId -> shared secret. When a key is
// set for a location, every request must carry it (?location_key= / body) — the
// secret rides in the GHL custom-menu-link URL, so only people inside that GHL
// account have it. Locations without an entry are unaffected.
const GHL_LOCATION_KEYS = parseEnvJson("GHL_LOCATION_KEYS");

function getTokenFor(locationId) {
  if (GHL_TOKENS[locationId]) return GHL_TOKENS[locationId];
  if (GHL_TOKEN && (!ALLOWED_LOCATION || locationId === ALLOWED_LOCATION)) return GHL_TOKEN;
  return "";
}

function timingSafeEq(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
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
  const token = getTokenFor(loc);
  if (!token) {
    // Unknown location — a token only exists for onboarded tenants, so this
    // also rejects spoofed IDs.
    const e = new Error("location not permitted");
    e.http = 403;
    throw e;
  }
  const requiredKey = GHL_LOCATION_KEYS[loc];
  if (requiredKey) {
    const got = req.query.location_key || req.body?.location_key || "";
    if (!timingSafeEq(got, requiredKey)) {
      const e = new Error("bad or missing location key");
      e.http = 403;
      throw e;
    }
  }
  return { locationId: loc, client: makeClient(token) };
}

const CONVERSATION_SENDS_LIVE = process.env.CARD_SENDS_ENABLED === "true";
const offersRouter = createOffersRouter({ resolveLocation, uploadDir: UPLOAD_DIR, publicBaseUrl: PUBLIC_BASE_URL, dataroomBaseUrl: DATAROOM_BASE_URL });
app.use("/api/offers", offersRouter);
// The post-mortem on a deal that fell through. Mounted beside the offers
// router; its paths are all /:id/deal/postmortem, which GET /:id can't eat.
app.use("/api/offers", createPostMortemRouter({ resolveLocation, feedbackFor: offersRouter.feedbackFor }));
// The first text to an agent the outreach import just created: the
// Conversation AI's cold open, drafted from the hook listing. Draft-only
// unless outreach_open is on the agent allowlist.
const outreachRouter = createOutreachRouter({
  resolveLocation,
  firstTouch: async ({ locationId, client, contactId, hook = {} }) => {
    const saved = (await store.getOfferSettings(locationId)) || {};
    return startProactive({
      client, locationId, saved, store, contactId, kind: "outreach_open",
      subject: { address: hook.address || "", hookPrice: hook.price || 0, hookDom: hook.dom || 0, brokerage: hook.brokerage || "" },
      sendsEnabled: CONVERSATION_SENDS_LIVE,
      deps: offersRouter.conversationDepsFor({ locationId, client, saved }),
    });
  },
});
app.use("/api/outreach", outreachRouter);
app.use("/api/dashboard", createDashboardRouter({ resolveLocation }));
const dispoRouter = createDispoRouter({ resolveLocation });
app.use("/api/dispo", dispoRouter);
offersRouter.setDispoDeps({ matchForDeal: dispoRouter.matchForDeal, blastFromApp: dispoRouter.blastFromApp });
// The contact record: the app's own memory of every agent and investor, and
// the drawer's door to it. GHL's custom fields are a digest of this.
app.use("/api/contacts", createContactsRouter({ resolveLocation }));
app.use("/api/datarooms", createDataroomRouter({ resolveLocation, publicBaseUrl: DATAROOM_BASE_URL }));
// Agent-facing offer packages. These live on the OFFERS hostname, not the
// deals one: an agent gets links branded like the documents they already have,
// and nothing about a listing agent's page should read as investor marketing.
app.use("/api/offer-pages", createOfferPageRouter({ resolveLocation, publicBaseUrl: PUBLIC_BASE_URL }));
// Investor datarooms are opened by people outside the GHL account, so /d is
// deliberately outside the location gate — the per-invite token is the
// credential, and the router enforces PIN, expiry, and revocation itself.
app.use("/d", createDataroomPublicRouter({ publicBaseUrl: DATAROOM_BASE_URL }));
// Same deal for /o: the share token is the credential, so it sits outside the
// location gate. It refuses dataroom tokens, and /d refuses these.
app.use("/o", createOfferPagePublicRouter());

store.init().catch((e) => console.error("store init failed:", e.message));
// Say at boot whether property videos have somewhere to go. "not configured"
// is a quiet state (uploads are refused with a message); a configured bucket
// that doesn't answer is the thing to read this log for.
checkObjectStore().then((r) => {
  if (r.ok) console.log(`object store ok: ${r.bucket} @ ${r.endpoint}`);
  else if (!r.configured) console.log(`object store ${r.reason} — video uploads disabled`);
  else console.error(`object store configured but not answering — ${r.reason}`);
}).catch((e) => console.error("object store check failed:", e.message));

// Nightly AI enrichment sweep (Settings → "Nightly conversation sweep").
// Fires during the 10:00 UTC hour ≈ 2–3am Pacific; maybeStartNightlySweep
// skips locations without the toggle/AI key and won't run twice in a day.
const SWEEP_UTC_HOUR = Number(process.env.ENRICH_SWEEP_UTC_HOUR || 10);
const sweepLocations = () =>
  [...new Set([...Object.keys(GHL_TOKENS), ...(ALLOWED_LOCATION ? [ALLOWED_LOCATION] : [])])];
setInterval(async () => {
  for (const locationId of sweepLocations()) {
    try {
      const token = getTokenFor(locationId);
      if (!token) continue;
      const saved = await store.getOfferSettings(locationId);
      const started = maybeStartNightlySweep({
        client: makeClient(token), locationId, saved, store, utcHour: SWEEP_UTC_HOUR,
      });
      if (started) console.log(`nightly enrich sweep started for ${locationId}`);
      // The follow-up clock rides the same tick rather than a third timer:
      // it is a once-a-day decision with the same four gates and the same
      // per-location try/catch. What it decides lands in the outbox, and the
      // 30s scheduler below is what actually sends it.
      const nudged = await maybeStartFollowUpSweep({
        client: makeClient(token), locationId, saved, store,
        sendsEnabled: CONVERSATION_SENDS_LIVE, utcHour: FOLLOW_UP_UTC_HOUR,
        deps: offersRouter.conversationDepsFor({ locationId, client: makeClient(token), saved }),
      });
      if (nudged) console.log(`follow-up sweep started for ${locationId}`);
      // The top of the funnel, same tick: pull, pick, import, say hello.
      const pulled = await maybeStartOutreachSweep({
        client: makeClient(token), locationId, saved, store, utcHour: OUTREACH_SWEEP_UTC_HOUR,
        deps: { runPull: outreachRouter.runPull, importAgents: outreachRouter.importAgents },
      });
      if (pulled) console.log(`outreach sweep started for ${locationId}`);
      // The agents GHL texted and never heard back from, into the second workflow.
      const followed = await maybeStartOutreachFollowUp({ client: makeClient(token), locationId, saved, store });
      if (followed) console.log(`outreach follow-up started for ${locationId}`);
      // The second wave: deals blasted once, nobody committed, the delay past.
      const waved = await maybeStartDispoSweep({
        client: makeClient(token), locationId, saved, store, utcHour: DISPO_SWEEP_UTC_HOUR,
        deps: { matchForDeal: dispoRouter.matchForDeal, blastFromApp: dispoRouter.blastFromApp },
      });
      if (waved) console.log(`dispo second wave started for ${locationId}`);
      // The board, onto GHL's Opportunities. Every tick, bounded.
      await maybeMirror({ client: makeClient(token), locationId, saved, store, log: console.log });
      // Calls that ended since the last look, read like inbound texts. No
      // GHL trigger needed.
      await maybeSweepCalls({
        client: makeClient(token), locationId, saved, store, sendsEnabled: CONVERSATION_SENDS_LIVE, log: console.log,
        deps: offersRouter.conversationDepsFor({ locationId, client: makeClient(token), saved }),
      });
    } catch (e) {
      console.error(`nightly sweep check failed for ${locationId}: ${e.message}`);
    }
  }
}, 15 * 60 * 1000).unref();

// Conversation AI auto-sends. An approved reply is scheduled a few human
// minutes out (reply-agent.js → conversation-scheduler.js); this sends the
// ones that have come due. Every 30s, cheap when there is nothing scheduled
// (one indexed read per location), and a no-op unless the broker's send gate
// is on — without CARD_SENDS_ENABLED nothing is ever scheduled in the first
// place, and anything left over from before the flag flipped is handed back
// to the outbox with a flag rather than left counting down.
let lastPrune = 0;
setInterval(async () => {
  try {
    const locations = sweepLocations()
      .map((locationId) => ({ locationId, token: getTokenFor(locationId) }))
      .filter((l) => l.token)
      .map(({ locationId, token }) => ({ locationId, client: makeClient(token) }));
    const r = await sendDueDrafts({
      store, locations, live: CONVERSATION_SENDS_LIVE, send: sendReplyDraft, log: console.log,
      enabledFor: async (locationId) => conversationConfig((await store.getOfferSettings(locationId)) || {}).enabled,
    });
    if (r.failed || r.recovered || r.returned) console.warn(`conversation scheduler: ${JSON.stringify(r)}`);
    // Once a day: settled drafts past the tab's retention go.
    if (Date.now() - lastPrune > 24 * 3600 * 1000) {
      lastPrune = Date.now();
      for (const { locationId } of locations) {
        try {
          const days = conversationConfig((await store.getOfferSettings(locationId)) || {}).retentionDays;
          if (days > 0 && store.pruneReplyDrafts) {
            const n = await store.pruneReplyDrafts(locationId, new Date(Date.now() - days * 86400000).toISOString());
            if (n) console.log(`conversation retention: pruned ${n} draft(s) for ${locationId}`);
          }
        } catch (e) { console.error(`conversation retention failed for ${locationId}: ${e.message}`); }
      }
    }
  } catch (e) {
    console.error(`conversation scheduler tick failed: ${e.message}`);
  }
}, 30 * 1000).unref();

app.listen(PORT, () => console.log(`offer broker on :${PORT}`));
