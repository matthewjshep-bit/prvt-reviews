// offer-page.js — the agent-facing offer package.
//
// The investor dataroom (dataroom.js) answers "should I buy this deal from
// you". This answers a different question, for a different reader: a listing
// agent who just got a cash offer well under asking and is deciding whether to
// take it to their seller or bin it.
//
// So it shares the dataroom's plumbing — same token model, same page shell and
// CSS, same frozen-snapshot rule, same no-JavaScript CSP — and almost none of
// its copy or content. Three things are deliberately different:
//
//   1. The arithmetic is the point. An agent who can see how the number was
//      built argues with the inputs instead of dismissing the offer. That's
//      shared/offer-breakdown.js, and it never shows our assignment fee.
//   2. The seller's net is here. It's the one figure an agent actually
//      presents, and it's what makes a lower gross number defensible.
//   3. No fee breakdown, no investor pricing, no spread. An agent must never
//      see what we resell for; the dataroom's feeBreakdown section has no
//      equivalent here and there is no toggle that could turn one on.
//
// Storage rides on the `datarooms` table with kind:"offer" — see the isolation
// note in routes/offer-page.js for why that must never leak into the investor
// feed.

import { netComparison } from "./shared/offer-calc.js";
import { zillowUrl } from "./shared/us-address.js";
import { offerBreakdown } from "./shared/offer-breakdown.js";
import { esc, page, pickedComps } from "./dataroom.js";

const num = (v) => {
  const n = Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const clean = (v, max) => String(v ?? "").trim().slice(0, max);
const money = (n) => `$${Math.round(num(n)).toLocaleString("en-US")}`;

/* ============================================================= *
 * sections
 * ============================================================= */

// `offer` is not in here on purpose: the price and the property are the page.
// A package that can hide its own offer is a blank page with a header.
export const OFFER_SECTION_KEYS = ["breakdown", "comps", "scope", "netsheet", "note", "documents"];

// Everything on except the breakdown. Showing your working is a per-offer
// judgement — persuasive to an agent who's pushing back on price, needless
// noise on an offer that's already close to asking.
export const DEFAULT_OFFER_SECTIONS = {
  breakdown: false, comps: true, scope: true, netsheet: true, note: true, documents: true,
};

export function normalizeOfferSections(input) {
  const out = { ...DEFAULT_OFFER_SECTIONS };
  for (const k of OFFER_SECTION_KEYS) {
    if (input && typeof input[k] === "boolean") out[k] = input[k];
  }
  return out;
}

/* ============================================================= *
 * snapshot
 * ============================================================= */

// Documents an agent may open. The PSA is here on purpose — it is the
// seller-facing offer, and putting it in front of the listing broker is the
// whole reason it exists. The generic contract and the assignment PDF are NOT:
// one is an internal template, the other goes to the end buyer.
export const OFFER_DOC_KINDS = {
  offer: { docKind: "pdf", urlKey: "pdfUrl", label: "The written offer" },
  psa: { docKind: "psapdf", urlKey: "psaPdfUrl", label: "Purchase & sale agreement" },
  comps: { docKind: "compspdf", urlKey: "compsPdfUrl", label: "Comparable sales analysis" },
  scope: { docKind: "scopepdf", urlKey: "scopePdfUrl", label: "Renovation scope of work" },
  netsheet: { docKind: "netsheetpdf", urlKey: "netSheetPdfUrl", label: "Seller net comparison" },
};

// Freeze the package from an offer. Taken once, so editing the offer afterwards
// never changes what an agent already opened; the operator refreshes on
// purpose. headline/note are operator-authored and must be passed back in on a
// refresh or rebuilding from the offer would silently drop them.
export function buildOfferSnapshot({ offer, settings = {}, sections, headline = "", note = "" }) {
  const inputs = offer?.calc?.inputs || {};
  const snap = offer?.snapshot || null;
  const company = offer?.calc?.settings?.company || settings?.company || {};
  const effective = offer?.calc?.settings || settings || {};

  const amount = Math.round(num(offer?.cashAmount) || num(offer?.calc?.offers?.cash?.amount));
  const net = netComparison(amount, effective);
  const subject = snap?.comps?.result?.info || snap?.subjectInfo || null;

  // The letter's own terms table, so the page and the PDF can't disagree.
  const terms = (Array.isArray(snap?.letterTerms) ? snap.letterTerms : [])
    .map((t) => ({ label: clean(t?.label, 60), value: clean(t?.value ?? t?.text, 240) }))
    .filter((t) => t.label && t.value)
    .slice(0, 12);

  return {
    builtAt: new Date().toISOString(),
    kind: "offer",
    sections: normalizeOfferSections(sections),
    headline: clean(headline, 120),
    note: clean(note, 2000),
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
    },
    offer: {
      amount,
      dateLabel: clean(offer?.dateLabel, 40),
      validLabel: clean(offer?.validLabel, 40),
      askingPrice: Math.round(num(inputs.askingPrice)) || null,
      terms,
    },
    // Precomputed and frozen: the page must show the same arithmetic six weeks
    // from now even if settings change underneath it.
    breakdown: offerBreakdown(offer),
    netsheet: net ? {
      offer: Math.round(net.offer),
      sellerPct: net.sellerPct,
      buyerPct: net.buyerPct,
      netA: Math.round(net.netA),
      listPrice: Math.round(net.listPrice),
      sellerCommissionA: Math.round(net.sellerCommissionA),
      sellerCommissionB: Math.round(net.sellerCommissionB),
      buyerCommissionB: Math.round(net.buyerCommissionB),
    } : null,
    comps: {
      // Each comp carries its own Zillow link so the agent can check our work
      // rather than take the table on faith — the whole point of showing comps
      // to someone who sells houses for a living. Frozen with the rest of the
      // snapshot; a URL derived from an address can't go stale on its own.
      items: pickedComps(snap).map((c) => ({ ...c, zillow: zillowUrl(c.address) || "" })),
      basis: clean(snap?.comps?.arvBasis, 120),
      months: Math.round(num(snap?.comps?.months)) || null,
    },
    scope: (offer?.scope || []).slice(0, 60)
      .map((s) => ({ label: clean(s.label, 120), cost: Math.round(num(s.cost)) })),
    documents: Object.entries(OFFER_DOC_KINDS)
      .filter(([, def]) => offer?.[def.urlKey])
      .map(([key, def]) => ({ key, label: def.label })),
  };
}

