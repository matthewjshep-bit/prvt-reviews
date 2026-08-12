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

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const clean = (v, max = 200) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// Comps the operator actually selected, plus any added by hand — the same
// selection the Comparable Sales Analysis PDF prints.
function pickedComps(snapshot) {
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
    ...(Array.isArray(cs.manual) ? cs.manual : []).map(withCondition),
  ].filter((c) => c.price > 0).slice(0, 24);
}

// Build the frozen investor package from an offer. Taken once at creation so
// later edits to the offer never change what an investor already opened;
// the operator refreshes deliberately via PUT /api/datarooms/:id.
export function buildSnapshot({ offer, settings = {}, sections, headline = "", notes = "" }) {
  const inputs = offer?.calc?.inputs || {};
  const deal = offer?.deal || null;
  const snap = offer?.snapshot || null;
  const company = offer?.calc?.settings?.company || settings?.company || {};

  // Whole dollars throughout. The offer calc deliberately jitters cents onto
  // the cash offer so it reads as calculated rather than round, but those cents
  // ride through into contractPrice and read as sloppiness on a deal package.
  const contractPrice = Math.round(num(deal?.contractPrice) || num(offer?.cashAmount));
  const assignmentFee = Math.round(deal ? num(deal.assignmentFee) : num(settings?.wholesaleFee));
  const investorPrice = contractPrice + assignmentFee;
  const arv = Math.round(num(inputs.arv));
  const repairs = Math.round(num(inputs.repairs) || (offer?.scope || []).reduce((t, s) => t + num(s.cost), 0));

  const subject = snap?.comps?.result?.info || snap?.subjectInfo || null;

  return {
    builtAt: new Date().toISOString(),
    sections: normalizeSections(sections),
    headline: clean(headline, 120),
    notes: clean(notes, 2000),
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
    numbers: { investorPrice, arv, repairs, contractPrice, assignmentFee },
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

// Headers every dataroom response carries: no indexing, no referrer leak of
// the token, no caching of confidential content, no framing.
export function secureHeaders(res) {
  res.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
  res.set("Referrer-Policy", "no-referrer");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("X-Frame-Options", "DENY");
  res.set("X-Content-Type-Options", "nosniff");
  res.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; " +
    "form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
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

const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", "Plus Jakarta Sans", system-ui, sans-serif`;

const BASE_CSS = `
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
   legibility device, not decoration (see DESIGN.md). Everything here is pure
   CSS: the investor pages have no script-src, so no carousel or JS lightbox is
   possible — the gallery is a scroll-snap strip and photos open full-size in a
   new tab. */
.hero{position:relative;border-radius:12px;overflow:hidden;margin:0 0 16px;background:#0F172A;
  border:1px solid #E2E8F0}
.hero img{display:block;width:100%;height:auto;aspect-ratio:3/2;object-fit:cover}
.hero .scrim{position:absolute;inset:auto 0 0 0;padding:56px 20px 18px;color:#fff;
  background:linear-gradient(to top,rgba(15,23,42,.92) 0%,rgba(15,23,42,.72) 42%,rgba(15,23,42,0) 100%)}
.hero .addr{font-size:21px;font-weight:800;letter-spacing:-.02em;line-height:1.2;margin:0;
  text-shadow:0 1px 12px rgba(15,23,42,.5)}
.hero .sub{font-size:13px;color:#CBD5E1;margin:5px 0 0}
.hero .tag{display:inline-block;background:#fff;color:#0F172A;font-size:13px;font-weight:800;
  padding:5px 11px;border-radius:8px;margin:0 0 10px;font-variant-numeric:tabular-nums}
.shots{display:flex;gap:8px;overflow-x:auto;-webkit-overflow-scrolling:touch;
  scroll-snap-type:x mandatory;padding:2px 0 6px;margin:0 -2px}
.shots a{flex:0 0 auto;scroll-snap-align:start;border-radius:8px;overflow:hidden;
  border:1px solid #E2E8F0;background:#F1F5F9;line-height:0}
.shots img{display:block;width:164px;height:116px;object-fit:cover}
@media(max-width:520px){.shots img{width:140px;height:100px}}
.noshot{padding:16px;text-align:center;background:#F1F5F9;color:#94A3B8;
  font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}

@media(max-width:520px){.wrap{padding:14px 12px 56px}.card{padding:16px}
  .hero .scrim{padding:48px 16px 15px}}
`;

function page({ title, css = "", body, watermark = "" }) {
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
</head><body>${tiles}<div class="wrap">${body}</div></body></html>`;
}

// Standalone notice — bad link, expired, revoked, locked out. Deliberately
// says as little as possible about which one to anyone without a valid token.
export function renderNotice({ title, message, detail = "" }) {
  return page({
    title,
    body: `<div class="card" style="margin-top:48px;text-align:center">
      <p class="eyebrow">Secure investor dataroom</p>
      <h1>${esc(title)}</h1>
      <p class="muted">${esc(message)}</p>
      ${detail ? `<p class="muted">${esc(detail)}</p>` : ""}
    </div>
    <p class="foot">If you believe this is a mistake, reply to the text you received and we'll send a fresh link.</p>`,
  });
}

/* ---------- the portfolio: every live deal on one page ---------- */

// One link for the whole buyer list. Each card is a deal, linking through to
// its full package; the package pages link back here. `rooms` arrive already
// filtered to what should be public and in the order they should appear.
export function renderPortfolio({ rooms = [], company = {} }) {
  const card = (r) => {
    const n = r.snapshot?.numbers || {};
    const p = r.snapshot?.property || {};
    const spread = num(n.arv) - num(n.investorPrice) - num(n.repairs);
    const bits = [
      p.beds != null ? `${p.beds} bd` : "",
      p.baths != null ? `${p.baths} ba` : "",
      p.sqft ? `${p.sqft.toLocaleString()} sqft` : "",
      p.yearBuilt ? `built ${p.yearBuilt}` : "",
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
    const priceTag = num(n.investorPrice) > 0 ? esc(money(n.investorPrice)) : "";
    return `<a class="deal" href="/d/${encodeURIComponent(r.shareToken)}">
      ${r.heroPhoto
        ? `<div class="shot">
             <img src="/d/${encodeURIComponent(r.shareToken)}/photo/${encodeURIComponent(r.heroPhoto.id)}/thumb"
               alt="" loading="lazy">
             ${priceTag ? `<span class="price">${priceTag}</span>` : ""}
           </div>`
        : `<div class="noshot">Photos coming soon</div>`}
      <div class="dealbody">
        ${!r.heroPhoto && priceTag ? `<div class="inprice">${priceTag}</div>` : ""}
        <div class="dealaddr">${esc(p.address || r.address || "Investment opportunity")}</div>
        ${bits ? `<div class="muted" style="font-size:12px;margin-top:2px">${esc(bits)}</div>` : ""}
        ${r.snapshot?.headline ? `<div style="font-size:13px;font-weight:600;margin-top:6px">${esc(r.snapshot.headline)}</div>` : ""}
        <div class="pfigs">
          ${num(n.arv) > 0 ? figure("ARV", money(n.arv)) : ""}
          ${num(n.repairs) > 0 ? figure("Rehab", money(n.repairs)) : ""}
          ${spread > 0 ? figure("Spread", money(spread), "good") : ""}
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

function documentsSection(snap, token) {
  const docs = snap.documents || [];
  if (!docs.length) return "";
  return `<div class="card">
    <h2>Documents</h2>
    ${docs.map((d) => `<div class="doc">
      <div><div style="font-weight:600;font-size:13px">${esc(d.label)}</div>
        <div class="muted" style="font-size:12px">PDF</div></div>
      <a class="btn ghost" href="/d/${encodeURIComponent(token)}/file/${encodeURIComponent(d.key)}"
        target="_blank" rel="noopener noreferrer">Open</a>
    </div>`).join("")}
  </div>`;
}

const photoUrl = (token, photo, variant) =>
  `/d/${encodeURIComponent(token)}/photo/${encodeURIComponent(photo.id)}/${variant}`;

// The rest of the photos, after the hero. A scroll-snap strip rather than a
// grid so it stays one gesture on a phone; each opens full-size in a new tab,
// which beats a :target lightbox on a page we can't debug in the wild.
function photosSection(photos, token) {
  const rest = photos.slice(1);
  if (!rest.length) return "";
  return `<div class="card">
    <h2>Photos</h2>
    <div class="shots">
      ${rest.map((p) => `<a href="${photoUrl(token, p, "full")}" target="_blank" rel="noopener noreferrer">
        <img src="${photoUrl(token, p, "thumb")}" alt="" loading="lazy"
          ${p.width && p.height ? `width="${p.width}" height="${p.height}"` : ""}></a>`).join("")}
    </div>
    <p class="muted" style="margin:8px 0 0;font-size:12px">
      ${rest.length + 1} photo${rest.length ? "s" : ""} · tap any one to see it full size.</p>
  </div>`;
}

// The full package. A named `invite` is a personal link — it gets the
// recipient's name in the watermark and the access stamp. The shared marketing
// link has no name, so it falls back to the company's own mark: there's no
// individual to attribute a view to, and pretending otherwise would be a lie.
export function renderRoom({ snap, token, invite, viewCount = 1, backLink = "", photos = [] }) {
  const s = snap.sections || DEFAULT_SECTIONS;
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
  const hero = s.photos !== false ? photos[0] : null;

  const body = `
    ${backLink ? `<p style="margin:0 0 12px"><a href="${esc(backLink)}"
      style="font-size:13px;font-weight:600;text-decoration:none">← All current deals</a></p>` : ""}
    ${hero ? `<div class="hero">
      <img src="${photoUrl(token, hero, "full")}" alt="${esc(p.address || "The property")}"
        ${hero.width && hero.height ? `width="${hero.width}" height="${hero.height}"` : ""}>
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
    ${s.photos !== false ? photosSection(photos, token) : ""}
    ${feeRows}

    ${snap.notes ? `<div class="card"><h2>Deal notes</h2><p class="muted" style="white-space:pre-wrap;margin:0">${esc(snap.notes)}</p></div>` : ""}

    ${s.terms && terms.length ? `<div class="card"><h2>Terms</h2><table><tbody>
      ${terms.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r" style="font-weight:600">${esc(v)}</td></tr>`).join("")}
    </tbody></table></div>` : ""}

    ${s.comps ? compsSection(snap) : ""}
    ${s.scope ? scopeSection(snap) : ""}
    ${s.documents ? documentsSection(snap, token) : ""}

    <div class="card">
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
    </div>

    ${backLink ? `<p style="text-align:center;margin:0 0 18px"><a href="${esc(backLink)}"
      style="font-size:13px;font-weight:600;text-decoration:none">← See every current deal</a></p>` : ""}

    <p class="foot">${recipient
      ? `Confidential. This package was issued to ${esc(recipient)} and every view is logged. `
      : ""}Figures are estimates for underwriting, not an appraisal or a guarantee of value —
      verify independently during your inspection period.</p>`;

  return page({
    title: `${p.address || "Investment opportunity"} — investor package`,
    body,
    // A personal link is marked confidential to its recipient. The shared link
    // is meant to circulate, so it carries the company's mark instead.
    watermark: recipient ? `${recipient} · CONFIDENTIAL` : (company.name || "CONFIDENTIAL"),
  });
}
