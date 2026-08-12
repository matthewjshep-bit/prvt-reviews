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
export const enrichContact = (id, { type } = {}) =>
  post(`/api/offers/contacts/${encodeURIComponent(id)}/enrich`, { ...(type ? { type } : {}) });
export const applyEnrichment = (id, payload) =>
  post(`/api/offers/contacts/${encodeURIComponent(id)}/enrich/apply`, payload);
export const startEnrichSweep = ({ since, windowLabel, types, maxContacts, repliesOnly }) =>
  post(`/api/offers/enrich/sweep`, { since, windowLabel, types, maxContacts, repliesOnly }).then((r) => r.job);
export const getEnrichSweep = () =>
  fetch(`${API_BASE}/api/offers/enrich/sweep?${locq()}`).then(j).then((r) => r.job);
export const cancelEnrichSweep = () => post(`/api/offers/enrich/sweep/cancel`, {});

/* ---------- CRM fields manager ---------- */
export const listCustomFields = () =>
  fetch(`${API_BASE}/api/offers/custom-fields?${locq()}`).then(j).then((r) => r.fields);
export const getFieldRegistry = () =>
  fetch(`${API_BASE}/api/offers/field-registry?${locq()}`).then(j).then((r) => r.registry);
export const createCustomField = ({ key, name, dataType }) =>
  post(`/api/offers/custom-fields`, { key, name, dataType });
export const pruneCustomFields = (ids) =>
  post(`/api/offers/custom-fields/prune`, { ids });
export const getContactRecord = (id) =>
  fetch(`${API_BASE}/api/offers/contacts/${encodeURIComponent(id)}/record?${locq()}`).then(j).then((r) => r.record);
export const saveContactRecord = (id, payload) =>
  post(`/api/offers/contacts/${encodeURIComponent(id)}/record`, payload, "PUT");
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
// Property photos hang off the offer, so they outlive any one dataroom. Upload
// is one photo per call: a whole batch in a single JSON body would be several
// MB of base64 for the broker to parse in one blocking go.
export const listOfferPhotos = (offerId) =>
  fetch(`${API_BASE}/api/offers/${encodeURIComponent(offerId)}/photos?${locq()}`).then(j).then((r) => r.photos);
export const uploadOfferPhoto = (offerId, { full, thumb, width, height }) =>
  post(`/api/offers/${encodeURIComponent(offerId)}/photos`, { full, thumb, width, height }).then((r) => r.photo);
export const reorderOfferPhotos = (offerId, ids) =>
  post(`/api/offers/${encodeURIComponent(offerId)}/photos/reorder`, { ids }).then((r) => r.photos);
// The console's own <img src>. The investor-facing photo URL needs a link
// token, which the operator doesn't have — this one rides the location gate.
export const offerPhotoUrl = (offerId, photoId, variant = "thumb") =>
  `${API_BASE}/api/offers/${encodeURIComponent(offerId)}/photos/${encodeURIComponent(photoId)}/${variant}?${locq()}`;
export const deleteOfferPhoto = (offerId, photoId) =>
  fetch(`${API_BASE}/api/offers/${encodeURIComponent(offerId)}/photos/${encodeURIComponent(photoId)}?${locq()}`,
    { method: "DELETE" }).then(j).then((r) => r.photos);

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
export const generateNetSheet = (id, fields) =>
  post(`/api/offers/${encodeURIComponent(id)}/netsheet`, { fields });

/* ---------- active deals ---------- */
export const listDeals = () =>
  fetch(`${API_BASE}/api/offers/deals?${locq()}`).then(j).then((r) => r.deals);
export const promoteDeal = (id, fields = {}) =>
  post(`/api/offers/${encodeURIComponent(id)}/deal`, fields);
export const updateDeal = (id, patch) =>
  post(`/api/offers/${encodeURIComponent(id)}/deal`, patch, "PATCH");