// Rebuild every agent-facing page for an offer that was just revised.
//
// The page's own freeze — "taken once, so editing the offer afterwards never
// changes what an agent already opened" — was written when editing an offer
// meant creating a different one. Now that a save re-renders the very PDFs this
// page serves by offer id, staying frozen would mean printing last week's price
// directly above this morning's attachment. So the page follows the offer; the
// operator's own words (headline, note, section toggles) ride across untouched.
//
// Best-effort: a page that won't save must never fail the save that triggered
// it. Never throws.
export async function refreshOfferPages({ store, locationId, offer, settings = {} }) {
  let refreshed = 0;
  try {
    for (const room of await store.listDatarooms(locationId, { offerId: offer.id })) {
      if (room?.kind !== "offer") continue;
      room.snapshot = buildOfferSnapshot({
        offer, settings,
        sections: room.snapshot?.sections,
        headline: room.snapshot?.headline,
        note: room.snapshot?.note,
      });
      room.address = offer.address || room.address;
      await store.updateDataroom(room.id, room);
      refreshed++;
    }
  } catch (e) {
    console.error(`offer-page: refresh failed offer=${offer?.id}:`, e?.message);
  }
  return refreshed;
}

/* ============================================================= *
 * HTML
 * ============================================================= */

const OFFER_CSS = `
.lead{background:#0F172A;border-radius:12px;padding:22px 20px;margin:0 0 16px;color:#fff}
.lead .addr{font-size:24px;font-weight:800;letter-spacing:-.02em;line-height:1.2;margin:0;
  color:#fff;overflow-wrap:break-word}
.lead .facts{font-size:13px;color:#CBD5E1;margin-top:6px}
/* The offer sits in its own block under the address, divided rather than
   merely spaced — the rule is what stops the number reading as another fact
   about the property. */
.lead .amt{margin-top:16px;padding-top:16px;border-top:1px solid rgba(255,255,255,.14)}
.lead .k{font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#94A3B8;margin-bottom:4px}
.lead .v{font-size:20px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.1}
.lead .sub{font-size:13px;color:#CBD5E1;margin-top:10px}
.stack td{border-bottom:0;padding:7px 8px 7px 0}
.stack tr.tot td{border-top:2px solid #0F172A;font-weight:800;padding-top:11px;font-size:15px}
.stack td.r{font-variant-numeric:tabular-nums;text-align:right;padding-right:0}
.stack .op{color:#94A3B8;width:14px;padding-right:6px;text-align:center}
td a{color:#2563EB;text-decoration:none;border-bottom:1px solid rgba(37,99,235,.3)}
.note p{margin:0 0 10px;font-size:14px}.note p:last-child{margin:0}
.netrow{display:flex;flex-wrap:wrap;gap:1px;background:#E2E8F0;border:1px solid #E2E8F0;border-radius:8px;overflow:hidden}
.netcol{background:#fff;padding:14px 16px;flex:1 1 200px;min-width:0}
.netcol.win{background:#ECFDF5}
.netcol .t{font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#64748B;margin-bottom:8px}
.netcol .k{font-size:12px;color:#475569;margin-bottom:2px}
.netcol .big{font-size:20px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.netcol .ln{display:flex;justify-content:space-between;gap:10px;font-size:12px;color:#475569;margin-top:5px;
  font-variant-numeric:tabular-nums}
/* The net is the arithmetic's answer, so it sits under a rule at the foot of
   the column rather than at the top — price first, deductions, then what's
   left. Green only in our column, and only on this line: the offer price
   above it is a plain number, not a claim. */
.netcol .net{display:flex;justify-content:space-between;gap:10px;align-items:baseline;margin-top:10px;
  padding-top:9px;border-top:1px solid #CBD5E1;font-variant-numeric:tabular-nums}
.netcol .net span:first-child{font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#64748B}
.netcol .net span:last-child{font-size:20px;font-weight:800;letter-spacing:-.02em}
.netcol.win .net{border-top-color:#A7F3D0}
.netcol.win .net span:last-child{color:#047857}
`;

