// routes/offers.js — the offer generator API. Everything the app does lives
// here: calculate offers, render the offer document (JPEG preview + PDF via
// cardgen), and associate the offer with a GHL contact (custom fields + note +
// tag). Mounted at /api/offers.
//
//   GET    /api/offers/settings              location calculation defaults
//   PUT    /api/offers/settings
//   POST   /api/offers/settings/exhibit      store a standing PSA exhibit (EMD check / proof of funds)
//   POST   /api/offers/calculate             pure calc — no side effects
//   POST   /api/offers/preview               render document, return data URL
//   GET    /api/offers/contacts?query=       GHL contact typeahead
//   POST   /api/offers                       create: calc + document + attach
//   GET    /api/offers?contact_id=&limit=&lean=  list saved offers (lean=1 → table rows)
//   GET    /api/offers/:id
//   PUT    /api/offers/:id                    save an existing offer in place (same id, re-rendered docs)
//   PATCH  /api/offers/:id/workspace          autosave the editor's comps/rehab workspace only
//   DELETE /api/offers/:id
//   PATCH  /api/offers/:id/status            record an offer outcome (sent/countered/no_response/passed/accepted)
//   PATCH  /api/offers/status                bulk outcome for a selection of offers
//   POST   /api/offers/:id/send              send offer docs via text/email
//   POST   /api/offers/:id/psa               render the Washington purchase & sale agreement package
//   GET    /api/offers/:id/psa.pdf
//   POST   /api/offers/:id/contract          render the generic purchase & sale contract PDF
//   GET    /api/offers/:id/contract.pdf
//   POST   /api/offers/:id/assignment        render the assignment of contract PDF (dispositions)
//   GET    /api/offers/:id/assignment.pdf
//   POST   /api/offers/:id/netsheet          render the seller net comparison one-pager
//   GET    /api/offers/:id/netsheet.pdf
//   POST   /api/offers/contacts/:id/enrich    AI conversation summary → proposed fields/tags (preview)
//   POST   /api/offers/contacts/:id/enrich/apply    write approved fields/tags/note to the contact
//   POST   /api/offers/enrich/sweep           batch enrich: all contacts active in a window (auto-apply)
//   GET    /api/offers/enrich/sweep           current/last sweep job (the UI polls this)
//   POST   /api/offers/enrich/sweep/cancel    stop after the in-flight contact
//   GET    /api/offers/contacts/:id/record    full record: standard + custom fields + app deals
//   PUT    /api/offers/contacts/:id/record    save standard/custom field edits
//   GET    /api/offers/field-registry          all app-owned field definitions by source
//   POST   /api/offers/custom-fields           create one custom field (idempotent)
//   GET    /api/offers/deals                  offers promoted to active deals
//   POST   /api/offers/:id/deal               promote an offer to a deal (under contract)
//   PATCH  /api/offers/:id/deal               update stage / terms
//   DELETE /api/offers/:id/deal               un-promote (mistake correction)
//   POST   /api/offers/:id/deal/investors     link a disposition investor (GHL contact)
//   POST   /api/offers/:id/deal/suggest-investors   AI-suggest investors from conversation history
//   POST   /api/offers/automations/deal-interest    GHL workflow webhook: Conversation AI flags interest → link investor to the deal they messaged about
//   POST   /api/offers/automations/reply            GHL workflow webhook: inbound agent text → AI-drafted reply, waiting for a human
//   GET    /api/offers/automations/reply            open drafts + live drafting jobs
//   POST   /api/offers/automations/reply/:id/send   send a draft (edited text allowed); dry-run unless CARD_SENDS_ENABLED
//   POST   /api/offers/automations/reply/:id/dismiss
//   PATCH  /api/offers/:id/deal/investors/:contactId    evaluation status
//   DELETE /api/offers/:id/deal/investors/:contactId    unlink
//   POST   /api/offers/deals/sync-investor-tags   backfill the on-deal GHL tag for all deal investors

import express from "express";
import crypto from "node:crypto";
import { store } from "../store.js";
import { calculateOffers, effectiveSettings, fmtMoney, netComparison } from "../shared/offer-calc.js";
import {
  SETTABLE_STATUSES, STATUS_HISTORY_PHRASE, STATUS_RANK,
  effectiveStatus, statusAfterSend, statusAfterUnpromote,
} from "../shared/offer-status.js";
import { buildOfferDocument, buildScopeDocument, buildScopeNotesDocument, buildCompsDocument, buildNetSheetDocument, moneyInWords } from "../offer-doc.js";
import { renderContractPdf } from "../contract-pdf.js";
import { renderPsaPdf } from "../psa-pdf.js";
import { PSA_MODES } from "../shared/wa-psa-template.js";
import {
  DEFAULT_CONTRACT_CLAUSES, DEFAULT_ASSIGNMENT_CLAUSES, ASSIGNMENT_TOKENS, ASSIGNMENT_PREAMBLE,
} from "../shared/contract-template.js";
import { fetchListingPhotos, fetchZillowPhotos, scanRehabFromPhotos, gradeCompConditions, anthropicErrorToHttp } from "../rehab-scan.js";
import { addressKey, addressQueryVariants, zillowUrl } from "../shared/us-address.js";
import { pullComps } from "../comps-pull.js";
import { geocodeAddress } from "../geocode.js";
import { pullZillowComps } from "../comps-zillow.js";
import { gradeComps, needsScrape } from "../comps-grade.js";
import {
  startUnderwrite, getJob as getUnderwriteJob, listJobs as listUnderwriteJobs,
  cancelJob as cancelUnderwriteJob, publicJob as publicUnderwriteJob,
  AUTO_UNDERWRITE_ENABLED,
  UW_POOL_BEDS_TOLERANCE, UW_POOL_BATHS_TOLERANCE, UW_POOL_SQFT_PCT,
} from "../auto-underwrite.js";
import {
  startReply, listJobs as listReplyJobs, publicJob as publicReplyJob,
  sendReplyDraft, dismissReplyDraft,
} from "../reply-agent.js";
import { buildBookmarklet, buildZgrabScript } from "../zgrab.js";
import { fetchRemoteImage, sniffImageType, sniffPdf } from "../fetch-image.js";
import { parseDriveFolderId, listDriveFolderImages, driveImageUrl, driveDirectUrl } from "../drive-folder.js";
export { zillowUrl };
import { jpegToPdf, jpegsToPdf } from "../pdf.js";
import { mapPool } from "../map-pool.js";
import { uploadAsset, r2Enabled } from "../r2.js";
import {
  MAX_PARTS, MAX_VIDEOS_PER_OFFER, MAX_VIDEO_BYTES, PART_BYTES, VIDEO_STORAGE_HINT, VIDEO_TYPES,
  abortVideoUpload, beginVideoUpload, deleteVideoObject, finishVideoUpload, putVideoPart, sniffVideoType,
  streamVideo, videoKey, videoStorageReady,
} from "../video.js";
import {
  getContact, searchContacts, findOrCreateContactByPhone, updateContact,
  findOrCreateCustomFieldByKey, createContactNote, addContactTags, removeContactTags, sendSms, sendEmail,
  customFieldIdKeyMap, contactCustomRecord, listCustomFieldsRaw, deleteCustomField, getContactNotes,
  searchContactsByTag,
} from "../ghl.js";
import {
  enrichFieldDefs, enrichTagVocab, ENRICH_TAG_GROUPS, inferContactType,
  buildTranscript, runEnrichment, suggestDealInvestors, mergeHistory, historyLine,
} from "../enrich.js";
import { OFFER_FIELDS, APP_FIELD_REGISTRY, registryByKey } from "../field-registry.js";
import { fitSnapshot } from "../offer-snapshot.js";
import { syncDealNumbers } from "../dataroom.js";
import { refreshOfferPages } from "../offer-page.js";
import { startSweep, getSweepJob, cancelSweepJob, publicSweepJob } from "../enrich-sweep.js";

const CARD_SERVICE_URL = (process.env.CARD_SERVICE_URL || "").replace(/\/$/, "");
const CARD_SENDS_ENABLED = process.env.CARD_SENDS_ENABLED === "true";
const OFFER_TAG = process.env.OFFER_TAG || "offer-created";
const DEAL_TAG = process.env.DEAL_TAG || "under-contract";
const INVESTOR_DEAL_TAG = process.env.INVESTOR_DEAL_TAG || "on-deal";

// Offer-outcome tags on the AGENT contact. Only the outcomes that need to
// drive a GHL workflow get one: "sent" and "accepted" are already covered by
// OFFER_TAG and DEAL_TAG. These three are mutually exclusive — see
// syncAgentOfferTag for why a contact can only ever carry one.
const OFFER_STATUS_TAGS = {
  countered: process.env.OFFER_COUNTERED_TAG || "offer-countered",
  no_response: process.env.OFFER_NO_RESPONSE_TAG || "offer-no-response",
  passed: process.env.OFFER_PASSED_TAG || "offer-passed",
};
const ALL_STATUS_TAGS = Object.values(OFFER_STATUS_TAGS);

// Active-deal tracking (offers under signed contract). Transitions are
// deliberately permissive (any stage to any stage) so mistakes are correctable;
// stageHistory records the true sequence for KPI math.
const DEAL_STAGES = ["under_contract", "buyer_found", "assigned", "closed", "fell_through"];
const LIVE_DEAL_STAGES = new Set(["under_contract", "buyer_found", "assigned"]);
const INVESTOR_STATUSES = ["sent", "evaluating", "passed", "committed"];
// First entry wins: APP_ORIGIN may list several allowed CORS origins (broker.js
// splits it), but a deep link written onto a contact has to name exactly one.
const APP_ORIGIN = (process.env.APP_ORIGIN || "").split(",")[0].trim().replace(/\/$/, "");

// Per-location access keys (enforced in broker.js resolveLocation) — deep
// links must carry the key or they'd 403 for key-protected locations.
// Guards the auto-underwrite webhook alone. Deliberately separate from
// GHL_LOCATION_KEYS, which resolveLocation applies to every request for a
// location and therefore cannot be switched on without re-issuing every GHL
// menu-link URL in the account.
// Trimmed: Render's env editor is a textarea, so a value can pick up a trailing
// newline that is invisible in the UI and fatal to an exact compare.
const AUTO_UNDERWRITE_SECRET = (process.env.AUTO_UNDERWRITE_SECRET || "").trim();

// Read the secret from wherever the caller could put it. GHL's Webhook action
// makes a custom header or a query string far easier to set than a hand-built
// JSON body, and a workflow saved with the default payload sends neither
// `secret` nor anything else we asked for — which reads as "bad or missing
// secret" and sends you looking at your env vars, where nothing is wrong.
const secretFrom = (req) =>
  req.get("x-underwrite-secret") ||
  req.query.secret ||
  req.body?.secret ||
  req.body?.customData?.secret ||
  "";

const secretOk = (got) => {
  if (!AUTO_UNDERWRITE_SECRET) return false;
  const a = Buffer.from(String(got == null ? "" : got).trim());
  const b = Buffer.from(AUTO_UNDERWRITE_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

let LOCATION_KEYS = {};
try { LOCATION_KEYS = JSON.parse(process.env.GHL_LOCATION_KEYS || "{}"); } catch { /* broker.js logs it */ }

// Deep link into the offer app scoped to one contact (clickable from the GHL
// contact panel). Empty when APP_ORIGIN isn't configured.
const offerAppLink = (locationId, contactId) => {
  if (!APP_ORIGIN) return "";
  const p = new URLSearchParams({ location_id: locationId, contact_id: contactId });
  if (LOCATION_KEYS[locationId]) p.set("key", LOCATION_KEYS[locationId]);
  return `${APP_ORIGIN}/?${p}`;
};

// Best property address among a contact's custom fields (mirrors the app's
// prefill logic: "…address…short…" first, then property-address, then any).
function bestContactAddress(custom) {
  const score = (k) => {
    const n = k.toLowerCase().replace(/[^a-z]/g, "");
    if (n.includes("address") && n.includes("short")) return 3;
    if (n.includes("property") && n.includes("address")) return 2;
    if (n.includes("address")) return 1;
    return 0;
  };
  let best = "", bestScore = 0;
  for (const [k, v] of Object.entries(custom || {})) {
    const val = String(v || "").trim();
    if (!val) continue;
    const s = score(k);
    if (s > bestScore) { bestScore = s; best = val; }
  }
  return best;
}

const dateLabel = (d = new Date()) =>
  d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

// yyyy-mm-dd (what a date input submits) parses as a LOCAL date so the printed
// label never drifts a day across timezones; anything else passes through as
// the operator typed it. Shared by every document that prints a date.
const dateText = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || "").trim());
  return m ? dateLabel(new Date(+m[1], +m[2] - 1, +m[3])) : String(v || "").trim();
};

// The offer's expiry date: the per-offer "Offer expires" picker when set
// (settings.offerExpires, yyyy-mm-dd, parsed as a local date so the label
// never drifts a day across timezones), else `from` + validityDays.
function offerExpiryDate(settings, from = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(settings.offerExpires || "").trim());
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  return new Date(from.getTime() + settings.validityDays * 86400000);
}

