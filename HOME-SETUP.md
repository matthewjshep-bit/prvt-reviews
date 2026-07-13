# Home page — GHL configuration snapshot

The consolidated **Home** page (`messaging-app/home.html`) is the daily operating
screen: Quote Follow-Up, Reviews, Win-Back, and Offers. Every queue is a
**contact query** — a driving tag plus contact custom fields. No pipelines, no
opportunities. This checklist is everything you configure by hand in a GHL
sub-account so the page shows real queues and Send fires real workflows.

The broker resolves fields **by key** and tags **by name** at runtime. A missing
required field/tag is surfaced as a *Setup needed* banner in the UI — it never
crashes. Names below are the code defaults; each is overridable per location via
a Custom Value (see §5) with zero code changes.

---

## 1. Contact custom fields

Create these under **Settings → Custom Fields** (object: *Contact*). GHL derives
the field **key** from the name (lowercased, spaces → underscores); the derived
key must match the `key` column below. Type is a guide — everything is read as
text and parsed leniently.

| Section | Field name (suggested) | Key (must match) | Type | Required |
|---|---|---|---|---|
| Quotes | Quote Amount | `quote_amount` | Number | ✅ |
| Quotes | Quote Date | `quote_date` | Date | – |
| Quotes | Quote Expiry | `quote_expiry` | Date | – |
| Quotes | Property Address | `property_address` | Text | – |
| Reviews | Job Type | `job_type` | Text | – |
| Reviews | Job Completed Date | `job_completed_date` | Date | ✅ |
| Reviews | Review Rating | `review_rating` | Number | – |
| Win-Back | Last Service Date | `last_service_date` | Date | ✅ |
| Win-Back | Last Service Type | `last_service_type` | Text | – |
| Win-Back | Lifetime Value | `lifetime_value` | Number | – |
| Offers | Deal Count | `deal_count` | Number | ✅ |
| Offers | Deal Volume | `deal_volume` | Number | – |
| Offers | First Deal Date | `deal_first_date` | Date | – |
| Offers | Late Payment Count | `late_payment_count` | Number | – |
| Offers | Tier (override) | `tier` | Text | – |
| *(all)* | Card Image URL | `card_image_url` | Text | ✅ |

`card_image_url` is written by the broker at send time — the per-contact card is
rendered, its URL stored here, then the workflow MMS references
`{{contact.card_image_url}}`. (Override the key with the `CARD_FIELD_KEY` env.)

---

## 2. Tags

Create under **Settings → Tags** (or let your automations create them). Matched
case-insensitively.

**Queue membership** — a contact carrying this tag is *in* that queue:

| Tag | Queue |
|---|---|
| `quote-open` | Quote Follow-Up |
| `review-due` | Reviews |
| `winback-due` | Win-Back |
| `offer-eligible` | Offers |

**Status** — drive the row badges:

| Tag | Effect |
|---|---|
| `quote-replied` | Quote row shows **Replied** (else age-based *No reply Nd*) |
| `quote-no-reply` | (reserved; age is computed from `quote_date`) |
| `review-left` | Review row shows **Review left ★** |
| `review-reminder-scheduled` | Review row shows **Reminder scheduled** |

**Send triggers** — the broker applies these to fire the workflow (§4):

| Tag | Fires |
|---|---|
| `send-quote-followup` | Quote follow-up MMS + sequence |
| `send-review-request` | Review request MMS + reminder |
| `send-winback` | Win-back MMS |
| `send-offer` | Offer terms MMS |

---

## 3. Card Studio templates

Create in the Card Studio editor (the `Card Studio` tab / `?view=studio`). Each
section resolves its template **by name** (case-insensitive). Start from the
matching starter and bind the fields shown.

| Section | Template name | Base starter | Key bindings |
|---|---|---|---|
| Quotes | `Quote Follow-Up` | Property Card | `{{contact.custom.property_address}}`, `${{contact.custom.quote_amount}}` |
| Reviews | `Review Request` | Review Request | `{{contact.first_name}}`, star badge |
| Win-Back | `Property Card` | Property Card | `{{contact.custom.property_address}}` (parcel aerial) |
| Offers | `Offer Terms` | *(new dark card)* | `{{data.tier.rate}}`, `{{data.tier.down}}`, `{{data.tier.proof}}` |

**Offer Terms** is a dark 1080×1080 card: headline → two big numbers
(`{{data.tier.rate}}`, `{{data.tier.down}}`) → proof line (`{{data.tier.proof}}`).
`data.tier.*` is injected by the broker per contact from their resolved tier (§5).
For higher tiers whose terms live in an external system, attach an `http-json`
data source with id `tier` instead — the same `{{data.tier.*}}` bindings resolve.

