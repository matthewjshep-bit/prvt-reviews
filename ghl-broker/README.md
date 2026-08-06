# Offer Generator — Broker

The backend between the iframe app and GoHighLevel. It holds the GHL token
**server-side** (never in the browser), runs the offer math, drives cardgen to
render the offer document, and writes the offer onto the contact record.

## API (all location-scoped via ?location_id= / body.location_id)

```
GET    /api/offers/settings          calculation defaults for the location
PUT    /api/offers/settings
POST   /api/offers/calculate         pure calc — no side effects
POST   /api/offers/preview           render the document, return a data URL
GET    /api/offers/contacts?query=   GHL contact typeahead
POST   /api/offers                   create: calc + document (JPEG+PDF) + attach
GET    /api/offers?contact_id=       list saved offers
GET    /api/offers/:id
DELETE /api/offers/:id
POST   /api/offers/:id/send          text the offer doc (dry-run by default)

GET    /api/dashboard/summary        offers / app sends / outreach funnel per day
GET    /api/dashboard/ghl/tags       live GHL contact counts per tag (?tags=a,b)
GET    /api/dashboard/ghl/messages   GHL calls/texts/emails per day (bounded scan,
                                     10-min cache; needs conversations.readonly)
GET    /api/dashboard/ghl/contacts   GHL contacts created per day (dateAdded scan)
```

`POST /api/offers` attaches to the GHL contact: custom fields
`last_offer_amount` / `last_offer_date` / `last_offer_doc_url` (auto-created),
a note with the full terms + PDF link, and the `offer-created` tag.

## Setup

```bash
npm install
cp .env.example .env   # fill in the values
npm start              # broker on :4000
```

Storage: Postgres when `DATABASE_URL` is set (schema auto-applies on boot),
otherwise a local JSON file (dev only). Generated documents go to R2 when the
`R2_*` vars are set, otherwise to local `uploads/` (dev only).

Key files: `broker.js` (entry + CORS + location guard), `routes/offers.js`
(the whole product API), `shared/offer-calc.js` (vendored calc engine —
edit `/shared/offer-calc.js` and run `node ../scripts/sync-shared.mjs`),
`offer-doc.js` (document layout), `pdf.js` (JPEG→PDF), `ghl.js` (LeadConnector
client), `store.js` (Postgres/JSON store), `r2.js` (R2 uploads).
