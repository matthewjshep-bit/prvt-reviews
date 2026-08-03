// store.js — data access for the offer generator, with two interchangeable
// backends:
//   • Postgres (used when DATABASE_URL is set) — the production backend.
//   • JSON file (fallback) — so the broker boots and offers persist in dev
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

/* ============================================================= *
 * Postgres backend
 * ============================================================= */

const pgStore = {
  async init() {
    await migrate();
  },

  /* ---- offers ---- */
  async createOffer(doc) {
    const id = doc.id || uuid();
    const ts = nowIso();
    const full = { ...doc, id, createdAt: ts };
    await query(
      `insert into offers (id, location_id, contact_id, address, cash_amount, doc, created_at)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [id, full.locationId, full.contactId || null, full.address || null, full.cashAmount || null, full, ts]
    );
    return full;
  },
  async listOffers(locationId, { contactId = null, limit = 50 } = {}) {
    const { rows } = contactId
      ? await query(
          `select doc from offers where location_id = $1 and contact_id = $2 order by created_at desc limit $3`,
          [locationId, contactId, limit]
        )
      : await query(
          `select doc from offers where location_id = $1 order by created_at desc limit $2`,
          [locationId, limit]
        );
    return rows.map((r) => r.doc);
  },
  async getOffer(id) {
    const { rows } = await query(`select doc from offers where id = $1`, [id]);
    return rows[0]?.doc || null;
  },
  async updateOffer(id, doc) {
    const { rowCount } = await query(`update offers set doc = $2 where id = $1`, [id, doc]);
    return rowCount > 0;
  },
  async deleteOffer(id) {
    await query(`delete from offer_documents where offer_id = $1`, [id]).catch(() => {});
    const { rowCount } = await query(`delete from offers where id = $1`, [id]);
    return rowCount > 0;
  },

  /* ---- offer documents (bytes in Postgres; used when R2 isn't configured) ---- */
  async saveOfferDoc(offerId, kind, bytes, contentType) {
    await query(
      `insert into offer_documents (offer_id, kind, content_type, bytes) values ($1,$2,$3,$4)
       on conflict (offer_id, kind) do update set content_type = $3, bytes = $4`,
      [offerId, kind, contentType, bytes]
    );
    return true;
  },
  async getOfferDoc(offerId, kind) {
    const { rows } = await query(
      `select content_type as "contentType", bytes from offer_documents where offer_id = $1 and kind = $2`,
      [offerId, kind]
    );
    return rows[0] || null;
  },

  /* ---- offer settings (one row per location) ---- */
  async getOfferSettings(locationId) {
    const { rows } = await query(`select doc from offer_settings where location_id = $1`, [locationId]);
    return rows[0]?.doc || null;
  },
  async saveOfferSettings(locationId, doc) {
    await query(
      `insert into offer_settings (location_id, doc, updated_at) values ($1,$2,$3)
       on conflict (location_id) do update set doc = $2, updated_at = $3`,
      [locationId, doc, nowIso()]
    );
    return doc;
  },

  /* ---- agent outreach ---- */
  // Upserts replace doc + bump last_seen but never touch the lifecycle
  // columns (status, contact_id, imported_at, first_seen).
  async upsertOutreachAgents(locationId, agents) {
    for (const a of agents) {
      await query(
        `insert into outreach_agents (id, location_id, agent_key, doc)
         values ($1,$2,$3,$4)
         on conflict (location_id, agent_key)
         do update set doc = excluded.doc, last_seen = now()`,
        [uuid(), locationId, a.agentKey, a.doc]
      );
    }
  },
  async listOutreachAgents(locationId, { status = null, limit = 1000 } = {}) {
    const { rows } = status
      ? await query(
          `select agent_key as "agentKey", status, contact_id as "contactId",
                  imported_at as "importedAt", first_seen as "firstSeen", last_seen as "lastSeen", doc
           from outreach_agents where location_id = $1 and status = $2
           order by last_seen desc limit $3`,
          [locationId, status, limit]
        )
      : await query(
          `select agent_key as "agentKey", status, contact_id as "contactId",
                  imported_at as "importedAt", first_seen as "firstSeen", last_seen as "lastSeen", doc
           from outreach_agents where location_id = $1
           order by last_seen desc limit $2`,
          [locationId, limit]
        );
    return rows;
  },
  async getOutreachAgent(locationId, agentKey) {
    const { rows } = await query(
      `select agent_key as "agentKey", status, contact_id as "contactId",
              imported_at as "importedAt", first_seen as "firstSeen", last_seen as "lastSeen", doc
       from outreach_agents where location_id = $1 and agent_key = $2`,
      [locationId, agentKey]
    );
    return rows[0] || null;
  },
  async setOutreachAgentStatus(locationId, agentKey, { status, contactId, importedAt } = {}) {
    const { rowCount } = await query(
      `update outreach_agents
       set status = coalesce($3, status),
           contact_id = coalesce($4, contact_id),
           imported_at = coalesce($5, imported_at)
       where location_id = $1 and agent_key = $2`,
      [locationId, agentKey, status || null, contactId || null, importedAt || null]
    );
    return rowCount > 0;
  },
  async upsertOutreachListings(locationId, listings) {
    for (const l of listings) {
      await query(
        `insert into outreach_listings (id, location_id, listing_key, agent_key, doc)
         values ($1,$2,$3,$4,$5)
         on conflict (location_id, listing_key)
         do update set doc = excluded.doc, agent_key = excluded.agent_key, last_seen = now()`,
        [uuid(), locationId, l.listingKey, l.agentKey, l.doc]
      );
    }
  },
  async listOutreachListings(locationId, { agentKey } = {}) {
    const { rows } = await query(
      `select listing_key as "listingKey", agent_key as "agentKey",
              first_seen as "firstSeen", last_seen as "lastSeen", doc
       from outreach_listings where location_id = $1 and agent_key = $2`,
      [locationId, agentKey]
    );
    return rows;
  },
  async recordOutreachPull(locationId, doc) {
    await query(`insert into outreach_pulls (id, location_id, doc) values ($1,$2,$3)`, [
      uuid(),
      locationId,
      doc,
    ]);
  },
  async listOutreachPulls(locationId, { limit = 50 } = {}) {
    const { rows } = await query(
      `select doc, created_at as "createdAt" from outreach_pulls
       where location_id = $1 order by created_at desc limit $2`,
      [locationId, limit]
    );
    return rows;
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
    return { offers: {}, offerSettings: {} };
  }
}

const fileStore = (() => {
  let data = null;
  let writeTimer = null;
  const ensure = () => {
    if (!data) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      data = loadFile();
      data.offers = data.offers || {};
      data.offerSettings = data.offerSettings || {};
      data.outreachAgents = data.outreachAgents || {};
      data.outreachListings = data.outreachListings || {};
      data.outreachPulls = data.outreachPulls || [];
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

    async createOffer(doc) {
      ensure();
      const id = doc.id || uuid();
      const full = { ...doc, id, createdAt: nowIso() };
      data.offers[id] = full;
      persist();
      return full;
    },
    async listOffers(locationId, { contactId = null, limit = 50 } = {}) {
      ensure();
      return Object.values(data.offers)
        .filter((o) => o.locationId === locationId && (!contactId || o.contactId === contactId))
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
        .slice(0, limit);
    },
    async getOffer(id) {
      ensure();
      return data.offers[id] || null;
    },
    async updateOffer(id, doc) {
      ensure();
      if (!data.offers[id]) return false;
      data.offers[id] = doc;
      persist();
      return true;
    },
    async deleteOffer(id) {
      ensure();
      if (!data.offers[id]) return false;
      delete data.offers[id];
      for (const kind of ["pdf", "image", "scopepdf", "compspdf", "contractpdf"]) {
        fs.rmSync(path.join(DATA_DIR, "docs", `${id}.${kind}`), { force: true });
        fs.rmSync(path.join(DATA_DIR, "docs", `${id}.${kind}.meta`), { force: true });
      }
      persist();
      return true;
    },

    // Documents live as files under DATA_DIR/docs (dev only).
    async saveOfferDoc(offerId, kind, bytes, contentType) {
      ensure();
      const dir = path.join(DATA_DIR, "docs");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${offerId}.${kind}`), bytes);
      fs.writeFileSync(path.join(dir, `${offerId}.${kind}.meta`), contentType);
      return true;
    },
    async getOfferDoc(offerId, kind) {
      ensure();
      try {
        const dir = path.join(DATA_DIR, "docs");
        return {
          bytes: fs.readFileSync(path.join(dir, `${offerId}.${kind}`)),
          contentType: fs.readFileSync(path.join(dir, `${offerId}.${kind}.meta`), "utf8"),
        };
      } catch {
        return null;
      }
    },

    async getOfferSettings(locationId) {
      ensure();
      return data.offerSettings[locationId] || null;
    },
    async saveOfferSettings(locationId, doc) {
      ensure();
      data.offerSettings[locationId] = doc;
      persist();
      return doc;
    },

    /* ---- agent outreach (rows keyed "<locationId>|<key>") ---- */
    async upsertOutreachAgents(locationId, agents) {
      ensure();
      for (const a of agents) {
        const k = `${locationId}|${a.agentKey}`;
        const prev = data.outreachAgents[k];
        data.outreachAgents[k] = prev
          ? { ...prev, doc: a.doc, lastSeen: nowIso() }
          : {
              agentKey: a.agentKey,
              locationId,
              status: "new",
              contactId: null,
              importedAt: null,
              firstSeen: nowIso(),
              lastSeen: nowIso(),
              doc: a.doc,
            };
      }
      persist();
    },
    async listOutreachAgents(locationId, { status = null, limit = 1000 } = {}) {
      ensure();
      return Object.values(data.outreachAgents)
        .filter((a) => a.locationId === locationId && (!status || a.status === status))
        .sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""))
        .slice(0, limit);
    },
    async getOutreachAgent(locationId, agentKey) {
      ensure();
      return data.outreachAgents[`${locationId}|${agentKey}`] || null;
    },
    async setOutreachAgentStatus(locationId, agentKey, { status, contactId, importedAt } = {}) {
      ensure();
      const row = data.outreachAgents[`${locationId}|${agentKey}`];
      if (!row) return false;
      if (status) row.status = status;
      if (contactId) row.contactId = contactId;
      if (importedAt) row.importedAt = importedAt;
      persist();
      return true;
    },
    async upsertOutreachListings(locationId, listings) {
      ensure();
      for (const l of listings) {
        const k = `${locationId}|${l.listingKey}`;
        const prev = data.outreachListings[k];
        data.outreachListings[k] = {
          listingKey: l.listingKey,
          locationId,
          agentKey: l.agentKey,
          firstSeen: prev?.firstSeen || nowIso(),
          lastSeen: nowIso(),
          doc: l.doc,
        };
      }
      persist();
    },
    async listOutreachListings(locationId, { agentKey } = {}) {
      ensure();
      return Object.values(data.outreachListings).filter(
        (l) => l.locationId === locationId && l.agentKey === agentKey
      );
    },
    async recordOutreachPull(locationId, doc) {
      ensure();
      data.outreachPulls.push({ locationId, doc, createdAt: nowIso() });
      if (data.outreachPulls.length > 200) data.outreachPulls = data.outreachPulls.slice(-200);
      persist();
    },
    async listOutreachPulls(locationId, { limit = 50 } = {}) {
      ensure();
      return data.outreachPulls
        .filter((p) => p.locationId === locationId)
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
        .slice(0, limit);
    },
  };
})();

/* ============================================================= *
 * Chosen backend
 * ============================================================= */

export const store = dbEnabled ? pgStore : fileStore;
export { dbEnabled };
