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
# OFFER_COUNTERED_TAG / OFFER_NO_RESPONSE_TAG / OFFER_PASSED_TAG — offer-outcome
# tags mirrored onto the agent contact; defaults are fine unless a GHL workflow
# already owns those names.
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

## Auto-underwrite (inbound text → offer)

An agent texts "you still buying? 1234 NE 8th St, asking 525k" and an offer is
waiting in History a few minutes later. The broker does the whole New Offer
flow: reads the address out of the message (falling back to the thread for a
"what about that one?" follow-up), pulls comps, grades each one's renovation
condition from its sold Zillow photos, derives the ARV from **only** the
renovated/updated ones, scans the subject's listing photos into a priced scope
of work, and creates a **blended** offer with every document attached.

**Prerequisites.** Settings needs the Anthropic key and the Apify token. A
RealEstateAPI key is **not** required on the default settings. Two Render env
vars, neither of which the rest of the app uses:

```
AUTO_UNDERWRITE_SECRET=<openssl rand -base64 24 | tr -d '/+='>
AUTO_UNDERWRITE_ENABLED=true      # leave unset until you've watched a dry run
```

The secret goes in the workflow's webhook body as `"secret"`. It guards that one
route, which is the point — **do not** use `GHL_LOCATION_KEYS` for this instead.
That variable is enforced by `resolveLocation` on *every* request for the
location, so switching it on 403s every GHL custom menu link in the account
(Offers, Deals, Dashboard, Agents) until each URL is re-issued with `?key=`
appended. It is a worthwhile change on its own schedule — it also closes the
cleartext-keys hole on `GET /api/offers/settings` — but it is not a prerequisite
for this feature and should not be done in the same sitting.

### Where comps come from

Two Settings dropdowns, both defaulted to the cheap path:

**Comps from — `zillow` (default) or `realestateapi`.** Zillow scrapes the sold
map through Apify's `maxcopell/zillow-scraper`, which is the book the operator
already reads by eye and the only source whose $/sqft spread tracks finish
level. RealEstateAPI returns county + MLS records instead; it is authoritative
about *what* sold and vague about what it looked like.

The Zillow path needs no RealEstateAPI account at all — one Apify token covers
both the sold-comp search and the subject's own listing. Two consequences worth
knowing:

- Zillow's sold map has **no subject record**, so the search centre comes from a
  free Photon geocode and the subject's facts come from its Zillow listing. In
  the manual Comps pane that means beds/baths/sqft are no longer auto-filled for
  you — type them, and the search uses them. Switch the source back to
  `realestateapi` if you want that prefill.
- Zillow rows carry **no `yearBuilt` at all** (verified: 0 of 78 on a live
  pull), so the ±10-year era criterion goes quiet. The match scorecard abstains
  on unknowns rather than penalising them, so comps degrade in ranking, not in
  correctness — a comp scores "4/5" instead of "5/6".
- Zillow's sold map returns condos, townhouses, multi-family and vacant land
  alongside houses (9 of 33 within half a mile on that pull). `filterComps`
  excludes those types, because a townhouse in the comp set is a different
  product with a different buyer.
- A search row's top-level `price` is an abbreviated LABEL — `"$1.23M"` — and
  the `unformattedPrice` the actor's docs advertise does not exist. The real
  number is `hdpData.homeInfo.price`. `parseMoney` understands the suffix and
  rejects anything under $1,000, because a comp parsed as `$1.23` clears every
  other filter in the file and guts the ARV.

**Two pools, not one.** The comps that carry the ARV must be tight matches. The
pool the price proxy *ranks* has to be wide enough to have a top tier at all,
and these are not the same requirement — running both off one tight set was a
real bug, caught by measurement rather than reasoning:

> A live 78-comp pull around a 3/2, 1,610 sqft house in Lake Forest Park left a
> pool of **four** under the tight bands (beds exact, baths ±0.5, size ±20%).
> The proxy needs six. Every run on a perfectly ordinary address would have held
> for review.

