const API_BASE = "https://prvt-reviews-1.onrender.com";

// Extract locationId from URL query string
const params = new URLSearchParams(window.location.search);
const locationId = params.get("locationId") || params.get("location_id");

export async function fetchBoard() {
  if (!locationId) throw new Error("No locationId provided");
  const res = await fetch(`${API_BASE}/api/pipeline/board?locationId=${encodeURIComponent(locationId)}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to fetch board");
  }
  return res.json();
}

export async function updateOpportunity(oppId, payload) {
  if (!locationId) throw new Error("No locationId provided");
  const res = await fetch(`${API_BASE}/api/pipeline/opportunity/${encodeURIComponent(oppId)}?locationId=${encodeURIComponent(locationId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to update opportunity");
  }
  return res.json();
}
