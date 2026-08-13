// dataroom.test.mjs — end-to-end checks for the secure investor dataroom.
// Run with:  npm run test:dataroom
//
// These assert the security properties the feature exists for: link tokens are
// never stored in the clear, a token opens only its own room's documents, and
// revoke / reissue / expiry kill access immediately.
// Runs against the JSON file backend in a throwaway temp directory.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dataroom-test-"));
process.env.DATAROOM_SECRET = "test-secret-abc";
process.env.CARD_SENDS_ENABLED = "false";

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { createDataroomRouter, createDataroomPublicRouter } = await import("./routes/dataroom.js");

const LOC = "loc-test-1";
const resolveLocation = (req) => {
  const loc = req.query.location_id || req.body?.location_id || "";
  if (loc !== LOC) { const e = new Error("bad location"); e.http = 403; throw e; }
  return { locationId: LOC, client: { call: async () => ({}) } };
};

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use("/api/datarooms", createDataroomRouter({ resolveLocation, publicBaseUrl: "http://127.0.0.1:4999" }));
app.use("/d", createDataroomPublicRouter());
const server = app.listen(4999);
await store.init();

const B = "http://127.0.0.1:4999";
let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
};
const jget = (u, opts) => fetch(u, opts).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null), res: r }));

// --- seed an offer that looks like a real one ---
const offer = await store.createOffer({
  locationId: LOC,
  contactId: "contact-agent-1",
  contactName: "Dana Reyes",
  address: "7316 166th Avenue East, Sumner, WA 98390",
  cashAmount: 310000,
  compsPdfUrl: "http://example.invalid/comps.pdf",
  scopePdfUrl: "http://example.invalid/scope.pdf",
  scope: [{ label: "Kitchen refresh", cost: 18000 }, { label: "Roof", cost: 14500 }],
  calc: {
    inputs: { address: "7316 166th Avenue East, Sumner, WA 98390", arv: 520000, repairs: 62000 },
    settings: { company: { name: "Prvt Capital", tagline: "Cash offers, closed fast", signer: "Matt Shepherd", phone: "(253) 555-0143", email: "matt@example.com" } },
  },
  snapshot: {
    subjectSqft: 1840,
    comps: {
      months: 6, arvBasis: "median $/sqft of 4 comps", arvBase: 515000,
      adjustments: [{ label: "Corner lot", pct: 2 }],
      selected: ["c1", "c2"],
      grades: { c1: { condition: "renovated" }, c2: { condition: "dated" } },
      result: {
        info: { beds: 4, baths: 2.5, sqft: 1840, yearBuilt: 1996 },
        comps: [
          { id: "c1", address: "7402 168th Ave E", price: 540000, sqft: 1900, beds: 4, baths: 2.5, saleDate: "2026-05-14", yearBuilt: 1998 },
          { id: "c2", address: "16510 74th St E", price: 498000, sqft: 1780, beds: 3, baths: 2, saleDate: "2026-04-02", yearBuilt: 1994 },
          { id: "c3", address: "not selected", price: 999999, sqft: 1000 },
        ],
      },
      manual: [{ id: "m1", address: "7101 170th Ave E (manual)", price: 525000, sqft: 1860, manual: true }],
    },
    rehab: { aiResult: { summary: "Original kitchen and baths; roof at end of life. Structure sound." } },
  },
  deal: {
    stage: "under_contract", contractPrice: 312000, assignmentFee: 15000,
    closingDate: "2026-09-15", inspectionDate: "2026-08-25", investors: [],
  },
});
await store.saveOfferDoc(offer.id, "compspdf", Buffer.from("%PDF-1.4 fake comps"), "application/pdf");

