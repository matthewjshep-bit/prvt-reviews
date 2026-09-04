// dataroom.js — the secure investor dataroom: link crypto, the snapshot taken
// from an offer, and the HTML the investor actually sees.
//
// There are two kinds of link, because a deal package does two jobs:
//   • The SHARE link — one per dataroom, for blasting to a buyer list. It's
//     marketing: meant to be forwarded, so its token is stored in the clear so
//     the operator can re-copy it any time. Rotating it kills the old one.
//   • A PERSONAL link — optional, one per investor, when the operator wants to
//     know who actually looked. Only its SHA-256 is stored, so a database leak
//     yields no working personal links, and each page is watermarked with the
//     recipient's name.
//
// Both are capability URLs: a 256-bit random token, unguessable at any
// realistic request rate — the same model the offer PDFs already use. What
// bounds them is revocation, expiry, and the access log. Documents stream
// through the broker rather than as R2 URLs, so a copied PDF link dies with
// the link that served it.

import crypto from "node:crypto";
import { fmtMoney } from "./shared/offer-calc.js";
import { brandMarkSvg } from "./shared/brand-mark.js";
import { zillowUrl } from "./shared/us-address.js";

export const DEFAULT_EXPIRY_DAYS = 14;

/* ============================================================= *
 * Link crypto
 * ============================================================= */

// 32 random bytes, base64url. Unguessable at any realistic request rate.
export const newToken = () => crypto.randomBytes(32).toString("base64url");
export const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

/* ============================================================= *
 * Snapshot: offer → investor-facing package
 * ============================================================= */

// What the operator can choose to include. `feeBreakdown` is off by default:
// it exposes our contract price and assignment fee, which is negotiating
// leverage, not investor information.
export const SECTION_KEYS = ["summary", "property", "equity", "photos", "comps", "scope", "terms", "documents", "feeBreakdown"];
export const DEFAULT_SECTIONS = {
  summary: true, property: true, equity: true, photos: true, comps: true,
  scope: true, terms: true, documents: true, feeBreakdown: false,
};

export function normalizeSections(input) {
  const out = { ...DEFAULT_SECTIONS };
  for (const k of SECTION_KEYS) {
    if (input && typeof input[k] === "boolean") out[k] = input[k];
  }
  return out;
}

/* ---- the public teaser: what a cold website visitor may see ---- */
//
// A second, stricter section mask for the tokenless teaser page the marketing
// site links to. Two keys are locked off no matter what the operator toggles:
// documents stream through invite-authorized routes (a public page has no
// invite to authorize with), and feeBreakdown is negotiating leverage that has
// no business in front of an anonymous visitor. The teaser a visitor sees is
// publicSections ∩ the room's own sections — the teaser can only ever narrow
// the package, never reveal something the package itself hides.
export const TEASER_LOCKED = ["documents", "feeBreakdown"];
export const DEFAULT_PUBLIC_SECTIONS = {
  summary: true, property: true, equity: true, photos: true, comps: false,
  scope: false, terms: false, documents: false, feeBreakdown: false,
};

export function normalizePublicSections(input) {
  const out = { ...DEFAULT_PUBLIC_SECTIONS };
  for (const k of SECTION_KEYS) {
    if (input && typeof input[k] === "boolean") out[k] = input[k];
  }
  for (const k of TEASER_LOCKED) out[k] = false;
  return out;
}