// The property leads, the offer follows. An agent opening this on a phone is
// triaging — they have several properties in play and need to know WHICH one
// before the number means anything. So the address is the page's h1, and the
// offer sits under it as the answer to a question the address has already asked.
function leadCard(snap) {
  const o = snap.offer || {};
  const p = snap.property || {};
  const facts = [
    p.beds != null ? `${p.beds} bd` : "",
    p.baths != null ? `${p.baths} ba` : "",
    p.sqft ? `${p.sqft.toLocaleString("en-US")} sqft` : "",
    p.yearBuilt ? `built ${p.yearBuilt}` : "",
  ].filter(Boolean).join(" · ");
  const valid = o.validLabel ? `Valid through ${esc(o.validLabel)}` : "";
  const asking = o.askingPrice ? `Asking ${money(o.askingPrice)}` : "";
  return `<div class="lead">
    <h1 class="addr">${esc(p.address || "")}</h1>
    ${facts ? `<div class="facts">${esc(facts)}</div>` : ""}
    <div class="amt">
      <div class="k">All-cash offer</div>
      <div class="v">${money(o.amount)}</div>
    </div>
    ${valid || asking ? `<div class="sub">${[asking, valid].filter(Boolean).join(" · ")}</div>` : ""}
  </div>`;
}

function noteSection(snap) {
  if (!snap.note && !snap.headline) return "";
  const paras = String(snap.note || "").split(/\n{2,}/).filter(Boolean)
    .map((t) => `<p>${esc(t).replace(/\n/g, "<br>")}</p>`).join("");
  return `<div class="card">
    <h2>${esc(snap.headline || "A note on this offer")}</h2>
    <div class="note">${paras || `<p class="muted">—</p>`}</div>
  </div>`;
}

function termsSection(snap) {
  const rows = snap.offer?.terms || [];
  if (!rows.length) return "";
  return `<div class="card"><h2>Terms</h2><table>${rows.map((t) => `<tr>
    <td style="color:#64748B;white-space:nowrap">${esc(t.label)}</td>
    <td>${esc(t.value)}</td></tr>`).join("")}</table></div>`;
}

