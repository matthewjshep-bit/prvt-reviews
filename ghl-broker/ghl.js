// ghl.js — thin LeadConnector (GoHighLevel) v2 API client, trimmed to what the
// offer generator uses: contact lookup/create, custom fields, notes, tags, and
// SMS/MMS send.
//   base    https://services.leadconnectorhq.com
//   auth    Authorization: Bearer <token>   (Private Integration token works)
//   version Version: 2021-07-28  (v2 default; conversations uses 2021-04-15)

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

/* ---------- custom fields (definitions) ---------- */

// Location custom-field definitions. Returns [{ id, name, fieldKey, dataType }].
// fieldKey looks like "contact.last_offer_amount".
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

// Raw custom-field definitions (all provider fields incl. folder/position
// metadata) — used by the field-admin endpoints.
export async function listCustomFieldsRaw(client, locationId) {
  const data = await client.call(`/locations/${encodeURIComponent(locationId)}/customFields`);
  return data.customFields || data.customField || [];
}

// Permanently delete a custom field definition AND its values on all records.
export async function deleteCustomField(client, locationId, fieldId) {
  return client.call(
    `/locations/${encodeURIComponent(locationId)}/customFields/${encodeURIComponent(fieldId)}`,
    { method: "DELETE" }
  );
}

// Find a custom field by its logical key (e.g. "last_offer_doc_url"), creating
// it if absent. Returns the field id. dataType: TEXT | NUMERICAL | DATE.
export async function findOrCreateCustomFieldByKey(client, locationId, key, name, dataType = "TEXT") {
  const fields = await listCustomFields(client, locationId);
  const match = fields.find(
    (f) => String(f.fieldKey || "").replace(/^contact\./, "") === key || f.name === (name || key)
  );
  if (match) return match.id;
  const created = await client.call(`/locations/${encodeURIComponent(locationId)}/customFields`, {
    method: "POST",
    body: { name: name || key, dataType, model: "contact" },
  });
  return created?.customField?.id || created?.id;
}

// Map of custom-field id -> logical key ("fieldKey" minus the "contact." prefix),
// e.g. { "abc123": "property_address" }. Used to read a contact's fields by key.
export async function customFieldIdKeyMap(client, locationId) {
  const defs = await listCustomFields(client, locationId);
  const map = new Map();
  for (const d of defs) map.set(d.id, String(d.fieldKey || d.key || "").replace(/^contact\./, ""));
  return map;
}

// Same map, but keyed by OUR canonical field keys wherever we recognize the
// field, falling back to GHL's own key for everything else.
//
// This exists because GHL derives `fieldKey` from the field's display NAME at
// creation time, not from anything we send: a field we created as
// `buybox_areas` with name "Buy Box: Areas" comes back as `buy_box_areas`, and
// "Buy Box: Must-Haves / Exclusions" as `buy_box_musthaves__exclusions`. Writes
// never noticed because findOrCreateCustomFieldByKey also matches on name and
// then writes by id — but anything READING by our key silently saw nothing.
//
// Matching mirrors findOrCreateCustomFieldByKey exactly (fieldKey OR name), so
// a field found for writing is the same field found for reading.
export async function customFieldIdKeyMapForDefs(client, locationId, defs) {
  const fields = await listCustomFields(client, locationId);
  const map = new Map();
  for (const f of fields) {
    const ghlKey = String(f.fieldKey || f.key || "").replace(/^contact\./, "");
    const def = (defs || []).find((d) => d.key === ghlKey || d.name === f.name);
    map.set(f.id, def ? def.key : ghlKey);
  }
  return map;
}

// Flatten a contact's customFields array into a { logicalKey: value } record.
// Tolerates both GHL shapes (customFields / customField, value / fieldValue).
export function contactCustomRecord(contact, idKeyMap) {
  const out = {};
  for (const cf of contact?.customFields || contact?.customField || []) {
    const key = idKeyMap.get(cf.id);
    if (key) out[key] = cf.value ?? cf.fieldValue ?? "";
  }
  return out;
}

/* ---------- contacts ---------- */

