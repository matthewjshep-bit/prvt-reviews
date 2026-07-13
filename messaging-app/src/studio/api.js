// api.js — broker calls for the Card Studio. All GHL/render traffic goes through
// the broker; the iframe never holds a token or a provider secret.

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
      msg = [b.error, Array.isArray(b.detail) ? b.detail.join("; ") : b.detail].filter(Boolean).join(" — ") || msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json();
}

/* ---------- templates ---------- */
export const listTemplates = () => fetch(`${API_BASE}/api/templates?location_id=${loc()}`).then(j).then((r) => r.templates);
export const getTemplate = (id) => fetch(`${API_BASE}/api/templates/${id}?location_id=${loc()}`).then(j).then((r) => r.template);
export const createTemplate = (doc) =>
  fetch(`${API_BASE}/api/templates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...doc, location_id: getLocationId() }),
  }).then(j).then((r) => r.template);
export const updateTemplate = (id, doc) =>
  fetch(`${API_BASE}/api/templates/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...doc, location_id: getLocationId() }),
  }).then(j).then((r) => r.template);
export const deleteTemplate = (id) =>
  fetch(`${API_BASE}/api/templates/${id}?location_id=${loc()}`, { method: "DELETE" }).then(j);

/* ---------- render preview → object URL ---------- */
export async function renderPreview(template, sampleData) {
  const res = await fetch(`${API_BASE}/api/render/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ location_id: getLocationId(), template, sampleData }),
  });
  if (!res.ok) throw new Error("preview failed");
  const missing = JSON.parse(res.headers.get("x-missing-bindings") || "[]");
  const blob = await res.blob();
  return { url: URL.createObjectURL(blob), missing };
}

/* ---------- custom fields / providers / connections ---------- */
export const getCustomFields = () =>
  fetch(`${API_BASE}/api/locations/${loc()}/custom-fields`).then(j).then((r) => r.customFields).catch(() => []);
export const createCustomField = ({ name, dataType = "TEXT" }) =>
  fetch(`${API_BASE}/api/custom-fields`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ location_id: getLocationId(), name, dataType }),
  }).then(j);
export const getProviders = () => fetch(`${API_BASE}/api/providers`).then(j).then((r) => r.providers).catch(() => []);
export const testProvider = (id, body) =>
  fetch(`${API_BASE}/api/providers/${id}/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ location_id: getLocationId(), ...body }),
  }).then(j);
export const listConnections = () =>
  fetch(`${API_BASE}/api/connections?location_id=${loc()}`).then(j).then((r) => r.connections).catch(() => []);
export const createConnection = (body) =>
  fetch(`${API_BASE}/api/connections`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ location_id: getLocationId(), ...body }),
  }).then(j);
export const deleteConnection = (id) =>
  fetch(`${API_BASE}/api/connections/${id}?location_id=${loc()}`, { method: "DELETE" }).then(j);

/* ---------- contacts (sample data "preview with real contact") ---------- */
export const searchContacts = (query) =>
  fetch(`${API_BASE}/api/contacts?location_id=${loc()}&query=${encodeURIComponent(query)}`).then(j).then((r) => r.contacts).catch(() => []);

/* ---------- asset upload ---------- */
export async function uploadAsset(file) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("location_id", getLocationId());
  const res = await fetch(`${API_BASE}/api/assets/upload`, { method: "POST", body: fd });
  return j(res).then((r) => r.url);
}

export { API_BASE };
