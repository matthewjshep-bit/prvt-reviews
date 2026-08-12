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

POST   /api/datarooms               build a secure investor package from an offer
GET    /api/datarooms?offer_id=     list packages
GET    /api/datarooms/:id           package + invites + access log
PUT    /api/datarooms/:id           edit sections/notes, or refresh from the offer
POST   /api/datarooms/:id/revoke    kill (or restore) every link at once
POST   /api/datarooms/:id/invites   issue one investor's link + code, optionally texting it
POST   /api/datarooms/:id/invites/:inviteId/{send,revoke,reissue}

GET    /api/dashboard/summary        offers / app sends / outreach funnel per day
GET    /api/dashboard/ghl/tags       live GHL contact counts per tag (?tags=a,b)
GET    /api/dashboard/ghl/messages   GHL calls/texts/emails per day (bounded scan,
                                     10-min cache; needs conversations.readonly)
GET    /api/dashboard/ghl/contacts   GHL contacts created per day (dateAdded scan)
```

`POST /api/offers` attaches to the GHL contact: custom fields
`last_offer_amount` / `last_offer_date` / `last_offer_doc_url` (auto-created),
a note with the full terms + PDF link, and the `offer-created` tag.

## Investor datarooms

A dataroom is a private web page built from one deal — the numbers, the comps,
the scope, and the PDFs — that investors open from a text. It is served at
`/d/:token`, deliberately **outside** the location gate, because the people
opening it are not in the GHL account. The per-invite token is the credential:

- **The link is the credential.** A 256-bit random token — unguessable at any
  realistic request rate, and the same capability-URL model the offer PDFs
  already use. Only its SHA-256 is stored, so a database dump yields no working
  links. The plaintext exists solely in the response that mints it: lose it and
  you reissue (which kills the old one).
- **Personal, expiring, revocable.** One invite per investor, expiring in 14 days
  by default, killable individually or all at once and effective immediately —
  so a link that turns up somewhere it shouldn't can be cut without disturbing
  anyone else.
- **Proxied documents.** PDFs stream through `/d/:token/file/:kind`, never as R2
  URLs, so a copied document link dies with the invite.
- **Watermark + access log.** Each page carries the recipient's name, and every
  view, download, send, reissue, and revocation is logged for the operator.

There is deliberately **no access code** — the operator wanted a single tap from
the text. The tradeoff is that anyone who gets the link can open it, which is why
per-invite watermarking, the access log, and instant revocation matter: a leak is
attributable and cuttable, not silent.

The snapshot is frozen when the room is built, so later edits to the offer never
silently change what an investor already opened — the operator pushes updates
deliberately with `PUT /api/datarooms/:id { refresh: true }`.

Investor links are built from `PUBLIC_BASE_URL`, so that must be the broker's
real public hostname. Run the security checks with `npm run test:dataroom`.

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
