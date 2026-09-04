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
# Object store (S3 protocol) — REQUIRED for property videos; nothing else needs
# it. A walkthrough is hundreds of MB and streams from the bucket through the
# broker's token-gated routes, so the bucket stays PRIVATE.
#
# Supabase Storage (the project this account already has):
#   1. Storage → New bucket → name it deal-videos, leave it private.
#   2. Project Settings → Storage → S3 Connection: turn it on, copy the Endpoint
#      and Region shown there, then "New access key" → copy the id and secret.
#   3. Set these on the Render service and let it redeploy:
S3_ENDPOINT=https://<project-ref>.supabase.co/storage/v1/s3
S3_REGION=<the region shown next to the endpoint, e.g. us-west-1>
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_BUCKET=deal-videos
#   4. Deploy check: the boot log prints "object store ok: deal-videos @ https://…".
#      "configured but not answering" means a typo above — the message says which.
#
# The free plan's 50 MB per-file limit does not matter: the broker stores each
# video as 8 MB objects and stitches them on playback. What the free plan does
# cap is the TOTAL — about 1 GB stored and 5 GB served per month — so roughly
# five walkthroughs, watched a couple of dozen times. Watch Storage → Usage;
# Pro lifts both by two orders of magnitude.
#
# Cloudflare R2 works the same way through R2_ACCOUNT_ID + R2_ACCESS_KEY_ID +
# R2_SECRET_ACCESS_KEY + R2_BUCKET (the endpoint is derived). R2_PUBLIC_BASE is
# separate and optional: set it and generated documents move from Postgres to
# the bucket under that hostname; leave it unset and they stay where they are.
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
`conversations.readonly` — required for the Dashboard's calls/texts panel
(`/dashboard`) and for the Conversation AI to read a thread before replying
— and `workflows.readonly`, which only fills the "add to a GHL workflow"
picker on the Conversation AI tab (the action itself needs just
`contacts.write`; without the scope you can paste a workflow id).

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
- **The price follows the deal; nothing else does.** A room's snapshot is
  frozen at build time, but contract price / assignment fee / assignment
  contract are re-pushed whenever the Deals tab saves new terms, and levelled
  again when the operator opens the room. Comps, scope, photos and notes still
  wait for **Refresh from the offer** — so a room can honestly show last
  week's comps at this morning's price, and never the reverse.

## Saving an offer vs. creating one

The editor has two save buttons once an offer exists, and they do different
things on purpose:

- **Save changes** (`PUT /api/offers/:id`) revises the offer that's open. Same
  id, so the letter and the companion PDFs are re-rendered over the same
  storage keys and the link an agent already has resolves to the new document.
  The URLs pick up a `?v=` stamp because those routes serve `immutable` for a
  year — without it a revision is invisible to anyone who already opened the
  old one.
- **Save as new offer** (`POST /api/offers`) is the original create path: a
  second offer on the same property, the first left untouched.

What a save deliberately does **not** touch: the offer's status and history,
its send ledger, its deal, and any PSA / purchase contract / assignment already
generated — those are signable paperwork and are never rewritten behind you.
The response lists any that now quote the old price so they can be regenerated
on purpose. On the CRM side a save refreshes the contact's `last_offer_*`
fields (unless a *newer* offer for that agent owns them) and writes one
`agent_deal_history` line, only when the number actually moved. It never adds a
second contact note — GHL notes are append-only.

Two derived surfaces follow a save automatically: the agent-facing offer page
(it publishes the very PDFs that were just re-rendered) and the investor
dataroom's price. A dataroom's comps and scope stay frozen until the operator
refreshes them, and the save response says how many rooms are behind.

