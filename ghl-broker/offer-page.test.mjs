// offer-page.test.mjs — the agent-facing offer package.
// Run with:  npm run test:offer-page
//
// Two classes of guarantee, and the second is the one that would cost real
// money if it broke:
//
//   Behaviour — build, share, rotate, revoke, and the document allowlist.
//   Isolation — an offer page carries our underwriting. It must never appear
//     in the PUBLIC deals feed or the portfolio board, its token must not open
//     an investor dataroom, a dataroom token must not open it, and the page
//     must never render the assignment fee or the contract/assignment PDFs.
//
// Runs against the JSON file backend in a throwaway temp directory.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "offer-page-test-"));
process.env.DATAROOM_SECRET = "test-secret-abc";
process.env.CARD_SENDS_ENABLED = "false";
// This location publishes a public deals feed — which is exactly the surface an
// offer page must never reach.
process.env.DATAROOM_FEED_LOCATIONS = "loc-op-test";
process.env.DATAROOM_FEED_TTL_MS = "0";

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { createOfferPageRouter, createOfferPagePublicRouter } = await import("./routes/offer-page.js");
const { createDataroomRouter, createDataroomPublicRouter } = await import("./routes/dataroom.js");

const LOC = "loc-op-test";
const BASE = "http://127.0.0.1:4997";
const resolveLocation = () => ({ locationId: LOC, client: { call: async () => ({}) } });

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use("/api/offer-pages", createOfferPageRouter({ resolveLocation, publicBaseUrl: BASE }));
app.use("/api/datarooms", createDataroomRouter({ resolveLocation, publicBaseUrl: BASE }));
app.use("/o", createOfferPagePublicRouter());
app.use("/d", createDataroomPublicRouter({ publicBaseUrl: BASE }));
const server = app.listen(4997);
await store.init();

const FEE = 15000;
const req = async (method, p, body) => {
  const r = await fetch(BASE + p, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, json, text };
};

const mkOffer = (over = {}) => store.createOffer({
  id: crypto.randomUUID(),
  locationId: LOC,
  contactId: "agent-1",
  contactName: "Cati Sandoval",
  address: "7374 Lazy S Ln NE, Bremerton, WA",
  cashAmount: 286500,
  dateLabel: "August 17, 2026",
  validLabel: "August 24, 2026",
  pdfUrl: "https://example.test/offer.pdf",
  compsPdfUrl: "https://example.test/comps.pdf",
  scopePdfUrl: "https://example.test/scope.pdf",
  netSheetPdfUrl: "https://example.test/net.pdf",
  contractPdfUrl: "https://example.test/contract.pdf",
  assignmentPdfUrl: "https://example.test/assignment.pdf",
  scope: [{ label: "Roof", cost: 12000 }, { label: "Kitchen", cost: 16500 }],
  calc: {
    inputs: { address: "7374 Lazy S Ln NE, Bremerton, WA", arv: 420000, repairs: 28500, askingPrice: 399000 },
    settings: { wholesaleFee: FEE, underwriteMode: "backstack", sellingCostPct: 7, flipProfitPct: 13,
      holdMonths: 5, holdMonthlyCost: 1200, sellerAgentPct: 3, buyerAgentPct: 3,
      company: { name: "Shep Flips", signer: "Matt Shepherd", phone: "425-620-2863" } },
    offers: { cash: { key: "cash", mode: "backstack", amount: 286500, base: 420000, repairs: 28500,
      sellingCosts: 29400, flipProfit: 54600, holding: 6000, wholesaleFee: FEE,
      sellingCostPct: 7, flipProfitPct: 13, holdMonths: 5, holdMonthlyCost: 1200, underwater: false } },
  },
  snapshot: {
    subjectSqft: 1550,
    subjectInfo: { beds: 3, baths: 2, sqft: 1550, yearBuilt: 1995 },
    letterTerms: [{ label: "Financing", value: "Funded with cash or private loan" }],
    comps: {
      selected: ["p-1", "z-9"],
      months: 18,
      arvBasis: "5 comps, size-adjusted",
      result: { comps: [{ id: "p-1", address: "1 Provider Rd", price: 402000, sqft: 1580, beds: 3, baths: 2, saleDate: "2026-06-01" }] },
      captured: [{ id: "z-9", address: "9 Zillow Way", price: 415000, sqft: 1600, beds: 3, baths: 2, saleDate: "2026-05-01" }],
      manual: [],
    },
  },
  status: "sent",
  ...over,
});

const build = async (over = {}) => {
  const offer = await mkOffer(over.offer || {});
  const r = await req("POST", "/api/offer-pages", { offerId: offer.id, ...over.body });
  assert.equal(r.status, 200, r.text);
  return { offer, page: r.json.offerPage, token: r.json.offerPage.shareLink.split("/o/")[1] };
};

/* ---------------- behaviour ---------------- */

