// routes/render.js — production render endpoints that resolve a real GHL contact
// into the template's binding context, drive cardgen, store to R2, and (for
// test-send) attach the result to an MMS. Also the GHL-workflow webhook (§8).
//
//   POST /api/render/generate    { templateId, contactId, force? }
//   POST /api/render/test-send   { templateId, testPhone, sampleName, message? }
//   POST /api/render/webhook     { locationId, contactId, templateId }  (phase 8)

import express from "express";
import { store } from "../store.js";
import {
  getContact, listCustomFields, getConfig, findOrCreateContactByPhone, sendSms,
  findOrCreateCustomFieldByKey, updateContactCustomField,
} from "../ghl.js";

const WEBHOOK_BUDGET_MS = 8000; // respond within this or return 202 and finish async
const DEFAULT_FIELD_KEY = process.env.CARD_FIELD_KEY || "card_image_url";

const CARD_SERVICE_URL = (process.env.CARD_SERVICE_URL || "").replace(/\/$/, "");
const CARD_SENDS_ENABLED = process.env.CARD_SENDS_ENABLED === "true";

// 5-min cache of custom-field defs per location (id → fieldKey mapping).
const cfCache = new Map();
async function customFieldMap(client, locationId) {
  const c = cfCache.get(locationId);
  if (c && Date.now() - c.ts < 5 * 60 * 1000) return c.map;
  let defs = [];
  try {
    defs = await listCustomFields(client, locationId);
  } catch {
    /* ignore */
  }
  const map = new Map();
  for (const d of defs) map.set(d.id, String(d.fieldKey || "").replace(/^contact\./, ""));
  cfCache.set(locationId, { ts: Date.now(), map });
  return map;
}

// Build { contact, loc, data } from a GHL contact + location config.
export async function buildContactContext(client, locationId, contact) {
  const cfMap = await customFieldMap(client, locationId);
  const custom = {};
  for (const cf of contact.customFields || contact.customField || []) {
    const key = cfMap.get(cf.id);
    if (key) custom[key] = cf.value ?? cf.fieldValue ?? "";
  }
  const std = {
    first_name: contact.firstName || "",
    last_name: contact.lastName || "",
    phone: contact.phone || "",
    email: contact.email || "",
    address1: contact.address1 || contact.address || "",
    city: contact.city || "",
    state: contact.state || "",
    custom,
  };
  std.address_full = [std.address1, std.city, std.state].filter(Boolean).join(", ");

  let loc = {};
  try {
    const cfg = await getConfig(client, locationId);
    loc = { business_name: cfg.businessName || "", owner_first_name: cfg.ownerName || "" };
  } catch {
    /* ignore */
  }
  return { contact: std, loc, data: {} };
}

