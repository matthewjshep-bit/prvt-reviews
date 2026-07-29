// routes/offers.js — the offer generator API. Everything the app does lives
// here: calculate offers, render the offer document (JPEG preview + PDF via
// cardgen), and associate the offer with a GHL contact (custom fields + note +
// tag). Mounted at /api/offers.
//
//   GET    /api/offers/settings              location calculation defaults
//   PUT    /api/offers/settings
//   POST   /api/offers/calculate             pure calc — no side effects
//   POST   /api/offers/preview               render document, return data URL
//   GET    /api/offers/contacts?query=       GHL contact typeahead
//   POST   /api/offers                       create: calc + document + attach
//   GET    /api/offers?contact_id=&limit=    list saved offers
//   GET    /api/offers/:id
//   DELETE /api/offers/:id
//   POST   /api/offers/:id/send              send offer docs via text/email

import express from "express";
import crypto from "node:crypto";
import { store } from "../store.js";
import { calculateOffers, effectiveSettings, fmtMoney } from "../shared/offer-calc.js";
import { buildOfferDocument, buildScopeDocument, buildScopeNotesDocument, buildCompsDocument } from "../offer-doc.js";
import { fetchListingPhotos, fetchZillowPhotos, scanRehabFromPhotos, anthropicErrorToHttp } from "../rehab-scan.js";
import { addressQueryVariants, zillowUrl } from "../shared/us-address.js";
export { zillowUrl };
import { jpegToPdf, jpegsToPdf } from "../pdf.js";
import { uploadAsset, r2Enabled } from "../r2.js";
import {
  getContact, searchContacts, findOrCreateContactByPhone, updateContact,
  findOrCreateCustomFieldByKey, createContactNote, addContactTags, sendSms, sendEmail,
  customFieldIdKeyMap, contactCustomRecord, listCustomFieldsRaw, deleteCustomField,
} from "../ghl.js";

const CARD_SERVICE_URL = (process.env.CARD_SERVICE_URL || "").replace(/\/$/, "");
const CARD_SENDS_ENABLED = process.env.CARD_SENDS_ENABLED === "true";
const OFFER_TAG = process.env.OFFER_TAG || "offer-created";
const APP_ORIGIN = (process.env.APP_ORIGIN || "").replace(/\/$/, "");

// Deep link into the offer app scoped to one contact (clickable from the GHL
// contact panel). Empty when APP_ORIGIN isn't configured.
const offerAppLink = (locationId, contactId) =>
  APP_ORIGIN
    ? `${APP_ORIGIN}/?location_id=${encodeURIComponent(locationId)}&contact_id=${encodeURIComponent(contactId)}`
    : "";

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

// Contact custom fields the app writes on every offer (created on demand).
const OFFER_FIELDS = [
  { key: "last_offer_amount", name: "Last Offer Amount", dataType: "NUMERICAL" },
  { key: "last_offer_date", name: "Last Offer Date", dataType: "TEXT" },
  { key: "last_offer_doc_url", name: "Last Offer Document URL", dataType: "TEXT" },
  { key: "last_offer_image_url", name: "Last Offer Image URL", dataType: "TEXT" },
  { key: "zillow_link", name: "Zillow Link", dataType: "TEXT" },
  { key: "offer_app_link", name: "Offer App Link", dataType: "TEXT" },
];

const dateLabel = (d = new Date()) =>
  d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

