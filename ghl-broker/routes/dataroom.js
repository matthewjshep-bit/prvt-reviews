// routes/dataroom.js — the secure investor dataroom, in two halves.
//
// Operator API (mounted at /api/datarooms, location-gated like every other
// product route):
//   POST   /api/datarooms                      build a room from an offer
//   GET    /api/datarooms?offer_id=            list rooms
//   GET    /api/datarooms/:id                  room + invites + access log
//   PUT    /api/datarooms/:id                  edit sections/notes, refresh snapshot
//   POST   /api/datarooms/:id/revoke           kill (or restore) every link at once
//   DELETE /api/datarooms/:id
//   POST   /api/datarooms/:id/invites          issue a personal link, optionally texting it
//   POST   /api/datarooms/:id/invites/:inviteId/send      text the link
//   POST   /api/datarooms/:id/invites/:inviteId/revoke    kill one link
//   POST   /api/datarooms/:id/invites/:inviteId/reissue   new token, old link dies
//
// Viewer (mounted at /d, no location gate — the token IS the credential):
//   GET    /d/:token                the package
//   GET    /d/:token/file/:kind     stream a document
//
// The one exception to "the token is the credential" is the public deals feed,
// which an external marketing site renders in its own brand:
//   GET    /d/deals.json?location_id=
// It carries no token, so it is gated instead by an explicit env allowlist of
// locations that have chosen to publish. See FEED_LOCATIONS below.
//
// The plaintext link token exists only in the response that creates it. Only
// its hash is stored, so neither this server nor a database dump can rebuild a
// working link — if the operator loses it, they reissue.

import express from "express";
import { store } from "../store.js";
import { effectiveSettings, fmtMoney } from "../shared/offer-calc.js";
import { getContact, sendSms } from "../ghl.js";
import {
  DEFAULT_EXPIRY_DAYS, brandFrom, buildSnapshot, dealCard, feedHeaders, hashToken,
  newToken, normalizeLinks, normalizePublicSections, normalizeSections, photoHeaders,
  renderNotice, renderPortfolio, renderRoom, secureHeaders, teaserSections,
} from "../dataroom.js";

// A location's portfolio is itself a dataroom row — offerId null, kind
// "portfolio" — so it inherits the share token, revocation and view counting
// that deal rooms already have. Its contents are resolved at render time from
// whichever deal rooms are currently active and listed.
const isPortfolio = (room) => room?.kind === "portfolio";
// Agent-facing offer packages (routes/offer-page.js) share this table. They
// carry our underwriting, so they must never be picked up by anything that
// lists or publishes rooms — the portfolio board and the PUBLIC deals feed both
// select through listedInPortfolio, and an offer page passing that filter would
// put our arithmetic on a marketing page. Excluded here, once, at the source.
const isOfferPage = (room) => room?.kind === "offer";
const listedInPortfolio = (room) =>
  !isPortfolio(room) && !isOfferPage(room) && room?.status === "active" && !room?.unlisted;

// The room's own flags say whether the operator wants it published; they say
// nothing about whether the deal is still for sale. A room is built once and
// then outlives the deal — so a property that closed, fell through, or whose
// offer was deleted kept advertising itself on a board titled "Current deals".
// The deal's own stage is the authority, checked at render time rather than
// mirrored onto the room, because a mirror needs every stage change to
// remember to update it and this can't be forgotten.
const DEAD_STAGES = new Set(["closed", "fell_through"]);
// An offer that never became a deal still belongs on the board: the operator
// built the room deliberately, and plenty of properties get shopped to buyers
// while the contract is still being signed.
const stillForSale = (offer) => Boolean(offer) && !DEAD_STAGES.has(offer.deal?.stage);

// Rooms that belong on the public board right now: listed by the operator AND
// backed by a deal that hasn't closed or died. The one place both halves of
// that question are asked, so the board, the teaser and the operator's own
// "listed" count can't disagree.
async function boardRooms(locationId) {
  const listed = (await store.listDatarooms(locationId, { limit: 500 })).filter(listedInPortfolio);
  const out = [];
  // Sequential, like the photo loads below: a primary-key lookup each, against
  // a pool of 8 connections.
  for (const r of listed) {
    if (r.offerId && !stillForSale(await store.getOffer(r.offerId))) continue;
    out.push(r);
  }
  return out;
}

// The shareable marketing link — one per room, no expiry, no recipient.
//
// Its token is deliberately stored in the clear (unlike personal invites,
// which keep only a hash). The operator has to be able to re-copy this link
// whenever they want to post it somewhere, and a link they can't retrieve is
// useless for marketing. The tradeoff is explicit: this one is meant to be
// forwarded, so rotation — not secrecy — is what controls it.
//
// Idempotent, and shared by both routers: the portfolio has to be able to mint
// links for rooms nobody has opened yet, or a freshly built deal would be
// missing from the very page meant to advertise it.
async function ensureShareLink(room) {
  if (room.shareToken) return room;
  const token = newToken();
  await store.createDataroomInvite({
    dataroomId: room.id,
    locationId: room.locationId,
    tokenHash: hashToken(token),
    contactId: null,
    name: null,
    phone: null,
    expiresAt: null,       // marketing links shouldn't die on a timer
    doc: { share: true },
  });
  room.shareToken = token;
  await store.updateDataroom(room.id, room);
  return room;
}