console.log("\n== operator: create room ==");
let r = await jget(`${B}/api/datarooms`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ location_id: LOC, offerId: offer.id, headline: "Sumner 4/2.5 — assignable", notes: "Seller motivated." }),
});
ok("creates a room", r.status === 200 && r.body?.dataroom?.id, JSON.stringify(r.body).slice(0, 200));
const room = r.body.dataroom;
ok("investor price = contract + fee", room.snapshot.numbers.investorPrice === 327000, room.snapshot.numbers.investorPrice);
ok("keeps only selected comps + manual", room.snapshot.comps.items.length === 3, room.snapshot.comps.items.map((c) => c.address).join("|"));
ok("fee breakdown off by default", room.snapshot.sections.feeBreakdown === false);
ok("lists both documents", room.snapshot.documents.length === 2);

console.log("\n== operator: the shared deal link ==");
r = await jget(`${B}/api/datarooms/${room.id}?location_id=${LOC}`);
ok("share link is returned", /\/d\/[A-Za-z0-9_-]{20,}/.test(r.body?.dataroom?.shareLink || ""), r.body?.dataroom?.shareLink);
const shareLink = r.body.dataroom.shareLink;
ok("share link is stable across reads",
  (await jget(`${B}/api/datarooms/${room.id}?location_id=${LOC}`)).body.dataroom.shareLink === shareLink);
ok("share link is not listed as an investor", (r.body.dataroom.invites || []).length === 0);

let sv = await fetch(shareLink, { redirect: "manual" });
let sh = await sv.text();
ok("share link opens the package", sv.status === 200 && sh.includes("Sumner"), sv.status);
ok("no personal watermark on the shared link", !sh.includes("Prepared for"));
ok("shared link is not told it's theirs alone", !sh.includes("yours alone"));
ok("prices are whole dollars", sh.includes("$327,000") && !/\$327,000\.\d/.test(sh));
r = await jget(`${B}/api/datarooms/${room.id}?location_id=${LOC}`);
ok("share views are counted", r.body.dataroom.shareViews === 1, r.body.dataroom.shareViews);

r = await jget(`${B}/api/datarooms/${room.id}/share/rotate`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ location_id: LOC }),
});
ok("rotate returns a new link", r.status === 200 && r.body.shareLink && r.body.shareLink !== shareLink, r.status);
sv = await fetch(shareLink, { redirect: "manual" });
ok("the rotated-away link is dead", sv.status === 404, sv.status);
sv = await fetch(r.body.shareLink, { redirect: "manual" });
ok("the new share link works", sv.status === 200, sv.status);

console.log("\n== portfolio: one link for every deal ==");
// A second deal, so the portfolio has something to list alongside the first.
const offer2 = await store.createOffer({
  locationId: LOC, contactId: "contact-agent-2", contactName: "Lee Ash",
  address: "900 Vashon Hwy SW, Vashon, WA 98070", cashAmount: 250000,
  calc: { inputs: { address: "900 Vashon Hwy SW, Vashon, WA 98070", arv: 600000, repairs: 90000 },
          settings: { company: { name: "Prvt Capital" } } },
  deal: { stage: "under_contract", contractPrice: 250000, assignmentFee: 20000, investors: [] },
});
r = await jget(`${B}/api/datarooms`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ location_id: LOC, offerId: offer2.id }),
});
const room2 = r.body.dataroom;

r = await jget(`${B}/api/datarooms/portfolio?location_id=${LOC}`);
ok("portfolio link is issued", r.status === 200 && /\/d\/[A-Za-z0-9_-]{20,}/.test(r.body?.shareLink || ""), JSON.stringify(r.body).slice(0, 160));
const portfolioLink = r.body.shareLink;
ok("portfolio counts both deals", r.body.listedCount === 2, r.body.listedCount);
ok("portfolio link is stable",
  (await jget(`${B}/api/datarooms/portfolio?location_id=${LOC}`)).body.shareLink === portfolioLink);

