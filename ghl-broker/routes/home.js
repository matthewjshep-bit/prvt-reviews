// routes/home.js — the consolidated Home page backend. Four contact-driven
// queues (quotes / reviews / winback / offers), a per-contact card preview, and
// send actions that fire GHL workflows by applying a trigger tag.
//
//   GET  /api/home/config                 → resolved config + config-error report
//   GET  /api/home/:section               → the queue (rows + badges + warnings)
//   POST /api/home/preview  {section,contactId}        → { url, message, ... }
//   POST /api/home/send     {section,contactId,dryRun,mode}
//   POST /api/home/send-batch {section,contactIds?,dryRun,mode}
//
// Hard rules (see the brief): all state is tags + custom fields (no pipelines);
// compliance is server-side (DND excluded, 24h per-queue dedupe, hard cap);
// a missing required field/tag is a reported config error, never a crash.

import express from "express";
import { store } from "../store.js";
import {
  listCustomValues, searchContactsByTag, searchContacts, getContact, updateContact, listTags,
  customFieldIdKeyMap, contactCustomRecord, setCustomValue,
  addContactTags, removeContactTag, findOrCreateCustomFieldByKey, updateContactCustomField, sendSms,
  getConversationByContact, getMessages,
} from "../ghl.js";
import { resolveBindings } from "../shared/bindings.js";
import { TemplateInputSchema } from "../shared/template-schema.js";
import * as starters from "../shared/starters.js";
import {
  SECTIONS, SECTION_KEYS, FIELD_KEYS, TAGS, CV_OVERRIDES, SECTION_STARTERS,
  effectiveSection, effectiveTiers, resolveTier,
} from "../home-config.js";

const CARD_SENDS_ENABLED = process.env.CARD_SENDS_ENABLED === "true";
const CAMPAIGN_CAP = parseInt(process.env.CAMPAIGN_CAP || "200", 10);
const DEDUPE_MS = 24 * 60 * 60 * 1000; // no repeat within 24h per queue per contact
const CARD_FIELD_KEY = process.env.CARD_FIELD_KEY || "card_image_url";
const SEND_THROTTLE_MS = 150; // ~6-7/sec, under GHL's 100/10s burst limit

/* ------------------------------------------------------------------ *
 * small helpers
 * ------------------------------------------------------------------ */
const idOf = (c) => c?.id || c?.contact?.id;
const isDnd = (c) => Boolean(c?.dnd ?? c?.contact?.dnd);
const firstNameOf = (c) => c?.firstName || c?.contact?.firstName || "";
const lowerTags = (c) => (c?.tags || []).map((t) => String(t).toLowerCase());
const hasTag = (c, tag) => lowerTags(c).includes(String(tag).toLowerCase());

const num = (v) => {
  const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const parseDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
};
const daysBetween = (a, b) => Math.round((a.getTime() - b.getTime()) / 86400000);
const monthsSince = (d) => {
  if (!d) return null;
  const now = new Date();
  return (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
};
// $1.2M / $640k / $2,850
function money(v) {
  const n = num(v);
  if (!n) return "$0";
  if (n >= 1e6) return `$${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1)}M`;
  if (n >= 1e4) return `$${Math.round(n / 1e3)}k`;
  return `$${n.toLocaleString("en-US")}`;
}
const shortDate = (d) => (d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");

// Per-location caches (60s) for custom values, custom-field key map, templates.
const cache = new Map();
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < ttl) return hit.val;
  const val = await fn();
  cache.set(key, { ts: Date.now(), val });
  return val;
}
const cvMap = (client, locationId) =>
  cached(`cv:${locationId}`, 60_000, async () => {
    const cvs = await listCustomValues(client, locationId);
    const byName = {};
    for (const cv of cvs) byName[cv.name] = cv.value;
    return byName;
  });
const cfKeyMap = (client, locationId) =>
  cached(`cf:${locationId}`, 60_000, () => customFieldIdKeyMap(client, locationId));
const tagLibrary = (client, locationId) =>
  cached(`tags:${locationId}`, 60_000, async () => {
    try {
      const tags = await listTags(client, locationId);
      return new Set(tags.map((t) => t.name.toLowerCase()));
    } catch {
      return null; // couldn't read the library — don't block queries on it
    }
  });

const templateList = (locationId) =>
  cached(`tpl:${locationId}`, 60_000, () => store.listTemplates(locationId));

// Picker options for the UIs (Home section settings + Card Studio "Used for").
async function templateOptions(locationId) {
  const list = await templateList(locationId);
  return (list || []).map((t) => ({ id: t.id, name: t.name, updatedAt: t.updatedAt }));
}