---

## 4. Workflows

One workflow per trigger tag. Trigger: **Contact Tag added** → *(tag)*. Steps:

1. **Send MMS** — message body (see §5 defaults) + image `{{contact.card_image_url}}`.
2. **Wait / follow-up sequence** as desired.
3. (Optional) **Remove** the trigger tag so it can fire again later.

STOP handling and quiet hours are standard GHL SMS behavior and ride along
automatically. The broker never sends around DND — opted-out contacts are
excluded server-side before the tag is ever applied.

| Workflow trigger tag | Suggested name |
|---|---|
| `send-quote-followup` | Home · Quote follow-up |
| `send-review-request` | Home · Review request |
| `send-winback` | Home · Win-back |
| `send-offer` | Home · Offer terms |

---

## 5. Custom Values (optional per-location overrides)

Set under **Settings → Custom Values**. All optional — the code defaults are a
working baseline. Existing messaging config (`rh_business_name`,
`rh_owner_first_name`) already feeds `{{loc.business_name}}` /
`{{loc.owner_first_name}}`.

| Custom Value | Purpose | Default |
|---|---|---|
| `rh_home_quotes_template` | Quote template name override | `Quote Follow-Up` |
| `rh_home_reviews_template` | Review template name override | `Review Request` |
| `rh_home_winback_template` | Win-back template name override | `Property Card` |
| `rh_home_offers_template` | Offer template name override | `Offer Terms` |
| `rh_home_quotes_message` … `_offers_message` | Outgoing message override per section | code default |
| `rh_home_offer_tiers` | Tier rules + terms, JSON (see below) | Proven/Repeat/New |
| `rh_home_batch_cap` | Hard batch cap override | `CAMPAIGN_CAP` env (200) |
| `rh_review_link` | Fills `[Review Link]` in review copy | empty |

**`rh_home_offer_tiers`** JSON — highest matching `minDeals` wins; an explicit
`tier` field on a contact overrides:

```json
[
  { "id": "proven", "label": "Proven", "rule": { "minDeals": 4 }, "terms": { "rate": "9.0%",  "down": "10%" } },
  { "id": "repeat", "label": "Repeat", "rule": { "minDeals": 2 }, "terms": { "rate": "9.75%", "down": "10%" } },
  { "id": "new",    "label": "New",    "rule": { "minDeals": 0 }, "terms": { "rate": "10.5%", "down": "10%" } }
]
```

---

## 6. Broker environment

| Env | Effect |
|---|---|
| `CARD_SENDS_ENABLED=true` | **Required for real sends.** Unset ⇒ every send is a safe dry run. |
| `CAMPAIGN_CAP` | Hard recipients-per-run cap (default 200). |
| `CARD_FIELD_KEY` | Contact field the card URL is written to (default `card_image_url`). |
| `DATABASE_URL` | Postgres for the 24h send-dedupe ledger (`home_sends`). Without it the broker uses an ephemeral JSON file — dedupe won't survive restarts. |
| `CARD_SERVICE_URL` | cardgen render service (already required by Card Studio). |

Apply the schema once (adds `home_sends`): `psql "$DATABASE_URL" -f ghl-broker/schema.pg.sql`

---

## 7. GHL Custom Menu Links

Point one agency-level Custom Menu Link at the built `home.html` with
`?location_id={{location.id}}`. Because every section is split-ready, you can add
focused links later with **zero code changes**:

| Link | URL suffix |
|---|---|
| Home (all) | `home.html?location_id={{location.id}}` |
| Quotes only | `home.html?view=quotes&location_id={{location.id}}` |
| Reviews only | `home.html?view=reviews&location_id={{location.id}}` |
| Win-back only | `home.html?view=winback&location_id={{location.id}}` |
| Offers only | `home.html?view=offers&location_id={{location.id}}` |
| Card Studio | `home.html?view=studio&location_id={{location.id}}` |

---

## 8. Definition-of-done checklist

- [ ] Page loads fast (only the first section fetches on boot; others on scroll).
- [ ] Each queue shows real contacts from real GHL fields + tags.
- [ ] Selecting a contact renders their actual card (parcel aerial / terms card).
- [ ] Send applies the trigger tag → the workflow fires.
- [ ] A DND contact is refused server-side (skipped, reported).
- [ ] A win-back batch **Preview audience** matches the real send audience exactly.
- [ ] Offers **Send to all** produces a per-contact card with the correct tier's terms.
