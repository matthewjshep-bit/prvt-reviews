// ghl.js — thin LeadConnector (GoHighLevel) v2 API client.
// Base + auth + version confirmed against the current API:
//   base    https://services.leadconnectorhq.com
//   auth    Authorization: Bearer <token>   (Private Integration token works)
//   version Version: 2021-07-28  (v2 default; conversations uses 2021-04-15)

import { CV, serializeConfig, deserializeConfig } from "./config.js";

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

/* ---------- custom values ---------- */

export async function listCustomValues(client, locationId) {
  const data = await client.call(`/locations/${locationId}/customValues`);
  return data.customValues || data.customValue || [];
}

export async function getConfig(client, locationId) {
  const cvs = await listCustomValues(client, locationId);
  const byName = {};
  for (const cv of cvs) byName[cv.name] = cv.value;
  return deserializeConfig(byName);
}

// Upsert ONE custom value by name. Used by the Home page's section-config
// writes (template assignment + message), where updating the whole config
// blob would be wasteful.
export async function setCustomValue(client, locationId, name, value) {
  const cvs = await listCustomValues(client, locationId);
  const match = cvs.find((c) => c.name === name);
  if (match) {
    await client.call(`/locations/${locationId}/customValues/${match.id}`, {
      method: "PUT",
      body: { name, value: String(value ?? "") },
    });
  } else {
    await client.call(`/locations/${locationId}/customValues`, {
      method: "POST",
      body: { name, value: String(value ?? "") },
    });
  }
}

export async function saveConfig(client, locationId, config) {
  const cvs = await listCustomValues(client, locationId);
  const byName = new Map(cvs.map((c) => [c.name, c]));
  const fields = serializeConfig(config);
  // Sequential to stay under the burst rate limit (100 req / 10s).
  for (const [name, value] of Object.entries(fields)) {
    const match = byName.get(name);
    if (match) {
      await client.call(`/locations/${locationId}/customValues/${match.id}`, {
        method: "PUT",
        body: { name, value },
      });
    } else {
      await client.call(`/locations/${locationId}/customValues`, {
        method: "POST",
        body: { name, value },
      });
    }
  }
  return getConfig(client, locationId);
}

/* ---------- custom fields (definitions) ---------- */

// Location custom-field definitions, used by the editor's merge-tag picker.
// Returns [{ id, name, fieldKey, dataType }]. fieldKey looks like
// "contact.property_address" — the studio maps it to contact.custom.<key>.
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

// Find a custom field by its logical key (e.g. "card_image_url"), creating it
// if absent. Returns the field id. Used by the render webhook writeback (§8)
// and the Home page's one-click field setup. dataType: TEXT | NUMERICAL | DATE.
export async function findOrCreateCustomFieldByKey(client, locationId, key, name, dataType = "TEXT") {
  const fields = await listCustomFields(client, locationId);
  const match = fields.find(
    (f) => String(f.fieldKey || "").replace(/^contact\./, "") === key || f.name === (name || key)
  );
  if (match) return match.id;
  const created = await client.call(`/locations/${encodeURIComponent(locationId)}/customFields`, {
    method: "POST",
    body: { name: name || "Card Image URL", dataType, model: "contact" },
  });
  return created?.customField?.id || created?.id;
}

// Map of custom-field id -> logical key ("fieldKey" minus the "contact." prefix),
// e.g. { "abc123": "quote_amount" }. Used to read a contact's fields by key.
export async function customFieldIdKeyMap(client, locationId) {
  const defs = await listCustomFields(client, locationId);
  const map = new Map();
  for (const d of defs) map.set(d.id, String(d.fieldKey || d.key || "").replace(/^contact\./, ""));
  return map;
}

// Flatten a contact's customFields array into a { logicalKey: value } record,
// using the id→key map from customFieldIdKeyMap. Tolerates both GHL shapes
// (customFields / customField, value / fieldValue).
export function contactCustomRecord(contact, idKeyMap) {
  const out = {};
  for (const cf of contact?.customFields || contact?.customField || []) {
    const key = idKeyMap.get(cf.id);
    if (key) out[key] = cf.value ?? cf.fieldValue ?? "";
  }
  return out;
}

