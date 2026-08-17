# Offer Generator — Go-Live Runbook

Three deployables, in dependency order: cardgen (Render/Docker), ghl-broker
(Render/Node), messaging-app (Netlify). One GHL wiring step at the end.

Current live hosts (dashboard-configured, auto-deploy on push to `main`):

- cardgen  → `https://prvt-reviews.onrender.com` (internal; broker-to-cardgen only)
- broker   → `https://offers.shepflips.com` (agent-facing) and
  `https://deals.shepflips.com` (investor-facing) — **the same Render service
  under two custom domains**; see "Two hostnames, one broker" below
- frontend → `https://app.shepflips.com` on Netlify (repo-root `netlify.toml`,
  base `messaging-app`; the Netlify UI "Base directory" must stay EMPTY for that
  toml to be read)

The original `.onrender.com` hostnames stay attached to their services
permanently. Every offer PDF link written into a GHL contact field, every note
body, and every dataroom link already texted to an investor is absolute on the
old host — leaving those domains connected is what keeps them resolving. Do not
remove them.

### Two hostnames, one broker

One Render service answers on both names; `PUBLIC_BASE_URL` and
`DATAROOM_BASE_URL` decide only which name gets *printed* into a link:

| Env var | Hostname | What it names |
|---|---|---|
| `PUBLIC_BASE_URL` | `offers.shepflips.com` | offer doc URLs, webhook targets |
| `DATAROOM_BASE_URL` | `deals.shepflips.com` | `/d/<token>`, teasers, `deals.json` deal + photo URLs |

