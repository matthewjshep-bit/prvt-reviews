// home/api.js — broker calls for the consolidated Home page. Every request is
// location-scoped; the iframe never talks to GHL directly. Mirrors the pattern
// in studio/api.js (shared error helper, location_id from the query string).

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

const post = (path, body) =>
  fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ location_id: getLocationId(), ...body }),
  }).then(j);

/* ---------- config + queues ---------- */
export const getHomeConfig = () => fetch(`${API_BASE}/api/home/config?location_id=${loc()}`).then(j);
export const getSection = (section) => fetch(`${API_BASE}/api/home/${section}?location_id=${loc()}`).then(j);

/* ---------- preview + send ---------- */
export const previewRow = (section, contactId) => post(`/api/home/preview`, { section, contactId });
export const sendOne = (section, contactId, { dryRun = false, mode = "tag" } = {}) =>
  post(`/api/home/send`, { section, contactId, dryRun, mode });
export const sendBatch = (section, { contactIds = null, dryRun = false, mode = "tag" } = {}) =>
  post(`/api/home/send-batch`, { section, contactIds, dryRun, mode });

export { API_BASE };