Editing comps or rehab on an open offer autosaves to `PATCH
/api/offers/:id/workspace`, which writes the form workspace and nothing else —
no calculation, no documents, no CRM. Before this existed that autosave minted
a *draft* row beside the offer, which is how one property ended up with three
rows in History.

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
  free geocode (`ghl-broker/geocode.js`) and the subject's facts come from its
  Zillow listing. In the manual Comps pane that means beds/baths/sqft are no
  longer auto-filled for you — type them, and the search uses them. Switch the
  source back to `realestateapi` if you want that prefill.
- **When every run suddenly returns nothing.** The Zillow data comes from two
  Apify actors (`maxcopell/zillow-scraper` for the sold search,
  `maxcopell/zillow-detail-scraper` for the subject's listing and each comp's
  photos), and their OUTPUT SCHEMA is not a stable interface. On 2026-09-02
  both were rebuilt with every field renamed — `price` → `listingPrice.amount`,
  `latLong` → `coordinates`, `address` → `listingAddress` (an object),
  `photos` → `listingPhotos`, `homeStatus` → `listingStatus` — and every run
  from that minute reported zero comps and zero photos. Nothing errored: the
  rows arrived and could not be read.

  The tell is in the hold reason. "Zillow returned 21 sold rows for that box
  and not one carried a usable price and position" means the shape moved;
  "returned nothing at all" means the box was empty or the search didn't run.
  Check `https://api.apify.com/v2/acts/maxcopell~zillow-scraper` for
  `modifiedAt` — no token needed — and the store page carries the current
  field list. normalizeRow and fetchZillowPhotos read the curated names first
  and the old ones behind them, so both shapes work; add the new name in front
  when it moves again.

  It moved again the next morning (0.0.91, 2026-09-03T08:48Z), and the store
  page's example row did NOT show it: in map-marker mode the money objects
  arrive as `listingSoldPrice: {currency}` and `listingPrice: {currency,
  formatted: "$345,000"}` — no `amount` on either. 57 rows, 57 zeros, with the
  rename fix deployed. The parser now reads a money object as its amount and
  then as its label. The lesson is the method, not the field: don't verify
  against the vendor's documented example, verify against the LAST RUN. With
  the Apify token (Settings, or `apifyToken` from `GET /api/offers/settings`),
  `GET https://api.apify.com/v2/actor-runs?token=…&desc=1` lists the recent
  runs and `GET /v2/datasets/<defaultDatasetId>/items?token=…` is exactly what
  the broker was handed. Costs nothing and takes a minute.
- **When the AI scan fails with "disallowed by the website's robots.txt".**
  Anthropic fetches a `url` image source itself and honours robots.txt;
  Zillow's photo CDN (`photos.zillowstatic.com`) forbids it, so every scan of
  a Zillow-sourced listing 400'd before a photo was looked at, and comp grading
  came back "unknown" for every comp by the same path. Since 2026-09-03 the
  broker downloads the photos and sends them inline as base64
  (`loadImageBlocks` in `rehab-scan.js`), preferring Zillow's 1024px `-p_f`
  rendition (~200 KB) over the carousel's 1536px one (~650 KB) so forty of
  them fit the API's 32 MB request cap. If the error ever comes back, a
  `source: {type: "url"}` image block has crept in somewhere.

- **When an address won't geocode.** The geocoder asks the US Census (TIGER)
  first and OSM/Photon second, both free and keyless, and tries several
  spellings of the address at each. If neither can pin the house it falls back
  to the centre of the ZIP or the city and *labels* that — an auto-underwrite
  centred on a centroid always holds for review, and the Comps pane says so
  above the board. Photon alone used to be the whole of this, and it has no node
  for a great many ordinary US houses, which failed those runs outright.
- **A centroid is the symptom of a bad address parse, not of a bad house.**
  Every "zero comps, no ARV" run so far has traced back to one: the search was
  centred half a mile to twenty miles off and the comps around it are somebody
  else's neighbourhood. The rewrites on the ladder each exist for a live
  failure — a missing comma before the city ("Riverview Way E Enumclaw"), a
  street with no type ("2614 S 54th"), a unit number, a spelled-out ordinal.
  When a run holds on a centroid, look at the address FIRST: paste it into the
  Comps pane, and if that comes back on the wrong part of the map the fix
  belongs in `queryLadder`, not in the comp bands.
