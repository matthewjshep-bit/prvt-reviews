# PRVT MKT — Reviews (Messaging side)

Three small services that, together with a GoHighLevel sub-account, run the
review-request product. None of them is a big app — GHL does the heavy lifting
(contacts, SMS, A2P, billing); these add the custom layer.

```
cardgen/        Personalized review-card image service. Renders a customer's
                name onto your brand background. Public, stateless. GHL fetches
                it at send time.  → deploy on Render (Docker)

ghl-broker/     Backend that holds the GHL token and exposes 4 endpoints the
                Messaging page calls (config read/write, send-test, logo upload).
                → deploy on Render (Node)

messaging-app/  The iframe page that loads inside GHL's sidebar. Configures the
                owner/business name, logo, message mode, and follow-ups.
                → build with Vite, host the dist on Netlify (or serve from broker)
```

## Deploy order

Follow **RUNBOOK.md** — it goes in dependency order and passes a value from each
step to the next:

1. Deploy `cardgen` → get its URL.
2. Deploy `ghl-broker` with your GHL Private Integration token + the card URL →
   get its URL. Then add the broker's host to the card service's
   `ALLOWED_BG_HOSTS`.
3. Build + host `messaging-app` pointed at the broker.
4. Wire a GHL Custom Menu Link (agency level) to the page URL.
5. Test end-to-end from the sub-account.

## The chain, in one sentence

The page saves a logo URL into GHL custom values → the workflow's MMS step builds
`cardgen/card?name={{contact.first_name}}&bg={{custom_values.rh_logo_url}}` → the
card service renders the personalized image → GHL sends it. The broker is what
lets the page read and write those custom values securely.

## Prerequisites that aren't code

- A2P 10DLC registration approved (or SMS silently won't deliver).
- Google Business Profile connected in the sub-account (for the real review link).
- GHL Agency / SaaS tier (for white-label + Custom Menu Links).

Each folder has its own README with detail.
