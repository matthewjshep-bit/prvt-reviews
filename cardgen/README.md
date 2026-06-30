# PRVT MKT — Personalized Review-Card Service

A tiny public HTTP service that renders a per-recipient image: the customer's
name burned onto your brand background (the "Jessica!" card). GHL fetches it at
send time, so every contact gets a unique image from one URL pattern.

```
GET /card?name=Jessica&bg=https://cdn.yoursite.com/brand.png&brand=PRVT%20MKT
→ image/jpeg
```

The uploaded picture (`bg`) is the **background**; the name is overlaid on top
by this service. If `bg` is omitted it renders the name on a solid dark card
(with optional `brand` text up top).

## Query params

| Param    | Required | Default  | Notes |
|----------|----------|----------|-------|
| `name`   | yes      | `there`  | Customer name. Sanitized + length-capped at 40. |
| `bg`     | no       | dark card| URL of the brand/background image. See security note. |
| `brand`  | no       | —        | Brand text rendered top-center (use when there's no `bg`). |
| `w`,`h`  | no       | 1080     | Output dimensions (300–2000). |
| `format` | no       | `jpeg`   | `jpeg` (smaller, MMS-safe) or `png`. |
| `excite` | no       | `1`      | Appends `!` to the name. Set `0` to disable. |

## Run locally

```bash
npm install
npm start
# open http://localhost:3000/card?name=Jessica&brand=PRVT%20MKT
```

## Deploy

Any host that serves a public HTTPS URL works (GHL must be able to reach it).

- **Docker (recommended — fonts guaranteed):** the included `Dockerfile`
  installs DejaVu fonts. Deploy to Fly.io, Render, Railway, Cloud Run, etc.
- **Node buildpack (Render/Railway):** set start command `node server.js`. If
  the name renders blank, the base image is missing fonts — switch to the
  Docker deploy, or add a fonts install step.

Set these env vars in production:

- `ALLOWED_BG_HOSTS` — comma-separated allowlist of hosts permitted for `bg`,
  e.g. `cdn.prvtmkt.com,prvt-assets.s3.amazonaws.com`. **Set this.** Without it
  the endpoint will fetch any image URL (abuse / SSRF surface).
- `PORT` — defaults to 3000.

## Wiring it into GHL

You need the **final image URL** to be unique per contact. Two ways:

### A) Workflow (MMS attachment via custom value)
1. In the sub-account → **Settings → Custom Values**, add:
   - `logo_url` = the uploaded brand image URL (this is what your iframe's
     "Update" writes).
2. Add another custom value `card_url` =
   `https://cards.prvtmkt.com/card?name={{contact.first_name}}&bg={{custom_values.logo_url}}`
3. In the review-request **Workflow → Send SMS/MMS** action, set the message
   body, and in the **attachment / media URL** field insert `{{custom_values.card_url}}`.
4. At send time GHL resolves the merge fields → a unique URL per contact →
   fetches this service → attaches the rendered card.

> If merge-fields-inside-a-media-URL behave inconsistently in your workflow
> build, use path B for the initial send instead — it's bulletproof.

### B) Conversations API (your backend sends directly)
Best for the bulk personalized-image blast where you want exact control. For
each contact, build the URL yourself and post the message:

```js
const cardUrl =
  `https://cards.prvtmkt.com/card?name=${encodeURIComponent(firstName)}` +
  `&bg=${encodeURIComponent(logoUrl)}`;

await fetch("https://services.leadconnectorhq.com/conversations/messages", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${locationAccessToken}`,
    Version: "2021-04-15",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    type: "SMS",
    contactId,
    message: `Hi ${firstName}, thanks for choosing ${businessName}! A quick Google review really helps: ${reviewLink}`,
    attachments: [cardUrl],
  }),
});
```

(The `Version` header value and exact field names follow the current
LeadConnector Conversations API — confirm against the live docs when you build.)

## Notes & limits

- **MMS size:** carriers cap MMS media (often ~600KB–1MB). JPEG output at 1080px
  is typically 20–250KB, well under. Keep `bg` source images reasonable.
- **Caching:** identical `name`+`bg` is cached in memory and served with a
  1-day `Cache-Control`, so the same name isn't re-rendered repeatedly.
- **Failure handling:** if the `bg` fetch fails, the service falls back to a
  plain branded card so the MMS still sends rather than breaking the workflow.
- **Security:** `bg` is fetched server-side, so the host allowlist
  (`ALLOWED_BG_HOSTS`) is your main guard against SSRF/abuse. Private/internal
  IPs are blocked, scheme is restricted to http/https, content-type must be an
  image, and the source is size-capped.
- **Fonts:** rendering depends on a real installed font (DejaVu in the
  Dockerfile). On a fontless host the name renders blank — that's the #1
  deploy gotcha.