let pv = await fetch(portfolioLink, { redirect: "manual" });
let ph = await pv.text();
ok("portfolio page renders", pv.status === 200 && ph.includes("Current deals"), pv.status);
ok("lists both addresses", ph.includes("Sumner") && ph.includes("Vashon"));
ok("shows highlights", ph.includes("$327,000") && ph.includes("$270,000"));
ok("links through to each deal", (ph.match(/href="\/d\//g) || []).length >= 2);
ok("brands the page from the deals when settings are blank", ph.includes("Prvt Capital"));

// The portfolio isn't a deal, so it must not appear in the operator's deal list.
r = await jget(`${B}/api/datarooms?location_id=${LOC}`);
ok("portfolio is not listed as a deal", r.body.datarooms.length === 2, r.body.datarooms.length);

console.log("\n== portfolio: back link on a deal page ==");
r = await jget(`${B}/api/datarooms/${room2.id}?location_id=${LOC}`);
let dv = await fetch(r.body.dataroom.shareLink, { redirect: "manual" });
let dh = await dv.text();
ok("deal page offers a way back", dh.includes("All current deals"));
ok("back link points at the portfolio", dh.includes(`/d/${portfolioLink.split("/d/")[1]}`));

console.log("\n== portfolio: unlisting a deal ==");
await jget(`${B}/api/datarooms/${room2.id}`, {
  method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ location_id: LOC, unlisted: true }),
});
pv = await fetch(portfolioLink, { redirect: "manual" });
ph = await pv.text();
ok("unlisted deal drops off the page", !ph.includes("Vashon") && ph.includes("Sumner"));
r = await jget(`${B}/api/datarooms/${room2.id}?location_id=${LOC}`);
dv = await fetch(r.body.dataroom.shareLink, { redirect: "manual" });
ok("its own link still works", dv.status === 200, dv.status);
ok("but offers no back link", !(await dv.text()).includes("All current deals"));
await jget(`${B}/api/datarooms/${room2.id}`, {
  method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ location_id: LOC, unlisted: false }),
});

console.log("\n== photos: serving and isolation ==");
// Seeded through the store: this suite mounts only the dataroom routers, and
// the operator upload API lives on the offers router. What matters here is the
// investor-facing read path, which is where the authorization lives.
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAj/2Q==", "base64");
const seedPhoto = (offerId) => store.saveOfferPhoto(offerId, LOC, {
  variants: { full: { bytes: JPEG, contentType: "image/jpeg" },
              thumb: { bytes: JPEG, contentType: "image/jpeg" } },
  width: 1600, height: 1067,
});

const photoA1 = (await seedPhoto(offer.id)).id;
const photoA2 = (await seedPhoto(offer.id)).id;
const photoB1 = (await seedPhoto(offer2.id)).id;

let list = await store.listOfferPhotos(offer.id);
ok("photos come back in sort order", list.map((p) => p.id).join() === `${photoA1},${photoA2}`);
ok("second photo sorted after the first", list[1].sort === 1, list[1].sort);
ok("metadata carries no bytes", !JSON.stringify(list).includes("/9j/"));

r = await jget(`${B}/api/datarooms/${room.id}?location_id=${LOC}`);
const dealShare = r.body.dataroom.shareLink;
r = await jget(`${B}/api/datarooms/${room2.id}?location_id=${LOC}`);
const otherShare = r.body.dataroom.shareLink;

let iv = await fetch(`${dealShare}/photo/${photoA1}/thumb`, { redirect: "manual" });
ok("serves a photo behind the deal's token", iv.status === 200 && iv.headers.get("content-type") === "image/jpeg", iv.status);
ok("cacheable but private", (iv.headers.get("cache-control") || "").includes("private"));
ok("not indexable", (iv.headers.get("x-robots-tag") || "").includes("noindex"));
const etag = iv.headers.get("etag");
ok("carries an etag", Boolean(etag));
iv = await fetch(`${dealShare}/photo/${photoA1}/thumb`, { headers: { "if-none-match": etag }, redirect: "manual" });
ok("repeat view is a 304", iv.status === 304, iv.status);
iv = await fetch(`${dealShare}/photo/${photoA1}/bogus`, { redirect: "manual" });
ok("unknown variant refused", iv.status === 404, iv.status);