- **The run works from the address that resolved, not the one that was typed.**
  TIGER answers "2614 S 54th" with "2614 S 54TH ST", and that canonical form is
  what then goes to Zillow, onto the Subject Property field, into the duplicate
  check and onto the letter. The contact note says so ("resolved from …") so the
  agent's own words are still on the record.
- Zillow rows carry **no `yearBuilt` at all** (verified: 0 of 78 on a live
  pull), so the ±10-year era criterion goes quiet. The match scorecard abstains
  on unknowns rather than penalising them, so comps degrade in ranking, not in
  correctness — a comp scores "4/5" instead of "5/6".
- Zillow's sold map returns condos, townhouses, multi-family and vacant land
  alongside houses (9 of 33 within half a mile on that pull). Comps are matched
  to the **subject's own** `homeType`, read off its Zillow listing: a condo is
  valued against condos, a house against houses. With the subject's type known,
  a comp whose type Zillow didn't report is dropped — an unconfirmed match is
  not a match, and nobody is watching an unattended run. When the subject's own
  type is unknown, it falls back to excluding the types that are wrong for a
  house rather than stopping.

  The search URL asks Zillow for that type too (verified: 77 rows unfiltered →
  63, all single-family), but that is only an optimization — `filterComps` is
  what guarantees it.

  Consequence worth knowing: **condo and townhouse subjects will hold far more
  often.** Half a mile around that Tacoma address held 24 single-family sales
  but only 1 condo and 6 townhouses, and the price proxy needs 6 to rank. That
  is the correct outcome — a condo comped against houses is worse than no
  number — but it means the automation is really a single-family tool until a
  denser market says otherwise.
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

### Subject Property

One contact field, `subject_property` ("Subject Property"), answers: *if I
underwrote something for this agent right now, which house would it be?*

- **Seeded** at outreach import from the hook address — the listing that made us
  reach out.
- **Kept current** by the AI conversation sweep (it is an agent enrich field) and
  by any auto-underwrite run that reads an address from the conversation. Your
  GHL conversation bot can write it too; the key is `subject_property`.
- **Read** by the auto-underwrite when the webhook body carries no `address`.

It is deliberately **not** in `OUTREACH_FIELDS`, which the import rewrites
wholesale each time. A re-import seeds it only when the contact has none —
putting the hook address back over a property the agent has since moved on from
would silently re-aim the automation at the wrong house.

Because it is a stored answer someone already committed to rather than a guess
made this second, the field bypasses the high-confidence gate that a
conversation-read address must clear. It shows in the offer's provenance panel
as "Address from: the Subject Property field", so a review can still tell where
the number came from.

*Door 1 — a Tier-1 / qualified trigger (recommended).* If a conversation bot
already qualifies the agent and captures the address, that bot IS the filter,
and its capture is better evidence than a one-shot extraction re-reading the
same thread. Trigger on **Opportunity Created** (filtered to the Tier 1
pipeline stage) or on the **Tier 1 tag being applied**, and hand the address
over:

```json
{ "location_id": "{{location.id}}", "secret": "<AUTO_UNDERWRITE_SECRET>",
  "contactId": "{{contact.id}}",
  "address": "{{contact.subject_property}}",
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

## Conversation AI (inbound text → a reply, drafted or sent)

An agent texts "still interested in 12 Elm?"; an investor texts "what's the
price on 54th?". A GHL workflow hands each text to the broker, which works out
**who is texting** from their tags, reads **the right record book** — the
offer book for a listing agent, the deal book and buy box for an investor —
and drafts what we would say in the voice set on the console's
**Conversation AI** tab. A draft waits in the outbox for a person, or, for the
intents that tab has cleared, counts down a few human minutes and sends
itself. It can also **trigger things in GHL** on what it hears.

Why not GHL's own Conversation AI: it is a generic knowledge-base bot that has
never seen the offer we sent this agent or the deal we blasted this investor,
so it can't answer the only question either of them is asking. This one can,
and it is not allowed to invent a number. Code: `ghl-broker/reply-agent.js`
(the pipeline), `conversation-party.js` (who), `conversation-context.js`
(what we know), `conversation-prompt.js` (what the model is told),
`conversation-actions.js` (what it triggers), `conversation-scheduler.js`
(when it sends), `shared/conversation-ai.js` (the config).

**Prerequisites.** Settings needs the Anthropic key. Two Render env vars:
`AUTO_UNDERWRITE_SECRET` (the same webhook credential the underwriter uses)
and `CARD_SENDS_ENABLED=true` — without it nothing goes out, by you or by
itself, and the tab says so. Scopes: `conversations.readonly` to read the
thread, `workflows.readonly` for the workflow picker (see the scopes list
above).

**Wiring — one workflow.** Trigger **Customer Replied** (GHL's inbound-message
trigger; filter Reply Channel to SMS for now). Add **no tag filter**: the
broker routes by the tag rules on the tab and holds, or answers generically,
when a contact carries neither kind. Action: **Webhook**, `POST` to
`https://offers.shepflips.com/api/offers/automations/conversation`, header
`x-underwrite-secret: <AUTO_UNDERWRITE_SECRET>`, custom data:

```
location_id   {{location.id}}
contact_id    {{contact.id}}
message       {{message.body}}
channel       sms
```

(`/api/offers/automations/reply` still works — it is the same handler.) Add
`party: agent` or `party: investor` only if the workflow already knows; it
overrides the tag rules. Then **switch GHL's Conversation AI off** for these
contacts (location setting, or a "Conversation AI: disable" action at the top
of the workflow) — otherwise both bots answer the same text. It answers `202`
in milliseconds; the draft is written in the background.

**Who is who.** The tab's routing card holds two comma lists of tag patterns
(`*` is the only wildcard): listing agents (`agent`, `agent-*`) and investors
(`investor`, `investor-*`, `dispo-*`, `disposition-*`, `on-deal`). A contact
matching both goes to the party the card says wins. One matching neither is
handled per the card: **classify** (the old GHL "master bot", reduced to one
cheap structured call — is this an agent with a property we could buy, or a
buyer who wants a deal from us?) answers from that playbook and, on a
confident read, stamps the party's first plain tag so the tags decide next
time; when the words don't settle it, it drafts the generic clarifying reply
("is this about a listing you have, or are you looking to pick one up?"),
which never auto-sends. **Hold** leaves a note and writes no draft;
**generic** skips the read. This deliberately does not use `inferContactType`
from the enrichment code, whose substring rules call an agent who was tagged
into a dispo blast ambiguous.

**Before any of that: opt-outs and photos.** A text that starts with one of
the opt-out words (`stop`, `unsubscribe`, `remove`, `cancel`, `quit`, `end`)
or contains one of the phrases (`wrong number`, `do not text`, …) gets
**silence** — no goodbye, no confirmation — plus the opt-out tags (`stop bot`,
`dnc` on the starter) and any reply counting down to that contact is
cancelled. No model call is made. The model can also read an opt-out the
words missed ("lose my number", plain anger); it ends the same way. Point a
GHL workflow at the tag to set DND. A message that is only a photo gets the
canned line ("Thanks for the images, taking a look!") and the image is never
looked at — pass the attachments to the webhook as `attachments` (a list, a
URL, or a count) so an empty body isn't refused.

