// routes/offer-page.js — the agent-facing offer package.
//
//   POST   /api/offer-pages                build a page from an offer
//   GET    /api/offer-pages?offer_id=      list this location's pages
//   GET    /api/offer-pages/:id            one page + share link + access log
//   PUT    /api/offer-pages/:id            refresh from the offer / edit sections, headline, note
//   POST   /api/offer-pages/:id/share/rotate   kill the old link, mint a new one
//   POST   /api/offer-pages/:id/revoke     switch the link off (reversible)
//   DELETE /api/offer-pages/:id
//
//   GET    /o/:token                       the page itself (public, tokenised)
//   GET    /o/:token/file/:kind            a document off the page
//
// Storage rides on the `datarooms` table with kind:"offer", so the token
// hashing, invite row, view counting and access log are the same ones the
// investor dataroom uses and are not reimplemented here.
//
// SECURITY — the isolation that matters:
//
//   An offer page carries our underwriting. The investor side publishes a
//   PUBLIC deals feed (/d/deals.json) and a portfolio board, and both select
//   rooms by "active and not unlisted". An offer-kind room passing that filter
//   would put our arithmetic on a public marketing page. routes/dataroom.js
//   therefore excludes kind:"offer" from every listing path, and the two token
//   routes refuse each other's rooms outright. Both directions are tested.

import express from "express";
import { store } from "../store.js";
import { effectiveSettings } from "../shared/offer-calc.js";
import {
  brandFrom, hashToken, newToken, renderNotice, secureHeaders,
} from "../dataroom.js";
import {
  OFFER_DOC_KINDS, buildOfferSnapshot, normalizeOfferSections, renderOfferPage,
} from "../offer-page.js";

const isOfferPage = (room) => room?.kind === "offer";
const clean = (v, max) => String(v ?? "").trim().slice(0, max);

/* ---------- share link ---------- */
// One forwardable link per offer: no expiry, no recipient, rotatable. Its token
// is stored in the clear (personal dataroom invites keep only a hash) because
// the operator has to be able to re-copy it, and a link you can't retrieve is
// useless for something you text to an agent. Rotation, not secrecy, controls
// it — this page is meant to be forwarded to a seller.
async function ensureShareLink(room) {
  if (room.shareToken) return room;
  const token = newToken();
  await store.createDataroomInvite({
    dataroomId: room.id,
    locationId: room.locationId,
    tokenHash: hashToken(token),
    contactId: null, name: null, phone: null,
    expiresAt: null,
    doc: { share: true, offerPage: true },
  });
  room.shareToken = token;
  await store.updateDataroom(room.id, room);
  return room;
}

