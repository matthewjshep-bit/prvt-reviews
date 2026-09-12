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
import { OFFER_LIST_FIELDS, toListOffer, effectiveStatus, OPEN_STATUSES } from "./shared/offer-status.js";

// pg hands bigint back as a string and real as a float; the API speaks numbers.
const videoRow = (r) => ({
  ...r,
  sizeBytes: r.sizeBytes == null ? null : Number(r.sizeBytes),
  durationS: r.durationS == null ? null : Number(r.durationS),
});

const nowIso = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

/* ============================================================= *
 * Offer list query
 * ============================================================= */

// The offers list, built as { text, params } in one place so it can be
// exercised without a database (see offer-list-query.test.mjs).
//
// `lean` trims each doc to the table's fields (OFFER_LIST_FIELDS) in SQL, so
// the weight never leaves Postgres: ~1KB a row instead of ~9KB. That trim is
// what makes "load every offer for the location" affordable, which is the
// difference between the history page showing your book and showing the newest
// hundred rows of it.
export function offerListQuery({ locationId, contactId = null, limit = 50, lean = false }) {
  const params = [locationId];
  const ph = (v) => `$${params.push(v)}`; // bind v, return its placeholder
  const col = lean
    ? `coalesce((select jsonb_object_agg(k, v) from jsonb_each(doc) as e(k, v)
                  where k = any(${ph(OFFER_LIST_FIELDS)}::text[])), '{}'::jsonb) as doc`
    : "doc";
  const where = contactId ? ` and contact_id = ${ph(contactId)}` : "";
  return {
    text: `select ${col} from offers
            where location_id = $1${where}
            order by created_at desc limit ${ph(limit)}`,
    params,
  };
}

// The last thing anyone said to each contact, one row per contact.
//
// Deliberately NOT windowed. The offers table's whole question is how cold an
// agent has gone, and a bounded scan answers "nothing in 90 days" with the
// same blank as "we have never spoken" — the ambiguity routes/dispo.js warns
// about. Unbounded, `never` is the truth. It is also the cheaper read: the
// (location_id, contact_id, at desc) index makes `distinct on` walk one row
// per contact instead of every event in the window.
export function lastActivityQuery({ locationId, types = null, limit = 5000 }) {
  const params = [locationId];
  const ph = (v) => `$${params.push(v)}`; // bind v, return its placeholder
  const where = Array.isArray(types) && types.length ? ` and type = any(${ph(types)}::text[])` : "";
  return {
    text: `select distinct on (contact_id)
                  contact_id as "contactId", type, at, source, data
             from contact_events
            where location_id = $1 and contact_id is not null${where}
            order by contact_id, at desc
            limit ${ph(limit)}`,
    params,
  };
}