// Every deal that belongs on the public board, newest first, each carrying a
// live share token and its hero photo. The one loader behind both the portfolio
// HTML page and the public JSON feed, so the two can never drift.
//
// Returns COPIES, deliberately. The JSON-file backend hands back live
// references to its in-memory documents, so hanging heroPhoto off the room
// object itself would ride into store.json on the next unrelated persist().
async function loadBoardDeals(locationId) {
  const listed = (await boardRooms(locationId)).filter((r) => r.snapshot);
  const out = [];
  // Sequential on purpose: the pool is 8 connections, so firing every room's
  // photo query at once would only queue them.
  for (const r of listed) {
    // Rooms built before share links existed (or never opened) get one now,
    // rather than being silently dropped from the list. This MUST stay ahead of
    // the photo attach below — ensureShareLink ends in updateDataroom(room.id,
    // room), so minting a token afterwards would persist heroPhoto into the
    // datarooms doc JSONB for real.
    await ensureShareLink(r);
    // Served under each deal's OWN token: the portfolio token can't authorize
    // another room's photo.
    const photos = r.offerId ? await store.listOfferPhotos(r.offerId) : [];
    out.push({ ...r, heroPhoto: photos[0] || null });
  }
  return out;
}

/* ---- public deals feed config ---- */

// Which locations may publish their board as a public JSON feed. Opt-in by
// design: this broker is multi-tenant (GHL_TOKENS is a map of locations), and
// the feed is keyed on a location id rather than on a share token, so without
// this gate every other tenant's board would drop from being protected by a
// 256-bit token to being protected by a guessable identifier.
const FEED_LOCATIONS = new Set(
  (process.env.DATAROOM_FEED_LOCATIONS || "").split(",").map((s) => s.trim()).filter(Boolean)
);

// How long a built board stays memoized in this process. Configurable chiefly
// so the tests can switch it off — with a warm cache, "unlist a deal and check
// it disappears" would fail for a minute and look like a real bug.
const FEED_TTL_MS = (() => {
  const raw = process.env.DATAROOM_FEED_TTL_MS;
  const n = Number(raw);
  return raw && Number.isFinite(n) && n >= 0 ? n : 60_000;
})();

// What the BROWSER may cache, in seconds. Separate from the memo above on
// purpose: that one protects the database, this one protects the network.
const FEED_MAX_AGE = 60;

// Building the board is expensive — listDatarooms pulls the full doc JSONB for
// every room and each doc carries a whole snapshot (up to 24 comps, 60 scope
// lines) — and this endpoint is about to be hit by every homepage visitor and
// every crawler. Memoize the finished JSON string: that skips re-serializing
// and structurally guarantees no live file-backend document is held here.
const feedCache = new Map();

function feedCacheGet(locationId) {
  if (FEED_TTL_MS <= 0) return null;
  const hit = feedCache.get(locationId);
  if (!hit) return null;
  if (Date.now() >= hit.expires) { feedCache.delete(locationId); return null; }
  return hit;
}

function feedCacheSet(locationId, status, body) {
  if (FEED_TTL_MS <= 0) return;
  // Bounded the way the bad-token throttle below is, so probing many location
  // ids can't grow the map without limit.
  if (feedCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of feedCache) if (now >= v.expires) feedCache.delete(k);
  }
  feedCache.set(locationId, { status, body, expires: Date.now() + FEED_TTL_MS });
}

const SENDS_ENABLED = process.env.CARD_SENDS_ENABLED === "true";

const str = (v, max = 200) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
// null/"" must come back as "no timestamp", NOT as epoch 0 — `new Date(null)`
// is 1970, which would make every never-expiring link read as long expired.
const ms = (v) => {
  if (v == null || v === "") return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
};
const expired = (invite) => {
  const t = ms(invite?.expiresAt);
  return t != null && t < Date.now();
};
const expiryFromDays = (days) => {
  const d = Math.min(365, Math.max(1, parseInt(days, 10) || DEFAULT_EXPIRY_DAYS));
  return new Date(Date.now() + d * 24 * 60 * 60 * 1000).toISOString();
};

// What the operator sees for an invite. The token hash never leaves the server
// — publishing it would let anyone who saw it confirm a guessed link offline.
const publicInvite = (i) => ({
  id: i.id,
  contactId: i.contactId,
  name: i.name,
  phone: i.phone,
  status: i.status,
  expiresAt: i.expiresAt,
  expired: expired(i),
  viewCount: i.viewCount || 0,
  firstViewedAt: i.firstViewedAt,
  lastViewedAt: i.lastViewedAt,
  sentAt: i.sentAt,
  createdAt: i.createdAt,
});

/* ============================================================= *
 * Operator API
 * ============================================================= */

