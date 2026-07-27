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
//   POST   /api/offers/:id/send              text the offer doc to the contact

import express from "express";
import crypto from "node:crypto";
import { store } from "../store.js";
import { calculateOffers, effectiveSettings, fmtMoney } from "../shared/offer-calc.js";
import { buildOfferDocument } from "../offer-doc.js";
import { jpegToPdf } from "../pdf.js";
import { uploadAsset, r2Enabled } from "../r2.js";
import {
  getContact, searchContacts, findOrCreateContactByPhone, updateContact,
  findOrCreateCustomFieldByKey, createContactNote, addContactTags, sendSms,
  customFieldIdKeyMap, contactCustomRecord,
} from "../ghl.js";

const CARD_SERVICE_URL = (process.env.CARD_SERVICE_URL || "").replace(/\/$/, "");
const CARD_SENDS_ENABLED = process.env.CARD_SENDS_ENABLED === "true";
const OFFER_TAG = process.env.OFFER_TAG || "offer-created";

// Contact custom fields the app writes on every offer (created on demand).
const OFFER_FIELDS = [
  { key: "last_offer_amount", name: "Last Offer Amount", dataType: "NUMERICAL" },
  { key: "last_offer_date", name: "Last Offer Date", dataType: "TEXT" },
  { key: "last_offer_doc_url", name: "Last Offer Document URL", dataType: "TEXT" },
  { key: "last_offer_image_url", name: "Last Offer Image URL", dataType: "TEXT" },
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
    `Inputs: asking ${fmtMoney(inputs.askingPrice)} · ARV ${fmtMoney(inputs.arv)} · repairs ${fmtMoney(inputs.repairs)}`,
  ];
  if (offer.pdfUrl) lines.push(`Document (PDF): ${offer.pdfUrl}`);
  if (offer.imageUrl) lines.push(`Document (image): ${offer.imageUrl}`);
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
  async function storeDocuments(offerId, locationId, jpeg, pdf) {
    if (r2Enabled) {
      const keyBase = `offers/${locationId}/${offerId}`;
      const localOpts = { localDir: uploadDir, localBaseUrl: `${publicBaseUrl}/uploads` };
      return {
        imageUrl: await uploadAsset(`${keyBase}.jpg`, jpeg, "image/jpeg", localOpts),
        pdfUrl: await uploadAsset(`${keyBase}.pdf`, pdf, "application/pdf", localOpts),
      };
    }
    await store.saveOfferDoc(offerId, "image", jpeg, "image/jpeg");
    await store.saveOfferDoc(offerId, "pdf", pdf, "application/pdf");
    return {
      imageUrl: `${publicBaseUrl}/api/offers/${offerId}/doc.jpg`,
      pdfUrl: `${publicBaseUrl}/api/offers/${offerId}/doc.pdf`,
    };
  }

  // Public document routes (the URLs written onto the contact / texted out).
  // No location gate: the unguessable offer UUID is the capability, exactly
  // like a public R2 URL.
  const serveDoc = (kind) => async (req, res) => {
    try {
      const doc = await store.getOfferDoc(req.params.id, kind);
      if (!doc) return res.status(404).type("text/plain").send("not found");
      res.set("Content-Type", doc.contentType);
      res.set("Cache-Control", "public, max-age=31536000, immutable");
      res.send(doc.bytes);
    } catch (err) { fail(res, err); }
  };
  router.get("/:id/doc.pdf", serveDoc("pdf"));
  router.get("/:id/doc.jpg", serveDoc("image"));

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
  router.get("/geocode", async (req, res) => {
    try {
      resolveLocation(req);
      const q = String(req.query.query || "").trim();
      if (q.length < 4) return res.json({ result: null });
      const r = await fetch(
        `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=1&lang=en`,
        { signal: AbortSignal.timeout(4000) }
      );
      if (!r.ok) return res.json({ result: null });
      const j = await r.json();
      const f = (j.features || [])[0];
      if (!f?.geometry?.coordinates) return res.json({ result: null });
      const [lng, lat] = f.geometry.coordinates;
      res.json({ result: { lat, lng } });
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

      const saved = await store.getOfferSettings(locationId);
      const apiKey = String(saved?.compsApiKey || saved?.rentcastApiKey || "").trim();
      if (!apiKey) return res.json({ enabled: false, comps: [], estimate: null, subject: null });

      const cacheKey = `${address.toLowerCase()}|${monthsBack}|${sqft}`;
      const hit = compsCache.get(cacheKey);
      if (hit && Date.now() - hit.ts < 24 * 3600 * 1000) return res.json(hit.data);

      const body = {
        address,
        max_days_back: monthsBack * 30,
        max_radius_miles: 2,
        max_results: 15,
        same_beds: true,
        same_baths: true,
        same_county: true,
        arms_length: true,
        ...(sqft > 0
          ? { living_square_feet_min: Math.round(sqft * 0.8), living_square_feet_max: Math.round(sqft * 1.2) }
          : {}),
      };
      const r = await fetch("https://api.realestateapi.com/v3/PropertyComps", {
        method: "POST",
        headers: { "x-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) {
        const detail = (await r.text()).slice(0, 300);
        return res.status(502).json({ error: `RealEstateAPI ${r.status}`, detail });
      }
      const j = await r.json();
      const subjInfo = j.subject?.propertyInfo || {};
      const num = (v) => (v == null || v === "" ? null : Number(v) || null);
      const data = {
        enabled: true,
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
      if (compsCache.size > 100) compsCache.clear();
      compsCache.set(cacheKey, { ts: Date.now(), data });
      res.json(data);
    } catch (err) { fail(res, err); }
  });

  /* ---------- create: calculate + document + attach to contact ---------- */
  router.post("/", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const { contactId: bodyContactId, newContact, inputs, settings: settingsOverride } = req.body || {};

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
      const { imageUrl, pdfUrl } = await storeDocuments(offerId, locationId, jpeg, pdf);

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
        dateLabel: meta.dateLabel,
        validLabel: meta.validLabel,
        calc,
      });

      // 5. Associate with the GHL contact record. Each write is independent;
      //    failures are reported + logged, not fatal (the offer itself is saved).
      const ghl = { fields: false, note: false, tag: false };
      const warnings = [];
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
        };
        const fieldWrites = [];
        for (const f of OFFER_FIELDS) {
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

  /* ---------- text the offer document to the contact ---------- */
  // dryRun defaults to true; a live send also requires CARD_SENDS_ENABLED=true
  // on the server (same safety gate the old send engine used).
  router.post("/:id/send", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const offer = await store.getOffer(req.params.id);
      if (!offer || offer.locationId !== locationId) return res.status(404).json({ error: "offer not found" });

      const { message = "", dryRun = true } = req.body || {};
      const firstName = (offer.contactName || "").split(" ")[0] || "there";
      const text = message ||
        `Hi ${firstName}, here's our written cash offer on ${offer.address || "your property"} — ` +
        `${fmtMoney(offer.cashAmount)}, as-is, close on your timeline (attached). ` +
        `Reply with any questions or a counter.`;

      const live = dryRun === false && CARD_SENDS_ENABLED;
      if (!live) {
        return res.json({ ok: true, dryRun: true, sendsEnabled: CARD_SENDS_ENABLED, wouldSendTo: offer.contactId, message: text, attachment: offer.imageUrl });
      }
      const result = await sendSms(client, { contactId: offer.contactId, message: text, attachments: [offer.imageUrl] });
      res.json({ ok: true, sent: true, result });
    } catch (err) { fail(res, err); }
  });

  return router;
}
