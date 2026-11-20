// porchcard-sync.js — our deals, on Matt's Porchcard profile (porchcard.com).
//
// Every live deal with a public deal room goes up as one of Matt's own
// listings, with the room's photos. When the deal closes, the listing is
// switched to closed with the contract price and no ARV or rehab. When it
// falls through, it comes off the profile. What may be published is decided in
// shared/porchcard-listing.js, by the room's own public switches.
//
// Off the 15-minute tick. OFF unless PORCHCARD_SYNC_ENABLED=true, with
// PORCHCARD_ADMIN_KEY and PORCHCARD_LOCATION_ID set. It never texts or emails
// anyone; it only writes to Matt's own Porchcard listings.
//
// Durable state is one job cursor, `porchcardSync`: { links: { [offerId]:
// { key, photoIds, photosDone, fails, failDay } }, run, lastRun, last }. The
// cursor is written before the run; a run still on it and not yet stale is
// left alone; a deal that fails three times in a day waits for tomorrow.
// A listing already on Porchcard for the same house (put up by hand) is
// adopted rather than listed twice; one Matt deleted or hid stays that way.

import { store as defaultStore } from "./store.js";
import { teaserSections } from "./dataroom.js";
import { porchcardListing, porchcardStep, sameListing, PORCHCARD_MAX_PHOTOS } from "./shared/porchcard-listing.js";

export const CURSOR_NAME = "porchcardSync";
const API = "https://www.porchcard.com/api/v1";
const ADMIN_API = "https://www.porchcard.com/api/admin/v1";
const STALE_RUN_MS = 30 * 60 * 1000;
const MAX_DAILY_FAILS = 3;
const MAX_PHOTOS_PER_RUN = 20;
const MAX_PHOTO_BYTES = 2_200_000; // a ~3 MB request once base64'd
const running = new Set();
const iso = (ms) => new Date(ms).toISOString();
const day = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(ms));

/** The switches, read from the environment each time so a test can set them. */
export function porchcardConfig(env = process.env) {
  return {
    enabled: env.PORCHCARD_SYNC_ENABLED === "true",
    key: String(env.PORCHCARD_ADMIN_KEY || "").trim(),
    locationId: String(env.PORCHCARD_LOCATION_ID || "").trim(),
    accountId: String(env.PORCHCARD_ACCOUNT_ID || "").trim(),
  };
}

