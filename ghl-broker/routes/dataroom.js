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
// The plaintext link token exists only in the response that creates it. Only
// its hash is stored, so neither this server nor a database dump can rebuild a
// working link — if the operator loses it, they reissue.

import express from "express";
import { store } from "../store.js";
import { effectiveSettings, fmtMoney } from "../shared/offer-calc.js";
import { getContact, sendSms } from "../ghl.js";
import {
  DEFAULT_EXPIRY_DAYS, buildSnapshot, hashToken, newToken, normalizeSections,
  photoHeaders, renderNotice, renderPortfolio, renderRoom, secureHeaders,
} from "../dataroom.js";

// A location's portfolio is itself a dataroom row — offerId null, kind
// "portfolio" — so it inherits the share token, revocation and view counting
// that deal rooms already have. Its contents are resolved at render time from
// whichever deal rooms are currently active and listed.
const isPortfolio = (room) => room?.kind === "portfolio";
const listedInPortfolio = (room) =>
  !isPortfolio(room) && room?.status === "active" && !room?.unlisted;

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
    if (!room || room.locationId !== locationId) {
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
      const rooms = await store.listDatarooms(locationId, { limit: 500 });
      const listed = rooms.filter(listedInPortfolio);
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
      const rooms = all.filter((r) => !isPortfolio(r)); // the portfolio isn't a deal
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
        });
        room.address = offer.address || room.address;
      } else {
        if (b.sections) room.snapshot.sections = normalizeSections(b.sections);
        if (b.headline !== undefined) room.snapshot.headline = str(b.headline, 120);
        if (b.notes !== undefined) room.snapshot.notes = str(b.notes, 2000);
      }
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

export function createDataroomPublicRouter() {
  const router = express.Router();

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
        const listed = (await store.listDatarooms(room.locationId, { limit: 500 }))
          .filter((r) => listedInPortfolio(r) && r.snapshot);
        // Rooms built before share links existed (or never opened) get one now,
        // rather than being silently dropped from the list. The hero photo is
        // fetched in the same pass, and served under each deal's OWN token —
        // the portfolio token can't authorize another room's photo.
        for (const r of listed) {
          await ensureShareLink(r);
          const photos = r.offerId ? await store.listOfferPhotos(r.offerId) : [];
          r.heroPhoto = photos[0] || null;
        }
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