// Resolve a section's card template. Order:
//   1. explicit assignment (rh_home_<section>_template_id custom value)
//   2. legacy name match against cfg.templateName (back-compat)
//   3. unassigned → null (UI shows the setup CTA)
// Returns { templateId, templateName, templateSource } where templateSource is
// "assigned" | "name" | null.
async function resolveTemplate(locationId, section, cfg, cvByName) {
  const list = (await templateList(locationId)) || [];
  const assignedId = String(cvByName[CV_OVERRIDES.templateId(section)] || "").trim();
  if (assignedId) {
    const hit = list.find((t) => t.id === assignedId);
    // A stale id (template deleted) falls through to the name match.
    if (hit) return { templateId: hit.id, templateName: hit.name, templateSource: "assigned" };
  }
  const want = String(cfg.templateName || "").trim().toLowerCase();
  const byName = list.find((t) => (t.name || "").toLowerCase() === want);
  if (byName) return { templateId: byName.id, templateName: byName.name, templateSource: "name" };
  return { templateId: null, templateName: cfg.templateName, templateSource: null };
}

// Bust the per-location caches after a config write so the next read is fresh.
function bustCaches(locationId) {
  cache.delete(`cv:${locationId}`);
  cache.delete(`tpl:${locationId}`);
}

// Hydrate contacts so each carries a customFields array. Advanced search usually
// includes them; if not, fetch per contact (bounded by cap).
async function hydrate(client, contacts, cap) {
  const out = [];
  for (const c of contacts.slice(0, cap)) {
    if (Array.isArray(c.customFields) || Array.isArray(c.customField)) { out.push(c); continue; }
    try { out.push(await getContact(client, idOf(c))); } catch { out.push(c); }
  }
  return out;
}

// Build the per-row record { logicalKey: value } + note which required keys are missing.
function recordFor(section, contact, idKeyMap) {
  const rec = contactCustomRecord(contact, idKeyMap);
  const warnings = [];
  for (const [key, def] of Object.entries(FIELD_KEYS[section])) {
    if (def.required && !(rec[key] && String(rec[key]).trim())) warnings.push(`missing ${def.label}`);
  }
  return { rec, warnings };
}

/* ------------------------------------------------------------------ *
 * per-section row builders → { row, sort }
 * ------------------------------------------------------------------ */
function buildRow(section, contact, rec, warnings) {
  const base = {
    id: idOf(contact),
    firstName: firstNameOf(contact),
    lastName: contact.lastName || "",
    name: [firstNameOf(contact), contact.lastName].filter(Boolean).join(" ") || contact.phone || "Contact",
    phone: contact.phone || "",
    dnd: isDnd(contact),
    warnings,
  };
  const tags = TAGS[section];

  if (section === "quotes") {
    const amount = num(rec.quote_amount);
    const quoted = parseDate(rec.quote_date);
    const expiry = parseDate(rec.quote_expiry);
    let status;
    if (hasTag(contact, tags.status.replied)) status = { kind: "replied", label: "Replied" };
    else {
      const days = quoted ? daysBetween(new Date(), quoted) : null;
      status = { kind: "no-reply", label: days != null ? `No reply ${days}d` : "Awaiting reply" };
    }
    return {
      row: {
        ...base, amount, amountLabel: money(amount),
        address: rec.property_address || "",
        quotedLabel: quoted ? `quoted ${shortDate(quoted)}` : "",
        expiryLabel: expiry ? `expires ${shortDate(expiry)}` : "",
        subtitle: `${money(amount)}${expiry ? ` · expires ${shortDate(expiry)}` : quoted ? ` · quoted ${shortDate(quoted)}` : ""}`,
        status,
      },
      // Soonest expiry first; unknown expiry sinks to the bottom, then by amount desc.
      sort: [expiry ? expiry.getTime() : Number.MAX_SAFE_INTEGER, -amount],
    };
  }

  if (section === "reviews") {
    const done = parseDate(rec.job_completed_date);
    let status;
    if (hasTag(contact, tags.status.left)) status = { kind: "left", label: "Review left", rating: num(rec.review_rating) || 5 };
    else if (hasTag(contact, tags.status.scheduled)) status = { kind: "scheduled", label: "Reminder scheduled" };
    else status = { kind: "due", label: "Ask due" };
    return {
      row: {
        ...base, jobType: rec.job_type || "",
        completedLabel: done ? finishedLabel(done) : "",
        subtitle: `${rec.job_type || "Job"}${done ? ` · ${finishedLabel(done)}` : ""}`,
        status,
      },
      // Freshest completion first.
      sort: [-(done ? done.getTime() : 0)],
    };
  }

  if (section === "winback") {
    const last = parseDate(rec.last_service_date);
    const months = monthsSince(last);
    const ltv = num(rec.lifetime_value);
    return {
      row: {
        ...base, ltv, ltvLabel: money(ltv),
        lastServiceType: rec.last_service_type || "",
        monthsAgo: months, monthsLabel: months != null ? `${months} mo` : "",
        subtitle: `${rec.last_service_type || "Service"}${months != null ? ` · ${months} months ago` : ""} · ${money(ltv)} LTV`,
        status: months != null ? { kind: "aged", label: `${months} mo` } : null,
      },
      // Highest lifetime value first.
      sort: [-ltv],
    };
  }

  // offers — tier resolved by caller (needs location tiers); placeholder here.
  const deals = num(rec.deal_count);
  const volume = num(rec.deal_volume);
  const late = num(rec.late_payment_count);
  return {
    row: {
      ...base, deals, volume, late,
      volumeLabel: money(volume),
      trackLine: `${deals} deal${deals === 1 ? "" : "s"}${volume ? ` · ${money(volume)} volume` : ""}${rec.late_payment_count != null && rec.late_payment_count !== "" ? ` · ${late} late` : ""}`,
      _record: rec, // used by the caller to assign a tier
    },
    sort: [-deals, -volume],
  };
}

