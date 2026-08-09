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
    // Adopt pre-batch outreach rows (batch_id null) into one "Earlier pulls"
    // batch per location. Idempotent: after the first run no null rows remain.
    try {
      const { rows } = await query(
        `select distinct location_id as "locationId" from outreach_agents where batch_id is null
         union
         select distinct location_id from outreach_listings where batch_id is null`
      );
      for (const { locationId } of rows) {
        const batch = await this.createOutreachBatch(locationId, { name: "Earlier pulls", autoNamed: false });
        await query(`update outreach_agents set batch_id = $2 where location_id = $1 and batch_id is null`, [locationId, batch.id]);
        await query(`update outreach_listings set batch_id = $2 where location_id = $1 and batch_id is null`, [locationId, batch.id]);
      }
    } catch (e) {
      console.error("store: legacy outreach batch adoption failed:", e.message);
    }
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
  // Offers promoted to deals (doc has a `deal` key), newest deal first.
  async listDeals(locationId, { limit = 200 } = {}) {
    const { rows } = await query(
      `select doc from offers where location_id = $1 and doc ? 'deal'
       order by doc->'deal'->>'createdAt' desc limit $2`,
      [locationId, limit]
    );
    return rows.map((r) => r.doc);
  },
  // Lean offer rows since a timestamp for dashboard aggregation — enough for
  // daily buckets without the fat doc (snapshot etc.). Ascending by creation.
  async listOffersSince(locationId, sinceIso) {
    const { rows } = await query(
      `select id, created_at as "createdAt", cash_amount as "cashAmount",
              doc->>'status' as status, coalesce(doc->'sends', '[]'::jsonb) as sends
       from offers where location_id = $1 and created_at >= $2
       order by created_at`,
      [locationId, sinceIso]
    );
    return rows;
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

  /* ---- agent outreach batches ---- */
  async createOutreachBatch(locationId, { name, autoNamed = true } = {}) {
    const id = uuid();
    const ts = nowIso();
    await query(
      `insert into outreach_batches (id, location_id, name, auto_named, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$5)`,
      [id, locationId, name, autoNamed, ts]
    );
    return { id, name, autoNamed, createdAt: ts };
  },
  async listOutreachBatches(locationId) {
    const { rows } = await query(
      `select b.id, b.name, b.auto_named as "autoNamed", b.created_at as "createdAt",
              count(a.id)::int as "agentCount",
              (count(a.id) filter (where a.status = 'imported'))::int as "importedCount"
       from outreach_batches b
       left join outreach_agents a on a.location_id = b.location_id and a.batch_id = b.id
       where b.location_id = $1
       group by b.id
       order by b.created_at desc`,
      [locationId]
    );
    return rows;
  },
  async getOutreachBatch(locationId, batchId) {
    const { rows } = await query(
      `select id, name, auto_named as "autoNamed", created_at as "createdAt"
       from outreach_batches where location_id = $1 and id = $2`,
      [locationId, batchId]
    );
    return rows[0] || null;
  },
  async renameOutreachBatch(locationId, batchId, name, { autoNamed = false } = {}) {
    const { rowCount } = await query(
      `update outreach_batches set name = $3, auto_named = $4, updated_at = now()
       where location_id = $1 and id = $2`,
      [locationId, batchId, name, autoNamed]
    );
    return rowCount > 0;
  },
  async deleteOutreachBatch(locationId, batchId) {
    await query(`delete from outreach_listings where location_id = $1 and batch_id = $2`, [locationId, batchId]);
    const { rowCount } = await query(
      `delete from outreach_agents where location_id = $1 and batch_id = $2`,
      [locationId, batchId]
    );
    await query(`delete from outreach_batches where location_id = $1 and id = $2`, [locationId, batchId]);
    return { removedAgents: rowCount };
  },

  /* ---- agent outreach (all rows scoped to a batch) ---- */
  // Upserts replace doc + bump last_seen but never touch the lifecycle
  // columns (status, contact_id, imported_at, first_seen).
  async upsertOutreachAgents(locationId, batchId, agents) {
    for (const a of agents) {
      await query(
        `insert into outreach_agents (id, location_id, batch_id, agent_key, doc)
         values ($1,$2,$3,$4,$5)
         on conflict (location_id, batch_id, agent_key)
         do update set doc = excluded.doc, last_seen = now()`,
        [uuid(), locationId, batchId, a.agentKey, a.doc]
      );
    }
  },
  async listOutreachAgents(locationId, { batchId, status = null, limit = 1000 } = {}) {
    const { rows } = status
      ? await query(
          `select agent_key as "agentKey", status, contact_id as "contactId",
                  imported_at as "importedAt", first_seen as "firstSeen", last_seen as "lastSeen", doc
           from outreach_agents where location_id = $1 and batch_id = $2 and status = $3
           order by last_seen desc limit $4`,
          [locationId, batchId, status, limit]
        )
      : await query(
          `select agent_key as "agentKey", status, contact_id as "contactId",
                  imported_at as "importedAt", first_seen as "firstSeen", last_seen as "lastSeen", doc
           from outreach_agents where location_id = $1 and batch_id = $2
           order by last_seen desc limit $3`,
          [locationId, batchId, limit]
        );
    return rows;
  },
  async getOutreachAgent(locationId, batchId, agentKey) {
    const { rows } = await query(
      `select agent_key as "agentKey", status, contact_id as "contactId",
              imported_at as "importedAt", first_seen as "firstSeen", last_seen as "lastSeen", doc
       from outreach_agents where location_id = $1 and batch_id = $2 and agent_key = $3`,
      [locationId, batchId, agentKey]
    );
    return rows[0] || null;
  },
  async setOutreachAgentStatus(locationId, batchId, agentKey, { status, contactId, importedAt } = {}) {
    const { rowCount } = await query(
      `update outreach_agents
       set status = coalesce($4, status),
           contact_id = coalesce($5, contact_id),
           imported_at = coalesce($6, imported_at)
       where location_id = $1 and batch_id = $2 and agent_key = $3`,
      [locationId, batchId, agentKey, status || null, contactId || null, importedAt || null]
    );
    return rowCount > 0;
  },
  async upsertOutreachListings(locationId, batchId, listings) {
    for (const l of listings) {
      await query(
        `insert into outreach_listings (id, location_id, batch_id, listing_key, agent_key, doc)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (location_id, batch_id, listing_key)
         do update set doc = excluded.doc, agent_key = excluded.agent_key, last_seen = now()`,
        [uuid(), locationId, batchId, l.listingKey, l.agentKey, l.doc]
      );
    }
  },
  async listOutreachListings(locationId, { batchId, agentKey } = {}) {
    const { rows } = await query(
      `select listing_key as "listingKey", agent_key as "agentKey",
              first_seen as "firstSeen", last_seen as "lastSeen", doc
       from outreach_listings where location_id = $1 and batch_id = $2 and agent_key = $3`,
      [locationId, batchId, agentKey]
    );
    return rows;
  },
  async listAllOutreachListings(locationId, { batchId } = {}) {
    const { rows } = await query(
      `select listing_key as "listingKey", agent_key as "agentKey", doc
       from outreach_listings where location_id = $1 and batch_id = $2`,
      [locationId, batchId]
    );
    return rows;
  },
  // Delete the batch's non-imported agents + their listings. Returns the
  // number of agents removed.
  async clearOutreachAgents(locationId, batchId) {
    await query(
      `delete from outreach_listings where location_id = $1 and batch_id = $2 and agent_key in
         (select agent_key from outreach_agents where location_id = $1 and batch_id = $2 and status <> 'imported')`,
      [locationId, batchId]
    );
    const { rowCount } = await query(
      `delete from outreach_agents where location_id = $1 and batch_id = $2 and status <> 'imported'`,
      [locationId, batchId]
    );
    return rowCount;
  },
  // Cross-batch agent lifecycle rows for the dashboard funnel: every agent
  // first seen OR imported since the timestamp.
  async listOutreachActivity(locationId, sinceIso) {
    const { rows } = await query(
      `select first_seen as "firstSeen", imported_at as "importedAt", status
       from outreach_agents
       where location_id = $1 and (first_seen >= $2 or imported_at >= $2)`,
      [locationId, sinceIso]
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
      data.outreachBatches = data.outreachBatches || {};
      adoptLegacyOutreachRows();
    }
    return data;
  };
  // Adopt pre-batch rows (no batchId) into one "Earlier pulls" batch per
  // location, re-keying "<loc>|<key>" entries to "<loc>|<batchId>|<key>".
  const adoptLegacyOutreachRows = () => {
    const legacyBatchByLoc = {};
    const batchFor = (locationId) => {
      if (!legacyBatchByLoc[locationId]) {
        const id = uuid();
        data.outreachBatches[id] = {
          id, locationId, name: "Earlier pulls", autoNamed: false,
          createdAt: nowIso(), updatedAt: nowIso(),
        };
        legacyBatchByLoc[locationId] = id;
      }
      return legacyBatchByLoc[locationId];
    };
    let touched = false;
    for (const bucket of ["outreachAgents", "outreachListings"]) {
      for (const [k, row] of Object.entries(data[bucket])) {
        if (row.batchId) continue;
        row.batchId = batchFor(row.locationId);
        delete data[bucket][k];
        const key = bucket === "outreachAgents" ? row.agentKey : row.listingKey;
        data[bucket][`${row.locationId}|${row.batchId}|${key}`] = row;
        touched = true;
      }
    }
    if (touched) persist();
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
    async listDeals(locationId, { limit = 200 } = {}) {
      ensure();
      return Object.values(data.offers)
        .filter((o) => o.locationId === locationId && o.deal)
        .sort((a, b) => (b.deal.createdAt || "").localeCompare(a.deal.createdAt || ""))
        .slice(0, limit);
    },
    async listOffersSince(locationId, sinceIso) {
      ensure();
      return Object.values(data.offers)
        .filter((o) => o.locationId === locationId && (o.createdAt || "") >= sinceIso)
        .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""))
        .map((o) => ({
          id: o.id,
          createdAt: o.createdAt,
          cashAmount: o.cashAmount ?? null,
          status: o.status || null,
          sends: o.sends || [],
        }));
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
      for (const kind of ["pdf", "image", "scopepdf", "compspdf", "contractpdf", "assignmentpdf"]) {
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

    /* ---- agent outreach batches ---- */
    async createOutreachBatch(locationId, { name, autoNamed = true } = {}) {
      ensure();
      const id = uuid();
      const ts = nowIso();
      data.outreachBatches[id] = { id, locationId, name, autoNamed, createdAt: ts, updatedAt: ts };
      persist();
      return { id, name, autoNamed, createdAt: ts };
    },
    async listOutreachBatches(locationId) {
      ensure();
      const agents = Object.values(data.outreachAgents);
      return Object.values(data.outreachBatches)
        .filter((b) => b.locationId === locationId)
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
        .map((b) => {
          const mine = agents.filter((a) => a.locationId === locationId && a.batchId === b.id);
          return {
            id: b.id, name: b.name, autoNamed: b.autoNamed, createdAt: b.createdAt,
            agentCount: mine.length,
            importedCount: mine.filter((a) => a.status === "imported").length,
          };
        });
    },
    async getOutreachBatch(locationId, batchId) {
      ensure();
      const b = data.outreachBatches[batchId];
      return b && b.locationId === locationId
        ? { id: b.id, name: b.name, autoNamed: b.autoNamed, createdAt: b.createdAt }
        : null;
    },
    async renameOutreachBatch(locationId, batchId, name, { autoNamed = false } = {}) {
      ensure();
      const b = data.outreachBatches[batchId];
      if (!b || b.locationId !== locationId) return false;
      b.name = name;
      b.autoNamed = autoNamed;
      b.updatedAt = nowIso();
      persist();
      return true;
    },
    async deleteOutreachBatch(locationId, batchId) {
      ensure();
      let removedAgents = 0;
      for (const bucket of ["outreachListings", "outreachAgents"]) {
        for (const [k, row] of Object.entries(data[bucket])) {
          if (row.locationId === locationId && row.batchId === batchId) {
            delete data[bucket][k];
            if (bucket === "outreachAgents") removedAgents++;
          }
        }
      }
      delete data.outreachBatches[batchId];
      persist();
      return { removedAgents };
    },

    /* ---- agent outreach (rows keyed "<locationId>|<batchId>|<key>") ---- */
    async upsertOutreachAgents(locationId, batchId, agents) {
      ensure();
      for (const a of agents) {
        const k = `${locationId}|${batchId}|${a.agentKey}`;
        const prev = data.outreachAgents[k];
        data.outreachAgents[k] = prev
          ? { ...prev, doc: a.doc, lastSeen: nowIso() }
          : {
              agentKey: a.agentKey,
              locationId,
              batchId,
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
    async listOutreachAgents(locationId, { batchId, status = null, limit = 1000 } = {}) {
      ensure();
      return Object.values(data.outreachAgents)
        .filter((a) => a.locationId === locationId && a.batchId === batchId && (!status || a.status === status))
        .sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""))
        .slice(0, limit);
    },
    async getOutreachAgent(locationId, batchId, agentKey) {
      ensure();
      return data.outreachAgents[`${locationId}|${batchId}|${agentKey}`] || null;
    },
    async setOutreachAgentStatus(locationId, batchId, agentKey, { status, contactId, importedAt } = {}) {
      ensure();
      const row = data.outreachAgents[`${locationId}|${batchId}|${agentKey}`];
      if (!row) return false;
      if (status) row.status = status;
      if (contactId) row.contactId = contactId;
      if (importedAt) row.importedAt = importedAt;
      persist();
      return true;
    },
    async upsertOutreachListings(locationId, batchId, listings) {
      ensure();
      for (const l of listings) {
        const k = `${locationId}|${batchId}|${l.listingKey}`;
        const prev = data.outreachListings[k];
        data.outreachListings[k] = {
          listingKey: l.listingKey,
          locationId,
          batchId,
          agentKey: l.agentKey,
          firstSeen: prev?.firstSeen || nowIso(),
          lastSeen: nowIso(),
          doc: l.doc,
        };
      }
      persist();
    },
    async listOutreachListings(locationId, { batchId, agentKey } = {}) {
      ensure();
      return Object.values(data.outreachListings).filter(
        (l) => l.locationId === locationId && l.batchId === batchId && l.agentKey === agentKey
      );
    },
    async listAllOutreachListings(locationId, { batchId } = {}) {
      ensure();
      return Object.values(data.outreachListings).filter(
        (l) => l.locationId === locationId && l.batchId === batchId
      );
    },
    async clearOutreachAgents(locationId, batchId) {
      ensure();
      let removed = 0;
      for (const [k, a] of Object.entries(data.outreachAgents)) {
        if (a.locationId !== locationId || a.batchId !== batchId || a.status === "imported") continue;
        for (const [lk, l] of Object.entries(data.outreachListings)) {
          if (l.locationId === locationId && l.batchId === batchId && l.agentKey === a.agentKey)
            delete data.outreachListings[lk];
        }
        delete data.outreachAgents[k];
        removed++;
      }
      persist();
      return removed;
    },
    async listOutreachActivity(locationId, sinceIso) {
      ensure();
      return Object.values(data.outreachAgents)
        .filter((a) => a.locationId === locationId &&
          ((a.firstSeen || "") >= sinceIso || (a.importedAt || "") >= sinceIso))
        .map((a) => ({ firstSeen: a.firstSeen, importedAt: a.importedAt, status: a.status }));
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
