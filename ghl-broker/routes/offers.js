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
import path from "node:path";
import { store } from "../store.js";
import { calculateOffers, effectiveSettings, fmtMoney } from "../shared/offer-calc.js";
import { buildOfferDocument } from "../offer-doc.js";
import { jpegToPdf } from "../pdf.js";
import { uploadAsset } from "../r2.js";
import {
  getContact, searchContacts, findOrCreateContactByPhone, updateContact,
  findOrCreateCustomFieldByKey, createContactNote, addContactTags, sendSms,
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
    `OFFER — ${inputs.address || "subject property"} (${offer.dateLabel})`,
    `Option A · Cash: ${fmtMoney(offers.cash.amount)} (as-is, ~${offers.cash.closeDays}-day close)`,
    `Option B · Seller finance: ${fmtMoney(offers.sellerFinance.price)} — ${fmtMoney(offers.sellerFinance.down)} down, ` +
      `${fmtMoney(offers.sellerFinance.monthly)}/mo` +
      (offers.sellerFinance.balloon > 0
        ? `, balloon ${fmtMoney(offers.sellerFinance.balloon)} at year ${offers.sellerFinance.balloonYears}`
        : ` for ${offers.sellerFinance.termYears} yrs`),
  ];
  if (offers.leaseOption) {
    lines.push(
      `Option C · Lease option: ${fmtMoney(offers.leaseOption.price)} — ${fmtMoney(offers.leaseOption.optionFee)} option fee, ` +
      `${fmtMoney(offers.leaseOption.monthly)}/mo for ${offers.leaseOption.termMonths} months`
    );
  }
  lines.push(`Inputs: asking ${fmtMoney(inputs.askingPrice)} · ARV ${fmtMoney(inputs.arv)} · repairs ${fmtMoney(inputs.repairs)}`);
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
  // Keys already carry the offers/ prefix; store relative to the upload root.
  const localOpts = {
    localDir: uploadDir,
    localBaseUrl: `${publicBaseUrl}/uploads`,
  };

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
      const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const keyBase = `offers/${locationId}/${stamp}`;
      const imageUrl = await uploadAsset(`${keyBase}.jpg`, jpeg, "image/jpeg", localOpts);
      const pdfUrl = await uploadAsset(`${keyBase}.pdf`, pdf, "application/pdf", localOpts);

      // 4. Persist the offer.
      const offer = await store.createOffer({
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
        `Hi ${firstName}, here's our written offer on ${offer.address || "your property"} — ` +
        `${fmtMoney(offer.cashAmount)} cash, plus two other ways we can structure it (attached). ` +
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