function finishedLabel(done) {
  const d = daysBetween(new Date(), done);
  if (d <= 0) return "finished today";
  if (d === 1) return "finished yesterday";
  return `finished ${shortDate(done)}`;
}

/* ------------------------------------------------------------------ *
 * router
 * ------------------------------------------------------------------ */
export default function createHomeRouter({ resolveLocation, renderRouter }) {
  const router = express.Router();
  const fail = (res, err) => {
    const code = err.http || err.status || 500;
    if (code >= 500) console.error("home error:", code, err.message, err.data || "");
    res.status(code).json({ error: err.message, detail: err.detail || err.data });
  };
  const batchCap = (cvByName) => {
    const o = parseInt(cvByName[CV_OVERRIDES.batchCap] || "", 10);
    return Number.isFinite(o) && o > 0 ? Math.min(o, CAMPAIGN_CAP) : CAMPAIGN_CAP;
  };

  // Resolve a contact's Offers tier data (record → tier → data.tier scope).
  function tierDataFor(rec, tiers) {
    const tier = resolveTier(rec, tiers);
    const proof = `${num(rec.deal_count)} deals · ${money(rec.deal_volume)} · ${num(rec.late_payment_count)} late payments`;
    return {
      tier,
      data: { tier: { id: tier.id, label: tier.label, rate: tier.terms?.rate || "", down: tier.terms?.down || "", proof } },
    };
  }

  // Build outgoing message text for a contact against a render context.
  function renderMessage(section, cfg, context, cvByName) {
    const link = cvByName["rh_review_link"] || "";
    const withLink = String(cfg.message || "").replace(/\[Review Link\]/g, link);
    return resolveBindings(withLink, context).value;
  }

  /* ---------- GET /api/home/config ---------- */
  router.get("/config", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const cvByName = await cvMap(client, locationId);
      const tiers = effectiveTiers(cvByName);

      // Which queue tags actually exist (config-error surfacing).
      let existing = new Set();
      try { existing = new Set((await listTags(client, locationId)).map((t) => t.name.toLowerCase())); } catch { /* non-fatal */ }

      const sections = {};
      const assignments = {};
      for (const key of SECTION_KEYS) {
        const cfg = effectiveSection(key, cvByName);
        const resolved = await resolveTemplate(locationId, key, cfg, cvByName);
        if (resolved.templateId) assignments[key] = resolved.templateId;
        const errors = [];
        if (!existing.size) errors.push("could not read tag library");
        else if (!existing.has(cfg.tags.queue.toLowerCase())) errors.push(`queue tag "${cfg.tags.queue}" not found`);
        if (!resolved.templateId) errors.push(`no card assigned — pick a template or use the preset`);
        sections[key] = {
          view: cfg.view, label: cfg.label, subtitle: cfg.subtitle, batch: cfg.batch,
          templateName: resolved.templateName, templateId: resolved.templateId,
          templateSource: resolved.templateSource, message: cfg.message,
          tags: cfg.tags, fields: cfg.fields, errors,
        };
      }
      res.json({
        ok: true, sections, assignments, templates: await templateOptions(locationId),
        tiers, sendsEnabled: CARD_SENDS_ENABLED, cap: batchCap(cvByName),
        views: SECTION_KEYS,
      });
    } catch (err) { fail(res, err); }
  });

  /* ==================================================================
     Contacts — the app-specific contact list + detail + manage surface.
     Registered BEFORE /:section so "contacts" isn't read as a section.
     ================================================================== */

  // Map a raw GHL contact to a list row (queues derived from queue tags).
  const queueTagBySection = Object.fromEntries(SECTION_KEYS.map((k) => [k, TAGS[k].queue.toLowerCase()]));
  function contactRow(c) {
    const tags = lowerTags(c);
    return {
      id: idOf(c),
      firstName: c.firstName || "",
      name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.contactName || c.phone || "Contact",
      phone: c.phone || "",
      email: c.email || "",
      dnd: isDnd(c),
      addedAt: c.dateAdded || c.createdAt || null,
      queues: SECTION_KEYS.filter((k) => tags.includes(queueTagBySection[k])),
    };
  }

  // Full drawer payload for one contact.
  async function contactDetail(client, locationId, contactId) {
    const contact = await getContact(client, contactId);
    const idKeyMap = await cfKeyMap(client, locationId);
    const rec = contactCustomRecord(contact, idKeyMap);

    // Our fields, grouped per section, with definition presence flagged.
    const definedKeys = new Set([...idKeyMap.values()]);
    const fields = {};
    for (const section of SECTION_KEYS) {
      fields[section] = Object.entries(FIELD_KEYS[section]).map(([key, def]) => ({
        key,
        label: def.label,
        type: def.type,
        required: Boolean(def.required),
        value: rec[key] ?? "",
        defined: definedKeys.has(key), // false = field doesn't exist in GHL yet
      }));
    }

    let sends = [];
    try { sends = await store.homeSendsForContact(locationId, contactId, 20); } catch { /* ignore */ }

    let messages = [];
    try {
      const convo = await getConversationByContact(client, contactId, locationId);
      if (convo?.id) {
        const raw = await getMessages(client, convo.id);
        messages = (raw || []).slice(0, 20).map((m) => ({
          id: m.id,
          body: m.body || "",
          direction: m.direction || (m.type === "outbound" ? "outbound" : "inbound"),
          dateAdded: m.dateAdded || m.dateUpdated || null,
          attachments: m.attachments || [],
        }));
      }
    } catch { /* messages are best-effort */ }

    return {
      ok: true,
      contact: contactRow(contact),
      tags: contact.tags || [],
      fields,
      sends,
      messages,
      sendsEnabled: CARD_SENDS_ENABLED,
    };
  }

  /* ---------- GET /api/home/contacts ---------- */
  // ?query= text search · ?filter= quotes|reviews|winback|offers|dnd ·
  // ?startAfter/&startAfterId= cursor for the plain paged list.
  router.get("/contacts", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const query = String(req.query.query || "").trim();
      const filter = String(req.query.filter || "").trim();

      if (query) {
        const results = await searchContacts(client, locationId, query);
        return res.json({ ok: true, contacts: (results || []).slice(0, 50).map(contactRow), cursor: null, mode: "search" });
      }

      if (SECTIONS[filter]) {
        const { contacts } = await searchContactsByTag(client, locationId, TAGS[filter].queue, { max: 200 });
        return res.json({ ok: true, contacts: contacts.map(contactRow), cursor: null, mode: "filter" });
      }

      // Default: cursor-paged full list (GHL meta.startAfter/startAfterId).
      let path = `/contacts/?locationId=${encodeURIComponent(locationId)}&limit=50`;
      const { startAfter, startAfterId } = req.query;
      if (startAfter && startAfterId) {
        path += `&startAfter=${encodeURIComponent(startAfter)}&startAfterId=${encodeURIComponent(startAfterId)}`;
      }
      const data = await client.call(path);
      const batch = data.contacts || [];
      const meta = data.meta || {};
      const cursor = batch.length === 50 && meta.startAfterId
        ? { startAfter: meta.startAfter, startAfterId: meta.startAfterId }
        : null;
      let rows = batch.map(contactRow);
      if (filter === "dnd") rows = rows.filter((r) => r.dnd);
      res.json({ ok: true, contacts: rows, cursor, total: meta.total });
    } catch (err) { fail(res, err); }
  });

  /* ---------- GET /api/home/contacts/:id ---------- */
  router.get("/contacts/:id", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      res.json(await contactDetail(client, locationId, req.params.id));
    } catch (err) { fail(res, err); }
  });

  /* ---------- PATCH /api/home/contacts/:id ---------- */
  // body: { fields?: {key: value}, queues?: {section: bool}, dnd?: bool }
  // Applies our custom-field edits, queue-tag membership, and DND, then
  // returns the refreshed detail payload.
  router.patch("/contacts/:id", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const contactId = req.params.id;
      const { fields, queues, dnd } = req.body || {};

      if (fields && typeof fields === "object" && Object.keys(fields).length) {
        const idKeyMap = await cfKeyMap(client, locationId);
        const keyToId = new Map([...idKeyMap].map(([id, key]) => [key, id]));
        const customFields = [];
        const missing = [];
        for (const [key, value] of Object.entries(fields)) {
          const fid = keyToId.get(key);
          if (fid) customFields.push({ id: fid, value: String(value ?? "") });
          else missing.push(key);
        }
        if (missing.length) {
          return res.status(422).json({
            error: `no custom-field definition for: ${missing.join(", ")} — create them in GHL (Settings → Custom Fields) first`,
          });
        }
        if (customFields.length) await updateContact(client, contactId, { customFields });
      }

      if (queues && typeof queues === "object") {
        const add = [];
        const remove = [];
        for (const [section, on] of Object.entries(queues)) {
          if (!SECTIONS[section]) return res.status(400).json({ error: `unknown section "${section}"` });
          (on ? add : remove).push(TAGS[section].queue);
        }
        if (add.length) await addContactTags(client, contactId, add);
        if (remove.length) await removeContactTag(client, contactId, remove);
      }

      if (dnd !== undefined) {
        await updateContact(client, contactId, { dnd: Boolean(dnd) });
      }

      res.json(await contactDetail(client, locationId, contactId));
    } catch (err) { fail(res, err); }
  });

  /* ---------- GET /api/home/:section ---------- */
  router.get("/:section", async (req, res) => {
    try {
      const section = req.params.section;
      if (!SECTIONS[section]) return res.status(400).json({ error: `unknown section "${section}"` });
      const { locationId, client } = resolveLocation(req);
      const cvByName = await cvMap(client, locationId);
      const cfg = effectiveSection(section, cvByName);
      const tiers = effectiveTiers(cvByName);
      const cap = batchCap(cvByName);

      const resolved = await resolveTemplate(locationId, section, cfg, cvByName);
      const templates = await templateOptions(locationId);
      const common = {
        ok: true, section, view: cfg.view, label: cfg.label, subtitle: cfg.subtitle,
        batch: cfg.batch, templateId: resolved.templateId, templateName: resolved.templateName,
        templateSource: resolved.templateSource, assignedTemplateId: resolved.templateSource === "assigned" ? resolved.templateId : null,
        templates, message: cfg.message,
        queueTag: cfg.tags.queue, trigger: cfg.tags.trigger,
        sendsEnabled: CARD_SENDS_ENABLED, cap,
      };

      // If the queue tag doesn't exist in the tag library yet, this is a setup
      // problem — say so and skip the contact query entirely.
      const library = await tagLibrary(client, locationId);
      if (library && !library.has(cfg.tags.queue.toLowerCase())) {
        return res.json({
          ...common,
          rows: [], summary: summarize(section, [], cap),
          configError: `queue tag "${cfg.tags.queue}" doesn't exist yet — create it in GHL (Settings → Tags) and add it to contacts`,
        });
      }

      const { contacts } = await searchContactsByTag(client, locationId, cfg.tags.queue, { max: cap });
      const idKeyMap = await cfKeyMap(client, locationId);
      const hydrated = await hydrate(client, contacts, cap);

      const built = hydrated.map((c) => {
        const { rec, warnings } = recordFor(section, c, idKeyMap);
        const b = buildRow(section, c, rec, warnings);
        if (section === "offers") {
          const { tier } = tierDataFor(rec, tiers);
          b.row.tier = { id: tier.id, label: tier.label, terms: tier.terms };
          // Sort offers by tier rank (higher minDeals first), then volume desc.
          const rank = tiers.findIndex((t) => t.id === tier.id);
          b.sort = [rank, -b.row.volume];
        }
        return b;
      });
      built.sort((a, b) => {
        for (let i = 0; i < Math.max(a.sort.length, b.sort.length); i++) {
          const d = (a.sort[i] ?? 0) - (b.sort[i] ?? 0);
          if (d) return d;
        }
        return 0;
      });
      const rows = built.map((b) => b.row);

      // Section-level summary for the header + batch strip.
      const summary = summarize(section, rows, cap);
      res.json({
        ...common,
        ...(section === "offers" ? { tiers } : {}),
        rows, summary,
        configError: !resolved.templateId ? "no card assigned to this section yet" : null,
      });
    } catch (err) { fail(res, err); }
  });

  /* ---------- POST /api/home/preview ---------- */
  router.post("/preview", async (req, res) => {
    try {
      const { section, contactId } = req.body || {};
      if (!SECTIONS[section]) return res.status(400).json({ error: "unknown section" });
      if (!contactId) return res.status(400).json({ error: "contactId required" });
      const { locationId, client } = resolveLocation(req);
      const cvByName = await cvMap(client, locationId);
      const cfg = effectiveSection(section, cvByName);
      const { templateId } = await resolveTemplate(locationId, section, cfg, cvByName);
      if (!templateId) return res.status(422).json({ error: "no card assigned to this section — pick a template or use the preset" });

      const dataOverrides = await offersOverrides(section, client, locationId, contactId, cvByName);
      const gen = await renderRouter.generate({ client, locationId, templateId, contactId, force: false, dataOverrides });
      const message = renderMessage(section, cfg, gen.context, cvByName);
      res.json({ ok: true, url: gen.url, message, missingBindings: gen.missingBindings, cached: gen.cached });
    } catch (err) { fail(res, err); }
  });

  /* ---------- POST /api/home/section-config ---------- */
  // Set a section's card template and/or outgoing message. Writes GHL custom
  // values (rh_home_<section>_template_id / rh_home_<section>_message) so the
  // binding is explicit, per-location, and survives template renames.
  router.post("/section-config", async (req, res) => {
    try {
      const { section, templateId, message } = req.body || {};
      if (!SECTIONS[section]) return res.status(400).json({ error: "unknown section" });
      if (templateId === undefined && message === undefined) {
        return res.status(400).json({ error: "templateId or message required" });
      }
      const { locationId, client } = resolveLocation(req);

      if (templateId !== undefined) {
        if (templateId) {
          // Assign — the template must exist and belong to this location.
          const t = await store.getTemplate(templateId);
          if (!t || t.locationId !== locationId) return res.status(404).json({ error: "template not found" });
          await setCustomValue(client, locationId, CV_OVERRIDES.templateId(section), templateId);
        } else {
          // Unassign (empty string clears the custom value).
          await setCustomValue(client, locationId, CV_OVERRIDES.templateId(section), "");
        }
      }
      if (message !== undefined) {
        await setCustomValue(client, locationId, CV_OVERRIDES.message(section), String(message));
      }

      bustCaches(locationId);
      const cvByName = await cvMap(client, locationId);
      const cfg = effectiveSection(section, cvByName);
      const resolved = await resolveTemplate(locationId, section, cfg, cvByName);
      res.json({ ok: true, section, ...resolved, message: cfg.message });
    } catch (err) { fail(res, err); }
  });

  /* ---------- POST /api/home/create-from-preset ---------- */
  // One-click setup: create the section's preset template (or adopt an existing
  // template already carrying the preset's name) and assign it to the section.
  router.post("/create-from-preset", async (req, res) => {
    try {
      const { section } = req.body || {};
      if (!SECTIONS[section]) return res.status(400).json({ error: "unknown section" });
      const { locationId, client } = resolveLocation(req);

      const build = starters[SECTION_STARTERS[section]];
      if (typeof build !== "function") return res.status(500).json({ error: "no preset available for this section" });
      const doc = build({ locationId });

      // Adopt an existing template with the preset's name instead of duplicating.
      const list = (await templateList(locationId)) || [];
      let template = list.find((t) => (t.name || "").toLowerCase() === String(doc.name).toLowerCase());
      let created = false;
      if (!template) {
        const parsed = TemplateInputSchema.safeParse(doc);
        if (!parsed.success) {
          return res.status(500).json({
            error: "preset failed validation",
            detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
          });
        }
        template = await store.createTemplate(parsed.data);
        created = true;
      }

      await setCustomValue(client, locationId, CV_OVERRIDES.templateId(section), template.id);
      bustCaches(locationId);
      res.json({ ok: true, template: { id: template.id, name: template.name }, created, assigned: true });
    } catch (err) { fail(res, err); }
  });

  /* ---------- POST /api/home/send ---------- */
  router.post("/send", async (req, res) => {
    try {
      const { section, contactId, dryRun = true, mode: reqMode } = req.body || {};
      if (!SECTIONS[section]) return res.status(400).json({ error: "unknown section" });
      if (!contactId) return res.status(400).json({ error: "contactId required" });
      const { locationId, client } = resolveLocation(req);
      const cvByName = await cvMap(client, locationId);
      const cfg = effectiveSection(section, cvByName);
      // "direct" = broker sends the MMS itself; "tag" = fire the GHL workflow.
      // Default direct until the location's workflows exist (rh_home_send_mode).
      const mode = reqMode || cvByName[CV_OVERRIDES.sendMode] || "direct";

      const contact = await getContact(client, contactId);
      if (isDnd(contact)) return res.json({ ok: true, skipped: "dnd", contactId });
      const recent = await store.recentHomeSendIds(locationId, section, DEDUPE_MS);
      if (recent.has(contactId)) return res.json({ ok: true, skipped: "recent", contactId });

      const live = dryRun === false && CARD_SENDS_ENABLED;
      if (!live) {
        // Dry run: prove the card + message without sending.
        const preview = await safePreview(section, client, locationId, contactId, cfg, cvByName);
        return res.json({
          ok: true, dryRun: true, sendsEnabled: CARD_SENDS_ENABLED,
          wouldSendTo: { id: contactId, firstName: firstNameOf(contact) },
          mode, trigger: cfg.tags.trigger, ...preview,
        });
      }

      const result = await deliver({ section, client, locationId, contactId, cfg, cvByName, mode });
      await store.logHomeSend({ locationId, section, contactId, triggerTag: cfg.tags.trigger, cardUrl: result.cardUrl });
      res.json({ ok: true, sent: true, contactId, mode, ...result });
    } catch (err) { fail(res, err); }
  });

  /* ---------- POST /api/home/send-batch ---------- */
  router.post("/send-batch", async (req, res) => {
    try {
      const { section, contactIds = null, dryRun = true, mode: reqMode } = req.body || {};
      if (!SECTIONS[section]) return res.status(400).json({ error: "unknown section" });
      const { locationId, client } = resolveLocation(req);
      const cvByName = await cvMap(client, locationId);
      const cfg = effectiveSection(section, cvByName);
      const mode = reqMode || cvByName[CV_OVERRIDES.sendMode] || "direct";
      const tiers = effectiveTiers(cvByName);
      const cap = batchCap(cvByName);

      // Audience = queue-tag members, optionally intersected with an explicit pick.
      const { contacts } = await searchContactsByTag(client, locationId, cfg.tags.queue, { max: cap });
      const idKeyMap = await cfKeyMap(client, locationId);
      const hydrated = await hydrate(client, contacts, cap);
      let audience = hydrated;
      if (Array.isArray(contactIds) && contactIds.length) {
        const want = new Set(contactIds);
        audience = audience.filter((c) => want.has(idOf(c)));
      }

      const withId = audience.filter((c) => idOf(c));
      const eligible = withId.filter((c) => !isDnd(c));
      const skippedDnd = withId.length - eligible.length;
      const recent = await store.recentHomeSendIds(locationId, section, DEDUPE_MS);
      const fresh = eligible.filter((c) => !recent.has(idOf(c)));
      const skippedRecent = eligible.length - fresh.length;
      const capped = fresh.slice(0, cap);

      // Metrics for the batch strip (LTV total for winback, tier split for offers).
      const totalLtv = section === "winback" ? withId.reduce((s, c) => s + num(contactCustomRecord(c, idKeyMap).lifetime_value), 0) : undefined;
      const tierSplit = section === "offers"
        ? capped.reduce((m, c) => { const t = tierDataFor(contactCustomRecord(c, idKeyMap), tiers).tier; m[t.id] = (m[t.id] || 0) + 1; return m; }, {})
        : undefined;

      const live = dryRun === false && CARD_SENDS_ENABLED;
      if (!live) {
        return res.json({
          ok: true, dryRun: true, sendsEnabled: CARD_SENDS_ENABLED, section, mode,
          matched: withId.length, eligible: eligible.length, skippedDnd, skippedRecent,
          willSend: capped.length, cap, trigger: cfg.tags.trigger,
          ...(totalLtv != null ? { totalLtv, totalLtvLabel: money(totalLtv) } : {}),
          ...(tierSplit ? { tierSplit } : {}),
          sample: capped.slice(0, 5).map((c) => ({ id: idOf(c), firstName: firstNameOf(c) })),
        });
      }

      const batchId = `${section}-${Date.now()}`;
      let sent = 0, failed = 0;
      const errors = [];
      for (const c of capped) {
        const cid = idOf(c);
        try {
          const result = await deliver({ section, client, locationId, contactId: cid, cfg, cvByName, mode, contact: c, idKeyMap, tiers });
          await store.logHomeSend({ locationId, section, contactId: cid, triggerTag: cfg.tags.trigger, cardUrl: result.cardUrl, batchId });
          sent++;
        } catch (e) {
          failed++;
          if (errors.length < 5) errors.push({ who: firstNameOf(c) || cid, error: e?.message || "error" });
        }
        await new Promise((r) => setTimeout(r, SEND_THROTTLE_MS));
      }
      res.json({ ok: true, sent, failed, skippedDnd, skippedRecent, willSend: capped.length, cap, batchId, errors });
    } catch (err) { fail(res, err); }
  });

  /* ------------------------------------------------------------------ *
   * send internals
   * ------------------------------------------------------------------ */

  // Compute data.tier overrides for the Offers section (empty for others).
  async function offersOverrides(section, client, locationId, contactId, cvByName, preContact, idKeyMap) {
    if (section !== "offers") return undefined;
    const tiers = effectiveTiers(cvByName);
    let rec;
    if (preContact && idKeyMap) rec = contactCustomRecord(preContact, idKeyMap);
    else {
      const c = await getContact(client, contactId);
      rec = contactCustomRecord(c, await cfKeyMap(client, locationId));
    }
    return tierDataFor(rec, tiers).data;
  }

  async function safePreview(section, client, locationId, contactId, cfg, cvByName) {
    const { templateId } = await resolveTemplate(locationId, section, cfg, cvByName);
    if (!templateId) return { cardUrl: null, message: null, configError: "no card assigned to this section" };
    try {
      const dataOverrides = await offersOverrides(section, client, locationId, contactId, cvByName);
      const gen = await renderRouter.generate({ client, locationId, templateId, contactId, force: false, dataOverrides });
      return { cardUrl: gen.url, message: renderMessage(section, cfg, gen.context, cvByName) };
    } catch (e) {
      return { cardUrl: null, message: null, renderError: e?.message || "render failed" };
    }
  }

  // Deliver a send. Default mode "tag": pre-render the card, write its URL into
  // the contact's card field, then apply the trigger tag so the GHL workflow
  // sends the MMS + follow-ups (STOP handling rides along). Mode "direct":
  // broker sends the MMS itself (useful before workflows exist / for testing).
  async function deliver({ section, client, locationId, contactId, cfg, cvByName, mode, contact, idKeyMap, tiers }) {
    const { templateId } = await resolveTemplate(locationId, section, cfg, cvByName);
    if (!templateId) throw Object.assign(new Error("no card assigned to this section"), { http: 422 });
    const dataOverrides = await offersOverrides(section, client, locationId, contactId, cvByName, contact, idKeyMap);
    const gen = await renderRouter.generate({ client, locationId, templateId, contactId, force: false, dataOverrides });
    const message = renderMessage(section, cfg, gen.context, cvByName);

    if (mode === "direct") {
      await sendSms(client, { contactId, message, attachments: [gen.url] });
      return { cardUrl: gen.url, message, delivered: "mms" };
    }
    // tag mode: stage the card, then trigger the workflow.
    const fieldId = await findOrCreateCustomFieldByKey(client, locationId, CARD_FIELD_KEY, "Card Image URL");
    await updateContactCustomField(client, contactId, fieldId, gen.url);
    await addContactTags(client, contactId, [cfg.tags.trigger]);
    return { cardUrl: gen.url, message, delivered: "tag", trigger: cfg.tags.trigger };
  }

  return router;
}

/* ------------------------------------------------------------------ *
 * section summary (header stat + batch strip)
 * ------------------------------------------------------------------ */
// One headline shape for every section — "N in queue · <metric>" — so the
// header pills read uniformly across the page.
function summarize(section, rows, cap) {
  const base = `${rows.length} in queue`;
  if (section === "quotes") {
    const total = rows.reduce((s, r) => s + (r.amount || 0), 0);
    return { count: rows.length, headline: `${base} · ${money(total)}`, totalAmount: total };
  }
  if (section === "reviews") {
    const due = rows.filter((r) => r.status?.kind === "due").length;
    return { count: rows.length, due, headline: `${base} · ${due} due` };
  }
  if (section === "winback") {
    const ltv = rows.reduce((s, r) => s + (r.ltv || 0), 0);
    return { count: rows.length, headline: `${base} · ${money(ltv)} LTV`, totalLtv: ltv, totalLtvLabel: money(ltv) };
  }
  // offers
  return { count: rows.length, headline: base };
}
