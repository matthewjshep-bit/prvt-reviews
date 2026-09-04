-- schema.pg.sql — Offer Generator tables (Render-managed Postgres).
-- Apply with:  psql "$DATABASE_URL" -f schema.pg.sql
-- Safe to re-run (idempotent). UUIDs are generated in Node (crypto.randomUUID)
-- so no pgcrypto/uuid-ossp extension is required.

-- One row per generated offer. `doc` is the full offer record: inputs,
-- effective settings, calculated options, document URLs, GHL association.
create table if not exists offers (
  id           uuid primary key,
  location_id  text not null,
  contact_id   text,
  address      text,
  cash_amount  numeric,
  doc          jsonb not null,
  created_at   timestamptz not null default now()
);
create index if not exists offers_location_idx on offers (location_id, created_at desc);
create index if not exists offers_contact_idx on offers (location_id, contact_id);

-- Per-location calculation defaults (percentages, terms, company info printed
-- on the document). One row per location.
create table if not exists offer_settings (
  location_id  text primary key,
  doc          jsonb not null,
  updated_at   timestamptz not null default now()
);

-- Generated offer documents (PDF + JPEG bytes), served by the broker at
-- /api/offers/:id/doc.(pdf|jpg). Kept in Postgres so links survive deploys
-- with zero storage configuration; R2 is used instead when configured.
create table if not exists offer_documents (
  offer_id      uuid not null,
  kind          text not null,          -- 'pdf' | 'image'
  content_type  text not null,
  bytes         bytea not null,
  created_at    timestamptz not null default now(),
  primary key (offer_id, kind)
);

-- Property photos the operator uploaded, shown in the investor dataroom. Split
-- metadata from bytes so listing photos for a page never drags megabytes into
-- Node — `select * from offer_photos` is safe by construction.
--
-- Hero is simply sort = 0; there is deliberately no is_hero flag, because two
-- sources of truth for "which comes first" drift apart. `sort` is a plain int
-- with NO unique constraint: uniqueness would turn every reorder into a
-- constraint-violation shuffle through temporary values. Reads must always
-- `order by sort, created_at, id` so ties can't flip between page loads.
create table if not exists offer_photos (
  id            uuid primary key,
  offer_id      uuid not null,
  location_id   text not null,
  source        text not null default 'upload',
  caption       text,
  sort          int not null default 0,
  width         int,
  height        int,
  created_at    timestamptz not null default now()
);
create index if not exists offer_photos_offer_idx on offer_photos (offer_id, sort);

-- One row per (photo, size). `variant` is 'full' | 'thumb'; adding a card size
-- later is an insert, not a migration. storage_key is the seam for moving bytes
-- to R2 without changing any URL the investor sees.
create table if not exists offer_photo_bytes (
  photo_id      uuid not null references offer_photos (id) on delete cascade,
  variant       text not null,
  content_type  text not null,
  bytes         bytea,
  storage_key   text,
  primary key (photo_id, variant)
);

-- Property videos: the walkthrough the operator shot on their phone. The BYTES
-- are deliberately not here — a two-minute clip is a few hundred MB — they
-- live in R2 under storage_key (video.js) and stream to investors through the
-- token-gated dataroom routes with Range support. status is 'uploading' while
-- the browser is still sending parts and 'ready' once the object is complete;
-- investor pages list ready rows only. Posters are the small JPEGs the browser
-- grabbed from the first second, kept like photo variants so a gallery tile
-- costs a thumbnail, not a video.
create table if not exists offer_videos (
  id            uuid primary key,
  offer_id      uuid not null,
  location_id   text not null,
  status        text not null default 'uploading',
  name          text,
  content_type  text not null,
  size_bytes    bigint,
  storage_key   text not null,
  upload_id     text,
  caption       text,
  sort          int not null default 0,
  width         int,
  height        int,
  duration_s    real,
  created_at    timestamptz not null default now()
);
create index if not exists offer_videos_offer_idx on offer_videos (offer_id, sort);

create table if not exists offer_video_posters (
  video_id      uuid not null references offer_videos (id) on delete cascade,
  variant       text not null,
  content_type  text not null,
  bytes         bytea not null,
  primary key (video_id, variant)
);

-- Deal attachments: files the operator uploads against a deal (signed purchase
-- & sale, addenda, title work, inspection reports). Distinct from
-- offer_documents, which holds the ONE generated PDF/JPEG per kind — these are
-- many arbitrary files per offer, named by the operator.
--
-- Same metadata/bytes split as the photos, for the same reason: listing a
-- deal's attachments must never drag their bytes into Node.
create table if not exists deal_documents (
  id            uuid primary key,
  offer_id      uuid not null,
  location_id   text not null,
  kind          text not null default 'Other',  -- operator label, e.g. 'Purchase & sale'
  name          text not null,                  -- original filename
  content_type  text not null,
  size_bytes    int not null,
  created_at    timestamptz not null default now()
);
create index if not exists deal_documents_offer_idx on deal_documents (offer_id, created_at);

