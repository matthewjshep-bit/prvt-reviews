-- schema.pg.sql — Dynamic Card Studio tables (Render-managed Postgres).
-- Apply with:  psql "$DATABASE_URL" -f schema.pg.sql
-- Safe to re-run (idempotent). UUIDs are generated in Node (crypto.randomUUID)
-- so no pgcrypto/uuid-ossp extension is required.

-- Template documents, one row per template, current version inline.
create table if not exists templates (
  id           uuid primary key,
  location_id  text not null,
  name         text not null,
  version      integer not null default 1,
  doc          jsonb not null,          -- full canonical template JSON
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists templates_location_idx on templates (location_id);

-- Version history (keep last 10 per template; enforced in app code).
create table if not exists template_versions (
  id           bigserial primary key,
  template_id  uuid not null references templates (id) on delete cascade,
  version      integer not null,
  doc          jsonb not null,
  created_at   timestamptz not null default now(),
  unique (template_id, version)
);

-- Render log: one row per render/generate attempt.
create table if not exists renders (
  id                uuid primary key,
  location_id       text,
  template_id       uuid,
  template_version  integer,
  contact_id        text,
  cache_key         text,
  r2_key            text,
  url               text,
  status            text,               -- 'ok' | 'error' | 'fallback'
  cached            boolean default false,
  duration_ms       integer,
  missing_bindings  jsonb,
  provider_results  jsonb,
  resolved_snapshot jsonb,
  error             text,
  created_at        timestamptz not null default now()
);
create index if not exists renders_template_idx on renders (template_id);
create index if not exists renders_cachekey_idx on renders (cache_key);

-- Uploaded image assets (metadata; bytes live in R2).
create table if not exists assets (
  id            uuid primary key,
  location_id   text not null,
  r2_key        text,
  url           text not null,
  content_type  text,
  bytes         integer,
  created_at    timestamptz not null default now()
);
create index if not exists assets_location_idx on assets (location_id);

-- Provider credentials, encrypted at rest (AES-256-GCM). `type` column exists
-- so OAuth connections can be added later without a migration.
create table if not exists connections (
  id           uuid primary key,
  location_id  text not null,
  name         text not null,
  provider     text,                    -- registry id or 'generic-http'
  type         text not null default 'header',  -- 'header' | 'bearer' | 'webhook'
  secret_enc   text not null,           -- base64(iv):base64(tag):base64(ciphertext)
  created_at   timestamptz not null default now()
);
create index if not exists connections_location_idx on connections (location_id);

-- Home-page send log + dedupe ledger. One row per contact per queue per send
-- attempt (dry runs are NOT logged). The per-queue 24h dedupe reads the most
-- recent row for (location, contact, section).
create table if not exists home_sends (
  id           bigserial primary key,
  location_id  text not null,
  section      text not null,          -- 'quotes' | 'reviews' | 'winback' | 'offers'
  contact_id   text not null,
  trigger_tag  text,                   -- tag applied to fire the workflow
  card_url     text,                   -- rendered card written for the workflow (if any)
  batch_id     text,                   -- groups a batch send
  created_at   timestamptz not null default now()
);
create index if not exists home_sends_dedupe_idx on home_sends (location_id, contact_id, section, created_at desc);
create index if not exists home_sends_batch_idx on home_sends (batch_id);

-- Last Test result per data source (discovered keys + thumbnail), so the editor
-- is useful on reload.
create table if not exists data_source_tests (
  id              bigserial primary key,
  location_id     text not null,
  template_id     uuid,
  source_id       text not null,
  discovered_keys jsonb,
  data            jsonb,
  thumbnail_key   text,
  thumbnail_url   text,
  created_at      timestamptz not null default now()
);
create index if not exists dst_lookup_idx on data_source_tests (location_id, template_id, source_id);