// Write a value into a contact's custom field.
export async function updateContactCustomField(client, contactId, fieldId, value) {
  return client.call(`/contacts/${encodeURIComponent(contactId)}`, {
    method: "PUT",
    body: { customFields: [{ id: fieldId, value }] },
  });
}

/* ---------- contacts ---------- */

export async function findOrCreateContactByPhone(client, locationId, phone, firstName) {
  // Try to find an existing contact by phone (avoids duplicates on repeat tests).
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
    body: { locationId, phone, firstName: firstName || "Test" },
  });
  return created?.contact?.id || created?.id;
}

export async function searchContacts(client, locationId, query) {
  // Use the standard GHL v2 contact search endpoint
  const data = await client.call(`/contacts/?locationId=${encodeURIComponent(locationId)}&query=${encodeURIComponent(query)}&limit=20`);
  return data.contacts || [];
}

// Tags for the audience picker — the UNION of the location's tag library (all
// tags, even ones not yet applied to a contact) and tags actually in use on
// contacts. This way a newly-created tag shows up whether or not it's on anyone.
export async function listTags(client, locationId) {
  const byName = new Map(); // lowercased -> { name }
  const add = (raw) => {
    const name = String(raw?.name ?? raw ?? "").trim();
    if (name) byName.set(name.toLowerCase(), { name });
  };

  // 1. Location tag library (authoritative list of all tags).
  try {
    const data = await client.call(`/locations/${encodeURIComponent(locationId)}/tags`);
    for (const t of data.tags || []) add(t);
  } catch {
    /* endpoint may need a scope the token lacks — the contact scan covers it */
  }

  // 2. Tags in use on contacts (covers a missing scope or brand-new merges).
  //    Skip the deep scan if the library already returned tags.
  const maxPages = byName.size > 0 ? 3 : 10;
  let startAfter, startAfterId;
  try {
    for (let i = 0; i < maxPages; i++) {
      let path = `/contacts/?locationId=${encodeURIComponent(locationId)}&limit=100`;
      if (startAfter && startAfterId) {
        path += `&startAfter=${encodeURIComponent(startAfter)}&startAfterId=${encodeURIComponent(startAfterId)}`;
      }
      const data = await client.call(path);
      const batch = data.contacts || [];
      for (const c of batch) for (const t of c.tags || []) add(t);
      if (batch.length < 100) break;
      const meta = data.meta || {};
      startAfter = meta.startAfter;
      startAfterId = meta.startAfterId;
      if (!startAfterId) break;
    }
  } catch {
    /* ignore — return whatever we have */
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// All contacts carrying a given tag. Prefers the v2 advanced-search endpoint
// (paginated); if that ERRORS (schema drift), falls back to paging the plain
// contacts list and filtering by tag client-side. An empty advanced-search
// result is trusted as-is — falling through on "zero matches" caused a full
// contact-list scan per request (rate-limit storms when a tag has no members).
export async function searchContactsByTag(client, locationId, tag, { max = 500 } = {}) {
  const wanted = String(tag).trim().toLowerCase();

  // Preferred: advanced search with a tags filter, paged.
  try {
    const out = [];
    for (let page = 1; out.length < max && page <= 20; page++) {
      const data = await client.call(`/contacts/search`, {
        method: "POST",
        body: {
          locationId,
          page,
          pageLimit: 100,
          filters: [{ field: "tags", operator: "contains", value: tag }],
        },
      });
      const batch = data.contacts || [];
      out.push(...batch);
      const total = data.total ?? out.length;
      if (batch.length === 0 || out.length >= total) break;
    }
    return { contacts: out.slice(0, max), total: out.length };
  } catch {
    /* fall through to the list-scan fallback */
  }

  // Fallback: page the contacts list and filter by tag ourselves.
  const out = [];
  let startAfter;
  let startAfterId;
  for (let i = 0; i < 30 && out.length < max; i++) {
    let path = `/contacts/?locationId=${encodeURIComponent(locationId)}&limit=100`;
    if (startAfter && startAfterId) {
      path += `&startAfter=${encodeURIComponent(startAfter)}&startAfterId=${encodeURIComponent(startAfterId)}`;
    }
    const data = await client.call(path);
    const batch = data.contacts || [];
    for (const c of batch) {
      const tags = (c.tags || []).map((t) => String(t).toLowerCase());
      if (tags.includes(wanted)) out.push(c);
    }
    if (batch.length < 100) break;
    const meta = data.meta || {};
    startAfter = meta.startAfter;
    startAfterId = meta.startAfterId;
    if (!startAfterId) break;
  }
  return { contacts: out.slice(0, max), total: out.length };
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

export async function getConversationByContact(client, contactId, locationId) {
  const data = await client.call(`/conversations/search?contactId=${encodeURIComponent(contactId)}&locationId=${encodeURIComponent(locationId)}`, {
    version: V_CONVERSATIONS,
  });
  // Returns an array of conversations; typically one per contact
  const convos = data.conversations || [];
  return convos.length > 0 ? convos[0] : null;
}

export async function getMessages(client, conversationId) {
  const data = await client.call(`/conversations/${encodeURIComponent(conversationId)}/messages`, {
    version: V_CONVERSATIONS,
  });
  if (data.messages && Array.isArray(data.messages.messages)) {
    return data.messages.messages;
  }
  return Array.isArray(data.messages) ? data.messages : [];
}

/* ---------- opportunities & pipelines ---------- */

export async function listPipelines(client, locationId) {
  const data = await client.call(`/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`);
  return data.pipelines || [];
}

export async function searchOpportunities(client, { locationId, pipelineId, pipelineStageId, limit = 20, page = 1 }) {
  // GHL search uses location_id and pipeline_id (snake_case)
  let url = `/opportunities/search?location_id=${encodeURIComponent(locationId)}&pipeline_id=${encodeURIComponent(pipelineId)}`;
  if (pipelineStageId) url += `&pipeline_stage_id=${encodeURIComponent(pipelineStageId)}`;
  url += `&limit=${limit}`;
  if (page) url += `&page=${page}`;
  
  const data = await client.call(url);
  return data;
}

export async function getOpportunity(client, opportunityId) {
  const data = await client.call(`/opportunities/${encodeURIComponent(opportunityId)}`);
  return data.opportunity || data;
}

export async function updateOpportunity(client, opportunityId, payload) {
  const data = await client.call(`/opportunities/${encodeURIComponent(opportunityId)}`, {
    method: "PUT",
    body: payload,
  });
  return data.opportunity || data;
}

export async function createOpportunity(client, payload) {
  const data = await client.call(`/opportunities/`, {
    method: "POST",
    body: payload,
  });
  return data.opportunity || data;
}

/* ---------- contacts (detail) ---------- */

export async function getContact(client, contactId) {
  const data = await client.call(`/contacts/${encodeURIComponent(contactId)}`);
  return data.contact || data;
}

// Update a contact's standard fields (dnd, firstName, …) and/or customFields.
// Same PUT the custom-field writeback uses, generalized.
export async function updateContact(client, contactId, body) {
  const data = await client.call(`/contacts/${encodeURIComponent(contactId)}`, {
    method: "PUT",
    body,
  });
  return data.contact || data;
}

/* ---------- contact notes ---------- */

export async function getContactNotes(client, contactId) {
  const data = await client.call(`/contacts/${encodeURIComponent(contactId)}/notes`);
  return data.notes || [];
}

export async function createContactNote(client, contactId, body) {
  const data = await client.call(`/contacts/${encodeURIComponent(contactId)}/notes`, {
    method: "POST",
    body,
  });
  return data.note || data;
}

/* ---------- contact tasks ---------- */

export async function getContactTasks(client, contactId) {
  const data = await client.call(`/contacts/${encodeURIComponent(contactId)}/tasks`);
  return data.tasks || [];
}

export async function createContactTask(client, contactId, body) {
  const data = await client.call(`/contacts/${encodeURIComponent(contactId)}/tasks`, {
    method: "POST",
    body,
  });
  return data.task || data;
}

export async function updateContactTask(client, contactId, taskId, body) {
  const data = await client.call(`/contacts/${encodeURIComponent(contactId)}/tasks/${encodeURIComponent(taskId)}`, {
    method: "PUT",
    body,
  });
  return data.task || data;
}

/* ---------- contact tags ---------- */

export async function addContactTags(client, contactId, tags) {
  const data = await client.call(`/contacts/${encodeURIComponent(contactId)}/tags`, {
    method: "POST",
    body: { tags },
  });
  return data.tags || data;
}

export async function removeContactTag(client, contactId, tags) {
  const data = await client.call(`/contacts/${encodeURIComponent(contactId)}/tags`, {
    method: "DELETE",
    body: { tags },
  });
  return data;
}

/* ---------- contact opportunities ---------- */

export async function getContactOpportunities(client, contactId) {
  // GHL doesn't have a direct "opps by contact" endpoint, so we search by contact
  const data = await client.call(`/contacts/${encodeURIComponent(contactId)}`);
  const contact = data.contact || data;
  // Contact object has an `opportunities` array with opportunity IDs
  return contact.opportunities || [];
}

/* ---------- dashboard ---------- */

export async function getDashboard(client, locationId) {
  // 1. Fetch custom values for businessName and reviewLink
  let businessName = "Your Business";
  let reviewLink = "";
  try {
    const config = await getConfig(client, locationId);
    businessName = config.businessName || "Your Business";
    reviewLink = config.reviewLink || "";
  } catch (err) {
    console.error("Failed to fetch config for dashboard:", err.message);
  }
  
  // Initialize default shape
  const dashboard = {
    businessName,
    rating: 0,
    reviewCount: 0,
    last30: { newReviews: 0, updatedReviews: 0, linkClicks: 0, requestsSent: 0, contactsAdded: 0 },
    history: [],
    reviewLink,
    mapsUrl: reviewLink, // Fallback if no specific maps URL
  };

  // 2. Fetch reviews (GHL Reputation reviews are not exposed via the public API
  //    for Private Integration tokens — only e-commerce product reviews are.
  //    A future enhancement could use the Google Places API directly.)
  try {
    let reviews = [];
    
    // Try products/reviews endpoint (e-commerce reviews only)
    try {
      const prodRes = await client.call(
        `/products/reviews?altId=${encodeURIComponent(locationId)}&altType=location&status=approved`
      );
      if (prodRes?.reviews?.length) {
        reviews = prodRes.reviews;
      }
    } catch {
      // Expected to fail or return 0 — not an error
    }

    if (reviews.length > 0) {
      dashboard.reviewCount = reviews.length;
      let totalStars = 0;
      
      const now = new Date();
      const thirtyDaysAgo = new Date(now.setDate(now.getDate() - 30));
      const countsByDate = {};

      for (const r of reviews) {
        totalStars += r.starRating || 0;
        const rDate = new Date(r.createdAt || r.updatedAt || r.date);
        if (rDate >= thirtyDaysAgo) {
          dashboard.last30.newReviews += 1;
        }
        const dateStr = rDate.toISOString().split("T")[0];
        countsByDate[dateStr] = (countsByDate[dateStr] || 0) + 1;
      }
      
      dashboard.rating = totalStars / dashboard.reviewCount;
      dashboard.history = Object.entries(countsByDate)
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date));
    }
  } catch (err) {
    console.error("Failed to fetch reviews (might need scopes):", err.message);
    dashboard._debugError = err.message;
  }

  // 3. (Optional) Fetch contacts added in last 30 days
  try {
    // A simplified approximation: fetch recent contacts
    const contactsData = await client.call(`/contacts/?locationId=${encodeURIComponent(locationId)}&limit=100`);
    const contacts = contactsData.contacts || [];
    const thirtyDaysAgo = new Date(new Date().setDate(new Date().getDate() - 30));
    
    dashboard.last30.contactsAdded = contacts.filter(c => new Date(c.dateAdded || c.createdAt) >= thirtyDaysAgo).length;
  } catch (err) {
    console.error("Failed to fetch contacts for stats:", err.message);
    dashboard._debugContactsError = err.message;
  }

  return dashboard;
}

export { CV };