`DATAROOM_BASE_URL` falls back to `PUBLIC_BASE_URL`, so a single-domain setup
still works with only the first one set.

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
PUBLIC_BASE_URL=https://offers.shepflips.com    # agent-facing links
DATAROOM_BASE_URL=https://deals.shepflips.com   # investor-facing links
DATABASE_URL=postgres://...       # Render Postgres; schema auto-applies on boot
# R2_* (optional) — when set, documents go to Cloudflare R2 instead of Postgres.
# R2_PUBLIC_BASE is the hostname on every offer PDF an agent opens — connect a
# custom domain (docs.shepflips.com) to the bucket and keep the old one attached
# so already-issued document URLs keep resolving.
APP_ORIGIN=https://app.shepflips.com     # frontend origin (cross-origin CORS)
# CARD_SENDS_ENABLED=true         # leave unset until you want live SMS sends
DATAROOM_FEED_LOCATIONS=          # locations allowed to publish a PUBLIC deals feed
# DATAROOM_FEED_TTL_MS=60000      # server memo for that feed; leave unset
```

`DATAROOM_BASE_URL` matters more than the rest: the public deals feed builds
absolute deal and photo URLs from it, so if it points at a hostname that no
longer resolves, the marketing site renders cards with dead links and broken
images. Check it resolves before relying on the feed.

`APP_ORIGIN` is comma-separated for CORS, but only its **first** entry is
written into the `offer_app_link` deep link on each contact. Put the canonical
console origin first; list any others (an old Netlify URL kept alive during a
cutover, the standalone Agent Outreach site) after it.

Token scopes: `contacts.readonly`, `contacts.write`,
`locations/customFields.readonly`, `locations/customFields.write`,
`conversations.write`, `conversations/message.write`, plus
`conversations.readonly` — required only for the Dashboard's calls/texts
panel (`/dashboard`); the dashboard shows a warning banner and keeps working
without it.

Sanity: `GET /` → `offer broker ok`, then
`POST /api/offers/calculate` with `{"location_id":"...","inputs":{"askingPrice":200000}}`.

### Publishing the deals board to a public website

`GET /d/deals.json?location_id=<id>` serves the location's board as JSON, so an
external marketing site (shepflips.com) can render the cards in its own brand
instead of iframing the dataroom — which is impossible anyway, since every
dataroom response sends `X-Frame-Options: DENY`.

It is **off for every location by default**. Two gates must both pass or it
answers 404, deliberately indistinguishable from an unknown location:

1. The location id appears in `DATAROOM_FEED_LOCATIONS` (comma-separated). This
   gate exists because the broker is multi-tenant and the feed is keyed on a
   location id rather than a 256-bit token — without it, any tenant's board
   would be readable by anyone who learned their id.
2. The location's portfolio dataroom is `status: active`. That is the publish
   switch: revoking the portfolio room takes the board off the website, and the
   site degrades to its link-out on its own.

Verify after deploy — the third command must print `0`, and the `url` from the
first must be on `deals.shepflips.com`, never the offers host:

```bash
DEALS=https://deals.shepflips.com
curl -s  "$DEALS/d/deals.json?location_id=$LOC" | jq '.count, .deals[0].url, .deals[0].photo.url'
curl -sI "$DEALS/d/deals.json?location_id=$LOC" | grep -i 'access-control\|cache-control'
curl -s  "$DEALS/d/deals.json?location_id=$LOC" | grep -ci 'notes\|comps\|assignmentFee'
```

The feed's cards link to each deal's **public teaser** (`/d/deal/<roomId>`), a
tokenless page showing only the room's `publicSections` (toggled in the deal's
Dataroom modal; documents and the fee breakdown are locked off server-side).
The full package still travels only by share/personal link — the feed carries
no tokens at all.

Three things to know once it's live:

- **The feed and the teaser write nothing.** No view counts, no access-log
  rows — both URLs are public, so every homepage visitor and every crawler
  would bury the log the operator reads. Real interest shows up when a visitor
  asks for their personal link (the teaser's closing card tells them how).
- **`GET /api/datarooms/portfolio` `views` goes flat.** It counts opens of the
  portfolio HTML page, and the website no longer sends anyone through it. Use
  the site's own analytics for "did anyone look at the board".
- **The share link stays out of the feed on purpose.** If it ever shows up in
  `deals.json`, that's a regression — the test suite pins this.

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

## Dispositions (investor book)

**Separate app, same Netlify site**, at the `/dispo` path:
`https://<site>/dispo?location_id=<LOCATION>`. Same deal as `/agents` — no extra
deploy or env, the SPA redirect serves the same bundle. Add it to GHL as another
Custom Menu Link pointing at `https://<site>/dispo?location_id={{location.id}}`.
(Own domain later: a second Netlify site with `VITE_APP_MODE=dispo`, plus that
origin in the broker's `APP_ORIGIN`.)

The acquisitions side (`/agents` → offers → deals) finds properties; this is the
other half — who buys them. It mirrors your investor contacts out of GHL, searches
them by **buy box**, and hands a shortlist to a GHL workflow.

1. **Sync** pulls every contact carrying an investor tag (default `investor`,
   `investor-active`, `investor-stale`, `on-deal`; override in Settings →
   "Dispositions"). Read-only against GHL, safe to run any time; it prunes
   contacts that lost their tag. Re-run it after tagging new buyers.
2. **Buy box** = the `buybox_*` / `rehab_appetite` contact custom fields the AI
   enrichment sweep already writes from your conversations. Edit one inline on
   the Investors page and only the fields you changed are written back to GHL —
   the sweep's other findings are never clobbered.
3. **Search** takes plain English ("cash buyers for a gut-job duplex in Tacoma
   under 400k"). The AI turns it into criteria — shown as removable chips so you
   can see and correct what it understood — then plain code drops the investors
   whose buy box contradicts it, and the AI ranks the rest with a reason each.
   A missing buy-box field never counts against an investor (nobody asked them
   yet ≠ they said no); tick **Only documented fits** to reverse that.
   Needs the Anthropic key in Settings → AI features. Without one the chips and
   filters still work — you just lose the plain-English box and the reasons.
4. **Find buyers** on a deal (Deals → open a deal) runs the same match from the
   deal's own numbers: area from the address, the price the *investor* would pay
   (contract + assignment fee), and rehab level from repairs ÷ ARV. Distinct
   from **Suggest from conversations** beside it: that asks who is already
   talking about this property, this asks whose buy box fits it.
5. **Tag & blast** applies a per-blast tag (`<prefix>-<deal>`, prefix in
   Settings) plus the `dispo-blast` trigger tag (`DISPO_TAG`). Build a GHL
   workflow on the trigger tag to send the deal. Live tagging requires
   `DISPO_BLASTS_ENABLED=true` on the broker; otherwise every blast is a
   dry-run preview.

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
- **Dispositions blasts are dry-run by default** — same double gate via
  `DISPO_BLASTS_ENABLED`. Syncing the investor book only reads from GHL, so it
  is deliberately not gated; the buy-box editor writes only changed fields.
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