// The section mask a teaser page renders with.
export function teaserSections(room) {
  const own = room?.snapshot?.sections || DEFAULT_SECTIONS;
  const pub = normalizePublicSections(room?.publicSections);
  const out = {};
  for (const k of SECTION_KEYS) out[k] = Boolean(own[k] !== false && pub[k]);
  return out;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const clean = (v, max = 200) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export const MAX_LINKS = 12;

// Operator-curated external links shown in the investor package — a Matterport
// tour, a Drive folder of inspection reports, a county parcel page.
//
// These become href attributes on a page we serve to people outside the
// account, so the scheme allowlist is the whole security story: `javascript:`
// and `data:` URLs are script-execution vectors dressed as links, and the
// page's CSP can't stop a navigation. Parse with URL() and accept nothing but
// http/https — no regex, no "starts with http" check that `https:evil` would
// slip past.
export function normalizeLinks(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of input.slice(0, MAX_LINKS * 2)) {
    const href = clean(raw?.url, 600);
    if (!href) continue;
    let parsed;
    try {
      parsed = new URL(href);
    } catch {
      continue; // not a URL at all
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    const url = parsed.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      id: clean(raw?.id, 40) || `lnk-${out.length + 1}-${url.length}`,
      // An unlabelled link still needs something clickable; the host is the
      // most honest fallback ("matterport.com" tells you more than "Link 3").
      label: clean(raw?.label, 80) || parsed.hostname.replace(/^www\./, ""),
      url,
      host: parsed.hostname.replace(/^www\./, ""),
    });
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

// Comps the operator actually selected, plus any added by hand — the same
// selection the Comparable Sales Analysis PDF prints.
export function pickedComps(snapshot) {
  const cs = snapshot?.comps;
  if (!cs) return [];
  const sel = new Set(Array.isArray(cs.selected) ? cs.selected : []);
  const grades = cs.grades || {};
  const withCondition = (c) => ({
    id: clean(c.id, 80),
    address: clean(c.address, 90) || "Comparable sale",
    price: Math.round(num(c.price)),
    sqft: Math.round(num(c.sqft)) || null,
    beds: c.beds != null && c.beds !== "" ? num(c.beds) : null,
    baths: c.baths != null && c.baths !== "" ? num(c.baths) : null,
    saleDate: clean(c.saleDate, 10) || null,
    distance: c.distance != null ? num(c.distance) : null,
    yearBuilt: Math.round(num(c.yearBuilt)) || null,
    condition: clean(grades[c.id]?.condition, 30) || null,
    manual: Boolean(c.manual),
  });
  return [
    ...(cs.result?.comps || []).filter((c) => sel.has(c.id)).map(withCondition),
    // Comps captured from Zillow are ticked like pulled ones and belong in the
    // investor package too — leaving them out would show a different comp set
    // than the ARV was actually built from.
    ...(Array.isArray(cs.captured) ? cs.captured : []).filter((c) => sel.has(c.id)).map(withCondition),
    ...(Array.isArray(cs.manual) ? cs.manual : []).map(withCondition),
  ].filter((c) => c.price > 0).slice(0, 24);
}

// The money on the package, in one place: the deal's own terms once the offer
// is under contract, the offer's cash number and the default fee before that.
// `investorPrice` is the assignment contract — contract price + fee — which is
// exactly what the deal page calls it and what the end buyer pays.
//
// Whole dollars throughout. The offer calc deliberately jitters cents onto the
// cash offer so it reads as calculated rather than round, but those cents ride
// through into contractPrice and read as sloppiness on a deal package.
export function dealNumbers({ offer, settings = {} }) {
  const deal = offer?.deal || null;
  const inputs = offer?.calc?.inputs || {};
  const contractPrice = Math.round(num(deal?.contractPrice) || num(offer?.cashAmount));
  const assignmentFee = Math.round(deal ? num(deal.assignmentFee) : num(settings?.wholesaleFee));
  // ARV and rehab are the offer's own, not the deal's. Rehab falls back to the
  // scope's line items when the offer doesn't name a figure outright —
  // `repairsFromScope` says which of the two it was, because only an
  // outright figure is safe to sync into a room whose scope table is frozen.
  const arv = Math.round(num(inputs.arv));
  const namedRepairs = Math.round(num(inputs.repairs));
  const scopeRepairs = Math.round((offer?.scope || []).reduce((t, s) => t + num(s.cost), 0));
  return {
    contractPrice,
    assignmentFee,
    investorPrice: contractPrice + assignmentFee,
    arv,
    repairs: namedRepairs || scopeRepairs,
    repairsFromScope: !namedRepairs && scopeRepairs > 0,
  };
}

// Figures the operator has set on the room itself, overriding what the offer
// says: { investorPrice, arv, repairs }, each a positive whole-dollar amount,
// present only while pinned. They live beside `numbers` rather than in it so
// the sync below can tell "set here" from "last synced" — and so the console
// can show which is which and offer a way back to following the offer.
export const OVERRIDABLE = ["investorPrice", "arv", "repairs"];
export function normalizeNumberOverrides(o) {
  const out = {};
  for (const k of OVERRIDABLE) {
    const v = Math.round(num(o?.[k]));
    if (v > 0 && v <= 100_000_000) out[k] = v;
  }
  return out;
}

// Lay the operator's pins over a set of numbers. A pinned purchase price is
// what the investor is quoted, and the breakdown card prints contract price +
// fee = price, so the fee absorbs the difference; a pin that has fallen below
// the contract price no longer describes a deal that exists and is dropped.
export function applyNumberOverrides(numbers, overrides = {}) {
  const n = { ...numbers };
  const o = { ...overrides };
  if (o.arv > 0) n.arv = o.arv;
  if (o.repairs > 0) n.repairs = o.repairs;
  if (o.investorPrice > 0) {
    if (num(n.contractPrice) > 0 && o.investorPrice < num(n.contractPrice)) {
      delete o.investorPrice;
    } else {
      n.investorPrice = o.investorPrice;
      if (num(n.contractPrice) > 0) n.assignmentFee = o.investorPrice - num(n.contractPrice);
    }
  }
  return { numbers: n, overrides: o };
}

// Push the offer's money into every room built from it. The snapshot is frozen
// on purpose — comps, scope, photos and notes stay as the investor first saw
// them until the operator refreshes — but the figures on the headline strip
// must never be behind the offer: quoting an investor a purchase price the deal
// page has since moved off is how you assign a deal at the wrong number.
//
// Price, ARV and rehab move together, because the strip's "Spread at ARV" is
// computed from all three at render time. Syncing price alone would leave that
// spread reconciling to neither vintage — a wrong number in front of a buyer.
// Everything else still waits for a deliberate refresh.
//
// A figure the operator has pinned on the room (snapshot.overrides) is theirs:
// the sync moves around it, and only a deliberate unpin in the console lets the
// offer's number back in.
//
// Best-effort by design: a room that won't save must never fail the deal edit
// that triggered this. Never throws.
export function dealMoves({ offer, settings = {} }) {
  const next = dealNumbers({ offer, settings });
  const moves = {
    contractPrice: next.contractPrice,
    assignmentFee: next.assignmentFee,
    investorPrice: next.investorPrice,
  };
  // Only overwrite a figure the offer actually carries. An offer with no calc
  // inputs must not blank an ARV an investor has already seen — a missing
  // number reads as a withdrawn one, which is worse than a stale one.
  if (next.arv > 0) moves.arv = next.arv;
  // A scope-derived rehab total belongs to the scope table printed beside it,
  // and that table stays frozen. Moving the total while its line items sit
  // still would make the two openly disagree, so it waits for the refresh.
  if (next.repairs > 0 && !next.repairsFromScope) moves.repairs = next.repairs;
  return moves;
}

export async function syncDealNumbers({ store, offer, settings = {} }) {
  const moves = dealMoves({ offer, settings });
  let synced = 0;
  try {
    for (const room of await store.listDatarooms(offer.locationId, { offerId: offer.id })) {
      // Investor rooms only. An agent-facing offer page rides on the same table
      // (kind "offer") and carries the offer's own numbers, not the deal's.
      const n = room?.kind === "offer" ? null : room?.snapshot?.numbers;
      if (!n) continue;
      const { numbers, overrides } = applyNumberOverrides({ ...n, ...moves }, room.snapshot.overrides);
      if (Object.keys(numbers).every((k) => n[k] === numbers[k])) continue;
      room.snapshot = { ...room.snapshot, numbers, overrides };
      await store.updateDataroom(room.id, room);
      synced++;
    }
  } catch (e) {
    console.error(`dataroom: number sync failed offer=${offer?.id}:`, e?.message);
  }
  return synced;
}

// Build the frozen investor package from an offer. Taken once at creation so
// later edits to the offer never change what an investor already opened;
// the operator refreshes deliberately via PUT /api/datarooms/:id. The one
// exception is the headline money — price, ARV and rehab — which
// syncDealNumbers above keeps level with the offer.
// `links` is operator-authored, not derived from the offer — like headline and
// notes, it must be passed back in on a refresh or rebuilding from the offer
// would silently drop it. So are `overrides`, the figures pinned on the room.
export function buildSnapshot({ offer, settings = {}, sections, headline = "", notes = "", links = [], overrides = {} }) {
  const inputs = offer?.calc?.inputs || {};
  const deal = offer?.deal || null;
  const snap = offer?.snapshot || null;
  const company = offer?.calc?.settings?.company || settings?.company || {};

  const base = dealNumbers({ offer, settings });
  const pinned = applyNumberOverrides(
    { investorPrice: base.investorPrice, arv: base.arv, repairs: base.repairs, contractPrice: base.contractPrice, assignmentFee: base.assignmentFee },
    normalizeNumberOverrides(overrides)
  );

  const subject = snap?.comps?.result?.info || snap?.subjectInfo || null;

  return {
    builtAt: new Date().toISOString(),
    sections: normalizeSections(sections),
    headline: clean(headline, 120),
    notes: clean(notes, 2000),
    links: normalizeLinks(links),
    company: {
      name: clean(company.name, 80),
      tagline: clean(company.tagline, 120),
      signer: clean(company.signer, 80),
      phone: clean(company.phone, 40),
      email: clean(company.email, 120),
    },
    property: {
      address: clean(inputs.address || offer?.address, 160),
      beds: subject?.beds != null ? num(subject.beds) : null,
      baths: subject?.baths != null ? num(subject.baths) : null,
      sqft: Math.round(num(subject?.sqft) || num(snap?.subjectSqft)) || null,
      yearBuilt: Math.round(num(subject?.yearBuilt)) || null,
      zillow: zillowUrl(inputs.address || offer?.address || "") || "",
    },
    numbers: pinned.numbers,
    overrides: pinned.overrides,
    terms: {
      closingDate: clean(deal?.closingDate, 40),
      inspectionDate: clean(deal?.inspectionDate, 40),
      stage: clean(deal?.stage, 40),
    },
    comps: {
      items: pickedComps(snap),
      basis: clean(snap?.comps?.arvBasis, 120),
      months: Math.round(num(snap?.comps?.months)) || null,
      adjustments: (Array.isArray(snap?.comps?.adjustments) ? snap.comps.adjustments : [])
        .map((a) => ({ label: clean(a?.label, 60), pct: num(a?.pct) }))
        .filter((a) => a.pct !== 0)
        .slice(0, 6),
    },
    scope: (offer?.scope || []).slice(0, 60).map((s) => ({ label: clean(s.label, 120), cost: Math.round(num(s.cost)) })),
    conditionSummary: clean(snap?.rehab?.aiResult?.summary, 800),
    // Document kinds the room can serve; the public route maps these to the
    // offer's stored bytes / R2 URLs.
    documents: [
      offer?.compsPdfUrl ? { key: "comps", label: "Comparable sales analysis" } : null,
      offer?.scopePdfUrl ? { key: "scope", label: "Rehab scope of work" } : null,
    ].filter(Boolean),
  };
}

/* ============================================================= *
 * HTML
 * ============================================================= */

export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const money = (n) => (num(n) > 0 ? fmtMoney(Math.round(num(n))) : "—");

// The one script an investor page runs: the photo viewer. Every photo link on
// the page (the hero and each thumbnail) carries data-gal="<index>" and points
// at the full-size image, so with scripting off the links simply open in a new
// tab. With it on, a tap opens the overlay in the markup photoViewer() emits:
// prev/next, swipe, arrow keys, Escape, a counter, and the phone's back gesture
// closes it instead of leaving the room. A link carrying data-video is a
// walkthrough: the viewer swaps the image for the <video> element with native
// controls and starts it; without the script the same link opens the stream
// in a tab, which every browser plays on its own.
//
// It is allowed by CONTENT HASH, not by 'unsafe-inline' or a nonce: the CSP
// names the SHA-256 of this exact string, so nothing else inline can ever run,
// there is no per-request state to plumb through the renderer, and a typo here
// fails closed (the browser drops the script and the links still work).
// Keep it free of backticks and of the sequence "</script".
export const GALLERY_JS = `(function () {
  var d = document, h = d.documentElement, lb = d.getElementById("lb");
  if (!lb || !d.querySelector("a[data-gal]")) return;
  var links = [].slice.call(d.querySelectorAll("a[data-gal]"))
    .sort(function (a, b) { return a.dataset.gal - b.dataset.gal; });
  var img = lb.querySelector("img"), vid = lb.querySelector("video");
  var cap = lb.querySelector(".lb-c"), idx = lb.querySelector(".lb-i");
  var btns = [].slice.call(lb.querySelectorAll("button"));
  var cur = -1, opener = null, pushed = false;
  h.classList.add("gal");

  function preload(i) {
    if (i >= 0 && i < links.length && !links[i].dataset.video) { var p = new Image(); p.src = links[i].href; }
  }
  function stopVideo() {
    if (!vid) return;
    try { vid.pause(); } catch (e) { /* not playing */ }
    vid.removeAttribute("src"); vid.removeAttribute("poster"); vid.load();
    vid.hidden = true;
  }
  function show(i, play) {
    cur = (i + links.length) % links.length;
    var a = links[cur], text = a.dataset.cap || "";
    stopVideo();
    if (a.dataset.video && vid) {
      lb.classList.remove("loading");
      img.hidden = true; img.removeAttribute("src");
      if (a.dataset.poster) vid.poster = a.dataset.poster;
      vid.src = a.dataset.video;
      vid.hidden = false;
      if (play) { var pr = vid.play(); if (pr && pr.catch) pr.catch(function () { /* wants a tap */ }); }
    } else {
      img.hidden = false;
      lb.classList.add("loading");
      img.src = a.href;
      img.alt = text;
    }
    cap.textContent = text;
    idx.textContent = (cur + 1) + " / " + links.length;
    preload(cur + 1); preload(cur - 1);
  }
  function open(i, from) {
    opener = from || null;
    lb.hidden = false;
    h.classList.add("lb-open");
    show(i, true);
    try { history.pushState({ lb: 1 }, ""); pushed = true; } catch (e) { pushed = false; }
    lb.querySelector(".lb-x").focus();
  }
  function close(fromHistory) {
    if (lb.hidden) return;
    lb.hidden = true;
    h.classList.remove("lb-open");
    stopVideo();
    img.removeAttribute("src");
    if (opener && opener.focus) opener.focus();
    opener = null;
    var back = pushed && !fromHistory;
    pushed = false;
    if (back) history.back();
  }

  img.addEventListener("load", function () { lb.classList.remove("loading"); });
  img.addEventListener("error", function () { lb.classList.remove("loading"); });

  d.addEventListener("click", function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var a = t.closest("a[data-gal]");
    if (a) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return;
      e.preventDefault();
      open(links.indexOf(a), a);
      return;
    }
    var b = t.closest("[data-lb]");
    if (b) {
      var k = b.dataset.lb;
      if (k === "close") close(); else if (k === "prev") show(cur - 1); else if (k === "next") show(cur + 1);
      return;
    }
    if (t === lb || (t.classList && t.classList.contains("lb-f"))) close();
  });

  d.addEventListener("keydown", function (e) {
    if (lb.hidden) return;
    if (vid && e.target === vid && e.key !== "Escape") return; /* the player owns its keys */
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); show(cur - 1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); show(cur + 1); }
    else if (e.key === "Tab") {
      var i = btns.indexOf(d.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); btns[btns.length - 1].focus(); }
      else if (!e.shiftKey && (i < 0 || i === btns.length - 1)) { e.preventDefault(); btns[0].focus(); }
    }
  });

  var tx = null, ty = null;
  lb.addEventListener("touchstart", function (e) {
    if (vid && vid.contains(e.target)) { tx = ty = null; return; } /* scrubbing isn't swiping */
    var t = e.changedTouches[0]; tx = t.clientX; ty = t.clientY;
  }, { passive: true });
  lb.addEventListener("touchend", function (e) {
    if (tx === null) return;
    var t = e.changedTouches[0], dx = t.clientX - tx, dy = t.clientY - ty;
    tx = ty = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) show(dx < 0 ? cur + 1 : cur - 1);
  }, { passive: true });

  window.addEventListener("popstate", function () { if (!lb.hidden) close(true); });
})();`;

// 'sha256-…' source expressions for the CSP, memoized: the scripts are module
// constants, so hashing them per response would only spend CPU to get the same
// answer.
const cspHashes = new Map();
const cspHash = (src) => {
  if (!cspHashes.has(src)) {
    cspHashes.set(src, `'sha256-${crypto.createHash("sha256").update(src, "utf8").digest("base64")}'`);
  }
  return cspHashes.get(src);
};

// Headers every dataroom response carries: no indexing, no referrer leak of
// the token, no caching of confidential content, no framing.
//
// `scripts` is the list of inline script SOURCES the page will embed (see
// GALLERY_JS). Each is allowed by its hash and nothing else is, so a page that
// passes none stays entirely script-free — the notices and the offer page do.
// `media` lets the page play same-origin <video>: the room pages, whose
// walkthroughs stream from this host behind the same token as the page.
export function secureHeaders(res, { scripts = [], media = false } = {}) {
  res.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
  res.set("Referrer-Policy", "no-referrer");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("X-Frame-Options", "DENY");
  res.set("X-Content-Type-Options", "nosniff");
  res.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; " +
    "form-action 'self'; frame-ancestors 'none'; base-uri 'none'" +
    (scripts.length ? `; script-src ${scripts.map(cspHash).join(" ")}` : "") +
    (media ? "; media-src 'self'" : "")
  );
}