// Candidates for a time-based nudge: the location's open offers whose status
// has not moved since `before`, oldest first — the most neglected offer is the
// one to look at first. Built as { text, params } here for the same reason
// offerListQuery is: it gets a unit test without a database.
//
// The status/status_at columns this reads are a mirror of `doc`, kept for the
// index. The sweep re-checks effectiveStatus on the full row before it acts,
// so a stale mirror costs a missed nudge and never a wrong send.
export function followUpQuery({ locationId, statuses = [...OPEN_STATUSES], before, limit = 200 }) {
  const params = [locationId];
  const ph = (v) => `$${params.push(v)}`;
  const lean = `coalesce((select jsonb_object_agg(k, v) from jsonb_each(doc) as e(k, v)
                  where k = any(${ph(OFFER_LIST_FIELDS)}::text[])), '{}'::jsonb) as doc`;
  const where = [`location_id = $1`, `status = any(${ph(statuses)}::text[])`];
  // A row whose status_at never got written (an offer that predates the
  // column and has no statusAt in its doc either) is a candidate, not a
  // silent omission — the sweep will read it properly and decide.
  if (before) where.push(`(status_at is null or status_at <= ${ph(before)})`);
  return {
    text: `select ${lean} from offers
            where ${where.join(" and ")}
            order by status_at asc nulls first limit ${ph(limit)}`,
    params,
  };
}

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
    await this.backfillOfferStatusColumns().catch((e) =>
      console.error("store: offer status backfill failed:", e.message));
  },

  // Fill the mirrored status columns on offers written before they existed.
  // Idempotent: after the first run no null-status rows remain, so a redeploy
  // pages once, finds nothing and stops.
  //
  // Derived in JS through the shared effectiveStatus, never in SQL. The rule
  // ("no status? then a send makes it sent, a deal makes it accepted, else
  // new") already exists in one place, and a second copy written in SQL is a
  // copy that drifts.
  async backfillOfferStatusColumns({ pageSize = 500 } = {}) {
    let filled = 0;
    for (;;) {
      const { rows } = await query(
        `select id, doc, created_at as "createdAt" from offers where status is null limit $1`, [pageSize]);
      if (!rows.length) break;
      for (const r of rows) {
        const doc = r.doc || {};
        await query(`update offers set status = $2, status_at = $3 where id = $1`,
          [r.id, effectiveStatus(doc), doc.statusAt || doc.createdAt || r.createdAt || null]);
        filled++;
      }
      if (rows.length < pageSize) break;
    }
    if (filled) console.log(`store: backfilled status on ${filled} offer(s)`);
    return filled;
  },

  /* ---- offers ---- */
  async createOffer(doc) {
    const id = doc.id || uuid();
    const ts = nowIso();
    const full = { ...doc, id, createdAt: ts };
    await query(
      `insert into offers (id, location_id, contact_id, address, cash_amount, doc, created_at, status, status_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,
      [id, full.locationId, full.contactId || null, full.address || null, full.cashAmount || null, full, ts,
       full.status || effectiveStatus(full), full.statusAt || ts]
    );
    return full;
  },
  // `lean` trims each doc to the table's fields (see OFFER_LIST_FIELDS) in SQL,
  // so the weight never leaves Postgres: ~1KB a row instead of ~9KB. That trim
  // is what makes "load every offer for the location" affordable, which is the
  // difference between the history page showing your book and showing the
  // newest hundred rows of it.
  async listOffers(locationId, { contactId = null, limit = 50, lean = false } = {}) {
    const { text, params } = offerListQuery({ locationId, contactId, limit, lean });
    const { rows } = await query(text, params);
    return lean ? rows.map((r) => toListOffer(r.doc)) : rows.map((r) => r.doc);
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
  // The three columns beside `doc` are a mirror of it, and until an offer could
  // be revised in place nothing ever made them disagree. listOffersSince reads
  // cash_amount from the COLUMN (it feeds the dashboard's daily cash buckets),
  // so a doc-only write would leave the table showing one number and the chart
  // another, permanently. Every caller passes a whole doc, so mirror all three.
  async updateOffer(id, doc) {
    const { rowCount } = await query(
      `update offers set doc = $2, contact_id = $3, address = $4, cash_amount = $5,
                         status = $6, status_at = $7, updated_at = now() where id = $1`,
      [id, doc, doc.contactId || null, doc.address || null, doc.cashAmount || null,
       doc.status || effectiveStatus(doc), doc.statusAt || doc.createdAt || null]
    );
    return rowCount > 0;
  },
  // See followUpQuery. Lean rows, oldest-first; the caller re-reads the full
  // doc before acting on any of them.
  async listOffersForFollowUp(locationId, { statuses, before = null, limit = 200 } = {}) {
    const { text, params } = followUpQuery({ locationId, statuses, before, limit });
    const { rows } = await query(text, params);
    return rows.map((r) => toListOffer(r.doc));
  },
  async deleteOffer(id) {
    await query(`delete from offer_documents where offer_id = $1`, [id]).catch(() => {});
    // offer_photo_bytes / deal_document_bytes cascade from their parent rows.
    await query(`delete from offer_photos where offer_id = $1`, [id]).catch(() => {});
    // Video BYTES are the route's job (routes/offers.js deletes the R2 objects
    // before calling this); posters cascade from the rows.
    await query(`delete from offer_videos where offer_id = $1`, [id]).catch(() => {});
    await query(`delete from deal_documents where offer_id = $1`, [id]).catch(() => {});
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

  /* ---- deal attachments (operator-uploaded files: signed P&S, addenda…) ---- */

  // Metadata only — never `select *`, or every list drags the file bytes along.
  async listDealDocs(offerId) {
    const { rows } = await query(
      `select id, offer_id as "offerId", location_id as "locationId", kind, name,
              content_type as "contentType", size_bytes as "size", created_at as "createdAt"
         from deal_documents where offer_id = $1
        order by created_at, id`,
      [offerId]
    );
    return rows;
  },
  async saveDealDoc(offerId, locationId, { kind, name, contentType, bytes }) {
    const id = crypto.randomUUID();
    await query(
      `insert into deal_documents (id, offer_id, location_id, kind, name, content_type, size_bytes)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [id, offerId, locationId, kind, name, contentType, bytes.length]
    );
    await query(`insert into deal_document_bytes (document_id, bytes) values ($1,$2)`, [id, bytes]);
    const { rows } = await query(
      `select id, offer_id as "offerId", location_id as "locationId", kind, name,
              content_type as "contentType", size_bytes as "size", created_at as "createdAt"
         from deal_documents where id = $1`,
      [id]
    );
    return rows[0];
  },
  async readDealDocBytes(docId) {
    const { rows } = await query(
      `select d.name, d.content_type as "contentType", b.bytes, b.storage_key as "storageKey"
         from deal_documents d join deal_document_bytes b on b.document_id = d.id
        where d.id = $1`,
      [docId]
    );
    return rows[0] || null;
  },
  // offer_id in the WHERE: a caller can't delete someone else's attachment by
  // id-stuffing, same rule as the photos.
  async deleteDealDoc(offerId, docId) {
    const { rowCount } = await query(
      `delete from deal_documents where id = $1 and offer_id = $2`, [docId, offerId]
    );
    return rowCount > 0;
  },

  /* ---- property photos ---- */

  // Metadata only, never bytes — this is called on every dataroom render.
  async listOfferPhotos(offerId) {
    const { rows } = await query(
      `select id, offer_id as "offerId", location_id as "locationId", source, caption,
              sort, width, height, created_at as "createdAt"
         from offer_photos where offer_id = $1
        order by sort, created_at, id`,
      [offerId]
    );
    return rows;
  },
  async saveOfferPhoto(offerId, locationId, { variants, width, height, caption = null, source = "upload" }) {
    const id = crypto.randomUUID();
    // Sort is computed server-side; two parallel uploads racing on max()+1 land
    // on the same slot, which the created_at/id tiebreaker resolves cosmetically.
    // Not worth a lock.
    await query(
      `insert into offer_photos (id, offer_id, location_id, source, caption, sort, width, height)
       values ($1,$2,$3,$4,$5,(select coalesce(max(sort),-1)+1 from offer_photos where offer_id = $2),$6,$7)`,
      [id, offerId, locationId, source, caption, width || null, height || null]
    );
    for (const [variant, v] of Object.entries(variants)) {
      await query(
        `insert into offer_photo_bytes (photo_id, variant, content_type, bytes) values ($1,$2,$3,$4)`,
        [id, variant, v.contentType, v.bytes]
      );
    }
    const { rows } = await query(
      `select id, offer_id as "offerId", location_id as "locationId", source, caption,
              sort, width, height, created_at as "createdAt" from offer_photos where id = $1`,
      [id]
    );
    return rows[0];
  },
  // The single chokepoint for photo bytes — swapping to R2 means branching on
  // storage_key here and nowhere else.
  async readPhotoBytes(photoId, variant) {
    const { rows } = await query(
      `select content_type as "contentType", bytes, storage_key as "storageKey"
         from offer_photo_bytes where photo_id = $1 and variant = $2`,
      [photoId, variant]
    );
    return rows[0] || null;
  },
  // Rewrites the whole order in one statement. offer_id in the WHERE means a
  // caller can't reorder photos belonging to someone else's deal by id-stuffing.
  async reorderOfferPhotos(offerId, ids) {
    if (!ids.length) return true;
    await query(
      `update offer_photos p set sort = d.ord
         from (select * from unnest($2::uuid[]) with ordinality as t(id, ord)) d
        where p.id = d.id and p.offer_id = $1`,
      [offerId, ids]
    );
    return true;
  },
  async deleteOfferPhoto(offerId, photoId) {
    const { rowCount } = await query(
      `delete from offer_photos where id = $1 and offer_id = $2`, [photoId, offerId]
    );
    return rowCount > 0;
  },

  /* ---- property videos ---- */
  // Metadata only. Bytes live in R2 under storageKey (video.js) and never pass
  // through here; posters are small and stored like photo variants. `id` is
  // minted by the caller because the storage key is built from it before the
  // row exists. Rows are 'uploading' until finishOfferVideo flips them.
  async listOfferVideos(offerId) {
    const { rows } = await query(
      `select id, offer_id as "offerId", location_id as "locationId", status, name,
              content_type as "contentType", size_bytes as "sizeBytes", storage_key as "storageKey",
              upload_id as "uploadId", caption, sort, width, height, duration_s as "durationS",
              created_at as "createdAt"
         from offer_videos where offer_id = $1
        order by sort, created_at, id`,
      [offerId]
    );
    return rows.map(videoRow);
  },
  async getOfferVideo(offerId, videoId) {
    const { rows } = await query(
      `select id, offer_id as "offerId", location_id as "locationId", status, name,
              content_type as "contentType", size_bytes as "sizeBytes", storage_key as "storageKey",
              upload_id as "uploadId", caption, sort, width, height, duration_s as "durationS",
              created_at as "createdAt"
         from offer_videos where id = $1 and offer_id = $2`,
      [videoId, offerId]
    );
    return rows[0] ? videoRow(rows[0]) : null;
  },
  async createOfferVideo(offerId, locationId, { id, name, contentType, sizeBytes, storageKey, uploadId }) {
    await query(
      `insert into offer_videos (id, offer_id, location_id, status, name, content_type, size_bytes, storage_key, upload_id, sort)
       values ($1,$2,$3,'uploading',$4,$5,$6,$7,$8,(select coalesce(max(sort),-1)+1 from offer_videos where offer_id = $2))`,
      [id, offerId, locationId, name || null, contentType, sizeBytes || null, storageKey, uploadId || null]
    );
    return pgStore.getOfferVideo(offerId, id);
  },
  async finishOfferVideo(offerId, videoId, { sizeBytes, width, height, durationS, posters = {} }) {
    const { rowCount } = await query(
      `update offer_videos set status = 'ready', size_bytes = $3, width = $4, height = $5, duration_s = $6, upload_id = null
        where id = $1 and offer_id = $2`,
      [videoId, offerId, sizeBytes || null, width || null, height || null, durationS || null]
    );
    if (!rowCount) return null;
    for (const [variant, v] of Object.entries(posters)) {
      await query(
        `insert into offer_video_posters (video_id, variant, content_type, bytes) values ($1,$2,$3,$4)
         on conflict (video_id, variant) do update set content_type = excluded.content_type, bytes = excluded.bytes`,
        [videoId, variant, v.contentType, v.bytes]
      );
    }
    return pgStore.getOfferVideo(offerId, videoId);
  },
  async readVideoPoster(videoId, variant) {
    const { rows } = await query(
      `select content_type as "contentType", bytes from offer_video_posters where video_id = $1 and variant = $2`,
      [videoId, variant]
    );
    return rows[0] || null;
  },
  // Answers the row it removed (the caller still has to delete the bytes in R2,
  // which the store knows nothing about), or null if it wasn't this offer's.
  async deleteOfferVideo(offerId, videoId) {
    const row = await pgStore.getOfferVideo(offerId, videoId);
    if (!row) return null;
    await query(`delete from offer_videos where id = $1 and offer_id = $2`, [videoId, offerId]);
    return row;
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

  /* ---- reply drafts (the reply agent's outbox, awaiting a human) ---- */
  async createReplyDraft(doc) {
    const id = doc.id || uuid();
    const ts = nowIso();
    const full = { ...doc, id, createdAt: ts, updatedAt: doc.updatedAt || ts };
    await query(
      `insert into reply_drafts (id, location_id, contact_id, status, doc, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [id, full.locationId, full.contactId || null, full.status || "draft", full, ts, full.updatedAt]
    );
    return full;
  },
  // Newest first. `since` bounds by creation (the daily cap), `status` and
  // `contactId` narrow — both optional so the outbox and the cap share a query.
  async listReplyDrafts(locationId, { status = null, contactId = null, since = null, limit = 100 } = {}) {
    const params = [locationId];
    let where = "";
    if (Array.isArray(status) && status.length) { params.push(status); where += ` and status = any($${params.length}::text[])`; }
    else if (status && !Array.isArray(status)) { params.push(status); where += ` and status = $${params.length}`; }
    if (contactId) { params.push(contactId); where += ` and contact_id = $${params.length}`; }
    if (since) { params.push(since); where += ` and created_at >= $${params.length}`; }
    params.push(limit);
    const { rows } = await query(
      `select doc from reply_drafts where location_id = $1${where}
       order by created_at desc limit $${params.length}`,
      params
    );
    return rows.map((r) => r.doc);
  },
  async getReplyDraft(id) {
    const { rows } = await query(`select doc from reply_drafts where id = $1`, [id]);
    return rows[0]?.doc || null;
  },
  async updateReplyDraft(id, doc) {
    const { rowCount } = await query(
      `update reply_drafts set doc = $2, status = $3, updated_at = $4 where id = $1`,
      [id, doc, doc.status || "draft", doc.updatedAt || nowIso()]
    );
    return rowCount > 0;
  },
  // Retention: settled rows older than the cutoff go. Open, scheduled and
  // in-flight rows never do — a draft nobody answered is still a draft.
  async pruneReplyDrafts(locationId, beforeIso) {
    const { rowCount } = await query(
      `delete from reply_drafts where location_id = $1 and created_at < $2
         and status in ('sent', 'dismissed', 'superseded', 'handled')`,
      [locationId, beforeIso]
    );
    return rowCount;
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

  /* ---- dispositions (investor book) ---- */
  // Sync-time upsert: replaces the mirrored GHL data but never the local
  // lifecycle (status, last_blast_at) — same discipline as outreach agents.
  async upsertInvestors(locationId, rows) {
    let created = 0;
    let updated = 0;
    for (const r of rows) {
      // `xmax = 0` distinguishes an INSERT from a DO UPDATE in one round trip:
      // a freshly inserted tuple has no updating transaction stamped on it.
      // The alternative is a select-then-write per row, which doubles the
      // query count on a sync that already walks the whole book.
      const { rows: out } = await query(
        `insert into investors (id, location_id, contact_id, name, doc, buybox_text)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (location_id, contact_id)
         do update set name = excluded.name, doc = excluded.doc,
                       buybox_text = excluded.buybox_text, synced_at = now()
         returning (xmax = 0) as created`,
        [uuid(), locationId, r.contactId, r.name || null, r.doc, r.buyboxText || null]
      );
      if (out[0]?.created) created++;
      else updated++;
    }
    return { created, updated };
  },
  async listInvestors(locationId, { status = null, limit = 2000 } = {}) {
    const { rows } = status
      ? await query(
          `select contact_id as "contactId", name, status, buybox_text as "buyboxText",
                  doc, synced_at as "syncedAt", last_blast_at as "lastBlastAt"
           from investors where location_id = $1 and status = $2
           order by name nulls last limit $3`,
          [locationId, status, limit]
        )
      : await query(
          `select contact_id as "contactId", name, status, buybox_text as "buyboxText",
                  doc, synced_at as "syncedAt", last_blast_at as "lastBlastAt"
           from investors where location_id = $1
           order by name nulls last limit $2`,
          [locationId, limit]
        );
    return rows;
  },
  async getInvestor(locationId, contactId) {
    const { rows } = await query(
      `select contact_id as "contactId", name, status, buybox_text as "buyboxText",
              doc, synced_at as "syncedAt", last_blast_at as "lastBlastAt"
       from investors where location_id = $1 and contact_id = $2`,
      [locationId, contactId]
    );
    return rows[0] || null;
  },
  async setInvestorStatus(locationId, contactId, { status, lastBlastAt } = {}) {
    const { rowCount } = await query(
      `update investors set status = coalesce($3, status), last_blast_at = coalesce($4, last_blast_at)
       where location_id = $1 and contact_id = $2`,
      [locationId, contactId, status || null, lastBlastAt || null]
    );
    return rowCount > 0;
  },
  // Write back a locally-edited buy box (the GHL write already succeeded).
  async updateInvestorDoc(locationId, contactId, doc, buyboxText) {
    const { rowCount } = await query(
      `update investors set doc = $3, buybox_text = $4, synced_at = now()
       where location_id = $1 and contact_id = $2`,
      [locationId, contactId, doc, buyboxText || null]
    );
    return rowCount > 0;
  },
  // Drop investors who no longer carry any of the configured tags in GHL.
  // Called only after a FULL, untruncated sync — a partial page would delete
  // the tail of the book, so routes/dispo.js gates this on `truncated`.
  async deleteMissingInvestors(locationId, keepContactIds) {
    const keep = [...new Set(keepContactIds || [])];
    // Explicit ::text[] cast — without it Postgres has to infer the array
    // element type from an untyped parameter, which fails on an all-numeric
    // set of contact ids.
    const { rowCount } = keep.length
      ? await query(`delete from investors where location_id = $1 and not (contact_id = any($2::text[]))`, [locationId, keep])
      : await query(`delete from investors where location_id = $1`, [locationId]);
    return rowCount;
  },

  /* ---- contact record (the app's own memory of a person) ---- */
  // Person-scoped and permanent: nothing re-syncs over these rows and the
  // investor prune never sees them. See schema.pg.sql for the shapes.
  async getContactProfile(locationId, contactId) {
    const { rows } = await query(
      `select id, location_id as "locationId", contact_id as "contactId", party, name, email, phone, tags, facts,
              ghl_seen_at as "ghlSeenAt", projected_at as "projectedAt", created_at as "createdAt", updated_at as "updatedAt"
         from contact_profiles where location_id = $1 and contact_id = $2`,
      [locationId, contactId]
    );
    return rows[0] || null;
  },
  // Merge patch: only the keys given change. `facts` is replaced whole — the
  // caller computed the merge with addFact/removeFact and hands back the doc.
  async upsertContactProfile(locationId, contactId, patch = {}) {
    const { rows } = await query(
      `insert into contact_profiles (id, location_id, contact_id, party, name, email, phone, tags, facts, ghl_seen_at, projected_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict (location_id, contact_id) do update set
         party = coalesce(excluded.party, contact_profiles.party),
         name = coalesce(excluded.name, contact_profiles.name),
         email = coalesce(excluded.email, contact_profiles.email),
         phone = coalesce(excluded.phone, contact_profiles.phone),
         tags = case when $12::boolean then excluded.tags else contact_profiles.tags end,
         facts = case when $13::boolean then excluded.facts else contact_profiles.facts end,
         ghl_seen_at = coalesce(excluded.ghl_seen_at, contact_profiles.ghl_seen_at),
         projected_at = coalesce(excluded.projected_at, contact_profiles.projected_at),
         updated_at = now()
       returning id, location_id as "locationId", contact_id as "contactId", party, name, email, phone, tags, facts,
                 ghl_seen_at as "ghlSeenAt", projected_at as "projectedAt", created_at as "createdAt", updated_at as "updatedAt"`,
      [uuid(), locationId, contactId, patch.party ?? null, patch.name ?? null, patch.email ?? null, patch.phone ?? null,
       JSON.stringify(patch.tags ?? []), JSON.stringify(patch.facts ?? {}), patch.ghlSeenAt ?? null, patch.projectedAt ?? null,
       patch.tags !== undefined, patch.facts !== undefined]
    );
    return rows[0];
  },
  async listContactProfiles(locationId, { party = null, limit = 5000 } = {}) {
    const params = [locationId];
    let where = "";
    if (party) { params.push(party); where = ` and party = $${params.length}`; }
    params.push(limit);
    const { rows } = await query(
      `select id, location_id as "locationId", contact_id as "contactId", party, name, email, phone, tags, facts,
              ghl_seen_at as "ghlSeenAt", projected_at as "projectedAt", created_at as "createdAt", updated_at as "updatedAt"
         from contact_profiles where location_id = $1${where} order by updated_at desc limit $${params.length}`,
      params
    );
    return rows;
  },
  // Append-only. A row whose dedupe key already exists is skipped, not an
  // error — that is the whole point of the key.
  async appendContactEvents(locationId, contactId, events = []) {
    let inserted = 0;
    let skipped = 0;
    for (const e of events) {
      if (!e?.type || !e.at) { skipped++; continue; }
      const { rowCount } = await query(
        `insert into contact_events (id, location_id, contact_id, party, type, at, address, offer_id, deal_id, source, ref, dedupe_key, data)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         on conflict (location_id, contact_id, dedupe_key) where dedupe_key is not null do nothing`,
        [e.id || uuid(), locationId, contactId, e.party || null, e.type, e.at, e.address || null, e.offerId || null, e.dealId || null,
         e.source || "operator", e.ref || null, e.dedupeKey || null, JSON.stringify(e.data || {})]
      );
      if (rowCount) inserted++;
      else skipped++;
    }
    return { inserted, skipped };
  },
  async listContactEvents(locationId, contactId, { limit = 500, since = null, types = null } = {}) {
    const params = [locationId, contactId];
    let where = "";
    if (since) { params.push(since); where += ` and at >= $${params.length}`; }
    if (Array.isArray(types) && types.length) { params.push(types); where += ` and type = any($${params.length}::text[])`; }
    params.push(limit);
    const { rows } = await query(
      `select id, contact_id as "contactId", party, type, at, address, offer_id as "offerId", deal_id as "dealId", source, ref,
              dedupe_key as "dedupeKey", data, created_at as "createdAt"
         from contact_events where location_id = $1 and contact_id = $2${where}
         order by at desc, created_at desc limit $${params.length}`,
      params
    );
    return rows.map((r) => ({ ...r, at: r.at instanceof Date ? r.at.toISOString() : r.at }));
  },
  async listContactEventsByOffer(locationId, offerId, { limit = 200 } = {}) {
    const { rows } = await query(
      `select id, contact_id as "contactId", party, type, at, address, offer_id as "offerId", deal_id as "dealId", source, ref,
              dedupe_key as "dedupeKey", data, created_at as "createdAt"
         from contact_events where location_id = $1 and offer_id = $2 order by at desc limit $3`,
      [locationId, offerId, limit]
    );
    return rows.map((r) => ({ ...r, at: r.at instanceof Date ? r.at.toISOString() : r.at }));
  },
  // Everything that happened in this location since `since`, oldest first.
  // The per-contact index cannot serve this; contact_events_loc_at_idx can.
  // The investor follow-up ladder and the funnel report are both built on it.
  async listContactEventsSince(locationId, sinceIso, { types = null, limit = 5000 } = {}) {
    const params = [locationId, sinceIso];
    let where = "";
    if (Array.isArray(types) && types.length) { params.push(types); where = ` and type = any($${params.length}::text[])`; }
    params.push(limit);
    const { rows } = await query(
      `select id, contact_id as "contactId", party, type, at, address, offer_id as "offerId", deal_id as "dealId", source, ref,
              dedupe_key as "dedupeKey", data, created_at as "createdAt"
         from contact_events where location_id = $1 and at >= $2${where}
         order by at asc limit $${params.length}`,
      params
    );
    return rows.map((r) => ({ ...r, at: r.at instanceof Date ? r.at.toISOString() : r.at }));
  },
  // The newest communication per contact — see lastActivityQuery for why it
  // has no window.
  async lastContactActivity(locationId, { types = null, limit = 5000 } = {}) {
    const { text, params } = lastActivityQuery({ locationId, types, limit });
    const { rows } = await query(text, params);
    return rows.map((r) => ({ ...r, at: r.at instanceof Date ? r.at.toISOString() : r.at }));
  },
  // The outcome projection the funnel report reads: enough of each offer to
  // count a status transition, a counter spread and a pass reason, and nothing
  // else. Note the window is on created_at — a status can land on an offer
  // created long before it, so callers widen the horizon themselves.
  async listOfferOutcomesSince(locationId, sinceIso, { limit = 5000 } = {}) {
    const { rows } = await query(
      `select id, contact_id as "contactId", address, created_at as "createdAt",
              cash_amount as "cashAmount", status, status_at as "statusAt",
              coalesce(doc->'statusHistory', '[]'::jsonb) as "statusHistory",
              doc->'counter' as counter, doc->'deal' as deal,
              doc->'arv' as arv, doc->'repairs' as repairs
         from offers where location_id = $1 and created_at >= $2
         order by created_at asc limit $3`,
      [locationId, sinceIso, limit]
    );
    return rows.map((r) => ({
      ...r,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
      statusAt: r.statusAt instanceof Date ? r.statusAt.toISOString() : r.statusAt,
      cashAmount: r.cashAmount == null ? null : Number(r.cashAmount),
    }));
  },

  /* ---- job cursors ---- */
  async getJobCursor(locationId, name) {
    const { rows } = await query(
      `select at, doc from job_cursors where location_id = $1 and name = $2`, [locationId, name]);
    if (!rows[0]) return null;
    const at = rows[0].at;
    return { at: at instanceof Date ? at.toISOString() : at, doc: rows[0].doc || {} };
  },
  async setJobCursor(locationId, name, { at = nowIso(), doc = {} } = {}) {
    await query(
      `insert into job_cursors (location_id, name, at, doc) values ($1,$2,$3,$4)
       on conflict (location_id, name) do update set at = excluded.at, doc = excluded.doc`,
      [locationId, name, at, doc]
    );
    return { at, doc };
  },

  async contactRecordStats(locationId) {
    const { rows } = await query(
      `select (select count(*) from contact_profiles where location_id = $1)::int as profiles,
              (select count(*) from contact_events where location_id = $1)::int as events,
              (select count(*) from contact_events where location_id = $1 and source = 'import')::int as "importedEvents",
              (select max(created_at) from contact_events where location_id = $1 and source = 'import') as "lastImportAt"`,
      [locationId]
    );
    return rows[0];
  },

  /* ---- Zillow comp inbox ---- */
  // Resolve a location from a capture token. The bookmarklet has no
  // location_id — the token IS the credential, so this is the one lookup that
  // maps an opaque string back to a tenant. Kept to an exact match on the
  // settings blob so a malformed token can't pattern-match its way in.
  async findLocationByCaptureToken(token) {
    const { rows } = await query(
      `select location_id as "locationId" from offer_settings
       where doc->>'captureToken' = $1 limit 1`,
      [token]
    );
    return rows[0]?.locationId || null;
  },
  async addCompCaptures(locationId, items) {
    const saved = [];
    for (const item of items) {
      const id = uuid();
      const doc = { ...item, id, locationId, createdAt: nowIso() };
      // Re-grabbing the same house refreshes it rather than stacking
      // duplicates — you often revisit a comp after looking at more photos.
      const { rows } = await query(
        `insert into comp_captures (id, location_id, zpid, address, doc)
         values ($1,$2,$3,$4,$5)
         on conflict (location_id, zpid) where zpid is not null
         do update set doc = $5, address = $4, created_at = now()
         returning doc`,
        [id, locationId, item.zpid || null, item.address || null, doc]
      );
      if (rows[0]) saved.push(rows[0].doc);
    }
    // Housekeeping on write: a stale comp is worse than no comp, and nobody
    // will ever come here to clean up by hand.
    await query(`delete from comp_captures where location_id = $1 and created_at < now() - interval '30 days'`, [locationId]);
    return saved;
  },
  async listCompCaptures(locationId, { limit = 200 } = {}) {
    const { rows } = await query(
      `select doc from comp_captures where location_id = $1 order by created_at desc limit $2`,
      [locationId, limit]
    );
    return rows.map((r) => r.doc);
  },
  async deleteCompCaptures(locationId, ids = null) {
    const { rowCount } = ids?.length
      ? await query(`delete from comp_captures where location_id = $1 and id = any($2::uuid[])`, [locationId, ids])
      : await query(`delete from comp_captures where location_id = $1`, [locationId]);
    return rowCount;
  },

  /* ---- investor datarooms ---- */
  async createDataroom(doc) {
    const id = doc.id || uuid();
    const ts = nowIso();
    const full = { ...doc, id, createdAt: ts, updatedAt: ts, status: doc.status || "active" };
    await query(
      `insert into datarooms (id, location_id, offer_id, address, status, doc, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$7)`,
      [id, full.locationId, full.offerId || null, full.address || null, full.status, full, ts]
    );
    return full;
  },
  async getDataroom(id) {
    const { rows } = await query(`select doc from datarooms where id = $1`, [id]);
    return rows[0]?.doc || null;
  },
  async listDatarooms(locationId, { offerId = null, limit = 200 } = {}) {
    const { rows } = offerId
      ? await query(
          `select doc from datarooms where location_id = $1 and offer_id = $2 order by created_at desc limit $3`,
          [locationId, offerId, limit]
        )
      : await query(
          `select doc from datarooms where location_id = $1 order by created_at desc limit $2`,
          [locationId, limit]
        );
    return rows.map((r) => r.doc);
  },
  async updateDataroom(id, doc) {
    const full = { ...doc, updatedAt: nowIso() };
    const { rowCount } = await query(
      `update datarooms set doc = $2, status = $3, updated_at = $4 where id = $1`,
      [id, full, full.status || "active", full.updatedAt]
    );
    return rowCount > 0 ? full : null;
  },
  async deleteDataroom(id) {
    await query(`delete from dataroom_events where dataroom_id = $1`, [id]).catch(() => {});
    await query(`delete from dataroom_invites where dataroom_id = $1`, [id]).catch(() => {});
    const { rowCount } = await query(`delete from datarooms where id = $1`, [id]);
    return rowCount > 0;
  },

  // Invites. Columns (not doc) carry everything the token lookup and the
  // lockout counter touch, so a hot path is one indexed read/write.
  async createDataroomInvite(row) {
    const id = row.id || uuid();
    await query(
      `insert into dataroom_invites
         (id, dataroom_id, location_id, token_hash, contact_id, name, phone, status, expires_at, doc)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, row.dataroomId, row.locationId, row.tokenHash,
       row.contactId || null, row.name || null, row.phone || null, row.status || "active",
       row.expiresAt || null, row.doc || {}]
    );
    return this.getDataroomInvite(id);
  },
  async getDataroomInvite(id) {
    const { rows } = await query(`${INVITE_SELECT} where id = $1`, [id]);
    return rows[0] || null;
  },
  async getDataroomInviteByTokenHash(tokenHash) {
    const { rows } = await query(`${INVITE_SELECT} where token_hash = $1`, [tokenHash]);
    return rows[0] || null;
  },
  async listDataroomInvites(dataroomId) {
    const { rows } = await query(`${INVITE_SELECT} where dataroom_id = $1 order by created_at`, [dataroomId]);
    return rows;
  },
  // Every link ever issued to one contact, newest first — the Conversation
  // AI reads it to tell an investor "you opened it twice" from "not yet".
  async listDataroomInvitesByContact(locationId, contactId, { limit = 50 } = {}) {
    const { rows } = await query(
      `${INVITE_SELECT} where location_id = $1 and contact_id = $2 order by created_at desc limit $3`,
      [locationId, contactId, limit]
    );
    return rows;
  },
  // Partial update by column name (camelCase keys map to the snake_case
  // columns in INVITE_COLUMNS). Unknown keys are ignored.
  async updateDataroomInvite(id, patch) {
    const sets = [];
    const vals = [id];
    for (const [k, v] of Object.entries(patch || {})) {
      const col = INVITE_COLUMNS[k];
      if (!col) continue;
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    }
    if (!sets.length) return this.getDataroomInvite(id);
    await query(`update dataroom_invites set ${sets.join(", ")} where id = $1`, vals);
    return this.getDataroomInvite(id);
  },

  async logDataroomEvent(dataroomId, inviteId, kind, detail = {}) {
    await query(
      `insert into dataroom_events (id, dataroom_id, invite_id, kind, detail) values ($1,$2,$3,$4,$5)`,
      [uuid(), dataroomId, inviteId || null, kind, detail]
    );
  },
  async listDataroomEvents(dataroomId, { limit = 200 } = {}) {
    const { rows } = await query(
      `select id, invite_id as "inviteId", kind, detail, created_at as "createdAt"
       from dataroom_events where dataroom_id = $1 order by created_at desc limit $2`,
      [dataroomId, limit]
    );
    return rows;
  },
};

