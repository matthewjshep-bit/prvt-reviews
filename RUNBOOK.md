# Messaging Side — Go-Live Runbook

You have the Private Integration token. This is the order to wire everything up.
Three things get deployed (card service, broker, page) and one thing gets wired
(the Custom Menu Link). Do them in this order — each step feeds the next.

Keep these values handy as you go; you'll paste them between services:

- `TOKEN`     = your `pit-...` Private Integration token
- `LOCATION`  = the sub-account ID (e.g. PvdeT4y6MyupP0pKMMjz)
- `CARD_URL`  = filled in after Step 1
- `BROKER_URL`= filled in after Step 2
- `PAGE_URL`  = filled in after Step 3

---

## Step 1 — Deploy the card service

Folder: the `cardgen` files (render.js, server.js, Dockerfile, package.json).

1. Push it to a Git repo, then on Render: **New → Web Service → Docker**. (Use the
   Dockerfile — it installs the fonts, which is the #1 gotcha.)
2. Leave `ALLOWED_BG_HOSTS` blank **for now** — you'll set it in Step 2 once you
   know the broker's host.
3. Deploy. Copy the live URL → this is **`CARD_URL`** (e.g. `https://prvt-cards.onrender.com`).
4. Sanity check: open `CARD_URL/card?name=Jessica&brand=PRVT%20MKT` in a browser
   — you should see the card image.

---

## Step 2 — Deploy the broker

Folder: the `ghl-broker` files.

1. On Render: **New → Web Service** (plain Node, not Docker). Start command `node broker.js`.
2. Set env vars:
   - `GHL_TOKEN` = `TOKEN`
   - `GHL_LOCATION_ID` = `LOCATION`
   - `CARD_SERVICE_URL` = `CARD_URL` (from Step 1)
   - `PUBLIC_BASE_URL` = this broker's own URL (you'll know it after first deploy; set it, then redeploy)
3. Deploy. Copy the live URL → this is **`BROKER_URL`** (e.g. `https://prvt-api.onrender.com`).
4. **Now go back to the card service** and set `ALLOWED_BG_HOSTS` = the broker's
   hostname (e.g. `prvt-api.onrender.com`). This matters: uploaded logos live at
   `BROKER_URL/uploads/...`, and the card service fetches them via `?bg=`. Without
   this in the allowlist, the card render will reject the logo.
5. Sanity check: open `BROKER_URL/` → should say "broker ok".

> ⚠️ Render's disk is ephemeral — uploaded logos disappear on redeploy. Fine for
> testing. For production, switch `/api/upload-logo` to S3 / Cloudflare R2.

---

## Step 3 — Build & host the Messaging page

Folder: the `messaging-app` Vite project.

1. Open `src/MessagingPage.jsx`, find `const API_BASE = ""` near the top, and set
   it to your broker: `const API_BASE = "https://prvt-api.onrender.com";`
2. Build it:
   ```bash
   npm install
   npm run build
   ```
   This produces a `dist/` folder.
3. Deploy `dist/` to Netlify (drag-and-drop the folder at app.netlify.com/drop),
   Vercel, or Cloudflare Pages. Copy the URL → this is **`PAGE_URL`**.
4. Back in the broker env, set `APP_ORIGIN` = `PAGE_URL` (so the browser is allowed
   to call the broker cross-origin), and redeploy the broker.

> Simpler alternative: serve the page from the broker (same origin, no CORS).
> Copy `dist/` into a `public/` folder in the broker, add
> `app.use(express.static("public"))`, leave `API_BASE = ""`, and the page lives at
> `BROKER_URL`. Either path works.

---

## Step 4 — Connect Google (for real review links)

In the sub-account, connect the **Google Business Profile** via the reputation /
integrations flow. This is what produces the real review link. *Not required for
the send-test in Step 6 — required before you request real reviews.*

---

## Step 5 — Wire the Custom Menu Link (agency level)

1. Switch from the sub-account to the **Agency** view.
2. **Settings → Custom Menu Links → Create New.**
3. Title: `Messaging`. Pick an icon. Type: **Embedded Page (iFrame)**.
4. URL: `PAGE_URL/?location_id={{location.id}}`
   (e.g. `https://prvt-messaging.netlify.app/?location_id={{location.id}}`)
5. Show on the **sub-account** sidebar.

---

## Step 6 — Test the full loop

1. Open the sub-account → click **Messaging** in the sidebar. The page should load
   inside GHL and show your defaults.
2. Type an owner / business name → **Save changes**. Then check **Settings → Custom
   Values** in the sub-account — you should see `rh_business_name` etc. appear. (The
   broker auto-creates them on first save.)
