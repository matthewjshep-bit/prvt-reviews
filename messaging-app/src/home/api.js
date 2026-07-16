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

// Jump to the Card Studio view, optionally with a template open. Sets the URL
// and pings HomePage's popstate listener so the view switches in place.
export function gotoStudio(templateId) {
  try {
    const p = new URLSearchParams(window.location.search);
    p.set("view", "studio");
    if (templateId) p.set("template", templateId);
    else p.delete("template");
    window.history.pushState(null, "", `${window.location.pathname}?${p}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  } catch { /* ignore */ }
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

/* ---------- journeys (mapped card+text lifecycles) ---------- */
export const listJourneys = () => fetch(`${API_BASE}/api/journeys?location_id=${loc()}`).then(j).then((r) => r.journeys);
export const getJourney = (id) => fetch(`${API_BASE}/api/journeys/${id}?location_id=${loc()}`).then(j);
export const createJourney = (doc) => post(`/api/journeys`, doc).then((r) => r.journey);
export const updateJourney = (id, doc) =>
  fetch(`${API_BASE}/api/journeys/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ location_id: getLocationId(), ...doc }),
  }).then(j).then((r) => r.journey);
export const deleteJourney = (id) =>
  fetch(`${API_BASE}/api/journeys/${id}?location_id=${loc()}`, { method: "DELETE" }).then(j);
export const enrollInJourney = (id, { contactIds, tag } = {}) => post(`/api/journeys/${id}/enroll`, { contactIds, tag });
export const removeFromJourney = (id, contactId) =>
  fetch(`${API_BASE}/api/journeys/${id}/enrollments/${encodeURIComponent(contactId)}?location_id=${loc()}`, { method: "DELETE" }).then(j);
export const sendJourneyStep = (id, stepIndex, { dryRun = true } = {}) =>
  post(`/api/journeys/${id}/steps/${stepIndex}/send`, { dryRun });

/* ---------- one-click GHL custom-field setup ---------- */
export const setupFields = () => post(`/api/home/setup-fields`, {});

/* ---------- contacts (app-specific list + detail + manage) ---------- */
export const listContacts = ({ query = "", filter = "", startAfter = "", startAfterId = "" } = {}) => {
  const p = new URLSearchParams({ location_id: getLocationId() });
  if (query) p.set("query", query);
  if (filter) p.set("filter", filter);
  if (startAfter && startAfterId) { p.set("startAfter", startAfter); p.set("startAfterId", startAfterId); }
  return fetch(`${API_BASE}/api/home/contacts?${p}`).then(j);
};
export const getContactDetail = (id) =>
  fetch(`${API_BASE}/api/home/contacts/${encodeURIComponent(id)}?location_id=${loc()}`).then(j);
export const patchContact = (id, body) =>
  fetch(`${API_BASE}/api/home/contacts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ location_id: getLocationId(), ...body }),
  }).then(j);

/* ---------- section settings (card + message association) ---------- */
export const saveSectionConfig = (section, { templateId, message } = {}) =>
  post(`/api/home/section-config`, { section, templateId, message });
export const createFromPreset = (section) => post(`/api/home/create-from-preset`, { section });

/* ---------- preview + send ---------- */
export const previewRow = (section, contactId) => post(`/api/home/preview`, { section, contactId });
export const sendOne = (section, contactId, { dryRun = false, mode, force = false } = {}) =>
  post(`/api/home/send`, { section, contactId, dryRun, ...(mode ? { mode } : {}), ...(force ? { force: true } : {}) });
export const sendBatch = (section, { contactIds = null, dryRun = false, mode = "tag" } = {}) =>
  post(`/api/home/send-batch`, { section, contactIds, dryRun, mode });

export { API_BASE };