So the pull uses pool bands (beds ±1, baths ±1, size ±30%, houses only, half a
mile — `UW_POOL_*` in `auto-underwrite.js`), the proxy marks the top ~35% by
$/sqft as renovated, and the ARV then takes the best-**matching** comps from
inside that tier. `compareByMatch` already scores beds, baths, size, era and
distance, so the tightening is done by the scorecard rather than by a second set
of hand-tuned numbers. On that address it yields 12 in the pool, a top tier of
4, and an ARV of $1,050,000 off comps scoring 5/5 and 4/5.

**Renovated comps decided by — `price` (default) or `ai`.** ARV means *after
repair* value, so it has to rest on comps that were themselves renovated.

`ai` reads each comp's sold listing photos with a vision model. It is the
accurate answer and it is expensive: a scrape plus a multi-image call per comp,
which is the single slowest and priciest stage in the whole pipeline.

`price` takes the top of the **$/sqft** spread inside a comp set already cut to
the same beds and baths, ±20% floor area and half a mile. Inside a box that
tight, most of what is left to explain the price spread *is* condition. Two
details make it honest rather than convenient:

- It ranks by $/sqft, not by price. Even inside a ±20% band the biggest house
  usually posts the biggest number, so ranking on price would mostly
  re-discover square footage.
- It refuses when there are fewer than 6 priced comps nearby. Calling the best
  3 of 3 "renovated" is circular — it just restates which comps you have — so
  the run holds for review and says so in those words.

`deriveArv` then takes the **median** of the marked tier, not the maximum, so a
single optimistic sale can't set the ARV on its own. Marked comps carry
`conditionSource: "price"` everywhere they travel, and the review panel says
"condition by $/sqft" rather than letting it read like someone looked at the
kitchen.

**Wiring it.** There are two front doors. Use the first one if you have a
qualifying bot; it is cheaper and more accurate.

*Door 1 — a Tier-1 / qualified trigger (recommended).* If a conversation bot
already qualifies the agent and captures the address, that bot IS the filter,
and its capture is better evidence than a one-shot extraction re-reading the
same thread. Trigger on **Opportunity Created** (filtered to the Tier 1
pipeline stage) or on the **Tier 1 tag being applied**, and hand the address
over:

```json
{ "location_id": "{{location.id}}", "secret": "<AUTO_UNDERWRITE_SECRET>",
  "contactId": "{{contact.id}}",
  "address": "{{contact.short_hand_property_address}}",
  "askingPrice": "{{contact.hook_price}}",
  "dryRun": false }
```

When `address` is present the run trusts it, marks the provenance
`address from the GHL workflow`, and **skips the extraction call entirely** —
one less Claude call and one less failure mode. No `message` is needed, which
is what makes an opportunity trigger (where there is no inbound message) work.

Point `address` at whichever field your bot writes. If the workflow can fire
before that field lands, either add a 1–2 minute **Wait** step first or also
pass `"message": "{{message.body}}"` — a blank address falls back to reading
the conversation rather than failing.

*Door 2 — Inbound Message.* No bot, or you want it to fire on any qualifying
text:

1. Trigger: **Inbound Message**.
2. Add your filter. The workflow decides which texts are worth spending on —
   the broker trusts it. Firing on every inbound text is what the daily cap
   exists to survive.
3. Action: **Webhook**, `POST`, to
   `https://offers.shepflips.com/api/offers/automations/underwrite`, body:

```json
{ "location_id": "{{location.id}}", "secret": "<AUTO_UNDERWRITE_SECRET>",
  "contactId": "{{contact.id}}", "message": "{{message.body}}", "dryRun": false }
```

Here the broker reads the address itself. It does **not** rely on the webhook
payload alone: it pulls the contact's last ~40 messages and resolves follow-ups
("what about that one?") against the earlier thread, then refuses to proceed
unless the street number, street name and city are all explicit somewhere in it.
Anything less than high confidence holds for review rather than underwriting a
guess.