function client({ key, fetchImpl }) {
  let accountId = "";
  async function call(base, method, path, { body, idem } = {}) {
    for (let i = 0; i < 3; i++) {
      const res = await fetchImpl(base + path, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          ...(accountId && base === API ? { "Porchcard-Account": accountId } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(idem ? { "Idempotency-Key": idem } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 429 && i < 2) {
        await new Promise((r) => setTimeout(r, Math.min(30, Number(res.headers.get("retry-after")) || 5) * 1000));
        continue;
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const e = new Error(`porchcard ${method} ${path.split("?")[0]} ${res.status} ${json?.error?.code || ""} ${json?.error?.field || ""}`.trim());
        e.status = res.status;
        throw e;
      }
      return json;
    }
    throw new Error(`porchcard ${method} ${path} rate limited`);
  }
  return {
    // The admin key works as an agent only with their account id; with none
    // configured, the listings are the key owner's own (Matt's).
    async useAccount(id) { accountId = id || (await call(ADMIN_API, "GET", "/me")).owner?.id || ""; return accountId; },
    listings: async () => ((await call(API, "GET", "/listings")).listings || []).filter((l) => l.source === "own" || l.own),
    create: (fields, offerId) => call(API, "POST", "/listings", { body: fields, idem: `shepflips-deal-${offerId}` }).then((r) => r.listing),
    patch: (key, patch) => call(API, "PATCH", `/listings/${encodeURIComponent(key)}`, { body: patch }).then((r) => r.listing),
    addPhoto: (key, dataUrl, photoId) => call(API, "POST", `/listings/${encodeURIComponent(key)}/photos`, { body: { data: dataUrl }, idem: `shepflips-photo-${photoId}` }),
  };
}

// The room a deal publishes from: the same rule the public deal feed uses —
// active, listed, and never the portfolio or an agent-facing offer page.
async function publicRoom(store, locationId, offerId) {
  const rooms = await store.listDatarooms(locationId, { offerId }).catch(() => []);
  return rooms
    .filter((r) => r?.kind !== "portfolio" && r?.kind !== "offer" && r?.status === "active" && !r?.unlisted)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0] || null;
}

/**
 * runPorchcardSync({ locationId, store, env, deps, now }) → { checked, changed, results }
 *
 * `deps.fetch` stands in for the network in tests.
 */
export async function runPorchcardSync({ locationId, store = defaultStore, env = process.env, deps = {}, now = Date.now() }) {
  const cfg = porchcardConfig(env);
  const out = { checked: 0, changed: 0, results: [] };
  const fetchImpl = deps.fetch || globalThis.fetch;
  const pc = client({ key: cfg.key, fetchImpl });

  const deals = (await store.listDeals(locationId, { limit: 500 })).filter((o) => o?.deal?.stage);
  const cursor = await store.getJobCursor(locationId, CURSOR_NAME).catch(() => null);
  const doc = cursor?.doc || {};
  const links = { ...(doc.links || {}) };
  const save = (extra = {}) => store.setJobCursor(locationId, CURSOR_NAME, { at: iso(now), doc: { ...doc, links, ...extra } });

  // A deal that fell through and never went up needs nothing, nor does one
  // that has failed enough today. Nothing left: no call to Porchcard at all.
  const today = day(now);
  const todo = deals.filter((o) => {
    const link = links[o.id];
    if (link?.failDay === today && (link.fails || 0) >= MAX_DAILY_FAILS) return false;
    if (link?.settled) return false;
    return o.deal.stage !== "fell_through" || (link?.key && !link.hidden);
  });
  if (!todo.length) return out;

  await save({ run: { startedAt: iso(now) } });
  await pc.useAccount(cfg.accountId);
  const remote = await pc.listings();
  let photoBudget = MAX_PHOTOS_PER_RUN;

  for (const offer of todo) {
    out.checked++;
    const room = await publicRoom(store, locationId, offer.id);
    const want = porchcardListing({ offer, room, sections: room ? teaserSections(room) : {} });
    const photos = want.ok && want.photos ? await store.listOfferPhotos(offer.id).catch(() => []) : [];
    const roomPhotoIds = [...photos].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)).map((p) => p.id);
    const note = { offerId: offer.id, address: offer.address || "", did: [] };

    // A deal's steps back to back (adopt or create, then photos), so a new
    // listing doesn't wait a tick for its pictures. Bounded: every step moves
    // the link or the listing on, and there are only so many.
    for (let i = 0; i < 4; i++) {
      const link = links[offer.id] || null;
      const listing = link?.key
        ? remote.find((l) => l.key === link.key) || null
        : remote.find((l) => sameListing(l, room?.snapshot?.property?.address || offer.address)) || null;
      const step = porchcardStep({ want, link, listing, roomPhotoIds });
      if (step.do === "none") {
        if (!note.did.length && (step.reason || want.reason)) note.reason = step.reason || want.reason;
        // Nothing left to do for good: a closed listing with its photos, or a
        // dead deal's listing that's off the profile. Not looked at again.
        if (link?.key && listing && ((want.stage === "closed" && listing.status === "closed" && link.photosDone)
          || (want.stage === "gone" && listing.shown === false))) {
          links[offer.id] = { ...link, settled: true };
          await save({ run: { startedAt: iso(now) } });
        }
        break;
      }
      try {
        if (step.do === "adopt") {
          links[offer.id] = { key: step.key, photoIds: [], photosDone: step.photosDone };
        } else if (step.do === "create") {
          const made = await pc.create(step.fields, offer.id);
          links[offer.id] = { key: made.key, photoIds: [], photosDone: false };
          remote.push({ ...made, photos: [...(made.photos || [])] });
        } else if (step.do === "close") {
          await pc.patch(step.key, step.patch);
          listing.status = "closed";
        } else if (step.do === "hide") {
          await pc.patch(step.key, { shown: false });
          listing.shown = false;
          links[offer.id] = { ...link, hidden: true };
        } else if (step.do === "photos") {
          if (photoBudget <= 0) break;
          const sent = [...(link?.photoIds || [])];
          let full = false;
          let added = 0;
          for (const id of step.photoIds) {
            if (photoBudget <= 0) break;
            const stored = await store.readPhotoBytes(id, "full").catch(() => null)
              || await store.readPhotoBytes(id, "thumb").catch(() => null);
            // A photo with no bytes, or too big to send, is passed over for good.
            if (stored?.bytes && stored.bytes.length <= MAX_PHOTO_BYTES) {
              const dataUrl = `data:${stored.contentType || "image/jpeg"};base64,${Buffer.from(stored.bytes).toString("base64")}`;
              try {
                await pc.addPhoto(step.key, dataUrl, id);
                listing.photos = [...(listing.photos || []), id];
                added++;
              } catch (e) {
                if (e.status === 422) { full = true; break; } // Porchcard's fifteen
                if (e.status !== 400) throw e;               // 400: Porchcard couldn't read it
              }
              photoBudget--;
            }
            sent.push(id);
          }
          // Done when the listing is full or every room photo has had its go;
          // a run that ran out of budget picks up next tick.
          const done = full || listing.photos.length >= PORCHCARD_MAX_PHOTOS || roomPhotoIds.every((id) => sent.includes(id));
          links[offer.id] = { ...link, photoIds: sent, photosDone: done };
          note.photos = (note.photos || 0) + added;
        }
        note.did.push(step.do);
        out.changed++;
        await save({ run: { startedAt: iso(now) } });
      } catch (e) {
        const prev = links[offer.id] || {};
        const fails = prev.failDay === today ? (prev.fails || 0) + 1 : 1;
        links[offer.id] = { ...prev, fails, failDay: today };
        note.error = String(e?.message || e).slice(0, 160);
        await save({ run: { startedAt: iso(now) } });
        break;
      }
    }
    if (note.did.length || note.error) out.results.push(note);
  }

  await save({ run: null, lastRun: iso(now), last: { checked: out.checked, changed: out.changed, errors: out.results.filter((r) => r.error).length } });
  return out;
}

/**
 * maybeRunPorchcardSync({ locationId, store, env, deps, now }) → result | null
 *
 * Off the tick. Nothing unless switched on for this location; never two at
 * once, and a run another broker left on the cursor is waited out until stale.
 */
export async function maybeRunPorchcardSync(args) {
  const { locationId, store = defaultStore, env = process.env, now = Date.now() } = args;
  const cfg = porchcardConfig(env);
  if (!cfg.enabled || !cfg.key || !cfg.locationId || cfg.locationId !== locationId) return null;
  if (running.has(locationId)) return null;
  const cursor = await store.getJobCursor(locationId, CURSOR_NAME).catch(() => null);
  const startedAt = cursor?.doc?.run?.startedAt ? Date.parse(cursor.doc.run.startedAt) : null;
  if (startedAt && now - startedAt < STALE_RUN_MS) return null;
  running.add(locationId);
  try { return await runPorchcardSync({ ...args, store, env, now }); } finally { running.delete(locationId); }
}
