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
      const err = new Error(`GHL ${method} ${path} -> ${res.status}`);
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

  // 2. Fetch reviews
  try {
    const reviewsData = await client.call(`/reviews?locationId=${encodeURIComponent(locationId)}`);
    const reviews = reviewsData.reviews || [];
    
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

      // Convert history to array and sort
      dashboard.history = Object.entries(countsByDate)
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date));
    }
  } catch (err) {
    console.error("Failed to fetch reviews (might need scopes):", err.message);
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
  }

  return dashboard;
}

export { CV };