// Photos, unlike the HTML, are safe to cache: content is immutable per photo id
// (an edit mints a new id), so a strong ETag turns repeat gallery views into
// 304s. That matters — the DB pool is 8 connections and a gallery fires every
// image at once. `private` keeps bytes out of shared caches and the 24h cap
// bounds how long a revoked invite's images linger in one browser.
export function photoHeaders(res, etag) {
  res.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Cache-Control", "private, max-age=86400");
  if (etag) res.set("ETag", etag);
}

// The public deals feed is the one dataroom response meant to be read by
// another origin and cached, so secureHeaders is wrong for it in every
// particular: `no-store` would put the whole board through the database on
// every homepage view, and framing rules say nothing about a JSON body.
//
// `maxAge` governs the BROWSER's copy and is a product decision — how stale a
// homepage's deal list may be. It is deliberately separate from the server-side
// memo TTL, which protects the database and is tuned (and switched off in
// tests) independently. Pass 0 for errors, which must never be cached.
//
// No OPTIONS handler accompanies this route: a plain GET with no custom request
// headers is a CORS "simple request" and triggers no preflight. Sending any
// custom header from the client would silently start needing one.
export function feedHeaders(res, maxAge = 60) {
  // Open to any origin. The board is published deliberately, and there are no
  // cookies and no auth here, so an allowlist would buy nothing while breaking
  // Netlify's randomly-named deploy previews. WHICH locations publish at all is
  // decided by DATAROOM_FEED_LOCATIONS, not by who is asking.
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Cache-Control", maxAge > 0
    ? `public, max-age=${maxAge}, stale-while-revalidate=300`
    : "no-store");
  res.set("X-Content-Type-Options", "nosniff");
  // The site embedding this is what should rank; the raw feed shouldn't.
  res.set("X-Robots-Tag", "noindex");
}

const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", "Plus Jakarta Sans", system-ui, sans-serif`;

export const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
body{margin:0;font-family:${FONT};background:#F8FAFC;color:#0F172A;
  -webkit-text-size-adjust:100%;line-height:1.5}