export async function findOrCreateContactByPhone(client, locationId, phone, firstName) {
  // Try to find an existing contact by phone (avoids duplicates).
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
    body: { locationId, phone, firstName: firstName || "Seller" },
  });
  return created?.contact?.id || created?.id;
}

// Look up an existing contact by email and/or phone via the duplicate-search
// endpoint, one identifier at a time so the match source is unambiguous.
// Returns { id, matchedBy: "email" | "phone" } or null. A failed lookup on one
// identifier falls through to the next (matches findOrCreateContactByPhone's
// tolerance) — callers treat null as "assume new".
export async function findDuplicateContact(client, locationId, { email, phone }) {
  const loc = encodeURIComponent(locationId);
  if (email) {
    try {
      const found = await client.call(`/contacts/search/duplicate?locationId=${loc}&email=${encodeURIComponent(email)}`);
      if (found?.contact?.id) return { id: found.contact.id, matchedBy: "email" };
    } catch { /* fall through */ }
  }
  if (phone) {
    // GHL stores phones as E.164; a bare 10-digit US number silently fails to
    // match, so normalize before querying.
    const digits = String(phone).replace(/\D/g, "");
    const e164 = digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith("1") ? `+${digits}` : phone;
    try {
      const found = await client.call(`/contacts/search/duplicate?locationId=${loc}&number=${encodeURIComponent(e164)}`);
      if (found?.contact?.id) return { id: found.contact.id, matchedBy: "phone" };
    } catch { /* fall through */ }
  }
  return null;
}

// Plain contact create — dedupe is the caller's responsibility (agent outreach
// checks findDuplicateContact first, so the phone-only find-or-create above
// doesn't fit). body: { firstName, lastName, phone, email, source, ... }.
export async function createContact(client, locationId, body) {
  const created = await client.call(`/contacts/`, { method: "POST", body: { locationId, ...body } });
  return created?.contact?.id || created?.id;
}

export async function searchContacts(client, locationId, query) {
  const data = await client.call(
    `/contacts/?locationId=${encodeURIComponent(locationId)}&query=${encodeURIComponent(query)}&limit=20`
  );
  return data.contacts || [];
}

export async function getContact(client, contactId) {
  const data = await client.call(`/contacts/${encodeURIComponent(contactId)}`);
  return data.contact || data;
}

// Update a contact's standard fields and/or customFields ([{ id, value }]).
export async function updateContact(client, contactId, body) {
  const data = await client.call(`/contacts/${encodeURIComponent(contactId)}`, {
    method: "PUT",
    body,
  });
  return data.contact || data;
}

/* ---------- contact notes ---------- */

export async function createContactNote(client, contactId, body) {
  const data = await client.call(`/contacts/${encodeURIComponent(contactId)}/notes`, {
    method: "POST",
    body,
  });
  return data.note || data;
}

export async function getContactNotes(client, contactId) {
  const data = await client.call(`/contacts/${encodeURIComponent(contactId)}/notes`);
  // Defensive on shape: documented as { notes: [...] }, but accept a bare array.
  return Array.isArray(data?.notes) ? data.notes : Array.isArray(data) ? data : [];
}

/* ---------- contact tags ---------- */

export async function addContactTags(client, contactId, tags) {
  const data = await client.call(`/contacts/${encodeURIComponent(contactId)}/tags`, {
    method: "POST",
    body: { tags },
  });
  return data.tags || data;
}

export async function removeContactTags(client, contactId, tags) {
  const data = await client.call(`/contacts/${encodeURIComponent(contactId)}/tags`, {
    method: "DELETE",
    body: { tags },
  });
  return data.tags || data;
}

// One page of contacts carrying a tag. Returns raw contact objects (id,
// firstName/lastName, phone, email, tags, ...).
export async function searchContactsByTag(client, locationId, tag, { pageLimit = 50 } = {}) {
  const data = await client.call(`/contacts/search`, {
    method: "POST",
    body: {
      locationId,
      pageLimit,
      filters: [{ field: "tags", operator: "contains", value: [tag] }],
    },
  });
  return data.contacts || [];
}

