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
const loc = () => encodeURIComponent(getLocationId());

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
    body: JSON.stringify({ location_id: getLocationId(), ...body }),
  }).then(j);

/* ---------- settings ---------- */
export const getSettings = () =>
  fetch(`${API_BASE}/api/offers/settings?location_id=${loc()}`).then(j).then((r) => r.settings);
export const saveSettings = (settings) => post(`/api/offers/settings`, { settings }, "PUT");

/* ---------- contacts ---------- */
export const searchContacts = (query) =>
  fetch(`${API_BASE}/api/offers/contacts?location_id=${loc()}&query=${encodeURIComponent(query)}`)
    .then(j)
    .then((r) => r.contacts);

/* ---------- offers ---------- */
export const previewDocument = (inputs, settings, contactName) =>
  post(`/api/offers/preview`, { inputs, settings, contactName });
export const createOffer = ({ contactId, newContact, inputs, settings }) =>
  post(`/api/offers`, { contactId, newContact, inputs, settings });
export const listOffers = ({ contactId = "", limit = 50 } = {}) => {
  const p = new URLSearchParams({ location_id: getLocationId(), limit });
  if (contactId) p.set("contact_id", contactId);
  return fetch(`${API_BASE}/api/offers?${p}`).then(j).then((r) => r.offers);
};
export const deleteOffer = (id) =>
  fetch(`${API_BASE}/api/offers/${encodeURIComponent(id)}?location_id=${loc()}`, { method: "DELETE" }).then(j);
export const sendOffer = (id, { message = "", dryRun = true } = {}) =>
  post(`/api/offers/${encodeURIComponent(id)}/send`, { message, dryRun });

export { API_BASE };
