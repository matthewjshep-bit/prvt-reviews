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

-- The pre-overhaul Card Studio / Home tables (templates, template_versions,
-- renders, assets, connections, home_sends, campaigns, journeys,
-- journey_enrollments, data_source_tests) are no longer used. They are left
-- in place so historical data survives; drop them manually when ready:
--   drop table if exists template_versions, templates, renders, assets,
--     connections, home_sends, campaigns, journey_enrollments, journeys,
--     data_source_tests cascade;