export const removeDeal = (id) =>
  fetch(`${API_BASE}/api/offers/${encodeURIComponent(id)}/deal?${locq()}`, { method: "DELETE" }).then(j);
export const addDealInvestor = (id, { contactId, name }) =>
  post(`/api/offers/${encodeURIComponent(id)}/deal/investors`, { contactId, name });
export const updateDealInvestor = (id, contactId, status) =>
  post(`/api/offers/${encodeURIComponent(id)}/deal/investors/${encodeURIComponent(contactId)}`, { status }, "PATCH");
export const removeDealInvestor = (id, contactId) =>
  fetch(`${API_BASE}/api/offers/${encodeURIComponent(id)}/deal/investors/${encodeURIComponent(contactId)}?${locq()}`, { method: "DELETE" }).then(j);
export const suggestInvestors = (id) =>
  post(`/api/offers/${encodeURIComponent(id)}/deal/suggest-investors`, {});

/* ---------- investor datarooms ---------- */
// A dataroom is a frozen, investor-facing package built from one offer.
//
// getDataroom returns `shareLink` — one link per deal, meant to be blasted to a
// buyer list and re-copied any time. Personal per-investor links are optional
// extra: those come back ONLY from createDataroomInvite/reissueDataroomInvite
// and are never retrievable afterwards, so the UI must send or copy them
// right away.
// One link for every listed deal at once — the page buyers land on, with each
// deal linking through to its own package. Resolved live, so adding a deal
// updates it without resending anything.
export const getDataroomPortfolio = () =>
  fetch(`${API_BASE}/api/datarooms/portfolio?${locq()}`).then(j);
export const listDatarooms = (offerId = "") => {
  const p = new URLSearchParams(locq());
  if (offerId) p.set("offer_id", offerId);
  return fetch(`${API_BASE}/api/datarooms?${p}`).then(j).then((r) => r.datarooms);
};
export const getDataroom = (id) =>
  fetch(`${API_BASE}/api/datarooms/${encodeURIComponent(id)}?${locq()}`).then(j);
export const createDataroom = ({ offerId, sections, headline, notes, expiryDays }) =>
  post(`/api/datarooms`, { offerId, sections, headline, notes, expiryDays }).then((r) => r.dataroom);
export const updateDataroom = (id, patch) =>
  post(`/api/datarooms/${encodeURIComponent(id)}`, patch, "PUT").then((r) => r.dataroom);
export const rotateDataroomShareLink = (id) =>
  post(`/api/datarooms/${encodeURIComponent(id)}/share/rotate`, {}).then((r) => r.shareLink);
export const revokeDataroom = (id, revoked = true) =>
  post(`/api/datarooms/${encodeURIComponent(id)}/revoke`, { revoked }).then((r) => r.dataroom);
export const deleteDataroom = (id) =>
  fetch(`${API_BASE}/api/datarooms/${encodeURIComponent(id)}?${locq()}`, { method: "DELETE" }).then(j);
export const createDataroomInvite = (id, { contactId, name, phone, expiryDays, send, dryRun, message }) =>
  post(`/api/datarooms/${encodeURIComponent(id)}/invites`, {
    contactId, name, phone, expiryDays, send, dryRun, message,
  });
// `token` is the link handed back at creation — the server keeps only its hash,
// so the caller must pass it back to send it again.
export const sendDataroomInvite = (id, inviteId, { token, message, dryRun }) =>
  post(`/api/datarooms/${encodeURIComponent(id)}/invites/${encodeURIComponent(inviteId)}/send`, {
    token, message, dryRun,
  });
export const revokeDataroomInvite = (id, inviteId, revoked = true) =>
  post(`/api/datarooms/${encodeURIComponent(id)}/invites/${encodeURIComponent(inviteId)}/revoke`, { revoked });
export const reissueDataroomInvite = (id, inviteId, opts = {}) =>
  post(`/api/datarooms/${encodeURIComponent(id)}/invites/${encodeURIComponent(inviteId)}/reissue`, opts);

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
