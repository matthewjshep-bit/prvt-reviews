# Shep Flips — Offer Generator

A real-estate offer generator for GoHighLevel (in the spirit of lowballoffer.ai):
enter a property's numbers, get three ready-to-present offers (cash, seller
finance, lease option), generate a professional one-page offer document
(image + PDF), and attach the whole thing to the seller's GHL contact record.

```
ghl-broker/     The backend. Holds the GHL token (never the browser), runs the
                offer API (/api/offers): calculate → render document → store →
                write custom fields + note + tag on the contact.
                Also serves the investor datarooms at /d.
                → deploy on Render (Node)   [live: offers.shepflips.com for
                  agent-facing links, deals.shepflips.com for investor links —
                  one service, two custom domains]

cardgen/        Stateless render service (sharp/SVG). The broker posts it the
                offer-document template; it returns the letter-size JPEG that
                the broker also wraps into a PDF. Stores to R2 when configured.
                → deploy on Render (Docker) [live: prvt-reviews.onrender.com —
                  internal only, the broker is its only caller]

messaging-app/  The React iframe app (New Offer / History / Settings). Loads
                inside a GHL Custom Menu Link with ?location_id=.
                → build with Vite, hosted on Netlify (netlify.toml at repo root)
                  [live: app.shepflips.com]

shared/         Source of truth for shared modules. offer-calc.js (the offer
                math, used by broker + frontend), template-schema.js and
                bindings.js (used by cardgen). Vendored copies are synced with
                `node scripts/sync-shared.mjs`.
```

## The flow, in one sentence

The app sends property inputs to `POST /api/offers` → the broker calculates the
three offers, has cardgen draw the one-page offer letter, wraps it into a PDF,
stores both in R2, saves the offer, and writes it back onto the GHL contact
(`last_offer_amount`, `last_offer_date`, `last_offer_doc_url` custom fields, a
note with the full terms + document link, and an `offer-created` tag).

## Auto-underwrite

A GoHighLevel workflow can webhook an inbound agent text into a finished offer:
`POST /api/offers/automations/underwrite` reads the address out of the message,
pulls sold comps within half a mile (Zillow's sold map via Apify, or
RealEstateAPI), takes the top of their $/sqft spread as renovated, derives the
ARV from those only, scans the subject's photos into a priced scope of work, and
creates a blended offer through the same code path the New Offer page uses. It never
sends, and it saves a draft instead of an offer whenever the underwrite can't
clear its quality gates. See RUNBOOK.md → Auto-underwrite.

## Offer math (defaults, all editable in Settings)

Reverse engineered from lowballoffer.ai's shipped bundle (see the header of
`shared/offer-calc.js` for the decoded source):

Cash-only: offer = ~90% of ARV − repair adjustment − $30k assignment-fee
spread. The repair adjustment is piecewise: repairs + $30k when under $30k,
2× repairs in the normal band, and 2×(10% ARV) + 1.5×(excess) when repairs
exceed 10% of ARV. Deterministic "precision jitter" reproduces their
non-round anchor numbers (same inputs → same offer).

## Dev quickstart

```bash
# 1. render service
cd cardgen && npm i && node server.js                      # :8080

# 2. broker (JSON-file store when DATABASE_URL is unset)
cd ghl-broker && npm i
GHL_TOKEN=pit-... GHL_LOCATION_ID=... CARD_SERVICE_URL=http://localhost:8080 node broker.js   # :4000

# 3. app
cd messaging-app && npm i
VITE_API_BASE=http://localhost:4000 npm run dev            # open /?location_id=<id>
```

See **RUNBOOK.md** for production deploy + GHL wiring.