// The one that matters: a token must only serve photos from its OWN deal.
iv = await fetch(`${otherShare}/photo/${photoA1}/thumb`, { redirect: "manual" });
ok("another deal's token can't fetch this photo", iv.status === 404, iv.status);
iv = await fetch(`${dealShare}/photo/${photoB1}/thumb`, { redirect: "manual" });
ok("and the reverse is refused too", iv.status === 404, iv.status);
iv = await fetch(`${portfolioLink}/photo/${photoA1}/thumb`, { redirect: "manual" });
ok("the portfolio token can't fetch any photo", iv.status === 404, iv.status);

console.log("\n== photos: on the investor pages ==");
let pgh = await (await fetch(dealShare, { redirect: "manual" })).text();
ok("hero photo renders", pgh.includes(`/photo/${photoA1}/full`));
ok("the rest go in the strip", pgh.includes(`/photo/${photoA2}/thumb`));
ok("hero carries explicit dimensions", /width="1600" height="1067"/.test(pgh));
ph = await (await fetch(portfolioLink, { redirect: "manual" })).text();
ok("portfolio card shows a thumbnail", ph.includes(`/photo/${photoA1}/thumb`));
ok("portfolio thumb is served under the deal's own token",
  ph.includes(`/d/${dealShare.split("/d/")[1]}/photo/${photoA1}/thumb`));

console.log("\n== photos: reorder and delete ==");
await store.reorderOfferPhotos(offer.id, [photoA2, photoA1]);
pgh = await (await fetch(dealShare, { redirect: "manual" })).text();
ok("promoting a photo changes the hero", pgh.includes(`/photo/${photoA2}/full`));
ok("reorder can't touch another deal's photos",
  !(await store.listOfferPhotos(offer2.id)).some((p) => p.id === photoA1));
await store.reorderOfferPhotos(offer.id, [photoB1]);
ok("id-stuffing another deal's photo is ignored",
  (await store.listOfferPhotos(offer.id)).length === 2);

ok("delete is scoped to its own offer", (await store.deleteOfferPhoto(offer2.id, photoA1)) === false);
ok("delete succeeds for the right offer", (await store.deleteOfferPhoto(offer.id, photoA1)) === true);
iv = await fetch(`${dealShare}/photo/${photoA1}/thumb`, { redirect: "manual" });
ok("a deleted photo dies on every live link immediately", iv.status === 404, iv.status);

console.log("\n== photos: revocation ==");
await jget(`${B}/api/datarooms/${room.id}/revoke`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ location_id: LOC, revoked: true }),
});
iv = await fetch(`${dealShare}/photo/${photoA2}/thumb`, { redirect: "manual" });
ok("a revoked room serves no photos", iv.status === 404, iv.status);
await jget(`${B}/api/datarooms/${room.id}/revoke`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ location_id: LOC, revoked: false }),
});

console.log("\n== operator: wrong location is refused ==");
r = await jget(`${B}/api/datarooms/${room.id}?location_id=someone-else`);
ok("403 on a foreign location", r.status === 403, r.status);

console.log("\n== operator: issue an invite ==");
r = await jget(`${B}/api/datarooms/${room.id}/invites`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ location_id: LOC, contactId: "contact-inv-1", name: "Priya Raman", phone: "+12065550187" }),
});
ok("issues a link", r.status === 200 && /\/d\/[A-Za-z0-9_-]{20,}/.test(r.body?.link || ""), JSON.stringify(r.body).slice(0, 200));
ok("issues no access code", !r.body?.pin);
const link = r.body.link, inviteId = r.body.invite.id;
const token = link.split("/d/")[1];

console.log("\n== storage: no plaintext token at rest ==");
const raw = await store.getDataroomInvite(inviteId);
ok("token is not stored", !JSON.stringify(raw).includes(token));
ok("token hash is stored", typeof raw.tokenHash === "string" && raw.tokenHash.length === 64);
r = await jget(`${B}/api/datarooms/${room.id}?location_id=${LOC}`);
ok("token hash never leaves the server", !JSON.stringify(r.body).includes(raw.tokenHash));