export function createOfferPageRouter({ resolveLocation, publicBaseUrl = "" }) {
  const router = express.Router();
  const pageLink = (token) => (token ? `${publicBaseUrl}/o/${token}` : "");

  async function loadPage(req, res) {
    const { locationId } = resolveLocation(req);
    const room = await store.getDataroom(req.params.id).catch(() => null);
    // A dataroom id must 404 here exactly like an unknown one — the two
    // features share a table but never each other's routes.
    if (!room || room.locationId !== locationId || !isOfferPage(room)) {
      res.status(404).json({ error: "offer page not found" });
      return null;
    }
    return { locationId, room };
  }

  const publicShape = async (room) => {
    const invites = await store.listDataroomInvites(room.id).catch(() => []);
    const share = invites.find((i) => i.doc?.share);
    return {
      id: room.id,
      offerId: room.offerId,
      address: room.address,
      status: room.status,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      snapshot: room.snapshot,
      shareLink: pageLink(room.shareToken),
      views: share?.viewCount || 0,
      lastViewedAt: share?.lastViewedAt || null,
    };
  };

  /* ---------- build ---------- */
  router.post("/", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const offerId = clean(req.body?.offerId, 64);
      if (!offerId) return res.status(400).json({ error: "offerId required" });
      const offer = await store.getOffer(offerId);
      if (!offer || offer.locationId !== locationId) return res.status(404).json({ error: "offer not found" });
      if (offer.status === "draft") {
        return res.status(400).json({ error: "create the offer before building its page" });
      }

      const settings = effectiveSettings(await store.getOfferSettings(locationId));
      const snapshot = buildOfferSnapshot({
        offer, settings,
        sections: req.body?.sections,
        headline: req.body?.headline,
        note: req.body?.note,
      });
      const room = await store.createDataroom({
        locationId,
        offerId,
        address: offer.address || snapshot.property.address || null,
        status: "active",
        kind: "offer",
        snapshot,
      });
      await ensureShareLink(room);
      res.json({ ok: true, offerPage: await publicShape(room) });
    } catch (err) { fail(res, err); }
  });

  /* ---------- read ---------- */
  router.get("/", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const offerId = clean(req.query.offer_id, 64);
      const rooms = (await store.listDatarooms(locationId, { limit: 500 }))
        .filter((r) => isOfferPage(r) && (!offerId || r.offerId === offerId));
      const out = [];
      for (const r of rooms) out.push(await publicShape(r));
      res.json({ offerPages: out });
    } catch (err) { fail(res, err); }
  });

  router.get("/:id", async (req, res) => {
    try {
      const ctx = await loadPage(req, res);
      if (!ctx) return;
      res.json({
        offerPage: await publicShape(ctx.room),
        events: await store.listDataroomEvents(ctx.room.id).catch(() => []),
      });
    } catch (err) { fail(res, err); }
  });

  /* ---------- edit ---------- */
  router.put("/:id", async (req, res) => {
    try {
      const ctx = await loadPage(req, res);
      if (!ctx) return;
      const { locationId, room } = ctx;
      const b = req.body || {};

      if (b.refresh) {
        // Re-read the offer. headline/note/sections are operator-authored, so
        // they ride across explicitly or a refresh would silently erase them.
        const offer = await store.getOffer(room.offerId);
        if (!offer || offer.locationId !== locationId) {
          return res.status(404).json({ error: "the offer behind this page is gone" });
        }
        const settings = effectiveSettings(await store.getOfferSettings(locationId));
        room.snapshot = buildOfferSnapshot({
          offer, settings,
          sections: b.sections !== undefined ? b.sections : room.snapshot?.sections,
          headline: b.headline !== undefined ? b.headline : room.snapshot?.headline,
          note: b.note !== undefined ? b.note : room.snapshot?.note,
        });
        room.address = offer.address || room.address;
      } else {
        if (b.sections !== undefined) room.snapshot.sections = normalizeOfferSections(b.sections);
        if (b.headline !== undefined) room.snapshot.headline = clean(b.headline, 120);
        if (b.note !== undefined) room.snapshot.note = clean(b.note, 2000);
      }
      room.updatedAt = new Date().toISOString();
      await store.updateDataroom(room.id, room);
      res.json({ ok: true, offerPage: await publicShape(room) });
    } catch (err) { fail(res, err); }
  });

  router.post("/:id/share/rotate", async (req, res) => {
    try {
      const ctx = await loadPage(req, res);
      if (!ctx) return;
      const { room } = ctx;
      // Revoke every share row first: rotation has to kill the URL that's
      // already been forwarded, not just stop handing out the old one.
      for (const inv of await store.listDataroomInvites(room.id)) {
        if (inv.doc?.share) await store.updateDataroomInvite(inv.id, { status: "revoked" });
      }
      delete room.shareToken;
      await store.updateDataroom(room.id, room);
      await ensureShareLink(room);
      await store.logDataroomEvent(room.id, null, "share_rotated", {});
      res.json({ ok: true, shareLink: pageLink(room.shareToken) });
    } catch (err) { fail(res, err); }
  });

  router.post("/:id/revoke", async (req, res) => {
    try {
      const ctx = await loadPage(req, res);
      if (!ctx) return;
      const { room } = ctx;
      const revoked = req.body?.revoked !== false;
      room.status = revoked ? "revoked" : "active";
      room.updatedAt = new Date().toISOString();
      await store.updateDataroom(room.id, room);
      await store.logDataroomEvent(room.id, null, revoked ? "revoked" : "restored", {});
      res.json({ ok: true, offerPage: await publicShape(room) });
    } catch (err) { fail(res, err); }
  });

  router.delete("/:id", async (req, res) => {
    try {
      const ctx = await loadPage(req, res);
      if (!ctx) return;
      await store.deleteDataroom(ctx.room.id);
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });

  return router;
}