3. Upload a logo → it posts to the broker and the preview updates.
4. Enter your own phone number in the field under the phone preview → **Send test
   message**. You should receive the SMS, with the personalized image attached if a
   logo is set.

> ⚠️ A2P 10DLC: if your number's 10DLC registration isn't approved yet, carriers
> may silently drop the test. If the test "sends" (no error) but nothing arrives,
> that's almost always A2P — start the registration if you haven't.

---

## What this gets you

When Step 6 works, the entire Messaging side is live: the page configures, the
broker persists to GHL, and the workflow (built separately) sends using those
custom values + the card service. The Dashboard page reuses this exact broker —
it's just one more endpoint and one more iframe page.

---

# Dynamic Card Studio (v2) — Go-Live

The Card Studio generalizes the single review card into template-driven,
per-contact images. It runs on the SAME three services; you add a database,
object storage, and (optionally) a Mapbox token. The legacy `/card` endpoint and
everything above still work — nothing regresses.

## New infrastructure

1. **Postgres** (Render-managed). Create it, copy the *Internal Database URL*.
   Apply the schema once:
   ```bash
   psql "$DATABASE_URL" -f ghl-broker/schema.pg.sql
   ```
   (The broker also applies it on boot; running it manually confirms access.)
   Without `DATABASE_URL` the broker falls back to a local JSON file — fine for
   dev, **not** for production (Render disks are ephemeral).

2. **Cloudflare R2** bucket behind a public domain (e.g. `cards.knownintown.com`).
   Create an S3 API token (Access Key + Secret). Rendered cards and provider
   caches are written here; MMS/iMessage fetch from the public domain, never
   from Render.

3. **Mapbox token** (only if you use the pin/parcel map providers).

## Env vars

**cardgen** (the render engine — holds the map + storage keys):
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
- `R2_PUBLIC_BASE` = `https://cards.knownintown.com`
- `MAPBOX_TOKEN` = `pk....` (optional; pin/parcel providers)
- `CARDGEN_PUBLIC_URL` = the card service's own URL (used only for the local
  fallback when R2 is off)
- `MAPBOX_PARCEL_KINGCOUNTY_URL` (optional) — override if the county GIS layer
  URL changes; new counties are added in `cardgen/providers/counties.js`.

**broker** (adds to the Step-2 vars):
- `DATABASE_URL` = Render Postgres internal URL
- `CARD_SERVICE_URL` = `CARD_URL` (already set in Step 2)
- `CONNECTIONS_KEY` = a long random string (AES-256-GCM key for provider
  credentials). Set it before anyone creates a Connection.
- `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` /
  `R2_PUBLIC_BASE` (broker uploads user image assets to the same bucket)
- `CARD_FIELD_KEY` (optional) — the contact custom field the webhook writes to
  (default `card_image_url`).

The iframe (`messaging-app`) needs **no** new secrets — it only ever talks to
the broker.

## First open = auto-migration

The first time a location opens the studio, the broker reads its legacy saved
image settings (logo, fit, colors, headline, name-box position) and seeds a
**Review Request** template from them. It renders visually-equivalent to the old
card; a test send confirms parity.

## Per-contact dynamic images in Workflows A/B/C

No new GHL features required. In each workflow, before the SMS/MMS step:

1. **Webhook** (POST) → `BROKER_URL/api/render/webhook`
   Body (JSON):
   ```json
   {
     "location_id": "{{location.id}}",
     "contactId": "{{contact.id}}",
     "templateId": "<paste the template id from the studio toolbar>"
   }
   ```
   The broker renders the card for that contact, stores it in R2, and **writes
   the public URL into the contact custom field** `card_image_url` (auto-created
   if missing). It responds within ~8s, or `202` and finishes the write shortly
   after — which the Wait below absorbs.

2. **Wait** — 30 seconds.

3. **SMS/MMS step** — attach the image `{{contact.card_image_url}}`.

That's the whole integration: Webhook → Wait → MMS. The same template rides all
three workflows; change the design once in the studio and every workflow follows.

## Providers & Connections (tie back to any service)

- **HTTP JSON** / **Image URL** — point at any REST or image endpoint, map fields
  with JSONPath, zero code. Public endpoints need no auth.
- **Make.com webhook** — POST card data to a Make scenario (e.g. the King County
  APN lookup) and render returned values.
- **Mapbox pin / parcel** — satellite maps with parcel outlines + lot size.
- **Connections** (studio toolbar) store API keys / bearer tokens / webhook URLs,
  encrypted with `CONNECTIONS_KEY`. Secrets are write-only — never returned by any
  API after saving. All outbound provider fetches are SSRF-guarded (https-only,
  private-IP + redirect-to-private blocked, GHL/own hosts blocked).