create table if not exists deal_document_bytes (
  document_id   uuid primary key references deal_documents (id) on delete cascade,
  bytes         bytea,
  storage_key   text
);

-- Agent Outreach: listing agents discovered from RentCast pulls.
-- agent_key encodes the dedupe identity: "e:<email>" else "p:<10-digit phone>"
-- else "n:<name-slug>|<office-slug>". Lifecycle lives in columns (not doc) so
-- pull-time upserts can replace doc without clobbering import status.
create table if not exists outreach_agents (
  id           uuid primary key,
  location_id  text not null,
  agent_key    text not null,
  status       text not null default 'new',   -- 'new' | 'skipped' | 'imported'
  contact_id   text,
  imported_at  timestamptz,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  doc          jsonb not null,
  unique (location_id, agent_key)
);
create index if not exists outreach_agents_loc_idx on outreach_agents (location_id, last_seen desc);
create index if not exists outreach_agents_status_idx on outreach_agents (location_id, status);

-- Listings backing the outreach agents. listing_key = "<mlsName>:<mlsNumber>"
-- (fallback: normalized address) so re-pulls upsert instead of duplicating.
create table if not exists outreach_listings (
  id           uuid primary key,
  location_id  text not null,
  listing_key  text not null,
  agent_key    text not null,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  doc          jsonb not null,
  unique (location_id, listing_key)
);
create index if not exists outreach_listings_agent_idx on outreach_listings (location_id, agent_key);

-- One row per RentCast pull (params, requestsUsed, counts) — powers the
-- month-to-date request meter in the UI (free tier = 50 requests/month).
create table if not exists outreach_pulls (
  id           uuid primary key,
  location_id  text not null,
  doc          jsonb not null,
  created_at   timestamptz not null default now()
);
create index if not exists outreach_pulls_loc_idx on outreach_pulls (location_id, created_at desc);

