// zgrab.js — the Zillow comp-capture script, served to the user's browser by
// GET /api/offers/comps/zgrab.js and injected into a Zillow page by a
// bookmarklet.
//
// Why a server-served script instead of putting the logic in the bookmarklet:
// Zillow's page structure WILL change. This way a fix is a backend deploy
// rather than "everyone please re-drag your bookmark".
//
// On Zillow's terms: this reads a page the user has already loaded in their own
// browser, on their own session, one click at a time. No crawler, no automation,
// no rate. That's a materially weaker concern than the Apify scraper this repo
// already uses for listing photos (see the note in rehab-scan.js), but it is not
// zero, and it is the reason this is a user-initiated bookmarklet rather than
// anything that runs on a schedule.
//
// The script is written as ES5-flavoured, dependency-free browser JS: it runs
// inside someone else's page and must not assume a build step, a framework, or
// modern syntax support in whatever browser the user has.

// Values interpolated per request. The token is a capture-scoped credential
// (see POST /comps/capture) — never the location key.
export function buildZgrabScript({ token, brokerBase, appOrigin }) {
  const cfg = JSON.stringify({ token, broker: brokerBase, app: appOrigin });
  return `(function(){
"use strict";
var CFG = ${cfg};

/* ---------- toast ---------- */
function toast(msg, ok) {
  var id = "prvt-zgrab-toast";
  var el = document.getElementById(id);
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    document.body.appendChild(el);
  }
  el.textContent = msg;
  // Literal values, not tokens: this renders inside Zillow's page, where none
  // of our CSS exists. They mirror DESIGN.md — danger, ink-soft, deal-green-text,
  // radius lg, spacing lg/md — so the toast still reads as ours.
  el.setAttribute("style",
    "position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:340px;" +
    "padding:12px 16px;border-radius:12px;font:600 14px/1.5 'Plus Jakarta Sans',system-ui,sans-serif;" +
    "color:#FFFFFF;box-shadow:0 8px 24px rgba(15,23,42,.24);white-space:pre-line;" +
    "background:" + (ok === false ? "#DC2626" : ok === null ? "#334155" : "#047857"));
  clearTimeout(el._t);
  el._t = setTimeout(function(){ if (el.parentNode) el.parentNode.removeChild(el); }, 5000);
}

/* ---------- helpers ---------- */
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  var n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.\\-]/g, ""));
  return isFinite(n) && n !== 0 ? n : (n === 0 ? 0 : null);
}
function str(v) {
  var s = v === null || v === undefined ? "" : String(v).trim();
  return s && s.toLowerCase() !== "null" ? s : null;
}
function firstOf() {
  for (var i = 0; i < arguments.length; i++) { var s = str(arguments[i]); if (s) return s; }
  return null;
}
// resoFacts.constructionMaterials / stories arrive as arrays about half the time.
function flat(v) {
  if (Array.isArray(v)) return v.filter(Boolean).join(", ") || null;
  return str(v);
}
// "123 Main St, Kent, WA 98032" — one spelling of an address across both page
// types, because it's the key the comps PDF prints and zillowUrl() rebuilds.
function joinAddress(street, city, state, zip) {
  if (!street) return null;
  var line = [street, city].filter(Boolean).join(", ");
  var tail = [state, zip].filter(Boolean).join(" ");
  return tail ? line + ", " + tail : line;
}
function isoDate(v) {
  if (!v) return null;
  var t = typeof v === "number" ? v : Date.parse(v);
  if (!isFinite(t)) return null;
  // Zillow hands out both seconds and milliseconds epochs.
  if (t < 1e11 && typeof v === "number") t = t * 1000;
  var d = new Date(t);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/* ---------- page data ---------- */
function nextData() {
  try {
    var el = document.getElementById("__NEXT_DATA__");
    if (el && el.textContent) return JSON.parse(el.textContent);
  } catch (e) {}
  try { if (window.__NEXT_DATA__) return window.__NEXT_DATA__; } catch (e) {}
  return null;
}
function deepParse(v) {
  if (typeof v === "string") { try { return JSON.parse(v); } catch (e) { return null; } }
  return v || null;
}
// The detail page's property object lives in a cache keyed by a GraphQL query
// name that changes between page variants ("ForSaleShopperPlatformFullRender…",
// "NotForSalePriorityQuery…"), so walk the values instead of guessing the key.
function propertyFromNextData(nd) {
  var pp = nd && nd.props && nd.props.pageProps;
  var caches = [
    pp && pp.componentProps && pp.componentProps.gdpClientCache,
    pp && pp.gdpClientCache,
    pp && pp.componentProps && pp.componentProps.initialReduxState &&
      pp.componentProps.initialReduxState.gdp && pp.componentProps.initialReduxState.gdp.building
  ];
  for (var i = 0; i < caches.length; i++) {
    var obj = deepParse(caches[i]);
    if (!obj) continue;
    if (obj.property) return obj.property;
    for (var k in obj) {
      if (obj[k] && obj[k].property) return obj[k].property;
      if (obj[k] && obj[k].zpid && obj[k].address) return obj[k];
    }
  }
  return null;
}

// The zpid in the address bar is the one thing that is ALWAYS right, including
// inside the modal. Everything below treats it as the source of truth.
function urlZpid() {
  var m = location.pathname.match(/\\/(\\d+)_zpid/);
  return m ? m[1] : null;
}

// The property embedded in THIS document — only if it's actually the property
// the URL is pointing at.
//
// Why the check: clicking a card on a search page opens the listing as a modal
// and soft-navigates the URL to /homedetails/…, but __NEXT_DATA__ is baked into
// the HTML at first load and is NEVER rewritten on client-side navigation. So
// the document still holds the SEARCH page's payload while the URL says detail.
// Without this guard we'd either find nothing (and fall back to the URL slug,
// which has no price) or — worse — read a different house's numbers.
function localProperty() {
  var p = propertyFromNextData(nextData());
  if (!p) return null;
  var want = urlZpid();
  if (want && p.zpid != null && String(p.zpid) !== want) return null; // stale
  return p;
}

// Re-request the page we're already on and read ITS server-rendered payload.
// Same-origin, so no CORS and the browser sends the user's own cookies — this
// is the same page they're looking at, fetched the way the browser would have
// fetched it on a hard reload. Fixes the modal case completely.
function fetchedProperty() {
  return fetch(location.href, { credentials: "same-origin", headers: { Accept: "text/html" } })
    .then(function (r) { return r.ok ? r.text() : null; })
    .then(function (html) {
      if (!html) return null;
      var m = /<script id="__NEXT_DATA__"[^>]*>([\\s\\S]*?)<\\/script>/.exec(html);
      if (!m) return null;
      try { return propertyFromNextData(JSON.parse(m[1])); } catch (e) { return null; }
    })
    .catch(function () { return null; });
}
// Fallback 1: schema.org markup. Always has the address and usually the price.
function jsonLd() {
  var nodes = document.querySelectorAll('script[type="application/ld+json"]');
  for (var i = 0; i < nodes.length; i++) {
    try {
      var j = JSON.parse(nodes[i].textContent);
      var list = Array.isArray(j) ? j : (j["@graph"] || [j]);
      for (var n = 0; n < list.length; n++) {
        var o = list[n];
        if (o && o.address) return o;
      }
    } catch (e) {}
  }
  return null;
}
// Fallback 2: the URL slug. /homedetails/1234-Main-St-Kent-WA-98032/12345_zpid/
function fromUrl() {
  var m = location.pathname.match(/\\/homedetails\\/([^/]+)\\/(\\d+)_zpid/);
  if (!m) return null;
  var slug = decodeURIComponent(m[1]).replace(/-/g, " ").trim();
  return { address: slug, zpid: m[2] };
}

function bestPhoto(p) {
  var jpegs = (p && p.mixedSources && p.mixedSources.jpeg) || [];
  if (jpegs.length) {
    var under = jpegs.filter(function (j) { return j.width <= 1536; })
      .sort(function (a, b) { return b.width - a.width; });
    return (under[0] || jpegs.slice().sort(function (a, b) { return a.width - b.width; })[0]).url;
  }
  return (p && (p.url || p.href)) || null;
}

/* ---------- normalize one detail page ---------- */
// Takes the property object (from this document or a refetch), or null to
// fall back to schema.org markup and the URL slug.
function buildDetailComp(p) {
  var ld = p ? null : jsonLd();
  var u = fromUrl();
  if (!p && !ld && !u) return null;

  var facts = (p && p.resoFacts) || {};
  var addr = (p && p.address) || {};
  var street = firstOf(
    addr.streetAddress,
    ld && ld.address && ld.address.streetAddress,
    u && u.address
  );
  var full = joinAddress(
    street,
    firstOf(addr.city, ld && ld.address && ld.address.addressLocality),
    firstOf(addr.state, ld && ld.address && ld.address.addressRegion),
    firstOf(addr.zipcode, ld && ld.address && ld.address.postalCode)
  );
  if (!full) return null;

  var rawPhotos = (p && (p.photos || p.responsivePhotos)) || [];
  var photos = [];
  for (var i = 0; i < rawPhotos.length && photos.length < 8; i++) {
    var url = bestPhoto(rawPhotos[i]);
    if (url) photos.push(url);
  }

  // A sold comp's price is lastSoldPrice; a live listing's is price. Prefer the
  // sold figure — that's the transaction we're comping against.
  var sold = num(p && (p.lastSoldPrice || p.dateSoldPrice));
  var price = sold || num(p && p.price) || num(ld && ld.offers && ld.offers.price);

  return {
    zpid: str((p && p.zpid) || (u && u.zpid)),
    address: full,
    price: price,
    beds: num(p && p.bedrooms),
    baths: num(p && p.bathrooms),
    sqft: num(p && (p.livingArea || p.livingAreaValue)) || num(facts.livingArea),
    yearBuilt: num((p && p.yearBuilt) || facts.yearBuilt),
    lat: num(p && p.latitude),
    lng: num(p && p.longitude),
    saleDate: isoDate((p && (p.dateSold || p.dateSoldString)) || facts.dateSold),
    status: str(p && p.homeStatus),
    stories: num(facts.stories) || num(facts.storiesTotal),
    material: flat(facts.constructionMaterials),
    subdivision: firstOf(facts.subdivisionName, addr.subdivision),
    lotSize: num(facts.lotSize),
    url: location.href.split("?")[0],
    photos: photos,
    description: (str(p && p.description) || "").slice(0, 1200) || null
  };
}

// Resolve the property for the current URL, refetching when the document's own
// data is stale or missing. Returns a promise of the comp (or null).
function readDetail() {
  var local = localProperty();
  if (local) return Promise.resolve(buildDetailComp(local));
  toast("Reading the listing…", null);
  return fetchedProperty().then(function (p) {
    // p may still be null (Zillow shape change) — buildDetailComp then falls
    // back to schema.org + the URL slug, which yields an address but no price,
    // and the server will reject it with a clear message rather than store a
    // priceless comp.
    return buildDetailComp(p);
  });
}

/* ---------- normalize a search-results page ---------- */
function readSearch() {
  var nd = nextData();
  var sps = nd && nd.props && nd.props.pageProps && nd.props.pageProps.searchPageState;
  if (!sps) {
    // Older shape: search state parked in a script tag as an HTML comment.
    var node = document.querySelector('script[data-zrr-shared-data-key]');
    if (node) {
      try { sps = JSON.parse(node.textContent.replace(/^\\s*<!--/, "").replace(/-->\\s*$/, "")); } catch (e) {}
    }
  }
  var cat = sps && (sps.cat1 || sps.cat2);
  var sr = cat && cat.searchResults;
  var list = (sr && (sr.listResults || sr.mapResults)) || [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    if (!r) continue;
    var hd = r.hdpData && r.hdpData.homeInfo ? r.hdpData.homeInfo : {};
    // r.address is usually already the full one-line form; only assemble it
    // from the parts when it clearly isn't (no comma = street only).
    var address = str(r.address) || str(hd.streetAddress);
    if (!address) continue;
    if (address.indexOf(",") === -1) {
      address = joinAddress(address, str(hd.city), str(hd.state), str(hd.zipcode));
      if (!address) continue;
    }
    var price = num(r.unformattedPrice) || num(hd.price) || num(r.price);
    if (!price) continue;
    out.push({
      zpid: str(r.zpid || hd.zpid),
      address: address,
      price: price,
      beds: num(r.beds) || num(hd.bedrooms),
      baths: num(r.baths) || num(hd.bathrooms),
      sqft: num(r.area) || num(hd.livingArea),
      yearBuilt: null,
      lat: num((r.latLong && r.latLong.latitude) || hd.latitude),
      lng: num((r.latLong && r.latLong.longitude) || hd.longitude),
      saleDate: isoDate(hd.dateSold),
      status: str(r.statusType || hd.homeStatus),
      stories: null, material: null, subdivision: null,
      url: r.detailUrl ? (r.detailUrl.indexOf("http") === 0 ? r.detailUrl : "https://www.zillow.com" + r.detailUrl) : null,
      photos: r.imgSrc ? [r.imgSrc] : [],
      description: null
    });
  }
  return out;
}

/* ---------- transport ---------- */
function relay(payload) {
  // Zillow's CSP blocked connect-src. Hand the payload to a page on OUR origin
  // through the URL fragment (fragments never reach a server or a referrer),
  // and let that page do the POST from an origin the broker already allows.
  var w = window.open(
    CFG.app + "/zcapture.html#" + encodeURIComponent(JSON.stringify(payload)),
    "prvtcapture", "width=420,height=260"
  );
  if (!w) toast("Popup blocked.\\nAllow popups for zillow.com and click again.", false);
}
function send(comps) {
  if (!comps.length) {
    toast("Couldn't read a sold comp off this page.\\nOpen the property's own page and try again.", false);
    return;
  }
  // The broker URL rides along for the relay page's benefit — it's a static
  // file with no build-time config of its own.
  var payload = { token: CFG.token, source: "zillow", broker: CFG.broker, comps: comps };
  toast("Sending " + comps.length + " comp" + (comps.length > 1 ? "s" : "") + "…", null);
  var done = false;
  try {
    fetch(CFG.broker + "/api/offers/comps/capture", {
      method: "POST", mode: "cors",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; });
    }).then(function (x) {
      done = true;
      if (x.ok) toast("✓ " + (x.j.added || comps.length) + " comp(s) in your inbox.\\nOpen Comps & ARV to pull them in.", true);
      else toast("✗ " + (x.j.error || "capture rejected"), false);
    }).catch(function () {
      if (!done) relay(payload);
    });
  } catch (e) {
    relay(payload);
  }
}

/* ---------- go ---------- */
try {
  if (/\\/homedetails\\//.test(location.pathname)) {
    readDetail().then(function (one) {
      send(one ? [one] : []);
    }).catch(function (e) {
      toast("Couldn't read this listing: " + (e && e.message ? e.message : "unknown error"), false);
    });
  } else {
    var many = readSearch();
    if (!many.length) {
      toast("No results found on this page.\\nOpen a Zillow search or a property page.", false);
    } else if (window.confirm("Grab all " + many.length + " results on this page as comps?")) {
      send(many);
    }
  }
} catch (e) {
  toast("Capture failed: " + (e && e.message ? e.message : "unknown error"), false);
}
})();
`;
}

// The one-liner the user drags to their bookmarks bar. Deliberately a loader:
// it fetches the real script fresh every click, so a Zillow page-shape change
// is fixed by deploying the broker, not by re-installing the bookmark.
export function buildBookmarklet({ token, brokerBase }) {
  const src = `${brokerBase}/api/offers/comps/zgrab.js?t=${encodeURIComponent(token)}`;
  return (
    "javascript:(function(){var s=document.createElement('script');" +
    `s.src=${JSON.stringify(src)}+'&_='+Date.now();` +
    "s.onerror=function(){alert('Comp capture script failed to load — check your connection.')};" +
    "document.body.appendChild(s);setTimeout(function(){if(s.parentNode)s.parentNode.removeChild(s)},10000);})()"
  );
}