**The starter playbook.** "Load starter playbook" on the tab fills the
persona, rules, examples, routing, texting rules, opt-outs and both playbooks
with the Shep Flips setup consolidated from the three GHL bots it replaces
(2026-09-04): the master router is the classify step; the acquisitions bot is
the agent playbook (Tier 1 = has a deal or a new property → `tier-1`, Tier 2
= open to investors → `tier-2`, Tier 3 = passed → `tier-3`, mirroring the
Acquisitions pipeline stages); the dispositions bot, which had been a copy of
the acquisitions prompt, is written properly for the first time (interested →
`investor-active` + link to the deal + a suggested dataroom link; wants to
buy / walk it → ask-first `investor-hot` + link). Every auto-send stays off
until a person ticks it. **Workflows.** The bots used to drop a contact
straight into the GHL workflows `TIER 1` / `TIER 2` / `TIER 3` (Agent
Wholesale Automations) and `Tier 1 Disposition` / `Tier 2 Disposition`. The
starter does the same — `add_to_workflow` on the tier rules, alongside the
tags — by matching those names, which needs the `workflows.readonly` scope on
the Private Integration so the list is visible (`matchStarterWorkflows` in
`shared/conversation-ai.js`; without the scope the rules are tags only and
the action editor takes a pasted workflow id). Enrolling a contact needs only
`contacts.write`. A DND workflow on `stop bot` or `dnc` is worth adding.
Nothing in GHL needs to classify, tag tiers or reply any more — switch those
bots off.

**Memory.** With the Memory card on (the starter turns it on), every reply's
model call also returns what is NEW about the person — personal details, the
areas they work or buy, a property event ("7 Pine Ct | sent us the listing"),
an investor's price band, types and rehab appetite — and `applyProfileUpdates`
files it into the same CRM fields the nightly enrichment sweep keeps, through
the same merge rules (facts union, history ledgers dedupe and keep the
newest), so the two never fight. The transcript it reads includes the most
recent call transcripts (default 2) when GHL has them. The prompt's PERSONAL
TOUCH rule then lets the reply lean on that once, lightly — "thanks again for
the Tacoma addresses", "hope the surgery went well" — never every message,
never as surveillance. Each draft row and its note say what was filed.

**Hands off.** A contact carrying a hands-off tag (`stop bot`, `bot-off` on
the starter — the same tag the opt-out writes) gets no draft, no send, no
note. And when a person replied to them inside the stand-down window (30
min), the bot drafts but never sends itself: the row says "you replied to them
N minutes ago". Three texts in a row are one reply: the draft waits the
debounce (45s on the starter) and a newer text replaces the waiting job; the
same words twice inside two minutes are one message. Each contact also has
its own daily cap (12).