console.log("\n== viewer: the link opens the package directly ==");
let v = await fetch(link, { redirect: "manual" });
let html = await v.text();
ok("package renders with no code prompt", v.status === 200 && html.includes("Sumner") && !html.includes("access code"), v.status);
ok("noindex header set", (v.headers.get("x-robots-tag") || "").includes("noindex"));
ok("no-store header set", (v.headers.get("cache-control") || "").includes("no-store"));
ok("framing denied", v.headers.get("x-frame-options") === "DENY");
ok("sets no cookie", !v.headers.get("set-cookie"));
ok("shows the investor price", html.includes("$327,000"));
ok("hides our contract price by default", !html.includes("$312,000") && !html.includes("$15,000"));
ok("shows comps", html.includes("7402 168th Ave E") && html.includes("7101 170th Ave E"));
ok("excludes unselected comps", !html.includes("not selected"));
ok("shows the scope", html.includes("Kitchen refresh") && html.includes("$32,500"));
ok("watermarks with the recipient", html.includes("Priya Raman · CONFIDENTIAL"));
ok("spread computed", html.includes("Spread at ARV") && html.includes("$131,000"));
ok("warns against forwarding", html.includes("yours alone"));

console.log("\n== viewer: each invite is watermarked to its own recipient ==");
r = await jget(`${B}/api/datarooms/${room.id}/invites`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ location_id: LOC, contactId: "contact-inv-2", name: "Sam Cole", phone: "+12065550188" }),
});
const link2 = r.body.link;
v = await fetch(link2, { redirect: "manual" });
html = await v.text();
ok("second invite names its own recipient", html.includes("Sam Cole · CONFIDENTIAL") && !html.includes("Priya Raman"));

console.log("\n== viewer: documents ==");
v = await fetch(`${link}/file/comps`, { redirect: "manual" });
ok("serves a document behind a live token", v.status === 200 && (await v.text()).startsWith("%PDF"), v.status);
v = await fetch(`${link}/file/contract`, { redirect: "manual" });
ok("undeclared document kind refused", v.status === 404, v.status);

console.log("\n== operator: external links for investors ==");
r = await jget(`${B}/api/datarooms/${room.id}`, {
  method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    location_id: LOC,
    links: [
      { label: "3D walkthrough", url: "https://my.matterport.com/show/?m=abc123" },
      { label: "", url: "https://www.kingcounty.gov/parcel/9876" },
      // Everything below must be dropped before it can reach an href.
      { label: "xss", url: "javascript:alert(document.cookie)" },
      { label: "xss mixed", url: "JaVaScRiPt:alert(1)" },
      { label: "data uri", url: "data:text/html,<script>alert(1)</script>" },
      { label: "local file", url: "file:///etc/passwd" },
      { label: "nonsense", url: "not a url at all" },
      { label: "dupe", url: "https://my.matterport.com/show/?m=abc123" },
    ],
  }),
});
let saved = r.body?.dataroom?.snapshot?.links || [];
ok("keeps only the http(s) links", saved.length === 2, JSON.stringify(saved.map((l) => l.url)));
ok("drops javascript: urls", !saved.some((l) => /^javascript:/i.test(l.url)));
ok("drops data: and file: urls", !saved.some((l) => /^(data|file):/i.test(l.url)));
ok("dedupes the same url twice", saved.filter((l) => l.url.includes("matterport")).length === 1);
ok("falls back to the host when unlabelled", saved.some((l) => l.label === "kingcounty.gov"));

v = await fetch(link, { redirect: "manual" });
html = await v.text();
ok("links render for the investor", html.includes("3D walkthrough") && html.includes("my.matterport.com"));
ok("links sit in the documents card", html.includes("Documents &amp; links"));
ok("no javascript: href reaches the page", !/href="javascript:/i.test(html));
ok("no inline script reaches the page", !/<script/i.test(html));

// The whole point of storing links on the room rather than the offer.
r = await jget(`${B}/api/datarooms/${room.id}`, {
  method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ location_id: LOC, refresh: true }),
});
ok("survive a refresh from the offer", (r.body?.dataroom?.snapshot?.links || []).length === 2,
  JSON.stringify(r.body?.dataroom?.snapshot?.links || []));