export function createDataroomRouter({ resolveLocation, publicBaseUrl }) {
  const router = express.Router();
  const fail = (res, err) => {
    const code = err.http || err.status || 500;
    if (code >= 500) console.error("dataroom error:", code, err.message);
    res.status(code).json({ error: err.message, detail: err.detail });
  };
  const roomLink = (token) => `${publicBaseUrl}/d/${token}`;

  // Load a room and prove it belongs to the caller's location.
  async function loadRoom(req, res) {
    const { locationId, client } = resolveLocation(req);
    const room = await store.getDataroom(req.params.id);
    if (!room || room.locationId !== locationId || isOfferPage(room)) {
      // An offer-page id 404s here exactly like an unknown one: the two
      // features share a table but never each other's routes.
      res.status(404).json({ error: "dataroom not found" });
      return null;
    }
    return { locationId, client, room };
  }

  // The location's portfolio room, created on first use.
  async function ensurePortfolio(locationId) {
    const rooms = await store.listDatarooms(locationId, { limit: 500 });
    const existing = rooms.find(isPortfolio);
    if (existing) return ensureShareLink(existing);
    const created = await store.createDataroom({
      locationId,
      offerId: null,
      address: null,
      status: "active",
      kind: "portfolio",
      snapshot: null,
    });
    return ensureShareLink(created);
  }

  // One link for the whole buyer list: every listed deal on a single page.
  // MUST stay registered before GET /:id or "portfolio" is captured as :id.
  router.get("/portfolio", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const portfolio = await ensurePortfolio(locationId);
      // The same count the board itself renders — closed and fell-through deals
      // drop out of both together.
      const listed = await boardRooms(locationId);
      const invites = await store.listDataroomInvites(portfolio.id);
      const share = invites.find((i) => i.doc?.share && i.status === "active");
      res.json({
        shareLink: roomLink(portfolio.shareToken),
        status: portfolio.status,
        listedCount: listed.length,
        views: share?.viewCount || 0,
        lastViewedAt: share?.lastViewedAt || null,
      });
    } catch (err) { fail(res, err); }
  });

  // Build a room from one offer. The snapshot is frozen here on purpose.
  router.post("/", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const offerId = str(req.body?.offerId, 64);
      if (!offerId) return res.status(400).json({ error: "offerId required" });
      const offer = await store.getOffer(offerId);
      if (!offer || offer.locationId !== locationId) return res.status(404).json({ error: "offer not found" });
      if (offer.status === "draft") return res.status(400).json({ error: "create the offer before building a dataroom" });

      const settings = effectiveSettings(await store.getOfferSettings(locationId));
      const snapshot = buildSnapshot({
        offer, settings,
        sections: req.body?.sections,
        headline: req.body?.headline,
        notes: req.body?.notes,
        links: req.body?.links,
      });
      const room = await store.createDataroom({
        locationId,
        offerId,
        address: offer.address || snapshot.property.address || null,
        status: "active",
        snapshot,
        defaultExpiryDays: Math.min(365, Math.max(1, parseInt(req.body?.expiryDays, 10) || DEFAULT_EXPIRY_DAYS)),
      });
      // Mint the share link now rather than on first open, so the deal is
      // linkable — and shows up on the portfolio — the moment it's built.
      await ensureShareLink(room);
      res.json({ ok: true, dataroom: { ...room, shareLink: roomLink(room.shareToken), invites: [] } });
    } catch (err) { fail(res, err); }
  });

  router.get("/", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const offerId = str(req.query.offer_id, 64);
      const all = await store.listDatarooms(locationId, { offerId: offerId || null });
      // The portfolio isn't a deal, and an agent-facing offer page isn't a
      // dataroom at all — it only shares the table.
      const rooms = all.filter((r) => !isPortfolio(r) && !isOfferPage(r));
      const withCounts = await Promise.all(rooms.map(async (r) => {
        const invites = await store.listDataroomInvites(r.id);
        return {
          id: r.id, offerId: r.offerId, address: r.address, status: r.status,
          createdAt: r.createdAt, updatedAt: r.updatedAt,
          // Personal invites only; the shared link isn't someone we "invited".
          inviteCount: invites.filter((i) => i.status === "active" && !i.doc?.share).length,
          // Views across both kinds of link — the honest "is anyone looking" number.
          viewCount: invites.reduce((t, i) => t + (i.viewCount || 0), 0),
          lastViewedAt: invites.map((i) => i.lastViewedAt).filter(Boolean)
            .sort((a, b) => new Date(b) - new Date(a))[0] || null,
        };
      }));
      res.json({ datarooms: withCounts });
    } catch (err) { fail(res, err); }
  });

  router.get("/:id", async (req, res) => {
    try {
      const ctx = await loadRoom(req, res);
      if (!ctx) return;
      const room = await ensureShareLink(ctx.room);
      const invites = await store.listDataroomInvites(room.id);
      const events = await store.listDataroomEvents(room.id, { limit: 100 });
      const share = invites.find((i) => i.doc?.share && i.status === "active");
      res.json({
        dataroom: {
          ...room,
          shareLink: roomLink(room.shareToken),
          shareViews: share?.viewCount || 0,
          shareLastViewedAt: share?.lastViewedAt || null,
          // The tokenless public page the marketing site links to, and the
          // normalized view of what it shows — locked keys always come back
          // false, so the UI can render the truth rather than the stored doc.
          teaserLink: `${publicBaseUrl}/d/deal/${encodeURIComponent(room.id)}`,
          publicSections: normalizePublicSections(room.publicSections),
          // Personal invites only — the share link is presented on its own.
          invites: invites.filter((i) => !i.doc?.share).map(publicInvite),
        },
        events,
      });
    } catch (err) { fail(res, err); }
  });

  // Rotate the shared link: the old URL dies immediately, a new one takes its
  // place. The move for a link that's been posted somewhere it shouldn't.
  router.post("/:id/share/rotate", async (req, res) => {
    try {
      const ctx = await loadRoom(req, res);
      if (!ctx) return;
      const { room } = ctx;
      for (const old of await store.listDataroomInvites(room.id)) {
        if (old.doc?.share && old.status === "active") {
          await store.updateDataroomInvite(old.id, { status: "revoked" });
        }
      }
      delete room.shareToken;
      await store.updateDataroom(room.id, room);
      const fresh = await ensureShareLink(await store.getDataroom(room.id));
      await store.logDataroomEvent(room.id, null, "share_rotated", {});
      res.json({ ok: true, shareLink: roomLink(fresh.shareToken) });
    } catch (err) { fail(res, err); }
  });

  // Edit the room. `refresh: true` re-reads the offer, so the operator can
  // deliberately push updated numbers to everyone holding a live link.
  router.put("/:id", async (req, res) => {
    try {
      const ctx = await loadRoom(req, res);
      if (!ctx) return;
      const { locationId, room } = ctx;
      const b = req.body || {};
      if (b.refresh) {
        const offer = await store.getOffer(room.offerId);
        if (!offer || offer.locationId !== locationId) {
          return res.status(404).json({ error: "the source offer no longer exists — nothing to refresh from" });
        }
        room.snapshot = buildSnapshot({
          offer,
          settings: effectiveSettings(await store.getOfferSettings(locationId)),
          sections: b.sections ?? room.snapshot?.sections,
          headline: b.headline ?? room.snapshot?.headline,
          notes: b.notes ?? room.snapshot?.notes,
          // Links are the operator's, not the offer's — a refresh rebuilds
          // everything else from the offer but must carry these across.
          links: b.links ?? room.snapshot?.links,
        });
        room.address = offer.address || room.address;
      } else {
        if (b.sections) room.snapshot.sections = normalizeSections(b.sections);
        if (b.headline !== undefined) room.snapshot.headline = str(b.headline, 120);
        if (b.notes !== undefined) room.snapshot.notes = str(b.notes, 2000);
        if (b.links !== undefined) room.snapshot.links = normalizeLinks(b.links);
      }
      // What the tokenless public teaser page may show (documents and the fee
      // breakdown are locked off inside normalizePublicSections).
      if (b.publicSections) room.publicSections = normalizePublicSections(b.publicSections);
      // Hide a deal from the public list without touching its own link.
      if (b.unlisted !== undefined) room.unlisted = Boolean(b.unlisted);
      if (b.expiryDays !== undefined) {
        room.defaultExpiryDays = Math.min(365, Math.max(1, parseInt(b.expiryDays, 10) || DEFAULT_EXPIRY_DAYS));
      }
      const saved = await store.updateDataroom(room.id, room);
      res.json({ ok: true, dataroom: saved });
    } catch (err) { fail(res, err); }
  });

  // Kill every link at once — the panic button. Reversible with { revoked: false }.
  router.post("/:id/revoke", async (req, res) => {
    try {
      const ctx = await loadRoom(req, res);
      if (!ctx) return;
      const revoked = req.body?.revoked !== false;
      ctx.room.status = revoked ? "revoked" : "active";
      const saved = await store.updateDataroom(ctx.room.id, ctx.room);
      await store.logDataroomEvent(ctx.room.id, null, revoked ? "revoked" : "restored", {});
      res.json({ ok: true, dataroom: saved });
    } catch (err) { fail(res, err); }
  });

  router.delete("/:id", async (req, res) => {
    try {
      const ctx = await loadRoom(req, res);
      if (!ctx) return;
      await store.deleteDataroom(ctx.room.id);
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });

  /* ---------- invites ---------- */

  function inviteMessage({ room, invite, token }) {
    const first = (invite.name || "").split(" ")[0] || "there";
    const address = room.address || room.snapshot?.property?.address || "the property";
    const price = room.snapshot?.numbers?.investorPrice;
    return (
      `Hi ${first} — here's the deal package on ${address}` +
      (price > 0 ? ` (${fmtMoney(price)})` : "") + `:\n${roomLink(token)}\n` +
      `This link is yours only and it's tracked — please don't forward it.`
    );
  }

  async function textInvite({ client, room, invite, token, message, dryRun }) {
    // A custom message that forgot the link would send the investor nothing to
    // open, so append it rather than trusting the operator to include it.
    const custom = str(message, 800);
    const body = !custom
      ? inviteMessage({ room, invite, token })
      : custom.includes(roomLink(token)) ? custom : `${custom}\n${roomLink(token)}`;
    const live = dryRun === false && SENDS_ENABLED;
    if (!live) {
      return { dryRun: true, sendsEnabled: SENDS_ENABLED, preview: { to: invite.phone, message: body } };
    }
    const results = {};
    try {
      await sendSms(client, { contactId: invite.contactId, message: body });
      results.link = { ok: true };
    } catch (e) { results.link = { ok: false, error: e.message }; }
    if (results.link?.ok) {
      await store.updateDataroomInvite(invite.id, { sentAt: new Date().toISOString() });
      await store.logDataroomEvent(room.id, invite.id, "sent", { to: invite.phone || null });
    }
    return { sent: Boolean(results.link?.ok), results };
  }

  // Issue a personal link. The plaintext token is in THIS response and nowhere
  // else — after it, only the hash exists.
  router.post("/:id/invites", async (req, res) => {
    try {
      const ctx = await loadRoom(req, res);
      if (!ctx) return;
      const { locationId, client, room } = ctx;
      const b = req.body || {};
      const contactId = str(b.contactId, 64);
      if (!contactId) return res.status(400).json({ error: "contactId required — investors are GHL contacts so the link can be texted" });

      let name = str(b.name, 120);
      let phone = str(b.phone, 40);
      if (!name || !phone) {
        try {
          const c = await getContact(client, contactId);
          name = name || str([c?.firstName, c?.lastName].filter(Boolean).join(" ") || c?.name, 120);
          phone = phone || str(c?.phone, 40);
        } catch { /* the invite still works; sending will report the gap */ }
      }

      const token = newToken();
      const invite = await store.createDataroomInvite({
        dataroomId: room.id,
        locationId,
        tokenHash: hashToken(token),
        contactId, name: name || null, phone: phone || null,
        expiresAt: expiryFromDays(b.expiryDays ?? room.defaultExpiryDays),
      });

      let send = null;
      if (b.send) {
        if (!phone) send = { error: "contact has no phone number" };
        else send = await textInvite({ client, room, invite, token, message: b.message, dryRun: b.dryRun !== false });
      }
      const fresh = await store.getDataroomInvite(invite.id);
      res.json({
        ok: true,
        invite: publicInvite(fresh),
        // Shown once. Copy it now or reissue later.
        link: roomLink(token),
        send,
      });
    } catch (err) { fail(res, err); }
  });

  // Text an already-issued link. The caller passes back the token it was given
  // at creation — the server can't reconstruct it, and verifies the hash
  // matches before sending anything.
  router.post("/:id/invites/:inviteId/send", async (req, res) => {
    try {
      const ctx = await loadRoom(req, res);
      if (!ctx) return;
      const { client, room } = ctx;
      const invite = await store.getDataroomInvite(req.params.inviteId);
      if (!invite || invite.dataroomId !== room.id) return res.status(404).json({ error: "invite not found" });
      if (invite.status !== "active") return res.status(400).json({ error: "this link is revoked — reissue it first" });
      if (!invite.phone) return res.status(400).json({ error: "contact has no phone number" });

      const token = str(req.body?.token, 128);
      if (!token || hashToken(token) !== invite.tokenHash) {
        return res.status(400).json({ error: "link no longer available to send — reissue it to get a fresh one" });
      }
      const send = await textInvite({
        client, room, invite, token, message: req.body?.message, dryRun: req.body?.dryRun !== false,
      });
      res.json({ ok: true, invite: publicInvite(await store.getDataroomInvite(invite.id)), send });
    } catch (err) { fail(res, err); }
  });

  router.post("/:id/invites/:inviteId/revoke", async (req, res) => {
    try {
      const ctx = await loadRoom(req, res);
      if (!ctx) return;
      const invite = await store.getDataroomInvite(req.params.inviteId);
      if (!invite || invite.dataroomId !== ctx.room.id) return res.status(404).json({ error: "invite not found" });
      const revoked = req.body?.revoked !== false;
      const updated = await store.updateDataroomInvite(invite.id, { status: revoked ? "revoked" : "active" });
      await store.logDataroomEvent(ctx.room.id, invite.id, revoked ? "revoked" : "restored", { name: invite.name });
      res.json({ ok: true, invite: publicInvite(updated) });
    } catch (err) { fail(res, err); }
  });

  // Fresh token for the same recipient. The old link stops working the instant
  // this returns — this is the fix for a leaked or lost link.
  router.post("/:id/invites/:inviteId/reissue", async (req, res) => {
    try {
      const ctx = await loadRoom(req, res);
      if (!ctx) return;
      const { client, room } = ctx;
      const invite = await store.getDataroomInvite(req.params.inviteId);
      if (!invite || invite.dataroomId !== room.id) return res.status(404).json({ error: "invite not found" });

      const token = newToken();
      const updated = await store.updateDataroomInvite(invite.id, {
        tokenHash: hashToken(token),
        status: "active",
        expiresAt: expiryFromDays(req.body?.expiryDays ?? room.defaultExpiryDays),
      });
      await store.logDataroomEvent(room.id, invite.id, "reissued", { name: invite.name });

      let send = null;
      if (req.body?.send && updated.phone) {
        send = await textInvite({ client, room, invite: updated, token, message: req.body?.message, dryRun: req.body?.dryRun !== false });
      }
      res.json({ ok: true, invite: publicInvite(await store.getDataroomInvite(invite.id)), link: roomLink(token), send });
    } catch (err) { fail(res, err); }
  });

  return router;
}

