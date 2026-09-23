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
# OFFER_COUNTERED_TAG / OFFER_NO_RESPONSE_TAG / OFFER_PASSED_TAG / OFFER_WE_PASSED_TAG — offer-outcome
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

### A shorthand address, and a run a redeploy killed (2026-09-16)

**Short addresses.** Agents write "34418 54th Ave S" — no city. A geocoder
given only that puts it in another state at street precision or nowhere
("couldn't locate … on the map" held three runs on 2026-09-16). Before the
geocode, `completeAddress` (shared/us-address.js) finishes the line from
what the contact record already knows, best first: a full address we hold
for this agent on the same street (the listing hook at import, the outreach
text, Subject Property), the contact's own city/state, the county off their
outreach batch tag (`agent-outreach-…-king-wa` → "King County, WA"), and
the bare line last. The run's warnings say `address completed: "…" → "…"`.

**Vanished runs.** An underwrite lives in memory; a deploy in the middle of
one (Boots Swan's 3925 SW 317th, 12:56 PT, three deploys 12:55–12:58) kills
it with no note, no draft, no tag change. `restartVanishedUnderwrites`
(auto-underwrite.js) runs on the 15-minute tick: any reply draft from the
last 12 hours whose `start_underwrite` action says "done", older than 20
minutes, with **no row at all** for that agent on that street (no offer, no
held or failed draft, no job in memory) is started again from the draft,
once (`uw_restart:{draftId}` on the timeline). Log line: "underwrites
restarted for <location>: …".

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
- Zillow **search** rows carry no `yearBuilt` at all (verified: 0 of 78 on a
  live pull). Since 2026-09-16 the most similar comps in each ring get theirs
  from the detail actor — see "Year built, bought" below. A comp that wasn't
  looked up still abstains on era rather than being penalised.
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

**One loose pool, ranked — the most similar first (2026-09-16).** The pull
uses the pool bands (beds ±1, baths ±1, size ±30%, houses only, half a mile —
`UW_POOL_*` in `auto-underwrite.js`), plus era ±15 years once a comp's year
built is known (`UW_POOL_YEAR_TOLERANCE`). That door is as wide as it was, on
purpose: Matt's call was fewer holds, not tighter bands. What changed is who
inside it carries the number.

Every comp in the ring is scored by `similarity` in `shared/comp-match.js` — a
0–100 closeness, not a vote count. Distance leads (full marks inside a quarter
mile, nothing at the ring edge), then size (±10% or ±300 sqft is a full match,
nothing at ±30%), beds (exact, or 40% for one off), baths, year built (full
inside five years, nothing at 25), sale recency, and lot when both are known.
A fact nobody has leaves the denominator, as the old scorecard's did. The
scorecard itself stays for the ✓/✗ lines in the pane's tooltip.

Why: the old scorecard counted pass/fail over nine criteria, and on Zillow rows
only about five were knowable (no year built, stories, material or
subdivision), so a whole ring tied at 4/5 and the pick fell to $/sqft. The
price proxy then ranked the **whole ring** by $/sqft and called the top 35%
renovated — so the priciest houses nearby (bigger lots, newer, better streets)
were the ARV evidence and the similar-but-cheaper renovated sale next door
lost. The post-mortem of 2026-09-10 found buyers pay ≤70% of ARV less repairs
and the three dead deals were priced off ARVs that were too high.

**Year built, bought.** No Zillow search row carries it, so era never counted.
The detail actor does — the same batched call the multifamily path was already
making for unit counts and keeping only the units from. Now each ring looks up
its `UW_ENRICH_CANDIDATES` (20) most similar comps in one detail run
(`fetchZillowFacts` in `rehab-scan.js`: year built, lot, size, beds, baths,
units, last sale), keeps the facts a day per street so a retry, the queue or
the Comps pane pays nothing twice, and merges them onto the search rows without
touching the price or the sale date (`mergeFacts`). The 1.5 mi ring only buys
addresses the half-mile ring didn't. Cost: one detail run of ≤20 addresses per
ring reached; a multifamily pays nothing extra. `UW_ENRICH_CANDIDATES = 0`
switches it off and the run prices on the search rows alone, as before. The
run's warnings say `N in the ring, M with a year built, ARV set match 84` so
the dials can be tuned after a week.

**Renovated comps decided by — `price` (default) or `ai`.** ARV means *after
repair* value, so it has to rest on comps that were themselves renovated.

`ai` reads each comp's sold listing photos with a vision model. It is the
accurate answer and it is expensive: a scrape plus a multi-image call per comp,
which is the single slowest and priciest stage in the whole pipeline.

`price` takes the top of the **$/sqft** spread — but inside the
**`UW_SIMILAR_CANDIDATES` (10) most similar comps**, and the top
`UW_PROXY_SHARE` (half) of those. Similar first, then price: inside ten houses
that are already the closest in distance, size, beds, baths and era, most of
what is left to explain the $/sqft spread *is* condition. Two details keep it
honest:

- It ranks by $/sqft, not by price. Even among close matches the biggest house
  usually posts the biggest number, so ranking on price would mostly
  re-discover square footage.
- It refuses when there are fewer than 6 priced comps among the candidates.
  Calling the best 3 of 3 "renovated" is circular, so the run widens to the
  1.5 mi ring and, failing that, takes the gut check (2–5 priced comps, the top
  three by $/sqft, said in those words) or holds.

The ARV set is then the best-matching four of the marked tier, size-fit first
(±25%), exactly as before. `proxy.reason` leads with `most similar 10 of 41:`.

**How the ARV is weighted.** `deriveArv` (`shared/arv.js`) brings each sale
to today first — `timeTrend` regresses $/sqft on months-since-sale over the
**whole ring** (never the four ARV comps), abstains under eight dated comps or
six months of spread, and is capped at ±1%/month — then applies the usual
half-$/sqft size adjustment, and takes the **similarity-weighted median** (a
comp's weight is its score, floored at 0.2; a comp with no score weighs 1, so
hand-picked and captured comps count fully). The basis now leads with the
reach of the evidence, because the offer document cuts it at 80 characters:

    4 comps · match 84 · within 0.4 mi · size ±12% · built ±8 yrs; 4 comps
    (renovated/updated), size-adjusted to 1,890 sqft, time +0.3%/mo

Marked comps carry `conditionSource: "price"` everywhere they travel, and the
review panel says "condition by $/sqft" rather than letting it read like
someone looked at the kitchen.

**The Comps pane** ranks and preselects by the same score: the chip is the
0–100 similarity (tooltip: each factor's share, then the ✓/✗ criteria), the
route enriches the subject and its twenty most similar comps in one detail
batch — which is also how the subject's beds/baths/size/year/lot fill in
again — and the ARV suggestion uses the board's own time trend.

**Wiring it.** There are two front doors. Use the first one if you have a
qualifying bot; it is cheaper and more accurate.

### Subject Property

One contact field, `subject_property` ("Subject Property"), answers: *if I
underwrote something for this agent right now, which house would it be?*

**Which house, when the field is stale.** The field (or the workflow body)
is a standing answer, and standing answers go stale — set on Monday's house
while Tuesday's thread is about a different one. So the underwriter reads
the newest slice of the thread anyway and lets the conversation referee:
of the standing address and every address the record has seen this agent
raise, whichever was mentioned *last* in the thread wins. A different
winner is used with source `thread`, a warning is logged ("subject property
was stale: X → Y"), and Subject Property is rewritten to it. Nothing from
the candidate list mentioned in the thread → the standing answer holds.

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
and drafts what we would say in the voice set on the **Conversation AI** tab
of the Autopilot app (`/autopilot?view=conversation`, `VITE_APP_MODE=autopilot`;
its outbox is Today's Needs-you queue at `/dashboard`) — deliberately
not in the offers console, where the outbox banner buried the offer table. A draft waits in the outbox for a person, or, for the
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
the acquisitions prompt, is written properly for the first time. Its goal is
a **walkthrough** — a buyer who walks a house buys a house — so it steers
toward "want to get eyes on it this week?", offers once and drops it rather
than nagging, and asks which day without ever confirming a time (interested →
`investor-active` + Tier 1 Disposition + link to the deal + a suggested
dataroom link; wants to buy / walk it → ask-first `investor-hot` + link, so a
person sets the actual time). **Workflows.** The bots used to drop a contact
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
note. So does anyone you are actively working a deal with, which needs no tag
to remember. Two sides:

- the **agent or seller** on a property at `under_contract`, `buyer_found`
  or `assigned` — an accepted offer turns outreach into a negotiation you
  are handling yourself;
- the one buyer marked **`committed`** on one of those deals — the person
  signing the assignment. Past that the deal is paperwork.

**`evaluating` is not a handoff.** It is every buyer actively weighing the
deal, a dozen of them on a good blast, and working them is the job: the
investor playbook's goal is getting them to *walk the property*, and the bot
keeps talking to them until they sign or pass. A buyer who **passed** is free
for the next deal. A buyer never linked is still the bot's to pitch — that is
the blast itself, which tags rather than links. A closed or fallen-through deal releases everyone. The routing
card's "People you're already working" can narrow this to the acquisition
side only, or switch it off. Both checks run before the model call, so
neither costs anything. The stand-down window ("stand down after you reply")
is **never under 30 minutes** (`HUMAN_ACTIVE_MIN_FLOOR`, default 45; the page
can lengthen it, not shorten it). It shipped at 0 on 2026-09-07 because Matt
works the outbox by hand and wanted the bot to pick back up around him — and
on 2026-09-16 it answered Angela Jaeger three minutes after he had ("I'm an
assistant on Matt's team keeping up with texts!"); she closed the thread as
"Totally AI". Once a person has jumped in, the bot stays out for at least half
an hour. Beside it, narrower and always on: an auto-send checks
the thread the moment it comes due, and if a person answered that thread
after the draft was written it stands aside for that one — the draft is
dismissed with "you answered it yourself" and History shows "you answered
it" — then picks up again on the next inbound. Pressing Send by hand is a
person deciding and is never second-guessed. Three texts in a row are one reply: the draft waits the
debounce (45s on the starter) and a newer text replaces the waiting job; the
same words twice inside two minutes are one message. Each contact also has
its own daily cap (12). **A burst never silences a thread** (Colin Foote,
2026-09-15): a link and "$950k, quick close" drew a reply that was counting
down; "buyer to pay my 3%" a minute later read as a person's call and its
held draft superseded the one about to go, so nothing went. Now a draft held
for a person leaves the scheduled reply to the earlier texts alone and waits
in the outbox on top of it (`keptScheduledIds`) — unless the new text turned
the conversation (a no, a counter, a yes, an opt-out), which still supersedes.

**A buyer's standing on a deal** is one of three: `evaluating` (actively
weighing it — many buyers at once, and the bot's to work), `committed` (the
one who signs the assignment; advances the stage to `buyer_found` and stands
the bot down), `passed`. There used to be a fourth, `sent`, meaning we had shown them the
deal and heard nothing — retired, because putting a buyer on a deal *is* the
act of shopping it to them, and "no answer yet" was already told by the blast
tag and the dataroom invite trail. Rows written before the change still carry
it and read as `evaluating`; there is no migration. Adding a buyer to a deal
by hand now starts them at `evaluating`, which also stands the bot down for
them.

**Subject Property** is the underwriter's aim, so the pipeline keeps it
current on **every agent message that names a property** — not only on the
tier-1 intents that used to carry a `set_field` rule, because an agent raises
a new address in a question or a status check as readily as in a "got one for
you". It is written only when the property actually moved (compared on
`addressKey`, so a spelling difference is not a move) and only when the model
returned something an underwriter could search: a house number and a street.
"the Tacoma one" and "her listing" are honest answers to what a message is
about and useless as an aim, so they leave the field where it was. Investors
never touch it. It is filed even when profile learning is switched off.

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

**The realm check.** The flow Matt described: an agent confirms a listing →
Tier 1, Subject Property written, the auto-underwrite runs (your Tier 1
workflow, or the `start_underwrite` action). While it runs, the agent
playbook's QUALIFY paragraph has the bot learn condition, the seller's
number, timeline and occupancy, one question at a time. When the underwrite
creates an offer, the underwriter's `onOfferCreated` hook calls
`startProactive` and the bot drafts a text it STARTS — "we'd likely land
around 410k as-is, quick close; is that in the realm for the seller before I
send it over?" — with the number from the offer book (so the money guard
allows it) and the letter's terms. It waits in the outbox like any reply,
labelled "floated our number", and on the starter it goes by itself — the one
message the bot STARTS rather than answers. Untick `realm_check` on the
agent's auto-send list, or turn `realmCheck` off, to make it wait. The agent's answer is read as `realm_yes` (tag
`realm-yes`, the offer noted "in the realm" and a ledger line, so History
and the next context both know) or as a `counter` / `rejection` like any
other. The agent book now also carries each offer's terms (close days,
earnest money, as-is) and its counter history; the ARV and repair estimate
ride along too but reach the prompt only when the playbook's **Show the
math** switch is on (off on the starter — it's leverage).

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
(Two guarded doors exist, each with its own switch and its own arithmetic: the
agent's counter band, and since 2026-09-17 "The investor band" for a price
pushback. Both are off by default and both leave `NEVER_AUTO` itself alone.
Since 2026-09-22 the counter band also answers on an offer that is dead on
THEIR side — `passed` or `no_response`, `REVIVABLE_STATUSES` / `isNegotiable`
in `shared/offer-status.js` — because the passed-offer check-in asked for
exactly that answer: Pink Skulls Realtor came back at 144k on Longfellow,
inside the 145.6k ceiling, and the band said "no open offer". Re-issuing a
revived offer records it `countered` first so the paper can follow. An offer
WE passed on is never revived by the machine.)
`decideAutoSend` then adds the tab's switches: the bot is on, the broker can
send, the party's auto-send is on, the intent is on its allowlist, the channel
is allowed. The first switch that is off is recorded on the draft and shown
on the row ("Would have been safe to send on its own. Didn't, because
auto-send is off for agents").

**Unsubscribed (DND) — flagged, never drafted (2026-09-16).** A buyer who
had texted STOP got a blast reply that failed "Cannot send message as +1425…
has unsubscribed" and sat in Today as "Needs you" — a text nobody could send.
GHL records a STOP as `dndSettings.SMS.status: "permanent"` (the top-level
`dnd` stays false); `smsUnsubscribed(contact)` in `ghl.js` reads both. Now:
the reply agent and every proactive kind stand down before the model call
(`handsOffReason` → "they unsubscribed"), the auto-send re-reads the contact
and dismisses a due draft to anyone who unsubscribed since, GHL's own 400 is
dismissed rather than handed back, and the contact is flagged once — tag
`unsubscribed` and an `unsubscribed` timeline row — so lists and the drawer
show it. "Needs you" is for texts a person could actually send.

**Auto-send.** **On** out of the box for both parties, with the allowlist set
to everything `NEVER_AUTO` doesn't forbid — reviewing every text is the thing
that stops a bot being used, and the allowlist is only what the gates would
let through anyway. What it can never include: a counter, an acceptance, a
call, a showing time, proof of funds, a new property, a price pushback, a
buying decision. Those are locked out of the list, not merely unticked. Turn
the whole thing off with the switch at the top of the tab, a party at a time
with its own switch, or an intent at a time on the allowlist. When a reply
clears
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

**Try it.** A chat window, on the tab and inside the offers console's
Settings → Conversation AI,
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
many a person then sent **as written**. Read it the other way round now that
auto-send ships on: an intent whose sent-as-written rate is poor is one to
untick. Counters, calls, showings, proof of funds and buying decisions stay
yours for good, whatever the numbers say.

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

### One number per house — the price lock (2026-09-16)

Heather Vandyken, 36721 6th Ave SW. We offered 825 in August and the seller
accepted it in September; a re-underwrite had quietly dropped our number, so
her "they agreed to accept 825" read as a counter and was held. A second run
then floated 795 "after the latest look" — 30k under an accepted price. She
got the seller to 795, then 800, which the counter band accepted and we
promised a PSA on. Then a phone call was transcribed, read as a rejection
with a repair figure in it, re-quoted to 731.5, and **sent** — by text and
email. She's gone. Three rules now, all in code:

- **A house the agent already has our number on is never re-priced by the
  machine** — `findOfferOut` in `auto-underwrite.js`: an unattended run on an
  address with a live sent (or agreed) offer for that agent stops and says so
  in the note; only a person replacing the offer on purpose (`replaceOfferId`,
  the form's fill) re-runs it.
- **An agreed price is locked** — `priceAgreed` / `priceLocked` in
  `shared/offer-status.js`: a realm-yes, a counter the band accepted, an
  accepted status or a deal writes `offer.agreed {amount, at, via}` (derived
  for older rows). `requoteFromAgentNumbers` refuses on a locked offer; a dead
  offer (passed / no response / we passed) is a fresh negotiation again.
- **The machine never lowers a number already out** — `planRequote` refuses
  any re-quote that lands under the sent price. Re-quotes move toward the
  agent on their numbers; a retraction is a person's call every time.

What a person still owns: the PSA after a yes. "14 days works on the 800k"
was held as "an acceptance is a person's call" and nobody sent the contract
that day; the bot had already promised it twice. That handoff is on Today.

### The nightly audit (2026-09-16)

**The audit answers what it finds (2026-09-22).** "From last night" had 18
rows and the bot had touched none; seven read "drafting was tried on an
earlier run and nothing came of it". Read against the threads: five were
tapbacks or closers ("Ok thank you", "Sound good.", a thumbs-up on Matt's own
text), one was the bot-off tag (Michael Lindekugel), one was the per-contact
cap (Melissa Willet, 12/12 after an eight-address afternoon; the same-day
retry hit the same cap). Now:
- a tapback or a closer (`isCloser`, shared) is read BEFORE the claim and is
  not a finding at all — not started, not on Today;
- a redraft that was skipped (a cap) says why on Today ("not drafted: this
  contact's daily cap reached (12/12)"), records an `audit_outcome`, and is
  tried again the next night, up to `MAX_REDRAFT_TRIES` (3) — the claim key
  carries `:tryN`;
- a hold before any draft (bot-off tag, live deal, "you have the thread",
  no party tag) writes a `reply_held` timeline row from the reply agent, and
  the next night's row says "the bot stood down: bot is off for this contact
  (tag: stop bot)" instead of "nothing came of it".
The per-contact daily cap now defaults to 0 (none) — Matt, 2026-09-22; the
location cap (400) still bounds a runaway loop.
What stays a person's by design: scheduling / wants a call (NEVER_AUTO, or
turn booking on), a counter with no number read, "other", a live deal.

Fifteen ticks push pieces of the loop. None of them stood back at the end of
the day and asked, per thread: did we answer? do we owe them something, and is
it on a clock? is the next move queued? Three threads went quiet on 2026-09-16
for three different reasons (a burst superseded the only reply, a held draft
nobody clocked, a reply job that hung) and each was invisible until Matt asked.

**What it is.** `shared/conversation-audit.js` is the analysis — pure, rows in,
findings out; read it to know what the sweep would and wouldn't do.
`ghl-broker/conversation-audit.js` runs it once a night at `nightlyAudit.hour`
Pacific (19 by default, after the promise window closes; retried through the
evening, a stale run retried like the outreach sweep's) with **zero GHL calls
except one cached `ghlLastMessages` read** — that read is what catches a text
that produced no draft row at all. Every finding names ONE existing mechanism:

- **Texts we never answered** — no row at all, or only rows a burst replaced →
  redraft via `startReply` (the redraft button's own path); a held draft →
  make sure the reply agent's "unanswered" check-in clock exists (same dedupe
  key, so never two); a `handled` wants-a-call → yours.
- **They said the number works, no offer went** → queued as `autoSendPending`
  (`by: "audit"`) so the morning tick sends it (`retryPendingOfferSends`
  honours that without the clean-underwrite switch). Never sends at night.
- **Still owed a number** — the promise sweep already texted once; the audit
  never texts twice. (What the machine would do about each one, and the rows
  that are never owed: "Promises", below.) Past two days with no word it books a morning check-in;
  under, a Today row (which is what keeps it visible past the queue's 3-day drop).
- **Counters nobody moved on** (48h, no re-quote/band/decline) → re-quote on
  the agent's numbers when re-quoting is on and a take exists; else yours,
  with their number, ours and the gap.
- **Floated, never heard back** / **offers with no follow-up clock** → when
  the offer ladder is on and the follow-up sweep hasn't run today, the sweep
  is started (once a night); ladder off → yours, said so.
- **Offers that couldn't send themselves** → yours, with the reason.
- **Ran out of asks** → the address chase is closed with a terminal event.

**Loose (default, Matt 2026-09-16: "fire where it can").** `nightlyAudit.loose`:
a held draft the money guard passed, that the model didn't flag for a person,
held only because its intent is a person's call / off the list / the band's
arithmetic didn't open, is **sent** (scheduled at the next open minute) rather
than clocked — it is a holding reply that commits to nothing. What the audit
itself starts (a redraft, a nudge) is released the same way
(`releaseForAudit` in reply-agent.js, via `deps.releaseHeld`). A stalled
counter with no numbers to re-run on gets a `counter_nudge` (asks for room,
names no number of ours; not on the playbook grid — the audit releases it). A
realm-yes queues the send whatever the underwrite switch says. The gates,
`needsHuman`, a person holding the thread, and drafts older than three days
are never released. `loose: false` restores clocks-only.

**Rules it never breaks.** Nothing texts at night — every remedy goes through
`startReply`/`startProactive` → gates → the dial → the 30-second scheduler at
the next open minute. Every text-ending remedy is claimed first (`audit_action`
with a key on the thing it answers) so a re-run or the morning sweep starts
nothing twice. A person who replied last owns the thread; unsubscribed,
opted-out and bot-off contacts are never in the list. With the bot switched
off it reports and touches nothing. `dryRun` analyses and writes nothing.

**Where to look.** Today's "Last night" card (checked / answered / queued /
on a clock / need you, with Run now), the queue group "From last night", and
`GET /api/dashboard/audit` (`last`, `run`, `tries`, `failed`); `POST
/api/dashboard/audit/run { dryRun }` runs it by hand. Cursor `conversationAudit`.

### The daytime pass (2026-09-17)

**Why.** The audit's fixes ran once, at 7pm. A thread that stalled at 9am sat
for ten hours, and the morning's counters, realm-yeses and unanswered texts
were exactly the rows on Today.

**What it is.** `driver.daytime` (off by default; the dial turns it on at
Normal): `{ enabled, startHour: 9, endHour: 18, everyHours: 2,
releaseMinAgeMin: 120, heldSweep: false }`, hours in Pacific. It is a second
**mode** of the audit's own runner, not a sibling: `runConversationAudit({ mode:
"day" })`, the same findings, the same claim keys (`auditDedupeKey`), the same
remedies, so day and night can never start the same thing twice.
`maybeRunDaytimeDriver` hangs off the 15-minute tick after the nightly audit's
gate, with the same gating (cursor written before the run, a stale run retried
after 30 minutes, tries capped at passes-per-day + 2) on **its own cursor,
`daytimeDriver`**. The night's `last` is never touched, so Today's "From last
night" keeps meaning last night. Weekends are skipped unless
`autoSend.weekends` is `all`: everything it starts is machine-started.

**What is narrower by day.**

- A held reply is released only when it is at least `releaseMinAgeMin` old
  **and** its intent is not a person's call (`NEVER_AUTO`). At 7pm you have had
  the day to look; at 11am a counter held at 10:50 is a decision you may be
  about to make. The night's "loose" rule is unchanged.
- The follow-up sweep is not started (it keeps its own hour and its own 20-hour
  cursor).
- The held underwrites are left for the night unless `heldSweep` is on: two
  GHL reads per held house, five times a day, is about 500 reads. The promise
  driver's `onHeld` hook covers the urgent ones.
- Anything it **starts** (a re-quote, a counter nudge, an offer nudge) asks the
  brake first (`threadHealth`); a stopped row says why. A redraft is an answer
  to something they said, not a push, and is not braked.
- A released reply says "released by the daytime pass".

Today shows its last run above the queue ("Daytime pass last ran 1:05 PM: 2
started, 1 left alone by the brake"). The Autopilot switchboard has the switch.

### The investor band (2026-09-17, Matt's decision)

**Why.** A buyer pushing back on price ("it's a deal for me around 400k") always
waited for a person. Matt chose a guarded band for it, modelled on the agent's
counter band, in the task that built it. It is the one addition to
`GUARDED_AUTO` (`investor: price_pushback`, guard family "band").
`NEVER_AUTO.investor` is unchanged, and a price pushback is still never a box
on the auto-send grid.

**The switch.** `parties.investor.priceBand = { enabled: false, dailyCap: 1,
minFee: 10000, maxDropPct: 5 }`. Off by default; **Full** on the dial and no
lower; a card on the Conversation AI tab ("Buyers who push back on price").
The normaliser holds `minFee` at 5,000 or more, `maxDropPct` between 1 and 15,
and never lets an agent playbook carry the switch on.

**The guard.** `evaluateInvestorBand` in shared/auto-accept.js, pure, every
check recorded pass or fail on the draft:

| Check | Means |
|---|---|
| `their_own_words` | the exact figure is in the message they sent |
| `one_deal` | one live deal of theirs, or the address is named |
| `deal_live` | under contract, not spoken for by another buyer |
| `below_asking` | under the price they were quoted (the dataroom's headline when there is one) |
| `above_floor` | at or over contract price + `minFee` |
| `within_drop` | no more than `maxDropPct` off asking. A second, independent rail: the floor is only as right as the contract price typed on the deal |
| `sure` | confidence high, and the model didn't flag it for a person |
| `once_per_deal` | `deal.investorBand` is unset. One concession per deal, ever, to anyone |
| `under_daily_cap` | investor releases today, counted from the store, separately from the agent band's |

There is no counter-back: it never says a number they did not say.

**Neither band borrows from the other.** `releaseUnderGuard` releases an
investor's pushback only on an `investor_band` verdict under `priceBand.enabled`,
and an agent's counter never on the investor's. `base.code === "never_auto"`
still bears the whole argument: a draft the money guard flagged, or one that
arrived while a person had the thread, is never released.

**What a release does.**

1. The reply is fixed words: "415k works on 138th. Want to walk it this week,
   or should I send the paperwork over?" It names their number and nothing
   else. Our contract price and fee stay forbidden; the gate that flags them is
   untouched.
2. The reply agent injects `agree_investor_price`, an action no rule can carry
   (absent from `INTERNAL_ACTIONS_FOR`, like the dataroom invite). It runs
   `agreeInvestorPrice` (ghl-broker/investor-price.js), which **re-checks** the
   floor and once-per-deal before writing `deal.investors[i].agreedPrice` and
   `deal.investorBand`. The deal's own contract price and fee are never touched.
   If the write fails the text is held: "works for us" has to be true.
3. From then on that buyer's context quotes the agreed price, marked "agreed
   with them; hold it, do not reopen it". Every other buyer still sees asking.
   Two more figures become forbidden for that buyer: the fee they are actually
   paying, and how far we came down.
4. Today gets a **Your call** row: "the machine agreed $415,000 with Alex · the
   dataroom still says $425,000 · they are not marked committed". A note lands
   on the contact. Marking them committed is still a person's press, and when
   it happens the assignment drafts at the agreed price.

**The risk to know about.** The floor is contract price + minimum fee, and the
contract price is one typed field on the deal. `within_drop`, the daily cap of
1 and once-per-deal are the backstops if it is wrong.

### The hot push — an agreed price, pushed to paper (2026-09-17)

**Why.** "Hot" was the end of the machine's road: a price was agreed (a realm
yes, the counter band, a warm signal) and nothing chased the paper. The goal
from there is the listing agent writing it up on NWMLS forms for us to sign.

**What it is.** A sixth follow-up ladder, `hot_push` (agent; `[1, 3, 6, 10]`
days, stops when it runs out; **off by default**, on with the other ladders at
Normal; on the auto-send grid as "pushed an agreed price toward paper", so a
second tick is needed before it sends itself). `hotCandidates` in
follow-up-sweep.js: open offers where `isHot` and there is no deal.

- **It re-anchors on their reply.** The ladder counts from the later of when it
  went hot and when they last wrote, and the subject id carries the anchor day
  (`<offerId>@<yyyy-mm-dd>`), so a restarted ladder gets fresh claims. Rungs
  sent before the anchor belong to the old one. So `stopOnAnyInbound` does not
  apply to it: a reply is the agent working it.
- **Its own rails.** A fixed 20-hour floor between texts (`HOT_MIN_HOURS`, a
  constant) instead of the shared 40; the weekly cap does not hold up an agreed
  price. With the ladder on, the offer ladder skips hot offers: one house, one
  ladder.
- **It asks the brake first** (`threadHealth`). Two pushes with nothing back,
  an annoyed agent, a thread you stopped or picked up: it stands down, and
  Today gets a **Stuck** row, "price agreed, 2 pushes and nothing back", whose
  next move is a call (`hot_stalled`).
- **The ask.** Rung 1: can you write it up on NWMLS forms at the agreed number
  and send it for us to sign. 2: what do you need from us to get it written.
  3: is the seller still good at that number. 4: a quick call today. The agreed
  number (the offer's own) may be said; nothing new may.
- **Never our paper.** A `hot_push` draft that says PSA, purchase and sale, or
  contract is held by `evaluateReplyGates`. Offering our own paperwork is a
  different move, and a person's.

The auto-send list's length bound went from 20 to 40: with this ladder the
agent side has 21 eligible intents, and the last one was being dropped on
save. Every entry is still filtered against `autoEligible`.

### Timers on Today's rows (2026-09-17)

`driver.timers` (off by default; Normal on the dial): `{ enabled,
floatAfterHours: 4, goneQuietDays: 14 }`. `timerMoves` in shared/pipeline.js is
the one table: the Today row reads it for its "Next:" line (and moves to "The
machine is on it"), and `ghl-broker/today-timers.js` carries it out at the end
of every **daytime pass**, so the timers do nothing while `driver.daytime` is
off (the switchboard says so).

| Row | What the machine does | Guard |
|---|---|---|
| Priced, not floated | floats it `floatAfterHours` after it was priced, through `deps.floatOffer` (their read first, "our offer already went out" still stops it) | asks the brake; never when the float was skipped, because that row is Stuck with why |
| Gone quiet | marks it no response through `deps.setOfferStatus`, the door the board's button uses (tags, mirror, promise settle all fire) | not braked: it ends a thread, it doesn't push one |
| Underwrites that failed | one retry, only when the error reads as the network's or the model's (a timeout, a 5xx, a rate limit, an AI scan cut short), never "no address" | the underwriter's daily cap; a dry run unless it is live |

Each is claimed first (`audit:timer_float:<offerId>`, `audit:timer_quiet:
<offerId>`, `audit:timer_uw_retry:<jobId>`), once ever. The file reads no
environment switch; a test asserts it.

**Left out on purpose.** "Followed up, no reply": the follow-up sweep already
marks no response when the ladder runs out, unless the ladder is set to
"stop", and that is a setting, not an oversight. "Blasted, nobody opened it":
those rungs are the follow-up sweep's, which refuses a second run inside 20
hours, so a timer would do nothing. "Stage is behind": check the deal's commit
path first; the row looks like a bug there rather than a job for a timer.
Closings, hand-offs, deals with nobody on them and failed bands stay yours.

### Promises — what the machine would do about each one (2026-09-17)

**Why.** Today carried ten "we owe them a number / an answer" rows and every
one offered a single button, Dismiss. Some were never owed (our text ended by
asking THEM something), one had a priced offer nobody had floated, several had
an underwrite held on thin comps that the agent's own numbers would clear.

**What it is.** `shared/promise-resolver.js`, pure. `openPromises(events)` is
the one derivation of "what is open for this contact"; `resolvePromise` picks
one move, in this order:

| Move | When | The Today row offers |
|---|---|---|
| `not_owed` | an owed ANSWER we have since given (a sent reply to something they wrote, not small talk, not another "I'll get back to you"); or our text ended with a real question to them ("sound good?" does not count) | no row |
| `send_number` | a priced open offer on that house, nothing sent or floated since the promise | Float our read / Float the number |
| `wait` | an underwrite for them is queued or running, or the triage says we already asked | nothing but Dismiss |
| `rerun` | held, and they have given the numbers that clear it (`triageHeldUnderwrite`) | Re-run on their numbers / Open and fix |
| `ask_numbers` | held on a value or work hold, never asked | Open and fix |
| `start_underwrite` | a promised number, a full address, and nothing ever ran | nothing yet |
| `yours` | anything else, with the reason | Open and fix when there is a draft |

A promised number is only ever kept by a number: "ok thanks" and "sounds good"
back never closes it.

**What changed in behaviour.** The promise sweep settles a `not_owed` promise
(`promise_kept`, `by: "not_owed"`) before it writes `promise_owed` or texts
`promise_due`, so nobody we asked a question gets "we owe you", and a row
already on Today for one clears by itself on the next tick. It only removes a
send, so it has no switch. Nothing else acts yet: the moves are shown, and a
person presses the button, unless the driver below is on.

**The send records the ending.** `promise_made` keeps only the first 200
characters of what we said, so a long text's ending is unknown. `sendReplyDraft`
now writes `data.asksThem` from the whole body; for older events a text that
fills the 200 characters is never read as ending in a question.

**The driver (`conversationAi.driver.promises`, off by default; the dial turns
it on at Normal).** `ghl-broker/promise-driver.js` presses the row's button
itself. It runs first on the promise sweep's tick (same working hours, same
in-flight guard), and straight away for one contact when an underwrite holds
(`deps.onHeld` from `finishHeld`):

- `send_number` → `deps.floatOffer`, which is `floatNumber` in routes/offers.js:
  the same step a finished underwrite takes, so "our offer there has already
  gone out" still stops it, and their read is still asked for before our price.
- `start_underwrite` → `deps.startUnderwrite`: the daily cap, queued if capped,
  a dry run unless `AUTO_UNDERWRITE_ENABLED`. Only with a full address on the
  promise; an address is never read out of a text here.
- `ask_numbers` / `rerun` → `carryOutHeldVerdict` (held-underwrites.js), the
  nightly held sweep's own carrier and its own claim key, so day and night can
  never both ask, or both re-run on the same numbers. The two GHL reads the
  triage needs (the contact, their opportunities) are made here, only when a
  hold is in the way.

A promise younger than 30 minutes is left alone (the reply agent may be
starting the underwrite itself), and nobody who unsubscribed is driven. Every
float and start is claimed first (`audit_action`, `audit:promise_<move>:
<contactId>:<since>`). When the driver has moved, the promise sweep still
writes `promise_owed` (Today shows the row as waiting) but does **not** send
the "still working on it" text: one voice at a time. Everything the driver
starts is a draft in the ordinary lane; the gates, the auto-send list, the
caps and `CARD_SENDS_ENABLED` decide whether it leaves.

Adding the switch means a location that was at Normal or Full reads **Custom**
on the dial until the mode is pressed again (`detectAutonomy` matches the plan
exactly). That is the rollout: nothing new runs until Matt re-presses.

Re-pressing holds nothing (2026-09-18). The dial holds every reply that is
counting down only when the move takes something away: a switch going off, an
intent leaving an auto-send list, stricter send rules (`autonomyTurnsDown`,
shared/autonomy.js). It used to treat any move from Custom as down, so pressing
Full again to pick up new switches pulled back every reply about to send.
A half-on ladder set going fully on is not down either: that was prod's exact
shape on 2026-09-18 (every ladder on but the new hot push), the first version
of the rule read it as down, and ten nudges were pulled back. The undo is
`POST /api/offers/automations/autonomy/release-held { dryRun }`: every draft the
dial held in the last day that had passed the gates, and that the dial as it
stands would still send, goes back to scheduled (`dialHeldReleasable`), nudges
spread across the day as the sweep spreads them. A dry run unless `dryRun:
false`.

**Dismiss asks why.** One tap: Handled it by phone / We didn't owe anything /
They went quiet / Not a deal / Something else (`PROMISE_DISMISS_REASONS`); a
second press on the button skips it. The reason rides on the `promise_kept`
event with what we had said, and the nightly coach reads it as
`promiseDismissals`. "We didn't owe anything" more than once is a `code_gap`:
`detectPromise` is misreading something.

**Two other rows now say why and offer the fix.** "Priced, not floated" shows
why the float didn't go (`offer.proactive.skipped = { kind, reason, at }`,
written by `onOfferCreated`, cleared when a float does go). "Underwrites that
failed" offers Retry (the strip's own retry, while the run is in memory) and
Open what loaded when the run saved a draft.

**Today's read is local.** `heldTriageForPromises` (promise-sweep.js) runs the
held triage from the contact's timeline and drafts only. GHL is not asked, so
the tag and stage checks are skipped on the row; the nightly sweep makes them
before anything is actually done.

### Answers the bot didn't have (2026-09-17)

**Why.** Three of Today's "we owe them an answer" rows were the bot saying "let
me check with my partner" about things only Matt knows: the inspection window,
how we handle referrals, when a full PSA goes out. The row offered Dismiss. The
agent never got the answer, and the next agent to ask got the same deflection.

**The row.** An owed answer the resolver can't close (`move: "yours"`, `kind:
"partner_answer"`) shows the question they asked — the inbound of the reply
that deflected, via `questionIn` (shared/follow-up.js) — with a box. `isDeflection`
is the same read as a predicate, for anything that wants to count them.

**What typing an answer does** (`ghl-broker/partner-answer.js`,
`POST /api/dashboard/answers`):

1. Drafts it to that agent in the bot's voice: the `partner_answer` outbound
   kind, whose prompt is "say exactly this, add nothing". The figures typed
   are the only ones it may say. It is **not** in `OUTBOUND_INTENTS`, so it is
   never on the auto-send grid, and it is in `RELEASE_QUIET`, so the nightly
   audit never releases it. The owner's words leave on the owner's Send.
2. Keeps it as a standing answer in `conversationAi.answers` (`{ id, party,
   question, answer, at, draftId }`, 40 kept, oldest dropped), unless "Save for
   next time" is unticked. The system prompt carries them as **ANSWERS THE
   OWNER HAS ALREADY GIVEN** — facts, answer it yourself, don't say you'll check
   with a partner — filtered by party, the newest 20. An answer carrying a
   phone number, an email or a street address still goes to them but is never
   kept. The box offers Undo; the Conversation AI tab has the full list
   ("Answers you've given") to edit, add to, or prune.
3. Settles the promise (`promise_kept`, `by: "answered"`) and writes
   `partner_answered`, so the row leaves Today. If the draft can't start
   (the bot is off), nothing is saved and the row stays.

**Money.** A dollar amount in a standing answer is not added to the money
guard's allowed amounts. The bot will draft it next time and the guard will
hold the draft for a person, every time. The box warns before Send. Day counts
and percentages pass.

**The coach** is shown the answers as current guidance so it doesn't propose
them again. It never writes one: its validator refuses fees, earnest money and
amounts, which is exactly what these answers contain.

### Today's three groups, and the brake (2026-09-17)

**The groups.** Every action `buildPipeline` emits carries `group` (`groupFor`,
shared/pipeline.js), and Today shows three sections instead of one list:

- **Your call** — decisions only a person makes: drafts waiting, one-click
  hand-offs, closings, deals with no buyers, a priced offer nobody floated, a
  question for the answer box, last night's audit rows. Open, first.
- **Stuck** — the machine would normally handle it and couldn't, with why: a
  held or failed underwrite, a float that was skipped (`proactive.skipped`), a
  ladder that ran out, a thread gone quiet, a promised number behind a hold
  nobody's numbers clear. Usually a phone call or a fix to the data.
- **The machine is on it** — already moving: texts sending themselves (with
  when), a promise waiting on an underwrite or on their answer, and, with
  `driver.promises` on, the move the driver makes on its next pass. Collapsed;
  each row says `Next: …`. A driven promise row has **Stop**.

The KPI row reads Your call / Stuck / Machine is on it (`counts.actions.byGroup`).

**The brake.** `shared/thread-health.js` `threadHealth({ offer, drafts, events,
now }) → { drive, reason, detail, since }`. Every driver asks it before it
claims anything. It stops on, strongest first: they opted out · you pressed
Stop · it is a deal now · they passed (a rejection as their newest word, or a
dead status) · the house is pending or sold (`OVER_PLAIN`, the strict one:
"a few went pending nearby" and "sold as is" do not trip it) · they sound
annoyed (`IRRITATED_RX`, words only, read from their newest three messages) ·
you answered by hand in the last 3 days · two texts we started are sitting
unanswered. There is no tone field on the classifier; the regex is the first
version on purpose, and the coach's dismissal reasons will show what it misses.

The existing ladders keep their own rules. The brake is for what the machine
starts by itself between rungs.

**Stop / Resume.** `POST /api/dashboard/drive/stop` and `/drive/resume` write
`drive_stopped` / `drive_resumed`. A stop from Today is the whole thread with
that agent, until Resume; a stopped promise row moves back to Your call.

### Rows that were never a decision (2026-09-18)

Read off Today the day before a week away; three kinds of row the machine made
for itself:

- **A check-in that re-quoted an old price.** The `passed_checkin` prompt said
  "you may mention the number we offered (it's in the offer book)". A passed
  offer's number is not in the book, so the gate held every one, five in a
  day. The prompt now names no number at all ("where we were"): an August
  price said again in September recommits us to it.
- **Nothing to say back.** "That was an auto dial" is small talk with an empty
  reply. With no actions no draft is saved; with a routing tag stamped on the
  way a row was saved and waited. Now it closes itself (`dismissed`, flag
  "nothing to say back — not sent", which the coach reads as the machine's and
  not a person's). A suggested action still keeps the row.
- **A check-in on a house WE walked from.** Two ways an offer dies by a
  decision (`shared/offer-status.js`): `passed` is theirs and keeps its
  check-in ladder (every ten days: would the seller come closer?). `we_passed`
  is ours, and it ends the chasing — Matt, 2026-09-22, the Medina thread:
  the ladder had asked whether the seller moved, the agent asked for best and
  final, and the bot promised a number. Now marking `we_passed` (single or
  bulk) dismisses every open text the machine started about that house
  (`stopMachineTextsForOffer`, flag "we passed on … — not sent"; replies to
  something they said are left alone), the auto-send path refuses one that
  slipped through, and the offer book marks the house "WE WALKED AWAY" with a
  `WE PASSED` rule in the agent prompt: no chasing, no number, a new number
  from them is `needsHuman`. The passed-offer ladder and the price watch never
  read `we_passed` to begin with.
- **A ladder drafting someone who had asked off.** An agent wrote "take me off
  your list" on 8/18, before the bot, and carried no tag. `optOutInTranscript`
  (shared/conversation-ai.js) reads THEIR lines of the thread; anything the
  machine starts (`startProactive`) stands down before the model is called:
  "they asked to be left alone on <date> — nothing is drafted". Stricter than
  `detectOptOut` on purpose ("Stop by the open house" is not an opt-out). It
  tags nobody: a false positive costs one nudge, not a contact. An answer to
  something they send is not this path.

### The nightly coach (2026-09-17)

The bot used to get better only when Matt noticed a bad reply and said so in a coding session. The coach closes that loop. An hour after the audit (8pm Pacific by default) it reads what a person did with the day's drafts and **proposes** what the bot should learn. It never applies anything; Today's "Learned last night" card is where a person answers.

- **What it reads** (`shared/coach.js` `gatherSignals`): drafts sent edited (the bot's words beside yours), drafts a person dismissed or held, threads you answered yourself, gate reasons seen twice or more, intents you keep rewriting (under 70% as written over the graduation window), the audit's errors, and the night's `app_errors`. A draft the machine binned (dead deal, unsubscribed, you got there first) is not a verdict on the words and is left out.
- **The why**: Dismiss, and Send on an edited draft, take an optional one-tap reason (`DRAFT_FEEDBACK` in `shared/conversation-ai.js`), kept on the draft as `feedback { code, note, at }`.
- **One model call a night, none on a quiet one.** Nothing edited, dismissed or broken means no call.
- **Four kinds of proposal**: a voice `example` (your edit, verbatim), a house `rule`, a standing `instruction` for one party, or a `code_gap`.
- **What it may not touch** (`validateProposal`, enforced in code, not asked of the model): anything naming an amount or a percentage, fees, assignment, earnest money, what the bot may commit to, auto-send, the counter band. Also dropped: a proposal with no draft of yours behind it, one citing draft ids it wasn't shown, one carrying a phone, email or street address, one the prompt already says, one that would overflow a cap. Six a night at most. A rejected lesson is not proposed again for 30 days.
- **Apply / Revert**: Apply writes through `saveConversationConfig` (the same save the config page uses) and keeps an `undo` on the proposal. Revert removes exactly what Apply added, so a rule you wrote by hand in between survives.
- **Try it first**: drafts the evidence messages with and without the proposal, beside what you sent. Drafted cold (no contact, no thread, no deal book) because the live thread now holds your answer. Voice, not numbers. Up to 3 drafts, two model calls each, only on a press.
- **Did it help**: each applied proposal carries a scorecard, as-written % for its party and intent over the 14 days before and since. It reports "worth a look"; it never reverts on its own.
- **Code gaps** are filed, not applied: "File for a fix" opens a GitHub issue labelled `coach` (Settings → Nightly coach → GitHub: `githubRepo`, `githubToken`, fine-grained, Issues read/write on this repo only). `issueFor` cuts names to first names and removes phones, emails and street addresses; the issue carries draft ids, not thread text. The scheduled coding agent (`.claude/coach-agent.md`) takes one issue a run, writes a failing test, fixes it and opens a PR. It never merges. It has repo access and no app secrets.

Switch: Conversation AI tab → Nightly coach (`conversationAi.coach { enabled, hour }`). **Off by default.** The autonomy dial does not touch it, since it sends nothing. Routes: `GET /api/dashboard/coach`, `POST /api/dashboard/coach/run { dryRun }`, `POST /api/dashboard/coach/:id/{apply,reject,revert,file,preview}`. State: table `coach_proposals`; run state on `job_cursors` name `coach` (the audit's gate: cursor written before the run, stale run retried, 3 tries a night). `coachedThrough` on the cursor is the bookmark, so a missed night is read the next one (72h at most).

### Teaching the bot from Today (2026-09-22)

Every row on Today is a place the bot stopped and a person had to act. Matt
asked to say, on each one, what the bot should have done instead, and to
have that feed the coach. **Teach it** on every row — drafts, "From last
night", held underwrites, owed numbers, timers, pulse checks — opens four
chips and a note (300 chars): *Should have replied itself · Should have
taken an action · Wrong read of the message · Right to hand it to me*. It is
separate from resolving the row: saving changes nothing about the row, and
the draft chips ("What was wrong with it?") stay where they were. The row then
reads "noted · <category>"; a second save is a newer verdict.

- **Where it lives.** One `contact_events` row of type `row_feedback` per
  save (`shared/row-feedback.js`; the write is `ghl-broker/row-feedback.js`
  `recordRowFeedback`). `data` carries the row id and kind, the category and
  note, and — read from the draft on the broker, never from the client —
  what they said, what the bot wrote, the party and the intent. Newest per
  row wins (`latestRowFeedback`). A row with no contact (a blast) is filed
  under the sentinel contact `_today`, so no profile is made up. Draft rows
  are keyed `draft:<draftId>`; every other row by its pipeline id.
- **Routes.** `POST /api/dashboard/feedback` writes it; `GET
  /api/dashboard/pipeline` returns `rowFeedback` by row id and sets
  `feedback` on each action.
- **What the coach does with it.** `gatherSignals` shows the model
  `rowFeedback` (the three learnable categories, each with an `fb:<eventId>`
  it may cite, plus the draft id behind it) and `counterEvidence` ("Right to
  hand it to me", no id: nothing may be built on it). Per category: should
  have replied → an instruction or rule, unless a gate or a person's-call rule
  held it, which is a `code_gap`; should have acted → a `code_gap` naming the
  action; wrong read → an example or a rule. A night with only feedback is not
  a quiet night. `HANDS_OFF` was tightened at the same time: a rule naming
  never-auto, guarded-auto, the gates, "bypass" or "without review" is dropped
  — the bot is never talked around its own gates by a rule.
- **What is never done.** Nothing is applied on its own (Apply on the Learned
  card, Matt's 2026-09-17 decision); no new send or spend switch; the note is
  never logged and never leaves the app unscrubbed (issues carry ids and a
  scrubbed `why`); the row's title (a name and a street) is kept in `data`
  and not shown to the model.

### Today's work pane (2026-09-23)

Today used to be a long list with a different look per row kind: drafts had
the outbox row, promises had op buttons, questions had the answer box,
"Teach it" hid behind a link, and the offer, the thread and the coach's
lessons were each somewhere else. Matt asked for one surface per row with
all of that visible at once, and an easy way to go to the next row.

**The layout** (`messaging-app/src/WorkView.jsx`, an inbox split):

- **The rail** (left, `WorkRail.jsx`): the queue in work order, which is Your call,
  Stuck, then The machine is on it (folded unless you are in it), and kind by
  kind inside each (`orderRows`, `messaging-app/src/work-queue.js`). It has a
  filter box. A tick marks a row you've taught.
- **The header**: what the row is, why it's here (`detail`, "Stuck because",
  "Next:"), and its own buttons. These are the same ops, confirms and toasts as
  before, now in `RowOps.jsx`.
- **Offer** (left, `OfferPanel.jsx`):
  - Our offer, asking, their counter, the agreed price, ARV and repairs.
  - The **all-in % of ARV**: (price + repairs) / ARV, green up to 70, amber up
    to 74, red above. That is the buyer ceiling from the 2026-09-10 post-mortem.
    It is shown at our number and at their counter.
  - What happened (sends, status changes), the offer PDF, how the machine
    priced it, the rehab scope, and their other offers.
  - A row with no offer says so and offers **Start one**.
- **Conversation** (right, `ConversationPanel.jsx`): the whole GHL thread
  (100 messages), refreshed every 30s. Under it is the reply box:
  - When the bot has an open draft for this person, the box is that draft
    (`DraftRow embedded`). Edits, reasons, Dismiss and Hold work as they do
    everywhere, so the coach still sees them.
  - A question the bot couldn't answer gets the answer box instead.
  - Otherwise it is a plain box (the hand reply, below).
- **Coach** (bottom, `CoachPanel.jsx`):
  - Teach it, always open.
  - What you taught on this person's rows before.
  - The nightly coach's open and applied proposals whose evidence is this
    person's drafts or feedback on their rows. Apply and Reject work as on
    the Learned card; nothing applies itself.

**Keys:**

| Key | Does |
|---|---|
| J / ↓ | next row |
| K / ↑ | previous row |
| R | the reply box |
| T | the Teach note |
| O | open the offer in the editor |
| ⌘↵ | send (in the reply box) or save (in the Teach note) |
| ? | show the list |

Keys are ignored while typing, in a menu, or while the contact record is open.
The open row is kept in `?row=<id>`. When the row you're on is resolved, the
pane moves to the one after it ("Done — next: …"). The next row's offer,
thread and lessons are read ahead (`work-data.js`).

**Below laptop width:**

- The rail becomes a picker in the header.
- Offer and Conversation become two tabs.
- The KPI tiles are now a one-line strip; the group counts are on the rail.

**The hand reply** (`POST /api/contacts/:id/reply`, `ghl-broker/hand-reply.js`).
This is the one new send, for a person typing when the bot has nothing open.

- **Dry run unless `CARD_SENDS_ENABLED`**, like every send. SMS only, 1600
  characters at most.
- **The bot stands aside.** It dismisses the person's open drafts
  (`answeredBy: "you"`, "you answered it yourself") and writes a `hand_reply`
  event.
- **The brake.** `threadHealth` reads that event as `person_has_it` for three
  days, so the drivers, timers and audit leave the thread alone.
  `humanHasThread` already read a text that matches no sent draft as a person.
- **No words stored.** The event carries the GHL message id and a character
  count, never the words; nothing about the contact is logged. A failed GHL
  send writes nothing.

**Per-contact lessons.** `GET /api/dashboard/coach/contact/:contactId` returns
`{ canFile, proposals, taught }`. It uses `proposalsForContact` (shared/coach.js),
which matches draft ids and `fb:<eventId>`; only open and applied proposals
are returned, and applied ones carry their scorecard.

Also: a promise row is named after the agent (from their offer or their
drafts). It used to fall back to "An agent", because the name lookup only
knew buyers.

### Durable errors (2026-09-17)

Failures in the reply agent, proactive drafts, the underwriter, the 15-minute sweep and the coach used to live in Render's log or on an in-memory job a redeploy forgets. `recordError` (`ghl-broker/app-errors.js`) keeps them in `app_errors`, one row per distinct failure (fingerprint of area + message with ids and numbers flattened), counted. The message has phones and emails knocked out and the context is ids only. It never throws. The coach reads the night's rows; a repeated one becomes a `code_gap`.

### Held underwrites — the nightly triage (2026-09-16)

"Underwrites that need a look" held 49 rows and Matt wasn't going to get to
them. Read against the conversations and the GHL stage, most weren't
decisions: test rows and dry runs; houses that had gone pending or turned out
turnkey; two-week-old holds the agent never wrote back on; and a dozen held
on thin comps or too few photos — things the agent could have told us, and in
three cases already had.

**What it is.** `shared/held-underwrites.js` `triageHeldUnderwrite` is the
verdict, pure, one held draft in. `ghl-broker/held-underwrites.js`
`sweepHeldUnderwrites` reads what it needs (the contact's offers, timeline,
drafts, GHL tags, opportunity stage) and carries it out. It rides on the
nightly audit — same run, same result, same card — and by hand from the
card's Run now (dry run first). `nightlyAudit.heldSweep: false` turns it off.

The verdicts, in order:

- **drop** (deleted): no address, a test address, a dry run; a newer draft or
  a priced offer already on the same house.
- **retire** (a status, a reason on the row, an `offer_*` event, a GHL note):
  they unsubscribed / bot-off tag / GHL opportunity lost or in a cold stage
  (Tier 3, passed on offer) → `we_passed`; the agent said pending, sold, not
  interested, under contract → `passed`; turnkey per the agent → `we_passed`;
  held **14 days** with no word → `we_passed`; we asked for their read
  **7 days** ago and heard nothing → `we_passed`. The `uw-needs-review` tag
  comes off once nothing of theirs is held.
  Their numbers are read by house, not by the full address key: Shelley
  Elenbaas' 100k (2026-09-21) was filed under the thread's "161st Court NE,
  Redmond, WA", the rerun looked under the listing's "161st Ct NE, Redmond,
  WA 98052", and the underwriter held again on the photo rule with our 16.5k
  scope. `propertyDossier` and the photo gate's `describedWork` match by
  `sameHouse` (street and city, ZIP optional).
- **rerun**: the holds are all ones the agent's numbers answer (value: thin or
  no comps, unknown sqft; work: too few photos, scope past the band) and the
  timeline has their ARV / rehab dated after the hold → `startUnderwrite`
  with `replaceOfferId` (the retry button's path); `agentNumbersRescue`
  prices it on their figures, bounded (value ≤125% of any list price we
  know — the listing's, the seller's ask on the timeline, or the message's;
  the cap used to read only the listing, so a park home with no live
  listing never rescued). Their value with no list price at all → yours.
- **ask**: rescuable holds, the missing number(s) not on the timeline, the
  thread alive (they wrote within 21 days, or the hold is under 3 days) →
  one `take_ask` text asking for exactly the missing piece — "what's it worth
  fixed up" and/or "what would the work run" — no number of ours. Released by
  the audit like a nudge, sent at the next open minute. Never while a
  `promise_due` text from the last 3 days already asked. Their answer lands
  as an `agent_estimate`, the reply agent's own re-run rule
  (`rerunHeld`) or the next night's **rerun** finishes it.
- **wait**: asked under a week ago — nothing.
- **yours**: a structural flag, an address we couldn't place, a run that
  stopped early, their numbers that didn't clear it either.

Every ask and rerun is claimed first (`audit_action`, keyed on the hold or on
their newest number) so nothing starts twice. Dry run reports and touches
nothing. **A held draft a person published is not "needs a look"** any more
— the queue row is only for an unpublished draft (Erin Twedt's 20531 S
Danvers sat there a day after its number had been floated).

### Sounding like a person (the send layer)

Conversation AI page → "When it sends on its own". Three things beyond the
delay band and the hours:

- **Intent-aware delay.** Quick intents (a question, a check-in, "send me
  details", a time) go in the quick band (45–180s default); slow ones (a
  new deal, a counter, a pass, "we want to buy") in the slow band
  (10–40 min); everything else in the default band. Whatever the band, a
  reply never leaves faster than it takes to type at four characters a
  second (`conversation-scheduler.js`).
- **Spread, not bursts.** What the machine *starts* — follow-up nudges, cold
  opens, blasts — lands somewhere in the first N hours of the day
  (`nudgeSpreadHours`, default 8), not all at the opening bell. The ticker
  also paces: at most 20 sends a tick, a couple of seconds apart with
  jitter, so two texts never leave in the same second and a 200-buyer
  blast takes the morning.
- **Weekends.** `replies_only` (default) answers what comes in and starts
  nothing until Monday; `all` treats Saturday like Tuesday; `none` sends
  nothing at all until Monday.

### Phone calls as an inbound

A finished call runs the same pipeline a text does. Wiring, in GHL:

1. Turn on **call recording and transcription** for the numbers you use
   (Settings → Phone Numbers → the number → call recording + transcription).
   Without it there is nothing to read; the broker leaves a bare
   `call_summary` event saying so.
2. Nothing else. The broker **polls**: every 15 minutes it asks GHL for
   conversations that moved since its last look (`job_cursors` row `calls`)
   and reads every new call message through the intake — no workflow
   trigger needed. (The "Call Status" workflow trigger exists only for LC
   Phone numbers; if you have it, a workflow posting to
   `POST /api/offers/automations/call` with `x-underwrite-secret`,
   `location_id`, `contact_id` reads the call a few minutes sooner, and the
   per-call key makes the poller's second arrival a no-op.) Switch:
   `conversationAi.callIntake.enabled`, on with the bot.
3. The Private Integration needs `conversations/message.readonly` for the
   transcription endpoint (it already has it for call transcripts in the
   nightly sweep).

What happens (`ghl-broker/call-intake.js`): the broker answers 202, waits for
GHL's transcript (30s polls, up to ~10 minutes), then hands the transcript to
the reply pipeline as `inboundKind: "call"`. Party, record book, intent and
numbers are read from what THEY said; the actions fire as on a text (tier
tags → pipeline, an underwrite on an address they named, offer marks, a
booking under the calendar guard); profile facts are learned; a
`call_summary` event with the one-line summary lands on the timeline (key
`call:<messageId>`, so a workflow that fires twice reads the call once). The
draft is the text a person sends right after hanging up. It sends itself only
when **text after a call** (`call_followup`) is ticked on that party's
auto-send list *and* the intent read from the call is allowed — a counter
named on the phone still parks. "Stop" said in a call is a word, not an
opt-out. Calls under 40 transcript characters are recorded and skipped.
`GET /api/offers/automations/call` lists recent intake jobs.

### Booking calls (the calendar as a guard)

Conversation AI page → "Booking calls". Pick a calendar (needs
`calendars.readonly` and `calendars/events.write` on the Private
Integration; a calendar id can be pasted without the list). When a message
sounds like scheduling — or we recently offered times — the broker reads the
calendar's free slots for the next N days, hands the model two or three of
them with exact labels ("Fri Sep 11 at 10:00am"), and the reply may name
ONLY those. The guard (`shared/booking.js`) checks every time the model says
it offered is on that list and appears verbatim in the text; when they pick
one, it checks it was one we offered and is still free, then `book_call`
runs and the appointment lands on the calendar with a `call_booked` event
and a note. A reply that confirms a booking the calendar refused is held.

"Wants a call", "scheduling" and "wants to walk it" stay locked on the
auto-send list; this is the one door through that lock, and it opens per
message, exactly like the counter band. Both guards now actually release:
the gate used to trip "a counter is a person's call" before the release
code ran, so the band could never open in production — fixed alongside
this (`evaluateReplyGates` now names the lock apart from the other gates).

### The offer sends itself

Two doors, both shut by default.

**On realm-yes.** The starter's `realm_yes` rule now carries a `send_offer`
action beside the tag and the note. It has its own mode: **ask** (the row
shows "Send the formal offer" as a one-click action, and it also appears in
the Pipeline queue under "One click from you") or **send it on its own**
(the documents go the moment the intent is read with confidence). Channels
and documents are set on the action (text with the letter image + PDF by
default). The rule's mode is a ceiling — an action can never run inside an
ask rule. Behind it is the same function the Send button uses, so the
lifecycle, the `sends` record and the status advance are identical; an offer
that already went out is reported, not re-sent.

**After a clean underwrite.** Agent playbook → "Send the offer after a clean
underwrite". When an auto-underwrite finishes with status `new` (every gate
passed — a gate-held DRAFT never qualifies), the agent has replied to us at
least once, and the clock is inside the auto-send hours, the documents go by
the playbook's channels with no realm check. Otherwise the usual float
drafts. Needs `CARD_SENDS_ENABLED`; a note is left on the contact.

Both write an `offer_sent` event with `data.by` = `conversation` or
`underwrite`, so the funnel can tell a machine send from a person's.

**The agent page rides along.** An unattended send has no operator to tick
"include the link", so the send builds the agent-facing offer page itself (the
modal's defaults — breakdown off, note prefilled) if the offer has none, and
puts its `/o/<token>` link at the end of the text and in the email body. A page
the operator *revoked* is left switched off and no link goes out; a page that
won't build never blocks the paper. A send that carries the operator's own
message is untouched — SendModal already appends the link there, and unticking
that box is a decision the server must not undo.

### Walking away (2026-09-16)

Matt: "be quicker to pass on ones that aren't in our buy box and move on. If
the agent keeps pushing back, say sorry this one didn't work out, move them
to Tier 3/2, stay in touch, and mark it they passed." The counter block in
reply-agent.js (`WALK_AWAY_GAP`, `listPriceFloor`):

- **Their floor is the list price, said in words.** "Current list price",
  "full asking", "nothing under list" on a rejection, counter or question
  reads as a counter AT the list price (Bryce Buri: "Current list price" =
  1,195,000 against our 1,038,419, held as a counter with no figure).
- **Out of reach is a pass, however it's put.** Over `COUNTER_PASS_MARGIN`
  (10%) past the most we'd pay, a plain or firm floor was already a pass; a
  soft one ("if you were around 430 we'd consider it") still gets one round —
  their value and repairs asked for, one re-quote. Past `WALK_AWAY_GAP`
  (25%) or at the list price, the soft round is skipped too.
- **The goodbye** names no number: "Sorry, this one didn't work out for us,
  we're too far apart on the number. Appreciate you working it with me.
  Keep me in mind for the next one that needs work, and if anything changes
  with the seller I'm here." The second no with no number closes the same way
  (prompt: no second ask, no new number).
- **What follows** is the rejection rule as configured (prod: tier-3 + TIER 3
  workflow + `mark_offer_passed`) and the passed-offer check-in ladder
  (every 10 days) — that is the "stay in touch".

### Terms the bot holds (2026-09-16)

**The inspection period.** Our diligence is the feasibility window after mutual
acceptance, and it is not the thing we trade away to win a deal: **7–10 days is
the floor, 14 is what we normally write, longer is better.** The bot may say we
need the window and why (it is what lets us close fast, cash, with no lender)
and ask what the seller actually needs — but it may never agree to a specific
window or name a shorter one, and under 7 days is not its conversation at all.
Those land as `needsHuman` with the reason.

**No pre-inspection.** We do not send an inspector or a contractor out, and do
not schedule an inspection, in front of a contract — whoever offers to pay.
Asked, the bot says our inspection happens in the feasibility window once we're
under contract, that we can move quickly on it, and asks what timeline the
seller needs. It never refuses coldly and never explains our reasons. This is
about an inspection before a contract and does not change "Seeing the house"
above, which still lets a person go out as the last step before a deal.

Both live in `buildSystemPrompt` (agent party only — an investor is never told
any of it). From Saundra Mock on 13041, 2026-09-16: "your 12 day inspection
contingency is a killer… she wants you to preinspect, so obviously the fewer
days the better." The bot had a policy for neither half, so it promised twice
to run it by a partner and the thread sat two days.

### A counter typed short, and a thread nobody answered (2026-09-16)

Thomas Rinow answered our $456,250 on 10412 SE 219th with **"That are willing
to go to 670"** — the number we had just asked him for — and heard nothing back
at all. Two faults, both fixed:

- **670 is not $670.** `moneyIn` refuses a bare integer on purpose ("14" is a
  day count, "2026" is a year) and the leak guard needs that. On a counter it
  meant their number read as *under* ours, so the band failed on "at or under
  our own number" and the draft parked. `counterDollars` (reply-agent.js) now
  reads a bare number beside price language — "go to 670", "get them to 650",
  "you need to be at 610" — as thousands, but only when it lands in a
  house-price band around our own offer (half to five times it), and only one
  candidate: two different numbers are left for a person. It fills the model's
  0 as well as rescaling its 670, and the band's "their own words" check reads
  the message the same way, so the arithmetic decides instead of the spelling.
  The model is told the same rule in the prompt.
- **A held draft is a list, not a clock.** When an agent's text leaves us
  silent, a `checkin_requested` event with `kind: "unanswered"` starts the
  check-in sweep two mornings on, and a contact note says so with their message
  in it. Only when THIS thread is waiting on a person (`HELD_FOR_A_PERSON`: the
  gates, a person's-call intent, the band didn't open, the intent isn't on the
  auto-send list) — never because sends or the bot are off for the whole
  location, and never on an opt-out, small talk, a message that already booked
  a check-in, or one that started an address chase. The check-in itself never
  apologises for the gap and never mentions it: it picks the thread back up
  where they left it.

## Hardening notes (2026-09)

- **API keys never leave the broker in the clear.** `GET /api/offers/settings`
  returns a blank for each key with `secrets: { field: { set, last4 } }`;
  the Settings form shows "set · ends abcd" and a blank on save means keep.
  `?reveal=1` returns them only for a location with a `GHL_LOCATION_KEYS`
  entry (which the request had to present). To read a token off prod for
  debugging, set a location key first.
- **Every daily sweep has a durable cursor** (`job_cursors`): follow-up,
  outreach, dispo second wave, the GHL mirror, and now the nightly
  enrichment sweep (`enrichNightly`) — a redeploy inside the trigger hour no
  longer re-spends model calls.
- **RentCast budget.** The outreach sweep stands down at 45 of the free
  tier's 50 requests for the month (`rentcastMonthlyBudget` in settings
  overrides). The buttons keep the last five.
- **Console smoke tests.** `cd messaging-app && npm test` (vitest, server
  rendered): the Autopilot card, the action queue, the playbooks/booking/
  auto-send cards on the shapes the broker actually sends.
- Still in memory, by design: the underwrite / reply / feedback-scan job
  registries. A restart loses job *visibility* only; every write they make
  is idempotent and every durable decision is a `contact_events` row.
- `routes/offers.js` is past five thousand lines. Splitting it into offers /
  deals / automations routers is mechanical and pending.
- Render still carries `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` from the
  review-card era; nothing reads them. Rotate and delete.

## GHL pipeline mirror (Opportunities)

Settings → "GHL pipeline mirror". The Pipeline tab stays the truth; this
projects it onto GHL's Opportunities board, one way, every fifteen minutes
on the broker's tick (bounded to 60 writes a pass; "Sync now" runs up to
200). Map each side to a GHL pipeline and each lane to a stage:

- **Acquisitions — by tier (default).** One opportunity per AGENT, in the
  stage their tier maps to: Tier 1 (has a deal / new property), Tier 2 (open
  to investors), Tier 3 (passed / no fit), optionally "no tier yet". This is
  how the GHL Acquisitions pipeline actually reads. The tier is the truth
  the record holds: the tags GHL showed us last (the profile's snapshot),
  with every tier tag the Conversation AI added or removed since replayed on
  top — so a tier the bot moves is on the pipeline at once (the tag action
  fires the mirror for that agent), and a live deal counts as Tier 1
  whatever the tags say. Snapshots older than a day are re-read from GHL,
  thirty a pass, so tags a workflow set outside the app also land within a
  day. Value = the newest open offer's cash number. Memory of what was
  written: `job_cursors` rows `mirror:agent:<contactId>`.
- **Acquisitions — by lane (optional).** One opportunity per PROPERTY:
  Not sent · Floated · Sent · Countered · Needs review, plus where a passed /
  no-response offer goes (marked **lost**) and where one that went under
  contract goes (marked **won**). A lane left as "leave the stage alone"
  only writes the status.
- **Dispositions**: Under contract · Buyer found · Assigned · Closed (won) ·
  Fell through (lost). Value = contract price + assignment fee.

One opportunity per property per side, named by the address, valued at our
cash offer on the agent side. An opportunity already on the contact in that
pipeline with the same name is adopted, not duplicated. What was written is
remembered on the offer (`offer.mirror`, on the lean row) so unchanged
offers cost nothing; a stage somebody drags in GHL is overwritten next
pass. Needs `opportunities.readonly` + `opportunities.write` on the
Private Integration. Pure plan: `shared/ghl-mirror.js`; writer:
`ghl-broker/ghl-mirror.js`; `GET /api/dashboard/ghl/pipelines`,
`POST /api/dashboard/ghl/mirror/run`.

## Today / Autopilot / Reports (the old Overview, split 2026-09-13)

The Overview menu link used to hold four crowded tabs. It is now three GHL
Custom Menu Links, each one job, each component in exactly one place:

| Menu link | URL | Tabs |
|---|---|---|
| Today (the old Overview link — rename it) | `https://<site>/dashboard?location_id={{location.id}}` | Needs you (the work pane: the queue down the left in three groups — your call · stuck · the machine is on it — and one row at a time as offer · conversation · coach; `&row=<id>` opens a row) · Board |
| Autopilot | `https://<site>/autopilot?location_id={{location.id}}` | Controls (the dial + every switch) · Conversation AI |
| Reports | `https://<site>/reports?location_id={{location.id}}` | Flow · Activity (charts) · Lessons (outcomes + fell-through lessons) |

Old links redirect: `/dashboard?view=flow|dashboard|conversation` →
`/reports?view=flow`, `/reports?view=activity`, `/autopilot?view=conversation`
(other params kept). Cross-app links go through `messaging-app/src/links.js`.

## Flow (the Reports landing tab)

`/reports?view=flow` — the river. Twelve stages in two rows (acquisition:
found → first text → replied → underwritten → offered → floated → countered
→ under contract; disposition: blasted → opened → buyer → assigned/closed),
each with its count in the window, a bar split violet (the machine on its
own) / grey (a person), and arrows carrying the share of the previous stage
that reached this one. Under it "What moved": every movement in the window, newest first, filterable to
the machine / people / acquisition / disposition, with contact and offer
links. Windows: today / 7 / 30 days, or a single past day. Polls every 30s
while visible. Pure builder `shared/flow.js` (`buildFlow`, `machineDid`);
route `GET /api/dashboard/flow?days=&end=&tz_offset=`, uncached local tier.
The timeline renderer is `messaging-app/src/EventFeed.jsx`, shared with the
contact drawer.

## Contact record (the app is the system of record; GHL is the digest)

Every agent and investor has a record in the app: **facts** with provenance
(what they buy, what they've told us, their brokerage, the property they're
on about — each with where it came from and when) and an append-only
**timeline** (every offer, revision, counter, pass, deal stage, blast,
dataroom link and view, conversation summary, sweep run, tag change, note).
Two tables, `contact_profiles` and `contact_events`; the dispo `investors`
re-sync never touches them and nothing is ever dropped for length.

**GHL's custom fields keep their exact meaning.** `personal_details`,
`buybox_*`, `agent_deal_history` and the rest are now a *digest* rendered
from the record: every writer that used to write only to GHL first records
to the app, then makes the same GHL write it always made (the tests assert
the payload is byte-identical). Your workflows, tags and filters see no
change. What changed is that the record behind them is complete — a ledger
field that drops its oldest lines at 2,000 characters is a summary, and now
it is only a summary.

**Precedence.** The record wins where it has a value; GHL fills the gaps. A
field someone typed straight into GHL is pulled into the record as a fact
with source `operator` on the next drawer open, dispo sync, or backfill.
GHL never deletes anything from the record. Deleting is a drawer action:
removing a fact there leaves a tombstone (the sweep cannot put it back) and
re-renders the GHL field without it.

**The drawer.** Click any contact name — an outbox row, a deal's agent or
buyer, an offer in History, an investor in the book — and their record
slides in on either host; `?contact=<id>` deep-links to it. Facts wear a
source chip: violet when the AI inferred them (a text, a call, the sweep),
slate when a person stated them or a record produced them. Add a fact there
and it projects into GHL the same way. "Pull from GHL" re-reads the contact.

**Fill it once.** Settings → *Contact record* → **Fill the record** walks
every offer, deal, draft and dataroom invite in the app (no GHL calls), then
reads each contact from GHL once (150 ms apart) and files its fields and
ledger lines. Every event carries a dedupe key, so a line the app derives
from an offer and the same line GHL already holds land on one row; running
it again reports 0 new. Operator-triggered, never on boot.

**What the model reads.** The prompt builders take the record first: the
newest twelve ledger events rendered in the same line format, and facts
laid over the GHL fields (record wins, GHL fills). A contact with an empty
record reads exactly as before — the test asserts it byte for byte. The
auto-underwriter's Subject Property read prefers the record's aim over the
field; the dispo sync reconciles each investor from the contact it already
holds and renders the cache's buy box record-first.

**File store.** Without `DATABASE_URL` the record lives in `data/store.json`
under `contactProfiles` and `contactEvents`, never pruned — fine for dev,
not a production shape.

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
5. Pulls can still be run by hand; `POST /api/outreach/pull` with just
   `location_id` defaults its market params from Settings and lands in the
   most recent batch (auto-creating one if none exists); pass `"batchId"` to
   target a specific batch.

### The daily sweep (outreach autopilot)

Settings → Agent Outreach → "Run outreach every day on its own". Once a
weekday (the `OUTREACH_SWEEP_HOUR` hour in Pacific time, default 10 = 10–11am,
on the broker's 15-minute tick, `job_cursors` row `outreach`; untick "Weekdays
only" for every day) the broker pulls — with a county list, the next pages of
one county at a time (`job_cursors` row `outreachPages`), filtered at RentCast
to listings at least 45 days old of the chosen property types, with requests
spread over the month to a hard stop of 48 — picks the most distressed
agents nobody has talked to (status new, no GHL match, a phone, at least one
distressed listing unless you untick that), imports up to the daily cap
(default 12, max 500), and says hello the configured way.

The follow-up (`outreach-followup.js`, `OUTREACH_FOLLOWUP_HOUR`, default 11am
Pacific, row `outreachFollowUp`) puts agents enrolled by the "GHL workflow"
first touch who haven't answered in N days (default 14) into the follow-up
workflow. It needs `conversations.readonly` to see who wrote back.

**When it doesn't happen (2026-09-16).** The sweep started at 10:03,
imported one agent at 10:08 and then sat "running" on a GHL request that
never answered; the tick saw a run in progress and never retried, and the
11:02 deploy wiped the job with the day stamped as done. Three fixes:

- **No GHL call waits forever** — `GHL_TIMEOUT_MS` (30s) on every request in
  `ghl.js`, so a hang throws and the retry machinery gets its turn.
- **The run lives on the cursor, not just in memory**: `doc.run` while it is
  going, `doc.last` (county, imported, candidates, already-in-GHL, error) once
  it is over. A run the cursor says is going with nothing behind it for
  `STALE_RUN_MS` (45 min) is retried as if it had failed. `GET
  /api/outreach/autopilot` returns `run`, `last`, `tries`, `failed`, `error`,
  and the Agent Outreach strip shows them when no job is in memory — so
  "what happened to outreach today?" is answered by the page.
- **A failed day comes back until the working day is out**: six tries,
  twenty minutes apart at least, 10am–5pm Pacific (`MAX_DAILY_TRIES`,
  `RETRY_WINDOW_HOURS`), not three tries by lunch.

**Who says hello** is a setting. `app`: the bot drafts the first text from
the hook listing (`outreach_open` on the agent playbook — turn on "First text
to new agents" there) and the GHL trigger tag is *not* applied, so the
workflow template cannot text them too. `ghl`: the trigger tag as before and
no bot draft. Either way the import needs `OUTREACH_IMPORTS_ENABLED=true`;
without it the sweep pulls and reports who it would have imported.

The first text is draft-only until `first text about their listing` is ticked
on the agent auto-send list — that is the shakedown. When it actually leaves,
an `outreach_sent` event lands on the contact, and that is what the
"Reached out, no reply" ladder (2/5/9/14/21/30 by default, off by default)
counts from. Any reply, an offer, a realm-yes, or a deal ends the ladder;
when it runs out the agent is counted on Reports → Flow ("N cold agents never
answered", `counts.coldNoReply`). It is not a row on Today (2026-09-17): there
is nothing for a person to do about an agent who never answered.

On the Agents page the strip at the top says whether the sweep is on, when
it last ran, and offers "Preview today's sweep" (pull + pick, writes nothing
to GHL — a cold cache still spends RentCast requests) and "Run it now".
`GET /api/outreach/autopilot` returns the same; `POST /api/outreach/autopilot/run`
with `{ "dryRun": false }` runs it.

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
   contacts that lost their tag. Re-run it after tagging new buyers, or tick
   Settings → Dispositions → "Sync the investor list from GHL every night"
   (`dispoAutopilot.bookSync`, off by default, 4am Pacific, audit-style
   retries on the `investorBookSync` cursor; `GET /api/dispo/investors`
   returns its last run as `nightlySync`).
2. **Buy box** = the contact record's buy-box facts first, then the `buybox_*` /
   `rehab_appetite` GHL fields under them. The reply agent files what an
   investor texts as facts, and every fact learned or forgotten re-renders that
   investor's row at once (`ghl-broker/investor-row.js`), so search, the table
   and the AI ranking see it without a Sync. Rows keep GHL's fields in
   `doc.custom` and the record in `doc.record`; a re-render leaves `synced_at`
   alone, so "last synced" still means the last GHL read. A contact who isn't
   in the book (no buyer tag) is never added by a text. Edit a buy box inline on
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

### The blast text (2026-09-16)

One text per buyer, built from the deal — never a model call, because a blast
is one message to many people. It now carries what the deal actually knows:

    Hey Dmitriy, got 23706 138th Dr SE in Snohomish under contract — 3bd 2.5ba
    1,890 sqft, built 1978, moderate rehab. Buyer price 532k, ARV around 735k,
    rehab about 85k. Corner lot, tenant is out. Want the details?

Beds, baths, sqft and year come from the underwrite's own subject record —
the same `snapshot.comps.result.info` the dataroom and the agent offer page
read. They used to be looked for at `offer.subject`, where nothing writes
them, which is why every blast went out as a street, a rehab word and a price.
ARV and the rehab estimate come off the offer (the scope's line items when the
offer names no repair figure, so the text and the dataroom quote one number),
and the last line is the deal's **dataroom headline** — the operator's own
sentence, already written for buyers — trimmed out if it runs over 90
characters. Dollar signs and URLs are stripped whatever is typed: carrier
rules. Three phrasings still rotate per recipient.

**What a buyer may see is exactly the three figures the dataroom shows them:
the buyer price, the ARV and the rehab estimate.** The contract price and the
assignment fee are not in `dealFacts` and must never be — that is asserted in
`shared/blast-text.test.mjs`.

### Soft commit — "I think I have a buyer for this one" (2026-09-16)

A fourth buyer standing on a deal, between Evaluating and Committed. Set it on
the buyer in Deals → open the deal, and **outreach on that deal stops**:

- no new blast (the button, the blast on promote, and the second wave),
- no nudge to any other buyer (`blast_nudge`, `dataroom_nudge`),
- no automatic dataroom invite to anyone but the buyer it is held for.

What it deliberately does **not** do: it is not `dealSpokenFor`. The deal is
still live and still priced, other buyers still see it and its numbers, and
the Conversation AI keeps working everyone on it — including the soft-commit
buyer, who is a maybe and exactly the person to keep talking to. Only
`committed` stands the bot down.

Nothing is stored. The pause is read off the buyers every time
(`dealOutreachPaused` in `shared/offer-status.js`), so putting them back to
Evaluating — or their passing — resumes outreach with no second switch to
remember. The deal card says "soft commit — outreach paused" and the deal
itself carries a banner explaining what is held and how to release it.

**The bot cannot set it.** Deciding a buyer is probably real is a judgement
about a person, not something a warm text should act on, so the conversation's
`setInvestorStatus` refuses `soft_commit`; it may still mark evaluating,
committed or passed.

### Market tags and buyer import (2026-09-13)

Buyers are tagged by where they have actually financed a property and how,
from borrower lists (the "enhanced borrower list builder" CSV export):

- `dispo-city-<city>` for every city they bought in, `dispo-region-<region>`
  (seattle, north-king, eastside, south-king, snohomish, pierce, kitsap-mason,
  thurston, other-wa — map in `shared/dispo-regions.js`), `dispo-oos-<st>` for
  out-of-state properties, and `dispo-type-<flip|new-construction|rental>`.
  Type: 10+ year maturity = rental; construction lender or ≥ $2.5M = new
  construction; everything else = flip.
- `city-`/`region-` sit inside the tag on purpose: a bare `dispo-<city>` is read
  as a *blast* tag by the buyer-feedback package (`blastTagsFor`).
- Each financed property is a `property_financed` event on the contact record;
  the Investors table reads Market / Does / Last flip / Largest loan from those
  and the tags, with region → city and type filters and sortable columns.

**Retag an existing list** (tags only, never creates):
`node --env-file=.env scripts/retag-dispo-markets.mjs <csv>... [--tag disposition-seatac,dispositions-vashon] [--live] [--limit N] [--record https://offers.shepflips.com]`
— dry run by default, report CSV in `ghl-broker/tmp/`. `--record` posts the
purchases to `POST /api/dispo/purchases` (the script has no database).

**Import a new list**: Dispositions → **Import buyers**. Upload the CSV,
preview (no GHL calls), tick who to bring in, Dry run, then Import. Matches get
tags added and blanks filled; new people are created with `investor`, the
market/type tags and a `dispo-import-<batch>` tag. Live writes need
`DISPO_IMPORTS_ENABLED=true` on the broker. Run **Sync** afterwards (the page
does it when a live import finishes).

### Dispositions autopilot

Settings → Dispositions → "Dispositions autopilot".

**Blasts from the app.** With "How a blast goes out" = *from the app* (the
default), Tag & blast on a deal ("Find buyers" → tick → Blast, with "Send
from the app" on) no longer applies the trigger tag. Each buyer gets one
outbound draft (`blast_open`, investor party) — the deal in one text:
street, size, the work, the buyer price in k, no dollar signs, no links,
three phrasings rotated. The drafts are **scheduled**, `spreadSec` apart
from the next open minute inside the auto-send hours, and the 30-second
scheduler sends them; Hold works on each. They schedule only when
`CARD_SENDS_ENABLED`, `DISPO_BLASTS_ENABLED`, and "sent them a deal"
(`blast_open`) is ticked on the investor auto-send list — otherwise they sit
in the outbox as drafts, with the reason on the row. Every send writes
`blast_sent` (with the offer id) and the buyer's `lastBlastAt`, so the
feedback package and the second wave need no scan. The deal's own blast tag
is still applied for GHL filtering; `deal.blasts` records each wave.
`POST /api/dispo/blast` with `sendWith: "app"` and `offerId`.

**Blast on promote.** When an offer becomes a deal, the strong buy-box fits
(documented buy box, not on a live deal, not already pitched this deal) are
blasted, up to the first-wave cap. With nobody committed after the wave
delay, the daily dispo sweep (`DISPO_SWEEP_UTC_HOUR`, default 17,
`job_cursors` row `dispo`) blasts the *possible* fits. Off by default.

**Dataroom link on its own.** `suggest_dataroom_invite` stays ask-only. A
separate `send_dataroom_invite` action — which no rule can carry — is
injected by the broker's guard when an investor already evaluating a live
deal (or being linked to it by the same reply) asks for details on it and
their stated buy box fits ≥70%, and the deal has a room. Anything short of
that becomes the usual suggestion with the reason on it. Off by default.

**Assignment on commit.** Marking a buyer committed drafts the assignment
PDF from the deal, the buyer and the company settings (`offer.assignment`),
for review. Off by default.

### Pulse check between deals (2026-09-18)

Settings → Dispositions → "Pulse check between deals". The buyer pool only
ever heard from us when we were selling (1,326 of 1,645 buyers blasted, 484
ever replied, 85 with a buy box). A few buyers each workday get one personal
text with **no deal in it**: are you buying right now, and what's your buy
box, so what we send is relevant.

**Who** (`shared/buyer-pulse.js` `pickPulseBuyers`). Active buyers with a
phone. Left out: a do-not-text tag, on a live deal, any message either way in
the last `quietDays` (7), a draft already waiting in the outbox, or pulsed
within `everyDays` (90). Two lines: buyers who never wrote back go first, best
buyer score first; buyers we have talked with (a reply, or a pass / evaluating
/ commit on a deal) are deprioritised but keep `conversedShare` (20%) of every
day's seats, never less than one, longest-silent first. `dailyCap` 10, max 50,
and the cap is the day's — a retry or a second Run now only fills empty seats.

**What it says.** A `buyer_pulse` outbound message (investor party) through
`startProactive`, so the bot reads the thread, tags and record itself and
holds for a hands-off tag, an earlier opt-out, or a person in the thread. The
clues it is handed (`pulseSubject`): deals sent, whether they've talked with
us, the **city** of their last financed purchase in the past two years (never
the street, amount or lender), where and what they buy, and the buy box on
file — which it confirms rather than asks for again. No price, number, address
or link; the money guard holds any draft that names one. Their answer is an
ordinary `buybox_update` / `looking_for_deals` reply.

**Switches.** Two, both off, under `dispoAutopilot.pulse`: `enabled` drafts
them into the outbox at 11am Pacific on workdays; `autoSend` lets a clean
draft send itself, spread across the day like every machine-started text —
and only with `CARD_SENDS_ENABLED` and `DISPO_BLASTS_ENABLED`. It is not on
the playbook grid and the autonomy dial never touches it (like
`counter_nudge`). Each buyer is claimed with a `pulse_sent` event before
anything is drafted (`pulse_sent:<contact>:<Pacific day>`), which is also the
clock the next one counts from.

**Run / inspect.** `job_cursors` row `buyerPulse` (cursor written before the
run; a run stale after 45 min is retried, 3 tries, until 4pm).
`GET /api/dispo/pulse` → switches, gates, eligibility counts, last run.
`POST /api/dispo/pulse/run {dryRun, limit}` — a dry run (the default, and the
Preview button) lists who it would text and their clues and touches nobody.

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
- **The drivers and the investor band ship off** (2026-09-17):
  `conversationAi.driver.promises / daytime / timers`, the `hot_push` ladder and
  `parties.investor.priceBand`. The dial turns the drivers and the ladder on at
  Normal and the investor band at Full only. Adding them makes a location that
  was at Normal or Full read **Custom** until the mode is pressed again, which
  is the rollout: nothing new runs until then. None of them reads or sets an
  environment switch, and everything they start is a draft in the ordinary
  lane, under the same gates, allow-lists, caps and `CARD_SENDS_ENABLED`.
- **Auto-underwrites are dry-run by default** — same double gate via
  `AUTO_UNDERWRITE_ENABLED`. A dry run still does all the work (and spends the
  Apify/Anthropic money); it just saves a draft instead of publishing an offer.
  Three further rails, because this is the one feature that spends money with
  nobody watching: the endpoint **requires** the location to be in
  `GHL_LOCATION_KEYS`, a per-location daily cap (Settings, default 25) counted
  from the database rather than memory so a crash loop can't reset it, and a
  24-hour dedupe on contact + address. An auto-underwrite never sends.
  Addresses past the cap wait in `job_cursors` row `uwQueue` and the tick
  starts them when there's room — **one house per agent per tick**: two from
  the same agent in one pass collide with each other's in-flight run and the
  second came back `deduped`, was counted as started and dropped (Colin
  Foote's 15605 NE 1st, 2026-09-15). A deduped start now stays in line.
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