// Every tag defined on the location, lowercased. Needed because GHL's contact
// search matches tags EXACTLY — filtering on "disposition" returns nothing
// even when "disposition-seatac" exists — so a prefix has to be expanded to
// concrete tag names on our side before the search can use it.
export async function listLocationTags(client, locationId) {
  const data = await client.call(`/locations/${encodeURIComponent(locationId)}/tags`);
  return (data.tags || data.data || [])
    .map((t) => String(t?.name ?? t ?? "").trim().toLowerCase())
    .filter(Boolean);
}

// EVERY contact carrying ANY of `tags`, paged to exhaustion. The one-page
// searchContactsByTag above is fine for "give me a sample of investors" but
// silently truncates at its page size, which is wrong for the dispositions
// sync — a buyer list that stops at 50 hides real buyers with no error.
//
// A `contains` filter with an array value is OR'd by GHL, so this is one query
// per page rather than one per tag, and dedupe is only needed because the same
// contact can carry several of the tags. `truncated` is true when maxPages ran
// out with more results waiting — the caller must NOT prune on a truncated
// sync or it deletes the tail of the book.
export async function searchAllContactsByTags(client, locationId, tags, { pageLimit = 100, maxPages = 100 } = {}) {
  const value = [...new Set((tags || []).map((t) => String(t).trim()).filter(Boolean))];
  if (!value.length) return { contacts: [], total: 0, truncated: false };

  const byId = new Map();
  let searchAfter = null;
  let total = 0;
  let truncated = false;

  for (let page = 0; page < maxPages; page++) {
    const data = await client.call(`/contacts/search`, {
      method: "POST",
      body: {
        locationId,
        pageLimit,
        filters: [{ field: "tags", operator: "contains", value }],
        // A stable sort is what makes searchAfter a cursor rather than a
        // suggestion; without it pages can repeat and drop rows.
        sort: [{ field: "dateAdded", direction: "desc" }],
        ...(searchAfter ? { searchAfter } : {}),
      },
    });
    const contacts = data.contacts || [];
    total = Number(data.total) || total;
    for (const c of contacts) if (c?.id) byId.set(c.id, c);
    searchAfter = contacts.length ? contacts[contacts.length - 1].searchAfter || null : null;
    if (contacts.length < pageLimit || !searchAfter) break;
    if (page === maxPages - 1) truncated = true;
  }

  return { contacts: [...byId.values()], total, truncated };
}

// Last message per contact across the whole location, as a Map of
// contactId -> { at, direction, type }. `direction` is the thing worth having:
// "inbound" means they answered us, "outbound" means we spoke last.
//
// Location-wide rather than per-contact on purpose. getLastMessageDate is one
// request per contact, which is fine for a few dozen agents and absurd for a
// book of a few thousand investors; conversations sorted by last_message_date
// cover everyone in one paginated walk (~20 requests for 2k conversations).
//
// Needs the conversations.readonly scope — callers should treat 401/403 as
// "no reply data" and carry on, not as a failure.
export async function scanConversationsByContact(client, locationId, { maxPages = 250, limit = 100 } = {}) {
  const byContact = new Map();
  const seen = new Set();
  let cursor;
  let truncated = false;
  let total = 0;

  for (let page = 0; page < maxPages; page++) {
    const res = await searchConversations(client, locationId, { limit, startAfterDate: cursor });
    const { conversations } = res;
    if (!total) total = res.total;
    if (!conversations.length) break;

    let oldest = null;
    let fresh = 0;
    for (const c of conversations) {
      if (!c.id || seen.has(c.id)) continue;
      seen.add(c.id);
      fresh++;
      const ms = Number(c.lastMessageDate) || new Date(c.lastMessageDate).getTime();
      if (!Number.isFinite(ms) || ms <= 0) continue;
      if (oldest === null || ms < oldest) oldest = ms;
      const cid = c.contactId;
      if (!cid) continue;
      // Sorted newest-first, so the first sighting of a contact is their most
      // recent conversation — later pages only carry older ones.
      if (!byContact.has(cid)) {
        byContact.set(cid, {
          at: new Date(ms).toISOString(),
          direction: c.lastMessageDirection || null,
          type: c.lastMessageType || null,
          conversationIds: [],
        });
      }
      // Keep the ids so a caller can look inside the conversation. Capped:
      // "has this person ever answered" is settled by their few most recent
      // threads, and an unbounded list would make the message scan unbounded.
      const entry = byContact.get(cid);
      if (entry.conversationIds.length < 3) entry.conversationIds.push(c.id);
    }

    // Every conversation on this page was already seen, or none carried a
    // usable date — either way the cursor can't advance, so stop rather than
    // spin on the same page.
    if (!fresh || oldest === null) break;
    cursor = oldest;
    if (page === maxPages - 1) truncated = true;
  }

  return { byContact, truncated, scanned: seen.size, total };
}