**Catch-all and status.** Each playbook has a fallback that runs when no
intent rule matched, unless the contact already carries one of its tags: on
the starter, any agent reply with no fit is Tier 3 (tag + TIER 3 workflow),
never demoting a Tier 1 or 2. Tier moves also LEAVE the lower tiers'
workflows (`remove_from_workflow`) so a nurture drip can't keep texting an
agent we're now working, and a Tier 1 read writes the named address to
Subject Property (empty tokens write nothing) so the underwriter reads it. A
counter marks the agent's open offer countered and a pass marks it passed
(the same write as History's status menu); an investor passing is marked
passed on the deal; the committed buyer is ask-first because it advances the
deal. The investor book now also recognises a dispo blast tag as "sent to
them" and lists finished deals they saw as NO LONGER AVAILABLE, so "is 54th
still open?" gets an honest answer.

**What the model is given.** The persona (name, role, voice, length, sign-off),
the house rules, the party's playbook (standing instructions, "it may / it may
not"), the examples of our voice, the intent definitions, and then per party:

- *Agent* — the offer book, newest first: our cash offer, the asking price,
  status, when and how it was sent; the Subject Property field; anything the
  enrichment sweep learned (areas served, personal details, last conversation
  summary); and any auto-underwrite running for them right now ("numbers
  coming shortly", never a number).
- *Investor* — their buy box (from the Dispositions book, or their GHL fields
  if they were never synced); the live deals they are already on, with their
  status and whether they opened the dataroom link we sent; and up to five
  other live deals that fit their buy box, each with **only the buyer price**
  (contract price + our fee), ARV and estimated repairs. The contract price
  and the fee are handed to the money guard as **forbidden**: a draft that
  names either is flagged even if the investor said the number first.

**What it will not do on its own.** `evaluateReplyGates` holds a draft that
names a number not in the record book or the inbound text, that leaks a
forbidden number, that the model marked `needsHuman`, that is under high
confidence, that is empty, that is too long for a text, or — under the
texting rules on the tab — that carries a `$` or a link (carrier spam
filters key on both; money is written 525k). Em dashes are scrubbed from
every draft. And every intent
in `NEVER_AUTO` (agent: counter, acceptance, wants a call, scheduling, proof
of funds, new property, other; investor: price pushback, wants to buy, wants
to walk it, wants a call, other) is a person's call whatever the tab says.
`decideAutoSend` then adds the tab's switches: the bot is on, the broker can
send, the party's auto-send is on, the intent is on its allowlist, the channel
is allowed. The first switch that is off is recorded on the draft and shown
on the row ("Would have been safe to send on its own. Didn't, because
auto-send is off for agents").

**Auto-send.** Off by default for both parties. When a reply clears
everything it is **scheduled**, not sent: `sendAt` = now + a random delay in
the configured band (default 2–4 minutes), pushed to the next opening if that
lands outside the sending window (default 08:00–20:00 America/Los_Angeles).
The row shows "Sending itself in 2m 10s" with a **Hold** button; the contact
note says the same. A 30-second ticker in `broker.js` sends what has come due,
as written, and notes the contact "Conversation AI sent this reply itself". A
failed send goes back to the outbox with the reason and is never retried
silently; a send interrupted by a restart is handed back after five minutes.
State is in `reply_drafts` (status `scheduled` / `sending`), so a redeploy
loses nothing.

**Actions.** Per party, per intent, the tab can wire: add tags, remove tags,
set a custom field (`{{intent}}`, `{{propertyAddress}}`, `{{summary}}`,
`{{date}}` and friends interpolate), add the contact to a GHL workflow, and
the broker's own moves — link an investor to the deal they mean as
"evaluating" (the deal-interest logic, now shared), start an auto-underwrite
for an agent's new property, text an investor a dataroom link. A rule runs
**automatically** the moment the intent is read with high confidence, or
**ask me first**, which shows it on the draft row as a violet chip for one
click. A dataroom link is always ask-first. Every outcome is recorded on the
draft and in the contact note.

**Try it.** A chat window, on the tab and inside Settings → Conversation AI,
in the shape of GHL's own "Test your agent": pick a real contact (every reply
then has their real thread, offers, deals and buy box behind it) or talk to
it cold as an agent or an investor, text as the lead would, and read the
reply turn by turn. Under each reply: the intent, whether it would have sent
itself and if not why, the actions it would have fired, and a "details"
toggle with what the model saw. The typed turns are appended to the
contact's real thread on each call, so a test is "their conversation so far,
then this". Nothing is saved, sent, tagged or scheduled, it never reaches
the contact, and it doesn't count against the daily cap. This is where the
page gets tuned: when a reply is wrong, add a line to the playbook and ask
again.

**Graduating an intent.** The history table on the tab shows, per party and
intent, how many drafts the gates would have let go (*auto-sendable*) and how
many a person then sent **as written**. When those agree for a couple of weeks,
tick the intent on the party's allowlist and turn the party's auto-send on.
Counters, calls, showings, proof of funds and buying decisions stay yours for
good.

**Where the config lives.** `settings.conversationAi`, written only by
`PUT /api/offers/automations/conversation/config` — the Settings page re-attaches the stored
value rather than carrying its own copy, so a stale Settings form can't
clobber what the tab saved. A location that never opened the tab is seeded
from the old `replyAgentDailyCap` / `replyAgentInstructions` and behaves as it
did.

**Cost.** One Claude call per inbound text (~$0.02–0.05, a little more with
call transcripts and the profile extraction), read once at the daily cap on
the tab (default 60, plus 12 per contact), counted from the store so a
restart can't reset it. No Apify. Two drafts in flight per location at a
time. Settled drafts older than the retention (180 days) are pruned daily.

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

## Dataroom photos from a Google Drive folder

The dataroom photo box takes a Drive **folder** link and imports everything in
it, in filename order, instead of one photo at a time. Photo #1 becomes the
deal's cover, so name them the way you want them ordered.

**Setup** (once per location):

1. console.cloud.google.com → pick or create a project → **APIs & Services** →
   *Enable APIs* → **Google Drive API**. Skipping this is the most common
   failure; the import says so explicitly when it happens.
2. **Credentials** → *Create credentials* → **API key**. Restrict it to the
   Drive API. Do **not** add an HTTP-referrer restriction — the broker calls
   from a server, so there is no referrer to match. IP restriction works if you
   want one (Render's outbound IPs).
3. Settings → **Property photos from Google Drive** → paste the key.
4. Share the folder itself as **"Anyone with the link"**. The key reads public
   folders only; it is not a sign-in.

**How it works.** Listing the folder needs the key and happens on the broker.
Downloading each photo needs nothing — if the listing worked the folder is
link-shared — so the key never reaches the browser. The broker answers with
plain image URLs and the client pulls each one back through the same
`/photos/from-url` endpoint a dragged image uses: one fetch path, one set of
SSRF guards (`ghl-broker/fetch-image.js`), one place that decides sizes.

Downloads go through Drive's thumbnail endpoint rather than the raw file. That
is what makes an **iPhone HEIC importable** (Drive re-encodes to JPEG, which a
browser canvas can actually decode), caps resolution server-side instead of
shipping a 6MB photo only to downscale it to 1600px anyway, and dodges the
virus-scan interstitial Drive serves for large files.

**Limits and behaviour.** 100 photos per import, then it says it truncated.
Subfolders are not descended into. Non-photos (a PSA PDF filed alongside) are
counted and reported, not silently dropped, so "32 things in the folder, 30
photos imported" reconciles. Nothing is stored server-side during expansion.

**Also fixed by this:** a single-file `drive.google.com/file/d/<id>/view` link
pasted anywhere that accepts a URL — the photo box and the PSA exhibit fields —
now resolves to the file instead of failing as "not a direct image". Exhibits
ask for the original bytes rather than a thumbnail, since a thumbnail of a PDF
is a picture of its first page.

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
- **The Conversation AI sends only what its tab allows** — per-party
  auto-send switches and intent allowlists, `NEVER_AUTO` above them, and the
  broker's `CARD_SENDS_ENABLED` gate above that. Every auto-send is scheduled
  minutes out with a Hold button. See "Conversation AI" above.
- **Auto-underwrites are dry-run by default** — same double gate via
  `AUTO_UNDERWRITE_ENABLED`. A dry run still does all the work (and spends the
  Apify/Anthropic money); it just saves a draft instead of publishing an offer.
  Three further rails, because this is the one feature that spends money with
  nobody watching: the endpoint **requires** the location to be in
  `GHL_LOCATION_KEYS`, a per-location daily cap (Settings, default 25) counted
  from the database rather than memory so a crash loop can't reset it, and a
  24-hour dedupe on contact + address. An auto-underwrite never sends.
- **The reply agent never sends on its own.** Every draft waits for a person;
  the Send button is dry-run unless `CARD_SENDS_ENABLED=true` (the offer-send
  gate). The webhook needs the same credential as the underwriter, drafts are
  capped per day from the database, and a draft naming a dollar figure that
  isn't in the offer book is flagged before anyone sees it.
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