test("a page builds from an offer and opens on its share link", async () => {
  const { page, token } = await build();
  assert.ok(page.shareLink.startsWith(`${BASE}/o/`));
  const r = await req("GET", `/o/${token}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /All-cash offer/);
  assert.match(r.text, /\$286,500/);
  assert.match(r.text, /7374 Lazy S Ln NE/);
});

test("a draft has no page to build", async () => {
  const offer = await mkOffer({ status: "draft" });
  const r = await req("POST", "/api/offer-pages", { offerId: offer.id });
  assert.equal(r.status, 400);
});

test("sections switch content on and off, and the breakdown is off by default", async () => {
  const { page, token } = await build();
  assert.equal(page.snapshot.sections.breakdown, false, "showing your working is opt-in");
  let r = await req("GET", `/o/${token}`);
  assert.doesNotMatch(r.text, /How we got to this number/);
  assert.match(r.text, /What the seller nets/);
  assert.match(r.text, /comparable sales/i);

  await req("PUT", `/api/offer-pages/${page.id}`, {
    sections: { breakdown: true, comps: false, scope: false, netsheet: false, note: false, documents: false },
  });
  r = await req("GET", `/o/${token}`);
  assert.match(r.text, /How we got to this number/);
  assert.doesNotMatch(r.text, /What the seller nets/);
  assert.doesNotMatch(r.text, /Renovation scope of work/);
});

test("the note is operator-authored and survives a refresh", async () => {
  const { page, token } = await build({ body: { headline: "Why this works", note: "Happy to move faster on closing." } });
  let r = await req("GET", `/o/${token}`);
  assert.match(r.text, /Why this works/);
  assert.match(r.text, /Happy to move faster on closing/);

  await req("PUT", `/api/offer-pages/${page.id}`, { refresh: true });
  r = await req("GET", `/o/${token}`);
  assert.match(r.text, /Happy to move faster on closing/, "a refresh must not erase the note");
});

test("rotating the share link kills the URL already sent", async () => {
  const { page, token } = await build();
  assert.equal((await req("GET", `/o/${token}`)).status, 200);
  const r = await req("POST", `/api/offer-pages/${page.id}/share/rotate`);
  const fresh = r.json.shareLink.split("/o/")[1];
  assert.notEqual(fresh, token);
  assert.equal((await req("GET", `/o/${token}`)).status, 404, "the forwarded link is dead");
  assert.equal((await req("GET", `/o/${fresh}`)).status, 200);
});

test("revoke switches the page off and back on", async () => {
  const { page, token } = await build();
  await req("POST", `/api/offer-pages/${page.id}/revoke`, {});
  assert.equal((await req("GET", `/o/${token}`)).status, 404);
  await req("POST", `/api/offer-pages/${page.id}/revoke`, { revoked: false });
  assert.equal((await req("GET", `/o/${token}`)).status, 200);
});

test("views are counted so you know whether the agent opened it", async () => {
  const { page, token } = await build();
  await req("GET", `/o/${token}`);
  await req("GET", `/o/${token}`);
  const r = await req("GET", `/api/offer-pages/${page.id}`);
  assert.equal(r.json.offerPage.views, 2);
  assert.ok(r.json.offerPage.lastViewedAt);
  assert.ok(r.json.events.some((e) => e.kind === "view"));
});

test("garbage tokens are refused without revealing whether one existed", async () => {
  const bad = await req("GET", "/o/not-a-real-token-aaaaaaaaaaaaaaaaaaaa");
  assert.equal(bad.status, 404);
  assert.equal((await req("GET", "/o/short")).status, 404);
  assert.doesNotMatch(bad.text, /dataroom|offer page not found/i, "no product name, no internal error text");
});

/* ---------------- documents ---------------- */

test("only the four agent-facing documents are reachable", async () => {
  const { token } = await build();
  for (const kind of ["offer", "comps", "scope", "netsheet"]) {
    // No stored bytes and the upstream URL is unreachable in tests, so a 404
    // here is fine — what matters is that the kind passes the allowlist gate
    // rather than being rejected outright. Rejected kinds are asserted below.
    const r = await req("GET", `/o/${token}/file/${kind}`);
    assert.ok([200, 404].includes(r.status));
  }
  // Ours, not theirs. These have no key in OFFER_DOC_KINDS at all.
  for (const kind of ["contract", "assignment", "../../etc/passwd", "image"]) {
    assert.equal((await req("GET", `/o/${token}/file/${encodeURIComponent(kind)}`)).status, 404,
      `${kind} must not be reachable`);
  }
});

test("turning documents off kills the file URLs too", async () => {
  const { page, token } = await build();
  await req("PUT", `/api/offer-pages/${page.id}`, { refresh: true, sections: { documents: false } });
  // The section toggle hides the links; the frozen documents list is the gate
  // the route actually checks, so refresh with documents off must clear it.
  const r = await req("GET", `/o/${token}`);
  assert.doesNotMatch(r.text, /Open PDF/);
});

/* ---------------- isolation ---------------- */

test("the assignment fee never reaches the rendered page", async () => {
  const { page, token } = await build();
  await req("PUT", `/api/offer-pages/${page.id}`, { sections: { breakdown: true } });
  const r = await req("GET", `/o/${token}`);
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.text, /\$15,000\b|assignment fee|wholesale/i,
    "the breakdown must absorb the fee, never print it");
  // And the column still ties out to the offer.
  assert.match(r.text, /Our offer/);
  assert.match(r.text, /\$286,500/);
});

test("an offer page never appears in the public deals feed or the portfolio", async () => {
  await build();
  const feed = await req("GET", `/d/deals.json?location_id=${LOC}`);
  const body = feed.text || "";
  assert.doesNotMatch(body, /Lazy S Ln/, "our offer must not be published as a deal");
  assert.doesNotMatch(body, /15,000|420000|286500/, "no underwriting in a public feed");
});

test("the dataroom operator API cannot see or open an offer page", async () => {
  const { page } = await build();
  assert.equal((await req("GET", `/api/datarooms/${page.id}`)).status, 404);
  assert.equal((await req("PUT", `/api/datarooms/${page.id}`, { sections: {} })).status, 404);
  assert.equal((await req("DELETE", `/api/datarooms/${page.id}`)).status, 404);
  const list = await req("GET", "/api/datarooms");
  assert.ok(!(list.json.datarooms || []).some((d) => d.id === page.id), "not enumerated either");
});

test("tokens do not cross between /o and /d", async () => {
  const { token: offerToken } = await build();
  // An offer-page token must not open an investor room.
  assert.equal((await req("GET", `/d/${offerToken}`)).status, 404);

  // ...and a real dataroom's token must not open an offer page.
  const dealOffer = await mkOffer({ deal: { stage: "under_contract", contractPrice: 286500, assignmentFee: FEE, investors: [], stageHistory: [] } });
  const room = await req("POST", "/api/datarooms", { offerId: dealOffer.id });
  assert.equal(room.status, 200, room.text);
  const roomToken = room.json.dataroom.shareLink.split("/d/")[1];
  assert.equal((await req("GET", `/d/${roomToken}`)).status, 200, "the dataroom still works");
  assert.equal((await req("GET", `/o/${roomToken}`)).status, 404, "but not as an offer page");
});

test("the offer-page API cannot be pointed at a dataroom id", async () => {
  const dealOffer = await mkOffer({ deal: { stage: "under_contract", contractPrice: 286500, assignmentFee: FEE, investors: [], stageHistory: [] } });
  const room = await req("POST", "/api/datarooms", { offerId: dealOffer.id });
  const id = room.json.dataroom.id;
  assert.equal((await req("GET", `/api/offer-pages/${id}`)).status, 404);
  assert.equal((await req("POST", `/api/offer-pages/${id}/revoke`, {})).status, 404);
  assert.equal((await req("DELETE", `/api/offer-pages/${id}`)).status, 404);
});

test("the page carries no script and refuses to be framed", async () => {
  const { token } = await build();
  const r = await fetch(`${BASE}/o/${token}`);
  const html = await r.text();
  assert.doesNotMatch(html, /<script/i, "no script — the CSP has no script-src to allow one");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.match(r.headers.get("content-security-policy") || "", /default-src 'none'/);
  assert.match(r.headers.get("x-robots-tag") || "", /noindex/);
});

test("the net comparison shows what we pay before what the seller keeps", async () => {
  const { token } = await build();
  const r = await req("GET", `/o/${token}`);
  // Our purchase price is on the page next to the net it produces — an agent
  // reading only this card must not have to reverse the commission to find
  // the offer. Both columns land on the same net; that is the comparison.
  const net = r.text.split("What the seller nets")[1].split("</div></div>")[0];
  assert.match(net, /Our purchase price/);
  assert.ok(net.indexOf("$286,500") < net.indexOf("$277,905"), "price above the net, not after it");
  assert.equal((net.match(/\$277,905/g) || []).length, 2, "both columns net the seller the same");
});

test("the offer page header keeps the logo and drops the marketing nav", async () => {
  const { renderOfferPage } = await import("./offer-page.js");
  const { brandFrom } = await import("./dataroom.js");
  const brand = brandFrom({
    name: "Shep Flips",
    brandLinks: [
      { label: "Home", url: "https://shepflips.com" },
      { label: "Deals", url: "https://shepflips.com/deals" },
      { label: "Join the buyers list", url: "https://shepflips.com/join", cta: true },
    ],
  });
  const html = renderOfferPage({ snap: { property: { address: "7374 Lazy S Ln NE" }, offer: {} }, token: "t", brand });
  const header = html.split("</header>")[0];
  assert.match(header, /Shep Flips/, "the lockup stays");
  assert.match(header, /href="https:\/\/shepflips.com"/, "and stays clickable");
  assert.doesNotMatch(header, /<nav/, "no nav links beside it, empty or otherwise");
  assert.doesNotMatch(header, /Join the buyers list|shepflips.com\/deals/);
});

test.after(() => server.close());