// Given the map from scanConversationsByContact, find each contact's most
// recent INBOUND message — i.e. the last time they actually answered us.
//
// This needs message-level detail because a conversation only exposes its LAST
// message. After a bulk send that is our own outbound blast for everybody, so
// conversation-level direction answers "who spoke last", which is a different
// and much less useful question than "has this person ever engaged".
//
// One request per conversation, so it is the expensive half of a sync — hence
// the concurrency pool, the 3-conversation cap per contact upstream, and
// `maxPagesPerConvo`: the most recent page settles it for all but the longest
// threads, and a thread that is 100+ messages of pure outbound is not a reply
// we are missing.
export async function lastInboundByContact(client, byContact, { concurrency = 8, maxPagesPerConvo = 2 } = {}) {
  const jobs = [];
  for (const [contactId, info] of byContact) {
    for (const conversationId of info.conversationIds || []) jobs.push({ contactId, conversationId });
  }

  const lastInbound = new Map();
  let failures = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < jobs.length) {
      const { contactId, conversationId } = jobs[cursor++];
      try {
        let lastMessageId;
        for (let page = 0; page < maxPagesPerConvo; page++) {
          const { messages, lastMessageId: next, nextPage } =
            await listConversationMessages(client, conversationId, { lastMessageId, limit: 100 });
          for (const m of messages) {
            if (String(m.direction || "").toLowerCase() !== "inbound") continue;
            const ms = Number(m.dateAdded) || new Date(m.dateAdded).getTime();
            if (!Number.isFinite(ms) || ms <= 0) continue;
            const iso = new Date(ms).toISOString();
            const prev = lastInbound.get(contactId);
            if (!prev || iso > prev) lastInbound.set(contactId, iso);
          }
          // Found one on the newest page: any older inbound is by definition
          // not their LAST reply, so there is nothing left to look for.
          if (lastInbound.has(contactId) || !nextPage || !next) break;
          lastMessageId = next;
        }
      } catch {
        failures++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

  return { lastInbound, scanned: jobs.length, failures };
}

// Count of contacts carrying a tag, via the filtered contact search. Cheapest
// possible query: one result page of 1, read the total. Throws on GHL errors
// (err.status set) — callers should treat 401/403 as "scope not granted".
export async function countContactsByTag(client, locationId, tag) {
  const data = await client.call(`/contacts/search`, {
    method: "POST",
    body: {
      locationId,
      pageLimit: 1,
      filters: [{ field: "tags", operator: "contains", value: [tag] }],
    },
  });
  return Number(data.total) || 0;
}

/* ---------- conversations (dashboard message/call volume) ---------- */

// One page of contacts created in [sinceIso, untilIso), newest first, with
// cursor pagination (pass the previous page's searchAfter to continue).
// Returns { contacts: [{ dateAdded, ... }], total, searchAfter } — total is
// the exact match count even when paging stops early.
export async function searchContactsCreatedSince(client, locationId, { sinceIso, untilIso, pageLimit = 100, searchAfter } = {}) {
  const data = await client.call(`/contacts/search`, {
    method: "POST",
    body: {
      locationId,
      pageLimit,
      filters: [{
        field: "dateAdded",
        operator: "range",
        value: { gte: sinceIso, ...(untilIso ? { lt: untilIso } : {}) },
      }],
      sort: [{ field: "dateAdded", direction: "desc" }],
      ...(searchAfter ? { searchAfter } : {}),
    },
  });
  const contacts = data.contacts || [];
  return {
    contacts,
    total: Number(data.total) || 0,
    searchAfter: contacts.length ? contacts[contacts.length - 1].searchAfter || null : null,
  };
}

// One page of the location's conversations, newest activity first. Pass
// startAfterDate (epoch ms of the previous page's oldest lastMessageDate) to
// page older; pass contactId to scope to one contact's conversations.
// Returns { conversations: [{ id, lastMessageDate, ... }], total }.
// Needs the conversations.readonly scope (401/403 when missing).
export async function searchConversations(client, locationId, { limit = 100, startAfterDate, contactId } = {}) {
  const p = new URLSearchParams({
    locationId,
    limit: String(limit),
    sortBy: "last_message_date",
    sort: "desc",
  });
  if (startAfterDate) p.set("startAfterDate", String(startAfterDate));
  if (contactId) p.set("contactId", contactId);
  const data = await client.call(`/conversations/search?${p}`, { version: V_CONVERSATIONS });
  return { conversations: data.conversations || [], total: Number(data.total) || 0 };
}

// One page of a conversation's messages, newest first. Returns { messages:
// [{ type, direction, dateAdded, ... }], lastMessageId, nextPage }. Tolerates
// both response shapes (data.messages.messages vs data.messages).
export async function listConversationMessages(client, conversationId, { lastMessageId, limit = 100 } = {}) {
  const p = new URLSearchParams({ limit: String(limit) });
  if (lastMessageId) p.set("lastMessageId", lastMessageId);
  const data = await client.call(
    `/conversations/${encodeURIComponent(conversationId)}/messages?${p}`,
    { version: V_CONVERSATIONS }
  );
  const box = data.messages && !Array.isArray(data.messages) ? data.messages : data;
  const messages = Array.isArray(box.messages) ? box.messages : Array.isArray(data.messages) ? data.messages : [];
  return {
    messages,
    lastMessageId: box.lastMessageId || null,
    nextPage: Boolean(box.nextPage),
  };
}

// Sentence-level transcription of a recorded call message. Returns an array
// of { mediaChannel, sentenceIndex, startTime, endTime, transcript,
// confidence } (order not guaranteed — sort by sentenceIndex). Throws on GHL
// errors: 404 = the call has no transcription (recording/transcription not
// enabled, or still processing); 401/403 = the conversations/message.readonly
// scope is missing.
export async function getMessageTranscription(client, locationId, messageId) {
  const data = await client.call(
    `/conversations/locations/${encodeURIComponent(locationId)}/messages/${encodeURIComponent(messageId)}/transcription`,
    { version: V_CONVERSATIONS }
  );
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.transcriptions)) return data.transcriptions;
  if (Array.isArray(data?.transcription)) return data.transcription;
  return [];
}

// Most recent message activity for a contact (any channel). Returns
// { at: ISO, direction, type } or null. Needs the conversations.readonly
// scope — callers should treat 401/403 as "scope not granted".
export async function getLastMessageDate(client, locationId, contactId) {
  const data = await client.call(
    `/conversations/search?locationId=${encodeURIComponent(locationId)}&contactId=${encodeURIComponent(contactId)}&limit=1`,
    { version: V_CONVERSATIONS }
  );
  const c = (data.conversations || [])[0];
  if (!c || !c.lastMessageDate) return null;
  const ts = Number(c.lastMessageDate);
  const at = Number.isFinite(ts) && ts > 0 ? new Date(ts) : new Date(c.lastMessageDate);
  if (Number.isNaN(at.getTime())) return null;
  return { at: at.toISOString(), direction: c.lastMessageDirection || null, type: c.lastMessageType || null };
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

export async function sendEmail(client, { contactId, subject, html, attachments }) {
  return client.call(`/conversations/messages`, {
    method: "POST",
    version: V_CONVERSATIONS,
    body: {
      type: "Email",
      contactId,
      subject,
      html,
      ...(attachments && attachments.length ? { attachments } : {}),
    },
  });
}