// Columns the invite row exposes to callers, and the camelCase→column map
// updateDataroomInvite patches through.
const INVITE_COLUMNS = {
  status: "status", expiresAt: "expires_at",
  firstViewedAt: "first_viewed_at", lastViewedAt: "last_viewed_at", viewCount: "view_count",
  sentAt: "sent_at", name: "name", phone: "phone", contactId: "contact_id",
  tokenHash: "token_hash", doc: "doc",
};
const INVITE_SELECT = `select id, dataroom_id as "dataroomId", location_id as "locationId",
    token_hash as "tokenHash", contact_id as "contactId", name, phone, status,
    expires_at as "expiresAt", first_viewed_at as "firstViewedAt",
    last_viewed_at as "lastViewedAt", view_count as "viewCount", sent_at as "sentAt",
    created_at as "createdAt", doc
  from dataroom_invites`;

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
      data.datarooms = data.datarooms || {};
      data.dataroomInvites = data.dataroomInvites || {};
      data.dataroomEvents = data.dataroomEvents || [];
      data.offerPhotos = data.offerPhotos || {};
      data.offerVideos = data.offerVideos || {};
      data.dealDocs = data.dealDocs || {};
      data.compCaptures = data.compCaptures || {};
      data.investors = data.investors || {};
      data.jobCursors = data.jobCursors || {};
      data.replyDrafts = data.replyDrafts || {};
      data.contactProfiles = data.contactProfiles || {};
      data.contactEvents = data.contactEvents || {};   // "<loc>|<contact>" → [events]; never pruned (dev backend)
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
    async listOffers(locationId, { contactId = null, limit = 50, lean = false } = {}) {
      ensure();
      const rows = Object.values(data.offers)
        .filter((o) => o.locationId === locationId && (!contactId || o.contactId === contactId))
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
        .slice(0, limit);
      return lean ? rows.map(toListOffer) : rows;
    },
    async listDeals(locationId, { limit = 200 } = {}) {
      ensure();
      return Object.values(data.offers)
        .filter((o) => o.locationId === locationId && o.deal)
        .sort((a, b) => (b.deal.createdAt || "").localeCompare(a.deal.createdAt || ""))
        .slice(0, limit);
    },
    // The file backend has no columns to mirror, so it filters the docs the
    // Postgres index exists to avoid scanning. Same answer, same order.
    async listOffersForFollowUp(locationId, { statuses = [...OPEN_STATUSES], before = null, limit = 200 } = {}) {
      ensure();
      const want = new Set(statuses);
      return Object.values(data.offers)
        .filter((o) => o.locationId === locationId && want.has(effectiveStatus(o)))
        .filter((o) => !before || !(o.statusAt || o.createdAt) || (o.statusAt || o.createdAt) <= before)
        .sort((a, b) => String(a.statusAt || a.createdAt || "").localeCompare(String(b.statusAt || b.createdAt || "")))
        .slice(0, limit)
        .map(toListOffer);
    },
    // Nothing to fill: the file backend reads status off the doc every time.
    async backfillOfferStatusColumns() { return 0; },
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
      for (const kind of ["pdf", "image", "scopepdf", "compspdf", "contractpdf", "assignmentpdf", "netsheetpdf"]) {
        fs.rmSync(path.join(DATA_DIR, "docs", `${id}.${kind}`), { force: true });
        fs.rmSync(path.join(DATA_DIR, "docs", `${id}.${kind}.meta`), { force: true });
      }
      for (const p of Object.values(data.offerPhotos)) if (p.offerId === id) delete data.offerPhotos[p.id];
      fs.rmSync(path.join(DATA_DIR, "photos", id), { recursive: true, force: true });
      for (const v of Object.values(data.offerVideos)) if (v.offerId === id) delete data.offerVideos[v.id];
      fs.rmSync(path.join(DATA_DIR, "video-posters", id), { recursive: true, force: true });
      for (const d of Object.values(data.dealDocs)) if (d.offerId === id) delete data.dealDocs[d.id];
      fs.rmSync(path.join(DATA_DIR, "deal-docs", id), { recursive: true, force: true });
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

    /* ---- deal attachments ---- */
    // Same split as the photos: metadata in store.json, bytes on disk under
    // DATA_DIR/deal-docs/<offerId>/ (dev only — production runs Postgres).
    async listDealDocs(offerId) {
      ensure();
      return Object.values(data.dealDocs)
        .filter((d) => d.offerId === offerId)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
    },
    async saveDealDoc(offerId, locationId, { kind, name, contentType, bytes }) {
      ensure();
      const id = crypto.randomUUID();
      const dir = path.join(DATA_DIR, "deal-docs", offerId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, id), bytes);
      const row = {
        id, offerId, locationId, kind, name, contentType,
        size: bytes.length,
        createdAt: new Date().toISOString(),
      };
      data.dealDocs[id] = row;
      persist();
      return row;
    },
    async readDealDocBytes(docId) {
      ensure();
      const row = data.dealDocs[docId];
      if (!row) return null;
      try {
        return {
          name: row.name,
          contentType: row.contentType,
          bytes: fs.readFileSync(path.join(DATA_DIR, "deal-docs", row.offerId, docId)),
        };
      } catch {
        return null;
      }
    },
    async deleteDealDoc(offerId, docId) {
      ensure();
      const row = data.dealDocs[docId];
      if (!row || row.offerId !== offerId) return false;
      delete data.dealDocs[docId];
      fs.rmSync(path.join(DATA_DIR, "deal-docs", offerId, docId), { force: true });
      persist();
      return true;
    },

    /* ---- property photos ---- */
    // Metadata lives in store.json; BYTES DO NOT. persist() rewrites the whole
    // JSON file on every write, so a single photo in there would re-serialize
    // megabytes on every subsequent dataroom event.
    async listOfferPhotos(offerId) {
      ensure();
      return Object.values(data.offerPhotos)
        .filter((p) => p.offerId === offerId)
        .sort((a, b) =>
          a.sort - b.sort ||
          String(a.createdAt).localeCompare(String(b.createdAt)) ||
          a.id.localeCompare(b.id));
    },
    async saveOfferPhoto(offerId, locationId, { variants, width, height, caption = null, source = "upload" }) {
      ensure();
      const id = crypto.randomUUID();
      const dir = path.join(DATA_DIR, "photos", offerId);
      fs.mkdirSync(dir, { recursive: true });
      for (const [variant, v] of Object.entries(variants)) {
        fs.writeFileSync(path.join(dir, `${id}.${variant}`), v.bytes);
        fs.writeFileSync(path.join(dir, `${id}.${variant}.meta`), v.contentType);
      }
      const maxSort = Object.values(data.offerPhotos)
        .filter((p) => p.offerId === offerId)
        .reduce((m, p) => Math.max(m, p.sort), -1);
      const row = {
        id, offerId, locationId, source, caption,
        sort: maxSort + 1,
        width: width || null, height: height || null,
        createdAt: new Date().toISOString(),
      };
      data.offerPhotos[id] = row;
      persist();
      return row;
    },
    async readPhotoBytes(photoId, variant) {
      ensure();
      const row = data.offerPhotos[photoId];
      if (!row) return null;
      try {
        const dir = path.join(DATA_DIR, "photos", row.offerId);
        return {
          bytes: fs.readFileSync(path.join(dir, `${photoId}.${variant}`)),
          contentType: fs.readFileSync(path.join(dir, `${photoId}.${variant}.meta`), "utf8"),
        };
      } catch {
        return null;
      }
    },
    async reorderOfferPhotos(offerId, ids) {
      ensure();
      ids.forEach((id, i) => {
        const row = data.offerPhotos[id];
        if (row && row.offerId === offerId) row.sort = i;
      });
      persist();
      return true;
    },
    async deleteOfferPhoto(offerId, photoId) {
      ensure();
      const row = data.offerPhotos[photoId];
      if (!row || row.offerId !== offerId) return false;
      delete data.offerPhotos[photoId];
      const dir = path.join(DATA_DIR, "photos", offerId);
      for (const variant of ["full", "thumb"]) {
        fs.rmSync(path.join(dir, `${photoId}.${variant}`), { force: true });
        fs.rmSync(path.join(dir, `${photoId}.${variant}.meta`), { force: true });
      }
      persist();
      return true;
    },

    /* ---- property videos ---- */
    // Rows in store.json; bytes under DATA_DIR/videos via the r2.js local
    // fallback (video.js); posters as files like photo variants.
    async listOfferVideos(offerId) {
      ensure();
      return Object.values(data.offerVideos)
        .filter((v) => v.offerId === offerId)
        .sort((a, b) =>
          a.sort - b.sort ||
          String(a.createdAt).localeCompare(String(b.createdAt)) ||
          a.id.localeCompare(b.id));
    },
    async getOfferVideo(offerId, videoId) {
      ensure();
      const row = data.offerVideos[videoId];
      return row && row.offerId === offerId ? row : null;
    },
    async createOfferVideo(offerId, locationId, { id, name, contentType, sizeBytes, storageKey, uploadId }) {
      ensure();
      const maxSort = Object.values(data.offerVideos)
        .filter((v) => v.offerId === offerId)
        .reduce((m, v) => Math.max(m, v.sort), -1);
      const row = {
        id, offerId, locationId, status: "uploading", name: name || null, contentType,
        sizeBytes: sizeBytes || null, storageKey, uploadId: uploadId || null, caption: null,
        sort: maxSort + 1, width: null, height: null, durationS: null,
        createdAt: new Date().toISOString(),
      };
      data.offerVideos[id] = row;
      persist();
      return row;
    },
    async finishOfferVideo(offerId, videoId, { sizeBytes, width, height, durationS, posters = {} }) {
      ensure();
      const row = data.offerVideos[videoId];
      if (!row || row.offerId !== offerId) return null;
      const dir = path.join(DATA_DIR, "video-posters", offerId);
      fs.mkdirSync(dir, { recursive: true });
      for (const [variant, v] of Object.entries(posters)) {
        fs.writeFileSync(path.join(dir, `${videoId}.${variant}`), v.bytes);
        fs.writeFileSync(path.join(dir, `${videoId}.${variant}.meta`), v.contentType);
      }
      Object.assign(row, {
        status: "ready", sizeBytes: sizeBytes || null, width: width || null, height: height || null,
        durationS: durationS || null, uploadId: null,
      });
      persist();
      return row;
    },
    async readVideoPoster(videoId, variant) {
      ensure();
      const row = data.offerVideos[videoId];
      if (!row) return null;
      try {
        const dir = path.join(DATA_DIR, "video-posters", row.offerId);
        return {
          bytes: fs.readFileSync(path.join(dir, `${videoId}.${variant}`)),
          contentType: fs.readFileSync(path.join(dir, `${videoId}.${variant}.meta`), "utf8"),
        };
      } catch {
        return null;
      }
    },
    async deleteOfferVideo(offerId, videoId) {
      ensure();
      const row = data.offerVideos[videoId];
      if (!row || row.offerId !== offerId) return null;
      delete data.offerVideos[videoId];
      const dir = path.join(DATA_DIR, "video-posters", offerId);
      for (const variant of ["full", "thumb"]) {
        fs.rmSync(path.join(dir, `${videoId}.${variant}`), { force: true });
        fs.rmSync(path.join(dir, `${videoId}.${variant}.meta`), { force: true });
      }
      persist();
      return row;
    },

    async createReplyDraft(doc) {
      ensure();
      const id = doc.id || uuid();
      const ts = nowIso();
      const full = { ...doc, id, createdAt: ts, updatedAt: doc.updatedAt || ts };
      data.replyDrafts[id] = full;
      persist();
      return full;
    },
    async listReplyDrafts(locationId, { status = null, contactId = null, since = null, limit = 100 } = {}) {
      ensure();
      return Object.values(data.replyDrafts)
        .filter((d) => d.locationId === locationId)
        .filter((d) => !status || (Array.isArray(status) ? status.includes(d.status) : d.status === status))
        .filter((d) => !contactId || d.contactId === contactId)
        .filter((d) => !since || (d.createdAt || "") >= since)
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
        .slice(0, limit);
    },
    async getReplyDraft(id) {
      ensure();
      return data.replyDrafts[id] || null;
    },
    async updateReplyDraft(id, doc) {
      ensure();
      if (!data.replyDrafts[id]) return false;
      data.replyDrafts[id] = doc;
      persist();
      return true;
    },
    async pruneReplyDrafts(locationId, beforeIso) {
      ensure();
      let n = 0;
      for (const [id, d] of Object.entries(data.replyDrafts)) {
        if (d.locationId === locationId && (d.createdAt || "") < beforeIso && ["sent", "dismissed", "superseded", "handled"].includes(d.status)) {
          delete data.replyDrafts[id];
          n++;
        }
      }
      if (n) persist();
      return n;
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

    /* ---- dispositions (investor book) ---- */
    async upsertInvestors(locationId, rows) {
      ensure();
      let created = 0;
      let updated = 0;
      for (const r of rows) {
        const k = `${locationId}|${r.contactId}`;
        const prev = data.investors[k];
        data.investors[k] = {
          // Lifecycle survives the sync; everything else is replaced.
          status: prev?.status || "active",
          lastBlastAt: prev?.lastBlastAt || null,
          createdAt: prev?.createdAt || nowIso(),
          locationId,
          contactId: r.contactId,
          name: r.name || null,
          doc: r.doc,
          buyboxText: r.buyboxText || null,
          syncedAt: nowIso(),
        };
        if (prev) updated++;
        else created++;
      }
      persist();
      return { created, updated };
    },
    async listInvestors(locationId, { status = null, limit = 2000 } = {}) {
      ensure();
      return Object.values(data.investors)
        .filter((i) => i.locationId === locationId && (!status || i.status === status))
        .sort((a, b) => String(a.name || "￿").localeCompare(String(b.name || "￿")))
        .slice(0, limit);
    },
    async getInvestor(locationId, contactId) {
      ensure();
      return data.investors[`${locationId}|${contactId}`] || null;
    },
    async setInvestorStatus(locationId, contactId, { status, lastBlastAt } = {}) {
      ensure();
      const row = data.investors[`${locationId}|${contactId}`];
      if (!row) return false;
      if (status) row.status = status;
      if (lastBlastAt) row.lastBlastAt = lastBlastAt;
      persist();
      return true;
    },
    async updateInvestorDoc(locationId, contactId, doc, buyboxText) {
      ensure();
      const row = data.investors[`${locationId}|${contactId}`];
      if (!row) return false;
      row.doc = doc;
      row.buyboxText = buyboxText || null;
      row.syncedAt = nowIso();
      persist();
      return true;
    },
    async deleteMissingInvestors(locationId, keepContactIds) {
      ensure();
      const keep = new Set(keepContactIds || []);
      let removed = 0;
      for (const [k, i] of Object.entries(data.investors)) {
        if (i.locationId !== locationId || keep.has(i.contactId)) continue;
        delete data.investors[k];
        removed++;
      }
      if (removed) persist();
      return removed;
    },

    /* ---- contact record ---- */
    async getContactProfile(locationId, contactId) {
      ensure();
      return data.contactProfiles[`${locationId}|${contactId}`] || null;
    },
    async upsertContactProfile(locationId, contactId, patch = {}) {
      ensure();
      const k = `${locationId}|${contactId}`;
      const prev = data.contactProfiles[k];
      const row = {
        id: prev?.id || uuid(), locationId, contactId,
        party: patch.party ?? prev?.party ?? null,
        name: patch.name ?? prev?.name ?? null,
        email: patch.email ?? prev?.email ?? null,
        phone: patch.phone ?? prev?.phone ?? null,
        tags: patch.tags !== undefined ? patch.tags : (prev?.tags || []),
        facts: patch.facts !== undefined ? patch.facts : (prev?.facts || {}),
        ghlSeenAt: patch.ghlSeenAt ?? prev?.ghlSeenAt ?? null,
        projectedAt: patch.projectedAt ?? prev?.projectedAt ?? null,
        createdAt: prev?.createdAt || nowIso(),
        updatedAt: nowIso(),
      };
      data.contactProfiles[k] = row;
      persist();
      return row;
    },
    async listContactProfiles(locationId, { party = null, limit = 5000 } = {}) {
      ensure();
      return Object.values(data.contactProfiles)
        .filter((p) => p.locationId === locationId && (!party || p.party === party))
        .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
        .slice(0, limit);
    },
    async appendContactEvents(locationId, contactId, events = []) {
      ensure();
      const k = `${locationId}|${contactId}`;
      const list = (data.contactEvents[k] = data.contactEvents[k] || []);
      const keys = new Set(list.map((e) => e.dedupeKey).filter(Boolean));
      let inserted = 0;
      let skipped = 0;
      for (const e of events) {
        if (!e?.type || !e.at || (e.dedupeKey && keys.has(e.dedupeKey))) { skipped++; continue; }
        const row = {
          id: e.id || uuid(), contactId, party: e.party || null, type: e.type, at: e.at, address: e.address || null,
          offerId: e.offerId || null, dealId: e.dealId || null, source: e.source || "operator", ref: e.ref || null,
          dedupeKey: e.dedupeKey || null, data: e.data || {}, createdAt: nowIso(),
        };
        list.push(row);
        if (row.dedupeKey) keys.add(row.dedupeKey);
        inserted++;
      }
      if (inserted) persist();
      return { inserted, skipped };
    },
    async listContactEvents(locationId, contactId, { limit = 500, since = null, types = null } = {}) {
      ensure();
      return (data.contactEvents[`${locationId}|${contactId}`] || [])
        .filter((e) => (!since || e.at >= since) && (!types?.length || types.includes(e.type)))
        .sort((a, b) => String(b.at).localeCompare(String(a.at)) || String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, limit);
    },
    async listContactEventsSince(locationId, sinceIso, { types = null, limit = 5000 } = {}) {
      ensure();
      return Object.entries(data.contactEvents)
        .filter(([k]) => k.startsWith(`${locationId}|`))
        .flatMap(([, list]) => list)
        .filter((e) => e.at >= sinceIso && (!types?.length || types.includes(e.type)))
        .sort((a, b) => String(a.at).localeCompare(String(b.at)))
        .slice(0, limit);
    },
    async lastContactActivity(locationId, { types = null, limit = 5000 } = {}) {
      ensure();
      const newest = new Map();
      for (const [k, list] of Object.entries(data.contactEvents)) {
        if (!k.startsWith(`${locationId}|`)) continue;
        for (const e of list) {
          if (!e?.contactId || (types?.length && !types.includes(e.type))) continue;
          const prev = newest.get(e.contactId);
          if (!prev || String(e.at || "").localeCompare(String(prev.at || "")) > 0) newest.set(e.contactId, e);
        }
      }
      return [...newest.values()]
        .map((e) => ({ contactId: e.contactId, type: e.type, at: e.at, source: e.source || "", data: e.data || {} }))
        .slice(0, limit);
    },
    async listOfferOutcomesSince(locationId, sinceIso, { limit = 5000 } = {}) {
      ensure();
      return Object.values(data.offers)
        .filter((o) => o.locationId === locationId && (o.createdAt || "") >= sinceIso)
        .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
        .slice(0, limit)
        .map((o) => ({
          id: o.id, contactId: o.contactId || null, address: o.address || null,
          createdAt: o.createdAt, cashAmount: o.cashAmount ?? null,
          status: o.status || effectiveStatus(o), statusAt: o.statusAt || o.createdAt || null,
          statusHistory: o.statusHistory || [], counter: o.counter || null, deal: o.deal || null,
          arv: o.arv ?? null, repairs: o.repairs ?? null,
        }));
    },
    async getJobCursor(locationId, name) {
      ensure();
      return data.jobCursors[`${locationId}|${name}`] || null;
    },
    async setJobCursor(locationId, name, { at = nowIso(), doc = {} } = {}) {
      ensure();
      data.jobCursors[`${locationId}|${name}`] = { at, doc };
      persist();
      return { at, doc };
    },
    async listContactEventsByOffer(locationId, offerId, { limit = 200 } = {}) {
      ensure();
      return Object.entries(data.contactEvents)
        .filter(([k]) => k.startsWith(`${locationId}|`))
        .flatMap(([, list]) => list.filter((e) => e.offerId === offerId))
        .sort((a, b) => String(b.at).localeCompare(String(a.at)))
        .slice(0, limit);
    },
    async contactRecordStats(locationId) {
      ensure();
      const events = Object.entries(data.contactEvents).filter(([k]) => k.startsWith(`${locationId}|`)).flatMap(([, l]) => l);
      const imported = events.filter((e) => e.source === "import");
      return {
        profiles: Object.values(data.contactProfiles).filter((p) => p.locationId === locationId).length,
        events: events.length,
        importedEvents: imported.length,
        lastImportAt: imported.map((e) => e.createdAt).sort().pop() || null,
      };
    },

  /* ---- Zillow comp inbox ---- */
    async findLocationByCaptureToken(token) {
      ensure();
      for (const [locationId, doc] of Object.entries(data.offerSettings)) {
        if (doc && doc.captureToken && doc.captureToken === token) return locationId;
      }
      return null;
    },
    async addCompCaptures(locationId, items) {
      ensure();
      const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
      const saved = [];
      for (const item of items) {
        // Same dedupe rule as Postgres: a repeat grab of a known zpid updates
        // in place instead of stacking a duplicate.
        const existing = item.zpid
          ? Object.values(data.compCaptures).find((c) => c.locationId === locationId && c.zpid === item.zpid)
          : null;
        const id = existing?.id || uuid();
        const full = { ...item, id, locationId, createdAt: nowIso() };
        data.compCaptures[id] = full;
        saved.push(full);
      }
      for (const [id, c] of Object.entries(data.compCaptures)) {
        if (c.locationId === locationId && Date.parse(c.createdAt || "") < cutoff) delete data.compCaptures[id];
      }
      persist();
      return saved;
    },
    async listCompCaptures(locationId, { limit = 200 } = {}) {
      ensure();
      return Object.values(data.compCaptures)
        .filter((c) => c.locationId === locationId)
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
        .slice(0, limit);
    },
    async deleteCompCaptures(locationId, ids = null) {
      ensure();
      const drop = ids?.length ? new Set(ids) : null;
      let n = 0;
      for (const [id, c] of Object.entries(data.compCaptures)) {
        if (c.locationId !== locationId) continue;
        if (drop && !drop.has(id)) continue;
        delete data.compCaptures[id];
        n++;
      }
      persist();
      return n;
    },

    /* ---- investor datarooms ---- */
    async createDataroom(doc) {
      ensure();
      const id = doc.id || uuid();
      const ts = nowIso();
      const full = { ...doc, id, createdAt: ts, updatedAt: ts, status: doc.status || "active" };
      data.datarooms[id] = full;
      persist();
      return full;
    },
    async getDataroom(id) {
      ensure();
      return data.datarooms[id] || null;
    },
    async listDatarooms(locationId, { offerId = null, limit = 200 } = {}) {
      ensure();
      return Object.values(data.datarooms)
        .filter((d) => d.locationId === locationId && (!offerId || d.offerId === offerId))
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
        .slice(0, limit);
    },
    async updateDataroom(id, doc) {
      ensure();
      if (!data.datarooms[id]) return null;
      const full = { ...doc, updatedAt: nowIso() };
      data.datarooms[id] = full;
      persist();
      return full;
    },
    async deleteDataroom(id) {
      ensure();
      if (!data.datarooms[id]) return false;
      delete data.datarooms[id];
      for (const [k, v] of Object.entries(data.dataroomInvites)) {
        if (v.dataroomId === id) delete data.dataroomInvites[k];
      }
      data.dataroomEvents = data.dataroomEvents.filter((e) => e.dataroomId !== id);
      persist();
      return true;
    },

    async createDataroomInvite(row) {
      ensure();
      const id = row.id || uuid();
      const full = {
        id,
        dataroomId: row.dataroomId,
        locationId: row.locationId,
        tokenHash: row.tokenHash,
        contactId: row.contactId || null,
        name: row.name || null,
        phone: row.phone || null,
        status: row.status || "active",
        expiresAt: row.expiresAt || null,
        firstViewedAt: null,
        lastViewedAt: null,
        viewCount: 0,
        sentAt: null,
        createdAt: nowIso(),
        doc: row.doc || {},
      };
      data.dataroomInvites[id] = full;
      persist();
      return full;
    },
    async getDataroomInvite(id) {
      ensure();
      return data.dataroomInvites[id] || null;
    },
    async getDataroomInviteByTokenHash(tokenHash) {
      ensure();
      return Object.values(data.dataroomInvites).find((i) => i.tokenHash === tokenHash) || null;
    },
    async listDataroomInvites(dataroomId) {
      ensure();
      return Object.values(data.dataroomInvites)
        .filter((i) => i.dataroomId === dataroomId)
        .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
    },
    async listDataroomInvitesByContact(locationId, contactId, { limit = 50 } = {}) {
      ensure();
      return Object.values(data.dataroomInvites)
        .filter((i) => i.locationId === locationId && i.contactId === contactId)
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
        .slice(0, limit);
    },
    async updateDataroomInvite(id, patch) {
      ensure();
      const row = data.dataroomInvites[id];
      if (!row) return null;
      Object.assign(row, patch);
      persist();
      return row;
    },

    async logDataroomEvent(dataroomId, inviteId, kind, detail = {}) {
      ensure();
      data.dataroomEvents.push({ id: uuid(), dataroomId, inviteId: inviteId || null, kind, detail, createdAt: nowIso() });
      if (data.dataroomEvents.length > 5000) data.dataroomEvents = data.dataroomEvents.slice(-5000);
      persist();
    },
    async listDataroomEvents(dataroomId, { limit = 200 } = {}) {
      ensure();
      return data.dataroomEvents
        .filter((e) => e.dataroomId === dataroomId)
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