async function cardgenGenerate({ template, context, connections = {}, force = false }) {
  const resolveProviders = Array.isArray(template.dataSources) && template.dataSources.length > 0;
  const r = await fetch(`${CARD_SERVICE_URL}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ template, context, connections, resolveProviders, store: true, format: "auto", force }),
  });
  if (!r.ok) throw Object.assign(new Error("cardgen_generate_failed"), { http: 502, detail: (await r.text()).slice(0, 300) });
  return r.json();
}

export default function createRenderRouter({ resolveLocation, resolveConnectionsFor }) {
  const router = express.Router();
  const fail = (res, err) => {
    const code = err.http || err.status || 500;
    if (code >= 500) console.error("render error:", code, err.message);
    res.status(code).json({ error: err.message, detail: err.detail });
  };
  const needCardgen = () => {
    if (!CARD_SERVICE_URL) throw Object.assign(new Error("CARD_SERVICE_URL not configured"), { http: 500 });
  };

  // Core: resolve a template + contact → generate → log → return.
  // `dataOverrides` (optional) is merged into context.data before render, so
  // callers can inject computed scopes like data.tier.* (Home Offers terms).
  async function generate({ client, locationId, templateId, contactId, force, dataOverrides }) {
    const template = await store.getTemplate(templateId);
    if (!template || template.locationId !== locationId) throw Object.assign(new Error("template not found"), { http: 404 });
    const contact = await getContact(client, contactId);
    const context = await buildContactContext(client, locationId, contact);
    if (dataOverrides && typeof dataOverrides === "object") {
      context.data = { ...(context.data || {}), ...dataOverrides };
    }
    const connections = resolveConnectionsFor ? await resolveConnectionsFor(template, locationId) : {};

    const out = await cardgenGenerate({ template, context, connections, force });
    const providerFailures = (out.providerResults || []).filter((p) => !p.ok);
    await store.logRender({
      locationId, templateId, templateVersion: template.version, contactId,
      cacheKey: out.cacheKey, r2Key: out.r2Key, url: out.url,
      status: providerFailures.length ? "fallback" : "ok", cached: out.cached, durationMs: out.durationMs,
      missingBindings: out.missingBindings, providerResults: out.providerResults, resolvedSnapshot: context,
    }).catch(() => {});
    return { url: out.url, cached: out.cached, missingBindings: out.missingBindings || [], providerFailures, context };
  }

  /* ---------- POST /api/render/generate ---------- */
  router.post("/generate", async (req, res) => {
    try {
      needCardgen();
      const { locationId, client } = resolveLocation(req);
      const { templateId, contactId, force = false } = req.body || {};
      if (!templateId || !contactId) return res.status(400).json({ error: "templateId and contactId required" });
      res.json(await generate({ client, locationId, templateId, contactId, force }));
    } catch (err) {
      fail(res, err);
    }
  });

  /* ---------- POST /api/render/test-send ---------- */
  // Renders the template for a (created-if-needed) test contact and sends MMS.
  router.post("/test-send", async (req, res) => {
    try {
      needCardgen();
      const { locationId, client } = resolveLocation(req);
      const { templateId, testPhone, sampleName = "there", message = "", contactId: bodyContactId } = req.body || {};
      if (!templateId) return res.status(400).json({ error: "templateId required" });
      if (!bodyContactId && !testPhone) return res.status(400).json({ error: "contactId or testPhone required" });

      // Prefer an explicit contact (real fields, no duplicate); else find/create by phone.
      const contactId = bodyContactId || (await findOrCreateContactByPhone(client, locationId, testPhone, sampleName));
      const { url, missingBindings, providerFailures } = await generate({ client, locationId, templateId, contactId, force: false });

      const text = message || `Hi ${sampleName}! Here's your card.`;
      const result = await sendSms(client, { contactId, message: text, attachments: [url] });
      res.json({ ok: true, url, contactId, missingBindings, providerFailures, result });
    } catch (err) {
      fail(res, err);
    }
  });

  /* ---------- POST /api/render/webhook ---------- */
  // GHL-workflow wrapper: generate the card, then WRITE the URL into a contact
  // custom field (default card_image_url, auto-created if absent). Responds
  // within ~8s when possible; otherwise 202 and finishes the write async.
  router.post("/webhook", async (req, res) => {
    try {
      needCardgen();
      const b = req.body || {};
      // Accept GHL's native webhook payload as well as our clean format.
      const locId = b.locationId || b.location_id || b.location?.id || b.locationID;
      if (locId) req.body.location_id = locId;
      const { locationId, client } = resolveLocation(req);

      const contactId = b.contactId || b.contact_id || b.contact?.id || b.contactID;
      const fieldKey = b.fieldKey || b.field_key || DEFAULT_FIELD_KEY;

      // Reference the template by id, or by name (case-insensitive) for this location.
      let templateId = b.templateId || b.template_id;
      const templateName = b.templateName || b.template_name || b.template;
      if (!templateId && templateName) {
        const list = await store.listTemplates(locationId);
        const match = list.find((t) => (t.name || "").toLowerCase() === String(templateName).toLowerCase());
        if (match) templateId = match.id;
      }

      if (!contactId) return res.status(400).json({ error: "contactId required (send contact_id or {{contact.id}})" });
      if (!templateId) return res.status(400).json({ error: "templateId or templateName required" });

      const work = (async () => {
        const { url } = await generate({ client, locationId, templateId, contactId, force: false });
        const fieldId = await findOrCreateCustomFieldByKey(client, locationId, fieldKey, "Card Image URL");
        await updateContactCustomField(client, contactId, fieldId, url);
        return url;
      })();

      const timeout = new Promise((r) => setTimeout(() => r("__timeout__"), WEBHOOK_BUDGET_MS));
      const winner = await Promise.race([work.then((url) => ({ url })).catch((e) => ({ err: e.message })), timeout]);

      if (winner === "__timeout__") {
        work.catch((e) => console.error("webhook async writeback failed:", e.message));
        return res.status(202).json({ status: "processing", field: fieldKey });
      }
      if (winner.err) return res.status(502).json({ error: winner.err });
      res.json({ ok: true, url: winner.url, field: fieldKey });
    } catch (err) {
      fail(res, err);
    }
  });

  // Expose the generate core so the webhook (phase 8) reuses it.
  router.generate = generate;
  return router;
}