// GHL contact names often arrive lowercased (or SHOUTED) from ingestion.
// Single-case words get Title Case (incl. after - and '); mixed-case words
// (McDonald, DeAngelo) are assumed intentional and left as typed.
function titleCaseName(name) {
  return String(name || "")
    .split(/\s+/)
    .map((w) => {
      if (w !== w.toLowerCase() && w !== w.toUpperCase()) return w;
      return w.toLowerCase().replace(/(^|[-'’])\p{L}/gu, (c) => c.toUpperCase());
    })
    .join(" ")
    .trim();
}

function contactName(c) {
  return titleCaseName([c?.firstName, c?.lastName].filter(Boolean).join(" ") || c?.contactName || "");
}

// Render the offer document through cardgen. Returns { jpeg, width, height }.
async function renderDocument(calc, meta, locationId) {
  if (!CARD_SERVICE_URL) {
    throw Object.assign(new Error("CARD_SERVICE_URL not configured"), { http: 500 });
  }
  const template = buildOfferDocument({ calc, meta, locationId });
  const r = await fetch(`${CARD_SERVICE_URL}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ template, context: {}, store: false, format: "jpeg" }),
  });
  if (!r.ok) {
    throw Object.assign(new Error("document render failed"), {
      http: 502, detail: (await r.text()).slice(0, 300),
    });
  }
  const jpeg = Buffer.from(await r.arrayBuffer());
  return { jpeg, width: template.canvas.width, height: template.canvas.height };
}

// Build the note body attached to the contact.
function offerNoteBody(offer) {
  const { inputs, offers } = offer.calc;
  const lines = [
    `CASH OFFER — ${inputs.address || "subject property"} (${offer.dateLabel})`,
    `Offer: ${fmtMoney(offers.cash.amount)} (as-is, valid through ${offer.validLabel})`,
    `Inputs: ARV ${fmtMoney(inputs.arv)} · repairs ${fmtMoney(inputs.repairs)}` +
      (inputs.askingPrice > 0 ? ` · asking ${fmtMoney(inputs.askingPrice)}` : ""),
  ];
  if (offer.scope?.length) {
    lines.push(`Rehab scope: ${offer.scope.map((s) => `${s.label} ${fmtMoney(s.cost)}`).join("; ")}`);
  }
  // ARV adjustments applied in the comps workspace (busy road, power lines…).
  const cs = offer.snapshot?.comps;
  const adjs = (Array.isArray(cs?.adjustments) ? cs.adjustments : [])
    .map((a) => ({ label: String(a?.label || "").slice(0, 60), pct: Number(a?.pct) || 0 }))
    .filter((a) => a.pct !== 0);
  if (adjs.length) {
    const base = Math.round(Number(cs?.arvBase)) || 0;
    const totalPct = adjs.reduce((t, a) => t + a.pct, 0);
    const adjusted = base ? Math.round((base * (1 + totalPct / 100)) / 1000) * 1000 : 0;
    lines.push(
      `ARV adjustments: ${adjs.map((a) => `${a.label} ${a.pct > 0 ? "+" : "-"}${Math.abs(a.pct)}%`).join(", ")}` +
      (base ? ` (base ${fmtMoney(base)} → ${fmtMoney(adjusted)})` : "")
    );
  }
  const pnotes = String(offer.snapshot?.propertyNotes || "").trim();
  if (pnotes) lines.push(`Property notes: ${pnotes.slice(0, 600)}`);
  if (offer.pdfUrl) lines.push(`Offer letter (PDF): ${offer.pdfUrl}`);
  if (offer.scopePdfUrl) lines.push(`Rehab scope of work (PDF): ${offer.scopePdfUrl}`);
  if (offer.compsPdfUrl) lines.push(`Comparable sales analysis (PDF): ${offer.compsPdfUrl}`);
  if (offer.imageUrl) lines.push(`Offer letter (image): ${offer.imageUrl}`);
  const appLink = offerAppLink(offer.locationId, offer.contactId);
  if (appLink) lines.push(`Edit this offer in the app: ${appLink}&offer_id=${encodeURIComponent(offer.id)}`);
  const zUrl = zillowUrl(inputs.address);
  if (zUrl) lines.push(`Zillow: ${zUrl}`);
  return lines.join("\n");
}

export default function createOffersRouter({ resolveLocation, uploadDir, publicBaseUrl }) {
  const router = express.Router();
  const fail = (res, err) => {
    const code = err.http || err.status || 500;
    if (code >= 500) console.error("offers error:", code, err.message, err.detail || "");
    res.status(code).json({ error: err.message, detail: err.detail });
  };
  // Where generated documents live:
  //   • R2 when configured (permanent public URLs, offloaded bandwidth), else
  //   • Postgres via store.saveOfferDoc, served by the doc routes below —
  //     zero storage configuration and the URLs survive redeploys.
  async function storeDocuments(offerId, locationId, jpeg, pdf, address) {
    if (r2Enabled) {
      const keyBase = `offers/${locationId}/${offerId}`;
      const localOpts = { localDir: uploadDir, localBaseUrl: `${publicBaseUrl}/uploads` };
      const named = (suffix, ext) => ({
        ...localOpts,
        contentDisposition: `inline; filename="${docFilename(address, suffix, ext)}"`,
      });
      return {
        imageUrl: await uploadAsset(`${keyBase}.jpg`, jpeg, "image/jpeg", named("OFFER", "jpg")),
        pdfUrl: await uploadAsset(`${keyBase}.pdf`, pdf, "application/pdf", named("OFFER", "pdf")),
      };
    }
    await store.saveOfferDoc(offerId, "image", jpeg, "image/jpeg");
    await store.saveOfferDoc(offerId, "pdf", pdf, "application/pdf");
    return {
      imageUrl: `${publicBaseUrl}/api/offers/${offerId}/doc.jpg`,
      pdfUrl: `${publicBaseUrl}/api/offers/${offerId}/doc.pdf`,
    };
  }

  // Filename the browser's Save dialog offers for a document, e.g.
  // "7316 166th Avenue East Sumner OFFER.pdf". Content-Disposition quoted
  // strings must stay ASCII and can't contain filesystem-reserved characters.
  const docFilename = (address, suffix, ext) => {
    const addr = String(address || "")
      .replace(/[^\x20-\x7e]/g, "")
      .replace(/[\\/:*?"<>|,]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    return `${addr ? `${addr} ` : ""}${suffix}.${ext}`;
  };

  // Public document routes (the URLs written onto the contact / texted out).
  // No location gate: the unguessable offer UUID is the capability, exactly
  // like a public R2 URL.
  const serveDoc = (kind, suffix, ext) => async (req, res) => {
    try {
      const doc = await store.getOfferDoc(req.params.id, kind);
      if (!doc) return res.status(404).type("text/plain").send("not found");
      const offer = await store.getOffer(req.params.id).catch(() => null);
      res.set("Content-Type", doc.contentType);
      res.set("Content-Disposition", `inline; filename="${docFilename(offer?.address, suffix, ext)}"`);
      res.set("Cache-Control", "public, max-age=31536000, immutable");
      res.send(doc.bytes);
    } catch (err) { fail(res, err); }
  };
  router.get("/:id/doc.pdf", serveDoc("pdf", "OFFER", "pdf"));
  router.get("/:id/doc.jpg", serveDoc("image", "OFFER", "jpg"));
  router.get("/:id/scope.pdf", serveDoc("scopepdf", "REHAB SOW", "pdf"));
  router.get("/:id/comps.pdf", serveDoc("compspdf", "COMPS", "pdf"));
  router.get("/:id/contract.pdf", serveDoc("contractpdf", "CONTRACT", "pdf"));
  router.get("/:id/psa.pdf", serveDoc("psapdf", "PURCHASE AGREEMENT", "pdf"));
  router.get("/:id/assignment.pdf", serveDoc("assignmentpdf", "ASSIGNMENT", "pdf"));
  router.get("/:id/netsheet.pdf", serveDoc("netsheetpdf", "NET COMPARISON", "pdf"));

  /* ---- property photos ----------------------------------------------------
   * Uploaded by the operator, shown in the investor dataroom. Photos belong to
   * the offer (not to a dataroom), so a rebuilt or re-sent package keeps them.
   * The investor-facing read path lives in routes/dataroom.js behind a link
   * token; everything here is location-gated like the rest of this router.
   * ------------------------------------------------------------------------ */

  // A photo arrives as two data URIs the browser already downscaled: `full`
  // (~1600px) for the lightbox and `thumb` (~400px) for grids. Doing it client
  // side avoids an image library on a server that has none.
  const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

  function decodeDataUri(value, label) {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(value || ""));
    if (!m) throw Object.assign(new Error(`${label} must be a base64 image data URI`), { http: 400 });
    const bytes = Buffer.from(m[2], "base64");
    if (!bytes.length) throw Object.assign(new Error(`${label} is empty`), { http: 400 });
    if (bytes.length > MAX_PHOTO_BYTES) {
      throw Object.assign(new Error(`${label} is too large (max 2MB after downscaling)`), { http: 413 });
    }
    // Trust the bytes, not the declared type: check the actual magic number.
    const sniffed =
      bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? "image/jpeg"
      : bytes.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? "image/png"
      : bytes.slice(0, 4).toString("ascii") === "RIFF" && bytes.slice(8, 12).toString("ascii") === "WEBP" ? "image/webp"
      : null;
    if (!sniffed) throw Object.assign(new Error(`${label} isn't a JPEG, PNG or WebP`), { http: 400 });
    return { bytes, contentType: sniffed };
  }

  // Prove the offer is the caller's before touching its photos.
  async function loadOwnOffer(req, res) {
    const { locationId } = resolveLocation(req);
    const offer = await store.getOffer(req.params.id);
    if (!offer || offer.locationId !== locationId) {
      res.status(404).json({ error: "offer not found" });
      return null;
    }
    return { locationId, offer };
  }

  router.get("/:id/photos", async (req, res) => {
    try {
      const ctx = await loadOwnOffer(req, res);
      if (!ctx) return;
      res.json({ photos: await store.listOfferPhotos(ctx.offer.id) });
    } catch (err) { fail(res, err); }
  });

  // One photo per request. A 20-photo batch would be ~7MB of base64 to
  // JSON.parse on a single-threaded process; the client uploads a few at a time
  // instead, so one failure doesn't lose the batch.
  router.post("/:id/photos", async (req, res) => {
    try {
      const ctx = await loadOwnOffer(req, res);
      if (!ctx) return;
      const full = decodeDataUri(req.body?.full, "full");
      const thumb = decodeDataUri(req.body?.thumb, "thumb");
      const photo = await store.saveOfferPhoto(ctx.offer.id, ctx.locationId, {
        variants: { full, thumb },
        width: parseInt(req.body?.width, 10) || null,
        height: parseInt(req.body?.height, 10) || null,
      });
      res.json({ ok: true, photo });
    } catch (err) { fail(res, err); }
  });

  // Rewrites the whole order; "make this the hero" is just moving it to index 0.
  // Fetch a remote image so the browser can downscale it through the normal
  // path. Deliberately does NOT store anything: it returns the bytes as a data
  // URI and the client then posts them to /photos like any other upload, so
  // there is exactly one storage path and one place that decides sizes.
  // See fetch-image.js for the SSRF guards — this endpoint hands a
  // user-supplied URL to the server's network stack.
  router.post("/:id/photos/from-url", async (req, res) => {
    try {
      const ctx = await loadOwnOffer(req, res);
      if (!ctx) return;
      // A /file/d/<id>/view link is a web page, not an image — rewrite it to
      // the bytes before the sniffer (correctly) turns the page away.
      const { bytes, contentType } = await fetchRemoteImage(driveDirectUrl(req.body?.url));
      res.json({
        ok: true,
        contentType,
        dataUrl: `data:${contentType};base64,${bytes.toString("base64")}`,
      });
    } catch (err) { fail(res, err); }
  });

  // Expand a Google Drive FOLDER link into the direct image URLs inside it, so
  // the operator can hand over a whole deal folder instead of pasting thirty
  // links. Like /photos/from-url this stores NOTHING: it answers with URLs and
  // the client then pulls each one back through that same endpoint, so there
  // stays exactly one fetch path, one set of SSRF guards and one place that
  // decides sizes.
  //
  // The API key never leaves the server. Listing needs it; downloading does
  // not — if the listing succeeded the folder is link-shared, and its files
  // are fetchable anonymously. See ../drive-folder.js.
  router.post("/:id/photos/drive-folder", async (req, res) => {
    try {
      const ctx = await loadOwnOffer(req, res);
      if (!ctx) return;
      const folderId = parseDriveFolderId(req.body?.url);
      if (!folderId) return res.status(400).json({ error: "that isn't a Google Drive folder link" });

      const saved = await store.getOfferSettings(ctx.locationId);
      const apiKey = String(saved?.googleApiKey || "").trim();
      if (!apiKey) {
        return res.status(400).json({ error: "Google API key not configured — add it in Settings to import Drive folders" });
      }

      const { files, skipped, truncated } = await listDriveFolderImages(folderId, apiKey);
      res.json({
        ok: true,
        skipped,
        truncated,
        files: files.map((f) => ({ name: f.name, url: driveImageUrl(f.id) })),
      });
    } catch (err) { fail(res, err); }
  });

  router.post("/:id/photos/reorder", async (req, res) => {
    try {
      const ctx = await loadOwnOffer(req, res);
      if (!ctx) return;
      const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
        .filter((v) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v))
        .slice(0, 200);
      await store.reorderOfferPhotos(ctx.offer.id, ids);
      res.json({ ok: true, photos: await store.listOfferPhotos(ctx.offer.id) });
    } catch (err) { fail(res, err); }
  });

  // The operator's own view of a photo. The investor route in routes/dataroom.js
  // is gated by a link token, which the console doesn't have — this one is
  // gated by the location like the rest of this router. Same membership rule:
  // the photo must belong to this offer, never looked up by id alone.
  router.get("/:id/photos/:photoId/:variant", async (req, res) => {
    try {
      const ctx = await loadOwnOffer(req, res);
      if (!ctx) return;
      const variant = req.params.variant === "thumb" ? "thumb" : "full";
      const photos = await store.listOfferPhotos(ctx.offer.id);
      if (!photos.some((p) => p.id === req.params.photoId)) {
        return res.status(404).type("text/plain").send("not found");
      }
      const stored = await store.readPhotoBytes(req.params.photoId, variant);
      if (!stored?.bytes) return res.status(404).type("text/plain").send("not found");
      res.set("Content-Type", stored.contentType || "image/jpeg");
      res.set("Cache-Control", "private, max-age=86400");
      res.set("ETag", `"${req.params.photoId}-${variant}"`);
      res.send(stored.bytes);
    } catch (err) { fail(res, err); }
  });

  router.delete("/:id/photos/:photoId", async (req, res) => {
    try {
      const ctx = await loadOwnOffer(req, res);
      if (!ctx) return;
      const ok = await store.deleteOfferPhoto(ctx.offer.id, req.params.photoId);
      if (!ok) return res.status(404).json({ error: "photo not found" });
      res.json({ ok: true, photos: await store.listOfferPhotos(ctx.offer.id) });
    } catch (err) { fail(res, err); }
  });

  /* ---- property videos ----------------------------------------------------
   * A phone walkthrough is a few hundred MB, so it never travels as one JSON
   * body. The browser asks to begin, PUTs uniform 8MB parts (a request each, so
   * a dropped connection retries one part rather than the file), then completes
   * with the poster frame and dimensions it read locally. Each part is stored
   * as an object of its own (video.js) — never glued into one file, so a bucket
   * with a small per-file limit still holds a long walkthrough — and the broker
   * keeps only the row. The investor read path is in routes/dataroom.js behind
   * a link token, like photos.
   * ------------------------------------------------------------------------ */

  router.get("/:id/videos", async (req, res) => {
    try {
      const ctx = await loadOwnOffer(req, res);
      if (!ctx) return;
      res.json({ videos: await store.listOfferVideos(ctx.offer.id) });
    } catch (err) { fail(res, err); }
  });

  router.post("/:id/videos", async (req, res) => {
    try {
      const ctx = await loadOwnOffer(req, res);
      if (!ctx) return;
      if (!videoStorageReady) return res.status(503).json({ error: VIDEO_STORAGE_HINT });
      const contentType = String(req.body?.contentType || "");
      if (!VIDEO_TYPES[contentType]) return res.status(400).json({ error: "a video has to be an MP4, MOV (QuickTime) or WebM file" });
      const sizeBytes = parseInt(req.body?.sizeBytes, 10);
      if (!(sizeBytes > 0)) return res.status(400).json({ error: "the video's size is missing" });
      if (sizeBytes > MAX_VIDEO_BYTES) {
        return res.status(413).json({ error: `that video is too large (max ${Math.round(MAX_VIDEO_BYTES / 1048576)}MB)` });
      }
      const existing = await store.listOfferVideos(ctx.offer.id);
      if (existing.length >= MAX_VIDEOS_PER_OFFER) {
        return res.status(400).json({ error: `a deal can carry at most ${MAX_VIDEOS_PER_OFFER} videos — delete one first` });
      }
      // The id is minted here because the storage key is built from it.
      const id = crypto.randomUUID();
      const storageKey = videoKey(ctx.locationId, ctx.offer.id, id, contentType);
      const { uploadId } = await beginVideoUpload(storageKey, contentType);
      const video = await store.createOfferVideo(ctx.offer.id, ctx.locationId, {
        id, name: String(req.body?.name || "").replace(/[\u0000-\u001f]/g, "").slice(0, 120),
        contentType, sizeBytes, storageKey, uploadId,
      });
      res.json({ ok: true, video, partBytes: PART_BYTES });
    } catch (err) { fail(res, err); }
  });

  // Parts are raw bytes, not JSON: express.json leaves them alone (wrong
  // content type) and this route-level parser takes them, capped just above
  // the agreed part size so an off-by-one client fails loudly rather than
  // being silently truncated.
  const partBody = express.raw({ type: () => true, limit: PART_BYTES + 4096 });
  router.put("/:id/videos/:videoId/parts/:n", partBody, async (req, res) => {
    try {
      const ctx = await loadOwnOffer(req, res);
      if (!ctx) return;
      const video = await store.getOfferVideo(ctx.offer.id, req.params.videoId);
      if (!video || video.status !== "uploading") return res.status(404).json({ error: "upload not found" });
      const n = parseInt(req.params.n, 10);
      if (!(n >= 1 && n <= MAX_PARTS)) return res.status(400).json({ error: "bad part number" });
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!body.length) return res.status(400).json({ error: "that part is empty" });
      if (body.length > PART_BYTES) return res.status(413).json({ error: "that part is larger than the agreed size" });
      // Trust the bytes, not the declared type — same rule as photos, checked
      // on the part that carries the file header.
      if (n === 1 && !sniffVideoType(body)) return res.status(400).json({ error: "that file doesn't look like a video" });
      const { etag } = await putVideoPart(video.storageKey, video.uploadId, n, body);
      res.json({ ok: true, etag });
    } catch (err) { fail(res, err); }
  });

  router.post("/:id/videos/:videoId/complete", async (req, res) => {
    try {
      const ctx = await loadOwnOffer(req, res);
      if (!ctx) return;
      const video = await store.getOfferVideo(ctx.offer.id, req.params.videoId);
      if (!video || video.status !== "uploading") return res.status(404).json({ error: "upload not found" });
      const parts = (Array.isArray(req.body?.parts) ? req.body.parts : [])
        .map((p) => ({ partNumber: parseInt(p?.n, 10), etag: String(p?.etag || "") }))
        .filter((p) => p.partNumber >= 1 && p.etag)
        .sort((a, b) => a.partNumber - b.partNumber);
      if (!parts.length || parts.some((p, i) => p.partNumber !== i + 1)) {
        return res.status(400).json({ error: "the upload is missing parts — try that video again" });
      }
      // The poster is what the gallery tile shows and what the viewer paints
      // before playback; without one the tile would be a black box.
      const posters = {
        full: decodeDataUri(req.body?.poster?.full, "poster"),
        thumb: decodeDataUri(req.body?.poster?.thumb, "poster thumbnail"),
      };
      const { size } = await finishVideoUpload(video.storageKey, video.uploadId, parts);
      if (size > MAX_VIDEO_BYTES) {
        await deleteVideoObject(video.storageKey).catch(() => {});
        await store.deleteOfferVideo(ctx.offer.id, video.id);
        return res.status(413).json({ error: `that video is too large (max ${Math.round(MAX_VIDEO_BYTES / 1048576)}MB)` });
      }
      const done = await store.finishOfferVideo(ctx.offer.id, video.id, {
        sizeBytes: size,
        width: parseInt(req.body?.width, 10) || null,
        height: parseInt(req.body?.height, 10) || null,
        durationS: Number.isFinite(Number(req.body?.durationS)) ? Number(req.body.durationS) : null,
        posters,
      });
      res.json({ ok: true, video: done });
    } catch (err) { fail(res, err); }
  });

  // The operator's own poster and playback, gated by location like the photo
  // view above. The investor routes live in routes/dataroom.js behind a token.
  router.get("/:id/videos/:videoId/poster/:variant", async (req, res) => {
    try {
      const ctx = await loadOwnOffer(req, res);
      if (!ctx) return;
      const variant = req.params.variant === "thumb" ? "thumb" : "full";
      const video = await store.getOfferVideo(ctx.offer.id, req.params.videoId);
      if (!video || video.status !== "ready") return res.status(404).type("text/plain").send("not found");
      const stored = await store.readVideoPoster(video.id, variant);
      if (!stored?.bytes) return res.status(404).type("text/plain").send("not found");
      res.set("Content-Type", stored.contentType || "image/jpeg");
      res.set("Cache-Control", "private, max-age=86400");
      res.set("ETag", `"${video.id}-poster-${variant}"`);
      res.send(stored.bytes);
    } catch (err) { fail(res, err); }
  });

  router.get("/:id/videos/:videoId/stream", async (req, res) => {
    try {
      const ctx = await loadOwnOffer(req, res);
      if (!ctx) return;
      const video = await store.getOfferVideo(ctx.offer.id, req.params.videoId);
      if (!video || video.status !== "ready") return res.status(404).type("text/plain").send("not found");
      res.set("Cache-Control", "private, max-age=86400");
      res.set("X-Content-Type-Options", "nosniff");
      const served = await streamVideo(req, res, { key: video.storageKey, contentType: video.contentType, etag: `"${video.id}"`, size: video.sizeBytes });
      if (!served) res.status(404).type("text/plain").send("not found");
    } catch (err) { if (!res.headersSent) fail(res, err); else res.destroy(); }
  });

  // Row first, bytes second: the investor page stops listing the video the
  // instant the row is gone, and a failed bucket delete is only a stray object.
  router.delete("/:id/videos/:videoId", async (req, res) => {
    try {
      const ctx = await loadOwnOffer(req, res);
      if (!ctx) return;
      const video = await store.deleteOfferVideo(ctx.offer.id, req.params.videoId);
      if (!video) return res.status(404).json({ error: "video not found" });
      try {
        if (video.status === "uploading" && video.uploadId) await abortVideoUpload(video.storageKey, video.uploadId);
        else await deleteVideoObject(video.storageKey);
      } catch (e) { console.warn("video bytes not removed:", video.storageKey, e.message); }
      res.json({ ok: true, videos: await store.listOfferVideos(ctx.offer.id) });
    } catch (err) { fail(res, err); }
  });

  // Render a companion PDF (Rehab SOW, Comps Analysis) through cardgen and
  // store it next to the offer documents. Accepts one template per page.
  // Best-effort at every call site: a failure never blocks the offer itself.
  async function storeCompanionPdf({ offerId, locationId, templates, kind, slug, docKind, address, suffix }) {
    const pages = [];
    for (const template of templates) {
      const r = await fetch(`${CARD_SERVICE_URL}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template, context: {}, store: false, format: "jpeg" }),
      });
      if (!r.ok) throw new Error(`${kind} render ${r.status}`);
      pages.push({ jpeg: Buffer.from(await r.arrayBuffer()), width: template.canvas.width, height: template.canvas.height });
    }
    const pdf = jpegsToPdf(pages);
    if (r2Enabled) {
      const localOpts = {
        localDir: uploadDir,
        localBaseUrl: `${publicBaseUrl}/uploads`,
        contentDisposition: `inline; filename="${docFilename(address, suffix, "pdf")}"`,
      };
      return uploadAsset(`offers/${locationId}/${offerId}-${slug}.pdf`, pdf, "application/pdf", localOpts);
    }
    await store.saveOfferDoc(offerId, docKind, pdf, "application/pdf");
    return `${publicBaseUrl}/api/offers/${offerId}/${slug}.pdf`;
  }

  async function storeScopeDocument({ offerId, locationId, scope, total, address, meta, company, assessment }) {
    const templates = [buildScopeDocument({ scope, total, address, meta, company, locationId })];
    // Page 2 — condition summary + per-item rationale (when a photo review ran).
    const notesTemplate = assessment
      ? buildScopeNotesDocument({ ...assessment, address, meta, company, locationId })
      : null;
    if (notesTemplate) templates.push(notesTemplate);
    return storeCompanionPdf({ offerId, locationId, templates, kind: "scope", slug: "scope", docKind: "scopepdf", address, suffix: "REHAB SOW" });
  }

  async function storeCompsDocument({ offerId, locationId, meta, company, ...doc }) {
    const template = buildCompsDocument({ ...doc, meta, company, locationId });
    if (!template) return null; // no priced comps selected — nothing to render
    return storeCompanionPdf({ offerId, locationId, templates: [template], kind: "comps", slug: "comps", docKind: "compspdf", address: doc.address, suffix: "COMPS" });
  }

  async function storeNetSheetDocument({ offerId, locationId, net, address, meta, company }) {
    const template = buildNetSheetDocument({ net, address, meta, company, locationId });
    if (!template) return null; // no positive offer amount — nothing to compare
    return storeCompanionPdf({ offerId, locationId, templates: [template], kind: "netsheet", slug: "netsheet", docKind: "netsheetpdf", address, suffix: "NET COMPARISON" });
  }

  /* ---------- settings ---------- */
  router.get("/settings", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const saved = await store.getOfferSettings(locationId);
      res.json({ settings: effectiveSettings(saved || {}) });
    } catch (err) { fail(res, err); }
  });

  router.put("/settings", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const { location_id, ...body } = req.body || {};
      const settings = effectiveSettings(body.settings || body);
      await store.saveOfferSettings(locationId, settings);
      res.json({ ok: true, settings });
    } catch (err) { fail(res, err); }
  });

  /* ---------- PSA exhibits (standing files, not per-offer) ---------- */
  // Body: { kind: "emdCheck" | "proofOfFunds", dataUri }. Stores one file and
  // returns its URL for the operator to save into settings.psa. These are
  // standing documents — the same earnest money check and proof-of-funds letter
  // ride along on every agreement — so they live in Settings rather than being
  // re-uploaded per offer. Settings also accepts a pasted URL directly; this
  // route exists because the operator usually has a file, not a link.
  const EXHIBIT_KINDS = ["emdCheck", "proofOfFunds"];
  const MAX_EXHIBIT_BYTES = 8 * 1024 * 1024;

  router.post("/settings/exhibit", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const kind = String(req.body?.kind || "");
      if (!EXHIBIT_KINDS.includes(kind)) return res.status(400).json({ error: "unknown exhibit kind" });

      const m = /^data:(application\/pdf|image\/(?:jpeg|png));base64,(.+)$/.exec(String(req.body?.dataUri || ""));
      if (!m) return res.status(400).json({ error: "exhibit must be a PDF, JPEG or PNG data URI" });
      const bytes = Buffer.from(m[2], "base64");
      if (!bytes.length) return res.status(400).json({ error: "that file is empty" });
      if (bytes.length > MAX_EXHIBIT_BYTES) return res.status(413).json({ error: "that file is too large (max 8MB)" });

      // Trust the bytes, not the declared type — same rule the photo path uses.
      const sniffed = sniffPdf(bytes) || sniffImageType(bytes);
      if (sniffed !== "application/pdf" && sniffed !== "image/jpeg" && sniffed !== "image/png") {
        return res.status(400).json({ error: "that file isn't a PDF, JPEG or PNG" });
      }
      const ext = sniffed === "application/pdf" ? "pdf" : sniffed === "image/png" ? "png" : "jpg";

      // Content-addressed: replacing the file gets a new URL, so a cached copy
      // of the old one can never be the thing an agreement links to.
      const digest = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 12);
      const url = await uploadAsset(
        `psa-exhibits/${locationId}/${kind}-${digest}.${ext}`, bytes, sniffed,
        { localDir: uploadDir, localBaseUrl: `${publicBaseUrl}/uploads` }
      );
      res.json({ ok: true, url, contentType: sniffed });
    } catch (err) { fail(res, err); }
  });

  /* ---------- pure calculation (live preview as the user types) ---------- */
  router.post("/calculate", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const saved = await store.getOfferSettings(locationId);
      const calc = calculateOffers(req.body?.inputs || {}, { ...(saved || {}), ...(req.body?.settings || {}) });
      res.json(calc);
    } catch (err) { fail(res, err); }
  });

  /* ---------- document preview (no contact, no persistence) ---------- */
  router.post("/preview", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const saved = await store.getOfferSettings(locationId);
      const calc = calculateOffers(req.body?.inputs || {}, { ...(saved || {}), ...(req.body?.settings || {}) });
      const validUntil = offerExpiryDate(calc.settings);
      const { jpeg } = await renderDocument(calc, {
        contactName: titleCaseName(req.body?.contactName || ""),
        dateLabel: dateLabel(),
        validLabel: dateLabel(validUntil),
      }, locationId);
      res.json({ image: `data:image/jpeg;base64,${jpeg.toString("base64")}`, calc });
    } catch (err) { fail(res, err); }
  });

  /* ---------- contact typeahead ---------- */
  router.get("/contacts", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const q = String(req.query.query || "").trim();
      if (!q) return res.json({ contacts: [] });
      const results = await searchContacts(client, locationId, q);
      res.json({
        contacts: (results || []).slice(0, 20).map((c) => ({
          id: c.id,
          name: contactName(c),
          phone: c.phone || "",
          email: c.email || "",
        })),
      });
    } catch (err) { fail(res, err); }
  });

  /* ---------- contact detail (custom fields, for address prefill) ---------- */
  router.get("/contacts/:id", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const contact = await getContact(client, req.params.id);
      const map = await customFieldIdKeyMap(client, locationId);
      // Recent notes ride along (best-effort — a notes failure never blocks
      // the contact prefill).
      let notes = [];
      try {
        notes = (await getContactNotes(client, req.params.id))
          .sort((a, b) => new Date(b.dateAdded || 0) - new Date(a.dateAdded || 0))
          .slice(0, 5)
          .map((n) => ({ body: String(n.body || "").slice(0, 500), dateAdded: n.dateAdded || null }));
      } catch { /* notes are optional */ }
      res.json({
        contact: {
          id: contact.id || req.params.id,
          name: contactName(contact),
          phone: contact.phone || "",
          email: contact.email || "",
          custom: contactCustomRecord(contact, map),
          notes,
        },
      });
    } catch (err) { fail(res, err); }
  });

  /* ---------- contact notes (full list + add, for the notes panel) ---------- */
  // Unlike the best-effort embed on /contacts/:id, errors here are returned
  // to the client — a missing notes scope on the GHL token should be visible,
  // not silently an empty list.
  router.get("/contacts/:id/notes", async (req, res) => {
    try {
      const { client } = resolveLocation(req);
      const notes = (await getContactNotes(client, req.params.id))
        .sort((a, b) => new Date(b.dateAdded || 0) - new Date(a.dateAdded || 0))
        .slice(0, 50)
        .map((n) => ({ id: n.id || null, body: String(n.body || ""), dateAdded: n.dateAdded || null }));
      res.json({ notes });
    } catch (err) { fail(res, err); }
  });

  router.post("/contacts/:id/notes", async (req, res) => {
    try {
      const { client } = resolveLocation(req);
      const body = String(req.body?.body || "").trim();
      if (!body) return res.status(400).json({ error: "note body required" });
      const note = await createContactNote(client, req.params.id, { body: body.slice(0, 5000) });
      res.json({ ok: true, note });
    } catch (err) { fail(res, err); }
  });

  /* ---------- AI contact enrichment (conversation history → fields + tags) ---------- */
  // Preview: pull the contact's conversation transcript, run Claude, return
  // proposed field values + tag changes. NO writes — the /apply route below
  // does those after the user reviews the diff.
  router.post("/contacts/:id/enrich", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const saved = await store.getOfferSettings(locationId);
      const aiApiKey = String(saved?.aiApiKey || "").trim();
      if (!aiApiKey) return res.status(400).json({ error: "Anthropic API key required — add it in Settings → AI features" });

      const contact = await getContact(client, req.params.id);
      if (!contact) return res.status(404).json({ error: "contact not found" });
      const idKeyMap = await customFieldIdKeyMap(client, locationId);
      const currentFields = contactCustomRecord(contact, idKeyMap);
      const currentTags = (contact.tags || []).map((t) => String(t).toLowerCase());

      const typeInferred = inferContactType(currentTags);
      const type = ["agent", "investor"].includes(req.body?.type) ? req.body.type : typeInferred;
      if (!type) return res.json({ ok: false, needsType: true });

      let transcript;
      try {
        transcript = await buildTranscript(client, locationId, req.params.id);
      } catch (e) {
        if (e?.status === 401 || e?.status === 403) return res.json({ ok: false, scopeMissing: true });
        throw e;
      }
      if (!transcript.stats.messages) return res.json({ ok: false, empty: true, typeInferred });

      // App-side ground truth for the deal-history ledger: deals this contact
      // is on, plus (agents) every offer we've sent them. Best-effort.
      const authLines = [];
      try {
        for (const o of await store.listDeals(locationId, { limit: 500 })) {
          const d = o.deal || {};
          if (type === "agent" && o.contactId === req.params.id) {
            authLines.push(historyLine(
              d.updatedAt || d.createdAt, o.address,
              String(d.stage || "").replace(/_/g, " "),
              d.stage === "fell_through" ? d.fellThroughReason || "" : ""
            ));
          }
          if (type === "investor") {
            const inv = (d.investors || []).find((i) => i.contactId === req.params.id);
            if (inv) authLines.push(historyLine(inv.updatedAt || inv.addedAt, o.address, inv.status || "sent"));
          }
        }
        if (type === "agent") {
          for (const o of await store.listOffers(locationId, { contactId: req.params.id, limit: 50 })) {
            if (o.status === "draft") continue;
            authLines.push(historyLine(o.createdAt, o.address, `we offered ${fmtMoney(o.cashAmount)}`));
          }
        }
      } catch (e) { console.error("enrich: deal history lookup failed:", e?.message); }

      let raw;
      try {
        raw = await runEnrichment({
          contact, currentFields, currentTags, transcript, type,
          extraInstructions: String(saved?.enrichExtraInstructions || "").trim(),
          dealContext: authLines.length ? authLines.join("\n") : null,
          aiApiKey,
        });
      } catch (e) { throw anthropicErrorToHttp(e); }

      // Flatten to UI-ready diff rows. "unknown"/empty proposals become null
      // (nothing to apply); last_convo_date is server-computed, not AI.
      const rows = [];
      for (const def of enrichFieldDefs(type)) {
        if (def.key === "enrich_last_run") continue; // stamped on apply
        let proposed = null;
        let reason = "";
        if (def.serverSet) {
          if (def.key === "last_convo_date" && transcript.lastMessageAt) {
            proposed = transcript.lastMessageAt.slice(0, 10);
            reason = "date of the newest message";
          }
        } else if (def.append) {
          // History ledger: propose the full server-merged value (existing +
          // app records + AI's new events) so the diff shows the real result.
          const entry = raw.fields?.[def.key];
          const delta = String(entry?.value ?? "").trim();
          const merged = mergeHistory(currentFields[def.key], [...authLines, delta === "unknown" ? "" : delta]);
          if (merged && merged !== String(currentFields[def.key] ?? "").trim()) proposed = merged;
          reason = String(entry?.reason || "") || (authLines.length ? "from app deal records" : "");
        } else {
          const entry = raw.fields?.[def.key];
          const v = entry?.value;
          if (v !== null && v !== undefined) {
            const sv = String(v).trim();
            if (sv && sv !== "unknown") proposed = def.dataType === "NUMERICAL" ? Number(v) : sv;
          }
          reason = String(entry?.reason || "");
        }
        const current = String(currentFields[def.key] ?? "").trim() || null;
        rows.push({
          key: def.key, name: def.name, dataType: def.dataType,
          values: def.values || null, multi: Boolean(def.multi), append: Boolean(def.append),
          current, proposed, reason,
        });
      }

      // Tag changes: whitelist, drop no-ops, and expand mutual exclusivity —
      // adding one tag of a group removes its currently-present siblings.
      const vocab = new Set(enrichTagVocab(type));
      const has = (t) => currentTags.includes(t);
      const add = [...new Set((raw.tags?.add || []).filter((t) => vocab.has(t) && !has(t)))];
      const remove = new Set((raw.tags?.remove || []).filter((t) => vocab.has(t) && has(t)));
      for (const group of ENRICH_TAG_GROUPS[type] || []) {
        for (const t of add) {
          if (!group.includes(t)) continue;
          for (const sib of group) if (sib !== t && has(sib)) remove.add(sib);
        }
      }

      res.json({
        ok: true, type, typeInferred,
        proposal: {
          fields: rows,
          tags: { add, remove: [...remove] },
          summary: String(raw.summary || ""),
          confidence: raw.confidence || "low",
        },
        transcriptStats: transcript.stats,
      });
    } catch (err) { fail(res, err); }
  });

  // Apply the (user-edited) proposal: custom fields + tags + optional summary
  // note. Validates everything against the schema consts — the UI can only
  // send what the vocabulary allows.
  router.post("/contacts/:id/enrich/apply", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const type = ["agent", "investor"].includes(req.body?.type) ? req.body.type : null;
      if (!type) return res.status(400).json({ error: "type must be agent or investor" });

      const defs = new Map(enrichFieldDefs(type).map((f) => [f.key, f]));
      const fields = req.body?.fields && typeof req.body.fields === "object" ? req.body.fields : {};
      const vocab = new Set(enrichTagVocab(type));
      const tagsAdd = [...new Set((req.body?.tags?.add || []).filter((t) => vocab.has(t)))];
      const tagsRemove = [...new Set((req.body?.tags?.remove || []).filter((t) => vocab.has(t)))];
      const note = String(req.body?.note || "").trim().slice(0, 4000);

      const writes = {};
      for (const [k, v] of Object.entries(fields)) {
        const def = defs.get(k);
        if (!def) return res.status(400).json({ error: `unknown field: ${k}` });
        const sv = String(v ?? "").trim();
        if (!sv || sv === "unknown") continue;
        if (def.dataType === "NUMERICAL") {
          const n = Number(String(sv).replace(/[$,\s]/g, ""));
          if (!Number.isFinite(n)) return res.status(400).json({ error: `invalid number for ${k}` });
          writes[k] = n;
        } else if (def.values && !def.multi) {
          if (!def.values.includes(sv)) return res.status(400).json({ error: `invalid value for ${k}: ${sv}` });
          writes[k] = sv;
        } else if (def.values && def.multi) {
          const parts = sv.split(",").map((p) => p.trim()).filter(Boolean);
          if (parts.some((p) => !def.values.includes(p))) {
            return res.status(400).json({ error: `invalid value for ${k}: ${sv}` });
          }
          writes[k] = parts.join(", ");
        } else if (def.append) {
          // History ledger: the UI sends the user-approved merged value.
          // Normalize/dedupe and cap by dropping the OLDEST lines (a plain
          // tail-slice would delete the newest events).
          writes[k] = mergeHistory(sv, []);
        } else {
          writes[k] = sv.slice(0, 2000);
        }
      }
      if (!Object.keys(writes).length && !tagsAdd.length && !tagsRemove.length && !note) {
        return res.status(400).json({ error: "nothing to apply" });
      }
      // Full timestamp (not date-only) so the sweep's already-enriched skip
      // can compare against the contact's newest message precisely.
      writes.enrich_last_run = new Date().toISOString();

      // Each GHL write is independent; failures become warnings, not errors.
      const warnings = [];
      const ghl = { fields: false, tagsAdded: false, tagsRemoved: false, note: false };
      try {
        const fieldWrites = [];
        for (const [k, v] of Object.entries(writes)) {
          const def = defs.get(k);
          const id = await findOrCreateCustomFieldByKey(client, locationId, k, def.name, def.dataType);
          if (id) fieldWrites.push({ id, value: v });
        }
        if (fieldWrites.length) {
          await updateContact(client, req.params.id, { customFields: fieldWrites });
          ghl.fields = true;
        }
      } catch (e) { warnings.push(`fields: ${e.message}`); }
      if (tagsAdd.length) {
        try { await addContactTags(client, req.params.id, tagsAdd); ghl.tagsAdded = true; }
        catch (e) { warnings.push(`tags add: ${e.message}`); }
      }
      if (tagsRemove.length) {
        try { await removeContactTags(client, req.params.id, tagsRemove); ghl.tagsRemoved = true; }
        catch (e) { warnings.push(`tags remove: ${e.message}`); }
      }
      if (note) {
        try {
          await createContactNote(client, req.params.id, { body: `AI ENRICHMENT — ${dateLabel()}\n${note}` });
          ghl.note = true;
        } catch (e) { warnings.push(`note: ${e.message}`); }
      }

      // Best-effort refetch so the UI can show the post-apply state.
      let updated = null;
      try {
        const idKeyMap = await customFieldIdKeyMap(client, locationId);
        const c = await getContact(client, req.params.id);
        updated = { custom: contactCustomRecord(c, idKeyMap), tags: c.tags || [] };
      } catch { /* preview state is close enough */ }

      res.json({ ok: true, ghl, updated, warnings });
    } catch (err) { fail(res, err); }
  });

  /* ---------- batch enrichment sweep ---------- */
  // Start a sweep over every contact with conversation activity since
  // `since` (ISO, computed client-side so "today" means the user's midnight).
  // Body: { since, windowLabel?, types?: ["agent","investor"], maxContacts?,
  // repliesOnly? } — repliesOnly (default true) skips the AI call for
  // contacts whose window activity is outbound-only.
  // Runs in the background; poll GET /enrich/sweep for progress.
  router.post("/enrich/sweep", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const saved = await store.getOfferSettings(locationId);
      if (!String(saved?.aiApiKey || "").trim()) {
        return res.status(400).json({ error: "Anthropic API key required — add it in Settings → AI features" });
      }
      const sinceMs = new Date(String(req.body?.since || "")).getTime();
      const now = Date.now();
      if (!Number.isFinite(sinceMs) || sinceMs >= now || sinceMs < now - 90 * 86400000) {
        return res.status(400).json({ error: "since must be an ISO time within the last 90 days" });
      }
      const types = ["agent", "investor"].filter((t) =>
        Array.isArray(req.body?.types) ? req.body.types.includes(t) : true);
      if (!types.length) return res.status(400).json({ error: "types must include agent and/or investor" });
      // No cap by default (0 = unlimited): the already-enriched skip +
      // replied-only filter are the real cost control, and collection is
      // naturally bounded by the conversation scan (MAX_PAGES in enrich-sweep).
      const maxContacts = Math.max(0, Number(req.body?.maxContacts) || 0);

      const job = startSweep({
        client, locationId, saved, store,
        sinceIso: new Date(sinceMs).toISOString(),
        windowLabel: String(req.body?.windowLabel || "").slice(0, 60),
        types, maxContacts,
        repliesOnly: req.body?.repliesOnly !== false,
        trigger: "manual",
      });
      res.json({ ok: true, job: publicSweepJob(job) });
    } catch (err) { fail(res, err); }
  });

  router.get("/enrich/sweep", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      res.json({ job: publicSweepJob(getSweepJob(locationId)) });
    } catch (err) { fail(res, err); }
  });

  router.post("/enrich/sweep/cancel", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      res.json({ ok: true, canceled: cancelSweepJob(locationId) });
    } catch (err) { fail(res, err); }
  });

  /* ---------- full contact record (Fields Manager preview) ---------- */
  // Standard fields + every custom-field definition joined with the contact's
  // values (tagged by which app feature owns the field), plus the contact's
  // app deals (agent side and/or linked investor).
  router.get("/contacts/:id/record", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const [contact, defs, deals] = await Promise.all([
        getContact(client, req.params.id),
        listCustomFieldsRaw(client, locationId),
        store.listDeals(locationId).catch(() => []),
      ]);
      if (!contact) return res.status(404).json({ error: "contact not found" });

      const rawValues = contact.customFields || contact.customField || [];
      const valueById = new Map(rawValues.map((f) => [f.id, f.value ?? f.fieldValue ?? ""]));

      const fields = [];
      for (const def of defs) {
        if (def.model && def.model !== "contact") continue;
        const key = String(def.fieldKey || "").replace(/^contact\./, "") || def.id;
        // Same match rule as findOrCreateCustomFieldByKey: key OR name.
        const reg = registryByKey.get(key)
          || APP_FIELD_REGISTRY.find((f) => f.name.toLowerCase() === String(def.name || "").toLowerCase());
        fields.push({
          id: def.id,
          key,
          fieldKey: def.fieldKey || null,
          name: def.name || key,
          dataType: def.dataType || "TEXT",
          picklistOptions: Array.isArray(def.picklistOptions) ? def.picklistOptions : null,
          value: String(valueById.get(def.id) ?? ""),
          source: reg?.source || "other",
          values: reg?.values || null,
          multi: Boolean(reg?.multi),
          serverSet: Boolean(reg?.serverSet),
          append: Boolean(reg?.append),
          keyMismatch: Boolean(reg && reg.key !== key),
        });
      }

      const contactDeals = [];
      for (const o of deals) {
        const d = o.deal || {};
        const base = {
          id: o.id, address: o.address || null, stage: d.stage,
          contractPrice: d.contractPrice ?? null, assignmentFee: d.assignmentFee ?? null,
          closingDate: d.closingDate || null,
        };
        if (o.contactId === req.params.id) contactDeals.push({ ...base, role: "agent" });
        const inv = (d.investors || []).find((i) => i.contactId === req.params.id);
        if (inv) contactDeals.push({ ...base, role: "investor", investorStatus: inv.status });
      }

      res.json({
        record: {
          contact: {
            id: contact.id || req.params.id,
            firstName: contact.firstName || "",
            lastName: contact.lastName || "",
            name: contactName(contact),
            phone: contact.phone || "",
            email: contact.email || "",
            tags: contact.tags || [],
            dateAdded: contact.dateAdded || null,
            source: contact.source || null,
            address1: contact.address1 || "",
            city: contact.city || "",
            state: contact.state || "",
            postalCode: contact.postalCode || "",
          },
          fields,
          deals: contactDeals,
        },
      });
    } catch (err) { fail(res, err); }
  });

  // Save edits from the Fields Manager preview. Body:
  // { standard?: { firstName, lastName, phone, email }, fields?: [{ id, key?, value }] }.
  // Writes by field id only; values validated against the app registry when
  // the key is one the app owns.
  router.put("/contacts/:id/record", async (req, res) => {
    try {
      const { client } = resolveLocation(req);

      const fieldWrites = [];
      for (const f of Array.isArray(req.body?.fields) ? req.body.fields : []) {
        const id = String(f?.id || "").trim();
        if (!id) return res.status(400).json({ error: "field id required" });
        const key = String(f?.key || "").trim();
        const reg = key ? registryByKey.get(key) : null;
        let value = String(f?.value ?? "").trim();
        if (reg?.dataType === "NUMERICAL" && value) {
          const n = Number(value.replace(/[$,\s]/g, ""));
          if (!Number.isFinite(n)) return res.status(400).json({ error: `invalid number for ${key}` });
          value = n;
        } else if (reg?.values && !reg.multi && value) {
          if (!reg.values.includes(value)) return res.status(400).json({ error: `invalid value for ${key}: ${value}` });
        } else if (reg?.values && reg.multi && value) {
          const parts = value.split(",").map((p) => p.trim()).filter(Boolean);
          if (parts.some((p) => !reg.values.includes(p))) {
            return res.status(400).json({ error: `invalid value for ${key}: ${value}` });
          }
          value = parts.join(", ");
        } else if (typeof value === "string") {
          value = value.slice(0, 2000);
        }
        fieldWrites.push({ id, value });
      }

      const standard = {};
      const std = req.body?.standard || {};
      for (const k of ["firstName", "lastName", "phone", "email"]) {
        if (std[k] !== undefined) standard[k] = String(std[k] ?? "").trim().slice(0, 200);
      }

      if (!fieldWrites.length && !Object.keys(standard).length) {
        return res.status(400).json({ error: "nothing to save" });
      }
      await updateContact(client, req.params.id, {
        ...standard,
        ...(fieldWrites.length ? { customFields: fieldWrites } : {}),
      });
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });

  /* ---------- address autocomplete (OSM/Photon, confirmed by Census) ---------- */
  router.get("/address-suggest", async (req, res) => {
    try {
      resolveLocation(req);
      const q = String(req.query.query || "").trim();
      if (q.length < 4) return res.json({ suggestions: [] });
      const suggestions = [];
      try {
        const r = await fetch(
          `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8&lang=en`,
          { signal: AbortSignal.timeout(4000) }
        );
        const j = r.ok ? await r.json() : null;
        for (const f of j?.features || []) {
          const p = f.properties || {};
          if ((p.countrycode || "").toLowerCase() !== "us") continue;
          if (!p.housenumber || !p.street) continue; // real street addresses only
          const street = `${p.housenumber} ${p.street}`;
          const label = [
            street,
            p.city || p.district || p.county,
            [p.state, p.postcode].filter(Boolean).join(" "),
          ].filter(Boolean).join(", ");
          if (!suggestions.includes(label)) suggestions.push(label);
          if (suggestions.length >= 6) break;
        }
      } catch { /* Photon down — the confirmation below still stands a chance */ }
      // OSM has no node for a great many ordinary US houses, so a perfectly
      // real address can autocomplete to nothing and look like a typo. When
      // what's typed already looks like a whole street address, ask the
      // geocoder to confirm it and offer the address it actually resolved.
      if (!suggestions.length && /^\s*\d+\s+\S+/.test(q)) {
        const geo = await geocodeAddress(q, { minPrecision: "address" });
        if (geo?.matched) suggestions.push(geo.matched);
      }
      res.json({ suggestions });
    } catch {
      res.json({ suggestions: [] }); // autocomplete is best-effort — never block typing
    }
  });

  /* ---------- geocode (map centering for the comps pane) ---------- */
  router.get("/geocode", async (req, res) => {
    try {
      resolveLocation(req);
      const q = String(req.query.query || "").trim();
      if (q.length < 4) return res.json({ result: null });
      res.json({ result: await geocodeAddress(q) });
    } catch {
      res.json({ result: null });
    }
  });

  /* ---------- comps (RealEstateAPI.com v3, key configured in Settings) ---------- */
  // The pull itself lives in ../comps-pull.js so the auto-underwrite pipeline
  // can call it directly instead of round-tripping HTTP to this same server.
  router.get("/comps", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const address = String(req.query.address || "").trim();
      if (!address) return res.status(400).json({ error: "address required" });

      const saved = await store.getOfferSettings(locationId);
      const source = saved?.compsSource === "realestateapi" ? "realestateapi" : "zillow";
      const apifyToken = String(saved?.apifyToken || "").trim();
      const apiKey = String(saved?.compsApiKey || saved?.rentcastApiKey || "").trim();

      const months = Math.min(24, Math.max(1, parseInt(req.query.months, 10) || 12));
      const sqft = parseInt(req.query.sqft, 10) || 0;
      const beds = Math.max(0, parseInt(req.query.beds, 10) || 0);
      const baths = Math.max(0, parseFloat(req.query.baths) || 0);

      let data;
      let geo = null;
      if (source === "zillow") {
        if (!apifyToken) return res.json({ enabled: false, comps: [], estimate: null, subject: null });
        // Zillow's sold map has no subject record, so the centre comes from a
        // free geocode and the facts come from whatever the pane already knows.
        // Typing beds/baths/sqft therefore does more work here than it did
        // against the county-record provider, which filled them in for you.
        geo = await geocodeAddress(address);
        if (!geo) return res.status(404).json({ error: "couldn't locate that address on the map" });
        data = await pullZillowComps({
          apifyToken, lat: geo.lat, lng: geo.lng,
          beds, baths, sqft,
          radiusMiles: Math.min(5, Math.max(0.1, parseFloat(req.query.radius) || 0.5)),
          monthsBack: months,
          // The pane RANKS rather than filters — every comp arrives with a
          // match chip and you tick the ones you want — so it gets the same
          // wide bands the automation ranks over. On the tight bands a real
          // Seattle address returned two comps, which is not a board.
          bedTolerance: UW_POOL_BEDS_TOLERANCE,
          bathTolerance: UW_POOL_BATHS_TOLERANCE,
          sqftPct: UW_POOL_SQFT_PCT,
        });
      } else {
        if (!apiKey) return res.json({ enabled: false, comps: [], estimate: null, subject: null });
        data = await pullComps({ apiKey, address, months, sqft, beds, baths });
      }
      // AI condition grading needs both the Anthropic key and the Apify
      // token (Zillow photos) — tell the UI whether to offer the button.
      res.json({
        ...data,
        source,
        // Zillow comps are searched in a circle around a geocode. When that
        // geocode is only a ZIP or city centroid the board is still worth
        // looking at, but the operator has to be told it isn't centred on the
        // house — the pane says so above the comps.
        geo: geo ? { precision: geo.precision, matched: geo.matched || null } : null,
        gradeEnabled: Boolean(String(saved?.aiApiKey || "").trim() && apifyToken),
      });
    } catch (err) { fail(res, err); }
  });

  /* ---------- AI comp condition grading (renovated / updated / dated …) ---------- */
  // POST { address, comps: [{id, address, price, sqft, beds, baths, saleDate}] }
  // For each comp: pull the Zillow sold-listing photos + description (Apify),
  // then one batched Claude call grades them all. ARV should be derived from
  // renovated/updated comps — that's what "after repair" means. The client
  // sends comps in small chunks (~4) so each request stays fast.
  router.post("/comps/grade", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const subjectAddress = String(req.body?.address || "").trim();
      const comps = (Array.isArray(req.body?.comps) ? req.body.comps : [])
        .filter((c) => c && c.id && String(c.address || "").trim())
        .slice(0, 12);
      if (!comps.length) return res.status(400).json({ error: "comps required" });

      const saved = await store.getOfferSettings(locationId);
      const aiApiKey = String(saved?.aiApiKey || "").trim();
      const apifyToken = String(saved?.apifyToken || "").trim();
      if (!aiApiKey) return res.status(400).json({ error: "Anthropic API key required (Settings) for comp grading" });
      // Apify is only needed for comps we have to go scrape. Comps captured
      // from Zillow already carry their photos, so grading those must not be
      // gated behind a token the user may never have configured.
      if (needsScrape(comps) && !apifyToken) {
        return res.status(400).json({ error: "Apify token required (Settings) to pull sold-listing photos — or capture these comps from Zillow with the bookmarklet, which brings its own photos" });
      }

      let out;
      try {
        out = await gradeComps({ subjectAddress, comps, aiApiKey, apifyToken });
      } catch (e) {
        throw anthropicErrorToHttp(e);
      }
      res.json({ ok: true, ...out });
    } catch (err) { fail(res, err); }
  });

  /* ---------- Zillow comp capture (bookmarklet) ---------- */
  // The workflow this exists for: the operator finds his best comps by eye on
  // Zillow, one click each drops them into a per-location inbox, and the Comps
  // & ARV pane pulls them into an offer later. A server-side inbox is the only
  // possible channel — the app runs in a GHL iframe on a different origin from
  // zillow.com, so no browser storage is shared between the two tabs.

  // Mint (or rotate) the capture token. Server-generated, never client-chosen.
  // Rotating invalidates any bookmarklet built from the previous token, which
  // is the revocation story for a credential that lives in a bookmark.
  const brokerBase = () => publicBaseUrl.replace(/\/+$/, "");

  router.post("/comps/capture-token", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const saved = (await store.getOfferSettings(locationId)) || {};
      const captureToken = crypto.randomBytes(24).toString("base64url");
      await store.saveOfferSettings(locationId, { ...saved, captureToken });
      // Return the token as well as the href: the Settings form folds it into
      // its local state so that a later Save (built from a form loaded before
      // the token existed) can't write the token straight back out again.
      res.json({
        ok: true,
        captureToken,
        bookmarklet: buildBookmarklet({ token: captureToken, brokerBase: brokerBase() }),
      });
    } catch (err) { fail(res, err); }
  });

  // Which property the operator is currently working on. The Comps & ARV pane
  // posts this whenever it has an address, and every capture that arrives
  // afterwards is stamped with it — that's what lets a comp grabbed on Zillow
  // land in the right offer without the operator sorting anything by hand.
  //
  // Kept on the location's settings blob rather than in a table: it's a single
  // ephemeral "where am I pointed" value, not a record worth a row.
  router.post("/comps/capture-target", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const address = String(req.body?.address || "").trim();
      if (!address) return res.status(400).json({ error: "address required" });
      const saved = (await store.getOfferSettings(locationId)) || {};
      await store.saveOfferSettings(locationId, {
        ...saved,
        captureTarget: {
          address,
          key: addressKey(address),
          lat: Number(req.body?.lat) || null,
          lng: Number(req.body?.lng) || null,
          at: new Date().toISOString(),
        },
      });
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });

  // Hand over every capture belonging to this property and clear them in the
  // same call. Read-and-delete together on purpose: the pane merges them into
  // the offer it holds in memory, so a capture returned but not deleted would
  // be added twice on the next refresh.
  router.post("/comps/claim", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const address = String(req.body?.address || "").trim();
      if (!address) return res.status(400).json({ error: "address required" });
      const key = addressKey(address);
      const all = await store.listCompCaptures(locationId);
      // Untargeted captures (grabbed before any offer was open) are claimed by
      // whatever property asks first — they were grabbed for *something*, and
      // stranding them where nobody looks is worse than landing them somewhere
      // visible, where the distance chip and the trash button sort it out.
      const mine = all.filter((c) => !c.subjectKey || c.subjectKey === key);
      if (mine.length) await store.deleteCompCaptures(locationId, mine.map((c) => c.id));
      res.json({ captures: mine });
    } catch (err) { fail(res, err); }
  });

  // The bookmarklet href for the current location. Built server-side so the
  // loader URL has exactly one definition.
  router.get("/comps/bookmarklet", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const saved = await store.getOfferSettings(locationId);
      const token = String(saved?.captureToken || "").trim();
      res.json({
        hasToken: Boolean(token),
        bookmarklet: token ? buildBookmarklet({ token, brokerBase: brokerBase() }) : "",
      });
    } catch (err) { fail(res, err); }
  });

  // The capture script itself. Unauthenticated on purpose: it is inert code —
  // the token only matters on the POST below — and serving it fresh on every
  // click is what lets a Zillow page-shape change be fixed by a deploy.
  router.get("/comps/zgrab.js", (req, res) => {
    const token = String(req.query.t || "").trim();
    res.type("application/javascript");
    res.set("Cache-Control", "no-store");
    res.send(buildZgrabScript({
      token,
      brokerBase: brokerBase(),
      appOrigin: (APP_ORIGIN || publicBaseUrl).replace(/\/+$/, ""),
    }));
  });

  // CORS for the capture POST only. The global middleware in broker.js sets
  // headers exclusively for APP_ORIGINS and only short-circuits OPTIONS for
  // those, so requests from zillow.com fall through to here untouched.
  const CAPTURE_ORIGINS = ["https://www.zillow.com", "https://zillow.com"];
  const captureCors = (req, res) => {
    const origin = req.headers.origin;
    if (origin && CAPTURE_ORIGINS.includes(origin)) {
      res.header("Access-Control-Allow-Origin", origin);
      res.header("Access-Control-Allow-Headers", "Content-Type");
      res.header("Access-Control-Allow-Methods", "POST,OPTIONS");
      res.header("Vary", "Origin");
    }
  };
  router.options("/comps/capture", (req, res) => { captureCors(req, res); res.sendStatus(204); });

  // Normalize whatever the page gave us into the comp shape the app already
  // speaks, so captured comps flow through the map, the match scorecard, the
  // ARV math and the comps PDF with no special-casing downstream.
  const normalizeCapture = (raw) => {
    const n = (v) => {
      const x = Number(v);
      return Number.isFinite(x) && x !== 0 ? x : null;
    };
    const s = (v, max = 200) => {
      const t = String(v == null ? "" : v).trim();
      return t ? t.slice(0, max) : null;
    };
    const address = s(raw?.address, 200);
    const price = Math.round(Number(raw?.price) || 0);
    if (!address || price <= 0) return null;
    return {
      zpid: s(raw?.zpid, 32),
      address,
      price,
      beds: n(raw?.beds),
      baths: n(raw?.baths),
      sqft: Math.round(n(raw?.sqft) || 0) || 0,
      yearBuilt: n(raw?.yearBuilt),
      lat: n(raw?.lat),
      lng: n(raw?.lng),
      saleDate: /^\d{4}-\d{2}-\d{2}$/.test(String(raw?.saleDate || "")) ? String(raw.saleDate) : "",
      status: s(raw?.status, 40),
      stories: n(raw?.stories),
      material: s(raw?.material, 120),
      subdivision: s(raw?.subdivision, 120),
      url: /^https:\/\/(www\.)?zillow\.com\//.test(String(raw?.url || "")) ? String(raw.url).slice(0, 500) : null,
      // Photos ride along so AI condition grading costs one Claude call and no
      // Apify credits. Capped hard — this lands in a jsonb column.
      photos: (Array.isArray(raw?.photos) ? raw.photos : [])
        .filter((p) => typeof p === "string" && /^https:\/\//.test(p))
        .slice(0, 8)
        .map((p) => p.slice(0, 500)),
      description: s(raw?.description, 1200),
    };
  };

  router.post("/comps/capture", async (req, res) => {
    captureCors(req, res);
    try {
      // The token is the whole credential here — there is no location_id on a
      // request coming from a Zillow tab. It is scoped to this one endpoint,
      // appends to an inbox and nothing else, and is independently revocable.
      const token = String(req.body?.token || "").trim();
      if (!token) return res.status(400).json({ error: "capture token required" });
      const locationId = await store.findLocationByCaptureToken(token);
      if (!locationId) {
        return res.status(403).json({ error: "capture token not recognized — regenerate the bookmarklet in Settings" });
      }
      // Stamp each capture with the property the operator is working on, so it
      // surfaces in that offer rather than in a pile they have to sort.
      const settings = await store.getOfferSettings(locationId);
      const target = settings?.captureTarget || null;
      const comps = (Array.isArray(req.body?.comps) ? req.body.comps : [])
        .slice(0, 60)
        .map(normalizeCapture)
        .filter(Boolean)
        .map((c) => ({
          ...c,
          subjectKey: target?.key || null,
          subjectAddress: target?.address || null,
        }));
      if (!comps.length) return res.status(400).json({ error: "no usable comps on that page" });
      const saved = await store.addCompCaptures(locationId, comps);
      res.json({ ok: true, added: saved.length, target: target?.address || null });
    } catch (err) { fail(res, err); }
  });



  /* ---------- contact-link webhook (GHL workflow: stamp app + Zillow links) ---------- */
  // Wire a GHL workflow (e.g. trigger: Contact Created, or tag applied) to
  // POST here with { location_id, contact_id } — accepts GHL's native payload
  // shapes too. Writes offer_app_link (deep link into this app scoped to the
  // contact) and, when the contact has a property-address custom field,
  // zillow_link. No offer required.
  router.post("/contact-link", async (req, res) => {
    try {
      const b = req.body || {};
      const locId = b.location_id || b.locationId || b.location?.id;
      if (locId) req.body.location_id = locId;
      const { locationId, client } = resolveLocation(req);
      const contactId = b.contact_id || b.contactId || b.contact?.id;
      if (!contactId) return res.status(400).json({ error: "contact_id required (send {{contact.id}})" });

      const contact = await getContact(client, contactId);
      const map = await customFieldIdKeyMap(client, locationId);
      const custom = contactCustomRecord(contact, map);
      const address = bestContactAddress(custom);

      const values = {
        offer_app_link: offerAppLink(locationId, contactId),
        ...(address ? { zillow_link: zillowUrl(address) } : {}),
      };
      const fieldWrites = [];
      for (const f of OFFER_FIELDS) {
        if (!values[f.key]) continue;
        const id = await findOrCreateCustomFieldByKey(client, locationId, f.key, f.name, f.dataType);
        if (id) fieldWrites.push({ id, value: values[f.key] });
      }
      if (fieldWrites.length) await updateContact(client, contactId, { customFields: fieldWrites });
      res.json({ ok: true, wrote: Object.keys(values), address: address || null });
    } catch (err) { fail(res, err); }
  });

  /* ---------- field admin (inventory + explicit prune) ---------- */
  // GET returns the raw custom-field definitions (incl. folder metadata) so
  // cleanup can be planned. DELETE requires an explicit id list — deleting a
  // field permanently erases its values on every contact.
  router.get("/custom-fields", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      res.json({ fields: await listCustomFieldsRaw(client, locationId) });
    } catch (err) { fail(res, err); }
  });

  router.post("/custom-fields/prune", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
      if (!ids.length) return res.status(400).json({ error: "ids required" });
      const results = [];
      for (const id of ids) {
        try {
          await deleteCustomField(client, locationId, id);
          results.push({ id, ok: true });
        } catch (e) {
          results.push({ id, ok: false, error: e.message.slice(0, 200) });
        }
      }
      res.json({ ok: true, results });
    } catch (err) { fail(res, err); }
  });

  // Every field the APP owns (offer writes, outreach imports, AI enrichment),
  // tagged by source — the Fields Manager joins this against /custom-fields.
  router.get("/field-registry", async (req, res) => {
    try {
      resolveLocation(req);
      res.json({ registry: APP_FIELD_REGISTRY });
    } catch (err) { fail(res, err); }
  });

  // Create one contact custom field (idempotent — reuses an existing
  // definition matching by key or name). Body: { key?, name, dataType }.
  router.post("/custom-fields", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const name = String(req.body?.name || "").trim().slice(0, 120);
      const key = String(req.body?.key || "").trim() || name;
      const dataType = String(req.body?.dataType || "TEXT").toUpperCase();
      if (!name) return res.status(400).json({ error: "name required" });
      if (!["TEXT", "NUMERICAL", "DATE"].includes(dataType)) {
        return res.status(400).json({ error: "dataType must be TEXT, NUMERICAL, or DATE" });
      }
      // A field the app owns knows which folder it belongs in; one typed in by
      // hand doesn't, and lands unfiled exactly as before.
      const siblingKey = registryByKey.get(key)?.folderSibling;
      const id = await findOrCreateCustomFieldByKey(client, locationId, key, name, dataType, { siblingKey });
      if (!id) return res.status(502).json({ error: "GHL did not return a field id" });
      res.json({ ok: true, id, filedWith: siblingKey || null });
    } catch (err) { fail(res, err); }
  });

  /* ---------- AI rehab scan (MLS photos → suggested scope of work) ---------- */
  // POST { address, beds?, baths?, sqft? } — pulls the listing's MLS photos
  // (RealEstateAPI key) and has Claude produce a scope suggestion keyed to
  // the shared rehab catalog (Anthropic key). Both keys live in Settings.
  router.post("/scan-rehab", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const address = String(req.body?.address || "").trim();
      if (!address) return res.status(400).json({ error: "address required" });

      const saved = await store.getOfferSettings(locationId);
      const compsApiKey = String(saved?.compsApiKey || "").trim();
      const aiApiKey = String(saved?.aiApiKey || "").trim();
      if (!aiApiKey) return res.status(400).json({ error: "Anthropic API key required (Settings) for AI photo scan" });

      // Photo source order: user-uploaded data URLs → Zillow (Apify) →
      // RealEstateAPI MLS Detail (requires their MLS add-on plan).
      const apifyToken = String(saved?.apifyToken || "").trim();
      let photos;
      let photosCount;
      let listing = null;
      let facts = null;
      const uploaded = Array.isArray(req.body?.images)
        ? req.body.images.filter((i) => typeof i === "string" && i.startsWith("data:image/")).slice(0, 40)        : [];
      if (uploaded.length) {
        photos = uploaded;
        photosCount = uploaded.length;
      } else if (apifyToken) {
        ({ photos, photosCount, listing, facts } = await fetchZillowPhotos(address, apifyToken));
        if (!photos.length) {
          return res.status(404).json({ error: "Zillow has no photos for this address — upload the listing photos instead" });
        }
      } else if (compsApiKey) {
        ({ photos, photosCount, listing } = await fetchListingPhotos(address, compsApiKey));
        if (!photos.length) {
          return res.status(404).json({ error: "no MLS photos found for this address — upload the listing photos instead" });
        }
      } else {
        return res.status(400).json({ error: "add an Apify token in Settings (or upload photos)" });
      }

      let suggestion;
      try {
        suggestion = await scanRehabFromPhotos({
          photos,
          listing,
          subject: {
            beds: Number(req.body?.beds) || facts?.beds || null,
            baths: Number(req.body?.baths) || facts?.baths || null,
            sqft: Number(req.body?.sqft) || facts?.sqft || null,
            yearBuilt: Number(req.body?.yearBuilt) || facts?.yearBuilt || null,
          },
          aiApiKey,
        });
      } catch (e) {
        throw anthropicErrorToHttp(e);
      }

      res.json({
        ok: true,
        suggestion,
        photosAnalyzed: photos.length,
        photosCount,
        listing,
      });
    } catch (err) { fail(res, err); }
  });

  /* ---------- drafts (save the form, come back later) ---------- */
  // POST { id?, draft } — creates or updates a draft offer row. The draft
  // holds the full form state; no document is generated and nothing touches
  // GHL until the draft is turned into a real offer.
  router.post("/draft", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const { id, draft } = req.body || {};
      if (!draft || typeof draft !== "object") return res.status(400).json({ error: "draft required" });
      const record = {
        locationId,
        status: "draft",
        contactId: draft.contact?.id || null,
        contactName: draft.contact?.name || draft.newContact?.name || "",
        address: draft.inputs?.address || "",
        cashAmount: Number(draft.cashPreview) || null,
        draft,
        updatedAt: new Date().toISOString(),
      };
      if (id) {
        const prev = await store.getOffer(id);
        if (prev && prev.locationId === locationId && prev.status === "draft") {
          const full = { ...prev, ...record, id, createdAt: prev.createdAt };
          await store.updateOffer(id, full);
          return res.json({ ok: true, offer: full });
        }
      }
      const offer = await store.createOffer(record);
      res.json({ ok: true, offer });
    } catch (err) { fail(res, err); }
  });

  // Is this offer the newest thing we've sent this agent? Drafts don't count —
  // they were never offered. Used to decide whether a revision may rewrite the
  // contact's last_offer_* fields. Fails open: if the lookup breaks, the write
  // goes ahead, which is the behaviour every offer had before revisions existed.
  async function isNewestOfferForContact(locationId, contactId, offer) {
    if (!contactId) return true;
    try {
      const rows = await store.listOffers(locationId, { contactId, limit: 200, lean: true });
      const mine = Date.parse(offer.createdAt || "") || 0;
      return !rows.some((o) =>
        o.id !== offer.id && o.status !== "draft" && (Date.parse(o.createdAt || "") || 0) > mine);
    } catch { return true; }
  }

  /* ---------- create: calculate + document + attach to contact ---------- */
  // The whole create path — calculate, render every document, persist, write
  // the contact back — as a plain function. The route below is a thin wrapper,
  // and the auto-underwrite pipeline calls this directly, so an offer produced
  // unattended is the same artifact as one built by hand: same PDFs, same
  // custom fields, same note, same tag.
  //
  // It stays inside this closure deliberately — renderDocument, storeDocuments,
  // storeScopeDocument, offerNoteBody and appendDealHistory all live here.
  //
  // Pass `existing` and it revises that offer instead of minting one: same id,
  // so every document overwrites in place and the link an agent already holds
  // resolves to the new letter. One pipeline, two outcomes — forking it would
  // guarantee the two drift, and a revised offer has to be the same artifact as
  // a fresh one (same PDFs, same fields) or History stops telling the truth.
  async function createOfferFromRequest({ locationId, client, body = {}, existing = null }) {
    const revising = Boolean(existing);
    const { contactId: bodyContactId, newContact, inputs, settings: settingsOverride } = body || {};
    // Rehab scope of work (internal — saved + noted, never on the letter).
    const scope = Array.isArray(body.scope)
      ? body.scope
          .filter((s) => s && s.label && Number(s.cost) > 0)
          .slice(0, 60)
          .map((s) => ({ label: String(s.label).slice(0, 120), cost: Math.round(Number(s.cost)) }))
      : [];
    // Full form snapshot (comps workspace + rehab state) so editing the
    // offer later restores everything. Over the cap it is trimmed a piece at
    // a time rather than discarded whole — see ghl-broker/offer-snapshot.js
    // for the shedding order and why comps outrank everything in it.
    const fitted = fitSnapshot(body.snapshot);
    const snapshotWarnings = [...fitted.warnings];
    let snapshot = fitted.snapshot;
    // A revision that arrives without a usable snapshot must not wipe the one
    // already on the offer: captured comps are read-and-delete, so that field
    // is the only copy that exists anywhere.
    if (revising && !snapshot && existing.snapshot) {
      snapshot = existing.snapshot;
      snapshotWarnings.push("the workspace didn't fit — kept the comps and rehab state already on the offer");
    }

    // 1. Resolve the contact (existing id, or find/create by phone). A revision
    //    keeps the contact it was written for — the route refuses a swap, so
    //    the old agent's fields and tag can't end up pointing at someone
    //    else's offer.
    let contactId = revising ? existing.contactId || "" : bodyContactId || "";
    if (!contactId && newContact?.phone) {
      contactId = await findOrCreateContactByPhone(client, locationId, newContact.phone, newContact.name || "");
    }
    if (!contactId) {
      throw Object.assign(new Error("contactId or newContact.phone required"), { http: 400 });
    }
    const contact = await getContact(client, contactId);

    // 2. Calculate.
    const saved = await store.getOfferSettings(locationId);
    const calc = calculateOffers(inputs || {}, { ...(saved || {}), ...(settingsOverride || {}) });

    // 3. Render the document, wrap as PDF, store both.
    const created = new Date();
    const validUntil = offerExpiryDate(calc.settings, created);
    const meta = {
      contactName: contactName(contact),
      dateLabel: dateLabel(created),
      validLabel: dateLabel(validUntil),
    };
    const { jpeg, width, height } = await renderDocument(calc, meta, locationId);
    const pdf = jpegToPdf(jpeg, width, height);
    // The id IS the document key (offers/<location>/<id>.pdf), so reusing it is
    // what makes a save overwrite in place rather than mint a parallel file.
    const offerId = revising ? existing.id : crypto.randomUUID();
    // ...but those routes serve `immutable, max-age=31536000`, so a viewer who
    // already opened the old one would keep it for a year. Version every URL a
    // revision regenerates, exactly as the PSA and net sheet already do. One
    // stamp for all of them, so they move together.
    const stamp = Date.now();
    const bust = (url) => (revising && url ? `${url}${url.includes("?") ? "&" : "?"}v=${stamp}` : url);
    const stored = await storeDocuments(offerId, locationId, jpeg, pdf, calc.inputs.address);
    const imageUrl = bust(stored.imageUrl);
    const pdfUrl = bust(stored.pdfUrl);

    // Companion document: Rehab Scope of Work (when a scope was applied).
    let scopePdfUrl = null;
    let scopeWarning = null;
    if (scope.length) {
      try {
        // Photo-review summary + per-item rationale from the form snapshot
        // (rendered as "condition notes" — no tooling references on paper).
        const ai = snapshot?.rehab?.aiResult;
        const assessment = ai && (ai.summary || (ai.notes || []).length || (ai.areas || []).length)
          ? {
              summary: ai.summary || "",
              notes: Array.isArray(ai.notes) ? ai.notes : [],
              areas: Array.isArray(ai.areas) ? ai.areas : [],
            }
          : null;
        scopePdfUrl = bust(await storeScopeDocument({
          offerId, locationId, scope,
          total: calc.inputs.repairs,
          address: calc.inputs.address,
          meta, company: calc.settings.company || {},
          assessment,
        }));
      } catch (e) { scopeWarning = `rehab SOW: ${e.message}`; }
    }

    // Companion document: Comparable Sales Analysis (when comps back the ARV).
    let compsPdfUrl = null;
    let compsWarning = null;
    try {
      const cs = snapshot?.comps;
      const sel = new Set(Array.isArray(cs?.selected) ? cs.selected : []);
      const gr = cs?.grades || {};
      const withCondition = (c) => ({ ...c, condition: gr[c.id]?.condition || null });
      const picked = [
        ...(cs?.result?.comps || []).filter((c) => sel.has(c.id)).map(withCondition),
        // Comps captured from Zillow are ticked the same way pulled ones are
        // and must reach the PDF, or the analysis silently omits the comps
        // the user hand-picked — the ones most likely to carry the ARV.
        ...(Array.isArray(cs?.captured) ? cs.captured : []).filter((c) => sel.has(c.id)).map(withCondition),
        ...(Array.isArray(cs?.manual) ? cs.manual : []).map(withCondition),
      ];
      if (picked.length) {
        compsPdfUrl = bust(await storeCompsDocument({
          offerId, locationId,
          comps: picked,
          arvBasis: String(cs?.arvBasis || ""),
          arvBase: Math.round(Number(cs?.arvBase)) || 0,
          arvAdjustments: (Array.isArray(cs?.adjustments) ? cs.adjustments : [])
            .map((a) => ({ label: String(a?.label || "").slice(0, 60), pct: Number(a?.pct) || 0 }))
            .filter((a) => a.pct !== 0)
            .slice(0, 6),
          subject: cs?.result?.info || null,
          estimate: cs?.result?.estimate || null,
          months: Number(cs?.months) || 0,
          subjectSqft: Number(String(snapshot?.subjectSqft ?? "").replace(/[^\d.]/g, "")) || 0,
          arv: calc.inputs.arv,
          address: calc.inputs.address,
          meta, company: calc.settings.company || {},
        }));
      }
    } catch (e) { compsWarning = `comps PDF: ${e.message}`; }

    // Companion document: Seller Net Comparison (the "no buyer's commission"
    // one-pager, sent separately from the offer letter).
    let netSheetPdfUrl = null;
    let netSheetWarning = null;
    let netSheetFields = null;
    try {
      const net = netComparison(calc.offers.cash.amount, calc.settings);
      if (net) {
        netSheetFields = { sellerAgentPct: net.sellerPct, buyerAgentPct: net.buyerPct };
        netSheetPdfUrl = bust(await storeNetSheetDocument({
          offerId, locationId, net,
          address: calc.inputs.address,
          meta, company: calc.settings.company || {},
        }));
      }
    } catch (e) { netSheetWarning = `net comparison: ${e.message}`; }

    // 4. Persist the offer. Everything this run recomputed, and nothing else —
    //    on a revision the spread below carries the rest of the record across.
    const fresh = {
      contactId,
      contactName: meta.contactName,
      address: calc.inputs.address,
      cashAmount: calc.offers.cash.amount,
      imageUrl,
      pdfUrl,
      scopePdfUrl,
      compsPdfUrl,
      netSheetPdfUrl,
      netSheet: netSheetPdfUrl ? { fields: netSheetFields, generatedAt: created.toISOString() } : null,
      dateLabel: meta.dateLabel,
      validLabel: meta.validLabel,
      scope,
      snapshot,
      calc,
    };
    let offer;
    if (revising) {
      // `...existing` first, `...fresh` over it: the lifecycle — status and its
      // history, the send ledger, the deal, the PSA / contract / assignment and
      // their PDFs, the auto-underwrite provenance — is inherited rather than
      // listed, so a field added to an offer next year survives a save without
      // anyone remembering to come back here.
      offer = {
        ...existing,
        ...fresh,
        id: existing.id,
        locationId,
        createdAt: existing.createdAt,
        updatedAt: created.toISOString(),
        // The letter is re-dated, so the printed "valid through" moved. Without
        // this, offerExpiresAt() would keep deriving the old date off createdAt
        // and mark the offer expired while the document says otherwise.
        expiresAt: validUntil.toISOString(),
        revisions: [
          ...(existing.revisions || []),
          { ts: created.toISOString(), from: Math.round(Number(existing.cashAmount) || 0), to: fresh.cashAmount },
        ].slice(-20),
      };
      await store.updateOffer(offer.id, offer);
    } else {
      offer = await store.createOffer({
        id: offerId,
        locationId,
        ...fresh,
        // A generated offer starts its lifecycle at "not sent". Sending it,
        // or recording an outcome by hand, moves it from here.
        status: "new",
        statusHistory: [{ status: "new", ts: created.toISOString() }],
      });
    }

    // 5. Associate with the GHL contact record. Each write is independent;
    //    failures are reported + logged, not fatal (the offer itself is saved).
    const ghl = { fields: false, note: false, tag: false };
    const warnings = [...snapshotWarnings];
    if (scopeWarning) warnings.push(scopeWarning);
    if (compsWarning) warnings.push(compsWarning);
    if (netSheetWarning) warnings.push(netSheetWarning);
    const noteFailure = (step, e) => {
      const detail = e?.data ? `${e.message} :: ${JSON.stringify(e.data).slice(0, 200)}` : e?.message;
      console.error(`offers: GHL attach failed [${step}] contact=${contactId}:`, detail);
      warnings.push(`${step}: ${e.message}`);
    };
    // The contact's fields are named last_offer_* — they describe the agent's
    // most recent offer, not this one. Revising an older offer must not drag
    // them backwards over a newer offer on another property.
    const holdsTheFields = !revising || (await isNewestOfferForContact(locationId, contactId, offer));
    if (!holdsTheFields) {
      warnings.push("contact fields left alone — a newer offer for this agent holds them");
    }
    if (holdsTheFields) {
      try {
        const fieldValues = {
          last_offer_amount: calc.offers.cash.amount,
          last_offer_date: created.toISOString().slice(0, 10),
          last_offer_doc_url: pdfUrl,
          last_offer_image_url: imageUrl,
          zillow_link: zillowUrl(calc.inputs.address),
          offer_app_link: offerAppLink(locationId, contactId),
        };
        const fieldWrites = [];
        for (const f of OFFER_FIELDS) {
          if (!fieldValues[f.key]) continue; // e.g. no address → no Zillow link
          const id = await findOrCreateCustomFieldByKey(client, locationId, f.key, f.name, f.dataType);
          if (id) fieldWrites.push({ id, value: fieldValues[f.key] });
        }
        if (fieldWrites.length) {
          await updateContact(client, contactId, { customFields: fieldWrites });
          ghl.fields = true;
        }
      } catch (e) { noteFailure("custom fields", e); }
    }
    // The note and the tag happen once, at creation. GHL notes are append-only
    // — there is no edit — so re-noting every save would bury the contact under
    // one note per keystroke-session, and the tag is already on them.
    if (revising) {
      ghl.note = existing.ghl?.note ?? false;
      ghl.tag = existing.ghl?.tag ?? false;
    } else {
      try {
        await createContactNote(client, contactId, { body: offerNoteBody(offer) });
        ghl.note = true;
      } catch (e) { noteFailure("note", e); }
      try {
        await addContactTags(client, contactId, [OFFER_TAG]);
        ghl.tag = true;
      } catch (e) { noteFailure("tag", e); }
    }
    // The ledger is what AI enrichment reads to know what we've offered, so a
    // new number belongs in it — but only a new one. Re-saving after moving a
    // comp shouldn't write a line at all.
    const amountMoved = !revising || calc.offers.cash.amount !== Math.round(Number(existing.cashAmount) || 0);
    if (calc.offers.cash.amount > 0 && amountMoved) {
      await appendDealHistory(client, locationId, contactId, "agent_deal_history",
        historyLine(created.toISOString(), calc.inputs.address,
          revising
            ? `we revised our offer to ${fmtMoney(calc.offers.cash.amount)}`
            : `we offered ${fmtMoney(calc.offers.cash.amount)}`));
    }

    // A revision re-renders the documents the agent's own page publishes, so
    // that page has to be rebuilt or it prints last week's price above this
    // morning's PDF. Investor rooms are a different contract — frozen until the
    // operator refreshes — but their money still follows, exactly as it does
    // when a deal's terms change.
    const stale = [];
    if (revising) {
      await refreshOfferPages({ store, locationId, offer, settings: calc.settings });
      await syncDealNumbers({ store, offer, settings: calc.settings });
      // Signable paperwork is never regenerated behind the operator's back: a
      // PSA may already be signed. Say which ones no longer match instead.
      for (const [key, label] of [["psa", "purchase & sale agreement"], ["contract", "purchase contract"], ["assignment", "assignment contract"]]) {
        const priced = Number(String(offer[key]?.fields?.price ?? "").replace(/[^\d.]/g, ""));
        if (offer[key] && Number.isFinite(priced) && priced && priced !== offer.cashAmount) stale.push(label);
      }
      if (stale.length) {
        warnings.push(`${stale.join(" and ")} still quote${stale.length > 1 ? "" : "s"} the old price — regenerate from the offer's documents`);
      }
      const rooms = await store.listDatarooms(locationId, { offerId: offer.id }).catch(() => []);
      const frozen = rooms.filter((r) => r?.kind !== "offer" && r?.snapshot?.numbers).length;
      if (frozen) {
        warnings.push(`${frozen} investor dataroom${frozen > 1 ? "s" : ""} still show${frozen > 1 ? "" : "s"} the previous comps and scope — refresh from the Dataroom tab`);
      }
    }

    // Persist the attach outcome on the offer so History can show it.
    offer.ghl = ghl;
    offer.warnings = warnings;
    await store.updateOffer(offer.id, offer).catch(() => {});

    // Creating from a draft consumes the draft.
    const draftId = body.draftId;
    if (draftId) {
      const d = await store.getOffer(draftId).catch(() => null);
      if (d && d.locationId === locationId && d.status === "draft") {
        await store.deleteOffer(draftId).catch(() => {});
      }
    }

    return { ok: true, offer, ghl, warnings, ...(revising ? { revised: true, staleDocs: stale } : {}) };
  }

  router.post("/", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      res.json(await createOfferFromRequest({ locationId, client, body: req.body || {} }));
    } catch (err) { fail(res, err); }
  });

  // Save an offer in place. Same id, same document URLs, revised numbers — the
  // letter behind the link an agent already has becomes the new one. This is
  // the difference between revising your offer on a property and owning four
  // offers on it.
  //
  // Registered after PUT /settings, so that path still wins; nothing else in
  // this router claims a one-segment PUT.
  router.put("/:id", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const existing = await store.getOffer(req.params.id);
      if (!existing || existing.locationId !== locationId) {
        return res.status(404).json({ error: "offer not found" });
      }
      // A draft has no document and nothing in the CRM to keep level; it stays
      // on its own route, which already saves in place.
      if (existing.status === "draft") {
        return res.status(400).json({ error: "this is still a draft — keep saving it as a draft, or create the offer" });
      }
      const body = req.body || {};
      // Writing this offer for someone else would leave the first agent tagged,
      // noted, and holding fields that point at an offer no longer theirs.
      const wanted = String(body.contactId || "").trim();
      if (wanted && existing.contactId && wanted !== existing.contactId) {
        return res.status(400).json({
          error: `this offer belongs to ${existing.contactName || "another contact"} — use "Save as new offer" to write one for someone else`,
        });
      }
      if (!body.inputs || typeof body.inputs !== "object") {
        return res.status(400).json({ error: "inputs required" });
      }
      const out = await createOfferFromRequest({ locationId, client, body, existing });
      // The client asks before overwriting a document that already went out;
      // it needs to know there was one.
      out.revisedAfterSend = (existing.sends || []).length > 0;
      res.json(out);
    } catch (err) { fail(res, err); }
  });

  /* ---------- list / read / delete ---------- */
  // All active deals for the location (offers with a `deal` object), newest
  // first. MUST stay registered before GET /:id or "deals" is captured as :id.
  router.get("/deals", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const limit = Math.min(500, parseInt(req.query.limit, 10) || 200);
      const deals = await store.listDeals(locationId, { limit });
      // The Deals tab needs none of the fat calc/snapshot blobs.
      res.json({ deals: deals.map(({ snapshot, calc, ...rest }) => rest) });
    } catch (err) { fail(res, err); }
  });

  router.get("/", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const contactId = String(req.query.contact_id || "") || null;
      // A lean row is ~1KB against ~9KB for the whole document, so the history
      // page can ask for the location's entire book in one call. Full docs keep
      // the cap they always had — that ceiling is why the page silently showed
      // only its newest 100 offers, and nothing should hit it by accident again.
      const lean = req.query.lean === "1" || req.query.lean === "true";
      const limit = Math.min(lean ? 2000 : 200, parseInt(req.query.limit, 10) || 50);
      res.json({ offers: await store.listOffers(locationId, { contactId, limit, lean }) });
    } catch (err) { fail(res, err); }
  });

  router.get("/:id", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const offer = await store.getOffer(req.params.id);
      if (!offer || offer.locationId !== locationId) return res.status(404).json({ error: "offer not found" });
      res.json({ offer });
    } catch (err) { fail(res, err); }
  });

  router.delete("/:id", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const offer = await store.getOffer(req.params.id);
      if (!offer || offer.locationId !== locationId) return res.status(404).json({ error: "offer not found" });
      // Video bytes live in R2, which the store can't reach: clear them here
      // before the rows go, or every deleted deal leaves its walkthrough behind.
      for (const v of await store.listOfferVideos(offer.id)) {
        try {
          if (v.status === "uploading" && v.uploadId) await abortVideoUpload(v.storageKey, v.uploadId);
          else await deleteVideoObject(v.storageKey);
        } catch (e) { console.warn("video bytes not removed:", v.storageKey, e.message); }
      }
      await store.deleteOffer(req.params.id);
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });

  /* ---------- purchase & sale contract (text PDF via pdf-lib) ---------- */
  // Body: { fields: { effectiveDate, buyerName, sellerName, address, price,
  //         earnestMoney, inspectionDays, closingDate, titleCompany,
  //         specialProvisions, state, county } }. Renders the location's clause
  //         template (Settings; falls back to the built-in wholesale-friendly
  //         default) merged with these fill-ins, stores the PDF next to the
  //         offer documents, and records the fields on the offer so the form
  //         rehydrates on regeneration. Empty fields print as signable blanks.
  router.post("/:id/contract", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const offer = await store.getOffer(req.params.id);
      if (!offer || offer.locationId !== locationId) return res.status(404).json({ error: "offer not found" });

      const raw = req.body?.fields || {};
      const str = (k, max = 200) => String(raw[k] ?? "").trim().slice(0, max);
      const money = (k) => {
        const n = Number(String(raw[k] ?? "").replace(/[$,\s]/g, ""));
        return Number.isFinite(n) && n > 0 ? n : 0;
      };
      const fields = {
        effectiveDate: str("effectiveDate"),
        buyerName: str("buyerName"),
        sellerName: str("sellerName"),
        address: str("address"),
        price: money("price"),
        earnestMoney: money("earnestMoney"),
        inspectionDays: Math.max(0, parseInt(raw.inspectionDays, 10) || 0),
        closingDate: str("closingDate"),
        titleCompany: str("titleCompany"),
        specialProvisions: str("specialProvisions", 4000),
        state: str("state"),
        county: str("county"),
      };

      const settings = effectiveSettings(await store.getOfferSettings(locationId));
      const clauses = Array.isArray(settings.contractTemplate) && settings.contractTemplate.length
        ? settings.contractTemplate
        : DEFAULT_CONTRACT_CLAUSES;

      const values = {
        effective_date: dateText(fields.effectiveDate),
        buyer_name: fields.buyerName,
        seller_name: fields.sellerName,
        address: fields.address,
        price: fields.price ? fmtMoney(fields.price) : "",
        price_words: fields.price ? moneyInWords(fields.price) : "",
        earnest_money: fields.earnestMoney ? fmtMoney(fields.earnestMoney) : "",
        inspection_days: fields.inspectionDays ? String(fields.inspectionDays) : "",
        closing_date: dateText(fields.closingDate),
        title_company: fields.titleCompany,
        special_provisions: fields.specialProvisions,
        state: fields.state,
        county: fields.county,
      };

      const pdf = await renderContractPdf({
        clauses,
        values,
        meta: { buyerName: fields.buyerName, sellerName: fields.sellerName },
      });

      let url;
      if (r2Enabled) {
        url = await uploadAsset(`offers/${locationId}/${offer.id}-contract.pdf`, pdf, "application/pdf", {
          localDir: uploadDir,
          localBaseUrl: `${publicBaseUrl}/uploads`,
          contentDisposition: `inline; filename="${docFilename(offer.address, "CONTRACT", "pdf")}"`,
        });
      } else {
        await store.saveOfferDoc(offer.id, "contractpdf", pdf, "application/pdf");
        url = `${publicBaseUrl}/api/offers/${offer.id}/contract.pdf`;
      }
      // The doc routes serve immutable/long-cache; version the URL so a
      // regenerated contract isn't hidden behind the old cached copy.
      url += `${url.includes("?") ? "&" : "?"}v=${Date.now()}`;

      offer.contract = { fields, generatedAt: new Date().toISOString() };
      offer.contractPdfUrl = url;
      await store.updateOffer(offer.id, offer);
      res.json({ ok: true, offer });
    } catch (err) { fail(res, err); }
  });

  /* ---------- purchase & sale agreement (the "official offer") ---------- */
  // Body: { fields: { mode, effectiveDate, buyerEntity, buyerEntityState,
  //         sellerName, address, apn, legalDescription, county, price,
  //         earnestMoney, feasibilityDays, closingDays, closingDate,
  //         backstopDate, titleCompany, titleOfficer, titlePhone, lenderName,
  //         approvalDeadline, counterDays, offerExpires, offerExpiresTime,
  //         additionalTerms } }
  //
  // This is the document that answers "that's just an LOI, not a real offer".
  // It renders the Washington PSA package from shared/wa-psa-template.js —
  // Offer Summary cover, 22 numbered sections, Addendum A, plus Addendum B and
  // approval-keyed timelines on a short sale — with the standing exhibits from
  // Settings merged on the end. Blanks print as fill-in lines, so a
  // half-filled agreement is still printable and signable.
  //
  // Deliberately separate from POST /:id/contract: that one is the generic
  // multi-state clause template the operator edits in Settings. This one is
  // authored, locked text whose section numbers are cross-referenced inside the
  // document itself.
  router.post("/:id/psa", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const offer = await store.getOffer(req.params.id);
      if (!offer || offer.locationId !== locationId) return res.status(404).json({ error: "offer not found" });

      const raw = req.body?.fields || {};
      const str = (k, max = 200) => String(raw[k] ?? "").trim().slice(0, max);
      const money = (k) => {
        const n = Number(String(raw[k] ?? "").replace(/[$,\s]/g, ""));
        return Number.isFinite(n) && n > 0 ? n : 0;
      };
      const days = (k, fallback) => {
        const n = parseInt(raw[k], 10);
        return Number.isFinite(n) && n > 0 ? Math.min(n, 365) : fallback;
      };

      const settings = effectiveSettings(await store.getOfferSettings(locationId));
      const psaDefaults = settings.psa;
      const company = settings.company || {};

      const mode = PSA_MODES.includes(raw.mode) ? raw.mode : "standard";
      const fields = {
        mode,
        effectiveDate: str("effectiveDate"),
        buyerEntity: str("buyerEntity") || psaDefaults.buyerEntity,
        buyerEntityState: str("buyerEntityState") || psaDefaults.buyerEntityState,
        sellerName: str("sellerName"),
        address: str("address") || offer.address || "",
        apn: str("apn", 40),
        legalDescription: str("legalDescription", 2000),
        county: str("county", 60),
        price: money("price") || Math.round(Number(offer.cashAmount) || 0),
        earnestMoney: money("earnestMoney") || Number(settings.earnestMoney) || 0,
        feasibilityDays: days("feasibilityDays", psaDefaults.feasibilityDays),
        closingDays: days("closingDays", psaDefaults.closingDays),
        closingDate: str("closingDate"),
        backstopDate: str("backstopDate"),
        titleCompany: str("titleCompany") || psaDefaults.titleCompany,
        titleOfficer: str("titleOfficer") || psaDefaults.titleOfficer,
        titlePhone: str("titlePhone", 40) || psaDefaults.titlePhone,
        lenderName: str("lenderName") || psaDefaults.lenderName,
        approvalDeadline: str("approvalDeadline"),
        counterDays: days("counterDays", psaDefaults.counterDays),
        offerExpires: str("offerExpires"),
        offerExpiresTime: str("offerExpiresTime", 20),
        additionalTerms: str("additionalTerms", 4000),
      };

      // "August 24, 2026 at 5:00 PM" — one string, because § 22 and the summary
      // row both print the whole expiry and neither wants to reassemble it.
      const expiresLabel = [dateText(fields.offerExpires), fields.offerExpiresTime]
        .filter(Boolean).join(" at ");

      const values = {
        effective_date: dateText(fields.effectiveDate),
        buyer_entity: fields.buyerEntity,
        buyer_state: fields.buyerEntityState,
        seller_name: fields.sellerName,
        address: fields.address,
        apn: fields.apn,
        legal_description: fields.legalDescription,
        county: fields.county,
        price: fields.price ? fmtMoney(fields.price) : "",
        price_words: fields.price ? moneyInWords(fields.price) : "",
        earnest_money: fields.earnestMoney ? fmtMoney(fields.earnestMoney) : "",
        feasibility_days: String(fields.feasibilityDays),
        closing_days: String(fields.closingDays),
        closing_date: dateText(fields.closingDate),
        backstop_date: dateText(fields.backstopDate),
        title_company: fields.titleCompany,
        title_officer: fields.titleOfficer,
        title_phone: fields.titlePhone,
        lender_name: fields.lenderName,
        approval_deadline: dateText(fields.approvalDeadline),
        counter_days: String(fields.counterDays),
        offer_expires: expiresLabel,
        signer_name: company.signer || "",
        signer_email: company.email || "",
        signer_phone: company.phone || "",
      };

      const exhibits = await loadPsaExhibits(psaDefaults, mode);

      // Pre-applied buyer signature, when the operator has opted in. Dated to
      // the agreement's own effective date rather than "now", so the signature
      // and the document can't disagree about when it was signed.
      const signName = psaDefaults.signatureName || company.signer || "";
      const signature = psaDefaults.autoSign && signName
        ? {
            name: signName,
            date: values.effective_date || dateLabel(),
            capacity: psaDefaults.signatureCapacity || "",
          }
        : null;

      const pdf = await renderPsaPdf({
        mode, values, company, exhibits, signature,
        address: fields.address,
        additionalTerms: fields.additionalTerms,
      });

      let url;
      if (r2Enabled) {
        url = await uploadAsset(`offers/${locationId}/${offer.id}-psa.pdf`, pdf, "application/pdf", {
          localDir: uploadDir,
          localBaseUrl: `${publicBaseUrl}/uploads`,
          contentDisposition: `inline; filename="${docFilename(offer.address, "PURCHASE AGREEMENT", "pdf")}"`,
        });
      } else {
        await store.saveOfferDoc(offer.id, "psapdf", pdf, "application/pdf");
        url = `${publicBaseUrl}/api/offers/${offer.id}/psa.pdf`;
      }
      // The doc routes serve immutable/long-cache; version the URL so a
      // regenerated agreement isn't hidden behind the old cached copy.
      url += `${url.includes("?") ? "&" : "?"}v=${Date.now()}`;

      offer.psa = { fields, generatedAt: new Date().toISOString() };
      offer.psaPdfUrl = url;
      await store.updateOffer(offer.id, offer);
      res.json({ ok: true, offer });
    } catch (err) { fail(res, err); }
  });

  // The standing exhibits, fetched fresh at render time so replacing the file
  // in Settings updates every agreement generated afterwards. A fetch failure
  // drops that exhibit rather than failing the offer — and because the renderer
  // numbers exhibits from what it is actually handed, the summary and § 21 stay
  // consistent with what's in the envelope.
  //
  // The proof-of-funds letter only rides along when there's a lender named to
  // attribute it to, which is also the only case the summary row cites it.
  async function loadPsaExhibits(psaDefaults, mode) {
    const wanted = [
      { kind: "emdCheck", url: psaDefaults.emdCheckUrl, title: "Copy of earnest money check payable to the Closing Agent" },
      { kind: "proofOfFunds", url: psaDefaults.proofOfFundsUrl, title: "Proof of funds letter" },
    ].filter((e) => String(e.url || "").trim());

    const loaded = await Promise.all(wanted.map(async (e) => {
      try {
        // `original`, not the JPEG rendering: a thumbnail of a PDF exhibit
        // would be a picture of its first page.
        const { bytes, contentType } = await fetchRemoteImage(driveDirectUrl(e.url, { original: true }), { allowPdf: true, maxBytes: 8 * 1024 * 1024 });
        return { kind: e.kind, title: e.title, bytes, contentType };
      } catch {
        return null;
      }
    }));
    return loaded.filter(Boolean);
  }

  /* ---------- assignment of contract (dispositions — the end buyer) ---------- */
  // Body: { fields: { effectiveDate, assignorName, assignorCompany,
  //         assigneeName, assigneeCompany, address, totalPrice, deposit,
  //         depositDueDate, closingDate } }. Same machinery as the purchase
  //         contract but with the assignment clause template and an
  //         Assignee/Assignor document shell. This document goes to the END
  //         BUYER — it is deliberately NOT part of the /send doc set, which
  //         only ever texts/emails the seller-side contact.
  router.post("/:id/assignment", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const offer = await store.getOffer(req.params.id);
      if (!offer || offer.locationId !== locationId) return res.status(404).json({ error: "offer not found" });

      const raw = req.body?.fields || {};
      const str = (k, max = 200) => String(raw[k] ?? "").trim().slice(0, max);
      const money = (k) => {
        const n = Number(String(raw[k] ?? "").replace(/[$,\s]/g, ""));
        return Number.isFinite(n) && n > 0 ? n : 0;
      };
      const fields = {
        effectiveDate: str("effectiveDate"),
        assignorName: str("assignorName"),
        assignorCompany: str("assignorCompany"),
        assigneeName: str("assigneeName"),
        assigneeCompany: str("assigneeCompany"),
        address: str("address"),
        totalPrice: money("totalPrice"),
        deposit: money("deposit"),
        depositDueDate: str("depositDueDate"),
        closingDate: str("closingDate"),
      };

      const settings = effectiveSettings(await store.getOfferSettings(locationId));
      const clauses = Array.isArray(settings.assignmentTemplate) && settings.assignmentTemplate.length
        ? settings.assignmentTemplate
        : DEFAULT_ASSIGNMENT_CLAUSES;

      const values = {
        effective_date: dateText(fields.effectiveDate),
        assignor_name: fields.assignorName,
        assignor_company: fields.assignorCompany,
        assignee_name: fields.assigneeName,
        assignee_company: fields.assigneeCompany,
        address: fields.address,
        total_price: fields.totalPrice ? fmtMoney(fields.totalPrice) : "",
        total_price_words: fields.totalPrice ? moneyInWords(fields.totalPrice) : "",
        deposit: fields.deposit ? fmtMoney(fields.deposit) : "",
        deposit_due_date: dateText(fields.depositDueDate),
        closing_date: dateText(fields.closingDate),
      };

      const blank = (n) => "_".repeat(n);
      const pdf = await renderContractPdf({
        clauses,
        values,
        layout: {
          title: "ASSIGNMENT OF CONTRACT AGREEMENT",
          preamble: ASSIGNMENT_PREAMBLE,
          tokens: ASSIGNMENT_TOKENS,
          specificRows: [
            ["Date of Agreement", values.effective_date || blank(18)],
            ["Assignor / Seller", values.assignor_name || blank(30)],
            ["Assignee / Buyer", values.assignee_name || blank(30)],
            ["Property Address", values.address || blank(40)],
            ["Total Purchase Price", values.total_price ? `${values.total_price} (includes Assignor's assignment fee)` : blank(14)],
            ["Deposit", values.deposit || blank(12)],
            ["Deposit Due", values.deposit_due_date ? `On or before ${values.deposit_due_date}` : `On or before ${blank(18)}`],
            ["Closing Date", values.closing_date ? `On or before ${values.closing_date}` : `On or before ${blank(18)}`],
          ],
          // Assignee signs first, matching the standard assignment form order.
          signatures: [
            { role: "ASSIGNEE / BUYER", name: fields.assigneeName, company: fields.assigneeCompany },
            { role: "ASSIGNOR / SELLER", name: fields.assignorName, company: fields.assignorCompany },
          ],
          initialsLabels: ["Assignor's Initials", "Assignee's Initials"],
        },
      });

      let url;
      if (r2Enabled) {
        url = await uploadAsset(`offers/${locationId}/${offer.id}-assignment.pdf`, pdf, "application/pdf", {
          localDir: uploadDir,
          localBaseUrl: `${publicBaseUrl}/uploads`,
          contentDisposition: `inline; filename="${docFilename(offer.address, "ASSIGNMENT", "pdf")}"`,
        });
      } else {
        await store.saveOfferDoc(offer.id, "assignmentpdf", pdf, "application/pdf");
        url = `${publicBaseUrl}/api/offers/${offer.id}/assignment.pdf`;
      }
      url += `${url.includes("?") ? "&" : "?"}v=${Date.now()}`;

      offer.assignment = { fields, generatedAt: new Date().toISOString() };
      offer.assignmentPdfUrl = url;
      await store.updateOffer(offer.id, offer);
      res.json({ ok: true, offer });
    } catch (err) { fail(res, err); }
  });

  /* ---------- seller net comparison one-pager ---------- */
  // (Re)render the Seller Net Comparison for an offer. Body (optional):
  // { fields: { sellerAgentPct, buyerAgentPct } } — defaults come from the
  // location settings; the fields used are saved on the offer for prefill.
  router.post("/:id/netsheet", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const offer = await store.getOffer(req.params.id);
      if (!offer || offer.locationId !== locationId) {
        return res.status(404).json({ error: "offer not found" });
      }
      const settings = effectiveSettings(await store.getOfferSettings(locationId));
      const pct = (v, fallback) => {
        const n = Number(String(v ?? "").replace(/[%\s]/g, ""));
        return Number.isFinite(n) && n >= 0 && n < 100 ? n : fallback;
      };
      const fields = {
        sellerAgentPct: pct(req.body?.fields?.sellerAgentPct, settings.sellerAgentPct),
        buyerAgentPct: pct(req.body?.fields?.buyerAgentPct, settings.buyerAgentPct),
      };
      const net = netComparison(offer.cashAmount, fields);
      if (!net) {
        return res.status(400).json({ error: "offer has no positive amount to compare (or commissions ≥ 100%)" });
      }
      const meta = { dateLabel: dateLabel() };
      let url = await storeNetSheetDocument({
        offerId: offer.id, locationId, net,
        address: offer.address,
        meta, company: settings.company || {},
      });
      url += `?v=${Date.now()}`; // doc routes serve immutable — cache-bust regenerations
      offer.netSheet = { fields, generatedAt: new Date().toISOString() };
      offer.netSheetPdfUrl = url;
      await store.updateOffer(offer.id, offer);
      res.json({ ok: true, offer });
    } catch (err) { fail(res, err); }
  });

  /* ---------- active deals (offers under signed contract) ---------- */
  // A deal is an offer whose doc carries a `deal` object: stage + terms on the
  // acquisitions side (the agent contact already on the offer) plus the
  // disposition investors (existing GHL contacts) evaluating the property.

  const dealStr = (v, max = 200) => String(v ?? "").trim().slice(0, max);
  const dealMoney = (v) => {
    const n = Number(String(v ?? "").replace(/[$,\s]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  // Shared loader: offer must exist, belong to the location, and (unless
  // promoting) already be a deal. Writes the error response itself.
  async function loadDealOffer(req, res, { requireDeal = true } = {}) {
    const { locationId, client } = resolveLocation(req);
    const offer = await store.getOffer(req.params.id);
    if (!offer || offer.locationId !== locationId) {
      res.status(404).json({ error: "offer not found" });
      return null;
    }
    if (requireDeal && !offer.deal) {
      res.status(404).json({ error: "offer is not a deal" });
      return null;
    }
    return { locationId, client, offer };
  }

  // Best-effort: append one dated line to a contact's deal-history ledger
  // (agent_deal_history / investor_deal_history) so the CRM stays current
  // even when the contact never messages (the sweep would skip them). Reads
  // the current value, merges, and writes back; never throws — the ledger is
  // a convenience mirror, not critical state.
  async function appendDealHistory(client, locationId, contactId, fieldKey, line) {
    if (!contactId || !line) return;
    try {
      const type = fieldKey === "agent_deal_history" ? "agent" : "investor";
      const def = enrichFieldDefs(type).find((f) => f.key === fieldKey);
      const id = await findOrCreateCustomFieldByKey(client, locationId, fieldKey, def.name, def.dataType);
      if (!id) return;
      const contact = await getContact(client, contactId);
      const idKeyMap = await customFieldIdKeyMap(client, locationId);
      const current = contactCustomRecord(contact, idKeyMap)[fieldKey] || "";
      const merged = mergeHistory(current, [line]);
      if (merged && merged !== String(current).trim()) {
        await updateContact(client, contactId, { customFields: [{ id, value: merged }] });
      }
    } catch (e) {
      console.error(`offers: deal history append failed contact=${contactId}:`, e?.message);
    }
  }

  // Best-effort: keep the INVESTOR_DEAL_TAG GHL tag in sync for one contact.
  // The tag means "linked as a disposition investor on at least one live deal"
  // (under_contract / buyer_found / assigned), so GHL contact filters can
  // include or exclude investors who are currently working a property. The
  // membership check spans ALL the location's deals — a contact on two deals
  // keeps the tag until the last one closes or unlinks. Never throws.
  async function syncInvestorDealTag(client, locationId, contactId) {
    if (!contactId) return;
    try {
      const onLiveDeal = (await store.listDeals(locationId)).some((o) =>
        LIVE_DEAL_STAGES.has(o.deal?.stage) &&
        (o.deal?.investors || []).some((i) => i.contactId === contactId));
      if (onLiveDeal) await addContactTags(client, contactId, [INVESTOR_DEAL_TAG]);
      else await removeContactTags(client, contactId, [INVESTOR_DEAL_TAG]);
    } catch (e) {
      console.error(`offers: investor deal tag sync failed contact=${contactId}:`, e?.message);
    }
  }

  /* ---------- offer lifecycle status ---------- */
  // An offer's outcome: not sent → sent → countered / no response / passed /
  // accepted. See shared/offer-status.js for why "expired" is derived rather
  // than stored, and why "accepted" is the promote action under another name.

  // Write a status onto the offer doc and append to its ledger. Mirrors the
  // deal's stage/stageHistory pair — the current value is what the UI reads,
  // the history is what the KPI math trusts.
  function recordStatus(offer, status, note = "", ts = new Date().toISOString()) {
    offer.status = status;
    offer.statusAt = ts;
    offer.statusNote = note;
    offer.statusHistory = [...(offer.statusHistory || []), { status, ts, ...(note ? { note } : {}) }];
    return offer;
  }

  // Best-effort: reconcile the agent's offer-outcome tag in GHL.
  //
  // The awkward part: tags live on the CONTACT, but statuses live on OFFERS,
  // and one agent can have a dozen offers. So this deliberately ignores the
  // offer you just touched and recomputes across ALL of that contact's offers,
  // applying the tag for their most advanced status (STATUS_RANK). An agent
  // with one passed offer and one live one is not a "passed" agent — tagging
  // them from the last row you happened to click would quietly drop them out
  // of your follow-up workflows. Same recompute-and-reconcile shape as
  // syncInvestorDealTag. Never throws.
  async function syncAgentOfferTag(client, locationId, contactId) {
    if (!contactId) return;
    try {
      const offers = await store.listOffers(locationId, { contactId, limit: 200 });
      let best = null;
      for (const o of offers) {
        if (o.status === "draft") continue; // not an offer yet
        const s = effectiveStatus(o);
        if (best === null || (STATUS_RANK[s] ?? -1) > (STATUS_RANK[best] ?? -1)) best = s;
      }
      const want = best ? OFFER_STATUS_TAGS[best] : null;
      const stale = ALL_STATUS_TAGS.filter((t) => t !== want);
      if (want) await addContactTags(client, contactId, [want]);
      await removeContactTags(client, contactId, stale);
    } catch (e) {
      console.error(`offers: agent offer tag sync failed contact=${contactId}:`, e?.message);
    }
  }

  // Promote an offer to an active deal. Shared by POST /:id/deal and by
  // setting the status to "accepted", so there is exactly one code path that
  // can record an acceptance. Throws with .http for the caller to surface.
  async function promoteToDeal({ locationId, client, offer, body = {} }) {
    if (offer.status === "draft") {
      throw Object.assign(new Error("drafts can't be promoted — create the offer first"), { http: 400 });
    }
    if (offer.deal) throw Object.assign(new Error("already a deal"), { http: 409, offer });

    const settings = effectiveSettings(await store.getOfferSettings(locationId));
    const ts = new Date().toISOString();
    const contractPrice = dealMoney(body.contractPrice)
      ?? dealMoney(offer.contract?.fields?.price)
      ?? dealMoney(offer.cashAmount);
    const assignmentFee = dealMoney(body.assignmentFee) ?? dealMoney(settings.wholesaleFee);
    // Inspection contingency deadline: today + the contract's inspection
    // period (local date, same yyyy-mm-dd convention as closingDate).
    const parsedDays = parseInt(offer.contract?.fields?.inspectionDays, 10);
    const inspEnd = new Date();
    inspEnd.setDate(inspEnd.getDate() + (Number.isFinite(parsedDays) ? Math.max(0, parsedDays) : 10));
    const inspectionDefault = `${inspEnd.getFullYear()}-${String(inspEnd.getMonth() + 1).padStart(2, "0")}-${String(inspEnd.getDate()).padStart(2, "0")}`;
    offer.deal = {
      stage: "under_contract",
      createdAt: ts,
      updatedAt: ts,
      stageHistory: [{ stage: "under_contract", ts }],
      contractPrice,
      assignmentFee,
      closingDate: dealStr(body.closingDate, 40) || dealStr(offer.contract?.fields?.closingDate, 40),
      inspectionDate: dealStr(body.inspectionDate, 40) || inspectionDefault,
      notes: "",
      fellThroughReason: "",
      investors: [],
      ghl: { tag: false, note: false },
    };
    // Under contract IS the accepted state — keep the two from disagreeing.
    recordStatus(offer, "accepted", "", ts);

    // Mark the agent contact in GHL — best-effort, never fails the promote.
    const warnings = [];
    const noteFailure = (step, e) => {
      console.error(`offers: deal attach failed [${step}] contact=${offer.contactId}:`, e?.message);
      warnings.push(`${step}: ${e.message}`);
    };
    if (offer.contactId) {
      try {
        await addContactTags(client, offer.contactId, [DEAL_TAG]);
        offer.deal.ghl.tag = true;
      } catch (e) { noteFailure("deal tag", e); }
      try {
        await createContactNote(client, offer.contactId, {
          body: `UNDER CONTRACT — ${offer.address || "property"} (${dateLabel()})` +
            (contractPrice ? `\nContract price: ${fmtMoney(contractPrice)}` : "") +
            `\nTracked in the offer app (Deals tab).`,
        });
        offer.deal.ghl.note = true;
      } catch (e) { noteFailure("deal note", e); }
    }
    if (warnings.length) offer.warnings = [...(offer.warnings || []), ...warnings];
    await appendDealHistory(client, locationId, offer.contactId, "agent_deal_history",
      historyLine(ts, offer.address, "under contract"));

    await store.updateOffer(offer.id, offer);
    // Any investor room already built from this offer now quotes the deal's
    // assignment contract rather than the bare cash offer.
    await syncDealNumbers({ store, offer, settings });
    // The agent is no longer "countered"/"passed" once they're under contract.
    await syncAgentOfferTag(client, locationId, offer.contactId);
    return { offer, warnings };
  }

  // Record an offer outcome. Body: { status, note? }. Picking "accepted" runs
  // the promote path so an acceptance can only ever be recorded one way.
  // The editor's scratch space for an offer that already exists. Autosave lands
  // here so that touching comps or rehab on an open offer can't mint a stray
  // draft row beside it — the bug that left three rows on one property.
  //
  // It writes the workspace and nothing else: no calculation, no documents, no
  // CRM. That is what makes it safe on a debounce, on tab-hide and on unmount,
  // and it means an offer's money can only ever move on a deliberate save.
  router.patch("/:id/workspace", async (req, res) => {
    try {
      const ctx = await loadOwnOffer(req, res);
      if (!ctx) return;
      const { offer } = ctx;
      if (offer.status === "draft") {
        return res.status(400).json({ error: "drafts autosave through POST /api/offers/draft" });
      }
      const fitted = fitSnapshot(req.body?.snapshot);
      if (!fitted.snapshot) return res.status(400).json({ error: "snapshot required" });
      offer.snapshot = fitted.snapshot;
      offer.workspaceAt = new Date().toISOString();
      offer.updatedAt = offer.workspaceAt;
      await store.updateOffer(offer.id, offer);
      res.json({ ok: true, savedAt: offer.workspaceAt, warnings: fitted.warnings });
    } catch (err) { fail(res, err); }
  });

  router.patch("/:id/status", async (req, res) => {
    try {
      const ctx = await loadDealOffer(req, res, { requireDeal: false });
      if (!ctx) return;
      const { locationId, client, offer } = ctx;
      const status = dealStr(req.body?.status, 40);
      if (!SETTABLE_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${SETTABLE_STATUSES.join(", ")}` });
      }
      if (offer.status === "draft") {
        return res.status(400).json({ error: "drafts have no outcome — create the offer first" });
      }
      const note = dealStr(req.body?.note, 200);

      if (status === "accepted") {
        // Already a deal: nothing to promote, and the status is already right.
        if (offer.deal) return res.json({ ok: true, offer, warnings: [] });
        const r = await promoteToDeal({ locationId, client, offer, body: req.body || {} });
        return res.json({ ok: true, promoted: true, ...r });
      }

      const ts = new Date().toISOString();
      recordStatus(offer, status, note, ts);
      await store.updateOffer(offer.id, offer);

      // Best-effort CRM mirror: the ledger line keeps AI enrichment from
      // pitching an agent who already said no; the tag lets workflows branch.
      await appendDealHistory(client, locationId, offer.contactId, "agent_deal_history",
        historyLine(ts, offer.address, STATUS_HISTORY_PHRASE[status] || status.replace(/_/g, " "), note));
      await syncAgentOfferTag(client, locationId, offer.contactId);

      res.json({ ok: true, offer });
    } catch (err) { fail(res, err); }
  });

  // Bulk outcome for the history table's selection bar. Body: { ids, status,
  // note? }. Per-id results so one bad id doesn't sink the batch. "accepted"
  // is excluded — promoting many offers at once is never what you meant.
  router.patch("/status", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const status = dealStr(req.body?.status, 40);
      if (!SETTABLE_STATUSES.includes(status) || status === "accepted") {
        const allowed = SETTABLE_STATUSES.filter((s) => s !== "accepted");
        return res.status(400).json({ error: `status must be one of: ${allowed.join(", ")}` });
      }
      const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).slice(0, 100).map((v) => dealStr(v, 64));
      if (!ids.length) return res.status(400).json({ error: "no offers selected" });
      const note = dealStr(req.body?.note, 200);

      const ts = new Date().toISOString();
      const results = [];
      const offers = [];
      const touchedContacts = new Set();
      for (const id of ids) {
        try {
          const offer = await store.getOffer(id);
          if (!offer || offer.locationId !== locationId) throw new Error("offer not found");
          if (offer.status === "draft") throw new Error("drafts have no outcome");
          if (offer.deal) throw new Error("already a deal — change its stage instead");
          recordStatus(offer, status, note, ts);
          await store.updateOffer(id, offer);
          offers.push(offer);
          if (offer.contactId) touchedContacts.add(offer.contactId);
          await appendDealHistory(client, locationId, offer.contactId, "agent_deal_history",
            historyLine(ts, offer.address, STATUS_HISTORY_PHRASE[status] || status.replace(/_/g, " "), note));
          results.push({ id, ok: true });
        } catch (e) {
          results.push({ id, ok: false, error: e.message });
        }
      }
      // One tag reconcile per contact, not per offer — the tag is computed
      // from all of their offers anyway, so repeating it would be pure waste.
      for (const contactId of touchedContacts) {
        await syncAgentOfferTag(client, locationId, contactId);
      }

      res.json({ ok: true, results, offers });
    } catch (err) { fail(res, err); }
  });

  // Promote an offer to an active deal. Body (all optional): { contractPrice,
  // assignmentFee, closingDate, inspectionDate } — defaults come from the
  // generated contract, the cash offer, and settings.wholesaleFee.
  router.post("/:id/deal", async (req, res) => {
    try {
      const ctx = await loadDealOffer(req, res, { requireDeal: false });
      if (!ctx) return;
      const { locationId, client, offer } = ctx;
      const r = await promoteToDeal({ locationId, client, offer, body: req.body || {} });
      res.json({ ok: true, ...r });
    } catch (err) {
      // 409 keeps its historical shape: the client navigates to the existing deal.
      if (err.http === 409) return res.status(409).json({ error: err.message, offer: err.offer });
      fail(res, err);
    }
  });

  // Update deal terms / stage. Body: any of { stage, contractPrice,
  // assignmentFee, closingDate, inspectionDate, notes, fellThroughReason }.
  router.patch("/:id/deal", async (req, res) => {
    try {
      const ctx = await loadDealOffer(req, res);
      if (!ctx) return;
      const { locationId, client, offer } = ctx;
      const deal = offer.deal;
      const b = req.body || {};
      let stageChanged = false;
      if (b.stage !== undefined) {
        if (!DEAL_STAGES.includes(b.stage)) {
          return res.status(400).json({ error: `stage must be one of: ${DEAL_STAGES.join(", ")}` });
        }
        if (b.stage !== deal.stage) {
          deal.stage = b.stage;
          deal.stageHistory.push({ stage: b.stage, ts: new Date().toISOString() });
          stageChanged = true;
        }
      }
      if (b.contractPrice !== undefined) deal.contractPrice = dealMoney(b.contractPrice);
      if (b.assignmentFee !== undefined) deal.assignmentFee = dealMoney(b.assignmentFee);
      if (b.closingDate !== undefined) deal.closingDate = dealStr(b.closingDate, 40);
      if (b.inspectionDate !== undefined) deal.inspectionDate = dealStr(b.inspectionDate, 40);
      if (b.notes !== undefined) deal.notes = dealStr(b.notes, 4000);
      if (b.fellThroughReason !== undefined) deal.fellThroughReason = dealStr(b.fellThroughReason, 200);
      deal.updatedAt = new Date().toISOString();
      await store.updateOffer(offer.id, offer);
      // Re-price the investor package off the new terms. The rest of its
      // snapshot stays frozen until the operator refreshes it deliberately.
      if (b.contractPrice !== undefined || b.assignmentFee !== undefined) {
        await syncDealNumbers({ store, offer });
      }
      if (stageChanged) {
        await appendDealHistory(client, locationId, offer.contactId, "agent_deal_history",
          historyLine(deal.updatedAt, offer.address, deal.stage.replace(/_/g, " "),
            deal.stage === "fell_through" ? deal.fellThroughReason : ""));
        // A move into/out of closed|fell_through flips whether this deal keeps
        // its investors tagged as on a live deal.
        for (const inv of deal.investors) {
          await syncInvestorDealTag(client, locationId, inv.contactId);
        }
      }
      res.json({ ok: true, offer });
    } catch (err) { fail(res, err); }
  });

  // Un-promote (mistake correction) — removes deal tracking, keeps the offer.
  // The best-effort GHL tag isn't reversed.
  router.delete("/:id/deal", async (req, res) => {
    try {
      const ctx = await loadDealOffer(req, res);
      if (!ctx) return;
      const { locationId, client, offer } = ctx;
      const investors = offer.deal.investors || [];
      delete offer.deal;
      // The acceptance is being taken back too — fall to whatever was true
      // before it (sent if the docs went out, otherwise not sent).
      recordStatus(offer, statusAfterUnpromote(offer));
      await store.updateOffer(offer.id, offer);
      // There is no assignment contract any more — an investor room falls back
      // to the offer's own cash number and the default fee.
      await syncDealNumbers({ store, offer, settings: effectiveSettings(await store.getOfferSettings(locationId)) });
      await syncAgentOfferTag(client, locationId, offer.contactId);
      for (const inv of investors) {
        await syncInvestorDealTag(client, locationId, inv.contactId);
      }
      res.json({ ok: true, offer });
    } catch (err) { fail(res, err); }
  });

  // Link a disposition investor (an existing GHL contact) to the deal.
  // Idempotent on contactId. Body: { contactId, name? }.
  router.post("/:id/deal/investors", async (req, res) => {
    try {
      const ctx = await loadDealOffer(req, res);
      if (!ctx) return;
      const { locationId, client, offer } = ctx;
      const contactId = dealStr(req.body?.contactId, 64);
      if (!contactId) return res.status(400).json({ error: "contactId required" });
      if (offer.deal.investors.some((i) => i.contactId === contactId)) {
        return res.json({ ok: true, offer, duplicate: true });
      }
      let name = dealStr(req.body?.name, 120);
      if (!name) {
        try { name = contactName(await getContact(client, contactId)) || contactId; }
        catch { name = contactId; }
      }
      const ts = new Date().toISOString();
      offer.deal.investors.push({ contactId, name, status: "sent", addedAt: ts, updatedAt: ts });
      offer.deal.updatedAt = ts;
      await store.updateOffer(offer.id, offer);
      await appendDealHistory(client, locationId, contactId, "investor_deal_history",
        historyLine(ts, offer.address, "sent"));
      await syncInvestorDealTag(client, locationId, contactId);
      res.json({ ok: true, offer });
    } catch (err) { fail(res, err); }
  });

  /* ---------- automations: Conversation AI → deal interest ---------- */
  // POST /automations/deal-interest — the target of a GHL workflow's Webhook
  // action, which a Conversation AI bot triggers when a contact expresses
  // interest in a property. Figures out WHICH open deal they were talking
  // about — their recent messages are searched for each deal's street line,
  // in both spelled-out and USPS-abbreviated forms — and links them as an
  // "evaluating" investor: the same write the Deals UI makes, deal-history
  // stamp and tag sync included. Idempotent: already linked as "sent"
  // advances to "evaluating"; any other existing status is left alone.
  // Auth is the standard location gate (location_id + location_key in the
  // webhook URL's query string).
  /* ---------- automation: underwrite an inbound text into an offer ---------- */
  // Target of a GHL Workflow: Inbound Message trigger → your filter → Webhook.
  // The workflow decides WHICH texts are worth spending on; this endpoint
  // trusts that decision and runs the whole underwrite in the background.
  //
  //   POST { location_id, location_key, contactId, message, dryRun }
  //   → 202 { ok, jobId }
  //
  // Answers immediately on purpose: a full run takes 2–5 minutes (the Apify
  // Zillow scrapes dominate) and GHL's webhook action will time out long
  // before that. Progress is polled from the GET below and mirrored onto the
  // contact as notes and uw-* tags.
  router.post("/automations/underwrite", async (req, res) => {
    try {
      const b = req.body || {};
      // GHL webhook payloads vary by trigger — accept every shape it sends.
      b.location_id = b.location_id || b.locationId || b.location?.id || b.customData?.location_id;
      const { locationId, client } = resolveLocation(req);

      // Every other endpoint here is read-mostly or operator-driven. This one
      // spends Apify credits and Anthropic tokens on nothing but a location id,
      // which is guessable, so it insists on a real credential.
      //
      // Two ways to satisfy it, because the obvious one is a trap:
      // GHL_LOCATION_KEYS is enforced by resolveLocation on EVERY request to
      // that location, so switching it on to protect this one webhook 403s
      // every custom menu link in the account until each URL gets ?key=
      // appended. AUTO_UNDERWRITE_SECRET guards only this route and costs no
      // migration — it belongs in the workflow's webhook body, nowhere else.
      if (!LOCATION_KEYS[locationId] && !secretOk(secretFrom(req))) {
        // Say WHICH of the two it is. "bad or missing secret" sent the operator
        // to check their env vars, where the secret was set correctly all along
        // — the workflow simply wasn't sending one.
        // Names only, never values. A 403 that just says "nothing arrived"
        // leaves you guessing which of the caller's three transports the other
        // system actually forwards; this says what it really sent, which is
        // the one fact neither end can see on its own.
        return res.status(403).json({
          error: !AUTO_UNDERWRITE_SECRET
            ? "auto-underwrite needs a credential — set AUTO_UNDERWRITE_SECRET on the broker"
            : secretFrom(req)
            ? "the secret sent doesn't match AUTO_UNDERWRITE_SECRET on the broker"
            : "no secret was sent — add it to the webhook as an x-underwrite-secret header, a ?secret= query param, or \"secret\" in a custom JSON body",
          received: {
            queryKeys: Object.keys(req.query || {}),
            bodyKeys: Object.keys(req.body || {}).slice(0, 30),
            customDataKeys: Object.keys(req.body?.customData || {}).slice(0, 30),
            hasSecretHeader: Boolean(req.get("x-underwrite-secret")),
            contentType: req.get("content-type") || null,
          },
        });
      }

      const contactId = String(
        b.contactId || b.contact_id || b.contact?.id || b.customData?.contact_id || ""
      ).slice(0, 64);
      if (!contactId) return res.status(400).json({ error: "contact_id required" });
      const message = String(b.message || b.body || b.customData?.message || "").slice(0, 4000);
      // An address the workflow already has — from a conversation bot that
      // confirmed the property with the agent, or a contact custom field. When
      // it's present the run trusts it and skips the extraction call entirely.
      const address = String(b.address || b.property_address || b.customData?.address || "").trim();
      const askingPrice = Number(String(b.askingPrice ?? b.asking_price ?? b.customData?.askingPrice ?? "")
        .replace(/[^\d.]/g, "")) || 0;
      // Neither is required. This guard used to demand one of them, which was
      // right before Subject Property existed and wrong after: a workflow that
      // sends only the contact — GHL's default webhook payload, which is what
      // you get when you paste a URL and set no custom body — is now a
      // perfectly good trigger, because the run reads the address off the
      // contact itself.
      //
      // If that field is empty too, the run holds with "no property address"
      // and says so on the contact. A 400 here would instead surface in GHL's
      // execution log as a failed webhook, which describes the workflow rather
      // than the thing that's actually missing.

      const saved = await store.getOfferSettings(locationId);
      // Same double gate as sends, outreach imports and dispo blasts: the
      // caller has to ask for a live run AND the broker has to be configured
      // for it. A dry run still does all the work — it just saves a draft.
      // GHL's Custom Data is all strings, so a "dryRun" row set to false
      // arrives as the STRING "false" — which is not `false`, and would have
      // left the run dry forever with nothing to show for the setting.
      const askedLive = b.dryRun === false || String(b.dryRun).toLowerCase() === "false";
      const dryRun = !askedLive || !AUTO_UNDERWRITE_ENABLED;

      const { skipped, job } = await startUnderwrite({
        client, locationId, saved, store, contactId, message, address, askingPrice, dryRun,
        deps: { createOffer: createOfferFromRequest },
      });
      // A cap hit answers 200, not 4xx: a GHL workflow that gets an error
      // retries, and retrying is exactly what the cap exists to stop.
      if (skipped) return res.json({ ok: true, started: false, skipped });
      res.status(202).json({ ok: true, started: true, jobId: job.id, dryRun: job.dryRun });
    } catch (err) { fail(res, err); }
  });

  router.get("/automations/underwrite", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const one = req.query.jobId ? getUnderwriteJob(String(req.query.jobId)) : null;
      if (req.query.jobId) {
        if (!one || one.locationId !== locationId) return res.status(404).json({ error: "no such job" });
        return res.json({ ok: true, job: publicUnderwriteJob(one) });
      }
      res.json({
        ok: true,
        enabled: AUTO_UNDERWRITE_ENABLED,
        jobs: listUnderwriteJobs(locationId).map(publicUnderwriteJob),
      });
    } catch (err) { fail(res, err); }
  });

  router.post("/automations/underwrite/:id/cancel", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const job = getUnderwriteJob(req.params.id);
      if (!job || job.locationId !== locationId) return res.status(404).json({ error: "no such job" });
      res.json({ ok: true, canceled: cancelUnderwriteJob(job.id) });
    } catch (err) { fail(res, err); }
  });

  /* ---------- automation: draft a reply to an inbound agent text ---------- */
  // Target of a GHL Workflow: Inbound Message trigger → your filter → Webhook.
  // Same trust model as the underwriter: the workflow decides WHICH texts get
  // a draft, this endpoint drafts one in the background and answers at once.
  //
  //   POST { location_id, secret, contactId, message, channel? }
  //   → 202 { ok, jobId }
  //
  // Nothing is sent from here. The draft lands in the outbox (GET below) and
  // on the contact as a note + `reply-draft` tag; a person sends it from the
  // app. Same credential rule as the underwriter, and the same reason: this
  // spends Anthropic tokens on nothing but a location id.
  router.post("/automations/reply", async (req, res) => {
    try {
      const b = req.body || {};
      b.location_id = b.location_id || b.locationId || b.location?.id || b.customData?.location_id;
      const { locationId, client } = resolveLocation(req);
      if (!LOCATION_KEYS[locationId] && !secretOk(secretFrom(req))) {
        return res.status(403).json({
          error: !AUTO_UNDERWRITE_SECRET
            ? "the reply agent needs a credential — set AUTO_UNDERWRITE_SECRET on the broker"
            : secretFrom(req)
            ? "the secret sent doesn't match AUTO_UNDERWRITE_SECRET on the broker"
            : "no secret was sent — add it to the webhook as an x-underwrite-secret header, a ?secret= query param, or \"secret\" in a custom JSON body",
        });
      }
      const contactId = String(
        b.contactId || b.contact_id || b.contact?.id || b.customData?.contact_id || ""
      ).slice(0, 64);
      if (!contactId) return res.status(400).json({ error: "contact_id required" });
      const message = String(b.message || b.body || b.customData?.message || "").slice(0, 4000);
      if (!message.trim()) return res.status(400).json({ error: "message required — pass {{message.body}}" });
      // GHL names the channel in several places depending on the trigger.
      const rawChannel = String(b.channel || b.messageType || b.type || b.customData?.channel || "").toLowerCase();
      const channel = rawChannel.includes("email") ? "email" : "sms";

      const saved = await store.getOfferSettings(locationId);
      const { skipped, job } = await startReply({ client, locationId, saved, store, contactId, message, channel });
      // A cap hit answers 200, not 4xx — a GHL workflow that gets an error
      // retries, and retrying is exactly what the cap exists to stop.
      if (skipped) return res.json({ ok: true, started: false, skipped });
      res.status(202).json({ ok: true, started: true, jobId: job.id });
    } catch (err) { fail(res, err); }
  });

  // The outbox: every draft waiting on a person, plus anything being drafted
  // right now, plus whether Send would actually send.
  router.get("/automations/reply", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const drafts = await store.listReplyDrafts(locationId, { status: "draft", limit: 50 });
      res.json({
        ok: true,
        sendsEnabled: CARD_SENDS_ENABLED,
        drafts,
        jobs: listReplyJobs(locationId).map(publicReplyJob),
      });
    } catch (err) { fail(res, err); }
  });

  // Body: { text?, dryRun }. `text` is what goes out — the operator's edit
  // wins over the model's draft. Dry-run unless dryRun:false AND the broker
  // has CARD_SENDS_ENABLED, the same double gate an offer send has.
  router.post("/automations/reply/:id/send", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const b = req.body || {};
      const live = b.dryRun === false && CARD_SENDS_ENABLED;
      const out = await sendReplyDraft({
        client, store, locationId, draftId: String(req.params.id), text: b.text, live,
      });
      res.json({ ...out, sendsEnabled: CARD_SENDS_ENABLED });
    } catch (err) { fail(res, err); }
  });

  router.post("/automations/reply/:id/dismiss", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      res.json(await dismissReplyDraft({ client, store, locationId, draftId: String(req.params.id) }));
    } catch (err) { fail(res, err); }
  });

  router.post("/automations/deal-interest", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const b = req.body || {};
      // GHL webhook payloads vary by trigger — accept every shape it sends.
      const contactId = dealStr(
        b.contactId || b.contact_id || b.contact?.id || b.customData?.contact_id, 64);
      if (!contactId) return res.status(400).json({ error: "contact_id required" });

      const OPEN_STAGES = new Set(["under_contract", "buyer_found"]);
      const open = (await store.listDeals(locationId)).filter((o) => OPEN_STAGES.has(o.deal?.stage));
      if (!open.length) return res.json({ ok: true, linked: false, reason: "no open deals" });

      let text = "";
      try {
        const t = await buildTranscript(client, locationId, contactId, {
          maxConversations: 2, maxPagesPerConvo: 1, maxMessages: 80,
          maxChars: 15000, maxCallTranscripts: 0,
        });
        text = t.text.toLowerCase();
      } catch { /* missing scope or no messages — the single-deal fallback below still applies */ }

      // Most recently mentioned deal wins; a lone open deal needs no mention.
      let match = null;
      let matchPos = -1;
      for (const o of open) {
        for (const v of addressQueryVariants(o.address || "")) {
          const street = v.split(",")[0].trim().toLowerCase();
          if (street.length < 6) continue;
          const pos = text.lastIndexOf(street);
          if (pos > matchPos) { match = o; matchPos = pos; }
        }
      }
      if (!match && open.length === 1) match = open[0];
      if (!match) return res.json({ ok: true, linked: false, reason: "no deal address in recent messages" });

      const offer = match;
      offer.deal.investors = offer.deal.investors || [];
      const ts = new Date().toISOString();
      const existing = offer.deal.investors.find((i) => i.contactId === contactId);
      if (existing && existing.status !== "sent") {
        return res.json({
          ok: true, linked: true, unchanged: true,
          offerId: offer.id, address: offer.address, status: existing.status,
        });
      }
      if (existing) {
        existing.status = "evaluating";
        existing.updatedAt = ts;
      } else {
        let name = "";
        try { name = contactName(await getContact(client, contactId)) || contactId; }
        catch { name = contactId; }
        offer.deal.investors.push({ contactId, name, status: "evaluating", addedAt: ts, updatedAt: ts });
      }
      offer.deal.updatedAt = ts;
      await store.updateOffer(offer.id, offer);
      await appendDealHistory(client, locationId, contactId, "investor_deal_history",
        historyLine(ts, offer.address, "evaluating", "Conversation AI flagged interest"));
      await syncInvestorDealTag(client, locationId, contactId);
      res.json({ ok: true, linked: true, offerId: offer.id, address: offer.address, status: "evaluating" });
    } catch (err) { fail(res, err); }
  });

  // Per-investor evaluation status. "committed" marks the buyer: notes the
  // investor's GHL contact and advances an under_contract deal to buyer_found.
  // Other investors are left as they are.
  router.patch("/:id/deal/investors/:contactId", async (req, res) => {
    try {
      const ctx = await loadDealOffer(req, res);
      if (!ctx) return;
      const { locationId, client, offer } = ctx;
      const status = dealStr(req.body?.status, 40);
      if (!INVESTOR_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${INVESTOR_STATUSES.join(", ")}` });
      }
      const inv = offer.deal.investors.find((i) => i.contactId === req.params.contactId);
      if (!inv) return res.status(404).json({ error: "investor not linked to this deal" });
      const ts = new Date().toISOString();
      inv.status = status;
      inv.updatedAt = ts;
      const warnings = [];
      if (status === "committed") {
        if (offer.deal.stage === "under_contract") {
          offer.deal.stage = "buyer_found";
          offer.deal.stageHistory.push({ stage: "buyer_found", ts });
        }
        try {
          await createContactNote(client, inv.contactId, {
            body: `COMMITTED BUYER — ${offer.address || "property"} (${dateLabel()})` +
              (offer.deal.assignmentFee ? `\nAssignment fee: ${fmtMoney(offer.deal.assignmentFee)}` : ""),
          });
        } catch (e) {
          console.error(`offers: investor note failed contact=${inv.contactId}:`, e?.message);
          warnings.push(`investor note: ${e.message}`);
        }
      }
      offer.deal.updatedAt = ts;
      await store.updateOffer(offer.id, offer);
      await appendDealHistory(client, locationId, inv.contactId, "investor_deal_history",
        historyLine(ts, offer.address, status));
      res.json({ ok: true, offer, warnings });
    } catch (err) { fail(res, err); }
  });

  // AI-suggest disposition investors for this deal from conversation history.
  // Candidates = investors linked on OTHER deals + contacts carrying an
  // investor tag (minus anyone already on this deal). Each gets a small
  // recent-conversation snippet; one Claude call decides who shows evidence
  // of interest in THIS property. Preview only — the UI links via the normal
  // investor endpoints.
  router.post("/:id/deal/suggest-investors", async (req, res) => {
    try {
      const ctx = await loadDealOffer(req, res);
      if (!ctx) return;
      const { locationId, client, offer } = ctx;
      const saved = await store.getOfferSettings(locationId);
      const aiApiKey = String(saved?.aiApiKey || "").trim();
      if (!aiApiKey) return res.status(400).json({ error: "Anthropic API key required — add it in Settings → AI features" });

      const linkedHere = new Set(offer.deal.investors.map((i) => i.contactId));
      const byId = new Map();
      for (const o of await store.listDeals(locationId)) {
        for (const i of o.deal?.investors || []) {
          if (!linkedHere.has(i.contactId) && !byId.has(i.contactId)) {
            byId.set(i.contactId, { contactId: i.contactId, name: i.name });
          }
        }
      }
      for (const tag of ["investor-active", "investor-stale", "investor"]) {
        try {
          for (const c of await searchContactsByTag(client, locationId, tag)) {
            if (!linkedHere.has(c.id) && !byId.has(c.id)) {
              byId.set(c.id, { contactId: c.id, name: contactName(c) || c.id });
            }
          }
        } catch { /* best-effort — tag may not exist */ }
      }
      const candidates = [...byId.values()].slice(0, 20);
      if (!candidates.length) {
        return res.json({ ok: false, empty: true, reason: "No investor candidates found — link investors on a deal or tag contacts (investor / investor-active)." });
      }

      // Cheap per-candidate snippets: recent conversations only, no call
      // transcription fetches (that's 20 candidates, not one contact).
      let scopeMissing = false;
      await mapPool(candidates, 3, async (c) => {
        try {
          const t = await buildTranscript(client, locationId, c.contactId, {
            maxConversations: 3, maxPagesPerConvo: 1, maxMessages: 80, maxChars: 6000, maxCallTranscripts: 0,
          });
          c.snippet = t.text;
        } catch (e) {
          if (e?.status === 401 || e?.status === 403) scopeMissing = true;
          c.snippet = "";
        }
      });
      if (scopeMissing) return res.json({ ok: false, scopeMissing: true });
      const withText = candidates.filter((c) => c.snippet);
      if (!withText.length) {
        return res.json({ ok: false, empty: true, reason: "No recent conversations found with any investor candidate." });
      }

      let raw;
      try {
        raw = await suggestDealInvestors({
          deal: { address: offer.address, ...offer.deal },
          candidates: withText,
          aiApiKey,
          extraInstructions: String(saved?.enrichExtraInstructions || "").trim(),
        });
      } catch (e) { throw anthropicErrorToHttp(e); }

      const nameOf = new Map(withText.map((c) => [c.contactId, c.name]));
      const suggestions = (raw.suggestions || [])
        .filter((s) => s.include && nameOf.has(s.contactId))
        .map((s) => ({ contactId: s.contactId, name: nameOf.get(s.contactId), status: s.status, reason: String(s.reason || "") }));
      res.json({ ok: true, suggestions, scanned: withText.length });
    } catch (err) { fail(res, err); }
  });

  // Unlink an investor from the deal.
  router.delete("/:id/deal/investors/:contactId", async (req, res) => {
    try {
      const ctx = await loadDealOffer(req, res);
      if (!ctx) return;
      const { locationId, client, offer } = ctx;
      const before = offer.deal.investors.length;
      offer.deal.investors = offer.deal.investors.filter((i) => i.contactId !== req.params.contactId);
      if (offer.deal.investors.length === before) {
        return res.status(404).json({ error: "investor not linked to this deal" });
      }
      offer.deal.updatedAt = new Date().toISOString();
      await store.updateOffer(offer.id, offer);
      await syncInvestorDealTag(client, locationId, req.params.contactId);
      res.json({ ok: true, offer });
    } catch (err) { fail(res, err); }
  });

  /* ---- deal attachments -------------------------------------------------
   * Files the operator uploads against a deal: the signed purchase & sale,
   * addenda, title work, inspection reports. Stored as bytes next to the deal
   * (store.saveDealDoc) rather than on R2, so a link never outlives the
   * location gate — every read below is location-scoped like the rest of this
   * router. Uploads arrive as a base64 data URI, same shape as the photos.
   * ---------------------------------------------------------------------- */

  const MAX_DEAL_DOC_BYTES = 15 * 1024 * 1024;
  const DEAL_DOC_KINDS = [
    "Purchase & sale", "Assignment", "Addendum", "Inspection",
    "Title", "Photos / other", "Other",
  ];

  // Trust the bytes, not the declared type. Anything we can't identify from its
  // magic number is rejected — an attachment list is a place people click, so
  // "some file that claims to be a PDF" is not good enough.
  const DOC_MAGIC = [
    { type: "application/pdf", test: (b) => b.slice(0, 5).toString("ascii") === "%PDF-" },
    { type: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    { type: "image/png", test: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
    { type: "image/webp", test: (b) => b.slice(0, 4).toString("ascii") === "RIFF" && b.slice(8, 12).toString("ascii") === "WEBP" },
    { type: "image/heic", test: (b) => b.slice(4, 8).toString("ascii") === "ftyp" && /heic|heix|mif1/.test(b.slice(8, 12).toString("ascii")) },
    // Modern Office files are zips; legacy .doc/.xls are OLE compound files.
    { type: "application/vnd.openxmlformats-officedocument", test: (b) => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07) },
    { type: "application/msword", test: (b) => b.slice(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) },
  ];

  // A zip could be .docx, .xlsx or a plain .zip — the extension decides which,
  // since the container bytes are identical.
  const OOXML_BY_EXT = {
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    zip: "application/zip",
  };

  function decodeDealDocUpload(dataUri, filename) {
    const m = /^data:([\w.+-]+\/[\w.+-]+)?(;charset=[\w-]+)?;base64,(.+)$/s.exec(String(dataUri || ""));
    if (!m) throw Object.assign(new Error("file must be a base64 data URI"), { http: 400 });
    const bytes = Buffer.from(m[3], "base64");
    if (!bytes.length) throw Object.assign(new Error("file is empty"), { http: 400 });
    if (bytes.length > MAX_DEAL_DOC_BYTES) {
      throw Object.assign(new Error("file is too large (max 15MB)"), { http: 413 });
    }
    const hit = DOC_MAGIC.find((d) => d.test(bytes));
    if (!hit) {
      throw Object.assign(
        new Error("unsupported file type — PDF, image, or Office document"),
        { http: 400 }
      );
    }
    const ext = String(filename || "").split(".").pop().toLowerCase();
    const contentType =
      hit.type === "application/vnd.openxmlformats-officedocument"
        ? OOXML_BY_EXT[ext] || "application/zip"
        : hit.type;
    return { bytes, contentType };
  }

  // Never let an uploaded name reach a header or a filesystem path.
  const safeDocName = (name) =>
    dealStr(String(name || "").replace(/[\\/\r\n"]/g, " ").replace(/\s+/g, " "), 120) || "document";

  router.get("/:id/deal/documents", async (req, res) => {
    try {
      const ctx = await loadDealOffer(req, res);
      if (!ctx) return;
      res.json({ documents: await store.listDealDocs(ctx.offer.id) });
    } catch (err) { fail(res, err); }
  });

  // One file per request: a multi-file batch would be tens of MB of base64 for
  // a single-threaded process to JSON.parse in one blocking go. The client
  // uploads a picked batch one at a time, so one failure doesn't lose the rest.
  router.post("/:id/deal/documents", async (req, res) => {
    try {
      const ctx = await loadDealOffer(req, res);
      if (!ctx) return;
      const name = safeDocName(req.body?.name);
      const kind = DEAL_DOC_KINDS.includes(req.body?.kind) ? req.body.kind : "Other";
      const { bytes, contentType } = decodeDealDocUpload(req.body?.data, name);
      const document = await store.saveDealDoc(ctx.offer.id, ctx.locationId, { kind, name, contentType, bytes });
      res.json({ ok: true, document, documents: await store.listDealDocs(ctx.offer.id) });
    } catch (err) { fail(res, err); }
  });

  // Membership is checked through the offer's own list, never by document id
  // alone — the same rule the photo read path follows.
  router.get("/:id/deal/documents/:docId", async (req, res) => {
    try {
      const ctx = await loadDealOffer(req, res);
      if (!ctx) return;
      const meta = (await store.listDealDocs(ctx.offer.id)).find((d) => d.id === req.params.docId);
      if (!meta) return res.status(404).type("text/plain").send("not found");
      const stored = await store.readDealDocBytes(req.params.docId);
      if (!stored?.bytes) return res.status(404).type("text/plain").send("not found");
      const disposition = req.query.download === "1" ? "attachment" : "inline";
      res.set("Content-Type", meta.contentType || "application/octet-stream");
      res.set("Content-Disposition", `${disposition}; filename="${meta.name}"`);
      res.set("Cache-Control", "private, max-age=3600");
      res.send(stored.bytes);
    } catch (err) { fail(res, err); }
  });

  router.delete("/:id/deal/documents/:docId", async (req, res) => {
    try {
      const ctx = await loadDealOffer(req, res);
      if (!ctx) return;
      const ok = await store.deleteDealDoc(ctx.offer.id, req.params.docId);
      if (!ok) return res.status(404).json({ error: "document not found" });
      res.json({ ok: true, documents: await store.listDealDocs(ctx.offer.id) });
    } catch (err) { fail(res, err); }
  });

  // One-time backfill: recompute the INVESTOR_DEAL_TAG for every contact that
  // appears as an investor on any of the location's deals (live or dead).
  // Investors linked before tag sync existed have no tag; running this once
  // brings GHL in line. Idempotent — safe to re-run.
  router.post("/deals/sync-investor-tags", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const contactIds = new Set();
      for (const o of await store.listDeals(locationId)) {
        for (const i of o.deal?.investors || []) contactIds.add(i.contactId);
      }
      for (const contactId of contactIds) {
        await syncInvestorDealTag(client, locationId, contactId);
      }
      res.json({ ok: true, synced: contactIds.size });
    } catch (err) { fail(res, err); }
  });

  /* ---------- send the offer documents to the contact (text / email) ---------- */
  // Body: { channels?: ["sms","email"], docs?: ["pdf","scope","comps","image"],
  //         message?, emailSubject?, dryRun? }. Defaults ({channels:["sms"],
  //         docs:["image"]}) reproduce the legacy text-with-image behavior.
  // dryRun defaults to true and returns per-channel previews; a live send also
  // requires CARD_SENDS_ENABLED=true on the server (same safety gate the old
  // send engine used). Live sends are recorded on the offer as offer.sends.
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  router.post("/:id/send", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const offer = await store.getOffer(req.params.id);
      if (!offer || offer.locationId !== locationId) return res.status(404).json({ error: "offer not found" });

      const b = req.body || {};
      const { message = "", emailSubject = "", dryRun = true } = b;
      const channels = (Array.isArray(b.channels) ? b.channels : ["sms"]).filter((c) => c === "sms" || c === "email");
      const docKeys = Array.isArray(b.docs) ? b.docs : ["image"];
      if (!channels.length) return res.status(400).json({ error: "no channel selected" });

      // Requested documents, filtered to what this offer actually has.
      const DOC_DEFS = [
        ["pdf", "Offer letter (PDF)", offer.pdfUrl],
        ["psa", "Purchase & sale agreement", offer.psaPdfUrl],
        ["scope", "Rehab scope of work", offer.scopePdfUrl],
        ["comps", "Comparable sales analysis", offer.compsPdfUrl],
        ["netsheet", "Seller net comparison", offer.netSheetPdfUrl],
        ["image", "Offer letter (image)", offer.imageUrl],
      ];
      const picked = DOC_DEFS.filter(([key, , url]) => docKeys.includes(key) && url);
      if (!picked.length) return res.status(400).json({ error: "no documents selected (or the offer has none)" });
      const imagePicked = picked.some(([key]) => key === "image");

      // Destination phone/email live on the GHL contact, not the offer. A
      // lookup failure never fails the request — it surfaces per channel.
      let contact = null;
      let contactErr = "";
      try {
        contact = await getContact(client, offer.contactId);
      } catch (e) { contactErr = e.message; }
      const phone = contact?.phone || "";
      const email = contact?.email || "";
      const channelErr = (dest, label) =>
        contactErr ? `contact lookup failed: ${contactErr}` : !dest ? `contact has no ${label}` : "";

      const firstName = (offer.contactName || "").split(" ")[0] || "there";
      // Kept in step with defaultSendMessage() in the app's SendModal — this
      // is the fallback for callers that send no message of their own.
      const text = message ||
        `Hi ${firstName}, here's our written cash offer on ${offer.address || "your property"} — ` +
        `${fmtMoney(offer.cashAmount)}, as-is, close on your timeline (attached). ` +
        `Happy to answer any questions.`;

      // SMS: just the message, with the image as the MMS attachment. PDFs are
      // email-only — no links in the text.
      const smsText = text;
      const smsAttachments = imagePicked ? [offer.imageUrl] : [];

      // Email: every picked document attached as a file, short HTML body.
      const company = offer.calc?.settings?.company || {};
      const subject = (emailSubject || `Cash offer — ${offer.address || "your property"}`).slice(0, 150);
      const emailAttachments = picked.map(([, , url]) => url);
      const signoffLines = [company.signer || company.name, company.email, company.phone].filter(Boolean);
      // A bare https:// in an HTML email is a dead string the agent has to
      // copy by hand — the operator's message often ends in the offer-page
      // link, so turn URLs into links. Runs after esc(), and stops at "<" so
      // it can't reach into the <br> tags inserted alongside it.
      const linkify = (escaped) =>
        escaped.replace(/https?:\/\/[^\s<]+[^\s<.,:;"')\]]/g, (u) => `<a href="${u}">${u}</a>`);
      const html = [
        `<p>${linkify(esc(message || `Hi ${firstName},`).replace(/\n/g, "<br>"))}</p>`,
        ...(message ? [] : [
          `<p>Please find our written cash offer on <strong>${esc(offer.address || "your property")}</strong> attached — ` +
          `<strong>${esc(fmtMoney(offer.cashAmount))}</strong>, as-is, close on your timeline. ` +
          `Happy to answer any questions.</p>`,
        ]),
        `<p>Attached:</p><ul>${picked.map(([, label]) => `<li>${esc(label)}</li>`).join("")}</ul>`,
        signoffLines.length ? `<p>${signoffLines.map(esc).join("<br>")}</p>` : "",
      ].filter(Boolean).join("\n");

      const live = dryRun === false && CARD_SENDS_ENABLED;
      if (!live) {
        return res.json({
          ok: true,
          dryRun: true,
          sendsEnabled: CARD_SENDS_ENABLED,
          wouldSendTo: offer.contactId,
          // Legacy fields (the New Offer tab's simple send flow reads these).
          message: smsText,
          attachment: offer.imageUrl,
          contact: { phone, email },
          ...(contactErr ? { contactError: contactErr } : {}),
          previews: {
            ...(channels.includes("sms") ? {
              sms: {
                to: phone, message: smsText, attachments: smsAttachments,
                ...(channelErr(phone, "phone number") ? { error: channelErr(phone, "phone number") } : {}),
              },
            } : {}),
            ...(channels.includes("email") ? {
              email: {
                to: email, subject, html, attachments: emailAttachments,
                docs: picked.map(([key, label]) => ({ key, label })),
                ...(channelErr(email, "email address") ? { error: channelErr(email, "email address") } : {}),
              },
            } : {}),
          },
        });
      }

      // Live send — each channel independently; one failing never blocks the other.
      const results = {};
      if (channels.includes("sms")) {
        const err = channelErr(phone, "phone number");
        if (err) results.sms = { ok: false, error: err };
        else {
          try {
            await sendSms(client, { contactId: offer.contactId, message: smsText, attachments: smsAttachments });
            results.sms = { ok: true };
          } catch (e) { results.sms = { ok: false, error: e.message }; }
        }
      }
      if (channels.includes("email")) {
        const err = channelErr(email, "email address");
        if (err) results.email = { ok: false, error: err };
        else {
          try {
            await sendEmail(client, { contactId: offer.contactId, subject, html, attachments: emailAttachments });
            results.email = { ok: true };
          } catch (e) { results.email = { ok: false, error: e.message }; }
        }
      }

      // Record the send on the offer so History can show what went out.
      // (Failed attempts are recorded too — they're part of the story.)
      const sentAt = new Date().toISOString();
      offer.sends = [...(offer.sends || []), {
        ts: sentAt,
        channels,
        docs: picked.map(([key]) => key),
        results,
      }];

      // A successful send advances the lifecycle — but only forwards. Texting
      // the documents again to an agent who already countered (or passed)
      // must not erase what they told us.
      const outcomes = Object.values(results);
      if (outcomes.some((r) => r.ok)) {
        const next = statusAfterSend(offer);
        if (next !== effectiveStatus(offer) || !offer.status) {
          recordStatus(offer, next, "", sentAt);
        }
      }
      await store.updateOffer(offer.id, offer).catch(() => {});

      if (!outcomes.some((r) => r.ok)) {
        // Nothing went out — error response, like the old route on a failed text.
        const detail = Object.entries(results).map(([ch, r]) => `${ch}: ${r.error}`).join("; ");
        return res.status(502).json({ error: "send failed", detail, results, sends: offer.sends });
      }
      // status/statusHistory come back too: a send can advance the lifecycle,
      // and the history row has to show that without a refetch of the fat doc.
      res.json({
        ok: outcomes.every((r) => r.ok), sent: true, results,
        sends: offer.sends, status: offer.status, statusHistory: offer.statusHistory,
      });
    } catch (err) { fail(res, err); }
  });

  return router;
}
