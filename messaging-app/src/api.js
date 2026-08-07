// api.js — broker calls for the offer generator. Every request is
// location-scoped; the iframe never talks to GHL directly. The page runs
// inside a GHL Custom Menu Link iframe that supplies ?location_id=.

const API_BASE = import.meta.env.VITE_API_BASE || "https://prvt-reviews-1.onrender.com";

export function getLocationId() {
  try {
    return new URLSearchParams(window.location.search).get("location_id") || "";
  } catch {
    return "";
  }
}

// Optional per-location access key: the GHL menu-link URL may carry ?key=,
// which the broker verifies when one is configured for the location.
export function getLocationKey() {
  try {
    return new URLSearchParams(window.location.search).get("key") || "";
  } catch {
    return "";
  }
}

// Location-scope query fragment: "location_id=...&location_key=...".
const locq = () => {
  const p = new URLSearchParams({ location_id: getLocationId() });
  const key = getLocationKey();
  if (key) p.set("location_key", key);
  return p.toString();
};

async function j(res) {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const b = await res.json();
      const detail = Array.isArray(b.detail)
        ? b.detail.join("; ")
        : b.detail && typeof b.detail === "object"
        ? JSON.stringify(b.detail).slice(0, 200)
        : b.detail;
      msg = [b.error, detail].filter(Boolean).join(" — ") || msg;
    } catch { /* ignore */ }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const post = (path, body, method = "POST") =>
  fetch(`${API_BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      location_id: getLocationId(),
      ...(getLocationKey() ? { location_key: getLocationKey() } : {}),
      ...body,
    }),
  }).then(j);

/* ---------- settings ---------- */
export const getSettings = () =>
  fetch(`${API_BASE}/api/offers/settings?${locq()}`).then(j).then((r) => r.settings);
export const saveSettings = (settings) => post(`/api/offers/settings`, { settings }, "PUT");

/* ---------- contacts ---------- */
export const searchContacts = (query) =>
  fetch(`${API_BASE}/api/offers/contacts?${locq()}&query=${encodeURIComponent(query)}`)
    .then(j)
    .then((r) => r.contacts);
export const getContactDetail = (id) =>
  fetch(`${API_BASE}/api/offers/contacts/${encodeURIComponent(id)}?${locq()}`)
    .then(j)
    .then((r) => r.contact);
export const getContactNotes = (id) =>
  fetch(`${API_BASE}/api/offers/contacts/${encodeURIComponent(id)}/notes?${locq()}`)
    .then(j)
    .then((r) => r.notes);
export const addContactNote = (id, body) =>
  post(`/api/offers/contacts/${encodeURIComponent(id)}/notes`, { body });
export const suggestAddresses = (query) =>
  fetch(`${API_BASE}/api/offers/address-suggest?${locq()}&query=${encodeURIComponent(query)}`)
    .then(j)
    .then((r) => r.suggestions);
export const geocode = (query) =>
  fetch(`${API_BASE}/api/offers/geocode?${locq()}&query=${encodeURIComponent(query)}`)
    .then(j)
    .then((r) => r.result);
export const getComps = (address, { sqft, months, beds, baths } = {}) => {
  const p = new URLSearchParams(locq());
  p.set("address", address);
  if (sqft) p.set("sqft", sqft);
  if (months) p.set("months", months);
  if (beds) p.set("beds", beds);
  if (baths) p.set("baths", baths);
  return fetch(`${API_BASE}/api/offers/comps?${p}`).then(j);
};

// Deep link to a contact record inside GHL (opens in a new tab).
export const ghlContactUrl = (contactId) =>
  `https://app.gohighlevel.com/v2/location/${getLocationId()}/contacts/detail/${contactId}`;

// Zillow deep link from a street address (redirects to the property page).
// Shared impl normalizes to USPS abbreviations — spelled-out slugs dump to a
// metro-area search instead of the property.
export { zillowUrl } from "@shared/us-address.js";

/* ---------- offers ---------- */
export const previewDocument = (inputs, settings, contactName) =>
  post(`/api/offers/preview`, { inputs, settings, contactName });
export const createOffer = ({ contactId, newContact, inputs, settings, scope, draftId, snapshot }) =>
  post(`/api/offers`, { contactId, newContact, inputs, settings, scope, draftId, snapshot });
export const saveDraft = (id, draft) => post(`/api/offers/draft`, { id, draft });
export const scanRehab = (address, { beds, baths, sqft, yearBuilt, images } = {}) =>
  post(`/api/offers/scan-rehab`, { address, beds, baths, sqft, yearBuilt, images });
export const gradeComps = (address, comps) =>
  post(`/api/offers/comps/grade`, { address, comps });
export const listOffers = ({ contactId = "", limit = 50 } = {}) => {
  const p = new URLSearchParams(locq());
  p.set("limit", limit);
  if (contactId) p.set("contact_id", contactId);
  return fetch(`${API_BASE}/api/offers?${p}`).then(j).then((r) => r.offers);
};
export const getOffer = (id) =>
  fetch(`${API_BASE}/api/offers/${encodeURIComponent(id)}?${locq()}`).then(j).then((r) => r.offer);
export const deleteOffer = (id) =>
  fetch(`${API_BASE}/api/offers/${encodeURIComponent(id)}?${locq()}`, { method: "DELETE" }).then(j);
export const generateContract = (id, fields) =>
  post(`/api/offers/${encodeURIComponent(id)}/contract`, { fields });
export const generateAssignment = (id, fields) =>
  post(`/api/offers/${encodeURIComponent(id)}/assignment`, { fields });

/* ---------- dashboard ---------- */
// tz_offset lets the broker bucket daily metrics to the viewer's local day;
// end ("YYYY-MM-DD") makes the window finish on a past day (the date picker).
const tzq = () => `&tz_offset=${new Date().getTimezoneOffset()}`;
const endq = (end) => (end ? `&end=${encodeURIComponent(end)}` : "");
export const getDashboardSummary = (days = 30, end = "") =>
  fetch(`${API_BASE}/api/dashboard/summary?${locq()}&days=${days}${tzq()}${endq(end)}`).then(j);
export const getDashboardTagCounts = (tags) =>
  fetch(`${API_BASE}/api/dashboard/ghl/tags?${locq()}&tags=${encodeURIComponent((tags || []).join(","))}`).then(j);
export const getDashboardMessages = (days = 30, end = "") =>
  fetch(`${API_BASE}/api/dashboard/ghl/messages?${locq()}&days=${days}${tzq()}${endq(end)}`).then(j);
export const getDashboardContacts = (days = 30, end = "") =>
  fetch(`${API_BASE}/api/dashboard/ghl/contacts?${locq()}&days=${days}${tzq()}${endq(end)}`).then(j);
export const sendOffer = (id, { message = "", dryRun = true, channels, docs, emailSubject } = {}) =>
  post(`/api/offers/${encodeURIComponent(id)}/send`, {
    message,
    dryRun,
    ...(channels ? { channels } : {}),
    ...(docs ? { docs } : {}),
    ...(emailSubject ? { emailSubject } : {}),
  });

/* ---------- agent outreach ---------- */
// Agents/listings are scoped to a batch (a saved pull cohort). batchId is
// optional everywhere — the server falls back to the most recent batch.
const batchQ = (batchId) => (batchId ? `&batch_id=${encodeURIComponent(batchId)}` : "");

export const getOutreachBatches = () =>
  fetch(`${API_BASE}/api/outreach/batches?${locq()}`).then(j).then((r) => r.batches);
export const createOutreachBatch = (name) =>
  post(`/api/outreach/batches`, name ? { name } : {}).then((r) => r.batch);
export const renameOutreachBatch = (batchId, name) =>
  post(`/api/outreach/batches/${encodeURIComponent(batchId)}/rename`, { name }).then((r) => r.batch);
export const deleteOutreachBatch = (batchId) =>
  fetch(`${API_BASE}/api/outreach/batches/${encodeURIComponent(batchId)}?${locq()}`, { method: "DELETE" }).then(j);

export const getOutreachAgents = (batchId) =>
  fetch(`${API_BASE}/api/outreach/agents?${locq()}${batchQ(batchId)}`).then(j);
export const getAgentListings = (agentKey, batchId) =>
  fetch(`${API_BASE}/api/outreach/agents/${encodeURIComponent(agentKey)}/listings?${locq()}${batchQ(batchId)}`)
    .then(j)
    .then((r) => r.listings);
export const pullOutreach = (params = {}) => post(`/api/outreach/pull`, params);
export const importOutreachAgents = ({ agentKeys, applyTag = true, dryRun = true, batchId, sessionTag }) =>
  post(`/api/outreach/import`, {
    agentKeys, applyTag, dryRun,
    ...(batchId ? { batchId } : {}),
    ...(sessionTag ? { sessionTag } : {}),
  });
export const setOutreachStatus = (agentKey, status, batchId) =>
  post(`/api/outreach/agents/${encodeURIComponent(agentKey)}/status`, { status, ...(batchId ? { batchId } : {}) });
export const clearOutreach = (batchId) => post(`/api/outreach/clear`, batchId ? { batchId } : {});

export { API_BASE };