function breakdownSection(snap) {
  const b = snap.breakdown;
  if (!b || !b.rows?.length) return "";
  const rows = b.rows.map((r) => `<tr>
    <td class="op">${r.sign === "+" ? "" : "−"}</td>
    <td>${esc(r.label)}</td>
    <td class="r">${money(r.amount)}</td></tr>`).join("");
  return `<div class="card">
    <h2>How we got to this number</h2>
    <table class="stack">${rows}
      <tr class="tot"><td class="op"></td><td>Our offer</td><td class="r">${money(b.total)}</td></tr>
    </table>
    <p class="muted" style="margin-top:12px">${esc(b.basis)}</p>
  </div>`;
}

function netSection(snap) {
  const n = snap.netsheet;
  if (!n) return "";
  // The comparison an agent can actually take to a seller: our offer with only
  // their side of the commission, against the list price a traditional sale
  // would need to leave the seller the same money.
  // Both columns start with a price and end with the same net, so the two
  // sides are read as like against like: our purchase price up top — the
  // number the agent already saw at the head of the page — the commissions
  // taken out beneath it, and the seller's money last. Leading with the net
  // asked the reader to work backwards to find the offer.
  return `<div class="card">
    <h2>What the seller nets</h2>
    <div class="netrow">
      <div class="netcol win">
        <div class="t">Our offer — no buyer's agent</div>
        <div class="k">Our purchase price</div>
        <div class="big">${money(n.offer)}</div>
        <div class="ln"><span>Your commission (${n.sellerPct}%)</span><span>− ${money(n.sellerCommissionA)}</span></div>
        <div class="ln"><span>Buyer's agent</span><span>none</span></div>
        <div class="net"><span>Seller nets</span><span>${money(n.netA)}</span></div>
      </div>
      <div class="netcol">
        <div class="t">Listed, to net the same</div>
        <div class="k">List price required</div>
        <div class="big">${money(n.listPrice)}</div>
        <div class="ln"><span>Your commission (${n.sellerPct}%)</span><span>− ${money(n.sellerCommissionB)}</span></div>
        <div class="ln"><span>Buyer's agent (${n.buyerPct}%)</span><span>− ${money(n.buyerCommissionB)}</span></div>
        <div class="net"><span>Seller nets</span><span>${money(n.netA)}</span></div>
      </div>
    </div>
    <p class="muted" style="margin-top:14px">
      We represent ourselves on the purchase, so there's no buyer's agent commission to pay — that saving is
      already built into the number above. We're also flexible on how that side is handled: if you'd rather
      bring a buyer's agent, or write your own commission into the deal, tell us what you need and we'll
      work with it.
    </p>
    <p class="muted" style="margin-top:10px">
      The right-hand column is what the property would have to list for to leave your seller the same money
      after both commissions — before repairs, concessions, carrying costs and time on market, all of which
      fall on the seller in that column and on us in ours.
    </p>
  </div>`;
}

function compsSection(snap) {
  const items = snap.comps?.items || [];
  if (!items.length) return "";

  // Only carry columns that some comp can actually fill. A Zillow capture often
  // arrives without a sold date (Zillow doesn't always expose one), and a
  // hand-entered comp has no bed/bath count — a column of em-dashes on a
  // document going to an agent reads as sloppy data rather than absent data.
  const has = (f) => items.some((c) => f(c));
  const cols = {
    bedbath: has((c) => c.beds != null || c.baths != null),
    sqft: has((c) => c.sqft),
    sold: has((c) => c.saleDate),
  };
  const dash = (v) => (v == null || v === "" ? "—" : esc(String(v)));

  const rows = items.map((c) => {
    // The address is the link — an agent checking a comp goes straight to the
    // listing. rel/target so we never navigate the offer page itself away.
    const addr = c.zillow
      ? `<a href="${esc(c.zillow)}" target="_blank" rel="noreferrer noopener">${esc(c.address)}</a>`
      : esc(c.address);
    return `<tr>
      <td>${addr}${c.condition ? ` <span class="pill">${esc(c.condition)}</span>` : ""}</td>
      ${cols.bedbath ? `<td class="r">${dash(c.beds)}/${dash(c.baths)}</td>` : ""}
      ${cols.sqft ? `<td class="r">${c.sqft ? c.sqft.toLocaleString("en-US") : "—"}</td>` : ""}
      ${cols.sold ? `<td class="r">${dash(c.saleDate)}</td>` : ""}
      <td class="r">${money(c.price)}</td></tr>`;
  }).join("");

  const basis = [
    snap.comps.basis,
    snap.comps.months ? `sold within ${snap.comps.months} months` : "",
  ].filter(Boolean).join(" · ");
  const linked = items.some((c) => c.zillow);
  return `<div class="card">
    <h2>The comparable sales behind it</h2>
    <div class="scroll wide"><table>
      <tr><th>Address</th>
        ${cols.bedbath ? `<th class="r">Bd/Ba</th>` : ""}
        ${cols.sqft ? `<th class="r">Sqft</th>` : ""}
        ${cols.sold ? `<th class="r">Sold</th>` : ""}
        <th class="r">Price</th></tr>
      ${rows}
    </table></div>
    <p class="hint">Scroll the table sideways to see every column.</p>
    ${linked ? `<p class="muted" style="margin-top:12px">Tap any address to open it on Zillow.</p>` : ""}
    ${basis ? `<p class="muted" style="margin-top:${linked ? 4 : 12}px">${esc(basis)}</p>` : ""}
  </div>`;
}

