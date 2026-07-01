-- google_connections: stores Google Business Profile OAuth tokens per GHL location.
-- Run this in the Supabase SQL Editor or via the CLI.

create table if not exists google_connections (
  location_id          text primary key,
  google_access_token  text not null,
  google_refresh_token text not null,
  access_token_expiry  timestamptz not null,
  google_account_id    text,
  google_location_id   text,
  connected_at         timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- RLS on with no policies: the anon key can't read/write.
-- The broker's service-role key bypasses RLS automatically.
alter table google_connections enable row level security;