-- Agent Outreach batches: a saved, named cohort of agents. Pulls land in a
-- batch; the GHL import tag derives from the batch name.
create table if not exists outreach_batches (
  id           uuid primary key,
  location_id  text not null,
  name         text not null,
  auto_named   boolean not null default true,  -- false once the user renames
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists outreach_batches_loc_idx on outreach_batches (location_id, created_at desc);

-- Batch-scope agents + listings (each batch is an independent snapshot).
-- Legacy rows (batch_id null) are adopted into an "Earlier pulls" batch by
-- store init right after this file runs, so app code always has a batch_id.
alter table outreach_agents   add column if not exists batch_id uuid;
alter table outreach_listings add column if not exists batch_id uuid;
alter table outreach_agents   drop constraint if exists outreach_agents_location_id_agent_key_key;
alter table outreach_listings drop constraint if exists outreach_listings_location_id_listing_key_key;
create unique index if not exists outreach_agents_batch_agent_uniq
  on outreach_agents (location_id, batch_id, agent_key);
create unique index if not exists outreach_listings_batch_listing_uniq
  on outreach_listings (location_id, batch_id, listing_key);
create index if not exists outreach_agents_batch_idx on outreach_agents (location_id, batch_id, last_seen desc);
create index if not exists outreach_listings_batch_idx2 on outreach_listings (location_id, batch_id, agent_key);

-- Dispositions: the cash-buyer list, mirrored out of GHL so the whole book can
-- be filtered and ranked at once. GHL contacts stay the source of truth — this
-- is a rebuildable search cache (drop it and the next Sync restores it), the
-- same relationship outreach_agents has to RentCast.
--
-- Lifecycle columns (status, last_blast_at) live OUTSIDE `doc` for the same
-- reason they do on outreach_agents: a re-sync replaces doc wholesale, and
-- burying "we already blasted this buyer" in there would erase it every time
-- someone clicks Sync.
--
-- buybox_text is the flattened profile paragraph (shared/buybox.js
-- buildBuyboxProfile). It is denormalized out of doc deliberately: it's what
-- the ranker reads and what a future keyword index would cover, and computing
-- it per request for a few hundred investors is pure waste.
create table if not exists investors (
  id            uuid primary key,
  location_id   text not null,
  contact_id    text not null,
  name          text,
  status        text not null default 'active',   -- 'active' | 'archived'
  buybox_text   text,
  doc           jsonb not null,                   -- { name, email, phone, tags, buybox, lastConvoSummary, ... }
  synced_at     timestamptz not null default now(),
  last_blast_at timestamptz,
  created_at    timestamptz not null default now()
);
create unique index if not exists investors_contact_uniq on investors (location_id, contact_id);
create index if not exists investors_loc_idx on investors (location_id, synced_at desc);
create index if not exists investors_status_idx on investors (location_id, status);

-- Zillow comp inbox. The bookmarklet POSTs comps here from a Zillow tab; the
-- Comps & ARV pane pulls them into an offer later. This table exists because
-- the app runs in a GHL iframe on a different origin from zillow.com, so there
-- is no localStorage or postMessage channel between the two tabs — the server
-- is the only path between "I found a good comp" and "it's in my offer".
--
-- zpid is Zillow's own property id and is what dedupes a comp grabbed twice.
-- It can be null (a search-result card without one), so uniqueness is a
-- partial index rather than a column constraint.
create table if not exists comp_captures (
  id           uuid primary key,
  location_id  text not null,
  zpid         text,
  address      text,
  doc          jsonb not null,
  created_at   timestamptz not null default now()
);
create index if not exists comp_captures_loc_idx on comp_captures (location_id, created_at desc);
create unique index if not exists comp_captures_zpid_uniq
  on comp_captures (location_id, zpid) where zpid is not null;

-- Investor datarooms: a curated, investor-facing package for one deal
-- (address, numbers, comps, scope, documents). `doc` holds the snapshot taken
-- at build time plus the section toggles, so editing the offer afterwards
-- never silently changes what an investor already opened.
create table if not exists datarooms (
  id           uuid primary key,
  location_id  text not null,
  offer_id     uuid,
  address      text,
  status       text not null default 'active',   -- 'active' | 'revoked'
  doc          jsonb not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists datarooms_loc_idx on datarooms (location_id, created_at desc);
create index if not exists datarooms_offer_idx on datarooms (location_id, offer_id);

-- One invite per investor. The link token is NEVER stored — only its SHA-256,
-- so a database leak yields no working links. The token alone opens the room;
-- expiry and revocation are what bound it.
create table if not exists dataroom_invites (
  id              uuid primary key,
  dataroom_id     uuid not null,
  location_id     text not null,
  token_hash      text not null unique,
  contact_id      text,
  name            text,
  phone           text,
  status          text not null default 'active',   -- 'active' | 'revoked'
  expires_at      timestamptz,
  first_viewed_at timestamptz,
  last_viewed_at  timestamptz,
  view_count      int not null default 0,
  sent_at         timestamptz,
  created_at      timestamptz not null default now(),
  doc             jsonb not null default '{}'::jsonb
);
create index if not exists dataroom_invites_room_idx on dataroom_invites (dataroom_id, created_at);
create index if not exists dataroom_invites_loc_idx on dataroom_invites (location_id, created_at desc);

-- Access log: who opened what, when. Powers the "who's actually looking"
-- column the operator sees next to each investor.
create table if not exists dataroom_events (
  id           uuid primary key,
  dataroom_id  uuid not null,
  invite_id    uuid,
  kind         text not null,   -- 'view' | 'download' | 'sent' | 'reissued' | 'revoked'
  detail       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists dataroom_events_room_idx on dataroom_events (dataroom_id, created_at desc);

-- The pre-overhaul Card Studio / Home tables (templates, template_versions,
-- renders, assets, connections, home_sends, campaigns, journeys,
-- journey_enrollments, data_source_tests) are no longer used. They are left
-- in place so historical data survives; drop them manually when ready:
--   drop table if exists template_versions, templates, renders, assets,
--     connections, home_sends, campaigns, journey_enrollments, journeys,
--     data_source_tests cascade;

-- The reply agent's outbox. One row per drafted reply to a listing agent's
-- inbound text (see ghl-broker/reply-agent.js). `doc` carries the inbound
-- message, the draft, the model's read of the intent, and the gate result;
-- `status` is mirrored out of it so the open outbox and the daily cap are one
-- indexed query rather than a scan: 'draft' | 'sent' | 'dismissed' |
-- 'superseded'. Drafts live here rather than in memory because a draft that
-- vanishes on a redeploy is a text an agent sent that nobody answers.
create table if not exists reply_drafts (
  id           uuid primary key,
  location_id  text not null,
  contact_id   text,
  status       text not null default 'draft',
  doc          jsonb not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists reply_drafts_loc_idx on reply_drafts (location_id, status, created_at desc);
create index if not exists reply_drafts_contact_idx on reply_drafts (location_id, contact_id, created_at desc);