a{color:#2563EB}
.wrap{max-width:760px;margin:0 auto;padding:20px 16px 64px}
.card{background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:20px;margin:0 0 16px}
.eyebrow{font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#64748B;margin:0 0 6px}
h1{font-size:21px;font-weight:700;letter-spacing:-.01em;margin:0 0 4px;line-height:1.25;overflow-wrap:break-word}
h2{font-size:15px;font-weight:700;letter-spacing:-.005em;margin:0 0 14px}
p{margin:0 0 10px}
.muted{color:#64748B;font-size:13px}
/* Flex, not grid: a grid minmax() track can't shrink below its content, so a
   long money figure would widen the whole page on a phone. */
.figs{display:flex;flex-wrap:wrap;gap:1px;background:#E2E8F0;
  border:1px solid #E2E8F0;border-radius:8px;overflow:hidden}
.fig{background:#fff;padding:14px 16px;flex:1 1 150px;min-width:0}
.fig .k{font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#64748B;margin-bottom:4px}
.fig .v{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.fig.hero{background:#0F172A}
.fig.hero .k{color:#94A3B8}
.fig.hero .v{color:#fff;font-size:24px}
.fig.good .v{color:#047857}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#94A3B8;
  padding:0 8px 8px 0;border-bottom:1px solid #E2E8F0;white-space:nowrap}
td{padding:9px 8px 9px 0;border-bottom:1px solid #F1F5F9;vertical-align:top}
th.r,td.r{text-align:right;padding:9px 0 9px 14px;font-variant-numeric:tabular-nums;white-space:nowrap}
th.r{padding-top:0;padding-bottom:8px}
tr:last-child td{border-bottom:0}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 -4px;padding:0 4px}
/* The comps table has too many columns for a phone. Let it keep its natural
   width and scroll inside the card rather than crushing every column. */
.scroll.wide table{min-width:500px}
.scroll.wide td:first-child{min-width:150px}
.hint{display:none;font-size:12px;color:#94A3B8;margin:8px 0 0}
@media(max-width:600px){.hint{display:block}}
.pill{display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;border-radius:9999px;
  background:#F1F5F9;color:#475569;white-space:nowrap}
.doc{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid #F1F5F9}
.doc:last-child{border-bottom:0}
.btn{display:inline-block;background:#2563EB;color:#fff;text-decoration:none;font-size:13px;font-weight:600;
  padding:9px 16px;border-radius:8px;border:0;cursor:pointer;font-family:inherit}
.btn.ghost{background:#fff;color:#0F172A;border:1px solid #E2E8F0}
.foot{font-size:12px;color:#94A3B8;text-align:center;line-height:1.6;padding:0 8px}
.stamp{font-size:12px;color:#64748B;border-top:1px dashed #E2E8F0;margin-top:16px;padding-top:12px}
.wm{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;
  display:flex;flex-wrap:wrap;align-content:flex-start;gap:0;opacity:.05}
/* min-width:0 matters: without it a flex item refuses to shrink below its
   nowrap text, and these tiles would widen the document behind the clip. */
.wm span{flex:0 0 50%;min-width:0;overflow:hidden;transform:rotate(-24deg);
  font-size:13px;font-weight:700;color:#0F172A;padding:30px 0;text-align:center;white-space:nowrap}
.wrap{position:relative;z-index:1}

/* ---- photography ----
   A hero photo carries an arbitrary image behind white type, so it needs a
   scrim to stay legible. That is the one gradient in the system and it is a
   legibility device, not decoration (see DESIGN.md).

   The gallery is a wrapping 3:2 grid — never a horizontal strip, whose only
   "there's more" signal is a scrollbar that macOS and every phone hide, so it
   read as four photos and done. Past the first eight the thumbnails sit behind
   a details/summary disclosure, which needs no script to open. Tapping any photo
   opens the viewer (.lb) when GALLERY_JS runs, and the full-size image in a new
   tab when it doesn't. */
.hero{position:relative;border-radius:12px;overflow:hidden;margin:0 0 16px;background:#0F172A;
  border:1px solid #E2E8F0}
.hero img{display:block;width:100%;height:auto;aspect-ratio:3/2;object-fit:cover}
.hero a{display:block;line-height:0}
/* The scrim sits over the bottom of the photo; letting taps fall through it
   makes the whole hero, not just its top half, open the viewer. */
.hero .scrim{pointer-events:none;position:absolute;inset:auto 0 0 0;padding:56px 20px 18px;color:#fff;
  background:linear-gradient(to top,rgba(15,23,42,.92) 0%,rgba(15,23,42,.72) 42%,rgba(15,23,42,0) 100%)}
.hero .addr{font-size:21px;font-weight:800;letter-spacing:-.02em;line-height:1.2;margin:0;
  text-shadow:0 1px 12px rgba(15,23,42,.5)}
.hero .sub{font-size:13px;color:#CBD5E1;margin:5px 0 0}
.hero .tag{display:inline-block;background:#fff;color:#0F172A;font-size:13px;font-weight:800;
  padding:5px 11px;border-radius:8px;margin:0 0 10px;font-variant-numeric:tabular-nums}
.shots{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.shots a{display:block;border-radius:8px;overflow:hidden;border:1px solid #E2E8F0;background:#F1F5F9;line-height:0}
.shots img{display:block;width:100%;height:auto;aspect-ratio:3/2;object-fit:cover}
/* A video tile is its poster with a play badge and the running time. */
.shots a{position:relative}
.shots .play{position:absolute;left:6px;bottom:6px;display:inline-flex;align-items:center;gap:5px;
  background:rgba(15,23,42,.84);color:#fff;font-size:11px;font-weight:700;line-height:1;padding:4px 7px;
  border-radius:6px;font-variant-numeric:tabular-nums}
.shots .play svg{width:9px;height:9px;fill:#fff}
@media(max-width:520px){.shots{grid-template-columns:repeat(2,minmax(0,1fr))}}
html.gal a[data-gal]{cursor:zoom-in}
html.gal a[data-video]{cursor:pointer}
.more{margin:8px 0 0}
.more summary{list-style:none;display:block;text-align:center;cursor:pointer;font-size:13px;font-weight:600;
  color:#0F172A;background:#fff;border:1px solid #E2E8F0;border-radius:8px;padding:9px 16px;margin:0 0 8px}
.more summary::-webkit-details-marker{display:none}
.more summary .less{display:none}
.more[open] summary .all{display:none}
.more[open] summary .less{display:inline}
/* The viewer. An overlay, so it is the one place besides the hero scrim that
   ink appears at alpha; no gradients, no shadows, and buttons are flat rings. */
.lb{position:fixed;inset:0;z-index:50;background:rgba(15,23,42,.97);
  display:flex;align-items:center;justify-content:center}
.lb[hidden]{display:none}
html.lb-open{overflow:hidden}
.lb-f{margin:0;width:100%;height:100vh;height:100dvh;display:flex;flex-direction:column;
  align-items:center;justify-content:center;padding:64px 72px}
.lb-f img{display:block;max-width:100%;max-height:100%;min-height:0;width:auto;height:auto;
  object-fit:contain;border-radius:4px;transition:opacity .2s}
.lb-f img:not([src]){visibility:hidden}
.lb.loading .lb-f img{opacity:.35}
.lb-f video{display:block;max-width:100%;max-height:100%;min-height:0;width:auto;height:auto;background:#000;border-radius:4px}
.lb-f img[hidden],.lb-f video[hidden]{display:none}
.lb-c{flex:0 0 auto;color:#CBD5E1;font-size:13px;line-height:1.4;margin:10px 0 0;text-align:center;max-width:640px}
.lb-c:empty{display:none}
.lb-i{position:absolute;top:0;left:64px;right:64px;height:64px;display:flex;align-items:center;justify-content:center;
  color:#CBD5E1;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;pointer-events:none}
.lb button{position:absolute;width:44px;height:44px;padding:0;border-radius:9999px;cursor:pointer;
  border:1px solid rgba(255,255,255,.24);background:rgba(255,255,255,.1);color:#fff;
  display:flex;align-items:center;justify-content:center;transition:background .15s}
.lb button:hover{background:rgba(255,255,255,.22)}
.lb button:focus-visible{outline:2px solid #fff;outline-offset:2px}
.lb-x{top:10px;right:10px}
.lb-p{left:14px;top:50%;transform:translateY(-50%)}
.lb-n{right:14px;top:50%;transform:translateY(-50%)}
@media(max-width:520px){.lb-f{padding:60px 10px 72px}
  .lb-p,.lb-n{top:auto;bottom:14px;transform:none}}
@media(prefers-reduced-motion:reduce){.lb,.lb *{transition:none}}
.noshot{padding:16px;text-align:center;background:#F1F5F9;color:#94A3B8;
  font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}

@media(max-width:520px){.wrap{padding:14px 12px 56px}.card{padding:16px}
  .hero .scrim{padding:48px 16px 15px}}

/* ---- brand header ----
   The operator's wordmark across the top of every investor-facing page, in the
   style of their marketing site: letterspaced uppercase mark, accent-colored
   middle dots, small-caps tagline. Colors arrive per-location (settings →
   company.brandPrimary/brandAccent), so they ride inline on the elements
   rather than living in this static sheet. */
.bbar{background:#fff;border-bottom:1px solid #E2E8F0;position:relative;z-index:1}
.bwrap{max-width:760px;margin:0 auto;padding:14px 16px 12px;
  display:flex;align-items:center;justify-content:space-between;gap:16px}
.blockup{display:flex;align-items:center;gap:11px}
.blogo{display:block;flex:0 0 auto}
.bmark{font-size:18px;font-weight:700;letter-spacing:.17em;line-height:1.1;text-transform:uppercase;white-space:nowrap}
a.bhome{text-decoration:none}
/* On a phone the lockup and the CTA compete for one row. The tagline is the
   part that can go — the mark and wordmark already say who this is — and the
   row is allowed to wrap, so a long CTA label drops to a second line instead
   of being clipped at the viewport edge on a narrow handset. */
@media(max-width:520px){
  .bwrap{flex-wrap:wrap;row-gap:10px;padding:12px 14px 10px}
  .blockup{gap:8px;min-width:0}
  .bmark{font-size:14px;letter-spacing:.12em}
  .bsub{display:none}
  /* Must NOT shrink: a shrinking nav gets squeezed and its CTA overflows
     the box instead of wrapping to the next line. */
  .bnav{flex:0 0 auto;justify-content:flex-end}
  .bnav a.bcta{padding:8px 11px;font-size:11px}}
.bsub{font-size:10px;font-weight:600;letter-spacing:.17em;text-transform:uppercase;color:#64748B;margin-top:4px}
.bnav{display:flex;align-items:center;gap:18px;flex-wrap:wrap;justify-content:flex-end}
.bnav a{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
  color:#334155;text-decoration:none}
.bnav a.bcta{color:#fff;padding:9px 14px;border-radius:8px}
/* Texted links open on phones: the plain nav links yield, the CTA stays. */
@media(max-width:640px){.bnav a:not(.bcta){display:none}}
`;

// Header branding from a location's company settings. `wordmark` may carry
// middle dots ("Shep·Flips") — each one renders in the accent color, the way
// the operator's own site sets its wordmark. Colors are validated as hex so a
// settings value can style the header but never break out of the attribute,
// and nav links must be http(s) so a stored value can't smuggle javascript:.
const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
const httpUrl = (v) => {
  const s = String(v || "").trim();
  return /^https?:\/\//i.test(s) ? s.slice(0, 300) : "";
};

export function brandFrom(company = {}) {
  const wordmark = clean(company.wordmark || company.name, 60);
  if (!wordmark) return null;
  const links = (Array.isArray(company.brandLinks) ? company.brandLinks : [])
    .map((l) => ({ label: clean(l?.label, 40), url: httpUrl(l?.url), cta: Boolean(l?.cta) }))
    .filter((l) => l.label && l.url)
    .slice(0, 6);
  return {
    wordmark,
    tagline: clean(company.tagline, 80),
    primary: HEX_RE.test(String(company.brandPrimary || "")) ? company.brandPrimary : "#0F172A",
    accent: HEX_RE.test(String(company.brandAccent || "")) ? company.brandAccent : "#2563EB",
    // An operator's own image wins over the drawn mark. http(s) only, for the
    // same reason the nav links are: a settings value must never be able to
    // smuggle a javascript: or data: URL onto an investor's screen.
    logoUrl: httpUrl(company.logoUrl),
    links,
  };
}

export function brandHeader(brand) {
  if (!brand?.wordmark) return "";
  const mark = esc(brand.wordmark)
    .split("·")
    .join(`<span style="color:${brand.accent}">·</span>`);
  const home = brand.links?.[0]?.url || "";
  // The house mark ahead of the wordmark, exactly as the marketing site sets
  // it. Drawn (shared/brand-mark.js) unless the operator pointed us at their
  // own file, so this needs no asset hosting and stays crisp at 30px.
  const logo = brand.logoUrl
    ? `<img class="blogo" src="${esc(brand.logoUrl)}" alt="" height="30" loading="lazy">`
    : `<span class="blogo">${brandMarkSvg({ primary: brand.primary, accent: brand.accent, height: 30 })}</span>`;
  const lockup = `<div class="blockup">
      ${logo}
      <div>
        <div class="bmark" style="color:${brand.primary}">${mark}</div>
        ${brand.tagline ? `<div class="bsub">${esc(brand.tagline)}</div>` : ""}
      </div>
    </div>`;
  // links[0] is the home link and lives on the lockup, so the nav is what's
  // left. A page may hand us only that one (the offer package does) — check
  // what's actually left rather than the full list, or the bar keeps an empty
  // <nav> and the flex gap it brings with it.
  const navLinks = (brand.links || []).slice(1);
  const nav = navLinks.length
    ? `<nav class="bnav">${navLinks
        .map((l) => l.cta
          ? `<a class="bcta" style="background:${brand.primary}" href="${esc(l.url)}">${esc(l.label)}</a>`
          : `<a href="${esc(l.url)}">${esc(l.label)}</a>`)
        .join("")}</nav>`
    : "";
  return `<header class="bbar"><div class="bwrap">
    ${home ? `<a class="bhome" href="${esc(home)}">${lockup}</a>` : lockup}
    ${nav}
  </div></header>`;
}

// `script` is inline source embedded verbatim before </body>. It runs only if
// the response's CSP names its hash — see secureHeaders — so a caller passing
// one must also have passed the same string to secureHeaders({ scripts }).
export function page({ title, css = "", body, watermark = "", brand = null, script = "" }) {
  const tiles = watermark
    ? `<div class="wm" aria-hidden="true">${Array.from({ length: 24 }, () => `<span>${esc(watermark)}</span>`).join("")}</div>`
    : "";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>${BASE_CSS}${css}</style>
</head><body>${brandHeader(brand)}${tiles}<div class="wrap">${body}</div>${script ? `<script>${script}</script>` : ""}</body></html>`;
}

// Standalone notice — bad link, expired, revoked, locked out. Deliberately
// says as little as possible about which one to anyone without a valid token.
export function renderNotice({ title, message, detail = "", eyebrow = "Secure investor dataroom" }) {
  return page({
    title,
    body: `<div class="card" style="margin-top:48px;text-align:center">
      <p class="eyebrow">${esc(eyebrow)}</p>
      <h1>${esc(title)}</h1>
      <p class="muted">${esc(message)}</p>
      ${detail ? `<p class="muted">${esc(detail)}</p>` : ""}
    </div>
    <p class="foot">If you believe this is a mistake, reply to the text you received and we'll send a fresh link.</p>`,
  });
}

/* ---------- the portfolio: every live deal on one page ---------- */

// One deal reduced to what a card needs, and the single source of truth behind
// both the portfolio HTML below and the public JSON feed the marketing site
// renders (GET /d/deals.json). The two must never disagree — above all about
// `spread`, which is derived rather than stored and would be the embarrassing
// one to get different in two places.
//
// Everything here is safe to publish. The snapshot also carries `notes`,
// `comps`, `scope` and `conditionSummary`; leaving them out is the point, so
// this is an explicit projection and never a spread of the snapshot.
export function dealCard(room) {
  const n = room?.snapshot?.numbers || {};
  const p = room?.snapshot?.property || {};
  const price = Math.round(num(n.investorPrice));
  const arv = Math.round(num(n.arv));
  const rehab = Math.round(num(n.repairs));
  // A non-positive spread reads as a broken deal rather than an honest one, so
  // it comes back as 0 and every surface hides it on the same rule.
  const spread = Math.max(0, arv - price - rehab);
  const photo = room?.heroPhoto || null;
  return {
    id: room?.id || "",
    shareToken: room?.shareToken || "",
    address: p.address || room?.address || "",
    headline: room?.snapshot?.headline || "",
    beds: p.beds ?? null,
    baths: p.baths ?? null,
    sqft: p.sqft || null,
    yearBuilt: p.yearBuilt || null,
    price, arv, rehab, spread,
    // Dimensions are the ORIGINAL's, not the thumbnail's. The downscale keeps
    // the aspect ratio, which is all a client needs to reserve the right box
    // and avoid layout shift.
    photo: photo ? { id: photo.id, width: photo.width || null, height: photo.height || null } : null,
    addedAt: room?.createdAt || null,
  };
}

// One link for the whole buyer list. Each card is a deal, linking through to
// its full package; the package pages link back here. `rooms` arrive already
// filtered to what should be public and in the order they should appear.
export function renderPortfolio({ rooms = [], company = {} }) {
  const card = (r) => {
    const d = dealCard(r);
    const bits = [
      d.beds != null ? `${d.beds} bd` : "",
      d.baths != null ? `${d.baths} ba` : "",
      d.sqft ? `${d.sqft.toLocaleString()} sqft` : "",
      d.yearBuilt ? `built ${d.yearBuilt}` : "",
    ].filter(Boolean).join(" · ");
    const figure = (k, v, cls = "") =>
      `<div class="pfig ${cls}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`;
    // The thumbnail is served under THIS deal's own share token, not the
    // portfolio's — the portfolio room has no offer of its own and so can't
    // authorize a photo. A revoked deal drops off this list entirely, so its
    // thumbnail dies with it.
    // A card with no photo gets a slim band rather than a full-height empty
    // frame — otherwise a portfolio of unphotographed deals is mostly grey.
    // Its price moves inline instead of being badged over nothing.
    const priceTag = d.price > 0 ? esc(money(d.price)) : "";
    return `<a class="deal" href="/d/${encodeURIComponent(d.shareToken)}">
      ${d.photo
        ? `<div class="shot">
             <img src="/d/${encodeURIComponent(d.shareToken)}/photo/${encodeURIComponent(d.photo.id)}/thumb"
               alt="" loading="lazy">
             ${priceTag ? `<span class="price">${priceTag}</span>` : ""}
           </div>`
        : `<div class="noshot">Photos coming soon</div>`}
      <div class="dealbody">
        ${!d.photo && priceTag ? `<div class="inprice">${priceTag}</div>` : ""}
        <div class="dealaddr">${esc(d.address || "Investment opportunity")}</div>
        ${bits ? `<div class="muted" style="font-size:12px;margin-top:2px">${esc(bits)}</div>` : ""}
        ${d.headline ? `<div style="font-size:13px;font-weight:600;margin-top:6px">${esc(d.headline)}</div>` : ""}
        <div class="pfigs">
          ${d.arv > 0 ? figure("ARV", money(d.arv)) : ""}
          ${d.rehab > 0 ? figure("Rehab", money(d.rehab)) : ""}
          ${d.spread > 0 ? figure("Spread", money(d.spread), "good") : ""}
        </div>
        <div class="more">See the photos, comps and numbers →</div>
      </div>
    </a>`;
  };

  const contactBits = [company.phone, company.email].filter(Boolean);
  // Company name is often left blank in settings, so fall back through the
  // other identifying fields before landing on something generic — this title
  // is what shows in a browser tab and in a shared-link preview.
  const brand = company.name || company.tagline || company.signer || "";
  return page({
    title: brand ? `${brand} — current deals` : "Current deals",
    css: `
      .grid{display:grid;grid-template-columns:1fr;gap:12px}
      @media(min-width:680px){.grid{grid-template-columns:1fr 1fr}}
      .deal{display:block;text-decoration:none;color:inherit;background:#fff;border:1px solid #E2E8F0;
        border-radius:12px;overflow:hidden}
      .deal .shot{position:relative;background:#F1F5F9;line-height:0}
      .deal .shot img{display:block;width:100%;height:auto;aspect-ratio:3/2;object-fit:cover}
      .deal .price{position:absolute;left:10px;bottom:10px;background:#0F172A;color:#fff;
        font-size:15px;font-weight:800;letter-spacing:-.01em;padding:6px 11px;border-radius:8px;
        font-variant-numeric:tabular-nums;line-height:1.2}
      .dealbody{padding:14px 16px 16px}
      .dealaddr{font-size:15px;font-weight:700;letter-spacing:-.015em;line-height:1.3}
      .pfigs{display:flex;flex-wrap:wrap;gap:1px;background:#E2E8F0;border:1px solid #E2E8F0;
        border-radius:8px;overflow:hidden;margin-top:12px}
      .pfig{background:#fff;padding:9px 12px;flex:1 1 88px;min-width:0}
      .pfig .k{font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#64748B}
      .pfig .v{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.01em;margin-top:1px}
      .pfig.good .v{color:#047857}
      .inprice{display:inline-block;background:#0F172A;color:#fff;font-size:15px;font-weight:800;
        letter-spacing:-.01em;padding:5px 10px;border-radius:8px;margin:0 0 8px;
        font-variant-numeric:tabular-nums;line-height:1.2}
      .more{font-size:13px;font-weight:600;color:#2563EB;margin-top:12px}
    `,
    body: `
      <div class="card">
        <p class="eyebrow">${esc(company.name || "Current deals")}${company.tagline ? ` · ${esc(company.tagline)}` : ""}</p>
        <h1>Current deals</h1>
        <p class="muted" style="margin:4px 0 0">
          ${rooms.length ? `${rooms.length} propert${rooms.length === 1 ? "y" : "ies"} available now — tap any one for the full package.`
            : "No properties are available right now. Check back shortly."}</p>
      </div>
      <div class="grid">${rooms.map(card).join("")}</div>
      ${contactBits.length ? `<div class="card">
        <h2>Want one of these?</h2>
        <p class="muted" style="margin-bottom:12px">First to commit takes it. Call or text
          ${esc(company.signer || company.name || "us")}.</p>
        <p style="margin:0">${contactBits.map((c) =>
          `<a href="${c.includes("@") ? `mailto:${esc(c)}` : `tel:${esc(String(c).replace(/[^\d+]/g, ""))}`}"
            style="font-weight:600">${esc(c)}</a>`).join(" &nbsp;·&nbsp; ")}</p>
      </div>` : ""}
      <p class="foot">Figures are estimates for underwriting, not an appraisal or a guarantee of value —
        verify independently during your inspection period.</p>`,
    brand: brandFrom(company),
    watermark: company.name || "",
  });
}

/* ---------- the package itself ---------- */

const dateLabel = (iso) => {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(iso)) ? `${iso}T12:00:00` : iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

const CONDITION_LABEL = {
  renovated: "Renovated", updated: "Updated", dated: "Dated",
  original: "Original", distressed: "Distressed",
};

function compsSection(snap) {
  const items = snap.comps?.items || [];
  if (!items.length) return "";
  const hasCond = items.some((c) => c.condition);
  const ppsf = (c) => (c.sqft > 0 ? Math.round(c.price / c.sqft) : null);
  const rows = items.map((c) => {
    const bits = [
      c.beds != null ? `${c.beds} bd` : "",
      c.baths != null ? `${c.baths} ba` : "",
      c.yearBuilt ? `${c.yearBuilt}` : "",
    ].filter(Boolean).join(" · ");
    return `<tr>
      <td><div style="font-weight:600">${esc(c.address)}</div>
        ${bits ? `<div class="muted" style="font-size:12px">${esc(bits)}</div>` : ""}</td>
      ${hasCond ? `<td>${c.condition ? `<span class="pill">${esc(CONDITION_LABEL[c.condition] || c.condition)}</span>` : ""}</td>` : ""}
      <td class="r">${c.sqft ? c.sqft.toLocaleString() : "—"}</td>
      <td class="r">${c.saleDate ? esc(c.saleDate.slice(0, 7)) : "—"}</td>
      <td class="r">${ppsf(c) ? `$${ppsf(c)}` : "—"}</td>
      <td class="r" style="font-weight:700">${esc(money(c.price))}</td>
    </tr>`;
  }).join("");
  const adj = (snap.comps.adjustments || [])
    .map((a) => `${esc(a.label)} ${a.pct > 0 ? "+" : "−"}${Math.abs(a.pct)}%`).join(", ");
  const sub = [
    snap.comps.months ? `Closed sales, last ${snap.comps.months} months` : "Closed sales",
    snap.comps.basis ? esc(snap.comps.basis) : "",
  ].filter(Boolean).join(" · ");
  return `<div class="card">
    <h2>Comparable sales</h2>
    <div class="scroll wide"><table>
      <thead><tr><th>Address</th>${hasCond ? "<th>Condition</th>" : ""}
        <th class="r">Sqft</th><th class="r">Sold</th><th class="r">$/sqft</th><th class="r">Price</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="hint">Swipe the table sideways to see every column.</p>
    <p class="muted" style="margin:12px 0 0;font-size:12px">${sub}${adj ? ` · ARV adjustments: ${adj}` : ""}</p>
  </div>`;
}

function scopeSection(snap) {
  const rows = snap.scope || [];
  if (!rows.length) return "";
  const total = rows.reduce((t, r) => t + num(r.cost), 0);
  return `<div class="card">
    <h2>Rehab scope of work</h2>
    ${snap.conditionSummary ? `<p class="muted">${esc(snap.conditionSummary)}</p>` : ""}
    <div class="scroll"><table>
      <thead><tr><th>Item</th><th class="r">Budget</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${esc(r.label)}</td><td class="r">${esc(money(r.cost))}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td style="font-weight:700;padding-top:10px">Total</td>
        <td class="r" style="font-weight:700;padding-top:10px">${esc(money(total))}</td></tr></tfoot>
    </table></div>
    <p class="muted" style="margin:12px 0 0;font-size:12px">
      Contractor estimate for underwriting. Verify during your inspection period.</p>
  </div>`;
}

// Generated PDFs and operator-added links share one card: from an investor's
// side they're the same thing — material to open — and splitting them into two
// stacks would just make them hunt twice.
//
// The link href is escaped like any other attribute, and normalizeLinks has
// already guaranteed the scheme is http/https. `rel="noopener noreferrer"`
// plus the page-wide `Referrer-Policy: no-referrer` means clicking out never
// hands the destination the tokenized room URL.
function documentsSection(snap, base) {
  const docs = snap.documents || [];
  const links = Array.isArray(snap.links) ? snap.links : [];
  if (!docs.length && !links.length) return "";
  const row = (label, kind, href) => `<div class="doc">
      <div><div style="font-weight:600;font-size:13px">${esc(label)}</div>
        <div class="muted" style="font-size:12px">${esc(kind)}</div></div>
      <a class="btn ghost" href="${esc(href)}" target="_blank" rel="noopener noreferrer">Open</a>
    </div>`;
  return `<div class="card">
    <h2>Documents${links.length ? " &amp; links" : ""}</h2>
    ${docs.map((d) => row(d.label, "PDF", `${base}/file/${encodeURIComponent(d.key)}`)).join("")}
    ${links.map((l) => row(l.label, l.host || "Link", l.url)).join("")}
  </div>`;
}

// `base` is the page's own URL root — /d/<token> for an invite-authorized
// package, /d/deal/<id> for the public teaser — so photos and files always
// resolve through the same authorization the page itself passed.
const photoUrl = (base, photo, variant) =>
  `${base}/photo/${encodeURIComponent(photo.id)}/${variant}`;

// The gallery in viewer order: the hero (first photo) leads, then the videos
// — a walkthrough is usually the most telling thing in the package, so it
// never sits behind the fold — then the remaining photos. `i` is what
// data-gal carries and what the viewer walks, so it has to be this order
// exactly. `label` is the link's accessible name when there's no caption:
// thumbnails have no text of their own.
function galleryItems(photos, videos) {
  const items = [];
  photos.forEach((p, k) => items.push({ kind: "photo", rec: p, hero: k === 0, label: `Photo ${k + 1} of ${photos.length}` }));
  const rest = items.splice(1);
  videos.forEach((v, k) => items.push({ kind: "video", rec: v, label: `Video ${k + 1} of ${videos.length}` }));
  items.push(...rest);
  return items.map((it, i) => ({ ...it, i }));
}

const mmss = (secs) => {
  const t = Math.max(0, Math.round(Number(secs) || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

const videoUrl = (base, video) => `${base}/video/${encodeURIComponent(video.id)}`;

// One gallery link. The href is what opens when the viewer isn't running: the
// full-size image, or the video stream itself, which every browser plays on
// its own. data-video and data-poster are what the viewer reads instead.
function galleryLink(item, base, inner) {
  const cap = item.rec.caption ? esc(item.rec.caption) : "";
  const href = item.kind === "video" ? videoUrl(base, item.rec) : photoUrl(base, item.rec, "full");
  const media = item.kind === "video" ? ` data-video="${href}" data-poster="${href}/poster/full"` : "";
  return `<a href="${href}" target="_blank" rel="noopener noreferrer"
      data-gal="${item.i}"${media}${cap ? ` data-cap="${cap}"` : ""}>${inner(cap || esc(item.label))}</a>`;
}

// How many tiles show before the disclosure: two full rows on a desktop (four
// across) and four on a phone (two across), so the fold never lands mid-row.
// Videos always show, even past eight of them.
const INLINE_SHOTS = 8;

// Everything after the hero: video tiles, then photo thumbnails, the first
// eight inline and the rest behind "Show all N photos". The viewer
// (photoViewer, below) walks every item whether or not the disclosure is open.
function photosSection(items, base) {
  const tiles = items.filter((it) => !it.hero);
  if (!tiles.length) return "";
  const photos = items.filter((it) => it.kind === "photo").length;
  const videos = items.filter((it) => it.kind === "video").length;
  const tile = (it) => galleryLink(it, base, (alt) => {
    const r = it.rec;
    const src = it.kind === "video" ? `${videoUrl(base, r)}/poster/thumb` : photoUrl(base, r, "thumb");
    const dims = r.width && r.height ? ` width="${r.width}" height="${r.height}"` : "";
    const badge = it.kind === "video"
      ? `<span class="play"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.5v9l7.5-4.5z"/></svg>${r.durationS ? esc(mmss(r.durationS)) : "Video"}</span>`
      : "";
    return `<img src="${src}" alt="${alt}" loading="lazy"${dims}>${badge}`;
  });
  const cut = Math.max(INLINE_SHOTS, videos);
  const inline = tiles.slice(0, cut).map(tile).join("");
  const more = tiles.slice(cut).map(tile).join("");
  const count = [
    photos ? `${photos} photo${photos === 1 ? "" : "s"}` : "",
    videos ? `${videos} video${videos === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" · ");
  return `<div class="card">
    <h2>Photos${videos ? " &amp; video" : ""}</h2>
    <div class="shots">${inline}</div>
    ${more ? `<details class="more">
      <summary><span class="all">Show all ${photos} photos</span><span class="less">Show fewer</span></summary>
      <div class="shots">${more}</div>
    </details>` : ""}
    <p class="muted" style="margin:10px 0 0;font-size:12px">
      ${count} · tap any one to see it full size.</p>
  </div>`;
}

// The full-screen viewer GALLERY_JS drives. Static markup, hidden until a
// gallery link is tapped; the script only ever fills in src, poster, alt,
// caption and counter, so nothing here is built from strings at runtime. The
// <video> stays hidden and empty until a walkthrough is shown.
function photoViewer() {
  const icon = (d) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
  return `<div class="lb" id="lb" hidden role="dialog" aria-modal="true" aria-label="Photo viewer">
    <div class="lb-i" aria-live="polite"></div>
    <button type="button" class="lb-x" data-lb="close" aria-label="Close">${icon("M6 6l12 12M18 6L6 18")}</button>
    <button type="button" class="lb-p" data-lb="prev" aria-label="Previous photo">${icon("M15 5l-7 7 7 7")}</button>
    <figure class="lb-f"><img alt=""><video controls playsinline preload="metadata" hidden></video><figcaption class="lb-c"></figcaption></figure>
    <button type="button" class="lb-n" data-lb="next" aria-label="Next photo">${icon("M9 5l7 7-7 7")}</button>
  </div>`;
}

// The full package. A named `invite` is a personal link — it gets the
// recipient's name in the watermark and the access stamp. The shared marketing
// link has no name, so it falls back to the company's own mark: there's no
// individual to attribute a view to, and pretending otherwise would be a lie.
//
// `teaser` mode is the public flavor the marketing site links to: the caller
// hands in a snapshot whose sections are already masked (teaserSections),
// photo URLs resolve through the tokenless publicPath, and the closing card
// sells the full package instead of assuming the reader already holds it.
export function renderRoom({ snap, token, invite, viewCount = 1, backLink = "", photos = [], videos = [], teaser = false, publicPath = "", brand = null }) {
  const s = snap.sections || DEFAULT_SECTIONS;
  const base = teaser ? publicPath : `/d/${encodeURIComponent(token)}`;
  const n = snap.numbers || {};
  const p = snap.property || {};
  const company = snap.company || {};
  const recipient = clean(invite?.name, 80);
  const equity = num(n.arv) - num(n.investorPrice) - num(n.repairs);

  const propBits = [
    p.beds != null ? `${p.beds} bd` : "",
    p.baths != null ? `${p.baths} ba` : "",
    p.sqft ? `${p.sqft.toLocaleString()} sqft` : "",
    p.yearBuilt ? `built ${p.yearBuilt}` : "",
  ].filter(Boolean).join("  ·  ");

  const figs = [
    `<div class="fig hero"><div class="k">Your purchase price</div><div class="v">${esc(money(n.investorPrice))}</div></div>`,
    num(n.arv) > 0 ? `<div class="fig"><div class="k">After-repair value</div><div class="v">${esc(money(n.arv))}</div></div>` : "",
    num(n.repairs) > 0 ? `<div class="fig"><div class="k">Est. rehab</div><div class="v">${esc(money(n.repairs))}</div></div>` : "",
    s.equity && equity > 0
      ? `<div class="fig good"><div class="k">Spread at ARV</div><div class="v">${esc(money(equity))}</div></div>` : "",
  ].filter(Boolean).join("");

  const terms = [
    snap.terms?.closingDate ? ["Target closing", dateLabel(snap.terms.closingDate)] : null,
    snap.terms?.inspectionDate ? ["Inspection deadline", dateLabel(snap.terms.inspectionDate)] : null,
  ].filter(Boolean);

  const feeRows = s.feeBreakdown
    ? `<div class="card"><h2>Price breakdown</h2><table><tbody>
        <tr><td>Contract price</td><td class="r">${esc(money(n.contractPrice))}</td></tr>
        <tr><td>Assignment fee</td><td class="r">${esc(money(n.assignmentFee))}</td></tr>
        <tr><td style="font-weight:700">Your total</td>
          <td class="r" style="font-weight:700">${esc(money(n.investorPrice))}</td></tr>
      </tbody></table></div>`
    : "";

  const contactBits = [company.phone, company.email].filter(Boolean);
  // Hero is the first photo by sort order; the operator promotes one by moving
  // it to the front rather than by flagging it.
  const items = s.photos !== false ? galleryItems(photos, videos) : [];
  const hero = items.find((it) => it.hero) || null;

  const body = `
    ${backLink ? `<p style="margin:0 0 12px"><a href="${esc(backLink)}"
      style="font-size:13px;font-weight:600;text-decoration:none">← All current deals</a></p>` : ""}
    ${hero ? `<div class="hero">
      ${galleryLink(hero, base, () => `<img src="${photoUrl(base, hero.rec, "full")}" alt="${esc(p.address || "The property")}"
        ${hero.rec.width && hero.rec.height ? `width="${hero.rec.width}" height="${hero.rec.height}"` : ""}>`)}
      <div class="scrim">
        ${num(n.investorPrice) > 0 ? `<div class="tag">${esc(money(n.investorPrice))}</div>` : ""}
        <p class="addr">${esc(p.address || "Investment opportunity")}</p>
        ${propBits ? `<p class="sub">${esc(propBits)}</p>` : ""}
      </div>
    </div>
    ${snap.headline || p.zillow ? `<div class="card">
      <p class="eyebrow">${esc(company.name || "Investor package")}${company.tagline ? ` · ${esc(company.tagline)}` : ""}</p>
      ${snap.headline ? `<p style="margin:0;font-weight:600">${esc(snap.headline)}</p>` : ""}
      ${p.zillow ? `<p style="margin:8px 0 0"><a href="${esc(p.zillow)}" target="_blank" rel="noopener noreferrer nofollow" style="font-size:13px">View the property on Zillow →</a></p>` : ""}
    </div>` : ""}`
    : `<div class="card">
      <p class="eyebrow">${esc(company.name || "Investor package")}${company.tagline ? ` · ${esc(company.tagline)}` : ""}</p>
      <h1>${esc(p.address || "Investment opportunity")}</h1>
      ${propBits ? `<p class="muted" style="margin-bottom:2px">${esc(propBits)}</p>` : ""}
      ${snap.headline ? `<p style="margin-top:10px;font-weight:600">${esc(snap.headline)}</p>` : ""}
      ${p.zillow ? `<p style="margin:8px 0 0"><a href="${esc(p.zillow)}" target="_blank" rel="noopener noreferrer nofollow" style="font-size:13px">View the property on Zillow →</a></p>` : ""}
    </div>`}

    ${s.summary ? `<div class="figs" style="margin-bottom:16px">${figs}</div>` : ""}
    ${photosSection(items, base)}
    ${items.length ? photoViewer() : ""}
    ${feeRows}

    ${snap.notes && !teaser ? `<div class="card"><h2>Deal notes</h2><p class="muted" style="white-space:pre-wrap;margin:0">${esc(snap.notes)}</p></div>` : ""}

    ${s.terms && terms.length ? `<div class="card"><h2>Terms</h2><table><tbody>
      ${terms.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r" style="font-weight:600">${esc(v)}</td></tr>`).join("")}
    </tbody></table></div>` : ""}

    ${s.comps ? compsSection(snap) : ""}
    ${s.scope ? scopeSection(snap) : ""}
    ${s.documents ? documentsSection(snap, base) : ""}

    ${teaser
      ? `<div class="card">
      <h2>Get the full package</h2>
      <p class="muted" style="margin-bottom:14px">
        The complete investor package — every photo, the comparable-sales analysis, the full rehab
        scope and the documents — goes out by personal link. ${contactBits.length ? "Call or text" : "Reach"}
        ${esc(company.signer || company.name || "us")} and we'll send yours.</p>
      ${contactBits.length ? `<p style="margin:0">${contactBits.map((c) =>
        `<a href="${c.includes("@") ? `mailto:${esc(c)}` : `tel:${esc(String(c).replace(/[^\d+]/g, ""))}`}"
          style="font-weight:600">${esc(c)}</a>`).join(" &nbsp;·&nbsp; ")}</p>` : ""}
      <div class="stamp">Listed by <strong>${esc(company.name || company.signer || "us")}</strong>
        · ${esc(new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }))}</div>
    </div>`
      : `<div class="card">
      <h2>Take the deal</h2>
      <p class="muted" style="margin-bottom:14px">
        ${recipient ? "Reply to the text you received, or reach" : "First to commit takes it. Call or text"}
        ${esc(company.signer || company.name || "us")}${recipient ? " directly" : ""}.</p>
      ${contactBits.length ? `<p style="margin:0">${contactBits.map((c) =>
        `<a href="${c.includes("@") ? `mailto:${esc(c)}` : `tel:${esc(String(c).replace(/[^\d+]/g, ""))}`}"
          style="font-weight:600">${esc(c)}</a>`).join(" &nbsp;·&nbsp; ")}</p>` : ""}
      <div class="stamp">
        ${recipient
          ? `Prepared for <strong>${esc(recipient)}</strong>${invite?.phone ? ` (…${esc(String(invite.phone).slice(-4))})` : ""}
             · opened ${viewCount} time${viewCount === 1 ? "" : "s"}
             · ${esc(new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }))}
             ${invite?.expiresAt ? `<br>This link expires ${esc(dateLabel(invite.expiresAt))}.` : ""}
             <br>This link is yours alone — please don't forward it.`
          : `Prepared by <strong>${esc(company.name || company.signer || "us")}</strong>
             · ${esc(new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }))}
             ${invite?.expiresAt ? `<br>This link expires ${esc(dateLabel(invite.expiresAt))}.` : ""}`}
      </div>
    </div>`}

    ${backLink ? `<p style="text-align:center;margin:0 0 18px"><a href="${esc(backLink)}"
      style="font-size:13px;font-weight:600;text-decoration:none">← See every current deal</a></p>` : ""}

    <p class="foot">${recipient
      ? `Confidential. This package was issued to ${esc(recipient)} and every view is logged. `
      : ""}Figures are estimates for underwriting, not an appraisal or a guarantee of value —
      verify independently during your inspection period.</p>`;

  return page({
    title: `${p.address || "Investment opportunity"} — ${teaser ? "off-market deal" : "investor package"}`,
    body,
    // Live-resolved brand from the route when it has one; the snapshot's own
    // company block as the fallback, so a page never renders nameless.
    brand: brand || brandFrom(company),
    // A personal link is marked confidential to its recipient. The shared link
    // is meant to circulate, so it carries the company's mark instead. The
    // public teaser is deliberately unmarked — nothing on it is confidential.
    watermark: teaser ? "" : recipient ? `${recipient} · CONFIDENTIAL` : (company.name || "CONFIDENTIAL"),
    // The viewer only when there is something to view. Its hash is in the CSP
    // regardless (the routes pass GALLERY_JS to secureHeaders), which is
    // harmless: an allowance for a script that isn't on the page.
    script: items.length ? GALLERY_JS : "",
  });
}
