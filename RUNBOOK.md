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

**Closed deals** come from the same endpoint with `&status=closed`, for a
"deals we've done" section. Same two gates, same cache and CORS. A deal is on
it when its room is listed and its deal stage is `closed` (fell-through deals
never are), newest close first. Each card carries only `id, address, beds,
baths, sqft, yearBuilt, kind, photo, closedAt, status` — **no price, ARV,
rehab, spread or headline, and no link**, because on a sold house those publish
what we made. The photo is served from `/d/sold/<roomId>/photo/<id>/thumb`
(the teaser photo path dies with the deal) and only while the room's public
photos are on. Unlisting the room takes a closed deal off the site. Only deals
that had a buyer package built can appear; any other `status` is a 400.

```bash
curl -s "$DEALS/d/deals.json?location_id=$LOC&status=closed" | jq '.count, .deals[0]'
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

### Draft only: the app makes the draft, you price it (2026-10-16)

**Why.** Read against all 363 runs and their 269 threads:
- Matt reworked the comps or the number on 43% of the machine's offers.
- Of the numbers that went out untouched, about half were visibly wrong (mixed up, cut after the agent saw them, wrong asset, high ARV).
- Every agent "yes" to a machine number was to one we then walked back.
- No contract came from a machine price Matt wouldn't have reached himself.
- A run costs about $0.43: the Claude photo scan is $0.15, Apify comps about $0.28.

**What it does** (`settings.autoUnderwriteMode`: `"full"` default | `"draft"`; Settings → "When an agent names a house"):
- A run the conversation starts stops after the listing lookup and the not-our-kind and rural holds.
- It saves a held draft: the agent, the address, the listing's facts and the list price. The reason is `DRAFT_ONLY_HOLD` ("ready for your comps…", `isDraftOnly` in shared/offer-status.js).
- `autoUnderwrite` carries `draftOnly` and a `subjectLine`.
- No comps are bought, no photo scan runs, no offer is made, and nothing floats.
- A run a person starts is still the full machine: Re-run, Retry and Underwrite anyway go through `/automations/underwrite/retry` with `full: true`, and the editor's Auto-underwrite is a fill run.

**Today.** The draft is a **Price it** row (`price_it`, severity now, under Needs you): the listing line, what they said, then **Price it** (opens the editor) and **Pass** (we_passed).
- Saving the priced draft publishes it, which approves the number (`approved.by = "publish"`).
- The float then leads with that number as a realm check, firm even on a high-stakes house.

**The bot meanwhile:**
- The offer book says "MATT IS PRICING THIS ONE HIMSELF" — no figure, no range, no time.
- A showing offer on an unpriced house is held for you (`showingOffered`) instead of "let me run the numbers first". The draft is still made.
- The nightly held sweep never asks the agent for numbers on a draft-only draft. It's "yours", and retires only when the house is over (they passed, or 14 days of silence).

**Also in this change:**
- **Work already done isn't a rehab budget.** "It had 56k in work done before it was listed" read as a 56k budget and called a refresh a flip (217 N French Ave). See `isPastWork` (shared/flip-read.js), used by `agentTakeFromText` and `qualifyRehab`.
- **No run on a place with no house number** ("Horizon Hill", "Finn Hill", "62nd St NW"). The `start_underwrite` action waits for the address (`hasHouseNumber`, conversation-actions.js).
- **No run on the house the thread was on when their text names another street.** `otherStreetIn` (shared/mentioned-houses.js) holds it as an address to confirm, on the street they named.

**Check:**
- `/automations/ai-spend` shows `photo_scan` near 0 a day.
- History shows no realm_check or take_check on draft-only houses.
- Today shows Price it rows.
- To roll back, set the mode to "full".

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

### Skeleton drafts and the pass note (2026-10-19)

Matt: "When someone mentions a property can we make a draft for that (just
agent/address is fine, NO AUTOUNDERWRITE) … we can then quickly eyeball it and
mark it on the offer — the app/bot will then respond to them (if we don't
ourselves) with thanks for sending but gonna pass on X property because of Y
reason."

**Skeleton** (Settings → Auto-underwrite → "When an agent names a house" →
"Make a skeleton", `autoUnderwriteMode: "skeleton"`):
- A run the machine starts (the conversation, the promise driver, Tier 1, the
  timers, the held retries) stops right after the address is placed and the
  duplicate checks: a draft with the agent and the address, held as
  `SKELETON_HOLD` (matches `DRAFT_ONLY_RX`, so it is the same "Price it" row),
  stamped `autoUnderwrite.skeleton`. No Zillow facts, no comps, no photo scan,
  no kind or rural hold. It doesn't spend the day's cap on runs and isn't
  counted against it. A run a person starts is the full machine.
- The conversation starts one for every house the agent names with a full
  address in their own words and that isn't in the book (`skeletonHouses` in
  `runReply`): not only the house the rule would underwrite, and also on a
  "call me about these" text that otherwise only notifies you. Not a house
  the reply already answered: passed on, called turnkey, or the first-text
  house it is still asking its one question about. Houses are read only on a
  lead-type text (`HOUSE_LEAD_INTENTS`), as before.

**The status menu on drafts.** Offers and the work pane show the status menu
on a draft row too ("accepted" is left off a draft).

**The pass note** (Conversation AI → agent playbook → "Tell them when you pass
on a house they sent", `parties.agent.passNote.enabled`, off by default):
- A house nothing went out on (a draft, or a priced row never sent or floated)
  marked "We passed: <reason>" gets `offer.passNote = { status: "due",
  markedAt }`, and the status route starts the note (`ghl-broker/pass-note.js`
  startPassNote). The menu says "The bot tells them in 10 minutes unless you
  text them first", or why not.
- One note for every one of their houses waiting on one (`passNoteHouses`,
  shared/pass-note.js). The bot writes it (outbound kind `pass_note`): thanks,
  each house by its street with its reason's `words`, an ask for rougher ones,
  no number. It is scheduled 10 minutes after the LAST mark, inside machine
  hours (marked after 5pm, it goes at 8am). Marking another of their houses
  in those minutes redrafts it with both; correcting the reason redrafts it.
- Its switch is its place on the auto-send list (`decideAutoSend`). It is a
  machine-started kind: Stop on the contact holds it, a reply of theirs
  waiting on you holds it (the tick retries), and your own text dismisses it
  (the hand reply dismisses every open draft) — the tick then marks the
  houses `yours`. The "one house at a time" spacing and the "we walked away"
  check don't apply to it.
- At send, every house must still be the pass you marked (same status, same
  `statusAt`, `passNoteStale`); a house you priced or re-marked since stops
  it. Sent, the houses are `passNote.status: "sent"`.
- The 15-minute tick (`pass-notes`, sweepPassNotes): `due` ones are started,
  a superseded or lost draft is written again, a dismissed one is `yours`, a
  mark a day old with nothing sent is `off`.
- Reports → Follow-up has a "Pass note on a house you marked" row.

**A reply about a house we passed on** (1921 Lopez Way, 2026-10-20). When the
contact's `subject_property` is a house we walked away from (`walkedAwayFrom`,
and not one reopened on their numbers), `buildAgentContext` drops that house's
STILL MISSING checklist, our underwrite lead and the "next step we had
planned" field. In their place goes one line: WE PASSED ON <house> (why), ask
nothing more about it, and if the thread hasn't told them yet, tell them in
this reply. Before this, the checklist had the bot asking what a passed house
was worth fixed up. This works with the pass note switched off.

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
0–100 closeness, not a vote count. Distance leads (full marks inside 0.15 mi — a quarter
mile before 2026-10-06 — nothing at the ring edge), then size (±10% or ±300 sqft is a full match,
nothing at ±30%), beds (exact, or 40% for one off), baths, year built (full
inside five years, nothing at 15, and weighted above beds since 2026-09-24),
sale recency, and lot when both are known.
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
touching the price or the sale date (`mergeFacts`). The 1 mi ring only buys
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
  1 mi ring (the widest since 2026-10-02; it was 1.5 mi) and, failing that, takes the gut check (2–5 priced comps, the top
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

**Same side of the main roads, and location before age (2026-10-06).** Matt
on 2325 48th Ave SW, Tumwater: "it's picking stuff that is ON THE OTHER SIDE
of a main road, we need to skew towards stuff that is in the same
neighborhood, vicinity, same side of a main road". All four comps carrying
that ARV were new builds across Trosper Rd SW ($860K–1.23M, ARV $922K). Six
sales within 0.4 mi on the house's own side ($485–694K) carried nothing,
because they were built 2005–2014, outside ±15 years of a 1989 house. That
left the half-mile ring too thin, and the run went a mile out.

- **The map.** `fetchBarriers` (`ghl-broker/site-context.js`) makes one free
  Overpass query per run for the square holding the whole ring: OSM
  motorway/trunk/primary/secondary/tertiary, `railway=rail` and
  `waterway=river`. Ramps, creeks and residential streets are left out.
  Trosper is tagged tertiary right there, so a secondary-and-up line would have
  missed the case that asked for it.
- **The check.** `shared/same-side.js` draws a straight line from the house to
  each comp and records the barriers it crosses on `comp.side.across`. A
  crossing within 30 m of either end is the house's own frontage, so it
  doesn't count.
- **Every run, on by default, fails open.** The map is cached a day, runs
  under the comps pull, and never throws. When it doesn't load, comps carry no
  `side`, rank as before, and the note says "side of the main roads not
  checked".
- **Ranking.** `similarity` gives "Same side" weight 25. Distance went 25 → 30,
  with full marks only inside 0.15 mi (was a quarter mile).
- **The ARV.** `gradeByPriceProxy` judges the house's own side first.
  Across-the-road comps only top it up to the 6 the proxy needs, and the ARV
  set ranks same side first. A basis that still uses one says "— 1 across
  Trosper Rd SW".
- **Location before age.** Inside each ring, when the ±15-year band leaves too
  few comps to carry an ARV, same-side houses outside the band come in. They
  are still scored down for age. Only if that fails does the run widen to the
  next ring. The note says "kept the search close and let in same-side houses
  outside that band".
- **The pane.** It gets the same map from `GET /comps` (20 s budget, not past
  1.5 mi). It pre-ticks same side first, tags a row "across Trosper Rd SW",
  and never pre-ticks the house's own earlier sale ("this house").

Tumwater replayed offline: the old logic gave $922K off the across-road lots.
The new logic stops at half a mile with six same-side sales and gives $589K.
That is low against the house's own $690K sale (Nov 2024) and the same-size
Blackstone sale at $694K. Four of the six are ~900 sqft smaller, and the
half-$/sqft size adjustment holds them down. That is the next dial if
Tumwater-shaped houses come in short.

**Wiring it.** There are two front doors. Use the first one if you have a
qualifying bot; it is cheaper and more accurate.

### Buyer view checks (2026-10-02)

**Why these exist.** After a run of deals fell through, every buyer thread with a reply was read: 539 threads with calls, 296 of them substantive. Most of what buyers passed on could have been checked before the offer went out.

| What buyers said | Buyers | What it means |
|---|---|---|
| Rehab too low — never once "too high" | ~26 | Scope was missing, not marked down. Contingency is already 10%. |
| ARV too high | ~16 | Buyers were 10–16% under us. The causes: the size on record, the garage, a short basement, comps that were stale or taken from a ZIP median, and cheaper houses already listed. |
| The street | ~12 | "busy rd", "double yellow is busy street" |

One case set the balance for the whole design: on the Mamer listing the agent agreed with our ARV and rehab, and our $326k still lost to a $425k cash offer. So every check:

- fires only on evidence about that house;
- is measured against the comps;
- is capped;
- prints its reasoning;
- can be removed by hand.

All the logic lives in `shared/underwrite-checks.js` (`buyerView`), which calls `site-check.js`, `arv-checks.js`, `rehab-checks.js` and `house-facts.js`.

**The switch.** Settings → *Buyer view checks*, stored as `settings.underwriteChecks`.

- The master `enabled` switch defaults to **false** and stays off until Matt has seen the backtest.
- Each check (`site`, `layout`, `actives`, `rehab`, `flags`) has its own switch. These are on by default, so turning on the master switch turns on every check Matt chose.
- `normalizeUnderwriteChecks` clamps every number to a sane range. A cut can never become a premium.

**What each check does.** Nothing here sends anything or holds a run. Each check's output becomes a line on the note, the editor and the package.

- **Street (`site`).** One Overpass query covers the house and every comp (`ghl-broker/site-context.js`).
  - **A busy road** (−5%): the house fronts a secondary road or bigger, or sits within 35 m of one, within 175 m of a primary/trunk road, or within 250 m of a motorway.
  - **Commercial land within 50 m** (−5%). **A rail line within 150 m** (−6%).
  - **Each cut is scaled against the comps.** It is multiplied by the share of ARV comps that don't share the trait, so a busy-road house comped against busy-road sales isn't cut twice.
  - **A quieter house gets a credit.** If the house is quieter than its comps, it gets up to 3% back.
  - **When the street can't be checked,** the warning reads `street not checked (…)` and the run prices without the street check.
- **Layout (`layout`).**
  - **Size.** A size more than 10% over the record is replaced by the record. A basement the listing calls low-ceilinged isn't counted.
  - **No garage** when the comps have one: −3% times the share of comps that have one.
  - **A lot under 60% of the comps' median:** −2% times the share.
  - **A missing bath.** If the house has fewer baths than the ARV comps and 3 or more beds, a bath ($25k) goes into the scope, since the ARV assumes it. If you remove that line, the ARV is re-run on same-bath comps.
- **Today's listings (`actives`).** One Zillow for-sale/pending pull per run, about $0.15, cached for a day (`pullZillowActives`).
  - The ARV is held to the size-adjusted median of the renovated-looking half of the most similar listings.
  - It needs at least 3 listings, and it never cuts more than 20%.
  - A sold row is never treated as a listing, and the house's own listing is never its own ceiling.
- **Rehab (`rehab`).** These become visible "Buyer allowance — …" lines in the scope.
  - **Systems:** built before 1980, electrical $4k plus plumbing $5k scaled to size; before 1950 it's a rewire and repipe at double. Waived when the photos grade the system good, the remarks say it was updated, or the scope already prices it.
  - **Photos:** any area graded poor that has no line in the scope gets the matching catalog line.
  - **The listing's own words:** water damage, mold, roof, foundation, sewer. Fire or a house carved into rooms is flagged rather than priced.
  - **Cleanout:** from the photo scan's new `contents` field, or the remarks.
  - **Distressed floor:** a distressed listing's rehab is held to at least 8% of ARV and the size band's light floor.
  - **Ceiling:** the allowance lines never push the scope past `heavyCeiling`.
- **Flags (`flags`).** These are never priced:
  - the listing is on the market, or how long it's been listed and any price cuts;
  - septic, an easement, a right-of-way, unpermitted work, an HOA, a land lease;
  - a thin buyer pool: ferry-only ZIPs, an ARV over $1.5M, under 1,000 sqft;
  - comps more than 6 months old in a falling market.

**Removals stick.** Each removal is stored in `snapshot.checks.declined`, as `{ arv:[keys], rehab:[keys], cap }`. A retry reads it from the draft it replaces, and the editor's Auto-underwrite button sends it along.

**Where the checks show up.**

- **The run note** gets a "Buyer-view checks:" block. It includes the numbers before the checks whenever they moved.
- **The Comps pane** shows a *Buyer view* box with auto chips (×), the listings line, and the flags.
- **The Rehab pane** shows *What a buyer will price*.
- **The Today offer panel and the offer detail** show *Buyer view*, read from `offer.checks`, which also appears on lean rows.
- **Dispositions:**
  - The package and the blast say "septic" and "incl. systems".
  - The package has a "Worth knowing" line.
  - The bot's deal line carries "about the house".
- **Blasts.** A buyer whose saved dealbreakers ("busy streets", "Vashon Island (too far)", "off-market only") the house hits is never sent the deal (`buyerDealbreakers`, `pickDealBuyers`). This only ever narrows who gets a blast.
- **Lessons** shows *Why buyers passed — last 30 days*, and adds recommendations: `buyer_view_on`, `site_cut_deeper`, `site_cut_lighter` and `rehab_floor_higher`. Each one can be applied.

**Pass reasons.** A buyer's no is now filed under `arv`, `layout`, `location`, `legal` or `exposure` when that's what their words say. `area` still means the buyer's own territory. Older reasons are recoded when they're read and are never rewritten.

**Verify the Zillow field names before trusting the layout checks.**

- `houseFactsFromDetail` (`rehab-scan.js`) reads `resoFacts` fields: above- and below-grade area, garage, sewer, HOA, and `priceHistory`.
- None of these were checked against a live detail row when this was built.
- After deploying, run one quiet backtest on a single house and look at `job.snapshot.subjectInfo.house`. If a fact comes back null when the listing obviously has it, read the field names off the last detail-actor dataset (the Apify method above) and fix the parser.

**The backtest — run it before switching the checks on.**

- The route is `POST /api/offers/automations/underwrite/backtest { items: [{ address }] }`.
  - Each item runs a quiet fill run with the checks forced on.
  - Nothing is written to GHL or the store.
  - Poll each job with `GET /automations/underwrite?jobId=`.
- **Step 1:** `node scripts/underwrite-backtest.mjs` prints the houses and the cost (about $0.6–1.6 each) and runs nothing.
- **Step 2:** `--go` actually runs it. Add `--recent 20` for the newest auto-underwrites, and `--buyers buyers.json` (local only) for what buyers said each house was worth.
- **The pass bars:**
  - Deals that sold must stay within 5% of what the buyer paid.
  - Deals that died must come down toward the buyers' numbers.
  - The median change in the buyer line is the acceptance risk.
- **Caveats:** today's listings and the street aren't what they were when a past deal was priced, and a subject that has since sold may show up in its own comps. Read the results as a direction, not a verdict.

**Re-reading the threads.** `node scripts/buyer-objections-report.mjs` repeats the tally. It is read-only, prints ids only, and writes quotes only to a local file with `--quotes`.

### Calibration from your own revisions (2026-10-15)

From the funnel review: our number fell after the agent saw it on 35 of 305
houses, and hand and machine first numbers were cut about equally (12.6% and
11%), so the inputs are the problem: rehab read low off the photos, ARV read
high. When Matt revises an auto-underwrite by hand, the machine now learns how
far off it was.

- **Recorded.** Every revision (`offer.revisions[]`) now carries `by` (`you`,
  `requote`, `counter_band`), and `arv` and `repairs` as `[from, to]`, plus the
  house's `sqft` and `yearBuilt` off the snapshot (`routes/offers.js`
  `revisionInputs`). Only revisions made from 2026-10-15 have them.
- **Read.** `calibrationReport` (`shared/calibration.js`) looks at a person's
  revisions of auto-underwrites (one correction per offer: the machine's
  figures before the first, his after the last) and adds two recommendations
  to **Lessons** (`GET /api/dashboard/lessons`), the same shape as the rest:
  - `rehab_psf_floor`, by era (built before 1950, 1950–79, 1980 on): at least
    5 corrections in the era, at least 60% of them raising the rehab; the floor
    is the $/sqft a quarter of his revisions run under;
  - `arv_haircut`: at least 5 corrections, at least 60% lowering the ARV; the
    cut is his middle cut, at most 15%.
  With fewer, Lessons says "Not enough of your revisions yet to calibrate:
  N of 5" (`calibration.note`). Apply works as for every other row; it saves
  the whole `underwriteCalibration` block.
- **Applied.** `settings.underwriteCalibration = { rehabFloorPsf: [{beforeYear,
  psf}], arvHaircutPct }`, absent by default (`effectiveSettings` leaves it
  absent; absent changes nothing). When set, the underwriter takes the haircut
  off the ARV (the basis says "calibrated: less N%") and, when the scan priced
  a rehab and the house has a size and a year built, adds an allowance line up
  to the era's $/sqft — never past the heavy band's top, so it can't hold a
  run. `job.calibration` says what it did.
- **Check it.** Lessons shows the rows or the note. After Apply, a new
  underwrite's ARV basis and warnings name the calibration.

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
canned line ("Thanks for the images, taking a look!") — pass the attachments
to the webhook as `attachments` (a list, a URL, or a count) so an empty body
isn't refused.

**Addresses on flyers (2026-10-22, `media.readAddresses`, off by default).**
With the switch on ("Read the address off flyers and screenshots they send",
Photos and attachments card), the pictures and PDFs they sent since our last
text, by text or email (attachments, and pictures placed in an email body),
are read by one vision call for the printed street address and nothing else
(`ghl-broker/photo-addresses.js`, metered as `photo_addresses`, a few cents).
The burst is read back from GHL (needs conversations.readonly), so a second
photo text that replaces the first one's waiting reply still sees both. Each
address leads the message as `[photo → address]`, the way a listing link
becomes `[listing link → address]`: the reply is drafted from those lines,
never from the picture, and in skeleton mode every one becomes an agent +
address draft. More than four addresses in one burst (a comps sheet) reads as
none. Pictures are cached six hours by URL, so a burst is paid for once.

**Emails in the thread (2026-10-22).** GHL lists an email thread as one stub
whose body and direction can't be trusted: an agent's reply to our outreach
email listed as OUR email's words, marked inbound, at the time of their reply,
and with no attachments. Until this date the bot's transcript and the thread
on a contact either skipped it or read our words as theirs. Now
`listConversationMessages` (`ghl.js` `withEmails`) reads every email in a stub
(`/conversations/messages/email/:id`, cached per process) and lists each one
with its real direction, time and attachments, and with the quoted history cut
(`cutQuotedHtml`). Readers that only count (the dashboard's daily tally, call
intake) pass `emails: false` and keep the stubs, to spare GHL a read per
thread.

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
Since 2026-10-02 the counter band never releases — see "Never above what we
sent" below — so on the agent side it only shows the ceiling on the draft.
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

### Never above what we sent (2026-10-02)

17044 Woodcrest Dr NE, Bothell. Matt had taken the offer from the
underwriting's 405k down by hand to 390k, then sent a letter at 386k that
the agent wrote up on NWMLS forms and Matt signed. The seller came back at
410k; Matt answered "let me know if he comes down at all". The next morning
the agent asked again, and the counter band — 410k was inside 10% of its
402.5k ceiling (75% × 650k − 75k − the 10k fee) — re-issued the letter at
402.5k, sent it, and texted "Best we can do… is 402,500". The seller said yes
to a number nobody decided on. Matt: "we need to stick with our prev numbers".

- **The machine never goes above the number we sent** —
  `never_above_sent` in `evaluateCounterBand` (`shared/auto-accept.js`). Every
  counter is above our number, so the band no longer re-issues, sends or says
  yes to one: a counter is a person's call. The ceiling is still worked out
  and rides along in the draft's reason ("…is your call, 7,500 over the
  402,500 ceiling"), and the Counters card's switch now reads "Show the
  ceiling on every counter". It is in code, so the autonomy dial can't turn
  the old behaviour back on. The acceptance half (a yes at OUR number) is
  unchanged.
- **A person can take back an agreed price** — `DELETE /api/offers/:id/agreed`
  writes `offer.agreedCleared {at, by, amount, via}` and nothing else.
  `priceAgreed` ignores every marker from before it (the agreed record, the
  band's acceptance, a realm yes); the markers stay as history, and a new yes
  after it locks the price again. A deal is refused: its price is the
  contract's. The Offer pane's pencil does this before a re-quote on an
  agreed offer and says so first. Sends nothing.

### A second look at a strong past offer (2026-10-16, off by default)

The 2026-10-16 audit found 36 offers that died close, with nothing planned:
they passed, went quiet or countered and stopped; the seller's number was
within 15% of ours; and the agent had really talked to us. Matt: "checking
really good past offers to see if they would reconsider if the margin's good
enough and the conversation warranted a follow-up".

- **Who** (`secondLookDue`, `shared/second-look.js`, pure). The agent's
  current row on the house, no deal, and all of these:
  - status passed, no_response or countered, or our own pass over their
    counter (`numbersPass`: a counter on record or the counter hold, never a
    pass for the kind of house, the area, or one a sweep closed out);
  - our number went out: paper, `floatSentAt` (a number texted in a plain
    reply) or a realm check; the status is 21–120 days old;
  - their number within `withinPct` of ours: the lowest of their counter,
    the seller's number the agent gave (`sellerAsk`), and the list price (the
    price watch's last look, else the list when we priced it);
  - they wrote us `minTheirTexts` times (auto-replies don't count) or we had
    a real call (`realCall`);
  - quiet: nothing from them, and no text of ours about this house, for
    `afterDays`;
  - not off the market (the price watch) and not "it's pending/sold" in their
    newest texts; unknown is allowed;
  - at most `maxPerHouse` sent per house, `everyDays` between looks (per
    house and per agent: one house at a time), and none after a no to the
    last one;
  - never to an agent who is stopped, opted out, tagged off or annoyed
    (`agentStops`), on a live thread (`machineMayStart`), the day a call to
    them is queued in GHL, or while another house of theirs is live.
- **The text** (`second_look`, `conversation-prompt.js`, carrier-checked):
  one or two lines under 240 characters naming the street — if the seller is
  still open to it, we can still do our same number — and is it worth a
  quick call. Never "did it sell?". The number is worked out from the thread
  in `startProactive` (`secondLookNumber`: the lowest we put to them on the
  house, via `holdNumber`), and it is the only number the money guard allows
  (`onlyFloats`, ours or ours in thousands rounded down). Anything above it,
  even "378K" on 377,552, or over 240 characters, is written once more and
  then dropped, never left on the Desk.
- **Running it.** The morning follow-up sweep (`secondLookCandidates`), after
  every other clock, one house per agent (the closest to ours), with the
  sweep's own gates: Stop/Pause, one text a morning, 72 hours apart and two a
  week (`second_look` is an unprompted kind), the outbox, the claim
  (`follow_up_sent`, `data.kind: second_look`). A clean draft sends itself:
  the sweep releases it (`releaseHeld`) the way the agent check-in's runner
  does, so it is not on the auto-send grid and the dial never touches it.
  When it actually sends, `second_look_sent` goes on the timeline; that is
  what `maxPerHouse` counts. A second look on our own numbers pass is the one
  machine text allowed on a we_passed house, and only if the offer's status
  hasn't changed since it was drafted.
- **Switch:** `conversationAi.parties.agent.followUp.secondLook { enabled:
  false, withinPct: 15, afterDays: 21, everyDays: 45, maxPerHouse: 2,
  minTheirTexts: 2 }`. Party auto-send and `CARD_SENDS_ENABLED` still gate
  every send.
- **Check:** `GET /api/offers/automations/conversation/follow-ups?preview=1`
  lists `secondLooks.rows` — who the next sweep would ask and why ("their
  counter 410K is 7.9% over our 380K; passed 30 days ago"), even with the
  switch off, no names. `POST …/follow-ups/run {dryRun: true}` shows each as
  `would send`. A real one's claim carries the same `data.why`, and the
  timeline reads "we asked once more at our same number".

### How we got our number — the math behind every offer (2026-10-07)

Matt benchmarked a No Fluff wholesaling video (Ed Zamora, 3–5 deals a month
working listing agents). His setup call explains how he underwrites before any
number, and floats a range rather than one figure. Matt: "we usually use the
70–75% ARV − rehab number, but I want them to know what we base it off of
(holding costs, profit margin, etc)". **Pricing did not change.** Automatic
offers are still `mao` (maoPctOfArv × ARV − rehab − fee). What changed is
that the agent sees what the gap between the ARV and our price is made of.

- **One source: `offerMath` (`shared/offer-breakdown.js`).** It reruns the
  back-stack cost model on the offer's own frozen settings, against the same
  ARV and repairs, for every pricing mode. The rows are:
  - after-repair value
  - closing costs, buying and reselling (7% resale plus `buyClosingPct`, 1%,
    on the flipper's purchase basis; the purchase closing is explanation
    only, never pricing)
  - holding (loan interest and points, taxes, insurance, utilities)
  - the work
  - **profit & risk**, the residual that makes the column add up exactly to
    the price we sent. The fee sits inside it and can't be recovered by
    subtraction. A price set above what the costs leave room for shows a
    "premium" row. A residual over 22% of ARV (cheap houses, where the flat
    fee dominates) gets a caption on the page.
  - `pctOfArv` is (price + work) ÷ ARV: the "about 69%" Matt prices off.
- **Texts name every cost and never give profit & risk a figure.** The page,
  the letter and the email show every line. A gate (`namesHidden` in
  `evaluateReplyGates`) holds a text that names it in any form: "$91,217",
  "91k", or the bare "91".
- **Where it shows:**
  - **The bot, asked or pushed** (`parties.agent.showMath`, on in prod since
    2026-09-17). The offer book's `[our math: …]` line now carries every
    cost; the MATH rule walks through it and ends by asking for their numbers.
    An offer that was capped, set by hand or came down by text gets the method
    without the arithmetic.
  - **The float** (`realmCheck.withMath`, off until Matt flips it). One
    clause before the number.
  - **The written offer.** The text that carries the letter adds
    `mathSentence`. The email shows the whole column under "How we got to the
    number". The agent page's breakdown is on by default (older pages keep the
    sections they were saved with).
  - **The letter of intent.** A "How we priced it" box beside the closing
    paragraph, to the cent.
  - Settings → "How we got our number": `buyClosingPct` and `showPricingMath`
    (off removes it from the letter, the text and the email).
- **A range topped by our number** (`realmCheck.range {enabled, pct}`, off).
  - The float says "the 280s to 295": `floatRange` puts our number, rounded
    down, on top, and the bottom `pct` under it on a round step. The letter
    only ever goes at the top.
  - A range that went out is stamped `offer.proactive.range`, live until the
    number moves (`liveRange`).
  - The offer book tells later replies our number is its top. The gate holds
    the bottom said on its own.
  - The readers in `shared/current-offer.js` skip a range's bottom and take
    its top, so a float never holds the letter at 280 or reads 295 as a raise.
  - **Their number inside the range** ("285 works") is `in_range`: the reply
    waits with the letter at ours and a revise to theirs both one click away.
    It is never filed as a counter, never a realm yes at ours, and never
    released by the nightly audit. A plain yes sends at the top; above the
    top is a counter, and `never_above_sent` is untouched.
- **One setup question** (`realmCheck.setupQuestion {enabled, ask}`, off).
  - `SETUP_QUESTIONS`:
    - other offers and the seller's timeline
    - "anything I won't see in the photos" (roof, foundation, water, septic)
    - their read on the work and the value
  - One per float, rotated by offer, never one the dossier already answers.
  - The answers land where they always did: their take → re-quote, condition →
    property details.
- **The transcript readers ignore the math.** Cost words ("38 to buy and
  resell", "26 of holding", "500 it's worth fixed up") are not prices. An
  offer letter's text and email are read only up to their math
  (`MATH_MARKER_RX`).
- **Preview before switching on.** `POST /api/offers/:id/float {preview:
  true, realmCheck: {withMath, range, setupQuestion}}` drafts the float on a
  real offer with those switches, without saving them. It returns the text,
  its length and the gate's flags. Nothing is filed or sent; it costs one
  model call. Turn the switches on with one PUT of the whole conversation
  config (GET it first).

### Price once: a range on a big house, the seller's number first (2026-10-15)

The funnel review (July to October) found our number fell after the agent had
seen it on 35 of 305 houses, 11 of them after a counter or a yes. Hand and
machine first numbers were cut about equally (12.6% and 11%), so the inputs
are the problem (rehab read low, ARV read high). The gap between their number
and ours decided the outcome: within 5%, 13 of 25 agreed; past 25%, none of 95.
Both halves live in `shared/number-stance.js` (pure).

- **A range until we know more** (`parties.agent.realmCheck.highStakes`:
  `enabled` off by default, `overAmount` 500000). A house is high-stakes when
  it is off-market, the agent brought it (`autoUnderwrite.leadSource:
  agent_brought`), or our number is over `overAmount`. Until we have the
  agent's read of the value and the work AND eyes on it (8+ photos scanned, a
  walkthrough video on the offer, or `offer.seen`), the house is in range mode
  (`numberStance` → `mode: "range"`):
  - the float never leads with the number (`leadsWithNumber` is false), uses
    the rough wording with a range topped by ours, and asks for their read,
    then (once their read is in) "any chance of a few more photos or a quick
    walkthrough video?";
  - nothing goes on paper by machine: `paperWorthy`/`sendsItselfOnClear` say
    no, the silence and answer timers skip it, the pushback paper skips it,
    and the conversation's `sendOfferDocs` holds any send nobody pressed
    (`unattended`, `forRecord`, or an auto rule's `send_offer`) with a
    "Paper held" banner. A person pressing Send has decided;
  - the offer book tells the bot "RANGE ONLY until …": no firm number, no
    "our offer", no write-up ask.
  A person-made or published offer is firm. Matt's approval (below) clears it.
- **A listed house: the seller's number first** (`parties.agent.listedFirst`:
  `enabled` off by default, `minPctOfTheirs` 75). Agents only, the machine's
  first word on a house only (a person pressing Float, and a re-quote, skip
  it). `listedFit` in `startProactive`:
  - **ask_number** — a listed house (a list price, or our hook listing, and
    not off-market), nothing of ours on it yet, and no seller number known:
    the float becomes a take check that floats our ARV/rehab read and asks
    "what's the seller hoping to get?" (`subject.askSeller`). Their answer
    (filed as `property_details.sellerAsk`) fires the realm check the way
    their read does.
  - **no_fit** — ours is under `minPctOfTheirs`% of the seller's number (their
    words, a `house_mentioned` with one, or a counter), or of the list price
    once we've asked, and no number of ours has gone on the house (no price in
    the thread, no paper, no floated number): nothing with a number goes. A
    `kind_pass` with `why: "too_far"` says it's too far from where the seller
    is to send a number and asks for other fixers on or off market (no
    number). `offer.noFit {at, theirs, source, ratio, ours}` puts a **no_fit**
    row on Today ("ours is 68% of the seller's 600K") with Price it by hand ·
    Float ours anyway · We passed. It is never we_passed. The row goes when the
    number moves, a number is floated, paper goes, or the offer closes. The
    pushback paper never goes on a no-fit house.
  - 75% of theirs is not the counter walk-away (`WALK_AWAY_GAP`, 25% over the
    most we'd pay, so ours under about 80% of theirs): that rule answers a
    counter after ours went out and is unchanged.
- **Check it.** `POST /api/offers/:id/float {preview: true, realmCheck:
  {highStakes: {enabled: true}}}` on a big house shows the range and the
  question. Offers with `noFit` show on Today; `GET /api/offers/:id` shows
  `noFit` and `paperHeld`.

### The agent's own numbers only ever lower ours (2026-10-16)

An agent brought us a Shoreline house and said it was worth 650–680K fixed up
and needed 80–100K of work. Zillow had no record of the house. The rough pass
guessed its size from the comps and stretched three small sales to 842K. The
bot texted "we're actually seeing comps closer to 842k fixed up", then
"around 531.5k". He said yes. On his own numbers it is about 380K. The county
has no house at that number, so the address was probably wrong too.

- **No record of the house, no number.** The map places an address whether
  or not a house stands there. A subject with a point but no size, beds, baths,
  year built, home type or lot (`knowsTheHouse` in auto-underwrite.js) holds
  with `NO_HOUSE_RECORD`. That reason is an address hold:
  - the triage asks the agent to confirm the address;
  - no rough number or rescue prices past it;
  - the comps' size is never lent to such a house.

  Over 2026-10-05 to 10-16 this would have held 3 of the 19 rough numbers
  (Shoreline, a 1.19M Redmond offer, and a Puyallup house).
- **Their value under ours prices the house** (`theirNumbersBound`, pure). It
  takes the agent's value (the dossier's `agent_estimate`) when it is under
  ours, with or without a list price. A higher value of theirs changes nothing
  here; that is the rescue's and the re-quote's. It runs after the rescue and
  the rough pass, on clean runs too. The offer carries `autoUnderwrite.agentValue
  {theirs, ours}`, and the basis reads "their 665k value (our comps read
  842k)".
- **Their repairs over ours are budgeted.** A repair figure of theirs above
  ours replaces ours. A lower one leaves ours alone (the rescue's own
  quarter-cut is unchanged).
- **The reply never argues the value up.** Once they've said what it's worth,
  `evaluateReplyGates` holds a draft that names a value above theirs (more
  than 5%; `valuesWeName` in shared/current-offer.js reads "842k fixed up",
  "comps closer to 842k", "ARV around 842k"). It also holds our own ARV said
  back within 2% without a value word. Their own figures may be echoed. Their
  value comes from this message's take (the model's, else `agentTakeFromText`,
  which now reads "value fixed up could be" followed by two figures), else their
  timeline (`theirValueFor`). Outbound texts read it from the dossier. Before
  they've said, floating our ARV to get theirs (the take check) is unchanged.
- **Check it.** `GET /api/offers/:id` → `autoUnderwrite.agentValue`, and the
  `warnings` "priced on their … value" / "repairs at their …". A held reply
  shows "… for what it's worth fixed up — they said …".

### The current offer — one live row per house (2026-09-25)

13041 SE 208th St, Kent. Five offer rows on one house: a July offer, two
August revisions, an August draft, an unsent first pass. From 8/7 on, the
thread said "~400K". On 9/22 "She's at $420k" landed as a counter on the July
row (416,500), the only one not marked passed. On 9/25 "draw it up" was read
as realm_yes, and the rule's `send_offer` auto-sent a letter of intent at
416,500. It was off that July row, and the draft's own summary said "400k".
The acceptance band then released "I'll draw it up in the morning" as the
seller taking our number. The deal died on it. About 20 selectors each
picked "the" offer their own way, mostly newest-`createdAt`. A revision keeps
its `createdAt`, so a re-priced row sorted *below* the stale one it replaced.

**The rule** (`shared/current-offer.js`, derived on read, nothing to migrate):
1. A draft is never current.
2. A deal on the house is current. A deal is never superseded.
3. A row a person pinned is current, until a sibling is **sent** after the pin.
4. Otherwise it's the row whose number moved last: sent, revised, re-quoted,
   or created. A status change is not a price move.

Status never disqualifies. A passed current offer is still our number on that
house. Every other row on the house is **superseded**.

**Every machine path acts on current offers only:**
- the conversational deps in `routes/offers.js` (via `currentOffersFor`):
  status, heat, realm, re-quote, counter revise, promote, `sendOfferDocs`
- the counter band and the acceptance band
- the follow-up ladders (offer nudge, hot push, passed check-in)
- the price watch, the nightly audit, the promise resolver
- the board (one card per house; a draft on an older row moves to the current card)
- the GHL mirror's value and the agent's offer-status tag

A selector finds the current row of the named house, then applies its own
status filter to that row. If the row fails the filter, the selector refuses.
It never falls back to a superseded sibling.

**Paper holds.** `paperCheck` / `ourComeDown` look for a lower number we
texted after the current row last moved.
- A reply whose actions would send the offer or call it in the realm is held
  as `stale_number`. Its paper actions move to "ask", the offer is stamped
  `paperHeld`, and the draft carries `paperHold`.
- The nightly audit never releases a `stale_number` hold.
- `sendOfferDocs` runs the same check for every machine caller:
  `onOfferCreated`, the retry tick, the audit's queued send. If it can't read
  the thread, it holds.
- Both bands gained a `current_number` check.

`ourComeDown` doesn't count the offer's own number said short ("227K" for
227,552), or figures named as ARV, rehab, repairs or work.

**The machine never raises our own number (2026-09-29).** 336 SW 15th St,
Chehalis: we quoted 185k. The agent said the floors were new, a re-underwrite
landed at 192,250, and the realm check texted "we can go around 192k" to an
agent who hadn't countered. Separately, the hot push asked her to write it
up at 173k, which was her other listing's number.
- `machineRaise` finds the last price we texted on the house, in a line of
  ours that names its number and street (`lastQuoteOnHouse`). It fires when
  the offer is above that price and no person has stood behind it since. A
  pin, a revision, a re-quote, a send, or a row a person made or published
  counts as standing behind it.
- `startProactive` reads the thread before a realm check or hot push and skips
  on a raise. The skip is marked on the offer (Today's "priced, not floated"),
  and `floatNumber` leaves a contact note. **Float** on the offer
  (`personAsked`) sends it anyway.
- `paperCheck` holds paper on a raise the same way it holds a come-down, and
  offers **Re-quote at** the number the agent has.
- The hot push may name only its own house's number (`onlyFloats`), not every
  number in the agent's book.

**The bot's offer book** lists one line per house: the current row, plus a
count of superseded rows. Superseded amounts are stale, so a draft that says
one is held.

**Where you see it:**
- **Offers tab:** a green *current* pill when the house has more than one row.
  Superseded rows are greyed with "superseded by $X". The funnel chips count
  current rows only.
- **Status menu:** "Make this the current offer" (`PATCH /:id/current`) and
  "Unpin".
- **Editor:** a superseded banner.
- **Held-paper banner** (editor, offer window, Today's pane): **Re-quote at N**
  (`POST /:id/requote`) re-prices the row in place. Nothing is sent; Send is
  your next press.
- **Today's pane:** shows the house's current offer, even when the row
  pointed at an older one.

**Before and after deploy:** run `node scripts/current-offer-report.mjs`
(read-only). It lists every house with more than one offer, the current row,
the row the old send path would have picked, and any paper that would be
held. First run, 2026-09-25: 207 houses; 57 with more than one offer; on 36
of those the old path picked a different row; 2 held.

### Next follow-up — one answer per offer (2026-09-29)

Matt asked for every offer to be in the right stage and to show the follow-up
it has coming. On 9/29 the live book had 230 houses. Every ladder was on and
auto-sending on the Full dial. Offers still stalled, for four reasons:

- **The offer ladder ended at their first reply.** `stopOnAnyInbound` turned
  "they answered, we answered, then silence" into no clock at all.
- **`no_response` had no clock.** It is revivable, but only `passed` got
  check-ins.
- **A sold or pending house kept getting check-ins.** The price watch saw
  it go, but the check-in ladder never asked.
- **Nobody could see what was next.** The preview ignored inbound, caps and
  the hot and passed ladders.

**What changed in the sweep** (`ghl-broker/follow-up-sweep.js`):
- **Re-anchor.** The offer nudge re-anchors on the last time the thread was
  dealt with, instead of stopping. A reply sent counts. So does a closer we
  left unanswered on purpose ("ok thanks", a draft that was dismissed or
  skipped). The anchor day rides in the subject id (`offerId@day`), so the
  new rungs get fresh claims, the same trick the hot push uses.
  - It asks `threadHealth` first, like the hot push. It ignores the
    two-unanswered stop, which the plain offer ladder never had either.
  - If their text is the last word and nobody has dealt with it, there is
    still no nudge. That is a reply owed, not a follow-up.
- **Gone-quiet offers.** `passedCandidates` reads `no_response` as well,
  counted from its no_response history entry. The check-in text says "we
  never heard back" instead of "they passed" (`outbound.quiet`).
- **Off the market.** A `listing_off_market` event after the pass or silence
  ends that house's check-ins.

**The column.** `nextFollowUp` in `shared/next-follow-up.js` is pure. It uses
the same start points as the sweep (`offerNudgeStart`, `offerNudgeAnchor`,
`passedStart`, `threadTimes`, `nextRungAt` in `shared/follow-up.js`), so the
day it shows is the day the sweep acts. First match wins:

1. **Nothing, by design.** A deal, our pass, a superseded row, a draft, or
   an accepted offer.
2. **Stopped.** They opted out, or you stopped it on Today.
3. **Queued.** A draft is already scheduled; its send time shows.
4. **Reply held.** Their text is waiting on you.
5. **The soonest of:**
   - a promise we made
   - a check-in they asked for
   - the hot push
   - the offer nudge
   - the passed or quiet check-in
   - the float timer (after a day overdue, it reads as yours)
6. **None scheduled**, with the reason (the ladder ran out, the machine
   stands down, and so on).

A rung lands on the first daily sweep at or after its day (16:00 UTC). A
weekend rung moves to Monday unless `autoSend.weekends` is `all`. The weekly
per-contact cap can't be seen ahead of time, so the column is the plan, not a
guarantee.

**API.** `GET /api/offers?lean=1&next=1` adds `nextFollowUp {at, kind, label,
who, reason, overdue}` to each row. It is opt-in, like `activity=1`. It costs
two location-wide reads (reply drafts and the clocks' events), done in
`ghl-broker/next-follow-up.js`.

**On the Offers tab:**
- A sortable "Next follow-up" column. The group header shows the agent's
  soonest follow-up, or their gap.
- A "No follow-up" chip: live offers with nothing coming, or one that's late.
  (2026-10-07: under "Closed / other" — see the three tabs below.)
- **The Offers tabs — Draft · Sent · Responded (2026-10-13, Matt's diagram).**
  The three stages of an offer (`shared/offer-stage.js` `offerStage`, derived
  on read; the stored statuses are unchanged) in `messaging-app/src/offer-tabs.js`:
  **Draft** (held drafts and priced offers whose number hasn't gone out;
  oldest first, every agent unfolded) · **Sent** (the written offer went, or
  our number went by text — `floatSentAt`, stamped on the offer when a
  `realm_check` draft actually sends; older floats get it from
  `POST /api/offers/backfill/float-sent {apply:true}`, or `floatedAt` attached
  by `?activity=1`) · **Responded**, with one chip per answer: 🔥 Hot ·
  Countered · Accepted (a live or closed deal) · Passed (they passed, we
  passed, gone, no reply after the follow-ups, or a deal that fell through —
  Matt: no reply counts as passed). A row a newer one on the house replaced
  is in no stage. All offers, Off-market, No follow-up and AI review sit
  under "Other". The page opens on Hot, or Draft when nothing is hot. The
  board's lanes sit under the same three headers. The agent's GHL card
  follows the stage — see "The pipeline".
- Changing a status in the table shows "updates on reload" rather than a
  schedule worked out for the old status.

**Hot is not a yes (same day).** Four offers went hot when the agent said
they would take our number to the seller (`signal: "presenting"`). The push
to paper was about to ask each agent to write it up before the seller had
answered. `pushesToPaper` (shared/offer-status.js) now decides the push. It
needs a yes: an agreed price (`priceAgreed`), the `writing_up` signal, or
your own flag. "Presenting" and "warm" still put an offer in the Hot lane,
but the offer nudge keeps it until a yes. The sweep, the hot_push `ready`
check and the column all read this.

**Fixing a status after the fact.** `PATCH /api/offers/:id/status` takes an
optional `at` (ISO, between the offer's creation and now) and `amount` (only
with countered; it becomes `offer.counter`). A July pass marked in September
keeps its July date, so its check-ins count from then.

### One voice, a recorded yes, and room for replies (2026-09-29)

**A machine text never talks over a reply that is waiting.** Until now every
text the machine started (a nudge, a check-in, a float, a price drop, a
promise) superseded whatever was in the contact's outbox, so a question held
for you left Today and a canned text went out in its place. Now
(`blockingDraft` in shared/follow-up.js, `draftWaitingOnYou` in
ghl-broker/outbox-guard.js):

- A reply to their text, or anything a person wrote (your check-in, your
  answer on Today, the walkthrough ask, a queued deal text), holds every
  machine-started text for that contact. The row's reason reads "their text
  is waiting on you" or "your check-in to them is waiting in the outbox".
- An older machine text nobody sent is still replaced by the next one.
- A text that carries on from a reply may replace that reply and no other:
  the realm check after their read, the re-quote on their numbers, and the
  "never got a reply" check-in, which is the net under the draft it was made
  for (`continues`).
- A person pressing Float, or your answer on Today, replaces anything, as
  before.
- Every sweep asks before it claims its rung, so a text that waits spends
  nothing and goes on a later run: the follow-up sweep, the promise, check-in
  and address sweeps, the audit's nudges and re-quote, the held-underwrite
  ask, the promise driver's float and the float timer. A float that waits is
  not filed as skipped, so the timer floats it once the reply is dealt with.

**A seller's yes at our number is an agreed price.** "The seller accepted"
used to add the `seller-accepted` tag and warm the offer, and nothing else:
the push to paper waits for an agreed price, so the offer kept its weekly
"any update?". Now the reply agent checks the yes
(`acceptanceAtOurNumber` in shared/auto-accept.js: sure, one house, no other
number named, the thread's number is the offer's) and injects
`mark_offer_agreed`, which is never wirable on a rule. It writes
`offer.agreed {via: "acceptance"}` and a ledger line "accepted our offer — at
N, not in writing yet". The price is locked, `hot_push` picks the offer up,
and the Offers column says "Push to paper". A yes on an offer they passed on
brings it back; a house we walked from is never brought back. It also writes
`acceptanceSignal`, which the acceptance band's once-per-offer check had been
reading while nothing wrote it.

**Replies to people always have room.** `conversationAi.dailyCap` counts
every draft of the day, but it only ever stopped replies. Machine-started
texts now stop a reserve short of it (`REPLY_RESERVE_SHARE` 25%, at least
`REPLY_RESERVE_MIN` 10): with the live cap of 400 the machine stops at 300 and
the last 100 are for people who text us. Both constants are fixed, not
settings. The day's count reads past the cap (it used to stop at 500 rows),
and the band's daily count reads the whole day.

**Nudges say only what's true.** An offer nothing went out on (no letter,
nothing floated) is not nudged: the float timer owns it. A number floated by
text is followed up from when it was floated, and the nudge, check-in and
price-drop texts say "the number we floated", never "the offer we sent"
(`whatWentOut` in reply-agent.js).

### One agent, one house at a time (2026-10-02)

**Why.** Every house kept its own clock, and nothing looked at the agent as
one person. One listing agent got six machine texts from 9/19 to 9/30 about
three houses: the live offer's nudges, a ten-day check-in on a house they had
passed on in August, and one on an old row of a house that had sold. On 9/21
the passed-house check-in went out *instead of* the nudge on the live offer:
both were due that morning, and the later draft replaced the earlier one.
The weekly cap (`maxPerContactPerWeek`) only counted the morning's run, so
three texts in five days each looked like the first. The nightly audit's
"floated, never heard back" nudge wasn't counted as a rung either, so the
sweep asked the same thing again two days later.

**Matt's rule** (`shared/agent-focus.js`):

- **The live offer is what we text about.** `focusOf` picks one house per
  agent from the current rows: a deal still closing, then an agreed price,
  an acceptance, a counter, and otherwise the open offer whose number moved
  last. A priced row nobody floated isn't live.
- **A house they passed on gets a light touch.** While a live offer is out,
  its check-in doesn't go on its own. When it's due it is held without being
  claimed, and rides on the live offer's nudge as one closing line: "still
  around if it ever shakes loose". It's a statement, not a question, with no
  number, at most once every `LIGHT_TOUCH_DAYS` (30). Its rung is then
  claimed (`follow_up_sent` with `data.aside`), and its `followUps` entry
  carries `aside: true`. A house we passed on never comes up. With nothing
  live, the check-in goes on its own as before.
- **One text a morning per agent.** The push to paper goes first, then the
  live offer's nudge, and the rest wait for another day.
- **Three days apart, two a week.** `minHoursBetween` now defaults to 72
  (was 40). The weekly cap counts what actually went out to them, sent or
  queued (`spacingHolds`, `machineTexts`). It covers the unprompted kinds:
  offer and counter nudges, passed check-ins, the agent check-in and the
  outreach texts. It never holds a reply, a number they're waiting on
  (realm/take check, take ask), a promise (promise due, call follow-up), a
  check-in they asked for, an address chase, a price drop, or the push to
  paper (which keeps its 20-hour floor).
- **Check-ins 14 days apart, whichever clock (2026-10-21).** Matt: "if we
  checked in the day before and then we double-text them the day after, it
  just comes off as too needy and aggressive." The check-ins are the agent
  check-in (`agent_pulse`), the outreach follow-up (`outreach_nudge`) and
  the passed-house check-in (`passed_checkin`). Each waits
  `CHECK_IN_GAP_DAYS` (14, stretched by "check in less") after any other
  check-in, sent or queued (`spacingHolds` in shared/agent-focus.js). A
  ladder's own next rung keeps its steps (the outreach follow-ups on day 3
  and day 10); the agent check-in has no ladder, so it is spaced against
  itself too. A held check-in is voided and tried on the next run.
- **A nudge another path sent is that day's rung** (`rungsCovered` and
  `nudgeTimes` in shared/follow-up.js). That covers the audit's nudge and a
  Float pressed by hand. The Offers column reads it the same way.
- **A ladder that keeps asking has no "last check".** With `repeatEvery` on,
  the day-14 nudge used to say "I'll leave it alone" a week before the next
  one. Repeat rungs are now worded as repeats.

**Where it's enforced.** The follow-up sweep asks before it claims, so a
held text spends nothing. `startProactive` asks again for every other door
(`agentTurnReason` in ghl-broker/agent-focus.js): the audit's nudges, the
agent check-in, outreach. A refusal there comes back as `{ skipped, spaced:
true }`. The Offers column and the work pane show a passed house as "Rides on
the <street> nudge".

**Live setting.** The saved config keeps whatever `minHoursBetween` it has.
Prod had 40 on 2026-10-02, so set it to 72 when this merges.

### Reads that keep the newest (2026-09-29)

Several reads stopped at a fixed number of rows and kept the OLDEST, so on a
busy location the week every clock was asking about was the part cut off.

- **The timeline window** (`store.listContactEventsSince`): past its limit it
  now keeps the newest rows and says so (`rows.truncated`). A reader that
  needs all of a window pages through it (`listContactEventsPage`, and
  `allEventsSince` in ghl-broker/contact-events.js). The 14-day outreach
  follow-up read enrollments and replies together, oldest first, capped at
  5,000: months of replies filled the read and this month's enrollments fell
  off the end. It now pages the enrollments and checks each agent's own
  timeline for a reply.
- **The follow-up sweep's offers** (`followUpRows`): open offers used to be
  read oldest-first, 200 at a time (400 for check-ins), superseded rows
  included. Now it pages through the whole book (500 a page, up to 5,000). A
  run starts at most `MAX_STARTS_PER_RUN` (150) texts, hot pushes first, so a
  backlog the paging uncovers goes out over days; a ladder only ever fires its
  latest due rung. The push to paper no longer counts against the week's
  two nudges.
- **The price watch** reads only its 90-day window, all of it. It used to take
  the oldest 300 offers of all time and then keep the last 90 days.
- **The buyer book**: `listInvestors` stopped at 2,000 rows sorted by name, so
  the end of the alphabet silently left every pulse, wave and search. It reads
  the whole book now (and `listContactProfiles` 20,000).
- **Underwrites that never ran**: an address that waited past the daily cap
  for 3 days, or was refused on the tick, is written down
  (`underwrite_dropped`) and shows on Today under "Underwrites that never ran"
  with a Run it now button, until the house has an offer or a week passes.
  It used to be a console line.
- **Flow**: "Replied" counts only agents answering, meaning their inbound text
  or a call. Investors, and the backfill's summaries of our own texts, no
  longer count. "Opened" is measured against the buyers blasted, so it can't
  pass 100%. The page says when a window was bigger than one read holds.

**The price watch sees more.** A house that went off the market and comes
back is recorded (`listing_back_on_market`). Off-market no longer ends its
check-ins for good. With `followUp.relist` on, the passed-offer check-ins
start over from the relist and say it's back on the market. A drop found
while their text (or your own draft) is waiting in the outbox is kept
(`priceWatch.dropOwed`) and texted on a later run, measured from the price
before the drop. With `followUp.watchFloated` on, a number floated by text
and never sent is watched too. Both switches ship off.

**A number texted in a plain reply counts as out (2026-10-16).** Our number
said in an ordinary reply leaves the offer "new" with only `floatSentAt`, no
realm check's own stamp. The follow-up sweep learned to nudge it the same
morning (b8c360e); three readers still took it for a number that never went
out:
- **The price watch** skipped it, so a cut on that house went unseen. It now
  reads `floatSentAt` like a realm check's stamp, still behind
  `followUp.watchFloated` (off in code; the coordinator turns it on).
- **The Offers column** (`nextFollowUp`) said "Our number never went out" and
  the agent check-in read the offer as unsent and took the agent; it now
  shows the offer nudge, counted from `floatSentAt`, the way the sweep acts.
- **Today's "Priced, not floated"** row (and the float timer it drives) no
  longer lists it, so the number is never floated a second time.
No switch beyond `watchFloated`. Check: an offer with `floatSentAt` and status
new shows "Nudge · …" in Next follow-up, and once `watchFloated` is on the
next morning's watch (`job_cursors` row `priceWatch`, `last.watched`) counts
it. Not changed: the board's
lane (`laneFor`) still places such a row in "ready", which the GHL mirror
reads.

### The tick: every job on its own, every day comes back (2026-09-29)

**One job can't stop the others.** The 15-minute tick ran every job for a
location inside one try/catch, so a throw in an early job skipped everything
after it: promises, the audit, the price watch, the waves, the pulse, the
calls. The jobs are now a list (`TICK_JOBS` in broker.js), each run on its
own by `runLocationTick` (ghl-broker/tick.js). A failure is logged as
`tick:<area> failed` and recorded in `app_errors` under that area. The nightly
enrich sweep is awaited now: it is async, and its rejection used to escape
the tick entirely.

**A daily run a deploy kills comes back the same day.** Every push to main
redeploys the broker. A daily job that stamped its cursor and then died used
to lose the day. The follow-up sweep, the outreach follow-up, the dispo
second wave, the nightly enrich, the price watch and the tier check now share
the audit's gating (`claimDailyRun` / `closeDailyRun` in
ghl-broker/daily-gate.js):

- the cursor carries `run` while the job goes and `last` when it's over;
- a run still marked going after 45 minutes with nothing in memory behind it
  is retried;
- a failed run is retried up to four times a day, 20 minutes apart;
- a new day may start anywhere in the job's window (follow-up sweep 16–19
  UTC, outreach follow-up 11am–4pm PT, dispo waves 17–21 UTC, enrich 10–13
  UTC, price watch 9am–5pm PT, tier check 7am–8pm PT), so a deploy across
  the start hour doesn't skip it;
- a cursor from before this change (only `at`) counts as the day's run.

`GET /api/offers/automations/conversation/follow-ups` now returns `daily`: the
cursor's tries, whether a run is going or failed, and `last`, which is what
the day's run did. The tier check's summary moved into `last` on its cursor,
like the others.

### Never more than our number (2026-09-28)

Jesse, 39811 226th Ave SE, Enumclaw. Our offer was 550K, already over
the band's ceiling (the ceiling reads 0 on this house). The passed check-in
asked if the sellers had moved. He came back with "$650 is their bottom
bottom … $650k plus my fees". The bot asked for his value and repairs. He sent
a scope, and the bot auto-sent a `deal_available` reply: "That scope is
workable for us at 650. Can you write it up on NWMLS forms". **"at 650" has no
k**, so `moneyIn` never saw a number and the money guard had nothing to check.
His "Yes I can do that" was then released under the acceptance band as "they
took our number". The band read the book's 550, not the 650 we had just
texted. Three days of "waiting on my partner" texts followed.

What holds it now:
- **Shorthand is money.** `shorthandPrices` (`shared/current-offer.js`) reads
  a bare 2–4 digit number beside a price word ("at 650", "do 650",
  "650 works", "650ish as-is") as thousands, when ×1000 is plausible beside
  our number (0.4–3×). It never reads a number before a unit or a capitalised
  street name, or the tail of a comma group. The gate's `said` includes it.
  Their shorthand ("$650 is their bottom") counts as theirs to echo.
- **Nothing above ours.** `evaluateReplyGates({ ourAmount })` flags any price
  in an agent reply above our number on the house (`pricesWeName`, slack
  max($1k, 0.5%)), even when the agent typed it first. Our number comes from
  `ourNumberFor(book.numbers, draft.propertyAddress)`: the come-down when there
  is one, and 0 for a named house with no offer. A `counter` stays clean so
  the band can weigh it, and the band's own words replace the reply. The gate
  carries `overOffer`, and `releaseForAudit` never releases it.
- Not counted as ours: the ARV, rehab or work, the list price, "came down to",
  "reads as", EMD or earnest, and "Nk is way past…".
- **The thread moved up.** `ourMoveUp` is `ourComeDown`'s other half. It finds a
  higher number we texted after the row last moved. Both bands' `current_number`
  check fails on it. `paperCheck` holds paper with no `comeDown`, so there is no
  "Re-quote at N" button: paying more is a person's call. The offer book tells
  the model the number is not ours, and hides the HOT line.
- **Counters read as theirs** in the book: "they countered at $650,000".
- The prompt's goal rule (3) says never to call a number above ours workable.

Replay over the 30 days before the fix: 11 of 606 agent replies with an offer
on the book would have held. Most were genuine mismatches, e.g. "still at 400"
on a 373.5K book, and "still good for 700k" on a 669K book.

### What the drafts cost (2026-09-25)

September's bill was about $7 a day, and 85–90% of it was the reply drafter
on Opus 5, at ~100–130 drafts a day and ~5–8¢ each. What changed:

- **Every draft records its cost.** `usage` sits on each reply-draft row:
  tokens by kind (cache read, 5-minute and 1-hour writes, output), whether it
  was batched, and dollars (`shared/ai-cost.js`, prices from the pricing
  page). Address extraction and the coach log a line with the same numbers.
  Read it with `node scripts/ai-usage-report.mjs [--days N] [--pairs file.md]`.
- **The system prompt caches for an hour.** Drafts arrive every few minutes.
  The 5-minute cache missed about half of them, and each miss re-wrote ~5K
  tokens at 1.25x.
- **The output format is part of that cache, so it is one format per party
  for every machine text** (2026-10-02). Each kind used to carry a
  one-value intent list naming itself, so each kind (realm check, check-in,
  pulse, nudge…) had its own cache entry and re-wrote it at 2x: 46 writes in
  158 machine texts over two days. The kind is named in the text's
  instructions ("Set intent to …") and `parseDraft` stamps it on the draft.
  Replies to a person keep their own format and their intent list. A test in
  `draft-cache.test.mjs` fails if two kinds' formats ever differ again.
- **Sweep texts go through the Batch API at half price.** These are the
  `BATCHABLE_KINDS` in `reply-agent.js`: nudges, check-ins, pulse, hot push,
  promise and price-drop texts, first outreach.
  - They run on their own lane (`<location>:machine`, 8 wide), so they never
    queue in front of a reply to a person.
  - `draft-batch.js` collects them for 20 seconds and sends one batch.
  - Any error or refusal, or a batch not finished in 15 minutes, falls back
    to the ordinary direct call.
  - A redeploy while a batch is out loses those drafts, the same way it loses
    any in-flight job.
  - Switch: `conversationAi.ai.batchMachineDrafts`.
  - Never batched: realm/take floats, partner answers, address chases, and
    every reply.
- **Plain check-ins draft at low effort** (`LOW_EFFORT_KINDS`). Replies, and
  anything with a number, a counter or terms, stay at medium.
- **Address extraction runs on Sonnet 5 at low effort.** The coach runs at
  medium.
- **The thread reaches the model newest-first.** The prompt used to keep the
  first 14K characters of a 16K thread, which dropped the newest messages on
  long threads. It now keeps the last 14K. The classifier and extraction had
  the same cut.

**The shadow.** `conversationAi.ai.shadowModel` (Sonnet 5) drafts every
message beside the real Opus draft, until `shadowUntil` (2026-09-30).
- The shadow draft is stored on the row as `shadow`: its reply, intent and
  needs-a-person flag, the same gates' verdict, and its own cost.
- It is never sent or acted on.
- The real draft waits for it 20 seconds at most.
- Judge it with the report's `--pairs` file. If intent and gate agreement
  hold and the replies read right, change `REPLY_MODEL` to `claude-sonnet-5`.
  That's about 60% off the drafter.
- Set `shadowModel: ""` to stop it early.

### What every Claude call costs (2026-09-30)

The drafts report said about $8 a day while the bill said more. Photo scans
(up to 40 photos each), comp grading, enrichment, dispo ranking, party
classification, post-mortems and the coach were never metered.

- `ghl-broker/ai-spend.js`: every Claude call goes through `meterAi(feature,
  response)`. It logs the call and adds it to a per-day, per-feature ledger in
  `job_cursors` (location `_all`, name `aiSpend`, last 60 days). Metering never
  throws. Until `startAiSpendMeter` runs at broker boot it only logs, so tests
  and scripts write nothing.
- Features: `draft_reply`, `draft_machine`, `draft_shadow`, `photo_scan`,
  `comp_grade`, `address_extraction`, `enrich_contact`, `deal_interest`,
  `buybox_parse`, `buyer_rank`, `classify_party`, `post_mortem`, `coach`.
- Read it at `GET /api/offers/automations/ai-spend?days=N`. The last section
  of `node scripts/ai-usage-report.mjs` prints it.
- **Drafts moved to Sonnet 5** (`REPLY_MODEL`). The case for it was 420
  drafts side by side with Opus 5: same intent 80%, same needs-a-person 87%,
  42% of the cost, and every number above ours caught by the gates. Sonnet
  has no server-side fallback, so `callDraftModel` writes a declined draft
  once more on Opus 5 (`REFUSAL_RETRY_MODEL`). The shadow stops by itself,
  because it only runs when its model differs from `REPLY_MODEL`.
- `classifyParty` set `output_config` twice. The second one (format only)
  dropped effort "low", so the call ran at the default. It is one object now.

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

**Only what still needs you (2026-09-30).** Matt: "if they say 'no' nothing
else we need to do… I just want the high leverage important stuff."
- A plain no to our check-in — "No / Sorry", "Nope", "Not right now",
  "Nothing yet, thanks", "Not a project" (`isPlainNo`: short, no question, no
  number, nothing after a "but") — is dropped like a closer: no redraft, no
  row. Unless our offer is out or a deal is live: then the no may be their
  pass, and the reply agent answers and records it.
- Today re-reads last night's rows when it loads (`stillOwed`): a "texts we
  never answered" row leaves once a reply was sent or queued after their
  text, whoever wrote it; and no row that would text someone who
  unsubscribed (an `unsubscribed` event) is shown — audit rows, held drafts,
  scheduled drafts or promises. The counts drop with them.
- Goodbyes are closers however they're spelled ("Sounds good! Thank you for
  reaching out, have a good weekend!", "Sounds great man! I will do that",
  "Please do!", "🙏🏻" with a skin tone), up to 80 characters.
- The audit reads every text they sent since our last one
  (`getUnansweredInbound`), not just the newest: only when all of them are
  goodbyes, reactions or plain nos is the thread left alone — "We just have
  the one in south park…" then "Otherwise. Not really" is a lead.
- A row about their text shows it ("“7022 in Kenmore is the only thing
  close.” — the bot stood down: bot is off for this contact (tag: stop
  bot)"), and a stood-down reply says why before "a reply was started".

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

### Approved numbers only go to a write-up (2026-10-15)

From the funnel review: "since we're aligned at 752,500, can you write it up on
NWMLS forms?", then "can't get there" the next day. The machine now asks an
agent to write it up, use NWMLS forms or represent us only at a number Matt
stands behind (`numberApproved` in `shared/offer-status.js`). No switch: this
only tightens.

- **Approved** means one of: an offer built by hand that no machine has moved;
  `offer.approved = {amount, at, by}` at today's number, written by Send
  (`by: "send"`), publishing a held run (`publish`), a hand revision in the
  editor or the held-paper banner's re-quote (`revise`; revisions now carry
  `by`), pinning a row (`pin`), or **Approve** on Today (`today`,
  `POST /api/offers/:id/approve {amount?}`); or a run published or pinned after
  the machine last moved the number. A re-quote on their figures
  (`by: "requote"`) and the counter band running by itself
  (`by: "counter_band"`) are not approval, and a new number voids an old one.
- **What it holds.** The hot push (`asksForWriteUp` = `pushesToPaper` and
  approved) — its `ready` and `hotCandidates`; the offer ladder still leaves an
  agreed price alone, so nothing texts until Matt approves. The offer book says
  "AGREED … but the number is NOT APPROVED on our side yet — don't ask them to
  write it up … say you'll confirm the number on our side today". A gate
  (`writeUpOk` in `evaluateReplyGates`) holds any agent draft that asks for a
  write-up ("NWMLS", "write it up", or "represent us" beside an offer or a
  price) on a house whose number isn't approved — except the "we're not
  agents" answer when they handed the write-up back to us. The machine's own
  letter text and email drop the NWMLS ask; so does the "taking it to the
  seller" reply; the confident float doesn't promise the write-up.
  `pushesToPaper` itself is unchanged: the focus house, the call list and the
  offer ladder still read it as "a price is agreed".
- **Today.** An agreed price (`priceAgreed`) at an unapproved number is an
  **approve_number** row, "they agreed at $410,000 — approve it before we ask
  for the write-up", with **Approve 410K** and Open.
- **Check it.** `GET /api/offers/:id` shows `approved`; Today shows the row;
  the hot push's skip reason is "the agreed number isn't approved yet".

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

**The machine's own texts stop at 5pm (2026-10-05).** Matt saw check-ins
landing at 7 and 8pm: "not send outreach texts after 5pm… feel like it hurts
our chances". `autoSend.machineUntil` (default "17:00") shuts the window for
anything the machine starts on its own (`MACHINE_STARTED_KINDS`, blasts,
written offers, the walkthrough ask). `machineHours(autoSend)` in
conversation-scheduler.js is the page's window shut at that time. Replies to
their texts keep the whole window (8am–9pm live). It applies in three places:
every scheduling path for those texts uses it; `spreadAcrossDay` now keeps a
spread inside the day's window (a noon sweep fills the afternoon instead of
rolling a third onto 8:00 tomorrow); and the 30s ticker moves a machine text
that comes due outside its hours to the next opening (`afterHours`) rather
than sending it. Settings → Conversation AI → "Texts the machine starts stop
at". A pile of machine texts due in the same tick (a rolled spread, a
backlog after a restart) goes `MACHINE_BURST` (5) at a time; the rest are
spread across the hours left (`respread`).

**A hold the reader got wrong undoes itself (2026-10-05).** First texts saying
"your listing at 1301 225th Pl SE" were held as naming $1,301,000 until
`SHORT_STREET` fixed the reader that morning, but a held draft is never read
again and the 7pm audit never releases a gate's hold, so the ones held before
the fix sat under Decide. Every tick (`misread-holds.js`, area
`misread-holds`) reads again each held text the machine started whose only
flags are "names $X, which is not in the offer/deal book". When the gate's own
readers (`moneyIn`, `shorthandPrices`) no longer see any $X in it, it is under
72h old, the model didn't ask for a person, and `decideAutoSend` as the
switches stand would send it, it goes back to scheduled, spread across the
day. One open draft per contact: a newer one wins. The send-time checks still
apply. A reply to their text, or a hold for anything else, stays yours.

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

### A promised number stays owed until it's delivered (2026-10-14)

**Why.** Reading 2,014 threads turned up at least 15 where we told an agent
"I'll get back to you today with a number" (or the LOI) and nothing
followed. The promise row above drops off Today after 72 hours. Several of
the houses were then closed out by the nightly held-underwrite sweep, stale
or no answer, with nothing sent. The agent was never told. These were the
agents who answer us.

**The row.** `shared/promise-owed.js` `owedPromises`, pure. A `promise_made`
of a **number** or **the written offer** that is 24h old (`OWED_AFTER_HOURS`)
becomes a "Needs you" row, kind `number_owed`: "Owed: a number to Pat on
12 Elm St". The detail says when we promised ("promised Oct 7, again Oct 9")
and what we said. It doesn't expire at 72h; it reads back 60 days
(`OWED_WINDOW_DAYS`). While the 72-hour `promise_owed` row is up for that
person, that row speaks for them. The buttons are the resolver's (float,
open and send, re-run) plus Dismiss-with-why.

It clears when:
- a text of ours on that house names a price (≥ $50k; "449kish" counts) or
  passes (`keepsOurWord`);
- a float or `kind_pass` goes out, or the written offer goes out;
- they passed, the house is gone, it's a deal, or a person marked it we passed;
- there's a `promise_kept` after it: the sweep, a status you set, or Dismiss.

A house the held sweep closed out by itself does **not** clear it. The agent
hasn't heard yet. Not owed at all: an "answer" promise (the 72h row's
business), a number promise that ended on a question to them, and a
conditional one ("…circle back if it pencils out", "see if we can",
`isConditionalPromise`).

**The send writes the keep.** `sendReplyDraft` records `promise_kept`
(`by: our_number | our_pass | realm_check | take_check | kind_pass`) for any
agent text that delivers. A text that promises again keeps nothing ("Got it,
480k, let me run that…" is their number said back).

**Your own texts count.** The composer and texts typed in GHL go through
`notePromiseInHandText` (promise-sweep.js, via the offers router's
`onHandText`). A promise opens a `promise_made` with `by: "you"`, and a price
or pass keeps one. Only what kind of promise it was is stored, never the
words. The sweep, the driver and the 72h row ignore `by: "you"`, so no "still
working on it" text ever goes out in your name. Only the owed row carries it.

**Detection widened.** `detectPromise` now reads "I'll come back to you today
with a number", "will have a number for you this afternoon", "let me run it
and get back to you", "…with where we'd land", and "run both of these by
underwriting" as a number. When a partner is named, it stays an answer, for
the answer box. "Can you send it over?" and "so I can get it in front of
underwriting" are no longer read as promising the paper.

**Retiring a house we owed tells them.** See the held-underwrite triage,
"promised" below.

**Replay (2026-10-14, 968 saved threads).** 115 threads have a firm promise
of a number or the offer from us. In 55 of them, at least one promise saw no
price, offer or pass from us within 48h. Of those, 44 were in the last 60
days and 28 never got one at all. On deploy, expect up to about that many
`number_owed` rows. Only promises recorded since `promise_made` existed
(bot sends from 2026-09-14) show, and your own typed promises only from now
on.

### A call, a time to walk it, the earnest money: promises we keep (2026-10-15)

**Why.** The funnel review: in 37 of the 58 negotiations we dropped, we'd
promised something nobody delivered, and the bot's defaults kept inventing
people to check with ("my underwriting team", "my partner … back to you this
afternoon").

**Three more kinds of promise** (`detectPromise`, shared/follow-up.js):
`call` ("I'll give you a call tomorrow", "let me call you back"), `tour`
("I'll get you a time to walk it", "let me set up a walkthrough") and `emd`
("we'll get the earnest money over to title"). A conditional one ("…give you a
call if it makes sense") is not a promise. They're `PERSON_PROMISES`: only a
person keeps them, so the promise sweep never sends its "still working on it"
text for one and the driver never acts on one. `sendReplyDraft` and your own
typed texts (`notePromiseInHandText`) record them as `promise_made` with
`what: call | tour | emd`.

**Owed rows** (`owedPersonPromises`, shared/promise-owed.js), a day after the
promise, for 60 days:
- `call`: a **call_owed** Call row ("Owed: a call to Pat on 12 Elm St"),
  score 110, so it leads Today's calls, and it's on Today even when
  `desk.dailyCalls` is 0. Kept by a connected call or one of ours that was
  tried (`call_attempt`, not their missed call to us).
- `tour`: an owed row "Owed: a time to walk it to …". Kept by a booking
  (`call_booked`) or a text of ours that names a time.
- `emd`: an owed row "Owed: the earnest money to …". Kept when the deal's
  "Earnest money to title" checklist item is ticked.
Dismiss closes any of them (`promise_kept` by `dismissed`). The machine's own
keeps (a price went out) don't: a price isn't a call.

**The default words** (no setting; the live config's saved instructions are
separate and get the same rewrite by hand). A new fixed `PROMISE_RULE` rides
on every agent draft: promise only what will actually happen, and say when
("I'll text you the number by 3"); never invent a team or a partner; anything
only Matt settles goes on a quick call, with needsHuman. FACTS, COMMITMENTS
and MATH (conversation-prompt.js), the starter rules, examples, PRICING,
REALM CHECK and mayCommit (shared/conversation-ai.js), AGENT_PAPER_RULE and
AGENT_GOAL_RULE, the come-down line in the offer book, and the number-first
reply ("…I'll text you where we'd be once they're done") all lost their
"underwriting team / my partner / back to you today". "I'll text you the
number" and "text you where we'd land" still read as a promised number.

**Check:** a sent "I'll give you a call tomorrow" puts `promise_made {what:
"call"}` on the timeline; a day on, Today's calls shows "Owed: a call to …"
until a call is logged or tried.

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

### Today — only what needs you (2026-10-13)

Matt: "get rid of the call section … Today should ONLY be for urgent, crucial
tasks only I should do." Today is one list, **Needs you** (`TODAY_SECTIONS`,
`urgentReasons` in shared/desk.js, applied before the fold so a person whose
strongest reason was a call still shows for the decision under it). On it:
a reply waiting on him (the bot couldn't place it or may not send it), a text
nobody answered, a number or answer we owe, a counter above our number (the
CallCard's Hold / Meet / Walk away), paper to sign, a hand-off, a buyer's
agreed price, a held deal blast, a closing that's due. Off it: the call list
(first replies, gaps, houses they brought, hot offers, missed calls), the
machine's own work, held underwrites and priced-not-sent offers (Offers →
Draft), texts the machine started (check-ins, first texts, buyer pulses,
floats — the Conversation outbox), deal housekeeping not yet due. The call
list only ever fed this screen, so nothing about who gets texted changed. The
Settings section for the call list is gone. Live snapshot: 85 rows → 18.

**Today's calls (2026-10-15).** The funnel review: all 8 contracts from
outreach agents came after a phone call; agents who talked brought houses
54% of the time against 8%; and only 15% of the agents who answered us
ever talked. So the call list is back on Today as a second section, **Today's
calls**, under Needs you: the best `desk.dailyCalls` (default **10**, 0–30, 0 =
none) call list rows still in Call, best score first (`urgentReasons`). A
counter above ours and partner terms stay under Needs you as before. A missed
call only makes it with a live house on it. A person with a decision and a
call shows once, led by the call, with the decision under "Also on".
Scores now carry boosts (`CALL_BOOSTS`, shared/call-list.js), shown on the
call card as "Up the list: …": +15 an agent we've done business with or
who brought us a house (`agentSegment` partner/source), +10 one who talks
like an investor (`investor_minded` in the last 90 days), +10 a seller going
through a life event or an estate in their words (last 60 days), +10 a
counter within `counterHold.callWithinPct` of ours. Setting: `saved.desk.dailyCalls`
(PUT the settings doc; there's no Settings field). Check: `GET
/api/dashboard/pipeline` → `desk.sections` has `call`, and at most
`dailyCalls` rows have `section: "call"`. With calls going to GHL (below),
these go to GHL's Manual Actions instead and leave Today.

**GHL stage beside the name.** The work pane's name line (Today and the
Offers split, `GhlStagePill` in PaneParts.jsx) shows the agent's Acquisitions
card — "GHL: Tier 2", "GHL: Offer Out", "GHL: no card" — from
`GET /api/dashboard/ghl/card?contact_id=` (one GHL read, cached two minutes in
the page). Buyers don't get one.

### The Desk — one row per person, Call · Decide · Machine (2026-10-02)

Matt's day ran across three places (Today, GHL's Tier 1 stage, the Offers
tab) and Today listed the same agent up to three times for one house. The
Desk is Today's "Desk" tab (it was "Needs you"): the same rows, folded.

- **Reasons fold into people.** Every row `buildPipeline` and last night's
  audit produce is a reason; `foldDesk` (`shared/desk.js`) folds the reasons
  about one contact into one row, led by the strongest (`KIND_STRENGTH`). Rows
  about a deal (`closing_*`, `deal_*`, `showing_*`, `stage_lag`,
  `blast_no_opens`) fold by deal, not under the listing agent. The others ride
  along as `also`, each with its own buttons in the pane's **Also on …**
  block. A reason that only repeats a stronger one (`quiet`: last night's
  "still owed a number" beside the promise row) isn't shown, but Dismiss
  takes it too, so it can't bring the person back on its own.
- **Sections** (`sectionFor`). **Call**: a counter (a draft whose band
  refused it), a wants-a-call / scheduling / walkthrough draft, `hot_stalled`,
  `deal_interest_stalled`, last night's `counter_stalled`, a buyer the bot
  stays out of on a live deal, and the call list's own rows. **Machine**: the
  pipeline's machine group (timers, driven promises, scheduled drafts),
  `gone_quiet`, `showing_soon`, `blast_no_opens`, `underwrite_failed`, a
  closing next week, the audit's `float_unanswered`/`offer_no_followup`, and a
  held underwrite last night's triage is asking about, re-running, dropping
  or retiring (`heldVerdicts`). Everything else is **Decide**.
- **Names.** `nameRows` fills a missing name off the contact record and GHL
  (`namesFor`, ≤25 lookups a load, cached) on every row, not only the audit's,
  and keeps the old "An agent…" title as `dismissedAs` so an earlier dismissal
  still holds.
- **The strip** (`deskKpis`): calls placed and talked today, written offers
  sent today against `lineTargets.offersPerDay` (+ floats), the Hot lane, and
  contracts this month against `lineTargets.dealsPerMonth`. Pacific days.
- **Wire.** `GET /api/dashboard/pipeline` adds `desk: { sections, rows,
  counts, kpis }` after dismissals; `actions` is unchanged for the board and
  for a console that predates the Desk (which then shows the old groups). A
  `?row=` link to any folded reason opens its person.

### The call list — who to call today, and why (2026-10-02)

The phone is Matt's job; everything else is the machine's. `callList`
(`shared/call-list.js`) builds the Desk's Call rows from the book — before it,
a hot offer reached Today only after two failed pushes, and GHL's Tier 1 stage
was the call list he walked by hand. One reason per person, the strongest:

| kind | when | score |
|---|---|---|
| `call_missed` | they called in the last 3 days and nobody picked up (an inbound `call_attempt`) | 105 |
| `call_hot` | a current offer is Hot and not a deal — "get it written up" when the price is agreed (`pushesToPaper`), else "hear where the seller is" | 100 |
| `call_counter` | a countered offer whose `counter.amount` is above ours — ours, theirs, the gap, and the band draft's ceiling | 90 |
| `call_first_reply` | an outreach agent's first-ever reply that names a house (or is open to investors), within `firstReplyDays` | 70 |
| `call_quiet` | `ladder_exhausted` / `gone_quiet` on an agent who has replied before (engaged or partner) | 60 |
| `call_phone_only` | unsubscribed from texts with a house still open | 55 |
| `call_partner` | an agent we've done business with, quiet `relationshipDays` (at most `relationshipPerDay`) | 30 |

Rows the pipeline already put in Call (a wants-a-call draft, `hot_stalled`,
`deal_interest_stalled`, last night's counters) get a brief from `briefFor`.
Score drops a point a day as their last word ages (≤30) and 15 for each call
that didn't connect. Anyone whose recent texts read as annoyed (or opted out,
except `call_phone_only`) is never listed.

**Every Call row** carries `call: { why, goal, opener, houses, tries, … }`. The
opener is a template, never the model, and numbers are said the way Matt says
them — `kText`, never rounded up past what we sent ("197.5K", not "198K").
The pane shows it as the call card: **Call in GHL** (the dialer records it),
the number, and three chips for a call that didn't connect.

**What clears a row.** A connected call after the row's `since` (call-intake's
transcript, or one logged by hand). A `call_attempt` lowers it for the day;
`call_back` with a date hides it until then; after `triesBeforeMachine` calls
with no answer it goes to the machine ("back to texting") and the person's
other Call reasons become decisions. Rows past `callCap` wait behind "N more
to call". Settings → The Desk's call list holds the five numbers
(`saved.desk`, `normalizeDesk`). Nothing on the list sends anything.

**Answering a counter from the Desk.** A `call_counter` row carries
`counter: { ours, theirs, gap, ceiling, overCeiling, basis, draftId }` (the
ceiling from the newest band draft on the offer, never off a lean row) and
four answers under the call card, each a person's tap — the band and
`NEVER_AUTO` are untouched:
- **Hold our number** — `GET /api/offers/:id/hold` reads the thread and
  returns `holdNumber` (`shared/current-offer.js`): the lowest number we've
  put to them on the house (the book as it last went out — a re-quote nobody
  sent yet doesn't count, `sentNumber` — a lower number we texted since —
  `ourComeDown` — or the last quote that named it), in words that name only
  that number. They land in the reply box (`COMPOSE_EVENT`); Send is yours.
- **Meet at $X** — between ours and theirs; a warning past the ceiling.
  `POST /:id/requote` (refuses an agreed price), then the usual Send window
  for the letter; the counter draft is dismissed once it's sent.
- **Call them** — the card's Call in GHL.
- **Walk away** — confirm, then the offer is `we_passed` (machine texts about
  it stop) and the counter draft is dismissed.

### Today's calls in GHL's Manual Actions (2026-10-15)

Matt dials from his computer in GHL's Manual Actions queue, not from Today.
Matt's decisions: calls live in GHL **only** (once a call is in GHL it leaves
Today), the day's list goes in at **8:30am Pacific** on workdays, and the
urgent ones go in as they turn up until **5pm**.

**What goes, and when** (`ghl-broker/ghl-calls.js`, the `ghl-calls` tick job;
which rows in `shared/desk.js` `ghlCallRows`):
- **8:30, the morning list:** Today's calls (the best `desk.dailyCalls`, not
  the ones behind "N more to call") plus every urgent one.
- **Every tick after it until 5pm, the urgent ones:** a call we promised
  (`call_owed`), an agent asking to talk (a held reply whose intent is
  `wants_call` / `scheduling` / `wants_walkthrough`), a counter above ours
  (`call_counter`), partner terms (`call_partner_terms`), a missed call on a
  live house (`call_missed`). Other call rows that show up after 8:30 stay
  on Today until the next morning's list.
- For each person (once per Pacific day): the app fills two contact fields,
  **App call why** (`contact.app_call_why`: what the call is about and what
  it's for, ≤300 characters — e.g. "Countered 315K on 12 Elm St against our
  300K — 5% apart, a call lands it. Land a number. …") and **App call say**
  (`contact.app_call_say`: the call card's opener), adds the contact to the
  workflow below, and leaves a **contact note** with the same words ("App
  call today / Why: … / Say: …"). GHL's newer **Manual call** step has no
  instructions box (2026-10-16), so the note — shown beside the call in
  Manual Actions — is where Matt reads them. The note is best-effort: one
  that doesn't save never takes the call back. Nothing is texted, ever.

**Today with it on** (`withoutQueuedCalls`): a call that's in GHL (queued
today, or since its reason began) leaves Today, and the counts follow. A
counter above ours and partner terms **stay** — their Hold / Meet / Walk
buttons are decisions — and say "In GHL Manual Actions". Today's calls,
empty, reads "Today's calls are in GHL's Manual Actions." A call GHL records
(call-intake reads it, as before) clears the row by itself.

**The ledger** (each person's timeline): `ghl_call_queued` is the day's claim,
written before anything goes to GHL (key `ghl_call:<contactId>:<day>`, so
two ticks or brokers never put someone in twice); `ghl_call_failed` when a
GHL write failed; `ghl_call_withdrawn` when a call was taken back out.
- **No phone in GHL:** never claimed; the row stays on Today.
- **A GHL write failed:** a durable error (area `ghl-calls`) and
  `ghl_call_failed`; the row stays on Today for the rest of the day.
- **Taken back:** a call still in GHL whose reason is gone from Today (not
  just pushed down the list) with no call since it went in is removed from
  the workflow. At most ten a run, and never off a read that came back empty.
- **Next workday:** a call still due goes back in once, with that day's
  words; the app takes the contact out of the workflow first, so GHL holds
  one action for them.

**The GHL workflow Matt builds once** (the GHL API can't create a Manual
Action; only a workflow step can):
1. Automation → Workflows → Create Workflow → Start from scratch. Name it
   **App: call today** (any name works).
2. No trigger: the app adds contacts itself. (If GHL won't publish without
   one, use Contact Tag Added → `app-call-today`; the app never sets it.)
3. Workflow **Settings** tab: **Allow re-entry ON** (the same person can
   come back on another day).
4. Add action → **Manual call**. Action name: anything (e.g. "App call").
   Under **Advanced settings**, assign it to Matt if there's a user field.
   There's no instructions box — the app's contact note carries the words.
5. **Save action**, flip **Draft → Publish**.
6. Copy the workflow's link from the browser (…/workflow/<id>) → the app's
   Settings → **Today's calls in GHL** → paste it in "GHL workflow link",
   tick **Calls go to GHL Manual Actions**, Save.

The two contact fields (**App call why**, **App call say**) are made by the
app on its first run; nothing to set up for them.

No new Private Integration scopes: contact updates, custom fields and adding
to a workflow are what outreach already uses (`contacts.write`,
`locations/customFields.write`).

**The switch** (`saved.desk.ghlCalls`, normalised by `normalizeDesk`, so
Settings' whole-blob save keeps it): `{ enabled: false, workflowId: "",
hour: 8, minute: 30, until: "17:00", weekdaysOnly: true }`. **Off by
default**; it runs only with `enabled` and a `workflowId` (a pasted builder
link is read down to the id). Settings has the switch and the link; the
times are PUT-only. Turning it off leaves what's already in GHL's queue
there and puts every call back on Today.

**Check:**
- `GET /api/dashboard/ghl-calls` — the setting, today's calls in GHL (`inGhl`,
  `ended`), the failures and take-backs, and the job cursor (`last` = the
  morning, `urgent.last`, `hand.last`).
- `POST /api/dashboard/ghl-calls/run` `{"mode":"morning"}` — a dry run (the
  default): who would go in and who would be taken back; writes nothing.
  `{"mode":"morning","dryRun":false}` runs it for real (switch on only).
- GHL → Contacts → Manual Actions → the phone calls are there with the why
  and the words; Today's calls is empty; a counter row says "In GHL Manual
  Actions".
- Errors: app_errors area `ghl-calls` (Reports → Line's errors).

**Known limits.** Completing or skipping a Manual Action in GHL without a
call isn't seen by the app: the row stays off Today the rest of the day, and
goes back in the next workday if it's still due. One call per person a day,
in the words of the first reason that sent it: a counter that arrives at 2pm
for someone already in GHL for a hot offer doesn't change the GHL words (the
counter row stays on Today with its buttons, marked as in GHL). A call that
failed to go waits on Today until the next morning.

### The pipeline — GHL follows the offers (2026-10-13)

Matt's diagram: GHL's Acquisitions board is the source of truth for where an
agent is, in four stages, and the stage of their offers drives it.

| GHL stage | Means | Set when, across the agent's current offers |
|---|---|---|
| Tier 2 | replied, nothing live — the app's check-in is the nurture | every offer passed (they passed, we passed, gone, no reply, deal fell through) |
| Tier 1 | a property identified | a draft: priced and not out, or a held underwrite — while live (something on the offer in the last `staleTier1Days`, 10) |
| Offer Out | our number is out | Sent (written offer, or a number texted), Countered or Hot |
| Contract | under contract | Accepted / a live deal. A closed deal marks the card **won** |

The offers' own stages are Draft · Sent · Responded (Passed · Countered · Hot ·
Accepted) — see the Offers tabs. The highest card stage across the agent's
houses wins, so a pass on one house never drops an agent whose other house is
out. Rules: `shared/ghl-stages.js` (`targetStage`, `planCard`, `planStageMoves`).

- **Newest wins.** A card moves only when the agent's newest offer event
  (`offerStageAt`: status, send, float, heat, deal stage) is later than the
  card's `lastStageChangeAt`. A card you drag in GHL after that stays put and
  is reported as "moved by hand". A move the app made — this planner, the
  migration, the Tier 1 list (`ghl_stage_moved`, within 10 minutes of the
  card's move, `APP_MOVE_SLACK_MS`) — is never read as yours (2026-10-14:
  the migration's own move into Tier 1 pinned Eric B. and Korey P. there).
  A move by a GHL TIER workflow the bot enrolled them in stands like yours:
  it was the conversation's read at the time ("she's listing next week" →
  TIER 2), and an unsent number mustn't drag the card back up.
- **A number we never sent goes stale (2026-10-14).** A `new` row or a held
  draft is Tier 1 only while live: an offer event on it (a re-run, a float,
  a send, a status) in the last `staleTier1Days` (10) — their texts about
  something else don't count. After that the agent is Tier 2
  ("priced but never sent…"). Eric B. had sat in Tier 1 55 days on an
  August row; Cheryl P. on a duplicate of a house we'd passed.
- **Never:** two open cards (a person's call), a won card (a new house makes a
  new card), a card still in a stage that's going away (the migration), or a
  move into Tier 2 while a published "nurture" workflow would text them
  (`allowNurtureTrigger` overrides). A card is made for an agent with
  something live and no card. A lost or abandoned card is reopened instead.
  With `tier2Repliers` (below), a conversation gets a Tier 2 card too.
- **Who moves it** (`ghl-broker/tier-check.js`):
  - `syncAgentCard`, one agent, right after your status change, promote, hot
    flag, send, Tier 1 Pass/Kick, or the conversation's status change;
  - `syncChangedCards`, every 15 minutes (`cardSync` cursor), for every
    agent whose offers moved since the last run — the sweeps, timers and
    triage that write statuses elsewhere;
  - `runStagePlan`, every morning at 7am PT, the whole board, capped at
    `maxMovesPerRun`.
- **Tags follow the card** when it's on: the 7am check sets tier-1 for Tier 1,
  Offer Out and Contract and tier-2 for Tier 2, and a tag the bot adds no
  longer moves a card. The bot's tier tags and TIER 1/2/3 enrollments all
  stand down (reply-agent 4e°, `isLowerTierAction`, `isTierOneCardAction`,
  2026-10-14). TIER 1 had moved the card into Tier 1 on the model's intent
  alone, including on replies that passed (Dana F., Loren K.,
  Lan N.). The rule's `start_underwrite` still runs; the offer it makes
  moves the card. The TIER 1/2/3 workflows in GHL can go to Draft.
- **Our reply passes → not Tier 1 (2026-10-14).** The model tagged "probably
  not enough meat for us" as `deal_available`. `ourReplyPasses`
  (`shared/flip-read.js`) reads our own reply: a pass that isn't also chasing
  a house ("pass on 184th, keep me posted on Mount Vernon" still runs) files
  as `investor_open`, strips the underwrite and the tier-1 rule, stamps the
  draft `qualify: {stage: "pass", why: "our reply passed on it"}` (so
  `threadPassed` stops a racing underwrite, and the app's Tier 1 skips the
  house), and `retire_unsent_offer` closes a number we priced on that house
  and never sent (`we_passed`, `retired.by: "conversation"`). An offer that
  went out — floated or sent — is never touched.
- **Their no on a house we never sent → not Tier 1 (2026-10-16).** Brent S.:
  the underwrite on 4203 E Congress stopped early, so the row stayed a held
  draft. Matt texted a number by hand, the agent said "not at this time", and
  `mark_offer_passed` found "no open offer on that address"; the draft kept
  the card in Tier 1. The conversation's `passed` or `unavailable` now lands
  on the held draft for the house it names, ahead of a guess at another
  house's open offer. With no house named, it lands on the only draft from
  the last 21 days, never one of several. A counter never lands on a draft:
  we sent no number to counter.
- **A pass that leaves the card says why (2026-10-16).** Toril S.: Matt passed
  one house by hand and the card stayed in Tier 1, because her other house
  was a held draft. That's the rule working, but nothing said so. The status
  route now answers with `card: { to, label, offerId, address, text }`
  (`cardHeldBy`), and the work pane and the Offers table show the text: "The
  GHL card stays in Tier 1: 29308 158th Ave E is still being priced. Pass
  that house too and it goes to Tier 2."
- **A conversation gets a Tier 2 card (2026-10-16).** Deanna W. wrote back
  "no fixers right now, I'll call when I have one". There was nothing to
  price, so no offer and no card, and since the bot's TIER 2 enrollment stood
  down (10-14) nothing else made one. Matt: "should have an opp in tier 2 so
  we know to follow up with her". With Settings → "Give every agent we've
  talked with a Tier 2 card" (`ghlStages.tier2Repliers`, **off**), an agent
  whose last word to us is on record (a call, or a text of theirs) and who
  has nothing live and no open card gets one in Tier 2 (`repliedCard` in
  `shared/ghl-stages.js`, `agentRepliers` in `ghl-broker/tier-check.js`).
  Buyers are left out, and so are agents who opted out (an `unsubscribed`
  event, or a last word with `opt_out`). Only a contact tagged as an agent
  by the Conversation AI routing (`agent`, `agent-*`) qualifies. The plan
  knows an agent by profile tags, a `tag_added` agent tag on their timeline
  (the outreach import; most profiles carry no tags), our outreach opener, or
  an offer row. GHL's live tags are checked again right before a card is
  made or reopened ("not tagged as an agent in GHL"). The first
  preview had planned a card for a homeowner from the June seller texts,
  whose replies had been filed as an agent's. The rules for the card:
  - A closed card reopens in Tier 2 only when they wrote after it closed.
    A lost card stays lost. A won card stays won, and a word since makes a
    new card.
  - When the app made a card for them before and it's gone, someone deleted
    it, and it stays deleted. This also stops GHL's search lag from making a
    card twice.
  - The 7am sweep makes them, after the offers' own moves and under the same
    `maxMovesPerRun`. The 15-minute tick makes one for an agent who wrote
    since its last run; that path never moves a card they already have.
  - The nurture guard holds them too.
  - Preview before switching on: `GET /api/dashboard/ghl/pipeline?repliers=1`
    (`plan.counts.tier2Repliers`, `plan.creates`).
  - **GHL's thread counts too (2026-10-19).** Matt: "all agents who HAVE
    responded (not negatively like stop, etc)". The app's record of a reply
    was the bot's summary, so 153 agents who wrote back had no card: the
    July/August lists the bot never answered, threads it was stopped on,
    texts it held. The 7am sweep now reads every GHL thread that moved since
    its last read (cursor `ghlWords` in `job_cursors`, oldest first, 1,000
    threads a run) for agents by GHL tag with no open card, and
    `theirWordInGhl` (`shared/ghl-stages.js`) finds their newest real word:
    a text, an email, or a call that connected. A tapback or an office's
    auto-reply isn't one; any stop / remove / wrong number, or GHL's "DnD
    enabled", is an opt-out. A buyer (investor tag), a `dnc` tag and an
    `unsubscribed` event stay out. One found but not carded that run (the
    cap, a guard) waits in the cursor's `pending` and is tried each morning
    for 30 days. A dry run (the preview) reads no thread. The first run reads
    every thread.
- **A house the conversation raised is Tier 1, with nothing priced
  (2026-10-16).** An agent answered our first text with "It needs a lot of
  work". The bot rightly asked its one question first, so no underwrite ran,
  no row was made, and the card stayed out of Tier 1. Matt: "Tier 1 should be
  allowed even if there is no draft or offer. As long as they've offered a
  valid address or have indicated it's an actual flip opportunity."
  `raisedHouses` (`shared/ghl-stages.js`) reads their timeline
  (`HOUSE_EVENT_TYPES`):
  - **Raised:** a `house_mentioned` with a full address (a house number, a
    street, and a town or ZIP; not `needsAddress`). Or their words about a
    house read as a candidate (`saysRealWork` in `shared/flip-read.js`):
    their own framing ("needs a lot of work", "a bit of a project", "a
    fixer"), real trouble (flipRead's strong list: foundation, estate, tear
    down…), or a rehab budget of their own of 50K+. A list of rooms ("kitchen
    and baths original") is not their word that it's a flip. Neither is "not
    a fixer", new construction, a remodel already done, or an unfinished
    basement.
  - **Closed:** a later `house_closed`. The reply agent files one when our
    reply or the qualify step passes, they say it's turnkey, they pass, or it
    sold. Also closed by: a later read of their words as turnkey or light, a
    `subject_property_set` marked notOurKind, Tier 1 Pass or Kick (that house,
    or every house before it when the pass named none), or an opt-out.
  - **The rule:**
    - an open house is Tier 1 for `staleTier1Days` (10), like an unsent row;
    - a closed one sends the card to Tier 2 when nothing else is live;
    - a house with an offer row is the row's to say;
    - it never pulls a card down from Offer Out or Contract;
    - newest wins as before: the raise or the close is the event, and a card
      you drag after it stands.
  - **Homeowners:** the plan carries `conversation: true`. As with a
    conversation's Tier 2 card, it's planned only for a known agent, and GHL's
    live tags are checked before the card is made or moved, so a homeowner
    from the seller texts is never an agent's lead.
  - **Who moves it:** the 15-minute tick syncs an agent whose house events
    arrived since its last run. The 7am sweep plans the rest.
  - **Check it:** `GET /api/dashboard/ghl/pipeline?fresh=1`. Look at
    `plan.counts.conversation`, and the rows with `conversation: true`. The
    work pane's pass note names a raised house that keeps the card in Tier 1.
- **Tier 2 is the agent nurture** (Matt): everyone with nothing live,
  former Tier 3s included, replied or not. The app's agent check-in is the
  nurture. A card that still lands in Tier 3 (a workflow, a drag) is moved on
  to Tier 2 or wherever the offers put it.
- **The nurture guard** only stops on an agent nurture — a published workflow
  whose name says both "tier" and "nurture" ("Tier 2+3 nurture"). "Not Now
  Nurture" is a seller drip and doesn't count.
- **Tier 1 Pass / Kick out** set the offer and hand the card to the rule.
- **Report:** `GET /api/dashboard/ghl/pipeline` (Offers page strip): GHL
  counts per stage, offer counts per stage, and what would move. Read-only.
- **Switch:** Settings → "GHL pipeline follows the offers"
  (`ghlStages.mode`, **off**). The old 7am report is the same plan.
- The board finder (`acquisitionsPipeline`) needs only Tier 1 and Tier 2, so
  deleting Tier 3 in GHL breaks nothing.

**Tier 1 → Draft by itself** (Settings → Tier 1 → "Price Tier 1 houses by
themselves", `tierOne.autoUnderwrite`, **off**; `underwriteMax` 10 a day).
Hourly 8am–5pm Pacific (`maybeUnderwriteTierOne`, ghl-broker/tier-one.js,
cursor `tierOneUnderwrite`, written before the run, a run left running over
30 minutes retried, 12 tries a day): a clean Tier 1 card with a house address
(named in their words, or the card's name) and nothing priced or held starts
the conversation's own `startUnderwrite` — so `AUTO_UNDERWRITE_ENABLED`, the
daily underwrite cap and the 24h dedupe all hold. A `tier1_underwrite` event
goes on the contact. The Tier 1 tab's Underwrite button is unchanged.

**The move off the old stages (once).** Settings → "GHL pipeline follows the
offers" → Check / Move (`POST /api/dashboard/ghl/pipeline/migrate {apply}`,
`ghl-broker/acq-migrate.js`, plan `planMigration`). Every card in New Lead,
Contacted, Tier 3, Negotiations, Passed on Offer, Not a Good Deal, Contract
Sent (when Contract Signed is kept) or Lost lands by the facts: live offers
where `targetStage` puts them; no offers but they've written to us → Tier 2;
**every Tier 3 card with nothing live → Tier 2, open, replied or not** (Matt:
"Tier 2 should combine all the previous tier 3's"); any other old stage,
never replied → Tier 2 with the card closed `abandoned` (they stay in
outreach). Closed cards keep their status and go to Tier 2 (won → Contract),
so the old stages empty. Two open cards are listed, not moved. Nothing opens
into Tier 2 while a nurture workflow is published. 300 a press; the summary
is on the `pipelineMigrate` cursor. Order:
1. In GHL, set "Tier 2+3 nurture" and the TIER 2/3 workflows to Draft, and
   check no workflow is triggered by a stage change on the stages going away.
2. Check, read the counts, then Move until nothing is left.
3. Delete the empty stages in GHL by hand.
4. Switch "GHL pipeline follows the offers" on.

### Tier 1 — GHL's stage, screened (2026-10-07)

Matt: "where does the tier 1 come from in our today? It doesn't match up with
the tier 1 in our opportunities pipeline, and that's my source of truth."
In play (below) counted any open offer of any age as Tier 1 — 96 agents
against GHL's 28 cards. Today's second tab is now **Tier 1**: the cards in
GHL's Acquisitions "Tier 1" stage, read live, each with the house it's about,
our numbers and the machine's first look. `?view=inplay` opens it;
`?view=board` is still the lane board.

- **Read:** `GET /api/dashboard/tier1` (`loadTierOne`,
  `ghl-broker/tier-one.js`; five minutes' cache, `?fresh=1` skips it). One
  read of the Acquisitions board; per card, the contact's events and their
  current offer (the full doc for `priceWatch` / hold reasons). Flagged cards
  sort first, then the longest in Tier 1. `belongs` lists agents `agentTier`
  reads as Tier 1, clean on the screen and not stale, with no card at Tier 1
  or later. `tier2` is the roster's Tier 2 rows.
- **The house** (`pickHouse`, `shared/tier-one.js`): their current open
  offer, else a house they named in the last 21 days if it's newer, else a
  held draft, else the card's name when it reads like a street address.
  A named house carries its held draft as its row (`source: "held"`), so
  Pass closes the draft and the card can leave Tier 1. A closed offer counts
  from when it came in, not from its status change, so passing an old house
  doesn't make it outrank the house they named since (Toril S., 2026-10-16).
- **The screen** (`screenTierOne`). Red = sure, amber = their words only,
  grey = soft:

  | flag | when |
  |---|---|
  | Sold or off the market | offer `unavailable`; `priceWatch.offMarketAt` / an unresolved `listing_off_market`; Zillow status pending/sold/contingent — sure. `houseGone` in their last text — amber |
  | Not a flip | the named house carries `notOurKind` — sure. `isTurnkeyReply` on their last text (14 days) — amber |
  | Not single-family | asset type outside `focusKinds`, or a `not our kind of house` hold — sure |
  | Rural (2+ acres) | a `rural` hold, or the offer's `subjectInfo.lotSqft` is 2 acres or more — sure |
  | No house named | no house, or no house number — sure |
  | Already passed | `passedOnHouse` (we passed / no longer available, or a `tier1_passed`/`tier1_kicked` event) — sure; they passed on our offer — amber |
  | Quiet 3+ weeks | nothing from them and nothing priced in 21 days — grey, never a fail |

- **Pass** (`POST /api/dashboard/tier1/:contactId/pass`): the house's open or
  held offer → `we_passed` through the offers router's `applyOperatorStatus`
  (ledger line, tag sync, promise settled, machine texts stopped); a
  `tier1_passed` event with the address — so a house never priced counts too;
  an open `address_pending` closed; the card → **Passed on Offer**, read back
  by id; the `tier-1` tag removed. **tier-2 is never added** — GHL's "Tier
  2+3 nurture" would text them. A deal refuses (409).
- **Kick out** (`…/kick`, `reason`): the same, but `unavailable` when it's
  gone (else `we_passed`), a `tier1_kicked` event, and the card → **Not a
  Good Deal**.
- **Add** (`…/add`): the card → Tier 1 (reopening a passed/lost one; never
  from Offer Out or later), or a new card; a `tier1_added` event. No tag
  write — the 7am tier check adds tier-1 to a Tier 1 card, which can start
  the TIER 1 workflow.
- **Offer →** opens the offer in the split pane. A written offer **you** send
  (`POST /api/offers/:id/send`, live and sent) moves the card to **Offer
  Out**, only from New Lead / Contacted / Tier 1-3, never with two open
  cards, with a `ghl_stage_moved` event. The machine's sends do the same
  only with `settings.tierOne.followMachineSends` (off).
- **Nothing moves** while the GHL mirror is enabled (it owns the board).
  Log lines carry ids and counts only.
- **After a pass, the nurture is the agent check-in.** `housesFrom` counts
  Tier 1 passes as walked away (never raised as a fresh listing for six
  months); `agentPulseSubject` skips passed houses for `lastHouse` and lists
  them in `avoid`, and the prompt says "Never bring up X — we passed on it."
  The ask stays "anything coming up that needs work?", with the off-market
  version at most monthly. `agentTier` drops a named house that was passed
  or that the agent said isn't a flip.
- **The bot doesn't put them back.** A not-a-flip reply that names the house
  no longer runs the new-property rule (no tier-1 tag, no TIER 1 workflow,
  no card move), and an agent re-pitching a house we passed on has the
  tier-1 rule's tag/workflow actions skipped ("we passed on this house"). A
  different house still runs it.
- **Morning clear-out — off** (`settings.tierOne.autoKick`, Settings → Tier 1
  (GHL)). The 7am tier check reuses its board read and plans
  (`autoKickPlan`): sure misses only — gone, not a flip, not single-family, rural,
  already passed, or no house after 7 days in Tier 1 with no open address
  chase — never a card added by hand in the last 7 days. The plan is always
  kept on the `tierCheck` cursor as `last.tierOne` (ids and reasons). With the
  switch on it kicks at most `autoKickMax` (10) a morning, `by: "machine"`.

### In play — every agent with something live (2026-10-02)

> Superseded 2026-10-07 by **Tier 1** (above); `InPlayView.jsx` is gone and
> `?view=inplay` opens Tier 1. `shared/in-play.js` is unused by the console.

Today's second tab (it replaced "Board"; the lane board is its **By house**
toggle, and `?view=board` still opens it). One row per agent from the Offers
list's lean rows (`listOffers` with `activity` and `next`), built by
`buildInPlay` (`shared/in-play.js`): their best house's stage (Deal · Hot ·
Countered · Offer out · Floated · Not sent · Held underwrite · Passed
lately), every current house with ours / theirs, the last touch either way,
the machine's next move (`shared/next-follow-up.js`), and a flag from
`offerLeaks` (`shared/line.js`): **nothing scheduled** or **a follow-up is
late** sort first, **waiting on you** next. Only each house's current offer
counts; a house passed more than 30 days ago isn't in play. Clicking a row
opens the agent's lead offer in the Offers split's pane (`OfferPane`), the
list shrunk to a rail (J/K, Esc). Loads on open and on Refresh — no poll.

This is the daily walk through GHL's Tier 1 stage and the Offers tab, done
from the app's own record.

### "It's signed" → Promote, one tap (2026-10-02)

An agent's "we're mutual!" used to change nothing: the offer stayed "sent"
until someone promoted it in the offers console. `signedContractIn`
(`shared/contract-signed.js`) reads their words — mutual, fully executed,
seller signed, DocuSign complete, counter-signed, under contract — sentence by
sentence, and not the future, the negative or a question ("once it's signed",
"hasn't signed yet", "is it mutual?"), nor someone else's contract, a
counter, or the listing's own paperwork ("signed another offer", "under
contract with someone else", "signed the counter", "the disclosures"). On a
call only the THEM lines count. The reply agent adds the existing ask-only
`promote_to_deal` hand-off (Today: Decide, "Do it") only when the agent has an
open offer, the intent isn't a counter or a rejection, the text isn't a "gone"
text (`houseGone`), and either they said it about ours ("your offer", "our
contract") or our offer is already hot (`pushesToPaper`): a bare "we're under
contract" on an offer that was only sent is often the other buyer.
`ASK_ONLY_ACTIONS` is unchanged, so a person still promotes. A real, future
closing date in the same message ("closing 10/24") rides on the action. The
deal's price is what `promoteToDeal` always read — the PSA's, else the
offer's — never an "agreed" on record, which can sit above the book.

### Before you sign: the pre-contract check (2026-10-15)

The funnel review: 7 of 8 listed-house contracts fell through, against 1 of 5
off-market. The dead ones had rehab low or ARV high, two were mobile homes
signed and backed out of, one was signed with no buyer. `preContractChecks`
(`shared/pre-contract.js`) reads eight things off the offer, each `ok`,
`warn` (the record says something's wrong) or `unknown` (nobody looked):

- **Listing remarks read**: `snapshot.rehab.listing.remarks` through
  `remarkSignals` (a defect, low ceilings, rooms, contents left behind).
- **Kind of house and title**: a mobile home (`assetOf`), or a land lease,
  55+, HOA, easement, right-of-way or unpermitted work in the remarks or the
  buyer-view flags.
- **Eyes on the house**: 8+ listing photos scanned, or a video on the offer.
- **Rehab at or above the light floor**: repairs vs `rehabBand(sqft).light[0]`.
- **ARV under today's listings**: the buyer-view listings cap
  (`snapshot.checks.cap` / `arv.capped`).
- **At or under our number and the buyer ceiling**: the agreed (or contract)
  price vs `cashAmount` and `buyerCeiling().withFee`.
- **An extension, not their deadline**: ticked by hand only.
- **Pre-sold to 3 buyers** (listed houses; none for off-market).

Where it shows, all advisory (nothing blocks, no switch):

- **Today**: a `pre_contract` row (Needs you) on an offer about to be signed
  (`needsPreContract`: `pushesToPaper`, or the agent is writing it up; no
  deal yet) while anything is open. Only within 14 days of the yes, the
  write-up or your Hot flag (`PRE_CONTRACT_FRESH_DAYS`): the first live read
  had six rows for agreements weeks old. "now" when they're writing it up. The pane
  lists the items with a **Checked** button each (`POST
  /api/offers/:id/precontract { key, done, note }`, kept at
  `offer.preContract.ticks`; `GET` reads them). Buttons: **Pre-sell to 3
  buyers** (listed houses), **Open the offer**, **It's signed — promote**.
- **Promote**: open items are added to the promote's warnings ("before
  signing, not checked: …") and the whole list is kept at
  `deal.preContractAtPromote { at, open, checks }` for the post-mortem.
- **Pre-sell** (`POST /api/dispo/presell { offerId, count = 3, dryRun }`):
  the top `count` from `matchForDeal` (everyone who buys where it is, best fit first), never
  one it already went to, as **drafts only** — never scheduled, `needsHuman`,
  reason `needs a person: a pre-sell waits for your Send…`, so no audit or
  sweep releases them. `presellMessage` (shared/blast-text.js) never says
  "under contract" and carries no link; the price is our number plus the
  default fee. Saves `offer.presell { at, contactIds }`. At promote, buyers
  whose pre-sell text was sent join the deal as `evaluating`
  (`source: "presell"`); an unsent pre-sell draft is superseded so the first send can
  give them the deal itself. A buyer who answers a pre-sell text before the
  promote is answered by the investor bot, which has no deal to read yet —
  work those by hand.

Check: `GET /api/dashboard/pipeline` → `actions[]` with `kind: "pre_contract"`
and its `checks`; a promoted deal's `deal.preContractAtPromote`.

### Tier 1 / Tier 2 — kept by the app, not GHL (2026-10-02)

> 2026-10-07: GHL's Tier 1 stage is the list again (Matt: "that's my source
> of truth"), screened by the app — see **Tier 1 — GHL's stage, screened**.
> `agentTier` still feeds the `belongs` list and Tier 2.

Matt: track the tiers in the app rather than in GHL's pipeline stages, for
agents and for buyers. GHL's tiers were tags and card stages the bot and the
workflows wrote, and they drifted; these are derived on every read
(`shared/tiers.js`), never stored, so there is nothing to drift.

| | Tier 1 | Tier 2 | the rest |
|---|---|---|---|
| **Agents** (`agentTier`) | a property in hand that could be a flip: a live deal, an offer out (sent, countered, hot, priced not sent), an underwrite held in the last 21 days, or a house they named (`subject_property_set`) / an open `address_pending` in the last 21 days that we haven't priced | wrote back to us (their last word, or an offer only their answer moved: a counter, a yes, a pass, a deal), nothing in hand | **Cold**: never wrote back. **Opted out** |
| **Buyers** (`buyerTier`) | on a live deal now (`onLiveDeal`: evaluating, soft-committed, committed) | talking to us or replied (`relationshipOf`) | not talking yet (no reply / never messaged). Opted out |

- **Agents — Today → In play.** The Tier 1 chip is the offer table plus
  "Sent us a house · not priced yet"; the Tier 2 chip lists every agent who
  wrote back with nothing in hand, when they last wrote, and **what keeps them
  warm** — the clock that owns them, the next check-in, a stop, or (in amber)
  "the agent check-in is off — nothing keeps them warm". Read from
  `GET /api/dashboard/agents/tiers` (`agentRoster` in
  `ghl-broker/agent-pulse.js`, which reads the agent check-in's own load and
  verdicts, `evaluateAgent`; cached five minutes, `?fresh=1`). The roster also
  counts agents we made an offer to who have no contact profile; the check-in's
  own audience is unchanged.
- **Buyers — Dispositions.** The tabs are **Tier 1 · on a deal**, **Tier 2 ·
  talking**, **Not talking yet**, Everyone, Opted out. It opens on Tier 1 when
  somebody is on a deal, else Tier 2. The old `?who=talking|replied|no_reply|never`
  links still filter by relationship. (The VIP / Active / Cold dropdown is a
  different thing: how actively a buyer buys.)
- GHL's TIER 1/2/3 tags and workflows keep running as the playbook sets them;
  nothing here writes them. GHL's board is optional (next section).

### Only what needs you — the machine's rows, and hold then pass (2026-10-04)

Matt, 2026-10-04: "today should only be for urgent things only a human should
do and i expect the app to do everything else". The live Desk had 15 Call and
25 Decide rows; about 35 needed nothing from him. What changed:

- **The machine's rows** (`machineDrives` in `shared/desk.js` → `callList({ machine })`).
  - While the hot push ladder is on, a hot offer is a Machine row
    (`hot_machine`: "waiting on their write-up" / "the next push to paper").
    It is a call only when they hand the write-up to someone else
    (`handsWriteUpBack`, with the number they gave). A warm offer (nothing
    agreed) sits with the machine only while the offer nudge is on. A yes
    you re-priced below by hand is not a "settle the number" call, but
    `priceAgreed` keeps it, so no paper goes out at the lower number. It is a Decide row,
    `paper_to_sign`, when they say the paper is on its way to sign.
  - While `counterHold` is on, a counter we held our number on is a Machine
    row (`counter_held`) with its next check-in or the day it passes. A
    counter with no hold yet stays a call.
  - While `offer_nudge` repeats, there is no `call_quiet`.
  - Each switch off puts its rows back the way they were.
- **Hold, then pass** (`parties.agent.counterHold { enabled, checkIns: 2 }`,
  off; Full on the dial).
  - The reply: a counter above our number, or an ask for us to come up with
    no number, gets our number back once (by text only, never off a call, and
    only with the follow-up clock on). The reply agent writes it from
    `holdNumber`'s amount: the lowest we've put to them, never more, and no
    dollar sign. It sends itself only when the counter's NEVER_AUTO lock is
    the one thing holding it. `offer.counterHold = { at, ours, theirs, nudges,
    replies }`.
  - The clock: `ghl-broker/counter-hold.js` runs at the end of the morning
    follow-up sweep. It sends a `counter_nudge` (held wording) at the
    follow-up spacing. After `checkIns` nudges or unmoved replies with
    nothing new from them, it sets `we_passed` (`passHeldCounter` → the
    status menu's own path, which stops the queued texts).
  - Exceptions: a lower number from them starts a new hold. An agreed, hot
    or deal offer is never passed.
  - A counter with no number that asks nothing of us is reclassified
    `status_check`, gated by the same switch. Matt authorised this narrowing
    of NEVER_AUTO.
  - Preview: `GET …/follow-ups?preview=1` → `counterHolds.rows`, even with
    the switch off.
  - **A counter close to ours is a call, not the hold (2026-10-15).** The
    funnel review: counters within 5% of our number agreed 13 times in 25;
    past 25%, none of 95. A counter within
    `parties.agent.counterHold.callWithinPct` (default **10**, 0–30, 0 = off)
    of our number gets no hold text and is never passed by text (the soft
    round, the pass line and the firm-floor pass all stand aside). It stays a
    person's `counter` draft carrying `callCounter { offerId, ours, theirs,
    pct }`, the offer is marked countered as before, and the Desk's
    `call_counter` row says "N% apart, a call lands it". A close counter that
    comes in after an earlier hold takes the house off the hold's clock (no
    check-in, no pass) and back onto the call list (`callsInstead`,
    shared/counter-hold.js). The counter band and `never_above_sent` are
    unchanged. Check: the counter's draft in the outbox shows "N% over our
    $X — call them"; the Desk shows the `call_counter` row.
- **Your texts in GHL count** (`ghl-broker/hand-reply-sweep.js`, every tick).
  - It reads the moved conversations and picks out the outbound texts with a
    GHL `userId` (a person). The app's own sends come as source `app` with no
    userId.
  - Each one gets a `hand_reply {via: "ghl"}` and sets aside the open drafts
    written before it. It sends nothing.
  - The audit's `stillOwed` and the call list read `hand_reply` and connected
    calls as answers.
  - One-time look back: `POST /api/dashboard/hand-replies/sweep { days, dryRun }`.
- **Your "no" is a pass** (`passOnOurNo`, routes/offers.js).
  - A text a person sent ("can't get there", "too far apart", "we'll pass" —
    `weDecline`) on a contact whose current offer is countered above ours
    sets `we_passed`.
  - It covers texts typed in GHL, the composer, and a draft you edited and
    sent, as long as all of these hold:
    - SMS only;
    - the counter is no more than 21 days old;
    - nothing is agreed and the offer isn't hot;
    - the text names that house, or it is the only live counter.
  - A hold, a showing time or a hand-off doesn't count.
  - Look back: `POST /api/offers/passes/our-no { dryRun }`.
- **A check-in never goes over a reply we owe.** When the "unanswered" clock
  fires and the held reply never went out, their text goes back through
  `startReply(fromCheckIn: true)` instead. A second hold books no new clock.
  The offer book says "price is done" only on an agreed number.
- **Heat** comes only from real warmth. Never on a counter, a price push,
  "come up", or second thoughts, and those cool heat the conversation set.
  Our own letter echoed back (`isOurEcho`) is no draft and no heat.
- **The hot push after its ladder**: with `hot_push.repeatEvery` (live: 0 →
  set 7 to turn it on) it sends a weekly "any word from the seller?". Second
  thoughts switch to that cadence at once. `hot_stalled` is then a Machine
  row.
- **The machine's own leftovers.**
  - A machine-started text that fails a gate is drafted once more with
    `outbound.fix`, else dropped with a timeline note. It never waits on you.
    The exceptions (`KEEP_FOR_A_PERSON`) still wait: floats, a promised
    number, a price drop, the first text.
  - Held underwrites:
    - Not single-family: passed after 24h, unless you pressed Underwrite anyway.
    - Rural (2 acres or more): passed at the next check, with no 24h wait.
    - A town we've never priced in and that isn't on the map
      (`knownCitiesFrom`; the city comes from `parseUsAddress`): passed,
      but only after anything their numbers could clear has been asked.
    - Each gets one `kind_pass` text, which says why: not single-family, rural or out of area.
    - An address the map couldn't place: finished from what we hold first
      (their RentCast listings, our outreach text, the book), and re-run on
      that; only a street we can't place gets one ask to confirm it.
    - `heldOnTheMachine` shows the plain ones as Machine rows tonight.
  - A held reply the 7pm check will send (`releasableHeld`) is a Machine row
    with its time. Only a reply to their text: a text the machine started
    (a blast, an emailed deal, a pulse) is never sent by the check, so one
    held by a Settings switch is a Decide row with that reason (2026-10-05,
    14 emails on 9311 12th Pl SE).
  - A held underwrite's ask is made once (2026-10-05). After it: they wrote
    back without the number → `held_call`, a Call row with why; silence, or
    an ask that was held and never went → `held_waiting`, a Machine row with
    `passAt` (a week from the ask), then retired as we_passed with a
    `kind_pass` text (why `numbers`). Never "claimed" night after night.
  - A hot offer the machine is nudging shows the nudge's real time, or why it
    stood down ("you have the thread"), from `nextFollowUp`.
  - Hand-made `offer_ready` rows last 7 days.
  - "Fully executed" on a live deal ticks `psa_signed`.
- **Calls that reach voicemail** (`voicemailGreeting`, outbound calls only)
  are a `call_attempt`, never a draft.
- **Nightly audit**: wider closers. "You have the thread" is retried the
  next night. Three empty tries on a text that asks nothing, with no digits,
  are settled (`reply_not_needed`).

### GHL's Acquisitions board following the app — optional, off (2026-10-02)

The app's own tiers are the record (Today → In play); GHL's board is a
digest nobody has to tend. For anyone who still wants GHL's cards to match,
the daily tier check (7am PT) also plans the moves `planStageMoves`
(`shared/ghl-stages.js`) would make — Offer Out when our number went out,
Negotiations on a counter or a hot offer, Passed on Offer / Not a Good Deal
when every house is over, and a Tier 1 card with nothing open for
`staleTier1Days` (10) → Tier 2 — and keeps the plan on the `tierCheck`
cursor as `last.stageMoves` (ids and stage names only). Read it at
`GET /api/dashboard/ghl/stage-report`. Nothing moves unless
`settings.ghlStages.mode` is `"on"` (default `"off"`); then at most
`maxMovesPerRun` (100) a morning, each a `ghl_stage_moved` event. Never a
contract stage, a lost card, a live deal's card, or an agent with two open
cards; and never into Tier 2/3 while a published nurture workflow would text
them on the move (`allowNurtureTrigger` overrides; an unreadable workflow
list counts as published).

Separately of this plan (2026-10-07): a written offer you send moves the
card to Offer Out, and Tier 1's Pass / Kick out / Add move cards on your
press — see **Tier 1 — GHL's stage, screened**.

### Today's three groups, and the brake (2026-09-17)

> Since 2026-10-02 the Desk (above) shows these rows folded by person in
> Call · Decide · Machine; the pipeline still tags every row with the group
> below, the Desk's sections are read from it (`sectionFor`), and the brake is
> unchanged — except that a connected phone call now stops it for 48 hours.

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

**When they hand the write-up back, or we're talking past each other (2026-10-03).**
"Write up whatever you like!" means the agent thinks we'll write our own
offer. `AGENT_PAPER_RULE` now says to clear that up first: we're not agents,
so ask them, or the person they named, to write it up on NWMLS forms. A reply
that doesn't is held (`handsWriteUpBack` / `clearsWriteUp`, reply gate).
`CLARIFY_RULE` (agents and buyers): when they've misread us, clear it up in
one line before the next step. A yes to a higher number than the book's
(`agreedAboveOurNumber`: a realm yes at 289,750, then a hand drop to 226K) is
no longer an agreement at the book's number. The push to paper doesn't run,
the call list already flags it, and the bot's offer book says plainly that
they haven't agreed to ours.

**A deal that fell through (2026-10-03).** Every text the machine starts goes
through `startProactive` (ghl-broker/reply-agent.js). If its house is a deal
marked fell through, it is not drafted, whoever it is to (the listing agent,
their TC, a buyer) and whatever kind it is: a check-in, a nudge, a promise,
a pulse. A text already counting down is dismissed at the send instead
(`sendReplyDraft`, auto path). The house is matched loosely
(`fellThroughOn` → `sameStreetLoose`), so the thread's "5232 S Yakima" is the
deal's "5232 South Yakima Avenue". A re-contract on the same house is a live
deal, and texts about the house go again. A person pressing Send or Float is
not stopped. Agent pulse no longer picks a fell-through house as the one it
mentions. Replies to something the person texted still go.

**Stop / Resume.** `POST /api/dashboard/drive/stop` and `/drive/resume` write
`drive_stopped` / `drive_resumed`. A stop from Today is the whole thread with
that agent, until Resume; a stopped promise row moves back to Your call. Since
2026-10-01 a stop holds every sender, not only the drivers — see "Stop,
pause and pace — one person".

### Stop, pause and pace — one person (2026-10-01)

Matt: Stop on a thread means nothing goes to that person by itself. Until
this date the stop was read by the promise driver, the hot push and a few
daytime moves; the reply agent drafted and auto-sent, scheduled texts went,
the nightly audit released held replies, the first offer-nudge ladder, passed
check-ins and price drops ran, and a clean underwrite could send the letter.
The toast said "It is yours until you press Resume" all the same.

**What a stop means now.** While it holds, nothing reaches them unless a
person presses Send (or a suggestion's button):

- Their texts still get a draft. It waits on Today with "you stopped the bot
  on them — it waits for you" (`decideAutoSend` code `bot_stopped`, checked
  first). It is not a person's call on the words, so it starts no check-in
  clock, keeps no older reply scheduled, and neither the audit nor the
  counter band can release it.
- Nothing the machine starts is drafted (`startProactive`, before any model
  call; jobs already on the lane stand down in `runProactive`). A Float a
  person presses still drafts, and waits.
- On a draft, the actions that reach them become suggestions: the letter,
  a dataroom invite, a GHL drip, a booking, a re-quote, a counter, an agreed
  investor price (`HELD_WHILE_STOPPED`). Tags and statuses still run. A reply
  rewritten to say "sent our letter over" goes back to the model's words.
- The send-time backstop (`sendReplyDraft`, auto path): a machine text that
  was counting down is binned ("… — not sent"); a reply goes back to wait.
  The draft is written before the skip returns, so the scheduler never
  leaves it "sending".
- The letter never sends itself (`sendOfferDocs({ unattended })` on a clean
  underwrite and the retry tick); the offer stays "priced, not floated" so it
  floats after Resume. A blast to a stopped buyer is queued as a draft.
- The nightly audit leaves them alone: a held reply is not released, no
  clock is booked, and nudge / re-quote / letter actions are dropped from
  the row (`STOPPED_REFUSES`). A redraft still runs — its draft waits.

**Before a claim, not after.** The scheduled jobs claim before they draft
(a rung, a check-in, an ask, a pulse seat), so a stop read only at the door
would spend the claim and lose the text. Each asks first and claims nothing
while you hold the thread; it goes after Resume. `waitingReason`
(outbox-guard.js) asks the hold by default — the promise driver, held
underwrites, the audit's nudges, the price watch (kept as `dropOwed`), the
check-in sweep and the address chase all use it. The follow-up sweep, the
outreach follow-up and both pulses read everyone's stops once per run; the
timers hold the float and "gone quiet → no response"; the showing sweep asks
per buyer. A paused offer is never marked "no response" while the pause
holds. The promise sweep is the one that still claims: `promise_owed` is
what puts "we owe them a number" on Today; the text after it is refused.

**Pressing Stop** (`POST /api/dashboard/drive/stop { contactId, party?,
preset?: "1w" | "2w" | "1m", until?, reason? }`) also stands down what is
already waiting (`standDownForHold`): open machine texts are binned, a
scheduled reply goes back to draft, a row already sending is left alone.
A pause is a stop with an end date, at most five weeks out; it ends by
itself, with no event. `party` is written only when given (it used to be
forced to "agent", which would have turned a buyer into an agent). Resume
re-sends nothing: what was held waits for Send.

**One reading.** `shared/bot-hold.js` `botHold` is the only reader of the
toggle (thread health, the column, the agent pulse and Today's promise rows
all ask it). `ghl-broker/bot-hold.js` reads the events with no time window,
so a stop pressed months ago still holds; a read that fails holds rather
than sends. Skip lines and flags carry `holdLine` ("you stopped the bot on
them", "paused until Oct 15"), never the reason a person typed.

**Check in less / normal / more** (`POST /api/dashboard/drive/pace
{ contactId, pace }`, a `cadence_set` event, newest wins). Per person. It
scales the time between our own unprompted texts: the offer nudge, the
passed check-in, the hot push, the outreach / blast / dataroom nudges and
both pulses. "Less" doubles the time to each rung (the agent pulse's three
weeks become six); "more" halves it. The rungs keep their numbers — a rung's
day is its dedupe key — so changing pace mid-ladder never re-sends one.
"More" never shrinks a floor (the 40 hours between texts, the hot push's 20,
the pulses' quiet days); "less" stretches those too. Untouched: their own
asks, promises, price drops, timers, showing texts, every count cap, the
two-unanswered brake. Pace never switches on a ladder that is off. The
Offers column and the follow-up preview show the paced dates.

**What it can't stop.** GHL workflows that fire on tags the app sets can
still text a stopped person; only GHL's DND or the stop-bot tag stops those.
The app never writes the stop-bot tag for a Stop: that tag stops drafting
too, and a stop keeps the drafts.

### Rows that were never a decision (2026-09-18)

Read off Today the day before a week away; three kinds of row the machine made
for itself:

- **A check-in that re-quoted an old price.** The `passed_checkin` prompt said
  "you may mention the number we offered (it's in the offer book)". A passed
  offer's number is not in the book, so the gate held every one, five in a
  day. The prompt now names no number at all ("where we were"): an August
  price said again in September recommits us to it.
  **2026-10-08:** it no longer asks about the house at all. An agent got
  seven texts in a month asking whether 163rd had closed, but his seller had
  taken another offer in August. Matt: "we don't know what happened to
  specific properties and often they get sold. When we check in, just ask
  about any other distressed properties, off market or not, in a personable,
  professional, even slightly funny way."
  - **The ask.** The prompt says the old house is NOT the subject. It asks
    whether other houses that need work, on the market or off, have come
    across their desk. `CHECKIN_PERSONALITY` covers the passed check-in and
    `agent_pulse`.
  - **The gate.** `namesHouse` checks for the house number (3+ digits) or
    the street word. A draft that names it fails the gate, is redrafted once
    with the reason, and is dropped with a timeline note if it still names
    it. A relisted house is exempt, because there the house is the news.
  - **The aside.** A passed house's line on a live offer's nudge now says
    "if anything else that needs work crosses your desk, on or off market,
    we'd love a look" and names no house.
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

> The pane is the same on the Desk (2026-10-02), with two additions: a Call
> row's **call card** under the heading (goal, ours vs theirs, the opener,
> Call in GHL, the no-answer chips, and on a counter Hold / Meet / Walk away),
> and **Also on …** — the person's other reasons, each with its own buttons.

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
- **The header**: what the row is, the person and the house, why it's here
  (`detail`, "Stuck because", "Next:"), and its own buttons. These are the same
  ops, confirms and toasts as before, now in `RowOps.jsx`. Since 2026-10-01
  (`PaneParts.jsx`, shared with the Offers split):
  - The person's **name opens their record** (the contact drawer). The Record
    button is gone — Matt didn't know what it was.
  - Under the name, **the strip** (`MomentStrip.jsx`): the house's last six
    moments, oldest first — priced, sent, nudges that went, their texts,
    counters, re-quotes, agreed, hot, calls, stop / pause / pace — each with a
    dot for who (them slate, us blue, the machine violet), then the next move
    ("next: nudge Thu", violet when it goes by itself, amber when it waits on
    you) and **History**. `GET /api/contacts/:id/timeline` (Contact record).
  - **Bot ▾** (`BotMenu.jsx`): its label is the state — Bot on (· less / more
    often), Bot stopped, Paused until Oct 15, and read-only Bot off in GHL
    (the stop-bot tag), Unsubscribed. Stop the bot on them, Pause 1 week /
    2 weeks / 1 month, Resume; Check in less / Normal pace / Check in more.
    See "Stop, pause and pace — one person". A stopped person's draft says
    "The bot is stopped on them — this waits for your Send."
  - **⋯**: Feedback for the bot (T), their record, Open in GHL.
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
    (`DraftComposer`). Edits, Dismiss and Hold work as they do everywhere, so
    the coach still sees them.
  - A question the bot couldn't answer gets the answer box instead.
  - Otherwise it is a plain box (the hand reply, below).
  - **Feedback** (`PaneFeedback`, tucked): nothing shows until T or ⋯ opens
    it; a verdict saved before reads "noted · …" on one quiet line. Matt never
    used it (2026-10-01); the coach still learns from edits and dismissals.
- **Coach ideas**: a "Coach · N ideas" header button (`CoachIdeas.jsx`) when
  the nightly coach has open or applied proposals from this person's drafts
  or feedback. Apply and Reject work as on the Learned card; nothing applies
  itself.

**Keys:**

| Key | Does |
|---|---|
| J / ↓ | next row |
| K / ↑ | previous row |
| R | the reply box |
| T | feedback for the bot (opens the tucked control) |
| O | open the offer in the editor |
| D | dismiss the row |
| ⌘↵ | send (in the reply box) or save (in the feedback note) |
| ? | show the list |

Keys are ignored while typing, in a menu, or while the contact record is open.
The open row is kept in `?row=<id>`. When the row you're on is resolved, the
pane moves to the one after it ("Done — next: …"). The next row's offer,
thread, lessons and timeline are read ahead (`work-data.js`).

**Below laptop width:**

- The rail becomes a picker in the header.
- Offer and Conversation become two tabs.
- The KPI tiles are now a one-line strip; the group counts are on the rail.

**The same pane on Offers (2026-10-01).** Matt: getting context on an offer
took two or three pages — the offer window had no conversation, and its agent
name went out to GHL. Now a click on an offer row (not a draft — drafts still
open the editor) opens **the split** (`OffersHistory.jsx`, `OfferRail.jsx`,
`OfferPane.jsx`, `offers-split.js`):

- The table shrinks to a **rail** of the rows it was showing, in its order:
  street, agent, our number, status, next follow-up. The rail is frozen when
  it opens (recording an outcome doesn't renumber it) and re-frozen when the
  filter, search or sort changes. Chips and search stay; the KPI tiles, the
  underwrite strip, the bulk bar and the table step aside.
- The **pane** is Today's (`PaneParts.jsx`): the person and the house with
  the strip, Status · Bot · Edit offer · Call · Coach · ⋯, the offer on the
  left, the conversation and a reply box on the right (their open draft comes
  from `GET /automations/conversation?contact_id=`). Its own buttons: n of N,
  ‹ ›, ✕ back to the table, **Details** (the full offer window: documents,
  PSA, contract, assignment, net sheet) and **Send**.
- Keys: J/K walk the rail, R the reply box, T feedback, O the editor, Esc back
  to the table. Nothing fires while a window or menu is open over the page.
- The open offer is kept in `?offer=<id>` (not `?offer_id=`, the editor's
  deep link). Opened from a link, an offer outside the current filter switches
  the chips to All once. Back in the table, the agent's group is open and the
  row is scrolled into view.
- A status, a send or a Bot press re-reads that person's rows (with their next
  follow-up) rather than the whole book; a deal opens in the Deals view.

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

### Dismiss on any Today row (2026-09-28)

Matt, on the 1415 2nd St closing row: some panes had nowhere to dismiss. Every
row's header now has **Dismiss** (key **D**), except drafts (the composer's
Dismiss bins the draft) and owed promises (their Dismiss asks why, for the coach).

- The row leaves the queue at once and the pane moves to the next row. The toast says
  "Dismissed — next: …" and has **Undo** for six seconds.
- The broker remembers it on the `todayDismissed` job cursor, keyed by row id with a
  fingerprint of kind, severity, title and detail, digits dropped
  (`shared/today-dismiss.js`). A row stays off Today until it says something new:
  "closes in 2d" becoming "in 1d" stays hidden, but "was due to close" or a new stage
  brings it back. Entries are forgotten after 30 days.
- Routes: `POST /api/dashboard/rows/dismiss { rowId, kind, severity, title, detail }`
  and `POST /api/dashboard/rows/restore { rowId }`. `/pipeline` drops dismissed rows,
  lowers the counts, and returns `dismissedCount`.
- Dismiss changes nothing about the deal, the offer or the thread. It only hides the row.

### Durable errors (2026-09-17)

Failures in the reply agent, proactive drafts, the underwriter, the 15-minute sweep and the coach used to live in Render's log or on an in-memory job a redeploy forgets. `recordError` (`ghl-broker/app-errors.js`) keeps them in `app_errors`, one row per distinct failure (fingerprint of area + message with ids and numbers flattened), counted. The message has phones and emails knocked out and the context is ids only. It never throws. The coach reads the night's rows; a repeated one becomes a `code_gap`.

### No longer available — a house that sold isn't anyone's pass (2026-10-02)

**Why.** "We passed" means we chose to walk away. "They passed" means the
seller said no, and it gets a check-in every ten days, because a house still
for sale can come back. A house the agent says sold or went pending is
neither. It was filed as one or the other. 4621 S Sheridan Ave ("That one is
already sold", 9/15) was read as a first no: the bot asked what the seller
would take, and the offer stayed open until the 9/29 cleanup. 2617 Cottage
Rd E's "already pending" was filed as their pass and got a check-in claimed
on 9/27. Matt: "we passed is like we intentionally said no".

**The status.** `unavailable`, shown as "No longer available"
(shared/offer-status.js). It counts as dead and is never open, revivable or
chased. It ranks lowest and carries no GHL tag, so a sold house never puts
the agent in a "they passed" workflow. The funnel counts it on its own
(`unavailable`, in "dead of sent"). The Offers column reads "No longer
available — no follow-up". The bulk bar and the status menu can set it. The
agent check-in may name it as how a house ended ("it sold").

**Who sets it.**
- The nightly held-underwrite sweep, on `GONE_TEXT` (above).
- The reply agent, when the agent says the house is gone (`houseGone` in
  shared/held-underwrites.js). On a no it reads the loose words (pending,
  sold, under contract, off the market, no longer available, accepted another
  offer, withdrawn). Otherwise it needs the strict `OVER_PLAIN` wording that
  names the house. "Sold as is" and "a few went pending nearby" don't count.
  Calls never set it.
- When it fires, it injects `mark_offer_unavailable` and drops what a no
  wires (they passed, Tier 3). It never makes the first-no ask.
  `setOfferStatus` accepts `unavailable` from a reply because it's a fact the
  agent told us, not a decision. It lands on the live offer, or on a house
  they passed on whose check-in they're answering, never on a house we passed
  on. It stops whatever the machine had queued about the house. `we_passed`
  still can't be set by a reply.
- A person, from the status menu or the bulk bar. That also stops queued
  machine texts.

**Not changed.** The price watch's own "went pending/sold" read still writes
`listing_off_market` and stops check-ins; it doesn't set the status.

### The first text is an icebreaker — qualify before underwriting (2026-10-08)

Switch: `conversationAi.parties.agent.qualifyFirst.enabled` (default **off**).
Rules: `shared/flip-read.js`. Gate: `qualifyIcebreaker` in `ghl-broker/reply-agent.js`.

The house our first text opened with (the newest `outreach_sent`, the
workflow cohort's `outreach_enrolled`, or — since 2026-10-14 — a check-in
about a fresh listing of theirs, `agent_pulse_texted` with its `listingKey`)
is a way to start talking, not a lead. Matched by number and street, so a
check-in event that held the street alone still counts.
With the switch on, a reply about that house, before we have any offer on it, goes:

1. **Their words name real trouble → underwrite now**, as before. That covers
   foundation/structural, water/mold, fire, a hoarder, estate/probate,
   foreclosure, unlivable/gut, unfinished, or can't-finance. Two big-ticket
   items (roof, kitchen, baths, heating, electrical, plumbing,
   windows/siding) count too, as does one big item plus a reason to sell, or a
   rehab budget of their own of 50k or more. Negated or already-done items don't count.
2. **Anything vaguer → one text**, our question: big-ticket work or a refresh,
   and what's the seller's situation. There's no underwrite, no Tier 1 tag or
   workflow, and the subject event carries `qualifying: "ask"` so the app's
   Tier 1 leaves it out.
3. **Their answer to that still doesn't qualify → a polite pass** that asks
   for anything distressed on or off market (intent `investor_open`, Tier 2).
   Once we've passed, a later reply that still doesn't qualify gets a one-line
   close.

Their words are every line they've sent since the first text. A showing offer
("come take a look") on the icebreaker house gets the question, not "number
first". A house the agent brings up themselves underwrites right away, and so
does any house we already priced. The draft row carries `qualify: {stage, address, why}`.

**Houses the agent brings, screened too (2026-10-16).** Switch: `parties.agent.qualifyFirst.brought`, off by default.

Of 132 houses agents raised, 47 were real flips, but 51 the agent had already called cosmetic or turnkey. `qualifyBrought` (reply-agent.js) applies `broughtStep` (shared/flip-read.js) to a house that isn't the first-text one and that we have no offer or draft on:
- **Real trouble or their own work budget of 50k or more** → it runs (or is drafted in draft-only mode).
- **Off-market with the seller's number** → it runs, even if cosmetic (7034 S K St was an off-market cosmetic fixer at $250K and became a contract).
- **Cosmetic or turnkey in their words** (`saysCosmeticOnly`: light words and no big-ticket item named) → the pass, plus the ask for others.
- **Unclear** → our one question. Still unclear after it → it runs anyway: their own house is worth Matt's look.

Backtest on the 132 graded houses: no real flip or live house was passed. Most got the question first.

### Their first answer asks for a call (2026-10-15)

**Why.** The funnel review (485 threads): all 8 contracts from outreach
agents came after a phone call; agents who talked brought us houses 54% of
the time against 8%; only 15% of repliers ever talked.

**What it does** (`parties.agent.callAsk { enabled }`, **off** by default). An
agent's first answer to our first text (no text or call of ours since the
`outreach_sent`/`outreach_enrolled`), turnkey answers included, closes with
ONE question that asks for both other fixers and a quick call: "If you've got
other fixers on your radar, I'd love a quick 5-minute call this week, what
time works?" (`FIXERS_CALL_ASKS`, shared/flip-read.js). No day or time is
offered: no calendar is connected, so they pick. The model is told to (a
FIRST ANSWER line in the context); `withCallAsk` is the backstop when it
didn't, taking over a closing "anything else that needs work?" so the text
still asks one thing. The canned qualify question and pass have call
variants (`QUALIFY_ASKS_CALL`, `QUALIFY_PASSES_CALL`). Never on a call, never
when they brought a house of their own (that house is the lead), never on a
counter, yes, no, opt-out, or a reply asking for a call or a time, never to
someone who sounds annoyed, and only once: the send records `call_asked`
(and `fixers_asked` when the text asks for other houses).

**With the switch off,** the first answer still closes on the other-fixers
ask alone (`FIXERS_ASKS`, `withFixersAsk`), because the first text no longer
carries that line. Same rules: first answer only, not when they brought a
house of their own, not on a counter, yes, no or opt-out.

**A turnkey reply is a small call (`call_turnkey_week`).** The call list
dropped turnkey first replies on 2026-10-08. They're back for 7 days at score
50 (below a lead's 70): "what else are you working on?". Today's calls shows
them only when the day has room.

**Check:** with the switch on, a first answer's draft ends with the call ask;
the contact's timeline has `call_asked` once it's sent; when they answer with
a time it's a `scheduling` heads-up for you.

### Every house an agent names is kept, and a missing address is asked for (2026-10-13)

Rules: `shared/mentioned-houses.js`. Wiring: `runReply` in `ghl-broker/reply-agent.js`.
No switch. It sends only through the reply's existing auto-send rules.

An agent we'd passed on (the first-text house) wrote back with two more of
theirs: one on a street in town and a triplex, each with
an asking price. Neither had a house number. The
empty `propertyAddress` was read as the first-text house, the qualify step
had already passed on it, and the canned "keep me in mind" line went out.
Neither house was kept, and nothing asked where they were.

Now, on an agent text that reads as a lead (`HOUSE_LEAD_INTENTS`: deal_available,
new_property, investor_open, media, wants_call, scheduling):

- The draft lists every house they named in `houses` (`{address, sellerAsk, note}`).
  Streets the model missed are caught from their words (`streetMentions`).
  The first-text house and office addresses in a signature are left out.
- Each house becomes a `house_mentioned` event (`data.sellerAsk`, `data.note`,
  `data.needsAddress`), shown on the timeline as "they named a house".
- If they named any house that isn't the first-text one, the qualify step
  leaves the message alone.
- A house with no number:
  - **No underwrite.** That holds even when the model put the bare street in
    `propertyAddress`.
  - **The reply asks for the exact address of each one.** If the model's
    reply forgot to, the ask is added to the end.
  - **The address chase starts**, with a hint that names each house and its
    ask (`address_pending.data.houses`). The chase text asks for each house by name.
- The agent context lists "HOUSES THEY NAMED THAT WE DON'T HAVE AN ADDRESS
  FOR YET" (last 60 days) until the number or an offer on that street shows up.
- When several numbered houses come in one text, each house the model listed
  that has its street line in their own words gets its own `start_underwrite`
  (an `address` and `askingPrice` on the action). This happens only when the
  rule already starts one, and never for a house already in the offer book.

Still one chase per contact: an address landing for one house closes the
chase for the rest. The context block keeps the others in front of the bot.

#### Calls, houses with no street, and referrals (2026-10-14)

Reading 2,014 threads turned up three more leaks: a house named on a call was
never kept; a house named by town only ("some Stanwood houses", "I got one in
Medina, 2 in Stanwood") or by what it is ("two more parcels next to" a
listing, "he wants to sell his flips") was never asked about; and an agent who
pointed us at someone else ("contact <name> at John L Scott, she has one coming
up") got a thank-you and nothing more. Still no switch.

- **Calls.** The same capture runs on a call transcript. When GHL labels the
  sides (`THEM:` / `US:`), only their lines are read (`callWords`). A house in
  the model's `houses` counts only if their lines name its street or town
  (`saidIn`). A call's
  intent doesn't gate it, and houses already in their offer book are left out.
  The text after the call gets the address ask, and the address chase starts.
  `house_mentioned.data.heard` is `them`, `unlabelled` or `text`. With no
  speaker labels, our own words are mixed in. Those houses are kept and asked
  about, but **never underwritten**. On a labelled call, a numbered house
  in their lines can still get its own `start_underwrite`, as in a text.
- **No street at all** (`areaMentions`). The house is kept as a
  `house_mentioned` with `address: ""` and these fields:
  - `data.label`: how the ask names it ("the Stanwood houses").
  - `data.area`: the town, or "next to 5206 W Werner Rd".
  - `data.town`: the town when one was said.

  Two kinds count:
  - A town we know (the buyer-map list plus a few) after a "have / got /
    there's / listed" with "one", "another", a number or a house noun.
  - "a/some <Town> <house noun>" with a lead word nearby.

  The first-text house's town counts only with "another" or "more". A
  copula ("it's a Lacey rambler") never counts. Neither does a tapback
  quoting our text. Such a house stays on the context list until a numbered
  house in that town comes in from them. With no town ("his flips"), any
  numbered house closes it. "Federal Way" with no number is the town, not a
  street.
- **Referrals** (`referralMention`). These count:
  - "contact / call / text / reach out to / go through <Name> (at <Brokerage>)"
  - "<Name> at <Brokerage> has one"
  - "my partner/colleague <Name>" with a lead cue
  - "my husband's client wants to sell"
  - "my wholesale partner is looking for you"

  Each writes one `referral_mentioned` event per person named (`data.name`,
  `brokerage`, `relation`, `phone`, `phrase`). Only the agent's own words
  count: a text, or their side of a labelled call. That event raises a
  **`referral` row on Today** (`shared/call-list.js`): "Referral: <Name>
  (<brokerage>) — <agent> says they have one". The row shows their words, the
  phone if they gave one, and "mention <agent>". It lasts 21 days, or until
  you Dismiss it. **Nothing ever texts the person they named.** Reaching
  out is Matt's call.

Replay on the saved threads (5,210 agent texts, 362 call transcripts):

| Detector | Agent texts | Calls | False positives |
| --- | --- | --- | --- |
| `referralMention` | 7 | 0 | none clear; 2 are a partner holding details on a house already in play |
| `areaMentions` | 43 | 6 | 1, on a call: an agent's own project |

About four of the 43 texts gave the number in the next sentence. The model's
`houses` usually carries it, and a numbered house in the same town drops the
town-only one. Still missed on calls: "I'll have one up there", with the
town said by the other speaker, and a bare "he'll email other properties".

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
  (Tier 3, passed on offer) → `we_passed`; the agent said the house is gone —
  pending, sold, under contract, off the market, no longer available,
  accepted another offer, withdrawn (`GONE_TEXT`) → `unavailable` (2026-10-02:
  2617 Cottage Rd E's "already pending" was filed as their pass, and a passed
  house gets a check-in every ten days); the seller said no, not interested,
  won't sell, or has other offers → `passed`, still for sale, so the check-in
  may bring it back; turnkey per the agent → `we_passed`;
  we told them we're passing on it — our sent reply on the house passes
  (`ourReplyPasses`) or the thread's qualify stamp says pass → `we_passed`
  (2026-10-14, Welfare Ave: a pass, then an underwrite held on the map, then
  "can you confirm the full address?" at 7pm);
  held **14 days** with no word → `we_passed`; we asked for their read
  **7 days** ago and heard nothing → `we_passed`. The `uw-needs-review` tag
  comes off once nothing of theirs is held.
  **Promised (2026-10-14).** Sometimes the sweep closes a house out by itself
  (stale, no answer, turnkey; `QUIET_PASS`) while we still owe that agent a
  number or the offer on it (`owedOnHouse`, shared/promise-owed.js), or while
  their last text about it was never answered. Then the verdict carries
  `passNote: "promised"`, and a `kind_pass` is drafted with `why: "promised"`.
  It owns that we owe them, says we're out with one honest reason
  (`passReasonInWords`, never the sweep's own "held 15 days"), and asks for
  the next fixer. It names no number. **Switch:
  `conversationAi.heldTriage.passOnRetire`, off by default.** When it's off,
  the draft is held for you. It shows on Today as a draft beside the
  `number_owed` row, and the audit never releases it. When it's on, it goes
  the way the other pass notes go (released by the audit). Retires that
  already tell them, or that we may not text (unsubscribed, bot-off, a GHL
  stage, "we told them we're passing"), get no second note.
  **Not a flip, in their words (2026-10-05).** Ryan Bowen texted "move in
  ready… certainly not a fix n flip", then "You should come take a look!",
  and "number first" underwrote 13814 214th St E anyway. `isTurnkeyReply` now
  reads everything they've said since our last text (`theirLatestWords`),
  and "not a fixer / fix n flip / flip / project" counts. On such a house
  no path starts an underwrite (number first, the rule's own, a new subject
  property). A showing offer on it gets "that one sounds more finished than
  what we buy… if something rough crosses your desk, I'd love a first look",
  filed investor_open. This reverses 9/14's "number first" for a house the
  agent calls finished; anything that might need work still gets the number.
  The sweep's `TURNKEY_TEXT` reads "move in ready" with a space and "not a
  fix n flip" too.
  2026-10-07: such a reply that names the house no longer runs the
  new-property rule (no tier-1 tag, no TIER 1 workflow), and the named house
  carries `notOurKind` — see **Tier 1 — GHL's stage, screened**.
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
  **Also a rerun (2026-10-14): a street the map couldn't place** ("couldn't
  locate 5413 Welfare Ave NE") that matches, by number and street, a full
  address we already hold for this agent (`knownAddressesFor` in
  auto-underwrite.js: their RentCast listings — `store.listContactListingAddresses`
  — our outreach hook, timeline events with a city, the book) re-runs on that
  address, and nobody is asked. The underwriter reads the same list before it
  ever holds. Agent check-ins now carry the listing's full address, so a reply
  to one starts with its city.
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

**Numbers we never sent, closed out (2026-10-16, ON at 10 days).** The audit
found six priced offers whose number never went out, some since August: the
Offers column said "Our number never went out — float or send it" ("the
float timer didn't send it") and they sat on Today for Matt for good. The
same nightly pass now closes them (`retireStaleUnsent`,
`ghl-broker/held-underwrites.js`; the verdict is `staleUnsent`,
`shared/stale-unsent.js`):
- **Which.** The house's current row, status new, a number on it, and nothing
  of ours ever in front of them: no letter that went, no `floatSentAt` (a
  number texted in a plain reply), no realm or take check, no nudge. It is
  `retireUnsentDays` past the day it was due out (the float timer's hours
  after it was priced, or a day for one made by hand; a re-quote restarts
  it). Not a deal, a held draft (the triage above has those), or a yes.
- **Never** while a person has the thread (a hand reply or a call), while a
  float you pressed is still waiting in the outbox, or within 14 days of a
  person's own work on the row: made by hand, revised, pinned, approved or
  published.
- **What it does.** `we_passed`, `statusNote` "never sent: closed after N
  days", `retired: {by: "stale-unsent", at, reason}` (the held sweep's own
  shape), an `offer_we_passed` timeline line, and any machine text still
  queued about it dismissed, as the status menu's "we passed" does. Nothing is
  texted and no GHL note is written. The agent is then nobody's offer and goes
  to the agent check-in (`offerOwner` reads a pass of ours as nothing coming).
  A second look never revives one (`numbersPass` skips sweep-retired rows).
- **Switch:** `conversationAi.parties.agent.followUp.retireUnsentDays`,
  default **10** — this one ships on, because it only closes our own stale
  rows and sends nothing. 0 turns it off; so does `nightlyAudit.heldSweep:
  false`.
- **Check:** the audit's Run now as a dry run lists them as "Numbers we never
  sent, closed out" (kind `stale_unsent`, `counts.byKind.stale_unsent`) with
  the days; a real run shows each under "Done on its own" as `close unsent
  (closed: never sent: closed after N days)`.

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

**A call that didn't connect is an attempt (2026-10-02).** Before, a call that
rang out was a bare `call_summary`, and every reader took that as "they
answered": the nudge ladder re-anchored, the "they replied" chip lit, Reports
counted a reply. Now `connectedCall` (`shared/talked-to.js`) decides: a
status that says nobody picked up, or under 30 seconds with no transcript, or
a voicemail greeting under 40 characters, is a **`call_attempt`** event
(`data: { outcome: "no_answer" | "voicemail", direction, durationSec }`, key
`call:<messageId>`, no words). A long call GHL couldn't transcribe is still a
`call_summary`. The Desk's chips write the same event by hand through
`POST /api/contacts/:id/events {type: "call_attempt", outcome, callBackAt?}`
(`outcome` is `no_answer`, `voicemail` or `call_back`; a call back needs a date
inside 60 days). Expect Reports' "replied" counts to drop a little: our
missed calls no longer count. **Their** missed call (inbound) is both: a
`call_attempt` (key `call_attempt:<messageId>`, the Desk's "they called you")
and, as before, a bare `call_summary` so the ladders and the check-in still
see them reaching out — never read as a conversation. With no transcript the
call is read once more before deciding, in case its length landed late.

**A voicemail they leave is a missed call (2026-10-15).** Their inbound call
that nobody picked up, with a voicemail long enough to read (40+ characters),
used to go to the reply agent as if we'd talked: its `call_summary` read as a
conversation, so "they called you" never showed. Now call-intake writes the
inbound `call_attempt` first (`outcome: "voicemail"`, `leftMessage: true`, key
`call_attempt:<messageId>`), then hands the words to the reply agent with
`call.missed`. The reply agent's `call_summary` carries `missed: true`, which
`callEventConnected` never counts as talking (so it doesn't clear the call
row, and the 48-hour brake below doesn't fire). For an agent with a live
house, the text after it waits for you ("they called about … and left a
voicemail — call them back") and the Desk's `call_missed` row is one of
Today's calls. No switch: it only holds a text back. Check: the contact's
timeline shows the attempt with `leftMessage`, and the outbox row's reason
says to call them back.

**After a real call the machine stays off the thread for 48 hours**
(`CALL_HAS_IT_HOURS`, `shared/thread-health.js`): a connected `call_summary`
(transcribed, or logged by hand) makes the brake read `person_has_it` —
"you spoke on the phone" — so no nudge, float or push lands on top of the
conversation. The call's own follow-up text comes from the reply agent, not a
driver, and is not held by it; and a number promised **on** that call is still
sent by the promise driver (`via: "call"`, a promise made at or after the call).

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

### Texts the carriers block (Error 30007, 2026-10-02)

Matt's screenshot: "Jeff, noticed your listing at 1515 Lombard Ave has been
sitting a while. I'm a local investor buying houses as-is, no repairs needed.
Would the seller consider a cash offer?" — Error 30007, "Message blocked due
to carrier policies". Fourteen days of outbound SMS (2,776, one number) read
from GHL, by what they said:

- check-ins and openers that pitched "as-is cash offer / I buy houses / local
  investor": blocked 53% to agents who had never written back, 26% to ones who
  had ("no repairs" 60%, "cash" 38%, "as-is" 24%, "investor" 21%);
- deal texts with the package link: 32% cold, 9% warm; the same texts
  without a link, 0 of 121. Blocks started 9/29, the day after the package
  link went into deal texts;
- buyer check-ins saying "a Seattle investor who wholesales…": 13% cold;
- everything else the app sent (replies, floats, nudges): 0.6%; the GHL
  workflow's own opener (a plain question about the listing): 0.1%.

It is wording and links, not the number's registration. What changed:

- **The prompts** for the four texts that introduce us
  (`CARRIER_CHECKED_KINDS`: outreach_open, outreach_nudge, agent_pulse,
  buyer_pulse) ask about the house in plain words ("is it a bit of a
  project?") and say who we are without "investor" or "wholesale", and carry
  `CARRIER_RULE` (shared/carrier-words.js): never cash, cash offer, as-is,
  investor, buy houses, no repairs, quick close, wholesale or a link.
- **One rewrite, then a hold.** A draft of those kinds that still says any of
  them (`carrierFlags`) is drafted once more with the words named
  (`writeAgainWithoutCarrierWords`, `outbound.avoid`); the rewrite is kept
  only if it says fewer. `evaluateReplyGates({ carrierCheck })` flags what's
  left, so it waits for a person instead of going. Floats and replies to
  someone mid-conversation are not checked — they went through.
- **The letter's text** says neither "cash" nor "as-is" (the attached letter
  carries the terms) and carries no link when the email is going too: the
  comps page link rides in the email, and the text says "The comps and
  numbers are in your email."
- **Deal texts** (`dispoAutopilot.blastLink`, Settings → Dispositions → "The
  package link in a deal text"): `"on_reply"` sends the deal without the link
  — ending "Happy to send photos and numbers." or "Want the details?" — and no
  invite is minted (the draft carries `blastWithoutLink`). When the buyer
  answers that text with interest, a question, a walkthrough ask, a status
  check or price pushback, within 30 days and before any link has gone, the
  reply agent sends the package link for THAT deal (`linkOwed`,
  `send_dataroom_invite` with `addressHint`), whatever the buy-box guard
  says; a pass gets nothing. Emailed deals always carry the link. Default
  `"always"`.
- `OUR_OFFER_TEXT_RX` also knows the for-the-record letter ("sending our
  written offer on …"), so the thread reader never takes it for a person.

**Buyer texts (2026-10-15).** October's buyer texts: 74 of 678 blocked
(10.9%), all of them cold deal texts ("it's Matt, a local investor… under
contract…") and walkthrough invites with a price; buyer check-ins went
through. What changed, no switch (these only hold more):

- `CARRIER_CHECKED_KINDS` also covers the buyer follow-ups and walkthrough
  texts: `blast_nudge`, `dataroom_nudge`, `deal_followup`, `showing_reminder`,
  `showing_followup`. Same rule, one rewrite, then the gate holds it.
- The county-records intro (dispo-autopilot.js `countyIntro`) says "I'm
  Matt, I fix up houses locally", not "a local investor".
- The operator's line in a deal text (`blastNote`, from the package headline
  or the wave's own line) is left out whole when it says a carrier word
  ("cash only, sold as-is").
- **Send-time backstop** (`sendReplyDraft`, `BUYER_CARRIER_KINDS`): a deal,
  walkthrough or buyer follow-up text going by itself that still says a
  carrier word after the send-time rewrite goes back to Draft with
  `held: carriers block texts like this — it says "…" — not sent`. A link
  only counts to a buyer who has never written back (`investors.doc.lastRepliedAt`),
  so with `blastLink: "always"` a cold buyer's deal text waits for your Send
  (the minted invite is revoked; your Send mints a fresh one). Live is
  `"on_reply"`, so a deal text carries no link and goes. Your Send is never held.
- Check: the Outbox's Draft rows with that flag; or `carrierFlags(text)` on a
  blast preview's rows (`POST /api/dispo/blast` with `dryRun`, the default).

To re-run the measurement: page `searchConversations` for the window, read
each conversation's messages, and group outbound `TYPE_SMS` by the `Error
NNNNN` in `error` — read gently (two at a time, back off on 429), the broker
shares GHL's rate limit.

### Matt's contact card (2026-10-09)

Matt: share my contact card "when people ask or if an initial deal doesn't work,
saying to save my contact info and I'll be in touch." The card is a .vcf that goes
in **its own text, right behind the bot's reply**, as an MMS attachment
(`ghl-broker/contact-card.js` `followWithCard`, called at the end of
`sendReplyDraft`). It goes on both paths: an auto-send and your Send on the Desk.

The rules are in `shared/contact-card.js` `cardMoment`:

- **They asked** who we are or how to reach us ("what's your email", "who is this",
  "send me your info", "do you have a website"). Agent or buyer. On its own,
  "your number" is a price, so it doesn't count as an ask. A second ask within
  `askRepeatDays` (7) gets no second card.
- **The house didn't work**: an agent's `rejection`, our `kind_pass`, a
  "not our kind of house" reply (`draft.notOurKind`), or the icebreaker pass
  (`qualify.stage: "pass"`). **Once per agent, ever.** The text says "save it
  and I'll be in touch".
- **Never** on a cold first text (`outreach_open`, `blast_open`), because an attachment
  in a cold text is what the carriers block (30007). Never on email.

Each card that goes writes a `contact_card_sent` event on the contact record.
"Once ever" and "not twice in a week" are both read from those events. A card
that
fails to send is logged and leaves the reply's own send alone.

**Where the card lives:** `settings.conversationAi.contactCard` (`vcard`,
`fileName`, `onAsk`, `onPass`, `askText`, `passText`, `askRepeatDays`), set under
Conversation AI → Contact card. Matt's phone number stays out of the repo. The
first save mints `token`. The carrier fetches the card from
`GET /card/<token>` on the broker (`PUBLIC_BASE_URL`, outside the location gate,
because the token is the credential). That route serves `text/vcard` with a
`Content-Disposition` file name, so the phone shows "Matt Shepherd.vcf" instead of
`text_1.vcf`. The link works whether or not sending is switched on, so the card can be tried
first. A page saved from a bundle older than the card sends no `contactCard`
key, and `saveConversationConfig` keeps the saved card in that case.

**Ships off** (`contactCard.enabled: false`). The autonomy dial doesn't touch it.

### The written offer follows the float (2026-10-02)

Matt: "send them our offer in the official email text form so that they have
it in front of them … floating and actually sending the offer should be more
in line." In the 30 days to 10/2, 114 numbers were floated by text and 35 got
the written offer. The float stays — it asks the agent's read before paper —
but silence no longer leaves the offer unwritten.

Playbooks → Agents → "Send the written offer after a quiet float"
(`parties.agent.sendOffer.afterFloat`: `enabled` off by default,
`silenceHours` 24, `dailyCap` 20; `onPushback` is the reply half). On the
15-minute tick (`paper-after-float`, `router.sendPaperAfterSilence`), inside the
auto-send hours, the letter goes by text and email in its own words ("sending
our written offer on … over so you have it on file") when, per
`paperAfterSilenceDue` in shared/paper-follows.js:

- the offer is the house's current one, `new` or `sent`, not a deal, with a number;
- our number went out by text — a SENT realm-check draft for that offer
  (`proactive.realmCheckAt` is stamped when the float is drafted, which can
  be long before it leaves) — within the last 14 days; a take-check names
  no number and doesn't count;
- it's a number we'd put in writing unasked: a person's own, a clean
  underwrite, or a held one a person published — never `agent_numbers`;
- nothing came back since: no inbound text the bot drafted for, no text
  summary, no call;
- `silenceHours` working hours have passed (weekday clock hours, Pacific —
  a Friday 2pm float is papered Monday 2pm);
- no paper went yet (`paperWent`: at least one channel succeeded), and it
  hasn't been tried (`offer.paperAfterFloat`, claimed before the send).

Never to a contact who unsubscribed or that a person stopped the bot on. The
send goes through the conversation's `sendOfferDocs` pinned to that offer
(`offerId`), so `paperCheck`/`stale_number` still holds a number the thread
has moved past. The timeline's `offer_sent` carries `by: "after_float"`,
`forRecord: true`; Flow counts it as the machine's. A send whose every
channel failed is in the ledger but isn't paper: `whatWentOut`, the
follow-up sweep and the Next follow-up column read `paperWent` now, so a
nudge never says "we sent you an offer" after one. The nudge clock restarts
from the paper.

**With the float, no wait (2026-10-13)** ("Send the written offer with the
float — don't wait", `afterFloat.withFloat`, needs `afterFloat.enabled`).
Matt: a number we texted counts as Sent, "we should also just send out the
offer here so they have it". `paperAfterSilenceDue` drops the working-day
wait, so the letter goes on the next 15-minute tick after the float text
leaves. Everything else above still holds: current offer, `paperWorthy`,
`paperCheck`, once per offer, auto-send hours, `dailyCap`. If they answered in
that window, the reply path (`onPushback` / `onNeutral`) has it. Ships off.

**With the reply to a no** ("Send the written offer with the reply to a
no", `afterFloat.onPushback`, needs `afterFloat.enabled` too). Matt: "even if
it doesn't make sense for the agent or if the number they say they have some
pushback on it." In runReply, after the first-no block and before the paper
hold: when the intent is a rejection (a first no, a plain no, their pass or
walk-away) or a soft floor, on the house's current offer that is `new` or
`countered`, not on paper (`paperWent`), a number we'd put in writing
(`paperWorthy`), that we floated (a sent realm-check draft, or our price on
that house in the thread — `lastQuoteOnHouse`) and whose number the thread
still agrees with (`paperCheck` — a mismatch skips it, it never holds the
reply). A `send_offer` with `via: "for record"`, `forRecord: true`, the
offer's id and channels sms + email goes FIRST in the plan, ahead of
`mark_offer_passed` (the send only goes on an open offer). The reply gains
"I'll send our written offer over anyway so you have it on file." — before
"Keep me in mind" on a goodbye — and keeps the model's words as
`replyBeforeSend`; step 5 puts them back, with a flag, if the letter didn't go,
and a failed for-record send never holds the reply. When the reply waits for
a person, the send is a one-click suggestion instead and the reply is
untouched. Never on a counter (NEVER_AUTO: Matt's call), a house that sold
(`houseGone`), an opt-out, a we-passed house, or alongside a re-quote. A stop
on the bot turns it into a suggestion like any send (step 4g). The timeline
records `by: "for_record"`.

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

### The machine stays out of a live thread, and never walks away from a yes (2026-10-15)

**Why.** The funnel review (485 threads, Jul–Oct) found machine texts landing
in the middle of 92 live negotiations. The worst: a seller took our 261k on an
offer we had marked we_passed four hours earlier, and 11 minutes later the
bot answered "We've actually moved on from this one for now". The agent asked
us to stop texting.

**Two rules** (`machineMayStart`, shared/thread-health.js), asked in
`startProactive` before anything is drafted and again in `sendReplyDraft`
before an auto-send:

- **48 hours.** They texted us (not an auto-reply) in the last 48h and a house
  is live for them (an offer new/sent/countered, hot or agreed, a house they
  named in the last 14 days): no `kind_pass`, `passed_checkin`, `agent_pulse`,
  `checkin_due`, nudge, `address_chase`, `price_drop`, `promise_due`,
  `take_ask` or `hot_push` is started, and one already counting down is
  binned. The floats (`realm_check`, `take_check`) are exempt: they answer
  the conversation.
- **A yes.** Any yes to our number in the last 30 days on that house
  (`saidYes`, shared/offer-status.js: an agreed price, the acceptance mark, a
  `realm_yes`/`offer_accepted` event, an inbound read as an acceptance or a
  realm yes, or their own words — `saysYes`): nothing pass-shaped goes out by
  itself. That's `kind_pass`, `passed_checkin`, and any text whose words pass
  (`ourReplyPasses`, which now also reads "we've actually/just moved on"). A
  machine text is binned; a reply goes back to wait for you. The same yes
  stops the held-underwrite sweep closing the house (it's "yours"), the
  counter-hold clock passing it, the Tier 1 morning clear-out kicking the
  card, and a reply that passes from retiring the unsent offer.

**A yes after we passed.** A yes (by intent or in their words) on a house we
marked we passed holds the reply for you whatever the model filed it as, and
the draft carries `yesAfterPass`. Today shows it as **"They said yes after we
passed: Name on Street"** (a `draft_waiting` row, now). Their next texts stay
held until somebody sends something. The prompt's WE PASSED rule now says a
yes to our number is not a new price: thank them, say you'll confirm today,
needsHuman, never "we've moved on".

**No switch.** Both rules only hold things back. **Check:** the outbox row's
flag says "the machine stays out of a live thread for 48h" or "they said yes
to our number"; the follow-up sweep's report lists the same reason as
`skipped`.

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

### One set of terms (2026-10-15)

Agents asked for written offers, earnest money terms and the inspection window,
and got two answers: the bot's write-up terms ($1,000 earnest after
inspection, a 10 to 14 day inspection, a hard money loan, roughly 10 to 21
days to close; `writeUp` in the Conversation AI config, Matt 2026-09-18) and
the letter's ($2,500 on acceptance, 14 days). Now there is one set. No switch:
it follows `writeUp`.

- **The letter** (`offer-doc.js`): with the Conversation AI saved, the earnest
  money row is `writeUp.earnestMoney` "deposited with escrow after the
  inspection period", a new **Inspection** row says "10 to 14 days from mutual
  acceptance", and the closing row says "Roughly 10 to 21 days from acceptance,
  inspection included — or a date of your choosing" (a closing date set by
  hand in Settings still wins). `writtenTerms` in `shared/offer-calc.js`. A
  visible change: new letters show $1,000, not $2,500. Letters already made
  keep what they said. Per-offer letter terms from the editor are untouched.
- **The email** the machine writes (no operator message) adds "Our terms:"
  with `writeUpTermsText(writeUp)`. An operator's own message gets nothing
  added. The text message is unchanged (carrier-safe: no "cash", no "as-is",
  no link). No proof of funds goes (Matt skipped it).
- **The offer book** reads the terms stamped on the offer when its letter was
  made (`offer.terms`, `termsOnLetter`, now on lean rows), so the bot says
  $1,000 and the inspection window for new letters and the old terms for old
  ones.
- **Check it.** Preview a send (`POST /api/offers/:id/send` with no message):
  the email has "Our terms:"; a new offer's letter shows the Inspection row.

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
- **A lean offer read is the same on both backends** (2026-10-07). The
  Postgres lean projection (`leanDocSql` in `store.js`) keeps the list fields
  plus an ALLOWLISTED slice of `calc`: inputs, `LEAN_CALC_SETTINGS`
  (`calc.settings` holds API keys, so never a denylist) and
  `LEAN_CASH_FIELDS`. It also keeps a held draft's inputs. Before this, every
  lean row on prod lost its ARV, repairs, list price and terms, and the bot's
  show-our-work never had a figure. `leanOfferDoc` (`shared/offer-status.js`)
  is its JS twin: the file store runs it, so tests trim like prod. Change one,
  change the other. Rows carry `row.math` (compactMath).
- **Every daily sweep has a durable cursor** (`job_cursors`): follow-up,
  outreach, dispo second wave, the GHL mirror, and now the nightly
  enrichment sweep (`enrichNightly`) — a redeploy inside the trigger hour no
  longer re-spends model calls.
- **RentCast budget.** Settings → Agent Outreach → "RentCast requests a
  month" (`outreachAutopilot.monthlyRequests`, blank = 48, the free tier's
  50 less two; the old top-level `rentcastMonthlyBudget` still counts when
  it's blank) and "Plan renews on day" (`cycleDay`, Pacific). The sweep stops
  at the plan's number less `reserveRequests` (kept for the Pull button).
  Past a plan's number RentCast bills each request — it never refuses — so
  raise the number only after the plan on the key is upgraded.
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

## No Today: who owns what (2026-10-20)

Matt, 2026-10-20: "Today really shouldn't just exist. These things should be
automatically handled by the app." The Desk and the app's Tier 1 tab are gone.
`/dashboard` (any view) opens Offers (`messaging-app/src/links.js` movedTo);
old `?view=flow|dashboard|conversation` links still go to Reports / Autopilot.
**In GHL, remove the "Today" Custom Menu Link** (or point it at Offers).

Matt prices; the machine does the rest. GHL's Acquisitions pipeline is the
board: a house waiting on his number sits in Tier 1, a sent number in Offer Out
(the app moves the cards, `ghlStages.mode`).

Every reason the pipeline, the call list or last night's audit makes has one
owner (`shared/hand-off.js` ownerOf; a test fails on a kind with none). The
pipeline response carries the counts as `handOffs`:

| Owner | What happens | Kinds (examples) |
|---|---|---|
| machine | the bot sends it, or it closes itself | held replies (released under the gates; `autoSend.otherNow`), counters (the counter hold), hand-made numbers (the timer floats them a day on), the ask for their read |
| price | Matt sets the number — the GHL Tier 1 card | price_it, number owed, underwrite held, no_fit |
| call | booked on the calendar (`conversationAi.booking`), else GHL Manual Actions (`desk.ghlCalls`) | wants_call / scheduling (held or from the audit), call_* |
| ping | GHL workflow "App: needs Matt" (`desk.ghlPings`), and its own page | paper_to_sign, approve_number (Approve on the offer), closing tasks, pre_contract, partner questions |
| drop | closed quietly | a held thanks/photo/stop or a stranger's text a day on (the audit's `quietHolds`), a pass on a deal with outreach stopped, an office line two agents share |

A house waiting on Matt's number (draft only) gets one `take_ask` for the
agent's read — worth done, the work, what the seller would take — then waits
for him (`shared/held-underwrites.js` 3c). The machine never prices from it.

**Pings.** Build a GHL workflow with one Internal notification step to Matt,
re-entry on, publish it, paste its link in Settings → Ping me in GHL. Each
thing pings once (`ghl_ping_sent` claim). `POST /api/dashboard/ghl-pings/run`
(dry run by default) lists who would be pinged; `GET /api/dashboard/ghl-pings`
shows the last runs.

| Menu link | URL | Tabs |
|---|---|---|
| Autopilot | `https://<site>/autopilot?location_id={{location.id}}` | Overview · Agents · Investors · Advanced settings |
| Reports | `https://<site>/reports?location_id={{location.id}}` | Flow · Line · Follow-up · Activity · Lessons |

