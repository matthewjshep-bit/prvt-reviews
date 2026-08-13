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
# R2_* (optional) — when set, documents go to Cloudflare R2 instead of Postgres
APP_ORIGIN=https://<your-netlify-site>   # frontend origin (cross-origin CORS)
# CARD_SENDS_ENABLED=true         # leave unset until you want live SMS sends
```

Token scopes: `contacts.readonly`, `contacts.write`,
`locations/customFields.readonly`, `locations/customFields.write`,
`conversations.write`, `conversations/message.write`, plus
`conversations.readonly` — required only for the Dashboard's calls/texts
panel (`/dashboard`); the dashboard shows a warning banner and keeps working
without it.

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

## Agent Outreach

**Separate app, same Netlify site.** Agent Outreach lives at the `/agents`
path: `https://<site>/agents?location_id=<LOCATION>` (own header/nav, no offer
tabs; the offers app at `/` does not show Agent Outreach). No extra deploy or
env needed — the SPA redirect serves the same bundle and the app switches on
the path. Add it to GHL as a second Custom Menu Link pointing at
`https://<site>/agents?location_id={{location.id}}`.

To later split it onto its own domain: deploy a second Netlify site from this
repo with env `VITE_APP_MODE=outreach`, and add that origin to the broker's
comma-separated `APP_ORIGIN`.


The Agent Outreach tab pulls active MLS listings from RentCast, groups them by
listing agent (each agent's most-fixer-like listing becomes the outreach
"hook"), flags agents already in GHL, and bulk-imports selected agents as
contacts. Every pull lands in a **batch** — a saved, named cohort you can
switch between, rename, and delete from the batch picker (auto-named
"zips · date"; renaming changes future import tags).

1. Settings → "Agent Outreach (RentCast)" → paste a RentCast API key
   (rentcast.io/api, free Developer tier = 50 requests/month) and set the
   default market (zips or city/state).
2. The first import auto-creates the contact custom fields (`hook_address`,
   `hook_price`, `hook_dom`, `hook_url`, `brokerage`) and tags each contact
   with the batch's tag (`agent-outreach-<batch-name-slug>` — always applied)
   plus the `agent-outreach` trigger tag when the checkbox is on (override the
   base with `OUTREACH_TAG`).
3. Build a GHL workflow triggered on the trigger tag to send the actual
   outreach (reference the hook fields in the message; set re-entry OFF) — or
   leave the checkbox off and add contacts to the workflow manually by
   filtering on the batch tag.
4. Live imports require `OUTREACH_IMPORTS_ENABLED=true` on the broker;
   otherwise every import is a dry-run preview.
5. Pulls are manual (button) today. For a nightly sync later, add a Render
   Cron Job: `curl -fsS -X POST "$BROKER_URL/api/outreach/pull" -H
   'Content-Type: application/json' -d '{"location_id":"<LOCATION>"}'` —
   the endpoint defaults its market params from Settings and lands in the
   most recent batch (auto-creating one if none exists); pass `"batchId"` to
   target a specific batch.

## Zillow comp capture (bookmarklet)

For comps found by eye on Zillow rather than pulled from the comps API.

1. Settings → **Zillow comp capture** → *Create the bookmarklet*. This mints a
   per-location `captureToken` server-side and returns a `javascript:` href.
2. **Drag** the "📍 Grab comp" button to the browser's bookmarks bar (clicking
   it inside the app does nothing but show a hint — it only works on Zillow).
3. On a Zillow property page it grabs that one comp; on a search-results page
   it offers to grab every result. Captures land in a server-side inbox and
   appear as **Zillow inbox (N)** on the Comps & ARV step.

Notes for whoever maintains this:

- The bookmarklet is only a **loader** — it fetches
  `GET /api/offers/comps/zgrab.js` fresh on every click. When Zillow changes
  its page structure, fix `ghl-broker/zgrab.js` and redeploy the broker; nobody
  has to re-drag their bookmark.
- The capture POST needs CORS for `zillow.com`, handled per-route in
  `routes/offers.js` (the global middleware in `broker.js` only covers
  `APP_ORIGIN`). If Zillow's CSP blocks the direct POST, the script falls back
  to opening `messaging-app/public/zcapture.html`, which relays the payload
  from our own origin. The payload travels in the URL fragment so the capture
  token never reaches a server log or a Referer header.
- `APP_ORIGIN` must be set on the broker for that fallback to have somewhere to
  go — it's the origin baked into the served script.
- **The bookmarklet can't be tested against localhost**: zillow.com is https,
  so a request to `http://localhost:3000` is blocked as mixed content. Test
  against the deployed broker or an https tunnel. To iterate on the extraction
  logic alone, paste the body of the served script into devtools on a Zillow
  page with the `fetch` call stubbed.
- The token is scoped to appending to the comp inbox and nothing else.
  *Regenerate* revokes it — the old bookmark 403s immediately.

## Safety rails

- **SMS sends are dry-run by default.** `POST /api/offers/:id/send` returns a
  preview unless the request passes `dryRun:false` AND the broker has
  `CARD_SENDS_ENABLED=true`.
- **Agent Outreach imports are dry-run by default** — same double gate via
  `OUTREACH_IMPORTS_ENABLED`.
- The broker rejects any `location_id` that doesn't match `GHL_LOCATION_ID`.
- Generated documents are stored in Postgres and served at /api/offers/:id/doc.(pdf|jpg) — no storage config needed; links survive redeploys. Setting the R2_* vars switches storage to R2.
- Offer creation degrades gracefully: if a GHL write fails (fields/note/tag),
  the offer + documents still save and the response lists per-step warnings.

## Shared modules

`shared/` is the source of truth. After editing `shared/offer-calc.js` (or the
template schema), run `node scripts/sync-shared.mjs` to refresh the vendored
copies in `ghl-broker/shared/` and `cardgen/shared/`, then redeploy the
affected service. The frontend imports `shared/` directly via the `@shared`
Vite alias.
