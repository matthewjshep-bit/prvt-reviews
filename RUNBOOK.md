# Offer Generator — Go-Live Runbook

Three deployables, in dependency order: cardgen (Render/Docker), ghl-broker
(Render/Node), messaging-app (Netlify). One GHL wiring step at the end.

Current live hosts (dashboard-configured, auto-deploy on push to `main`):

- cardgen  → `https://prvt-reviews.onrender.com`
- broker   → `https://prvt-reviews-1.onrender.com`
- frontend → Netlify (repo-root `netlify.toml`, base `messaging-app`; the
  Netlify UI "Base directory" must stay EMPTY for that toml to be read)

---

## Step 1 — cardgen (render service)

Render → Web Service → Docker (the Dockerfile installs the fonts — required).
No env is required for the offer-document path (the broker stores the files).

Sanity: `GET /` → `ok`.

## Step 2 — ghl-broker

Render → Web Service → Node (`npm install && npm start` in `ghl-broker/`).

Env (see `ghl-broker/.env.example` for the full annotated list):

```
GHL_TOKEN=pit-...                 # Private Integration token
GHL_LOCATION_ID=...               # single-tenant guard
CARD_SERVICE_URL=https://prvt-reviews.onrender.com
PUBLIC_BASE_URL=https://prvt-reviews-1.onrender.com
DATABASE_URL=postgres://...       # Render Postgres; schema auto-applies on boot
R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET / R2_PUBLIC_BASE
APP_ORIGIN=https://<your-netlify-site>   # frontend origin (cross-origin CORS)
# CARD_SENDS_ENABLED=true         # leave unset until you want live SMS sends
```

Token scopes: `contacts.readonly`, `contacts.write`,
`locations/customFields.readonly`, `locations/customFields.write`,
`conversations.write`, `conversations/message.write`.

Sanity: `GET /` → `offer broker ok`, then
`POST /api/offers/calculate` with `{"location_id":"...","inputs":{"askingPrice":200000}}`.

DB note: the schema (`ghl-broker/schema.pg.sql`) is applied idempotently on
boot. Tables from the pre-overhaul card-studio era are left untouched; the file
ends with a commented `drop` block to run manually when that history is no
longer needed.

## Step 3 — messaging-app (frontend)

Netlify auto-builds from `main` via the root `netlify.toml`. The API base
defaults to the live broker; override with `VITE_API_BASE` in Netlify env if
the broker URL ever changes.

Sanity: open `https://<site>/?location_id=<LOCATION>` — the New Offer screen
should load and contact search should return results.

## Step 4 — GHL wiring

1. Agency → Custom Menu Link → URL:
   `https://<netlify-site>/?location_id={{location.id}}` (iframe mode).
2. The first offer created auto-creates the contact custom fields
   (`last_offer_amount`, `last_offer_date`, `last_offer_doc_url`) and applies
   the `offer-created` tag — no manual field setup needed.

## Safety rails

- **SMS sends are dry-run by default.** `POST /api/offers/:id/send` returns a
  preview unless the request passes `dryRun:false` AND the broker has
  `CARD_SENDS_ENABLED=true`.
- The broker rejects any `location_id` that doesn't match `GHL_LOCATION_ID`.
- Offer creation degrades gracefully: if a GHL write fails (fields/note/tag),
  the offer + documents still save and the response lists per-step warnings.

## Shared modules

`shared/` is the source of truth. After editing `shared/offer-calc.js` (or the
template schema), run `node scripts/sync-shared.mjs` to refresh the vendored
copies in `ghl-broker/shared/` and `cardgen/shared/`, then redeploy the
affected service. The frontend imports `shared/` directly via the `@shared`
Vite alias.