/* ============================================================= *
 * Public viewer
 * ============================================================= */

// Cheap in-memory throttle on bad tokens, so nobody can scan the namespace from
// one address. Per-process is enough: the tokens are 256-bit, this only blunts
// noise and keeps the log readable.
const badHits = new Map();
function tooManyBadHits(ip) {
  const now = Date.now();
  const rec = badHits.get(ip);
  if (!rec || now > rec.reset) {
    badHits.set(ip, { count: 1, reset: now + 10 * 60 * 1000 });
    if (badHits.size > 5000) for (const [k, v] of badHits) if (now > v.reset) badHits.delete(k);
    return false;
  }
  rec.count += 1;
  return rec.count > 40;
}

export function createDataroomPublicRouter({ publicBaseUrl = "" } = {}) {
  const router = express.Router();

  // The feed emits absolute URLs, because a relative "/d/…" in a JSON body gets
  // resolved against the marketing site and 404s into broken images. Falls back
  // to relative when unset so dev and the tests keep working.
  const feedBase = String(publicBaseUrl || "").replace(/\/+$/, "");

  const clientIp = (req) =>
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "";

  const notice = (res, code, opts) => {
    secureHeaders(res);
    res.status(code).type("html").send(renderNotice(opts));
  };
  const gone = (res) =>
    notice(res, 404, {
      title: "This link isn't available",
      message: "It may have expired, been replaced, or been turned off by the sender.",
    });

  // Resolve a token to { invite, room }, enforcing revocation and expiry.
  // Every failure returns the same notice — a prober learns nothing about
  // whether a token existed.
  async function resolveInvite(req, res) {
    const token = String(req.params.token || "");
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) { gone(res); return null; }
    const invite = await store.getDataroomInviteByTokenHash(hashToken(token));
    if (!invite) {
      if (tooManyBadHits(clientIp(req))) {
        notice(res, 429, { title: "Too many attempts", message: "Please wait a few minutes and try again." });
        return null;
      }
      gone(res); return null;
    }
    if (invite.status !== "active" || expired(invite)) { gone(res); return null; }
    const room = await store.getDataroom(invite.dataroomId);
    if (!room || room.status !== "active") { gone(res); return null; }
    // Offer-page tokens live in this same invite table and must not open an
    // investor room. /o/:token enforces the mirror of this.
    if (isOfferPage(room)) { gone(res); return null; }
    return { token, invite, room };
  }

  // Company branding for pages that aren't built from one offer. Location
  // settings are the source of truth, but they're often blank because the
  // company block is filled in per-offer — so fall back to what the deals
  // themselves are already branded with rather than showing a nameless page.
  async function companyFor(locationId, rooms = []) {
    const saved = await store.getOfferSettings(locationId).catch(() => null);
    if (saved?.company?.name) return saved.company;
    const fromRoom = rooms.map((r) => r.snapshot?.company).find((c) => c?.name);
    return fromRoom || saved?.company || {};
  }

  // The location's portfolio link, so every deal page can offer a way back to
  // the full list. Absent (or unlisted) → no back link rather than a dead one.
  async function portfolioLinkFor(room) {
    if (room.unlisted) return "";
    const rooms = await store.listDatarooms(room.locationId, { limit: 500 }).catch(() => []);
    const portfolio = rooms.find(isPortfolio);
    return portfolio?.shareToken && portfolio.status === "active"
      ? `/d/${encodeURIComponent(portfolio.shareToken)}`
      : "";
  }

  /* ---- the board as JSON, for a marketing site to render in its own brand ---- */
  //
  // MUST stay registered before GET /:token, or "deals.json" is captured as a
  // token. If it ever gets reordered the failure is benign — resolveInvite's
  // token regex rejects both the dot and the length — but it's a dead feed, so
  // the test suite pins the ordering.
  //
  // Keyed on location_id, NOT on the portfolio's share token. That keeps the
  // site decoupled from POST /api/datarooms/:id/share/rotate, which would
  // otherwise blank the homepage with no signal, and it avoids reaching into
  // resolveInvite — which renders-and-returns-null and is relied on by every
  // other route here.
  //
  // Deliberately writes nothing: no viewCount, no dataroom_events row. Every
  // homepage visitor and every crawler hitting this would bury the access log
  // the operator actually reads, and a cache hit isn't a person. The signal
  // that matters survives — clicking into a deal still logs a real view below.
  router.get("/deals.json", async (req, res) => {
    const locationId = String(req.query.location_id || "").slice(0, 64);
    if (!locationId) {
      feedHeaders(res, 0);
      return res.status(400).json({ error: "location_id required" });
    }

    const cached = feedCacheGet(locationId);
    if (cached) {
      feedHeaders(res, FEED_MAX_AGE);
      return res.status(cached.status).type("json").send(cached.body);
    }

    try {
      // Two gates, both required. The env allowlist is what keeps other
      // tenants' boards private; the portfolio room's status is the operator's
      // existing publish switch, so revoking it takes the site's deal section
      // down to its link-out. Both failures answer identically, so a location
      // that hasn't opted in is indistinguishable from one that doesn't exist.
      const rooms = FEED_LOCATIONS.has(locationId)
        ? await store.listDatarooms(locationId, { limit: 500 })
        : [];
      const portfolio = rooms.find((r) => isPortfolio(r) && r.status === "active");
      if (!portfolio) {
        // Negative-cached too, or probing location ids walks straight past the
        // cache into the database.
        const body = JSON.stringify({ error: "not found" });
        feedCacheSet(locationId, 404, body);
        feedHeaders(res, FEED_MAX_AGE);
        return res.status(404).type("json").send(body);
      }

      const listed = await loadBoardDeals(locationId);
      const company = await companyFor(locationId, listed);
      const body = JSON.stringify({
        // Build time, not request time — so it doubles as the cache's age when
        // something on the site looks stale.
        generatedAt: new Date().toISOString(),
        company: {
          name: company.name || "",
          tagline: company.tagline || "",
          signer: company.signer || "",
          phone: company.phone || "",
          email: company.email || "",
        },
        count: listed.length,
        // Raw integers, never formatted strings: money formatting on a
        // marketing card is the site's presentation choice, and shipping both
        // would only guarantee they drift. `spread` is the exception and comes
        // from dealCard, so this and the HTML board can't disagree about it.
        deals: listed.map((r) => {
          const d = dealCard(r);
          // The TEASER url, never the share token: this JSON is world-readable,
          // and the share link is the full package. A visitor who wants more
          // than the teaser asks, and gets a link that's theirs.
          const base = `${feedBase}/d/deal/${encodeURIComponent(d.id)}`;
          // A photo the teaser wouldn't serve isn't advertised either, or the
          // site would render cards with broken images.
          const photo = teaserSections(r).photos ? d.photo : null;
          return {
            id: d.id,
            url: base,
            address: d.address,
            headline: d.headline,
            beds: d.beds,
            baths: d.baths,
            sqft: d.sqft,
            yearBuilt: d.yearBuilt,
            price: d.price,
            arv: d.arv,
            rehab: d.rehab,
            spread: d.spread,
            photo: photo
              ? {
                  url: `${base}/photo/${encodeURIComponent(photo.id)}/thumb`,
                  width: photo.width,
                  height: photo.height,
                }
              : null,
            addedAt: d.addedAt,
          };
        }),
      });
      feedCacheSet(locationId, 200, body);
      feedHeaders(res, FEED_MAX_AGE);
      res.type("json").send(body);
    } catch (err) {
      console.error("dataroom feed failed:", err.message);
      // Never cached: a transient database blip shouldn't take the board off
      // the site for a full TTL.
      feedHeaders(res, 0);
      res.status(500).json({ error: "unavailable" });
    }
  });

  /* ---- the public teaser: what a cold website visitor may see ---- */
  //
  // Tokenless by design — the marketing site links here, and public means
  // public. What bounds it instead: the same env allowlist as the feed, the
  // room's own listed/active state, and the portfolio master switch. The page
  // renders the snapshot through teaserSections, so it can only ever show a
  // subset of what the operator already toggled into the package, minus the
  // permanently-locked keys (documents, fee breakdown).
  //
  // Registered before GET /:token so the literal "deal" segment wins; if it
  // ever gets reordered the failure is benign — "deal" is shorter than any
  // token — but the teaser dies, so the tests pin this too.
  async function resolveTeaser(req, res) {
    const id = String(req.params.roomId || "");
    if (!/^[A-Za-z0-9_-]{4,80}$/.test(id)) { gone(res); return null; }
    const room = await store.getDataroom(id).catch(() => null);
    if (!room || !FEED_LOCATIONS.has(room.locationId) || !listedInPortfolio(room) || !room.snapshot) {
      gone(res);
      return null;
    }
    // A dead deal's teaser dies with it — the card is off the board, so a
    // bookmarked or shared teaser link shouldn't be the way back in.
    if (room.offerId && !stillForSale(await store.getOffer(room.offerId))) { gone(res); return null; }
    const rooms = await store.listDatarooms(room.locationId, { limit: 500 });
    if (!rooms.some((r) => isPortfolio(r) && r.status === "active")) { gone(res); return null; }
    return room;
  }

  router.get("/deal/:roomId", async (req, res) => {
    try {
      const room = await resolveTeaser(req, res);
      if (!room) return;
      secureHeaders(res);
      // The marketing site embedding the feed is what should rank, not the
      // broker's bare teaser page.
      res.set("X-Robots-Tag", "noindex");
      const mask = teaserSections(room);
      // Deliberately unlogged (unlike token views): this URL is public, so
      // crawlers would bury the access log the operator actually reads. Real
      // interest shows up when someone asks for their personal link.
      res.type("html").send(renderRoom({
        snap: { ...room.snapshot, sections: mask },
        token: "",
        teaser: true,
        publicPath: `/d/deal/${encodeURIComponent(room.id)}`,
        photos: mask.photos && room.offerId ? await store.listOfferPhotos(room.offerId) : [],
        // Live settings, not the frozen snapshot: a rebrand reaches every
        // page at once without rebuilding rooms.
        brand: brandFrom(await companyFor(room.locationId, [room])),
      }));
    } catch (err) {
      console.error("dataroom teaser failed:", err.message);
      notice(res, 500, { title: "Something went wrong", message: "Please try that link again in a moment." });
    }
  });

  router.get("/deal/:roomId/photo/:photoId/:variant?", async (req, res) => {
    try {
      const room = await resolveTeaser(req, res);
      if (!room) return;
      if (!teaserSections(room).photos || !room.offerId) return gone(res);
      const variant = req.params.variant || "full";
      if (!PHOTO_VARIANTS.has(variant)) return gone(res);
      // Same proof as the token photo route: the id must belong to THIS room's
      // offer, or any listed deal would serve any photo in the system.
      const photos = await store.listOfferPhotos(room.offerId);
      if (!photos.some((p) => p.id === req.params.photoId)) return gone(res);
      const etag = `"${req.params.photoId}-${variant}"`;
      if (req.headers["if-none-match"] === etag) {
        photoHeaders(res, etag);
        return res.status(304).end();
      }
      const stored = await store.readPhotoBytes(req.params.photoId, variant);
      if (!stored?.bytes) return gone(res);
      photoHeaders(res, etag);
      res.set("Content-Type", stored.contentType || "image/jpeg");
      res.send(stored.bytes);
    } catch (err) {
      console.error("dataroom teaser photo failed:", err.message);
      gone(res);
    }
  });

  /* ---- the package, or the portfolio of every live deal ---- */
  router.get("/:token", async (req, res) => {
    try {
      const ctx = await resolveInvite(req, res);
      if (!ctx) return;
      const { token, invite, room } = ctx;
      secureHeaders(res);

      const viewCount = (invite.viewCount || 0) + 1;
      await store.updateDataroomInvite(invite.id, {
        viewCount,
        lastViewedAt: new Date().toISOString(),
        ...(invite.firstViewedAt ? {} : { firstViewedAt: new Date().toISOString() }),
      });
      await store.logDataroomEvent(room.id, invite.id, "view", {
        ip: clientIp(req), ua: String(req.headers["user-agent"] || "").slice(0, 200), name: invite.name,
      });

      if (isPortfolio(room)) {
        // Resolved live, so a deal added or pulled today is reflected without
        // anyone having to rebuild or resend the portfolio link.
        const listed = await loadBoardDeals(room.locationId);
        return res.type("html").send(renderPortfolio({
          rooms: listed, company: await companyFor(room.locationId, listed),
        }));
      }

      // Photos resolve live rather than being frozen into the snapshot: the
      // snapshot exists so an investor's NUMBERS can't shift under them, but a
      // photo pulled for cause (wrong house, a face in a window) has to
      // disappear everywhere at once. Whether the room shows photos at all IS
      // frozen — that's the operator's presentation choice, in snapshot.sections.
      res.type("html").send(renderRoom({
        snap: room.snapshot, token, invite, viewCount,
        photos: room.snapshot?.sections?.photos === false || !room.offerId
          ? [] : await store.listOfferPhotos(room.offerId),
        backLink: await portfolioLinkFor(room),
        brand: brandFrom(await companyFor(room.locationId, [room])),
      }));
    } catch (err) {
      console.error("dataroom view failed:", err.message);
      notice(res, 500, { title: "Something went wrong", message: "Please try that link again in a moment." });
    }
  });

  /* ---- property photos, behind the same token ---- */
  //
  // SECURITY: the photo id comes from the client, so it must never be trusted
  // as a lookup key on its own. Every photo served here is proved to belong to
  // THIS room's offer first — otherwise any valid token anywhere would serve
  // any photo in the system. The PDF route above is safe for the same reason:
  // its content is derived from room.offerId, not from user input.
  const PHOTO_VARIANTS = new Set(["full", "thumb"]);

  router.get("/:token/photo/:photoId/:variant?", async (req, res) => {
    try {
      const ctx = await resolveInvite(req, res);
      if (!ctx) return;
      const { room } = ctx;
      // The portfolio room has no offer of its own, so it can't authorize a
      // photo. Its cards link to each deal's own token instead.
      if (isPortfolio(room) || !room.offerId) return gone(res);

      const variant = req.params.variant || "full";
      if (!PHOTO_VARIANTS.has(variant)) return gone(res);

      const photos = await store.listOfferPhotos(room.offerId);
      if (!photos.some((p) => p.id === req.params.photoId)) return gone(res);

      // Immutable per (id, variant) — answer repeat views without touching the DB.
      const etag = `"${req.params.photoId}-${variant}"`;
      if (req.headers["if-none-match"] === etag) {
        photoHeaders(res, etag);
        return res.status(304).end();
      }

      const stored = await store.readPhotoBytes(req.params.photoId, variant);
      if (!stored?.bytes) return gone(res);
      photoHeaders(res, etag);
      res.set("Content-Type", stored.contentType || "image/jpeg");
      res.send(stored.bytes);
      // Deliberately NOT logged: a 20-image gallery would write 20 rows per
      // view and bury the access log the operator actually reads. The page
      // `view` event already records that someone opened this.
    } catch (err) {
      console.error("dataroom photo failed:", err.message);
      gone(res);
    }
  });

  /* ---- documents, streamed behind the same token ---- */
  const DOC_KINDS = {
    comps: { docKind: "compspdf", urlKey: "compsPdfUrl", label: "Comparable Sales Analysis" },
    scope: { docKind: "scopepdf", urlKey: "scopePdfUrl", label: "Rehab Scope of Work" },
  };

  router.get("/:token/file/:kind", async (req, res) => {
    try {
      const ctx = await resolveInvite(req, res);
      if (!ctx) return;
      const { invite, room } = ctx;
      const def = DOC_KINDS[req.params.kind];
      const offered = (room.snapshot?.documents || []).some((d) => d.key === req.params.kind);
      if (!def || !offered) return gone(res);

      secureHeaders(res);
      const filename = `${(room.address || "Property").replace(/[^\x20-\x7e]/g, "").replace(/[\\/:*?"<>|,]+/g, " ").trim().slice(0, 100)} ${def.label}.pdf`;
      await store.logDataroomEvent(room.id, invite.id, "download", {
        kind: req.params.kind, ip: clientIp(req), name: invite.name,
      });

      // Bytes live in Postgres when R2 isn't configured; otherwise the offer
      // holds an R2 URL, which we fetch server-side so the investor never sees
      // a URL that outlives their invite.
      const stored = await store.getOfferDoc(room.offerId, def.docKind).catch(() => null);
      if (stored) {
        res.set("Content-Type", stored.contentType || "application/pdf");
        res.set("Content-Disposition", `inline; filename="${filename}"`);
        return res.send(stored.bytes);
      }
      const offer = await store.getOffer(room.offerId).catch(() => null);
      const url = offer?.[def.urlKey];
      if (!url) return gone(res);
      const upstream = await fetch(url);
      if (!upstream.ok) return gone(res);
      res.set("Content-Type", upstream.headers.get("content-type") || "application/pdf");
      res.set("Content-Disposition", `inline; filename="${filename}"`);
      res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      console.error("dataroom file failed:", err.message);
      gone(res);
    }
  });

  return router;
}

export default createDataroomRouter;