/* ============================================================= *
 * public
 * ============================================================= */

// Per-IP throttle on bad tokens: 40 misses per 10 minutes. Per-process and
// bounded, same as the dataroom's — enough to make guessing pointless without
// pretending to be a distributed rate limiter.
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

const clientIp = (req) =>
  String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "";

export function createOfferPagePublicRouter() {
  const router = express.Router();

  const notice = (res, code, opts) => {
    secureHeaders(res);
    // Agent-facing wording: the reader of this page has never heard of a
    // "dataroom" and shouldn't be told they just missed one.
    res.status(code).type("html").send(renderNotice({ eyebrow: "Cash offer", ...opts }));
  };
  // Every failure looks identical, so a prober can't learn whether a token
  // ever existed.
  const gone = (res) =>
    notice(res, 404, {
      title: "This offer link isn't available",
      message: "It may have been replaced or switched off by the sender.",
    });

  async function resolveToken(req, res) {
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
    if (invite.status !== "active") { gone(res); return null; }
    const room = await store.getDataroom(invite.dataroomId);
    // A dataroom token must not open here, and vice versa — they share an
    // invite table, so the kind check is the only thing separating them.
    if (!room || room.status !== "active" || !isOfferPage(room)) { gone(res); return null; }
    return { token, invite, room };
  }

  router.get("/:token", async (req, res) => {
    try {
      const ctx = await resolveToken(req, res);
      if (!ctx) return;
      const { token, invite, room } = ctx;

      await store.updateDataroomInvite(invite.id, {
        viewCount: (invite.viewCount || 0) + 1,
        lastViewedAt: new Date().toISOString(),
        ...(invite.firstViewedAt ? {} : { firstViewedAt: new Date().toISOString() }),
      }).catch(() => {});
      await store.logDataroomEvent(room.id, invite.id, "view", {
        ip: clientIp(req),
        ua: String(req.headers["user-agent"] || "").slice(0, 200),
      }).catch(() => {});

      secureHeaders(res);
      res.type("html").send(renderOfferPage({
        snap: room.snapshot,
        token,
        brand: brandFrom(room.snapshot?.company || {}),
      }));
    } catch {
      gone(res);
    }
  });

  router.get("/:token/file/:kind", async (req, res) => {
    try {
      const ctx = await resolveToken(req, res);
      if (!ctx) return;
      const { invite, room } = ctx;
      const def = OFFER_DOC_KINDS[req.params.kind];
      // Double gate: a known kind AND one this page actually froze. Turning
      // documents off, or refreshing off an offer that lost a PDF, kills the
      // URL. The contract and assignment PDFs have no key here at all.
      const offered = (room.snapshot?.documents || []).some((d) => d.key === req.params.kind);
      if (!def || !offered) return gone(res);

      secureHeaders(res);
      const filename = `${String(room.address || "Property")
        .replace(/[^\x20-\x7e]/g, "").replace(/[\\/:*?"<>|,]+/g, " ").trim().slice(0, 100)} ${def.label}.pdf`;
      await store.logDataroomEvent(room.id, invite.id, "download", {
        kind: req.params.kind, ip: clientIp(req),
      }).catch(() => {});

      // Bytes live in Postgres when R2 isn't configured; otherwise the offer
      // holds an R2 URL, fetched server-side so the agent never sees a URL
      // that outlives the link they were given.
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
    } catch {
      gone(res);
    }
  });

  return router;
}

function fail(res, err) {
  const code = err.http || err.status || 500;
  if (code >= 500) console.error("offer-page error:", code, err.message, err.detail || "");
  res.status(code).json({ error: err.message, detail: err.detail });
}
