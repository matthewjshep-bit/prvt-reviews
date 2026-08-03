// ghl.js — thin LeadConnector (GoHighLevel) v2 API client, trimmed to what the
// offer generator uses: contact lookup/create, custom fields, notes, tags, and
// SMS/MMS send.
//   base    https://services.leadconnectorhq.com
//   auth    Authorization: Bearer <token>   (Private Integration token works)
//   version Version: 2021-07-28  (v2 default; conversations uses 2021-04-15)

const BASE = "https://services.leadconnectorhq.com";
const V2 = "2021-07-28";
const V_CONVERSATIONS = "2021-04-15";

export function makeClient(token) {
  async function call(path, { method = "GET", body, version = V2 } = {}) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Version: version,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(`GHL ${method} ${path} -> ${res.status} ${text}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }
  return { call };
}

/* ---------- custom fields (definitions) ---------- */

// Location custom-field definitions. Returns [{ id, name, fieldKey, dataType }].
// fieldKey looks like "contact.last_offer_amount".
export async function listCustomFields(client, locationId) {
  const data = await client.call(`/locations/${encodeURIComponent(locationId)}/customFields`);
  const fields = data.customFields || data.customField || [];
  return fields.map((f) => ({
    id: f.id,
    name: f.name,
    fieldKey: f.fieldKey || f.key || "",
    dataType: f.dataType || f.type || "TEXT",
  }));
}

// Raw custom-field definitions (all provider fields incl. folder/position
// metadata) — used by the field-admin endpoints.
export async function listCustomFieldsRaw(client, locationId) {
  const data = await client.call(`/locations/${encodeURIComponent(locationId)}/customFields`);
  return data.customFields || data.customField || [];
}

// Permanently delete a custom field definition AND its values on all records.
export async function deleteCustomField(client, locationId, fieldId) {
  return client.call(
    `/locations/${encodeURIComponent(locationId)}/customFields/${encodeURIComponent(fieldId)}`,
    { method: "DELETE" }
  );
}

// Find a custom field by its logical key (e.g. "last_offer_doc_url"), creating
// it if absent. Returns the field id. dataType: TEXT | NUMERICAL | DATE.
export async function findOrCreateCustomFieldByKey(client, locationId, key, name, dataType = "TEXT") {
  const fields = await listCustomFields(client, locationId);
  const match = fields.find(
    (f) => String(f.fieldKey || "").replace(/^contact\./, "") === key || f.name === (name || key)
  );
  if (match) return match.id;
  const created = await client.call(`/locations/${encodeURIComponent(locationId)}/customFields`, {
    method: "POST",
    body: { name: name || key, dataType, model: "contact" },
  });
  return created?.customField?.id || created?.id;
}

// Map of custom-field id -> logical key ("fieldKey" minus the "contact." prefix),
// e.g. { "abc123": "property_address" }. Used to read a contact's fields by key.
export async function customFieldIdKeyMap(client, locationId) {
  const defs = await listCustomFields(client, locationId);
  const map = new Map();
  for (const d of defs) map.set(d.id, String(d.fieldKey || d.key || "").replace(/^contact\./, ""));
  return map;
}

// Flatten a contact's customFields array into a { logicalKey: value } record.
// Tolerates both GHL shapes (customFields / customField, value / fieldValue).
export function contactCustomRecord(contact, idKeyMap) {
  const out = {};
  for (const cf of contact?.customFields || contact?.customField || []) {
    const key = idKeyMap.get(cf.id);
    if (key) out[key] = cf.value ?? cf.fieldValue ?? "";
  }
  return out;
}

/* ---------- contacts ---------- */

export async function findOrCreateContactByPhone(client, locationId, phone, firstName) {
  // Try to find an existing contact by phone (avoids duplicates).
  try {
    const found = await client.call(
      `/contacts/search/duplicate?locationId=${encodeURIComponent(locationId)}&number=${encodeURIComponent(phone)}`
    );
    const id = found?.contact?.id;
    if (id) return id;
  } catch {
    // fall through to create
  }
  const created = await client.call(`/contacts/`, {
    method: "POST",
    body: { locationId, phone, firstName: firstName || "Seller" },
  });
  return created?.contact?.id || created?.id;
}

// Look up an existing contact by email and/or phone via the duplicate-search
// endpoint, one identifier at a time so the match source is unambiguous.
// Returns { id, matchedBy: "email" | "phone" } or null. A failed lookup on one
// identifier falls through to the next (matches findOrCreateContactByPhone's
// tolerance) — callers treat null as "assume new".
export async function findDuplicateContact(client, locationId, { email, phone }) {
  const loc = encodeURIComponent(locationId);
  if (email) {
    try {
      const found = await client.call(`/contacts/search/duplicate?locationId=${loc}&email=${encodeURIComponent(email)}`);
      if (found?.contact?.id) return { id: found.contact.id, matchedBy: "email" };
    } catch { /* fall through */ }
  }
  if (phone) {
    try {
      const found = await client.call(`/contacts/search/duplicate?locationId=${loc}&number=${encodeURIComponent(phone)}`);
      if (found?.contact?.id) return { id: found.contact.id, matchedBy: "phone" };
    } catch { /* fall through */ }
  }
  return null;
}

// Plain contact create — dedupe is the caller's responsibility (agent outreach
// checks findDuplicateContact first, so the phone-only find-or-create above
// doesn't fit). body: { firstName, lastName, phone, email, source, ... }.
export async function createContact(client, locationId, body) {
  const created = await client.call(`/contacts/`, { method: "POST", body: { locationId, ...body } });
  return created?.contact?.id || created?.id;
}

export async function searchContacts(client, locationId, query) {
  const data = await client.call(
    `/contacts/?locationId=${encodeURIComponent(locationId)}&query=${encodeURIComponent(query)}&limit=20`
  );
  return data.contacts || [];
}

export async function getContact(client, contactId) {
  const data = await client.call(`/contacts/${encodeURIComponent(contactId)}`);
  return data.contact || data;
}

// Update a contact's standard fields and/or customFields ([{ id, value }]).
export async function updateContact(client, contactId, body) {
  const data = await client.call(`/contacts/${encodeURIComponent(contactId)}`, {
    method: "PUT",
    body,
  });
  return data.contact || data;
}

/* ---------- contact notes ---------- */

export async function createContactNote(client, contactId, body) {
  const data = await client.call(`/contacts/${encodeURIComponent(contactId)}/notes`, {
    method: "POST",
    body,
  });
  return data.note || data;
}

export async function getContactNotes(client, contactId) {
  const data = await client.call(`/contacts/${encodeURIComponent(contactId)}/notes`);
  // Defensive on shape: documented as { notes: [...] }, but accept a bare array.
  return Array.isArray(data?.notes) ? data.notes : Array.isArray(data) ? data : [];
}

/* ---------- contact tags ---------- */

export async function addContactTags(client, contactId, tags) {
  const data = await client.call(`/contacts/${encodeURIComponent(contactId)}/tags`, {
    method: "POST",
    body: { tags },
  });
  return data.tags || data;
}

/* ---------- messaging ---------- */

export async function sendSms(client, { contactId, message, attachments }) {
  return client.call(`/conversations/messages`, {
    method: "POST",
    version: V_CONVERSATIONS,
    body: {
      type: "SMS",
      contactId,
      message,
      ...(attachments && attachments.length ? { attachments } : {}),
    },
  });
}

export async function sendEmail(client, { contactId, subject, html, attachments }) {
  return client.call(`/conversations/messages`, {
    method: "POST",
    version: V_CONVERSATIONS,
    body: {
      type: "Email",
      contactId,
      subject,
      html,
      ...(attachments && attachments.length ? { attachments } : {}),
    },
  });
}
