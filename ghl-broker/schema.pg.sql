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

-- The pre-overhaul Card Studio / Home tables (templates, template_versions,
-- renders, assets, connections, home_sends, campaigns, journeys,
-- journey_enrollments, data_source_tests) are no longer used. They are left
-- in place so historical data survives; drop them manually when ready:
--   drop table if exists template_versions, templates, renders, assets,
--     connections, home_sends, campaigns, journey_enrollments, journeys,
--     data_source_tests cascade;
