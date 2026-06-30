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
