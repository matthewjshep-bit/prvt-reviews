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