function contactName(c) {
  return [c?.firstName, c?.lastName].filter(Boolean).join(" ") || c?.contactName || "";
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
    `Offer: ${fmtMoney(offers.cash.amount)} (as-is, ~${offers.cash.closeDays}-day close, valid through ${offer.validLabel})`,
    `Inputs: ARV ${fmtMoney(inputs.arv)} · repairs ${fmtMoney(inputs.repairs)}` +
      (inputs.askingPrice > 0 ? ` · asking ${fmtMoney(inputs.askingPrice)}` : ""),
  ];
  if (offer.scope?.length) {
    lines.push(`Rehab scope: ${offer.scope.map((s) => `${s.label} ${fmtMoney(s.cost)}`).join("; ")}`);
  }
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
      const validUntil = new Date(Date.now() + calc.settings.validityDays * 86400000);
      const { jpeg } = await renderDocument(calc, {
        contactName: req.body?.contactName || "",
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
      res.json({
        contact: {
          id: contact.id || req.params.id,
          name: contactName(contact),
          phone: contact.phone || "",
          email: contact.email || "",
          custom: contactCustomRecord(contact, map),
        },
      });
    } catch (err) { fail(res, err); }
  });

  /* ---------- address autocomplete (OSM/Photon, no API key) ---------- */
  router.get("/address-suggest", async (req, res) => {
    try {
      resolveLocation(req);
      const q = String(req.query.query || "").trim();
      if (q.length < 4) return res.json({ suggestions: [] });
      const r = await fetch(
        `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8&lang=en`,
        { signal: AbortSignal.timeout(4000) }
      );
      if (!r.ok) return res.json({ suggestions: [] });
      const j = await r.json();
      const suggestions = [];
      for (const f of j.features || []) {
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
      res.json({ suggestions });
    } catch {
      res.json({ suggestions: [] }); // autocomplete is best-effort — never block typing
    }
  });

  /* ---------- geocode (map centering for the comps pane) ---------- */
  async function photonGeocode(q) {
    try {
      const r = await fetch(
        `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=1&lang=en`,
        { signal: AbortSignal.timeout(4000) }
      );
      if (!r.ok) return null;
      const f = ((await r.json()).features || [])[0];
      if (!f?.geometry?.coordinates) return null;
      const [lng, lat] = f.geometry.coordinates;
      return { lat, lng };
    } catch {
      return null;
    }
  }

  router.get("/geocode", async (req, res) => {
    try {
      resolveLocation(req);
      const q = String(req.query.query || "").trim();
      if (q.length < 4) return res.json({ result: null });
      res.json({ result: await photonGeocode(q) });
    } catch {
      res.json({ result: null });
    }
  });

  /* ---------- comps (RealEstateAPI.com v3, key configured in Settings) ---------- */
  // TRUE closed sales: arms-length transactions within N months, same beds +
  // baths + county, sqft within ±20% of the subject. Cached 24h per query to
  // conserve API credits.
  const compsCache = new Map();
  router.get("/comps", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const address = String(req.query.address || "").trim();
      if (!address) return res.status(400).json({ error: "address required" });
      const monthsBack = Math.min(24, Math.max(1, parseInt(req.query.months, 10) || 12));
      const sqft = parseInt(req.query.sqft, 10) || 0;
      // Optional user-corrected subject facts. When present they replace the
      // same_beds/same_baths matching (which trusts the provider's own record
      // — sometimes wrong) with explicit range filters.
      const beds = Math.max(0, parseInt(req.query.beds, 10) || 0);
      const baths = Math.max(0, parseFloat(req.query.baths) || 0);

      const saved = await store.getOfferSettings(locationId);
      const apiKey = String(saved?.compsApiKey || saved?.rentcastApiKey || "").trim();
      if (!apiKey) return res.json({ enabled: false, comps: [], estimate: null, subject: null });

      const cacheKey = `${address.toLowerCase()}|${monthsBack}|${sqft}|${beds}|${baths}`;
      const hit = compsCache.get(cacheKey);
      if (hit && Date.now() - hit.ts < 24 * 3600 * 1000) return res.json(hit.data);

      // When the user corrects beds/baths we do NOT pass bedrooms/bathrooms
      // filters to the API — RealEstateAPI applies them to the subject lookup
      // too, so a corrected count that disagrees with their record makes the
      // whole property "not exist". Instead: drop same_beds/same_baths, pull a
      // wider pool, and filter the comps ourselves below.
      const hasBedBathOverride = beds > 0 || baths > 0;
      const makeBody = ({ radiusMiles, daysBack, matchBedBath }) => ({
        max_days_back: daysBack,
        max_radius_miles: radiusMiles,
        max_results: hasBedBathOverride ? 30 : 15,
        ...(matchBedBath && !hasBedBathOverride ? { same_beds: true, same_baths: true } : {}),
        same_county: true,
        arms_length: true,
        ...(sqft > 0
          ? { living_square_feet_min: Math.round(sqft * 0.8), living_square_feet_max: Math.round(sqft * 1.2) }
          : {}),
      });
      const queryComps = async (subject, params) => {
        const r = await fetch("https://api.realestateapi.com/v3/PropertyComps", {
          method: "POST",
          headers: { "x-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ ...makeBody(params), ...subject }),
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) {
          const detail = (await r.text()).slice(0, 300);
          throw Object.assign(new Error(`RealEstateAPI ${r.status}`), { http: 502, detail });
        }
        return r.json();
      };
      // IMPORTANT provider quirk: when fewer than 3 comps match the filters,
      // PropertyComps suppresses the ENTIRE response — empty subject included,
      // with only a `reason` string. So "no property record" can really mean
      // "not enough sales matched"; the relaxation ladder below distinguishes
      // the two.
      const noRecord = (x) => !x?.subject?.propertyInfo?.latitude && !(x?.comps || []).length;
      const asRequested = { radiusMiles: 2, daysBack: monthsBack * 30, matchBedBath: true };
      let j = null;
      let lastErr = null;
      // Phase A — resolve by address: the provider's address matcher is
      // inconsistent about formats ("166th Ave NE" one day, "166th Avenue NE"
      // the next) while GHL/autocomplete produce the spelled-out form. Walk
      // the variant ladder until one resolves.
      for (const variant of addressQueryVariants(address)) {
        try {
          const attempt = await queryComps({ address: variant }, asRequested);
          if (!noRecord(attempt)) { j = attempt; break; }
          if (!j) j = attempt; // remember the first empty result as a fallback
        } catch (e) { lastErr = e; }
      }
      // Phase B — resolve by coordinates: county records keyed under another
      // postal city or grid-address quirks make some parcels unfindable by
      // address entirely. Geocode the typed address and find the parcel via
      // PropertySearch, then query comps against the property id.
      let subjectRef = null;
      if (!j || noRecord(j)) {
        try {
          const geo = await photonGeocode(address);
          if (geo) {
            const sr = await fetch("https://api.realestateapi.com/v2/PropertySearch", {
              method: "POST",
              headers: { "x-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
              body: JSON.stringify({ latitude: geo.lat, longitude: geo.lng, radius: 0.05, size: 10 }),
              signal: AbortSignal.timeout(15000),
            });
            if (sr.ok) {
              const list = ((await sr.json()).data || []).filter((p) => p?.id);
              const houseNo = (address.match(/^\s*(\d+)/) || [])[1];
              const label = (p) => String(p.address?.address || p.address?.label || "");
              const pick = (houseNo && list.find((p) => label(p).startsWith(houseNo))) || list[0];
              if (pick) {
                subjectRef = { id: pick.id };
                const byId = await queryComps(subjectRef, asRequested);
                if (!noRecord(byId)) j = byId;
              }
            }
          }
        } catch { /* keep whatever the ladder produced */ }
      }
      // Phase C — widen the search: still nothing means "fewer than 3 sales
      // matched", not "no such property" (rural areas rarely have 3 same-bed
      // sales within 2 miles). Expand stepwise and tell the UI we did.
      let widened = null;
      if (!j || noRecord(j)) {
        const ref = subjectRef || { address: addressQueryVariants(address)[0] };
        const steps = [
          { params: { radiusMiles: 5, daysBack: monthsBack * 30, matchBedBath: true }, label: "5 mi" },
          { params: { radiusMiles: 5, daysBack: Math.max(monthsBack * 30, 730), matchBedBath: false }, label: "5 mi / 24 mo / any beds-baths" },
        ];
        for (const step of steps) {
          try {
            const attempt = await queryComps(ref, step.params);
            if (!noRecord(attempt)) { j = attempt; widened = step.label; break; }
          } catch (e) { lastErr = e; }
        }
      }
      if (!j) throw lastErr || Object.assign(new Error("comps lookup failed"), { http: 502 });
      const subjInfo = j.subject?.propertyInfo || {};
      const num = (v) => (v == null || v === "" ? null : Number(v) || null);
      const data = {
        enabled: true,
        ...(widened ? { widened } : {}),
        subject: {
          lat: num(subjInfo.latitude),
          lng: num(subjInfo.longitude),
          beds: num(subjInfo.bedrooms),
          baths: num(subjInfo.bathrooms),
          sqft: num(subjInfo.livingSquareFeet),
          yearBuilt: num(subjInfo.yearBuilt),
          lastSalePrice: num(j.subject?.lastSalePrice),
          lastSaleDate: j.subject?.lastSaleDate || null,
        },
        estimate: j.reapiAvm
          ? { price: Math.round(Number(j.reapiAvm)), low: Math.round(Number(j.reapiAvmLow || 0)), high: Math.round(Number(j.reapiAvmHigh || 0)) }
          : null,
        comps: (j.comps || [])
          .map((c) => {
            const price = c.mlsSoldPrice || c.lastSaleAmount || 0;
            const saleDate = c.mlsLastSaleDate || c.lastSaleDate || "";
            return {
              id: String(c.id || `${c.latitude},${c.longitude}`),
              address: c.address?.address || [c.address?.city, c.address?.state].filter(Boolean).join(", "),
              price: Math.round(price),
              saleDate: String(saleDate).slice(0, 10),
              sqft: Number(c.squareFeet) || 0,
              beds: c.bedrooms ?? null,
              baths: c.bathrooms ?? null,
              distance: c.distance != null ? Math.round(c.distance * 100) / 100 : null,
              lat: c.latitude,
              lng: c.longitude,
            };
          })
          .filter((c) => c.lat && c.lng && c.price > 0),
      };
      // Enforce "similar sqft" even when the caller didn't pass sqft (the
      // provider's own record supplies it): keep comps within ±20%.
      const effSqft = sqft > 0 ? sqft : data.subject.sqft || 0;
      if (effSqft > 0) {
        data.comps = data.comps.filter((c) => !c.sqft || (c.sqft >= effSqft * 0.8 && c.sqft <= effSqft * 1.2));
      }
      // User-corrected beds/baths: match server-side (comps missing the datum
      // are kept, mirroring the sqft rule). Baths allow ±0.5 so a 2.75-bath
      // comp still matches a "3 baths" subject. When the exact match filters
      // EVERYTHING out (a 6-bed in an area of 3-beds), fall back to the
      // unfiltered similar-size pool and flag it — hand-picking from nearby
      // sales beats a dead end.
      if (beds > 0 || baths > 0) {
        const pool = data.comps;
        let filtered = pool;
        if (beds > 0) filtered = filtered.filter((c) => c.beds == null || Math.round(Number(c.beds)) === beds);
        if (baths > 0) filtered = filtered.filter((c) => c.baths == null || Math.abs(Number(c.baths) - baths) <= 0.5);
        if (filtered.length) {
          data.comps = filtered;
        } else if (pool.length) {
          data.comps = pool;
          data.bedBathRelaxed = true;
        }
      }
      data.comps = data.comps.slice(0, 15);
      // Cache hits only — caching an empty result would pin a transient
      // provider blip as "no record" for 24h.
      if (data.subject.lat || data.comps.length) {
        if (compsCache.size > 100) compsCache.clear();
        compsCache.set(cacheKey, { ts: Date.now(), data });
      }
      res.json(data);
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

  /* ---------- create: calculate + document + attach to contact ---------- */
  router.post("/", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const { contactId: bodyContactId, newContact, inputs, settings: settingsOverride } = req.body || {};
      // Rehab scope of work (internal — saved + noted, never on the letter).
      const scope = Array.isArray(req.body?.scope)
        ? req.body.scope
            .filter((s) => s && s.label && Number(s.cost) > 0)
            .slice(0, 60)
            .map((s) => ({ label: String(s.label).slice(0, 120), cost: Math.round(Number(s.cost)) }))
        : [];
      // Full form snapshot (comps workspace + rehab state) so editing the
      // offer later restores everything. Size-capped defensively.
      let snapshot = null;
      if (req.body?.snapshot && typeof req.body.snapshot === "object") {
        try {
          if (JSON.stringify(req.body.snapshot).length <= 400_000) snapshot = req.body.snapshot;
        } catch { /* unserializable — drop */ }
      }

      // 1. Resolve the contact (existing id, or find/create by phone).
      let contactId = bodyContactId || "";
      if (!contactId && newContact?.phone) {
        contactId = await findOrCreateContactByPhone(client, locationId, newContact.phone, newContact.name || "");
      }
      if (!contactId) return res.status(400).json({ error: "contactId or newContact.phone required" });
      const contact = await getContact(client, contactId);

      // 2. Calculate.
      const saved = await store.getOfferSettings(locationId);
      const calc = calculateOffers(inputs || {}, { ...(saved || {}), ...(settingsOverride || {}) });

      // 3. Render the document, wrap as PDF, store both.
      const created = new Date();
      const validUntil = new Date(created.getTime() + calc.settings.validityDays * 86400000);
      const meta = {
        contactName: contactName(contact),
        dateLabel: dateLabel(created),
        validLabel: dateLabel(validUntil),
      };
      const { jpeg, width, height } = await renderDocument(calc, meta, locationId);
      const pdf = jpegToPdf(jpeg, width, height);
      const offerId = crypto.randomUUID();
      const { imageUrl, pdfUrl } = await storeDocuments(offerId, locationId, jpeg, pdf, calc.inputs.address);

      // Companion document: Rehab Scope of Work (when a scope was applied).
      let scopePdfUrl = null;
      let scopeWarning = null;
      if (scope.length) {
        try {
          // Photo-review summary + per-item rationale from the form snapshot
          // (rendered as "condition notes" — no tooling references on paper).
          const ai = snapshot?.rehab?.aiResult;
          const assessment = ai && (ai.summary || (ai.notes || []).length)
            ? { summary: ai.summary || "", notes: Array.isArray(ai.notes) ? ai.notes : [] }
            : null;
          scopePdfUrl = await storeScopeDocument({
            offerId, locationId, scope,
            total: calc.inputs.repairs,
            address: calc.inputs.address,
            meta, company: calc.settings.company || {},
            assessment,
          });
        } catch (e) { scopeWarning = `rehab SOW: ${e.message}`; }
      }

      // Companion document: Comparable Sales Analysis (when comps back the ARV).
      let compsPdfUrl = null;
      let compsWarning = null;
      try {
        const cs = snapshot?.comps;
        const sel = new Set(Array.isArray(cs?.selected) ? cs.selected : []);
        const picked = [
          ...(cs?.result?.comps || []).filter((c) => sel.has(c.id)),
          ...(Array.isArray(cs?.manual) ? cs.manual : []),
        ];
        if (picked.length) {
          compsPdfUrl = await storeCompsDocument({
            offerId, locationId,
            comps: picked,
            subject: cs?.result?.info || null,
            estimate: cs?.result?.estimate || null,
            months: Number(cs?.months) || 0,
            subjectSqft: Number(String(snapshot?.subjectSqft ?? "").replace(/[^\d.]/g, "")) || 0,
            arv: calc.inputs.arv,
            address: calc.inputs.address,
            meta, company: calc.settings.company || {},
          });
        }
      } catch (e) { compsWarning = `comps PDF: ${e.message}`; }

      // 4. Persist the offer.
      const offer = await store.createOffer({
        id: offerId,
        locationId,
        contactId,
        contactName: meta.contactName,
        address: calc.inputs.address,
        cashAmount: calc.offers.cash.amount,
        imageUrl,
        pdfUrl,
        scopePdfUrl,
        compsPdfUrl,
        dateLabel: meta.dateLabel,
        validLabel: meta.validLabel,
        scope,
        snapshot,
        calc,
      });

      // 5. Associate with the GHL contact record. Each write is independent;
      //    failures are reported + logged, not fatal (the offer itself is saved).
      const ghl = { fields: false, note: false, tag: false };
      const warnings = [];
      if (scopeWarning) warnings.push(scopeWarning);
      if (compsWarning) warnings.push(compsWarning);
      const noteFailure = (step, e) => {
        const detail = e?.data ? `${e.message} :: ${JSON.stringify(e.data).slice(0, 200)}` : e?.message;
        console.error(`offers: GHL attach failed [${step}] contact=${contactId}:`, detail);
        warnings.push(`${step}: ${e.message}`);
      };
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
      try {
        await createContactNote(client, contactId, { body: offerNoteBody(offer) });
        ghl.note = true;
      } catch (e) { noteFailure("note", e); }
      try {
        await addContactTags(client, contactId, [OFFER_TAG]);
        ghl.tag = true;
      } catch (e) { noteFailure("tag", e); }

      // Persist the attach outcome on the offer so History can show it.
      offer.ghl = ghl;
      offer.warnings = warnings;
      await store.updateOffer(offer.id, offer).catch(() => {});

      // Creating from a draft consumes the draft.
      const draftId = req.body?.draftId;
      if (draftId) {
        const d = await store.getOffer(draftId).catch(() => null);
        if (d && d.locationId === locationId && d.status === "draft") {
          await store.deleteOffer(draftId).catch(() => {});
        }
      }

      res.json({ ok: true, offer, ghl, warnings });
    } catch (err) { fail(res, err); }
  });

  /* ---------- list / read / delete ---------- */
  router.get("/", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const contactId = String(req.query.contact_id || "") || null;
      const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
      res.json({ offers: await store.listOffers(locationId, { contactId, limit }) });
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
      await store.deleteOffer(req.params.id);
      res.json({ ok: true });
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
        ["scope", "Rehab scope of work", offer.scopePdfUrl],
        ["comps", "Comparable sales analysis", offer.compsPdfUrl],
        ["image", "Offer letter (image)", offer.imageUrl],
      ];
      const picked = DOC_DEFS.filter(([key, , url]) => docKeys.includes(key) && url);
      if (!picked.length) return res.status(400).json({ error: "no documents selected (or the offer has none)" });
      const imagePicked = picked.some(([key]) => key === "image");
      const pdfDocs = picked.filter(([key]) => key !== "image");

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
      const text = message ||
        `Hi ${firstName}, here's our written cash offer on ${offer.address || "your property"} — ` +
        `${fmtMoney(offer.cashAmount)}, as-is, close on your timeline (attached). ` +
        `Happy to answer any questions.`;

      // SMS: image rides as the MMS attachment; PDFs go as links in the text.
      const smsText = [text, ...pdfDocs.map(([, label, url]) => `${label}: ${url}`)].join("\n\n");
      const smsAttachments = imagePicked ? [offer.imageUrl] : [];

      // Email: every picked document attached as a file, short HTML body.
      const company = offer.calc?.settings?.company || {};
      const subject = (emailSubject || `Cash offer — ${offer.address || "your property"}`).slice(0, 150);
      const emailAttachments = picked.map(([, , url]) => url);
      const signoffLines = [company.signer || company.name, company.email, company.phone].filter(Boolean);
      const html = [
        `<p>${esc(message || `Hi ${firstName},`).replace(/\n/g, "<br>")}</p>`,
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
      offer.sends = [...(offer.sends || []), {
        ts: new Date().toISOString(),
        channels,
        docs: picked.map(([key]) => key),
        results,
      }];
      await store.updateOffer(offer.id, offer).catch(() => {});

      const outcomes = Object.values(results);
      if (!outcomes.some((r) => r.ok)) {
        // Nothing went out — error response, like the old route on a failed text.
        const detail = Object.entries(results).map(([ch, r]) => `${ch}: ${r.error}`).join("; ");
        return res.status(502).json({ error: "send failed", detail, results, sends: offer.sends });
      }
      res.json({ ok: outcomes.every((r) => r.ok), sent: true, results, sends: offer.sends });
    } catch (err) { fail(res, err); }
  });

  return router;
}
