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

export async function createOpportunity(payload) {
  if (!locationId) throw new Error("No locationId provided");
  const res = await fetch(`${API_BASE}/api/pipeline/opportunity?locationId=${encodeURIComponent(locationId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to create opportunity");
  }
  return res.json();
}

export async function searchContacts(query) {
  if (!locationId) throw new Error("No locationId provided");
  const res = await fetch(`${API_BASE}/api/pipeline/contacts/search?locationId=${encodeURIComponent(locationId)}&query=${encodeURIComponent(query)}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to search contacts");
  }
  return res.json();
}

export async function getLinkedContacts(opportunityId) {
  if (!locationId) throw new Error("No locationId provided");
  const res = await fetch(`${API_BASE}/api/pipeline/opportunity/${encodeURIComponent(opportunityId)}/contacts?locationId=${encodeURIComponent(locationId)}`);
  if (!res.ok) return [];
  return res.json();
}

export async function addLinkedContact(opportunityId, contact, opportunityName) {
  if (!locationId) throw new Error("No locationId provided");
  const res = await fetch(`${API_BASE}/api/pipeline/opportunity/${encodeURIComponent(opportunityId)}/contacts?locationId=${encodeURIComponent(locationId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contact, opportunityName }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to link contact");
  }
  return res.json();
}

export async function removeLinkedContact(opportunityId, contactId) {
  if (!locationId) throw new Error("No locationId provided");
  const res = await fetch(`${API_BASE}/api/pipeline/opportunity/${encodeURIComponent(opportunityId)}/contacts/${encodeURIComponent(contactId)}?locationId=${encodeURIComponent(locationId)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to unlink contact");
  }
  return res.json();
}

// ========== CONTACT NOTES ==========

export async function fetchContactNotes(contactId) {
  if (!locationId) throw new Error("No locationId provided");
  const res = await fetch(`${API_BASE}/api/pipeline/contact/${encodeURIComponent(contactId)}/notes?locationId=${encodeURIComponent(locationId)}`);
  if (!res.ok) return [];
  return res.json();
}

export async function createNote(contactId, body) {
  if (!locationId) throw new Error("No locationId provided");
  const res = await fetch(`${API_BASE}/api/pipeline/contact/${encodeURIComponent(contactId)}/notes?locationId=${encodeURIComponent(locationId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to create note");
  }
  return res.json();
}

// ========== CONTACT TASKS ==========

export async function fetchContactTasks(contactId) {
  if (!locationId) throw new Error("No locationId provided");
  const res = await fetch(`${API_BASE}/api/pipeline/contact/${encodeURIComponent(contactId)}/tasks?locationId=${encodeURIComponent(locationId)}`);
  if (!res.ok) return [];
  return res.json();
}

export async function createTask(contactId, body) {
  if (!locationId) throw new Error("No locationId provided");
  const res = await fetch(`${API_BASE}/api/pipeline/contact/${encodeURIComponent(contactId)}/tasks?locationId=${encodeURIComponent(locationId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to create task");
  }
  return res.json();
}

export async function toggleTask(contactId, taskId, body) {
  if (!locationId) throw new Error("No locationId provided");
  const res = await fetch(`${API_BASE}/api/pipeline/contact/${encodeURIComponent(contactId)}/tasks/${encodeURIComponent(taskId)}?locationId=${encodeURIComponent(locationId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to update task");
  }
  return res.json();
}

// ========== CONTACT TAGS ==========

export async function fetchContactTags(contactId) {
  if (!locationId) throw new Error("No locationId provided");
  const res = await fetch(`${API_BASE}/api/pipeline/contact/${encodeURIComponent(contactId)}/tags?locationId=${encodeURIComponent(locationId)}`);
  if (!res.ok) return [];
  return res.json();
}

export async function addTag(contactId, tags) {
  if (!locationId) throw new Error("No locationId provided");
  const res = await fetch(`${API_BASE}/api/pipeline/contact/${encodeURIComponent(contactId)}/tags?locationId=${encodeURIComponent(locationId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tags }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to add tag");
  }
  return res.json();
}

export async function deleteTag(contactId, tags) {
  if (!locationId) throw new Error("No locationId provided");
  const res = await fetch(`${API_BASE}/api/pipeline/contact/${encodeURIComponent(contactId)}/tags?locationId=${encodeURIComponent(locationId)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tags }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to remove tag");
  }
  return res.json();
}

// ========== CONTACT OPPORTUNITIES ==========

export async function fetchContactOpportunities(contactId) {
  if (!locationId) throw new Error("No locationId provided");
  const res = await fetch(`${API_BASE}/api/pipeline/contact/${encodeURIComponent(contactId)}/opportunities?locationId=${encodeURIComponent(locationId)}`);
  if (!res.ok) return [];
  return res.json();
}

// ========== CONTACT MESSAGES ==========

export async function fetchContactMessages(contactId) {
  if (!locationId) throw new Error("No locationId provided");
  const res = await fetch(`${API_BASE}/api/pipeline/contact/${encodeURIComponent(contactId)}/messages?locationId=${encodeURIComponent(locationId)}`);
  if (!res.ok) return [];
  return res.json();
}