r = await jget(`${B}/api/datarooms/${room.id}`, {
  method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ location_id: LOC, links: [] }),
});
ok("can be cleared", (r.body?.dataroom?.snapshot?.links || []).length === 0);
v = await fetch(link, { redirect: "manual" });
html = await v.text();
ok("cleared links leave no empty card", !html.includes("Documents &amp; links"));

console.log("\n== operator: revoke one invite ==");
r = await jget(`${B}/api/datarooms/${room.id}/invites/${inviteId}/revoke`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ location_id: LOC }),
});
ok("revoke succeeds", r.status === 200 && r.body.invite.status === "revoked");
v = await fetch(link, { redirect: "manual" });
html = await v.text();
ok("revoked link dies immediately", v.status === 404 && html.includes("isn&#39;t available"), v.status);
v = await fetch(`${link}/file/comps`, { redirect: "manual" });
ok("revoked link can't fetch documents", v.status === 404, v.status);

console.log("\n== operator: reissue ==");
r = await jget(`${B}/api/datarooms/${room.id}/invites/${inviteId}/reissue`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ location_id: LOC }),
});
ok("reissue returns a new link", r.status === 200 && r.body.link !== link, r.status);
const link3 = r.body.link;
v = await fetch(link, { redirect: "manual" });
ok("the old link is dead", v.status === 404 && (await v.text()).includes("isn&#39;t available"), v.status);
v = await fetch(link3, { redirect: "manual" });
ok("the new link opens", v.status === 200 && (await v.text()).includes("Sumner"), v.status);

console.log("\n== operator: expiry ==");
await store.updateDataroomInvite(inviteId, { expiresAt: new Date(Date.now() - 1000).toISOString() });
v = await fetch(link3, { redirect: "manual" });
ok("expired link is gone", v.status === 404 && (await v.text()).includes("isn&#39;t available"), v.status);

console.log("\n== operator: whole-room revoke ==");
await store.updateDataroomInvite(inviteId, { expiresAt: new Date(Date.now() + 86400000).toISOString() });
r = await jget(`${B}/api/datarooms/${room.id}/revoke`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ location_id: LOC }),
});
ok("room revoke succeeds", r.status === 200);
v = await fetch(link3, { redirect: "manual" });
ok("every link dies with the room", v.status === 404 && (await v.text()).includes("isn&#39;t available"), v.status);
r = await jget(`${B}/api/datarooms/${room.id}/revoke`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ location_id: LOC, revoked: false }),
});
v = await fetch(link3, { redirect: "manual" });
ok("restore brings them back", v.status === 200 && (await v.text()).includes("Sumner"), v.status);

console.log("\n== operator: garbage tokens ==");
for (const bad of ["short", "../../etc/passwd", "A".repeat(200), "%00"]) {
  v = await fetch(`${B}/d/${encodeURIComponent(bad)}`, { redirect: "manual" });
  ok(`rejects "${bad.slice(0, 18)}"`, v.status === 404, v.status);
}

console.log("\n== operator: access log ==");
r = await jget(`${B}/api/datarooms/${room.id}?location_id=${LOC}`);
const kinds = (r.body.events || []).map((e) => e.kind);
ok("logs views", kinds.includes("view"));
ok("logs downloads", kinds.includes("download"));
ok("logs revocations", kinds.includes("revoked"));
ok("logs reissues", kinds.includes("reissued"));
ok("reports view counts", r.body.dataroom.invites.some((i) => i.viewCount > 0));

console.log("\n== operator: send (dry run) ==");
r = await jget(`${B}/api/datarooms/${room.id}/invites`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ location_id: LOC, contactId: "contact-inv-3", name: "Ali Novak", phone: "+12065550190", send: true }),
});
ok("dry run previews the text", r.body?.send?.dryRun === true && r.body.send.preview.message.includes("/d/"), JSON.stringify(r.body?.send || {}).slice(0, 300));
ok("dry run sends nothing", r.body.send.sent === undefined);
ok("text warns against forwarding", /don't forward/.test(r.body.send.preview.message));

console.log(`\n${pass} passed, ${fail} failed`);
server.close();
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