Cross-app links go through `messaging-app/src/links.js`.

## Flow (the Reports landing tab)

`/reports?view=flow` — the river. Thirteen stages in two rows (acquisition:
found → first text → replied → talked → underwritten → floated → offered → countered
→ under contract; disposition: blasted → opened → buyer → assigned/closed),
each with its count in the window, a bar split violet (the machine on its
own) / grey (a person), and arrows carrying the share of the previous stage
that reached this one. Two arrows are cohorts (2026-10-02): **Replied** is the
share of agents first texted in the window who answered after it ("N of M
first-texted agents replied") — the tile itself still counts every agent who
said anything, old threads included, which read as 79% on 389 found. **Offered**
comes after Floated (the number goes by text, the written offer follows) and
its arrow is the share of the window's floats now on paper (`paperWent`). First
text's sub-line counts known agents texted about a new listing
(`agent_pulse_texted`, reason fresh_listing) without adding them to the tile. Under it "What moved": every movement in the window, newest first, filterable to
the machine / people / acquisition / disposition, with contact and offer
links. Windows: today / 7 / 30 days, or a single past day. Polls every 30s
while visible. Pure builder `shared/flow.js` (`buildFlow`, `machineDid`);
route `GET /api/dashboard/flow?days=&end=&tz_offset=`, uncached local tier.
The timeline renderer is `messaging-app/src/EventFeed.jsx`, shared with the
contact drawer.

**Talked, and useful replies (2026-10-15).** Of every step on the line, a
phone call best predicts a contract, and the river had no station for it.
Thirteen stages now: **Talked** sits after Replied and counts each agent once
with a real call in the window (`realCall`, `shared/talked-to.js`): a
connected `call_summary` of 45 seconds or more; with no length from GHL, a
transcribed call whose summary runs 200+ characters; or a call Matt logged by
hand (no GHL message behind it). Its arrow is talked ÷ replied. Underwritten's
arrow stays underwritten ÷ replied. Replied's sub-line adds **"N useful"**:
agents whose reply said something (a text whose intent isn't opt_out, other or
small_talk, that isn't a phone auto-reply or "stop texting me"), a real call,
or a house, referral, property detail or estimate they gave
(`house_mentioned`, `referral_mentioned`, `property_details`,
`agent_estimate` — read by the Flow route, kept out of the feed). The Line gets
the Talked station from the Flow, with no target. No switch: it only counts.
Lean offer rows also carry `leadSource` (`{ source }` off
`autoUnderwrite.leadSource`), so a row says "agent brought" without the
timeline. Check: `GET /api/dashboard/flow` → `stages[3].key === "talked"`;
`GET /api/dashboard/line` → a `talked` station.

## Line (Reports → Line, 2026-09-29)

The whole business as one line, measured the way a factory floor is: is each station keeping pace, where does work wait, and what fell off with nothing scheduled. It only reads. Nothing on the page changes a setting.

**Where it lives.** `GET /api/dashboard/line` is cached a minute per location, and `?fresh=1` skips the cache. The arithmetic is in `shared/line.js`; the reads are in `ghl-broker/line.js` `lineFor`. The tab is `LineView.jsx`.

**Stations.** Flow's own counts (`buildFlow`) for the last 7 and 30 days, each station's rate a day, and its pace against a target.
- Targets are in Settings → Line targets (`settings.lineTargets`, `normalizeLineTargets`). Defaults are the Agent Method's: 10 new agents a day, 10 offers a day, 120 offers to a contract, 2 deals a month, $15K a deal, every replied agent touched in 21 days, every buyer in 30.
- The method line says what the month's offers should have made ("150 offers → 1.3 contracts expected") beside what they did.

**Supply (2026-10-15).** New-agent supply fell from 125 a day to 2 and
nothing said so. `supplyCheck` (`shared/line.js`, on `buildLine` as
`supply`) counts first texts over the last 7 days. Below
`lineTargets.minNewAgentsPerDay` (default 5; 0 turns it off; Settings → Line
targets "Warn below") it is `low`. `why` reads the outreach sweep's last run
(`job_cursors` "outreach", `doc.last`):
- the autopilot is off, or the sweep has no run on record;
- the last run failed;
- the RentCast budget is spent;
- the Conversation AI's daily cap left no room;
- the pool is dry (no picks, "nobody new", or half the picks already in GHL).
The Line shows a "New agents are drying up" card above Stations, with the
last sweep's counts (on file, picked, imported, already in GHL,
never-texted, off-market). Check: `GET /api/dashboard/line` → `supply`.

**Waiting between stations** (`cycleTimes`). Median and slowest-tenth days for each hop that *finished* in the last 30 days:
- priced → in front of the agent (letter or float);
- in front of them → their first answer;
- in front of them → a price agreed;
- agreed → contract;
- contract → first wave;
- contract → buyer committed;
- contract → assigned or closed.

**Leaks.** A leak is counted by the code that would have scheduled the work, so the Line and the machine never disagree:
- **Offers** (`nextFollowUp` on the current row of each house):
  - an open offer with nothing coming;
  - a machine clock more than 26 hours past due, which means a missed sweep.
  - Held replies, accepted offers waiting to be promoted, and floats the timer gave up on are shown as *waiting on you*. They aren't counted as leaks.
  - Deliberate stops (opted out, stopped by you, we passed, off market) aren't leaks. Neither is a passed offer whose check-ins finished: its agent belongs to the agent check-in from there.
- **Agents** (`planAgentPulse`) and **buyers** (`planBuyerPulse`): with a check-in off, everyone it would text is a leak — nothing will pick them up. With it on, those due beyond today's seats are **backlog**, counted apart: they're scheduled, just late. The buyer side also says how many workdays one pass through the pool takes, flagged when that's longer than the buyer touch target.
- **Deals** (the Today rows): nobody on it, blasted and nobody opened, buyers looked and nobody's committing, no buyer package, a stage lag, and a closing date or checklist item once it's *overdue*.

**Coverage.** The share of agents who have written back that were touched inside the check-in cadence, and the share of reachable buyers inside theirs.

**The jobs.** One row per durable job (`LINE_JOBS`, from `job_cursors` via `store.listJobCursors`, which reads only the run fields): when it last ran, whether it failed and why, or that it never ran. Whether a quiet job is switched off is the Autopilot page's to say. App errors from the last 7 days are grouped by area.

**What buyers paid** (`realizedPricing`, read-only). All-in (contract price + fee + repairs) as a share of ARV, scored from the whole deal documents the way Lessons reads them (the offer list is trimmed in SQL on Postgres and carries no ARV). It shows the median for deals that sold (buyer found, assigned, closed) and for deals that died, beside the offer setting (`maoPctOfArv`). The 2026-09-10 post-mortem found the sold deals near 70% and the dead ones asking 74–82%. The page keeps that evidence current and changes nothing.

**Last night's leaks on Today.** The nightly audit runs `lineFor` after its sweep and keeps `leakSummary` on its result (`audit.leaks`). Today's status strip shows "Leaks last night: N", linking to this tab, with the backlog beside it ("· M waiting for a check-in seat"). N counts what fell off, not what waits on you or waits for a seat.

## Follow-up (Reports → Follow-up, 2026-10-17)

Matt couldn't see what follow-up the app was generating, or what was queued for any one agent, offer or buyer. The answer was spread over the Offers column (offers only, next touch only), the check-in plan, the follow-ups preview and the Line, and buyers had nothing. This page puts it in one place, laid out like his sketch. It only reads.

**Where it lives.** `/reports?view=followup` (`&period=today|week|month|ytd` opens a period). The route is `GET /api/dashboard/followup?period=`, cached a minute per location and period (`?fresh=1` skips it). The rows behind a bar or a row come from `GET /api/dashboard/followup/items?period=&bucket=|mechanism=|group=|state=`, capped at 300.
- Arithmetic and catalog: `shared/follow-up-engine.js` (`buildFollowUpEngine`, `FOLLOW_UP_MECHANISMS`).
- Reads: `ghl-broker/follow-up-engine.js` (`followUpEngineFor`).
- Page: `messaging-app/src/FollowUpView.jsx`.

**Periods.** These are Pacific calendar periods that contain now:
- Today, by the hour.
- This week (Monday to Sunday) and this month, by the day.
- Year to date, by the week, plus the next 30 days.

The past part of a period counts what went; the rest counts what's coming.

**Blocks.** One row per mechanism, keyed to the `outbound.kind` its drafts carry, so a count is the texts that kind sent:

| Block | Rows |
|---|---|
| Agent outreach | First text (`outreach_open`), First text by GHL workflow |
| Agent follow-up | Agent check-in (`agent_pulse`), Matt's 15, Cold-agent follow-up (`outreach_nudge`), GHL follow-up workflow, Check-in they asked for (`checkin_due`), Promise we made (`promise_due`), Address chase, Held underwrite ask / pass (`take_ask`, `kind_pass`) |
| Offer follow-up · sent | Offer nudge, Push to paper (`hot_push`), Counter hold check-in (`counter_nudge`), Written offer after a float, Float our number (`take_check`/`realm_check`) |
| Offer follow-up · passed | Relisted house check-in (`passed_checkin`), Second look, Price drop |
| Buyers | Buyer check-in (`buyer_pulse`), Deal sent / catch-up (`blast_open`), Deal follow-up, Walkthrough reminder / follow-up (`showing_*`) |

Each row shows:
- what starts it, in words built from the live settings;
- its status, read from the same gates the sender checks;
- sent;
- replied: they answered within 72 hours, before our next text (last touch takes the credit);
- next touches;
- next send.

The page leaves out:
- a person's own texts: `check_in`, `partner_answer`, `showing_ask`;
- replies;
- the retired `blast_nudge` and `dataroom_nudge`.

A test fails if a new `OUTBOUND_KINDS` entry has no row and isn't on that list.

**First touches.** First texts, the float and a deal's first wave are shown but not counted in the follow-up totals.

**Status.**
- **On**: it sends itself.
- **Drafts only**: it is written and held for you. For example, the kind isn't on the auto-send list, a feature's own autoSend is off, or `CARD_SENDS_ENABLED` / `DISPO_BLASTS_ENABLED` is off.
- **Off**: nothing is written.
- **GHL sends it**: a workflow, outside the app's outbox.

Hover the pill for the job's last run.

**Where each number comes from.**
- **Sent.** From the send events, which are written when a text actually leaves and are never pruned:
  - `outreach_sent`
  - `outreach_enrolled`
  - `agent_pulse_texted`
  - `pulse_texted`
  - `blast_sent`
  - `second_look_sent`
  - `offer_sent` with `by` of `after_float` or `after_answer`

  Every other kind is counted from the outbox's sent rows (`store.listReplyDraftLedger`, trimmed in SQL). The outbox keeps those rows `retentionDays` (180), so on Year to date the page says where those counts begin.
- **`follow_up_sent` is never counted.** It is the sweep's claim, written before a draft exists.
- **Queued.** Outbox rows with a send time. These are exact, and a queued row stands in for the plan on the same contact and offer.
- **Waiting on you.** Machine drafts held under 7 days old (`staleHeld`).
- **Planned.** Each sweep's own planner:

  | Rows | Planner |
  |---|---|
  | Offer nudge, push to paper, relisted check-in, machine float | `nextFollowUp` on each house's current offer |
  | Agent check-in | `planAgentPulse` verdicts, rolled onto the weekday noon runs at `dailyCap` |
  | Buyer check-in | `planBuyerPulse` picks; the rest of the due buyers at the daily cap |
  | Cold-agent follow-up, deal follow-up | `outreachCandidates` / `investorCandidates` with `nextRungAt` |
  | Counter hold check-in | `holdState` |
  | Written offer after a float | `paperAfterSilenceDue` plus `addWorkingHours` |
  | Address chase | `addressChaseRungs` |
  | Deal catch-up | `catchUpDue`, at the next morning run |
  | Walkthrough texts | `showingTouches` |
  | Check-in they asked for, promise we made | their `dueAt` |

  Times land on the job's real run: the 16:00 UTC sweep, the noon check-in, machine hours.
- **One text a morning per contact.** The page keeps the sweep's order: push to paper, nudge, counter, passed, cold.

**What it can't promise.**
- A plan isn't a guarantee. The weekly per-contact cap, the model holding a draft, and a thread-health stand-down can't be seen ahead.
- Next touches counts each thread's next touch only, so a month undercounts a ladder's later rungs.
- Some rows depend on something that hasn't happened yet: a price drop, a held underwrite, a deal's first wave, the audit's stalled-counter nudge. These show "—" with what sets them off, never a made-up zero.
- A second look is picked each morning, so only today's is known.
- If GHL's Tier 2/3 cards can't be read, the page says so: agents who are only on a card are missing from the check-in plan.

**Tiles.**
- Agents reached out to / responded: Flow's own first-text cohort (`buildFlow().cohort`).
- Follow-ups sent, with the replied share.
- Scheduled ahead: queued plus planned.
- Waiting on you.
- Live offers with nothing scheduled: `offerLeaks`, the Line's own count.

Check: `GET /api/dashboard/followup?period=week` → `kpis`, `groups[].mechanisms[]`.

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

**The pane's strip** (2026-10-01). `GET /api/contacts/:id/timeline?offerId=&party=`
(`ghl-broker/contact-timeline.js`) is the work pane's header: the house's
moments (`shared/deal-moments.js` — priced, the letter going out, nudges
that actually went, their texts, counters, re-quotes, agreed, hot, the deal,
calls, stop / pause / pace; runs of the same moment collapse to "×N"), the
next move (`nextFollowUp`), and the Bot menu's state (`botHold`, `paceOf`,
the profile's stop-bot tag as last seen in GHL, an unsubscribe). One
person's reads, no GHL call. A moment carries no message words, phone,
email or typed reason. `GET /api/offers?contact_id=&next=1` reads one person
too (`attachNextFollowUpsFor`), and `GET /automations/conversation?contact_id=`
returns that person's open drafts.

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

## Companion window (2026-10-16)

The companion is a narrow app window that sits beside GoHighLevel and shows whoever is open there. When Matt opens a contact, or that contact's conversation, in GHL, the companion switches to that person. Nothing has to be clicked in the app.

- **Page:** `/contact?location_id=…&key=…` (`messaging-app/src/CompanionView.jsx`).
  - Top: the person's Desk pane, the same as on the Desk. It shows their current offer, the conversation and reply box, and the Status · Bot · Edit offer · Call buttons.
  - Below that: their whole record (`ContactRecordBody` from `ContactDrawer.jsx`).
  - `?contact=` keeps the person across a reload.
- **How to open it:** the **Companion** button in any app header (top right) opens it as a popup window.
- **Following GHL:** the Chrome extension in `companion-extension/` does this.
  - It reads the GHL tab's **address only** (`shared/ghl-url.js`, synced into `companion-extension/shared/`). It never reads GHL page content.
  - Its host permissions limit it to GHL and `app.shepflips.com`.
  - Addresses it follows:
    - `/v2/location/{loc}/contacts/detail/{contactId}`
    - `/v2/location/{loc}/conversations/conversations/{conversationId}`. The broker turns this into a contact with `GET /api/contacts/by-conversation/:conversationId`, which reads GHL `GET /conversations/:id` and needs the `conversations.readonly` scope.
  - A GHL tab on another sub-account is ignored, because the location ids differ.
- **Install (once):**
  1. Open chrome://extensions and turn on Developer mode.
  2. Click **Load unpacked** and choose `companion-extension/`.
  3. Pin it from the puzzle-piece menu.
  - After pulling a change to the extension, press its reload arrow on chrome://extensions.
- **Toolbar button:** brings the companion forward, or reopens it at the last companion address it saw. It stores that address in the extension's local storage. The address carries the location key, as GHL menu links do.
- **Always on top:** Chrome can't keep a window above others. Place the companion beside GHL instead, with macOS split view or a window manager.
- **When it doesn't follow, check in this order:**
  1. The dot at the top of the companion. Grey means the extension isn't talking to that window: is the extension loaded, and is the window on a host listed in `companion-extension/manifest.json`? The GHL menu links serve the app from `monumental-biscochitos-35bbee.netlify.app`, so the companion opens there, not on app.shepflips.com. A new console host has to be added to `manifest.json` and to `COMPANION_URLS` in `background.js`, then the extension reloaded.
  2. Is the GHL tab on a contact page or a conversation page? A list view is no one.
  3. On a conversation page, an amber note means GHL didn't name a contact for it.
- **Sends:** nothing new sends. The reply box and buttons go through the same gates as the Desk.

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

### Off-market first (2026-09-30)

Matt: "our biggest success has been in agent-sourced off market properties…
ask agents if they get off market properties please send our way, when we
can ask them but not in an aggressive way… a way to mark offers as
off-market and track those." The rules are `shared/off-market.js`.

**The mark.** `offer.offMarket = { value, by: "you" | "machine", why, at }`,
on the lean rows (`OFFER_LIST_FIELDS`).
- You: the offer's status menu → "Off-market — an agent brought it to us" /
  "Not off-market — it's listed" (`PATCH /api/offers/:id/off-market
  { offMarket, note }`). Your mark always wins.
- The machine, when an underwrite lands an offer (`offMarketSignals`): the
  agent's own words — the text that started it or their recent lines — say
  "pocket listing", "off market", "not listed yet", "coming soon", "hasn't
  hit the MLS", "before it goes on the market", "private sale"; or Zillow
  shows the house COMING_SOON or OFF_MARKET. Nothing said and a listing found
  is left unmarked — never "listed" by guess. Our own lines never count.
- The Offers tab: an "off-market" pill on the row and an Off-market filter.

- 2026-10-09: nothing had ever been marked (0 of 569). Three changes:
  - A house an agent brought that Zillow finds with no for-sale status (or none at all) is
    off-market (machine); a failed lookup stays unknown.
  - Held drafts are marked by the same signals.
  - The ~31 houses a thread read found off-market were backfilled as the machine's marks via
    `PATCH /api/offers/:id/off-market { by: "machine" }`, which never overrides yours.
- **The GHL tag `off-market`** (`OFF_MARKET_TAG`) goes on the agent's contact whenever a house of
  theirs is marked off-market, by the underwrite or by the route. Marking their last one listed by
  hand takes it off. It was a brand-new tag, so no workflow listened for it at launch.

**Tracking.** Reports → Line → "Off-market vs listed": offers, in front of
the agent, countered, price agreed, under contract, closed, and the share of
offers that became contracts — last 90 days or all time, each house once —
plus the agents who bring us off-market houses (`offMarketStats`).

**Asking, gently.** At most once a month per agent (`OFF_MARKET_ASK_EVERY_DAYS`
30), counted from `offmarket_asked` — written when a text that asks actually
sends, from the bot (`sendReplyDraft`) or from you on Today (`hand-reply.js`),
matched by `OFF_MARKET_ASK_RX` ("off market", "pocket listings", "before it
hits the market", "first look").
- The agent check-in's general and "the house they had with us" texts lean
  their ask that way when one is due: "whether any off-market opportunities
  have come across their desk… we'd love a first look", as a favor, never a
  pitch.
- 2026-10-06, Matt: say "off-market" itself. The asks had been going out as
  "anything before it hits the MLS"; the check-in, the reply prompt and the
  starter rule now all say "off-market" and never "before it hits the MLS".
- Replies: the agent system prompt's OFF-MARKET block lets the bot ask once,
  lightly, at a natural close (a house wasn't a fit, an offer died, they just
  sent one, the thread winding down) — only when the context's OFF-MARKET ASK
  line allows, never mid-negotiation, never claiming we have off-market deals.
  The context also names an off-market house they brought us before.
- The starter playbook's old rule "Never mention off-market deals" became
  "never pitch 'off-market deals' or claim we have any… you may ask for those
  lightly, at most once a month", and "Mention off-market deals" in the
  agent's may-not list became "Claim we have off-market deals". The live
  playbook needs the same two edits (Conversation AI tab), or its old rule
  outvotes the ask.

### Source like the deals with committed buyers (2026-10-09)

Matt: the deals with committed buyers are the ones closing; find how we
sourced them and make it repeatable. The four, read from the threads:
- **Vashon**: Matt called on the listing.
- **Issaquah**: the opener on a turnkey listing ended asking about their
  other fixers. The agent said it was finished and offered an unlisted POA
  house a minute later.
- **Snohomish 23706**: after we said it was too finished for us and sent
  two "any fixers?" check-ins about two weeks apart, the agent sent a
  friend's house.
- **7034 S K**: the agent named two other houses at once. Four weeks later
  a check-in got an off-market estate.

So the listing is the door and the deal is the agent's next house. All four
had a life-event seller, a call within about two hours, a written offer the
same day, and a price near the seller's number that still fit the buyer
ceiling.

**How a house came to us.** `shared/lead-source.js` `leadSourceOf` sorts
each house into one of three:
- `hook`: the listing our outreach opened with, or one of theirs we texted
  about since.
- `agent_brought`: an agent we reached out to brought a house we never
  raised. `checkin` is true when it came within 10 days of a check-in.
- `direct`: no outreach to that agent on record.

It is derived on read from:
- each imported agent's hook, via `store.listOutreachHooks`, which reads
  `outreach_agents` (`doc.hook.address`, `contact_id`, `imported_at`);
- the contact events: outreach, pulse, check-in and off-market asks.

Nothing is stored for old offers. The underwrite stamps
`autoUnderwrite.leadSource` on new ones.

Reports → Line → **"How deals came to us"** shows the funnel by source,
including a new **Committed buyer** station (`funnelBy` `buyer`: deal stage
buyer_found / assigned / closed). Below it is the list of agents who bring
houses (`sourceAgents`), with how many days after our first text the first
house came.

**What changed to repeat it.**
- **Opener.** Every default example ends asking for their other fixers, and
  the `outreach_open` rule makes that line required. The rule describes the
  line and never quotes it, so the texts don't all read the same.
  (Superseded 2026-10-15: the first text is one question, and the fixers
  ask follows their first answer. See "Short, one question" under The daily
  sweep.)
- **"It's turnkey".** A clear turnkey first answer skips the qualify question
  and gets the open-door pass at once (`saysTurnkey` in `shared/flip-read.js`;
  any "needs", "fixer" or "repairs" cancels it).
- **Life-event sellers.** STRONG now has "life event": executor, POA / power
  of attorney, conservator, a spouse or parent who died, assisted living,
  memory care, nursing home.
- **Off-market reads.** `OFF_MARKET_CUE_RX` now also reads "my friend has",
  "a friend of mine told me" and "word of mouth". An agent-brought house that
  Zillow knows and doesn't show for sale is off-market (machine).
- **Source agents.** An agent who brought a house is segment **source**,
  checked in on with partners first and never dropped for silence
  (`agentSegment`).
- **The call.** An agent-brought house becomes a **Call** row for two days
  (`call_brought` in `shared/call-list.js`), ranked just under hot. It says
  "a seller going through a life event" when their words do. When the
  seller's number leaves 10k under the buyer ceiling it says "their 250K
  works — a buyer pays up to 329K". That comes from `autoUnderwrite.theirNumber`,
  `theirNumberCheck` against `buyerCeiling().noFee`. It is a flag only:
  nothing sends above our number.
- **The prompt.** The agent system prompt's A HOUSE THEY BRING US rule:
  - get the address, promising not to approach or bother the seller;
  - ask their value fixed up, what it needs, and the seller's situation and
    timing.
- **The thank-you.** `deal_thanks` is a one-time check-in two to thirty days
  after a deal of theirs closes: thank them, ask for anything else like it.
  It is skipped when anyone texted them since the close. It stays a draft
  unless `outreachAutopilot.pulse.thanksAutoSend` is on (off by default).
- **Turnkey seats.** `outreachAutopilot.turnkeyShare` (0–100, ships 0; Matt
  said 25):
  - The sweep asks the pull to keep agents whose listings are all finished
    (`keepTurnkey`, sent beside the query and not part of its signature, so
    the saved page places don't start over). They are flagged
    `doc.turnkey` / `hook.turnkey`.
  - `pickAgentsToImport` weaves them in at the share, biggest book first,
    never more than the share.
  - Their opener is told the listing looks finished and leans on the
    other-fixers line.
  - **The flag reaches the text (fix, 2026-10-15).** The funnel review found
    79 of 80 turnkey-seat agents asked "is this one a project?": the import
    and the lost-text retry wrote the hook out field by field and dropped
    `turnkey`. One builder, `firstTextHook(doc, { county, base })` in
    `shared/outreach-opener.js`, now makes the hook for the import, the
    skipped retry (which re-reads the agent's row, so an old skip gets the
    flag back) and the lost retry. Check: `POST /api/outreach/opener/preview`
    on a turnkey row, or an `outreach_open_skipped` event's `data.hook.turnkey`.

### Converting the houses agents bring (2026-10-09)

Read from all 131 houses agents brought us (87 threads):
- **What converted:** the seller's number known early, a gap of 2–19%, a call within hours, no
  competition, and a seller with a reason and a date (estate, POA, a move by a set month).
- **What died:** a 20%+ gap, multiple offers, buy-box surprises.
- **Self-inflicted losses:**
  - 20 houses closed unpriced because the agent's GHL card said Tier 3;
  - numbers we floated, then cut;
  - slow or withheld numbers.

**What changed.**
- **The cold-stage retire.** The held-underwrite triage
  (`shared/held-underwrites.js`) no longer retires a house the agent *brought*
  (`brought`, from `autoUnderwrite.leadSource` or `leadSourceOf`) for the agent's cold or Tier 3
  card. A lost or abandoned opportunity still retires it. On a brought house, "turnkey" retires it
  only when said about that house's own address.
- **Held drafts.** They carry `autoUnderwrite.leadSource` too, so a held brought house is a
  `call_brought` Desk row: "no number yet (thin comps)", and the call asks for what the hold is
  missing.
- **No machine cuts.** `machineCut` (`shared/current-offer.js`) mirrors `machineRaise`: a number
  below the last one we texted on the house is never floated (`startProactive`) or papered
  (`paperCheck` → `cut`) unless a person stood behind it (send, revision, re-quote, pin, or a row
  they made).
- **`call_gap`** (`shared/call-list.js`): the seller's number (`property_details.sellerAsk`, read
  120 days back by the pipeline route as `asks`) within `desk.gapPct` (15) of ours.
  - It covers live floated/sent houses, and houses lost in the last `desk.revisitDays` (60) that
    weren't lost for kind or area.
  - The row shows the middle and whether it still leaves the fee under `buyerCeiling().noFee`.
  - It never sends a number.
- **Our box, once.** `OUR_BOX_WORDS` (`shared/asset-type.js`): "single-family houses that need work,
  under about a million" (Matt: single-family only).
  - It is in every `QUALIFY_PASSES` text, each with one kind of seller that converts.
  - The agent check-in names one `SELLER_SITUATIONS` entry in passing, and says the box to agents
    we've never priced a house for.
- **Investor-minded agents.** `investor_minded` events (`investorMindedCue`: a finder's fee,
  assigning, their own rentals or flips, offering to represent us), recorded once per agent from
  their own text.
  - They make the agent segment `source` in the check-in.
  - They get one `call_investor` Desk row within 30 days.
- **Assignments.** `ASSIGNMENT_RX` flags a brought house that's a wholesaler's assignment on the
  `call_brought` row (0 of 9 reached a buyer). It is a flag only; nothing passes automatically.

Not built: moving the agent's card to Tier 1 on a brought house. `followTierStage` already moves it
when the bot adds the tier-1 tag, so the leak was the retire rule.

### A lead with a date gets a check-in on that date, naming it (2026-10-14)

Reading 2,014 threads on 2026-10-14: 17 agents told us when a lead would be ready ("relisting in
springtime", "should know by end of the month", "coming closer to Nov 1", "not for about a year")
and 31 named one, and every one got the generic 14-day "anything distressed or off-market?" text.
`checkInRequested` only heard "check back" plus a weekday or a week, and calls were never read.

- **The reader.** `detectLeadTiming(text, now)` (shared/follow-up.js) needs a lead and a time in the
  same sentence:
  - leads: short sale, probate, estate, hoarder, foreclosure, an expiring listing, relisting, pulling
    it, one coming up, listing it / going on the market / going live, off-market or unlisted, a
    fixer, a tenant moving out, the seller deciding, "should know", or "check back / circle back /
    hit me up / free to talk after";
  - times: tomorrow, this/next week, next month, in N days/weeks/months, end of the month, a month
    name (next time it comes round), early/mid/late, seasons (Mar 15, Jun 15, Sep 15, Dec 15),
    after the holidays / new year (Jan 5), about a year, a weekday, a date, "soon" (two weeks, low).
- **The date.** The earliest one wins. A deadline ("by", "end of", "expires", "should know") is
  asked about two days after it, an "after" the day after. Never sooner than two days out, never on a
  weekend (Monday), never more than 13 months out.
- **It won't fire on:** a tapback quoting our own text ("Liked “I'll check back…”"), what they think
  WE could do ("if you fixed it up and relisted it"), a deal closing ("closing soon"), the past
  ("last spring", "since March", "listed in September", "of last year"), our offer expiring, or a
  bare "May"/"March" with no lead-in.
- **Booking.** The reply agent files `checkin_requested` with `kind: "lead"` and
  `lead: { what, when, said, via }` instead of the plain check-in for that message. A bare "check
  back in a couple months" with no lead in it is their cadence (`checkinEvery`), booked as a plain
  `kind: "date"` check-in, not a lead. On a call it
  reads the THEM lines of the transcript (an unlabelled one: lead words only, no "check back", since
  our side is in it). The isCall exclusion still holds for everything else. A house coming with no
  address and a lead under 21 days out makes that day the address chase's first ask; further out
  there's no chase, the lead's own check-in asks.
- **Its own track.** `runCheckInSweep` (promise-sweep.js) reads leads 13 months back, apart from the
  newest-request rule: a later "nobody answered them" clock doesn't replace a lead. It goes on its
  day as `checkin_due` with `sourceKind: "lead"`, and the text asks about that lead ("Did the bank
  come back on the short sale?"), not the generic question.
- **Who goes first.** An offer's clock (`offerOwner`, shared/agent-pulse.js: a live deal, an open
  offer still being asked about, a held underwrite) keeps them; the lead waits, unclaimed, and goes
  after. It's dropped 30 days past its day, after another check-in in the last three days waits, and
  if they spoke in the 14 days before its day the conversation has it. A far-off lead never means
  months of silence: the regular agent check-in keeps its clock, generic as always, and only stands
  down ("a lead they told us about") once the lead's day is within `everyDays`, so the two don't
  land together. A lead more than 7 days out doesn't replace the "nobody answered them" net under a
  held reply.
- **Sends.** No new switch. It rides `checkin_due`'s existing auto-send rule.
- **Replay (2026-10-14, read-only):** 36 hits in 5,538 texts and 252 calls across 31 agents: 9 within
  a week, 19 in 8–30 days, 4 in 31–90, 4 further. Two read as live-deal chatter ("undergoing
  foreclosure, close within a couple of days", "seller decides Monday"); both would wait behind
  the open offer.

### Partner terms reach Matt (2026-10-14)

Reading the threads, about 17 agents offered a working relationship on terms and the bot answered
"keep me in mind" or "let me check with my partner". The terms are Matt's to answer.

- **The detector.** `partnerTerms(text)` (`shared/partner-terms.js`, pure) returns
  `{ kind, phrase, kinds, addToBuyers }` or null. It reads only their own words: reactions quoting
  our text, links, phones and emails are stripped first. The kinds, strongest first:
  - `list_back`: list-backs, the relist after the flip, "one agent or several for resale".
  - `buyer_agent`: offers to represent us, or a buyer agency/brokerage agreement they need. "Are
    you represented?" is not one; the bot answers that.
  - `referral_fee`: finder's or referral fees, and a commission only when asked as a question.
  - `co_wholesale`: their wholesale or dispo partners, a JV, or a deal community.
  - `investor_buyer`: they pay assignment fees, buy N a month, or flip themselves.
- **Not in the model's schema.** The reply format is part of the cached prompt, so this is a
  regex backstop in `runReply` (step 1a). It runs on the agent's burst (`theirLatestWords`), texts
  only.
- **The hold.** The draft gets `partnerTerms` and `needsHuman`, and `evaluateReplyGates` flags
  "they … — partner terms are yours to answer" whatever the intent. It is a content gate:
  - no guard opens it;
  - the nightly audit never releases it (`releaseForAudit`, `releasableHeld`);
  - no redraft is spent on it.
- **The prompt line.** `partnerTermsLine` goes in the reply's user context, not the cached
  prompt. It tells the draft to name what they offered and say a call is coming, with no fee or
  agreement and no "keep me in mind". Matt edits and sends it.
- **The Desk row.** A `partner_terms` event (one per agent, kind and day) raises
  `call_partner_terms`, labelled "Partner terms: yours to answer" (`shared/call-list.js`).
  - It carries `partner: { kind, phrase, kinds, addToBuyers }` and the held draft's id.
  - It lasts 14 days. A connected call or a hand reply after it clears it.
  - It is on Today (`URGENT_KINDS`) and leads the person's row, with the held reply folded under it.
- **They buy.** `investor_buyer` also records `investor_minded` (same dedupe key as the reply's
  own read), and the row's goal says "add them to the buyer list". Nothing creates an investor
  profile.

Replay over the 5,503 texts agents sent us (saved threads, 2026-10-14): 56 hits across 46 agents
(list_back 15, referral_fee 16, buyer_agent 13, co_wholesale 9, investor_buyer 3). Two were not
partner terms: a wholesaler pointing us to their dispo person about one house, and "I'm a
wholesaler myself so I understand".

### Agents work for us (2026-10-15)

From the funnel review: agents asked for written offers, NWMLS forms and to
represent us, and the agents we let represent us became off-market sources.
No switch: one rule, a wider detector, and a hold (these only tighten).

- **The rule.** `AGENT_REPRESENT_RULE` (in `AGENT_GOAL_RULE`,
  `shared/conversation-ai.js`) tells the bot that when it fits — its reply to
  their first answer, a check-in, a house they bring us — it may say
  `REPRESENT_US_LINE`: "we'd love to have you represent us on the purchase, so
  you'd earn the buyer side too". Once in a thread at most, never as a
  condition, never beside a number of ours (the write-up gate reads "represent
  us" beside a price as a write-up ask).
- **Their offer to be our agent is partner terms.** `buyer_agent` in
  `shared/partner-terms.js` now also reads "I'd love to be your agent", "happy
  to be your agent", "work as your buyer's agent", "a buyer's agreement", "a
  buyer rep agreement" (never "who's your agent?" or "I can't be your agent").
  As before: the reply is held for Matt and a `call_partner_terms` row goes on
  Today.
- **A showing on a live house is Matt's.** When an agent offers a showing or a
  tour (`isShowingOffer`, or the model's walkthrough read) on a house we're
  working — an open offer on it, or one we haven't priced that their words say
  is finished — the reply is held: `draft.showingOffered`, and
  `evaluateReplyGates` flags "they offered a showing on … — yours to book,
  call or pass" (a content gate: the nightly audit never releases it). A
  `showing_offered` event goes on their timeline (one a day per house). On an
  unpriced finished house the drafted reply is still the "more finished than
  what we buy" pass, so Send is one press; it just never goes by itself. A
  house they told us was turnkey before this message (`agentRuledOut`) gets
  the pass sent as it always did. An unpriced house with work still gets
  "numbers first" and the underwrite.
- **Check it.** Today shows the held draft under Drafts waiting on you with
  the showing reason; the contact's timeline shows "they offered a showing".

### Every agent on a clock: the agent check-in (2026-09-29)

Matt: "reach out to these agents proactively and frequently, every 3 weeks or
so, to see if they have any new listings or leads." Until this, every clock
that texted an agent belonged to one thing (a first text, an offer, a phrase
they used), and every one of them ended. The outreach follow-up enrolled once,
passed-offer check-ins stopped at day 120, and "I'll send you deals"
check-ins stopped after six weeks. After that the agent dropped off the line
for good. The daily pull also skipped their next distressed listing, because
they were "already in GHL".

The agent check-in (`shared/agent-pulse.js` decides, `ghl-broker/agent-pulse.js`
runs it) owns an agent when nothing else does:

- **Who.** Every agent with a contact record, plus every GHL contact a pull
  matched to a fresh listing. It sorts them into three groups:
  - **partner**: a deal, an agreed price or a yes to a number, ever;
  - **engaged**: they have written back (a text summary counts only when it
    summarises THEIR text);
  - **cold**: never answered.
- **How often.** Partners and engaged agents every `everyDays` (21), and a
  fresh listing of theirs never brings that forward. Cold agents only when a
  fresh listing of theirs comes up, `coldEveryDays` (60) apart, never within
  14 days of any text of ours (`CHECK_IN_GAP_DAYS`), and never after `coldMaxUnanswered` (3) check-ins with nothing back. An
  engaged agent `engagedMaxUnanswered` (6) check-ins into silence is treated
  as cold (0 turns that off). These are Matt's cadence decisions (2026-09-29).
- **What about**, in this order:
  1. a fresh distressed listing of theirs, named in passing in a general
     check-in (2026-10-21, Matt): "saw your listing on 18th Ave Ct NW,
     doesn't look like a fixer. Just wanted to check in, any other
     distressed properties on your plate?" The street name only, never the
     house number, and never a question about that house. It must be one the
     pull first saw within `freshDays` (14) and still saw within
     `listingSeenDays` (30); distressed by the pull's own rule; not a house
     we have a live offer on; not one we walked away from in the last 180
     days. It is named once per listing ever (`listing_pinged`). Until
     2026-10-21 it was the whole text ("Is it a bit of a project?") and went
     as soon as `quietDays` (7) after our last text: an agent we'd checked in
     with a week earlier got it and opted out.
  2. the house they had with us, once its follow-ups have ended (passed and the
     check-ins are done or it went off the market, or the deal closed or fell
     through), but never one we walked away from.
  3. otherwise: anything coming up that needs work, or off market?
- **One voice.** An agent another clock owns is left to it. That covers:
  - a live deal, an open offer, or a held underwrite under 14 days old;
  - any follow-up the Offers column shows as coming;
  - anything waiting in the outbox (a held draft for a week at most), a
    promise, a check-in they asked for, a lead they gave us a date for (only
    once its day is within `everyDays`), or an address chase;
  - the outreach first-text workflow (until its follow-up is due) or its
    follow-up (`ghlWorkflowDays`, 21). The follow-up holds them only while
    `outreachAutopilot.followUpEnabled` is on (2026-10-16): switched off, its
    old enrollments hold nobody, and the app's nudge has that cohort;
  - any GHL workflow the app enrolled them in (now recorded as
    `workflow_enrolled`) unless its id is in `quietWorkflowIds`;
  - a thread you picked up in the last 3 days.

  Opted out, a do-not-text or bot-off tag, a stop on the whole thread, or
  sounding annoyed stops it altogether.
- **The text** (prompt case `agent_pulse`) names a listing by street, city and
  days on market, never its price. It never says a number or a link, and
  `onlyFloats` holds any draft that does. No agent, cold or known, gets a
  who-we-are line (2026-10-19: "I'm local and always looking for the next
  project house" was filler); the "Thanks, Matt" footer says who it is.

**Running it.** Once a workday from `hour` (noon Pacific), with the daily gate
(cursor `agentPulse`, retries if a deploy kills it), capped at `dailyCap` (20)
a day, or uncapped at 0 (live since 2026-10-05: every agent due gets one that
day; per-agent spacing still holds): thank-yous first, then partners and
engaged agents, most overdue first, then cold listings. Each agent is checked in GHL first (unsubscribed
is marked and skipped, tagged off or no phone is skipped), then claimed
(`agent_pulse_sent`) before anything is drafted. A claim that drafted nothing
is voided (`agent_pulse_voided`, and `listing_ping_voided`): the seat and the
listing come back, and the agent is tried the next day. `agent_pulse_texted`
is written when a check-in actually sends, and is what the cadence and the
unanswered counts read.

**A claim a restart dropped comes back (2026-10-16).** A deploy restarts the
broker while check-in drafts are still queued in memory; those never settle,
so their claims were never voided, and an unvoided claim reads as "checked in
on today" (`lastPulseAt`): the agent waited the full three or four weeks having
heard nothing. A deploy on 2026-10-16 dropped about 80 that way. Now each run
(the daily one and Matt's 15) first calls `voidDroppedClaims`: a claim from
the last 7 days that is over 2 hours old (`DROPPED_CLAIM_AFTER_MS`), with no
check-in draft for that agent after it, no `agent_pulse_texted` since, and no
job for them still queued or running, is voided ("a restart dropped it before
it was drafted"), with its listing ping. The run's job shows `recovered`.
Check: `GET /api/outreach/pulse` → `job.recovered` after a run.

**Switches** (`settings.outreachAutopilot.pulse`, outside the autonomy dial,
like the buyer pulse): `enabled` drafts the day's check-ins into the outbox,
and `autoSend` lets a clean one send itself. Both ship off, and
CARD_SENDS_ENABLED still gates every send. Settings → Agent Outreach → "Check
in with every agent" has the numbers and a Preview.

**Routes.** `GET /api/outreach/pulse` returns today's plan (counts by
segment, who another clock owns and why, who's due and why, coverage) plus
the last run; it writes nothing. `POST /api/outreach/pulse/run {dryRun, limit}`
is a dry run unless `dryRun: false`.

**It replaces the tier nurture drip (2026-09-30).** The check-in texts come
from a GHL workflow, "Tier 2+3 nurture", that GHL starts by itself when an
agent's Acquisitions card moves to Tier 2 or Tier 3 (Wait → SMS → Wait → SMS;
256 agents in it on 2026-09-30). It sends "still looking for fixers…" /
"anything ugly cross your desk lately?" about every four weeks. The TIER 1/2/3
workflows the playbook's rules enroll agents in move the card and are left
alone — an early version of this skipped them, which would have stopped new
cards (fixed the same day).

Which drips: `shared/agent-pulse.js` `tierDrips` — the ones picked in
Settings (`pulse.replacesWorkflowIds`), else every published workflow in
GHL's list whose name says both "tier" and "nurture" (not disposition).
GHL's list is read through `pulseWorkflows` (cached ten minutes); without it,
only picked ones count. While the check-in is on:
- an agent it texts is taken out of those drips first (`workflow_left`, a 4xx
  is "wasn't in it"), so nobody hears from both;
- a drip enrollment never "owns" an agent in the plan;
- a rule's `add_to_workflow` into a drip picked by hand is skipped
  (conversationDeps `replacedWorkflowIds` — picked ones only).

GHL keeps starting the nurture on every Tier 2/3 stage move, which the app
can't stop, so switch it to Draft in GHL the same day the check-in goes on
(keep it rather than delete it). Settings → "Replaces these GHL check-in
drips" lists GHL's nurture workflows to tick; **Count who's in them**, then
**Take everyone out now** (`POST /api/outreach/pulse/leave-drips {dryRun}`,
live only with the check-in on; progress at `GET /api/outreach/pulse/leave-drips`)
takes everyone tagged tier-2/tier-3 out at once — GHL has no API that lists a
workflow's members. "Not Now Nurture" is a second published nurture; tick it
only if it texts agents.

**How it sounds (changed 2026-10-09).** Matt: "personable yet generic and not
referencing the past property and checking in about any other distressed or
off market properties", except an offer we're following up, which is the offer
nudge's job. The check-in never mentions, names or hints at a house, listing,
offer or deal from before, including in a thank-you after a close. Every
general check-in asks whether anything distressed or off-market has come
across their desk. Its warmth comes from the tone, their first name, and at
most the area they work. A fresh listing of theirs is still named, because
it is news, not history. The subject carries `pastHouses`, which the drafter
never sees. A draft naming one of those houses (`namesHouse`) is written
again once and dropped if it still names one. `pulse.voice` (Settings, 600
characters) is Matt's own note on the voice, passed to the drafter.

**One real thing, and a call (2026-10-15).** The funnel review: Matt's own
specific texts got 70% replies, the generic check-ins 35%. Each check-in now
names ONE real thing, picked by `checkInHook` in `shared/agent-pulse.js`
(`subject.hook`), in this order:
- `listing`: their fresh listing (as before);
- `mentioned`: a house they named (`house_mentioned`, now read by the pulse)
  in the last 60 days that we never priced (no offer on it, sent or drafted),
  never passed or kicked off Tier 1, and that isn't our first text's listing;
- `closed_nearby`: one of our deals at stage `closed` in the last 60 days, in
  a town they work (their listings, their houses, their market areas). The
  text names the town only, never the house;
- `situation`: otherwise, one kind of seller we're good for.
Never a house we priced or passed on, and never "did it sell?". The thank-you
after a close has no hook. The hook's own house is taken out of `pastHouses`;
the gate still holds every other one. A mentioned house sets no `address` or
`listingKey`, so the reply isn't treated as a first-text house. The text may
offer a quick call "if that's easier", never with a day or time (no calendar
is connected). The draft's `outbound.hook` and the `agent_pulse_texted`
event's `data.hook` record which kind went. No switch: it rides the check-in's
own. Check: `POST /api/outreach/pulse/preview {limit: 3}` and read the hook in
each sample.

**A cold agent's fresh listing reads like a first text (2026-10-15).** A
cold agent's `fresh_listing` check-in is in effect a second first text, so it
gets the short first-text voice: their first name, the street, one question
("a bit of a project?"), under `OPENER_MAX_CHARS` (200; 160 and plain, with no
remark about the house and no joke, since 2026-10-16). No past house, no
other ask, no call offer. A draft over 200 is written again once
(`writeShorterFirstText`, `outbound.coldOpen`). `coldEveryDays` still
defaults to 60 (Matt sets 30 live). No new switch: it rides the check-in's
own. Check: `POST /api/outreach/pulse/preview {reason: "fresh_listing"}`.

**Matt's 15 (2026-10-15, off by default).** Matt's own specific texts got
70% replies. Once a week (`outreachAutopilot.pulse.mattsFifteen {enabled:
false, size: 15, weekday: 1, hour: 8}`: Monday, from 8am Pacific) the tick
drafts check-ins for his best agents, for him to make his own and send:
- **Who** (`pickMattsFifteen`, `shared/agent-pulse.js`): partners, then
  sources, then engaged agents. Within each, the newest word to us first, then
  the most houses with us. Never an agent who is stopped or owned by another
  clock, a cold one, or one either side texted in the last 7 days.
- **How** (`startMattsFifteen`, `ghl-broker/agent-pulse.js`): each is
  checked in GHL and claimed with the day's `agent_pulse_sent` (`reason:
  "matt15"`, the same daily key as the check-in, so nobody gets two). It is
  drafted as an `agent_pulse` with `subject.forMatt` and
  `holdForAPerson("Matt's 15 …")`. Nothing sends itself; a draft that trips a
  gate waits for him instead of being dropped.
- **Where it shows.** The draft's `outbound.forMatt` keeps it on Today
  (`urgentReasons`) as "Matt's 15: {name}, a check-in to make your own", with
  the editable draft in the work pane. Send records `agent_pulse_texted` as
  usual. His claims don't count against the daily check-in's seats.
- **Gating.** `job_cursors` row `mattsFifteen` via the daily gate (cursor
  written before the run, a stale run retried, tries capped), on the set
  weekday only.
- **Check.** `GET /api/outreach/pulse/matts-fifteen` lists who this week's
  would be, plus the last run. `POST /api/outreach/pulse/matts-fifteen/run
  {dryRun}` runs it by hand (a dry run by default).
**Write 3 sample check-ins** (`POST /api/outreach/pulse/preview {limit, reason}`, `reason` e.g. "general")
drafts the next ones from their real threads with the saved settings —
`reply-agent.js previewProactive`, which writes nothing and sends nothing.

**Spares.** The plan keeps the next few agents due beyond the day's seats
(`spares`). One skipped before its claim — unsubscribed in GHL, tagged off,
no phone — hands its seat to the next in line, as the buyer check-in does; and
a sample that wouldn't be drafted is shown with why while the next one is
written in its place. A listing the outreach first text already asked about
(`outreach_enrolled` / `outreach_sent` address, matched by number and street)
is never raised again as new.

**Turning it on.** Save your voice notes and read the samples. Tick "Check in
with every agent", switch "Tier 2+3 nurture" to Draft in GHL the same day, then
Count and Take everyone out of the drips. Read a day of drafts, and only then
tick "Let them send themselves".

**Also in this change.** The "I'll send you deals" check-ins can start again
when an agent offers a second time (the key used to be one per contact,
ever). While a chain is running, it keeps its own clock.

**Every agent with an offer (2026-10-09).** Matt: "make sure that every single
agent who has an offer, whether it is sent or just drafted, has the
appropriate follow-up going out to them". The live book had 316 agents with an
offer. Four things left some of them with nothing coming:

- **An open offer held the agent with nothing coming.** `agentOwner` read any
  open offer as "an open offer" owning them. Two kinds had no clock: a no the
  machine stands down on (the first no asks what the seller would take and
  keeps the offer open, and when that goes unanswered nothing moves it), and a
  priced number nobody sent. `openOfferIdle` lets those agents go to the
  check-in. That covers a no or pending/sold (`HOUSE_OVER_REASONS` in
  `shared/thread-health.js`) with no follow-up coming, and a person's unsent
  float more than `UNSENT_STALE_DAYS` (7) overdue. The send-time backstop
  (`ghl-broker/agent-focus.js`) drops the same offer as the "one house at a
  time" focus, for `agent_pulse` only.
- **GHL's TIER 1/2/3 enrollments held agents for 21 days.** Those workflows
  only move the Acquisitions card. A workflow named exactly `TIER 1`, `TIER 2`
  or `TIER 3` (`CARD_ONLY_WORKFLOW_RX`) never owns an agent; 165 were held on
  10-09. If one of them ever sends texts, rename it or put its id in
  `pulse.quietWorkflowIds`. That list works the other way round (quiet
  workflows never own anyone), so only a rename fixes it.
- **Answered, read as cold.** `agentSegment` now reads an offer only their
  answer could have moved (`offerHasTheirAnswer` in `shared/tiers.js`: passed,
  countered, a counter, a yes or no, sold) as engaged, the same way the tiers
  do.
- **Offered, never answered.** A cold agent with any offer row, sent or
  drafted, gets the regular check-in (`everyDays`), not listing pings only,
  until `coldMaxUnanswered` (3) check-ins go unanswered. After that the cold
  rule drops them. The text introduces us in one clause as the buyer who
  looked at one of their listings.

The plan also reads every offer contact, not only contact profiles and
listing agents (`loadPulseAgents`). The runner's GHL preflight checks the tags
of a contact with no profile.

**Offer contacts without an agent profile (2026-10-16).** The audit counted
seven contacts with an offer and no agent profile (offers made by hand from
the Offers form, where no text ever came through the app). They were already
in the pool through their offers; what they lost was their own record. The
plan now reads every profile in one read: an offer contact whose only profile
has no party (an event wrote it with none) has its tags and facts read, so a
do-not-contact tag or "check in every few months" holds for them too. Our own
contact (`shared/self-contact.js`, the signer's or persona's full name) is
never in the pool. A buyer with an offer stays the buyer pulse's. The first
check-in's claim (`agent_pulse_sent`, party agent) gives them an agent profile.
No switch: it rides the check-in's own. Check: `GET /api/outreach/pulse`
`counts.offerContacts` — `{ total, inPool, buyers, self }`; total minus inPool
is buyers plus us, so nobody with an offer is missing for any other reason.

**Tier 2 and Tier 3 from the app (2026-10-09).** Matt confirmed GHL's "Tier
2+3 nurture" sends nothing now: "we need to be doing everything from the
app". The plan reads GHL's Acquisitions board (`pulseTierCards`, ten
minutes' cache) and puts every open Tier 2/3 card's contact in the pool, with
the day the card moved (`lastStageChangeAt`, never `updatedAt`). For those
agents:
- The first check-in comes `everyDays` (14 live) after the move, or after our
  last word, whichever is later. A card that moved more than 14 days ago with
  nothing since goes on the next run.
- A card agent who never wrote back is checked in on like an offered one,
  until `coldMaxUnanswered` (3) go unanswered.

`GET /api/outreach/pulse` adds `counts.ghlTier` (t2, t3, due) and
`tierCardsRead`. `?agents=1` adds one line per agent, with no names:
- status and reason;
- `dueAt`, when the next check-in goes;
- the tier and when the card moved.

If the board can't be read, the run plans without the cards.

**Offers stuck open let the agent go (2026-10-14).** The Line listed open
offers the machine had stood down on 8–13 days back ("they passed"), and
others where the agent wrote and nothing answered it. The check-in left every
one of them to "an open offer", for good. Three fixes:
- **The plan reads the offer's thread.** It used to read four days of drafts,
  so a no from last week was missed, a nudge looked to be coming, and the agent
  stayed owned. An agent with an open offer now gets their newest 20 drafts
  from the last 130 days, the way the Offers column reads them.
- **Nothing coming plus a quiet week releases the agent.** `openOfferIdle`
  now covers any open offer with nothing coming (Next follow-up "None
  scheduled" for any reason: the push to paper ran out, a reply nobody
  answered, follow-ups switched off), and a house you pressed Stop on. These
  release once there has been no text either way for `STOOD_DOWN_QUIET_DAYS`
  (7). That counts their texts, ours, calls, sends and nudges on the offer,
  and the offer's own date. The agent stays with the offer when any of these
  hold:
  - a text in the last week;
  - an offer made this week;
  - a person on the thread (`person_has_it`);
  - a pause with a date;
  - anything still coming on the offer.

  A no or pending/sold still releases at once. The send-time door
  (`ghl-broker/agent-focus.js`) asks the same function.
- **A held draft owns the agent for a week, not forever.** A held reply or a
  person's draft created `STALE_HELD_DAYS` (7) ago, or a queued text whose send
  time has passed, no longer owns the agent (`staleHeld` in
  `shared/follow-up.js`). It stays on the Desk. The agent check-in no longer
  waits behind it (`blockingDraft` with kind `agent_pulse`) and does not
  replace it (`supersededBy`). Every other machine text still waits on it.

A released agent gets the general check-in. An open offer is never the
check-in's house, and the past-house gate holds a draft that names it. "You
have the thread" was already bounded: 3 days after your last hand reply
(`PERSON_HAS_IT_DAYS`).

**An open offer never holds a silent agent (2026-10-16).** `openOfferIdle`
(shared/agent-pulse.js) lets the agent go to the check-in when the offer's
nudge, push or passed-house clock hasn't fired once in `SILENT_OPEN_DAYS` (14)
— since its last step, or since our number went out — and nobody has texted
either way in that time. A pause with a date, a person on the thread, or a
clock that is firing still holds them. Found on an agent texted 377K in a plain
reply: "that won't work", our ask for their number, then 15 days of nothing
while "an open offer" held him and no nudge ever went.

### How often they asked, and when to stop asking (2026-10-14)

Reading 2,014 threads turned up agents who told us how often to check in,
and we kept the 21-day clock anyway: "check in no more than every 2–3
months" (texted a month later), "check back in a couple months" (texted
three weeks later, then two weeks after that), "you are on my email list so
you don't need to check in", "I have enough wholesalers". The address chase
kept asking after "please don't keep asking me". Brokerage auto-replies
(Redfin, the eXp desk) read as the agent writing back. The pure detectors
are in `shared/brush-offs.js`.

- **Cadence.** `cadenceRequest(text)` reads an agent's own text into days:
  - "every 2–3 months" is 75; "check back in a couple months" is 60; "a few
    months" is 90; "once a month" is 30;
  - "you're on my email list" or "don't need to check in" is 90;
  - "enough wholesalers", "too far apart to remain in contact", "don't work
    with wholesalers" or "pocket listings are illegal" is 120.

  The reply agent stores it as the fact `checkinEvery` (agent only, newest
  wins, app-only, no GHL field; you can edit or remove it in the drawer).
  The agent check-in waits at least that long for every kind of check-in,
  a fresh listing of theirs included, and the plan's reason reads "they
  asked for a check-in every N days". The same text never starts the weekly
  "I'll send you deals" chain, and the check-in sweep ends a running chain
  once the fact is there. It also never books the two-morning clock under a
  held reply.
- **"Check back in N months"** also books a dated check-in that far out
  (`checkin_requested`, kind `date`). A request now stands until 45 days
  after it was made, or two weeks past its due date, whichever is later
  (`requestStands`). The sweep reads requests up to `CHECKIN_LONGEST_DAYS`
  back.
- **The address chase stops on a no.** `refusesAddress(text)` covers "please
  don't keep asking", "you can see them when they're on the market", "I can't
  give the address until it lists", "can't share that", a bare "no" or "not
  yet", and "no, I'll tell you when". When their newest text since the chase
  started is one of these, the chase is closed (`address_pending_closed`,
  `reason: they_refused`, with `why`). A no that goes on with a lead is not a
  refusal. The chase also never starts on a text that refuses, or on land
  ("I still have a vacant lot", `notAHouse`): that closes with
  `reason: not_a_house`.
- **Auto-replies aren't replies.** `isAutoReply(text)` covers:
  - Redfin's "different number for texting" and the eXp desk menu;
  - "Thank you for your message, we will get back to you shortly";
  - out of office, Driving Focus, and a brokerage's SMS opt-in or CRM text.

  `startReply` drops these before anything runs. Nothing is drafted and no
  text summary is written, so the unanswered count doesn't reset, nothing
  waits on you, and no check-in is booked. `reply_not_needed` with
  `intent: auto_reply` settles it for the nightly audit, which also drops
  one on its own ("an auto-reply, not a person"). When the auto-reply names
  another number (`autoReplyNumber`), a `texts_elsewhere` event puts "Their
  texts go to another number" on Today, with the number. Update the contact
  in GHL or call, then dismiss it. The row clears after 30 days or when they
  text for real. The number goes only in the event and on the row, never in
  a log line.

No switch: these only make the machine text less.

**Agents who wrote back join it (2026-10-14).** Of the 1,049 agents we had
texted who sat outside the pool, 104 had replied at least once. They had no
profile, offer, card or fresh listing, so nothing would ever text them again.
Matt: all of them go into the check-in.
- **Who.** `loadPulseAgents` adds anyone with a reply on the timeline
  (`store.lastContactActivity`, inbound only), if we know they're an agent:
  - the reply was filed as an agent's;
  - or we imported them from the outreach pull;
  - or their timeline has our opener.

  A buyer or an unknown caller never joins. They come in as engaged, and
  opt-outs, stops, annoyed replies and the runner's GHL check (DND, tags)
  apply as for everyone.
- **Spread, not one burst.** Their last word is weeks old, so they would all
  be due the morning they join. Instead each agent's first check-in falls on
  their own weekday (Pacific) within `everyDays` of joining
  (`firstCheckInAt`, picked from their contact id). Weekends are skipped
  because the run is weekdays only. This applies only to the first check-in.
  Once they've been checked in on, or anyone has talked since, the normal
  clock takes over. A fresh listing of theirs waits for their day too.
- **The day they joined.** A replier who joins by their reply counts from
  today in every plan and preview until a real run writes it down. The first
  real run (`startAgentPulse`, not a dry run) records `agent_pulse_joined`
  for every such replier, picked or not, with `at` = now and dedupe key
  `agent_pulse_joined:<id>`. Later plans read their day from that event, so
  the spread holds from whenever the change first runs. The backfill below
  counts from the day it runs (`data.joinedAt` on its marker).
- **The backfill, once.** Many of the 104 answered a GHL workflow text
  before the app read inbound texts, so the app has no reply on record for
  them. `ghl-broker/scripts/backfill-replier-profiles.mjs`
  (`ghl-broker/replier-backfill.js`) reads the GHL thread of every outreach
  agent who isn't in the pool and isn't a buyer, three at a time. It sorts
  each one (`classifyReplierThread`):
  - **replied:** gets an agent profile and their last word on the timeline
    (a `text_summary`, or a `call_summary` for a call, with source `backfill`
    and dedupe key `replier_backfill:<id>`);
  - **opted out:** STOP, wrong number, "take me off", a stop at the end of a
    short text, SMS DND or a do-not-text tag. These are marked through
    `markUnsubscribed`, which adds the `unsubscribed` tag and event;
  - **left alone:** auto-replies only (a "Do Not Disturb While Driving"
    reply, or a brokerage desk line) and annoyed replies.

  A replay over the saved 2026-10-14 threads found 72 replied, 31 opted out
  and 2 auto-replies.

  Run it from `ghl-broker/` with `DATABASE_URL`, `GHL_TOKEN` and
  `GHL_LOCATION_ID` set; the broker's Render Shell has all three. Run it
  after the deploy that carries it:
  1. `node scripts/backfill-replier-profiles.mjs` is the dry run, and the
     default. It reads only and prints counts only: no names, phones or
     words. Check that the opted-out count holds the stops.
  2. `node scripts/backfill-replier-profiles.mjs --write` writes.
     `--limit N` runs a slice first.

  It's safe to run again: written contacts are in the pool and get skipped.
  Afterwards, `GET /api/outreach/pulse?agents=1` should show the engaged pool
  up by about 70, with their `dueAt` spread over the next `everyDays`.

**Repliers the pool already has (2026-10-16).** The 10/16 audit found 59+
agents IN the pool, sorted "cold" because the app had no reply from them,
who had written back in GHL (mostly to the old workflow texts in August and
September). Cold agents hear from us only about a fresh listing, so they
went months without a touch.
- **What.** `includePool` on the backfill also reads every pool agent with
  no reply on their timeline or drafts, no offer only their answer could
  have moved, and no stop (`poolNeverReplied`). A reply in GHL gets the same
  last-word marker, so they become engaged and join the regular check-in;
  an opt-out goes through `markUnsubscribed`. Auto-replies and annoyed
  replies are left alone. A reply found in their drafts is counted
  (`pool.hadReply`) and not read from GHL.
- **Spread.** Their first check-in is spread over `everyDays` from the run,
  like every joiner. A listing ping we sent them while they were cold (a
  ledger event with `data.segment: "cold"`, before the join) doesn't count as
  being on the clock, so it doesn't make them due all at once.
- **Running it, without the Render Shell.** `POST
  /api/outreach/repliers/backfill {dryRun = true, includePool = true,
  limit}` starts it as an in-memory job (one at a time, 409 otherwise),
  three GHL threads at a time and paced, as the script reads them. `GET
  /api/outreach/repliers/backfill` has `progress` while it reads and
  `result` when done: counts by class (`kinds`, `why`, `pool.kinds`,
  `written`), never a name, phone or word. Run the dry run first and check
  that `pool.kinds.opted_out` holds the stops; then `{dryRun: false}`. A
  `limit` reads a slice (the agents outside the pool first). The script
  takes `--include-pool` too. Reruns are safe. No switch: it runs only when
  asked.
- **Check.** `GET /api/outreach/pulse?agents=1`: the engaged count up by
  about `written.markers`, their `dueAt` spread over the next `everyDays`.

### The daily sweep (outreach autopilot)

Settings → Agent Outreach → "Run outreach every day on its own". Once a
weekday (the `OUTREACH_SWEEP_HOUR` hour in Pacific time, default 10 = 10–11am,
on the broker's 15-minute tick, `job_cursors` row `outreach`; untick "Weekdays
only" for every day) the broker pulls — with a county list, the counties in
turn from where the last run stopped (`job_cursors` row `outreachPages`), filtered at RentCast
to listings at least 45 days old of the chosen property types, with requests
spread over the billing month to the plan's number (below) — picks the most distressed
agents nobody has talked to (status new, no GHL match, a phone, at least one
distressed listing unless you untick that), imports up to the daily cap
(default 12, max 500), and says hello the configured way.

The follow-up (`outreach-followup.js`, `OUTREACH_FOLLOWUP_HOUR`, default 11am
Pacific, row `outreachFollowUp`) puts agents enrolled by the "GHL workflow"
first touch who haven't answered in N days (default 14) into the follow-up
workflow. It needs `conversations.readonly` to see who wrote back.

**The listing says it needs work (2026-10-17).** Matt: "we're simply
reaching out on a listing that has distress signals … double-check that it
has distress signals." The 10/16 run texted 375 agents off RentCast's numbers
alone (a price cut, or built before 1980), and the answers were "move in
ready", "new construction", "it's pending", "did you look at the listing?".
With `outreachAutopilot.distressCheck.enabled` (off by default; `perRun`
default 200, max 600 lookups) the sweep reads each picked agent's listing on
Zillow (`deps.screenListings` → `fetchZillowListings`, 40 to an actor run,
about a fifth of a cent each) in the pick's order, until it has 1.2 × the
day's number or the lookups are spent, and keeps only listings still for
sale whose remarks say they need work (`shared/listing-distress.js`: a
strong word like fixer, TLC, as-is, estate, contractor special; or a soft
one like dated, make it your own, with nothing saying remodeled, move-in
ready, turnkey or new). Built in the last ten years is out whatever it says.
No remarks, or Zillow can't find it, is out. What Zillow said is remembered
30 days on the `outreachScreen` cursor, so a listing isn't bought twice. A
failed lookup texts nobody it would have checked. `last.screen` has the
counts (`checked`, `remembered`, `kept`, `dropped` by reason, `waiting`).
The off-market seats keep their own Zillow status check.

**Day 2, then every 14 days, and an intro email (2026-10-20).** The
cold-agent ladder (`outreach_nudge`) defaults to `steps [2]`, `repeatEvery
14`: follow-up 1 on day 2 is Matt's "following up on my earlier message …
the uglier the better" text (`opener.followUps[0]`), and each repeat after
it is a check-in from `outreachAutopilot.opener.checkIns`, the next one
along each time (`repeatN` on the descriptor). Before this a repeat rung
read as step 1 and resent follow-up 1. Repeats end with the sweep's 60-day
window (`OUTREACH_NUDGE_WINDOW_DAYS`), so the last is day 58. A saved ladder
is kept as saved: the live one is set on Autopilot → Agents. The intro
email (`outreachAutopilot.introEmail`: `enabled`, `autoSend`, `day` 2,
`subject`, `body`; off by default) runs at the end of the morning follow-up
sweep (`ghl-broker/outreach-email.js`): an agent the app first-texted
`day` to `day + 5` days ago, with no reply, offer or deal since and an email
in GHL that hasn't opted out, gets one email draft (`outbound.kind
"outreach_email"`, channel email), claimed by an `outreach_email_queued`
event (dedupe `outreach_email:<contactId>`, once ever). It's scheduled
across the machine hours when `autoSend` is on and the broker may send,
otherwise it waits in the outbox. The send goes through `sendReplyDraft`
with every guard a text has. `job.emailed` and the job's rows say what it did.
An email also goes with each 14-day check-in (`outreachAutopilot.checkInEmail`:
`enabled`, `autoSend`, `emails` [{subject, body}]; off by default; four short
lowercase-subject defaults). Same sweep, after the intro emails
(`runCheckInEmails`): only to agents with an `outreach_email_queued` since
their first text, no reply since, on a repeat rung's day (up to 3 days late,
never past the 60-day window), claimed by `checkin_email_queued` (dedupe
`checkin_email:<contactId>:<step>`). Kind `checkin_email`; the next email
in the list each time, starting from the contact's variant.

**The texts are Matt's own (2026-10-17).** The first text, its 14-day
follow-up (`outreach_nudge`) and the plain agent check-in are fixed texts in
his voice, filled in (`shared/standard-texts.js`), not written by the model:
modelled on the Brenda and Rigo threads that became deals. First text:
"Hi Brenda, saw your listing at 14820 SE 172nd St. I'm local and fix up
houses. Is it a bit of a project, or pretty turnkey? If you've got other
fixers on your radar, I'm all ears." Which text an agent gets follows its
variant or contact id. The first-text set is `outreachAutopilot.opener.examples`
(blanks `{first}`, `{address}` = number and street, `{street}`, `{town}`,
`{county}`); `opener.mode` `"ai"` goes back to the model writing each one
(the 10/16 "plain" voice). The nudge and check-in sets are in code;
`outreachAutopilot.pulse.mode` `"ai"` goes back to the model for check-ins.
The model still writes the turnkey and off-market seats, a check-in about a
house they mentioned, the deal-thanks, the off-market listing ping and
Matt's 15. A sent first text records `style: "standard"` and
`standard: { set, index }` on the draft's outbound. The pass after a "too
nice" answer (`QUALIFY_PASSES`) is a thanks plus their other fixers, with no
list of what we buy.

**The run fills the day (2026-10-02).** A run used to stop at the first
county that yielded anyone: Pierce gave up one new agent and the day was over
with requests unspent. Now a run reads county after county, each at most
once, while it has requests left and fewer picks than 1.5 × the daily cap
(room for the agents the import finds already in GHL). Each county's agents
import into that county's own batch ("Autopilot · Pierce, WA"), the day's
cap shared across them; an agent with listings in two counties is picked in
the first. A run stops before a pull, not after one, once its requests are
spent. The turn stays on the first county left with pages and people in it;
otherwise it passes to the county after the last one read. A run stamps
`run.beatAt` on the cursor after every pull and import, and a stale run is
measured from the last beat, so a long run isn't retried while it works.
`last.tried` lists up to 12 counties with their pick counts.

**The whole state in one read (2026-10-02).** Settings → Agent Outreach →
"How to read them" (`outreachAutopilot.coverage`, default `"counties"`).
`"statewide"` asks RentCast for the counties' state (`state=WA`, no circle),
paged from the `statewide` place on the `outreachPages` cursor, and files each
listing under the county it names when that county is on the list
(`listingInCounty`); the rest of the state is dropped. Each county's agents
are ingested into its own "Autopilot · King, WA" batch, so Found attribution
on Flow is unchanged. "Cheap" is measured against the listing's ZIP median
when the ZIP has 15+ priced listings in the read, else its county's
(`medianIndex` in outreach-score.js) — never one median for the whole read.
One pull record carries the requests. A resumed lap starts 50 listings
before the saved place (`STATEWIDE_STEP_BACK`) because listings come and go
overnight; rows are keyed by listing and agent, so nothing is added twice. A
lap read to the end starts over the next run. Sweep pulls refresh agents'
last-message dates weekly, like the GHL match; the pull cache holds at most
40,000 listings all together. `runPull` was split into `fetchListings` and
`ingestCohort` for this; the button's pulls are unchanged.

**Who the pick can reach (2026-10-02).** The pick reads
`store.listOutreachPickable`: rows that are new, not in GHL (no contact id,
no `doc.ghl.contactId`), have a phone, and aren't imported, skipped or matched
under the same agent key in any other batch — most distressed first. It used
to read the newest 1,000 "new" rows, which agents already in GHL and agents
with no phone (both stay "new" forever) could fill. One phone is one person:
two rows with the same phone are picked once a run.

A pull fills a blank phone from what we already hold
(`store.findOutreachPhones`): the same agent key in another pull, or the same
name at the same office when no one else in the pull shares that name there.
The row carries `doc.phoneFrom` ("another pull" / "name and office"), and a
filled phone is never a source for another fill. The office's own phone
(`officePhone`) is never used for texting. GHL is asked about an agent once a
week (`GHL_RECHECK_DAYS`), not on every pull, and never about one with no
phone; the import still asks again, one at a time, before it creates anyone.

**A phone from Zillow (2026-10-02, off by default).** Settings → Agent
Outreach → "Find a phone on Zillow for agents RentCast has none for"
(`outreachAutopilot.zillowLookup {enabled, perRun 25}`). On the sweep's pulls
only, after the cross-fill, agents still without a phone have their hook
listing read by the Apify Zillow detail actor (`fetchZillowAgentContacts` in
rehab-scan.js, `apifyToken` from Settings, ~$0.002 a listing, at most
`perRun` per pull — one budget across a statewide pull's counties). The phone
is kept only when Zillow's agent has our agent's last name
(`sameLastName`); an email is filled only when we had none. The row carries
`phoneFrom: "zillow"`. The Zillow field names (`attributionInfo.agentName /
agentPhoneNumber / agentEmail`) were not checked against a live row when this
was built: before turning it on, `POST /api/outreach/zillow-agents/preview
{limit}` runs it on up to five no-phone agents and returns only which fields
came back and yes/no flags — never a name or a number.

**The RentCast meter (2026-10-02).** Matt moved RentCast to the Foundation
plan (1,000 requests a month) to find more agents. A run may spend what's
left of the billing month, less the reserve, divided by the workdays left —
at least one, at most `MAX_REQUESTS_PER_RUN` (40). The month is counted
from `cycleDay` in Pacific time and is summed by the store
(`sumOutreachRequests`, every pull since the cycle began); it used to read
the newest 200 pulls and undercount. The Pull button stays at ten requests a
press. `GET /api/outreach/autopilot` returns `budget {used, budget, reserve,
runsLeft, perRun, since}`; the Agents page meter reads the same numbers.

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

**The GHL workflow's cohort gets the app's follow-up (2026-10-16, off by
default).** Agents whose first text came from the GHL workflow (before
2026-10-04) carry an `outreach_enrolled` (kind `first`), not an
`outreach_sent`, so the ladder above never counted them. Their follow-up was
the GHL follow-up workflow's, and on 10/16 195 of them who never answered had
heard nothing in 15 to 45 days (about 73 workflow texts had gone out since
10/1 in all). `outreachAutopilot.nudgeGhlCohort` (default false) puts them on
the same "Reached out, no reply" ladder (`ghlCohortCandidates` in
follow-up-sweep.js):
- **Who.** A GHL first text in the last 60 days, no app first text, no offer,
  realm-yes or deal since, and no text of ours since (a check-in, a hand
  reply, an address chase, another follow-up). Counted from the GHL first
  text; any reply ends it, as for everyone.
- **GHL decides last.** Before a rung is claimed (a dry run too), their GHL
  thread is read (`afterFirstText`). Skipped, unclaimed: they wrote back
  there (a text or a call); GHL sent anything more than 6 hours after the
  first text that wasn't marked failed (the follow-up workflow did deliver,
  or a person texted); no first text in the thread; a thread that can't be
  read.
- **One system.** After the claim and before the draft starts, the contact
  is taken out of `followUpWorkflowId` (best-effort, written down as
  `workflow_left`). The GHL follow-up (`outreach-followup.js`) also skips
  anyone the app already followed up.
- **County.** The nudge names the county of their outreach row's listing
  (`doc.hook.county`), else the batch they were imported into ("Autopilot ·
  Pierce, WA"), and the listing from the enrollment.
- **Turning it on.** `nudgeGhlCohort: true` and `followUpEnabled: false`
  (keep `followUpWorkflowId` set: the removal needs it). The agent check-in
  then stops treating "the outreach follow-up workflow" as their owner.
- **Check.** `POST /api/offers/automations/conversation/follow-ups/run
  {dryRun: true}` (or the morning run), then `GET
  /api/offers/automations/conversation/follow-ups` for the job's `results`:
  rows with `ghl: true` say "would send" with the county, or why they were
  skipped. After a live run, a started row carries `ghlFollowUp: "removed"`,
  and the contact's timeline has the `follow_up_sent` (`outreach_nudge`) and
  a `workflow_left`.

**The app's first text (2026-10-04).** Matt moved the first text from the
agent-smsblast workflow to the app, so each one is written fresh in his voice:
- **Voice.** Settings → Agent Outreach → "How you'd write the first text"
  (`outreachAutopilot.opener.examples`, `shared/outreach-opener.js`). It
  defaults to his workflow template plus three variants. Each agent leads with
  a different example (`variant`, a hash of the contact id).
- **County.** The listing's own county from RentCast (`hook.county`), or else
  the county the sweep was reading. The text names that county and no other
  place. The "Reached out, no reply" nudge names the same county, read from
  `outreach_sent.data.county`.
- **No sign-off.** GHL's Messaging Compliance settings (Phone System →
  Messaging) add "Thanks, Matt" and "No worries if not can stop" to the
  first SMS a contact gets. The bot is told not to write either, and
  `stripSignOff` cuts any sign-off or opt-out line from the end of an
  `outreach_open`/`outreach_nudge` draft anyway. An example containing "can
  stop" is dropped, and a sign-off at the end of an example is cut. The first
  text stays under 200 characters (`OPENER_MAX_CHARS`; it was 250 until
  2026-10-15). A reply that arrives within minutes still
  matches our draft, so it isn't held as a person's thread.
- **Short, one question (2026-10-15).** The funnel review: first texts under
  about 230 characters got 54% replies, longer ones 33–36%, and the required
  other-fixers line cost about 12 points. The defaults are now four examples
  of about 150 characters with one question each and no fixers line, and the
  `outreach_open` rule asks for two short sentences and one question, with the
  county line optional. A turnkey seat is told to say it looks finished and
  ask lightly whether they ever see ones that need work. The fixers ask moves
  to the reply to their first answer. `normalizeOpener` reads a saved list of
  the old defaults (`LEGACY_DEFAULT_OPENER_EXAMPLES`) as unchanged and serves
  the new ones; an old default mixed in with Matt's own is dropped, and so is
  any saved example over 220 characters. An answer to our first text is
  recognised by its sent `outreach_open` draft (`lastLineIsOurFirstText`), not
  the words "came across your listing", which the new texts mostly don't say;
  the phrase still counts for the GHL workflow's template. Check: `POST
  /api/outreach/opener/preview` gives three samples, each at most 200
  characters, none asking for other fixers.
- **Plain, like a person (2026-10-16).** Matt: "the first text to agents look
  slightly spammy, can we make them more approachable and like a human". The
  day's batch read like a mass text: a remark about the house ("dates back to
  the 60s, always curious what's behind those walls", "surprised it's been
  sitting"), "I flip houses around Whatcom County", the full street address,
  and "project or pretty turnkey?" on most. Now the `outreach_open` rule asks
  for the street by name without the house number (`streetName`), the town
  at most (no county or region), a few plain words about who we are ("I fix
  up older homes locally"), and one plain question ("does it need much work,
  or is it pretty move-in ready?"). Nothing about the house itself, no
  compliments, no jokes, "fix up" or "renovate" rather than "flip".
  `OPENER_MAX_CHARS` is 160 (the plain text is about 120). The opening moves
  and the who-we-are lines still vary per agent; `WHAT TO NOTICE` and the
  humour line are gone (`outbound.notice` is always ""). New defaults; the
  2026-10-15 set (`PREVIOUS_DEFAULT_OPENER_EXAMPLES`) saved word for word
  reads as unchanged. "good bones" and "soft spot" join the overused phrases,
  and no opening move may say "caught my eye" any more. A cold agent's
  fresh-listing check-in gets the same plain voice. The draft and
  `outreach_sent` carry `style: "plain"`, so replies can be compared with the
  texts before. No switch: it is how the first text is written.
- **Redrafting held first texts (2026-10-16).** `POST
  /api/outreach/autopilot/first-texts/restyle {dryRun = true, since, limit}`
  (`restyleFirstTexts`): every first text you held before it went (flag "held
  by you", written since `since`, default the last day) is put aside —
  dismissed, `dismissedBy: "restyle"`, flag "restyled — not sent", which the
  coach reads as the machine binning it, not you — and the agent's first text
  starts again about the same listing through `openFirstText`. Never an agent
  with an `outreach_sent`, nor a draft held for another reason. A restyled
  draft doesn't count as the agent having a draft, so one whose new text a
  restart drops is found by the lost path of `retryFirstTexts`. These are
  drafted directly (`subject.direct`), not through the Batch API: you held them
  to send today, and a batch round can take 15 minutes for each rewrite. They
  still run on the machine lane, 24 at a time. Check: the dry run lists who.
- **Nobody is created and left untexted.** Before importing, the sweep asks how
  many machine drafts the Conversation AI's daily cap still allows after the
  reply reserve (`machineRoomToday`), and lowers the day's number to fit. A
  first text that is refused, fails, or is held with no draft is written down
  as `outreach_open_skipped`. The next sweep retries it before pulling anyone
  new, up to 3 times within 7 days (`retryFirstTexts`).
- **Personality (2026-10-05).** The bot gets the listing's town, the decade
  it was built, its beds and size, whether it's on a big lot, whether it has
  sat a while or had its price cut, and whether the agent has other listings
  out (`houseDetails`). It works ONE of these in so the agent can tell somebody
  looked. A light touch of humour about what we like is allowed, never at the
  house's expense. The examples show his range ("the uglier the better",
  original kitchens). Prices and days-on-market counts are never named.
- **Lost first texts.** A deploy restart drops first texts still queued in
  memory without recording a skip. The retry also picks up any contact the
  app created to text (`import` event with `openWith: "app"`) more than 2
  hours ago that has no draft of any kind.
- **Which first text went (2026-10-15).** `openerPlan(o)` in
  `conversation-prompt.js` makes every per-agent choice from `variant`: the
  lead example, the opening move, the way we say who we are and the one detail
  to notice. The prompt is built from it. The draft's `outbound` keeps
  `variant`, `move` (index into `OPENING_MOVES`), `who` (index into
  `WHO_WE_ARE`), `notice`, `turnkey` and `examplesHash` (which saved examples
  it was written from). The `outreach_sent` event adds `variant`,
  `openingMove`, `turnkey`, `chars` (the length that went) and `edited` (a
  person changed it). No switch. Check: an `outreach_sent` event's `data` on
  any agent texted after the deploy.
- **Agents nobody ever texted (2026-10-15, off by default).** New-agent
  supply fell from 125 a day to 2. `outreachAutopilot.neverTexted {enabled:
  false}`: inside the same daily room, after the retries, `retryFirstTexts`
  gives the first text to imported agents a pull saw in the last 3 days
  (`store.listNeverTextedOutreach`, both backends: status `imported`, a
  contact id, no `doc.ghl.lastMessageAt`). It skips anyone with
  `outreach_sent`, `outreach_enrolled`, an `outreach_open_skipped`,
  `agent_pulse_texted`, `hand_reply`, a text or call summary, a follow-up,
  check-in or address-chase text, an unsubscribe, the GHL trigger tag
  (`tag_added agent-outreach`), or any reply draft. It also skips anyone the
  app created to text, which the lost path covers. The hook is their current
  listing from the latest pull (`firstTextHook`). Each is claimed first with
  `outreach_open_queued` (one per contact, ever), so no second run starts
  another; one a deploy drops is retried by the lost path. The sweep's cursor
  `last` carries `retried`, `neverTexted` and `opened`. Check: `GET
  /api/outreach/autopilot` → `last.neverTexted` after the 10am run.
- **Listings that came off the market (2026-10-15, off by default).**
  `outreachAutopilot.expired {enabled: false, share: 25}`. Before the regular
  pull, each run reads ONE county (in turn, `outreachPages` cursor
  `expiredTurn`) for RentCast `status=Inactive` listings, which include the
  sold ones (`body.status: "Inactive"` on the pull; `rentcastPage` lets it
  override Active). The listings go into their own batch, "Autopilot ·
  Off-market · King, WA"; the county's own batch would collide on the listing
  key. `keepOffMarket` (routes/outreach.js) keeps only listings with a
  `removedDate` in the last 30 days that didn't sell
  (`offMarketListings`, outreach-score.js):
  - with an Apify token, Zillow's status decides for the freshest 40 (sold,
    pending or back for sale are dropped);
  - otherwise RentCast's history decides, which rarely shows a sale, so
    without a token a sold house can slip through.
  Coming off the market is the distress, so no distress rule applies after
  it. Each listing and hook carries `offMarket` and `removedDate`.
  `share` % of the run's RentCast requests and of the day's new agents go to
  it first (the import's `createLimit` for that batch); the regular pull gets
  the rest, inside the same monthly budget. A new agent's first text is the one
  any listing gets (the standard text, or "does it need much work?"), and
  never says it came off the market: since 2026-10-20 (Matt didn't like "saw
  your listing on … came off the market … is the seller still hoping to
  sell?"). An agent already in GHL is never told about it: since
  2026-10-19 (Matt didn't like "saw the listing on 126th come off the
  market") `freshListingFor` skips off-market listings, so the check-in is
  the ordinary one. The cursor's `last.offMarket` says what the pull found.
  Check: `GET /api/outreach/autopilot` → `last.offMarket`.
- **Samples.** "Write 3 sample first texts" under the examples box
  (`POST /api/outreach/opener/preview`) drafts texts for agents waiting in the
  autopilot batches. Nothing is imported, saved or sent.
- **Go-live config.** Set `firstTouch: "app"` and `followUpEnabled: false` (the
  GHL follow-up stands down). Turn on `outreach_open` in the agent playbook and
  put it on the auto-send list. Enable the `outreach_nudge` ladder for the
  14-day follow-up.

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

**Only the deal's own words describe the house (2026-10-05).** The blast on
3511 NE 153rd St said "heavy rehab". Nobody had put that on the deal: the
template turned 200k of repairs on an 849k ARV into a word. Now:
- The only word a blast has for the work is the level Matt picked in the Rehab
  pane's Quick estimate (`snapshot.rehab.bucket`, Light / Medium / Heavy,
  `pickedRehabLevel`). With none picked, the text says nothing about the work,
  because "rehab about 200k" already says it. The "needs work" fallback is gone too.
- The kind of house, septic and "incl. systems" stay. They are facts from the
  record.
- The bot's deal line carries the same words as `in our words: heavy rehab,
  "<headline>"` (`conversation-context.js`). FACTS tells it to describe a house
  only in the context's words or the buyer's own.
- The backstop is `houseWordsIn` (`shared/conversation-ai.js`), run in
  `evaluateReplyGates` on every buyer draft. A condition word ("heavy rehab",
  "gut job", "ugly", "cleanup", "turnkey", "needs work"…) that isn't in the
  deal's words or the buyer's own lines holds the draft. Our own earlier texts
  don't count, so an old blast is no licence. A machine-started text is
  redrafted once with the flag, then dropped. "Are you open to heavy rehab?"
  is about the buyer and passes.
- Matching buyers still reads repairs ÷ ARV (`rehabAppetiteFor`), because that
  is ranking, not wording.

**What a buyer may see is exactly the three figures the dataroom shows them:
the buyer price, the ARV and the rehab estimate.** The contract price and the
assignment fee are not in `dealFacts` and must never be — that is asserted in
`shared/blast-text.test.mjs`.

### Soft commit — "I think I have a buyer for this one" (2026-09-16)

A fourth buyer standing on a deal, between Evaluating and Committed. Set it on
the buyer in Deals → open the deal, and **outreach on that deal stops**:

- no new blast (the button, the blast on promote, and the second wave),
- no follow-up to any other buyer (`deal_followup`),
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

### Stop outreach on a deal (2026-10-01)

Deals → open the deal → **Stop outreach** (top right). Matt asked for it on
5232 S Yakima: "stop outreach on this one completely." It is the one stored
switch, `deal.outreachStopped {at, by}`. `dealOutreachPaused` returns
`{status: "stopped"}` for it before anything else, with no contactId, so
**no buyer is let through, the committed one included**:

- no blast, whether from the button, on promote or as a later wave (the wave
  preview says "you stopped outreach");
- no `deal_followup`, no package invite, no walkthrough
  reminder or follow-up. That includes the link owed to a buyer who answers
  a deal text that went without it (`blastLink: "on_reply"`). That link is
  sent as an action while the reply is drafted, so `startReply` checks the
  stop itself and leaves a warning on the draft;
- the bot doesn't bring the deal up to a buyer who isn't already on it or
  blasted (`conversation-context.js`);
- a buyer's reply about it waits for you. The send-time guard in
  `sendReplyDraft` (auto path only) puts it back to a draft. A machine-started
  text about it is dismissed with "you stopped outreach on … — not sent".
  A held reply's `autoSend.reason` reads "needs a person: you stopped
  outreach on …", so the nightly audit doesn't release it again.

Pressing Stop also pulls back what is already queued (`stopDealOutreach` in
`reply-agent.js`, `POST /api/offers/:id/deal/outreach {stopped}`). Buyer texts
whose outbound offerId (or, failing that, street) is this deal are handled
this way:
- the machine's own texts are dismissed;
- a scheduled reply goes back to a draft;
- a reply already waiting for you is left as it is.

The listing agent's thread is not touched. The banner on the deal and the
"outreach stopped" chip on the Deals list say it's on.

**Resume** clears the switch and puts back what Stop pulled (2026-10-04).
On 9311 12th Pl SE, Matt stopped outreach right after making the deal and then
pressed Resume. All 25 first-wave texts stayed dismissed, and `deal.blasts`
still listed those buyers, so the next wave skipped them. Nobody heard about
the deal. Now (`resumeDealOutreach` in `routes/offers.js`, `resumeWave` in
`routes/dispo.js`, `resumePulledBack` in `dispo-autopilot.js`):
- **Which texts come back** (`pulledBackBlasts`): a buyer's `blast_open` for
  this deal comes back when their newest one carries Stop's "you stopped
  outreach on … — not sent" flag and none was ever sent. A text you dismissed
  yourself, or one queued again since, stays as it is.
- **Who gets them:** only buyers the wave rules still pick right now
  (`matchForDeal` without the already-sent exclusion). A buyer
  who is on the deal (passed included), unsubscribed, committed to another
  deal, or who refuses the kind is left out. The response counts them as
  `dropped`.
- **How they go:** they're queued the way a wave is (`queueBlastDrafts`). They
  go out staggered, with the same 10-minute head start as promote, priced as
  each sends, and held for anyone you stopped the bot on. Emails wait in the
  outbox as before.
- **No new send:** it's still the same send. It gets `resumedAt`. The morning
  catch-up looks at the deal again as soon as it's no longer stopped.
- **Stopped before wave 1 existed:** a deal with no wave and no blast tag
  (stopped before the blast on promote ran) gets its first wave on Resume
  (`autoBlastOnPromote`).
- **Not put back:**
  - Nudges. The nudge sweep drafts them again off the `blast_sent` once the
    deal text goes.
  - A reply the stop handed back to you. It stays with you.
- **Only after a real stop:** Resume does this only when the deal was actually
  stopped. A `{stopped: false}` call on a live deal sends nothing.

The pane says what came back: "Outreach is back on: N deal texts queued…, N
waiting for you in the outbox, N buyers left out…".

### A buyer is followed up only after they speak (2026-10-05)

Buck, on 3511 NE 153rd St, never answered the deal. He still got the blast, a
walkthrough invite and, on 10/5, "Last check on this one… I'll leave it". 56
of those "last checks" were queued that morning, every one to a buyer with no
reply that week. Matt: nudge a buyer about a deal only when they showed some
interest, meaning they said something.

- **Retired:** the "Blasted, no reply" (`blast_nudge`, days 2/6) and "Opened the
  package, went quiet" (`dataroom_nudge`, days 1/4) ladders. Neither is offered
  in Settings, on the dial or by the sweep any more, and their saved ladders are
  dropped on the next save. Old rows still render and can be sent or dismissed
  by hand.
- **In their place is one follow-up, `deal_followup`** ("Spoke up on a deal,
  then went quiet").
  - **Trigger:** `investor_evaluating`, which is written when a reply about the
    deal is filed (`dealReplyFiling`: a question, interested, price, a call, a
    walkthrough, wanting it) or when you mark them evaluating.
  - **When:** `steps[0]` days (3) after their last word, once, ever, per house.
    The sweep keeps only the first day whatever is saved, so there is no ladder
    and no "last check".
  - **Skipped when:** they passed or committed on it, are soft-committed, the deal
    is over, or outreach on it is paused or stopped.
  - **Off by default** (new automation). Settings → Playbooks → Following up →
    Buyers, or the dial at Normal / Full.
- A buyer who never answered, or only opened the package, hears from us about
  **what fits them** (the pulse), not about that house again.
- **A link preview is not an open.** The page still renders for iMessage,
  Google Messages, WhatsApp, Slack and other bots, but `viewCount` and
  `dataroom_viewed` count people only. The access log records the bot visit as
  `preview` (`isLinkPreview`, `routes/dataroom.js`). On 3511, 19 of 48 "opens"
  came within two minutes of the text.
- Today's `blast_no_opens` row now offers **Find more buyers**, not "Nudge them".

### A buyer hears from us at most once a week (2026-10-05)

Nothing counted texts to one buyer across deals, so Buck got two pulse checks,
the 3511 deal, a walkthrough invite and a "last check" in eleven days. Several
buyers got two different deal texts one to three days apart.
`dispoAutopilot.touchBudget` is **on** and only holds texts back. Rules are in
`shared/buyer-touch.js`, reads in `ghl-broker/buyer-touch.js`.

- **What counts:** sent investor drafts the machine started (`blast_open`,
  `deal_followup`, `buyer_pulse`, `showing_reminder`, `showing_followup`, the
  retired nudges) in the trailing 7 days.
  - Deals sent within 10 minutes of each other count as one.
  - Our answers to their texts and anything a person sends never count.
- **How many:**
  - 1 a week to a buyer who never wrote back (`quietPerWeek`);
  - 2 a week to one we're talking to (`talkingPerWeek`). Talking means a
    text, call, evaluating or commit in the last `talkingDays` (30).
- **A deal text over the limit:**
  - **When a wave is queued:** the buyer keeps their seat. Their text is
    scheduled for when their week opens, with the flag "waits for this buyer's
    weekly limit — goes Tue Oct 7…". The wave's result counts `waiting`.
  - **When it sends** (`sendReplyDraft`, auto path only; a person's Send
    overrides): the limit is checked again, and a text over it goes back to
    `scheduled` at the opening. This also catches texts queued before 10/5.
- **Two deals, one text:** when a deal text goes, up to `bundleMax` − 1 other
  scheduled deal texts to that buyer (other live deals, not stopped, not held
  for another buyer) go in the same text (`bundleMessage`):
  > Hey Buck, got two under contract right now. 3511 NE 153rd St in Lake Forest Park, 3bd 2ba: buyer price 421k, ARV around 849k, rehab about 200k. And 5232 S Yakima Ave in Tacoma, 3bd 1ba: buyer price 261k, ARV around 360k, rehab about 60k. Either one fit what you're buying? Happy to send photos and numbers.
  - The bundle has no link and no walkthrough question. When they answer, the
    link goes for the house they name (`linkOwed` reads `outbound.bundle`).
  - Each deal in it gets its own `blast_sent`, so waves, feedback and Flow see
    it as sent. The other texts become `superseded` with `combinedInto`, flagged
    "went out together with …".
  - The scheduler reads each text again before claiming it, so one taken into
    a bundle earlier in the tick never goes on its own.
- **The pulse and `deal_followup`** skip a buyer whose week is spent. The pulse
  seat goes to the next in line, and the follow-up waits for a later run.
- **Walkthrough reminders and follow-ups** count, but are never held: they go
  to a buyer who booked a time.
- **Emails** to buyers with no phone are not limited or combined. They wait in
  the outbox anyway.
- **A deal text that waits for days stays safe.** A queued text used to wait
  minutes; now it can wait days, so:
  - **Their texts:** a buyer's text about something else doesn't cancel it.
    Only an opt-out does.
  - **Other machine texts:** they never replace it.
  - **Your own text:** if you've texted them since it was queued, it goes back
    to you as a draft ("you've texted them yourself since…") instead of being
    binned.
  - **Walkthroughs:** a walkthrough reminder or follow-up isn't held up behind
    it (`SERVICE_KINDS` in `blockingDraft`).
  - **Combined texts:** each house in one is checked like its own text (a bot
    stop on that house, fell through, stopped, held for another buyer). Each is
    claimed (`sending`, `combinedInto`) before the send and released if the send
    fails or the house is left out.
  - **The scheduler** asks the store only for what's due, longest-due first
    (`listReplyDrafts({ dueBy })`), so deferred texts can't hide one due now.
- **The pulse slowdown** counts pulses that went (`pulse_texted`, written on
  send), not claims. Pulses sent before 10/5 have no such event, so nobody
  starts slowed.
- **`deal_followup`** goes once per house, ever: changing the day, or the
  house turning up by street instead of id, doesn't send a second.
- **Setting:** Settings → Dispositions → Dispositions autopilot → "A buyer
  hears from the machine at most so often".

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

**Blast on promote — everyone who buys there, at once (2026-10-21).** There
are no waves. Matt: VIPs were getting bad deals first, the buyers who buy on
that street waited days or never heard, and the cap of 25 left fitting buyers
out. Now, ten minutes after promote, the deal goes to every buyer who fits its
area (`pickDealBuyers` in `shared/buyer-score.js`), best fit first, one text
every `spreadSec`, inside machine hours. A long list rolls into the next
morning on its own. A buyer fits (`rankParts.areaFit`) when they:
- bought in the deal's city (`bought_city`): a `dispo-city-*` tag, or a
  `property_financed` event in that city (`flips.cities`);
- told us its city or ZIP in their buy box (`said_city`, `said_zip`);
- told us a region that holds it, like "South King" (`said_region`).

A `dispo-region-*` tag with nothing else no longer sends. It is a loan
somewhere in a region of up to 28 cities, so it ranks the buyer but doesn't
send them the deal.
- **No tiers, no cap, no score floor.** VIPs are buyers like the rest. Tier,
  price, recency and engagement only set the order.
- **Still left off:** a buyer whose own buy box rules the deal out (their
  price band, with 10% either side, or a kind of house, rehab level or lot
  they said no to), their dealbreakers, a refused kind, STOP / DND, committed
  to another live deal.
- **Bot-off tags hold a deal text.** A buyer carrying one of the routing
  `botOffTags` ("stop bot", "bot-off") gets their deal text as a draft that
  waits for your Send, the same as Stop on the Bot menu. It's checked when the
  text is queued (`queueBlastDrafts`) and again right before it sends
  (`sendReplyDraft`), so a tag added in between still holds it. Before
  2026-10-21 the tags held only the bot's replies. A mobile home or land deal still goes by who buys that
  kind (see "House type and mobile home buyers" below).
- **The morning catch-up.** The daily dispo sweep (`DISPO_SWEEP_UTC_HOUR`,
  default 17, `job_cursors` row `dispo`) looks at every deal under contract
  that the app has sent at least once, with nobody committed or soft-committed
  and outreach not stopped (`catchUpDue`). It sends to anyone who fits now and
  hasn't had it: a new import, a buy box they just told us. A deal nobody new
  fits sends nothing. Each send is a `deal.blasts[]` entry, with `wave` as its
  running number, so `blastedTo` never sends anyone the same deal twice.
- **The weekly limit.** A deal text no longer waits for the buyer's week
  (`touchBudget.holdDealTexts`, off; Settings → Dispositions). It still counts
  as their machine text that week, so a check-in after it waits.
- **Gone:** `autoBlastCount`, `minMatchScore`, `secondWaveHours`,
  `secondWaveCount`, `secondWaveMinScore`, `maxWaves`. Saved values are
  dropped on the next save. `autoBlastOnPromote` still turns all of it on, and
  ships off.

**Dataroom link on its own.** `suggest_dataroom_invite` stays ask-only. A
separate `send_dataroom_invite` action — which no rule can carry — is
injected by the broker's guard when an investor already evaluating a live
deal (or being linked to it by the same reply) asks for details on it and
their stated buy box fits ≥70%, and the deal has a room. Anything short of
that becomes the usual suggestion with the reason on it. Off by default.

**Assignment on commit.** Marking a buyer committed drafts the assignment
PDF from the deal, the buyer and the company settings (`offer.assignment`),
for review. Off by default.

### Deal parties and the closing checklist (2026-09-29)

The Deals modal has three tabs: **Overview**, **Buyers**, and **Terms & paperwork**. The open tab is kept in `?tab=`.

**Overview** holds two things:
- the closing timeline;
- the deal's parties.

**Parties** (`shared/deal-parties.js`, stored at `offer.deal.parties`) covers five roles: title / escrow, seller's agent, buyer's agent, lender and assignee.
- Each role is picked from GHL (the `ContactSearch` typeahead) or typed in.
- Only what you set is stored. The rest is filled in when the deal is read, and says where it came from:
  - the seller's agent is the offer's contact;
  - the assignee is the committed buyer;
  - title comes from the offer's PSA fields, or from the PSA defaults in Settings.
- The lender is never pre-filled. Settings' PSA lender is ours, and on an assignment the assignee's lender is the one that matters.
- To edit a party, `PATCH /:id/deal { parties: { role: {...} | null } }`. Only the roles you name change, and `null` goes back to the default.
- `AssignmentModal` takes the assignee from `parties.assignee` first.

**The checklist** (`shared/deal-checklist.js`, stored at `offer.deal.checklist.items`) is a soft stage gate.
- Every item has:
  - a gate (`under_contract` / `buyer_found` / `assigned`);
  - an owner (`us` or one of the party roles);
  - a due date. The date comes from a rule relative to the contract date, the inspection date, the closing date, or the day the deal reached that stage. A typed date overrides the rule.
- **The template.** `CHECKLIST_TEMPLATE` is the standard WA assignment list. Promote writes a copy onto the deal. A deal promoted before this change reads the template until its first edit.
- **Editing.** `POST /:id/deal/checklist` changes one item per call. It can tick, re-date, reassign, rename, add a note, `remove`, or `add: { gate, label, owner, due }`.
- **Automatic ticks:**
  - uploading a *Purchase & sale* or *Assignment* document ticks the matching item;
  - marking a buyer's RSVP *attended* ticks the walkthrough item.
- **Moving the deal on.** Moving to a later stage with items still open asks first. It never blocks.

**Today** adds one `closing_task_due` row per live deal, for the most urgent open item, once that item is overdue or due within 2 days.
- Its ops are **Done** (`tick_task`) and **Open the deal**.
- The kind is deliberately not named `deal_*`. `rowTargets` routes any `deal*` kind to the investor pane, and this row belongs in the listing agent's thread.

The Deals table's **Next** column shows the same item, with its due chip and `done/total`.

### Buyer walkthrough (2026-09-29)

The goal of every text to a buyer about a deal under contract is a time they
will walk it. Matt chose one **group window** per house, agreed with the
listing agent, that every blast and reply invites buyers to. Asking commits
nobody, so the machine may ask. A text that **confirms** a buyer's time is a
person's to send: `wants_walkthrough` stays in `NEVER_AUTO`.

- **The shape.** `offer.deal.showing` holds `windows` (up to 3, start/end ISO),
  `access` (`agent` | `lockbox` | `matt`, set per deal, plus a private note),
  `agentAsk` (`none` | `asked` | `confirmed`) and `rsvps` (`interested`,
  `coming`, `cant_make_it`, `attended`, `no_show`). The pure rules live in
  `shared/showing.js`. The offer doc stores it, so there is no schema change.
- **Blasts.** `dispoAutopilot.showings.askInBlast` is on by default because it
  changes copy, not sends. A blast ends on "Walkthrough is Sat Oct 3,
  10am-12pm. Can you make it?", or on "When could you get out to walk it?"
  when no window is set, followed by the package link. `blast-refresh.js`
  reads the question again at send time, so a window set after the blast was
  queued is in every text that hasn't gone out yet.
- **The listing agent.** The live-deal hold keeps the model away from the
  agent on a deal under contract, so the ask is a fixed text written straight
  to the outbox (`outbound.kind: "showing_ask"`, party agent). It asks for a
  day, an hour window, and whether they let buyers in or there's a lockbox.
  There are two ways to send it:
  - press **Ask for a window** in the Deals modal or on the Today row; it
    sends at the next open minute;
  - turn on `dispoAutopilot.showings.askAgentOnPromote` (off by default).

  The agent's answer isn't parsed. You type the window on the deal, and that
  marks the ask `confirmed`.
- **Buyer replies.** The investor context gives every deal under contract its
  window, its access line and this buyer's RSVP. `COMMITMENTS.investor` ("THE
  GOAL IS A WALKTHROUGH") tells the bot to invite them to the exact window and
  never to propose another time. The investor schema's `walkthrough` field
  (`coming` / `cant_make_it` / `interested`) is filed on the deal by
  `deps.recordShowingRsvp` before the notify-only check, whatever happens to
  the reply. A `wants_walkthrough` on a deal we hold is drafted instead of
  notify-only, and the draft waits on Today for you.
- **Today.** `showing_no_window` fires when there's no window and the agent
  hasn't been asked, or 1+ day after asking with no window set.
  `showing_soon` fires when a window starts within 36h, and says who's coming
  and whether access is set.
- **Since built.** The reminder the day before and the "what did you
  think?" after the window are the walkthrough texts below
  (`ghl-broker/showing-sweep.js`, off by default).

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

**Relationship first (2026-10-05).** Matt: reach the buyers who haven't
answered, and ask what fits them, more often and more personally. Don't nudge
them about a house they ignored.
- **It says it's Matt.** The who-line is "It's Matt" / "This is Matt", plus how
  we found them for a Facebook-group buyer.
  - FACTS gains a rule for every reply: when asked "who is this?", the first
    words answer it.
  - Why: Buck's 9/24 "who is this?" was answered at once, but the answer opened
    "Matt, Seattle investor…". `callsThemOurName` read that as calling him Matt
    and held it. The audit's check-in redraft opened the same way and was held
    too, until Matt sent it by hand four days later. The gate is unchanged; the
    bot now introduces itself in the form the gate already passes.
- **After a deal** (`afterDeal`, on; `afterDealDays` 10). A buyer sent a deal
  10–21 days ago who never answered it, nor wrote since, gets a seat right after
  friends.
  - The house is the way in: "guessing Lake Forest Park wasn't your kind of
    house — what is?"
  - It never asks whether they want the house, and never names a number.
  - This replaces the old "blasted, no reply" nudges.
- **Personal clues** (`pulseSubject`, built from the runner's `buyerHistory` read):
  - the last house we sent and how it went;
  - their recorded pass reasons;
  - the record's "about them", "last conversation" and "next action";
  - the buy-box pieces we're missing, so the ask is for the one missing piece;
  - how we found a new buyer;
  - cities ordered by their latest purchase.

  The prompt keeps exactly one real reference (the agent check-in's rule).
- **Matt's voice** is `dispoAutopilot.pulse.voice`, fed in like the agent check-in's.
- **Two unanswered in a row** (`ignoredSlowdown` 2; 0 = off): the next pulse waits
  at least 90 days. They still get deals that fit, under the weekly limit.
- **Settings → Dispositions → Pulse** has Voice, After a deal, the never-replied
  cadence, the preview's new groups, and **Write 3 sample pulse checks**
  (`POST /api/dispo/pulse/preview`: nothing saved or sent).

### The buyer greenhouse (2026-09-29)

The selling side, reviewed as one line: every live deal reaches every buyer who fits it, once, and the buyer pool stays warm between deals. What changed:

**Unsubscribed buyers are never texted.**
- The nightly book sync writes `dnd` onto each buyer from GHL, and an `unsubscribed` event counts too.
- Waves skip DND buyers and buyers with a do-not-text tag (`isBlockedBuyer`).
- The pulse reads the contact from GHL before it claims a buyer. An unsubscribed buyer is marked, skipped, and their seat goes to the next in line (`spares`).

**A pulse that drafts nothing gives the claim back.** It writes `pulse_voided`. The day's cap and the cadence ignore voided claims. A buyer tried today waits for tomorrow, because the day's dedupe key is spent.

**The pulse's reach, and friends first.**
- `GET /api/dispo/pulse` counts show `passWorkdays`: how many workdays one pass through the reachable pool takes at today's cap.
- Optional `quietEveryDays` (30–365) sets the cadence for buyers who never wrote back. It defaults to `everyDays`, so the live setting is unchanged.
- Buyers who have committed on a deal with us get the first seats (`friends`).

**The ranking reads the whole buy box** (`shared/buyer-score.js`; since 2026-10-21 it only sets the order, and `areaFit` decides who gets the deal):
- *Location* matches the deal's city (35), its ZIP (35), or a region the buy box names (22): "South King" buys in Kent, and "King County" spans the county's regions (`regionsForArea`).
- A *box* part adds +10 when type, rehab appetite and lot fit, and −20 when the box rules the deal out.
- A buyer we're talking to gets +8.
- Only committed and soft-committed buyers are kept off another deal's waves. A buyer weighing one deal still hears about the next.

**Waves never repeat.** "Already sent this deal" (`blastedTo`) is the union of:
- `blast_sent` events for the offer;
- GHL-workflow blasts matched by the deal's blast tag or its street;
- anyone on one of the deal's app waves (`deal.blasts[].contactIds`, written from now on);
- and — the one that bit — a `blast_open` draft for the deal still waiting to go.

Before this, wave 2 re-drafted every wave-1 buyer whose text was still sitting in the outbox.

**A third wave** (`maxWaves`) is gone with the rest of the waves (2026-10-21, see "Blast on promote" above). A deal blasted only through a GHL workflow still gets no automatic send.
- `GET /api/dispo/waves/preview?offerId=` shows the deal's sends so far (`sends`), whether the morning catch-up still looks at it or why not (`catchUp`), how many buyers already have it, and who it would go to now (`wouldGet`, each with its `areaFit`). It reads only.

**Buyers looked, nobody's committing.** A Today row, `deal_interest_stalled`, shows when a deal under contract has package opens or a buyer evaluating, nobody soft-committed or committed, and 4 days since the last wave (`INTEREST_STALL_DAYS`). Its op is **Find more buyers**.

**A package on promote.** `dispoAutopilot.dataroomOnPromote` (off) builds the deal's dataroom the moment it's promoted, before any wave. It uses the same builder as the Build button (`buildDataroomForOffer` in `routes/dataroom.js`).
- Either way, a deal still without a live package a day after contract gets a Today row, `deal_no_dataroom`, with a **Build it** button.
- The Today route reads each live deal's rooms. A read that fails counts as having one, so the row never guesses.

**Walkthrough texts** (`ghl-broker/showing-sweep.js`, rules in `shared/showing.js` `showingTouches`):
- `showing_reminder` goes 3–6pm Pacific the afternoon before a window, to each buyer who said they're *coming* to it.
- `showing_followup` goes 2–48 hours after a window, to each buyer who came or said they would: how did it look, do they want it. A no-show, a "can't make it", or a buyer who has since committed, passed or soft-committed gets nothing. A deal somebody is taking texts nobody.
- **How it runs.** Every tick. Each text is its own claim, `showing_reminder_sent` / `showing_followup_sent`, keyed per buyer per window, so it goes once, ever.
  - A buyer with their own text waiting on you is skipped *before* the claim, and the next tick tries again once it's answered.
  - An unsubscribed buyer is marked and skipped.
- **What the model may say.** Both are investor outbound kinds that float nothing. Any number in the draft holds it; the street number and the time don't count as numbers. The prompt may say only what the deal's access lines say about getting in.
- **Switches.** `dispoAutopilot.showings.remindDayBefore`, `.followUpAfter` and `.autoSend`, all off. The texts are drafts until `autoSend` is on, and even then only with `CARD_SENDS_ENABLED` and `DISPO_BLASTS_ENABLED`. They aren't on the playbook grid, and the dial never touches them.
- Confirming a buyer's time is still yours: `wants_walkthrough` stays in `NEVER_AUTO`.
- `GET /api/dispo/showings/preview` lists who is owed a walkthrough text right now, as the tick would see it.

### House type and mobile home buyers (2026-10-01)

1510 Maple Lane, Kent was a 1978 mobile home in a park. The offer had no kind, so the deal had none, and the blast on promote went to 25 Kent flippers as a "3bd 2ba" house. None of the 20 buyers tagged `dispo-type-mobile-home` was in it: the wave needed a city match and a phone, and most of them have neither.

**The kind of house** lives in `shared/asset-type.js`:
- `offer.asset` is `{ type, land, by, at }`. `type` is `sfr`, `multi_family` or `manufactured`. `land` is `park` or `own_lot` and applies to a manufactured home only. `by` is `you` or `underwrite`.
- `assetOf(offer)` reads `offer.asset`, and falls back to Zillow's `homeType` on the underwrite's subject record. A deal older than the field still has a kind.
- A save writes what you picked. Failing that it writes Zillow's word, so the lean rows carry it. A later underwrite never overwrites your pick.
- **Where you set it:**
  - the offer editor's Property card (Property type, then Land for a mobile home);
  - the Deals modal → Overview → Property type;
  - `PATCH /api/offers/:id/asset { type, land }`. `{ type: "" }` hands it back to Zillow.
- Offers and Deals rows show a badge for anything that isn't single family.

**Where it goes:**
- `dealToQuery` puts it in the deal's `propertyTypes`. A deal with no kind still abstains, as before.
- The buy-box vocabulary has `manufactured`. "Mobile home", "single-wide" and "trailer" all file as it.
- The blast text says it ("got 1510 Maple Lane in Kent under contract — mobile home in a park, 3bd 2ba…"). Single family adds nothing, so a house's text is unchanged.
- The buyer package and the public feed show it first.
- The reply bot's deal line leads with it, and a houses-only buy box is never offered a mobile home.
- The Comps pane pulls manufactured comps when the type says so. Without it the pull keeps to houses and drops every manufactured sale.

**Who gets a mobile home** (`buyerTypeFit`, `pickWave({ manufactured })`):
- **Who counts as wanting one:** a buyer with the `dispo-type-mobile-home` tag, or `manufactured` in their buy box, or "manufactured homes only" in their exclusions.
- Location, tier and the score floor don't apply. A buyer with no area on file is in. A buyer whose areas are all elsewhere is out.
- **A stated no keeps a buyer off:**
  - "no mobile homes";
  - "no … park" on a park deal;
  - on a mobile home, a buy-box list of other kinds from someone with no tag.
  - "Manufactured homes only" or "no site-built" keeps that buyer off every house.
  - On a house, a list that leaves the kind out stays the buy box's −20, as before.
- A buyer carrying one of the deal's `blastTags` already has it, whether or not anything else recorded it. The script emails of 9/28 left only the tag.

**Email for buyers with no phone** (`dispoAutopilot.email`):
- **`draft`**, on by default: a buyer in a wave with no phone and an email gets a `channel: "email"` blast draft.
  - Subject: "Mobile home in a park, Kent — under contract, 76k" (`blastSubject`).
  - The body is the same text, rewritten at send time like the texts.
- **`autoSend`**, off by default: emailed deals schedule themselves under the same switches as texts (`CARD_SENDS_ENABLED`, `DISPO_BLASTS_ENABLED`, `blast_open` on the allowlist). Off, they wait in the outbox for you.
- An auto-sent email checks the contact's email opt-out, not SMS.
- `blast_sent` records `channel`.
- A buyer tagged `dispo-source-fb-warei` who has never written back gets "found you through the WA real estate Facebook group" first.

`GET /api/dispo/waves/preview?offerId=` returns the deal's `asset` and each next buyer's `channel`.

### Deals by email, and an email they text reaches GHL (2026-10-15)

Several buyers asked for deals by email (2026-10-15). A buyer with a phone could only be texted one, and an address anyone texted us was used once (the offer `emailTo`) and never reached GHL's email field. Rules are in `shared/contact-email.js`, I/O in `ghl-broker/contact-email.js`.

**Deals by email** (`deals_by` fact, investor, app-only; GHL tag `dispo-deals-by-email` mirrors it):
- **Waves:** text first. `blastChannels` texts a buyer whose `deals_by` is `email` (the record first, the tag when the record has no answer) and also emails them, when we have an address (Matt, 2026-10-15: "default to text first and then email if asked"). No phone: the email alone. No address: the text alone. The email is flagged "they asked for deals by email too — the text goes as well". It goes when the text does, including when the text waits for the weekly limit.
- **It still waits for you.** Emailed deals schedule themselves only with `dispoAutopilot.email.autoSend`, which is off. Emails aren't counted against the weekly touch limit or combined, as before.
- **Turning it on:** the contact drawer's **Deals by email** switch (`POST /api/contacts/:id/deals-by` `{ value: "email" | "text" }`). Off writes `text`, never removes the fact, so a tombstone can't stop them asking again.
- **When a buyer asks** ("email me the details", "by email please", "I prefer email"; `wantsDealsByEmail`, a no to email doesn't count): the switch turns on whoever has the thread. When the bot reads the reply, the deal they're on (the house they named, else the only one they're on) is drafted to them as an email (email only: they already have the text) (`emailDealTo` → `routes/dispo.js emailDealToBuyer`; not a wave, so the deal's `blasts` don't move). The draft carries a warning saying so. With no address on file the warning says to ask for one. The bot's reply can't say it was emailed (`CLAIMS_EMAIL_RX` holds it).
- Only deal texts (`blast_open`) get the email copy. Pulse check-ins, walkthrough texts and `deal_followup` are texts only.

**An email they text** (agents and buyers, every text the reply agent reads, whoever has the thread; never a call):
- **GHL has none:** saved to GHL's email field, the record's profile and their Dispositions row (`email_saved`).
- **GHL has a different one:** replaced when they said it's theirs ("my email is", "email me at", a bare address). Otherwise an `email_offered` event puts a Decide row on Today: "Sam texted an email: …", with **Use it** (`POST /api/contacts/:id/email`).
- **Someone else's** ("my TC at", "her email", anything after cc): never saved, never asked about.
- **Another GHL contact has it** (`findDuplicateContact`): not saved. The Today row says so, with no Use button.
- The row goes when any email is saved for them, after 21 days, or on Dismiss.
- Logs carry the contact id only; an address in a GHL error is blanked.

### A reply about a deal goes on the deal (2026-10-01)

Kenneth Patton asked about 1510 Maple Lane's land lease, its size and its photos, and he was on no deal. There were two reasons:
- Only "wants to walk it" and "wants to buy it" put a buyer on a deal. A question never did.
- While Matt was in the thread, the bot held the reply before reading it, so nothing was filed.

A sweep of the six live deals that day found 12 replies like that.

**Now (`dealReplyFiling` / `heldDealReplyFiling` in `reply-agent.js`, filed by `linkInvestorInterest` in `routes/offers.js`):**
- **When the bot reads the reply:**
  - Interest, a question, a push on price or wanting a call puts the buyer on the deal as **evaluating**.
  - A pass marks them **passed**, with the model's `passReason` on the deal and in its feedback.
  - Walking it or buying it works as before, from anyone, and brings back a buyer who had passed.
  - The playbook's own link or pass action for that reply is dropped, so nothing is written twice.
- **When Matt has the thread** (the bot holds before the model call):
  - A buyer who isn't on the deal yet is added.
  - They go on as **passed** when the words plainly say no (`PASS_RE`, or opening on "no"), otherwise as evaluating.
  - Someone already on the deal is never changed on a guess.
  - A tapback ("Liked “…”") or a bare "ok" files nothing.
- **Which deal:**
  - The house the reply names.
  - Otherwise the live deal mentioned last in the thread. For anything short of walking or buying, that mention must be within 14 days (`DEAL_REPLY_DAYS`).
  - Either way, only for a buyer who was sent a live deal (on it, or carrying its blast tag) or who named one.
- **Never moved:** a committed or soft-committed buyer.
- Being on a deal as evaluating does not quiet the bot. Only a committed buyer holds it (`WORKING_INVESTOR_STATUSES`).

### Rural: two acres or more (2026-10-08)

Matt: "filter out rural properties when we reach out to agents, these are harder to comp and thus investors won't want them. We need to do under 2 acres of land, and make sure we're telling agents that if the property is rural we can't do it and mark as we passed."

- **The rule.** `shared/asset-type.js` is the one definition: `isRuralLot` is true from `RURAL_LOT_SQFT` (2 × 43,560 sqft) up. `ruralHold` returns `rural — it sits on N acres (we buy houses on under 2 acres)`. A house with no lot on record goes ahead, the same way an untyped house does.
- **Outreach.** `ingestCohort` (routes/outreach.js) drops listings whose RentCast `lotSize` is rural from the qualifying pool, and says so in the pull's warnings. An agent whose only qualifying listing is rural is excluded, and a rural listing is never the hook. `listingCount` still counts the agent's whole book. `pickAgentsToImport` also refuses a stored row whose `hook.lotSize` is rural, which covers pulls made before the filter.
- **Underwrite.** Rural is held at the same point as `kindHold`, right after the subject lookup and before comps or photos are bought. Underwrite anyway (`anyKind`) and form fills skip it.
- **Pass.** `triageHeldUnderwrite` retires a rural hold to `we_passed` at the next check, with no 24h wait. The held sweep then sends `kind_pass` with `why: "rural"`: "we can't do rural — our buyers want houses on under 2 acres", and an ask for fixers in town. On the Desk the card reads "Rural: address" (Underwrite anyway / Pass on it). Tier 1 flags it `rural` (sure), and the morning auto-kick takes it off.
- **Bot.** `agentFocusRule` tells the agent bot that we don't buy rural houses, acreage, farms or ranches. When an agent says 2+ acres, the bot says no kindly and doesn't promise numbers. A rural house we priced on purpose is named by `pricedOutsideFocus`, and lean rows carry `subjectLotSqft` for that in both store backends.

### No mobile or manufactured homes (2026-10-13)

Matt: "can we not do manufactured homes as a rule now, lets decline if someone asks if we do them."

- **The rule.** `NEVER_BUY_KINDS = ["manufactured"]` in `shared/asset-type.js`. `normalizeFocusKinds` strips it, so it can't be ticked back on in Settings (the checkbox is gone). `kindHold` holds a mobile home as `not our kind of house — a mobile home (we don't buy mobile or manufactured homes)` whatever `focusKinds` says. `MOBILE_HOLD` matches it, and the older "(single-family only right now)" wording too.
- **Pass.** Like rural, `triageHeldUnderwrite` retires a mobile-home hold to `we_passed` at the next check, with no 24h wait. The held sweep sends `kind_pass` with `why: "manufactured"`: "it's a mobile or manufactured home, and we don't buy those", plus an ask for single-family fixers. Underwrite anyway before then still prices it.
- **Bot.** `agentFocusRule` has a MOBILE HOMES paragraph. If an agent asks whether we buy them, or brings one, the bot says no plainly and kindly, never "maybe" or "send it over", and asks for single-family fixers. A mobile home we priced on purpose is still named by `pricedOutsideFocus`.
- **Outreach.** `ingestCohort` drops `Manufactured` listings whatever type was asked for, with a "no mobile homes: dropped N of M" warning. `pickAgentsToImport` refuses a `Manufactured` hook. `normalizeOutreachAutopilot` drops the type, and the Settings and Agent Outreach pickers no longer offer it.
- **Unchanged.** Selling a mobile home we already hold: the buyer side, `pickWave({ manufactured })`, the mobile-home buyer tags and the Deals modal kind picker.

### Single-family focus (2026-10-01)

Matt: focus the app on single-family residences. Multi-family stays a kind an offer can carry (it will be expanded into later), but it isn't priced on its own yet. Neither are townhouses, condos, mobile homes or land.

- **`settings.focusKinds`** (default `["sfr"]`, `normalizeFocusKinds` in `shared/asset-type.js`) lists the kinds the auto-underwrite prices on its own. Set it in Settings → Auto-underwrite → "Houses the auto-underwrite prices on its own". Multi-family can be ticked there later (mobile/manufactured can't: see No mobile or manufactured homes).
- **The hold** (`kindHold`, `auto-underwrite.js` step 2):
  - It runs right after the subject's Zillow lookup, before the comps and the photo scan are bought.
  - Any `homeType` outside the focus is held as `not our kind of house — a townhouse (single-family only right now)`.
  - A house Zillow can't type goes ahead.
  - A run started from the offer form (`fill`) skips the hold. So does an `anyKind` run, which is what "Underwrite anyway" starts.
- **Today:**
  - The held draft shows as "Not single-family: <address>" with **Pass on it** (drop) and **Underwrite anyway**. That button starts the auto-underwrite again (`POST /automations/underwrite/retry` with `anyKind: true` and `replaceOfferId` set to the held draft). It skips only the kind hold. Every other gate and dedupe still applies, and the result replaces the held draft. The run prices the row's house: like a run from the offer form, it skips the listing-link and thread-referee checks that can move an ordinary run to whatever house the thread moved on to (`addressSource: "anyway"`).
  - The nightly triage calls it a person's call (`shared/held-underwrites.js`) and retires it after 14 quiet days like any hold. Nobody is asked for numbers on it.
- **The agent bot** reads `agentFocusRule` beside its other rules: we buy single-family houses only. A house that is plainly a condo, townhouse, mobile home, multi-family or land gets a kind no and an ask for single-family fixers, never "let me run numbers". The exception is a house outside the focus that we chose to price (`pricedOutsideFocus` in `conversation-context.js`: its current offer has a number and the house isn't passed, withdrawn or gone). The rule names it, and the bot talks numbers on it like any other house.
- **Outreach:** the autopilot's default types are `Single Family` only (`DEFAULT_PROPERTY_TYPES`). The live setting was already that. The Agent Outreach page already defaulted to it.
- **Seeing it:**
  - A **Single family** chip on Offers (removed 2026-10-07: single family is the kind of house, not a stage of an offer; non-SFR rows keep their pill).
  - A **Single family only** toggle on Deals.
  - On Line, a **Single family vs other kinds** card: the funnel by kind, with houses nobody typed in their own column (`kindStats` in `shared/line.js`, built on `funnelBy` in `shared/off-market.js`).
  - Lean list rows carry the kind: stored on the offer, else Zillow's `homeType`. Postgres returns `subjectHomeType` in the lean SQL for that, so older offers sort into it with no backfill.

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
- **The reply agent sends on its own only where the dial and the auto-send
  lists allow** (the intents ticked per party, the gates, `NEVER_AUTO`), and
  only with `CARD_SENDS_ENABLED=true` on the broker; everything else is a
  draft that waits for a person. The webhook needs the same credential as the
  underwriter, drafts are capped per day from the database, and a draft
  naming a dollar figure that isn't in the offer book is flagged before anyone
  sees it. (This line said "never sends on its own" until 2026-10-02 — true
  before auto-send shipped in September.)
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
