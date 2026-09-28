import test from "node:test";
import assert from "node:assert/strict";
import {
  findUrls, addressFromListingUrl, addressFromRunOnSlug, addressFromHtml, resolveListingLink, expandListingLinks,
} from "./listing-links.js";

/* ---------- finding links ---------- */

test("links are found with or without a scheme, and lose trailing punctuation", () => {
  assert.deepEqual(
    findUrls("check this https://redf.in/3ckOYn. also zillow.com/homedetails/1-A-St-Tacoma-WA-98408/1_zpid/!"),
    ["https://redf.in/3ckOYn", "https://zillow.com/homedetails/1-A-St-Tacoma-WA-98408/1_zpid/"],
  );
  assert.deepEqual(findUrls("no links, just 4621 S Sheridan Ave"), []);
});

/* ---------- addresses straight off the path ---------- */

test("a Redfin listing URL is an address — the one redf.in/3ckOYn actually lands on", () => {
  assert.equal(
    addressFromListingUrl("https://www.redfin.com/WA/Auburn/10625-SE-304th-Way-98092/home/406999?utm_source=ios_share"),
    "10625 SE 304th Way, Auburn, WA 98092",
  );
});

test("a Redfin condo keeps its unit", () => {
  assert.equal(
    addressFromListingUrl("https://www.redfin.com/WA/Seattle/1200-Western-Ave-98101/unit-704/home/123"),
    "1200 Western Ave #704, Seattle, WA 98101",
  );
});

test("a Zillow homedetails URL splits street from city at the street suffix", () => {
  assert.equal(
    addressFromListingUrl("https://www.zillow.com/homedetails/4621-S-Sheridan-Ave-Tacoma-WA-98408/49092391_zpid/"),
    "4621 S Sheridan Ave, Tacoma, WA 98408",
  );
});

test("a city with a suffix word in its name stays the city", () => {
  assert.equal(addressFromRunOnSlug("123-Main-St-Federal-Way-WA-98003"), "123 Main St, Federal Way, WA 98003");
});

test("a trailing directional stays on the street", () => {
  assert.equal(addressFromRunOnSlug("17118-Riverview-Way-E-Enumclaw-WA-98022"), "17118 Riverview Way E, Enumclaw, WA 98022");
});

test("a street with no suffix still comes back, comma-less for the geocoder to place", () => {
  assert.equal(addressFromRunOnSlug("500-Broadway-Tacoma-WA-98402"), "500 Broadway Tacoma, WA 98402");
});

test("a realtor.com URL reads its underscores", () => {
  assert.equal(
    addressFromListingUrl("https://www.realtor.com/realestateandhomes-detail/10625-SE-304th-Way_Auburn_WA_98092_M12345-67890"),
    "10625 SE 304th Way, Auburn, WA 98092",
  );
});

test("a lowercase Trulia slug gets its capitals back and its id dropped", () => {
  assert.equal(
    addressFromListingUrl("https://www.trulia.com/p/wa/auburn/10625-se-304th-way-auburn-wa-98092--2084431234"),
    "10625 SE 304th Way, Auburn, WA 98092",
  );
});

test("a path that isn't an address is not turned into one", () => {
  assert.equal(addressFromListingUrl("https://www.zillow.com/tacoma-wa/"), "");
  assert.equal(addressFromListingUrl("https://example.com/about-us"), "");
  assert.equal(addressFromListingUrl("https://redf.in/3ckOYn"), "");
});

test("a page with schema.org address data is read when the path has none", () => {
  const html = `<script type="application/ld+json">{"address":{"@type":"PostalAddress","streetAddress":"4621 S Sheridan Ave","addressLocality":"Tacoma","addressRegion":"WA","postalCode":"98408"}}</script>`;
  assert.equal(addressFromHtml(html), "4621 S Sheridan Ave, Tacoma, WA 98408");
  assert.equal(addressFromHtml("<title>Homes for sale</title>"), "");
});

/* ---------- following links ---------- */

const redirect = (to) => ({ status: 308, ok: false, headers: new Headers({ location: to }) });

test("a short link is followed to the listing and read off its URL — the listing page is never fetched", async () => {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    if (url === "https://redf.in/3ckOYn") return redirect("https://www.redfin.com/WA/Auburn/10625-SE-304th-Way-98092/home/406999");
    throw new Error(`fetched ${url}`);
  };
  const r = await resolveListingLink("https://redf.in/3ckOYn", { fetchImpl });
  assert.equal(r.address, "10625 SE 304th Way, Auburn, WA 98092");
  assert.equal(r.source, "redfin");
  assert.deepEqual(asked, ["https://redf.in/3ckOYn"]);
});

test("a dead or blocked link is no address, not an error", async () => {
  assert.equal(await resolveListingLink("https://redf.in/x", { fetchImpl: async () => { throw new Error("timeout"); } }), null);
  assert.equal(await resolveListingLink("https://redf.in/x", { fetchImpl: async () => ({ status: 403, ok: false, headers: new Headers() }) }), null);
});

