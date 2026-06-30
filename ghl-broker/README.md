# PRVT MKT — GHL Broker

The backend that sits between your iframe pages and GoHighLevel. It holds the
GHL token **server-side** (never in the browser) and answers the four calls the
Messaging page makes.

```
GET  /api/config?location_id=...   -> reads GHL custom values, returns config JSON
POST /api/config                   -> writes config back as GHL custom values
POST /api/send-test                -> sends a test SMS/MMS via the Conversations API
POST /api/upload-logo  (multipart) -> stores the logo, returns a public URL
```

## Why this exists

Your Messaging page can't call GHL directly — the token would be exposed inside
the iframe. So the page calls this broker, and the broker calls GHL with the
token. It's the same chain for the Dashboard page later.

## Setup

```bash
npm install
cp .env.example .env   # fill in the values
npm start              # broker on :4000
```

### Get the GHL token (single-tenant start)

1. In your sub-account: **Settings → Private Integrations → Create**.
   (If you don't see it, enable it under **Settings → Labs** first.)
2. Enable these scopes:
   - `locations/customValues.readonly`, `locations/customValues.write`
   - `contacts.readonly`, `contacts.write`
   - `conversations.write`, `conversations/message.write`
3. Copy the `pit-...` token into `GHL_TOKEN`, and put the sub-account ID in
   `GHL_LOCATION_ID`. The broker rejects any other location_id with that token.

## How the Messaging page points at it

In `MessagingPage.jsx`, `API_BASE` is the broker's origin. If you deploy the
page and the broker on the **same origin**, leave `API_BASE = ""`. If they're on
different origins, set `API_BASE` to the broker URL **and** set `APP_ORIGIN` in
the broker's env (CORS).

The `location_id` flows automatically: GHL puts it in the iframe URL → the page
reads it → it's sent on every broker call → the broker validates it.

## The custom-value contract

The broker reads/writes these GHL Custom Values (defined in `config.js`). Create
matching merge fields in your workflow:

| Config field        | GHL custom value        |
|---------------------|-------------------------|
| ownerName           | `rh_owner_first_name`   |
| businessName        | `rh_business_name`      |
| logoUrl             | `rh_logo_url`           |
| personalizedImage   | `rh_personalized_image` |
| smartEnabled        | `rh_smart_enabled`      |
| followUps           | `rh_follow_ups`         |
| mode                | `rh_message_mode`       |
| customTemplate      | `rh_custom_template`    |
| reviewLink          | `rh_review_link`        |

In the workflow's SMS/MMS step, the media URL is built from
`rh_logo_url` + the contact's first name (single-level merge, resolved at send
time) — **not** stored pre-baked, so GHL never has to resolve a merge field
inside another custom value:

```
https://cards.prvtmkt.com/card?name={{contact.first_name}}&bg={{custom_values.rh_logo_url}}
```

## Going multi-client (later)

Right now `getTokenFor(locationId)` returns the single env token. To serve many
clients, replace it with a lookup into a token store (a small table/KV keyed by
`location_id`, holding each client's OAuth access + refresh tokens from your
marketplace app), and refresh on expiry. Nothing else in the broker changes.

## Production notes

- **Uploads:** local disk works on a single host. For durability, store logos in
  S3 / Cloudflare R2 and return that URL from `/api/upload-logo`.
- **Conversations version:** the send-message call uses `Version: 2021-04-15`
  (the rest use `2021-07-28`). If that endpoint ever errors on version, flip it
  in `ghl.js`.
- **Verify location ownership:** the single-tenant guard is enough for your own
  account. Before real clients, add the marketplace signed **SSO** check so a
  spoofed `location_id` can't read another client's data.
- **Rate limit:** GHL bursts at 100 req / 10s. `saveConfig` writes sequentially
  to stay well under it.
