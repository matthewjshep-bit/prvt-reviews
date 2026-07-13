// store.js — data access for the Card Studio, with two interchangeable backends:
//   • Postgres (used when DATABASE_URL is set) — the production backend.
//   • JSON file (fallback) — so the broker boots and template CRUD works in dev
//     without a database. Ephemeral on Render, fine for local development.
//
// Both backends expose the SAME async API. Callers never branch on backend.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dbEnabled, query, migrate } from "./db.js";

const nowIso = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const MAX_VERSIONS = 10;

/* ============================================================= *
 * Postgres backend
 * ============================================================= */

const pgStore = {
  async init() {
    await migrate();
  },

  /* ---- templates ---- */
  async listTemplates(locationId) {
    const { rows } = await query(
      `select doc from templates where location_id = $1 order by updated_at desc`,
      [locationId]
    );
    return rows.map((r) => r.doc);
  },
  async getTemplate(id) {
    const { rows } = await query(`select doc from templates where id = $1`, [id]);
    return rows[0]?.doc || null;
  },
  async createTemplate(doc) {
    const id = uuid();
    const ts = nowIso();
    const full = { ...doc, id, version: 1, createdAt: ts, updatedAt: ts };
    await query(
      `insert into templates (id, location_id, name, version, doc, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [id, full.locationId, full.name, 1, full, ts, ts]
    );
    return full;
  },
  async updateTemplate(id, doc) {
    const { rows } = await query(`select doc from templates where id = $1`, [id]);
    const prev = rows[0]?.doc;
    if (!prev) return null;
    const version = (prev.version || 1) + 1;
    const ts = nowIso();
    const full = {
      ...doc,
      id,
      version,
      locationId: prev.locationId,
      createdAt: prev.createdAt || ts,
      updatedAt: ts,
    };
    // Snapshot the prior version, then update, then prune history to last N.
    await query(
      `insert into template_versions (template_id, version, doc)
       values ($1,$2,$3) on conflict (template_id, version) do nothing`,
      [id, prev.version || 1, prev]
    );
    await query(
      `update templates set name=$2, version=$3, doc=$4, updated_at=$5 where id=$1`,
      [id, full.name, version, full, ts]
    );
    await query(
      `delete from template_versions where template_id = $1 and version not in (
         select version from template_versions where template_id = $1
         order by version desc limit $2)`,
      [id, MAX_VERSIONS]
    );
    return full;
  },
  async deleteTemplate(id) {
    const { rowCount } = await query(`delete from templates where id = $1`, [id]);
    return rowCount > 0;
  },

  /* ---- renders (log) ---- */
  async logRender(row) {
    const id = row.id || uuid();
    await query(
      `insert into renders (id, location_id, template_id, template_version, contact_id,
         cache_key, r2_key, url, status, cached, duration_ms, missing_bindings,
         provider_results, resolved_snapshot, error)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        id, row.locationId, row.templateId || null, row.templateVersion || null,
        row.contactId || null, row.cacheKey || null, row.r2Key || null, row.url || null,
        row.status || null, row.cached ?? false, row.durationMs || null,
        JSON.stringify(row.missingBindings || []), JSON.stringify(row.providerResults || []),
        JSON.stringify(row.resolvedSnapshot || {}), row.error || null,
      ]
    );
    return id;
  },

  /* ---- home sends (log + 24h dedupe) ---- */
  async logHomeSend(row) {
    await query(
      `insert into home_sends (location_id, section, contact_id, trigger_tag, card_url, batch_id)
       values ($1,$2,$3,$4,$5,$6)`,
      [row.locationId, row.section, row.contactId, row.triggerTag || null, row.cardUrl || null, row.batchId || null]
    );
    return true;
  },
  // Contact ids for this (location, section) sent within `sinceMs` ago. Used to
  // skip re-sends inside the dedupe window.
  async recentHomeSendIds(locationId, section, sinceMs) {
    const cutoff = new Date(Date.now() - sinceMs).toISOString();
    const { rows } = await query(
      `select distinct contact_id from home_sends
       where location_id = $1 and section = $2 and created_at >= $3`,
      [locationId, section, cutoff]
    );
    return new Set(rows.map((r) => r.contact_id));
  },
  // One contact's send history (drives the Contacts drawer timeline).
  async homeSendsForContact(locationId, contactId, limit = 20) {
    const { rows } = await query(
      `select section, trigger_tag as "triggerTag", card_url as "cardUrl",
              batch_id as "batchId", created_at as "createdAt"
       from home_sends
       where location_id = $1 and contact_id = $2
       order by created_at desc limit $3`,
      [locationId, contactId, limit]
    );
    return rows;
  },

  /* ---- assets ---- */
  async createAsset(row) {
    const id = uuid();
    await query(
      `insert into assets (id, location_id, r2_key, url, content_type, bytes)
       values ($1,$2,$3,$4,$5,$6)`,
      [id, row.locationId, row.r2Key || null, row.url, row.contentType || null, row.bytes || null]
    );
    return { id, ...row };
  },
  async listAssets(locationId) {
    const { rows } = await query(
      `select id, location_id as "locationId", r2_key as "r2Key", url,
              content_type as "contentType", bytes, created_at as "createdAt"
       from assets where location_id = $1 order by created_at desc limit 200`,
      [locationId]
    );
    return rows;
  },

  /* ---- connections (secret_enc kept internal) ---- */
  async listConnections(locationId) {
    const { rows } = await query(
      `select id, name, provider, type, created_at as "createdAt"
       from connections where location_id = $1 order by created_at desc`,
      [locationId]
    );
    return rows;
  },
  async getConnection(id) {
    const { rows } = await query(
      `select id, location_id as "locationId", name, provider, type,
              secret_enc as "secretEnc", created_at as "createdAt"
       from connections where id = $1`,
      [id]
    );
    return rows[0] || null;
  },
  async createConnection(row) {
    const id = uuid();
    await query(
      `insert into connections (id, location_id, name, provider, type, secret_enc)
       values ($1,$2,$3,$4,$5,$6)`,
      [id, row.locationId, row.name, row.provider || null, row.type || "header", row.secretEnc]
    );
    return { id, name: row.name, provider: row.provider, type: row.type || "header" };
  },
  async deleteConnection(id) {
    const { rowCount } = await query(`delete from connections where id = $1`, [id]);
    return rowCount > 0;
  },

  /* ---- data source tests ---- */
  async saveDataSourceTest(row) {
    await query(
      `insert into data_source_tests (location_id, template_id, source_id,
         discovered_keys, data, thumbnail_key, thumbnail_url)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        row.locationId, row.templateId || null, row.sourceId,
        JSON.stringify(row.discoveredKeys || []), JSON.stringify(row.data || {}),
        row.thumbnailKey || null, row.thumbnailUrl || null,
      ]
    );
    return true;
  },
  async getDataSourceTest(locationId, templateId, sourceId) {
    const { rows } = await query(
      `select discovered_keys as "discoveredKeys", data, thumbnail_url as "thumbnailUrl"
       from data_source_tests
       where location_id = $1 and source_id = $3
         and (template_id = $2 or template_id is null)
       order by created_at desc limit 1`,
      [locationId, templateId || null, sourceId]
    );
    return rows[0] || null;
  },
};

/* ============================================================= *
 * JSON-file fallback backend
 * ============================================================= */

const DATA_DIR = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");

function loadFile() {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch {
    return { templates: {}, versions: {}, renders: [], assets: [], connections: {}, tests: [], homeSends: [] };
  }
}

const fileStore = (() => {
  let data = null;
  let writeTimer = null;
  const ensure = () => {
    if (!data) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      data = loadFile();
    }
    return data;
  };
  const persist = () => {
    clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      try {
        fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
      } catch (e) {
        console.error("store: file persist failed:", e.message);
      }
    }, 50);
  };

  return {
    async init() {
      ensure();
      console.warn(`store: DATABASE_URL not set — using JSON file fallback at ${STORE_FILE}`);
    },

    async listTemplates(locationId) {
      ensure();
      return Object.values(data.templates)
        .filter((t) => t.locationId === locationId)
        .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    },
    async getTemplate(id) {
      ensure();
      return data.templates[id] || null;
    },
    async createTemplate(doc) {
      ensure();
      const id = uuid();
      const ts = nowIso();
      const full = { ...doc, id, version: 1, createdAt: ts, updatedAt: ts };
      data.templates[id] = full;
      persist();
      return full;
    },
    async updateTemplate(id, doc) {
      ensure();
      const prev = data.templates[id];
      if (!prev) return null;
      const version = (prev.version || 1) + 1;
      const ts = nowIso();
      const full = {
        ...doc, id, version,
        locationId: prev.locationId,
        createdAt: prev.createdAt || ts,
        updatedAt: ts,
      };
      const hist = data.versions[id] || [];
      hist.push({ version: prev.version || 1, doc: prev, createdAt: ts });
      data.versions[id] = hist.slice(-MAX_VERSIONS);
      data.templates[id] = full;
      persist();
      return full;
    },
    async deleteTemplate(id) {
      ensure();
      if (!data.templates[id]) return false;
      delete data.templates[id];
      delete data.versions[id];
      persist();
      return true;
    },

    async logRender(row) {
      ensure();
      const id = row.id || uuid();
      data.renders.push({ id, ...row, createdAt: nowIso() });
      data.renders = data.renders.slice(-500);
      persist();
      return id;
    },

    async logHomeSend(row) {
      ensure();
      data.homeSends = data.homeSends || [];
      data.homeSends.push({ ...row, createdAt: nowIso() });
      data.homeSends = data.homeSends.slice(-2000);
      persist();
      return true;
    },
    async recentHomeSendIds(locationId, section, sinceMs) {
      ensure();
      const cutoff = Date.now() - sinceMs;
      const ids = new Set();
      for (const r of data.homeSends || []) {
        if (r.locationId === locationId && r.section === section && new Date(r.createdAt).getTime() >= cutoff) {
          ids.add(r.contactId);
        }
      }
      return ids;
    },
    async homeSendsForContact(locationId, contactId, limit = 20) {
      ensure();
      return (data.homeSends || [])
        .filter((r) => r.locationId === locationId && r.contactId === contactId)
        .slice(-limit)
        .reverse()
        .map(({ section, triggerTag, cardUrl, batchId, createdAt }) => ({ section, triggerTag, cardUrl, batchId, createdAt }));
    },

    async createAsset(row) {
      ensure();
      const id = uuid();
      const rec = { id, ...row, createdAt: nowIso() };
      data.assets.push(rec);
      persist();
      return rec;
    },
    async listAssets(locationId) {
      ensure();
      return data.assets.filter((a) => a.locationId === locationId).slice(-200).reverse();
    },

    async listConnections(locationId) {
      ensure();
      return Object.values(data.connections)
        .filter((c) => c.locationId === locationId)
        .map(({ id, name, provider, type, createdAt }) => ({ id, name, provider, type, createdAt }));
    },
    async getConnection(id) {
      ensure();
      return data.connections[id] || null;
    },
    async createConnection(row) {
      ensure();
      const id = uuid();
      data.connections[id] = { id, ...row, createdAt: nowIso() };
      persist();
      return { id, name: row.name, provider: row.provider, type: row.type || "header" };
    },
    async deleteConnection(id) {
      ensure();
      if (!data.connections[id]) return false;
      delete data.connections[id];
      persist();
      return true;
    },

    async saveDataSourceTest(row) {
      ensure();
      data.tests.push({ ...row, createdAt: nowIso() });
      data.tests = data.tests.slice(-500);
      persist();
      return true;
    },
    async getDataSourceTest(locationId, templateId, sourceId) {
      ensure();
      const matches = data.tests.filter(
        (t) => t.locationId === locationId && t.sourceId === sourceId &&
          (t.templateId === templateId || t.templateId == null)
      );
      return matches.length ? matches[matches.length - 1] : null;
    },
  };
})();

/* ============================================================= *
 * Chosen backend
 * ============================================================= */

export const store = dbEnabled ? pgStore : fileStore;
export { dbEnabled };