test("links to private addresses are never fetched", async () => {
  const fetchImpl = async () => { throw new Error("should not fetch"); };
  for (const u of ["http://localhost:3000/x", "http://127.0.0.1/x", "http://10.0.0.5/x", "http://169.254.169.254/latest", "http://192.168.1.1/"]) {
    assert.equal(await resolveListingLink(u, { fetchImpl }), null, u);
  }
  assert.equal(await resolveListingLink("https://redf.in/x", { fetchImpl: async () => redirect("http://127.0.0.1/admin") }), null);
});

/* ---------- expanding a message ---------- */

test("a message with no links comes back untouched, without a request", async () => {
  const resolve = async () => { throw new Error("should not resolve"); };
  assert.deepEqual(await expandListingLinks("Sold for 267k", { resolve }), { text: "Sold for 267k", links: [] });
});

test("a resolved link is written into the message as an address line", async () => {
  const resolve = async (url) => ({ url, resolvedUrl: url, address: "10625 SE 304th Way, Auburn, WA 98092", source: "redfin" });
  const x = await expandListingLinks("https://redf.in/3ckOYn", { resolve });
  assert.equal(x.text, "https://redf.in/3ckOYn\n[listing link → 10625 SE 304th Way, Auburn, WA 98092]");
  assert.equal(x.links.length, 1);
});

test("a message already carrying the address line is read from it, not fetched again", async () => {
  const resolve = async () => { throw new Error("should not resolve"); };
  const x = await expandListingLinks("https://redf.in/3ckOYn\n[listing link → 10625 SE 304th Way, Auburn, WA 98092]", { resolve });
  assert.equal(x.links[0].address, "10625 SE 304th Way, Auburn, WA 98092");
});

test("a link that resolves to nothing leaves the message as it was", async () => {
  const x = await expandListingLinks("look https://example.com/x", { resolve: async () => null });
  assert.deepEqual(x, { text: "look https://example.com/x", links: [] });
});

/* ---------- HomeSpotter (NWMLS agents' share links) ---------- */

// An agent's l.hms.pt link (2026-09-26): six redirects to an idx.homespotter.com
// page whose URL is only the MLS number, whose title is "Listing #2565463" and
// whose og:title is "5 beds, 3 baths for $577,500 in Auburn, WA". The bot
// answered "Link isn't opening on my end" twice.
const HOMESPOTTER_PAGE = `<html><head><title>Listing #2565463</title>
<meta property="og:title"  content="5 beds, 3 baths for $577,500 in Auburn, WA | HomeSpotter" /></head><body>
<div class="summary_wrapper">
  <div class="summary_price one">$577,500</div>
  <div class="summary_address">
    34418 54th Avenue S<br />Auburn, WA 98001  </div>
</div></body></html>`;

test("a HomeSpotter listing page is read from its address block", () => {
  assert.equal(addressFromHtml(HOMESPOTTER_PAGE), "34418 54th Avenue S, Auburn, WA 98001");
});

test("an agent's l.hms.pt link is followed through all six redirects to the address", async () => {
  const hops = {
    "https://l.hms.pt/1125/14/2565463/255944/81337/B8": "http://hms.pt/JgEV",
    "http://hms.pt/JgEV": "https://hms.pt/JgEV",
    "https://hms.pt/JgEV": "https://app.homespotter.com/JgEV",
    "https://app.homespotter.com/JgEV": "https://app.homespotter.com/customer_listing/hs_northwest/14/2565463?agent_id=255944",
    "https://app.homespotter.com/customer_listing/hs_northwest/14/2565463?agent_id=255944": "http://idx.homespotter.com/hs_northwest/nwmls/2565463?agent_id=255944",
    "http://idx.homespotter.com/hs_northwest/nwmls/2565463?agent_id=255944": "https://idx.homespotter.com/hs_northwest/nwmls/2565463?agent_id=255944",
  };
  const fetchImpl = async (url) => {
    if (hops[url]) return { status: 302, ok: false, headers: new Headers({ location: hops[url] }) };
    if (url === "https://idx.homespotter.com/hs_northwest/nwmls/2565463?agent_id=255944") {
      return { status: 200, ok: true, headers: new Headers({ "content-type": "text/html; charset=utf-8" }), text: async () => HOMESPOTTER_PAGE };
    }
    throw new Error(`unexpected ${url}`);
  };
  const r = await resolveListingLink("https://l.hms.pt/1125/14/2565463/255944/81337/B8", { fetchImpl });
  assert.equal(r?.address, "34418 54th Avenue S, Auburn, WA 98001");
  const { text } = await expandListingLinks("Check out this home I found https://l.hms.pt/1125/14/2565463/255944/81337/B8", { fetchImpl });
  assert.match(text, /\[listing link → 34418 54th Avenue S, Auburn, WA 98001\]/);
});

test("an address block that isn't an address is not turned into one", () => {
  assert.equal(addressFromHtml(`<div class="summary_address">Address withheld<br />Auburn, WA</div>`), "");
});
