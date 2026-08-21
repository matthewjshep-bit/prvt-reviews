// fetch-image.js — fetch a user-supplied image URL on the server's behalf.
//
// Why the server does this at all: the operator drags an image from another
// browser tab (Google Photos, a Drive preview, a listing) and the browser only
// hands us the URL, not the bytes. A client-side fetch of that URL is blocked
// by CORS on essentially every host worth dragging from, so the broker fetches
// it and hands the bytes back for the browser to downscale through the normal
// path.
//
// SECURITY: this is a server that makes an HTTP request to an address the user
// chose — a textbook SSRF sink. On Render the broker sits next to a Postgres
// instance and can reach the platform's metadata endpoints, so "just fetch it"
// would let anyone with account access read internal services and exfiltrate
// the response through a property photo. The guards below are the entire point
// of this module:
//
//   1. http/https only — no file:, gopher:, or redirect into one.
//   2. Every hostname is resolved and EVERY resolved address is checked against
//      the private/loopback/link-local/metadata ranges before we connect.
//   3. Redirects are followed manually so each hop gets the same treatment. A
//      public host that 302s to 169.254.169.254 is the classic bypass.
//   4. Hard caps on redirects, bytes and time.
//   5. The response must actually be an image, verified by magic number rather
//      than by the Content-Type the remote server claims.
//
// KNOWN RESIDUAL RISK: between our dns.lookup() and fetch()'s own internal
// resolution there is a DNS-rebinding window — an attacker controlling a
// nameserver could answer public on the first query and private on the second.
// Closing it properly means pinning the connection to the validated IP, which
// needs a custom undici dispatcher (not a dependency here) or an http.Agent
// (which global fetch ignores). Given this endpoint is authenticated and
// location-gated — the caller is already the account owner — the exposure is a
// self-attack, so the check above is proportionate. Revisit if this ever
// becomes reachable by a less-trusted caller.

import dns from "node:dns/promises";
import net from "node:net";

const MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024; // generous: the browser downscales after
const DEFAULT_TIMEOUT_MS = 12000;

const bad = (message, http = 400) => Object.assign(new Error(message), { http });

// IPv4 ranges that must never be reachable from a user-supplied URL.
const V4_BLOCKED = [
  ["0.0.0.0", 8],        // "this network"
  ["10.0.0.0", 8],       // private
  ["100.64.0.0", 10],    // carrier-grade NAT
  ["127.0.0.0", 8],      // loopback
  ["169.254.0.0", 16],   // link-local — cloud metadata lives at 169.254.169.254
  ["172.16.0.0", 12],    // private
  ["192.0.0.0", 24],     // IETF protocol assignments
  ["192.0.2.0", 24],     // TEST-NET-1
  ["192.168.0.0", 16],   // private
  ["198.18.0.0", 15],    // benchmarking
  ["224.0.0.0", 4],      // multicast
  ["240.0.0.0", 4],      // reserved / broadcast
];

const v4ToInt = (ip) => ip.split(".").reduce((acc, o) => (acc << 8 >>> 0) + Number(o), 0) >>> 0;

function isBlockedV4(ip) {
  const addr = v4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (addr & mask) >>> 0 === (v4ToInt(base) & mask) >>> 0;
  });
}

function isBlockedV6(ip) {
  const a = ip.toLowerCase().split("%")[0]; // strip any zone index
  if (a === "::" || a === "::1") return true;              // unspecified, loopback
  // IPv4-mapped (::ffff:10.0.0.1) and IPv4-compatible — judge the embedded v4.
  const mapped = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return isBlockedV4(mapped[1]);
  if (/^f[cd]/.test(a)) return true;                        // fc00::/7 unique-local
  if (/^fe[89ab]/.test(a)) return true;                     // fe80::/10 link-local
  if (/^ff/.test(a)) return true;                           // ff00::/8 multicast
  return false;
}

export function isBlockedAddress(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return isBlockedV4(ip);
  if (kind === 6) return isBlockedV6(ip);
  return true; // not an IP we can reason about — refuse
}