Either door: the 24-hour dedupe keys on contact **+ address**, so a second
property surfaced by the same agent runs again while a follow-up about the same
one does not.

It answers `202` in milliseconds — a full run takes 2–5 minutes (the Apify
Zillow scrapes dominate) and the webhook action would time out otherwise.

**Watching it.** Three places, deliberately:

- The **Auto-underwrites** strip at the top of History — live runs only, with
  the phase and elapsed time; it disappears when nothing is running.
- The **AI review** filter chip (violet, last in the row, hidden entirely until
  the location has run one). It holds every auto-underwritten offer nobody has
  acted on: held drafts *and* offers that were built but not sent. The chip
  drains by itself — fix a draft and it becomes an offer, send an offer and it
  moves to `sent` — so there is no "reviewed" flag to remember to set. Rows
  carry an **AI** badge (amber `AI · review` when the run held), collapsed
  agent rows show an `N AI` count, and hovering the badge gives the full audit
  trail. Opening an offer shows a provenance panel: what address the run read,
  with what confidence, how many renovated comps and photos it used, and the
  ARV basis string. Typing `ai` in the search box works too.
- The agent's GHL contact record, moved through `uw-running` → `uw-done` /
  `uw-needs-review` / `uw-failed`, with a note at each end carrying the ARV,
  its basis, the comps used and the offer link.

Provenance is deliberately **not** a status. An auto-made offer travels the
same road as any other — not sent → sent → countered — so `isAiGenerated` is a
second, independent question you ask a row (`shared/offer-status.js`). Folding
the two together would have meant an AI offer stopped being one once it was
sent, which is exactly when you most want to know.

**When it holds.** A run stops and saves a **draft** rather than publishing if
it can't find 3 renovated/updated comps within 0.5 mi, if the address was read
with less than high confidence, if the ARV fell back to ungraded comps, if
fewer than 8 listing photos were scannable, if the scope lands more than 25%
past the heavy band for the house size, or if the photo scan flagged a possible
foundation problem. The draft carries everything already paid for — comps,
grades, scope — so reviewing it is "tick two more comps and hit Create", not a
restart. The full list is `evaluateGates` in `ghl-broker/auto-underwrite.js`;
that function is the whole safety argument and is worth reading before you turn
this on.

**Cost.** On the defaults (Zillow + price proxy): one Apify search, one Apify
listing scrape, and one Claude vision call for the scope of work — roughly
$0.20–0.60 and under a minute, plus one Claude text call when the address has to
be read from the conversation. Two runs at a time per location.

Switching condition to `ai` adds up to 6 more Apify scrapes and a second vision
call carrying ~36 images, which is what takes a run to $1–3 and 3–5 minutes.
That is the dial to turn if the price proxy is producing ARVs you don't trust in
a particular market.

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
- **Auto-underwrites are dry-run by default** — same double gate via
  `AUTO_UNDERWRITE_ENABLED`. A dry run still does all the work (and spends the
  Apify/Anthropic money); it just saves a draft instead of publishing an offer.
  Three further rails, because this is the one feature that spends money with
  nobody watching: the endpoint **requires** the location to be in
  `GHL_LOCATION_KEYS`, a per-location daily cap (Settings, default 25) counted
  from the database rather than memory so a crash loop can't reset it, and a
  24-hour dedupe on contact + address. An auto-underwrite never sends.
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

Two of them are load-bearing for the auto-underwrite and are easy to forget:

- `shared/arv.js` — the ARV derivation. It was client-only until the broker
  needed to compute an ARV without a browser; it is now vendored too.
- `shared/rehab-scope.js` — the rehab checklist's state shape, what an AI photo
  scan does to it, and what it costs. Extracted out of `RehabPane.jsx` for the
  same reason. **If you change the pricing, change it here** — the pane, the
  scope-of-work PDF and the automation all read this one function, and the
  whole point is that they can't quote different repair numbers.