function scopeSection(snap) {
  const rows = snap.scope || [];
  if (!rows.length) return "";
  const total = rows.reduce((t, s) => t + num(s.cost), 0);
  return `<div class="card">
    <h2>What we'd have to put into it</h2>
    <table>${rows.map((s) => `<tr><td>${esc(s.label)}</td><td class="r">${money(s.cost)}</td></tr>`).join("")}
      <tr><td style="font-weight:700;border-top:2px solid #0F172A;padding-top:10px">Total</td>
          <td class="r" style="font-weight:700;border-top:2px solid #0F172A;padding-top:10px">${money(total)}</td></tr>
    </table>
  </div>`;
}

function documentsSection(snap, base) {
  const docs = snap.documents || [];
  if (!docs.length) return "";
  return `<div class="card"><h2>Documents</h2>${docs.map((d) => `<div class="doc">
    <div>${esc(d.label)}</div>
    <a class="btn ghost" href="${base}/file/${encodeURIComponent(d.key)}" target="_blank" rel="noreferrer">Open PDF</a>
  </div>`).join("")}</div>`;
}

// The whole page. `token` scopes the document links.
export function renderOfferPage({ snap, token, brand = null }) {
  const s = snap.sections || DEFAULT_OFFER_SECTIONS;
  const base = `/o/${encodeURIComponent(token)}`;
  const co = snap.company || {};
  const contact = [co.signer, co.phone, co.email].filter(Boolean).map(esc).join(" · ");

  const body = `
    ${leadCard(snap)}
    ${s.note ? noteSection(snap) : ""}
    ${termsSection(snap)}
    ${s.breakdown ? breakdownSection(snap) : ""}
    ${s.netsheet ? netSection(snap) : ""}
    ${s.comps ? compsSection(snap) : ""}
    ${s.scope ? scopeSection(snap) : ""}
    ${s.documents ? documentsSection(snap, base) : ""}
    <p class="foot">
      ${esc(co.name || "")}${contact ? `<br>${contact}` : ""}
      ${snap.offer?.dateLabel ? `<br>Offer dated ${esc(snap.offer.dateLabel)}` : ""}
    </p>`;

  // The header keeps the lockup and drops the nav. On the investor dataroom
  // those links are the point — a buyer who likes the deal should be able to
  // reach the rest of the site. Here the reader is a listing agent with one
  // question to answer, and a row of marketing CTAs above the offer both
  // crowds the bar and invites them somewhere other than the number. brandFrom
  // puts the home link first and the nav renders links.slice(1), so keeping
  // only the first leaves the logo clickable with nothing beside it.
  const bareBrand = brand?.links?.length > 1 ? { ...brand, links: brand.links.slice(0, 1) } : brand;

  return page({
    title: `Cash offer — ${snap.property?.address || "property"}`,
    css: OFFER_CSS,
    body,
    // No watermark. The dataroom watermarks because an investor package is
    // confidential and forwarding it costs us the deal; this page exists to be
    // forwarded — to the seller, to a broker, to whoever needs convincing.
    watermark: "",
    brand: bareBrand,
  });
}