// Resolve a hostname and refuse unless EVERY answer is a public address. All,
// not some: a host that returns one public and one private A record would
// otherwise be a coin flip at connect time.
async function assertPublicHost(rawHostname) {
  // URL.hostname keeps the brackets on an IPv6 literal ("[::1]"), which
  // net.isIP doesn't recognise — without stripping them the literal would skip
  // the IP check and fall through to a DNS lookup that only happens to fail.
  const hostname = rawHostname.startsWith("[") && rawHostname.endsWith("]")
    ? rawHostname.slice(1, -1)
    : rawHostname;
  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw bad("that address is not reachable from here");
    return;
  }
  let answers;
  try {
    answers = await dns.lookup(hostname, { all: true });
  } catch {
    throw bad(`couldn't resolve ${hostname}`);
  }
  if (!answers.length) throw bad(`couldn't resolve ${hostname}`);
  for (const { address } of answers) {
    if (isBlockedAddress(address)) throw bad("that address is not reachable from here");
  }
}

function parseHttpUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || "").trim());
  } catch {
    throw bad("that doesn't look like a web address");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw bad("only http and https image links are supported");
  }
  return u;
}

// Trust the bytes, not the Content-Type — same rule the upload path uses.
export function sniffImageType(bytes) {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.slice(0, 4).toString("ascii") === "RIFF" && bytes.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.slice(4, 12).toString("ascii") === "ftypavif") return "image/avif";
  if (bytes.slice(0, 6).toString("ascii") === "GIF87a" || bytes.slice(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  return null;
}

export function sniffPdf(bytes) {
  return bytes.slice(0, 5).toString("ascii") === "%PDF-" ? "application/pdf" : null;
}

/**
 * Fetch an image URL safely and return { bytes, contentType, url }.
 * Throws an Error with .http set on every rejection path.
 *
 * `allowPdf` widens the accepted types to PDF as well, for the PSA exhibits
 * (a proof-of-funds letter is almost always a PDF). Everything else — the SSRF
 * guards, the redirect vetting, the caps — is deliberately shared: a second
 * fetcher would mean a second place to get those wrong.
 */
export async function fetchRemoteImage(rawUrl, { maxBytes = DEFAULT_MAX_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS, allowPdf = false } = {}) {
  let url = parseHttpUrl(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url.hostname);

    let res;
    try {
      res = await fetch(url, {
        redirect: "manual", // we vet each hop ourselves
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Accept: allowPdf ? "application/pdf,image/*" : "image/*",
          // Some CDNs 403 an empty UA; identify honestly rather than spoof.
          "User-Agent": "shepflips-offer-broker/1.0 (property photo import)",
        },
      });
    } catch (e) {
      throw bad(e.name === "TimeoutError" ? "that image took too long to load" : `couldn't load that image (${e.message})`, 502);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw bad("that link redirected nowhere", 502);
      if (hop === MAX_REDIRECTS) throw bad("that link redirected too many times", 502);
      url = parseHttpUrl(new URL(location, url).toString()); // re-vets the scheme
      continue;
    }

    if (!res.ok) {
      throw bad(
        res.status === 403 || res.status === 401
          ? "that image is private — open it in a browser, save it, and upload the file instead"
          : `that image link returned ${res.status}`,
        502
      );
    }

    // Cheap pre-check; the byte cap below is what actually enforces the limit,
    // since Content-Length can lie or be absent.
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared && declared > maxBytes) throw bad("that image is too large (max 12MB)", 413);

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw bad("that image is too large (max 12MB)", 413);
    if (!buf.length) throw bad("that link returned an empty file");

    const contentType = sniffImageType(buf) || (allowPdf ? sniffPdf(buf) : null);
    if (!contentType) {
      if (allowPdf) throw bad("that link isn't a PDF or an image");
      // Overwhelmingly this is an album/gallery PAGE rather than an image.
      throw bad(
        "that link isn't a direct image — it looks like a web page. Right-click the photo itself and copy the image address, or save it and upload the file"
      );
    }
    return { bytes: buf, contentType, url: url.toString() };
  }
  throw bad("that link redirected too many times", 502);
}
