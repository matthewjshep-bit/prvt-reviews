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
  };
})();

/* ============================================================= *
 * Chosen backend
 * ============================================================= */

export const store = dbEnabled ? pgStore : fileStore;
export { dbEnabled };
